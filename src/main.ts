import './style.css';
import { App } from './app';
import { Viewer } from './ui/viewer';
import { Timeline, timecode } from './ui/timeline';
import { Inspector, OutputPreview } from './ui/inspector';
import { runExport, folderWriter, zipWriter, type ExportOptions, type Format, type Quality } from './export/export';
import { outputSize } from './model/project';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

if (!('VideoDecoder' in window)) {
  document.body.innerHTML = '<div class="unsupported"><h1>Video Slicer</h1><p>This browser has no WebCodecs support. Use a current Chrome, Edge, Opera or Safari 17+ (Firefox 130+ works for many codecs).</p></div>';
  throw new Error('WebCodecs unavailable');
}

const app = new App();
const viewer = new Viewer($<HTMLCanvasElement>('viewer'), app);
const timeline = new Timeline($<HTMLCanvasElement>('timeline'), app);
new Inspector($('inspector'), app);
new OutputPreview($<HTMLCanvasElement>('preview'), $('plabel'), app);
void viewer;

// ---------------------------------------------------------------- toasts

app.toast = (msg, kind = 'info') => {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').append(el);
  setTimeout(() => el.classList.add('gone'), kind === 'error' ? 6000 : 3000);
  setTimeout(() => el.remove(), kind === 'error' ? 6600 : 3600);
};
app.onLoading = msg => {
  $('loading').hidden = msg == null;
  if (msg) $('loading-text').textContent = msg;
};

// ------------------------------------------------------------------ open

async function open(file: File) {
  await app.open(file);
  if (app.media) {
    timeline.onMediaChanged();
    $('drop').classList.add('hidden');
    document.title = `${file.name} · Video Slicer`;
  }
}

$('open').onclick = () => $<HTMLInputElement>('file').click();
$<HTMLInputElement>('file').onchange = e => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void open(f);
  (e.target as HTMLInputElement).value = '';
};
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  if (/\.json$/i.test(f.name)) void loadProject(f);
  else void open(f);
});

// --------------------------------------------------------------- project

