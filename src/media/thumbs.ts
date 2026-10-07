import type { Demux } from './demux';

/** Filmstrip thumbnails, one per GOP: only keyframes are decoded, so this stays cheap on long videos. */
export class ThumbServer {
  onThumb: () => void = () => {};
  readonly height: number;
  readonly width: number;
  private cache = new Map<number, ImageBitmap>();
  private queue: number[] = [];
  private busy = false;
  private failed = false;
  private disposed = false;
  private decoder: VideoDecoder | null = null;
  private outputs: Promise<void>[] = [];

  constructor(private demux: Demux, height = 72) {
    const { rawW, rawH } = demux.info;
    this.height = height;
    this.width = Math.max(8, Math.round(height * rawW / rawH));
  }

  /** Thumbnail for the GOP containing source frame idx (raw orientation). */
  get(idx: number) {
    return this.cache.get(this.demux.index.gop[idx]);
  }

  /** Replace the queue with these source frames, most important first. */
  request(indices: number[]) {
    if (this.failed) return;
    const gops = new Set<number>();
    this.queue = [];
    for (const i of indices) {
      const g = this.demux.index.gop[i];
      if (!this.cache.has(g) && !gops.has(g)) { gops.add(g); this.queue.push(i); }
    }
    void this.run();
  }

  dispose() {
    this.disposed = true;
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    for (const b of this.cache.values()) b.close();
    this.cache.clear();
  }

  private ensureDecoder() {
    if (this.decoder && this.decoder.state === 'configured') return this.decoder;
    this.decoder = new VideoDecoder({
      output: frame => {
        const idx = this.demux.index.byUs.get(frame.timestamp);
        const p = createImageBitmap(frame, { resizeWidth: this.width, resizeHeight: this.height, resizeQuality: 'medium' })
          .then(b => {
            if (idx === undefined || this.disposed) { b.close(); return; }
            this.cache.set(this.demux.index.gop[idx], b);
          })
          .catch(() => {})
          .finally(() => frame.close());
        this.outputs.push(p);
      },
      error: e => { console.warn('thumbnail decoder', e); this.decoder = null; },
    });
    this.decoder.configure(this.demux.config);
    return this.decoder;
  }

  private async run() {
    if (this.busy || this.disposed) return;
    this.busy = true;
    let errors = 0;
    try {
      while (this.queue.length && !this.disposed) {
        // A few keyframes per flush: every one decodes on its own.
        const batch = this.queue.splice(0, 4);
        try {
          const decoder = this.ensureDecoder();
          for (const idx of batch) {
            const chunk = await this.demux.keyChunk(idx);
            if (chunk && decoder.state === 'configured') decoder.decode(chunk);
          }
          if (decoder.state === 'configured') await decoder.flush();
          await Promise.all(this.outputs);
          this.outputs = [];
          // Mark GOPs whose keyframe came back under another timestamp so they are not retried forever.
          for (const idx of batch) {
            const g = this.demux.index.gop[idx];
            if (!this.cache.has(g)) {
              const near = this.nearestThumb(g);
              if (near) this.cache.set(g, near);
            }
          }
          this.onThumb();
        } catch (e) {
          console.warn('thumbnail', e);
          this.decoder = null;
          if (++errors > 5) { this.failed = true; return; }
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private nearestThumb(g: number) {
    for (let d = 1; d < 8; d++) {
      const b = this.cache.get(g - d) ?? this.cache.get(g + d);
      if (b) return b;
    }
    return undefined;
  }
}
