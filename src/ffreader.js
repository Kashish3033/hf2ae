// Read an ffmpeg -filter_complex graph and rebuild it as an After Effects
// timeline: every input becomes a footage layer, every overlay a layer in a
// comp, zoompan becomes Scale keyframes, `enable=` becomes in/out points,
// eq/hue/noise become effects or adjustment layers, concat becomes cuts.
//
// A "stream" is a comp under construction:
//   { id, label, w, h, frames, layers: [Layer], clip, origin }
// Filters return new streams; split hands out copies that keep the same id,
// which is how mix() recognises copies of one source.

import { parseFiltergraph } from './filtergraph.js';
import { compileExpr } from './ffexpr.js';
import { fitCurve } from './fit.js';
import {
  P, makeLayer, newId, affineProp, scalarToVector, shiftLayer, isStatic, isIdentity, isAnimated,
} from './timeline.js';

// Calibration between ffmpeg and AE effect units. Checked in After Effects
// against the ffmpeg render; see README "Calibration".
export const CALIBRATION = {
  radialBlurPerZoom: 400,   // AE Radial Blur (Zoom) amount per 1.0 of zoom spread; measured in AE 26.5 (100-900 tried, 400 best)
  noisePerStrength: 1 / 2.55, // AE Noise % per ffmpeg noise strength
  gaussianPerSigma: 2.5,     // AE Gaussian Blur blurriness per ffmpeg gblur sigma
};

const NAMED_COLORS = {
  white: [1, 1, 1], black: [0, 0, 0], red: [1, 0, 0], green: [0, 0.5, 0], blue: [0, 0, 1],
  gray: [0.5, 0.5, 0.5], grey: [0.5, 0.5, 0.5], yellow: [1, 1, 0],
};

export function parseColor(str) {
  let [c, a] = String(str).split('@');
  const alpha = a === undefined ? 1 : parseFloat(a);
  c = c.trim();
  let rgb = NAMED_COLORS[c.toLowerCase()];
  const hex = /^(?:0x|#)([0-9a-fA-F]{6})/.exec(c);
  if (hex) rgb = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255);
  if (!rgb) throw new Error(`unknown colour ${str}`);
  return { rgb, alpha };
}

function parseSize(s) {
  const m = /^(\d+)x(\d+)$/.exec(s);
  if (m) return [+m[1], +m[2]];
  const named = { hd720: [1280, 720], hd1080: [1920, 1080] }[s];
  if (named) return named;
  throw new Error(`unknown size ${s}`);
}

const parseTime = (v) => parseFloat(v);

export class GraphReader {
  constructor({ fps = 25, inputs, names = {}, notes = [] }) {
    this.fps = fps;
    this.inputs = inputs;      // [{ stream factory }] built by the CLI
    this.names = names;        // label -> display name for comps
    this.comps = {};
    this.notes = notes;
  }

  note(msg) {
    if (!this.notes.includes(msg)) this.notes.push(msg);
  }

  // ---- streams ---------------------------------------------------------

  clone(s) {
    return structuredClone(s);
  }

  derive(s, fields) {
    return { ...this.clone(s), id: newId('s'), origin: null, ...fields };
  }

  displayName(s, fallback) {
    if (s.label && this.names[s.label]) return this.names[s.label];
    if (s.label && !/^\d+:v$/.test(s.label)) return s.label;
    return fallback || s.layers.map((l) => l.name).reverse().join(' + ');
  }

  // Turn a stream into a comp and return a stream holding one layer of it.
  precomp(s, name) {
    if (!Number.isFinite(s.frames)) throw new Error(`can't precompose an endless stream (${name}); add trim`);
    const id = newId('comp');
    const compName = name || this.displayName(s);
    const layers = s.layers.map((l) => ({ ...l, outFrame: Math.min(l.outFrame, s.frames) }))
      .filter((l) => l.outFrame > l.inFrame);
    this.comps[id] = { id, name: compName, w: s.w, h: s.h, frames: s.frames, layers };
    const layer = makeLayer({
      name: compName, kind: 'comp', source: id, w: s.w, h: s.h,
      inFrame: 0, outFrame: s.frames,
      anchor: P([s.w / 2, s.h / 2]), position: P([s.w / 2, s.h / 2]),
    });
    return { id: newId('s'), label: null, w: s.w, h: s.h, frames: s.frames, layers: [layer], clip: false, origin: null };
  }

