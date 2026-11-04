// Runs a generated .jsx against a small mock of the After Effects scripting
// API. This catches script errors and checks what would be built; it can't
// check how AE renders it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { writeJsx } from '../src/jsxwriter.js';
import { P, makeLayer } from '../src/timeline.js';
import { mockAE } from './mock_ae.js';
import { reportWarnings } from '../src/aerun.js';

test('generated jsx runs and builds the comps', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf2ae-'));
  const img = path.join(dir, 'photo.png');
  fs.writeFileSync(img, 'x');
  const tl = {
    name: 'Test Shot', fps: 25, main: 'c1', notes: [],
    footage: { f1: { name: 'photo.png', file: img, path: img, w: 100, h: 100, still: true } },
    comps: {
      c1: { name: 'Test Shot', w: 1920, h: 1080, frames: 10, layers: [
        makeLayer({ name: 'Inner', kind: 'comp', source: 'c2', outFrame: 10 }),
        makeLayer({ name: 'Flash f0', kind: 'adjustment', w: 1920, h: 1080, inFrame: 0, outFrame: 1,
          effects: [{ type: 'levels', name: 'Levels', props: { outputBlack: P(0.6) } }] }),
      ] },
      c2: { name: 'Inner', w: 2560, h: 1440, frames: 10, layers: [
        makeLayer({ name: 'photo', kind: 'footage', source: 'f1', outFrame: Infinity,
          scale: { keys: [{ f: 0, v: [75, 75], out: 'bezier', easeOut: [{ speed: 40, influence: 22 }, { speed: 40, influence: 22 }] },
            { f: 9, v: [88, 88], out: 'linear', easeIn: [{ speed: 1, influence: 50 }, { speed: 1, influence: 50 }] }] } }),
        makeLayer({ name: 'TITLE', kind: 'text', outFrame: 10,
          text: { text: 'TITLE', font: 'TeXGyreHeros-Bold', size: 100, fill: [1, 1, 1], tracking: 0, justify: 'right' },
          opacity: { keys: [{ f: 1, v: 0, out: 'linear' }, { f: 4, v: 100, out: 'linear' }] } }),
        makeLayer({ name: 'TITLE – fringe blue', kind: 'text', outFrame: 10, parent: 'TITLE',
          text: { text: 'TITLE', font: 'TeXGyreHeros-Bold', size: 100, fill: [1, 1, 1], tracking: 0, justify: 'right' },
          expressions: { sourceText: 'thisComp.layer("TITLE").text.sourceText' },
          effects: [{ type: 'fill', name: 'Fill', props: { color: P([0, 0.5, 1]) } }] }),
      ] },
    },
  };
  const { jsxPath } = writeJsx(tl, dir);
  const { ctx, items, files } = mockAE(dir);
  vm.runInNewContext(fs.readFileSync(jsxPath, 'utf8'), ctx);

  const main = items.find((c) => c.name === 'Test Shot');
  const inner = items.find((c) => c.name === 'Inner');
  assert.deepEqual(main.layerList.map((l) => l.name), ['Flash f0', 'Inner']); // top first, as in AE
  const photo = inner.layerList.find((l) => l.name === 'photo');
  assert.equal(photo.outPoint, 0.4);
  const scale = photo.property('ADBE Transform Group').property('ADBE Scale');
  assert.equal(scale.keys.length, 2);
  assert.deepEqual([...scale.keys[0].v], [75, 75, 100]); // arrays from the vm have another Array prototype
  assert.equal(scale.keys[0].ease[1][0].speed, 40);
  const fringe = inner.layerList.find((l) => l.name === 'TITLE – fringe blue');
  assert.equal(fringe.parent.name, 'TITLE');
  const report = Object.values(files)[0].join('\n');
  assert.ok(!/cannot|Error/.test(report), report);
  assert.match(ctx.alerted, /built "Test Shot"/);
});

const PUNCH = fileURLToPath(new URL('../examples/punch_demo/shot.json', import.meta.url));
const hasMedia = fs.existsSync(path.join(path.dirname(PUNCH), 'src/solvay.png'));

test('punch demo converts and its jsx runs cleanly', { skip: !hasMedia && 'run examples/punch_demo/fetch.sh first' }, async () => {
  const { convert } = await import('../src/cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf2ae-punch-'));
  const { jsxPath } = await convert(PUNCH, dir);
  const { ctx, items, files } = mockAE(dir);
  vm.runInNewContext(fs.readFileSync(jsxPath, 'utf8'), ctx);
  const names = items.map((c) => c.name);
  // One precomp per title line groups the text with its shadow copies.
  assert.deepEqual(names.sort(), ['EINSTEIN', 'Photo + Punch Title', 'Punch Demo – Einstein vs Bohr', 'Punch Title', 'Shot 1 – Einstein push', 'Shot 2 – Money', 'VS. BOHR'].sort());
  const report = Object.values(files)[0].join('\n');
  const warnings = reportWarnings(report);
  assert.deepEqual(warnings, []);
});

