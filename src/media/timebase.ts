import type { FrameIndex } from './demux';

const COMMON = [
  [24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [48, 1], [50, 1],
  [60000, 1001], [60, 1], [90, 1], [100, 1], [120000, 1001], [120, 1], [144, 1], [240, 1],
  [15, 1], [12, 1], [10, 1], [8, 1], [6, 1], [5, 1],
];

/** The source's nominal frame rate: mean frame spacing, snapped to a common rate when close. */
export function detectFps(index: FrameIndex): number {
  const n = index.count - index.first;
  if (n < 2) return 30;
  // The mean spacing over the whole stream; per-frame gaps suffer from timestamp rounding
  // (WebM stores milliseconds), the average does not.
  const raw = (n - 1) / (index.pts[index.count - 1] - index.pts[index.first]);
  let best = 0, err = Infinity;
  for (const [num, den] of COMMON) {
    const e = Math.abs(raw - num / den) / (num / den);
    if (e < err) { err = e; best = num / den; }
  }
  if (err < 0.0005) return best;
  return Math.round(raw * 1000) / 1000;
}

/** Parses "29.97", "30000/1001" or "30". */
export function parseFps(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const m = t.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  const v = m ? Number(m[1]) / Number(m[2]) : Number(t);
  return Number.isFinite(v) && v > 0 && v <= 1000 ? v : null;
}

export function formatFps(fps: number): string {
  for (const [num, den] of COMMON) if (den !== 1 && Math.abs(num / den - fps) < 1e-9) return `${(num / den).toFixed(3)} (${num}/${den})`;
  return String(Math.round(fps * 1000) / 1000);
}

/**
 * Output frames of the video conformed to a frame rate.
 * Native (fps = null) is frame-for-frame: output frame i is source frame i, even for
 * variable frame rate. Otherwise output frame i covers [i/fps, (i+1)/fps) from the first
 * frame and shows the source frame on screen at the middle of that interval, which is
 * the frame ffmpeg's fps filter picks.
 */
export class Timebase {
  readonly native: boolean;
  readonly fps: number;
  readonly count: number;
  private readonly map: Int32Array;
  readonly index: FrameIndex;
  readonly sourceFps: number;

  constructor(index: FrameIndex, fps: number | null, sourceFps: number) {
    this.index = index;
    this.sourceFps = sourceFps;
    this.native = fps == null;
    this.fps = fps ?? sourceFps;
    const { pts, first, end } = index;
    const visible = index.count - first;
    if (this.native) {
      this.count = visible;
      this.map = new Int32Array(visible);
      for (let i = 0; i < visible; i++) this.map[i] = first + i;
      return;
    }
    const t0 = pts[first];
    this.count = Math.max(1, Math.floor((end - t0) * this.fps + 1e-6));
    this.map = new Int32Array(this.count);
    let j = first;
    for (let i = 0; i < this.count; i++) {
      // Same choice as ffmpeg's fps filter: the last frame that starts before the middle
      // of the output frame's interval.
      const mid = t0 + (i + 0.5) / this.fps;
      while (j + 1 < index.count && pts[j + 1] < mid - 1e-7) j++;
      this.map[i] = j;
    }
  }

  /** Source frame index shown at output frame i. */
  src(i: number): number {
    return this.map[Math.max(0, Math.min(this.count - 1, i))];
  }

  /** Seconds from the first frame to output frame i. */
  time(i: number): number {
    if (this.native) return this.index.pts[this.src(i)] - this.index.pts[this.index.first];
    return i / this.fps;
  }

  /** Output frame showing at `sec` seconds from the first frame. */
  frameAt(sec: number): number {
    if (!this.native) return Math.max(0, Math.min(this.count - 1, Math.floor(sec * this.fps + 1e-6)));
    const t = sec + this.index.pts[this.index.first];
    let lo = 0, hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.index.pts[this.map[mid]] <= t + 1e-9) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** Duration of the conformed video in seconds. */
  get duration(): number {
    return this.native ? this.index.end - this.index.pts[this.index.first] : this.count / this.fps;
  }
}