  // Precompose unless the stream is already a single layer.
  single(s, name) {
    return s.layers.length === 1 ? this.clone(s) : this.precomp(s, name);
  }

  // ---- expressions over time -------------------------------------------

  frameEnv(n, extra = {}) {
    return { n, t: n / this.fps, PI: Math.PI, ...extra };
  }

  // Frames of [0, frames) where `expr` is non-zero, as [start, end) intervals.
  intervals(expr, frames, extra = {}) {
    const f = compileExpr(expr);
    const out = [];
    let start = null;
    for (let n = 0; n < frames; n++) {
      const on = f(this.frameEnv(n, extra)) !== 0;
      if (on && start === null) start = n;
      if (!on && start !== null) { out.push([start, n]); start = null; }
    }
    if (start !== null) out.push([start, frames]);
    return out;
  }

  // ---- graph -------------------------------------------------------------

  read(graph, outputLabel) {
    const chains = parseFiltergraph(graph);
    const streams = new Map();
    const pending = [...chains];
    while (pending.length) {
      const i = pending.findIndex((c) => c.inputs.every((l) => streams.has(l) || /^\d+(:v)?$/.test(l)));
      if (i < 0) throw new Error(`unresolved labels in: ${pending.map((c) => c.inputs.join(',')).join(' | ')}`);
      const chain = pending.splice(i, 1)[0];
      let cur = chain.inputs.map((l) => {
        if (streams.has(l)) {
          const s = this.clone(streams.get(l));
          streams.delete(l); // each label is consumed once
          return s;
        }
        return this.inputStream(parseInt(l, 10));
      });
      for (const filter of chain.filters) cur = this.apply(filter, cur);
      if (cur.length !== chain.outputs.length) {
        throw new Error(`chain makes ${cur.length} outputs but names ${chain.outputs.length}: ${chain.text.slice(0, 80)}`);
      }
      chain.outputs.forEach((label, k) => streams.set(label, { ...cur[k], label }));
    }
    const out = streams.get(outputLabel);
    if (!out) throw new Error(`no output [${outputLabel}]`);
    return out;
  }

  inputStream(index) {
    const make = this.inputs[index];
    if (!make) throw new Error(`no input ${index}`);
    return make();
  }

  apply(filter, ins) {
    const fn = this[`f_${filter.name}`];
    if (!fn) throw new Error(`ffmpeg filter '${filter.name}' isn't supported yet`);
    const out = fn.call(this, ins, filter.args);
    return Array.isArray(out) ? out : [out];
  }

  // ---- no-ops: pixel formats, timestamps, sample aspect ---------------------

  f_format([s]) { return s; }
  f_setsar([s]) { return s; }
  f_setpts([s]) { return s; }
  f_settb([s]) { return s; }
  f_null([s]) { return s; }
  f_fps([s], a) {
    if (parseFloat(a.fps) !== this.fps) this.note(`fps=${a.fps} ignored; the project runs at ${this.fps}fps`);
    return s;
  }

  f_split([s], a) {
    const n = parseInt(a.outputs ?? 2, 10);
    return Array.from({ length: n }, () => this.clone(s));
  }

  // ---- time ---------------------------------------------------------------

  f_loop([s], a) {
    if (parseInt(a.loop, 10) !== -1 || parseInt(a.size ?? 1, 10) !== 1 || s.frames !== 1) {
      throw new Error('loop: only loop=-1:size=1 on a still image is supported');
    }
    const out = this.derive(s, { frames: Infinity });
    for (const l of out.layers) if (l.outFrame === 1) l.outFrame = Infinity;
    return out;
  }

