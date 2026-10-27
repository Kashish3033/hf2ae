// A small mock of the After Effects scripting API, enough to run a
// generated .jsx and inspect what it would build. It can't check rendering.

import fs from 'node:fs';
import path from 'node:path';

const PVT = { NO_VALUE: 0, ThreeD_SPATIAL: 1, ThreeD: 2, TwoD_SPATIAL: 3, TwoD: 4, OneD: 5, COLOR: 6 };

class Prop {
  constructor(name, type = PVT.OneD, children = []) {
    this.name = name; this.matchName = name; this.propertyValueType = type;
    this.value = type === PVT.OneD ? 0 : [0, 0]; this.keys = []; this.expression = '';
    this.children = children; this.numProperties = children.length;
  }
  property(n) { return typeof n === 'number' ? this.children[n - 1] : this.children.find((c) => c.matchName === n || c.name === n) || null; }
  addProperty(match) {
    const p = new LazyProp(match, PVT.NO_VALUE, []);
    this.children.push(p); this.numProperties++;
    return p;
  }
  setValue(v) { if (this.keys.length) throw new Error(`${this.name}: setValue on keyed property`); this.value = v; }
  setValueAtTime(t, v) { this.keys.push({ t, v }); this.keys.sort((a, b) => a.t - b.t); }
  nearestKeyIndex(t) { return this.keys.findIndex((k) => Math.abs(k.t - t) < 1e-6) + 1; }
  setTemporalEaseAtKey(i, a, b) {
    const dims = this.propertyValueType === PVT.ThreeD ? 3 : this.propertyValueType === PVT.TwoD ? 2 : 1;
    if (a.length !== dims || b.length !== dims) throw new Error(`${this.name}: ease needs ${dims} dims`);
    this.keys[i - 1].ease = [a, b];
  }
  setInterpolationTypeAtKey(i, a, b) { this.keys[i - 1].interp = [a, b]; }
  setSpatialTangentsAtKey() {}
}

// Effects, text animators and their groups make any property asked for: the
// real lists only exist in AE.
class LazyProp extends Prop {
  property(n) {
    if (typeof n === 'number') return this.children[n - 1];
    let c = this.children.find((x) => x.matchName === n || x.name === n);
    if (!c) { c = new LazyProp(n); this.children.push(c); this.numProperties++; }
    return c;
  }
}

function makeLayerMock(kind, source) {
  const tr = new Prop('ADBE Transform Group', PVT.NO_VALUE, [
    new Prop('ADBE Anchor Point', PVT.TwoD_SPATIAL), new Prop('ADBE Position', PVT.TwoD_SPATIAL),
    new Prop('ADBE Scale', PVT.ThreeD), new Prop('ADBE Rotate Z'), new Prop('ADBE Opacity'),
  ]);
  const doc = { text: '', font: 'ArialMT' };
  const textDoc = new Prop('ADBE Text Document');
  textDoc.value = doc;
  textDoc.setValue = function (v) { this.value = { ...v }; };
  const groups = [tr, new Prop('ADBE Effect Parade', PVT.NO_VALUE, []), new LazyProp('ADBE Text Properties', PVT.NO_VALUE, [textDoc]),
    new LazyProp('ADBE Camera Options Group', PVT.NO_VALUE, [])];
  return {
    kind, source, name: '', startTime: 0, inPoint: 0, outPoint: 0,
    property: (n) => groups.find((g) => g.matchName === n),
    setParentWithJump(p) { this.parent = p; },
    setTrackMatte(m, type) { this.trackMatte = { layer: m, type }; },
  };
}

export function mockAE(baseDir) {
  const items = [];
  const comp = (name, w, h, par, dur, fps) => {
    const c = { name, w, h, dur, fps, layerList: [], openInViewer() {} };
    const add = (l) => { c.layerList.unshift(l); return l; };
    c.layers = {
      add: (src) => add(makeLayerMock('av', src)),
      addText: (t) => add(makeLayerMock('text', t)),
      addSolid: (col, n, sw, sh) => add({ ...makeLayerMock('solid'), w: sw, h: sh }),
      addCamera: (n) => { const cam = add(makeLayerMock('camera')); cam.name = n; c.camera = cam; return cam; },
    };
    items.push(c);
    return c;
  };
  const project = { items: { addFolder: (n) => ({ name: n }), addComp: comp }, importFile: (io) => ({ file: io.file }) };
  const files = {};
  // ExtendScript's File works with or without `new`.
  function File(p) {
    if (!(this instanceof File)) return new File(p);
    this.fsName = p; this.exists = fs.existsSync(p); this.parent = { fsName: baseDir };
  }
  File.prototype.open = function () { files[this.fsName] = []; };
  File.prototype.writeln = function (s) { files[this.fsName].push(s); };
  File.prototype.close = function () {};
  const ctx = {
    app: { project, beginUndoGroup() {}, endUndoGroup() {}, version: 'mock' },
    File, ImportOptions: function (f) { this.file = f; },
    $: { fileName: path.join(baseDir, 'x.jsx') },
    alert: (m) => { ctx.alerted = m; },
    KeyframeEase: function (s, i) { this.speed = s; this.influence = i; },
    BlendingMode: { NORMAL: 1, SCREEN: 2, MULTIPLY: 3, OVERLAY: 4, ADD: 5, LIGHTEN: 6, DARKEN: 7, DIFFERENCE: 8, SOFT_LIGHT: 9, HARD_LIGHT: 10, LUMINOSITY: 11, COLOR: 12 },
    KeyframeInterpolationType: { LINEAR: 1, BEZIER: 2, HOLD: 3 },
    PropertyValueType: PVT,
    ParagraphJustification: { LEFT_JUSTIFY: 1, RIGHT_JUSTIFY: 2, CENTER_JUSTIFY: 3 },
    TrackMatteType: { ALPHA: 1, LUMA: 2 },
  };
  return { ctx, items, files };
}

