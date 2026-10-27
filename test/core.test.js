import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalExpr } from '../src/ffexpr.js';
import { parseFiltergraph } from '../src/filtergraph.js';
import { fitCurve, evalProp } from '../src/fit.js';
import { GraphReader, levelsFromEq } from '../src/ffreader.js';
import { parseTextShadow } from '../src/hfreader.js';
import { P, makeLayer, newId } from '../src/timeline.js';

test('ffmpeg expressions', () => {
  assert.equal(evalExpr('1+2*3^2'), 19);
  assert.equal(evalExpr('-2^2'), -4);
  assert.equal(evalExpr("clip((on-34)/5,0,1)", { on: 36 }), 0.4);
  assert.equal(evalExpr('gte(n,12)+between(n,5,11)*eq(mod(n,2),1)', { n: 7 }), 1);
  assert.equal(evalExpr('if(lt(on,6),1,min(14,pow(1.9,on-6)))', { on: 3 }), 1);
  assert.ok(Math.abs(evalExpr('1280-1280/zoom', { zoom: 2 }) - 640) < 1e-9);
  assert.throws(() => evalExpr('foo(1)'));
});

test('filtergraph parsing keeps quoted commas and colons', () => {
  const [c] = parseFiltergraph("[a][b]overlay=x='clip(300+(n-4)*220,0,1660)':y=0:enable='between(n,4,9)'[o]");
  assert.deepEqual(c.inputs, ['a', 'b']);
  assert.deepEqual(c.outputs, ['o']);
  assert.equal(c.filters[0].args.x, 'clip(300+(n-4)*220,0,1660)');
  assert.equal(c.filters[0].args.enable, 'between(n,4,9)');
  const [d] = parseFiltergraph('[0:v]scale=2560:1440,split=3[x][y][z]');
  assert.equal(d.filters[0].args.w, '2560');
  assert.equal(d.filters[1].args.outputs, '3');
  assert.deepEqual(d.outputs, ['x', 'y', 'z']);
});

test('fitter: exponential push stays within tolerance with few keys', () => {
  const z = Array.from({ length: 40 }, (_, f) => 75 * (1 + 0.18 * (1 - Math.exp(-f / 7))));
  const p = fitCurve(z, { tol: 0.03 });
  assert.ok(p.keys.length <= 4, `${p.keys.length} keys`);
  z.forEach((v, f) => assert.ok(Math.abs(evalProp(p, f) - v) <= 0.03 + 1e-9, `frame ${f}`));
});

test('fitter: fades are linear, one-frame cuts are holds', () => {
  assert.deepEqual(fitCurve([0, 0, 33.33, 66.67, 100, 100], { tol: 0.5 }).keys.map((k) => [k.f, k.out]), [[1, 'linear'], [4, 'linear']]);
  const h = fitCurve([0, 0, 0, 100, 100, 0, 0], { tol: 0.5 });
  assert.deepEqual(h.keys.map((k) => [k.f, k.v, k.out]), [[0, 0, 'hold'], [3, 100, 'hold'], [5, 0, 'hold']]);
  assert.deepEqual(fitCurve([5, 5, 5]), { value: 5 });
});

test('eq brightness/contrast as Levels', () => {
  const full = levelsFromEq(0.55, 0.45, 1, 'pc').props;
  assert.ok(Math.abs(full.outputBlack.value - 0.675) < 1e-9);
  assert.ok(Math.abs(full.inputWhite.value - 0.5909) < 1e-3);
  assert.equal(full.outputWhite.value, 1);
  // TV-range luma (after format=yuv420p) lifts the blacks further.
  const tv = levelsFromEq(0.6, 0.4).props;
  assert.ok(Math.abs(tv.outputBlack.value - 0.6694) < 1e-3);
});

