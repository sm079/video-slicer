import type { App } from '../app';
import { cropAt, freeSpan, snapLen, ruleText, outputSize, type Win, type Key } from '../model/project';
import { rawToDisplay } from '../model/render';
import { tip } from './widgets';

const HEADER_W = 168;
const RULER_H = 26;
const FILM_H = 40;
const LANE_H = 38;
const LANE_GAP = 2;
const OVERVIEW_H = 12;
const FONT = getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || 'system-ui, sans-serif';
const EDGE = 7;
const MAGNET = 7;

type Drag =
  | { kind: 'scrub' }
  | { kind: 'overview'; grab: number }
  | { kind: 'pan'; x0: number; start0: number; y0: number; scroll0: number }
  | { kind: 'move'; win: Win; grab: number; orig: Win; moved: boolean; x0: number; y0: number; frame: number }
  | { kind: 'resize'; win: Win; side: 'l' | 'r'; orig: Win }
  | { kind: 'create'; track: string; anchor: number; win: Win | null; x0: number; y0: number; frame: number }
  | { kind: 'key'; win: Win; key: Key; moved: boolean; x0: number };

export class Timeline {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  /** Frame at the left edge of the lanes. */
  private start = 0;
  /** CSS pixels per frame. */
  private ppf = 1;
  private scrollY = 0;
  private fitted = false;
  private drag: Drag | null = null;
  private lastClick = { t: 0, x: 0, y: 0 };
  private hoverText = '';
  private hoverAdd = false;
  /** Theme colours read from CSS at each draw. */
  private film = '#000';
  private overview = { fill: '', border: '', shade: '' };
  /** A saved view that arrived before the canvas had a size. */
  private pendingView: unknown = null;

