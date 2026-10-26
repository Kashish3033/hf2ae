// Parser for ffmpeg -filter_complex strings.
//
// "[0:v]scale=2560:1440,loop=loop=-1:size=1[ph];[ph][tt]overlay=0:0[comp]"
// -> [{ inputs: ['0:v'], outputs: ['ph'], filters: [{name:'scale', args:{...}}, ...] }, ...]
//
// Labels in the middle of a chain are not supported (ffmpeg allows them but
// the Frameo graphs never use them).

// Positional argument names for the filters we read, from the ffmpeg docs.
const POSITIONAL = {
  scale: ['w', 'h'],
  crop: ['w', 'h', 'x', 'y'],
  overlay: ['x', 'y'],
  trim: ['start', 'end'],
  fade: ['type', 'start_frame', 'nb_frames'],
  split: ['outputs'],
  concat: [],
  hue: ['h', 's'],
  eq: ['contrast', 'brightness', 'saturation', 'gamma'],
  gblur: ['sigma', 'steps'],
  negate: ['negate_alpha'],
  fps: ['fps'],
  setpts: ['expr'],
  setsar: ['r'],
  format: ['pix_fmts'],
  loop: ['loop', 'size', 'start'],
  noise: [],
  zoompan: ['zoom'],
  mix: ['inputs'],
  color: ['c', 's', 'r', 'd'],
  drawbox: ['x', 'y', 'w', 'h', 'c', 't'],
  colorchannelmixer: ['rr', 'rg', 'rb', 'ra', 'gr', 'gg', 'gb', 'ga', 'br', 'bg', 'bb', 'ba'],
  vignette: ['angle'],
  tpad: [],
};

// Split on `sep` at the top level: not inside '...' quotes or [labels],
// and not after a backslash escape.
function splitTop(str, sep) {
  const out = [];
  let cur = '';
  let quote = false;
  let bracket = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\\' && i + 1 < str.length) { cur += c + str[++i]; continue; }
    if (c === "'") quote = !quote;
    else if (!quote && c === '[') bracket++;
    else if (!quote && c === ']') bracket--;
    if (c === sep && !quote && bracket === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// Remove one level of ffmpeg quoting/escaping from an option value.
function unquote(v) {
  let out = '';
  let quote = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === "'") { quote = !quote; continue; }
    if (c === '\\' && i + 1 < v.length) { out += v[++i]; continue; }
    out += c;
  }
  return out.trim();
}

function parseFilter(text) {
  const eq = text.indexOf('=');
  const name = (eq < 0 ? text : text.slice(0, eq)).trim();
  const args = {};
  const positional = [];
  if (eq >= 0) {
    for (const part of splitTop(text.slice(eq + 1), ':')) {
      // key=value only when the '=' comes before any quote or paren,
      // otherwise it is a positional expression such as 'eq(n,3)'.
      const m = /^\s*([A-Za-z_][A-Za-z_0-9]*)=/.exec(part);
      if (m) args[m[1]] = unquote(part.slice(m[0].length));
      else positional.push(unquote(part));
    }
  }
  const names = POSITIONAL[name] || [];
  positional.forEach((v, i) => {
    const key = names[i] ?? `_${i}`;
    if (!(key in args)) args[key] = v;
  });
  return { name, args };
}

function takeLabels(str, fromEnd) {
  const labels = [];
  let s = str.trim();
  const re = fromEnd ? /\[([^\]]+)\]\s*$/ : /^\s*\[([^\]]+)\]/;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (fromEnd) labels.unshift(m[1]);
    else labels.push(m[1]);
    s = fromEnd ? s.slice(0, m.index) : s.slice(m[0].length);
  }
  return { labels, rest: s.trim() };
}

export function parseFiltergraph(graph) {
  const chains = [];
  for (const raw of splitTop(graph.replace(/\n/g, ''), ';')) {
    if (!raw.trim()) continue;
    const head = takeLabels(raw, false);
    const tail = takeLabels(head.rest, true);
    const filters = splitTop(tail.rest, ',').map((f) => parseFilter(f));
    chains.push({ inputs: head.labels, outputs: tail.labels, filters, text: raw.trim() });
  }
  return chains;
}
