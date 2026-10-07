// Container access behind one interface. Mediabunny reads MP4/MOV/MKV/WebM/TS
// natively (fast, sample tables give the index without touching frame data);
// anything else falls back to web-demuxer, which is libavformat in WASM.

export type Rotation = 0 | 90 | 180 | 270;

/** Every frame of the video stream, in presentation order. */
export interface FrameIndex {
  count: number;
  /** Presentation timestamp in seconds, ascending. */
  pts: Float64Array;
  /** The same timestamps as integer microseconds (what decoders echo back). */
  us: Float64Array;
  key: Uint8Array;
  /** Ordinal of the keyframe that starts the GOP each frame belongs to. */
  gop: Int32Array;
  /** First frame meant to be shown (frames with negative pts are edit-list lead-in). */
  first: number;
  /** End of the last frame, seconds. */
  end: number;
  byUs: Map<number, number>;
}

export interface VideoInfo {
  fileName: string;
  container: string;
  codec: string;
  /** Size of decoded frames before rotation. */
  rawW: number;
  rawH: number;
  /** Clockwise rotation to apply for display. */
  rotation: Rotation;
  flip: boolean;
  /** Size after rotation. */
  width: number;
  height: number;
  demuxer: 'mediabunny' | 'ffmpeg';
  /** How YUV is converted: from the file's tags, or the assumption used for untagged video. */
  color: string;
}

/** Matrix assumed when a file does not say: BT.601 is what ffmpeg (and PyAV, OpenCV) use. */
export type UntaggedColor = 'bt601' | 'bt709';

export interface Demux {
  info: VideoInfo;
  index: FrameIndex;
  config: VideoDecoderConfig;
  /** Chunks in decode order, starting at the keyframe needed to decode frame `idx`. */
  packets(idx: number): AsyncGenerator<EncodedVideoChunk>;
  /** The keyframe chunk at or before frame `idx` (for thumbnails). */
  keyChunk(idx: number): Promise<EncodedVideoChunk | null>;
  dispose(): void;
}

export const toUs = (sec: number) => Math.round(sec * 1e6);

interface RawPacket { ts: number; key: boolean }

export function buildIndex(packets: RawPacket[], lastDuration: number): FrameIndex {
  packets.sort((a, b) => a.ts - b.ts);
  // Some containers repeat timestamps; keep the first so indices stay unique.
  const uniq: RawPacket[] = [];
  for (const p of packets) {
    const last = uniq[uniq.length - 1];
    if (last && toUs(last.ts) === toUs(p.ts)) { last.key ||= p.key; continue; }
    uniq.push(p);
  }
  const count = uniq.length;
  const pts = new Float64Array(count), us = new Float64Array(count);
  const key = new Uint8Array(count), gop = new Int32Array(count);
  const byUs = new Map<number, number>();
  let ord = -1, first = 0;
  for (let i = 0; i < count; i++) {
    pts[i] = uniq[i].ts;
    us[i] = toUs(uniq[i].ts);
    key[i] = uniq[i].key ? 1 : 0;
    if (key[i]) ord++;
    gop[i] = Math.max(0, ord);
    byUs.set(us[i], i);
  }
  while (first < count - 1 && pts[first] < -1e-9) first++;
  let frameDur = lastDuration;
  if (!(frameDur > 0) && count > 1) frameDur = (pts[count - 1] - pts[first]) / Math.max(1, count - 1 - first);
  const end = count ? pts[count - 1] + (frameDur > 0 ? frameDur : 1 / 30) : 0;
  return { count, pts, us, key, gop, first, end, byUs };
}

function rotated(rawW: number, rawH: number, rotation: Rotation) {
  return rotation % 180 ? { width: rawH, height: rawW } : { width: rawW, height: rawH };
}

/**
 * Drop rotation hints so decoders hand back raw frames (display rotation is applied when
 * drawing), and pin the colour matrix of untagged video so it decodes like it does in ffmpeg.
 */
function plainConfig(config: VideoDecoderConfig, matrix: string | null | undefined, untagged: UntaggedColor) {
  const c = { ...config } as VideoDecoderConfig & { rotation?: number; flip?: boolean };
  delete c.rotation;
  delete c.flip;
  let color = `tagged ${matrix}`;
  if (!matrix) {
    const m = untagged === 'bt601' ? 'smpte170m' : 'bt709';
    c.colorSpace = { matrix: m, primaries: 'bt709', transfer: 'bt709', fullRange: false };
    color = `untagged, decoded as ${untagged === 'bt601' ? 'BT.601' : 'BT.709'}`;
  }
  return { config: c as VideoDecoderConfig, color };
}

