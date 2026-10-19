import { useState, useEffect, useCallback, useRef } from 'react';
import * as pmtiles from 'pmtiles';
import {
  SEGMENT_CACHE_NAME,
  MAP_TILES_CACHE_NAME,
  CACHE_CHANNEL_NAME,
  MIN_RD5_BYTES,
  UK_SEGMENTS,
  fetchAndCacheSegment,
  getLatestCachedSegmentDate,
  getCachedSegmentSize,
  clearAllCachedSegments,
} from '../segment-cache.ts';
import { FONT_BASE_URL, FONT_NAMES, FONT_RANGES, ROUTING_FILES } from '../utils/map-styles.ts';
import { getMapTileDownloadUrl } from '../platform.ts';
import type { DownloadEvent, DownloadRequest } from '../download-worker.ts';

const TILES_DONE_KEY = 'rsrouter_map_tiles_done';
const OFFLINE_MODE_KEY = 'rsrouter_offline_mode';

export interface OfflineBundleStatus {
  ready: boolean;
  totalBytes: number;
  hasAny: boolean;
  hasPartialTiles?: boolean;
}

export interface DownloadProgress {
  active: boolean;
  message: string;
  percent: number;
}

export function pmtilesFileName(segmentId: string): string {
  return `${segmentId}.pmtiles`;
}

