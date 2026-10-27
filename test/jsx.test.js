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
  const warnings = report.split('\n').filter((l) => /: /.test(l) && !/^(effect |  |hf2ae report|After Effects)/.test(l));
  assert.deepEqual(warnings, []);
});

test('punch title rebuilt from the timeline matches the HyperFrames HTML', { skip: !hasMedia && 'run examples/punch_demo/fetch.sh first' }, async () => {
  const { convert } = await import('../src/cli.js');
  const { verify } = await import('../src/verify.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf2ae-verify-'));
  await convert(PUNCH, dir);
  const r = await verify(dir, { comp: 'Punch Title', ref: path.join(path.dirname(PUNCH), 'src/punch_title.html') });
  // 50 dB and up is pixel-identical to the eye; a missing shadow or a 1px slip drops well below.
  assert.ok(r.psnr.min >= 50, `worst frame ${r.worstFrames[0].frame}: ${r.psnr.min.toFixed(1)} dB`);
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
    const warnings = report.split('\n').filter((l) => /: /.test(l) && !/^(effect |  |hf2ae report|After Effects)/.test(l));
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
