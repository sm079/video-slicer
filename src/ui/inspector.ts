import type { App } from '../app';
import {
  cropAt, outputRegion, outputSize, outputSizeFor, snapLen, minLen, ruleText, RULE_PRESETS, COLORS, fullCrop,
  presetFrom, presetMatches, presetText, type Crop,
} from '../model/project';
import { formatFps, parseFps } from '../media/timebase';
import { renderOutput } from '../model/render';
import { timecode } from './timeline';
import { icon } from './icons';
import { escapeHtml as esc, initScrub } from './widgets';
import { enter } from './motion';

type Tab = 'window' | 'track' | 'project';
const TABS: Tab[] = ['window', 'track', 'project'];
const TAB_KEY = 'vs.tab';

const r1 = (v: number) => Math.round(v * 10) / 10;

const iconBtn = (act: string, name: Parameters<typeof icon>[0], tipText: string, kbd = '', cls = '') =>
  `<button class="btn icon ghost sm ${cls}" data-act="${act}" aria-label="${esc(tipText)}" data-tip="${esc(tipText)}"${kbd ? ` data-kbd="${kbd}"` : ''}>${icon(name, 15)}</button>`;

const field = (id: string, label: string, opts: { step?: number; min?: number; placeholder?: string; tip?: string; unit?: string } = {}) =>
  `<label class="field${opts.unit ? ' has-unit' : ''}"${opts.tip ? ` data-tip="${esc(opts.tip)}"` : ''}>${label ? `<span class="scrub">${label}</span>` : ''}` +
  `<input id="${id}" type="number" step="${opts.step ?? 1}"${opts.min != null ? ` min="${opts.min}"` : ''}${opts.placeholder ? ` placeholder="${esc(opts.placeholder)}"` : ''} aria-label="${esc(opts.tip ?? label)}">` +
  `${opts.unit ? `<span class="unit">${opts.unit}</span>` : ''}</label>`;

/** Side panel: the selected window and its crop, the current track, and project settings. Rebuilt only when its shape changes. */
export class Inspector {
  private shape = '';
  private tab: Tab;
  /** The preset name field is open. */
  private saving = false;
  /** Show the a·n + b fields even when the rule matches a preset. */
  private customRule = false;
  private ink = document.createElement('span');

