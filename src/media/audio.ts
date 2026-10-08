// Audio for playback (Web Audio, kept in step with the frame-paced video clock) and for
// export (the exact sample range under a clip, gaps filled with silence).

import type { AudioStream } from './demux';

const VOLUME_KEY = 'vs.volume';
const MUTED_KEY = 'vs.muted';
/** Seconds of audio scheduled ahead of the output. */
const AHEAD = 0.6;
/** Loops up to this long keep their decoded audio, so later passes don't decode again. */
const CACHE_LOOP = 30;

interface Session {
  stream: AudioStream;
  /** Media time `t0` is heard at context time `origin` + output latency. */
  t0: number;
  origin: number;
  loop: [number, number] | null;
  nodes: Set<AudioBufferSourceNode>;
  dead: boolean;
}

type Chunk = { t: number; buf: AudioBuffer };

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private session: Session | null = null;
  private loopCache: { stream: AudioStream; key: string; chunks: Chunk[] } | null = null;
  private _volume: number;
  private _muted: boolean;

  constructor() {
    let v = 1, m = false;
    try {
      const s = localStorage.getItem(VOLUME_KEY);
      if (s != null && Number.isFinite(Number(s))) v = Math.max(0, Math.min(1, Number(s)));
      m = localStorage.getItem(MUTED_KEY) === '1';
    } catch { /* storage unavailable */ }
    this._volume = v;
    this._muted = m;
  }

  get volume() { return this._volume; }
  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    try { localStorage.setItem(VOLUME_KEY, String(this._volume)); } catch { /* storage unavailable */ }
    this.applyGain();
  }

  get muted() { return this._muted; }
  set muted(m: boolean) {
    this._muted = m;
    try { localStorage.setItem(MUTED_KEY, m ? '1' : '0'); } catch { /* storage unavailable */ }
    this.applyGain();
  }

  get playing() { return !!this.session; }

  private applyGain() {
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(this._muted ? 0 : this._volume, this.ctx.currentTime, 0.015);
  }

  private get latency() {
    const c = this.ctx!;
    return (c.outputLatency || 0) + (c.baseLatency || 0);
  }

  /** Play from media time `t`, now. With `loop`, repeat [from, to) seamlessly. Call from a user gesture the first time. */
  start(stream: AudioStream, t: number, loop: [number, number] | null = null) {
    this.stop();
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this._muted ? 0 : this._volume;
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (loop && t >= loop[1]) t = loop[0];
    // What is scheduled now is heard `latency` later, so start that far into the media.
    const s: Session = { stream, t0: t + this.latency, origin: this.ctx.currentTime, loop, nodes: new Set(), dead: false };
    if (loop && s.t0 >= loop[1]) s.t0 = loop[0] + ((s.t0 - loop[0]) % (loop[1] - loop[0]));
    this.session = s;
    this.run(s).catch(e => { if (!s.dead) console.warn('audio playback stopped', e); });
  }

  stop() {
    const s = this.session;
    if (!s) return;
    s.dead = true;
    for (const n of s.nodes) { try { n.stop(); } catch { /* not started */ } n.disconnect(); }
    s.nodes.clear();
    this.session = null;
  }

  /** The media time being heard now, or null when not playing. */
  position(): number | null {
    const s = this.session;
    if (!s || !this.ctx) return null;
    let p = s.t0 + (this.ctx.currentTime - s.origin) - this.latency;
    if (s.loop) {
      const [a, b] = s.loop;
      if (p >= b) p = a + ((p - a) % (b - a));
    }
    return p;
  }

  private async run(s: Session) {
    const ctx = this.ctx!;
    let from = s.t0, origin = s.origin;
    const end = s.loop ? s.loop[1] : Infinity;
    const key = s.loop ? `${s.loop[0]}:${s.loop[1]}` : '';
    for (;;) {
      // A pass plays media [from, end) starting at context time `origin`.
      const lc = this.loopCache;
      const cached = s.loop && lc?.stream === s.stream && lc.key === key && from === s.loop[0] ? lc.chunks : null;
      const keep: Chunk[] | null = !cached && s.loop && from === s.loop[0] && end - from <= CACHE_LOOP ? [] : null;
      const source: AsyncIterable<Chunk> | Iterable<Chunk> = cached ?? s.stream.buffers(from, s.loop ? end : undefined);
      for await (const c of source) {
        if (s.dead) return;
        keep?.push(c);
        this.schedule(s, c, from, end, origin);
        if (c.t + c.buf.duration >= end) break;
        // Stay a little ahead of the output, no further.
        while (!s.dead && origin + (c.t + c.buf.duration - from) - ctx.currentTime > AHEAD) await new Promise(r => setTimeout(r, 50));
        if (s.dead) return;
      }
      if (keep) this.loopCache = { stream: s.stream, key, chunks: keep };
      if (!s.loop) return;
      origin += end - from;
      from = s.loop[0];
      // Also paces passes that have no audio at all (a loop past the end of the track).
      while (!s.dead && origin - ctx.currentTime > AHEAD) await new Promise(r => setTimeout(r, 50));
      if (s.dead) return;
    }
  }

  /** Schedule the part of `c` inside [from, end) of a pass that starts at context time `origin`. */
  private schedule(s: Session, c: Chunk, from: number, end: number, origin: number) {
    const ctx = this.ctx!;
    const a = Math.max(c.t, from), b = Math.min(c.t + c.buf.duration, end);
    if (b <= a) return;
    let when = origin + (a - from), offset = a - c.t, dur = b - a;
    const late = ctx.currentTime - when;
    if (late > 0) {
      if (late >= dur) return;
      when += late; offset += late; dur -= late;
    }
    const node = ctx.createBufferSource();
    node.buffer = c.buf;
    node.connect(this.gain!);
    node.start(when, offset, dur);
    s.nodes.add(node);
    node.onended = () => { s.nodes.delete(node); node.disconnect(); };
  }
}

