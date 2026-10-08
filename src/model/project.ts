/**
 * A crop is the selection rectangle {x, y, w, h} in display-oriented source pixels
 * (top-left corner of the unrotated box), rotated clockwise by r degrees about its centre.
 */
export interface Crop { x: number; y: number; w: number; h: number; r: number }

/** A crop keyframe; f counts output frames from the window start. */
export interface Key { f: number; c: Crop }

export interface Win {
  id: string;
  track: string;
  /** First output frame. */
  start: number;
  /** Frame count. */
  len: number;
  /** Always at least one key. With animate off there is exactly one, at f = 0. */
  keys: Key[];
  animate: boolean;
}

/** Allowed lengths are a·n + b for whole n (a = 1, b = 0 allows any length). */
export interface Rule { a: number; b: number }

export interface Track {
  id: string;
  name: string;
  color: string;
  rule: Rule;
  defLen: number;
  /** Output size; 0 means derive from the crop. Both set fixes the size and locks the crop shape. */
  outW: number;
  outH: number;
  /** Output sides snap down to multiples of this. */
  div: number;
}

export interface ProjectData {
  version: 1;
  fps: number | null;
  tracks: Track[];
  windows: Win[];
  defaultCrop: Crop | null;
}

export const COLORS = ['#4f8cff', '#f2994a', '#27ae60', '#d65db1', '#e2c044', '#2bb3c0', '#eb5757', '#9b8cff'];

export const RULE_PRESETS: { label: string; rule: Rule }[] = [
  { label: 'Any length', rule: { a: 1, b: 0 } },
  { label: '4n + 1', rule: { a: 4, b: 1 } },
  { label: '8n + 1', rule: { a: 8, b: 1 } },
  { label: '16n + 1', rule: { a: 16, b: 1 } },
  { label: '3n + 1', rule: { a: 3, b: 1 } },
  { label: '6n + 1', rule: { a: 6, b: 1 } },
];

let counter = 0;
export const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

const mod = (n: number, m: number) => ((n % m) + m) % m;

export function ruleText(rule: Rule): string {
  if (rule.a <= 1) return 'any';
  return rule.b ? `${rule.a}n${rule.b > 0 ? '+' : '−'}${Math.abs(rule.b)}` : `${rule.a}n`;
}

export function minLen(rule: Rule): number {
  const a = Math.max(1, Math.round(rule.a));
  return mod(rule.b - 1, a) + 1;
}

export function isAllowed(rule: Rule, len: number): boolean {
  const a = Math.max(1, Math.round(rule.a));
  return len >= 1 && mod(len - rule.b, a) === 0;
}

/** Nearest allowed length to `len` that is at most `max`, or null when none fits. */
export function snapLen(rule: Rule, len: number, max = Infinity, mode: 'nearest' | 'down' | 'up' = 'nearest'): number | null {
  const a = Math.max(1, Math.round(rule.a));
  const lo = minLen(rule);
  if (max < lo) return null;
  const n = (len - rule.b) / a;
  const k = mode === 'down' ? Math.floor(n + 1e-9) : mode === 'up' ? Math.ceil(n - 1e-9) : Math.round(n);
  let v = Math.max(lo, a * k + rule.b);
  if (v > max) v = a * Math.floor((max - rule.b) / a) + rule.b;
  return v >= lo ? v : null;
}

export function lerpCrop(p: Crop, q: Crop, t: number): Crop {
  return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, w: p.w + (q.w - p.w) * t, h: p.h + (q.h - p.h) * t, r: p.r + (q.r - p.r) * t };
}

/** Linear between keys, held before the first and after the last. */
export function cropAt(win: Win, f: number): Crop {
  const keys = win.keys;
  if (keys.length === 1 || f <= keys[0].f) return { ...keys[0].c };
  const last = keys[keys.length - 1];
  if (f >= last.f) return { ...last.c };
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (f <= b.f) return lerpCrop(a.c, b.c, (f - a.f) / (b.f - a.f));
  }
  return { ...last.c };
}

export const snapDown = (v: number, d: number) => Math.max(d, Math.floor(v / d + 1e-6) * d);
export const snapNear = (v: number, d: number) => Math.max(d, Math.round(v / d) * d);

/** Output frame size for a window whose first crop is c0: fixed by the track, or the crop snapped down to div. */
export function outputSizeFor(c0: Crop, track: Track): { w: number; h: number } {
  const div = Math.max(1, track.div | 0);
  if (track.outW > 0 && track.outH > 0) return { w: track.outW, h: track.outH };
  const cw = snapDown(c0.w, div), ch = snapDown(c0.h, div);
  if (track.outW > 0) return { w: track.outW, h: snapNear(track.outW * ch / cw, div) };
  if (track.outH > 0) return { w: snapNear(track.outH * cw / ch, div), h: track.outH };
  return { w: cw, h: ch };
}

