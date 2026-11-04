// HyperFrames boxes, SVG shapes and gradients -> After Effects layers:
//   - a plain <div> box      -> shape layer: Rectangle + Fill (size, position,
//                               colour keyed), clip-path inset -> a mask
//   - a gradient box         -> solid + a Gradient effect the AE script builds
//                               as Gradient Ramp (+ Offset + Polar Coordinates
//                               for conic) driven by an Angle/Radius slider
//   - hfPlus.shapes trees    -> shape layer contents: Ellipse / Polystar /
//                               Rectangle, Merge Paths, Offset Paths, Fill/Stroke
//   - hfPlus.sweep           -> CC Light Sweep, centre keyed

import { fitCurve } from './fit.js';
import { P, makeLayer } from './timeline.js';

const round2 = (v) => Math.round(v * 100) / 100;

export function parseCss(str) {
  const m = /rgba?\(([^)]+)\)/.exec(str || '');
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { rgb: [p[0] / 255, p[1] / 255, p[2] / 255], alpha: p.length > 3 ? p[3] : 1 };
  }
  const hex = /^#([0-9a-f]{3,8})$/i.exec((str || '').trim());
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { rgb: [n(0), n(2), n(4)], alpha: h.length === 8 ? n(6) : 1 };
  }
  return { rgb: [0, 0, 0], alpha: str === 'none' ? 0 : 1 };
}

const same = (arr) => arr.every((v) => Math.abs(v - arr[0]) < 1e-6);

// Several numbers moving together -> one prop. When every dimension follows
// the same 0..1 progress (a straight move, a uniform resize), fit that
// progress once so the keys get proper eases; otherwise key each dimension
// separately and join the key frames with linear interpolation.
export function fitVector(dims, { tol = 0.25, fps, spatial = false } = {}) {
  const n = dims[0].length;
  if (dims.every(same)) return P(dims.map((d) => round2(d[0])));
  const a = dims.map((d) => d[0]), b = dims.map((d) => d[n - 1]);
  const span = Math.hypot(...a.map((v, i) => b[i] - v));
  if (span > 1e-6) {
    // progress along a -> b, and how far each frame strays from that line
    const u = Array.from({ length: n }, (_, f) => {
      const dot = dims.reduce((s, d, i) => s + (d[f] - a[i]) * (b[i] - a[i]), 0);
      return dot / (span * span);
    });
    const off = Math.max(...Array.from({ length: n }, (_, f) => Math.hypot(...dims.map((d, i) => d[f] - (a[i] + (b[i] - a[i]) * u[f])))));
    if (off <= tol) {
      const at = (v) => a.map((x, i) => round2(x + (b[i] - x) * v));
      if (!spatial) {
        const fit = fitCurve(u, { tol: tol / span, fps });
        if (!fit.keys) return P(a.map(round2));
        const conv = (e) => (e ? a.map((x, i) => ({ speed: e.speed * (b[i] - x), influence: e.influence })) : e);
        return { keys: fit.keys.map((k) => ({ ...k, v: at(k.v), easeIn: conv(k.easeIn), easeOut: conv(k.easeOut) })) };
      }
      // Spatial: AE eases are speeds along the path toward the next key, never
      // negative. Key every turning point (springs, overshoots), fit each
      // one-way run, and measure speeds along that run's own direction.
      const turns = [0];
      for (let f = 1; f < n - 1; f++) {
        const d0 = u[f] - u[f - 1], d1 = u[f + 1] - u[f];
        if (d0 * d1 < 0 && Math.abs(d0) + Math.abs(d1) > 1e-6) turns.push(f);
      }
      turns.push(n - 1);
      const keys = [];
      for (let r = 0; r < turns.length - 1; r++) {
        const f0 = turns[r], f1 = turns[r + 1];
        const fit = fitCurve(u.slice(f0, f1 + 1), { tol: tol / span, fps, startFrame: f0 });
        const runKeys = fit.keys || [{ f: f0, v: u[f0], out: 'linear' }, { f: f1, v: u[f1], out: 'linear' }];
        for (const k of runKeys) {
          const prev = keys[keys.length - 1];
          if (prev && prev.f === k.f) { Object.assign(prev, { out: k.out, easeOut: k.easeOut }); continue; }
          keys.push({ ...k });
        }
      }
      if (keys.length < 2 && Math.max(...u) - Math.min(...u) < tol / span) return P(a.map(round2));
      return {
        keys: keys.map((k, i) => {
          const dirOut = i + 1 < keys.length ? Math.sign(keys[i + 1].v - k.v) : 1;
          const dirIn = i > 0 ? Math.sign(k.v - keys[i - 1].v) : 1;
          const conv = (e, dir) => (e ? { speed: Math.max(0, e.speed * dir) * span, influence: e.influence } : e);
          return { ...k, v: at(k.v), easeIn: conv(k.easeIn, dirIn), easeOut: conv(k.easeOut, dirOut) };
        }),
      };
    }
  }
  const fits = dims.map((d) => fitCurve(d, { tol, fps }));
  const frames = [...new Set(fits.flatMap((p) => (p.keys || []).map((k) => k.f)))].sort((x, y) => x - y);
  return { keys: frames.map((f) => ({ f, v: dims.map((d) => round2(d[f])), out: 'linear' })) };
}

