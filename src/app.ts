import { AudioPlayer } from './media/audio';
import { openVideo, type Demux, type UntaggedColor } from './media/demux';
import { FrameServer } from './media/frames';
import { hashFile } from './media/hash';
import { ThumbServer } from './media/thumbs';
import { Timebase, detectFps } from './media/timebase';
import {
  Store, emptyProject, sanitizeProject, newTrack, uid, cropAt, snapLen, fits, freeSpan, fullCrop, refitCrop,
  normalizeCrop, trackAspect, presetValues, sanitizePresets, type Crop, type Preset, type ProjectData, type Track, type Win,
} from './model/project';
import type { Orientation } from './model/render';

export interface Media {
  file: File;
  /** Content fingerprint; the key the editor state is saved under. */
  hash: string;
  demux: Demux;
  tb: Timebase;
  frames: FrameServer;
  thumbs: ThumbServer;
  sourceFps: number;
  /** Display-oriented frame size. */
  W: number;
  H: number;
  orient: Orientation;
}

interface Play {
  loop: string | null;
  nextDue: number;
  /** The loop range the audio was started with, to notice when the window is edited. */
  audioLoop: string;
  audioSynced: number;
}

/** Audio further than this from the picture is restarted at the picture's time. */
const AUDIO_DRIFT = 0.1;

const CACHE_KEY = 'vs.cacheMB';
const COLOR_KEY = 'vs.untaggedColor';
const PRESETS_KEY = 'vs.presets';
const STATE_PREFIX = 'vs.state:';

/** Everything restored when the same video is opened again. */
interface EditorState {
  version: 1;
  saved: number;
  project: ProjectData;
  playhead: number;
  selWin: string | null;
  selTrack: string | null;
  view: unknown;
}

/** A view (the timeline) whose zoom and scroll are saved with the editor state. */
export interface ViewState {
  get(): unknown;
  set(v: unknown): void;
  reset(): void;
}

export class App {
  store = new Store(emptyProject());
  media: Media | null = null;
  playhead = 0;
  selWin: string | null = null;
  selTrack: string;
  play: Play | null = null;
  readonly audio = new AudioPlayer();
  status = '';
  /** Called once per animation frame when anything visible changed. */
  private drawers: (() => void)[] = [];
  /** Called when selection, project or media changed (inspector, buttons). */
  private uiListeners: (() => void)[] = [];
  private frameRequested = false;
  private uiDirty = false;
  private saveTimer = 0;
  toast: (msg: string, kind?: 'error' | 'info' | 'success', action?: { label: string; run: () => void }) => void = () => {};
  onLoading: (msg: string | null) => void = () => {};
  view: ViewState | null = null;
  private presetCache: Preset[] | null = null;

