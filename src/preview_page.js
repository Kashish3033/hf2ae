// Browser-side preview of a hf2ae timeline. It draws a comp on a canvas using
// only what the After Effects project would contain (comps, layers, transforms,
// keyframes with their eases, effects) and none of the original HTML, so
// comparing it with the original render shows what the conversion lost.
//
// AE behaviour is reproduced as hf2ae assumes it (see README "Calibration");
// this checks the conversion, not After Effects itself.
// Plain script (no modules): loaded with page.addScriptTag.

(function () {
  let D = null, CAL = null;
  const images = {};

  // ---- keyframes -------------------------------------------------------------

  function bezierAt(x1, y1, x2, y2, T, v0, v1, x) {
    let lo = 0, hi = 1, u = 0.5;
    for (let k = 0; k < 40; k++) {
      u = (lo + hi) / 2;
      const xu = 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u * u * x2 + u ** 3 * T;
      if (xu < x) lo = u; else hi = u;
    }
    return (1 - u) ** 3 * v0 + 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u * u * y2 + u ** 3 * v1;
  }

  const easeFor = (e, i) => (e ? (Array.isArray(e) ? e[Math.min(i, e.length - 1)] : e) : null);

  function segment(k0, k1, f, i, a, b) {
    const T = k1.f - k0.f;
    if (k0.out === 'hold') return a;
    if (k0.out !== 'bezier' && !k1.easeIn) return a + (b - a) * (f - k0.f) / T;
    const eo = easeFor(k0.easeOut, i) || { speed: 0, influence: 100 / 3 };
    const ei = easeFor(k1.easeIn, i) || { speed: 0, influence: 100 / 3 };
    // A linear side of a bezier segment behaves like a straight-line tangent.
    const lin = (b - a) / T * D.fps;
    const so = k0.out === 'bezier' ? eo.speed : lin, si = k1.easeIn ? ei.speed : lin;
    const x1 = eo.influence / 100 * T, x2 = T - ei.influence / 100 * T;
    return bezierAt(x1, a + so / D.fps * x1, x2, b - si / D.fps * (T - x2), T, a, b, f - k0.f);
  }

  function value(prop, f) {
    if (!prop) return undefined;
    if (!prop.keys) return prop.value;
    const ks = prop.keys;
    if (f <= ks[0].f) return ks[0].v;
    if (f >= ks[ks.length - 1].f) return ks[ks.length - 1].v;
    for (let i = 0; i < ks.length - 1; i++) {
      const k0 = ks[i], k1 = ks[i + 1];
      if (f > k1.f) continue;
      if (Array.isArray(k0.v)) return k0.v.map((a, d) => segment(k0, k1, f, d, a, k1.v[d]));
      return segment(k0, k1, f, 0, k0.v, k1.v);
    }
    return ks[ks.length - 1].v;
  }

  // ---- expressions hf2ae writes ----------------------------------------------

  function opacityOf(comp, layer, f, depth = 0) {
    const ex = layer.expressions && layer.expressions.opacity;
    if (ex && depth < 4) {
      const m = /^thisComp\.layer\("(.+?)"\)\.transform\.opacity(?:\s*\*\s*([\d.]+))?$/.exec(ex);
      if (!m) throw new Error(`preview can't evaluate expression: ${ex}`);
      const src = comp.layers.find((l) => l.name === m[1]);
      return opacityOf(comp, src, f, depth + 1) * (m[2] ? parseFloat(m[2]) : 1);
    }
    return value(layer.opacity, f);
  }

  function textOf(comp, layer) {
    const ex = layer.expressions && layer.expressions.sourceText;
    if (ex) {
      const m = /^thisComp\.layer\("(.+?)"\)\.text\.sourceText$/.exec(ex);
      if (!m) throw new Error(`preview can't evaluate expression: ${ex}`);
      return { ...layer.text, text: comp.layers.find((l) => l.name === m[1]).text.text };
    }
    return layer.text;
  }

  // ---- transforms --------------------------------------------------------------

  function localMatrix(layer, f) {
    const [ax, ay] = value(layer.anchor, f);
    const [px, py] = value(layer.position, f);
    const [sx, sy] = value(layer.scale, f);
    const rot = (value(layer.rotation, f) || 0) * Math.PI / 180;
    return new DOMMatrix().translate(px, py).rotate(rot * 180 / Math.PI).scale(sx / 100, sy / 100).translate(-ax, -ay);
  }

  function worldMatrix(comp, layer, f) {
    let m = localMatrix(layer, f);
    for (let p = layer.parent, n = 0; p && n < 10; n++) {
      const pl = comp.layers.find((l) => l.name === p);
      m = localMatrix(pl, f).multiply(m);
      p = pl.parent;
    }
    return m;
  }

  // ---- drawing -----------------------------------------------------------------

  function canvas(w, h) {
    const c = new OffscreenCanvas(Math.round(w), Math.round(h));
    return c;
  }

  function drawText(ctx, t) {
    ctx.font = `${t.style === 'italic' ? 'italic ' : ''}${t.weight || 400} ${t.size}px "${t.family}"`;
    // AE tracking is in 1/1000 em, between characters (not after the last one).
    const ls = t.tracking / 1000 * t.size;
    ctx.letterSpacing = `${ls}px`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = rgb(t.fill);
    const lines = t.text.split('\r');
    lines.forEach((line, i) => {
      const w = ctx.measureText(line).width - ls;
      const x = t.justify === 'right' ? -w : t.justify === 'center' ? -w / 2 : 0;
      ctx.fillText(line, x, i * (t.leading || t.size * 1.2));
    });
  }

  const rgb = (c, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

  // Draw one layer's own pixels (no effects) into a comp-sized canvas.
  function layerPixels(comp, layer, f) {
    const c = canvas(comp.w, comp.h);
    const ctx = c.getContext('2d');
    ctx.setTransform(worldMatrix(comp, layer, f));
    if (layer.kind === 'text') drawText(ctx, textOf(comp, layer));
    else if (layer.kind === 'solid') { ctx.fillStyle = rgb(layer.color); ctx.fillRect(0, 0, layer.w, layer.h); }
    else if (layer.kind === 'footage') {
      const img = images[layer.source];
      if (!img) throw new Error(`preview: footage ${layer.source} is not an image`);
      ctx.drawImage(img, 0, 0);
    } else if (layer.kind === 'comp') {
      ctx.drawImage(renderComp(layer.source, f - layer.startFrame), 0, 0);
    }
    return c;
  }

  // ---- effects -------------------------------------------------------------------

  function pixels(c, fn) {
    const ctx = c.getContext('2d');
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) fn(d, i);
    ctx.putImageData(img, 0, 0);
  }

  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  function applyEffect(c, fx, f, notes) {
    const v = (k) => value(fx.props[k], f);
    switch (fx.type) {
      case 'levels': {
        const iB = v('inputBlack') ?? 0, iW = v('inputWhite') ?? 1, oB = v('outputBlack') ?? 0, oW = v('outputWhite') ?? 1, g = v('gamma') ?? 1;
        const lut = new Uint8ClampedArray(256);
        for (let x = 0; x < 256; x++) {
          const t = Math.min(Math.max((x / 255 - iB) / (iW - iB), 0), 1) ** (1 / g);
          lut[x] = Math.round((oB + t * (oW - oB)) * 255);
        }
        pixels(c, (d, i) => { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; });
        return c;
      }
      case 'tint': {
        const a = v('amount') / 100;
        pixels(c, (d, i) => { const y = lum(d[i], d[i + 1], d[i + 2]); for (let k = 0; k < 3; k++) d[i + k] += (y - d[i + k]) * a; });
        return c;
      }
      case 'hueSaturation': {
        const s = 1 + v('saturation') / 100;
        pixels(c, (d, i) => { const y = lum(d[i], d[i + 1], d[i + 2]); for (let k = 0; k < 3; k++) d[i + k] = y + (d[i + k] - y) * s; });
        return c;
      }
      case 'invert':
        pixels(c, (d, i) => { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; });
        return c;
      case 'channelMixer': {
        const m = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'].map((k) => v(k) / 100);
        pixels(c, (d, i) => {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          d[i] = m[0] * r + m[1] * g + m[2] * b; d[i + 1] = m[3] * r + m[4] * g + m[5] * b; d[i + 2] = m[6] * r + m[7] * g + m[8] * b;
        });
        return c;
      }
      case 'fill': {
        const ctx = c.getContext('2d');
        ctx.resetTransform(); // the layer's transform is still set from drawing it
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = rgb(v('color'));
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.globalCompositeOperation = 'source-over';
        return c;
      }
      case 'dropShadow': {
        const out = canvas(c.width, c.height);
        const ctx = out.getContext('2d');
        const dir = v('direction') * Math.PI / 180, dist = v('distance');
        const dx = Math.sin(dir) * dist, dy = -Math.cos(dir) * dist;
        ctx.shadowColor = rgb(v('color'), v('opacity') / 100);
        ctx.shadowBlur = v('softness'); // hf2ae maps CSS blur radius 1:1 to softness
        if (v('shadowOnly')) {
          // Draw the layer far outside the canvas so only its shadow lands.
          ctx.shadowOffsetX = dx + 100000;
          ctx.shadowOffsetY = dy;
          ctx.drawImage(c, -100000, 0);
        } else {
          ctx.shadowOffsetX = dx; ctx.shadowOffsetY = dy;
          ctx.drawImage(c, 0, 0);
        }
        return out;
      }
      case 'gaussianBlur': {
        const out = canvas(c.width, c.height);
        const ctx = out.getContext('2d');
        ctx.filter = `blur(${v('blurriness') / CAL.gaussianPerSigma}px)`;
        ctx.drawImage(c, 0, 0);
        return out;
      }
      case 'radialBlur': {
        // ffmpeg's version: average of 8 copies zoomed about the centre.
        const spread = v('amount') / CAL.radialBlurPerZoom;
        if (spread <= 0) return c;
        const [cx, cy] = v('center');
        const out = canvas(c.width, c.height);
        const ctx = out.getContext('2d');
        for (let i = 0; i < 8; i++) {
          const z = 1 + spread * i / 7;
          ctx.globalAlpha = 1 / (i + 1);
          ctx.setTransform(new DOMMatrix().translate(cx, cy).scale(z, z).translate(-cx, -cy));
          ctx.drawImage(c, 0, 0);
        }
        return out;
      }
      case 'noise':
        notes.add('Noise (grain) is random, so the preview leaves it out');
        return c;
      default:
        notes.add(`preview has no ${fx.type} effect`);
        return c;
    }
  }

  const BLEND = {
    normal: 'source-over', screen: 'screen', multiply: 'multiply', overlay: 'overlay', addition: 'lighter',
    lighten: 'lighten', darken: 'darken', difference: 'difference', softlight: 'soft-light', hardlight: 'hard-light',
    luminosity: 'luminosity', color: 'color',
  };

  const notes = new Set();

  function renderComp(id, f) {
    const comp = D.comps[id];
    const out = canvas(comp.w, comp.h);
    const ctx = out.getContext('2d');
    for (const layer of comp.layers) {
      if (layer.enabled === false || f < layer.inFrame || f >= layer.outFrame) continue;
      const op = opacityOf(comp, layer, f) / 100;
      if (layer.kind === 'adjustment') {
        let below = canvas(comp.w, comp.h);
        below.getContext('2d').drawImage(out, 0, 0);
        for (const fx of layer.effects) below = applyEffect(below, fx, f, notes);
        // At 100% Normal the result replaces what's below; otherwise it is
        // blended back over it with the layer's mode and opacity.
        const mode = BLEND[layer.blend] || 'source-over';
        ctx.globalAlpha = op;
        ctx.globalCompositeOperation = op >= 1 && mode === 'source-over' ? 'copy' : mode;
        ctx.drawImage(below, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        continue;
      }
      let c = layerPixels(comp, layer, f);
      for (const fx of layer.effects) c = applyEffect(c, fx, f, notes);
      ctx.globalAlpha = op;
      ctx.globalCompositeOperation = BLEND[layer.blend] || 'source-over';
      ctx.drawImage(c, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    return out;
  }

  window.hf2aePreview = {
    async init(data, calibration) {
      D = data;
      CAL = calibration;
      for (const [id, fd] of Object.entries(D.footage)) {
        if (!fd.still) continue;
        const img = new Image();
        img.src = fd.file;
        await img.decode();
        images[id] = img;
      }
      const fonts = new Set();
      for (const c of Object.values(D.comps)) {
        for (const l of c.layers) {
          if (l.kind === 'text') fonts.add(`${l.text.style === 'italic' ? 'italic ' : ''}${l.text.weight || 400} ${l.text.size}px "${l.text.family}"`);
        }
      }
      for (const f of fonts) await document.fonts.load(f);
      return [...fonts].map((f) => [f, document.fonts.check(f)]);
    },
    // Render comp `id` at frame f over a background colour; returns a PNG data URL.
    async frame(id, f, bg) {
      const c = renderComp(id, f);
      const out = canvas(c.width, c.height);
      const ctx = out.getContext('2d');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(c, 0, 0);
      const blob = await out.convertToBlob({ type: 'image/png' });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(s);
    },
    notes: () => [...notes],
  };
})();
