// Write a timeline as an ExtendScript (.jsx) file that rebuilds it in
// After Effects, plus the footage it needs, side by side in one folder.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ae_runtime.jsx');

// Comps in dependency order, main first; unreachable comps are dropped.
function compOrder(tl) {
  const order = [];
  const visit = (id) => {
    if (order.includes(id)) return;
    order.push(id);
    for (const l of tl.comps[id].layers) if (l.kind === 'comp') visit(l.source);
  };
  visit(tl.main);
  return order;
}

const r = (v) => (typeof v === 'number' ? Math.round(v * 10000) / 10000 : v);

function cleanProp(p) {
  if (!p) return p;
  if (!p.keys) return { value: Array.isArray(p.value) ? p.value.map(r) : r(p.value) };
  return {
    keys: p.keys.map((k) => ({
      ...k, f: r(k.f), v: Array.isArray(k.v) ? k.v.map(r) : r(k.v),
    })),
  };
}

export function prepare(tl) {
  const order = compOrder(tl);
  const comps = {};
  const usedFootage = new Set();
  for (const id of order) {
    const c = tl.comps[id];
    comps[id] = {
      ...c,
      layers: c.layers.map((l) => {
        if (l.kind === 'footage') usedFootage.add(l.source);
        const out = {
          ...l,
          inFrame: Math.max(0, l.inFrame),
          outFrame: Math.min(Number.isFinite(l.outFrame) ? l.outFrame : c.frames, c.frames),
        };
        for (const k of ['anchor', 'position', 'scale', 'opacity', 'rotation']) out[k] = cleanProp(l[k]);
        out.effects = l.effects.map((fx) => ({
          ...fx, props: Object.fromEntries(Object.entries(fx.props).map(([k, p]) => [k, cleanProp(p)])),
        }));
        return out;
      }).filter((l) => l.outFrame > l.inFrame),
    };
  }
  const footage = Object.fromEntries(Object.entries(tl.footage).filter(([id]) => usedFootage.has(id)));
  return { name: tl.name, fps: tl.fps, main: tl.main, order, comps, footage, notes: tl.notes };
}

export function writeJsx(tl, outDir) {
  fs.mkdirSync(path.join(outDir, 'footage'), { recursive: true });
  const data = prepare(tl);
  for (const fd of Object.values(data.footage)) {
    let dest = path.join('footage', path.basename(fd.file));
    if (/\.webm$/i.test(fd.path)) {
      // After Effects can't import WebM: hand it a ProRes 4444 .mov, which
      // keeps the alpha channel.
      dest = dest.replace(/\.webm$/i, '.mov');
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-c:v', 'libvpx-vp9', '-i', fd.path, '-c:v', 'prores_ks', '-profile:v', '4444',
        '-pix_fmt', 'yuva444p10le', '-an', path.join(outDir, dest)]);
    } else {
      fs.copyFileSync(fd.path, path.join(outDir, dest));
    }
    fd.file = dest;
    delete fd.path;
  }
  const safe = tl.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_');
  const jsxPath = path.join(outDir, `${safe}.jsx`);
  const header = `// ${tl.name}\n// Built by hf2ae. In After Effects: File > Scripts > Run Script File..., pick this file.\n// Keep the footage/ folder next to it.\n\n`;
  fs.writeFileSync(jsxPath, `${header}var DATA = ${JSON.stringify(data)};\n\n${fs.readFileSync(RUNTIME, 'utf8')}`);
  fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(data, null, 2));
  return { jsxPath, data };
}