// 2D matrix -> AE scale (percent), rotation (degrees) and skew (degrees, CSS sense)
function decompose([a, b, c, d]) {
  const sx = Math.hypot(a, b);
  const rot = Math.atan2(b, a);
  const shear = (a * c + b * d) / (sx * sx);
  const sy = (a * d - b * c) / sx;
  return { sx: sx * 100, sy: sy * 100, rot: rot * 180 / Math.PI, skew: Math.atan(shear) * 180 / Math.PI };
}

export function transformProps(ms, centres, fps) {
  const parts = ms.map(decompose);
  const position = fitVector([centres.map((c, f) => c[0] + ms[f][4]), centres.map((c, f) => c[1] + ms[f][5])], { fps, spatial: true });
  const scale = fitVector([parts.map((p) => p.sx), parts.map((p) => p.sy)], { tol: 0.05, fps });
  const rotation = fitCurve(parts.map((p) => p.rot), { tol: 0.05, fps });
  const skew = fitCurve(parts.map((p) => p.skew), { tol: 0.05, fps });
  return { position, scale, rotation, skew };
}

function colorProp(css, fps) {
  const cs = css.map(parseCss);
  const rgb = fitVector([0, 1, 2].map((i) => cs.map((c) => c.rgb[i])), { tol: 1 / 255, fps });
  const alpha = fitCurve(cs.map((c) => c.alpha * 100), { tol: 0.5, fps });
  return { rgb, alpha };
}

// clip-path: inset(t r b l) as a mask rectangle in layer space (box centred).
function insetMask(clips, rects, fps) {
  if (clips.every((c) => !c || c === 'none')) return null;
  const parse = (c, [, , w, h]) => {
    const m = /inset\(([^)]+)\)/.exec(c || '');
    if (!m) return null;
    let v = m[1].split(/\s+/).map((x) => x.trim()).filter(Boolean);
    if (v.length === 1) v = [v[0], v[0], v[0], v[0]];
    if (v.length === 2) v = [v[0], v[1], v[0], v[1]];
    if (v.length === 3) v = [v[0], v[1], v[2], v[1]];
    const len = (x, ref) => (x.endsWith('%') ? parseFloat(x) / 100 * ref : parseFloat(x));
    return [len(v[0], h), len(v[1], w), len(v[2], h), len(v[3], w)];
  };
  const ins = clips.map((c, f) => parse(c, rects[f]));
  if (ins.some((x) => !x)) return { unsupported: true };
  const [, , w, h] = rects[0];
  // one key per frame where any edge changes direction, linear in between
  const edges = [0, 1, 2, 3].map((i) => fitCurve(ins.map((x) => x[i]), { tol: 0.25, fps }));
  const frames = [...new Set(edges.flatMap((p) => (p.keys || []).map((k) => k.f)))].sort((x, y) => x - y);
  const rectAt = (f) => {
    const [t, r, b, l] = ins[f];
    return [[-w / 2 + l, -h / 2 + t], [w / 2 - r, -h / 2 + t], [w / 2 - r, h / 2 - b], [-w / 2 + l, h / 2 - b]].map((p) => p.map(round2));
  };
  const path = frames.length ? { keys: frames.map((f) => ({ f, v: rectAt(f), out: 'linear' })) } : P(rectAt(0));
  return { name: 'Clip', mode: 'add', path };
}

// ---- boxes ---------------------------------------------------------------------

