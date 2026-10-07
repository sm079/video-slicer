// Content fingerprint used to recognise a video again, whatever it is named or wherever it
// lives. Small files are hashed whole. Large ones hash their size plus evenly spaced 1 MiB
// samples (always including the first and last MiB): container headers, sample tables and
// frame data all differ between real videos, and this reads tens of MB instead of gigabytes.

const SAMPLE = 1 << 20;
const SAMPLES = 32;
const WHOLE_LIMIT = 64 << 20;

/** Byte ranges hashed for a file of `size` bytes, in file order, non-overlapping. */
export function sampleRanges(size: number): [number, number][] {
  if (size <= WHOLE_LIMIT) return [[0, size]];
  const ranges: [number, number][] = [];
  const step = (size - SAMPLE) / (SAMPLES - 1);
  for (let i = 0; i < SAMPLES; i++) {
    const at = Math.round(i * step);
    ranges.push([at, at + SAMPLE]);
  }
  return ranges;
}

const cache = new WeakMap<File, Promise<string>>();

/** Hex SHA-256 fingerprint of the file's content. */
export function hashFile(file: File): Promise<string> {
  let p = cache.get(file);
  if (!p) {
    p = digest(file);
    cache.set(file, p);
    p.catch(() => cache.delete(file));
  }
  return p;
}

async function digest(file: File): Promise<string> {
  const ranges = sampleRanges(file.size);
  const head = new Uint8Array(8);
  new DataView(head.buffer).setBigUint64(0, BigInt(file.size));
  const parts = await Promise.all(ranges.map(([a, b]) => file.slice(a, b).arrayBuffer()));
  const all = new Uint8Array(8 + parts.reduce((s, p) => s + p.byteLength, 0));
  all.set(head);
  let o = 8;
  for (const p of parts) { all.set(new Uint8Array(p), o); o += p.byteLength; }
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return Array.from(h, b => b.toString(16).padStart(2, '0')).join('');
}