/** Output frame size of a window: fixed by the track, or the crop at the window start snapped to div. */
export function outputSize(win: Win, track: Track): { w: number; h: number } {
  return outputSizeFor(cropAt(win, 0), track);
}

/**
 * The part of crop c that ends up in the output, scaled uniformly: the centred rect of the
 * output's shape. With a size taken from the crop it is the crop trimmed to the side
 * multiples, on whole pixels, so an unrotated crop at the window start copies 1:1.
 */
export function outputRegion(c: Crop, c0: Crop, track: Track): Crop {
  const out = outputSizeFor(c0, track);
  let w: number, h: number;
  if (track.outW > 0 || track.outH > 0) {
    const k = Math.min(c.w / out.w, c.h / out.h);
    w = out.w * k; h = out.h * k;
  } else {
    // Keys of an animated window share one shape; later keys scale the trimmed size with them.
    const k = Math.min(c.w / c0.w, c.h / c0.h);
    w = Math.min(c.w, out.w * k); h = Math.min(c.h, out.h * k);
  }
  let dx = (c.w - w) / 2, dy = (c.h - h) / 2;
  if (!c.r) { dx = Math.floor(dx + 1e-6); dy = Math.floor(dy + 1e-6); }
  return { x: c.x + dx, y: c.y + dy, w, h, r: c.r };
}

/**
 * The centred part of a region with the given aspect ratio, so it fills an output of that shape
 * without stretching. A region already of that shape comes back unchanged.
 */
export function fitAspect(c: Crop, aspect: number): Crop {
  const a = c.w / c.h;
  if (Math.abs(a - aspect) < 1e-6 * aspect) return c;
  const w = a > aspect ? c.h * aspect : c.w, h = a > aspect ? c.h : c.w / aspect;
  return { ...c, x: c.x + (c.w - w) / 2, y: c.y + (c.h - h) / 2, w, h };
}

/** The aspect ratio a track forces on crops, or null when free. */
export function trackAspect(track: Track): number | null {
  return track.outW > 0 && track.outH > 0 ? track.outW / track.outH : null;
}

/**
 * Makes a crop valid: aspect ratio and, when unrotated, inside the frame on whole pixels.
 * Crops are free-sized; the output trims them to the track's side multiples (outputRegion).
 */
export function normalizeCrop(c: Crop, frameW: number, frameH: number, aspect: number | null): Crop {
  let { x, y, w, h, r } = c;
  r = ((r + 180) % 360 + 360) % 360 - 180;
  if (Math.abs(r) < 1e-6) r = 0;
  const cx = x + w / 2, cy = y + h / 2;
  const maxW = r ? frameW * 4 : frameW, maxH = r ? frameH * 4 : frameH;
  w = Math.max(2, Math.min(w, maxW));
  h = Math.max(2, Math.min(h, maxH));
  if (aspect) {
    if (w / h > aspect) w = h * aspect; else h = w / aspect;
    if (w > maxW) { w = maxW; h = w / aspect; }
    if (h > maxH) { h = maxH; w = h * aspect; }
  }
  x = cx - w / 2;
  y = cy - h / 2;
  if (!r) {
    if (!aspect) { w = Math.round(w); h = Math.round(h); }
    x = Math.round(Math.max(0, Math.min(frameW - w, x)));
    y = Math.round(Math.max(0, Math.min(frameH - h, y)));
  }
  return { x, y, w, h, r };
}

/** The largest crop of the track's shape, centred in the frame. */
export function fullCrop(frameW: number, frameH: number, aspect: number | null): Crop {
  let w = frameW, h = frameH;
  if (aspect) { if (w / h > aspect) w = h * aspect; else h = w / aspect; }
  return normalizeCrop({ x: (frameW - w) / 2, y: (frameH - h) / 2, w, h, r: 0 }, frameW, frameH, aspect);
}

/** Refit a crop to a new shape, keeping its centre and size as far as possible. */
export function refitCrop(c: Crop, frameW: number, frameH: number, aspect: number | null): Crop {
  let { w, h } = c;
  if (aspect) {
    const area = w * h;
    w = Math.sqrt(area * aspect);
    h = w / aspect;
  }
  return normalizeCrop({ ...c, x: c.x + (c.w - w) / 2, y: c.y + (c.h - h) / 2, w, h }, frameW, frameH, aspect);
}

