/**
 * Centralized segment cache configuration, date extraction, and download logic.
 */

export const SEGMENT_CACHE_NAME = 'rsrouter-segments-v3';
export const MAP_TILES_CACHE_NAME = 'rsrouter-map-tiles-v1';
export const MIN_RD5_BYTES = 50000;

export const UK_SEGMENTS = [
  'W15_N50', // Ireland, far west coast
  'W10_N50', // Ireland, Northern Ireland, Cornwall west tip
  'W10_N55', // Donegal, Outer Hebrides
  'W5_N50',  // England, Wales, southern Scotland
  'W5_N55',  // Scotland, Orkney
  'W5_N60',  // Shetland
  'E0_N50',  // East England
];

export function isHtml(res: Response): boolean {
  return (res.headers.get('content-type') || '').includes('text/html');
}

/**
 * Extracts the 64-bit creation timestamp from the RD5 binary trailer.
 */
export function getRd5CreationDate(buffer: ArrayBuffer): Date | null {
  if (buffer.byteLength < 208) return null;
  const view = new DataView(buffer);
  const hi = view.getUint32(192);
  const lo = view.getUint32(196);
  const pos24 = (hi & 0x0000ffff) * 4294967296 + lo;
  if (pos24 + 8 > buffer.byteLength) return null;
  const ctimeHi = view.getInt32(pos24);
  const ctimeLo = view.getUint32(pos24 + 4);
  const ctime = ctimeHi * 4294967296 + ctimeLo;
  if (isNaN(ctime) || ctime <= 0) return null;
  return new Date(ctime);
}

export const CACHE_CHANNEL_NAME = 'rsrouter-cache-events';

const segmentDateMemo = new Map<string, Date>();

export function notifyCacheUpdated(): void {
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const bc = new BroadcastChannel(CACHE_CHANNEL_NAME);
      bc.postMessage({ type: 'updated' });
      bc.close();
    }
  } catch {}
}

/**
 * Reads the creation date of a cached segment without loading full data if headers exist.
 */
export async function getCachedSegmentDate(cache: Cache, segmentId: string): Promise<Date | null> {
  const match = await cache.match(`/segments4/${segmentId}.rd5`);
  if (!match) {
    segmentDateMemo.delete(segmentId);
    return null;
  }

  const headerDate = match.headers.get('x-segment-date');
  if (headerDate) {
    const d = new Date(headerDate);
    if (!isNaN(d.getTime())) {
      segmentDateMemo.set(segmentId, d);
      return d;
    }
  }

  const memo = segmentDateMemo.get(segmentId);
  if (memo) return memo;

  // Fallback: read only the 8-byte trailer offset and 8-byte creation timestamp via Blob.slice
  const blob = await match.blob();
  if (blob.size < 208) return null;
  const headerTail = await blob.slice(192, 200).arrayBuffer();
  const hView = new DataView(headerTail);
  const hi = hView.getUint32(0);
  const lo = hView.getUint32(4);
  const pos24 = (hi & 0x0000ffff) * 4294967296 + lo;
  if (pos24 + 8 > blob.size) return null;
  const trailerHead = await blob.slice(pos24, pos24 + 8).arrayBuffer();
  const tView = new DataView(trailerHead);
  const ctimeHi = tView.getInt32(0);
  const ctimeLo = tView.getUint32(4);
  const ctime = ctimeHi * 4294967296 + ctimeLo;
  if (isNaN(ctime) || ctime <= 0) return null;
  const d = new Date(ctime);
  segmentDateMemo.set(segmentId, d);
  return d;
}

/**
 * Size of a cached routing segment from response headers.
 */
export async function getCachedSegmentSize(cache: Cache, segmentId: string): Promise<number> {
  const match = await cache.match(`/segments4/${segmentId}.rd5`);
  return Number(match?.headers.get('content-length')) || 0;
}

/**
 * Checks if browser storage has enough space for new download.
 */
export async function ensureStorageFor(bytes: number, what: string) {
  const { quota = 0, usage = 0 } = await navigator.storage.estimate();
  const free = quota - usage;
  if (bytes > free) {
    const needMb = Math.round(bytes / (1024 * 1024));
    const freeMb = Math.round(free / (1024 * 1024));
    throw new Error(`Not enough browser storage for ${what}: needs ${needMb} MB, ${freeMb} MB free`);
  }
}

