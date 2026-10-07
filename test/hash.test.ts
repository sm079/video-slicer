import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashFile, sampleRanges } from '../src/media/hash.ts';

test('small files are hashed whole', () => {
  assert.deepEqual(sampleRanges(0), [[0, 0]]);
  assert.deepEqual(sampleRanges(5 << 20), [[0, 5 << 20]]);
});

test('large files are sampled from first to last MiB without overlap', () => {
  const size = 3 * 1024 ** 3 + 12345;
  const r = sampleRanges(size);
  assert.equal(r.length, 32);
  assert.deepEqual(r[0], [0, 1 << 20]);
  assert.equal(r[r.length - 1][1], size);
  for (let i = 1; i < r.length; i++) assert.ok(r[i][0] >= r[i - 1][1]);
});

test('hash depends on content, not name or date', async () => {
  const bytes = new Uint8Array(1000).map((_, i) => i * 7);
  const a = await hashFile(new File([bytes], 'a.mp4', { lastModified: 1 }));
  const b = await hashFile(new File([bytes], 'renamed.mp4', { lastModified: 2 }));
  bytes[500] ^= 1;
  const c = await hashFile(new File([bytes], 'a.mp4', { lastModified: 1 }));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});
