// Print a prepared timeline the way the AE timeline panel would show it.

const fmtFrames = (f, fps) => `${(f / fps).toFixed(2)}s (f${f})`;

function propNote(name, p) {
  if (!p || !p.keys) return null;
  const kinds = [...new Set(p.keys.map((k) => k.out))].join('/');
  return `${name} ${p.keys.length} keys (${kinds})`;
}

export function summarize(data) {
  const lines = [];
  const walk = (id, depth) => {
    const c = data.comps[id];
    const pad = '  '.repeat(depth);
    lines.push(`${pad}▣ ${c.name}  ${c.w}x${c.h}, ${fmtFrames(c.frames, data.fps)}${c.camera ? `  [camera zoom ${c.camera.zoom}]` : ''}`);
    for (const l of [...c.layers].reverse()) {
      const anim = ['position', 'scale', 'opacity', 'rotation', 'anchor'].map((k) => propNote(k, l[k])).filter(Boolean);
      const fx = l.effects.map((e) => e.name + (Object.values(e.props).some((p) => p && p.keys) ? '*' : ''));
      const tags = [
        l.kind,
        l.blend && l.blend !== 'normal' ? `blend ${l.blend}` : null,
        l.parent ? `parent → ${l.parent}` : null,
        l.trackMatte ? `${l.trackMatte.type} matte: ${l.trackMatte.layer}` : null,
        l.threeDPerChar ? 'per-character 3D' : null,
        l.text && l.text.animators ? l.text.animators.map((a) => `${a.name} by ${a.based}: ${Object.keys(a.props).join('/')}`).join('; ') : null,
        l.enabled === false ? 'off' : null,
      ].filter(Boolean).join(', ');
      lines.push(`${pad}  • ${l.name}  [${tags}]  ${l.inFrame}–${l.outFrame}`
        + (anim.length ? `  | ${anim.join(', ')}` : '')
        + (fx.length ? `  | fx: ${fx.join(', ')}` : ''));
      if (l.kind === 'comp') walk(l.source, depth + 2);
    }
  };
  walk(data.main, 0);
  if (data.notes.length) {
    lines.push('', 'Notes:');
    for (const n of data.notes) lines.push(`  - ${n}`);
  }
  return lines.join('\n');
}
