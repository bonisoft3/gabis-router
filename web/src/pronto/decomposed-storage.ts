import type * as pmtiles from 'pmtiles';
import { createIdbBlobStorage } from '../../../subrepos/mecha/packages/rclone-js/src/idb-storage.ts';
import type { BlobStorage } from '../../../subrepos/mecha/packages/rclone-js/src/types.ts';

export const PMTILES_BLOCK_SIZE = 1024 * 1024; // 1 MB blocks

let defaultStorage: BlobStorage | null = null;

export function getMechaBlobStorage(): BlobStorage {
  if (!defaultStorage) {
    defaultStorage = createIdbBlobStorage('rsrouter-mecha-blobs');
  }
  return defaultStorage;
}

export interface Rd5DecomposedMeta {
  size: number;
  creationDate: string;
  fileIndex: number[];
  nonEmptySquares: number[];
}

export interface PmtilesDecomposedMeta {
  size: number;
  blockSize: number;
  blockCount: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Parses the 200-byte RD5 header into 25 square end-offsets and splits the buffer into:
 * - 200-byte header + trailer bytes
 * - 25 independent 1x1 degree sub-tiles (`sub_0` .. `sub_24`)
 */
export function decomposeRd5Buffer(
  bytes: Uint8Array,
  creationDateIso: string,
): {
  meta: Rd5DecomposedMeta;
  headerAndTrailer: ArrayBuffer;
  subtiles: Array<{ subIdx: number; data: ArrayBuffer }>;
} {
  if (bytes.byteLength < 208) {
    throw new Error(`RD5 buffer too short (${bytes.byteLength} bytes)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fileIndex: number[] = [];
  for (let i = 0; i < 25; i++) {
    const hi = view.getUint32(i * 8);
    const lo = view.getUint32(i * 8 + 4);
    const offset = (hi & 0x0000ffff) * 4294967296 + lo;
    fileIndex.push(offset);
  }

  const trailerStart = fileIndex[24];
  if (trailerStart < 200 || trailerStart > bytes.byteLength) {
    throw new Error(`Invalid RD5 trailer offset ${trailerStart} (size ${bytes.byteLength})`);
  }

  const trailerLen = bytes.byteLength - trailerStart;
  const headerAndTrailer = new Uint8Array(200 + trailerLen);
  headerAndTrailer.set(bytes.subarray(0, 200), 0);
  headerAndTrailer.set(bytes.subarray(trailerStart), 200);

  const nonEmptySquares: number[] = [];
  const subtiles: Array<{ subIdx: number; data: ArrayBuffer }> = [];

  for (let i = 0; i < 25; i++) {
    const start = i === 0 ? 200 : fileIndex[i - 1];
    const end = fileIndex[i];
    if (end > start) {
      nonEmptySquares.push(i);
      subtiles.push({
        subIdx: i,
        data: toArrayBuffer(bytes.subarray(start, end)),
      });
    }
  }

  return {
    meta: {
      size: bytes.byteLength,
      creationDate: creationDateIso,
      fileIndex,
      nonEmptySquares,
    },
    headerAndTrailer: headerAndTrailer.buffer,
    subtiles,
  };
}

/**
 * Decomposes an `.rd5` buffer into its 25 1x1 degree sub-tiles and stores each sub-tile
 * as an independent object in `BlobStorage` (`rd5/<segmentId>/sub_<i>`).
 */
export async function writeDecomposedRd5(
  storage: BlobStorage,
  segmentId: string,
  bytes: Uint8Array,
  creationDateIso: string,
): Promise<Rd5DecomposedMeta> {
  const { meta, headerAndTrailer, subtiles } = decomposeRd5Buffer(bytes, creationDateIso);
  await storage.write(
    'rd5',
    `${segmentId}/header_trailer`,
    headerAndTrailer,
    'application/octet-stream',
  );
  for (const sub of subtiles) {
    await storage.write(
      'rd5',
      `${segmentId}/sub_${sub.subIdx}`,
      sub.data,
      'application/octet-stream',
    );
  }
  const metaBytes = toArrayBuffer(textEncoder.encode(JSON.stringify(meta)));
  await storage.write('rd5', `${segmentId}/meta`, metaBytes, 'application/json');
  return meta;
}

export async function getDecomposedRd5Meta(
  storage: BlobStorage,
  segmentId: string,
): Promise<Rd5DecomposedMeta | null> {
  const entry = await storage.read('rd5', `${segmentId}/meta`);
  if (!entry) return null;
  try {
    return JSON.parse(textDecoder.decode(entry.data)) as Rd5DecomposedMeta;
  } catch {
    return null;
  }
}

export async function readDecomposedRd5Subtile(
  storage: BlobStorage,
  segmentId: string,
  subIdx: number,
): Promise<Uint8Array | null> {
  const entry = await storage.read('rd5', `${segmentId}/sub_${subIdx}`);
  if (!entry) return null;
  return new Uint8Array(entry.data);
}

export async function reassembleDecomposedRd5(
  storage: BlobStorage,
  segmentId: string,
): Promise<Uint8Array | null> {
  const meta = await getDecomposedRd5Meta(storage, segmentId);
  if (!meta) return null;
  const htEntry = await storage.read('rd5', `${segmentId}/header_trailer`);
  if (!htEntry || htEntry.data.byteLength < 200) return null;

  const htBytes = new Uint8Array(htEntry.data);
  const out = new Uint8Array(meta.size);
  out.set(htBytes.subarray(0, 200), 0);

  for (const subIdx of meta.nonEmptySquares) {
    const start = subIdx === 0 ? 200 : meta.fileIndex[subIdx - 1];
    const end = meta.fileIndex[subIdx];
    const subEntry = await storage.read('rd5', `${segmentId}/sub_${subIdx}`);
    if (!subEntry || subEntry.data.byteLength !== end - start) return null;
    out.set(new Uint8Array(subEntry.data), start);
  }

  const trailerStart = meta.fileIndex[24];
  out.set(htBytes.subarray(200), trailerStart);
  return out;
}

export async function deleteDecomposedRd5(
  storage: BlobStorage,
  segmentId: string,
): Promise<void> {
  const items = await storage.list('rd5', `${segmentId}/`);
  for (const item of items) {
    await storage.delete('rd5', item.key);
  }
}

/**
 * Streams a `.pmtiles` archive into fixed-size 1 MB blocks inside `BlobStorage`
 * (`pmtiles/<segmentId>/block_<n>`), avoiding any Range or Blob.slice support in the store.
 */
export async function writePmtilesStreamToBlocks(
  storage: BlobStorage,
  segmentId: string,
  stream: ReadableStream<Uint8Array>,
  totalHint: number,
  onProgress?: (received: number, total: number) => void,
  blockSize = PMTILES_BLOCK_SIZE,
): Promise<PmtilesDecomposedMeta> {
  await deletePmtilesBlocks(storage, segmentId);

  const reader = stream.getReader();
  const blockBuf = new Uint8Array(blockSize);
  let blockFill = 0;
  let blockIdx = 0;
  let received = 0;
  let lastReport = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;

    let offset = 0;
    while (offset < value.byteLength) {
      const space = blockSize - blockFill;
      const take = Math.min(space, value.byteLength - offset);
      blockBuf.set(value.subarray(offset, offset + take), blockFill);
      blockFill += take;
      offset += take;

      if (blockFill === blockSize) {
        await storage.write(
          'pmtiles',
          `${segmentId}/block_${blockIdx}`,
          toArrayBuffer(blockBuf),
          'application/octet-stream',
        );
        blockIdx++;
        blockFill = 0;
      }
    }

    received += value.byteLength;
    if (onProgress) {
      const now = Date.now();
      if (now - lastReport > 250) {
        lastReport = now;
        onProgress(received, totalHint);
      }
    }
  }

  if (blockFill > 0) {
    await storage.write(
      'pmtiles',
      `${segmentId}/block_${blockIdx}`,
      toArrayBuffer(blockBuf.subarray(0, blockFill)),
      'application/octet-stream',
    );
    blockIdx++;
  }

  if (totalHint > 0 && received !== totalHint) {
    throw new Error(`Incomplete PMTiles stream for ${segmentId}: ${received} of ${totalHint} bytes`);
  }

  const meta: PmtilesDecomposedMeta = {
    size: received,
    blockSize,
    blockCount: blockIdx,
  };
  const metaBytes = toArrayBuffer(textEncoder.encode(JSON.stringify(meta)));
  await storage.write('pmtiles', `${segmentId}/meta`, metaBytes, 'application/json');
  return meta;
}

export async function getPmtilesMeta(
  storage: BlobStorage,
  segmentId: string,
): Promise<PmtilesDecomposedMeta | null> {
  const entry = await storage.read('pmtiles', `${segmentId}/meta`);
  if (!entry) return null;
  try {
    return JSON.parse(textDecoder.decode(entry.data)) as PmtilesDecomposedMeta;
  } catch {
    return null;
  }
}

export async function deletePmtilesBlocks(
  storage: BlobStorage,
  segmentId: string,
): Promise<void> {
  const items = await storage.list('pmtiles', `${segmentId}/`);
  for (const item of items) {
    await storage.delete('pmtiles', item.key);
  }
}

/**
 * `pmtiles.Source` implementation that reads fixed-size blocks from unmodified `BlobStorage`
 * (`storage.read('pmtiles', '<segmentId>/block_<n>')`) and slices the requested range in memory.
 */
export class ChunkedPmtilesSource implements pmtiles.Source {
  private readonly storage: BlobStorage;
  private readonly segmentId: string;
  private readonly meta: PmtilesDecomposedMeta;

  constructor(
    storage: BlobStorage,
    segmentId: string,
    meta: PmtilesDecomposedMeta,
  ) {
    this.storage = storage;
    this.segmentId = segmentId;
    this.meta = meta;
  }

  getKey(): string {
    return `pmtiles-mecha://${this.segmentId}`;
  }

  async getBytes(
    offset: number,
    length: number,
  ): Promise<pmtiles.RangeResponse> {
    if (length <= 0 || offset >= this.meta.size) {
      return { data: new ArrayBuffer(0) };
    }
    const clampedEnd = Math.min(this.meta.size, offset + length);
    const totalLen = clampedEnd - offset;
    const blockSize = this.meta.blockSize;
    const firstBlock = Math.floor(offset / blockSize);
    const lastBlock = Math.floor((clampedEnd - 1) / blockSize);

    if (firstBlock === lastBlock) {
      const entry = await this.storage.read('pmtiles', `${this.segmentId}/block_${firstBlock}`);
      if (!entry) {
        throw new Error(`Missing PMTiles block ${this.segmentId}/block_${firstBlock}`);
      }
      const startInBlock = offset - firstBlock * blockSize;
      return {
        data: entry.data.slice(startInBlock, startInBlock + totalLen),
      };
    }

    const out = new Uint8Array(totalLen);
    let written = 0;
    for (let b = firstBlock; b <= lastBlock; b++) {
      const entry = await this.storage.read('pmtiles', `${this.segmentId}/block_${b}`);
      if (!entry) {
        throw new Error(`Missing PMTiles block ${this.segmentId}/block_${b}`);
      }
      const blockStartByte = b * blockSize;
      const copyStart = Math.max(0, offset - blockStartByte);
      const copyEnd = Math.min(entry.data.byteLength, clampedEnd - blockStartByte);
      const slice = new Uint8Array(entry.data, copyStart, copyEnd - copyStart);
      out.set(slice, written);
      written += slice.byteLength;
    }

    return { data: out.buffer };
  }
}
