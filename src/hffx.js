// hfPlus.whip and hfPlus.fx -> After Effects layers and effects.
//
//   whip                -> the two layers slide with Easy Ease (smoothstep, as
//                          Frameo's whip.state shows) and get a Directional
//                          Blur keyed to blur * 4p(1-p); in/out points trimmed
//   fx(canvas, source)  -> a precomp of the canvas: the source layer, then each
//                          op in order:
//      blend            -> the `top` image as a layer with that blending mode,
//                          opacity keyed
//      directionalBlur  -> adjustment layer, Directional Blur keyed
//      whip             -> the stack so far whips out, `top` whips in
//      chromaticAberration -> three channel copies (Shift Channels), red and
//                          blue scaled apart, added: a radial RGB split
//      lensDistortion   -> adjustment layer, Optics Compensation keyed
//      grain / spinBlur -> Noise / Radial Blur (Spin) on an adjustment layer

import { fitCurve } from './fit.js';
import { P, makeLayer, newId } from './timeline.js';
import { fitVector } from './hfvector.js';

// Units that have no exact AE counterpart. Checked against Frameo's renders
// where noted; the AE side still needs one real run.
export const FX_CAL = {
  blurLengthPerSigma: 3,    // AE Directional Blur length per Gaussian sigma (px)
  fxWhipSigmaPerPx: 0.25,   // fx.whip blur sigma per its `px`
  opticsFovPerK: 100,       // AE Optics Compensation field of view per lensDistortion k
};

const BLEND = {
  normal: 'normal', 'source-over': 'normal', dissolve: 'dissolve', add: 'addition', lighter: 'addition',
  screen: 'screen', multiply: 'multiply', overlay: 'overlay', darken: 'darken', lighten: 'lighten',
  difference: 'difference', exclusion: 'exclusion', subtract: 'subtract', divide: 'divide',
  lighterColor: 'lighterColor', darkerColor: 'darkerColor', colorDodge: 'colorDodge', 'color-dodge': 'colorDodge',
  colorBurn: 'colorBurn', 'color-burn': 'colorBurn', 'hard-light': 'hardlight', hardLight: 'hardlight',
  'soft-light': 'softlight', softLight: 'softlight', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};

const smooth = (p) => { const q = Math.min(Math.max(p, 0), 1); return q * q * (3 - 2 * q); };

// whip.state, as Frameo's render prints it.
export function whipState(p, { angle = 180, distance = 0, blur = 40 } = {}) {
  const q = Math.min(Math.max(p, 0), 1), pos = smooth(q);
  const a = (angle * Math.PI) / 180, dir = [Math.cos(a), Math.sin(a)];
  return {
    pos,
    out: [dir[0] * distance * pos, dir[1] * distance * pos],
    in: [-dir[0] * distance * (1 - pos), -dir[1] * distance * (1 - pos)],
    std: blur * 4 * q * (1 - q),
  };
}

// AE Directional Blur: direction 0 blurs vertically, 90 horizontally.
export function directionalBlur(name, sigmas, angle, fps, scale = 1) {
  return {
    type: 'directionalBlur', name,
    props: {
      direction: P((((angle + 90) % 180) + 180) % 180),
      length: fitCurve(sigmas.map((s) => (s * FX_CAL.blurLengthPerSigma) / scale), { tol: 0.2, fps }),
    },
  };
}

const range = (n) => Array.from({ length: n }, (_, i) => i);

const EASY = { speed: 0, influence: 100 / 3 };

// The whip's slide as an editor keys it: two keys, Easy Ease both ends
// (smoothstep is exactly AE's Easy Ease).
function slideKeys(from, to, f0, f1) {
  return { keys: [{ f: f0, v: from, out: 'bezier', easeOut: EASY }, { f: f1, v: to, out: 'linear', easeIn: EASY }] };
}

// blur * 4p(1-p): each half of that parabola is exactly a bezier with
// one-third influence; the speed at the ends is 4 * peak / duration.
function blurKeys(peak, f0, f1, fps) {
  const mid = (f0 + f1) / 2, speed = (4 * peak) / ((f1 - f0) / fps);
  return {
    keys: [
      { f: f0, v: 0, out: 'bezier', easeOut: { speed, influence: 100 / 3 } },
      { f: mid, v: peak, out: 'bezier', easeIn: EASY, easeOut: EASY },
      { f: f1, v: 0, out: 'linear', easeIn: { speed: -speed, influence: 100 / 3 } },
    ],
  };
}

