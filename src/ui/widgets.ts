import { icon } from './icons';

// --------------------------------------------------------------- tooltips

/**
 * One shared tooltip. Any element with `data-tip` gets it on hover (after a short delay,
 * instantly while another tip was just showing) and on keyboard focus. `data-kbd` adds a
 * shortcut hint, written like "Ctrl+Z" or "← →".
 */
class Tooltip {
  private el = document.createElement('div');
  private timer = 0;
  private warmUntil = 0;
  private target: Element | null = null;

  constructor() {
    this.el.className = 'tooltip';
    this.el.setAttribute('role', 'tooltip');
    document.body.append(this.el);
    document.addEventListener('pointerover', e => {
      if (e.pointerType === 'touch') return;
      const t = (e.target as Element).closest?.('[data-tip]');
      if (t === this.target) return;
      if (!t) { this.hide(); return; }
      this.schedule(() => this.showFor(t));
    });
    document.addEventListener('focusin', e => {
      const t = (e.target as Element).closest?.('[data-tip]');
      if (t && (e.target as Element).matches(':focus-visible')) this.showFor(t);
    });
    document.addEventListener('focusout', () => this.hide());
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'scroll'] as const) {
      document.addEventListener(ev, () => this.hide(true), { capture: true, passive: true });
    }
  }

  private schedule(fn: () => void) {
    clearTimeout(this.timer);
    if (performance.now() < this.warmUntil) fn();
    else this.timer = window.setTimeout(fn, 500);
  }

  private showFor(t: Element) {
    const text = t.getAttribute('data-tip');
    if (!text) return;
    this.target = t;
    this.render(text, t.getAttribute('data-kbd'));
    const r = t.getBoundingClientRect();
    const place = t.getAttribute('data-tip-pos') ?? (r.top > 60 ? 'top' : 'bottom');
    this.position(r.left + r.width / 2, place === 'top' ? r.top : r.bottom, place === 'top');
  }

  /** Show text at a point (for canvas hit regions), after the usual delay. */
  at(x: number, y: number, text: string) {
    if (this.el.dataset.text === text && this.el.classList.contains('on')) { this.position(x, y - 10, true); return; }
    this.target = null;
    this.schedule(() => { this.render(text, null); this.position(x, y - 10, true); });
  }

  private render(text: string, kbd: string | null) {
    this.el.dataset.text = text;
    this.el.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = text;
    this.el.append(span);
    if (kbd) this.el.insertAdjacentHTML('beforeend', kbdHtml(kbd));
  }

  private position(x: number, y: number, above: boolean) {
    const el = this.el;
    el.classList.add('on');
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.max(8, Math.min(innerWidth - w - 8, x - w / 2));
    const top = above ? y - h - 8 : y + 8;
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(8, Math.min(innerHeight - h - 8, top)))}px)`;
  }

  hide(cool = false) {
    clearTimeout(this.timer);
    if (this.el.classList.contains('on') && !cool) this.warmUntil = performance.now() + 400;
    if (cool) this.warmUntil = 0;
    this.el.classList.remove('on');
    this.target = null;
  }
}

export function kbdHtml(spec: string) {
  return `<span class="kbds">${spec.split(' ').map(chord => chord.split('+').map(k => `<kbd>${escapeHtml(k)}</kbd>`).join('')).join('<span class="kbd-or">/</span>')}</span>`;
}

export const tip = new Tooltip();

// ------------------------------------------------------------------ menus

/**
 * A trigger with `data-menu="id"` toggles the popover `#id`, placed under it.
 * Arrow keys move between items; choosing one closes the menu.
 */
