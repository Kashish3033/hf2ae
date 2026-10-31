// hf2ae runtime: builds an After Effects project from DATA (written above
// this file by jsxwriter.js). ExtendScript is ES3: no let/const, arrows,
// JSON, forEach or indexOf.

(function () {
  var D = DATA;
  var FPS = D.fps;
  // Batch mode (src/aerun.js): a fresh project, saved as .aep, no dialogs;
  // the report comes back as the script's result instead of a file, so AE's
  // "Allow Scripts to Write Files" setting can stay off.
  var BATCH = (typeof HF2AE_BATCH !== 'undefined') ? HF2AE_BATCH : null;
  var base = BATCH && BATCH.base ? new Folder(BATCH.base) : File($.fileName).parent;
  var log = [];
  var seenFx = {};

  function warn(msg) { log.push(msg); }

  // AE's own errors don't always turn into text with +; ask for the message.
  function errText(e) {
    try { return e && e.message ? String(e.message) : String(e); } catch (x) { return 'unknown error'; }
  }

  // AE's own errors don't always turn into text with +; ask for the message.
  function errText(e) {
    try { return e && e.message ? String(e.message) : String(e); } catch (x) { return 'unknown error'; }
  }

  function sec(f) { return f / FPS; }

  // ---- effects: matchName + property candidates (matchName first, then UI name)
  var FX = {
    levels: { match: 'ADBE Easy Levels2', props: {
      inputBlack: ['ADBE Easy Levels Input Black', 'Input Black'],
      inputWhite: ['ADBE Easy Levels Input White', 'Input White'],
      gamma: ['ADBE Easy Levels Gamma', 'Gamma'],
      outputBlack: ['ADBE Easy Levels Output Black', 'Output Black'],
      outputWhite: ['ADBE Easy Levels Output White', 'Output White'] },
      normalized: { inputBlack: 1, inputWhite: 1, outputBlack: 1, outputWhite: 1 } },
    tint: { match: 'ADBE Tint', props: { amount: ['ADBE Tint-0003', 'Amount to Tint'] } },
    hueSaturation: { match: 'ADBE HUE SATURATION', props: { saturation: ['ADBE HUE SATURATION-0005', 'Master Saturation'] } },
    noise: { match: 'ADBE Noise', props: { amount: ['ADBE Noise-0001', 'Amount of Noise'] },
      fixed: [[['ADBE Noise-0002', 'Noise Type'], 0], [['ADBE Noise-0003', 'Clipping'], 1]] },
    radialBlur: { match: 'ADBE Radial Blur', props: {
      amount: ['ADBE Radial Blur-0001', 'Amount'], center: ['ADBE Radial Blur-0002', 'Center'] },
      fixed: [[['ADBE Radial Blur-0004', 'Antialiasing (Best Quality)'], 2]] },
    gaussianBlur: { match: 'ADBE Gaussian Blur 2', props: { blurriness: ['ADBE Gaussian Blur 2-0001', 'Blurriness'] },
      fixed: [[['ADBE Gaussian Blur 2-0003', 'Repeat Edge Pixels'], 1]] },
    invert: { match: 'ADBE Invert', props: {} },
    channelMixer: { match: 'ADBE CHANNEL MIXER', props: {
      rr: ['Red-Red'], rg: ['Red-Green'], rb: ['Red-Blue'], gr: ['Green-Red'], gg: ['Green-Green'], gb: ['Green-Blue'],
      br: ['Blue-Red'], bg: ['Blue-Green'], bb: ['Blue-Blue'] } },
    fill: { match: 'ADBE Fill', props: { color: ['ADBE Fill-0002', 'Color'] } },
    directionalBlur: { match: 'ADBE Motion Blur', props: {
      direction: ['ADBE Motion Blur-0001', 'Direction'], length: ['ADBE Motion Blur-0002', 'Blur Length'] } },
    // Shift Channels: keep one channel, the others Full Off.
    shiftChannels: { match: 'ADBE Shift Channels', props: {} },
    opticsCompensation: { match: 'ADBE Optics Compensation', props: { fov: ['ADBE Optics Compensation-0001', 'Field Of View (FOV)'] } },
    lightSweep: { match: 'CC Light Sweep', props: {
      center: ['CC Light Sweep-0001', 'Center'], direction: ['CC Light Sweep-0002', 'Direction'],
      width: ['CC Light Sweep-0004', 'Width'], intensity: ['CC Light Sweep-0005', 'Sweep Intensity'],
      color: ['CC Light Sweep-0008', 'Light Color'] },
      fixed: [[['CC Light Sweep-0003', 'Shape'], 2], [['CC Light Sweep-0006', 'Edge Intensity'], 0]] },
    dropShadow: { match: 'ADBE Drop Shadow', props: {
      color: ['ADBE Drop Shadow-0001', 'Shadow Color'], opacity: ['ADBE Drop Shadow-0002', 'Opacity'],
      direction: ['ADBE Drop Shadow-0003', 'Direction'], distance: ['ADBE Drop Shadow-0004', 'Distance'],
      softness: ['ADBE Drop Shadow-0005', 'Softness'], shadowOnly: ['ADBE Drop Shadow-0006', 'Shadow Only'] },
      percent: { opacity: 1 } }
  };

  var BLEND = {
    normal: BlendingMode.NORMAL, screen: BlendingMode.SCREEN, multiply: BlendingMode.MULTIPLY,
    overlay: BlendingMode.OVERLAY, addition: BlendingMode.ADD, lighten: BlendingMode.LIGHTEN,
    darken: BlendingMode.DARKEN, difference: BlendingMode.DIFFERENCE,
    softlight: BlendingMode.SOFT_LIGHT, hardlight: BlendingMode.HARD_LIGHT,
    luminosity: BlendingMode.LUMINOSITY, color: BlendingMode.COLOR,
    dissolve: BlendingMode.DISSOLVE, subtract: BlendingMode.SUBTRACT, divide: BlendingMode.DIVIDE,
    lighterColor: BlendingMode.LIGHTER_COLOR, darkerColor: BlendingMode.DARKER_COLOR,
    colorDodge: BlendingMode.COLOR_DODGE, colorBurn: BlendingMode.COLOR_BURN, exclusion: BlendingMode.EXCLUSION,
    hue: BlendingMode.HUE, saturation: BlendingMode.SATURATION
  };

  var INTERP = { linear: KeyframeInterpolationType.LINEAR, bezier: KeyframeInterpolationType.BEZIER, hold: KeyframeInterpolationType.HOLD };

  function findProp(group, names) {
    for (var i = 0; i < names.length; i++) {
      var p = null;
      try { p = group.property(names[i]); } catch (e) { p = null; }
      if (p) return p;
    }
    return null;
  }

  function isSpatial(prop) {
    return prop.propertyValueType == PropertyValueType.TwoD_SPATIAL || prop.propertyValueType == PropertyValueType.ThreeD_SPATIAL;
  }

  function easeDims(prop) {
    if (isSpatial(prop)) return 1;
    if (prop.propertyValueType == PropertyValueType.TwoD) return 2;
    if (prop.propertyValueType == PropertyValueType.ThreeD) return 3;
    return 1;
  }

  function fitValue(prop, v) {
    if (!(v instanceof Array)) return v;
    if (prop.propertyValueType == PropertyValueType.ThreeD && v.length == 2) return [v[0], v[1], 100];
    if (prop.propertyValueType == PropertyValueType.ThreeD_SPATIAL && v.length == 2) return [v[0], v[1], 0];
    if (prop.propertyValueType == PropertyValueType.COLOR && v.length == 3) return [v[0], v[1], v[2], 1];
    return v;
  }

  function easeArray(e, dims) {
    var out = [];
    for (var i = 0; i < dims; i++) {
      var x = e ? (e instanceof Array ? e[Math.min(i, e.length - 1)] : e) : null;
      var infl = x ? Math.max(0.1, Math.min(100, x.influence)) : 33.33;
      out.push(new KeyframeEase(x ? x.speed : 0, infl));
    }
    return out;
  }

  // Set a Prop ({value} or {keys}) on an AE property; map() converts units.
  function setProp(prop, P, map, where) {
    if (!prop || !P) return;
    var conv = function (v) { return fitValue(prop, map ? map(v) : v); };
    try {
      if (!P.keys) { prop.setValue(conv(P.value)); return; }
      var ks = P.keys, i;
      for (i = 0; i < ks.length; i++) prop.setValueAtTime(sec(ks[i].f), conv(ks[i].v));
      var dims = easeDims(prop);
      for (i = 0; i < ks.length; i++) {
        var idx = prop.nearestKeyIndex(sec(ks[i].f));
        var outT = ks[i].out || 'linear';
        var inT = i > 0 ? (ks[i - 1].out == 'hold' ? 'linear' : (ks[i].easeIn ? 'bezier' : 'linear')) : outT;
        if (outT == 'bezier' || inT == 'bezier') {
          prop.setTemporalEaseAtKey(idx, easeArray(ks[i].easeIn, dims), easeArray(ks[i].easeOut, dims));
        }
        prop.setInterpolationTypeAtKey(idx, INTERP[inT == 'hold' ? 'linear' : inT], INTERP[outT]);
        if (isSpatial(prop) && ks.length > 1) {
          var zero = prop.propertyValueType == PropertyValueType.ThreeD_SPATIAL ? [0, 0, 0] : [0, 0];
          prop.setSpatialTangentsAtKey(idx, zero, zero);
        }
      }
    } catch (e) {
      warn(where + ': ' + e.toString());
    }
  }

  function describe(prop, depth, out) {
    for (var i = 1; i <= prop.numProperties; i++) {
      var p = prop.property(i);
      var line = '  ' + p.matchName + ' "' + p.name + '"';
      try { if (p.hasMin || p.hasMax) line += ' range ' + p.minValue + '..' + p.maxValue; } catch (e) {}
      out.push(line);
    }
  }

  function setEffectProp(e, names, P, where) {
    var p = findProp(e, names);
    if (!p) { warn(where + ': no ' + names[0]); return null; }
    setProp(p, P, null, where + ' ' + names[names.length - 1]);
    return p;
  }

  // The 'gradient' effect: Gradient Ramp driven by an Angle or Radius slider
  // through expressions, so it stays one control to edit. Conic: a left-to-
  // right ramp wrapped round by Polar Coordinates, turned by Offset.
  function addGradient(layer, fx, where) {
    var parade = layer.property('ADBE Effect Parade');
    var P = fx.props, mode = P.mode.value;
    var c = P.center.keys ? P.center.keys[0].v : P.center.value;
    var p0 = P.startAt.value, p1 = P.endAt.value;
    var slider = parade.addProperty('ADBE Slider Control');
    slider.name = mode == 'radial' ? 'Radius' : 'Angle';
    setEffectProp(slider, ['ADBE Slider Control-0001', 'Slider'], mode == 'radial' ? P.radius : P.angle, where);
    var ramp = parade.addProperty('ADBE Ramp');
    ramp.name = 'Gradient';
    setEffectProp(ramp, ['ADBE Ramp-0002', 'Start Color'], P.startColor, where);
    setEffectProp(ramp, ['ADBE Ramp-0004', 'End Color'], P.endColor, where);
    var shape = findProp(ramp, ['ADBE Ramp-0005', 'Ramp Shape']);
    if (shape) shape.setValue(mode == 'radial' ? 2 : 1);
    var start = findProp(ramp, ['ADBE Ramp-0001', 'Start of Ramp']), end = findProp(ramp, ['ADBE Ramp-0003', 'End of Ramp']);
    var ctr = '[' + c[0] + ', ' + c[1] + ']';
    try {
      if (mode == 'radial') {
        start.expression = ctr;
        end.expression = ctr + ' + [effect("Radius")(1) * ' + p1 + ', 0]';
      } else if (mode == 'conic') {
        // Polar Coordinates (Rect to Polar) wraps x round the centre
        // counter-clockwise (measured in AE 26.5), so the ramp runs right to
        // left, and Offset turns it back by Angle: the gradient then starts
        // at Angle and runs clockwise, as CSS conic-gradient does.
        start.expression = '[thisLayer.width * (1 - ' + p0 + '), thisLayer.height / 2]';
        end.expression = '[thisLayer.width * (1 - ' + p1 + '), thisLayer.height / 2]';
        var off = parade.addProperty('ADBE Offset');
        off.name = 'Turn';
        findProp(off, ['ADBE Offset-0001', 'Shift Center To']).expression =
          '[thisLayer.width / 2 - effect("Angle")(1) / 360 * thisLayer.width, thisLayer.height / 2]';
        var polar = parade.addProperty('ADBE Polar Coordinates');
        polar.name = 'Wrap round';
        var interp = findProp(polar, ['ADBE Polar Coordinates-0001', 'Interpolation']);
        if (interp) interp.setValue(1); // 0-1 (100%) in AE 26.5
        var conv = findProp(polar, ['ADBE Polar Coordinates-0002', 'Type of Conversion']);
        if (conv) conv.setValue(1);
      } else {
        // CSS angle: 0 = up, 90 = right; the ramp runs along that line
        // through the centre, from startAt to endAt of its length.
        var body = 'var a = effect("Angle")(1) * Math.PI / 180, d = [Math.sin(a), -Math.cos(a)];\n'
          + 'var L = Math.abs(thisLayer.width * d[0]) + Math.abs(thisLayer.height * d[1]);\n';
        start.expression = body + ctr + ' + d * L * (' + p0 + ' - 0.5)';
        end.expression = body + ctr + ' + d * L * (' + p1 + ' - 0.5)';
      }
    } catch (e) { warn(where + ': gradient expressions: ' + errText(e)); }
  }

  function addEffect(layer, fx, where) {
    if (fx.type == 'gradient') { addGradient(layer, fx, where); return; }
    var spec = FX[fx.type];
    if (!spec) { warn(where + ': unknown effect type ' + fx.type); return; }
    var parade = layer.property('ADBE Effect Parade');
    var e;
    try { e = parade.addProperty(spec.match); } catch (err) { warn(where + ': cannot add ' + spec.match + ' (' + errText(err) + ')'); return; }
    e.name = fx.name;
    if (!seenFx[fx.type]) {
      seenFx[fx.type] = true;
      var lines = [];
      describe(e, 0, lines);
      log.push('effect ' + spec.match + ':\n' + lines.join('\n'));
    }
    for (var key in fx.props) {
      if (key == 'kind' || key == 'keep') continue;
      var names = spec.props[key];
      var p = names ? findProp(e, names) : null;
      if (!p) { warn(where + ': ' + fx.type + ' has no property ' + key); continue; }
      var map = null;
      if (spec.normalized && spec.normalized[key]) {
        // Levels takes 0-1 from scripts (a new Levels reads Input White = 1).
        map = null;
      } else if (spec.percent && spec.percent[key]) {
        map = (function (pp) { return function (v) { return (pp.hasMax && pp.maxValue > 100) ? v * 2.55 : v; }; })(p);
      }
      setProp(p, fx.props[key], map, where + ' ' + fx.name + '.' + key);
    }
    if (fx.type == 'shiftChannels') {
      // Take <channel> From: 2 Red, 3 Green, 4 Blue ... 10 Full Off (AE 26.5: the menu runs 1-10).
      var CH = { red: 2, green: 3, blue: 4 }, keep = fx.props.keep.value;
      var takes = [['ADBE Shift Channels-0002', 'Take Red From', 'red'], ['ADBE Shift Channels-0003', 'Take Green From', 'green'], ['ADBE Shift Channels-0004', 'Take Blue From', 'blue']];
      for (var t = 0; t < takes.length; t++) {
        var tp = findProp(e, [takes[t][0], takes[t][1]]);
        if (tp) tp.setValue(takes[t][2] == keep ? CH[keep] : 10);
      }
    }
    if (fx.type == 'radialBlur') {
      var rt = findProp(e, ['ADBE Radial Blur-0003', 'Type']);
      if (rt) rt.setValue(fx.props.kind && fx.props.kind.value == 'spin' ? 1 : 2);
    }
    if (spec.fixed) {
      for (var i = 0; i < spec.fixed.length; i++) {
        var fp = findProp(e, spec.fixed[i][0]);
        if (fp) { try { fp.setValue(spec.fixed[i][1]); } catch (err2) { warn(where + ': ' + errText(err2)); } }
      }
    }
  }

  function setText(layer, t, where) {
    var src = layer.property('ADBE Text Properties').property('ADBE Text Document');
    var doc = src.value;
    try { doc.resetCharStyle(); doc.resetParagraphStyle(); } catch (e) {}
    doc.text = t.text;
    doc.font = t.font;
    doc.fontSize = t.size;
    doc.applyFill = true;
    doc.fillColor = t.fill;
    doc.applyStroke = false;
    doc.tracking = t.tracking;
    // A lookup, not a chained ?: — ExtendScript groups a ? b : c ? d : e as
    // (a ? b : c) ? d : e, which turned right-aligned text into centred.
    var JUSTIFY = { right: ParagraphJustification.RIGHT_JUSTIFY, center: ParagraphJustification.CENTER_JUSTIFY };
    doc.justification = JUSTIFY[t.justify] || ParagraphJustification.LEFT_JUSTIFY;
    if (t.leading) { doc.autoLeading = false; doc.leading = t.leading; }
    try { doc.fauxBold = !!t.fauxBold; doc.fauxItalic = !!t.fauxItalic; } catch (e) { warn(where + ': faux styles: ' + errText(e)); }
    src.setValue(doc);
    if (src.value.font != t.font) warn(where + ': font ' + t.font + ' (' + t.family + ') is not installed; AE used ' + src.value.font);
  }

  // Text Animators (from hfPlus.text.animate): one animator per selector, its
  // properties set to their full-selection values, the Range Selector keyed.
  var BASED = { chars: 1, words: 3, lines: 4 };
  var GROUPING = { chars: 1, words: 2, lines: 3 };
  function addAnimators(layer, list, where) {
    var textProps = layer.property('ADBE Text Properties');
    for (var i = 0; i < list.length; i++) {
      var A = list[i], w = where + ' ' + A.name;
      try {
        var an = textProps.property('ADBE Text Animators').addProperty('ADBE Text Animator');
        an.name = A.name;
        var props = an.property('ADBE Text Animator Properties');
        var add = function (match, value) {
          try { props.addProperty(match).setValue(value); } catch (e) { warn(w + ': ' + match + ': ' + errText(e)); }
        };
        if (A.props.opacity !== undefined) add('ADBE Text Opacity', A.props.opacity);
        if (A.props.position) add('ADBE Text Position 3D', A.props.position);
        if (A.props.rotationX !== undefined) add('ADBE Text Rotation X', A.props.rotationX);
        if (A.props.rotationY !== undefined) add('ADBE Text Rotation Y', A.props.rotationY);
        if (A.props.rotation !== undefined) add('ADBE Text Rotation', A.props.rotation);
        if (A.props.scale) add('ADBE Text Scale 3D', A.props.scale);
        if (A.props.scramble) add('ADBE Text Character Offset', 25);

        var sel = an.property('ADBE Text Selectors').addProperty('ADBE Text Selector');
        setProp(findProp(sel, ['ADBE Text Percent Start', 'Start']), A.selector.start, null, w + ' start');
        setProp(findProp(sel, ['ADBE Text Percent End', 'End']), A.selector.end, null, w + ' end');
        setProp(findProp(sel, ['ADBE Text Percent Offset', 'Offset']), A.selector.offset, null, w + ' offset');
        var adv = findProp(sel, ['ADBE Text Range Advanced', 'Advanced']);
        var basedOn = adv && findProp(adv, ['ADBE Text Range Type2', 'Based On']);
        if (basedOn) basedOn.setValue(BASED[A.based] || 1); else warn(w + ': no Based On');

        if (A.props.scramble) {
          // Scramble: a Wiggly Selector intersected with the range gives each
          // selected character a random offset that changes every frame.
          var wig = an.property('ADBE Text Selectors').addProperty('ADBE Text Wiggly Selector');
          var mode = findProp(wig, ['ADBE Text Selector Mode', 'Mode']);
          if (mode) mode.setValue(3);
          var rate = findProp(wig, ['ADBE Text Temporal Freq', 'Wiggles/Second']);
          if (rate) rate.setValue(FPS);
          var corr = findProp(wig, ['ADBE Text Character Correlation', 'Correlation']);
          if (corr) corr.setValue(0);
        }
        var more = textProps.property('ADBE Text More Options');
        var grouping = more && findProp(more, ['ADBE Text Anchor Point Option', 'Anchor Point Grouping']);
        if (grouping) grouping.setValue(GROUPING[A.based] || 1);
        var align = more && findProp(more, ['ADBE Text Anchor Point Align', 'Grouping Alignment']);
        if (align && A.groupingAlignment) align.setValue(A.groupingAlignment);
      } catch (e) {
        warn(w + ': ' + errText(e));
      }
    }
  }

  // Shape-layer contents, in order: paths, then operators (Merge / Offset
  // Paths), then Fill / Stroke, as AE renders them top to bottom.
  var STAR = { star: 1, polygon: 2 };
  var MERGE_MODE = { merge: 1, add: 2, subtract: 3, intersect: 4, exclude: 5 };
  function addContents(group, list, where) {
    for (var i = 0; i < list.length; i++) {
      var it = list[i], w = where + ' ' + it.name, p;
      try {
        if (it.type == 'group') {
          p = group.addProperty('ADBE Vector Group');
          p.name = it.name;
          addContents(p.property('ADBE Vectors Group'), it.items, w);
          if (it.skew) {
            // CSS skewX leans the other way to AE Skew.
            var tg = p.property('ADBE Vector Transform Group');
            setProp(findProp(tg, ['ADBE Vector Skew', 'Skew']), it.skew, function (v) { return -v; }, w + ' skew');
          }
          continue;
        }
        if (it.type == 'rect') {
          p = group.addProperty('ADBE Vector Shape - Rect');
          setEffectProp(p, ['ADBE Vector Rect Size', 'Size'], it.size, w);
          if (it.position) setEffectProp(p, ['ADBE Vector Rect Position', 'Position'], it.position, w);
          if (it.roundness) setEffectProp(p, ['ADBE Vector Rect Roundness', 'Roundness'], it.roundness, w);
        } else if (it.type == 'ellipse') {
          p = group.addProperty('ADBE Vector Shape - Ellipse');
          setEffectProp(p, ['ADBE Vector Ellipse Size', 'Size'], it.size, w);
          if (it.position) setEffectProp(p, ['ADBE Vector Ellipse Position', 'Position'], it.position, w);
        } else if (it.type == 'star') {
          p = group.addProperty('ADBE Vector Shape - Star');
          findProp(p, ['ADBE Vector Star Type', 'Type']).setValue(STAR[it.star]);
          setEffectProp(p, ['ADBE Vector Star Points', 'Points'], it.points, w);
          setEffectProp(p, ['ADBE Vector Star Outer Radius', 'Outer Radius'], it.outer, w);
          if (it.inner) setEffectProp(p, ['ADBE Vector Star Inner Radius', 'Inner Radius'], it.inner, w);
          if (it.position) setEffectProp(p, ['ADBE Vector Star Position', 'Position'], it.position, w);
        } else if (it.type == 'merge') {
          p = group.addProperty('ADBE Vector Filter - Merge');
          findProp(p, ['ADBE Vector Merge Type', 'Mode']).setValue(MERGE_MODE[it.mode]);
        } else if (it.type == 'offset') {
          p = group.addProperty('ADBE Vector Filter - Offset');
          setEffectProp(p, ['ADBE Vector Offset Amount', 'Amount'], it.amount, w);
          var join = findProp(p, ['ADBE Vector Offset Line Join', 'Line Join']);
          if (join) join.setValue(1); // miter
        } else if (it.type == 'fill') {
          p = group.addProperty('ADBE Vector Graphic - Fill');
          setEffectProp(p, ['ADBE Vector Fill Color', 'Color'], it.color, w);
          if (it.opacity) setEffectProp(p, ['ADBE Vector Fill Opacity', 'Opacity'], it.opacity, w);
          if (it.rule == 'evenodd') findProp(p, ['ADBE Vector Fill Rule', 'Fill Rule']).setValue(2);
        } else if (it.type == 'stroke') {
          p = group.addProperty('ADBE Vector Graphic - Stroke');
          setEffectProp(p, ['ADBE Vector Stroke Color', 'Color'], it.color, w);
          setEffectProp(p, ['ADBE Vector Stroke Width', 'Stroke Width'], it.width, w);
          if (it.opacity) setEffectProp(p, ['ADBE Vector Stroke Opacity', 'Opacity'], it.opacity, w);
          var lj = findProp(p, ['ADBE Vector Stroke Line Join', 'Line Join']);
          if (lj) lj.setValue(1); // miter
        } else {
          warn(w + ': unknown shape item ' + it.type);
          continue;
        }
        if (p) p.name = it.name;
      } catch (e) {
        warn(w + ': ' + errText(e));
      }
    }
  }

  function toShape(v) {
    var sh = new Shape();
    sh.vertices = v;
    sh.closed = true;
    return sh;
  }

  function addMasks(layer, masks, where) {
    for (var i = 0; i < masks.length; i++) {
      try {
        var m = layer.property('ADBE Mask Parade').addProperty('ADBE Mask Atom');
        m.name = masks[i].name;
        m.maskMode = MaskMode.ADD;
        setProp(m.property('ADBE Mask Shape'), masks[i].path, toShape, where + ' mask');
      } catch (e) { warn(where + ': mask: ' + errText(e)); }
    }
  }

  function createLayer(comp, L, items, compData) {
    var layer;
    if (L.kind == 'footage') layer = comp.layers.add(items.footage[L.source]);
    else if (L.kind == 'comp') layer = comp.layers.add(items.comps[L.source]);
    else if (L.kind == 'text') layer = comp.layers.addText(L.text.text);
    else if (L.kind == 'shape') layer = comp.layers.addShape();
    else if (L.kind == 'solid' || L.kind == 'adjustment') {
      var w = Math.max(4, Math.round(L.w || compData.w)), h = Math.max(4, Math.round(L.h || compData.h));
      layer = comp.layers.addSolid(L.color || [1, 1, 1], L.name, w, h, 1);
      if (L.kind == 'adjustment') layer.adjustmentLayer = true;
    }
    layer.name = L.name;
    layer.startTime = sec(L.startFrame);
    layer.inPoint = sec(L.inFrame);
    layer.outPoint = sec(L.outFrame);
    return layer;
  }

  function buildComp(c, comp, items) {
    var made = [], byName = {}, i, L, layer, where;
    for (i = 0; i < c.layers.length; i++) {
      L = c.layers[i];
      try {
        layer = createLayer(comp, L, items, c);
      } catch (e) {
        warn(c.name + ' / ' + L.name + ': cannot create layer (' + errText(e) + ')');
        layer = null;
      }
      made.push(layer);
      if (layer) byName[L.name] = layer;
    }
    // Parents first, without moving the child (its position is parent-relative).
    for (i = 0; i < c.layers.length; i++) {
      if (!made[i] || !c.layers[i].parent) continue;
      var parent = byName[c.layers[i].parent];
      if (!parent) { warn(c.name + ' / ' + c.layers[i].name + ': no parent ' + c.layers[i].parent); continue; }
      try { made[i].setParentWithJump(parent); } catch (e) { made[i].parent = parent; }
    }
    for (i = 0; i < c.layers.length; i++) {
      L = c.layers[i]; layer = made[i];
      if (!layer) continue;
      where = c.name + ' / ' + L.name;
      if (L.kind == 'text') {
        if (L.threeDPerChar) { try { layer.threeDPerChar = true; } catch (e) { warn(where + ': per-character 3D: ' + errText(e)); } }
        setText(layer, L.text, where);
        if (L.text.animators) addAnimators(layer, L.text.animators, where);
      }
      var tr = layer.property('ADBE Transform Group');
      setProp(tr.property('ADBE Anchor Point'), L.anchor, null, where + ' anchor');
      setProp(tr.property('ADBE Position'), L.position, null, where + ' position');
      setProp(tr.property('ADBE Scale'), L.scale, null, where + ' scale');
      setProp(tr.property('ADBE Rotate Z'), L.rotation, null, where + ' rotation');
      setProp(tr.property('ADBE Opacity'), L.opacity, null, where + ' opacity');
      if (L.contents) addContents(layer.property('ADBE Root Vectors Group'), L.contents, where);
      if (L.masks) addMasks(layer, L.masks, where);
      for (var k = 0; k < L.effects.length; k++) addEffect(layer, L.effects[k], where);
      if (L.blend && BLEND[L.blend] !== undefined) layer.blendingMode = BLEND[L.blend];
      if (L.expressions) {
        try {
          if (L.expressions.sourceText) layer.property('ADBE Text Properties').property('ADBE Text Document').expression = L.expressions.sourceText;
          if (L.expressions.opacity) tr.property('ADBE Opacity').expression = L.expressions.opacity;
        } catch (e) { warn(where + ' expression: ' + errText(e)); }
      }
      if (L.comment) layer.comment = L.comment;
      if (L.guide) layer.guideLayer = true;
      if (L.enabled === false) layer.enabled = false;
    }
    // Track mattes (the matte layer already sits right above its layer).
    for (i = 0; i < c.layers.length; i++) {
      L = c.layers[i]; layer = made[i];
      if (!layer || !L.trackMatte) continue;
      var matte = byName[L.trackMatte.layer];
      var type = L.trackMatte.type == 'luma' ? TrackMatteType.LUMA : TrackMatteType.ALPHA;
      try {
        if (layer.setTrackMatte) layer.setTrackMatte(matte, type); // AE 2023 and later
        else layer.trackMatteType = type;                          // the layer above is the matte
      } catch (e) { warn(c.name + ' / ' + L.name + ': track matte: ' + errText(e)); }
    }
    // A camera stands in for CSS perspective: zoom = perspective distance.
    if (c.camera) {
      try {
        var cam = comp.layers.addCamera('Camera', [c.w / 2, c.h / 2]);
        cam.property('ADBE Camera Options Group').property('ADBE Camera Zoom').setValue(c.camera.zoom);
        cam.property('ADBE Transform Group').property('ADBE Position').setValue([c.w / 2, c.h / 2, -c.camera.zoom]);
      } catch (e) { warn(c.name + ': camera: ' + errText(e)); }
    }
  }

  if (BATCH && app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
  app.beginUndoGroup('hf2ae: ' + D.name);
  var proj = app.project || app.newProject();
  var root = proj.items.addFolder(D.name);
  var compFolder = proj.items.addFolder('Precomps');
  compFolder.parentFolder = root;
  var footFolder = proj.items.addFolder('Footage');
  footFolder.parentFolder = root;

  var items = { footage: {}, comps: {} };
  var id;
  for (id in D.footage) {
    var fd = D.footage[id];
    var file = new File(base.fsName + '/' + fd.file);
    if (!file.exists) { warn('missing footage ' + fd.file); continue; }
    try {
      var io = new ImportOptions(file);
      var item = proj.importFile(io);
      item.name = fd.name;
      item.parentFolder = footFolder;
      items.footage[id] = item;
    } catch (e) { warn('cannot import ' + fd.file + ' (' + errText(e) + ')'); }
  }
  for (id in D.comps) {
    var c = D.comps[id];
    var comp = proj.items.addComp(c.name, Math.round(c.w), Math.round(c.h), 1, Math.max(c.frames, 1) / FPS, FPS);
    comp.parentFolder = id == D.main ? root : compFolder;
    items.comps[id] = comp;
  }
  // Inner comps first so precomp layers see finished sources.
  for (var n = D.order.length - 1; n >= 0; n--) buildComp(D.comps[D.order[n]], items.comps[D.order[n]], items);
  app.endUndoGroup();

  items.comps[D.main].openInViewer();

  var text = 'hf2ae report for ' + D.name + ' (' + new Date().toString() + ')\nAfter Effects ' + app.version + '\n\n' + log.join('\n');
  var problems = 0;
  for (var j = 0; j < log.length; j++) if (log[j].substr(0, 7) != 'effect ') problems++;
  if (BATCH) {
    if (BATCH.save) app.project.save(new File(BATCH.save));
    $.global.HF2AE_RESULT = text;
    return;
  }
  var where = 'not saved (allow scripts to write files in AE settings to save it)';
  try {
    var report = new File(base.fsName + '/hf2ae_report.txt');
    if (report.open('w')) { report.write(text); report.close(); where = report.fsName; }
  } catch (e) {}
  alert('hf2ae: built "' + D.name + '"' + (problems ? ' with ' + problems + ' warnings.' : '.') + '\nReport: ' + where);
})();
