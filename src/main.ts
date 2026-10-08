import './style.css';
import { App } from './app';
import { Viewer } from './ui/viewer';
import { Timeline, timecode } from './ui/timeline';
import { Inspector, OutputPreview } from './ui/inspector';
import { hydrateIcons, icon } from './ui/icons';
import { initMenus, showToast, escapeHtml } from './ui/widgets';
import { runExport, folderWriter, zipWriter, type ExportOptions, type Format, type Quality } from './export/export';
import { outputSize } from './model/project';
import { formatFps } from './media/timebase';
import { initTheme, themePref, type ThemePref } from './ui/theme';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

if (!('VideoDecoder' in window)) {
  document.body.innerHTML = '<div class="unsupported"><h1>This browser can’t decode video here</h1><p>Video Slicer needs WebCodecs. Use a current Chrome, Edge or Opera, or Safari 17+.</p></div>';
  throw new Error('WebCodecs unavailable');
}

hydrateIcons();
initMenus();

const app = new App();
const viewer = new Viewer($<HTMLCanvasElement>('viewer'), app, $<HTMLButtonElement>('viewer-fit'));
const timeline = new Timeline($<HTMLCanvasElement>('timeline'), app);
const inspector = new Inspector($('inspector'), $('tabs'), app);
new OutputPreview($<HTMLCanvasElement>('preview'), $('plabel'), app);
void viewer;

// ------------------------------------------------------------------ theme

const setTheme = initTheme(() => app.invalidate(true));
const themeRadios = document.querySelectorAll<HTMLInputElement>('input[name=theme]');
themeRadios.forEach(r => {
  r.checked = r.value === themePref();
  r.addEventListener('change', () => { if (r.checked) setTheme(r.value as ThemePref); });
});

app.toast = (msg, kind = 'info', action) => showToast($('toasts'), msg, { kind, action });
app.onLoading = msg => {
  $('loading').hidden = msg == null;
  if (msg) $('loading-text').textContent = msg;
};

// ------------------------------------------------------------------ open

const pickVideo = () => $<HTMLInputElement>('file').click();
$('open').onclick = pickVideo;
$('m-open').onclick = pickVideo;
$<HTMLInputElement>('file').onchange = e => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void app.open(f);
  (e.target as HTMLInputElement).value = '';
};
let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  if (/\.json$/i.test(f.name)) void loadProject(f);
  else void app.open(f);
});

// --------------------------------------------------------------- project

