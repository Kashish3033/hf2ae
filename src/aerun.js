#!/usr/bin/env node
// hf2ae-aerun <outDir> [--no-render]
//
// Runs a converted shot through real After Effects: the .jsx in outDir is
// run in AE (via AppleScript, AE must be open) in batch mode, which saves
// outDir/project.aep and writes its report to ae_report.txt; then
// aerender renders the main comp to outDir/ae_render.mov.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const AE_DIR = process.env.AE_DIR || '/Applications/Adobe After Effects 2026';
const AE_APP = path.basename(AE_DIR); // "Adobe After Effects 2026"

const jsString = (s) => JSON.stringify(s); // a JS string literal ExtendScript also reads

// The lines of an AE report that are warnings, not its header or effect listing.
export function reportWarnings(report) {
  return report.split(/\r\n?|\n/).filter((l) => !/^(effect [^/]*:|  .*|hf2ae report for .*|After Effects \S+|)$/.test(l));
}

export function runInAE(outDir) {
  outDir = path.resolve(outDir);
  const jsx = fs.readdirSync(outDir).find((f) => f.endsWith('.jsx') && f !== 'aerun_wrapper.jsx');
  if (!jsx) throw new Error(`no .jsx in ${outDir}`);
  const aep = path.join(outDir, 'project.aep');
  fs.rmSync(aep, { force: true });
  const wrapper = path.join(outDir, 'aerun_wrapper.jsx');
  fs.writeFileSync(wrapper, [
    `var HF2AE_BATCH = { base: ${jsString(outDir)}, save: ${jsString(aep)} };`,
    `$.global.HF2AE_RESULT = 'no result';`,
    `try { $.evalFile(new File(${jsString(path.join(outDir, jsx))})); } catch (e) { $.global.HF2AE_RESULT = 'SCRIPT ERROR: ' + e.toString() + ' (line ' + e.line + ')'; }`,
    // AE's AppleScript bridge doesn't return script results, so the report
    // goes to a file.
    `var hf2aeOut = new File(${jsString(path.join(outDir, 'ae_report.txt'))});`,
    `hf2aeOut.encoding = 'UTF-8'; hf2aeOut.lineFeed = 'Unix'; hf2aeOut.open('w'); hf2aeOut.write($.global.HF2AE_RESULT); hf2aeOut.close();`,
  ].join('\n'));
  const reportFile = path.join(outDir, 'ae_report.txt');
  fs.rmSync(reportFile, { force: true });
  execFileSync('osascript', ['-e', `tell application ${jsString(AE_APP)} to DoScriptFile ${jsString(wrapper)}`], {
    encoding: 'utf8', timeout: 10 * 60 * 1000,
  });
  if (!fs.existsSync(reportFile)) throw new Error('AE wrote no report; is After Effects open, with "Allow Scripts to Write Files and Access Network" on?');
  const result = fs.readFileSync(reportFile, 'utf8').trim();
  if (result.startsWith('SCRIPT ERROR')) throw new Error(result);
  if (!fs.existsSync(aep)) throw new Error(`AE didn't save ${aep}; report: ${result.slice(0, 300)}`);
  return { aep, report: result };
}

export function renderInAE(outDir) {
  outDir = path.resolve(outDir);
  const data = JSON.parse(fs.readFileSync(path.join(outDir, 'timeline.json'), 'utf8'));
  const comp = data.comps[data.main].name;
  const out = path.join(outDir, 'ae_render.mov');
  fs.rmSync(out, { force: true });
  execFileSync(path.join(AE_DIR, 'aerender'), [
    '-project', path.join(outDir, 'project.aep'), '-comp', comp, '-output', out, '-OMtemplate', 'High Quality',
  ], { encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 64 << 20 });
  if (!fs.existsSync(out)) throw new Error('aerender produced no file');
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [outDir, ...rest] = process.argv.slice(2);
  if (!outDir) {
    console.error('usage: hf2ae-aerun <outDir> [--no-render]');
    process.exit(1);
  }
  try {
    const { aep, report } = runInAE(outDir);
    const warnings = reportWarnings(report);
    console.log(`built ${aep}`);
    console.log(warnings.length ? `warnings:\n  ${warnings.join('\n  ')}` : 'no warnings');
    if (!rest.includes('--no-render')) console.log(`rendered ${renderInAE(outDir)}`);
  } catch (e) {
    console.error(`hf2ae-aerun: ${e.message}`);
    process.exit(1);
  }
}