  f_trim([s], a) {
    let start = 0, end = s.frames;
    if (a.start_frame) start = parseInt(a.start_frame, 10);
    if (a.start) start = Math.round(parseTime(a.start) * this.fps);
    if (a.end_frame) end = parseInt(a.end_frame, 10);
    if (a.end) end = Math.round(parseTime(a.end) * this.fps);
    if (a.duration) end = start + Math.round(parseTime(a.duration) * this.fps);
    end = Math.min(end, s.frames);
    const out = this.derive(s, { frames: end - start });
    out.layers = out.layers.filter((l) => {
      if (start) shiftLayer(l, -start);
      l.inFrame = Math.max(l.inFrame, 0);
      l.outFrame = Math.min(l.outFrame, end - start);
      return l.outFrame > l.inFrame;
    });
    return out;
  }

  f_fade([s], a) {
    const type = a.type || a.t || 'in';
    const st = a.st !== undefined ? parseTime(a.st) * this.fps : parseFloat(a.start_frame || 0);
    const d = a.d !== undefined ? parseTime(a.d) * this.fps : parseFloat(a.nb_frames || 25);
    if (a.alpha !== '1') this.note('fade without alpha=1 (fade from black) was converted to an opacity fade');
    const out = this.single(s);
    const l = out.layers[0];
    const base = l.opacity.value ?? 100;
    if (isAnimated(l.opacity)) throw new Error('fade on a layer that already has opacity keys');
    const [v0, v1] = type === 'in' ? [0, base] : [base, 0];
    l.opacity = { keys: [{ f: st, v: v0, out: 'linear' }, { f: st + d, v: v1, out: 'linear' }] };
    return out;
  }

  // ---- size and position ----------------------------------------------------

  // Scale every layer about the comp origin (or precompose first).
  scaleStream(s, sx, sy) {
    const out = s.layers.length === 1 && isStatic(s.layers[0]) ? this.clone(s) : this.precomp(s);
    const l = out.layers[0];
    l.position = affineProp(l.position, [sx, sy]);
    l.scale = affineProp(l.scale, [sx, sy]);
    return out;
  }

  f_scale([s], a) {
    const env = { iw: s.w, ih: s.h, in_w: s.w, in_h: s.h };
    let w = compileExpr(a.w)(env);
    let h = compileExpr(a.h)(env);
    if (w < 0) w = (h / s.h) * s.w;
    if (h < 0) h = (w / s.w) * s.h;
    let sx = w / s.w, sy = h / s.h;
    if (a.force_original_aspect_ratio === 'increase' || a.force_original_aspect_ratio === 'decrease') {
      const k = a.force_original_aspect_ratio === 'increase' ? Math.max(sx, sy) : Math.min(sx, sy);
      sx = sy = k;
      w = Math.round(s.w * k);
      h = Math.round(s.h * k);
    }
    if (sx === 1 && sy === 1) return s;
    const out = this.scaleStream(s, sx, sy);
    return { ...out, w, h };
  }

  f_crop([s], a) {
    const env = { iw: s.w, ih: s.h, in_w: s.w, in_h: s.h };
    const w = compileExpr(a.w ?? 'iw')(env);
    const h = compileExpr(a.h ?? 'ih')(env);
    const x = a.x !== undefined ? compileExpr(a.x)({ ...env, ow: w, oh: h }) : (s.w - w) / 2;
    const y = a.y !== undefined ? compileExpr(a.y)({ ...env, ow: w, oh: h }) : (s.h - h) / 2;
    const out = this.derive(s, { w, h, clip: true });
    for (const l of out.layers) {
      l.position = affineProp(l.position, 1, [-x, -y]);
      if (l.kind === 'adjustment' || l.kind === 'solid') {
        // keep full-frame layers full-frame
        l.w = w; l.h = h; l.anchor = P([w / 2, h / 2]); l.position = P([w / 2, h / 2]);
      }
    }
    return out;
  }

  // Footprint of a layer in comp space, for static footage/solid/comp layers.
  bounds(l) {
    if (!isStatic(l) || l.w === undefined) return null;
    const [ax, ay] = l.anchor.value, [px, py] = l.position.value, [sx, sy] = l.scale.value.map((v) => v / 100);
    return [px - ax * sx, py - ay * sy, px + (l.w - ax) * sx, py + (l.h - ay) * sy];
  }

