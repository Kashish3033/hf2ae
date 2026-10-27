// Read a HyperFrames composition (HTML + paused GSAP timeline) and rebuild it
// as an After Effects comp of native text layers.
//
// The page is loaded in headless Chrome. Static styling (font, size, tracking,
// colour, text-shadow, baseline) is measured once; animation is sampled by
// seeking window.__timelines[id] to every frame and reading computed opacity
// and transform, then fitted back into keyframes.

import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { fitCurve } from './fit.js';
import { P, makeLayer, newId } from './timeline.js';
import { psName } from './fonts.js';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Installed before the page's scripts run. Frameo's hfPlus helpers
// (plus/*.js) only exist inside its render service, so this stand-in records
// what the page asks of them; the converter maps those calls straight to AE
// (Text Animators, track mattes) instead of sampling their DOM output.
function installHfPlusStub() {
  const rec = window.__hf2ae = { animates: [], mattes: [], unsupported: [], n: 0 };
  const tag = (el) => {
    if (typeof el === 'string') el = document.querySelector(el);
    if (el && !el.getAttribute('data-hf2ae')) el.setAttribute('data-hf2ae', `e${++rec.n}`);
    return el;
  };
  const unknown = (path) => new Proxy(function () {}, {
    get: (t, k) => (typeof k === 'symbol' || k === 'then' ? undefined : unknown(`${path}.${k}`)),
    apply: () => {
      if (!rec.unsupported.includes(path)) rec.unsupported.push(path);
      return unknown(`${path}()`);
    },
  });
  const ns = (path, obj) => new Proxy(obj, { get: (t, k) => (k in t ? t[k] : unknown(`${path}.${String(k)}`)) });
  window.hfPlus = ns('hfPlus', {
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

// Runs in the page: find every text, SVG text, video and image element,
// measure it, and sample the timeline on every frame.
function measure(fps) {
  const root = document.querySelector('[data-composition-id]');
  const compId = root.getAttribute('data-composition-id');
  const w = +root.getAttribute('data-width'), h = +root.getAttribute('data-height');
  const duration = +root.getAttribute('data-duration');
  const frames = Math.round(duration * fps);
  const tl = (window.__timelines || {})[compId];
  const rootRect = root.getBoundingClientRect();
  const rec = window.__hf2ae || { animates: [], mattes: [], unsupported: [] };

  const faces = {};
  document.fonts.forEach((f) => {
    if (f.status !== 'loaded') return;
    const fam = f.family.replace(/["']/g, '');
    (faces[fam] = faces[fam] || []).push({ weight: parseInt(f.weight, 10) || 400, style: f.style });
  });
  // A bold or italic the font doesn't have is synthesised by the browser
  // (font-synthesis); AE's equivalent is Faux Bold / Faux Italic on the
  // nearest real face.
  const fontOf = (cs) => {
    const families = cs.fontFamily.split(',').map((x) => x.trim().replace(/["']/g, ''));
    const family = families.find((f) => faces[f]) || families[0];
    const want = parseInt(cs.fontWeight, 10) || 400;
    const italic = cs.fontStyle === 'italic' || cs.fontStyle === 'oblique';
    const avail = faces[family] || [];
    if (!avail.length) return { family, weight: String(want), style: cs.fontStyle, size: parseFloat(cs.fontSize) };
    const styled = avail.filter((f) => (f.style === 'italic') === italic);
    const pool = styled.length ? styled : avail;
    const near = pool.reduce((a, b) => (Math.abs(b.weight - want) < Math.abs(a.weight - want) ? b : a));
    return {
      family, weight: String(near.weight), style: styled.length ? cs.fontStyle : 'normal', size: parseFloat(cs.fontSize),
      fauxBold: want >= 600 && near.weight < 600, fauxItalic: italic && !styled.length,
    };
  };
  const tag = (el) => {
    if (!el.getAttribute('data-hf2ae')) el.setAttribute('data-hf2ae', `e${++rec.n}`);
    return el.getAttribute('data-hf2ae');
  };
  const rel = (r) => ({ left: r.left - rootRect.left, top: r.top - rootRect.top, right: r.right - rootRect.left, bottom: r.bottom - rootRect.top });
  const opacityOf = (el) => {
    let op = 1;
    for (let n = el; n && n !== root.parentElement; n = n.parentElement) op *= parseFloat(getComputedStyle(n).opacity);
    return op;
  };

  const notes = [];
  const items = [];
  const all = [...root.querySelectorAll('*')];
  all.forEach((el, order) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    let kind = null;
    if (el.tagName === 'VIDEO') kind = 'video';
    else if (el.tagName === 'IMG') kind = 'image';
    else if (el instanceof SVGTextElement) kind = 'svgtext';
    else if (el instanceof HTMLElement && !el.closest('svg') && !el.querySelector('*:not(br)') && el.innerText.trim()) kind = 'text';
    else if (el instanceof HTMLCanvasElement || el.tagName === 'IFRAME') {
      notes.push(`<${el.tagName.toLowerCase()}> isn't converted yet`);
    }
    if (!kind) return;

    const clip = el.closest('.clip') || root;
    const start = parseFloat(clip.getAttribute('data-start') || 0);
    const dur = parseFloat(clip.getAttribute('data-duration') || duration);
    const item = {
      kind, tag: tag(el), id: el.id, order,
      track: +(clip.getAttribute('data-track-index') || 0),
      inFrame: Math.round(start * fps), outFrame: Math.round((start + dur) * fps),
      samples: { opacity: [], m: [] },
    };

    if (kind === 'text') {
      const saved = el.style.transform;
      el.style.transform = 'none';
      const r = el.getBoundingClientRect();
      const marker = document.createElement('span');
      marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;';
      el.insertBefore(marker, el.firstChild);
      const baseline = marker.getBoundingClientRect().top - rootRect.top;
      marker.remove();
      el.style.transform = saved;
      Object.assign(item, {
        text: el.innerText, font: fontOf(cs),
        letterSpacing: cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing),
        lineHeight: cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight),
        color: cs.color, textShadow: cs.textShadow, textAlign: cs.textAlign, box: rel(r), baseline,
      });
    } else if (kind === 'svgtext') {
      // Baseline: compare with an alphabetic-baseline copy, transforms off.
      const svg = el.ownerSVGElement;
      const off = rel(svg.getBoundingClientRect());
      const savedT = el.getAttribute('transform');
      el.removeAttribute('transform');
      const clone = el.cloneNode(true);
      clone.setAttribute('dominant-baseline', 'alphabetic');
      clone.removeAttribute('data-hf2ae');
      svg.appendChild(clone);
      const dy = el.getBBox().y - clone.getBBox().y;
      clone.remove();
      if (savedT !== null) el.setAttribute('transform', savedT);
      const x = el.x.baseVal.length ? el.x.baseVal[0].value : 0;
      const y = el.y.baseVal.length ? el.y.baseVal[0].value : 0;
      const anchor = cs.textAnchor;
      Object.assign(item, {
        text: el.textContent, font: fontOf(cs),
        letterSpacing: cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing),
        color: cs.fill, textShadow: 'none',
        textAlign: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left',
        origin: [x + off.left, y + dy + off.top], svgOffset: [off.left, off.top],
      });
    } else {
      Object.assign(item, {
        src: el.currentSrc || el.src, box: rel(el.getBoundingClientRect()), fit: cs.objectFit,
      });
    }
    items.push(item);
  });

  const byTag = Object.fromEntries(items.map((it) => [it.tag, it]));
  const elOf = (t) => root.querySelector(`[data-hf2ae="${t}"]`);
  // GSAP hangs its own (circular) state on the selector objects it tweens, so
  // only plain fields leave the page.
  const animates = rec.animates.map((a) => ({
    el: a.el, opts: a.opts,
    selectors: a.selectors.map((sel) => ({ type: sel.type })),
    samples: a.selectors.map(() => ({ start: [], end: [], offset: [] })),
  }));

  for (let f = 0; f < frames; f++) {
    if (tl) tl.seek(f / fps, false);
    for (const it of items) {
      const el = elOf(it.tag);
      it.samples.opacity.push(opacityOf(el) * 100);
      if (it.kind === 'svgtext') {
        const m = el.getCTM();
        it.samples.m.push([m.a, m.b, m.c, m.d, m.e, m.f]);
      } else if (it.kind === 'text') {
        const t = getComputedStyle(el).transform;
        const m = new DOMMatrix(t === 'none' ? undefined : t);
        it.samples.m.push([m.a, m.b, m.c, m.d, m.e, m.f]);
      }
    }
    animates.forEach((a, i) => rec.animates[i].selectors.forEach((sel, j) => {
      a.samples[j].start.push(sel.start);
      a.samples[j].end.push(sel.end);
      a.samples[j].offset.push(sel.offset);
    }));
  }

  // Which items each matte cuts: the content element or anything inside it.
  const mattes = rec.mattes.map((mt) => {
    const content = elOf(mt.content);
    return { ...mt, contentItems: items.filter((it) => content && content.contains(elOf(it.tag))).map((it) => it.tag) };
  });
  const bg = getComputedStyle(root).backgroundColor;
  const stylesheets = [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.href);
  return {
    compId, w, h, frames, items, animates: animates.filter((a) => byTag[a.el]), mattes, background: bg,
    unsupported: rec.unsupported, notes, stylesheets, hasTimeline: !!tl,
  };
}

function parseRgba(str) {
  const m = /rgba?\(([^)]+)\)/.exec(str);
  if (!m) return { rgb: [0, 0, 0], alpha: 1 };
  const p = m[1].split(',').map((s) => parseFloat(s));
  return { rgb: [p[0] / 255, p[1] / 255, p[2] / 255], alpha: p.length > 3 ? p[3] : 1 };
}

// "rgba(40, 120, 255, 0.92) -7px 0px 0px, rgb(...) 7px 0px 0px" -> list
export function parseTextShadow(str) {
  if (!str || str === 'none') return [];
  const parts = [];
  let depth = 0, cur = '';
  for (const c of str) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => {
    const color = /rgba?\([^)]+\)/.exec(p);
    const nums = p.replace(color ? color[0] : '', '').trim().split(/\s+/).map((s) => parseFloat(s));
    const [dx = 0, dy = 0, blur = 0] = nums;
    return { ...parseRgba(color ? color[0] : 'rgb(0,0,0)'), dx, dy, blur };
  });
}

function shadowRole(s) {
  if (s.blur === 0) {
    const tone = s.rgb[2] > s.rgb[0] ? 'blue' : s.rgb[0] > s.rgb[2] ? 'orange' : 'grey';
    return `fringe ${tone}`;
  }
  return s.dx === 0 && s.dy === 0 ? 'glow' : 'shadow';
}

const round2 = (v) => Math.round(v * 100) / 100;

// Build the layers for one text clip: the text itself, plus one linked copy
// per CSS text-shadow (CSS paints the first shadow on top, nearest the text).
function textLayers(item, fps, notes, animate) {
  const name = item.text.replace(/\s+/g, ' ').trim() || item.id;
  const { rgb, alpha } = parseRgba(item.color);
  const ls = item.letterSpacing;
  const justify = item.textAlign === 'right' || item.textAlign === 'end' ? 'right'
    : item.textAlign === 'center' ? 'center' : 'left';
  // CSS adds letter-spacing after the last glyph too; AE doesn't.
  const origin = item.origin ? item.origin.map(round2) : [round2(justify === 'right' ? item.box.right - ls
    : justify === 'center' ? (item.box.left + item.box.right - ls) / 2 : item.box.left), round2(item.baseline)];
  const font = psName(item.font);
  if (!font.known) notes.push(`Font "${item.font.family}" ${item.font.weight}: PostScript name guessed as ${font.name}; check it is installed`);

  const ms = item.samples.m;
  const s = {
    tx: ms.map((m) => m[4]), ty: ms.map((m) => m[5]),
    sx: ms.map((m) => Math.hypot(m[0], m[1]) * 100), sy: ms.map((m) => Math.hypot(m[2], m[3]) * 100),
    rot: ms.map((m) => Math.atan2(m[1], m[0]) * 180 / Math.PI),
  };
  const moves = ['tx', 'ty', 'sx', 'sy', 'rot'].some((k) => Math.max(...s[k]) - Math.min(...s[k]) > 0.01);
  const opacity = fitCurve(item.samples.opacity.map((v) => v * alpha), { tol: 0.5, fps });
  let anchor = P([0, 0]), position = P(origin), scale = P([100, 100]), rotation = P(0);
  if (item.kind === 'svgtext') {
    ({ anchor, position, scale, rotation } = svgTransform(item, origin, fps, notes, name));
  } else if (moves) {
    // CSS transforms pivot on the box centre: put the anchor there.
    const cx = (item.box.left + item.box.right) / 2, cy = (item.box.top + item.box.bottom) / 2;
    anchor = P([round2(cx - origin[0]), round2(cy - origin[1])]);
    const px = fitCurve(s.tx.map((v) => v + cx), { tol: 0.25, fps });
    const py = fitCurve(s.ty.map((v) => v + cy), { tol: 0.25, fps });
    position = px.keys || py.keys
      ? { keys: s.tx.map((v, f) => ({ f, v: [v + cx, s.ty[f] + cy], out: 'linear' })) }
      : P([px.value, py.value]);
    const sc = fitCurve(s.sx, { tol: 0.05, fps });
    scale = sc.keys ? { keys: sc.keys.map((k) => ({ ...k, v: [k.v, k.v], easeIn: k.easeIn && [k.easeIn, k.easeIn], easeOut: k.easeOut && [k.easeOut, k.easeOut] })) } : P([sc.value, sc.value]);
    rotation = fitCurve(s.rot, { tol: 0.05, fps });
    if (position.keys) notes.push(`${name}: moving text was keyed on every frame (motion fitting for position comes later)`);
  }

  const text = {
    text: item.text.replace(/\n/g, '\r'),
    font: font.name,
    family: item.font.family,
    weight: item.font.weight,   // not used by AE (the PostScript name carries it); used by the preview
    style: item.font.style,
    fauxBold: !!item.font.fauxBold,
    fauxItalic: !!item.font.fauxItalic,
    size: item.font.size,
    fill: rgb,
    tracking: round2(ls / item.font.size * 1000),
    justify,
    leading: item.text.includes('\n') ? item.lineHeight : null,
  };
  if (animate) text.animators = animate.animators;
  const base = { kind: 'text', inFrame: item.inFrame, outFrame: item.outFrame };
  const main = makeLayer({ ...base, name, text, anchor, position, scale, rotation, opacity, tag: item.tag });
  if (animate && animate.threeD) main.threeDPerChar = true;

  const copies = parseTextShadow(item.textShadow).map((sh, i) => {
    const role = shadowRole(sh);
    const link = `thisComp.layer("${name}")`;
    const layer = makeLayer({
      ...base,
      name: `${name} – ${role}`,
      text: { ...text },
      parent: name,
      position: P([0, 0]),
      expressions: {
        sourceText: `${link}.text.sourceText`,
        opacity: sh.blur === 0 ? `${link}.transform.opacity * ${round2(sh.alpha)}` : `${link}.transform.opacity`,
      },
      comment: `CSS text-shadow ${i + 1}: ${sh.dx}px ${sh.dy}px ${sh.blur}px`,
    });
    if (sh.blur === 0) {
      layer.position = P([sh.dx, sh.dy]);
      layer.effects.push({ type: 'fill', name: 'Fill', props: { color: P(sh.rgb) } });
    } else {
      const dist = Math.hypot(sh.dx, sh.dy);
      // AE direction: 0 deg = up, clockwise.
      const dir = dist ? (Math.atan2(sh.dx, -sh.dy) * 180 / Math.PI + 360) % 360 : 0;
      layer.effects.push({
        type: 'dropShadow', name: role === 'glow' ? 'Glow' : 'Shadow',
        props: {
          color: P(sh.rgb), opacity: P(sh.alpha * 100), direction: P(round2(dir)),
          distance: P(round2(dist)), softness: P(sh.blur), shadowOnly: P(1),
        },
      });
    }
    return layer;
  });
  const layers = [...copies.reverse(), main];

  // CSS opacity fades the text and its shadows as one group; per-layer
  // opacity in AE would let the fringes show through mid-fade. When it
  // matters, group them in a precomp and fade that, as an editor would.
  if (copies.length && (opacity.keys || opacity.value < 100)) {
    main.opacity = P(100);
    return [{ group: true, name, layers, opacity, inFrame: item.inFrame, outFrame: item.outFrame }];
  }
  return layers;
}

// SVG text transforms come as a matrix about the SVG origin (e.g. GSAP's
// svgOrigin). If one point stays put, that's the anchor and only scale and
// rotation animate; otherwise the position is keyed too.
function svgTransform(item, origin, fps, notes, name) {
  const ms = item.samples.m;
  const [ox, oy] = item.svgOffset;
  const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4] + ox, m[1] * x + m[3] * y + m[5] + oy];
  const scales = ms.map((m) => Math.hypot(m[0], m[1]));
  const rots = ms.map((m) => Math.atan2(m[1], m[0]) * 180 / Math.PI);
  const scale = fitCurve(scales.map((v) => v * 100), { tol: 0.03, fps });
  const rotation = fitCurve(rots, { tol: 0.05, fps });
  const vec = (p) => (p.keys ? { keys: p.keys.map((k) => ({ ...k, v: [k.v, k.v], easeIn: k.easeIn && [k.easeIn, k.easeIn], easeOut: k.easeOut && [k.easeOut, k.easeOut] })) } : P([p.value, p.value]));

  // Fixed point of the most-transformed frame: solve (I - A) q = t.
  const i = scales.reduce((bi, v, k) => (Math.abs(v - 1) > Math.abs(scales[bi] - 1) ? k : bi), 0);
  const [a, b, c, d, e, f] = ms[i];
  const det = (1 - a) * (1 - d) - b * c;
  if (Math.abs(det) > 1e-6) {
    const qx = ((1 - d) * e + c * f) / det, qy = (b * e + (1 - a) * f) / det;
    if (ms.every((m) => { const [px, py] = apply(m, [qx, qy]); return Math.hypot(px - qx - ox, py - qy - oy) < 0.5; })) {
      return {
        anchor: P([round2(qx + ox - origin[0]), round2(qy + oy - origin[1])]),
        position: P([round2(qx + ox), round2(qy + oy)]), scale: vec(scale), rotation,
      };
    }
  }
  if (ms.every((m) => m[4] === ms[0][4] && m[5] === ms[0][5] && scales.every((v) => v === 1))) {
    return { anchor: P([0, 0]), position: P(apply(ms[0], [origin[0] - ox, origin[1] - oy]).map(round2)), scale: P([100, 100]), rotation: P(0) };
  }
  notes.push(`${name}: SVG transform without a fixed point was keyed on every frame`);
  return {
    anchor: P([0, 0]),
    position: { keys: ms.map((m, k) => ({ f: k, v: apply(m, [origin[0] - ox, origin[1] - oy]).map(round2), out: 'linear' })) },
    scale: vec(scale), rotation,
  };
}

