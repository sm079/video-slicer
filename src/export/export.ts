import type { App } from '../app';
import type { Demux } from '../media/demux';
import { cropAt, outputSize, type Track, type Win } from '../model/project';
import { renderOutput } from '../model/render';

export type Format = 'mp4' | 'webm' | 'png';
export type Quality = 'high' | 'very-high' | 'max';

export interface ExportOptions {
  windows: Win[];
  format: Format;
  quality: Quality;
  manifest: boolean;
}

export interface Writer {
  write(path: string, data: Blob | Uint8Array): Promise<void>;
  finish(): Promise<void>;
}

export interface Progress {
  (p: { clip: number; clips: number; frame: number; frames: number; name: string }): void;
}

/** Writes into a folder the user picked (Chromium's File System Access API). */
export async function folderWriter(dir: FileSystemDirectoryHandle): Promise<Writer> {
  return {
    async write(path, data) {
      const parts = path.split('/');
      let d = dir;
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
      const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
      const ws = await fh.createWritable();
      await ws.write(data instanceof Blob ? data : new Blob([data as BlobPart]));
      await ws.close();
    },
    async finish() {},
  };
}

/** Collects everything into one uncompressed ZIP and downloads it. */
export async function zipWriter(name: string): Promise<Writer> {
  const { Zip, ZipPassThrough } = await import('fflate');
  const chunks: Uint8Array[] = [];
  let done!: () => void, fail!: (e: unknown) => void;
  const finished = new Promise<void>((res, rej) => { done = res; fail = rej; });
  const zip = new Zip((err, chunk, final) => {
    if (err) { fail(err); return; }
    chunks.push(chunk);
    if (final) done();
  });
  return {
    async write(path, data) {
      const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
      const entry = new ZipPassThrough(path);
      zip.add(entry);
      entry.push(bytes, true);
    },
    async finish() {
      zip.end();
      await finished;
      const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  };
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'clip';

export function clipName(app: App, w: Win, track: Track) {
  const base = safe(app.media!.file.name.replace(/\.[^.]+$/, ''));
  const n = app.data.windows.filter(o => o.track === w.track && o.start < w.start).length + 1;
  return `${base}_${safe(track.name)}_${String(n).padStart(3, '0')}_f${w.start}-${w.start + w.len - 1}`;
}

/**
 * Decoded frames for source frames [from, to] in presentation order. The decoder runs a
 * few frames ahead of the consumer and stops as soon as `to` has come out.
 */
async function* decodeRange(demux: Demux, from: number, to: number, signal: AbortSignal): AsyncGenerator<{ idx: number; frame: VideoFrame }> {
  const queue: VideoFrame[] = [];
  let wake: (() => void) | null = null;
  let error: unknown = null;
  let feeding = true;
  let stop = false;
  const poke = () => { const w = wake; wake = null; w?.(); };
  const decoder = new VideoDecoder({
    output: f => { queue.push(f); poke(); },
    error: e => { error = e; poke(); },
  });
  decoder.configure(demux.config);
  const fromUs = demux.index.us[from], toUs = demux.index.us[to];
  const it = demux.packets(from);
  const feeder = (async () => {
    try {
      for (;;) {
        while (!stop && !error && (decoder.decodeQueueSize > 6 || queue.length > 8)) await new Promise(r => setTimeout(r, 2));
        if (stop || error || signal.aborted) break;
        const { done, value } = await it.next();
        if (done) { await decoder.flush(); break; }
        if (decoder.state !== 'configured') break;
        decoder.decode(value);
      }
    } catch (e) {
      if (!stop) error = e;
    } finally {
      feeding = false;
      poke();
    }
  })();
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (error) throw error;
      const f = queue.shift();
      if (f) {
        const idx = demux.index.byUs.get(f.timestamp);
        if (idx === undefined || f.timestamp < fromUs || f.timestamp > toUs) { f.close(); if (f.timestamp > toUs) return; continue; }
        yield { idx, frame: f };
        if (f.timestamp >= toUs) return;
        continue;
      }
      if (!feeding) return;
      await new Promise<void>(r => { wake = r; if (queue.length || !feeding || error) poke(); });
    }
  } finally {
    stop = true;
    await feeder.catch(() => {});
    for (const f of queue) f.close();
    if (decoder.state !== 'closed') decoder.close();
    it.return(undefined).catch(() => {});
  }
}