function whipBlur(name, peakSigma, angle, f0, f1, fps, scale) {
  return {
    type: 'directionalBlur', name,
    props: {
      direction: P((((angle + 90) % 180) + 180) % 180),
      length: blurKeys((peakSigma * FX_CAL.blurLengthPerSigma) / scale, f0, f1, fps),
    },
  };
}

const at = (prop, f) => (prop.keys ? (f <= prop.keys[0].f ? prop.keys[0].v : prop.keys[prop.keys.length - 1].v) : prop.value);

// DOM whip: add the blur and trim the two layers. Their slide is already
// keyed from the sampled transforms.
// Frameo blurs the two whipping elements together, so the blur goes on one
// adjustment layer above both, live only during the whip. Returns it for the
// caller to place.
function whipBlurLayer(o, f0, f1, fps, w, h) {
  return makeLayer({
    name: 'Whip blur', kind: 'adjustment', color: [1, 1, 1], w, h,
    anchor: P([w / 2, h / 2]), position: P([w / 2, h / 2]),
    inFrame: Math.floor(f0), outFrame: Math.ceil(f1),
    effects: [whipBlur('Whip blur', o.blur, o.angle, f0, f1, fps, 1)],
  });
}

export function applyWhip(w, layers, { fps, compW, compH }) {
  const o = w.opts;
  const f0 = o.at * fps, f1 = (o.at + o.duration) * fps;
  const end = whipState(1, o);
  for (const [key, l] of [['out', layers.out], ['in', layers.in]]) {
    if (!l) continue;
    // Rest position: before the whip for the outgoing layer, after it for the incoming one.
    const rest = key === 'out' ? at(l.position, -Infinity) : at(l.position, Infinity);
    const d = key === 'out' ? end.out : whipState(0, o).in;
    l.position = key === 'out'
      ? slideKeys(rest, [rest[0] + d[0], rest[1] + d[1]], f0, f1)
      : slideKeys([rest[0] + d[0], rest[1] + d[1]], rest, f0, f1);
    if (key === 'out') l.outFrame = Math.min(l.outFrame, Math.ceil(f1));
    if (key === 'in') l.inFrame = Math.max(l.inFrame, Math.floor(f0));
  }
  return whipBlurLayer(o, f0, f1, fps, compW, compH);
}

// ---- fx --------------------------------------------------------------------------

const full = (w, h, fields) => makeLayer({
  w, h, anchor: P([w / 2, h / 2]), position: P([w / 2, h / 2]), ...fields,
});