  // A cropped stream whose layers spill past its edges must stay a comp,
  // otherwise the spill would show once its layers move into a bigger comp.
  keepCrop(s) {
    if (!s.clip) return s;
    const spills = s.layers.some((l) => {
      const b = this.bounds(l);
      return !b || b[0] < -0.5 || b[1] < -0.5 || b[2] > s.w + 0.5 || b[3] > s.h + 0.5;
    });
    return spills ? this.precomp(s) : s;
  }

  // ---- compositing ----------------------------------------------------------

  f_overlay([A, B], a) {
    const frames = a.shortest === '1' ? Math.min(A.frames, B.frames) : A.frames;
    const out = this.derive(A, { frames });
    let top = this.keepCrop(this.clone(B));
    const env0 = { main_w: A.w, main_h: A.h, W: A.w, H: A.h, overlay_w: B.w, overlay_h: B.h, w: B.w, h: B.h };
    const xs = a.x ?? '0', ys = a.y ?? '0';
    const staticXY = (() => {
      try { return [compileExpr(xs)(env0), compileExpr(ys)(env0)]; } catch { return null; }
    })();

    if (staticXY) {
      for (const l of top.layers) l.position = affineProp(l.position, 1, staticXY);
    } else {
      top = this.single(top);
      const l = top.layers[0];
      if (!isStatic(l)) throw new Error('overlay: animated x/y over an animated layer');
      const n = Number.isFinite(frames) ? frames : 1;
      const fx = compileExpr(xs), fy = compileExpr(ys);
      const xsF = [], ysF = [];
      for (let k = 0; k < n; k++) {
        const env = this.frameEnv(k, env0);
        xsF.push(fx(env)); ysF.push(fy(env));
      }
      const [px, py] = l.position.value;
      l.position = this.vectorKeys([xsF.map((v) => v + px), ysF.map((v) => v + py)], 0.5);
    }

    if (a.enable) {
      const n = Number.isFinite(frames) ? frames : Math.max(...top.layers.map((l) => l.outFrame).filter(Number.isFinite), 1);
      const spans = this.intervals(a.enable, n);
      const timed = [];
      for (const [s0, s1] of spans) {
        for (const l of top.layers) {
          const c = structuredClone(l);
          c.inFrame = Math.max(c.inFrame, s0);
          c.outFrame = Math.min(c.outFrame, s1);
          if (c.outFrame > c.inFrame) timed.push(c);
        }
      }
      top.layers = timed;
    }
    out.layers = [...out.layers, ...top.layers];
    return out;
  }

  // Per-frame 2D samples -> position keys at the union of both axes' keys.
  vectorKeys([xs, ys], tol) {
    const px = fitCurve(xs, { tol, fps: this.fps }), py = fitCurve(ys, { tol, fps: this.fps });
    if (!px.keys && !py.keys) return P([px.value, py.value]);
    const frames = new Set([...(px.keys || []).map((k) => k.f), ...(py.keys || []).map((k) => k.f)]);
    const sorted = [...frames].sort((m, n) => m - n);
    return {
      keys: sorted.map((f, i) => {
        const next = sorted[i + 1];
        const hold = next !== undefined && next - f === 1 && (xs[f] !== xs[next] || ys[f] !== ys[next])
          && (f === 0 || (xs[f - 1] === xs[f] && ys[f - 1] === ys[f]));
        return { f, v: [xs[f], ys[f]], out: hold ? 'hold' : 'linear' };
      }),
    };
  }

  f_blend([A, B], a) {
    const mode = a.all_mode || a.c0_mode;
    if (!mode || a.all_expr) throw new Error('blend: only all_mode=<mode> is supported');
    const supported = ['screen', 'multiply', 'overlay', 'addition', 'lighten', 'darken', 'difference', 'normal', 'softlight', 'hardlight'];
    if (!supported.includes(mode)) throw new Error(`blend mode ${mode} isn't supported yet`);
    const out = this.derive(A, { frames: a.shortest === '1' ? Math.min(A.frames, B.frames) : A.frames });
    const top = this.keepCrop(this.clone(B));
    for (const l of top.layers) l.blend = mode;
    if (top.layers.length > 1) {
      const pc = this.precomp(top);
      pc.layers[0].blend = mode;
      out.layers.push(...pc.layers);
    } else {
      out.layers.push(...top.layers);
    }
    return out;
  }