$('undo').onclick = () => app.store.undo();
$('redo').onclick = () => app.store.redo();
function saveProject() {
  if (!app.media) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(app.exportProject());
  a.download = `${app.media.file.name.replace(/\.[^.]+$/, '')}.slices.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
$('m-save').onclick = saveProject;
$('m-reset').onclick = () => {
  if (!app.media) return;
  app.resetEditor();
  app.toast('Started over', 'info', { label: 'Undo', run: () => app.store.undo() });
};
$('m-load').onclick = () => $<HTMLInputElement>('projfile').click();
$('m-help').onclick = () => $<HTMLDialogElement>('help-dlg').showModal();
$<HTMLInputElement>('projfile').onchange = e => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void loadProject(f);
  (e.target as HTMLInputElement).value = '';
};
async function loadProject(f: File) {
  if (!app.media) { app.toast('Open its video first, then load the project.'); return; }
  try {
    if (app.importProject(await f.text())) app.toast('Project loaded', 'success', { label: 'Undo', run: () => app.store.undo() });
    else app.toast('Loaded, but it was saved for a different video.', 'error');
  } catch (e) {
    app.toast(String((e as Error)?.message ?? e), 'error');
  }
}
$('fileinfo').onclick = () => inspector.show('project');

// ------------------------------------------------------------- transport

$('t-start').onclick = () => { app.stop(); app.seek(0); };
$('t-end').onclick = () => { app.stop(); app.seek(app.total - 1); };
$('t-back').onclick = () => app.step(-1);
$('t-fwd').onclick = () => app.step(1);
$('t-play').onclick = () => app.togglePlay();
$('t-new').onclick = () => app.createWindowAt(app.playhead);
$('t-zin').onclick = () => timeline.zoomBy(1.6);
$('t-zout').onclick = () => timeline.zoomBy(1 / 1.6);
$('t-fit').onclick = () => timeline.fit();
const muteBtn = $('t-mute'), volInput = $<HTMLInputElement>('t-vol');
const showVolume = () => {
  const muted = app.audio.muted || app.audio.volume === 0;
  muteBtn.innerHTML = icon(muted ? 'mute' : 'volume', 17);
  muteBtn.dataset.tip = muted ? 'Unmute' : 'Mute';
  muteBtn.setAttribute('aria-label', muteBtn.dataset.tip);
  volInput.value = String(app.audio.muted ? 0 : app.audio.volume);
  volInput.style.accentColor = muted ? 'var(--text-3)' : '';
};
muteBtn.onclick = () => { app.audio.muted = !app.audio.muted; if (!app.audio.muted && app.audio.volume === 0) app.audio.volume = 1; showVolume(); };
volInput.oninput = () => { app.audio.volume = Number(volInput.value); app.audio.muted = false; showVolume(); };
volInput.onchange = () => volInput.blur();
showVolume();
const frameInput = $<HTMLInputElement>('t-frame');
frameInput.onchange = () => { app.stop(); app.seek(Number(frameInput.value) || 0); frameInput.blur(); };
frameInput.onkeydown = e => { if (e.key === 'Escape') { frameInput.value = String(app.playhead); frameInput.blur(); } };
frameInput.onfocus = () => frameInput.select();

const playBtn = $('t-play');
let playState = '';
app.onDraw(() => {
  const m = app.media;
  if (document.activeElement !== frameInput) frameInput.value = m ? String(app.playhead) : '';
  const total = m ? `/ ${app.total - 1}` : '';
  if ($('t-total').textContent !== total) $('t-total').textContent = total;
  const time = m ? `${timecode(m.tb.time(app.playhead))}` : '';
  if ($('t-time').textContent !== time) $('t-time').textContent = time;
  const state = app.play ? (app.play.loop ? 'loop' : 'play') : 'pause';
  if (state !== playState) {
    playState = state;
    playBtn.innerHTML = icon(app.play ? 'pause' : 'play', 18);
    playBtn.dataset.tip = app.play ? 'Pause' : 'Play';
    playBtn.setAttribute('aria-label', playBtn.dataset.tip);
    playBtn.classList.toggle('looping', state === 'loop');
  }
});
app.onUi(() => {
  const m = app.media;
  $('app').classList.toggle('no-media', !m);
  const chip = $<HTMLButtonElement>('fileinfo');
  chip.hidden = !m;
  if (m && chip.dataset.hash !== m.hash) {
    chip.dataset.hash = m.hash;
    chip.innerHTML = `<span class="name">${escapeHtml(m.file.name)}</span><span class="meta">${m.W} × ${m.H} · ${escapeHtml(formatFps(m.sourceFps))} fps</span>`;
    document.title = `${m.file.name} · Video Slicer`;
  }
  $('t-audio').hidden = !m?.demux.audio;
  $<HTMLButtonElement>('undo').disabled = !m || !app.store.canUndo;
  $<HTMLButtonElement>('redo').disabled = !m || !app.store.canRedo;
  $<HTMLButtonElement>('export').disabled = !m || !app.data.windows.length;
  $('export').dataset.tip = m && !app.data.windows.length ? 'Draw a window first' : 'Export clips';
  document.querySelectorAll<HTMLButtonElement>('#main-menu [data-media]').forEach(b => { b.disabled = !m; });
});

// -------------------------------------------------------- split handles

/** Drag `handle` to set a CSS size variable; the size is remembered, double-click restores the default. */
function splitter(handle: HTMLElement, cssVar: string, storageKey: string, sizeAt: (e: PointerEvent) => number, limits: () => [number, number]) {
  const root = document.documentElement;
  const apply = (px: number) => {
    const [lo, hi] = limits();
    root.style.setProperty(cssVar, `${Math.round(Math.max(lo, Math.min(hi, px)))}px`);
  };
  const saved = Number(localStorageGet(storageKey));
  if (saved > 0) apply(saved);
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('active');
    const move = (ev: PointerEvent) => apply(sizeAt(ev));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.classList.remove('active');
      localStorageSet(storageKey, String(parseInt(root.style.getPropertyValue(cssVar))));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('lostpointercapture', up, { once: true });
  });
  handle.addEventListener('dblclick', () => {
    root.style.removeProperty(cssVar);
    try { localStorage.removeItem(storageKey); } catch { /* blocked */ }
  });
  // Keep a remembered size valid when the window shrinks.
  window.addEventListener('resize', () => {
    const cur = parseInt(root.style.getPropertyValue(cssVar));
    if (cur > 0) apply(cur);
  });
}

splitter($('split'), '--timeline-h', 'vs.timelineH', e => window.innerHeight - e.clientY,
  () => [120, Math.max(120, window.innerHeight - 260)]);
splitter($('vsplit'), '--side-w', 'vs.sideW', e => window.innerWidth - e.clientX,
  () => [280, Math.max(280, Math.min(900, window.innerWidth - 420))]);

function localStorageGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* blocked */ } }

// -------------------------------------------------------------- keyboard

function sortedWindows(sameTrack: boolean) {
  const w = app.selected;
  return app.data.windows
    .filter(o => !sameTrack || o.track === (w?.track ?? app.currentTrack.id))
    .sort((a, b) => a.start - b.start || app.data.tracks.findIndex(t => t.id === a.track) - app.data.tracks.findIndex(t => t.id === b.track));
}

function selectNeighbour(dir: 1 | -1, sameTrack: boolean) {
  const list = sortedWindows(sameTrack);
  if (!list.length) return;
  const cur = list.findIndex(o => o.id === app.selWin);
  let next;
  if (cur < 0) next = dir > 0 ? list.find(o => o.start >= app.playhead) ?? list[0] : [...list].reverse().find(o => o.start <= app.playhead) ?? list[list.length - 1];
  else next = list[(cur + dir + list.length) % list.length];
  app.stop();
  app.select(next.id);
  app.seek(next.start);
  timeline.show(next.start, next.start + next.len);
}

window.addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  if (t.closest('input:not([type=range]):not([type=checkbox]):not([type=radio]), select, textarea, dialog[open], [popover]:popover-open')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key;
  if (ctrl && (k === 'o' || k === 'O')) { e.preventDefault(); pickVideo(); return; }
  if (ctrl && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) app.store.redo(); else app.store.undo(); return; }
  if (ctrl && (k === 'y' || k === 'Y')) { e.preventDefault(); app.store.redo(); return; }
  if (ctrl && (k === 'e' || k === 'E')) { e.preventDefault(); openExport(); return; }
  if (ctrl && (k === 'd' || k === 'D')) { e.preventDefault(); if (app.selWin) app.duplicateWindow(app.selWin); return; }
  if (ctrl && (k === 's' || k === 'S')) { e.preventDefault(); saveProject(); return; }
  if (ctrl || e.altKey) return;
  if (k === '?') { e.preventDefault(); $<HTMLDialogElement>('help-dlg').showModal(); return; }
  if (!app.media) return;
  // Space on a focused button would click it as well.
  if ((k === ' ' || k === 'Enter') && t.closest('button, [role=tab]')) return;
  const handled = () => e.preventDefault();
  switch (k) {
    case ' ': handled(); app.togglePlay(); break;
    case 'ArrowLeft': handled(); app.step(e.shiftKey ? -10 : -1); break;
    case 'ArrowRight': handled(); app.step(e.shiftKey ? 10 : 1); break;
    case 'ArrowUp': handled(); selectNeighbour(-1, true); break;
    case 'ArrowDown': handled(); selectNeighbour(1, true); break;
    case 'Tab':
      // Keep Tab for focus navigation once the keyboard is in the panels.
      if (t !== document.body) return;
      handled(); selectNeighbour(e.shiftKey ? -1 : 1, false); break;
    case 'Home': handled(); app.stop(); app.seek(0); break;
    case 'End': handled(); app.stop(); app.seek(app.total - 1); break;
    case 'n': case 'N': handled(); app.createWindowAt(app.playhead); break;
    case 'l': case 'L': case 'Enter': handled(); if (app.selWin) app.playLoop(app.selWin); break;
    case 'Delete': case 'Backspace': handled(); if (app.selWin) app.deleteWindow(app.selWin); break;
    case 'i': case 'I': handled(); app.setEdge('start'); break;
    case 'o': case 'O': handled(); app.setEdge('end'); break;
    case 'k': case 'K': handled(); app.toggleKey(); break;
    case '[': handled(); app.jumpKey(-1); break;
    case ']': handled(); app.jumpKey(1); break;
    case '+': case '=': handled(); timeline.zoomBy(1.6); break;
    case '-': case '_': handled(); timeline.zoomBy(1 / 1.6); break;
    case 'f': case 'F': handled(); timeline.fit(); break;
    case 'm': case 'M': handled(); muteBtn.click(); break;
    case 'Escape': handled(); if (app.play) app.stop(); else app.select(null); break;
  }
});

// ----------------------------------------------------------------- export

const dlg = $<HTMLDialogElement>('export-dlg');
const form = $<HTMLFormElement>('x-form');
const xAudio = $<HTMLInputElement>('x-audio');
const radio = (name: string) => (form.elements.namedItem(name) as RadioNodeList);
const xProgress = $('x-progress');
let abort: AbortController | null = null;
if (!('showDirectoryPicker' in window)) {
  radio('x-dest').value = 'zip';
  $('x-dest-folder').querySelector('input')!.disabled = true;
  $('x-dest-folder').dataset.tip = 'Needs a Chromium browser';
}

function windowsFor(scope: string) {
  if (scope === 'sel') return app.selected ? [app.selected] : [];
  if (scope === 'track') return app.data.windows.filter(w => w.track === app.currentTrack.id);
  return app.data.windows;
}

function summarize() {
  const wins = windowsFor(radio('x-scope').value);
  const frames = wins.reduce((s, w) => s + w.len, 0);
  const sizes = new Set(wins.map(w => { const o = outputSize(w, app.track(w.track)!); return `${o.w}×${o.h}`; }));
  $('x-summary').textContent = wins.length
    ? `${wins.length} clip${wins.length > 1 ? 's' : ''} · ${frames.toLocaleString()} frames · ${sizes.size > 2 ? `${sizes.size} sizes` : [...sizes].join(', ')}`
    : 'Nothing to export';
  $('x-quality-row').hidden = radio('x-format').value === 'png';
  $<HTMLButtonElement>('x-go').disabled = !wins.length || !!abort;
}

function openExport() {
  if (!app.media || dlg.open) return;
  if (!app.data.windows.length) { app.toast('Draw a window on the timeline first.'); return; }
  app.stop();
  $('x-n-all').textContent = String(app.data.windows.length);
  $('x-n-track').textContent = String(windowsFor('track').length);
  const sel = radio('x-scope');
  const selInput = form.querySelector<HTMLInputElement>('input[name=x-scope][value=sel]')!;
  selInput.disabled = !app.selected;
  sel.value = app.selected ? 'sel' : sel.value === 'sel' ? 'all' : sel.value;
  if (sel.value === 'track' && !windowsFor('track').length) sel.value = 'all';
  const audio = app.media.demux.audio;
  xAudio.disabled = !audio;
  if (!audio) xAudio.checked = false;
  else if (xAudio.dataset.media !== app.media.hash) xAudio.checked = true;
  xAudio.dataset.media = app.media.hash;
  $('x-audio-wrap').dataset.tip = audio ? 'Source audio under each clip' : 'This video has no audio';
  xProgress.hidden = true;
  xProgress.classList.remove('done', 'failed');
  summarize();
  dlg.showModal();
}
$('export').onclick = openExport;
form.addEventListener('change', summarize);
dlg.addEventListener('cancel', e => { if (abort) e.preventDefault(); });
dlg.addEventListener('close', () => { if (abort) abort.abort(); });
$('x-cancel').addEventListener('click', e => {
  if (abort) { e.preventDefault(); abort.abort(); }
});

$('x-go').onclick = async () => {
  const wins = windowsFor(radio('x-scope').value);
  if (!wins.length || abort) return;
  const opts: ExportOptions = {
    windows: wins, format: radio('x-format').value as Format, quality: radio('x-quality').value as Quality,
    manifest: $<HTMLInputElement>('x-manifest').checked, audio: xAudio.checked && !xAudio.disabled,
  };
  let writer;
  const base = app.media!.file.name.replace(/\.[^.]+$/, '');
  try {
    if (radio('x-dest').value === 'folder') {
      const dir = await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'readwrite', id: 'video-slicer-export' });
      writer = await folderWriter(dir);
    } else writer = await zipWriter(`${base}_slices.zip`);
  } catch (e) {
    if ((e as DOMException)?.name !== 'AbortError') app.toast(String((e as Error)?.message ?? e), 'error');
    return;
  }
  abort = new AbortController();
  const bar = xProgress.querySelector<HTMLElement>('.bar > div')!;
  const title = $('x-progress-title'), pct = $('x-progress-pct'), detail = $('x-progress-detail');
  xProgress.hidden = false;
  xProgress.classList.remove('done', 'failed');
  dlg.classList.add('busy');
  bar.style.width = '0';
  title.textContent = 'Preparing…';
  pct.textContent = '';
  detail.textContent = '';
  $('x-cancel').textContent = 'Stop';
  summarize();
  // Export is disabled while running; keep focus (and Escape) inside the dialog.
  $('x-cancel').focus();
  const total = wins.reduce((s, w) => s + w.len, 0);
  let done = 0, lastClip = -1, clipBase = 0;
  const t0 = performance.now();
  try {
    await runExport(app, opts, writer, p => {
      if (p.clip !== lastClip) { clipBase = done; lastClip = p.clip; }
      done = clipBase + p.frame;
      const frac = done / total;
      bar.style.width = `${frac * 100}%`;
      const secs = (performance.now() - t0) / 1000;
      const fps = done / secs;
      const left = fps > 0 ? (total - done) / fps : 0;
      title.textContent = p.name;
      pct.textContent = `${Math.floor(frac * 100)}%`;
      detail.textContent = `Clip ${p.clip + 1} of ${p.clips} · ${fps.toFixed(0)} fps${done > 10 ? ` · ${formatDuration(left)} left` : ''}`;
    }, abort.signal);
    bar.style.width = '100%';
    xProgress.classList.add('done');
    title.textContent = `Exported ${wins.length} clip${wins.length > 1 ? 's' : ''}`;
    pct.textContent = '';
    detail.textContent = `${total.toLocaleString()} frames in ${formatDuration((performance.now() - t0) / 1000)}`;
    if (!dlg.open) app.toast(title.textContent, 'success');
  } catch (e) {
    const cancelled = (e as DOMException)?.name === 'AbortError';
    xProgress.classList.add('failed');
    title.textContent = cancelled ? 'Stopped' : 'Export failed';
    detail.textContent = cancelled ? '' : String((e as Error)?.message ?? e);
    if (!cancelled) { console.error(e); app.toast(`Export failed: ${detail.textContent}`, 'error'); }
  } finally {
    abort = null;
    dlg.classList.remove('busy');
    $('x-cancel').textContent = 'Close';
    summarize();
  }
};
dlg.addEventListener('close', () => { $('x-cancel').textContent = 'Cancel'; });

function formatDuration(s: number) {
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

app.invalidate(true);

// Handy for debugging from the console.
(window as unknown as { slicer: App }).slicer = app;
if (import.meta.env.DEV) {
  void Promise.all([import('./model/render'), import('./export/export'), import('./model/project')]).then(([render, exp, project]) => {
    (window as unknown as { slicerDebug: unknown }).slicerDebug = { ...render, ...exp, ...project };
  });
}
