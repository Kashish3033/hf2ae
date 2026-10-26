// Evaluator for ffmpeg's expression language (libavutil/eval.c): the strings
// inside zoompan z/x/y, overlay x/y, enable=..., geq, etc.
//
//   const f = compileExpr("1+0.18*(1-exp(-on/7))");
//   f({ on: 3 }) // -> 1.0627...

const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos,
  atan: Math.atan, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  exp: Math.exp, log: Math.log, sqrt: Math.sqrt, abs: Math.abs,
  floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc, round: Math.round,
  pow: Math.pow, hypot: Math.hypot, atan2: Math.atan2,
  min: Math.min, max: Math.max,
  mod: (a, b) => a - b * Math.trunc(a / b),
  clip: (x, lo, hi) => Math.min(Math.max(x, lo), hi),
  between: (x, lo, hi) => (x >= lo && x <= hi ? 1 : 0),
  eq: (a, b) => (a === b ? 1 : 0),
  gt: (a, b) => (a > b ? 1 : 0),
  gte: (a, b) => (a >= b ? 1 : 0),
  lt: (a, b) => (a < b ? 1 : 0),
  lte: (a, b) => (a <= b ? 1 : 0),
  not: (a) => (a === 0 ? 1 : 0),
  if: (c, a, b = 0) => (c !== 0 ? a : b),
  ifnot: (c, a, b = 0) => (c === 0 ? a : b),
  squish: (x) => 1 / (1 + Math.exp(4 * x)),
  gauss: (x) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI),
  isnan: (x) => (Number.isNaN(x) ? 1 : 0),
  isinf: (x) => (Number.isFinite(x) || Number.isNaN(x) ? 0 : 1),
  lerp: (a, b, t) => a + (b - a) * t,
};

const CONSTS = { PI: Math.PI, E: Math.E, PHI: (1 + Math.sqrt(5)) / 2 };

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
    if (num) { toks.push({ t: 'num', v: parseFloat(num[0]) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z_0-9]*/.exec(src.slice(i));
    if (id) { toks.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    if ('+-*/^(),;'.includes(c)) { toks.push({ t: c }); i++; continue; }
    throw new Error(`ffexpr: unexpected '${c}' in ${src}`);
  }
  return toks;
}

// Grammar, as in eval.c: expr = term (('+'|'-') term)* ; term = factor (('*'|'/') factor)* ;
// factor = sign? primary ('^' sign? primary)*, with the leading sign applied
// after the powers (so -2^2 = -4) and '^' grouping left to right.
// ';' separates sub-expressions; the value is the last one.
function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const take = (t) => {
    if (!toks[p] || toks[p].t !== t) throw new Error(`ffexpr: expected '${t}' in ${src}`);
    return toks[p++];
  };

  function seq() {
    const parts = [expr()];
    while (peek() && peek().t === ';') { p++; parts.push(expr()); }
    return parts.length === 1 ? parts[0] : (env) => { let v; for (const f of parts) v = f(env); return v; };
  }
  function expr() {
    let left = term();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = toks[p++].t;
      const a = left, b = term();
      left = op === '+' ? (env) => a(env) + b(env) : (env) => a(env) - b(env);
    }
    return left;
  }
  function term() {
    let left = factor();
    while (peek() && (peek().t === '*' || peek().t === '/')) {
      const op = toks[p++].t;
      const a = left, b = factor();
      left = op === '*' ? (env) => a(env) * b(env) : (env) => a(env) / b(env);
    }
    return left;
  }
  function sign() {
    if (peek() && (peek().t === '-' || peek().t === '+')) return toks[p++].t === '-' ? -1 : 1;
    return 1;
  }
  function factor() {
    const s = sign();
    let base = primary();
    while (peek() && peek().t === '^') {
      p++;
      const s2 = sign();
      const b = base, exp = primary();
      base = (env) => Math.pow(b(env), s2 * exp(env));
    }
    if (s === -1) { const b = base; return (env) => -b(env); }
    return base;
  }
  function primary() {
    const tok = toks[p++];
    if (!tok) throw new Error(`ffexpr: unexpected end of ${src}`);
    if (tok.t === 'num') return () => tok.v;
    if (tok.t === '(') { const e = seq(); take(')'); return e; }
    if (tok.t === 'id') {
      if (peek() && peek().t === '(') {
        p++;
        const args = [];
        if (peek().t !== ')') {
          args.push(seq());
          while (peek().t === ',') { p++; args.push(seq()); }
        }
        take(')');
        const fn = FUNCS[tok.v];
        if (!fn) throw new Error(`ffexpr: unknown function ${tok.v}()`);
        return (env) => fn(...args.map((a) => a(env)));
      }
      if (tok.v in CONSTS) return () => CONSTS[tok.v];
      const name = tok.v;
      return (env) => {
        if (!(name in env)) throw new Error(`ffexpr: unknown variable ${name} in ${src}`);
        return env[name];
      };
    }
    throw new Error(`ffexpr: unexpected '${tok.t}' in ${src}`);
  }

  const fn = seq();
  if (p !== toks.length) throw new Error(`ffexpr: trailing input in ${src}`);
  return fn;
}

const cache = new Map();

export function compileExpr(src) {
  const key = String(src);
  if (!cache.has(key)) cache.set(key, parse(key));
  return cache.get(key);
}

export function evalExpr(src, env = {}) {
  return compileExpr(src)(env);
}

// True when the expression doesn't depend on any of the given variables,
// i.e. it is a constant for our purposes.
export function isConstant(src, env = {}) {
  try { compileExpr(src)(env); return true; } catch { return false; }
}