  f_concat(ins, a) {
    const n = parseInt(a.n ?? 2, 10);
    if (a.a && a.a !== '0') throw new Error('concat: audio is not supported');
    const parts = ins.slice(0, n);
    let t = 0;
    const out = { id: newId('s'), label: null, w: parts[0].w, h: parts[0].h, frames: 0, layers: [], clip: false };
    parts.forEach((p, i) => {
      if (!Number.isFinite(p.frames)) throw new Error('concat of an endless stream; add trim');
      const piece = p.layers.length === 1 && isIdentityish(p) ? this.clone(p) : this.precomp(p, this.displayName(p, `Shot ${i + 1}`));
      for (const l of piece.layers) {
        l.outFrame = Math.min(l.outFrame, p.frames);
        shiftLayer(l, t);
        out.layers.push(l);
      }
      t += p.frames;
    });
    out.frames = t;
    return out;
  }

  // ---- camera: zoompan ------------------------------------------------------

  f_zoompan([s], a) {
    if (parseInt(a.d ?? 1, 10) !== 1) throw new Error('zoompan: only d=1 is supported');
    if (!Number.isFinite(s.frames)) throw new Error('zoompan on an endless stream; add trim first');
    const [W, H] = parseSize(a.s || 'hd720');
    const fz = compileExpr(a.zoom ?? a.z ?? '1');
    const fx = compileExpr(a.x ?? '0');
    const fy = compileExpr(a.y ?? '0');
    const iw = s.w, ih = s.h;
    const zs = [], xs = [], ys = [];
    let pzoom = 1, px = 0, py = 0;
    for (let on = 0; on < s.frames; on++) {
      const env = { on, in: on, iw, ih, in_w: iw, in_h: ih, ow: W, oh: H, out_w: W, out_h: H, pzoom, px, py, duration: 1, pduration: 1, time: on / this.fps, in_time: on / this.fps, a: iw / ih };
      let z = Math.min(Math.max(fz({ ...env, zoom: pzoom }), 1), 10);
      const x = Math.min(Math.max(fx({ ...env, zoom: z }), 0), Math.max(iw - iw / z, 0));
      const y = Math.min(Math.max(fy({ ...env, zoom: z }), 0), Math.max(ih - ih / z, 0));
      zs.push(z); xs.push(x); ys.push(y);
      pzoom = z; px = x; py = y;
    }

    // Is there one input point that stays put? (x = p - p/zoom.)
    let pin = null;
    const moving = zs.map((z, i) => i).filter((i) => zs[i] > 1.0001);
    if (moving.length) {
      const ps = moving.map((i) => [xs[i] * zs[i] / (zs[i] - 1), ys[i] * zs[i] / (zs[i] - 1)]);
      const [mx, my] = ps[0];
      const r3 = (v) => Math.round(v * 1000) / 1000;
      if (ps.every(([qx, qy]) => Math.abs(qx - mx) < 0.5 && Math.abs(qy - my) < 0.5)) pin = [r3(mx), r3(my)];
    } else if (xs.every((x) => x === 0) && ys.every((y) => y === 0)) {
      pin = [0, 0];
    }

    const kx = W / iw, ky = H / ih;
    const identity = W === iw && H === ih && zs.every((z) => z === 1) && xs.every((x) => x === 0) && ys.every((y) => y === 0);
    if (identity) {
      const out = this.derive(s, {});
      out.origin = { op: 'zoompan', srcId: s.id, zs, pin: 'any' };
      return out;
    }
    const scale = fitCurve(zs.map((z) => z * kx * 100), { tol: 0.03, fps: this.fps });
    const sAspect = ky / kx;
    let anchor, position;
    if (pin) {
      anchor = P(pin);
      position = P([pin[0] * kx, pin[1] * ky]);
    } else {
      // No fixed point: anchor at the input centre, move the position.
      const c = [iw / 2, ih / 2];
      anchor = P(c);
      position = this.vectorKeys([
        zs.map((z, i) => (c[0] - xs[i]) * z * kx),
        zs.map((z, i) => (c[1] - ys[i]) * z * ky),
      ], 0.25);
    }

    // Fold into the layer when it is a single static layer, else precompose.
    let out;
    const only = s.layers.length === 1 ? s.layers[0] : null;
    // Folding is safe for cropped streams too: the zoompan window never leaves the input frame.
    const foldable = only && isStatic(only) && !only.effects.some((e) => SPATIAL.has(e.type));
    if (foldable) {
      out = this.derive(s, { w: W, h: H });
      const l = out.layers[0];
      const [ax, ay] = l.anchor.value, [lpx, lpy] = l.position.value, [s0x, s0y] = l.scale.value.map((v) => v / 100);
      const P0 = anchor.value;
      l.anchor = P([ax + (P0[0] - lpx) / s0x, ay + (P0[1] - lpy) / s0y]);
      l.position = position;
      l.scale = scalarToVector(scale, [s0x, s0y * sAspect]);
    } else {
      out = this.precomp(s);
      out = { ...out, w: W, h: H };
      const l = out.layers[0];
      l.anchor = anchor;
      l.position = position;
      l.scale = scalarToVector(scale, [1, sAspect]);
    }
    out.origin = { op: 'zoompan', srcId: s.id, zs, pin: pin ? [pin[0] * kx, pin[1] * ky] : null };
    return out;
  }