/**
 * The audio under a clip: exactly round(dur × rate) frames per channel starting at media time
 * t0, as consecutive planar chunks. Gaps (audio starting late, ending early) are silence.
 */
export async function* clipAudio(stream: AudioStream, t0: number, dur: number): AsyncGenerator<Float32Array[]> {
  const { sampleRate: sr, channels: ch } = stream.info;
  const total = Math.round(dur * sr);
  let done = 0;
  function* silence(n: number) {
    while (n > 0) {
      const k = Math.min(n, 8192);
      yield Array.from({ length: ch }, () => new Float32Array(k));
      n -= k;
    }
  }
  if (total <= 0) return;
  for await (const { t, buf } of stream.buffers(t0, t0 + dur)) {
    const at = Math.round((t - t0) * sr);
    if (at >= total) break;
    if (at > done) { yield* silence(at - done); done = at; }
    const skip = done - at;
    const n = Math.min(buf.length - skip, total - done);
    if (n <= 0) continue;
    yield Array.from({ length: ch }, (_, c) => buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)).slice(skip, skip + n));
    done += n;
    if (done >= total) return;
  }
  yield* silence(total - done);
}

/** 16-bit PCM WAV from planar float chunks. */
export function wav(chunks: Float32Array[][], sampleRate: number, channels: number): Blob {
  const frames = chunks.reduce((s, c) => s + c[0].length, 0);
  const head = new DataView(new ArrayBuffer(44));
  const str = (o: number, v: string) => { for (let i = 0; i < v.length; i++) head.setUint8(o + i, v.charCodeAt(i)); };
  const bytes = frames * channels * 2;
  str(0, 'RIFF'); head.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, channels, true);
  head.setUint32(24, sampleRate, true); head.setUint32(28, sampleRate * channels * 2, true);
  head.setUint16(32, channels * 2, true); head.setUint16(34, 16, true);
  str(36, 'data'); head.setUint32(40, bytes, true);
  const parts: BlobPart[] = [head.buffer];
  for (const c of chunks) {
    const n = c[0].length, out = new Int16Array(n * channels);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < channels; k++) {
        const v = Math.max(-1, Math.min(1, c[k][i]));
        out[i * channels + k] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
    }
    parts.push(out.buffer);
  }
  return new Blob(parts, { type: 'audio/wav' });
}