export async function fxLayers(fx, { fps, frames, w, h, source, resolveMedia, comps, notes, name }) {
  const series = (op, key, f = (v) => v) => fx.samples.map((s) => f(s[op] && s[op][key] !== undefined ? s[op][key] : 0));
  const precomp = (layers, label) => {
    const id = newId('comp');
    comps[id] = { id, name: label, w, h, frames, layers };
    return full(w, h, { name: label, kind: 'comp', source: id, outFrame: frames });
  };
  const image = async (dataUrl, label) => {
    const ftg = await resolveMedia(dataUrl);
    return makeLayer({
      name: label, kind: 'footage', source: ftg.id, w: ftg.w, h: ftg.h, outFrame: frames,
      anchor: P([ftg.w / 2, ftg.h / 2]), position: P([w / 2, h / 2]),
      scale: P([(w / ftg.w) * 100, (h / ftg.h) * 100]),
    });
  };

  let stack = [];
  if (source) stack.push(source);
  else if (fx.sourceImage) stack.push(await image(fx.sourceImage, 'fx source'));

  for (const op of fx.ops) {
    const first = fx.samples[0][op] || {};
    if (op === 'blend') {
      if (!fx.tops.blend) { notes.push(`${name}: fx blend without a top image`); continue; }
      const top = await image(fx.tops.blend, 'Blend top');
      top.blend = BLEND[first.mode] || 'normal';
      if (!BLEND[first.mode]) notes.push(`${name}: blend mode "${first.mode}" isn't mapped (Normal used)`);
      top.opacity = fitCurve(series('blend', 'opacity', (v) => v * 100), { tol: 0.5, fps });
      stack.push(top);
    } else if (op === 'directionalBlur') {
      stack.push(full(w, h, {
        name: 'Directional blur', kind: 'adjustment', color: [1, 1, 1], outFrame: frames,
        effects: [directionalBlur('Directional Blur', series('directionalBlur', 'px', (v) => v / FX_CAL.blurLengthPerSigma), first.angle || 0, fps)],
      }));
    } else if (op === 'whip') {
      if (!fx.tops.whip) { notes.push(`${name}: fx whip without a top image`); continue; }
      const out = stack.length === 1 ? stack[0] : precomp(stack, `${name} – before whip`);
      const inn = await image(fx.tops.whip, 'Whip in');
      const o = { angle: first.angle || 0, distance: Math.abs(Math.cos((first.angle || 0) * Math.PI / 180)) * w + Math.abs(Math.sin((first.angle || 0) * Math.PI / 180)) * h, blur: (first.px || 200) * FX_CAL.fxWhipSigmaPerPx };
      // Start and end of the progress tween, from two frames inside it
      // (Frameo's pages tween it linearly).
      const ps = series('whip', 'progress');
      const inside = ps.map((p, f) => [f, p]).filter(([, p]) => p > 0 && p < 1);
      if (inside.length < 2) { notes.push(`${name}: fx whip never runs`); continue; }
      const [[fa, pa], [fb, pb]] = [inside[0], inside[inside.length - 1]];
      const slope = (pb - pa) / (fb - fa);
      const f0 = fa - pa / slope, f1 = f0 + 1 / slope;
      const st0 = whipState(0, o), st1 = whipState(1, o);
      for (const [l, from, to] of [[out, [0, 0], st1.out], [inn, st0.in, [0, 0]]]) {
        const [px, py] = l.position.value;
        l.position = slideKeys([px + from[0], py + from[1]], [px + to[0], py + to[1]], f0, f1);
      }
      inn.inFrame = Math.floor(f0);
      out.outFrame = Math.ceil(f1);
      stack = [out, inn, whipBlurLayer(o, f0, f1, fps, w, h)];
    } else if (op === 'chromaticAberration') {
      // Read off "P3 B7 distortion on cut": red pulled in, blue pushed out,
      // by `px` at the frame's edge on each axis (6px at 480 of 640 for px 8).
      const inner = precomp(stack, `${name} – before RGB split`);
      const px = series('chromaticAberration', 'px');
      const copy = (ch, sign, blend) => {
        const l = { ...structuredClone(inner), name: `RGB split – ${ch}`, blend };
        l.scale = fitVector([px.map((v) => 100 * (1 + (sign * v) / (w / 2))), px.map((v) => 100 * (1 + (sign * v) / (h / 2)))], { fps, tol: 0.01 });
        l.effects = [{ type: 'shiftChannels', name: `Keep ${ch}`, props: { keep: P(ch) } }];
        return l;
      };
      stack = [copy('red', -1, 'normal'), copy('green', 0, 'addition'), copy('blue', 1, 'addition')];
    } else if (op === 'lensDistortion') {
      stack.push(full(w, h, {
        name: 'Lens distortion', kind: 'adjustment', color: [1, 1, 1], outFrame: frames,
        effects: [{ type: 'opticsCompensation', name: 'Optics Compensation', props: { fov: fitCurve(series('lensDistortion', 'k', (v) => v * FX_CAL.opticsFovPerK), { tol: 0.05, fps }) } }],
      }));
    } else if (op === 'grain') {
      stack.push(full(w, h, {
        name: 'Grain', kind: 'adjustment', color: [1, 1, 1], outFrame: frames,
        effects: [{ type: 'noise', name: 'Grain', props: { amount: P((first.amount || 0.05) * 100) } }],
      }));
    } else if (op === 'spinBlur') {
      stack.push(full(w, h, {
        name: 'Spin blur', kind: 'adjustment', color: [1, 1, 1], outFrame: frames,
        effects: [{ type: 'radialBlur', name: 'Spin blur', props: { amount: P(first.angle || 0), center: P([(first.x ?? 0.5) * w, (first.y ?? 0.5) * h]), kind: P('spin') } }],
      }));
    } else {
      notes.push(`${name}: fx op "${op}" has no After Effects mapping yet; it was left out`);
    }
  }
  return precomp(stack, name);
}