  // mix of zoompan copies of one source = radial (zoom) blur.
  f_mix(ins, a) {
    const n = parseInt(a.inputs ?? 2, 10);
    const parts = ins.slice(0, n);
    const zp = parts.map((p) => p.origin);
    const pinned = zp.filter((o) => o && Array.isArray(o.pin));
    const sameSource = pinned.length > 0 && zp.every((o) => o && o.op === 'zoompan' && o.srcId === zp[0].srcId
      && (o.pin === 'any' || (Array.isArray(o.pin) && Math.hypot(o.pin[0] - pinned[0].pin[0], o.pin[1] - pinned[0].pin[1]) < 1)));
    if (sameSource) return this.zoomBlur(parts);

    // Generic mix: average the inputs by stacking them at 1/k opacity.
    this.note('mix of unrelated streams was rebuilt as stacked layers at 1/k opacity');
    const frames = Math.max(...parts.map((p) => p.frames));
    const out = { id: newId('s'), label: null, w: parts[0].w, h: parts[0].h, frames, layers: [], clip: false };
    parts.forEach((p, k) => {
      const pc = this.single(p);
      pc.layers[0].opacity = affineProp(pc.layers[0].opacity, 1 / (k + 1));
      out.layers.push(...pc.layers);
    });
    return out;
  }

  zoomBlur(parts) {
    const frames = Math.min(...parts.map((p) => p.frames));
    const base = parts.reduce((m, p) => (Math.max(...p.origin.zs) < Math.max(...m.origin.zs) ? p : m));
    const spread = [];
    for (let f = 0; f < frames; f++) {
      const zf = parts.map((p) => p.origin.zs[f]);
      spread.push(Math.max(...zf) / Math.min(...zf) - 1);
    }
    const active = spread.map((v, f) => (v > 1e-4 ? f : -1)).filter((f) => f >= 0);
    const out = this.clone(base);
    out.id = newId('s');
    out.origin = null;
    if (!active.length) return out;
    const a0 = Math.max(active[0] - 1, 0), a1 = active.at(-1) + 1;
    const amount = fitCurve(
      spread.slice(a0, a1).map((v) => v * CALIBRATION.radialBlurPerZoom),
      { tol: 0.2, fps: this.fps, startFrame: a0 },
    );
    const center = parts.find((p) => Array.isArray(p.origin.pin)).origin.pin;
    const fx = { type: 'radialBlur', name: 'Zoom blur', props: { amount, center: P(center), kind: P('zoom') } };
    this.note('Zoom blur: ffmpeg averaged zoomed copies; AE Radial Blur amount is calibrated (radialBlurPerZoom)');
    return this.addEffect(out, fx, [[a0, a1]], 'Zoom blur');
  }

