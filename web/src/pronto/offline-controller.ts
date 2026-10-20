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
import {
  ChunkedPmtilesSource,
  deletePmtilesBlocks,
  getMechaBlobStorage,
  getPmtilesMeta,
} from './decomposed-storage.ts';

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

export async function getTileSource(
  segmentId: string,
): Promise<{ source: pmtiles.Source; size: number } | null> {
  const expectedSize = getCompletedTiles()[segmentId];
  if (!expectedSize) return null;
  try {
    const storage = getMechaBlobStorage();
    const meta = await getPmtilesMeta(storage, segmentId);
    if (meta && meta.size === expectedSize) {
      return {
        source: new ChunkedPmtilesSource(storage, segmentId, meta),
        size: meta.size,
      };
    }
  } catch {}
  if (!('storage' in navigator && 'getDirectory' in navigator.storage)) return null;
  try {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle(pmtilesFileName(segmentId));
    const file = await handle.getFile();
    if (file.size === expectedSize) {
      return { source: new pmtiles.FileSource(file), size: file.size };
    }
    return null;
  } catch {
    return null;
  }
}

export async function deleteTileFile(segmentId: string, loadedMap: Map<string, pmtiles.PMTiles>) {
  setTileCompleted(segmentId, null);
  loadedMap.delete(segmentId);
  try {
    await deletePmtilesBlocks(getMechaBlobStorage(), segmentId);
  } catch {}
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
    const tile = await getTileSource(id);
    if (tile) {
      totalBytes += tile.size;
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

export const loadedPMTiles = new Map<string, pmtiles.PMTiles>();
(window as any).loadedPMTiles = loadedPMTiles;

let resolveArchivesReady: () => void;
export const archivesReady = new Promise<void>((resolve) => {
  resolveArchivesReady = resolve;
});

export interface OfflineControllerCallbacks {
  onStateChange: () => void;
  onOfflineModeChange: (offline: boolean) => void;
  onClearWorkerGraph: (recompute?: boolean) => void;
  onStatusChange: (msg: string) => void;
}

export class OfflineController {
  isOfflineMode = localStorage.getItem(OFFLINE_MODE_KEY) === 'true';
  bundleStatus: OfflineBundleStatus = { ready: false, totalBytes: 0, hasAny: false };
  snapshotDate: Date | null = null;
  downloadProgress: DownloadProgress = { active: false, message: '', percent: 0 };
  private bc: BroadcastChannel | null = null;
  private onOfflineHandler: () => void;

  constructor(private callbacks: OfflineControllerCallbacks) {
    this.onOfflineHandler = async () => {
      if (this.isOfflineMode) return;
      const status = await checkOfflineBundleStatus();
      if (status.ready) {
        this.setOfflineMode(true);
      }
    };
    window.addEventListener('offline', this.onOfflineHandler);

    try {
      if (typeof BroadcastChannel !== 'undefined') {
        this.bc = new BroadcastChannel(CACHE_CHANNEL_NAME);
        this.bc.onmessage = () => {
          this.refreshStatus();
        };
      }
    } catch {}

    this.initArchives();
  }

  private async initArchives() {
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
          const tile = await getTileSource(id);
          if (tile && !loadedPMTiles.has(id)) {
            const p = new pmtiles.PMTiles(tile.source);
            await p.getHeader();
            loadedPMTiles.set(id, p);
          }
        } catch {}
      }
    } finally {
      resolveArchivesReady();
    }

    const status = await this.refreshStatus();
    if (!navigator.onLine && status.ready) {
      this.setOfflineMode(true);
    } else if (this.isOfflineMode && !status.ready) {
      this.setOfflineMode(false);
    }
  }

  setOfflineMode = (enabled: boolean) => {
    this.isOfflineMode = enabled;
    localStorage.setItem(OFFLINE_MODE_KEY, enabled ? 'true' : 'false');
    this.callbacks.onOfflineModeChange(enabled);
    this.callbacks.onStateChange();
  };

  refreshStatus = async (): Promise<OfflineBundleStatus> => {
    try {
      const cache = await caches.open(SEGMENT_CACHE_NAME);
      const date = await getLatestCachedSegmentDate(cache);
      this.snapshotDate = date;
    } catch (err) {
      console.error('Failed to read cached segment date:', err);
    }

    const status = await checkOfflineBundleStatus();
    this.bundleStatus = status;
    this.callbacks.onStateChange();
    return status;
  };

  private async downloadMapTilesForSegment(
    segmentId: string,
    onProgress: (received: number, total: number) => void,
  ) {
    if (loadedPMTiles.has(segmentId)) return;
    const existing = await getTileSource(segmentId);
    if (existing) {
      const p = new pmtiles.PMTiles(existing.source);
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
          segmentId,
        } satisfies DownloadRequest);
      });
      setTileCompleted(segmentId, size);
    } finally {
      dl.terminate();
    }

    const tile = await getTileSource(segmentId);
    if (!tile) throw new Error(`Map tiles for ${segmentId} were not saved correctly`);
    const p = new pmtiles.PMTiles(tile.source);
    await p.getHeader();
    loadedPMTiles.set(segmentId, p);
  }

  downloadBundle = async (forceRouting = false) => {
    this.downloadProgress = { active: true, message: 'Downloading map fonts...', percent: 2 };
    this.callbacks.onStateChange();
    try {
      if (navigator.storage && navigator.storage.persist) {
        await navigator.storage.persist();
      }

      const fontCache = await caches.open(MAP_TILES_CACHE_NAME);
      for (const fontName of FONT_NAMES) {
        this.downloadProgress = {
          ...this.downloadProgress,
          message: `Downloading font ${fontName}...`,
        };
        this.callbacks.onStateChange();
        for (const range of FONT_RANGES) {
          const url = `${FONT_BASE_URL}${encodeURIComponent(fontName)}/${range}.pbf`;
          if (await fontCache.match(url)) continue;
          const res = await fetch(url);
          if (!res.ok) {
            throw new Error(`Failed to download font ${fontName} ${range}: HTTP ${res.status}`);
          }
          await fontCache.put(url, res);
        }
      }
      this.downloadProgress = {
        active: true,
        message: 'Downloading routing profiles...',
        percent: 10,
      };
      this.callbacks.onStateChange();

      const segmentCache = await caches.open(SEGMENT_CACHE_NAME);
      for (const url of ROUTING_FILES) {
        if (!forceRouting && (await segmentCache.match(url))) continue;
        this.downloadProgress = {
          ...this.downloadProgress,
          message: `Downloading profile ${url.split('/').pop()}...`,
        };
        this.callbacks.onStateChange();
        const res = await fetch(url);
        if (!res.ok || (res.headers.get('content-type') || '').includes('text/html')) {
          throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
        }
        await segmentCache.put(url, res);
      }

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
          this.downloadProgress = {
            active: true,
            percent: pct,
            message: `Routing data ${i + 1}/${n}: ${segId} (${formatMb(done)} / ${totalLabel} MB)`,
          };
          this.callbacks.onStateChange();
        });
      }

      for (let i = 0; i < n; i++) {
        const segId = UK_SEGMENTS[i];
        this.downloadProgress = {
          active: true,
          percent: Math.min(99, Math.round(20 + (i / n) * 80)),
          message: `Map tiles ${i + 1}/${n}: ${segId} (preparing, this can take a few minutes)`,
        };
        this.callbacks.onStateChange();
        await this.downloadMapTilesForSegment(segId, (done, total) => {
          const frac = total > 0 ? done / total : 0;
          const pct = Math.min(99, Math.round(20 + ((i + frac) / n) * 80));
          const totalLabel = total > 0 ? formatMb(total) : '?';
          this.downloadProgress = {
            active: true,
            percent: pct,
            message: `Map tiles ${i + 1}/${n}: ${segId} (${formatMb(done)} / ${totalLabel} MB)`,
          };
          this.callbacks.onStateChange();
        });
      }

      this.downloadProgress = { active: false, percent: 100, message: '' };
      await this.refreshStatus();
      this.callbacks.onStatusChange(
        forceRouting
          ? 'Offline data updated successfully.'
          : 'Offline data downloaded. You can now enable Offline Mode.',
      );
    } catch (err: any) {
      this.downloadProgress = { active: false, percent: 0, message: '' };
      await this.refreshStatus();
      this.callbacks.onStatusChange(
        `Download failed: ${err.message || String(err)}. Press Download to resume.`,
      );
    }
  };

  updateBundle = async () => {
    try {
      await clearAllCachedSegments();
      await this.refreshStatus();
      this.callbacks.onStatusChange(
        'Routing cache cleared. Segments will re-cache on next route.',
      );
      this.callbacks.onClearWorkerGraph(true);
    } catch (err) {
      console.error('Clear routing cache failed:', err);
    }
  };

  deleteBundle = async () => {
    if (this.isOfflineMode) {
      this.setOfflineMode(false);
    }
    this.callbacks.onStatusChange('Removing offline data...');
    for (const segId of UK_SEGMENTS) {
      await deleteTileFile(segId, loadedPMTiles);
    }
    await clearAllCachedSegments();
    this.callbacks.onClearWorkerGraph(false);
    await this.refreshStatus();
    this.callbacks.onStatusChange('Offline data removed from local storage.');
  };

  destroy() {
    window.removeEventListener('offline', this.onOfflineHandler);
    this.bc?.close();
  }
}