export function newTrack(index: number, from?: Track): Track {
  return {
    id: uid('t'),
    name: `Track ${index + 1}`,
    color: COLORS[index % COLORS.length],
    rule: from ? { ...from.rule } : { a: 1, b: 0 },
    defLen: from?.defLen ?? PRESET_DEFAULTS.defLen,
    outW: from?.outW ?? 0,
    outH: from?.outH ?? 0,
    div: from?.div ?? PRESET_DEFAULTS.div,
  };
}

/**
 * Saved output settings. Every field is optional: applying a preset sets the ones it has
 * and returns the rest to their defaults (native fps, size from the crop, any length).
 */
export interface Preset {
  name: string;
  fps?: number;
  outW?: number;
  outH?: number;
  rule?: Rule;
  defLen?: number;
  div?: number;
}

export type PresetValues = Required<Omit<Preset, 'name' | 'fps'>> & { fps: number | null };

export const PRESET_DEFAULTS: PresetValues = { fps: null, outW: 0, outH: 0, rule: { a: 1, b: 0 }, defLen: 81, div: 2 };

/** The settings a preset stands for, defaults filled in. */
export function presetValues(p: Preset): PresetValues {
  return {
    fps: p.fps ?? null,
    outW: p.outW ?? 0,
    outH: p.outH ?? 0,
    rule: p.rule ? { ...p.rule } : { ...PRESET_DEFAULTS.rule },
    defLen: p.defLen ?? PRESET_DEFAULTS.defLen,
    div: p.div ?? PRESET_DEFAULTS.div,
  };
}

const sameRule = (a: Rule, b: Rule) => a.a === b.a && (a.a <= 1 || a.b === b.b);

/** A preset of the current settings, leaving out the ones at their defaults. */
export function presetFrom(name: string, fps: number | null, t: Track): Preset {
  const p: Preset = { name };
  if (fps != null) p.fps = fps;
  if (t.outW) p.outW = t.outW;
  if (t.outH) p.outH = t.outH;
  if (!sameRule(t.rule, PRESET_DEFAULTS.rule)) p.rule = { ...t.rule };
  if (t.defLen !== PRESET_DEFAULTS.defLen) p.defLen = t.defLen;
  if (t.div !== PRESET_DEFAULTS.div) p.div = t.div;
  return p;
}

export function presetMatches(p: Preset, fps: number | null, t: Track): boolean {
  const v = presetValues(p);
  const fpsSame = v.fps == null ? fps == null : fps != null && Math.abs(v.fps - fps) < 1e-6;
  return fpsSame && v.outW === t.outW && v.outH === t.outH && sameRule(v.rule, t.rule) && v.defLen === t.defLen && v.div === t.div;
}

/** Accepts a parsed preset list, dropping malformed entries and fields. */
export function sanitizePresets(raw: unknown): Preset[] {
  if (!Array.isArray(raw)) return [];
  const int = (v: unknown, min: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.round(v) : undefined);
  const out: Preset[] = [];
  for (const r of raw as Partial<Preset>[]) {
    if (!r || typeof r !== 'object' || typeof r.name !== 'string' || !r.name.trim()) continue;
    const p: Preset = { name: r.name.trim() };
    if (typeof r.fps === 'number' && r.fps > 0 && Number.isFinite(r.fps)) p.fps = r.fps;
    const outW = int(r.outW, 1), outH = int(r.outH, 1), defLen = int(r.defLen, 1), div = int(r.div, 1);
    if (outW) p.outW = outW;
    if (outH) p.outH = outH;
    if (defLen) p.defLen = defLen;
    if (div) p.div = div;
    const a = int(r.rule?.a, 1);
    if (a) p.rule = { a, b: Math.round(Number(r.rule?.b) || 0) };
    out.push(p);
  }
  return out;
}

/** One-line summary, e.g. "24 fps · 832×480 · 4n+1 · len 81 · ÷16". */
export function presetText(p: Preset, fpsText: (fps: number) => string = String): string {
  const v = presetValues(p);
  const size = v.outW && v.outH ? `${v.outW}×${v.outH}` : v.outW ? `w ${v.outW}` : v.outH ? `h ${v.outH}` : 'crop size';
  return [v.fps == null ? 'native fps' : `${fpsText(v.fps)} fps`, size, ruleText(v.rule) === 'any' ? 'any length' : ruleText(v.rule),
    `len ${v.defLen}`, `÷${v.div}`].join(' · ');
}

