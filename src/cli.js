#!/usr/bin/env node
// hf2ae <shot.json> [-o outDir]
//
// shot.json:
// {
//   "name": "Punch Demo",
//   "fps": 25,
//   "inputs": [ { "file": "src/solvay.png" },
//               { "file": "src/title.webm", "name": "Punch Title", "hyperframes": "src/title.html" } ],
//   "graph": "<the -filter_complex string>"  (or "graphFile": "graph.txt"),
//   "output": "v",
//   "names": { "A": "Shot 1 – Einstein push" }
// }

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GraphReader } from './ffreader.js';
import { readHyperframes } from './hfreader.js';
import { writeJsx } from './jsxwriter.js';
import { summarize } from './summary.js';
import { P, makeLayer, newId } from './timeline.js';

const STILL = /\.(png|jpe?g|webp|tiff?|bmp)$/i;

function probe(file) {
  const json = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=width,height,nb_read_packets', '-of', 'json', file,
  ], { encoding: 'utf8' });
  const s = JSON.parse(json).streams[0];
  return { w: s.width, h: s.height, frames: STILL.test(file) ? 1 : parseInt(s.nb_read_packets, 10) };
}

export async function convert(shotPath, outDir) {
  const dir = path.dirname(path.resolve(shotPath));
  const shot = JSON.parse(fs.readFileSync(shotPath, 'utf8'));
  const fps = shot.fps || 25;
  const graph = shot.graph || fs.readFileSync(path.resolve(dir, shot.graphFile), 'utf8');
  const notes = [];
  const reader = new GraphReader({ fps, names: shot.names || {}, notes });
  const footage = {};

  const inputs = [];
  for (const input of shot.inputs) {
    const file = path.resolve(dir, input.file);
    const info = probe(file);
    const id = newId('ftg');
    const name = input.name || path.basename(file);
    footage[id] = { id, name: path.basename(file), file, path: file, ...info, still: info.frames === 1 };

    if (input.hyperframes) {
      const hf = await readHyperframes(path.resolve(dir, input.hyperframes), {
        fps, name, reference: { id, w: info.w, h: info.h },
      });
      notes.push(...hf.notes);
      Object.assign(reader.comps, hf.comps);
      const compId = newId('comp');
      reader.comps[compId] = { id: compId, ...hf.comp };
      inputs.push(() => ({
        id: newId('s'), label: null, w: hf.comp.w, h: hf.comp.h, frames: hf.comp.frames, clip: false,
        layers: [makeLayer({
          name, kind: 'comp', source: compId, w: hf.comp.w, h: hf.comp.h, outFrame: hf.comp.frames,
          anchor: P([hf.comp.w / 2, hf.comp.h / 2]), position: P([hf.comp.w / 2, hf.comp.h / 2]),
        })],
      }));
    } else {
      inputs.push(() => ({
        id: newId('s'), label: null, w: info.w, h: info.h, frames: info.frames, clip: false,
        layers: [makeLayer({
          name: input.name || path.basename(file, path.extname(file)), kind: 'footage', source: id,
          w: info.w, h: info.h, outFrame: info.frames === 1 ? 1 : info.frames,
          anchor: P([info.w / 2, info.h / 2]), position: P([info.w / 2, info.h / 2]),
        })],
      }));
    }
  }
  reader.inputs = inputs;

  const out = reader.read(graph, shot.output || 'v');
  const main = reader.precomp(out, shot.name);
  const mainId = main.layers[0].source;

  const timeline = { name: shot.name, fps, main: mainId, footage, comps: reader.comps, notes };
  fs.mkdirSync(outDir, { recursive: true });
  const { jsxPath, data } = writeJsx(timeline, outDir);
  const text = summarize(data);
  fs.writeFileSync(path.join(outDir, 'timeline.txt'), `${text}\n`);
  return { jsxPath, text };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const shot = args.find((a) => !a.startsWith('-'));
  const o = args.indexOf('-o');
  if (!shot) {
    console.error('usage: hf2ae <shot.json> [-o outDir]');
    process.exit(1);
  }
  const outDir = o >= 0 ? args[o + 1] : path.join('out', path.basename(path.dirname(path.resolve(shot))));
  convert(shot, outDir).then(({ jsxPath, text }) => {
    console.log(text);
    console.log(`\nWrote ${jsxPath}`);
  }).catch((e) => {
    console.error(`hf2ae: ${e.message}`);
    process.exit(1);
  });
}
