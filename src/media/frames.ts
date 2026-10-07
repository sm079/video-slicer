import type { Demux } from './demux';

/**
 * Decodes source frames on demand and keeps them as full-resolution ImageBitmaps.
 *
 * One decode session runs at a time: it starts at the keyframe a wanted frame needs and
 * feeds packets in decode order until every wanted frame has come out. Wanted frames that
 * lie ahead in the same or the next GOP are served by the running session, so playback and
 * stepping forward never re-decode; anything else restarts the session at the right
 * keyframe. Frames nobody asked for are closed straight away without a copy.
 */
export class FrameServer {
  onFrame: (idx: number) => void = () => {};
  onError: (msg: string) => void = () => {};

  private cache = new Map<number, ImageBitmap>();
  private bytes = 0;
  private goal: number[] = [];
  private goalSet = new Set<number>();
  private pinned = new Set<number>();
  private waiters = new Map<number, ((b: ImageBitmap | null) => void)[]>();
  private inflight = new Map<number, Promise<void>>();
  private missing = new Set<number>();
  private retries = new Map<number, number>();

  private decoder: VideoDecoder | null = null;
  private iter: AsyncGenerator<EncodedVideoChunk> | null = null;
  private session = 0;
  private startGop = -1;
  private fedGop = -1;
  private lastOutUs = -Infinity;
  private seen = new Set<number>();
  private ended = false;
  private pumping = false;
  private disposed = false;

  constructor(private demux: Demux, public budget = 1024 * 1024 * 1024) {}

  get frameBytes() {
    return this.demux.info.rawW * this.demux.info.rawH * 4;
  }

  /** How many frames fit in the cache budget. */
  get capacity() {
    return Math.max(4, Math.floor(this.budget / this.frameBytes));
  }

  get(idx: number): ImageBitmap | undefined {
    const b = this.cache.get(idx);
    if (b) { this.cache.delete(idx); this.cache.set(idx, b); }
    return b;
  }

  has(idx: number) {
    return this.cache.has(idx);
  }

  isMissing(idx: number) {
    return this.missing.has(idx);
  }

  /** Latest cached frame at or before idx, for showing something while decoding. */
  nearest(idx: number, within = 1e9): ImageBitmap | undefined {
    for (let i = idx; i >= 0 && idx - i <= within; i--) {
      const b = this.cache.get(i);
      if (b) return b;
    }
    return undefined;
  }

  /** Replace the wanted set. Order is priority: the frame on screen first, then what plays next. */
  want(indices: number[]) {
    const seen = new Set<number>();
    this.goal = [];
    for (const i of indices) if (i >= 0 && i < this.demux.index.count && !seen.has(i)) { seen.add(i); this.goal.push(i); }
    for (const i of this.waiters.keys()) if (!seen.has(i)) { seen.add(i); this.goal.push(i); }
    this.goalSet = seen;
    void this.pump();
  }

  /** Frames that survive eviction (the start of a looping window, say). */
  pin(indices: Iterable<number>) {
    this.pinned = new Set(indices);
  }

  request(idx: number): Promise<ImageBitmap | null> {
    const b = this.get(idx);
    if (b) return Promise.resolve(b);
    if (this.missing.has(idx)) return Promise.resolve(null);
    return new Promise(resolve => {
      const list = this.waiters.get(idx) ?? [];
      list.push(resolve);
      this.waiters.set(idx, list);
      if (!this.goalSet.has(idx)) { this.goal.unshift(idx); this.goalSet.add(idx); }
      void this.pump();
    });
  }

  clear() {
    for (const b of this.cache.values()) b.close();
    this.cache.clear();
    this.bytes = 0;
  }

  dispose() {
    this.disposed = true;
    this.session++;
    this.iter?.return(undefined);
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.clear();
    for (const [, list] of this.waiters) list.forEach(r => r(null));
    this.waiters.clear();
  }

  private resolve(idx: number, b: ImageBitmap | null) {
    const list = this.waiters.get(idx);
    if (list) { this.waiters.delete(idx); list.forEach(r => r(b)); }
  }

  private put(idx: number, bmp: ImageBitmap) {
    const old = this.cache.get(idx);
    if (old) { old.close(); this.bytes -= old.width * old.height * 4; this.cache.delete(idx); }
    this.cache.set(idx, bmp);
    this.bytes += bmp.width * bmp.height * 4;
    // Progress was made, so earlier restarts were not a decode failure loop.
    this.retries.clear();
    this.evict();
    this.resolve(idx, bmp);
    this.onFrame(idx);
  }