test('text-shadow parsing', () => {
  const s = parseTextShadow('rgba(40, 120, 255, 0.92) -7px 0px 0px, rgba(0, 0, 0, 0.45) 0px 6px 30px');
  assert.equal(s.length, 2);
  assert.equal(s[0].dx, -7);
  assert.equal(s[0].alpha, 0.92);
  assert.equal(s[1].blur, 30);
});

// A still photo input as the CLI would make it.
function still(w, h, name) {
  const id = newId('ftg');
  return () => ({
    id: newId('s'), label: null, w, h, frames: 1, clip: false,
    layers: [makeLayer({ name, kind: 'footage', source: id, w, h, outFrame: 1, anchor: P([w / 2, h / 2]), position: P([w / 2, h / 2]) })],
  });
}

test('graph: push, zoom blur, flash frames and a cut', () => {
  const r = new GraphReader({ fps: 25 });
  r.inputs = [still(2560, 1440, 'photo'), still(2560, 1440, 'money')];
  const blur = Array.from({ length: 3 }, (_, i) => `[a${i + 1}]zoompan=z='1+0.05*${i + 1}*clip((on-6)/3,0,1)':x='1000-1000/zoom':y='580-580/zoom':d=1:s=1920x1080[b${i + 1}]`);
  const graph = [
    "[0:v]loop=loop=-1:size=1,trim=duration=0.4,zoompan=z='1+0.18*(1-exp(-on/7))':x='1250-1250/zoom':y='740-740/zoom':d=1:s=1920x1080,split=4[a0][a1][a2][a3]",
    "[a0]zoompan=z='1':x='0':y='0':d=1:s=1920x1080[b0]",
    ...blur,
    "[b0][b1][b2][b3]mix=inputs=4,eq=brightness=0.45:contrast=0.55:enable='eq(n,0)'[A]",
    '[1:v]loop=loop=-1:size=1,trim=duration=0.2,hue=s=0[B]',
    '[A][B]concat=n=2:v=1:a=0,noise=alls=4:allf=t[v]',
  ].join(';');
  const out = r.read(graph, 'v');
  assert.equal(out.frames, 15);
  const names = out.layers.map((l) => l.name);
  assert.deepEqual(names, ['A', 'money', 'Grain']); // a single plain layer joins the cut without a precomp
  const shotA = r.comps[out.layers[0].source];
  assert.deepEqual(shotA.layers.map((l) => [l.name, l.kind, l.inFrame, l.outFrame]), [
    ['photo', 'footage', 0, 10],
    ['Zoom blur', 'adjustment', 6, 10], // from the last unblurred frame, amount 0
    ['Flash f0', 'adjustment', 0, 1],
  ]);
  // The push folded into the photo layer: pinned at (1250, 740), scale keys.
  const photo = shotA.layers[0];
  assert.deepEqual(photo.anchor.value, [1250, 740]);
  assert.deepEqual(photo.position.value, [937.5, 555]);
  assert.equal(photo.scale.keys[0].v[0], 75);
  assert.deepEqual(shotA.layers[1].effects[0].props.center.value, [1000, 580]);
  // Desaturation on a single untransformed layer goes on the layer itself.
  const shotB = out.layers[1];
  assert.equal(shotB.kind, 'footage');
  assert.equal(shotB.inFrame, 10);
  assert.equal(shotB.effects[0].type, 'tint');
});

test('graph: overlay enable windows become in/out points', () => {
  const r = new GraphReader({ fps: 25 });
  r.inputs = [still(1920, 1080, 'a'), still(1920, 1080, 'b')];
  const out = r.read("[0:v]loop=loop=-1:size=1,trim=end_frame=20[x];[1:v]loop=loop=-1:size=1[y];[x][y]overlay=enable='eq(n,5)+gte(n,11)'[v]", 'v');
  assert.deepEqual(out.layers.map((l) => [l.name, l.inFrame, l.outFrame]), [['a', 0, 20], ['b', 5, 6], ['b', 11, 20]]);
});
