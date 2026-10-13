import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getRd5CreationDate, isHtml, SEGMENT_CACHE_NAME, UK_SEGMENTS } from '../src/segment-cache.ts';

test('getRd5CreationDate returns null for short buffer', () => {
  const buf = new ArrayBuffer(100);
  assert.equal(getRd5CreationDate(buf), null);
});

test('getRd5CreationDate parses timestamp from synthetic trailer', () => {
  const buf = new ArrayBuffer(300);
  const view = new DataView(buf);
  // pos24 pointer at byte 192 pointing to offset 250
  view.setUint32(192, 0);
  view.setUint32(196, 250);

  // timestamp at byte 250: 1776048000000 ms (2026-04-13T02:40:00.000Z)
  const targetMs = 1776048000000;
  const hi = Math.floor(targetMs / 4294967296);
  const lo = targetMs >>> 0;
  view.setInt32(250, hi);
  view.setUint32(254, lo);

  const date = getRd5CreationDate(buf);
  assert.ok(date !== null);
  assert.equal(date.getTime(), targetMs);
});

test('getRd5CreationDate parses real rd5 file if available', () => {
  const filePath = join(process.cwd(), '../data/segments4/E0_N50.rd5');
  if (existsSync(filePath)) {
    const fileBytes = readFileSync(filePath);
    const date = getRd5CreationDate(fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength));
    assert.ok(date instanceof Date);
    assert.equal(date.getUTCFullYear(), 2026);
    assert.equal(date.getUTCMonth(), 9); // October (0-indexed: 9)
    assert.ok(date.getUTCDate() >= 12);
  }
});

test('isHtml identifies html responses', () => {
  const htmlRes = new Response('<html></html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
  const binRes = new Response(new Uint8Array(10), {
    headers: { 'content-type': 'application/octet-stream' },
  });
  assert.equal(isHtml(htmlRes), true);
  assert.equal(isHtml(binRes), false);
});

test('cache configuration constants', () => {
  assert.equal(SEGMENT_CACHE_NAME, 'rsrouter-segments-v3');
  assert.ok(UK_SEGMENTS.includes('E0_N50'));
  assert.ok(UK_SEGMENTS.includes('W5_N50'));
});
