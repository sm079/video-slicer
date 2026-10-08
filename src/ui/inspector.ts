import type { App } from '../app';
import { cropAt, outputSize, snapLen, minLen, ruleText, RULE_PRESETS, COLORS, fullCrop, trackAspect, type Crop } from '../model/project';
import { formatFps, parseFps } from '../media/timebase';
import { renderOutput } from '../model/render';

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** Side panel: video info, frame rate, the selected window and its track. Rebuilt only when its shape changes. */
export class Inspector {
  private shape = '';

  constructor(private root: HTMLElement, private app: App) {
    app.onUi(() => this.update());
    root.addEventListener('change', e => this.onChange(e.target as HTMLInputElement));
    root.addEventListener('click', e => this.onClick(e));
    root.addEventListener('keydown', e => {
      const t = e.target as HTMLInputElement;
      if (e.key === 'Enter' && t.tagName === 'INPUT') { t.blur(); }
      if (e.key === 'Escape' && t.tagName === 'INPUT') { this.shape = ''; t.blur(); this.update(); }
    });
  }

  private shapeKey() {
    const a = this.app, w = a.selected, t = a.currentTrack;
    return [a.media?.file.name, a.data.tracks.length, a.data.tracks.map(t => t.id + t.name + t.color).join(), w?.id, w?.animate,
      w?.keys.map(k => k.f).join(), t.id, t.rule.a, t.rule.b].join('|');
  }

  update() {
    const key = this.shapeKey();
    if (key !== this.shape) { this.shape = key; this.build(); }
    this.fill();
  }