export function getCompletedTiles(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(TILES_DONE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function setTileCompleted(segmentId: string, size: number | null) {
  const done = getCompletedTiles();
  if (size === null) {
    delete done[segmentId];
  } else {
    done[segmentId] = size;
  }
  localStorage.setItem(TILES_DONE_KEY, JSON.stringify(done));
}

export async function getTileFile(segmentId: string): Promise<File | null> {
  const expectedSize = getCompletedTiles()[segmentId];
  if (!expectedSize) return null;
  if (!('storage' in navigator && 'getDirectory' in navigator.storage)) return null;
  try {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle(pmtilesFileName(segmentId));
    const file = await handle.getFile();
    return file.size === expectedSize ? file : null;
  } catch {
    return null;
  }
}

export async function deleteTileFile(segmentId: string, loadedMap: Map<string, pmtiles.PMTiles>) {
  setTileCompleted(segmentId, null);
  loadedMap.delete(segmentId);
  if (!('storage' in navigator && 'getDirectory' in navigator.storage)) return;
  const dir = await navigator.storage.getDirectory();
  try {
    await dir.removeEntry(pmtilesFileName(segmentId));
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err;
  }
}

export async function checkOfflineBundleStatus(): Promise<OfflineBundleStatus> {
  let totalBytes = 0;
  let allTilesReady = true;
  let hasAny = false;
  let hasPartialTiles = false;

  for (const id of UK_SEGMENTS) {
    const file = await getTileFile(id);
    if (file) {
      totalBytes += file.size;
      hasAny = true;
      hasPartialTiles = true;
    } else {
      allTilesReady = false;
    }
  }

  const cache = await caches.open(SEGMENT_CACHE_NAME);
  let allSegmentsReady = true;
  for (const id of UK_SEGMENTS) {
    const size = await getCachedSegmentSize(cache, id);
    if (size >= MIN_RD5_BYTES) {
      totalBytes += size;
      hasAny = true;
    } else {
      allSegmentsReady = false;
    }
  }

  let allProfilesReady = true;
  for (const url of ROUTING_FILES) {
    if (await cache.match(url)) {
      hasAny = true;
    } else {
      allProfilesReady = false;
    }
  }

  const ready = allTilesReady && allSegmentsReady && allProfilesReady;
  return { ready, totalBytes, hasAny, hasPartialTiles };
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// Global PMTiles in-memory map and initialization gate
export const loadedPMTiles = new Map<string, pmtiles.PMTiles>();
(window as any).loadedPMTiles = loadedPMTiles;

let resolveArchivesReady: () => void;
export const archivesReady = new Promise<void>((resolve) => {
  resolveArchivesReady = resolve;
});

export function useOffline(
  onClearWorkerGraph: (recompute?: boolean) => void,
  onStatusChange: (msg: string) => void,
) {
  const [isOfflineMode, setIsOfflineModeState] = useState<boolean>(() => {
    return localStorage.getItem(OFFLINE_MODE_KEY) === 'true';
  });
  const [bundleStatus, setBundleStatus] = useState<OfflineBundleStatus>({ ready: false, totalBytes: 0, hasAny: false });
  const [snapshotDate, setSnapshotDate] = useState<Date | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress>({ active: false, message: '', percent: 0 });

  const isOfflineModeRef = useRef(isOfflineMode);
  isOfflineModeRef.current = isOfflineMode;

  const onClearWorkerGraphRef = useRef(onClearWorkerGraph);
  onClearWorkerGraphRef.current = onClearWorkerGraph;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const refreshStatus = useCallback(async () => {
    try {
      const cache = await caches.open(SEGMENT_CACHE_NAME);
      const date = await getLatestCachedSegmentDate(cache);
      setSnapshotDate(date);
    } catch (err) {
      console.error('Failed to read cached segment date:', err);
    }

    const status = await checkOfflineBundleStatus();
    setBundleStatus(status);

    if (!status.ready && isOfflineModeRef.current) {
      setIsOfflineModeState(false);
      localStorage.setItem(OFFLINE_MODE_KEY, 'false');
    }
    return status;
  }, []);

  const setOfflineMode = useCallback((enabled: boolean) => {
    setIsOfflineModeState(enabled);
    localStorage.setItem(OFFLINE_MODE_KEY, String(enabled));
    window.dispatchEvent(new CustomEvent('offlinemodechange', { detail: { offline: enabled } }));
    onStatusChangeRef.current(
      enabled
        ? 'Offline mode active. Rendering with local PMTiles archives.'
        : 'Online mode active. Streaming tiles on the fly.'
    );
  }, []);

  // Load PMTiles from OPFS on startup and subscribe to segment cache updates
  useEffect(() => {
    async function initArchives() {
      try {
        if ('indexedDB' in window) {
          indexedDB.deleteDatabase('rsrouter-pmtiles-v1');
        }
        try {
          const tileCache = await caches.open(MAP_TILES_CACHE_NAME);
          for (const req of await tileCache.keys()) {
            if (!req.url.startsWith(FONT_BASE_URL)) {
              await tileCache.delete(req);
            }
          }
        } catch {}

        for (const id of UK_SEGMENTS) {
          try {
            const file = await getTileFile(id);
            if (file && !loadedPMTiles.has(id)) {
              const p = new pmtiles.PMTiles(new pmtiles.FileSource(file));
              await p.getHeader();
              loadedPMTiles.set(id, p);
            }
          } catch {}
        }
      } finally {
        resolveArchivesReady();
      }

      const status = await refreshStatus();
      if (!navigator.onLine && status.ready) {
        setOfflineMode(true);
      } else if (isOfflineModeRef.current && !status.ready) {
        setOfflineMode(false);
      }
    }

    initArchives();

    let bc: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        bc = new BroadcastChannel(CACHE_CHANNEL_NAME);
        bc.onmessage = () => {
          refreshStatus();
        };
      }
    } catch {}

    const onOffline = async () => {
      if (isOfflineModeRef.current) return;
      const status = await checkOfflineBundleStatus();
      if (status.ready) {
        setOfflineMode(true);
      }
    };

    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('offline', onOffline);
      bc?.close();
    };
  }, [refreshStatus, setOfflineMode]);

  const downloadMapTilesForSegment = async (
    segmentId: string,
    onProgress: (received: number, total: number) => void,
  ) => {
    if (loadedPMTiles.has(segmentId)) return;
    const existing = await getTileFile(segmentId);
    if (existing) {
      const p = new pmtiles.PMTiles(new pmtiles.FileSource(existing));
      await p.getHeader();
      loadedPMTiles.set(segmentId, p);
      return;
    }

    setTileCompleted(segmentId, null);
    const dl = new Worker(new URL('../download-worker.ts', import.meta.url), { type: 'module' });
    try {
      const size = await new Promise<number>((resolve, reject) => {
        dl.onmessage = (e: MessageEvent<DownloadEvent>) => {
          const msg = e.data;
          if (msg.type === 'progress') onProgress(msg.received, msg.total);
          else if (msg.type === 'done') resolve(msg.size);
          else reject(new Error(msg.error));
        };
        dl.onerror = (e) => reject(new Error(e.message));
        dl.postMessage({
          url: getMapTileDownloadUrl(segmentId),
          fileName: pmtilesFileName(segmentId),
        } satisfies DownloadRequest);
      });
      setTileCompleted(segmentId, size);
    } finally {
      dl.terminate();
    }

    const file = await getTileFile(segmentId);
    if (!file) throw new Error(`Map tiles for ${segmentId} were not saved correctly`);
    const p = new pmtiles.PMTiles(new pmtiles.FileSource(file));
    await p.getHeader();
    loadedPMTiles.set(segmentId, p);
  };

  const downloadBundle = useCallback(async (forceRouting = false) => {
    setDownloadProgress({ active: true, message: 'Downloading map fonts...', percent: 2 });
    try {
      if (navigator.storage && navigator.storage.persist) {
        await navigator.storage.persist();
      }

      // 1. Fonts
      const fontCache = await caches.open(MAP_TILES_CACHE_NAME);
      for (const fontName of FONT_NAMES) {
        setDownloadProgress((prev) => ({ ...prev, message: `Downloading font ${fontName}...` }));
        for (const range of FONT_RANGES) {
          const url = `${FONT_BASE_URL}${encodeURIComponent(fontName)}/${range}.pbf`;
          if (await fontCache.match(url)) continue;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Failed to download font ${fontName} ${range}: HTTP ${res.status}`);
          await fontCache.put(url, res);
        }
      }
      setDownloadProgress({ active: true, message: 'Downloading routing profiles...', percent: 10 });

      // 2. Profiles
      const segmentCache = await caches.open(SEGMENT_CACHE_NAME);
      for (const url of ROUTING_FILES) {
        if (!forceRouting && (await segmentCache.match(url))) continue;
        setDownloadProgress((prev) => ({ ...prev, message: `Downloading profile ${url.split('/').pop()}...` }));
        const res = await fetch(url);
        if (!res.ok || (res.headers.get('content-type') || '').includes('text/html')) {
          throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
        }
        await segmentCache.put(url, res);
      }

      // 3. Routing Data
      const n = UK_SEGMENTS.length;
      for (let i = 0; i < n; i++) {
        const segId = UK_SEGMENTS[i];
        if (!forceRouting && (await getCachedSegmentSize(segmentCache, segId)) >= MIN_RD5_BYTES) {
          continue;
        }
        await fetchAndCacheSegment(segId, (done, total) => {
          const frac = total > 0 ? done / total : 0;
          const pct = Math.round(10 + ((i + frac) / n) * 10);
          const totalLabel = total > 0 ? formatMb(total) : '?';
          setDownloadProgress({
            active: true,
            percent: pct,
            message: `Routing data ${i + 1}/${n}: ${segId} (${formatMb(done)} / ${totalLabel} MB)`,
          });
        });
      }

      // 4. Map Tiles
      for (let i = 0; i < n; i++) {
        const segId = UK_SEGMENTS[i];
        setDownloadProgress({
          active: true,
          percent: Math.min(99, Math.round(20 + (i / n) * 80)),
          message: `Map tiles ${i + 1}/${n}: ${segId} (preparing, this can take a few minutes)`,
        });
        await downloadMapTilesForSegment(segId, (done, total) => {
          const frac = total > 0 ? done / total : 0;
          const pct = Math.min(99, Math.round(20 + ((i + frac) / n) * 80));
          const totalLabel = total > 0 ? formatMb(total) : '?';
          setDownloadProgress({
            active: true,
            percent: pct,
            message: `Map tiles ${i + 1}/${n}: ${segId} (${formatMb(done)} / ${totalLabel} MB)`,
          });
        });
      }

      setDownloadProgress({ active: false, percent: 100, message: '' });
      await refreshStatus();
      onStatusChange(
        forceRouting
          ? 'Offline data updated successfully.'
          : 'Offline data downloaded. You can now enable Offline Mode.'
      );
    } catch (err: any) {
      setDownloadProgress({ active: false, percent: 0, message: '' });
      await refreshStatus();
      onStatusChange(`Download failed: ${err.message || String(err)}. Press Download to resume.`);
    }
  }, [refreshStatus, onStatusChange]);

  const updateBundle = useCallback(async () => {
    try {
      await clearAllCachedSegments();
      await refreshStatus();
      onStatusChangeRef.current('Routing cache cleared. Segments will re-cache on next route.');
      onClearWorkerGraphRef.current(true);
    } catch (err) {
      console.error('Clear routing cache failed:', err);
    }
  }, [refreshStatus]);

  const deleteBundle = useCallback(async () => {
    if (isOfflineModeRef.current) {
      setOfflineMode(false);
    }
    onStatusChangeRef.current('Removing offline data...');
    for (const segId of UK_SEGMENTS) {
      await deleteTileFile(segId, loadedPMTiles);
    }
    await clearAllCachedSegments();
    onClearWorkerGraphRef.current(false);
    await refreshStatus();
    onStatusChangeRef.current('Offline data removed from local storage.');
  }, [refreshStatus, setOfflineMode]);

  return {
    isOfflineMode,
    setOfflineMode,
    bundleStatus,
    snapshotDate,
    downloadProgress,
    refreshStatus,
    downloadBundle: () => downloadBundle(false),
    updateBundle,
    deleteBundle,
  };
}
