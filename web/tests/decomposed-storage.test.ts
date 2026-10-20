import test from 'node:test';
import assert from 'node:assert/strict';
import type { BlobStorage } from '../../subrepos/mecha/packages/rclone-js/src/types.ts';
import {
  ChunkedPmtilesSource,
  deleteDecomposedRd5,
  deletePmtilesBlocks,
  getDecomposedRd5Meta,
  getPmtilesMeta,
  readDecomposedRd5Subtile,
  reassembleDecomposedRd5,
  writeDecomposedRd5,
  writePmtilesStreamToBlocks,
} from '../src/pronto/decomposed-storage.ts';

function createMemoryBlobStorage(): BlobStorage {
  const map = new Map<string, { data: ArrayBuffer; contentType: string }>();
  const keyOf = (bucket: string, key: string) => `${bucket}/${key}`;
  return {
    async read(bucket, key) {
      return map.get(keyOf(bucket, key)) ?? null;
    },
    async write(bucket, key, data, contentType) {
      map.set(keyOf(bucket, key), { data, contentType });
    },
    async delete(bucket, key) {
      return map.delete(keyOf(bucket, key));
    },
    async head(bucket, key) {
      const entry = map.get(keyOf(bucket, key));
      return entry ? { size: entry.data.byteLength, contentType: entry.contentType } : null;
    },
    async list(bucket, prefix) {
      const fullPrefix = `${bucket}/${prefix}`;
      const out: Array<{ key: string; size: number }> = [];
      for (const [k, v] of map.entries()) {
        if (k.startsWith(fullPrefix)) {
          out.push({ key: k.slice(`${bucket}/`.length), size: v.data.byteLength });
        }
      }
      return out;
    },
  };
}

test('writeDecomposedRd5 splits RD5 into 1x1 degree subtiles and reassembles byte-identically', async () => {
  const storage = createMemoryBlobStorage();

  // Construct a synthetic RD5 file with 200-byte header, 2 non-empty squares (sub_0 and sub_12), and 16-byte trailer
  const sub0 = new Uint8Array([10, 20, 30, 40, 50]);
  const sub12 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const trailer = new Uint8Array(16);
  trailer.fill(0xaa);

  const totalSize = 200 + sub0.byteLength + sub12.byteLength + trailer.byteLength;
  const rd5 = new Uint8Array(totalSize);
  const view = new DataView(rd5.buffer);

  let cursor = 200;
  for (let i = 0; i < 25; i++) {
    if (i === 0) cursor += sub0.byteLength;
    if (i === 12) cursor += sub12.byteLength;
    view.setUint32(i * 8, 0);
    view.setUint32(i * 8 + 4, cursor);
  }
  rd5.set(sub0, 200);
  rd5.set(sub12, 200 + sub0.byteLength);
  rd5.set(trailer, 200 + sub0.byteLength + sub12.byteLength);

  const iso = '2026-10-20T00:00:00.000Z';
  const meta = await writeDecomposedRd5(storage, 'W5_N50', rd5, iso);
  assert.equal(meta.size, totalSize);
  assert.deepEqual(meta.nonEmptySquares, [0, 12]);

  const loadedMeta = await getDecomposedRd5Meta(storage, 'W5_N50');
  assert.deepEqual(loadedMeta, meta);

  const readSub0 = await readDecomposedRd5Subtile(storage, 'W5_N50', 0);
  assert.deepEqual(readSub0, sub0);

  const readSub12 = await readDecomposedRd5Subtile(storage, 'W5_N50', 12);
  assert.deepEqual(readSub12, sub12);

  const reassembled = await reassembleDecomposedRd5(storage, 'W5_N50');
  assert.deepEqual(reassembled, rd5);

  await deleteDecomposedRd5(storage, 'W5_N50');
  assert.equal(await getDecomposedRd5Meta(storage, 'W5_N50'), null);
});

test('writePmtilesStreamToBlocks and ChunkedPmtilesSource read arbitrary byte ranges across blocks', async () => {
  const storage = createMemoryBlobStorage();

  // Create 250 bytes of deterministic data and decompose into 64-byte blocks
  const raw = new Uint8Array(250);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = i & 0xff;
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(raw.subarray(0, 100));
      controller.enqueue(raw.subarray(100, 210));
      controller.enqueue(raw.subarray(210, 250));
      controller.close();
    },
  });

  const meta = await writePmtilesStreamToBlocks(storage, 'E0_N50', stream, 250, undefined, 64);
  assert.equal(meta.size, 250);
  assert.equal(meta.blockSize, 64);
  assert.equal(meta.blockCount, 4);

  const loadedMeta = await getPmtilesMeta(storage, 'E0_N50');
  assert.deepEqual(loadedMeta, meta);

  const source = new ChunkedPmtilesSource(storage, 'E0_N50', meta);

  // 1. Single-block slice inside block 0
  const r1 = await source.getBytes(10, 20);
  assert.deepEqual(new Uint8Array(r1.data), raw.subarray(10, 30));

  // 2. Cross-block slice spanning block 0, block 1, and block 2 (offset 50, length 90 -> 50..140)
  const r2 = await source.getBytes(50, 90);
  assert.deepEqual(new Uint8Array(r2.data), raw.subarray(50, 140));

  // 3. Tail slice clamping at end of file
  const r3 = await source.getBytes(230, 50);
  assert.deepEqual(new Uint8Array(r3.data), raw.subarray(230, 250));

  await deletePmtilesBlocks(storage, 'E0_N50');
  assert.equal(await getPmtilesMeta(storage, 'E0_N50'), null);
});
