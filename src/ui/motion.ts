const reduce = matchMedia('(prefers-reduced-motion: reduce)');

export const reducedMotion = () => reduce.matches;

/** Fast start, long soft landing: for anything that answers a user action. */
export const easeOut = (t: number) => 1 - (1 - t) ** 4;

/**
 * A value animation driven from a draw loop: call `step()` each frame and keep
 * redrawing while it returns true. Finishes at once when motion is reduced.
 */
export class Tween {
  private t0 = performance.now();
  constructor(private dur: number, private apply: (k: number) => void) {}

  step() {
    const t = reducedMotion() ? 1 : Math.min(1, (performance.now() - this.t0) / this.dur);
    this.apply(easeOut(t));
    return t < 1;
  }
}

export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/**
 * Interpolate a 1-D camera from (left edge `a0`, span `s0`) to (`a1`, `s1`) so the
 * scale changes geometrically around the one point that stays put, the way a real
 * zoom looks. Falls back to a plain pan when the span barely changes.
 */
export function zoomPath(a0: number, s0: number, a1: number, s1: number) {
  const r = s1 / s0;
  if (Math.abs(1 - r) < 1e-3) return (k: number) => ({ left: lerp(a0, a1, k), span: lerp(s0, s1, k) });
  const fixed = (a1 - a0 * r) / (1 - r);
  return (k: number) => {
    const span = s0 * r ** k;
    return { left: fixed - (fixed - a0) * (span / s0), span };
  };
}

/** Play the standard enter motion on `el`; `dx`/`dy` give where it slides in from. */
export function enter(el: HTMLElement, dx = 0, dy = 0, dur = 220) {
  if (reducedMotion()) return;
  el.animate(
    [{ opacity: 0, transform: `translate(${dx}px, ${dy}px)` }, { opacity: 1, transform: 'none' }],
    { duration: dur, easing: 'cubic-bezier(.16, 1, .3, 1)' },
  );
}