  constructor(private root: HTMLElement, private tabs: HTMLElement, private app: App) {
    let saved: string | null = null;
    try { saved = localStorage.getItem(TAB_KEY); } catch { /* blocked */ }
    this.tab = saved === 'track' || saved === 'project' ? saved : 'window';
    app.onUi(() => this.update());
    root.addEventListener('change', e => this.onChange(e.target as HTMLInputElement, true));
    root.addEventListener('input', e => this.onInput(e.target as HTMLInputElement));
    root.addEventListener('click', e => this.onClick(e));
    root.addEventListener('keydown', e => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'p-name' && (e.key === 'Enter' || e.key === 'Escape')) {
        e.preventDefault();
        if (e.key === 'Enter') this.savePreset(); else this.closeSave();
        return;
      }
      if (e.key === 'Enter' && t.tagName === 'INPUT') t.blur();
      if (e.key === 'Escape' && t.tagName === 'INPUT') { this.shape = ''; t.blur(); this.update(); }
    });
    initScrub(root);
    this.ink.className = 'tab-ink';
    tabs.append(this.ink);
    new ResizeObserver(() => this.placeInk(false)).observe(tabs);
    tabs.addEventListener('click', e => {
      const b = (e.target as Element).closest<HTMLElement>('[data-tab]');
      if (b) this.show(b.dataset.tab as Tab);
    });
    tabs.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const next = TABS[(TABS.indexOf(this.tab) + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
      this.show(next);
      tabs.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
    });
  }

  show(tab: Tab) {
    const dir = Math.sign(TABS.indexOf(tab) - TABS.indexOf(this.tab));
    this.tab = tab;
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* blocked */ }
    this.update();
    // The new panel comes in from the side of the tab that was picked.
    if (dir) enter(this.root, dir * 14);
  }

  /** Slide the underline to the selected tab; jump there when `glide` is off (first show, resize). */
  private placeInk(glide: boolean) {
    const b = this.tabs.querySelector<HTMLElement>('[aria-selected=true]');
    if (!b?.offsetWidth) return;
    this.tabs.classList.toggle('ink-live', glide);
    this.ink.style.transform = `translateX(${b.offsetLeft + 10}px)`;
    this.ink.style.width = `${b.offsetWidth - 20}px`;
  }

  private shapeKey() {
    const a = this.app, w = a.selected, t = a.currentTrack;
    const common = [this.tab, a.media?.hash];
    const g = a.group(w?.id);
    if (this.tab === 'window') return [...common, a.picked.join(), g?.wins.join(), g && a.data.groups.indexOf(g), w?.id, w?.track, w?.animate, w?.keys.map(k => k.f).join(), t.id, t.color, t.rule.a, t.rule.b, a.data.tracks.map(t => t.id + t.name).join()].join('|');
    if (this.tab === 'track') return [...common, t.id, t.color, t.rule.a, t.rule.b, a.presets.map(p => p.name).join('\n'), this.saving, this.customRule, RULE_PRESETS.findIndex(p => sameRule(p.rule, t.rule))].join('|');
    return [...common, !!a.media?.demux.audio].join('|');
  }

  update() {
    this.tabs.querySelectorAll<HTMLElement>('[data-tab]').forEach(b => {
      const on = b.dataset.tab === this.tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    this.placeInk(true);
    const key = this.shapeKey();
    if (key !== this.shape) {
      this.shape = key;
      const scroll = this.root.scrollTop;
      this.build();
      this.root.scrollTop = scroll;
    }
    this.fill();
  }

  // ------------------------------------------------------------------ build

  private build() {
    const a = this.app;
    if (!a.media) { this.root.innerHTML = ''; return; }
    this.root.innerHTML = this.tab === 'window' ? this.windowTab() : this.tab === 'track' ? this.trackTab() : this.projectTab();
  }

  /** Combine the picked windows, or show the selected window's group. */
  private combineSection() {
    const a = this.app, n = a.picked.length, g = a.group(a.selWin);
    const sameGroup = !!g && n > 1 && a.picked.every(id => g.wins.includes(id));
    if (n > 1 && !sameGroup) {
      return `
      <section class="group">
        <div class="empty-note">${icon('layers', 15)}<span>${n} windows selected. Combined, they play and export as one clip, in the order picked.</span></div>
        <button class="btn block" data-act="combine" data-kbd="G">${icon('layers', 15)}<span>Combine ${n} windows</span></button>
      </section>`;
    }
    if (!g) return '';
    const order = g.wins.map((id, i) => {
      const w = a.win(id)!;
      return `<span class="${id === a.selWin ? 'here' : ''}">${i + 1}. ${w.start}–${w.start + w.len - 1}</span>`;
    }).join(' → ');
    return `
      <section class="group">
        <div class="group-head">
          <h3>${icon('layers', 15)}<span>Group ${a.data.groups.indexOf(g) + 1}</span><span class="meta">part ${g.wins.indexOf(a.selWin!) + 1} of ${g.wins.length}</span></h3>
          <div class="actions">${iconBtn('uncombine', 'x', 'Uncombine', 'Shift+G')}</div>
        </div>
        <div class="times">${order}</div>
      </section>`;
  }

  private windowTab() {
    const a = this.app, w = a.selected, t = a.currentTrack;
    let html = '';
    if (w) {
      html += `
      <section class="group">
        <div class="group-head">
          <h3><span class="swatch" style="background:${t.color}"></span><span id="win-n">Window</span></h3>
          <div class="actions">
            ${iconBtn('loop', 'loop', 'Loop window', 'L')}
            ${iconBtn('dup', 'copy', 'Duplicate', 'Ctrl+D')}
            ${iconBtn('del', 'trash', 'Delete', 'Del', 'danger')}
          </div>
        </div>
        <div class="row"><span class="lbl">Track</span><select id="win-track" aria-label="Track">${a.data.tracks.map(tr => `<option value="${tr.id}" ${tr.id === w.track ? 'selected' : ''}>${esc(tr.name)}</option>`).join('')}</select></div>
        <div class="cols c3">
          <label class="stack"><span class="lbl scrub" data-tip="First frame" data-kbd="I">Start</span><input id="win-start" type="number" min="0" step="1"></label>
          <label class="stack"><span class="lbl scrub" id="win-len-lbl">Length</span><input id="win-len" type="number" min="${minLen(t.rule)}" step="${Math.max(1, t.rule.a)}"></label>
          <label class="stack"><span class="lbl scrub" data-tip="Last frame" data-kbd="O">End</span><input id="win-end" type="number" min="0" step="1"></label>
        </div>
        <div class="times" id="win-times"></div>
      </section>`;
      html += this.combineSection();
    } else {
      html += `
      <section class="group">
        <div class="empty-note">${icon('info', 15)}<span>No window selected</span></div>
        <button class="btn block" data-act="new" data-tip="Or drag on a track" data-kbd="N">${icon('plus', 15)}<span>New window at playhead</span></button>
      </section>`;
    }
    html += `
      <section class="group">
        <div class="group-head">
          <h3>${w ? 'Crop' : '<span data-tip="Applied to new windows">Default crop</span>'}<span class="meta" id="crop-where"></span></h3>
        </div>
        <div class="cols c2">
          ${field('c-x', 'X')}${field('c-y', 'Y')}
          ${field('c-w', 'W', { min: 2 })}${field('c-h', 'H', { min: 2 })}
        </div>
        <div class="cols c2">
          ${field('c-r', '°', { step: 0.5, tip: 'Rotation' })}
          <div class="toolbar">
            ${iconBtn('rot-', 'rotL', 'Rotate −90°')}
            ${iconBtn('rot+', 'rotR', 'Rotate +90°')}
            ${iconBtn('full', 'full', 'Fill frame')}
            ${iconBtn('center', 'center', 'Center')}
          </div>
        </div>
        <div class="toolbar">
          <span class="meta" id="crop-out"></span>
          <span class="spacer"></span>
          ${w ? iconBtn('t-apply', 'layers', 'Use this crop for every window on the track') + iconBtn('reset-win', 'reset', 'Reset crop') : ''}
        </div>
      </section>`;
    if (w) {
      html += `
      <section class="group">
        <div class="group-head">
          <h3>Keyframes${w.animate ? `<span class="meta">${w.keys.length}</span>` : ''}</h3>
          <div class="actions">
            <label class="switch" data-tip="Animate the crop over time"><input type="checkbox" id="animate" ${w.animate ? 'checked' : ''} aria-label="Animate crop"><span class="track"></span></label>
          </div>
        </div>
        ${w.animate ? `
        <div class="keys">${w.keys.map(k => `<span class="keychip" data-f="${k.f}"><button data-act="jump" data-f="${k.f}" data-tip="Go to key">${icon('keyFill', 11)}${k.f}</button><button data-act="unkey" data-f="${k.f}" aria-label="Remove key" ${w.keys.length < 2 ? 'disabled' : ''}>${icon('x', 12)}</button></span>`).join('')}</div>
        <div class="toolbar">
          ${iconBtn('key-prev', 'prev', 'Previous key', '[')}
          <button class="btn sm" data-act="key" id="key-btn" data-kbd="K">${icon('key', 13)}<span>Add key</span></button>
          ${iconBtn('key-next', 'next', 'Next key', ']')}
        </div>` : ''}
      </section>`;
    }
    return html;
  }

  private trackTab() {
    const a = this.app, t = a.currentTrack;
    const preset = this.customRule ? -1 : RULE_PRESETS.findIndex(p => sameRule(p.rule, t.rule));
    return `
      <section class="group">
        <div class="group-head">
          <h3><span class="swatch" style="background:${t.color}"></span>${esc(t.name)}</h3>
          <div class="actions">${iconBtn('t-del', 'trash', 'Delete track', '', 'danger')}</div>
        </div>
        <div class="row"><span class="lbl">Name</span><input id="t-name" type="text" spellcheck="false" aria-label="Track name"></div>
        <div class="row"><span class="lbl">Color</span><div class="colors" role="radiogroup" aria-label="Track color">${COLORS.map(c => `<button data-act="color" data-c="${c}" role="radio" aria-checked="${c === t.color}" aria-label="Color ${c}" class="color ${c === t.color ? 'on' : ''}" style="background:${c};color:${c}"></button>`).join('')}</div></div>
      </section>
      <section class="group">
        <div class="group-head"><h3>Preset</h3></div>
        ${this.saving ? `
        <div class="inline-form">
          <input id="p-name" type="text" spellcheck="false" placeholder="Preset name" aria-label="Preset name">
          <button class="btn primary" data-act="p-ok">Save</button>
          <button class="btn icon ghost" data-act="p-cancel" aria-label="Cancel" data-tip="Cancel">${icon('x', 15)}</button>
        </div>` : `
        <div class="inline-form">
          <select id="preset" aria-label="Preset" data-tip="Sets frame rate, size and length rules"><option value="">Custom</option>${a.presets.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('')}</select>
          <button class="btn icon" data-act="p-save" aria-label="Save as preset" data-tip="Save current settings as preset">${icon('bookmark', 15)}</button>
          <button class="btn icon danger" data-act="p-del" aria-label="Delete preset" data-tip="Delete preset">${icon('trash', 15)}</button>
        </div>`}
      </section>
      <section class="group">
        <div class="group-head"><h3>Output size</h3></div>
        <div class="cols c3">
          ${field('t-ow', 'W', { min: 0, placeholder: 'Auto', tip: 'Width · blank follows the crop' })}
          ${field('t-oh', 'H', { min: 0, placeholder: 'Auto', tip: 'Height · blank follows the crop' })}
          ${field('t-div', '÷', { min: 1, tip: 'Sides snap to a multiple of this (H.264 needs 2)' })}
        </div>
      </section>
      <section class="group">
        <div class="group-head"><h3>Length</h3></div>
        <div class="row"><span class="lbl">Rule</span><select id="t-preset" aria-label="Length rule">${RULE_PRESETS.map((p, i) => `<option value="${i}" ${i === preset ? 'selected' : ''}>${p.label}</option>`).join('')}<option value="-1" ${preset < 0 ? 'selected' : ''}>Custom…</option></select></div>
        ${preset < 0 ? `<div class="row"><span class="lbl"></span><div class="rule-ctl"><input id="t-a" type="number" min="1" step="1" aria-label="Step a"><span>n +</span><input id="t-b" type="number" step="1" aria-label="Offset b"></div></div>` : ''}
        <div class="row"><span class="lbl">Default</span>${field('t-def', '#', { min: minLen(t.rule), step: Math.max(1, t.rule.a), tip: 'Length of new windows', unit: 'frames' })}</div>
      </section>`;
  }

  private projectTab() {
    const a = this.app, m = a.media!;
    const info = m.demux.info;
    const au = m.demux.audio?.info;
    return `
      <section class="group">
        <div class="group-head"><h3>Frame rate</h3></div>
        <div class="row">
          <span class="lbl">Output fps</span>
          <div class="ctl">
            <input id="fps" type="text" spellcheck="false" placeholder="Native · ${esc(formatFps(m.sourceFps))}" aria-label="Output fps" data-tip="Blank keeps every source frame. A rate resamples like ffmpeg's fps filter.">
            <button class="btn icon ghost" data-act="native" id="native-btn" aria-label="Use native frame rate" data-tip="Use native frame rate">${icon('reset', 15)}</button>
          </div>
        </div>
        <div class="row"><span class="lbl"></span><span class="meta" id="fps-note"></span></div>
      </section>
      <section class="group">
        <div class="group-head"><h3>Source</h3></div>
        <dl class="kv">
          <dt>File</dt><dd title="${esc(info.fileName)}">${esc(info.fileName)}</dd>
          <dt>Resolution</dt><dd>${info.width} × ${info.height}${info.rotation ? ` · ${info.rotation}°` : ''}</dd>
          <dt>Frames</dt><dd>${(m.demux.index.count - m.demux.index.first).toLocaleString()} · ${esc(formatFps(m.sourceFps))} fps</dd>
          <dt>Video</dt><dd>${esc(info.codec)} · ${esc(info.container)}</dd>
          <dt>Audio</dt><dd>${au ? `${esc(au.codec)} · ${(au.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz · ${au.channels} ch` : 'None'}</dd>
          <dt>Color</dt><dd title="${esc(info.color)}">${esc(info.color)}</dd>
          <dt>Size</dt><dd>${(m.file.size / 1048576).toFixed(1)} MB</dd>
        </dl>
      </section>
      <section class="group">
        <div class="group-head"><h3>Decoding</h3></div>
        <div class="row"><span class="lbl">Frame cache</span>${field('cache', '', { min: 256, step: 256, unit: 'MB', tip: 'Memory for decoded frames. Loops that fit play without re-decoding.' })}</div>
        <div class="row"><span class="lbl"></span><span class="meta" id="cache-note"></span></div>
        <div class="row"><span class="lbl">Untagged color</span><select id="untagged" aria-label="Color matrix for untagged video" data-tip="Color matrix for video that doesn't declare one"><option value="bt601">BT.601 · like ffmpeg</option><option value="bt709">BT.709</option></select></div>
      </section>`;
  }

  // ------------------------------------------------------------------- fill

  private set(id: string, v: string | number) {
    const el = this.root.querySelector<HTMLInputElement>(`#${id}`);
    if (!el || el === document.activeElement) return;
    const s = String(v);
    if (el.value !== s) el.value = s;
  }

  private text(id: string, s: string) {
    const el = this.root.querySelector(`#${id}`);
    if (el && el.textContent !== s) el.textContent = s;
  }

  private attr(sel: string, name: string, v: string | null) {
    const el = this.root.querySelector(sel);
    if (!el) return;
    if (v == null) el.removeAttribute(name);
    else if (el.getAttribute(name) !== v) el.setAttribute(name, v);
  }

  private fill() {
    const a = this.app, m = a.media;
    if (!m) return;
    const w = a.selected, t = a.currentTrack;
    if (this.tab === 'window') {
      if (w) {
        const n = a.data.windows.filter(o => o.track === w.track && o.start < w.start).length + 1;
        this.text('win-n', `Window ${n}`);
        this.set('win-start', w.start);
        this.set('win-len', w.len);
        this.set('win-end', w.start + w.len - 1);
        const secs = m.tb.time(w.start + w.len - 1) - m.tb.time(w.start) + 1 / m.tb.fps;
        this.text('win-times', `${timecode(m.tb.time(w.start))} – ${timecode(m.tb.time(w.start + w.len))} · ${secs.toFixed(2)} s`);
        this.attr('#win-len-lbl', 'data-tip', t.rule.a > 1 ? `Snaps to ${ruleText(t.rule)}` : null);
        this.root.querySelector('[data-act="loop"]')?.classList.toggle('on', a.play?.loop === w.id || !!a.play?.seq?.includes(w.id));
        const inside = a.playhead >= w.start && a.playhead < w.start + w.len;
        this.text('crop-where', w.animate ? (inside ? `frame ${a.playhead - w.start}` : 'outside window') : '');
        if (w.animate) {
          const f = a.localFrame(w);
          const here = w.keys.some(k => k.f === f);
          this.root.querySelectorAll<HTMLElement>('.keychip').forEach(el => el.classList.toggle('here', inside && Number(el.dataset.f) === f));
          const kb = this.root.querySelector<HTMLButtonElement>('#key-btn');
          if (kb) {
            const label = here ? 'Remove key' : 'Add key';
            if (kb.lastElementChild!.textContent !== label) kb.lastElementChild!.textContent = label;
            kb.disabled = here && w.keys.length < 2;
          }
        }
      }
      const c = a.activeCrop();
      if (c) {
        this.set('c-x', r1(c.x)); this.set('c-y', r1(c.y)); this.set('c-w', r1(c.w)); this.set('c-h', r1(c.h)); this.set('c-r', r1(c.r));
        const c0 = w ? cropAt(w, 0) : c;
        const out = outputSizeFor(c0, t), reg = outputRegion(c, c0, t);
        const trimmed = Math.abs(reg.w - c.w) > 0.05 || Math.abs(reg.h - c.h) > 0.05;
        this.text('crop-out', `Output ${out.w} × ${out.h}`);
        this.attr('#crop-out', 'data-tip', trimmed ? `Taken from the centre ${r1(reg.w)} × ${r1(reg.h)} (dashed frame)` : null);
      }
    } else if (this.tab === 'track') {
      this.set('t-name', t.name);
      this.set('t-a', t.rule.a);
      this.set('t-b', t.rule.b);
      this.set('t-def', t.defLen);
      this.set('t-ow', t.outW || '');
      this.set('t-oh', t.outH || '');
      this.set('t-div', t.div);
      const lo = minLen(t.rule), ex: number[] = [];
      for (let v = lo; ex.length < 4; v += Math.max(1, t.rule.a)) ex.push(v);
      this.attr('#t-preset', 'data-tip', t.rule.a <= 1 ? 'Any length' : `${ex.join(', ')}, …`);
      const match = a.presets.findIndex(p => presetMatches(p, a.data.fps, t));
      this.set('preset', match < 0 ? '' : String(match));
      this.attr('#preset', 'data-tip', presetText(match < 0 ? presetFrom('', a.data.fps, t) : a.presets[match], formatFps));
      const del = this.root.querySelector<HTMLButtonElement>('[data-act="p-del"]');
      if (del) del.disabled = match < 0;
    } else {
      this.set('fps', a.data.fps == null ? '' : String(Math.round(a.data.fps * 1e6) / 1e6));
      const native = this.root.querySelector<HTMLButtonElement>('#native-btn');
      if (native) native.hidden = a.data.fps == null;
      this.text('fps-note', `${m.tb.count.toLocaleString()} output frames`);
      this.set('cache', a.cacheMB);
      this.set('untagged', a.untaggedColor);
      this.text('cache-note', `≈ ${m.frames.capacity} frames at ${(m.frames.frameBytes / 1048576).toFixed(1)} MB each`);
    }
  }

  // ---------------------------------------------------------------- editing

  private num(el: HTMLInputElement) {
    const v = Number(el.value);
    return el.value.trim() !== '' && Number.isFinite(v) ? v : null;
  }

  /** Live crop edits while a field is scrubbed; the closing change event commits. */
  private onInput(el: HTMLInputElement) {
    if (/^c-[xywhr]$/.test(el.id) && document.activeElement !== el) this.onChange(el, false);
  }

  private onChange(el: HTMLInputElement, commit: boolean) {
    const a = this.app, m = a.media;
    if (!m) return;
    const w = a.selected, t = a.currentTrack;
    const v = this.num(el);
    const total = a.total;
    switch (el.id) {
      case 'fps': {
        const fps = el.value.trim() ? parseFps(el.value) : null;
        if (el.value.trim() && fps == null) { a.toast('Enter a frame rate like 24, 29.97 or 30000/1001.', 'error'); this.shape = ''; a.invalidate(true); return; }
        a.setFps(fps);
        return;
      }
      case 'preset': {
        const p = el.value === '' ? null : a.presets[Number(el.value)];
        if (p) a.applyPreset(p); else a.invalidate(true);
        return;
      }
      case 'win-track': {
        if (!w) return;
        const target = a.track(el.value)!;
        if (!fitsOn(a, target.id, w)) { a.toast('It would overlap a window on that track.', 'error'); this.shape = ''; a.invalidate(true); return; }
        a.moveToTrack(w, target);
        a.selTrack = target.id;
        a.store.commit();
        return;
      }
      case 'win-start': case 'win-len': case 'win-end': {
        if (!w || v == null) { a.invalidate(true); return; }
        let start = w.start, len = w.len;
        if (el.id === 'win-start') start = Math.round(v);
        if (el.id === 'win-len') len = Math.round(v);
        if (el.id === 'win-end') len = Math.round(v) - start + 1;
        start = Math.max(0, Math.min(total - 1, start));
        const snapped = snapLen(t.rule, len, total - start);
        if (snapped == null) { a.toast('No allowed length fits there.', 'error'); el.value = ''; a.invalidate(true); return; }
        const others = a.data.windows.some(o => o.track === w.track && o.id !== w.id && o.start < start + snapped && start < o.start + o.len);
        if (others) { a.toast('That would overlap another window.', 'error'); el.value = ''; a.invalidate(true); return; }
        a.setRange(w, start, snapped);
        a.store.commit();
        el.value = String(el.id === 'win-start' ? w.start : el.id === 'win-len' ? w.len : w.start + w.len - 1);
        return;
      }
      case 'c-x': case 'c-y': case 'c-w': case 'c-h': case 'c-r': {
        const c = a.activeCrop();
        if (!c || v == null) { a.invalidate(true); return; }
        const k = el.id.slice(2) as keyof Crop;
        const next = { ...c };
        if (k === 'w' || k === 'h') {
          // Resize about the centre.
          const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
          next[k] = Math.max(2, v);
          const aspect = a.cropAspect();
          if (aspect) { if (k === 'w') next.h = next.w / aspect; else next.w = next.h * aspect; }
          next.x = cx - next.w / 2;
          next.y = cy - next.h / 2;
        } else next[k] = v;
        a.setCrop(next, commit);
        return;
      }
      case 'animate':
        if (w) a.setAnimate(w, el.checked);
        return;
      case 't-name':
        t.name = el.value.trim() || t.name;
        a.store.commit();
        return;
      case 't-preset': {
        const i = Number(el.value);
        this.customRule = i < 0;
        if (i >= 0) a.updateTrack(t, { rule: { ...RULE_PRESETS[i].rule }, defLen: snapLen(RULE_PRESETS[i].rule, t.defLen) ?? t.defLen });
        else {
          // Custom: keep the rule, show its fields.
          this.update();
          this.root.querySelector<HTMLInputElement>('#t-a')?.focus();
        }
        return;
      }
      case 't-a': case 't-b': {
        if (v == null) return;
        const rule = { ...t.rule, [el.id === 't-a' ? 'a' : 'b']: Math.round(v) };
        rule.a = Math.max(1, rule.a);
        a.updateTrack(t, { rule, defLen: snapLen(rule, t.defLen) ?? t.defLen });
        return;
      }
      case 't-def':
        if (v != null) a.updateTrack(t, { defLen: snapLen(t.rule, Math.max(1, Math.round(v))) ?? t.defLen });
        el.value = String(t.defLen);
        return;
      case 't-ow': case 't-oh': case 't-div': {
        const val = Math.max(el.id === 't-div' ? 1 : 0, Math.round(v ?? 0));
        a.updateTrack(t, el.id === 't-ow' ? { outW: val } : el.id === 't-oh' ? { outH: val } : { div: val });
        return;
      }
      case 'untagged':
        void a.setUntaggedColor(el.value === 'bt709' ? 'bt709' : 'bt601');
        return;
      case 'cache':
        if (v != null) { a.cacheMB = Math.max(256, Math.round(v)); a.invalidate(true); }
        return;
    }
  }

  private savePreset() {
    const a = this.app;
    const name = this.root.querySelector<HTMLInputElement>('#p-name')?.value.trim();
    if (!name) { this.root.querySelector<HTMLInputElement>('#p-name')?.focus(); return; }
    const replacing = a.presets.some(p => p.name === name);
    a.savePreset(presetFrom(name, a.data.fps, a.currentTrack));
    a.toast(replacing ? `Updated “${name}”` : `Saved “${name}”`, 'success');
    this.closeSave();
  }

  private closeSave() {
    this.saving = false;
    this.update();
  }

  private onClick(e: Event) {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (!btn) return;
    const a = this.app, m = a.media;
    if (!m) return;
    const w = a.selected, t = a.currentTrack;
    const c = a.activeCrop();
    switch (btn.dataset.act) {
      case 'new': a.createWindowAt(a.playhead); break;
      case 'native': a.setFps(null); break;
      case 'loop': if (w) a.playLoop(w.id); break;
      case 'combine': a.combineSelection(); break;
      case 'uncombine': a.uncombineSelection(); break;
      case 'dup': if (w) a.duplicateWindow(w.id); break;
      case 'del': if (w) a.deleteWindow(w.id); break;
      case 'rot-': case 'rot+':
        if (c) a.setCrop({ ...c, r: Math.round(c.r / 90) * 90 + (btn.dataset.act === 'rot+' ? 90 : -90) });
        break;
      case 'p-save':
        this.saving = true;
        this.update();
        this.root.querySelector<HTMLInputElement>('#p-name')?.focus();
        break;
      case 'p-ok': this.savePreset(); break;
      case 'p-cancel': this.closeSave(); break;
      case 'p-del': {
        const p = a.presets.find(p => presetMatches(p, a.data.fps, t));
        if (p) {
          a.deletePreset(p.name);
          a.toast(`Deleted “${p.name}”`, 'info', { label: 'Undo', run: () => a.savePreset(p) });
        }
        break;
      }
      case 'reset-win': if (w) a.resetWindow(w); break;
      case 'full': {
        const full = fullCrop(m.W, m.H, a.cropAspect());
        a.setCrop(c?.r ? { ...full, r: c.r } : full);
        break;
      }
      case 'center':
        if (c) a.setCrop({ ...c, x: (m.W - c.w) / 2, y: (m.H - c.h) / 2 });
        break;
      case 'key': a.toggleKey(); break;
      case 'key-prev': a.jumpKey(-1); break;
      case 'key-next': a.jumpKey(1); break;
      case 'jump': if (w) { a.stop(); a.seek(w.start + Number(btn.dataset.f)); } break;
      case 'unkey': if (w) a.removeKey(w, Number(btn.dataset.f)); break;
      case 'color': t.color = btn.dataset.c!; a.store.commit(); break;
      case 't-apply': {
        if (!c) break;
        const n = a.data.windows.filter(o => o.track === t.id).length;
        for (const o of a.data.windows) if (o.track === t.id) { o.keys = [{ f: 0, c: { ...c } }]; o.animate = false; }
        a.store.commit();
        a.toast(`Crop applied to ${n} window${n === 1 ? '' : 's'}`, 'success', { label: 'Undo', run: () => a.store.undo() });
        break;
      }
      case 't-del': {
        if (a.data.tracks.length <= 1) { a.toast('A project needs at least one track.'); break; }
        const n = a.data.windows.filter(o => o.track === t.id).length;
        const name = t.name;
        a.deleteTrack(t.id);
        a.toast(n ? `Deleted ${name} and ${n} window${n === 1 ? '' : 's'}` : `Deleted ${name}`, 'info', { label: 'Undo', run: () => a.store.undo() });
        break;
      }
    }
  }
}

const sameRule = (p: { a: number; b: number }, q: { a: number; b: number }) => p.a === q.a && (p.a === 1 || p.b === q.b);

function fitsOn(a: App, track: string, w: { id: string; start: number; len: number }) {
  return !a.data.windows.some(o => o.track === track && o.id !== w.id && o.start < w.start + w.len && w.start < o.start + o.len);
}

/** The exact output frame for the selected window at the playhead, rendered the way export renders it. */
export class OutputPreview {
  private ctx: CanvasRenderingContext2D;
  private asked = -1;
  private labelKey = '';

  constructor(private canvas: HTMLCanvasElement, private label: HTMLElement, private app: App) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    app.onDraw(() => this.draw());
  }

  private setLabel(size: string, frame: string, outside: boolean) {
    const key = [size, frame, outside].join('|');
    if (key === this.labelKey) return;
    this.labelKey = key;
    this.label.innerHTML = size ? `${outside ? `<span class="warn" data-tip="Playhead is outside this window; showing its nearest frame">${icon('alert', 13)}</span>` : ''}<span>${frame}</span><span class="sep">·</span><span>${size}</span>` : '';
  }

  draw() {
    const a = this.app, m = a.media, w = a.selected;
    const box = this.canvas.parentElement!;
    if (!m || !w) {
      box.classList.add('empty');
      this.setLabel('', '', false);
      return;
    }
    box.classList.remove('empty');
    const track = a.track(w.track)!;
    const out = outputSize(w, track);
    if (this.canvas.width !== out.w || this.canvas.height !== out.h) {
      this.canvas.width = out.w;
      this.canvas.height = out.h;
    }
    const inside = a.playhead >= w.start && a.playhead < w.start + w.len;
    const f = a.localFrame(w);
    const src = m.tb.src(w.start + f);
    const bmp = m.frames.get(src);
    const size = `${out.w} × ${out.h}`;
    if (!bmp) {
      // Outside the window the frame is not in the playhead's prefetch, so ask once.
      if (!inside && this.asked !== src) { this.asked = src; void m.frames.request(src).then(() => a.invalidate()); }
      this.setLabel(size, 'decoding…', !inside);
      return;
    }
    renderOutput(this.ctx, bmp, m.orient, outputRegion(cropAt(w, f), cropAt(w, 0), track), out.w, out.h);
    this.setLabel(size, `${f + 1} / ${w.len}`, !inside);
  }
}