  private evict() {
    if (this.bytes <= this.budget) return;
    for (const [i, b] of this.cache) {
      if (this.bytes <= this.budget) break;
      if (this.goalSet.has(i) || this.pinned.has(i)) continue;
      b.close();
      this.cache.delete(i);
      this.bytes -= b.width * b.height * 4;
    }
  }

  private markMissing(idx: number) {
    this.missing.add(idx);
    this.resolve(idx, null);
    this.onFrame(idx);
  }

  private onOutput(frame: VideoFrame, session: number) {
    if (session !== this.session) { frame.close(); return; }
    const us = frame.timestamp;
    if (us > this.lastOutUs) this.lastOutUs = us;
    const idx = this.demux.index.byUs.get(us);
    if (idx === undefined) { frame.close(); return; }
    this.seen.add(idx);
    if (this.cache.has(idx) || this.inflight.has(idx) || !(this.goalSet.has(idx) || this.waiters.has(idx))) {
      frame.close();
      return;
    }
    const p = createImageBitmap(frame)
      .then(bmp => { if (this.disposed) bmp.close(); else this.put(idx, bmp); })
      .catch(e => console.warn('frame copy failed', e))
      .finally(() => { frame.close(); this.inflight.delete(idx); });
    this.inflight.set(idx, p);
  }

  private reachable(target: number) {
    const { gop, us } = this.demux.index;
    return !!this.decoder && this.decoder.state === 'configured' && !!this.iter && !this.ended
      && gop[target] >= this.startGop && gop[target] <= this.fedGop + 1 && us[target] > this.lastOutUs;
  }

  private restart(target: number) {
    this.session++;
    const session = this.session;
    this.iter?.return(undefined);
    if (!this.decoder || this.decoder.state === 'closed') {
      this.decoder = new VideoDecoder({
        output: f => this.onOutput(f, this.session),
        error: e => {
          console.warn('decoder error', e);
          this.onError(`Decoder error: ${e.message}`);
          if (this.session === session) this.decoder = null;
        },
      });
    } else {
      this.decoder.reset();
    }
    this.decoder.configure({ ...this.demux.config, optimizeForLatency: true });
    this.iter = this.demux.packets(target);
    this.startGop = this.demux.index.gop[target];
    this.fedGop = -1;
    this.lastOutUs = -Infinity;
    this.seen.clear();
    this.ended = false;
  }

  private async pump() {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.disposed) return;
        const target = this.goal.find(i => !this.cache.has(i) && !this.missing.has(i));
        if (target === undefined) return;
        const flight = this.inflight.get(target);
        if (flight) { await flight; continue; }
        if (!this.reachable(target)) {
          const { us } = this.demux.index;
          // The running session went past it without the decoder ever producing it.
          const skipped = this.decoder && this.iter && us[target] <= this.lastOutUs && !this.seen.has(target)
            && this.demux.index.gop[target] >= this.startGop;
          const tries = (this.retries.get(target) ?? 0) + 1;
          this.retries.set(target, tries);
          if (skipped || tries > 3) { this.markMissing(target); continue; }
          this.restart(target);
        }
        await this.feed();
      }
    } catch (e) {
      console.error(e);
      this.onError(String((e as Error)?.message ?? e));
      this.decoder = null;
    } finally {
      this.pumping = false;
    }
  }

  private async feed() {
    const decoder = this.decoder!, session = this.session;
    if (decoder.decodeQueueSize > 4) {
      await new Promise<void>(r => {
        const t = setTimeout(r, 20);
        decoder.addEventListener('dequeue', () => { clearTimeout(t); r(); }, { once: true });
      });
      return;
    }
    const { done, value } = await this.iter!.next();
    if (session !== this.session || decoder.state !== 'configured') return;
    if (done) {
      this.ended = true;
      await decoder.flush().catch(() => {});
      await Promise.all(this.inflight.values());
      // Anything wanted from this session that never came out does not exist.
      for (const i of this.goal) {
        if (!this.cache.has(i) && this.demux.index.gop[i] >= this.startGop && !this.inflight.has(i)) {
          if (!this.seen.has(i)) this.markMissing(i);
        }
      }
      return;
    }
    const idx = this.demux.index.byUs.get(value.timestamp);
    if (idx !== undefined) this.fedGop = Math.max(this.fedGop, this.demux.index.gop[idx]);
    decoder.decode(value);
  }
}
