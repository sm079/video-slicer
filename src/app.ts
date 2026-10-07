import { openVideo, type Demux, type UntaggedColor } from './media/demux';
import { FrameServer } from './media/frames';
import { ThumbServer } from './media/thumbs';
import { Timebase, detectFps } from './media/timebase';
import {
  Store, emptyProject, sanitizeProject, newTrack, uid, cropAt, snapLen, fits, freeSpan, fullCrop, refitCrop,
  normalizeCrop, trackAspect, type Crop, type ProjectData, type Track, type Win,
} from './model/project';
import type { Orientation } from './model/render';

export interface Media {
  file: File;
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
}

const CACHE_KEY = 'vs.cacheMB';
const COLOR_KEY = 'vs.untaggedColor';

export class App {
  store = new Store(emptyProject());
  media: Media | null = null;
  playhead = 0;
  selWin: string | null = null;
  selTrack: string;
  play: Play | null = null;
  status = '';
  /** Called once per animation frame when anything visible changed. */
  private drawers: (() => void)[] = [];
  /** Called when selection, project or media changed (inspector, buttons). */
  private uiListeners: (() => void)[] = [];
  private frameRequested = false;
  private uiDirty = false;
  private saveTimer = 0;
  toast: (msg: string, kind?: 'error' | 'info') => void = () => {};
  onLoading: (msg: string | null) => void = () => {};

  constructor() {
    this.selTrack = this.store.data.tracks[0].id;
    this.store.subscribe(() => {
      this.fixSelection();
      this.uiDirty = true;
      this.invalidate();
      this.scheduleSave();
    });
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
    if (this.media) {
      const { playhead, selWin } = this;
      await this.open(this.media.file);
      this.playhead = Math.min(playhead, this.total - 1);
      this.select(selWin);
      this.updateWants();
    }
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

  async open(file: File) {
    this.stop();
    this.onLoading(`Opening ${file.name}…`);
    let demux: Demux;
    try {
      demux = await openVideo(file, msg => this.onLoading(msg), this.untaggedColor);
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
    const saved = this.loadSaved(file);
    const data = saved ?? emptyProject();
    this.media = {
      file, demux, frames, thumbs, sourceFps,
      tb: new Timebase(demux.index, data.fps, sourceFps),
      W: info.width, H: info.height,
      orient: { rawW: info.rawW, rawH: info.rawH, rotation: info.rotation, flip: info.flip },
    };
    this.store.replace(data, false);
    this.selTrack = data.tracks[0].id;
    this.selWin = null;
    this.playhead = 0;
    this.onLoading(null);
    if (saved) this.toast('Restored the saved project for this video.');
    this.updateWants();
    this.invalidate(true);
  }

  get total() {
    return this.media?.tb.count ?? 0;
  }

  setFps(fps: number | null) {
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
    this.store.commit();
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
    if (this.play) this.play.nextDue = performance.now() + 1000 / this.media!.tb.fps;
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
    this.play = { loop: null, nextDue: performance.now() };
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
    this.play = { loop: id, nextDue: performance.now() };
    this.media.thumbs.setPaused(true);
    this.updateWants();
    this.invalidate(true);
  }

  stop() {
    if (!this.play) return;
    this.play = null;
    this.media?.frames.pin([]);
    this.media?.thumbs.setPaused(false);
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
  }

  // -------------------------------------------------------------- windows

  /** Crop that new windows on this track start with. */
  private templateCrop(track: Track): Crop {
    const m = this.media!;
    const aspect = trackAspect(track);
    const base = this.data.defaultCrop;
    return base ? refitCrop(base, m.W, m.H, aspect, track.div) : fullCrop(m.W, m.H, aspect, track.div);
  }

  /** Add a window without committing (the caller commits, e.g. at the end of a drag). */
  addWindow(track: Track, start: number, len: number): Win {
    const w = this.makeWindow(track, start, len);
    this.select(w.id);
    return w;
  }

  private makeWindow(track: Track, start: number, len: number): Win {
    const w: Win = { id: uid('w'), track: track.id, start, len, animate: false, keys: [{ f: 0, c: this.templateCrop(track) }] };
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
    if (from && (trackAspect(from) !== trackAspect(track) || from.div !== track.div)) this.refitWindow(w, track);
  }

  refitWindow(w: Win, track: Track) {
    const m = this.media;
    if (!m) return;
    const aspect = trackAspect(track);
    for (const k of w.keys) k.c = refitCrop(k.c, m.W, m.H, aspect, track.div);
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
    return this.data.defaultCrop ?? fullCrop(m.W, m.H, trackAspect(this.currentTrack), this.currentTrack.div);
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
    const track = this.currentTrack;
    const aspect = this.cropAspect();
    const div = aspect ? 1 : track.div;
    const crop = normalizeCrop(c, m.W, m.H, aspect, div);
    const w = this.selected;
    if (w) {
      if (!w.animate) w.keys = [{ f: 0, c: crop }];
      else {
        const f = this.localFrame(w);
        const k = w.keys.find(k => k.f === f);
        if (k) k.c = crop;
        else { w.keys.push({ f, c: crop }); w.keys.sort((a, b) => a.f - b.f); }
      }
    }
    this.data.defaultCrop = { ...crop };
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
    const shapeBefore = [trackAspect(track), track.div].join();
    Object.assign(track, patch);
    const total = this.total;
    const wins = this.data.windows.filter(w => w.track === track.id).sort((a, b) => a.start - b.start);
    for (const w of wins) {
      const [, hi] = freeSpan(this.data, track.id, w.start, total, w.id);
      const len = snapLen(track.rule, w.len, hi - w.start) ?? snapLen(track.rule, w.len, total - w.start, 'down');
      if (len != null) this.setRange(w, w.start, len);
    }
    if (shapeBefore !== [trackAspect(track), track.div].join()) for (const w of wins) this.refitWindow(w, track);
    this.resolveOverlaps(wins);
    this.store.commit();
  }

  // ---------------------------------------------------------- persistence

  private saveKey(file: File) {
    return `vs.project:${file.name}:${file.size}:${file.lastModified}`;
  }

  private loadSaved(file: File): ProjectData | null {
    try {
      const raw = localStorage.getItem(this.saveKey(file));
      return raw ? sanitizeProject(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      if (!this.media) return;
      try { localStorage.setItem(this.saveKey(this.media.file), JSON.stringify(this.data)); } catch { /* storage full or blocked */ }
    }, 400);
  }

  exportProject(): Blob {
    const m = this.media;
    const body = {
      ...this.data,
      source: m ? { name: m.file.name, size: m.file.size, width: m.W, height: m.H, frames: m.tb.count, fps: m.tb.fps } : undefined,
    };
    return new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
  }

  importProject(text: string) {
    const data = sanitizeProject(JSON.parse(text));
    const m = this.media;
    if (m) m.tb = new Timebase(m.demux.index, data.fps, m.sourceFps);
    const total = this.total;
    data.windows = data.windows.filter(w => w.start < total);
    for (const w of data.windows) w.len = Math.min(w.len, total - w.start);
    this.selWin = null;
    this.store.replace(data);
    this.updateWants();
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
