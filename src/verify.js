#!/usr/bin/env node
// hf2ae-verify <outDir> --comp "<comp name>" --ref <video or HyperFrames .html> [--bg #808080]
//
// Renders a comp of a converted timeline with the preview (src/preview_page.js),
// renders the reference video over the same background, and compares them
// frame by frame with ffmpeg's PSNR. Writes <outDir>/verify/<comp>/ with the
// frames, a side-by-side sheet (reference | preview | difference x4) and
// report.json.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { CALIBRATION } from './ffreader.js';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'preview_page.js');
const TYPES = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json', '.js': 'text/javascript' };

// Serve outDir over http so footage loads without tainting the canvas.
function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end(); return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function ffmpeg(args) {
  return execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
}

// Render a HyperFrames page the way its renderer does: seek the paused
// timeline to each frame and screenshot the composition.
async function renderHtmlFrames(htmlPath, comp, fps, bg, dir) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: comp.w, height: comp.h });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.evaluate((color) => document.fonts.ready.then(() => {
      document.documentElement.style.background = color;
      document.body.style.background = color;
    }), bg);
    for (let f = 0; f < comp.frames; f++) {
      await page.evaluate((t) => {
        const root = document.querySelector('[data-composition-id]');
        const tl = (window.__timelines || {})[root.getAttribute('data-composition-id')];
        if (tl) tl.seek(t, false);
      }, f / fps);
      await page.screenshot({ path: path.join(dir, `ref_${String(f).padStart(3, '0')}.png`), clip: { x: 0, y: 0, width: comp.w, height: comp.h } });
    }
  } finally {
    await browser.close();
  }
}