async function encoder(format: Format, quality: Quality, w: number, h: number, fps: number, canvas: OffscreenCanvas) {
  const mb = await import('mediabunny');
  const codec = format === 'webm' ? 'vp9' : 'avc';
  if (!(await mb.canEncodeVideo(codec, { width: w, height: h }))) {
    throw new Error(`This browser cannot encode ${codec === 'avc' ? 'H.264' : 'VP9'} at ${w}×${h}${codec === 'avc' && (w % 2 || h % 2) ? ' (H.264 needs even sides; set ÷ to 2 or more)' : ''}.`);
  }
  const bitrate = quality === 'max' ? Math.round(w * h * fps * 0.5) : quality === 'very-high' ? mb.QUALITY_VERY_HIGH : mb.QUALITY_HIGH;
  const target = new mb.BufferTarget();
  const output = new mb.Output({
    format: format === 'webm' ? new mb.WebMOutputFormat() : new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  });
  const source = new mb.CanvasSource(canvas, { codec, bitrate, sizeChangeBehavior: 'deny' });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  return {
    add: (i: number) => source.add(i / fps, 1 / fps),
    async finish() { await output.finalize(); return new Uint8Array(target.buffer!); },
    cancel: () => output.cancel().catch(() => {}),
  };
}

/** Render and write every window. Preview and export share renderOutput and the bitmap copy. */
export async function runExport(app: App, opts: ExportOptions, writer: Writer, progress: Progress, signal: AbortSignal) {
  const m = app.media!;
  const { tb, demux } = m;
  const clips = [...opts.windows].sort((a, b) => a.start - b.start);
  const manifest: unknown[] = [];
  for (let c = 0; c < clips.length; c++) {
    const w = clips[c];
    const track = app.track(w.track)!;
    const out = outputSize(w, track);
    const name = clipName(app, w, track);
    const srcs = Array.from({ length: w.len }, (_, i) => tb.src(w.start + i));
    const canvas = new OffscreenCanvas(out.w, out.h);
    const ctx = canvas.getContext('2d', { alpha: false })!;
    const enc = opts.format === 'png' ? null : await encoder(opts.format, opts.quality, out.w, out.h, tb.fps, canvas);
    const frames = decodeRange(demux, srcs[0], srcs[srcs.length - 1], signal);
    let prev: { idx: number; frame: VideoFrame } | null = null;
    let look: { idx: number; frame: VideoFrame } | null = null;
    let ended = false;
    // Latest decoded frame at or before s (repeats when conforming up, skips when conforming down).
    const frameFor = async (s: number) => {
      for (;;) {
        if (!look && !ended) {
          const n = await frames.next();
          if (n.done) ended = true; else look = n.value;
        }
        if (look && look.idx <= s) { prev?.frame.close(); prev = look; look = null; continue; }
        return (prev ?? look)?.frame ?? null;
      }
    };
    try {
      for (let i = 0; i < w.len; i++) {
        if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
        const frame = await frameFor(srcs[i]);
        if (!frame) throw new Error(`Could not decode source frame ${srcs[i]} for ${name}.`);
        const bmp = await createImageBitmap(frame);
        renderOutput(ctx, bmp, m.orient, cropAt(w, i), out.w, out.h);
        bmp.close();
        if (enc) await enc.add(i);
        else await writer.write(`${name}/${String(i).padStart(5, '0')}.png`, await canvas.convertToBlob({ type: 'image/png' }));
        progress({ clip: c, clips: clips.length, frame: i + 1, frames: w.len, name });
      }
      if (enc) await writer.write(`${name}.${opts.format}`, await enc.finish());
    } catch (e) {
      enc?.cancel();
      throw e;
    } finally {
      (prev as { frame: VideoFrame } | null)?.frame.close();
      (look as { frame: VideoFrame } | null)?.frame.close();
      await frames.return(undefined);
    }
    manifest.push({
      file: opts.format === 'png' ? `${name}/` : `${name}.${opts.format}`,
      track: track.name,
      start: w.start,
      end: w.start + w.len - 1,
      frames: w.len,
      startTime: tb.time(w.start),
      sourceFrames: [srcs[0] - demux.index.first, srcs[srcs.length - 1] - demux.index.first],
      width: out.w,
      height: out.h,
      keys: w.keys,
    });
  }
  if (opts.manifest) {
    const body = {
      source: { file: m.file.name, width: m.W, height: m.H, frames: tb.count, fps: tb.fps, native: tb.native },
      clips: manifest,
    };
    await writer.write('manifest.json', new TextEncoder().encode(JSON.stringify(body, null, 2)));
  }
  await writer.finish();
}