export function initMenus() {
  document.addEventListener('click', e => {
    const trigger = (e.target as Element).closest<HTMLElement>('[data-menu]');
    if (trigger) {
      const menu = document.getElementById(trigger.dataset.menu!)!;
      if (menu.matches(':popover-open')) { menu.hidePopover(); return; }
      menu.showPopover();
      placeUnder(menu, trigger);
      trigger.setAttribute('aria-expanded', 'true');
      menu.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)')?.focus();
      return;
    }
    const item = (e.target as Element).closest('[role=menuitem]');
    if (item) item.closest<HTMLElement>('[popover]')?.hidePopover();
  });
  document.querySelectorAll<HTMLElement>('.menu[popover]').forEach(menu => {
    menu.addEventListener('toggle', ev => {
      if ((ev as ToggleEvent).newState === 'closed') document.querySelector(`[data-menu="${menu.id}"]`)?.setAttribute('aria-expanded', 'false');
    });
    menu.addEventListener('keydown', e => {
      const items = [...menu.querySelectorAll<HTMLElement>('[role=menuitem]:not(:disabled)')];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        items[e.key === 'Home' ? 0 : items.length - 1]?.focus();
      } else if (e.key === 'Tab') menu.hidePopover();
    });
  });
}

function placeUnder(pop: HTMLElement, anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const alignRight = r.left + w > innerWidth - 8;
  pop.style.left = `${Math.max(8, alignRight ? r.right - w : r.left)}px`;
  pop.style.top = `${r.bottom + 6}px`;
}

// ---------------------------------------------------------- scrub fields

/**
 * Dragging the label of a `.field` changes its number input: live `input` events while
 * dragging and one `change` at the end. Shift moves 10× faster, Alt 10× finer.
 * A click without a drag focuses the input.
 */
export function initScrub(root: HTMLElement) {
  root.addEventListener('pointerdown', e => {
    const label = (e.target as Element).closest<HTMLElement>('.scrub');
    if (!label || e.button !== 0) return;
    const input = label.closest('.field, .stack')?.querySelector<HTMLInputElement>('input[type=number]');
    if (!input || input.disabled) return;
    e.preventDefault();
    label.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const v0 = Number(input.value) || 0;
    const step = Number(input.step) || 1;
    const min = input.min === '' ? -Infinity : Number(input.min);
    const max = input.max === '' ? Infinity : Number(input.max);
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      document.body.classList.add('scrubbing');
      const k = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      const raw = v0 + Math.round(dx / 2) * step * k;
      const v = Math.max(min, Math.min(max, Math.round(raw / (step * k)) * step * k));
      const s = String(Math.round(v * 1000) / 1000);
      if (input.value !== s) { input.value = s; input.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    label.addEventListener('pointermove', move);
    label.addEventListener('lostpointercapture', () => {
      label.removeEventListener('pointermove', move);
      document.body.classList.remove('scrubbing');
      if (moved) {
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // The click that ends a drag on a <label> would focus its input.
        const eat = (ev: Event) => ev.preventDefault();
        window.addEventListener('click', eat, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 0);
      } else { input.focus(); input.select(); }
    }, { once: true });
  });
}

// ----------------------------------------------------------------- toasts

export interface ToastOptions {
  kind?: 'info' | 'error' | 'success';
  action?: { label: string; run: () => void };
}

export function showToast(host: HTMLElement, msg: string, opts: ToastOptions = {}) {
  const kind = opts.kind ?? 'info';
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = icon(kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'info', 16);
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = msg;
  el.append(text);
  const close = () => { el.classList.add('gone'); setTimeout(() => el.remove(), 250); };
  if (opts.action) {
    const b = document.createElement('button');
    b.className = 'btn ghost sm';
    b.textContent = opts.action.label;
    b.onclick = () => { opts.action!.run(); close(); };
    el.append(b);
  }
  const x = document.createElement('button');
  x.className = 'btn icon sm ghost';
  x.setAttribute('aria-label', 'Dismiss');
  x.innerHTML = icon('x', 14);
  x.onclick = close;
  el.append(x);
  host.append(el);
  // Keep the newest few.
  while (host.children.length > 4) host.firstElementChild!.remove();
  let timer = window.setTimeout(close, kind === 'error' ? 7000 : opts.action ? 6000 : 3500);
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', () => { timer = window.setTimeout(close, 2500); });
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}