  constructor() {
    this.selTrack = this.store.data.tracks[0].id;
    this.store.subscribe(() => {
      this.syncTimebase();
      this.fixSelection();
      this.uiDirty = true;
      this.invalidate();
      this.saveSoon();
    });
    window.addEventListener('pagehide', () => this.saveNow());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.saveNow(); });
  }

  get data(): ProjectData {
    return this.store.data;
  }

  get cacheMB() {
    try { return Math.max(256, Number(localStorage.getItem(CACHE_KEY)) || 1024); } catch { return 1024; }
  }

  set cacheMB(mb: number) {
    try { localStorage.setItem(CACHE_KEY, String(mb)); } catch { /* storage unavailable */ }
    if (this.media) this.media.frames.budget = mb * 1024 * 1024;
  }

  get untaggedColor(): UntaggedColor {
    try { return localStorage.getItem(COLOR_KEY) === 'bt709' ? 'bt709' : 'bt601'; } catch { return 'bt601'; }
  }

  /** Changing the assumption re-opens the video so every decoder picks it up. */
  async setUntaggedColor(c: UntaggedColor) {
    try { localStorage.setItem(COLOR_KEY, c); } catch { /* storage unavailable */ }
    if (this.media) await this.open(this.media.file, true);
  }

  /** Saved presets, shared by every video in this browser. */
  get presets(): Preset[] {
    if (!this.presetCache) {
      try { this.presetCache = sanitizePresets(JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '[]')); } catch { this.presetCache = []; }
    }
    return this.presetCache;
  }

  private writePresets(list: Preset[]) {
    this.presetCache = list;
    try { localStorage.setItem(PRESETS_KEY, JSON.stringify(list)); } catch { this.toast('Couldn’t save presets: browser storage is unavailable.', 'error'); }
    this.invalidate(true);
  }

  /** Save a preset, replacing one of the same name. */
  savePreset(p: Preset) {
    this.writePresets([...this.presets.filter(o => o.name !== p.name), p].sort((a, b) => a.name.localeCompare(b.name)));
  }

  deletePreset(name: string) {
    this.writePresets(this.presets.filter(o => o.name !== name));
  }

  /** Set the frame rate and the current track's settings from a preset, as one undo step. */
  applyPreset(p: Preset) {
    const v = presetValues(p);
    const m = this.media;
    const fps = v.fps != null && m && Math.abs(v.fps - m.sourceFps) < 1e-9 ? null : v.fps;
    const cur = this.data.fps;
    if (fps == null ? cur != null : cur == null || Math.abs(cur - fps) > 1e-9) this.setFps(fps, false);
    this.updateTrack(this.currentTrack, { outW: v.outW, outH: v.outH, rule: v.rule, defLen: v.defLen, div: v.div });
  }

  onDraw(fn: () => void) { this.drawers.push(fn); }
  onUi(fn: () => void) { this.uiListeners.push(fn); }

  invalidate(ui = false) {
    if (ui) this.uiDirty = true;
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(t => this.frame(t));
  }

  private frame(now: number) {
    this.frameRequested = false;
    if (this.play) this.tick(now);
    if (this.uiDirty) { this.uiDirty = false; this.uiListeners.forEach(f => f()); }
    this.drawers.forEach(f => f());
    if (this.play) this.invalidate();
  }

  // ---------------------------------------------------------------- media

  /** Open a video and restore its saved editor state, if any (quietly when re-opening the same file). */
  async open(file: File, quiet = false) {
    this.stop();
    this.saveNow();
    this.onLoading(`Opening ${file.name}…`);
    let demux: Demux, hash: string;
    try {
      [demux, hash] = await Promise.all([
        openVideo(file, msg => this.onLoading(msg), this.untaggedColor),
        hashFile(file).catch(() => legacyKey(file)),
      ]);
    } catch (e) {
      this.onLoading(null);
      this.toast(String((e as Error)?.message ?? e), 'error');
      return;
    }
    this.media?.frames.dispose();
    this.media?.thumbs.dispose();
    this.media?.demux.dispose();
    const { info } = demux;
    const sourceFps = detectFps(demux.index);
    const frames = new FrameServer(demux, this.cacheMB * 1024 * 1024);
    const thumbs = new ThumbServer(demux);
    frames.onFrame = () => this.invalidate();
    frames.onError = msg => this.toast(msg, 'error');
    thumbs.onThumb = () => this.invalidate();
    const saved = loadState(hash, file);
    const data = saved?.project ?? emptyProject();
    this.media = {
      file, hash, demux, frames, thumbs, sourceFps,
      tb: new Timebase(demux.index, data.fps, sourceFps),
      W: info.width, H: info.height,
      orient: { rawW: info.rawW, rawH: info.rawH, rotation: info.rotation, flip: info.flip },
    };
    this.store.replace(data, false);
    this.selTrack = this.track(saved?.selTrack)?.id ?? data.tracks[0].id;
    this.selWin = this.win(saved?.selWin)?.id ?? null;
    this.playhead = Math.max(0, Math.min(this.total - 1, saved?.playhead ?? 0));
    this.view?.reset();
    if (saved?.view) this.view?.set(saved.view);
    this.onLoading(null);
    if (saved && !quiet) this.toast('Picked up where you left off', 'info', { label: 'Start over', run: () => {
      this.resetEditor();
      this.toast('Started over', 'info', { label: 'Undo', run: () => this.store.undo() });
    } });
    this.updateWants();
    this.invalidate(true);
  }

  /** Keep the timebase in step with the project's fps (after undo, redo or reset). */
  private syncTimebase() {
    const m = this.media;
    if (!m) return;
    const fps = this.data.fps;
    if (fps == null ? m.tb.native : !m.tb.native && Math.abs(m.tb.fps - fps) < 1e-9) return;
    const old = m.tb;
    m.tb = new Timebase(m.demux.index, fps, m.sourceFps);
    this.playhead = Math.min(m.tb.count - 1, m.tb.frameAt(old.time(this.playhead) + 1e-6));
    this.updateWants();
  }

  /** Start this video over: an empty project at frame 0. Undo brings the old project back. */
  resetEditor() {
    if (!this.media) return;
    this.stop();
    this.selWin = null;
    this.store.replace(emptyProject());
    this.selTrack = this.data.tracks[0].id;
    this.playhead = 0;
    this.view?.reset();
    this.updateWants();
    this.invalidate(true);
  }

  get total() {
    return this.media?.tb.count ?? 0;
  }

  setFps(fps: number | null, commit = true) {
    const m = this.media;
    if (!m) return;
    if (fps != null && Math.abs(fps - m.sourceFps) < 1e-9) fps = null;
    const old = m.tb;
    const tb = new Timebase(m.demux.index, fps, m.sourceFps);
    const ratio = tb.fps / old.fps;
    const d = this.data;
    const moved: Win[] = [];
    for (const w of d.windows) {
      const track = this.track(w.track)!;
      const start = tb.frameAt(old.time(w.start) + 1e-6);
      const end = tb.frameAt(old.time(w.start + w.len - 1) + 1e-6) + 1;
      w.start = Math.min(start, tb.count - 1);
      w.len = snapLen(track.rule, end - start, tb.count - w.start) ?? 1;
      w.keys = dedupeKeys(w.keys.map(k => ({ f: Math.min(w.len - 1, Math.round(k.f * ratio)), c: k.c })));
      moved.push(w);
    }
    d.fps = fps;
    m.tb = tb;
    this.playhead = tb.frameAt(old.time(this.playhead) + 1e-6);
    this.resolveOverlaps(moved);
    if (commit) this.store.commit();
    this.updateWants();
  }

  // ------------------------------------------------------------ selection

  win(id: string | null | undefined) {
    return id ? this.data.windows.find(w => w.id === id) : undefined;
  }

  track(id: string | null | undefined) {
    return id ? this.data.tracks.find(t => t.id === id) : undefined;
  }

  get selected(): Win | undefined {
    return this.win(this.selWin);
  }

  get currentTrack(): Track {
    return this.track(this.selected?.track ?? this.selTrack) ?? this.data.tracks[0];
  }

  select(id: string | null) {
    this.selWin = id;
    const w = this.win(id);
    if (w) this.selTrack = w.track;
    this.saveSoon();
    this.invalidate(true);
  }

  selectTrack(id: string) {
    this.selTrack = id;
    if (this.selected && this.selected.track !== id) this.selWin = null;
    this.invalidate(true);
  }

  private fixSelection() {
    if (this.selWin && !this.win(this.selWin)) this.selWin = null;
    if (!this.track(this.selTrack)) this.selTrack = this.data.tracks[0]?.id;
  }

  // ------------------------------------------------------------- playhead

  seek(f: number) {
    const total = this.total;
    if (!total) return;
    f = Math.max(0, Math.min(total - 1, Math.round(f)));
    if (this.play?.loop) {
      const w = this.win(this.play.loop);
      if (w && (f < w.start || f >= w.start + w.len)) this.stop();
    }
    if (f === this.playhead) return;
    this.playhead = f;
    if (this.play) { this.play.nextDue = performance.now() + 1000 / this.media!.tb.fps; this.startAudio(); }
    else this.saveSoon();
    this.updateWants();
    this.invalidate(true);
  }

  step(n: number) {
    if (this.play) this.stop();
    this.seek(this.playhead + n);
  }

  /** Source frames to decode now, most urgent first. */
  updateWants() {
    const m = this.media;
    if (!m) return;
    const { tb, frames } = m;
    const list: number[] = [tb.src(this.playhead)];
    // Prefetch, the frames the decoder emits past it (FrameServer keeps up to 12) and pinned
    // loop starts must fit the cache together, or eviction forces re-decodes.
    const cap = frames.capacity;
    if (this.play) {
      const w = this.win(this.play.loop);
      const lo = w ? w.start : 0, hi = w ? w.start + w.len : tb.count;
      const room = Math.max(4, cap - 14);
      const whole = !!w && w.len <= room;
      const ahead = whole ? w!.len : Math.min(Math.max(4, Math.floor(room / 2)), Math.ceil(tb.fps * 1.5) + 8);
      for (let i = 1; i < ahead; i++) {
        let f = this.playhead + i;
        if (f >= hi) { if (!w) break; f = lo + (f - lo) % (hi - lo); }
        list.push(tb.src(f));
      }
      if (w) {
        // Short loops stay cached whole; long ones keep their first frames so the wrap is seamless.
        const pin: number[] = [];
        const n = whole ? w.len : Math.max(0, room - ahead);
        for (let f = w.start; f < w.start + n; f++) pin.push(tb.src(f));
        frames.pin(pin);
      }
    } else {
      for (let i = 1; i <= 4; i++) if (this.playhead + i < tb.count) list.push(tb.src(this.playhead + i));
      for (let i = 1; i <= 6; i++) if (this.playhead - i >= 0) list.push(tb.src(this.playhead - i));
    }
    frames.want(list);
  }

  // ------------------------------------------------------------- playback

  togglePlay() {
    if (this.play) { this.stop(); return; }
    if (!this.media) return;
    if (this.playhead >= this.total - 1) this.seek(0);
    this.play = { loop: null, nextDue: performance.now(), audioLoop: '', audioSynced: 0 };
    this.startAudio();
    this.media.thumbs.setPaused(true);
    this.updateWants();
    this.invalidate(true);
  }

  playLoop(id: string) {
    const w = this.win(id);
    if (!w || !this.media) return;
    if (this.play?.loop === id) { this.stop(); return; }
    this.select(id);
    this.playhead = w.start;
    this.play = { loop: id, nextDue: performance.now(), audioLoop: '', audioSynced: 0 };
    this.startAudio();
    this.media.thumbs.setPaused(true);
    this.updateWants();
    this.invalidate(true);
  }

  stop() {
    if (!this.play) return;
    this.play = null;
    this.audio.stop();
    this.media?.frames.pin([]);
    this.media?.thumbs.setPaused(false);
    this.saveSoon();
    this.updateWants();
    this.invalidate(true);
  }

  /** Advance by whole frames, never skipping one: if the next frame is not decoded yet, wait for it. */
  private tick(now: number) {
    const m = this.media!, play = this.play!;
    const dt = 1000 / m.tb.fps;
    const w = this.win(play.loop);
    if (play.loop && !w) { this.stop(); return; }
    if (now - play.nextDue > 250) play.nextDue = now;
    let advanced = false;
    while (now >= play.nextDue) {
      let next = this.playhead + 1;
      if (w && next >= w.start + w.len) next = w.start;
      if (!w && next >= m.tb.count) { this.stop(); break; }
      if (!m.frames.has(m.tb.src(next))) break;
      this.playhead = next;
      play.nextDue += dt;
      advanced = true;
    }
    if (advanced) { this.updateWants(); this.uiDirty = true; }
    if (this.play) this.syncAudio(now);
  }

  /** Media time (the clock audio timestamps use) at the start of output frame f. */
  mediaTime(f: number) {
    const m = this.media!;
    return m.demux.index.pts[m.demux.index.first] + m.tb.time(f);
  }

  /** Media range a loop plays; its length is the loop's duration on the frame clock. */
  private loopRange(w: Win): [number, number] {
    const a = this.mediaTime(w.start);
    return [a, a + w.len / this.media!.tb.fps];
  }

  /** (Re)start the audio at the playhead's media time. */
  private startAudio(at = this.playhead, frac = 0) {
    const m = this.media, play = this.play;
    if (!m || !play) return;
    if (!m.demux.audio) return;
    const w = this.win(play.loop);
    const loop = w ? this.loopRange(w) : null;
    play.audioLoop = loop ? loop.join() : '';
    play.audioSynced = performance.now();
    this.audio.start(m.demux.audio, this.mediaTime(at) + frac, loop);
  }

  /** Keep the audio within AUDIO_DRIFT of the picture; restart it after seeks, stalls and loop edits. */
  private syncAudio(now: number) {
    const m = this.media!, play = this.play!;
    const pos = this.audio.position();
    if (pos == null || !m.demux.audio) return;
    const dt = 1000 / m.tb.fps;
    // How far into the current frame's display time we are.
    const frac = Math.max(0, Math.min(dt, now - (play.nextDue - dt))) / 1000;
    const w = this.win(play.loop);
    const loop = w ? this.loopRange(w) : null;
    if ((loop ? loop.join() : '') !== play.audioLoop) { this.startAudio(this.playhead, frac); return; }
    let drift = pos - (this.mediaTime(this.playhead) + frac);
    if (loop) {
      const len = loop[1] - loop[0];
      drift = ((drift % len) + len) % len;
      drift = Math.min(drift, len - drift);
    }
    if (Math.abs(drift) > AUDIO_DRIFT && now - play.audioSynced > 300) this.startAudio(this.playhead, frac);
  }

  // -------------------------------------------------------------- windows

  /** The default crop for new windows, in the track's shape. */
  defaultCropFor(track: Track): Crop {
    const m = this.media!;
    const aspect = trackAspect(track);
    const base = this.data.defaultCrop;
    return base ? refitCrop(base, m.W, m.H, aspect) : fullCrop(m.W, m.H, aspect);
  }

  /**
   * Crop a new window starting at `start` gets: where the window before it (on this track,
   * else on any track) ends, so consecutive windows line up exactly; else the default crop.
   */
  private templateCrop(track: Track, start: number): Crop {
    const m = this.media!;
    const before = (id?: string) => this.data.windows
      .filter(w => (!id || w.track === id) && w.start < start)
      .sort((a, b) => b.start + b.len - (a.start + a.len) || b.start - a.start)[0];
    const prev = before(track.id) ?? before();
    if (!prev) return this.defaultCropFor(track);
    return refitCrop(cropAt(prev, prev.len - 1), m.W, m.H, trackAspect(track));
  }

  /** Add a window without committing (the caller commits, e.g. at the end of a drag). */
  addWindow(track: Track, start: number, len: number): Win {
    const w = this.makeWindow(track, start, len);
    this.select(w.id);
    return w;
  }

  private makeWindow(track: Track, start: number, len: number): Win {
    const w: Win = { id: uid('w'), track: track.id, start, len, animate: false, keys: [{ f: 0, c: this.templateCrop(track, start) }] };
    this.data.windows.push(w);
    return w;
  }

  /** New window at `start`, on the given track when it fits there, otherwise on the next free track. */
  createWindowAt(start: number, trackId = this.currentTrack.id, len?: number): Win | null {
    if (!this.media) return null;
    const total = this.total;
    const order = [this.track(trackId)!, ...this.data.tracks.filter(t => t.id !== trackId)];
    for (const track of order) {
      const l = snapLen(track.rule, len ?? track.defLen, total);
      if (l == null) continue;
      const s = Math.max(0, Math.min(start, total - l));
      if (fits(this.data, track.id, s, l, total)) return this.finishCreate(this.makeWindow(track, s, l));
    }
    const base = order[0];
    const track = newTrack(this.data.tracks.length, base);
    this.data.tracks.push(track);
    const l = snapLen(track.rule, len ?? track.defLen, total);
    if (l == null) { this.toast('The video is shorter than the shortest allowed window.', 'error'); return null; }
    return this.finishCreate(this.makeWindow(track, Math.max(0, Math.min(start, total - l)), l));
  }

  private finishCreate(w: Win) {
    this.store.commit();
    this.select(w.id);
    return w;
  }

  deleteWindow(id: string) {
    const d = this.data;
    const i = d.windows.findIndex(w => w.id === id);
    if (i < 0) return;
    d.windows.splice(i, 1);
    if (this.play?.loop === id) this.stop();
    this.store.commit();
  }

  duplicateWindow(id: string) {
    const w = this.win(id);
    if (!w) return;
    const total = this.total;
    const copy = (track: string, start: number): Win => {
      const c: Win = JSON.parse(JSON.stringify(w));
      c.id = uid('w');
      c.track = track;
      c.start = start;
      this.data.windows.push(c);
      return c;
    };
    let made: Win | null = null;
    if (fits(this.data, w.track, w.start + w.len, w.len, total)) made = copy(w.track, w.start + w.len);
    else {
      for (const t of this.data.tracks) {
        if (t.id !== w.track && fits(this.data, t.id, w.start, w.len, total)) { made = copy(t.id, w.start); break; }
      }
    }
    if (!made) {
      const src = this.track(w.track)!;
      const t = newTrack(this.data.tracks.length, src);
      this.data.tracks.push(t);
      made = copy(t.id, w.start);
    }
    this.store.commit();
    this.select(made.id);
  }

  /** Move windows that collide with others onto free tracks (after re-timing). */
  private resolveOverlaps(candidates: Win[]) {
    const d = this.data, total = this.total;
    for (const w of [...candidates].sort((a, b) => a.start - b.start)) {
      if (fits(d, w.track, w.start, w.len, total, w.id)) continue;
      const free = d.tracks.find(t => fits(d, t.id, w.start, w.len, total, w.id));
      if (free) { this.moveToTrack(w, free); continue; }
      const t = newTrack(d.tracks.length, this.track(w.track));
      d.tracks.push(t);
      this.moveToTrack(w, t);
    }
  }

  /** Re-assign a window to a track, refitting crops when the track's shape differs. */
  moveToTrack(w: Win, track: Track) {
    const from = this.track(w.track);
    w.track = track.id;
    if (from && trackAspect(from) !== trackAspect(track)) this.refitWindow(w, track);
  }

  refitWindow(w: Win, track: Track) {
    const m = this.media;
    if (!m) return;
    const aspect = trackAspect(track);
    for (const k of w.keys) k.c = refitCrop(k.c, m.W, m.H, aspect);
  }

  /** Back to the default crop, with keyframes off. */
  resetWindow(w: Win) {
    if (!this.media) return;
    w.animate = false;
    w.keys = [{ f: 0, c: this.defaultCropFor(this.track(w.track)!) }];
    this.store.commit();
  }

  /** Change a window's range, keeping keys that still fall inside. */
  setRange(w: Win, start: number, len: number) {
    w.start = start;
    w.len = len;
    const inside = w.keys.filter(k => k.f < len);
    w.keys = inside.length ? inside : [{ f: Math.max(0, len - 1), c: w.keys[w.keys.length - 1].c }];
    if (!w.animate) w.keys = [{ f: 0, c: w.keys[0].c }];
  }

  /** The frame offset inside the window that crop edits apply to. */
  localFrame(w: Win) {
    return Math.max(0, Math.min(w.len - 1, this.playhead - w.start));
  }

  /** The crop on screen: the selected window's at the playhead, or the default crop for new windows. */
  activeCrop(): Crop | null {
    const m = this.media;
    if (!m) return null;
    const w = this.selected;
    if (w) return cropAt(w, this.localFrame(w));
    return this.defaultCropFor(this.currentTrack);
  }

  /** Aspect ratio crop edits must keep, if any. */
  cropAspect(): number | null {
    const w = this.selected;
    const track = this.currentTrack;
    const fixed = trackAspect(track);
    if (fixed) return fixed;
    // Keys of differing shape would stretch against the fixed output size.
    if (w && w.animate && w.keys.length > 1) return w.keys[0].c.w / w.keys[0].c.h;
    return null;
  }

  /** Apply a crop edit. With commit false it is a live drag step. */
  setCrop(c: Crop, commit = true) {
    const m = this.media;
    if (!m) return;
    const crop = normalizeCrop(c, m.W, m.H, this.cropAspect());
    const w = this.selected;
    if (w) {
      if (!w.animate) w.keys = [{ f: 0, c: crop }];
      else {
        const f = this.localFrame(w);
        const k = w.keys.find(k => k.f === f);
        if (k) k.c = crop;
        else { w.keys.push({ f, c: crop }); w.keys.sort((a, b) => a.f - b.f); }
      }
    } else this.data.defaultCrop = { ...crop };
    if (commit) this.store.commit();
    else this.store.changed();
  }

  setAnimate(w: Win, on: boolean) {
    if (w.animate === on) return;
    if (!on) w.keys = [{ f: 0, c: cropAt(w, this.localFrame(w)) }];
    w.animate = on;
    this.store.commit();
  }

  /** K: key the current crop at the playhead, or remove the key that is already there. */
  toggleKey() {
    const w = this.selected;
    if (!w) return;
    const f = this.localFrame(w);
    if (!w.animate) {
      w.animate = true;
      w.keys = [{ f, c: cropAt(w, f) }];
    } else {
      const i = w.keys.findIndex(k => k.f === f);
      if (i >= 0) { if (w.keys.length > 1) w.keys.splice(i, 1); }
      else { w.keys.push({ f, c: cropAt(w, f) }); w.keys.sort((a, b) => a.f - b.f); }
    }
    this.store.commit();
  }

  removeKey(w: Win, f: number) {
    if (w.keys.length <= 1) return;
    w.keys = w.keys.filter(k => k.f !== f);
    this.store.commit();
  }

  jumpKey(dir: 1 | -1) {
    const w = this.selected;
    if (!w) return;
    const fs = w.keys.map(k => k.f + w.start);
    const next = dir > 0 ? fs.find(f => f > this.playhead) : [...fs].reverse().find(f => f < this.playhead);
    if (next !== undefined) this.seek(next);
  }

  /** I / O: set the selected window's start or end at the playhead, keeping the other end. */
  setEdge(edge: 'start' | 'end') {
    const w = this.selected;
    if (!w) return;
    const track = this.track(w.track)!;
    const total = this.total;
    const [lo, hi] = freeSpan(this.data, w.track, w.start, total, w.id);
    if (edge === 'start') {
      const end = w.start + w.len;
      const s = Math.max(lo, Math.min(this.playhead, end - 1));
      const len = snapLen(track.rule, end - s, end - lo);
      if (len == null) return;
      this.setRange(w, end - len, len);
    } else {
      const e = Math.min(hi, Math.max(this.playhead + 1, w.start + 1));
      const len = snapLen(track.rule, e - w.start, hi - w.start);
      if (len == null) return;
      this.setRange(w, w.start, len);
    }
    this.store.commit();
  }

  // --------------------------------------------------------------- tracks

  addTrack() {
    const t = newTrack(this.data.tracks.length, this.currentTrack);
    this.data.tracks.push(t);
    this.selTrack = t.id;
    this.selWin = null;
    this.store.commit();
  }

  deleteTrack(id: string) {
    const d = this.data;
    if (d.tracks.length <= 1) { this.toast('A project needs at least one track.'); return; }
    d.tracks = d.tracks.filter(t => t.id !== id);
    d.windows = d.windows.filter(w => w.track !== id);
    this.store.commit();
  }

  /** Apply track settings, keeping its windows valid under the new rule and shape. */
  updateTrack(track: Track, patch: Partial<Track>) {
    const shapeBefore = trackAspect(track);
    Object.assign(track, patch);
    const total = this.total;
    const wins = this.data.windows.filter(w => w.track === track.id).sort((a, b) => a.start - b.start);
    for (const w of wins) {
      const [, hi] = freeSpan(this.data, track.id, w.start, total, w.id);
      const len = snapLen(track.rule, w.len, hi - w.start) ?? snapLen(track.rule, w.len, total - w.start, 'down');
      if (len != null) this.setRange(w, w.start, len);
    }
    if (shapeBefore !== trackAspect(track)) for (const w of wins) this.refitWindow(w, track);
    this.resolveOverlaps(wins);
    this.store.commit();
  }

  // ---------------------------------------------------------- persistence

  /** Save the editor state shortly, coalescing bursts of edits. */
  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    const m = this.media;
    if (!m) return;
    const state: EditorState = {
      version: 1, saved: Date.now(), project: this.data,
      playhead: this.playhead, selWin: this.selWin, selTrack: this.selTrack, view: this.view?.get() ?? null,
    };
    storeState(STATE_PREFIX + m.hash, JSON.stringify(state));
  }

  exportProject(): Blob {
    const m = this.media;
    const body = {
      ...this.data,
      source: m ? { name: m.file.name, size: m.file.size, hash: m.hash, width: m.W, height: m.H, frames: m.tb.count, fps: m.tb.fps } : undefined,
    };
    return new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
  }

  /** Load a saved project; returns false when it was saved for different video content. */
  importProject(text: string): boolean {
    const raw = JSON.parse(text);
    const data = sanitizeProject(raw);
    const m = this.media;
    if (m) m.tb = new Timebase(m.demux.index, data.fps, m.sourceFps);
    const total = this.total;
    data.windows = data.windows.filter(w => w.start < total);
    for (const w of data.windows) w.len = Math.min(w.len, total - w.start);
    this.selWin = null;
    this.store.replace(data);
    this.updateWants();
    const hash = raw?.source?.hash;
    return !m || typeof hash !== 'string' || hash === m.hash;
  }
}