  // ---- effects -----------------------------------------------------------

  // Put effects on the layer when that is equivalent, otherwise on an
  // adjustment layer; `spans` limits them to frame intervals. A blending
  // mode always needs an adjustment layer.
  addEffect(s, fx, spans, name, { blend } = {}) {
    const out = this.clone(s);
    const effects = Array.isArray(fx) ? fx : [fx];
    const spatial = effects.some((e) => SPATIAL.has(e.type));
    const only = out.layers.length === 1 ? out.layers[0] : null;
    const onLayer = !spans && !blend && only && (!spatial || isIdentity(only, out.w, out.h));
    if (onLayer) {
      only.effects.push(...effects);
      return out;
    }
    const n = Number.isFinite(out.frames) ? out.frames : Infinity;
    for (const [a, b] of spans || [[0, n]]) {
      out.layers.push(makeLayer({
        name: spans && b - a === 1 ? `${name} f${a}` : name,
        kind: 'adjustment', w: out.w, h: out.h, color: [1, 1, 1],
        inFrame: a, outFrame: b,
        anchor: P([out.w / 2, out.h / 2]), position: P([out.w / 2, out.h / 2]),
        effects: structuredClone(effects),
        blend: blend || 'normal',
      }));
    }
    return out;
  }

  spans(s, a) {
    if (!a.enable) return null;
    const n = Number.isFinite(s.frames) ? s.frames : 10000;
    return this.intervals(a.enable, n);
  }

  f_eq([s], a) {
    const c = parseFloat(a.contrast ?? 1), b = parseFloat(a.brightness ?? 0);
    const sat = parseFloat(a.saturation ?? 1), g = parseFloat(a.gamma ?? 1);
    const fx = [];
    if (c !== 1 || b !== 0 || g !== 1) fx.push(levelsFromEq(c, b, g));
    if (sat < 1) fx.push({ type: 'tint', name: 'Saturation', props: { amount: P((1 - sat) * 100) } });
    if (sat > 1) fx.push({ type: 'hueSaturation', name: 'Saturation', props: { saturation: P((sat - 1) * 100) } });
    if (!fx.length) return s;
    // ffmpeg's eq changes luma only and keeps the colour. Levels in
    // Luminosity mode does the same: brightness from the effect, colour from
    // below. A saturation change needs the colour, so it stays Normal.
    const lumaOnly = sat === 1;
    if (!lumaOnly) this.note('eq with saturation: Levels works on all channels here (ffmpeg changes luma only)');
    return this.addEffect(s, fx, this.spans(s, a), a.enable ? 'Flash' : 'Grade', { blend: lumaOnly ? 'luminosity' : undefined });
  }

  f_hue([s], a) {
    if (a.h && parseFloat(a.h) !== 0) throw new Error('hue: only s= (saturation) is supported');
    const sat = parseFloat(a.s ?? 1);
    if (sat === 1) return s;
    const fx = sat < 1
      ? { type: 'tint', name: sat === 0 ? 'Black & White' : 'Saturation', props: { amount: P((1 - sat) * 100) } }
      : { type: 'hueSaturation', name: 'Saturation', props: { saturation: P((sat - 1) * 100) } };
    return this.addEffect(s, fx, this.spans(s, a), 'Black & White');
  }

  f_negate([s], a) {
    return this.addEffect(s, { type: 'invert', name: 'Invert', props: {} }, this.spans(s, a), 'Invert');
  }

  f_noise([s], a) {
    const strength = parseFloat(a.alls ?? a.c0s ?? 0);
    if (!strength) return s;
    const fx = { type: 'noise', name: 'Grain', props: { amount: P(strength * CALIBRATION.noisePerStrength) } };
    this.note('Grain: ffmpeg noise strength mapped to AE Noise amount (noisePerStrength)');
    return this.addEffect(s, fx, this.spans(s, a), 'Grain');
  }