  constructor(private canvas: HTMLCanvasElement, private app: App) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e));
    canvas.addEventListener('pointercancel', () => { if (this.drag) { this.drag = null; app.store.revert(); } });
    canvas.addEventListener('wheel', e => this.wheel(e), { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointerleave', () => {
      tip.hide();
      if (this.hoverAdd) { this.hoverAdd = false; app.invalidate(); }
    });
    app.onDraw(() => this.draw());
    // Saved as the visible span rather than pixels per frame, so it survives a different window size.
    app.view = {
      get: () => ({ start: this.start, span: this.laneW / this.ppf, scrollY: this.scrollY }),
      set: v => {
        const s = v as { start?: unknown; span?: unknown; scrollY?: unknown };
        if (typeof s.span !== 'number' || !(s.span > 0)) return;
        if (!this.w) { this.pendingView = v; return; }
        this.pendingView = null;
        this.ppf = this.laneW / s.span;
        this.start = Number(s.start) || 0;
        this.scrollY = Number(s.scrollY) || 0;
        this.clamp();
        app.invalidate();
      },
      reset: () => this.onMediaChanged(),
    };
  }

  private resize() {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    if (!this.fitted) this.fit();
    if (this.pendingView && this.w) this.app.view?.set(this.pendingView);
    this.clamp();
    this.app.invalidate();
  }

  private get laneW() { return Math.max(10, this.w - HEADER_W); }
  private get lanesTop() { return RULER_H + FILM_H; }
  private get lanesBottom() { return this.h - OVERVIEW_H; }

  fit() {
    const total = this.app.total;
    if (!total || !this.w) return;
    this.ppf = this.laneW / total;
    this.start = 0;
    this.fitted = true;
    this.app.invalidate();
  }

  zoomBy(k: number, anchorX = HEADER_W + this.laneW / 2) {
    const f = this.frameAt(anchorX);
    this.ppf *= k;
    this.clamp();
    this.start = f - (anchorX - HEADER_W) / this.ppf;
    this.clamp();
    this.app.invalidate();
  }

  /** Zoom to show a frame range. */
  show(a: number, b: number) {
    this.ppf = this.laneW / Math.max(8, (b - a) * 1.3);
    this.clamp();
    this.start = (a + b) / 2 - this.laneW / this.ppf / 2;
    this.clamp();
    this.app.invalidate();
  }

  onMediaChanged() {
    this.pendingView = null;
    this.fitted = false;
    this.scrollY = 0;
    this.fit();
  }

  private clamp() {
    const total = Math.max(1, this.app.total);
    this.ppf = Math.max(this.laneW / total / 1.05, Math.min(60, this.ppf));
    const visible = this.laneW / this.ppf;
    this.start = Math.max(-visible * 0.02, Math.min(total - visible * 0.98, this.start));
    const lanesH = this.app.data.tracks.length * (LANE_H + LANE_GAP) + LANE_H;
    this.scrollY = Math.max(0, Math.min(lanesH - (this.lanesBottom - this.lanesTop), this.scrollY));
  }

  private x(f: number) { return HEADER_W + (f - this.start) * this.ppf; }
  private frameAt(x: number) { return this.start + (x - HEADER_W) / this.ppf; }
  private laneY(i: number) { return this.lanesTop + i * (LANE_H + LANE_GAP) - this.scrollY; }
  private laneAt(y: number) {
    if (y < this.lanesTop || y >= this.lanesBottom) return -1;
    return Math.floor((y - this.lanesTop + this.scrollY) / (LANE_H + LANE_GAP));
  }

  /** Keep the playhead in view while playing. */
  private follow() {
    const visible = this.laneW / this.ppf;
    const p = this.app.playhead;
    if (p < this.start || p > this.start + visible - 1) { this.start = p - visible * 0.1; this.clamp(); }
  }

  // ------------------------------------------------------------ hit tests

  private pos(e: PointerEvent | WheelEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private windowAt(x: number, y: number) {
    const lane = this.laneAt(y);
    const track = this.app.data.tracks[lane];
    if (!track) return null;
    const ly = this.laneY(lane);
    if (y > ly + LANE_H) return null;
    // Selected window first so its keys and edges win.
    const wins = this.app.data.windows.filter(w => w.track === track.id).sort((a, b) => (a.id === this.app.selWin ? -1 : b.id === this.app.selWin ? 1 : 0));
    for (const w of wins) {
      const x0 = this.x(w.start), x1 = this.x(w.start + w.len);
      const edge = Math.min(EDGE, (x1 - x0) / 3);
      if (x < x0 - 2 || x > x1 + 2) continue;
      if (w.id === this.app.selWin && y >= ly + LANE_H - 13) {
        for (const k of w.keys) {
          const kx = this.x(w.start + k.f + 0.5);
          if (Math.abs(x - kx) <= 6 && w.animate) return { w, part: 'key' as const, key: k };
        }
      }
      if (x1 - x0 >= 34 && x >= x0 + 4 && x <= x0 + 22 && y >= ly + 4 && y <= ly + 22) return { w, part: 'play' as const };
      if (x <= x0 + edge) return { w, part: 'l' as const };
      if (x >= x1 - edge) return { w, part: 'r' as const };
      return { w, part: 'body' as const };
    }
    return null;
  }

  // ---------------------------------------------------------- interaction

  private down(e: PointerEvent) {
    const app = this.app;
    if (!app.media) return;
    const { x, y } = this.pos(e);
    this.canvas.setPointerCapture(e.pointerId);
    const now = performance.now();
    const dbl = now - this.lastClick.t < 350 && Math.hypot(x - this.lastClick.x, y - this.lastClick.y) < 5;
    this.lastClick = { t: now, x, y };
    if (e.button === 1 || e.button === 2) {
      this.drag = { kind: 'pan', x0: x, start0: this.start, y0: y, scroll0: this.scrollY };
      return;
    }
    if (y >= this.lanesBottom) {
      const total = app.total;
      const visible = this.laneW / this.ppf;
      const vx0 = HEADER_W + (this.start / total) * this.laneW, vw = (visible / total) * this.laneW;
      const grab = x >= vx0 && x <= vx0 + vw ? (x - vx0) : vw / 2;
      this.drag = { kind: 'overview', grab };
      this.move(e);
      return;
    }
    if (y < this.lanesTop) {
      if (x < HEADER_W) return;
      this.drag = { kind: 'scrub' };
      app.seek(Math.floor(this.frameAt(x)));
      return;
    }
    const lane = this.laneAt(y);
    const track = app.data.tracks[lane];
    if (x < HEADER_W) {
      if (track) app.selectTrack(track.id);
      else if (lane === app.data.tracks.length) app.addTrack();
      return;
    }
    if (!track) return;
    const hit = this.windowAt(x, y);
    const frame = Math.max(0, Math.min(app.total - 1, Math.floor(this.frameAt(x))));
    if (hit) {
      const orig: Win = JSON.parse(JSON.stringify(hit.w));
      if (hit.part === 'play') { app.playLoop(hit.w.id); return; }
      if (app.play && app.play.loop !== hit.w.id) app.stop();
      app.select(hit.w.id);
      if (hit.part === 'key') { this.drag = { kind: 'key', win: hit.w, key: hit.key!, moved: false, x0: x }; return; }
      if (hit.part === 'l' || hit.part === 'r') { this.drag = { kind: 'resize', win: hit.w, side: hit.part, orig }; return; }
      if (dbl) { this.show(hit.w.start, hit.w.start + hit.w.len); return; }
      this.drag = { kind: 'move', win: hit.w, grab: this.frameAt(x) - hit.w.start, orig, moved: false, x0: x, y0: y, frame };
      return;
    }
    app.selectTrack(track.id);
    app.select(null);
    if (dbl) { app.createWindowAt(frame, track.id); return; }
    this.drag = { kind: 'create', track: track.id, anchor: frame, win: null, x0: x, y0: y, frame };
  }

  private move(e: PointerEvent) {
    const app = this.app;
    const { x, y } = this.pos(e);
    const d = this.drag;
    if (!d) { this.hoverCursor(x, y); return; }
    const total = app.total;
    switch (d.kind) {
      case 'pan':
        this.start = d.start0 - (x - d.x0) / this.ppf;
        this.scrollY = d.scroll0 - (y - d.y0);
        this.clamp();
        app.invalidate();
        break;
      case 'overview': {
        const visible = this.laneW / this.ppf;
        this.start = ((x - d.grab - HEADER_W) / this.laneW) * total;
        this.start = Math.max(0, Math.min(total - visible, this.start));
        this.clamp();
        app.invalidate();
        break;
      }
      case 'scrub':
        app.seek(Math.floor(this.frameAt(x)));
        break;
      case 'key': {
        if (!d.moved && Math.abs(x - d.x0) < 3) return;
        d.moved = true;
        const f = Math.max(0, Math.min(d.win.len - 1, Math.floor(this.frameAt(x)) - d.win.start));
        if (!d.win.keys.some(k => k !== d.key && k.f === f)) {
          d.key.f = f;
          d.win.keys.sort((a, b) => a.f - b.f);
          app.seek(d.win.start + f);
          app.store.changed();
        }
        break;
      }
      case 'resize': this.resizeTo(d, x, e.altKey); break;
      case 'move': {
        if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < 4) return;
        d.moved = true;
        this.moveTo(d, x, y, e.altKey);
        break;
      }
      case 'create': {
        if (!d.win && Math.abs(x - d.x0) < 4) return;
        const track = app.track(d.track)!;
        const c = Math.max(0, Math.min(total - 1, Math.floor(this.frameAt(x))));
        const [lo, hi] = freeSpan(app.data, d.track, d.anchor, total, d.win?.id);
        let start: number, len: number | null;
        if (c >= d.anchor) {
          len = snapLen(track.rule, c - d.anchor + 1, hi - d.anchor);
          start = d.anchor;
        } else {
          len = snapLen(track.rule, d.anchor + 1 - c, d.anchor + 1 - lo);
          start = len == null ? d.anchor : d.anchor + 1 - len;
        }
        if (len == null) return;
        if (!d.win) {
          d.win = app.addWindow(track, start, len);
          app.select(d.win.id);
        }
        d.win.start = start;
        d.win.len = len;
        app.store.changed();
        break;
      }
    }
  }

  private up(e: PointerEvent) {
    const app = this.app;
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const { x } = this.pos(e);
    switch (d.kind) {
      case 'move':
        if (d.moved) app.store.commit();
        else app.seek(Math.floor(this.frameAt(x)));
        break;
      case 'create':
        if (d.win) app.store.commit();
        else app.seek(d.frame);
        break;
      case 'key':
        if (d.moved) app.store.commit();
        else app.seek(d.win.start + d.key.f);
        break;
      case 'resize':
        app.store.commit();
        break;
    }
  }

  private magnets(skip: string): number[] {
    const app = this.app;
    const out = [app.playhead, 0, app.total];
    for (const w of app.data.windows) if (w.id !== skip) out.push(w.start, w.start + w.len);
    return out;
  }

  private snapEdge(f: number, cands: number[]): number | null {
    let best: number | null = null, dist = MAGNET / this.ppf;
    for (const c of cands) if (Math.abs(c - f) < dist) { dist = Math.abs(c - f); best = c; }
    return best;
  }

  private moveTo(d: Extract<Drag, { kind: 'move' }>, x: number, y: number, noSnap: boolean) {
    const app = this.app;
    const total = app.total;
    const w = d.win;
    let desired = Math.round(this.frameAt(x) - d.grab);
    if (!noSnap) {
      const cands = this.magnets(w.id);
      const s = this.snapEdge(desired, cands), en = this.snapEdge(desired + w.len, cands);
      if (s != null && (en == null || Math.abs(s - desired) <= Math.abs(en - desired - w.len))) desired = s;
      else if (en != null) desired = en - w.len;
    }
    const lane = this.laneAt(y);
    const targets = [app.data.tracks[lane], app.track(w.track)].filter(Boolean);
    for (const t of targets) {
      const place = this.place(t!.id, w, desired, total);
      if (place == null) continue;
      if (t!.id !== w.track) app.moveToTrack(w, t!);
      w.start = place;
      app.selTrack = w.track;
      app.store.changed();
      return;
    }
  }

  /** The allowed start nearest to `desired` on a track, or null if the window fits nowhere. */
  private place(track: string, w: Win, desired: number, total: number): number | null {
    const others = this.app.data.windows.filter(o => o.track === track && o.id !== w.id).sort((a, b) => a.start - b.start);
    let best: number | null = null, dist = Infinity, lo = 0;
    const gaps: [number, number][] = [];
    for (const o of others) { gaps.push([lo, o.start]); lo = Math.max(lo, o.start + o.len); }
    gaps.push([lo, total]);
    for (const [a, b] of gaps) {
      if (b - a < w.len) continue;
      const s = Math.max(a, Math.min(b - w.len, desired));
      if (Math.abs(s - desired) < dist) { dist = Math.abs(s - desired); best = s; }
    }
    // Do not jump across a neighbour just because the pointer overshot slightly.
    if (best != null && track === w.track && dist * this.ppf > Math.max(60, w.len * this.ppf * 0.6)) {
      const [a, b] = freeSpan(this.app.data, track, w.start, total, w.id);
      return Math.max(a, Math.min(b - w.len, desired));
    }
    return best;
  }

  private resizeTo(d: Extract<Drag, { kind: 'resize' }>, x: number, noSnap: boolean) {
    const app = this.app;
    const w = d.win, o = d.orig;
    const track = app.track(w.track)!;
    const total = app.total;
    const [lo, hi] = freeSpan(app.data, w.track, o.start, total, w.id);
    let f = Math.round(this.frameAt(x));
    if (!noSnap) { const s = this.snapEdge(f, this.magnets(w.id)); if (s != null) f = s; }
    let start = o.start, len: number | null;
    if (d.side === 'r') {
      len = snapLen(track.rule, Math.max(1, f - o.start), hi - o.start);
    } else {
      const end = o.start + o.len;
      len = snapLen(track.rule, Math.max(1, end - f), end - lo);
      if (len != null) start = end - len;
    }
    if (len == null) return;
    // Keys stay at the same moments when the start moves.
    const shift = o.start - start;
    const keys = o.keys.map(k => ({ f: k.f + shift, c: k.c })).filter(k => k.f >= 0 && k.f < len!);
    w.start = start;
    w.len = len;
    w.keys = keys.length ? keys : [{ f: 0, c: cropAt(o, Math.max(0, start - o.start)) }];
    if (!w.animate) w.keys = [{ f: 0, c: o.keys[0].c }];
    app.store.changed();
  }

  private hoverCursor(x: number, y: number) {
    let cursor = 'default';
    let text = '';
    const addRow = x < HEADER_W && this.laneAt(y) === this.app.data.tracks.length;
    if (y < this.lanesTop && x >= HEADER_W) cursor = 'col-resize';
    else if (y >= this.lanesTop && y < this.lanesBottom && x >= HEADER_W) {
      const hit = this.windowAt(x, y);
      if (hit) {
        cursor = hit.part === 'body' ? 'grab' : hit.part === 'play' ? 'pointer' : 'ew-resize';
        const n = this.app.data.windows.filter(o => o.track === hit.w.track && o.start < hit.w.start).length + 1;
        text = hit.part === 'play' ? (this.app.play?.loop === hit.w.id ? 'Stop loop' : 'Loop window')
          : hit.part === 'key' ? `Key at frame ${hit.key!.f} · drag to retime`
          : `Window ${n} · ${hit.w.start}–${hit.w.start + hit.w.len - 1} · ${hit.w.len} frames`;
      } else if (this.app.data.tracks[this.laneAt(y)]) cursor = 'crosshair';
    } else if (y >= this.lanesBottom && x >= HEADER_W) cursor = 'pointer';
    else if (addRow || (x < HEADER_W && this.app.data.tracks[this.laneAt(y)])) cursor = 'pointer';
    this.canvas.style.cursor = cursor;
    if (addRow !== this.hoverAdd) { this.hoverAdd = addRow; this.app.invalidate(); }
    if (text !== this.hoverText) this.hoverText = text;
    const r = this.canvas.getBoundingClientRect();
    if (text) tip.at(r.left + x, r.top + y, text);
    else tip.hide();
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const { x, y } = this.pos(e);
    if (x < HEADER_W && y >= this.lanesTop) {
      this.scrollY += e.deltaY;
      this.clamp();
      this.app.invalidate();
      return;
    }
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      this.start += (e.shiftKey ? e.deltaY : e.deltaX) / this.ppf;
      this.clamp();
      this.app.invalidate();
      return;
    }
    this.zoomBy(Math.exp(-e.deltaY * 0.002), Math.max(HEADER_W, x));
  }

  // -------------------------------------------------------------- drawing

  draw() {
    const { ctx, app } = this;
    const dpr = devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(this.canvas);
    const col = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
    const bg = col('--tl-bg', '#101215'), lane = col('--tl-lane', '#15171b'), lane2 = col('--tl-lane-sel', '#1a1d23');
    const head = col('--tl-head', '#14161a'), head2 = col('--tl-head-sel', '#1b1e24');
    const fg = col('--tl-fg', '#e7e9ed'), dim = col('--tl-dim', '#6c7380'), line = col('--tl-line', '#23262d');
    const playhead = col('--tl-playhead', '#ff5a52');
    const headFg = col('--tl-head-fg', fg), grid = col('--tl-grid', 'rgba(255,255,255,.035)');
    this.film = col('--tl-film', '#000');
    this.overview = { fill: col('--tl-view', 'rgba(255,255,255,.08)'), border: col('--tl-view-border', 'rgba(255,255,255,.28)'), shade: col('--tl-shade', 'rgba(0,0,0,.25)') };
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.w, this.h);
    const m = app.media;
    if (!m) return;
    if (app.play) this.follow();
    this.clamp();
    const total = app.total;
    const visible = this.laneW / this.ppf;
    const f0 = Math.max(0, Math.floor(this.start)), f1 = Math.min(total, Math.ceil(this.start + visible));

    // Lanes.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, this.lanesTop, this.w, this.lanesBottom - this.lanesTop);
    ctx.clip();
    app.data.tracks.forEach((t, i) => {
      const y = this.laneY(i);
      if (y > this.lanesBottom || y + LANE_H < this.lanesTop) return;
      ctx.fillStyle = t.id === app.currentTrack.id ? lane2 : lane;
      ctx.fillRect(HEADER_W, y, this.laneW, LANE_H);
    });
    if (this.ppf >= 8) {
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let f = f0; f <= f1; f++) { const x = Math.round(this.x(f)) + 0.5; ctx.moveTo(x, this.lanesTop); ctx.lineTo(x, this.lanesBottom); }
      ctx.stroke();
    }
    // Area beyond the end of the video.
    const endX = this.x(total);
    if (endX < this.w) {
      ctx.fillStyle = bg;
      ctx.fillRect(endX, this.lanesTop, this.w - endX, this.lanesBottom - this.lanesTop);
      ctx.fillStyle = line;
      ctx.fillRect(Math.round(endX), this.lanesTop, 1, this.lanesBottom - this.lanesTop);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER_W, this.lanesTop, this.laneW, this.lanesBottom - this.lanesTop);
    ctx.clip();
    for (const w of app.data.windows) this.drawWindow(w, fg);
    if (!app.data.windows.length && app.data.tracks.length) {
      // First-run hint inside the first lane.
      const y = this.laneY(0);
      ctx.fillStyle = dim;
      ctx.font = `12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('Drag here to draw a window  ·  double-click for default length', HEADER_W + Math.min(this.laneW, endX - HEADER_W) / 2, y + LANE_H / 2 + 4);
      ctx.textAlign = 'left';
    }
    ctx.restore();
    // Headers.
    app.data.tracks.forEach((t, i) => {
      const y = this.laneY(i);
      if (y > this.lanesBottom || y + LANE_H < this.lanesTop) return;
      const sel = t.id === app.currentTrack.id;
      ctx.fillStyle = sel ? head2 : head;
      ctx.fillRect(0, y, HEADER_W - 1, LANE_H);
      ctx.fillStyle = t.color;
      roundRect(ctx, 8, y + 9, 3, LANE_H - 18, 1.5);
      ctx.fill();
      ctx.fillStyle = sel ? fg : headFg;
      ctx.font = `${sel ? 600 : 500} 12px ${FONT}`;
      ctx.fillText(ellipsize(ctx, t.name, HEADER_W - 30), 19, y + 16);
      ctx.fillStyle = dim;
      ctx.font = `11px ${FONT}`;
      const size = t.outW && t.outH ? `${t.outW}×${t.outH}` : t.outW ? `W ${t.outW}` : t.outH ? `H ${t.outH}` : 'Crop size';
      const rule = ruleText(t.rule);
      ctx.fillText(ellipsize(ctx, `${size} · ${rule === 'any' ? 'any length' : rule}`, HEADER_W - 30), 19, y + 30);
    });
    const addY = this.laneY(app.data.tracks.length);
    if (this.hoverAdd) {
      ctx.fillStyle = head2;
      roundRect(ctx, 4, addY + 5, HEADER_W - 9, LANE_H - 10, 6);
      ctx.fill();
    }
    ctx.fillStyle = this.hoverAdd ? fg : dim;
    ctx.font = `500 12px ${FONT}`;
    ctx.fillText('+  Add track', 16, addY + LANE_H / 2 + 4);
    ctx.restore();

    // Ruler and filmstrip.
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.w, this.lanesTop);
    this.drawFilm(f0, f1);
    this.drawRuler(f0, f1, fg, dim, line);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, HEADER_W, this.lanesTop);
    ctx.fillStyle = line;
    ctx.fillRect(0, this.lanesTop - 1, this.w, 1);
    ctx.fillRect(HEADER_W - 1, 0, 1, this.lanesBottom);

    // Playhead.
    const px = this.x(app.playhead);
    if (this.ppf >= 3) {
      ctx.fillStyle = 'rgba(255,90,82,.12)';
      ctx.fillRect(Math.max(HEADER_W, px), RULER_H, this.ppf, this.lanesBottom - RULER_H);
    }
    const cx = px + this.ppf / 2;
    if (cx >= HEADER_W - 1) {
      ctx.strokeStyle = playhead;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, 6);
      ctx.lineTo(cx, this.lanesBottom);
      ctx.stroke();
      ctx.fillStyle = playhead;
      ctx.beginPath();
      ctx.roundRect(cx - 5, 1, 10, 9, 2);
      ctx.moveTo(cx - 5, 9); ctx.lineTo(cx + 5, 9); ctx.lineTo(cx, 14);
      ctx.fill();
    }
    this.drawOverview(dim, line, playhead);
  }

  private drawWindow(w: Win, fg: string) {
    const { ctx, app } = this;
    const idx = app.data.tracks.findIndex(t => t.id === w.track);
    const track = app.data.tracks[idx];
    if (!track) return;
    const x0 = this.x(w.start), x1 = this.x(w.start + w.len);
    if (x1 < HEADER_W || x0 > this.w) return;
    const y = this.laneY(idx) + 2, h = LANE_H - 4;
    const sel = w.id === app.selWin;
    const looping = app.play?.loop === w.id;
    const width = Math.max(2, x1 - x0);
    ctx.globalAlpha = sel || looping ? 1 : 0.72;
    ctx.fillStyle = track.color;
    roundRect(ctx, x0, y, width, h, 5);
    ctx.fill();
    ctx.globalAlpha = 1;
    // A soft top highlight gives the block some depth.
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    roundRect(ctx, x0, y, width, 1.5, 1);
    ctx.fill();
    if (sel || looping) {
      ctx.strokeStyle = fg;
      ctx.lineWidth = 2;
      roundRect(ctx, x0 - 1, y - 1, width + 2, h + 2, 6);
      ctx.stroke();
    }
    ctx.fillStyle = '#0b0d12';
    let tx = x0 + 6;
    if (width >= 34) {
      // Play / loop button.
      ctx.fillStyle = looping ? 'rgba(0,0,0,.5)' : 'rgba(0,0,0,.26)';
      roundRect(ctx, x0 + 4, y + 3, 18, 18, 4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      if (looping) { ctx.fillRect(x0 + 9, y + 7, 3, 10); ctx.fillRect(x0 + 14, y + 7, 3, 10); }
      else { ctx.moveTo(x0 + 10, y + 7); ctx.lineTo(x0 + 18, y + 12); ctx.lineTo(x0 + 10, y + 17); ctx.fill(); }
      tx = x0 + 27;
    }
    if (width > 60) {
      const n = app.data.windows.filter(o => o.track === w.track && o.start < w.start).length + 1;
      const out = outputSize(w, track);
      ctx.fillStyle = 'rgba(8,9,12,.92)';
      ctx.font = `600 11px ${FONT}`;
      const label = `${n}  ·  ${w.len} f${width > 150 ? `  ·  ${out.w}×${out.h}` : ''}`;
      ctx.fillText(ellipsize(ctx, label, x1 - tx - 6), tx, y + 16);
    }
    // Keyframes.
    if (w.animate) {
      for (const k of w.keys) {
        const kx = this.x(w.start + k.f + 0.5), ky = y + h - 6;
        const r = sel ? 4.5 : 3;
        ctx.fillStyle = sel ? '#fff' : 'rgba(255,255,255,.75)';
        ctx.strokeStyle = '#0b0d12';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(kx, ky - r); ctx.lineTo(kx + r, ky); ctx.lineTo(kx, ky + r); ctx.lineTo(kx - r, ky);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  private drawFilm(f0: number, f1: number) {
    const { ctx, app } = this;
    const m = app.media!;
    const th = m.thumbs;
    const y = RULER_H, h = FILM_H - 2;
    const rot = m.orient.rotation % 180 !== 0;
    const dispW = rot ? th.height : th.width, dispH = rot ? th.width : th.height;
    const slotW = Math.max(24, h * dispW / dispH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER_W, y, this.laneW, h);
    ctx.clip();
    ctx.fillStyle = this.film;
    ctx.fillRect(HEADER_W, y, Math.min(this.laneW, this.x(app.total) - HEADER_W), h);
    const want: number[] = [];
    const firstSlot = Math.floor((this.x(f0) - HEADER_W) / slotW);
    for (let s = Math.max(0, firstSlot); ; s++) {
      const sx = HEADER_W + s * slotW;
      if (sx > this.w) break;
      const f = Math.floor(this.frameAt(sx + slotW / 2));
      if (f < 0) continue;
      if (f >= f1 || f >= app.total) break;
      const src = m.tb.src(f);
      const b = th.get(src);
      if (!b) { want.push(src); continue; }
      const scale = h / dispH;
      const o = { rawW: b.width, rawH: b.height, rotation: m.orient.rotation, flip: m.orient.flip };
      const dw = dispW * scale;
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx, y, slotW, h);
      ctx.clip();
      ctx.setTransform(new DOMMatrix([devicePixelRatio || 1, 0, 0, devicePixelRatio || 1, 0, 0])
        .translate(sx + (slotW - dw) / 2, y).scale(scale).multiply(rawToDisplay(o)));
      ctx.drawImage(b, 0, 0);
      ctx.restore();
    }
    ctx.restore();
    if (want.length) th.request(want);
    // Cached frames along the bottom of the strip.
    if (f1 - f0 < 4000) {
      ctx.fillStyle = 'rgba(60,200,120,.85)';
      for (let f = f0; f < f1; f++) if (m.frames.has(m.tb.src(f))) ctx.fillRect(this.x(f), y + h - 2, Math.max(1, this.ppf), 2);
    }
  }

  private drawRuler(f0: number, f1: number, fg: string, dim: string, line: string) {
    const { ctx, app } = this;
    const tb = app.media!.tb;

    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000, 100000, 200000, 500000];
    const step = steps.find(s => s * this.ppf >= 70) ?? 1000000;
    const minor = steps.find(s => s * this.ppf >= 8 && step % s === 0) ?? step;
    ctx.strokeStyle = line;
    ctx.beginPath();
    for (let f = Math.floor(f0 / minor) * minor; f <= f1; f += minor) {
      const x = Math.round(this.x(f)) + 0.5;
      if (x < HEADER_W) continue;
      const major = f % step === 0;
      ctx.moveTo(x, major ? RULER_H - 9 : RULER_H - 4);
      ctx.lineTo(x, RULER_H);
    }
    ctx.stroke();
    for (let f = Math.floor(f0 / step) * step; f <= f1; f += step) {
      const x = this.x(f);
      if (x < HEADER_W) continue;
      ctx.font = `500 11px ${FONT}`;
      ctx.fillStyle = fg;
      ctx.fillText(String(f), x + 4, 12);
      const fw = ctx.measureText(String(f)).width;
      ctx.font = `10.5px ${FONT}`;
      const tc = timecode(tb.time(f));
      if (fw + ctx.measureText(tc).width + 22 <= step * this.ppf) {
        ctx.fillStyle = dim;
        ctx.fillText(tc, x + 10 + fw, 12);
      }
    }
  }

  private drawOverview(dim: string, line: string, playhead: string) {
    const { ctx, app } = this;
    const total = app.total;
    const y = this.lanesBottom;
    ctx.fillStyle = this.overview.shade;
    ctx.fillRect(0, y, this.w, OVERVIEW_H);
    for (const w of app.data.windows) {
      const t = app.track(w.track);
      ctx.fillStyle = t?.color ?? dim;
      ctx.globalAlpha = 0.7;
      ctx.fillRect(HEADER_W + (w.start / total) * this.laneW, y + 4, Math.max(1, (w.len / total) * this.laneW), OVERVIEW_H - 8);
      ctx.globalAlpha = 1;
    }
    const visible = this.laneW / this.ppf;
    if (visible < total * 0.995) {
      ctx.fillStyle = this.overview.fill;
      ctx.strokeStyle = this.overview.border;
      ctx.lineWidth = 1;
      const vx = HEADER_W + (this.start / total) * this.laneW, vw = Math.max(6, (visible / total) * this.laneW);
      roundRect(ctx, vx + 0.5, y + 1.5, vw - 1, OVERVIEW_H - 3, 3);
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = playhead;
    ctx.fillRect(HEADER_W + (app.playhead / total) * this.laneW, y, 1.5, OVERVIEW_H);
    ctx.strokeStyle = line;
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(this.w, y + 0.5);
    ctx.stroke();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

function ellipsize(ctx: CanvasRenderingContext2D, s: string, max: number) {
  if (max <= 8) return '';
  if (ctx.measureText(s).width <= max) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}

export function timecode(sec: number) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600), mnt = Math.floor((s % 3600) / 60), r = s % 60;
  const ss = r.toFixed(2).padStart(5, '0');
  return h ? `${h}:${String(mnt).padStart(2, '0')}:${ss}` : `${mnt}:${ss}`;
}