$('undo').onclick = () => app.store.undo();
$('redo').onclick = () => app.store.redo();
$('save').onclick = () => {
  if (!app.media) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(app.exportProject());
  a.download = `${app.media.file.name.replace(/\.[^.]+$/, '')}.slices.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
};
$('load').onclick = () => {
  if (!app.media) { app.toast('Open the video first, then load its project.'); return; }
  $<HTMLInputElement>('projfile').click();
};
$<HTMLInputElement>('projfile').onchange = e => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void loadProject(f);
  (e.target as HTMLInputElement).value = '';
};
async function loadProject(f: File) {
  if (!app.media) { app.toast('Open the video first, then load its project.'); return; }
  try {
    app.importProject(await f.text());
    app.toast('Project loaded.');
  } catch (e) {
    app.toast(String((e as Error)?.message ?? e), 'error');
  }
}

// ------------------------------------------------------------- transport

$('t-start').onclick = () => { app.stop(); app.seek(0); };
$('t-end').onclick = () => { app.stop(); app.seek(app.total - 1); };
$('t-back').onclick = () => app.step(-1);
$('t-fwd').onclick = () => app.step(1);
$('t-play').onclick = () => app.togglePlay();
$('t-new').onclick = () => app.createWindowAt(app.playhead);
$('t-track').onclick = () => app.media && app.addTrack();
$('t-zin').onclick = () => timeline.zoomBy(1.6);
$('t-zout').onclick = () => timeline.zoomBy(1 / 1.6);
$('t-fit').onclick = () => timeline.fit();
const frameInput = $<HTMLInputElement>('t-frame');
frameInput.onchange = () => { app.stop(); app.seek(Number(frameInput.value) || 0); frameInput.blur(); };

app.onDraw(() => {
  const m = app.media;
  if (document.activeElement !== frameInput) frameInput.value = m ? String(app.playhead) : '';
  $('t-total').textContent = m ? `/ ${app.total - 1}` : '';
  $('t-time').textContent = m ? `${timecode(m.tb.time(app.playhead))} / ${timecode(m.tb.duration)}` : '';
  const playBtn = $('t-play');
  const label = app.play ? '❚❚' : '▶';
  if (playBtn.textContent !== label) playBtn.textContent = label;
  playBtn.classList.toggle('looping', !!app.play?.loop);
});
app.onUi(() => {
  const m = app.media;
  $('fileinfo').textContent = m ? `${m.file.name} · ${m.W}×${m.H} · ${(m.file.size / 1048576).toFixed(1)} MB` : '';
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
    const move = (ev: PointerEvent) => apply(sizeAt(ev));
    const up = () => {
      handle.removeEventListener('pointermove', move);
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

splitter($('split'), '--timeline-h', 'vs.timelineH', e => window.innerHeight - e.clientY - 4,
  () => [120, Math.max(120, window.innerHeight - 240)]);
splitter($('vsplit'), '--side-w', 'vs.sideW', e => window.innerWidth - e.clientX - 2,
  () => [260, Math.max(260, Math.min(900, window.innerWidth - 360))]);

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
  if (t.closest('input, select, textarea, dialog[open]')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key;
  if (ctrl && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) app.store.redo(); else app.store.undo(); return; }
  if (ctrl && (k === 'y' || k === 'Y')) { e.preventDefault(); app.store.redo(); return; }
  if (ctrl && (k === 'e' || k === 'E')) { e.preventDefault(); openExport(); return; }
  if (ctrl && (k === 'd' || k === 'D')) { e.preventDefault(); if (app.selWin) app.duplicateWindow(app.selWin); return; }
  if (ctrl && (k === 's' || k === 'S')) { e.preventDefault(); $('save').click(); return; }
  if (ctrl || e.altKey) return;
  if (!app.media && k !== '?') return;
  const handled = () => e.preventDefault();
  switch (k) {
    case ' ': handled(); app.togglePlay(); break;
    case 'ArrowLeft': handled(); app.step(e.shiftKey ? -10 : -1); break;
    case 'ArrowRight': handled(); app.step(e.shiftKey ? 10 : 1); break;
    case 'ArrowUp': handled(); selectNeighbour(-1, true); break;
    case 'ArrowDown': handled(); selectNeighbour(1, true); break;
    case 'Tab': handled(); selectNeighbour(e.shiftKey ? -1 : 1, false); break;
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
    case 'Escape': handled(); if (app.play) app.stop(); else app.select(null); break;
    case '?': handled(); ($<HTMLDialogElement>('help-dlg')).showModal(); break;
  }
});
$('help').onclick = () => $<HTMLDialogElement>('help-dlg').showModal();

// ----------------------------------------------------------------- export

const dlg = $<HTMLDialogElement>('export-dlg');
const xScope = $<HTMLSelectElement>('x-scope'), xFormat = $<HTMLSelectElement>('x-format');
const xQuality = $<HTMLSelectElement>('x-quality'), xDest = $<HTMLSelectElement>('x-dest');
let abort: AbortController | null = null;
if (!('showDirectoryPicker' in window)) { xDest.value = 'zip'; xDest.querySelector('option[value=folder]')!.setAttribute('disabled', ''); }

function exportWindows() {
  const scope = xScope.value;
  if (scope === 'sel') return app.selected ? [app.selected] : [];
  if (scope === 'track') return app.data.windows.filter(w => w.track === app.currentTrack.id);
  return app.data.windows;
}

function summarize() {
  const wins = exportWindows();
  const frames = wins.reduce((s, w) => s + w.len, 0);
  const sizes = new Set(wins.map(w => { const o = outputSize(w, app.track(w.track)!); return `${o.w}×${o.h}`; }));
  $('x-summary').textContent = wins.length
    ? `${wins.length} clip${wins.length > 1 ? 's' : ''}, ${frames} frames, ${[...sizes].slice(0, 4).join(', ')}${sizes.size > 4 ? ', …' : ''} at ${app.media!.tb.fps.toFixed(3).replace(/\.?0+$/, '')} fps.`
    : 'Nothing to export.';
  $<HTMLButtonElement>('x-go').disabled = !wins.length || !!abort;
}

function openExport() {
  if (!app.media) return;
  if (!app.data.windows.length) { app.toast('Create a window first: drag on a track or press N.'); return; }
  app.stop();
  xScope.value = app.selected && xScope.value === 'sel' ? 'sel' : xScope.value === 'sel' ? 'all' : xScope.value;
  summarize();
  $('x-progress').hidden = true;
  dlg.showModal();
}
$('export').onclick = openExport;
[xScope, xFormat].forEach(el => el.addEventListener('change', summarize));
dlg.addEventListener('cancel', e => { if (abort) e.preventDefault(); });
$('x-cancel').addEventListener('click', e => {
  if (abort) { e.preventDefault(); abort.abort(); }
});

$('x-go').onclick = async () => {
  const wins = exportWindows();
  if (!wins.length || abort) return;
  const opts: ExportOptions = { windows: wins, format: xFormat.value as Format, quality: xQuality.value as Quality, manifest: $<HTMLInputElement>('x-manifest').checked };
  let writer;
  const base = app.media!.file.name.replace(/\.[^.]+$/, '');
  try {
    if (xDest.value === 'folder') {
      const dir = await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'readwrite', id: 'video-slicer-export' });
      writer = await folderWriter(dir);
    } else writer = await zipWriter(`${base}_slices.zip`);
  } catch (e) {
    if ((e as DOMException)?.name !== 'AbortError') app.toast(String((e as Error)?.message ?? e), 'error');
    return;
  }
  abort = new AbortController();
  const prog = $('x-progress'), bar = prog.querySelector<HTMLElement>('.bar > div')!, txt = prog.querySelector<HTMLElement>('span')!;
  prog.hidden = false;
  $('x-cancel').textContent = 'Cancel';
  summarize();
  const total = wins.reduce((s, w) => s + w.len, 0);
  let done = 0, lastClip = -1, clipBase = 0;
  const t0 = performance.now();
  try {
    await runExport(app, opts, writer, p => {
      if (p.clip !== lastClip) { clipBase = done; lastClip = p.clip; }
      done = clipBase + p.frame;
      bar.style.width = `${(done / total) * 100}%`;
      const fps = done / ((performance.now() - t0) / 1000);
      txt.textContent = `Clip ${p.clip + 1}/${p.clips} · ${p.name} · frame ${p.frame}/${p.frames} · ${fps.toFixed(0)} fps`;
    }, abort.signal);
    txt.textContent = `Done: ${wins.length} clip${wins.length > 1 ? 's' : ''}, ${total} frames in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
    bar.style.width = '100%';
    app.toast('Export finished.');
  } catch (e) {
    const cancelled = (e as DOMException)?.name === 'AbortError';
    txt.textContent = cancelled ? 'Cancelled.' : `Failed: ${String((e as Error)?.message ?? e)}`;
    if (!cancelled) { console.error(e); app.toast(txt.textContent, 'error'); }
  } finally {
    abort = null;
    $('x-cancel').textContent = 'Close';
    summarize();
  }
};

app.invalidate(true);

// Handy for debugging from the console.
(window as unknown as { slicer: App }).slicer = app;
if (import.meta.env.DEV) {
  void Promise.all([import('./model/render'), import('./export/export'), import('./model/project')]).then(([render, exp, project]) => {
    (window as unknown as { slicerDebug: unknown }).slicerDebug = { ...render, ...exp, ...project };
  });
}
