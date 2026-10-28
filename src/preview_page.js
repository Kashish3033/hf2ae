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
      if (f >= k1.f) continue; // on a key's own frame, the next segment starts
      // Spatial props (position) carry one ease for the whole path: speed is
      // along the straight line from k0 to k1, as in AE.
      const scalarEase = (e) => e && !Array.isArray(e);
      if (Array.isArray(k0.v) && (scalarEase(k0.easeOut) || scalarEase(k1.easeIn))) {
        const D = Math.hypot(...k0.v.map((a, d) => k1.v[d] - a));
        if (D < 1e-9) return k0.v;
        const t = segment(k0, k1, f, 0, 0, D) / D;
        return k0.v.map((a, d) => a + (k1.v[d] - a) * t);
      }
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

  const GENERIC = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'];
  const fontString = (t) => `${t.style === 'italic' || t.fauxItalic ? 'italic ' : ''}${t.fauxBold ? 700 : (t.weight || 400)} ${t.size}px ${GENERIC.includes(t.family) ? t.family : `"${t.family}"`}`;

  function drawText(ctx, t) {
    ctx.font = fontString(t);
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


  // ---- Text Animators, as AE applies them ---------------------------------------

  // Units of the text and their character ranges (AE "Based On").
  function units(text, based) {
    if (based === 'words') return [...text.matchAll(/\S+/g)].map((m) => ({ s: m[0], i: m.index }));
    if (based === 'lines') return text.split('\r').map((line, k, all) => ({ s: line, i: all.slice(0, k).join('\r').length + (k ? 1 : 0) }));
    return Array.from(text).map((ch, k, all) => ({ s: ch, i: all.slice(0, k).join('').length }));
  }

  // Range Selector, Square shape, percentage units: how much of unit k (of n)
  // lies inside [start, end] + offset.
  function amount(sel, k, n, f) {
    const off = value(sel.offset, f) || 0;
    let a = (value(sel.start, f) + off) / 100, b = (value(sel.end, f) + off) / 100;
    if (a > b) [a, b] = [b, a];
    const u0 = k / n, u1 = (k + 1) / n;
    return Math.min(Math.max((Math.min(b, u1) - Math.max(a, u0)) * n, 0), 1);
  }

  const SCRAMBLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const hash = (k, f) => { let x = (k * 374761393 + f * 668265263) | 0; x = (x ^ (x >>> 13)) * 1274126177; return Math.abs(x ^ (x >>> 16)); };

  // One animator (hf2ae writes one per text.animate selector).
  function drawAnimated(ctx, t, layer, comp, f) {
    const A = t.animators[0];
    if (t.animators.length > 1) notes.add('preview draws the first text animator only');
    ctx.font = fontString(t);
    const ls = t.tracking / 1000 * t.size;
    ctx.letterSpacing = `${ls}px`;
    ctx.textBaseline = 'alphabetic';
    const text = t.text;
    const total = ctx.measureText(text).width - ls;
    const x0 = t.justify === 'right' ? -total : t.justify === 'center' ? -total / 2 : 0;
    const m = ctx.measureText('M');
    // Grouping alignment 0,-50%: units pivot on the middle of the em box.
    const oy = -(m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2;
    const us = units(text, A.based);
    const p = A.props;
    const world = ctx.getTransform();
    const threeD = layer.threeDPerChar && comp.camera;
    us.forEach((u, k) => {
      const a = amount(A.selector, k, us.length, f);
      let str = u.s;
      if (p.scramble && a > 0) str = SCRAMBLE[hash(k, f) % SCRAMBLE.length];
      const ux = x0 + ctx.measureText(text.slice(0, u.i)).width;
      const uw = ctx.measureText(u.s).width - ls;
      const cx = ux + uw / 2;
      const op = p.opacity !== undefined ? (100 + a * (p.opacity - 100)) / 100 : 1;
      if (op <= 0) return;
      const [dx, dy, dz] = (p.position || [0, 0, 0]).map((v) => v * a);
      const sc = p.scale ? (100 + a * (p.scale[0] - 100)) / 100 : 1;
      const rz = (p.rotation || 0) * a;
      const rx = (p.rotationX || 0) * a;
      if (!threeD || (!rx && !dz)) {
        ctx.save();
        ctx.globalAlpha *= op;
        ctx.translate(cx + dx, oy + dy);
        ctx.rotate(rz * Math.PI / 180);
        ctx.scale(sc, sc);
        ctx.fillStyle = rgb(t.fill);
        ctx.fillText(str, -uw / 2 - (ux - (cx - uw / 2)), -oy);
        ctx.restore();
        return;
      }
      // Per-character 3D seen through the comp camera (zoom = CSS perspective).
      // AE z points away from the viewer and its X rotation turns the other
      // way to CSS (hf2ae flipped both), so flip back to project.
      const asc = m.fontBoundingBoxAscent, desc = m.fontBoundingBoxDescent;
      const pad = 4, gw = Math.ceil(uw + 2 * pad), gh = Math.ceil(asc + desc + 2 * pad);
      const g = new OffscreenCanvas(gw, gh), gc = g.getContext('2d');
      gc.font = ctx.font; gc.letterSpacing = ctx.letterSpacing; gc.textBaseline = 'alphabetic'; gc.fillStyle = rgb(t.fill);
      gc.fillText(str, pad, pad + asc);
      const th = -rx * Math.PI / 180, cssZ = -dz, P = comp.camera.zoom;
      const ccx = comp.w / 2, ccy = comp.h / 2;
      // Project a point of the glyph (yl relative to the pivot) to the comp.
      const project = (xl, yl) => {
        const yr = yl * Math.cos(th), zr = yl * Math.sin(th) + cssZ;
        const k = P / (P - zr);
        const q = world.transformPoint(new DOMPoint(cx + xl + dx, oy + yr + dy));
        return { x: ccx + (q.x - ccx) * k, y: ccy + (q.y - ccy) * k, ok: k > 0 && isFinite(k) };
      };
      // Each glyph row lands between its projected top and bottom edges, so
      // rows tile without gaps or overlaps; the opacity goes on once, after.
      const proj = new OffscreenCanvas(comp.w, comp.h), pc = proj.getContext('2d');
      for (let r = 0; r < gh; r++) {
        const y0 = (r - pad - asc) - oy, y1 = y0 + 1;
        const tl = project(-gw / 2, y0), tr = project(gw / 2, y0), bl = project(-gw / 2, y1);
        if (!tl.ok || !bl.ok) continue;
        const top = Math.min(tl.y, bl.y), hRow = Math.abs(bl.y - tl.y);
        if (hRow < 1e-3) continue;
        pc.drawImage(g, 0, r, gw, 1, tl.x, top, tr.x - tl.x, hRow);
      }
      ctx.save();
      ctx.resetTransform();
      ctx.globalAlpha *= op;
      ctx.drawImage(proj, 0, 0);
      ctx.restore();
    });
  }

  const rgb = (c, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;


  // ---- shape layers ------------------------------------------------------------

  // Polystar vertices, first point straight up, clockwise (as AE draws them).
  function starPoints(n, outer, inner, [cx, cy], polygon) {
    const pts = [];
    const count = polygon ? n : n * 2;
    for (let i = 0; i < count; i++) {
      const r = polygon || i % 2 === 0 ? outer : inner;
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }

  // Miter offset of a closed polygon by d (outward when d > 0).
  function offsetPolygon(pts, d) {
    const n = pts.length;
    let area = 0;
    for (let i = 0; i < n; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n]; area += x1 * y2 - x2 * y1; }
    const sgn = area > 0 ? 1 : -1; // y-down: positive area = clockwise on screen
    const lines = pts.map((p, i) => {
      const q = pts[(i + 1) % n];
      const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy);
      const nx = (dy / len) * sgn, ny = (-dx / len) * sgn;
      return [[p[0] + nx * d, p[1] + ny * d], [q[0] + nx * d, q[1] + ny * d]];
    });
    return lines.map((l, i) => {
      const [a, b] = lines[(i - 1 + n) % n], [c, e] = l;
      const d1 = [b[0] - a[0], b[1] - a[1]], d2 = [e[0] - c[0], e[1] - c[1]];
      const den = d1[0] * d2[1] - d1[1] * d2[0];
      if (Math.abs(den) < 1e-9) return c;
      const t = ((c[0] - a[0]) * d2[1] - (c[1] - a[1]) * d2[0]) / den;
      return [a[0] + d1[0] * t, a[1] + d1[1] * t];
    });
  }

  function polyPath(pts) { const p = new Path2D(); pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y))); p.closePath(); return p; }

  function geomPath(g) {
    if (g.poly) return polyPath(g.poly);
    const p = new Path2D();
    if (g.ellipse) p.ellipse(g.ellipse[0], g.ellipse[1], Math.max(g.ellipse[2], 0), Math.max(g.ellipse[3], 0), 0, 0, 2 * Math.PI);
    if (g.rect) { const [x, y, w, h, r] = g.rect; p.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); }
    return p;
  }

  // Draw a group's contents. Geometry collects until an operator or a
  // paint uses it; merges are done on raster masks (canvas compositing).
  // Points of a geometry, mapped through m (to bake a group's transform).
  function mapGeom(g, m) {
    if (g.raster || m.isIdentity) return g;
    const pt = ([x, y]) => { const q = m.transformPoint(new DOMPoint(x, y)); return [q.x, q.y]; };
    const toPoly = (gg) => {
      if (gg.poly) return gg.poly;
      if (gg.ellipse) { const [cx, cy, rx, ry] = gg.ellipse; return Array.from({ length: 96 }, (_, i) => [cx + rx * Math.cos(i * Math.PI / 48), cy + ry * Math.sin(i * Math.PI / 48)]); }
      const [x, y, w, h] = gg.rect; return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    };
    return { poly: toPoly(g).map(pt) };
  }

  // Returns the group's geometry: in AE a Fill or Stroke also paints the
  // paths of groups above it in the same group.
  function drawContents(ctx, items, f, compW, compH) {
    let geoms = [];
    for (const it of items) {
      const v = (k) => value(it[k], f);
      if (it.type === 'group') {
        ctx.save();
        let gm = new DOMMatrix();
        if (it.skew) { const k = Math.tan((value(it.skew, f) || 0) * Math.PI / 180); gm = new DOMMatrix([1, 0, k, 1, 0, 0]); ctx.transform(1, 0, k, 1, 0, 0); }
        const inner = drawContents(ctx, it.items, f, compW, compH);
        ctx.restore();
        geoms.push(...inner.map((g) => mapGeom(g, gm)));
        continue;
      }
      if (it.type === 'rect') { const [w, h] = v('size'), [x, y] = it.position ? v('position') : [0, 0]; geoms.push({ rect: [x - w / 2, y - h / 2, w, h, it.roundness ? v('roundness') : 0] }); }
      else if (it.type === 'ellipse') { const [w, h] = v('size'), [x, y] = it.position ? v('position') : [0, 0]; geoms.push({ ellipse: [x, y, w / 2, h / 2] }); }
      else if (it.type === 'star') geoms.push({ poly: starPoints(v('points'), v('outer'), it.inner ? v('inner') : 0, it.position ? v('position') : [0, 0], it.star === 'polygon') });
      else if (it.type === 'offset') {
        const d = v('amount');
        geoms = geoms.map((g) => {
          if (g.poly) return { poly: offsetPolygon(g.poly, d) };
          if (g.ellipse) return { ellipse: [g.ellipse[0], g.ellipse[1], g.ellipse[2] + d, g.ellipse[3] + d] };
          notes.add('preview offsets polygons and ellipses only');
          return g;
        });
      } else if (it.type === 'merge') {
        const m = new OffscreenCanvas(compW, compH), mc = m.getContext('2d');
        mc.setTransform(ctx.getTransform());
        const op = { add: 'source-over', intersect: 'destination-in', exclude: 'xor', subtract: 'destination-out' }[it.mode] || 'source-over';
        geoms.forEach((g, i) => {
          mc.globalCompositeOperation = i === 0 ? 'source-over' : op;
          if (g.raster) { mc.save(); mc.resetTransform(); mc.drawImage(g.raster, 0, 0); mc.restore(); }
          else { mc.fillStyle = '#fff'; mc.fill(geomPath(g)); }
        });
        geoms = [{ raster: m }];
      } else if (it.type === 'fill') {
        const color = rgb(v('color'), (it.opacity ? v('opacity') : 100) / 100);
        for (const g of geoms) {
          if (g.raster) {
            const r = new OffscreenCanvas(compW, compH), rc = r.getContext('2d');
            rc.drawImage(g.raster, 0, 0);
            rc.globalCompositeOperation = 'source-in';
            rc.fillStyle = color;
            rc.fillRect(0, 0, compW, compH);
            ctx.save(); ctx.resetTransform(); ctx.drawImage(r, 0, 0); ctx.restore();
          } else {
            ctx.fillStyle = color;
            ctx.fill(geomPath(g), it.rule === 'evenodd' ? 'evenodd' : 'nonzero');
          }
        }
      } else if (it.type === 'stroke') {
        ctx.strokeStyle = rgb(v('color'), (it.opacity ? v('opacity') : 100) / 100);
        ctx.lineWidth = v('width');
        ctx.lineJoin = 'miter';
        for (const g of geoms) {
          if (g.raster) { notes.add('preview cannot stroke a merged path'); continue; }
          ctx.stroke(geomPath(g));
        }
      }
    }
    return geoms;
  }

  // Mask paths: linear between keys (hf2ae writes linear mask keys).
  function maskPath(mask, f) {
    const P = mask.path;
    if (!P.keys) return polyPath(P.value);
    const ks = P.keys;
    if (f <= ks[0].f) return polyPath(ks[0].v);
    for (let i = 0; i < ks.length - 1; i++) {
      if (f > ks[i + 1].f) continue;
      const t = ks[i].out === 'hold' ? 0 : (f - ks[i].f) / (ks[i + 1].f - ks[i].f);
      return polyPath(ks[i].v.map((p, j) => [p[0] + (ks[i + 1].v[j][0] - p[0]) * t, p[1] + (ks[i + 1].v[j][1] - p[1]) * t]));
    }
    return polyPath(ks[ks.length - 1].v);
  }

  // The 'gradient' effect as the AE script builds it (Gradient Ramp from an
  // Angle/Radius slider; conic via Polar Coordinates), in the solid's space.
  function paintGradient(ctx, fx, w, h, f) {
    const P = fx.props, mode = P.mode.value;
    const [cx, cy] = value(P.center, f);
    const p0 = P.startAt.value, p1 = P.endAt.value;
    let g;
    if (mode === 'radial') {
      const R = value(P.radius, f);
      g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(R * p1, 0.001));
      g.addColorStop(0, rgb(P.startColor.value));
      g.addColorStop(1, rgb(P.endColor.value));
    } else if (mode === 'conic') {
      g = ctx.createConicGradient((value(P.angle, f) - 90) * Math.PI / 180, cx, cy);
      g.addColorStop(p0, rgb(P.startColor.value));
      g.addColorStop(p1, rgb(P.endColor.value));
    } else {
      const a = value(P.angle, f) * Math.PI / 180, d = [Math.sin(a), -Math.cos(a)];
      const L = Math.abs(w * d[0]) + Math.abs(h * d[1]);
      g = ctx.createLinearGradient(cx + d[0] * L * (p0 - 0.5), cy + d[1] * L * (p0 - 0.5), cx + d[0] * L * (p1 - 0.5), cy + d[1] * L * (p1 - 0.5));
      g.addColorStop(0, rgb(P.startColor.value));
      g.addColorStop(1, rgb(P.endColor.value));
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  // CC Light Sweep as hf2ae maps it: a band through `center`, its own
  // direction, `width` either side, over the layer's pixels.
  function paintSweep(ctx, fx, w, h, f) {
    const P = fx.props;
    const [cx, cy] = value(P.center, f);
    const a = (value(P.direction, f) + 90) * Math.PI / 180, n = [Math.sin(a), -Math.cos(a)];
    const half = value(P.width, f);
    const g = ctx.createLinearGradient(cx - n[0] * half, cy - n[1] * half, cx + n[0] * half, cy + n[1] * half);
    const c = value(P.color, f), k = value(P.intensity, f) / 100;
    g.addColorStop(0, rgb(c, 0)); g.addColorStop(0.5, rgb(c, k)); g.addColorStop(1, rgb(c, 0));
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // Draw one layer's own pixels (no effects) into a comp-sized canvas.
  function layerPixels(comp, layer, f) {
    const c = canvas(comp.w, comp.h);
    const ctx = c.getContext('2d');
    ctx.setTransform(worldMatrix(comp, layer, f));
    if (layer.kind === 'text') {
      const t = textOf(comp, layer);
      if (t.animators && t.animators.length) drawAnimated(ctx, t, layer, comp, f);
      else drawText(ctx, t);
    }
    else if (layer.kind === 'solid') {
      ctx.fillStyle = rgb(layer.color);
      ctx.fillRect(0, 0, layer.w, layer.h);
      // Generators replace the solid's pixels in its own space.
      for (const fx of layer.effects) {
        if (fx.type === 'gradient') paintGradient(ctx, fx, layer.w, layer.h, f);
        if (fx.type === 'lightSweep') paintSweep(ctx, fx, layer.w, layer.h, f);
      }
    } else if (layer.kind === 'shape') drawContents(ctx, layer.contents, f, comp.w, comp.h);
    else if (layer.kind === 'footage') {
      let img = images[layer.source];
      if (Array.isArray(img)) img = img[Math.min(Math.max(f - layer.startFrame, 0), img.length - 1)];
      if (!img) throw new Error(`preview: footage ${layer.source} wasn't loaded`);
      ctx.drawImage(img, 0, 0);
    } else if (layer.kind === 'comp') {
      ctx.drawImage(renderComp(layer.source, f - layer.startFrame), 0, 0);
    }
    if (layer.masks && layer.masks.length) {
      ctx.setTransform(worldMatrix(comp, layer, f));
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = '#fff';
      const all = new Path2D();
      for (const m of layer.masks) all.addPath(maskPath(m, f));
      ctx.fill(all);
      ctx.globalCompositeOperation = 'source-over';
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
      case 'gradient':
      case 'lightSweep':
        return c; // drawn as the solid's pixels
      case 'directionalBlur': {
        // Gaussian along the direction (AE: 0 = vertical, 90 = horizontal),
        // as three box passes of running averages.
        const sigma = v('length') / CAL.blurLengthPerSigma;
        if (!(sigma > 0.3)) return c;
        const a = (v('direction') * Math.PI) / 180, dir = [Math.sin(a), -Math.cos(a)];
        const width = Math.max(1, Math.round(Math.sqrt(4 * sigma * sigma + 1)));
        let cur = c;
        for (let pass = 0; pass < 3; pass++) {
          const out = canvas(c.width, c.height), ctx = out.getContext('2d');
          for (let i = 0; i < width; i++) {
            const o = i - (width - 1) / 2;
            ctx.globalAlpha = 1 / (i + 1);
            ctx.drawImage(cur, dir[0] * o, dir[1] * o);
          }
          cur = out;
        }
        return cur;
      }
      case 'shiftChannels': {
        const keep = { red: 0, green: 1, blue: 2 }[fx.props.keep.value];
        pixels(c, (d, i) => { for (let k = 0; k < 3; k++) if (k !== keep) d[i + k] = 0; });
        return c;
      }
      case 'opticsCompensation': {
        // Barrel distortion as hf2ae maps lensDistortion: k = FOV / opticsFovPerK,
        // a source radius r * (1 + k r^2), r normalised to the half diagonal.
        const k = v('fov') / CAL.opticsFovPerK;
        if (Math.abs(k) < 1e-4) return c;
        const W = c.width, H = c.height, R = Math.hypot(W, H) / 2;
        const src = c.getContext('2d').getImageData(0, 0, W, H).data;
        const out = canvas(W, H), octx = out.getContext('2d'), img = octx.createImageData(W, H), d = img.data;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const nx = (x - W / 2) / R, ny = (y - H / 2) / R, f = 1 + k * (nx * nx + ny * ny);
            const sx = Math.round(W / 2 + nx * f * R), sy = Math.round(H / 2 + ny * f * R);
            if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
            const si = (sy * W + sx) * 4, di = (y * W + x) * 4;
            d[di] = src[si]; d[di + 1] = src[si + 1]; d[di + 2] = src[si + 2]; d[di + 3] = src[si + 3];
          }
        }
        octx.putImageData(img, 0, 0);
        return out;
      }
      default:
        notes.add(`preview has no ${fx.type} effect`);
        return c;
    }
  }

  const BLEND = {
    normal: 'source-over', screen: 'screen', multiply: 'multiply', overlay: 'overlay', addition: 'lighter',
    lighten: 'lighten', darken: 'darken', difference: 'difference', softlight: 'soft-light', hardlight: 'hard-light',
    luminosity: 'luminosity', color: 'color', dissolve: 'source-over', exclusion: 'exclusion',
    colorDodge: 'color-dodge', colorBurn: 'color-burn', hue: 'hue', saturation: 'saturation',
  };

  const notes = new Set();

  function renderComp(id, f) {
    const comp = D.comps[id];
    const out = canvas(comp.w, comp.h);
    const ctx = out.getContext('2d');
    const mattes = new Set(comp.layers.filter((l) => l.trackMatte).map((l) => l.trackMatte.layer));
    for (const layer of comp.layers) {
      if (layer.enabled === false || f < layer.inFrame || f >= layer.outFrame) continue;
      if (mattes.has(layer.name)) continue; // a track matte isn't drawn itself
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
      if (layer.trackMatte) {
        const ml = comp.layers.find((l) => l.name === layer.trackMatte.layer);
        let mc = canvas(comp.w, comp.h);
        if (ml && f >= ml.inFrame && f < ml.outFrame) {
          mc = layerPixels(comp, ml, f);
          for (const fx of ml.effects) mc = applyEffect(mc, fx, f, notes);
        }
        if (layer.trackMatte.type === 'luma') {
          pixels(mc, (d, i) => { d[i + 3] = lum(d[i], d[i + 1], d[i + 2]) * d[i + 3] / 255; });
        }
        const cc = c.getContext('2d');
        cc.resetTransform();
        cc.globalAlpha = ml ? opacityOf(comp, ml, f) / 100 : 1;
        cc.globalCompositeOperation = 'destination-in';
        cc.drawImage(mc, 0, 0);
        cc.globalAlpha = 1;
        cc.globalCompositeOperation = 'source-over';
      }
      ctx.globalAlpha = op;
      ctx.globalCompositeOperation = BLEND[layer.blend] || 'source-over';
      ctx.drawImage(c, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    return out;
  }

  window.hf2aePreview = {
    // videoFrames: footage id -> list of frame image URLs (extracted by verify.js).
    async init(data, calibration, videoFrames = {}) {
      D = data;
      CAL = calibration;
      const load = async (src) => { const img = new Image(); img.src = src; await img.decode(); return img; };
      for (const [id, fd] of Object.entries(D.footage)) {
        if (fd.still) images[id] = await load(fd.file);
        else if (videoFrames[id]) images[id] = await Promise.all(videoFrames[id].map(load));
      }
      const fonts = new Set();
      for (const c of Object.values(D.comps)) {
        for (const l of c.layers) {
          if (l.kind === 'text') fonts.add(fontString(l.text));
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
