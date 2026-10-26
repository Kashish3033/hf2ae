// Turn a per-frame curve into the few keyframes an editor would set by hand.
//
// Input: samples[f] for frames f = 0..N-1 (relative to `startFrame`).
// Output: a timeline property, either { value } or
//   { keys: [{ f, v, out: 'linear'|'bezier'|'hold', easeIn, easeOut }] }
// where easeIn/easeOut are After Effects KeyframeEase pairs
// { speed (units per second), influence (percent, 0.1..100) }.
//
// Segments are fitted with AE's temporal bezier: between keys k0 and k1 the
// curve has control points (t0 + i0*T, v0 + s0*i0*T) and (t1 - i1*T, v1 - s1*i1*T).
// A segment that doesn't fit within `tol` is split at its worst frame.

const INFLUENCES = [];
for (let i = 1; i <= 100; i += i < 10 ? 1 : 2) INFLUENCES.push(i / 100);

function bezierAt(x1, y1, x2, y2, T, v0, v1, x) {
  // Solve x(u) = x by bisection (x(u) is monotonic for 0 <= x1 <= x2 <= T).
  let lo = 0, hi = 1, u = 0.5;
  for (let k = 0; k < 40; k++) {
    u = (lo + hi) / 2;
    const xu = 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u * u * x2 + u ** 3 * T;
    if (xu < x) lo = u; else hi = u;
  }
  return (1 - u) ** 3 * v0 + 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u * u * y2 + u ** 3 * v1;
}

// Error of fitting samples[a..b] with one bezier segment; slopes in units/frame.
function bezierError(samples, a, b, s0, s1, i0, i1) {
  const T = b - a, v0 = samples[a], v1 = samples[b];
  const x1 = i0 * T, y1 = v0 + s0 * i0 * T;
  const x2 = T - i1 * T, y2 = v1 - s1 * i1 * T;
  let err = 0, worst = -1;
  for (let f = a + 1; f < b; f++) {
    const e = Math.abs(bezierAt(x1, y1, x2, y2, T, v0, v1, f - a) - samples[f]);
    if (e > err) { err = e; worst = f; }
  }
  return { err, worst };
}

function linearError(samples, a, b) {
  let err = 0, worst = -1;
  for (let f = a + 1; f < b; f++) {
    const v = samples[a] + (samples[b] - samples[a]) * (f - a) / (b - a);
    const e = Math.abs(v - samples[f]);
    if (e > err) { err = e; worst = f; }
  }
  return { err, worst };
}

// One-sided slopes inside the segment, so kinks (clip(), if()) at the segment
// ends don't leak into the neighbouring segment.
function slopeOut(samples, a, b) {
  if (b - a >= 2) return (-3 * samples[a] + 4 * samples[a + 1] - samples[a + 2]) / 2;
  return samples[b] - samples[a];
}
function slopeIn(samples, a, b) {
  if (b - a >= 2) return (3 * samples[b] - 4 * samples[b - 1] + samples[b - 2]) / 2;
  return samples[b] - samples[a];
}

function fitLinear(samples, a, b, tol) {
  const lin = linearError(samples, a, b);
  if (lin.err <= tol) return [{ a, b, kind: 'linear' }];
  return [...fitLinear(samples, a, lin.worst, tol), ...fitLinear(samples, lin.worst, b, tol)];
}

// Whichever needs fewer keys: straight lines (fades, wipes) or eased curves
// (pushes, settles). Ties go to straight lines.
function fitRun(samples, a, b, tol) {
  const lin = fitLinear(samples, a, b, tol);
  if (lin.length === 1) return lin;
  const bez = fitSegment(samples, a, b, tol);
  return bez.length < lin.length ? bez : lin;
}

function fitSegment(samples, a, b, tol) {
  const lin = linearError(samples, a, b);
  if (lin.err <= tol) return [{ a, b, kind: 'linear' }];

  const s0 = slopeOut(samples, a, b), s1 = slopeIn(samples, a, b);
  let best = { err: Infinity };
  for (const i0 of INFLUENCES) {
    for (const i1 of INFLUENCES) {
      if (i0 + i1 > 1.0001) continue;
      const r = bezierError(samples, a, b, s0, s1, i0, i1);
      if (r.err < best.err) best = { ...r, i0, i1 };
    }
  }
  if (best.err <= tol) return [{ a, b, kind: 'bezier', s0, s1, i0: best.i0, i1: best.i1 }];

  const split = best.worst > a && best.worst < b ? best.worst : lin.worst;
  return [...fitSegment(samples, a, split, tol), ...fitSegment(samples, split, b, tol)];
}

