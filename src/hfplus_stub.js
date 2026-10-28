// A stand-in for Frameo's hfPlus helpers (plus/*.js), which only exist
// inside its render service. Installed before the page's own scripts run,
// it does two jobs:
//   - records what the page asks for (text animators, mattes, gradients,
//     sweeps, shapes), so the converter can map those calls straight to
//     After Effects features;
//   - behaves closely enough (eases, gradients as CSS, matchState) that the
//     page's GSAP timeline runs and its elements can be sampled.
//
// Behaviour was read off Frameo's own renders (HF Motion Studio Test): the
// ease curves are fitted to the dots in "P3 A10 eight eases", gradient
// conventions follow CSS as A4/A7 show. Runs in the page, so it must be
// self-contained.

export function installHfPlusStub() {
  const rec = window.__hf2ae = {
    animates: [], mattes: [], gradients: [], sweeps: [], shapes: {}, lives: [], approximations: [], unsupported: [], n: 0,
    whips: [], binds: [], fxs: [], particles: [],
  };
  const tag = (el) => {
    if (typeof el === 'string') el = document.querySelector(el);
    if (el && !el.getAttribute('data-hf2ae')) el.setAttribute('data-hf2ae', `e${++rec.n}`);
    return el;
  };
  // Unknown helpers: record the call and return something GSAP can
  // survive (numbers and strings read as 0 / '').
  const unknown = (path) => new Proxy(function () {}, {
    get: (t, k) => {
      if (k === Symbol.toPrimitive) return () => 0;
      if (typeof k === 'symbol' || k === 'then' || k === 'toJSON') return undefined;
      return unknown(`${path}.${k}`);
    },
    apply: () => {
      if (!rec.unsupported.includes(path)) rec.unsupported.push(path);
      return unknown(`${path}()`);
    },
  });
  const ns = (path, obj) => new Proxy(obj, { get: (t, k) => (k in t ? t[k] : unknown(`${path}.${String(k)}`)) });
  const approx = (msg) => { if (!rec.approximations.includes(msg)) rec.approximations.push(msg); };

  // ---- ease ---------------------------------------------------------------
  const bezier = (x1, y1, x2, y2) => (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1, u = 0.5;
    for (let i = 0; i < 50; i++) {
      u = (lo + hi) / 2;
      const xu = 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u * u * x2 + u ** 3;
      if (xu < x) lo = u; else hi = u;
    }
    return 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u * u * y2 + u ** 3;
  };
  const spring = (w, z) => (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
  };
  const c1 = 1.70158, c3 = c1 + 1, c4 = (2 * Math.PI) / 3;
  const bounceOut = (x) => {
    const n1 = 7.5625, d1 = 2.75;
    if (x < 1 / d1) return n1 * x * x;
    if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
    if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
    return n1 * (x -= 2.625 / d1) * x + 0.984375;
  };
  const ins = {
    Sine: (x) => 1 - Math.cos((x * Math.PI) / 2), Quad: (x) => x * x, Cubic: (x) => x ** 3, Quart: (x) => x ** 4,
    Quint: (x) => x ** 5, Expo: (x) => (x === 0 ? 0 : 2 ** (10 * x - 10)), Circ: (x) => 1 - Math.sqrt(1 - x * x),
    Back: (x) => c3 * x ** 3 - c1 * x * x,
    Elastic: (x) => (x === 0 || x === 1 ? x : -(2 ** (10 * x - 10)) * Math.sin((x * 10 - 10.75) * c4)),
    Bounce: (x) => 1 - bounceOut(1 - x),
  };
  const ease = {
    bezier,
    ae: (influence = 100 / 3) => bezier(influence / 100, 0, 1 - influence / 100, 1),
    // Fitted to Frameo's render (within 0.002 of its own printed values).
    easyEaseIn: bezier(0.12, 0.1, 0.66, 1),
    easyEaseOut: bezier(0.33, 0, 0.81, 0.8),
    motionIn: bezier(0.15, 0.3, 0.15, 1),
    motionMove: bezier(0.4, 0, 0.15, 1),
    springBouncy: spring(19.75, 0.35),
  };
  for (const [k, f] of Object.entries(ins)) {
    ease[`easeIn${k}`] = f;
    ease[`easeOut${k}`] = (x) => 1 - f(1 - x);
    ease[`easeInOut${k}`] = (x) => (x < 0.5 ? f(2 * x) / 2 : 1 - f(2 - 2 * x) / 2);
  }

  // ---- gradient and sweep: live objects painted as CSS backgrounds ---------
  const layers = new Map(); // element -> { gradient, sweeps }
  const paint = (el) => {
    const L = layers.get(el);
    const parts = [];
    for (const s of L.sweeps) {
      const a = s.position - s.width / 2, b = s.position + s.width / 2;
      parts.push(`linear-gradient(${s.angle}deg, transparent ${a}%, ${s.color} ${s.position}%, transparent ${b}%)`);
    }
    const g = L.gradient;
    if (g) {
      const stops = `${g.c0} ${g.p0}%, ${g.c1} ${g.p1}%`;
      if (g.type === 'radial') parts.push(`radial-gradient(circle ${g.radius}px at ${g.x}% ${g.y}%, ${stops})`);
      else if (g.type === 'conic') parts.push(`conic-gradient(from ${g.angle}deg at ${g.x}% ${g.y}%, ${stops})`);
      else parts.push(`linear-gradient(${g.angle}deg, ${stops})`);
    }
    el.style.backgroundImage = parts.join(', ');
  };
  // A plain object whose writes repaint the element (GSAP tweens it).
  // `hidden` keys work but aren't listed, as with Frameo's own objects (A4
  // prints Object.keys of a gradient: no "type").
  const live = (el, init, hidden = []) => {
    const state = { ...init };
    const obj = {};
    for (const k of Object.keys(state)) {
      Object.defineProperty(obj, k, { enumerable: !hidden.includes(k), get: () => state[k], set: (v) => { state[k] = v; paint(el); } });
    }
    return obj;
  };
  const gradient = (el, opts = {}) => {
    el = tag(el);
    if (!layers.has(el)) layers.set(el, { gradient: null, sweeps: [] });
    const stops = opts.stops || ['#000', '#fff'];
    const g = live(el, {
      type: opts.type || 'linear', angle: opts.angle ?? 180, x: opts.x ?? 50, y: opts.y ?? 50,
      radius: opts.radius ?? 50, c0: stops[0], p0: 0, c1: stops[stops.length - 1], p1: 100,
    }, ['type']);
    if (stops.length > 2) approx('gradient with more than two stops uses the first and last');
    layers.get(el).gradient = g;
    rec.gradients.push({ el: el.getAttribute('data-hf2ae'), obj: g });
    paint(el);
    return g;
  };
  // Band look read off A4: about 103 degrees, 22% wide, near-white (width
  // chosen by testing 18-25% against the render's sweep frames).
  const sweep = (el, opts = {}) => {
    el = tag(el);
    if (!layers.has(el)) layers.set(el, { gradient: null, sweeps: [] });
    const s = live(el, {
      angle: opts.angle ?? 103, position: opts.position ?? -20, width: opts.width ?? 22,
      color: opts.color || 'rgba(255,255,255,0.92)', text: !!opts.text,
    });
    layers.get(el).sweeps.push(s);
    rec.sweeps.push({ el: el.getAttribute('data-hf2ae'), obj: s });
    approx('sweep band shape (angle 103, width 22%) was read off one render');
    paint(el);
    return s;
  };
  sweep.band = () => unknown('hfPlus.sweep.band')();

  // ---- shapes: recorded as a tree, mapped to AE shape-layer contents -------
  const node = (op, o) => ({ __shape: true, op, ...o });
  const shapes = {
    ellipse: (o = {}) => node('ellipse', { x: 0, y: 0, rx: 50, ry: 50, ...o }),
    star: (o = {}) => node('star', { x: 0, y: 0, points: 5, outer: 100, inner: 50, ...o }),
    polygon: (o = {}) => node('polygon', { x: 0, y: 0, sides: 6, radius: 100, ...o }),
    rect: (o = {}) => node('rect', { x: 0, y: 0, width: 100, height: 100, radius: 0, ...o }),
    union: (a, b) => node('union', { a, b }),
    intersect: (a, b) => node('intersect', { a, b }),
    exclude: (a, b) => node('exclude', { a, b }),
    offset: (a, amount) => node('offset', { a, amount }),
    // A path string the page can set as d: an invisible point whose x is the
    // id of the recorded tree.
    d: (n) => {
      const id = 900000 + Object.keys(rec.shapes).length + 1;
      rec.shapes[id] = JSON.parse(JSON.stringify(n));
      return `M${id} 0Z`;
    },
    live: (el, fn, state = {}) => {
      el = tag(el);
      const st = { ...state };
      rec.lives.push({ el: el.getAttribute('data-hf2ae'), fn, st });
      el.setAttribute('d', shapes.d(fn(st)));
      return st;
    },
  };

  // ---- craft -----------------------------------------------------------------
  const craft = {
    // "smoothstep; colour done separately" (its own signature string, A8)
    matchState: (p, from, to) => {
      const q = Math.min(Math.max(p, 0), 1), s = q * q * (3 - 2 * q);
      const out = {};
      for (const k of Object.keys(to)) out[k] = from[k] + (to[k] - from[k]) * s;
      return out;
    },
    // The real one paints an organic brush stroke with drips; this reveals
    // the same area as a straight wipe from `origin`. Timing read off A8:
    // the brush crosses the box in the first 21% of progress, easing a
    // little (revealed 0.30/0.56/0.78/0.98 at a quarter steps of that).
    paintPath: (w, h, p, seed = 1, origin = [0.5, 0.5]) => {
      approx('craft.paintPath brush edge and drips become a straight wipe');
      const x = Math.min(Math.max(p / 0.21, 0), 1);
      const q = Math.min(1, x * (1.17 - 0.17 * x)) * 100, ox = origin[0];
      const left = (100 - q) * ox, right = (100 - q) * (1 - ox);
      return `inset(0% ${right}% 0% ${left}%)`;
    },
  };


  // ---- whip ------------------------------------------------------------------
  // Read off "P3 C10 paintPath whip state", which prints whip.state() every
  // frame: pos = smoothstep(p) (AE's Easy Ease), the outgoing element moves
  // distance*pos along `angle`, the incoming one arrives from the opposite
  // side, and the blur's standard deviation is blur*4p(1-p) along the move.
  const smooth = (p) => { const q = Math.min(Math.max(p, 0), 1); return q * q * (3 - 2 * q); };
  const whipState = (p, o = {}) => {
    const q = Math.min(Math.max(p, 0), 1), pos = smooth(q);
    const a = ((o.angle ?? 180) * Math.PI) / 180, d = o.distance ?? 0, b = o.blur ?? 40;
    const dir = [Math.cos(a), Math.sin(a)];
    const sd = b * 4 * q * (1 - q);
    return {
      pos,
      out: [dir[0] * d * pos, dir[1] * d * pos],
      in: [-dir[0] * d * (1 - pos), -dir[1] * d * (1 - pos)],
      std: [Math.abs(dir[0]) * sd, Math.abs(dir[1]) * sd],
    };
  };
  const whip = (tl, outEl, inEl, opts) => {
    const isEl = (x) => typeof x === 'string' || x instanceof Element;
    if (!isEl(inEl)) { opts = inEl; inEl = null; }
    opts = opts || {};
    outEl = outEl && tag(outEl);
    inEl = inEl && tag(inEl);
    const a = ((opts.angle ?? 180) * Math.PI) / 180;
    const box = (outEl || inEl).parentElement.getBoundingClientRect();
    const o = {
      at: opts.at ?? 0, duration: opts.duration ?? 0.4, angle: opts.angle ?? 180,
      distance: opts.distance ?? Math.abs(Math.cos(a)) * box.width + Math.abs(Math.sin(a)) * box.height,
      blur: opts.blur ?? 40,
    };
    const apply = (p) => {
      const st = whipState(p, o);
      const blur = (v) => (v > 0.01 ? `blur(${v}px)` : 'none');
      if (outEl) gsap.set(outEl, { x: st.out[0], y: st.out[1], filter: blur(Math.max(...st.std)) });
      if (inEl) gsap.set(inEl, { x: st.in[0], y: st.in[1], filter: blur(Math.max(...st.std)) });
    };
    const clock = { _p: 0, get p() { return this._p; }, set p(v) { this._p = v; apply(v); } };
    clock.p = 0;
    tl.fromTo(clock, { p: 0 }, { p: 1, duration: o.duration, ease: 'none', immediateRender: false }, o.at);
    rec.whips.push({ out: outEl && outEl.getAttribute('data-hf2ae'), in: inEl && inEl.getAttribute('data-hf2ae'), opts: o });
    return undefined;
  };
  whip.state = whipState;

  // ---- expr --------------------------------------------------------------------
  // bind() runs the page's functions of time on every frame, as GSAP sets;
  // the reader samples the result like any other animation. lookAt and the
  // page's own functions are exact. noise and the seeded randoms are this
  // stand-in's own generators, so their values differ from Frameo's.
  const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const noise1 = (seed, x) => {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    const g = (k) => hash(k * 1.13 + seed * 57.3) * 2 - 1;
    return g(i) * (1 - u) + g(i + 1) * u;
  };
  const rng = (seed) => {
    let st = (Math.floor(seed * 2654435761) >>> 0) || 1;
    return () => { st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0; return st / 4294967296; };
  };
  const ctxFor = (el, i, seed) => ({
    el, index: i,
    noise: (x) => noise1(seed + i, x),
    seedRandom(sd) { this._r = rng(seed * 1000 + sd * 31 + i + 1); },
    random(a = 0, b = 1) { if (!this._r) this._r = rng(seed + i + 1); return a + (b - a) * this._r(); },
    gaussRandom(a = 0, b = 1) {
      if (!this._r) this._r = rng(seed + i + 1);
      const g = Math.sqrt(-2 * Math.log(this._r() || 1e-9)) * Math.cos(2 * Math.PI * this._r());
      return (a + b) / 2 + Math.max(-1, Math.min(1, g / 3)) * (b - a) / 2;
    },
  });
  // AE-style spring between held key values: x'' = -w^2 (x - target) - 2 z w x'.
  const springTrack = (keys, o = {}) => {
    const w = 2 * Math.PI * (o.frequency ?? 2), z = o.damping ?? 0.5, dt = 1 / 1000;
    const end = keys[keys.length - 1].t + 10;
    const table = [];
    let x = keys[0].v, v = 0;
    for (let k = 0, t = 0; t <= end; t += dt, k++) {
      let target = keys[0].v;
      for (const key of keys) if (t >= key.t) target = key.v;
      if (k % 4 === 0) table.push(x);
      v += (-w * w * (x - target) - 2 * z * w * v) * dt;
      x += v * dt;
    }
    return { valueAtTime: (t) => table[Math.min(table.length - 1, Math.max(0, Math.round(t / (4 * dt))))] };
  };
  const expr = {
    bind(tl, sel, props, o = {}) {
      const els = typeof sel === 'string' ? [...document.querySelectorAll(sel)] : [sel];
      const dur = o.duration ?? 6;
      const ctxs = els.map((el, i) => ctxFor(el, i, o.seed ?? 0));
      const clock = {
        _t: 0, get t() { return this._t; },
        set t(v) {
          this._t = v;
          els.forEach((el, i) => {
            const vals = {};
            for (const [k, fn] of Object.entries(props)) vals[k] = fn(v, ctxs[i]);
            gsap.set(el, vals);
          });
        },
      };
      clock.t = 0;
      tl.fromTo(clock, { t: 0 }, { t: dur, duration: dur, ease: 'none', immediateRender: false }, 0);
      els.forEach((el) => tag(el));
      rec.binds.push({ els: els.map((el) => el.getAttribute('data-hf2ae')), props: Object.keys(props) });
      if (Object.values(props).some((fn) => /noise|random|gaussRandom/i.test(String(fn)))) {
        approx('expr noise / seeded random values come from this converter, not Frameo\'s generator');
      }
    },
    lookAt: (a, b) => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI,
    noise: (seed, x) => (x === undefined ? noise1(0, seed) : noise1(seed, x)),
    springTrack,
  };

  // ---- fx ------------------------------------------------------------------------
  // fx(tl, canvas, source, ops) draws `source` into `canvas` through a chain of
  // ops each frame. Recorded with live op objects (GSAP tweens them); the
  // converter rebuilds the canvas as AE layers and effects.
  const FX_OPS = ['blend', 'directionalBlur', 'whip', 'chromaticAberration', 'lensDistortion', 'grain', 'spinBlur'];
  const fx = (tl, canvas, source, ops = {}, o = {}) => {
    canvas = tag(canvas);
    const srcEl = typeof source === 'string' || source instanceof Element ? tag(source) : null;
    const live = {}, tops = {};
    for (const [name, params] of Object.entries(ops)) {
      const { top, ...rest } = params || {};
      if (top) tops[name] = top;
      live[name] = { ...rest };
      if (!FX_OPS.includes(name)) approx(`fx op "${name}" has no After Effects mapping yet`);
    }
    rec.fxs.push({ canvas: canvas.getAttribute('data-hf2ae'), source: srcEl && srcEl.getAttribute('data-hf2ae'), sourceCanvas: srcEl ? null : source, ops: live, tops });
    return live;
  };
  for (const k of ['outline', 'crtOverlay', 'ascii']) fx[k] = (...a) => unknown(`hfPlus.fx.${k}`)(...a);

  // ---- particles ---------------------------------------------------------------
  // Seeded emitters drawn into a canvas. Recorded (sprites saved as images)
  // for the converter; the particles themselves are random, so no render can
  // match Frameo's frame for frame.
  const snapshotSprites = (cfg) => ({
    ...cfg,
    emitters: (cfg.emitters || []).map((e) => ({
      ...e,
      sprite: e.sprite instanceof HTMLCanvasElement ? { image: e.sprite.toDataURL('image/png'), w: e.sprite.width, h: e.sprite.height } : e.sprite,
    })),
  });
  const particles = {
    attach(tl, canvas, cfg = {}) {
      canvas = tag(canvas);
      rec.particles.push({ canvas: canvas.getAttribute('data-hf2ae'), cfg: snapshotSprites(cfg) });
      return { render() {} };
    },
    create(canvas, cfg = {}) {
      canvas = tag(canvas);
      rec.particles.push({ canvas: canvas.getAttribute('data-hf2ae'), cfg: snapshotSprites(cfg), manual: true });
      return { render() {} };
    },
  };

  window.hfPlus = ns('hfPlus', {
    whip,
    expr: ns('hfPlus.expr', expr),
    fx,
    particles: ns('hfPlus.particles', particles),
    ease: ns('hfPlus.ease', ease),
    gradient,
    sweep,
    shapes: ns('hfPlus.shapes', shapes),
    craft: ns('hfPlus.craft', craft),
    text: ns('hfPlus.text', {
      animate(tl, el, opts) {
        el = tag(el);
        const selectors = ((opts && opts.selectors) || [{}]).map((sel) => ({ type: 'range', start: 0, end: 100, offset: 0, ...sel }));
        const plain = JSON.parse(JSON.stringify({ ...opts, selectors: undefined }));
        rec.animates.push({ el: el.getAttribute('data-hf2ae'), opts: plain, selectors });
        return { selectors, props: { ...((opts && opts.props) || {}) }, units: [] };
      },
    }),
    composite: ns('hfPlus.composite', {
      matte(content, matte, mode = 'alpha') {
        content = tag(content);
        matte = tag(matte);
        rec.mattes.push({ content: content.getAttribute('data-hf2ae'), matte: matte.getAttribute('data-hf2ae'), mode });
        return {};
      },
    }),
  });
}