export function boxLayer(item, { fps, gradient, sweep, notes }) {
  const s = item.samples;
  const [x0, y0, w, h] = s.rect[0];
  const sizeChanges = !s.rect.every((r) => Math.abs(r[2] - w) < 0.01 && Math.abs(r[3] - h) < 0.01);
  const centres = s.rect.map((r) => [r[0] + r[2] / 2, r[1] + r[3] / 2]);
  const { position, scale, rotation, skew } = transformProps(s.m, centres, fps);
  const opacity = fitCurve(s.opacity, { tol: 0.5, fps });
  const name = item.id || `Box ${Math.round(w)}x${Math.round(h)}`;
  const mask = insetMask(s.clip, s.rect, fps);
  if (mask && mask.unsupported) notes.push(`${name}: a clip-path that isn't inset() was left out`);

  if (gradient) {
    if (sizeChanges) notes.push(`${name}: gradient box changes size; the solid keeps its first size`);
    // Polar Coordinates spins round its layer's middle and only fills the circle
    // inside it, so a conic gradient is a solid big enough to reach every corner
    // from the gradient's centre, placed on that centre, inside a box-sized
    // precomp. Masks and sweeps go on the precomp's layer: AE applies masks
    // before effects, so Polar Coordinates would bend them.
    const conic = gradient.props.mode.value === 'conic';
    const sw = conic ? 2 * Math.ceil(gradient.reach) : Math.round(w), sh = conic ? sw : Math.round(h);
    const center = gradient.props.center;
    if (conic) gradient.props.center = P([sw / 2, sh / 2]);
    const over = sweep ? [sweep] : [];
    const masks = mask && !mask.unsupported ? [shiftMask(mask, w / 2, h / 2)] : null;
    const layer = makeLayer({
      name, kind: 'solid', w: sw, h: sh, color: [1, 1, 1], tag: item.tag,
      inFrame: item.inFrame, outFrame: item.outFrame,
      anchor: P([sw / 2, sh / 2]), position, scale, rotation, opacity,
      effects: conic ? [gradient] : [gradient, ...over],
    });
    if (conic) layer.precomp = { w: Math.round(w), h: Math.round(h), center, effects: over, masks };
    else if (masks) layer.masks = masks;
    return layer;
  }

  const r = item.radius;
  if (!same(r)) notes.push(`${name}: corners have different radii (${r.join('/')}); AE Rectangle uses one roundness (${Math.max(...r)})`);
  const color = colorProp(s.color, fps);
  const items = [{
    type: 'rect', name: 'Rectangle Path',
    size: sizeChanges ? fitVector([s.rect.map((q) => q[2]), s.rect.map((q) => q[3])], { fps }) : P([round2(w), round2(h)]),
    roundness: P(Math.min(Math.max(...r), w / 2, h / 2)),
  }, { type: 'fill', name: 'Fill', color: color.rgb, opacity: color.alpha }];
  if (item.border) {
    const bc = parseCss(item.border.color);
    items.push({ type: 'stroke', name: 'Stroke', color: P(bc.rgb), opacity: P(bc.alpha * 100), width: P(item.border.width) });
  }
  const layer = makeLayer({
    name, kind: 'shape', tag: item.tag, inFrame: item.inFrame, outFrame: item.outFrame,
    anchor: P([0, 0]), position, scale, rotation, opacity,
    contents: [{ type: 'group', name: 'Rectangle', skew, items }],
  });
  if (mask && !mask.unsupported) layer.masks = [mask];
  return layer;
}

// Masks are in layer space; a solid's origin is its top-left corner.
function shiftMask(mask, dx, dy) {
  const mv = (v) => v.map(([x, y]) => [round2(x + dx), round2(y + dy)]);
  return { ...mask, path: mask.path.keys ? { keys: mask.path.keys.map((k) => ({ ...k, v: mv(k.v) })) } : P(mv(mask.path.value)) };
}

// ---- gradients ---------------------------------------------------------------------

// A gradient effect in the box's own pixel space. The AE script builds it as
// Gradient Ramp with an Angle or Radius slider and expressions; conic adds
// Offset + Polar Coordinates.
export function gradientEffect(g, w, h, fps) {
  const first = g.samples[0];
  const c0 = parseCss(first.c0).rgb, c1 = parseCss(first.c1).rgb;
  const props = {
    mode: P(first.type),
    size: P([Math.round(w), Math.round(h)]),
    center: fitVector([g.samples.map((x) => x.x / 100 * w), g.samples.map((x) => x.y / 100 * h)], { fps }),
    startColor: P(c0), endColor: P(c1),
    startAt: P(first.p0 / 100), endAt: P(first.p1 / 100),
  };
  if (first.type === 'radial') props.radius = fitCurve(g.samples.map((x) => x.radius), { tol: 0.1, fps });
  else props.angle = fitCurve(g.samples.map((x) => x.angle), { tol: 0.05, fps });
  // How far the box's farthest corner gets from the centre over the whole shot.
  const reach = Math.max(...g.samples.flatMap((x) => [0, w].flatMap((cx) => [0, h].map((cy) => Math.hypot(x.x / 100 * w - cx, x.y / 100 * h - cy)))));
  return { type: 'gradient', name: 'Gradient', reach, props };
}