// hfPlus.text.animate -> an AE Text Animator: the props are the animator's
// values at full selection, the range selector's start/end/offset are keyed
// from the sampled timeline. CSS z points at the viewer and AE z away from
// it, so z and the X/Y rotations flip sign.
function animatorFor(rec, fps, notes, name) {
  const o = rec.opts || {};
  const p = o.props || {};
  const props = {};
  if (p.opacity !== undefined) props.opacity = p.opacity * 100;
  if (p.x !== undefined || p.y !== undefined || p.z !== undefined) props.position = [p.x || 0, p.y || 0, -(p.z || 0)];
  if (p.rotationX !== undefined) props.rotationX = -p.rotationX;
  if (p.rotationY !== undefined) props.rotationY = -p.rotationY;
  if (p.rotation !== undefined || p.rotationZ !== undefined) props.rotation = p.rotation ?? p.rotationZ;
  if (p.scale !== undefined) props.scale = [p.scale * 100, p.scale * 100, 100];
  if (p.scramble) props.scramble = true;
  const known = ['opacity', 'x', 'y', 'z', 'rotationX', 'rotationY', 'rotation', 'rotationZ', 'scale', 'scramble'];
  for (const k of Object.keys(p)) if (!known.includes(k)) notes.push(`${name}: text.animate prop "${k}" isn't mapped to AE yet`);
  const based = { chars: 'chars', characters: 'chars', words: 'words', lines: 'lines' }[o.based || 'chars'];
  if (!based) notes.push(`${name}: text.animate based:"${o.based}" isn't mapped`);
  const animators = rec.selectors.map((sel, j) => {
    if (sel.type !== 'range') notes.push(`${name}: selector type "${sel.type}" isn't mapped (range only)`);
    const smp = rec.samples[j];
    return {
      name: `Animator ${j + 1}`,
      based: based || 'chars',
      props,
      selector: {
        start: fitCurve(smp.start, { tol: 0.1, fps }),
        end: fitCurve(smp.end, { tol: 0.1, fps }),
        offset: fitCurve(smp.offset, { tol: 0.1, fps }),
      },
      // CSS rotates each unit about its box centre; AE's default is the
      // baseline, so the grouping alignment moves it up half the em box.
      groupingAlignment: [0, -50],
    };
  });
  const threeD = props.rotationX !== undefined || props.rotationY !== undefined || (props.position && props.position[2] !== 0);
  return { animators, threeD, perspective: o.perspective };
}