export function emptyProject(): ProjectData {
  return { version: 1, fps: null, tracks: [newTrack(0)], windows: [], defaultCrop: null };
}

/** Accepts a parsed project file, filling defaults and dropping anything malformed. */
export function sanitizeProject(raw: unknown): ProjectData {
  const p = raw as Partial<ProjectData>;
  if (!p || typeof p !== 'object' || !Array.isArray(p.tracks)) throw new Error('Not a video slicer project file.');
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const crop = (c: Partial<Crop> | undefined): Crop => ({ x: num(c?.x, 0), y: num(c?.y, 0), w: num(c?.w, 16), h: num(c?.h, 16), r: num(c?.r, 0) });
  const tracks: Track[] = p.tracks.map((t, i) => ({
    ...newTrack(i),
    ...(typeof t.id === 'string' ? { id: t.id } : {}),
    name: typeof t.name === 'string' ? t.name : `Track ${i + 1}`,
    color: typeof t.color === 'string' ? t.color : COLORS[i % COLORS.length],
    rule: { a: Math.max(1, Math.round(num(t.rule?.a, 1))), b: Math.round(num(t.rule?.b, 0)) },
    defLen: Math.max(1, Math.round(num(t.defLen, 81))),
    outW: Math.max(0, Math.round(num(t.outW, 0))),
    outH: Math.max(0, Math.round(num(t.outH, 0))),
    div: Math.max(1, Math.round(num(t.div, 2))),
  }));
  if (!tracks.length) tracks.push(newTrack(0));
  const ids = new Set(tracks.map(t => t.id));
  const windows: Win[] = (Array.isArray(p.windows) ? p.windows : [])
    .filter(w => w && ids.has(w.track) && Array.isArray(w.keys) && w.keys.length)
    .map(w => ({
      id: typeof w.id === 'string' ? w.id : uid('w'),
      track: w.track,
      start: Math.max(0, Math.round(num(w.start, 0))),
      len: Math.max(1, Math.round(num(w.len, 1))),
      animate: !!w.animate,
      keys: w.keys.map(k => ({ f: Math.max(0, Math.round(num(k.f, 0))), c: crop(k.c) })).sort((a, b) => a.f - b.f),
    }));
  return {
    version: 1,
    fps: typeof p.fps === 'number' && p.fps > 0 ? p.fps : null,
    tracks,
    windows,
    defaultCrop: p.defaultCrop ? crop(p.defaultCrop) : null,
  };
}

/** Free frames [lo, hi) around `frame` on a track, ignoring one window. */
export function freeSpan(p: ProjectData, track: string, frame: number, total: number, ignore?: string): [number, number] {
  let lo = 0, hi = total;
  for (const w of p.windows) {
    if (w.track !== track || w.id === ignore) continue;
    if (w.start + w.len <= frame) lo = Math.max(lo, w.start + w.len);
    else if (w.start > frame) hi = Math.min(hi, w.start);
    else return [frame, frame];
  }
  return [lo, hi];
}

export function fits(p: ProjectData, track: string, start: number, len: number, total: number, ignore?: string): boolean {
  if (start < 0 || start + len > total) return false;
  return !p.windows.some(w => w.track === track && w.id !== ignore && w.start < start + len && start < w.start + w.len);
}

/** Undoable project state with change notification. */
export class Store {
  private past: string[] = [];
  private future: string[] = [];
  private listeners = new Set<() => void>();
  private snapshot: string;
  data: ProjectData;

  constructor(data: ProjectData) {
    this.data = data;
    this.snapshot = JSON.stringify(data);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Notify without recording history (during a drag). */
  changed() {
    this.listeners.forEach(fn => fn());
  }

  /** Record the current state as one undo step. */
  commit() {
    const next = JSON.stringify(this.data);
    if (next === this.snapshot) { this.changed(); return; }
    this.past.push(this.snapshot);
    if (this.past.length > 300) this.past.shift();
    this.future = [];
    this.snapshot = next;
    this.changed();
  }

  /** Discard uncommitted edits (a cancelled drag). */
  revert() {
    this.data = JSON.parse(this.snapshot);
    this.changed();
  }

  replace(data: ProjectData, history = true) {
    this.data = data;
    if (history) this.commit();
    else { this.snapshot = JSON.stringify(data); this.past = []; this.future = []; this.changed(); }
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  undo() {
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push(this.snapshot);
    this.snapshot = prev;
    this.data = JSON.parse(prev);
    this.changed();
    return true;
  }

  redo() {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.snapshot);
    this.snapshot = next;
    this.data = JSON.parse(next);
    this.changed();
    return true;
  }
}