/** The pre-hash save key, used when a file can't be read for hashing and to migrate old saves. */
function legacyKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function loadState(hash: string, file: File): EditorState | null {
  try {
    const raw = localStorage.getItem(STATE_PREFIX + hash);
    if (raw) {
      const s = JSON.parse(raw) as Partial<EditorState>;
      return {
        version: 1, saved: Number(s.saved) || 0, project: sanitizeProject(s.project),
        playhead: Math.max(0, Math.round(Number(s.playhead) || 0)),
        selWin: typeof s.selWin === 'string' ? s.selWin : null,
        selTrack: typeof s.selTrack === 'string' ? s.selTrack : null,
        view: s.view ?? null,
      };
    }
    // Projects saved before content hashing were keyed by name, size and date: adopt one.
    const old = `vs.project:${legacyKey(file)}`;
    const legacy = localStorage.getItem(old);
    if (!legacy) return null;
    localStorage.removeItem(old);
    return { version: 1, saved: 0, project: sanitizeProject(JSON.parse(legacy)), playhead: 0, selWin: null, selTrack: null, view: null };
  } catch {
    return null;
  }
}

/** Write a state, dropping the least recently saved videos' states while storage is full. */
function storeState(key: string, json: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try { localStorage.setItem(key, json); return; } catch { /* full, or storage blocked */ }
    let oldest: string | null = null, when = Infinity;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || k === key || !(k.startsWith(STATE_PREFIX) || k.startsWith('vs.project:'))) continue;
        const t = k.startsWith(STATE_PREFIX) ? Number(JSON.parse(localStorage.getItem(k) ?? '{}').saved) || 0 : 0;
        if (t < when) { when = t; oldest = k; }
      }
      if (!oldest) return;
      localStorage.removeItem(oldest);
    } catch {
      return;
    }
  }
}

function dedupeKeys(keys: Win['keys']) {
  const out: Win['keys'] = [];
  for (const k of keys.sort((a, b) => a.f - b.f)) {
    if (out.length && out[out.length - 1].f === k.f) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
}
