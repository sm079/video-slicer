import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapLen, minLen, isAllowed, cropAt, outputSize, outputRegion, normalizeCrop, fullCrop, fits, freeSpan, newTrack, emptyProject,
  sanitizeProject, presetFrom, presetMatches, presetValues, sanitizePresets, PRESET_DEFAULTS, type Win, type Track,
} from '../src/model/project.ts';
import { Timebase, detectFps, parseFps } from '../src/media/timebase.ts';
import { buildIndex } from '../src/media/demux.ts';

const crop = (x: number, y: number, w: number, h: number, r = 0) => ({ x, y, w, h, r });

test('length rules', () => {
  const wan = { a: 4, b: 1 };
  assert.equal(minLen(wan), 1);
  assert.equal(minLen({ a: 4, b: 0 }), 4);
  assert.equal(minLen({ a: 1, b: 0 }), 1);
  assert.ok(isAllowed(wan, 81) && !isAllowed(wan, 80));
  assert.equal(snapLen(wan, 80), 81);
  assert.equal(snapLen(wan, 78), 77);
  assert.equal(snapLen(wan, 80, 79), 77, 'never past max');
  assert.equal(snapLen(wan, 80, 0), null, 'nothing fits');
  assert.equal(snapLen(wan, 80, Infinity, 'down'), 77);
  assert.equal(snapLen(wan, 78, Infinity, 'up'), 81);
  assert.equal(snapLen({ a: 1, b: 0 }, 37), 37);
  assert.equal(snapLen({ a: 8, b: 1 }, 3), 1);
});

test('crop keys interpolate and hold', () => {
  const w: Win = { id: 'w', track: 't', start: 10, len: 21, animate: true, keys: [{ f: 0, c: crop(0, 0, 100, 50) }, { f: 20, c: crop(100, 50, 200, 100, 10) }] };
  assert.deepEqual(cropAt(w, 10), crop(50, 25, 150, 75, 5));
  assert.deepEqual(cropAt(w, -5), w.keys[0].c);
  assert.deepEqual(cropAt(w, 99), w.keys[1].c);
});

test('output size', () => {
  const t: Track = { ...newTrack(0), div: 16 };
  const w: Win = { id: 'w', track: t.id, start: 0, len: 1, animate: false, keys: [{ f: 0, c: crop(0, 0, 1000, 563) }] };
  assert.deepEqual(outputSize(w, t), { w: 992, h: 560 });
  assert.deepEqual(outputSize(w, { ...t, outW: 832, outH: 480 }), { w: 832, h: 480 });
  assert.deepEqual(outputSize(w, { ...t, outW: 496 }), { w: 496, h: 288 });
});

test('normalizeCrop keeps crops valid', () => {
  // Unrotated: inside the frame on whole pixels; sides are not snapped to the output's multiples.
  assert.deepEqual(normalizeCrop(crop(-20.4, 700, 333, 100), 1280, 720, null), crop(0, 620, 333, 100));
  // Aspect ratio locked, larger than the frame.
  const c = normalizeCrop(crop(0, 0, 4000, 4000), 1280, 720, 16 / 9);
  assert.equal(c.w, 1280);
  assert.equal(c.h, 720);
  // Rotated crops may leave the frame (black fill) and the angle wraps.
  const r = normalizeCrop(crop(-100, -100, 400, 200, 370), 1280, 720, null);
  assert.equal(r.r, 10);
  assert.equal(r.x, -100);
  assert.deepEqual(fullCrop(1920, 1080, 1), crop(420, 0, 1080, 1080));
});

test('output region trims the crop to the output shape', () => {
  const t: Track = { ...newTrack(0), div: 16 };
  // Size from the crop: the centre 992×560 on whole pixels, copied 1:1.
  const c = crop(10, 20, 1001, 563);
  assert.deepEqual(outputRegion(c, c, t), crop(14, 21, 992, 560));
  // A later key at twice the size scales the trimmed area with it.
  assert.deepEqual(outputRegion(crop(0, 0, 2002, 1126), c, t), crop(9, 3, 1984, 1120));
  // Rotated crops keep their centre.
  const r = outputRegion(crop(0, 0, 1001, 563, 30), crop(0, 0, 1001, 563, 30), t);
  assert.equal(r.x + r.w / 2, 500.5);
  assert.equal(r.r, 30);
  // Fixed size: the crop already has the output's shape.
  assert.deepEqual(outputRegion(crop(0, 0, 832, 480), crop(0, 0, 832, 480), { ...t, outW: 832, outH: 480 }), crop(0, 0, 832, 480));
});

