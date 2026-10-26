// The timeline: an After Effects project described as plain data.
//
// {
//   name, fps, main: compId,
//   footage: { id: { name, file, w, h, frames, still } },
//   comps:   { id: { name, w, h, frames, layers: [Layer] } },   // layers bottom -> top
//   notes:   [string]                                            // approximations to check
// }
//
// Layer: {
//   name, kind: 'footage'|'comp'|'solid'|'adjustment'|'text', source,
//   w, h, color,                       // solids / adjustment layers
//   inFrame, outFrame, startFrame,     // comp frames; outFrame is exclusive
//   anchor, position, scale, opacity, rotation,   // Props; scale in percent
//   effects: [{ type, name, props: { key: Prop } }],
//   blend, text, parent, expressions, enabled, guide, comment
// }
//
// Prop: { value } or { keys: [{ f, v, out, easeIn, easeOut }] } (see fit.js).

let nextId = 1;
export const newId = (prefix) => `${prefix}${nextId++}`;

export const P = (value) => ({ value });

export function isAnimated(prop) {
  return !!(prop && prop.keys);
}

export function makeLayer(fields) {
  return {
    name: 'Layer',
    kind: 'footage',
    inFrame: 0,
    outFrame: Infinity,
    startFrame: 0,
    anchor: P([0, 0]),
    position: P([0, 0]),
    scale: P([100, 100]),
    opacity: P(100),
    rotation: P(0),
    effects: [],
    blend: 'normal',
    ...fields,
  };
}

// Apply v -> a*v + b to every value of a prop (a, b scalars or per-dimension
// arrays). Ease speeds scale by a.
export function affineProp(prop, a, b = 0) {
  const map = (v) => (Array.isArray(v)
    ? v.map((x, i) => x * (Array.isArray(a) ? a[i] : a) + (Array.isArray(b) ? b[i] : b))
    : v * (Array.isArray(a) ? a[0] : a) + (Array.isArray(b) ? b[0] : b));
  const mapEase = (e) => {
    if (!e) return e;
    if (Array.isArray(e)) return e.map((x, i) => ({ ...x, speed: x.speed * (Array.isArray(a) ? a[i] : a) }));
    return { ...e, speed: e.speed * (Array.isArray(a) ? a[0] : a) };
  };
  if (!prop.keys) return { value: map(prop.value) };
  return { keys: prop.keys.map((k) => ({ ...k, v: map(k.v), easeIn: mapEase(k.easeIn), easeOut: mapEase(k.easeOut) })) };
}

// A scalar prop (from fitCurve) turned into an n-dimensional one, value * factors.
export function scalarToVector(prop, factors) {
  const vec = (v) => factors.map((f) => v * f);
  const ease = (e) => (e ? factors.map((f) => ({ speed: e.speed * f, influence: e.influence })) : e);
  if (!prop.keys) return { value: vec(prop.value) };
  return { keys: prop.keys.map((k) => ({ ...k, v: vec(k.v), easeIn: ease(k.easeIn), easeOut: ease(k.easeOut) })) };
}

function shiftProp(prop, d) {
  if (prop && prop.keys) for (const k of prop.keys) k.f += d;
}

export function eachProp(layer, fn) {
  for (const key of ['anchor', 'position', 'scale', 'opacity', 'rotation']) if (layer[key]) fn(layer[key]);
  for (const fx of layer.effects) for (const p of Object.values(fx.props)) fn(p);
}

// Move a layer (and all its keyframes) d frames later.
export function shiftLayer(layer, d) {
  layer.inFrame += d;
  layer.outFrame += d;
  layer.startFrame += d;
  eachProp(layer, (p) => shiftProp(p, d));
}

export function isStatic(layer) {
  return !isAnimated(layer.anchor) && !isAnimated(layer.position)
    && !isAnimated(layer.scale) && !isAnimated(layer.rotation);
}

// True when the layer covers a w x h comp exactly with no transform.
export function isIdentity(layer, w, h) {
  if (!isStatic(layer) || layer.rotation.value !== 0) return false;
  const lw = layer.w, lh = layer.h;
  const [ax, ay] = layer.anchor.value, [px, py] = layer.position.value, [sx, sy] = layer.scale.value;
  return lw === w && lh === h && sx === 100 && sy === 100 && ax === px && ay === py;
}
