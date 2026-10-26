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
import { P, makeLayer } from './timeline.js';
import { psName } from './fonts.js';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Runs in the page: measure every .clip element and sample the timeline.
function measure(fps) {
  const root = document.querySelector('[data-composition-id]');
  const compId = root.getAttribute('data-composition-id');
  const w = +root.getAttribute('data-width'), h = +root.getAttribute('data-height');
  const duration = +root.getAttribute('data-duration');
  const frames = Math.round(duration * fps);
  const tl = (window.__timelines || {})[compId];
  const rootRect = root.getBoundingClientRect();

  const loadedFamilies = new Set();
  document.fonts.forEach((f) => { if (f.status === 'loaded') loadedFamilies.add(f.family.replace(/["']/g, '')); });

  const clips = [...root.querySelectorAll('.clip')];
  const items = [];
  const notes = [];
  for (const el of clips) {
    const leaf = !el.querySelector('*:not(br)');
    if (!leaf) {
      if (!el.querySelector('.clip')) notes.push(`#${el.id || el.className}: element with child markup was skipped (only plain text clips are converted)`);
      continue;
    }
    const cs = getComputedStyle(el);
    const families = cs.fontFamily.split(',').map((s) => s.trim().replace(/["']/g, ''));
    const used = families.find((f) => loadedFamilies.has(f)) || families[0];

    // Measure without transforms, and find the first line's baseline.
    const saved = el.style.transform;
    el.style.transform = 'none';
    const r = el.getBoundingClientRect();
    const marker = document.createElement('span');
    marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;';
    el.insertBefore(marker, el.firstChild);
    const baseline = marker.getBoundingClientRect().top - rootRect.top;
    marker.remove();
    el.style.transform = saved;

    const start = parseFloat(el.getAttribute('data-start') || 0);
    const dur = parseFloat(el.getAttribute('data-duration') || duration);
    items.push({
      id: el.id,
      text: el.innerText,
      font: { family: used, weight: cs.fontWeight, style: cs.fontStyle, size: parseFloat(cs.fontSize) },
      letterSpacing: cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing),
      lineHeight: cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight),
      color: cs.color,
      textShadow: cs.textShadow,
      textAlign: cs.textAlign,
      box: { left: r.left - rootRect.left, top: r.top - rootRect.top, right: r.right - rootRect.left, bottom: r.bottom - rootRect.top },
      baseline,
      inFrame: Math.round(start * fps),
      outFrame: Math.round((start + dur) * fps),
      track: +(el.getAttribute('data-track-index') || 0),
      samples: { opacity: [], tx: [], ty: [], sx: [], sy: [], rot: [] },
    });
  }

  for (let f = 0; f < frames; f++) {
    if (tl) tl.seek(f / fps, false);
    clips.forEach((el) => {
      const item = items.find((it) => it.id === el.id);
      if (!item) return;
      let op = 1;
      for (let n = el; n && n !== root.parentElement; n = n.parentElement) op *= parseFloat(getComputedStyle(n).opacity);
      const m = new DOMMatrix(getComputedStyle(el).transform === 'none' ? undefined : getComputedStyle(el).transform);
      item.samples.opacity.push(op * 100);
      item.samples.tx.push(m.e);
      item.samples.ty.push(m.f);
      item.samples.sx.push(Math.hypot(m.a, m.b) * 100);
      item.samples.sy.push(Math.hypot(m.c, m.d) * 100);
      item.samples.rot.push(Math.atan2(m.b, m.a) * 180 / Math.PI);
    });
  }
  return { compId, w, h, frames, items, notes, hasTimeline: !!tl };
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
function textLayers(item, fps, notes) {
  const name = item.text.replace(/\s+/g, ' ').trim() || item.id;
  const { rgb, alpha } = parseRgba(item.color);
  const ls = item.letterSpacing;
  const justify = item.textAlign === 'right' || item.textAlign === 'end' ? 'right'
    : item.textAlign === 'center' ? 'center' : 'left';
  // CSS adds letter-spacing after the last glyph too; AE doesn't.
  const originX = justify === 'right' ? item.box.right - ls
    : justify === 'center' ? (item.box.left + item.box.right - ls) / 2 : item.box.left;
  const origin = [round2(originX), round2(item.baseline)];
  const font = psName(item.font);
  if (!font.known) notes.push(`Font "${item.font.family}" ${item.font.weight}: PostScript name guessed as ${font.name}; check it is installed`);

  const s = item.samples;
  const moves = ['tx', 'ty', 'sx', 'sy', 'rot'].some((k) => Math.max(...s[k]) - Math.min(...s[k]) > 0.01);
  const opacity = fitCurve(s.opacity.map((v) => v * alpha), { tol: 0.5, fps });
  let anchor = P([0, 0]), position = P(origin), scale = P([100, 100]), rotation = P(0);
  if (moves) {
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
    size: item.font.size,
    fill: rgb,
    tracking: round2(ls / item.font.size * 1000),
    justify,
    leading: item.text.includes('\n') ? item.lineHeight : null,
  };
  const base = { kind: 'text', inFrame: item.inFrame, outFrame: item.outFrame };
  const main = makeLayer({ ...base, name, text, anchor, position, scale, rotation, opacity });

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
  return [...copies.reverse(), main];
}

export async function readHyperframes(htmlPath, { fps = 25, name, reference } = {}) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0', timeout: 60000 });
    const dims = await page.evaluate(() => {
      const r = document.querySelector('[data-composition-id]');
      return [+r.getAttribute('data-width'), +r.getAttribute('data-height')];
    });
    await page.setViewport({ width: dims[0], height: dims[1] });
    await page.evaluate(() => document.fonts.ready);
    const m = await page.evaluate(measure, fps);
    const notes = [...m.notes];
    if (!m.hasTimeline) notes.push(`${name}: no window.__timelines["${m.compId}"]; layers are static`);

    // Lower data-track-index draws first (bottom).
    const items = [...m.items].sort((a, b) => a.track - b.track);
    const layers = items.flatMap((it) => textLayers(it, fps, notes));
    if (reference) {
      layers.unshift(makeLayer({
        name: 'HyperFrames render (reference)', kind: 'footage', source: reference.id,
        w: reference.w, h: reference.h, inFrame: 0, outFrame: m.frames,
        anchor: P([reference.w / 2, reference.h / 2]), position: P([m.w / 2, m.h / 2]),
        enabled: false, guide: true,
        comment: 'The original HyperFrames render, switched off. Turn it on to compare.',
      }));
    }
    return { comp: { name: name || m.compId, w: m.w, h: m.h, frames: m.frames, layers }, notes };
  } finally {
    await browser.close();
  }
}