test('punch title rebuilt from the timeline matches the HyperFrames HTML', { skip: !hasMedia && 'run examples/punch_demo/fetch.sh first' }, async () => {
  const { convert } = await import('../src/cli.js');
  const { verify } = await import('../src/verify.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf2ae-verify-'));
  await convert(PUNCH, dir);
  const r = await verify(dir, { comp: 'Punch Title', ref: path.join(path.dirname(PUNCH), 'src/punch_title.html') });
  // 40 dB and up looks identical; a missing shadow or a 1px slip drops well below. (It was 54.5
  // before tracking was rounded to the whole numbers After Effects accepts: -28.57 -> -29.)
  assert.ok(r.psnr.min >= 40, `worst frame ${r.worstFrames[0].frame}: ${r.psnr.min.toFixed(1)} dB`);
});

const MOTION = fileURLToPath(new URL('../examples/hf_motion/', import.meta.url));
const hasMotion = fs.existsSync(path.join(MOTION, 'src/a1_iconic.mp4'));

test('hf motion renders map to text animators, a camera and a track matte', { skip: !hasMotion && 'run examples/hf_motion/fetch.sh first' }, async () => {
  const { convert } = await import('../src/cli.js');
  const built = {};
  for (const n of ['a1_iconic', 'a3_words', 'a5_solvay']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hf2ae-${n}-`));
    const { jsxPath } = await convert(path.join(MOTION, `${n}.json`), dir);
    const { ctx, items, files } = mockAE(dir);
    vm.runInNewContext(fs.readFileSync(jsxPath, 'utf8'), ctx);
    const report = Object.values(files)[0].join('\n');
    const warnings = reportWarnings(report);
    assert.deepEqual(warnings, [], n);
    built[n] = items.find((c) => c.name === n && c.layerList.some((l) => l.kind !== 'av' || l.name !== n)) || items[0];
  }
  const iconic = built.a1_iconic;
  const text = iconic.layerList.find((l) => l.name === 'ICONIC');
  assert.equal(text.threeDPerChar, true);
  const animator = text.property('ADBE Text Properties').property('ADBE Text Animators').children[0];
  assert.equal(animator.name, 'Animator 1');
  const start = animator.property('ADBE Text Selectors').children[0].property('ADBE Text Percent Start');
  assert.ok(start.keys.length >= 2, 'range selector start is keyed');
  assert.ok(iconic.camera, 'a camera stands in for CSS perspective');
  const v = built.a5_solvay.layerList.find((l) => l.name === 'v');
  assert.equal(v.trackMatte.layer.name, 'SOLVAY');
});

test('hf vector renders map to shape layers, merge paths, gradients and masks', { skip: !hasMotion && 'run examples/hf_motion/fetch.sh first' }, async () => {
  const { convert } = await import('../src/cli.js');
  const out = {};
  for (const n of ['a6_shapes', 'a7_gradients', 'a8_paintpath', 'a10_eases']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hf2ae-${n}-`));
    const { jsxPath } = await convert(path.join(MOTION, `${n}.json`), dir);
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
    const { ctx, files } = mockAE(dir);
    vm.runInNewContext(fs.readFileSync(jsxPath, 'utf8'), ctx);
    const report = Object.values(files)[0].join('\n');
    const warnings = reportWarnings(report);
    assert.deepEqual(warnings, [], n);
    out[n] = Object.values(data.comps).flatMap((c) => c.layers);
  }
  const find = (n, name) => out[n].find((l) => l.name === name);
  // union / intersect / exclude -> a group ending in Merge Paths
  const flat = (items) => items.flatMap((it) => (it.type === 'group' ? [it, ...flat(it.items)] : [it]));
  for (const [id, mode] of [['pu', 'add'], ['pi', 'intersect'], ['px', 'exclude']]) {
    assert.ok(flat(find('a6_shapes', id).contents).some((it) => it.type === 'merge' && it.mode === mode), id);
  }
  assert.ok(flat(find('a6_shapes', 'op').contents).some((it) => it.type === 'offset'));
  const sides = flat(find('a6_shapes', 'lp').contents).find((it) => it.type === 'star').points;
  assert.deepEqual(sides.keys.map((k) => k.v), [3, 4, 5, 6, 7, 8]);
  assert.ok(sides.keys.every((k) => k.out === 'hold'));
  // gradients: radial driven by Radius, conic by Angle
  assert.equal(find('a7_gradients', 'rad').effects[0].props.mode.value, 'radial');
  assert.ok(find('a7_gradients', 'rad').effects[0].props.radius.keys);
  // a conic gradient sits in a box-sized precomp that crops its larger solid
  assert.equal(find('a7_gradients', 'con').kind, 'comp');
  assert.equal(find('a7_gradients', 'con – gradient').effects[0].props.mode.value, 'conic');
  // paintPath -> a keyed mask; matchState -> keyed size and colour
  assert.ok(find('a8_paintpath', 'stroke').masks[0].path.keys);
  const bx = flat(find('a8_paintpath', 'bx').contents);
  assert.ok(bx.find((it) => it.type === 'rect').size.keys);
  assert.ok(bx.find((it) => it.type === 'fill').color.keys);
});

