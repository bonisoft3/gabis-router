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

/**
 * Reads the creation date of a cached segment without loading full data if headers exist.
 */
export async function getCachedSegmentDate(cache: Cache, segmentId: string): Promise<Date | null> {
  const match = await cache.match(`/segments4/${segmentId}.rd5`);
  if (!match) return null;

  const headerDate = match.headers.get('x-segment-date');
  if (headerDate) {
    const d = new Date(headerDate);
    if (!isNaN(d.getTime())) return d;
  }

  // Fallback: read trailer from arrayBuffer
  const buf = await match.arrayBuffer();
  return getRd5CreationDate(buf);
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
 * Downloads a segment, caches it, and returns the byte array.
 * Tries local path first (/segments4/<id>.rd5), falls back to proxy (/remote-segments/<id>.rd5).
 */
export async function fetchAndCacheSegment(
  segmentId: string,
  onProgress?: (received: number, total: number) => void,
): Promise<Uint8Array> {
  const cache = await caches.open(SEGMENT_CACHE_NAME);
  const key = `/segments4/${segmentId}.rd5`;

  let res = await fetch(key);
  if (!res.ok || isHtml(res)) {
    res = await fetch(`/remote-segments/${segmentId}.rd5`);
  }
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

  const creationDate = getRd5CreationDate(bytes.buffer);
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-length': String(received),
  };
  if (creationDate) {
    headers['x-segment-date'] = creationDate.toISOString();
  }

  await cache.put(key, new Response(bytes, { headers }));
  return bytes;
}

/**
 * Finds the latest creation date across cached segments.
 */
export async function getLatestCachedSegmentDate(cache: Cache): Promise<Date | null> {
  for (const segId of UK_SEGMENTS) {
    const d = await getCachedSegmentDate(cache, segId);
    if (d) return d;
  }
  const requests = await cache.keys();
  for (const req of requests) {
    if (req.url.includes('.rd5')) {
      const match = await cache.match(req);
      if (match) {
        const headerDate = match.headers.get('x-segment-date');
        if (headerDate) {
          const d = new Date(headerDate);
          if (!isNaN(d.getTime())) return d;
        }
        const buf = await match.arrayBuffer();
        const d = getRd5CreationDate(buf);
        if (d) return d;
      }
    }
  }
  return null;
}

/**
 * Removes all cached segments from storage.
 */
export async function clearAllCachedSegments(): Promise<void> {
  const cache = await caches.open(SEGMENT_CACHE_NAME);
  const requests = await cache.keys();
  for (const req of requests) {
    if (req.url.includes('.rd5')) {
      await cache.delete(req);
    }
  }
  for (const segId of UK_SEGMENTS) {
    await cache.delete(`/segments4/${segId}.rd5`);
    await cache.delete(`/remote-segments/${segId}.rd5`);
  }
}