// Hard cuts (a one-frame step with flat values on both sides, like tl.set or
// a one-frame flash) become hold keys. A fade starts or ends flat on only one
// side, so it stays a fitted segment.
function splitAtSteps(samples, tol) {
  const cuts = [0];
  for (let f = 1; f < samples.length; f++) {
    const step = Math.abs(samples[f] - samples[f - 1]);
    const flatBefore = f < 2 || Math.abs(samples[f - 1] - samples[f - 2]) <= tol;
    const flatAfter = f + 1 >= samples.length || Math.abs(samples[f + 1] - samples[f]) <= tol;
    if (step > tol && flatBefore && flatAfter) cuts.push(f);
  }
  return cuts;
}

export function fitCurve(samples, { tol = 0.01, fps = 25, startFrame = 0 } = {}) {
  const n = samples.length;
  if (n === 0) return { value: 0 };
  const min = Math.min(...samples), max = Math.max(...samples);
  if (max - min <= tol) return { value: samples[0] };
  if (n === 1) return { value: samples[0] };

  const keys = [];
  const addKey = (f, v) => {
    if (!keys.length || keys[keys.length - 1].f !== f) keys.push({ f, v, out: 'linear' });
    return keys[keys.length - 1];
  };

  // Each run between hard cuts is fitted on its own; the frame before a cut
  // holds its value until the cut.
  const cuts = splitAtSteps(samples, tol);
  for (let c = 0; c < cuts.length; c++) {
    const a = cuts[c];
    const b = (c + 1 < cuts.length ? cuts[c + 1] : n) - 1;
    if (b <= a) {
      addKey(a, samples[a]).out = 'hold';
      continue;
    }
    if (Math.max(...samples.slice(a, b + 1)) - Math.min(...samples.slice(a, b + 1)) <= tol) {
      addKey(a, samples[a]).out = 'hold';
      continue;
    }
    for (const seg of fitRun(samples, a, b, tol)) {
      const k0 = addKey(seg.a, samples[seg.a]);
      const k1 = addKey(seg.b, samples[seg.b]);
      if (seg.kind === 'bezier') {
        k0.out = 'bezier';
        k0.easeOut = { speed: seg.s0 * fps, influence: seg.i0 * 100 };
        k1.easeIn = { speed: seg.s1 * fps, influence: seg.i1 * 100 };
      }
    }
    // The last key of a run before a cut holds until the cut.
    if (c + 1 < cuts.length) keys[keys.length - 1].out = 'hold';
  }

  // Flat linear ends add nothing: AE holds the first and last values anyway.
  while (keys.length > 2 && keys[0].out === 'linear' && keys[0].v === keys[1].v) keys.shift();
  while (keys.length > 2 && keys.at(-2).out === 'linear' && keys.at(-1).v === keys.at(-2).v) keys.pop();

  for (const k of keys) k.f += startFrame;
  return { keys };
}

// Evaluate a fitted property at frame f (used by tests and the report).
export function evalProp(prop, f, fps = 25) {
  if (!prop.keys) return prop.value;
  const ks = prop.keys;
  if (f <= ks[0].f) return ks[0].v;
  for (let i = 0; i < ks.length - 1; i++) {
    const k0 = ks[i], k1 = ks[i + 1];
    if (f > k1.f) continue;
    if (f === k1.f) return k1.v;
    if (k0.out === 'hold') return k0.v;
    const T = k1.f - k0.f;
    if (k0.out === 'linear' && !k1.easeIn) return k0.v + (k1.v - k0.v) * (f - k0.f) / T;
    const eo = k0.easeOut || { speed: 0, influence: 100 / 3 };
    const ei = k1.easeIn || { speed: 0, influence: 100 / 3 };
    const x1 = eo.influence / 100 * T, y1 = k0.v + eo.speed / fps * x1;
    const x2 = T - ei.influence / 100 * T, y2 = k1.v - ei.speed / fps * (T - x2);
    return bezierAt(x1, y1, x2, y2, T, k0.v, k1.v, f - k0.f);
  }
  return ks[ks.length - 1].v;
}
