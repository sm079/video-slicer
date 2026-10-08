import type { App } from '../app';
import { cropAt, outputRegion, outputSizeFor, type Crop } from '../model/project';
import { cropCorners, rawToDisplay } from '../model/render';

type Handle = { kind: 'move' } | { kind: 'rotate' } | { kind: 'resize'; sx: -1 | 0 | 1; sy: -1 | 0 | 1 } | { kind: 'draw' } | { kind: 'pan' };

const HANDLE = 7;
const ROT_OFFSET = 26;

/** Source frame with the crop overlay. Drag inside to move, handles to resize or rotate, outside to draw a new crop. */
export class Viewer {
  private ctx: CanvasRenderingContext2D;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private drag: { h: Handle; start: Crop; p0: [number, number]; s0: [number, number]; pan0: [number, number] } | null = null;
  private hover: Handle | null = null;

  private chipText = '';

  constructor(private canvas: HTMLCanvasElement, private app: App, private zoomChip: HTMLButtonElement) {
    this.ctx = canvas.getContext('2d')!;
    zoomChip.addEventListener('click', () => this.resetView());
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e));
    canvas.addEventListener('pointercancel', () => { if (this.drag) { this.drag = null; app.store.revert(); } });
    canvas.addEventListener('wheel', e => this.wheel(e), { passive: false });
    canvas.addEventListener('dblclick', e => {
      if (!this.hitCrop(this.toDisplay(e))) this.resetView();
    });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    app.onDraw(() => this.draw());
  }

  resetView() {
    this.zoom = 1;
    this.panX = this.panY = 0;
    this.app.invalidate();
  }

  /** The zoom chip shows the scale in source pixels while the view is zoomed or panned. */
  private updateChip() {
    const zoomed = !!this.app.media && (Math.abs(this.zoom - 1) > 1e-3 || this.panX !== 0 || this.panY !== 0);
    const text = zoomed ? `${Math.round(this.scale / (devicePixelRatio || 1) * 100)}%` : '';
    if (text === this.chipText) return;
    this.chipText = text;
    this.zoomChip.hidden = !zoomed;
    this.zoomChip.textContent = text;
  }

  private resize() {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.app.invalidate();
  }

  /** Display pixels → canvas pixels. */
  private view(): DOMMatrix {
    const m = this.app.media;
    const cw = this.canvas.width, ch = this.canvas.height;
    if (!m) return new DOMMatrix();
    const pad = 24 * (devicePixelRatio || 1);
    const fit = Math.min((cw - pad * 2) / m.W, (ch - pad * 2) / m.H);
    const s = fit * this.zoom;
    return new DOMMatrix().translate(cw / 2 + this.panX, ch / 2 + this.panY).scale(s).translate(-m.W / 2, -m.H / 2);
  }

  private get scale() {
    return this.view().a;
  }

  private toDisplay(e: PointerEvent | MouseEvent | WheelEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    const p = this.view().inverse().transformPoint(new DOMPoint((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr));
    return [p.x, p.y];
  }

  private local(c: Crop, p: [number, number]): [number, number] {
    const a = -c.r * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
    const dx = p[0] - (c.x + c.w / 2), dy = p[1] - (c.y + c.h / 2);
    return [co * dx - si * dy, si * dx + co * dy];
  }

  private hitCrop(p: [number, number]) {
    const c = this.app.activeCrop();
    if (!c) return false;
    const [lx, ly] = this.local(c, p);
    return Math.abs(lx) <= c.w / 2 && Math.abs(ly) <= c.h / 2;
  }

  private hit(p: [number, number]): Handle | null {
    const c = this.app.activeCrop();
    if (!c || !this.app.media) return null;
    const tol = (HANDLE + 4) * (devicePixelRatio || 1) / this.scale;
    const [lx, ly] = this.local(c, p);
    const hw = c.w / 2, hh = c.h / 2;
    if (Math.hypot(lx, ly + hh + ROT_OFFSET * (devicePixelRatio || 1) / this.scale) <= tol) return { kind: 'rotate' };
    const nearX = Math.abs(Math.abs(lx) - hw) <= tol, nearY = Math.abs(Math.abs(ly) - hh) <= tol;
    const inX = Math.abs(lx) <= hw + tol, inY = Math.abs(ly) <= hh + tol;
    const sx = (lx < 0 ? -1 : 1) as -1 | 1, sy = (ly < 0 ? -1 : 1) as -1 | 1;
    if (nearX && nearY) return { kind: 'resize', sx, sy };
    if (nearX && inY) return { kind: 'resize', sx, sy: 0 };
    if (nearY && inX) return { kind: 'resize', sx: 0, sy };
    if (Math.abs(lx) < hw && Math.abs(ly) < hh) return { kind: 'move' };
    return null;
  }

  private cursor(h: Handle | null, c: Crop | null): string {
    if (!h) return 'crosshair';
    if (h.kind === 'move') return 'move';
    if (h.kind === 'rotate') return 'grab';
    if (h.kind === 'pan') return 'grabbing';
    if (h.kind === 'resize' && c) {
      const ang = (Math.atan2(h.sy, h.sx) * 180 / Math.PI + c.r + 360) % 180;
      return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(ang / 45) % 4];
    }
    return 'default';
  }

  private down(e: PointerEvent) {
    const app = this.app;
    if (!app.media) return;
    const p = this.toDisplay(e);
    const c = app.activeCrop()!;
    let h: Handle | null = e.button === 1 || e.button === 2 ? { kind: 'pan' } : this.hit(p);
    if (!h) h = { kind: 'draw' };
    if (app.play && h.kind !== 'pan') app.stop();
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { h, start: { ...c }, p0: p, s0: [e.clientX, e.clientY], pan0: [this.panX, this.panY] };
    this.canvas.style.cursor = this.cursor(h, c);
  }

  private move(e: PointerEvent) {
    const app = this.app;
    const p = this.toDisplay(e);
    if (!this.drag) {
      this.hover = this.hit(p);
      this.canvas.style.cursor = app.media ? this.cursor(this.hover, app.activeCrop()) : 'default';
      return;
    }
    const { h, start, p0, s0, pan0 } = this.drag;
    const dpr = devicePixelRatio || 1;
    if (h.kind === 'pan') {
      this.panX = pan0[0] + (e.clientX - s0[0]) * dpr;
      this.panY = pan0[1] + (e.clientY - s0[1]) * dpr;
      app.invalidate();
      return;
    }
    if (h.kind === 'draw' && Math.hypot(e.clientX - s0[0], e.clientY - s0[1]) < 4) return;
    app.setCrop(this.apply(h, start, p0, p, e), false);
  }

  private up(e: PointerEvent) {
    if (!this.drag) return;
    const moved = Math.hypot(e.clientX - this.drag.s0[0], e.clientY - this.drag.s0[1]) >= 4;
    const kind = this.drag.h.kind;
    this.drag = null;
    if (kind !== 'pan' && moved) this.app.store.commit();
    this.canvas.style.cursor = this.cursor(this.hit(this.toDisplay(e)), this.app.activeCrop());
  }

  private apply(h: Handle, c: Crop, p0: [number, number], p: [number, number], e: PointerEvent): Crop {
    const app = this.app;
    const aspect = app.cropAspect();
    if (h.kind === 'move') return { ...c, x: c.x + p[0] - p0[0], y: c.y + p[1] - p0[1] };
    if (h.kind === 'rotate') {
      const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
      let r = Math.atan2(p[1] - cy, p[0] - cx) * 180 / Math.PI + 90;
      if (e.shiftKey) r = Math.round(r / 15) * 15;
      return { ...c, r };
    }
    if (h.kind === 'draw') {
      let x0 = Math.min(p0[0], p[0]), y0 = Math.min(p0[1], p[1]);
      let w = Math.abs(p[0] - p0[0]), hgt = Math.abs(p[1] - p0[1]);
      if (aspect) {
        if (w / hgt > aspect) hgt = w / aspect; else w = hgt * aspect;
        x0 = p[0] < p0[0] ? p0[0] - w : p0[0];
        y0 = p[1] < p0[1] ? p0[1] - hgt : p0[1];
      }
      return { x: x0, y: y0, w, h: hgt, r: 0 };
    }
    if (h.kind !== 'resize') return c;
    return resizeCrop(c, h.sx, h.sy, p, aspect, e.altKey, app.media!.W, app.media!.H);
  }

  private wheel(e: WheelEvent) {
    if (!this.app.media) return;
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    const mx = (e.clientX - r.left) * dpr - this.canvas.width / 2, my = (e.clientY - r.top) * dpr - this.canvas.height / 2;
    const z = Math.max(0.25, Math.min(32, this.zoom * Math.exp(-e.deltaY * 0.0015)));
    const k = z / this.zoom;
    this.panX = mx - (mx - this.panX) * k;
    this.panY = my - (my - this.panY) * k;
    this.zoom = z;
    this.app.invalidate();
  }

  draw() {
    const { ctx, canvas, app } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--viewer-bg') || '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.updateChip();
    const m = app.media;
    if (!m) return;
    const src = m.tb.src(app.playhead);
    const exact = m.frames.get(src);
    const bmp = exact ?? m.frames.nearest(src, 600);
    const view = this.view();
    ctx.setTransform(view);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, m.W, m.H);
    if (bmp) {
      ctx.setTransform(view.multiply(rawToDisplay(m.orient)));
      ctx.imageSmoothingEnabled = view.a < 2;
      // Cheaper scaling while playing; a paused frame gets the best filter.
      ctx.imageSmoothingQuality = app.play ? 'low' : 'high';
      ctx.drawImage(bmp, 0, 0);
    }
    ctx.setTransform(view);
    const c = app.activeCrop();
    if (c) this.drawCrop(c, view.a);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!exact) {
      const dpr = devicePixelRatio || 1;
      ctx.font = `500 ${12 * dpr}px ${FONT}`;
      const t = m.frames.isMissing(src) ? 'Frame missing in source' : 'Decoding…';
      const tw = ctx.measureText(t).width;
      const bw = tw + 20 * dpr, bh = 24 * dpr, bx = canvas.width - bw - 12 * dpr, by = 12 * dpr;
      ctx.fillStyle = 'rgba(17,19,23,.82)';
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, bh / 2);
      ctx.fill();
      ctx.fillStyle = '#e7e9ed';
      ctx.textBaseline = 'middle';
      ctx.fillText(t, bx + 10 * dpr, by + bh / 2 + 0.5 * dpr);
      ctx.textBaseline = 'alphabetic';
    }
  }

  private drawCrop(c: Crop, s: number) {
    const { ctx, app } = this;
    const m = app.media!;
    const dpr = devicePixelRatio || 1;
    const px = dpr / s;
    const pts = cropCorners(c);
    const w = app.selected;
    const outside = !!w && (app.playhead < w.start || app.playhead >= w.start + w.len);
    // Dim everything outside the crop.
    ctx.beginPath();
    ctx.rect(-m.W * 4, -m.H * 4, m.W * 9, m.H * 9);
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 3; i >= 1; i--) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill('evenodd');
    const color = w ? app.track(w.track)?.color ?? '#5b8cff' : '#c4c8d0';
    // Thirds.
    ctx.save();
    ctx.translate(c.x + c.w / 2, c.y + c.h / 2);
    ctx.rotate(c.r * Math.PI / 180);
    ctx.lineWidth = px;
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.beginPath();
    for (const t of [-1 / 6, 1 / 6]) {
      ctx.moveTo(t * c.w, -c.h / 2); ctx.lineTo(t * c.w, c.h / 2);
      ctx.moveTo(-c.w / 2, t * c.h); ctx.lineTo(c.w / 2, t * c.h);
    }
    ctx.stroke();
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = color;
    if (outside) ctx.setLineDash([6 * px, 4 * px]);
    ctx.strokeRect(-c.w / 2, -c.h / 2, c.w, c.h);
    ctx.setLineDash([]);
    // The part that reaches the output, when the side multiples or output shape trim the crop.
    const track = w ? app.track(w.track)! : app.currentTrack;
    const c0 = w ? cropAt(w, 0) : c;
    const reg = outputRegion(c, c0, track);
    const trimmed = Math.abs(reg.w - c.w) > 0.05 || Math.abs(reg.h - c.h) > 0.05;
    if (trimmed) {
      // Only an unrotated region sits off-centre (on whole pixels), so the offset is along the crop's axes.
      const lx = reg.x + reg.w / 2 - (c.x + c.w / 2), ly = reg.y + reg.h / 2 - (c.y + c.h / 2);
      ctx.lineWidth = px;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.setLineDash([4 * px, 3 * px]);
      ctx.strokeRect(lx - reg.w / 2, ly - reg.h / 2, reg.w, reg.h);
      ctx.setLineDash([]);
      ctx.strokeStyle = color;
    }
    // Handles.
    const hs = HANDLE * px;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * px;
    for (const [sx, sy] of [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]) {
      const big = sx && sy;
      const r = big ? hs : hs * 0.75;
      ctx.beginPath();
      ctx.rect(sx * c.w / 2 - r / 2, sy * c.h / 2 - r / 2, r, r);
      ctx.fill();
      ctx.stroke();
    }
    const ry = -c.h / 2 - ROT_OFFSET * px;
    ctx.beginPath();
    ctx.moveTo(0, -c.h / 2);
    ctx.lineTo(0, ry);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, ry, hs * 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // Label.
    const out = outputSizeFor(c0, track);
    const label = `${fmt(c.w)} × ${fmt(c.h)}${trimmed || out.w !== Math.round(c.w) || out.h !== Math.round(c.h) ? `  →  ${out.w} × ${out.h}` : ''}${c.r ? `  ·  ${fmt(c.r)}°` : ''}`;
    ctx.font = `500 ${11.5 * px}px ${FONT}`;
    const tw = ctx.measureText(label).width;
    const top = pts.reduce((a, b) => (b[1] < a[1] ? b : a));
    const inv = this.view().inverse();
    const viewTL = inv.transformPoint(new DOMPoint(0, 0)), viewBR = inv.transformPoint(new DOMPoint(this.canvas.width, this.canvas.height));
    const lx = Math.max(viewTL.x + 10 * px, Math.min(viewBR.x - tw - 10 * px, top[0] - tw / 2));
    let ly = top[1] - 34 * px - ROT_OFFSET * px * 0.2;
    // No room above (crop at the top of the view): put it just inside the crop instead.
    const viewTop = viewTL.y;
    if (ly - 13 * px < viewTop) ly = top[1] + 22 * px;
    ctx.fillStyle = 'rgba(17,19,23,0.82)';
    ctx.beginPath();
    ctx.roundRect(lx - 8 * px, ly - 14 * px, tw + 16 * px, 20 * px, 10 * px);
    ctx.fill();
    ctx.fillStyle = '#e7e9ed';
    ctx.fillText(label, lx, ly);
  }
}