  private build() {
    const a = this.app, m = a.media;
    if (!m) {
      this.root.innerHTML = `<section><h3>Get started</h3><p class="muted">Open or drop a video. Everything runs locally in this browser tab, so nothing is uploaded.</p></section>`;
      return;
    }
    const info = m.demux.info;
    const w = a.selected, t = a.currentTrack;
    const preset = RULE_PRESETS.findIndex(p => p.rule.a === t.rule.a && (p.rule.a === 1 || p.rule.b === t.rule.b));
    let html = `
      <section>
        <h3>Video</h3>
        <div class="kv"><span>File</span><b title="${esc(info.fileName)}">${esc(info.fileName)}</b></div>
        <div class="kv"><span>Size</span><b>${info.width}×${info.height}${info.rotation ? ` (rotated ${info.rotation}°)` : ''}</b></div>
        <div class="kv"><span>Codec</span><b>${esc(info.codec)} · ${esc(info.container)}</b></div>
        <div class="kv"><span>Audio</span><b>${m.demux.audio ? `${esc(m.demux.audio.info.codec)} · ${(m.demux.audio.info.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz · ${m.demux.audio.info.channels} ch` : 'none'}</b></div>
        <div class="kv"><span>Color</span><b title="${esc(info.color)}">${esc(info.color)}</b></div>
        <div class="kv"><span>Source</span><b>${m.demux.index.count - m.demux.index.first} frames · ${esc(formatFps(m.sourceFps))} fps</b></div>
        <label class="row"><span>Output fps</span><input id="fps" type="text" placeholder="native (${esc(formatFps(m.sourceFps))})" spellcheck="false"><button data-act="native" title="Use the source frames one for one">Native</button></label>
        <p class="muted small" id="fps-note"></p>
      </section>`;
    if (w) {
      html += `
      <section>
        <h3><span class="swatch" style="background:${t.color}"></span>Window <span class="muted" id="win-n"></span></h3>
        <label class="row"><span>Track</span><select id="win-track">${a.data.tracks.map(tr => `<option value="${tr.id}" ${tr.id === w.track ? 'selected' : ''}>${esc(tr.name)}</option>`).join('')}</select></label>
        <div class="grid3">
          <label><span>Start</span><input id="win-start" type="number" min="0" step="1"></label>
          <label><span>Length</span><input id="win-len" type="number" min="1" step="${Math.max(1, t.rule.a)}"></label>
          <label><span>End</span><input id="win-end" type="number" min="0" step="1"></label>
        </div>
        <p class="muted small" id="win-out"></p>
        <div class="btns">
          <button data-act="loop" title="Loop this window (L)">▶ Loop</button>
          <button data-act="dup" title="Duplicate (Ctrl+D)">Duplicate</button>
          <button data-act="del" class="danger" title="Delete (Del)">Delete</button>
        </div>
      </section>`;
    }
    html += `
      <section>
        <h3>Crop ${w ? `<span class="muted small" id="crop-where"></span>` : '<span class="muted small">default for new windows</span>'}</h3>
        <div class="grid5">
          <label><span>X</span><input id="c-x" type="number" step="1"></label>
          <label><span>Y</span><input id="c-y" type="number" step="1"></label>
          <label><span>W</span><input id="c-w" type="number" step="${trackAspect(t) ? 1 : t.div}"></label>
          <label><span>H</span><input id="c-h" type="number" step="${trackAspect(t) ? 1 : t.div}"></label>
          <label><span>°</span><input id="c-r" type="number" step="0.5"></label>
        </div>
        <div class="btns">
          <button data-act="rot-">⟲ 90°</button><button data-act="rot+">⟳ 90°</button>
          <button data-act="full" title="Largest crop of this shape">Full</button><button data-act="center">Center</button>
        </div>
        ${w ? `
        <label class="check"><input type="checkbox" id="animate" ${w.animate ? 'checked' : ''}> Animate crop with keyframes</label>
        ${w.animate ? `<div class="keys">${w.keys.map(k => `<div class="key"><button data-act="jump" data-f="${k.f}">◆ frame ${k.f}</button><span class="muted small">@ ${k.f + w.start}</span><button data-act="unkey" data-f="${k.f}" title="Remove key" ${w.keys.length < 2 ? 'disabled' : ''}>✕</button></div>`).join('')}</div>
        <button data-act="key" title="Add or remove a key at the playhead (K)">◆ Key at playhead</button>` : '<p class="muted small">Off: one crop for the whole window. On: every edit keys the crop at the playhead; keys interpolate linearly.</p>'}` : ''}
      </section>
      <section>
        <h3><span class="swatch" style="background:${t.color}"></span>Track</h3>
        <label class="row"><span>Name</span><input id="t-name" type="text" spellcheck="false"></label>
        <label class="row"><span>Color</span><span class="colors">${COLORS.map(c => `<button data-act="color" data-c="${c}" class="color ${c === t.color ? 'on' : ''}" style="background:${c}"></button>`).join('')}</span></label>
        <label class="row"><span>Length rule</span><select id="t-preset">${RULE_PRESETS.map((p, i) => `<option value="${i}" ${i === preset ? 'selected' : ''}>${p.label}</option>`).join('')}<option value="-1" ${preset < 0 ? 'selected' : ''}>Custom</option></select></label>
        <div class="grid3 rule">
          <label><span>a (step)</span><input id="t-a" type="number" min="1" step="1"></label>
          <label><span>b (offset)</span><input id="t-b" type="number" step="1"></label>
          <label><span>Default len</span><input id="t-def" type="number" min="1" step="${Math.max(1, t.rule.a)}"></label>
        </div>
        <p class="muted small" id="t-rule-note"></p>
        <div class="grid3">
          <label><span>Out W</span><input id="t-ow" type="number" min="0" step="1" placeholder="auto"></label>
          <label><span>Out H</span><input id="t-oh" type="number" min="0" step="1" placeholder="auto"></label>
          <label><span>Sides ÷</span><input id="t-div" type="number" min="1" step="1"></label>
        </div>
        <p class="muted small">Blank output size = crop size. Both set = fixed size, crop shape locked. Sides snap down to multiples of ÷ (H.264 needs 2).</p>
        <div class="btns"><button data-act="t-apply" title="Give every window on this track the crop shown above">Apply crop to all</button><button data-act="t-del" class="danger">Delete track</button></div>
      </section>
      <section>
        <h3>Performance</h3>
        <label class="row"><span>Frame cache</span><input id="cache" type="number" min="256" step="256"><span class="muted small">MB</span></label>
        <p class="muted small" id="cache-note"></p>
        <label class="row"><span>Untagged color</span><select id="untagged"><option value="bt601">BT.601 (like ffmpeg)</option><option value="bt709">BT.709</option></select></label>
        <p class="muted small">Matrix for videos that don't say which one they use. BT.601 matches ffmpeg, PyAV and OpenCV.</p>
      </section>`;
    this.root.innerHTML = html;
  }

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

  private fill() {
    const a = this.app, m = a.media;
    if (!m) return;
    const w = a.selected, t = a.currentTrack;
    this.set('fps', a.data.fps == null ? '' : String(Math.round(a.data.fps * 1e6) / 1e6));
    this.text('fps-note', a.data.fps == null
      ? `Native: output frame i is source frame i (${m.tb.count} frames).`
      : `Conformed: ${m.tb.count} frames at ${formatFps(m.tb.fps)} fps, each showing the source frame at its midpoint (same as ffmpeg's fps filter).`);
    if (w) {
      const n = a.data.windows.filter(o => o.track === w.track && o.start < w.start).length + 1;
      this.text('win-n', `#${n}`);
      this.set('win-start', w.start);
      this.set('win-len', w.len);
      this.set('win-end', w.start + w.len - 1);
      const out = outputSize(w, t);
      const secs = m.tb.time(w.start + w.len - 1) - m.tb.time(w.start) + 1 / m.tb.fps;
      this.text('win-out', `${w.len} frames · ${secs.toFixed(2)} s · output ${out.w}×${out.h}`);
      const inside = a.playhead >= w.start && a.playhead < w.start + w.len;
      this.text('crop-where', inside ? `at window frame ${a.playhead - w.start}` : 'playhead is outside this window');
    }
    const c = a.activeCrop();
    if (c) {
      const r1 = (v: number) => Math.round(v * 10) / 10;
      this.set('c-x', r1(c.x)); this.set('c-y', r1(c.y)); this.set('c-w', r1(c.w)); this.set('c-h', r1(c.h)); this.set('c-r', r1(c.r));
    }
    this.set('t-name', t.name);
    this.set('t-a', t.rule.a);
    this.set('t-b', t.rule.b);
    this.set('t-def', t.defLen);
    this.set('t-ow', t.outW || '');
    this.set('t-oh', t.outH || '');
    this.set('t-div', t.div);
    const lo = minLen(t.rule), ex: number[] = [];
    for (let v = lo; ex.length < 5; v += Math.max(1, t.rule.a)) ex.push(v);
    this.text('t-rule-note', t.rule.a <= 1 ? 'Any length allowed.' : `Lengths ${ruleText(t.rule)}: ${ex.join(', ')}, …`);
    this.set('cache', a.cacheMB);
    this.set('untagged', a.untaggedColor);
    this.text('cache-note', `Holds about ${m.frames.capacity} full-resolution frames (${(m.frames.frameBytes / 1048576).toFixed(1)} MB each). Loops that fit play without re-decoding.`);
  }

  private num(el: HTMLInputElement) {
    const v = Number(el.value);
    return Number.isFinite(v) ? v : null;
  }

  private onChange(el: HTMLInputElement) {
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
      case 'win-track': {
        if (!w) return;
        const target = a.track(el.value)!;
        if (!fitsOn(a, target.id, w)) { a.toast('It overlaps a window on that track.', 'error'); this.shape = ''; a.invalidate(true); return; }
        a.moveToTrack(w, target);
        a.selTrack = target.id;
        a.store.commit();
        return;
      }
      case 'win-start': case 'win-len': case 'win-end': {
        if (!w || v == null) return;
        let start = w.start, len = w.len;
        if (el.id === 'win-start') start = Math.round(v);
        if (el.id === 'win-len') len = Math.round(v);
        if (el.id === 'win-end') len = Math.round(v) - start + 1;
        start = Math.max(0, Math.min(total - 1, start));
        const snapped = snapLen(t.rule, len, total - start);
        if (snapped == null) { a.toast('No allowed length fits there.', 'error'); a.invalidate(true); return; }
        const others = a.data.windows.some(o => o.track === w.track && o.id !== w.id && o.start < start + snapped && start < o.start + o.len);
        if (others) { a.toast('That would overlap another window on this track.', 'error'); a.invalidate(true); return; }
        a.setRange(w, start, snapped);
        a.store.commit();
        return;
      }
      case 'c-x': case 'c-y': case 'c-w': case 'c-h': case 'c-r': {
        const c = a.activeCrop();
        if (!c || v == null) return;
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
        a.setCrop(next);
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
        if (i >= 0) a.updateTrack(t, { rule: { ...RULE_PRESETS[i].rule }, defLen: snapLen(RULE_PRESETS[i].rule, t.defLen) ?? t.defLen });
        else { this.shape = ''; a.invalidate(true); }
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

  private onClick(e: Event) {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    const a = this.app, m = a.media;
    if (!m) return;
    const w = a.selected, t = a.currentTrack;
    const c = a.activeCrop();
    switch (btn.dataset.act) {
      case 'native': a.setFps(null); break;
      case 'loop': if (w) a.playLoop(w.id); break;
      case 'dup': if (w) a.duplicateWindow(w.id); break;
      case 'del': if (w) a.deleteWindow(w.id); break;
      case 'rot-': case 'rot+':
        if (c) a.setCrop({ ...c, r: Math.round(c.r / 90) * 90 + (btn.dataset.act === 'rot+' ? 90 : -90) });
        break;
      case 'full': {
        const full = fullCrop(m.W, m.H, a.cropAspect(), t.div);
        a.setCrop(c?.r ? { ...full, r: c.r } : full);
        break;
      }
      case 'center':
        if (c) a.setCrop({ ...c, x: (m.W - c.w) / 2, y: (m.H - c.h) / 2 });
        break;
      case 'key': a.toggleKey(); break;
      case 'jump': if (w) a.seek(w.start + Number(btn.dataset.f)); break;
      case 'unkey': if (w) a.removeKey(w, Number(btn.dataset.f)); break;
      case 'color': t.color = btn.dataset.c!; a.store.commit(); break;
      case 't-apply': {
        if (!c) break;
        for (const o of a.data.windows) if (o.track === t.id) { o.keys = [{ f: 0, c: { ...c } }]; o.animate = false; }
        a.store.commit();
        break;
      }
      case 't-del':
        if (a.data.windows.some(o => o.track === t.id) && !btn.dataset.armed) {
          btn.dataset.armed = '1';
          btn.textContent = 'Click again to delete its windows too';
          return;
        }
        a.deleteTrack(t.id);
        break;
    }
  }
}

function fitsOn(a: App, track: string, w: { id: string; start: number; len: number }) {
  return !a.data.windows.some(o => o.track === track && o.id !== w.id && o.start < w.start + w.len && w.start < o.start + o.len);
}

/** The exact output frame for the selected window at the playhead, rendered the way export renders it. */
export class OutputPreview {
  private ctx: CanvasRenderingContext2D;
  private asked = -1;

  constructor(private canvas: HTMLCanvasElement, private label: HTMLElement, private app: App) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    app.onDraw(() => this.draw());
  }

  draw() {
    const a = this.app, m = a.media, w = a.selected;
    const box = this.canvas.parentElement!;
    if (!m || !w) {
      box.classList.add('empty');
      this.label.textContent = m ? 'Select a window to see its output.' : '';
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
    const out_f = w.start + f;
    const src = m.tb.src(out_f);
    const bmp = m.frames.get(src);
    if (!bmp) {
      // Outside the window the frame is not in the playhead's prefetch, so ask once.
      if (!inside && this.asked !== src) { this.asked = src; void m.frames.request(src).then(() => a.invalidate()); }
      this.label.textContent = `${out.w}×${out.h} · decoding…`;
      return;
    }
    renderOutput(this.ctx, bmp, m.orient, cropAt(w, f), out.w, out.h);
    this.label.textContent = `${out.w}×${out.h} · frame ${f + 1}/${w.len}${inside ? '' : ' (clamped: playhead outside)'} · source #${src - m.demux.index.first}`;
  }
}