  f_gblur([s], a) {
    const fx = { type: 'gaussianBlur', name: 'Blur', props: { blurriness: P(parseFloat(a.sigma ?? 0.5) * CALIBRATION.gaussianPerSigma) } };
    return this.addEffect(s, fx, this.spans(s, a), 'Blur');
  }

  f_colorchannelmixer([s], a) {
    const keys = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'];
    const def = { rr: 1, gg: 1, bb: 1 };
    const props = {};
    for (const k of keys) props[k] = P(parseFloat(a[k] ?? def[k] ?? 0) * 100);
    return this.addEffect(s, { type: 'channelMixer', name: 'Channel Mixer', props }, this.spans(s, a), 'Channel Mixer');
  }

  f_drawbox([s], a) {
    const env = { iw: s.w, ih: s.h, in_w: s.w, in_h: s.h };
    const x = compileExpr(a.x ?? '0')(env), y = compileExpr(a.y ?? '0')(env);
    const w = compileExpr((a.w ?? a.width ?? 'iw'))(env), h = compileExpr((a.h ?? a.height ?? 'ih'))(env);
    const t = a.t ?? a.thickness ?? '3';
    if (t !== 'fill') throw new Error('drawbox: only t=fill is supported');
    const { rgb, alpha } = parseColor(a.c ?? a.color ?? 'black');
    const out = this.clone(s);
    const n = Number.isFinite(s.frames) ? s.frames : 10000;
    for (const [s0, s1] of this.spans(s, a) || [[0, Number.isFinite(s.frames) ? s.frames : Infinity]]) {
      out.layers.push(makeLayer({
        name: `Box ${Math.round(w)}x${Math.round(h)}`, kind: 'solid', w, h, color: rgb,
        inFrame: s0, outFrame: Math.min(s1, n === 10000 ? Infinity : n),
        anchor: P([w / 2, h / 2]), position: P([x + w / 2, y + h / 2]), opacity: P(alpha * 100),
      }));
    }
    return out;
  }

  // ---- sources -------------------------------------------------------------

  f_color([], a) {
    const [w, h] = parseSize(a.s ?? a.size ?? '320x240');
    const { rgb, alpha } = parseColor(a.c ?? a.color ?? 'black');
    const frames = a.d ? Math.round(parseTime(a.d) * this.fps) : Infinity;
    return {
      id: newId('s'), label: null, w, h, frames, clip: false,
      layers: [makeLayer({
        name: `Solid ${a.c ?? 'black'}`, kind: 'solid', w, h, color: rgb, outFrame: frames,
        anchor: P([w / 2, h / 2]), position: P([w / 2, h / 2]), opacity: P(alpha * 100),
      })],
    };
  }
}

const SPATIAL = new Set(['radialBlur', 'gaussianBlur', 'noise']);

function isIdentityish(s) {
  const l = s.layers[0];
  return isStatic(l) && l.w === s.w && l.h === s.h;
}

// ffmpeg eq: Y' = (Y - 0.5) * contrast + 0.5 + brightness (then gamma), on
// 8-bit luma codes. Frameo graphs convert to yuv420p first, which is TV range
// (black 16, white 235), so in full-range terms the gain is the contrast and
// the offset shifts. As Levels: the input range that lands inside [0, 1].
export function levelsFromEq(c, b, gamma = 1, range = 'tv') {
  const o = range === 'tv' ? 16 / 255 : 0, k = range === 'tv' ? 219 / 255 : 1;
  const base = (0.5 + b - o + c * (o - 0.5)) / k;
  const at = (x) => base + c * x;
  let inBlack = 0, inWhite = 1;
  if (c > 0) {
    inBlack = Math.max(0, -base / c);
    inWhite = Math.min(1, (1 - base) / c);
  }
  return {
    type: 'levels',
    name: 'Levels',
    props: {
      inputBlack: P(inBlack), inputWhite: P(inWhite),
      outputBlack: P(Math.min(Math.max(at(inBlack), 0), 1)),
      outputWhite: P(Math.min(Math.max(at(inWhite), 0), 1)),
      gamma: P(gamma),
    },
  };
}