test('whip and fx map to eased slides, a blur layer and an RGB-split rig', { skip: !hasMotion && 'run examples/hf_motion/fetch.sh first' }, async () => {
  const { convert } = await import('../src/cli.js');
  const out = {};
  for (const n of ['w2_domwhip', 'x2_cutdistort']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hf2ae-${n}-`));
    const { jsxPath } = await convert(path.join(MOTION, `${n}.json`), dir);
    const { ctx, files } = mockAE(dir);
    vm.runInNewContext(fs.readFileSync(jsxPath, 'utf8'), ctx);
    const report = Object.values(files)[0].join('\n');
    const warnings = reportWarnings(report);
    assert.deepEqual(warnings, [], n);
    out[n] = Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8')).comps).flatMap((c) => c.layers);
  }
  // whip: two Easy Ease keys at 3.0s and 3.4s (24fps), the incoming layer from +1280
  const im = out.w2_domwhip.find((l) => l.name === 'im');
  assert.deepEqual(im.position.keys.map((k) => [k.f, k.v[0]]), [[72, 1920], [81.6, 640]]);
  assert.ok(Math.abs(im.position.keys[0].easeOut.influence - 100 / 3) < 1e-6);
  const blur = out.w2_domwhip.find((l) => l.name === 'Whip blur');
  assert.equal(blur.kind, 'adjustment');
  assert.deepEqual(blur.effects[0].props.length.keys.map((k) => k.f), [72, 76.8, 81.6]);
  // fx: dissolve blend, three channel copies, Optics Compensation
  assert.equal(out.x2_cutdistort.find((l) => l.name === 'Blend top').blend, 'dissolve');
  assert.deepEqual(out.x2_cutdistort.filter((l) => l.name.startsWith('RGB split')).map((l) => l.effects[0].props.keep.value).sort(), ['blue', 'green', 'red']);
  assert.equal(out.x2_cutdistort.find((l) => l.name === 'Lens distortion').effects[0].type, 'opticsCompensation');
});

test('a conic gradient keeps its centre, and its mask and sweep stay on the box', { skip: !hasMotion && 'run examples/hf_motion/fetch.sh first' }, async () => {
  const { convert } = await import('../src/cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf2ae-conic-'));
  const shot = path.join(MOTION, 'a7b_conic_edge.json');
  const { jsxPath } = await convert(shot, dir);
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
  const { ctx, files } = mockAE(dir);
  vm.runInNewContext(fs.readFileSync(jsxPath, 'utf8'), ctx);
  assert.deepEqual(reportWarnings(Object.values(files)[0].join('\n')), []);
  const layers = Object.values(data.comps).flatMap((c) => c.layers);
  const outer = layers.find((l) => l.name === 'con'), inner = layers.find((l) => l.name === 'con – gradient');
  assert.deepEqual(inner.position.value, [126, 84]); // 30% 20% of 420x420
  assert.equal(inner.w, 894); // twice the 447px to the farthest corner, from (126, 84)
  assert.deepEqual(inner.effects.map((e) => e.type), ['gradient']);
  assert.deepEqual(outer.effects.map((e) => e.type), ['lightSweep']);
  assert.equal(outer.masks.length, 1);
  assert.equal(inner.masks, undefined);
});

test('batch mode: Cancel on the save prompt stops before anything is built or saved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf2ae-cancel-'));
  const { jsxPath } = writeJsx({
    name: 'Cancel', fps: 25, main: 'c', footage: {},
    comps: { c: { id: 'c', name: 'Cancel', w: 100, h: 100, frames: 10, layers: [] } }, notes: [],
  }, dir);
  const { ctx, items } = mockAE(dir);
  let saved = false;
  ctx.HF2AE_BATCH = { base: dir, save: path.join(dir, 'project.aep') };
  ctx.app.project.close = () => false;
  ctx.app.project.save = () => { saved = true; };
  vm.runInNewContext(fs.readFileSync(jsxPath, 'utf8'), ctx);
  assert.match(ctx.$.global.HF2AE_RESULT, /^SCRIPT ERROR/);
  assert.equal(items.length, 0);
  assert.equal(saved, false);
});

test('the report reaches the warning checks, so they can fail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf2ae-report-'));
  const layer = makeLayer({ name: 'a', kind: 'solid', w: 10, h: 10, color: [1, 1, 1], outFrame: 10, effects: [{ type: 'nope', name: 'x', props: {} }] });
  const { jsxPath } = writeJsx({
    name: 'Report', fps: 25, main: 'c', footage: {},
    comps: { c: { id: 'c', name: 'Report', w: 100, h: 100, frames: 10, layers: [layer] } }, notes: [],
  }, dir);
  const { ctx, files } = mockAE(dir);
  vm.runInNewContext(fs.readFileSync(jsxPath, 'utf8'), ctx);
  assert.deepEqual(reportWarnings(Object.values(files)[0].join('\n')), ['Report / a: unknown effect type nope']);
  assert.match(ctx.alerted, /with 1 warnings/);
});