/**
 * Downloads a segment from the BRouter repository (/segments4/<id>.rd5), caches it, and returns the byte array.
 */
export async function fetchAndCacheSegment(
  segmentId: string,
  onProgress?: (received: number, total: number) => void,
): Promise<Uint8Array> {
  const cache = await caches.open(SEGMENT_CACHE_NAME);
  const key = `/segments4/${segmentId}.rd5`;

  const res = await fetch(key, { cache: 'no-cache' });
  if (!res.ok || !res.body || isHtml(res)) {
    throw new Error(`Failed to fetch routing segment ${segmentId}: HTTP ${res.status}`);
  }

  const total = Number(res.headers.get('content-length')) || 0;
  if (total) {
    if (total < MIN_RD5_BYTES) {
      throw new Error(`Routing segment ${segmentId} is too small (${total} bytes)`);
    }
    await ensureStorageFor(total, `${segmentId}.rd5`);
  }

  let received = 0;
  const chunks: Uint8Array[] = [];
  const reader = res.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (onProgress) {
      onProgress(received, total);
    }
  }

  if (total ? received !== total : received < MIN_RD5_BYTES) {
    throw new Error(`Incomplete download of ${segmentId}.rd5: ${received} of ${total || '?'} bytes`);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let creationDate = getRd5CreationDate(bytes.buffer);
  if (!creationDate) {
    const lastMod = res.headers.get('last-modified');
    if (lastMod) {
      const parsed = new Date(lastMod);
      if (!isNaN(parsed.getTime())) creationDate = parsed;
    }
  }
  if (!creationDate) {
    creationDate = new Date();
  }

  segmentDateMemo.set(segmentId, creationDate);
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-length': String(received),
    'x-segment-date': creationDate.toISOString(),
  };

  await cache.put(key, new Response(bytes, { headers }));
  notifyCacheUpdated();
  return bytes;
}

/**
 * Returns IDs of all currently cached routing segments.
 */
export async function getCachedSegmentIds(cache: Cache): Promise<string[]> {
  const ids = new Set<string>();
  for (const segId of UK_SEGMENTS) {
    if ((await getCachedSegmentSize(cache, segId)) >= MIN_RD5_BYTES) {
      ids.add(segId);
    }
  }
  const requests = await cache.keys();
  for (const req of requests) {
    const m = req.url.match(/\/segments4\/([A-Z0-9_]+)\.rd5$/i);
    if (m) {
      ids.add(m[1]);
    }
  }
  return Array.from(ids);
}

/**
 * Finds the latest creation date across cached segments.
 */
export async function getLatestCachedSegmentDate(cache: Cache): Promise<Date | null> {
  let latest: Date | null = null;
  const consider = (d: Date | null) => {
    if (d && (!latest || d.getTime() > latest.getTime())) {
      latest = d;
    }
  };

  const seenIds = new Set<string>(UK_SEGMENTS);
  for (const segId of UK_SEGMENTS) {
    consider(await getCachedSegmentDate(cache, segId));
  }
  const requests = await cache.keys();
  for (const req of requests) {
    const m = req.url.match(/\/segments4\/([A-Z0-9_]+)\.rd5$/i);
    if (m && !seenIds.has(m[1])) {
      seenIds.add(m[1]);
      consider(await getCachedSegmentDate(cache, m[1]));
    }
  }
  return latest;
}

/**
 * Removes all cached routing segments and profile files from storage.
 */
export async function clearAllCachedSegments(): Promise<void> {
  segmentDateMemo.clear();
  const cache = await caches.open(SEGMENT_CACHE_NAME);
  const requests = await cache.keys();
  for (const req of requests) {
    await cache.delete(req);
  }
  for (const segId of UK_SEGMENTS) {
    await cache.delete(`/segments4/${segId}.rd5`);
  }
  try {
    await caches.delete('rsrouter-segments-v2');
  } catch {}
  notifyCacheUpdated();
}

