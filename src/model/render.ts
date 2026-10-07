import type { Rotation } from '../media/demux';
import type { Crop } from './project';

export interface Orientation { rawW: number; rawH: number; rotation: Rotation; flip: boolean }

/** Maps raw decoded pixels to display-oriented pixels. */
export function rawToDisplay(o: Orientation): DOMMatrix {
  const { rawW, rawH, rotation, flip } = o;
  let m: DOMMatrix;
  switch (rotation) {
    case 90: m = new DOMMatrix([0, 1, -1, 0, rawH, 0]); break;
    case 180: m = new DOMMatrix([-1, 0, 0, -1, rawW, rawH]); break;
    case 270: m = new DOMMatrix([0, -1, 1, 0, 0, rawW]); break;
    default: m = new DOMMatrix();
  }
  if (flip) {
    const dispW = rotation % 180 ? rawH : rawW;
    m = new DOMMatrix([-1, 0, 0, 1, dispW, 0]).multiply(m);
  }
  return m;
}

/** Maps display pixels to output pixels of an ow × oh frame for the crop. */
export function displayToOutput(c: Crop, ow: number, oh: number): DOMMatrix {
  return new DOMMatrix()
    .translate(ow / 2, oh / 2)
    .scale(ow / c.w, oh / c.h)
    .rotate(-c.r)
    .translate(-(c.x + c.w / 2), -(c.y + c.h / 2));
}

/**
 * Renders one output frame. Preview and export both call this, on frames copied the
 * same way, so what the preview shows is what gets encoded.
 */
export function renderOutput(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  frame: CanvasImageSource,
  o: Orientation,
  crop: Crop,
  ow: number,
  oh: number,
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, ow, oh);
  const m = displayToOutput(crop, ow, oh).multiply(rawToDisplay(o));
  ctx.setTransform(m);
  // An unscaled, unrotated crop on whole pixels is a straight copy.
  const exact = !crop.r && Math.abs(ow - crop.w) < 1e-6 && Math.abs(oh - crop.h) < 1e-6;
  ctx.imageSmoothingEnabled = !exact;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(frame, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Corners of a crop in display pixels: top-left, top-right, bottom-right, bottom-left. */
export function cropCorners(c: Crop): [number, number][] {
  const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
  const a = c.r * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => {
    const lx = sx * c.w / 2, ly = sy * c.h / 2;
    return [cx + co * lx - si * ly, cy + si * lx + co * ly];
  });
}