export async function verify(outDir, { comp: compName, ref, bg = '#808080' }) {
  outDir = path.resolve(outDir);
  const data = JSON.parse(fs.readFileSync(path.join(outDir, 'timeline.json'), 'utf8'));
  const [compId, comp] = Object.entries(data.comps).find(([, c]) => c.name === compName) || [];
  if (!comp) throw new Error(`no comp named "${compName}" (have: ${Object.values(data.comps).map((c) => c.name).join(', ')})`);
  const dir = path.join(outDir, 'verify', compName.replace(/[^\w\-]+/g, '_'));
  fs.rmSync(path.join(outDir, 'verify', '_frames'), { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const stylesheets = [...new Set(Object.values(data.comps).flatMap((c) => c.stylesheets || []))];
  fs.writeFileSync(path.join(outDir, 'preview.html'), `<!doctype html><meta charset="utf-8">${stylesheets.map((h) => `<link rel="stylesheet" href="${h}">`).join('')}<body></body>`);

  // Video footage on enabled layers: extract its frames for the preview.
  const videoFrames = {};
  for (const [id, fd] of Object.entries(data.footage)) {
    if (fd.still) continue;
    const used = Object.values(data.comps).some((c) => c.layers.some((l) => l.source === id && l.enabled !== false));
    if (!used) continue;
    const fdir = path.join('verify', '_frames', id);
    fs.mkdirSync(path.join(outDir, fdir), { recursive: true });
    ffmpeg(['-i', path.join(outDir, fd.file), '-vf', `fps=${data.fps}`, '-start_number', '0', path.join(outDir, fdir, '%04d.png')]);
    videoFrames[id] = fs.readdirSync(path.join(outDir, fdir)).filter((n) => n.endsWith('.png')).sort().map((n) => `${fdir}/${n}`);
  }

  // 1. Preview frames.
  const server = await serve(outDir);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  let notes, fonts;
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/preview.html`, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.addScriptTag({ path: PAGE_SCRIPT });
    fonts = await page.evaluate((d, cal, vf) => window.hf2aePreview.init(d, cal, vf), data, CALIBRATION, videoFrames);
    for (let f = 0; f < comp.frames; f++) {
      const b64 = await page.evaluate((id, n, color) => window.hf2aePreview.frame(id, n, color), compId, f, bg);
      fs.writeFileSync(path.join(dir, `preview_${String(f).padStart(3, '0')}.png`), Buffer.from(b64, 'base64'));
    }
    notes = await page.evaluate(() => window.hf2aePreview.notes());
  } finally {
    await browser.close();
    server.close();
  }

  // 2. Reference frames over the same background: a video (webm keeps its
  // alpha), or the original HyperFrames HTML rendered in Chrome, frame by frame.
  const refPath = path.resolve(outDir, ref);
  if (/\.html?$/i.test(refPath)) {
    await renderHtmlFrames(refPath, comp, data.fps, bg, dir);
  } else {
    const decoder = /\.webm$/i.test(refPath) ? ['-c:v', 'libvpx-vp9'] : [];
    const color = bg.replace('#', '0x');
    ffmpeg([
      '-f', 'lavfi', '-i', `color=c=${color}:s=${comp.w}x${comp.h}:r=${data.fps}`,
      ...decoder, '-i', refPath,
      '-filter_complex', `[1:v]fps=${data.fps},format=rgba[r];[0:v][r]overlay=shortest=1,format=rgb24`,
      '-frames:v', String(comp.frames), '-start_number', '0', path.join(dir, 'ref_%03d.png'),
    ]);
  }

  // 3. Per-frame PSNR (dB; higher is closer, 40+ is visually identical).
  const statsFile = path.join(dir, 'psnr.log');
  ffmpeg([
    '-start_number', '0', '-i', path.join(dir, 'ref_%03d.png'),
    '-start_number', '0', '-i', path.join(dir, 'preview_%03d.png'),
    '-lavfi', `[0:v]format=rgb24[a];[1:v]format=rgb24[b];[a][b]psnr=stats_file='${statsFile.replace(/'/g, "'\\''")}'`,
    '-f', 'null', '-',
  ]);
  const frames = fs.readFileSync(statsFile, 'utf8').trim().split('\n').map((line) => {
    const n = parseInt(/n:(\d+)/.exec(line)[1], 10) - 1;
    const psnr = /psnr_avg:(\S+)/.exec(line)[1];
    return { frame: n, psnr: psnr === 'inf' ? Infinity : parseFloat(psnr) };
  });

  // 4. Contact sheet of the frames that matter: worst ones and a spread.
  const worst = [...frames].sort((a, b) => a.psnr - b.psnr).slice(0, 3).map((x) => x.frame);
  const picks = [...new Set([0, Math.floor(comp.frames / 3), Math.floor(comp.frames * 2 / 3), comp.frames - 1, ...worst])].sort((a, b) => a - b).slice(0, 6);
  const rows = picks.map((f, i) => {
    const pad = String(f).padStart(3, '0');
    return { f, args: ['-i', path.join(dir, `ref_${pad}.png`), '-i', path.join(dir, `preview_${pad}.png`)], i };
  });
  const inputs = rows.flatMap((r) => r.args);
  const w = 480, h = Math.round(comp.h * w / comp.w);
  const graph = rows.map((r) => {
    const a = 2 * r.i, b = 2 * r.i + 1;
    return `[${a}:v]format=rgb24,scale=${w}:${h},split[ra${r.i}][rb${r.i}];[${b}:v]format=rgb24,scale=${w}:${h},split[pa${r.i}][pb${r.i}];`
      + `[rb${r.i}][pb${r.i}]blend=all_mode=difference,lutrgb=r='min(val*4,255)':g='min(val*4,255)':b='min(val*4,255)'[d${r.i}];`
      + `[ra${r.i}]drawtext=text='ref f${r.f}':x=8:y=8:fontsize=20:fontcolor=yellow[ra2${r.i}];`
      + `[pa${r.i}]drawtext=text='preview f${r.f}':x=8:y=8:fontsize=20:fontcolor=yellow[pa2${r.i}];`
      + `[ra2${r.i}][pa2${r.i}][d${r.i}]hstack=3[row${r.i}]`;
  }).join(';') + `;${rows.map((r) => `[row${r.i}]`).join('')}vstack=${rows.length}[out]`;
  const sheet = path.join(dir, 'sheet.png');
  // Labels need ffmpeg's drawtext, which not every build has.
  const hasDrawtext = /drawtext/.test(execFileSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }));
  ffmpeg([...inputs, '-filter_complex', hasDrawtext ? graph : graph.replace(/drawtext=[^\[]+?(?=\[)/g, 'null'), '-map', '[out]', '-frames:v', '1', sheet]);

  const finite = frames.filter((x) => Number.isFinite(x.psnr)).map((x) => x.psnr);
  const report = {
    comp: compName,
    reference: ref,
    frames: frames.length,
    psnr: {
      min: finite.length ? Math.min(...finite) : Infinity,
      mean: finite.length ? finite.reduce((s, v) => s + v, 0) / finite.length : Infinity,
      identicalFrames: frames.length - finite.length,
    },
    worstFrames: [...frames].sort((a, b) => a.psnr - b.psnr).slice(0, 5),
    perFrame: frames,
    fonts,
    notes,
    sheet,
  };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const outDir = args[0];
  if (!outDir || !opt('comp') || !opt('ref')) {
    console.error('usage: hf2ae-verify <outDir> --comp "<comp name>" --ref <video> [--bg #808080]');
    process.exit(1);
  }
  verify(outDir, { comp: opt('comp'), ref: opt('ref'), bg: opt('bg') }).then((r) => {
    const fmt = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} dB` : 'identical');
    console.log(`${r.comp}: ${r.frames} frames, PSNR mean ${fmt(r.psnr.mean)}, worst ${fmt(r.psnr.min)}`);
    console.log(`worst frames: ${r.worstFrames.map((x) => `f${x.frame} ${fmt(x.psnr)}`).join(', ')}`);
    console.log(`fonts: ${r.fonts.map(([f, ok]) => `${f} ${ok ? 'loaded' : 'MISSING'}`).join('; ')}`);
    if (r.notes.length) console.log(`notes: ${r.notes.join('; ')}`);
    console.log(`sheet: ${r.sheet}`);
  }).catch((e) => {
    console.error(`hf2ae-verify: ${e.message}`);
    process.exit(1);
  });
}
