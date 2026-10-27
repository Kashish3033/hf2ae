// hf2ae runtime: builds an After Effects project from DATA (written above
// this file by jsxwriter.js). ExtendScript is ES3: no let/const, arrows,
// JSON, forEach or indexOf.

(function () {
  var D = DATA;
  var FPS = D.fps;
  var base = File($.fileName).parent;
  var log = [];
  var seenFx = {};

  function warn(msg) { log.push(msg); }

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
      fixed: [[['ADBE Radial Blur-0003', 'Type'], 2], [['ADBE Radial Blur-0004', 'Antialiasing (Best Quality)'], 2]] },
    gaussianBlur: { match: 'ADBE Gaussian Blur 2', props: { blurriness: ['ADBE Gaussian Blur 2-0001', 'Blurriness'] },
      fixed: [[['ADBE Gaussian Blur 2-0003', 'Repeat Edge Pixels'], 1]] },
    invert: { match: 'ADBE Invert', props: {} },
    channelMixer: { match: 'ADBE CHANNEL MIXER', props: {
      rr: ['Red-Red'], rg: ['Red-Green'], rb: ['Red-Blue'], gr: ['Green-Red'], gg: ['Green-Green'], gb: ['Green-Blue'],
      br: ['Blue-Red'], bg: ['Blue-Green'], bb: ['Blue-Blue'] } },
    fill: { match: 'ADBE Fill', props: { color: ['ADBE Fill-0002', 'Color'] } },
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
    luminosity: BlendingMode.LUMINOSITY, color: BlendingMode.COLOR
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
    if (prop.propertyValueType == PropertyValueType.COLOR) return 4;
    return 1;
  }

  function fitValue(prop, v) {
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

  function addEffect(layer, fx, where) {
    var spec = FX[fx.type];
    if (!spec) { warn(where + ': unknown effect type ' + fx.type); return; }
    var parade = layer.property('ADBE Effect Parade');
    var e;
    try { e = parade.addProperty(spec.match); } catch (err) { warn(where + ': cannot add ' + spec.match + ' (' + err + ')'); return; }
    e.name = fx.name;
    if (!seenFx[fx.type]) {
      seenFx[fx.type] = true;
      var lines = [];
      describe(e, 0, lines);
      log.push('effect ' + spec.match + ':\n' + lines.join('\n'));
    }
    for (var key in fx.props) {
      if (key == 'kind') continue;
      var names = spec.props[key];
      var p = names ? findProp(e, names) : null;
      if (!p) { warn(where + ': ' + fx.type + ' has no property ' + key); continue; }
      var map = null;
      if (spec.normalized && spec.normalized[key]) {
        map = (function (pp) { return function (v) { return (pp.hasMax && pp.maxValue > 1.5) ? v * 255 : v; }; })(p);
      } else if (spec.percent && spec.percent[key]) {
        map = (function (pp) { return function (v) { return (pp.hasMax && pp.maxValue > 100) ? v * 2.55 : v; }; })(p);
      }
      setProp(p, fx.props[key], map, where + ' ' + fx.name + '.' + key);
    }
    if (spec.fixed) {
      for (var i = 0; i < spec.fixed.length; i++) {
        var fp = findProp(e, spec.fixed[i][0]);
        if (fp) { try { fp.setValue(spec.fixed[i][1]); } catch (err2) { warn(where + ': ' + err2); } }
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
    doc.justification = t.justify == 'right' ? ParagraphJustification.RIGHT_JUSTIFY
      : t.justify == 'center' ? ParagraphJustification.CENTER_JUSTIFY : ParagraphJustification.LEFT_JUSTIFY;
    if (t.leading) { doc.autoLeading = false; doc.leading = t.leading; }
    try { doc.fauxBold = !!t.fauxBold; doc.fauxItalic = !!t.fauxItalic; } catch (e) { warn(where + ': faux styles: ' + e); }
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
          try { props.addProperty(match).setValue(value); } catch (e) { warn(w + ': ' + match + ': ' + e); }
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
        warn(w + ': ' + e);
      }
    }
  }

  function createLayer(comp, L, items, compData) {
    var layer;
    if (L.kind == 'footage') layer = comp.layers.add(items.footage[L.source]);
    else if (L.kind == 'comp') layer = comp.layers.add(items.comps[L.source]);
    else if (L.kind == 'text') layer = comp.layers.addText(L.text.text);
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
        warn(c.name + ' / ' + L.name + ': cannot create layer (' + e + ')');
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
        if (L.threeDPerChar) { try { layer.threeDPerChar = true; } catch (e) { warn(where + ': per-character 3D: ' + e); } }
        setText(layer, L.text, where);
        if (L.text.animators) addAnimators(layer, L.text.animators, where);
      }
      var tr = layer.property('ADBE Transform Group');
      setProp(tr.property('ADBE Anchor Point'), L.anchor, null, where + ' anchor');
      setProp(tr.property('ADBE Position'), L.position, null, where + ' position');
      setProp(tr.property('ADBE Scale'), L.scale, null, where + ' scale');
      setProp(tr.property('ADBE Rotate Z'), L.rotation, null, where + ' rotation');
      setProp(tr.property('ADBE Opacity'), L.opacity, null, where + ' opacity');
      for (var k = 0; k < L.effects.length; k++) addEffect(layer, L.effects[k], where);
      if (L.blend && BLEND[L.blend] !== undefined) layer.blendingMode = BLEND[L.blend];
      if (L.expressions) {
        try {
          if (L.expressions.sourceText) layer.property('ADBE Text Properties').property('ADBE Text Document').expression = L.expressions.sourceText;
          if (L.expressions.opacity) tr.property('ADBE Opacity').expression = L.expressions.opacity;
        } catch (e) { warn(where + ' expression: ' + e); }
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
      } catch (e) { warn(c.name + ' / ' + L.name + ': track matte: ' + e); }
    }
    // A camera stands in for CSS perspective: zoom = perspective distance.
    if (c.camera) {
      try {
        var cam = comp.layers.addCamera('Camera', [c.w / 2, c.h / 2]);
        cam.property('ADBE Camera Options Group').property('ADBE Camera Zoom').setValue(c.camera.zoom);
        cam.property('ADBE Transform Group').property('ADBE Position').setValue([c.w / 2, c.h / 2, -c.camera.zoom]);
      } catch (e) { warn(c.name + ': camera: ' + e); }
    }
  }

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
    } catch (e) { warn('cannot import ' + fd.file + ' (' + e + ')'); }
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

  var report = new File(base.fsName + '/hf2ae_report.txt');
  report.open('w');
  report.writeln('hf2ae report for ' + D.name + ' (' + new Date() + ')');
  report.writeln('After Effects ' + app.version);
  report.writeln('');
  report.writeln(log.join('\n'));
  report.close();
  var problems = 0;
  for (var j = 0; j < log.length; j++) if (log[j].indexOf && log[j].substr(0, 7) != 'effect ') problems++;
  alert('hf2ae: built "' + D.name + '"' + (problems ? ' with ' + problems + ' warnings.' : '.') + '\nDetails: ' + report.fsName);
})();