// hfPlus.sweep -> CC Light Sweep: the band's centre moves along the gradient
// line (CSS sense: angle 0 = up, 90 = right) through the box.
export function sweepEffect(sw, w, h, fps) {
  const first = sw.samples[0];
  const th = first.angle * Math.PI / 180;
  const dir = [Math.sin(th), -Math.cos(th)];
  const L = Math.abs(w * dir[0]) + Math.abs(h * dir[1]);
  const at = (pos) => [w / 2 + dir[0] * L * (pos / 100 - 0.5), h / 2 + dir[1] * L * (pos / 100 - 0.5)];
  const pts = sw.samples.map((x) => at(x.position));
  const col = parseCss(first.color);
  return {
    type: 'lightSweep', name: 'Light Sweep',
    props: {
      center: fitVector([pts.map((p) => p[0]), pts.map((p) => p[1])], { fps, spatial: true }),
      // CC Light Sweep's direction is the angle of the band itself
      direction: P(round2(first.angle - 90)),
      width: P(round2(first.width / 100 * L / 2)),
      color: P(col.rgb), intensity: P(round2(col.alpha * 100)),
    },
  };
}

// ---- hfPlus.shapes trees -> shape-layer contents ---------------------------------------

const MERGE = { union: 'add', intersect: 'intersect', exclude: 'exclude' };

// trees: the tree on every frame (live shapes) or just one.
function contentsFor(trees, fps) {
  const t = trees[0];
  const param = (k, f = (x) => x, tol = 0.01) => {
    const vals = trees.map((n) => f(n[k]));
    return fitCurve(vals, { tol, fps });
  };
  const pos = () => fitVector([trees.map((n) => n.x), trees.map((n) => n.y)], { fps });
  switch (t.op) {
    case 'ellipse':
      return [{ type: 'ellipse', name: 'Ellipse Path', size: fitVector([trees.map((n) => 2 * n.rx), trees.map((n) => 2 * n.ry)], { fps }), position: pos() }];
    case 'star':
      return [{ type: 'star', name: 'Polystar Path', star: 'star', points: param('points', Math.round), outer: param('outer'), inner: param('inner'), position: pos() }];
    case 'polygon':
      // Sides are whole numbers (Frameo's render switches at .5): hold keys.
      return [{ type: 'star', name: 'Polygon Path', star: 'polygon', points: param('sides', Math.round, 0.01), outer: param('radius'), position: pos() }];
    case 'rect':
      return [{ type: 'rect', name: 'Rectangle Path', size: fitVector([trees.map((n) => n.width), trees.map((n) => n.height)], { fps }), position: fitVector([trees.map((n) => n.x + n.width / 2), trees.map((n) => n.y + n.height / 2)], { fps }), roundness: param('radius') }];
    case 'union': case 'intersect': case 'exclude':
      return [{
        type: 'group', name: t.op[0].toUpperCase() + t.op.slice(1),
        items: [...contentsFor(trees.map((n) => n.a), fps), ...contentsFor(trees.map((n) => n.b), fps), { type: 'merge', name: 'Merge Paths', mode: MERGE[t.op] }],
      }];
    case 'offset':
      return [{ type: 'group', name: `Offset ${t.amount}`, items: [...contentsFor(trees.map((n) => n.a), fps), { type: 'offset', name: 'Offset Paths', amount: param('amount') }] }];
    default:
      return null;
  }
}

export function pathLayer(item, { fps, trees, notes }) {
  const name = item.id || 'Shape';
  if (!trees) {
    notes.push(`${name}: plain SVG path data isn't converted yet (only hfPlus.shapes)`);
    return null;
  }
  const contents = contentsFor(trees, fps);
  if (!contents) {
    notes.push(`${name}: shape "${trees[0].op}" isn't mapped yet`);
    return null;
  }
  const paint = [];
  const fill = parseCss(item.fill);
  if (item.fill !== 'none' && fill.alpha > 0) paint.push({ type: 'fill', name: 'Fill', color: P(fill.rgb), opacity: P(fill.alpha * 100), rule: item.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' });
  const stroke = parseCss(item.stroke);
  if (item.stroke !== 'none' && stroke.alpha > 0) paint.push({ type: 'stroke', name: 'Stroke', color: P(stroke.rgb), opacity: P(stroke.alpha * 100), width: P(item.strokeWidth) });
  const [ox, oy] = item.svgOffset;
  const ms = item.samples.m;
  const { position, scale, rotation } = transformProps(ms.map((m) => [...m.slice(0, 4), m[4] + ox, m[5] + oy]), ms.map(() => [0, 0]), fps);
  return makeLayer({
    name, kind: 'shape', tag: item.tag, inFrame: item.inFrame, outFrame: item.outFrame,
    anchor: P([0, 0]), position, scale, rotation, opacity: fitCurve(item.samples.opacity, { tol: 0.5, fps }),
    contents: [{ type: 'group', name, items: [...contents, ...paint] }],
  });
}