const FONT = getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || 'system-ui, sans-serif';

const fmt = (v: number) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));

/**
 * Drag a corner (sx, sy both ±1) or side (one of them 0) of a possibly rotated crop.
 * The opposite corner or side stays put, or the centre with `fromCenter`.
 */
export function resizeCrop(c: Crop, sx: -1 | 0 | 1, sy: -1 | 0 | 1, p: [number, number], aspect: number | null,
  fromCenter: boolean, frameW: number, frameH: number): Crop {
  const a = c.r * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
  const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
  const toWorld = (lx: number, ly: number): [number, number] => [cx + co * lx - si * ly, cy + si * lx + co * ly];
  // Fixed point in crop-local coordinates.
  const fx = fromCenter ? 0 : -sx * c.w / 2, fy = fromCenter ? 0 : -sy * c.h / 2;
  const dx0 = p[0] - cx, dy0 = p[1] - cy;
  const lx = co * dx0 + si * dy0, ly = -si * dx0 + co * dy0;
  const k = fromCenter ? 2 : 1;
  let w = sx ? Math.max(4, (lx - fx) * sx * k) : c.w;
  let h = sy ? Math.max(4, (ly - fy) * sy * k) : c.h;
  if (!c.r) {
    // Unrotated: keep the moving edges inside the frame.
    const fwx = cx + fx, fwy = cy + fy;
    if (sx) w = Math.min(w, fromCenter ? 2 * Math.min(fwx, frameW - fwx) : sx > 0 ? frameW - fwx : fwx);
    if (sy) h = Math.min(h, fromCenter ? 2 * Math.min(fwy, frameH - fwy) : sy > 0 ? frameH - fwy : fwy);
  }
  if (aspect) {
    if (sx && sy) { if (w / h > aspect) h = w / aspect; else w = h * aspect; }
    else if (sx) h = w / aspect;
    else w = h * aspect;
    if (!c.r) {
      const fwx = cx + fx, fwy = cy + fy;
      const maxW = !sx ? Math.min(frameW, 2 * Math.min(fwx, frameW - fwx)) : fromCenter ? 2 * Math.min(fwx, frameW - fwx) : sx > 0 ? frameW - fwx : fwx;
      const maxH = !sy ? Math.min(frameH, 2 * Math.min(fwy, frameH - fwy)) : fromCenter ? 2 * Math.min(fwy, frameH - fwy) : sy > 0 ? frameH - fwy : fwy;
      const f = Math.min(1, maxW / w, maxH / h);
      w *= f; h *= f;
    }
  }
  if (!aspect && !c.r) {
    // Whole pixels here rather than later so the fixed side does not shift; never past the clamp above.
    if (sx) w = Math.max(2, Math.floor(w + 1e-6));
    if (sy) h = Math.max(2, Math.floor(h + 1e-6));
  }
  const ncx = fromCenter ? 0 : fx + sx * w / 2, ncy = fromCenter ? 0 : fy + sy * h / 2;
  const [wx, wy] = toWorld(sx ? ncx : 0, sy ? ncy : 0);
  return { x: wx - w / 2, y: wy - h / 2, w, h, r: c.r };
}