async function supported(config: VideoDecoderConfig) {
  try {
    return !!(await VideoDecoder.isConfigSupported(config)).supported;
  } catch {
    return false;
  }
}

export type Progress = (msg: string, fraction?: number) => void;

export async function openVideo(file: File, progress: Progress, untagged: UntaggedColor = 'bt601'): Promise<Demux> {
  let reason = '';
  try {
    const d = await openMediabunny(file, progress, untagged);
    if (d) return d;
  } catch (e) {
    reason = String((e as Error)?.message ?? e);
    console.warn('mediabunny could not open file, trying ffmpeg demuxer', e);
  }
  try {
    return await openFfmpeg(file, progress, untagged);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    throw new Error(reason && !/unsupported container/i.test(msg) ? `${reason}; ${msg}` : msg);
  }
}

async function openMediabunny(file: File, progress: Progress, untagged: UntaggedColor): Promise<Demux | null> {
  const mb = await import('mediabunny');
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  if (!(await input.canRead())) { input.dispose(); return null; }
  const track = await input.getPrimaryVideoTrack();
  if (!track) { input.dispose(); throw new Error('The file has no video track.'); }
  const config = await track.getDecoderConfig();
  const codec = (await track.getCodec()) ?? 'unknown';
  if (!config) { input.dispose(); return null; }
  const cs = await track.getColorSpace().catch(() => ({} as VideoColorSpaceInit));
  const { config: plain, color } = plainConfig(config, cs.matrix, untagged);
  if (!(await supported(plain))) {
    input.dispose();
    throw new Error(`This browser cannot decode ${codec} (${config.codec}) video.`);
  }
  progress('Indexing frames…');
  const sink = new mb.EncodedPacketSink(track);
  const raw: RawPacket[] = [];
  let lastDuration = 0;
  for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) {
    raw.push({ ts: p.timestamp, key: p.type === 'key' });
    lastDuration = p.duration;
    if ((raw.length & 4095) === 0) progress(`Indexing frames… ${raw.length}`);
  }
  if (!raw.length) { input.dispose(); throw new Error('The video track has no frames.'); }
  const index = buildIndex(raw, lastDuration);
  const rotation = (((track.rotation % 360) + 360) % 360) as Rotation;
  const flip = await track.getFlip().catch(() => false);
  const rawW = track.codedWidth, rawH = track.codedHeight;
  const format = await input.getFormat();
  const info: VideoInfo = {
    fileName: file.name, container: format.name, codec,
    rawW, rawH, rotation, flip, ...rotated(rawW, rawH, rotation), demuxer: 'mediabunny', color,
  };
  const chunk = (p: { type: string; timestamp: number; duration: number; data: Uint8Array }) =>
    new EncodedVideoChunk({
      type: p.type as EncodedVideoChunkType, timestamp: toUs(p.timestamp),
      duration: Math.max(0, toUs(p.duration)), data: p.data,
    });

  return {
    info, index, config: plain,
    async *packets(idx) {
      const start = await sink.getKeyPacket(index.pts[idx], { verifyKeyPackets: true })
        ?? await sink.getFirstKeyPacket({ verifyKeyPackets: true });
      if (!start) return;
      for await (const p of sink.packets(start)) yield chunk(p);
    },
    async keyChunk(idx) {
      const p = await sink.getKeyPacket(index.pts[idx], { verifyKeyPackets: true })
        ?? await sink.getFirstKeyPacket({ verifyKeyPackets: true });
      return p ? chunk(p) : null;
    },
    dispose: () => input.dispose(),
  };
}