// <video>/<img> -> footage layer, fitted to its box like CSS object-fit.
async function mediaLayer(item, resolveMedia, fps, notes) {
  if (!resolveMedia) throw new Error(`media element ${item.src} needs a resolver`);
  const ftg = await resolveMedia(item.src);
  const bw = item.box.right - item.box.left, bh = item.box.bottom - item.box.top;
  let sx = bw / ftg.w, sy = bh / ftg.h;
  if (item.fit === 'cover') sx = sy = Math.max(sx, sy);
  if (item.fit === 'contain') sx = sy = Math.min(sx, sy);
  if (item.fit === 'none') sx = sy = 1;
  if (item.fit === 'cover' && (ftg.w * sx > bw + 0.5 || ftg.h * sy > bh + 0.5)) {
    notes.push(`${item.id || item.src}: object-fit cover spills past its box; add a mask in AE if the box isn't the whole frame`);
  }
  return makeLayer({
    name: item.id || ftg.name, kind: 'footage', source: ftg.id, w: ftg.w, h: ftg.h, tag: item.tag,
    inFrame: item.inFrame, outFrame: item.outFrame, startFrame: item.kind === 'video' ? item.inFrame : 0,
    anchor: P([ftg.w / 2, ftg.h / 2]),
    position: P([round2((item.box.left + item.box.right) / 2), round2((item.box.top + item.box.bottom) / 2)]),
    scale: P([round2(sx * 100), round2(sy * 100)]),
    opacity: fitCurve(item.samples.opacity, { tol: 0.5, fps }),
  });
}