test('presets leave out defaults and fill them back in', () => {
  const t: Track = { ...newTrack(0), rule: { a: 4, b: 1 }, outW: 832, outH: 480, div: 16 };
  const p = presetFrom('Wan', 16, t);
  assert.deepEqual(p, { name: 'Wan', fps: 16, outW: 832, outH: 480, rule: { a: 4, b: 1 }, div: 16 });
  assert.ok(presetMatches(p, 16, t));
  assert.ok(!presetMatches(p, null, t), 'fps differs');
  assert.deepEqual(presetValues({ name: 'empty' }), PRESET_DEFAULTS);
  assert.ok(presetMatches({ name: 'empty' }, null, newTrack(0)));
  const list = sanitizePresets([{ name: ' A ', outW: -3, rule: { a: 8, b: 1 }, fps: 'x' }, { outW: 5 }, null]);
  assert.deepEqual(list, [{ name: 'A', rule: { a: 8, b: 1 } }]);
  assert.deepEqual(sanitizePresets('junk'), []);
});

test('overlap checks', () => {
  const p = emptyProject();
  const t = p.tracks[0].id;
  p.windows.push({ id: 'a', track: t, start: 10, len: 10, animate: false, keys: [{ f: 0, c: crop(0, 0, 2, 2) }] });
  p.windows.push({ id: 'b', track: t, start: 40, len: 10, animate: false, keys: [{ f: 0, c: crop(0, 0, 2, 2) }] });
  assert.ok(fits(p, t, 20, 20, 100));
  assert.ok(!fits(p, t, 19, 5, 100));
  assert.ok(fits(p, t, 15, 10, 100, 'a'), 'ignores itself');
  assert.deepEqual(freeSpan(p, t, 25, 100), [20, 40]);
  assert.deepEqual(freeSpan(p, t, 12, 100), [12, 12]);
  assert.deepEqual(freeSpan(p, t, 60, 100), [50, 100]);
});

test('sanitizeProject rejects junk and fills defaults', () => {
  assert.throws(() => sanitizeProject({}));
  const p = sanitizeProject({ tracks: [{ id: 'x', rule: { a: 4, b: 1 } }], windows: [{ track: 'x', start: 3, len: 81, keys: [{ f: 0, c: { x: 1, y: 2, w: 3, h: 4 } }] }, { track: 'missing', keys: [] }] });
  assert.equal(p.windows.length, 1);
  assert.equal(p.tracks[0].div, 2);
  assert.equal(p.windows[0].keys[0].c.r, 0);
});

/** Index of a CFR stream given in decode order with B-frames (I P B B P B B …). */
function cfrIndex(n: number, fps: number, gop = 12) {
  const order: { ts: number; key: boolean }[] = [];
  for (let i = 0; i < n; i++) order.push({ ts: i / fps, key: i % gop === 0 });
  return buildIndex(order.reverse(), 1 / fps);
}

test('buildIndex sorts to presentation order and groups GOPs', () => {
  const ix = cfrIndex(30, 30);
  assert.equal(ix.count, 30);
  assert.equal(ix.pts[5], 5 / 30);
  assert.equal(ix.gop[11], 0);
  assert.equal(ix.gop[12], 1);
  assert.ok(Math.abs(ix.end - 1) < 1e-9);
  const lead = buildIndex([{ ts: -0.1, key: true }, { ts: 0, key: false }, { ts: 0.1, key: false }], 0.1);
  assert.equal(lead.first, 1, 'edit-list lead-in is hidden');
});

test('timebase: native and conformed (same picks as ffmpeg fps filter)', () => {
  const ix = cfrIndex(600, 30);
  const fps = detectFps(ix);
  assert.equal(fps, 30);
  const native = new Timebase(ix, null, fps);
  assert.equal(native.count, 600);
  assert.equal(native.src(123), 123);
  const tb24 = new Timebase(ix, 24, fps);
  assert.equal(tb24.count, 480);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(i => tb24.src(i)), [0, 1, 3, 4, 5, 6]);
  const tb60 = new Timebase(ix, 60, fps);
  assert.deepEqual([0, 1, 2, 3].map(i => tb60.src(i)), [0, 0, 1, 1]);
  assert.equal(tb24.frameAt(tb24.time(100)), 100);
  assert.equal(native.frameAt(native.time(77)), 77);
  assert.equal(detectFps(cfrIndex(300, 30000 / 1001)), 30000 / 1001);
});

test('parseFps', () => {
  assert.equal(parseFps('30000/1001'), 30000 / 1001);
  assert.equal(parseFps(' 24 '), 24);
  assert.equal(parseFps('abc'), null);
  assert.equal(parseFps('0'), null);
});