async function openFfmpeg(file: File, progress: Progress, untagged: UntaggedColor): Promise<Demux> {
  progress('Loading ffmpeg demuxer…');
  const [{ WebDemuxer, AVMediaType, AVSeekFlag }, { default: wasmUrl }] = await Promise.all([
    import('web-demuxer'),
    import('../../node_modules/web-demuxer/dist/wasm-files/web-demuxer.wasm?url'),
  ]);
  const demuxer = new WebDemuxer({ wasmFilePath: new URL(wasmUrl, location.href).href });
  try {
    await demuxer.load(file);
  } catch (e) {
    demuxer.destroy();
    throw new Error(`Unsupported container: ${String((e as Error)?.message ?? e)}`);
  }
  let stream;
  try {
    stream = await demuxer.getMediaStream('video');
  } catch {
    demuxer.destroy();
    throw new Error('The file has no video track.');
  }
  const tag = stream.color_space && !/unknown|unspecified|reserved/.test(stream.color_space) ? stream.color_space : null;
  const { config, color } = plainConfig(demuxer.genDecoderConfig('video', stream) as VideoDecoderConfig, tag, untagged);
  if (!(await supported(config))) {
    demuxer.destroy();
    throw new Error(`This browser cannot decode ${stream.codec_name} (${stream.codec_string || 'unknown'}) video.`);
  }
  // No sample table to read here, so walk every packet once.
  progress('Indexing frames…', 0);
  const raw: RawPacket[] = [];
  let lastDuration = 0;
  const reader = demuxer.readAVPacket(0, 0, AVMediaType.AVMEDIA_TYPE_VIDEO, -1, AVSeekFlag.AVSEEK_FLAG_BACKWARD).getReader();
  const total = stream.duration || 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw.push({ ts: value.timestamp, key: value.keyframe === 1 });
    lastDuration = value.duration;
    if ((raw.length & 511) === 0) progress(`Indexing frames… ${raw.length}`, total ? value.timestamp / total : undefined);
  }
  if (!raw.length) { demuxer.destroy(); throw new Error('The video track has no frames.'); }
  const index = buildIndex(raw, lastDuration);
  // ffmpeg reports display-matrix rotation counter-clockwise.
  const rotation = ((((-Math.round((stream.rotation || 0) / 90) * 90) % 360) + 360) % 360) as Rotation;
  const rawW = stream.width, rawH = stream.height;
  const info: VideoInfo = {
    fileName: file.name, container: file.name.split('.').pop()?.toLowerCase() || 'unknown',
    codec: stream.codec_name, rawW, rawH, rotation, flip: !!stream.flip,
    ...rotated(rawW, rawH, rotation), demuxer: 'ffmpeg', color,
  };
  const chunk = (p: { keyframe: number; timestamp: number; duration: number; data: Uint8Array }) =>
    new EncodedVideoChunk({
      type: p.keyframe === 1 ? 'key' : 'delta', timestamp: toUs(p.timestamp),
      duration: Math.max(0, toUs(p.duration)), data: p.data,
    });
  const keyTime = (idx: number) => {
    let i = idx;
    while (i > 0 && !index.key[i]) i--;
    return Math.max(0, index.pts[i]);
  };

  // A web-demuxer worker breaks if two requests interleave, so every reader gets its own
  // instance from a pool, and keyframe lookups run one at a time on the first instance.
  type Instance = InstanceType<typeof WebDemuxer>;
  const idle: Instance[] = [];
  const all = new Set<Instance>([demuxer]);
  let disposed = false;
  const acquire = async (): Promise<Instance> => {
    const d = idle.pop();
    if (d) return d;
    const fresh = new WebDemuxer({ wasmFilePath: new URL(wasmUrl, location.href).href });
    all.add(fresh);
    await fresh.load(file);
    return fresh;
  };
  const release = (d: Instance, healthy: boolean) => {
    if (healthy && !disposed && idle.length < 3) idle.push(d);
    else { all.delete(d); d.destroy(); }
  };
  let keyQueue: Promise<unknown> = Promise.resolve();

  return {
    info, index, config,
    async *packets(idx) {
      const d = await acquire();
      const r = d.readAVPacket(keyTime(idx), 0, AVMediaType.AVMEDIA_TYPE_VIDEO, -1, AVSeekFlag.AVSEEK_FLAG_BACKWARD).getReader();
      let started = false, finished = false, healthy = true;
      try {
        for (;;) {
          const { done, value } = await r.read();
          if (done) { finished = true; return; }
          // A decoder must start on a keyframe.
          if (!started && value.keyframe !== 1) continue;
          started = true;
          yield chunk(value);
        }
      } catch (e) {
        healthy = false;
        throw e;
      } finally {
        if (!finished && healthy) {
          // Wait for the worker to stop the read before it serves anyone else.
          const stopped = await Promise.race([r.cancel().then(() => true, () => false), new Promise<boolean>(res => setTimeout(() => res(false), 1500))]);
          healthy = stopped;
        }
        release(d, healthy);
      }
    },
    keyChunk(idx) {
      const job = keyQueue.then(async () => {
        const p = await demuxer.getAVPacket(keyTime(idx), AVMediaType.AVMEDIA_TYPE_VIDEO, -1, AVSeekFlag.AVSEEK_FLAG_BACKWARD);
        return p ? chunk(p) : null;
      });
      keyQueue = job.catch(() => {});
      return job;
    },
    dispose: () => {
      disposed = true;
      for (const d of all) d.destroy();
      all.clear();
    },
  };
}