export async function readHyperframes(htmlPath, { fps = 25, name, reference, resolveMedia } = {}) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.evaluateOnNewDocument(installHfPlusStub);
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0', timeout: 60000 });
    const dims = await page.evaluate(() => {
      const r = document.querySelector('[data-composition-id]');
      return [+r.getAttribute('data-width'), +r.getAttribute('data-height')];
    });
    await page.setViewport({ width: dims[0], height: dims[1] });
    await page.evaluate(() => document.fonts.ready);
    const m = await page.evaluate(measure, fps);
    const notes = [...m.notes, ...pageErrors.map((e) => `${name}: page error: ${e}`)];
    if (!m.hasTimeline) notes.push(`${name}: no window.__timelines["${m.compId}"]; layers are static`);
    for (const u of m.unsupported) notes.push(`${name}: page calls ${u}, which isn't mapped to AE yet`);

    const comps = {};
    let camera = null;
    const layers = [];
    const { rgb: bg, alpha: bgAlpha } = parseRgba(m.background);
    if (bgAlpha > 0) {
      layers.push(makeLayer({
        name: 'Background', kind: 'solid', w: m.w, h: m.h, color: bg, outFrame: m.frames,
        anchor: P([m.w / 2, m.h / 2]), position: P([m.w / 2, m.h / 2]), opacity: P(bgAlpha * 100),
      }));
    }

    // Lower data-track-index draws first (bottom), then document order.
    const items = [...m.items].sort((a, b) => a.track - b.track || a.order - b.order);
    for (const it of items) {
      if (it.kind === 'video' || it.kind === 'image') {
        layers.push(await mediaLayer(it, resolveMedia, fps, notes));
        continue;
      }
      const label = it.text.replace(/\s+/g, ' ').trim();
      const rec = m.animates.find((a) => a.el === it.tag);
      const animate = rec ? animatorFor(rec, fps, notes, label) : null;
      if (animate && animate.threeD) camera = { zoom: animate.perspective || 100000 };
      for (const l of textLayers(it, fps, notes, animate)) {
        if (!l.group) { layers.push(l); continue; }
        const id = newId('comp');
        comps[id] = { id, name: l.name, w: m.w, h: m.h, frames: m.frames, layers: l.layers };
        layers.push(makeLayer({
          name: l.name, kind: 'comp', source: id, w: m.w, h: m.h, inFrame: l.inFrame, outFrame: l.outFrame,
          anchor: P([m.w / 2, m.h / 2]), position: P([m.w / 2, m.h / 2]), opacity: l.opacity, tag: it.tag,
          comment: 'Text with its CSS shadows; the precomp fades them together like CSS opacity.',
        }));
      }
    }

    // hfPlus.composite.matte -> track matte: the matte layer sits right above
    // the layer it cuts.
    for (const mt of m.mattes) {
      const matte = layers.find((l) => l.tag === mt.matte);
      const content = layers.filter((l) => mt.contentItems.includes(l.tag));
      if (!matte || content.length !== 1) {
        notes.push(`${name}: matte over ${content.length} layers isn't mapped yet (one layer only)`);
        continue;
      }
      layers.splice(layers.indexOf(matte), 1);
      layers.splice(layers.indexOf(content[0]) + 1, 0, matte);
      content[0].trackMatte = { layer: matte.name, type: mt.mode === 'luma' ? 'luma' : 'alpha' };
    }

    if (reference) {
      layers.unshift(makeLayer({
        name: 'HyperFrames render (reference)', kind: 'footage', source: reference.id,
        w: reference.w, h: reference.h, inFrame: 0, outFrame: m.frames,
        anchor: P([reference.w / 2, reference.h / 2]), position: P([m.w / 2, m.h / 2]),
        enabled: false, guide: true,
        comment: 'The original HyperFrames render, switched off. Turn it on to compare.',
      }));
    }
    for (const l of layers) delete l.tag;
    for (const c of Object.values(comps)) for (const l of c.layers) delete l.tag;
    const comp = { name: name || m.compId, w: m.w, h: m.h, frames: m.frames, layers, stylesheets: m.stylesheets };
    if (camera) comp.camera = camera;
    return { comp, comps, notes };
  } finally {
    await browser.close();
  }
}
