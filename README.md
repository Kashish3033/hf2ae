# hf2ae

Turns a Frameo shot (HyperFrames layers + the ffmpeg graph that composites
them) into an After Effects project you can keep editing: real comps, layers,
keyframes and effects, laid out the way an editor would build the shot by hand.

```
shot.json ─┬─ ffmpeg graph ──► ffreader ─┐
           └─ HyperFrames HTML ► hfreader ┴─► timeline ──► .jsx ──► After Effects
```

- **ffreader** reads the `-filter_complex` graph. Inputs become footage layers,
  `overlay` places layers, `enable=` becomes in/out points, `zoompan` becomes
  Anchor Point + Scale keyframes, `eq`/`hue`/`noise` become effects or short
  adjustment layers, mixed zoompan copies become a Radial Blur, and `concat`
  becomes cuts.
- **hfreader** opens the HyperFrames page in headless Chrome, measures each
  text clip and samples the GSAP timeline on every frame. Text becomes native AE
  text layers. Each CSS `text-shadow` becomes a linked copy of the text layer:
  a Fill colour for the chromatic-aberration fringes, a Drop Shadow for glows
  and shadows. Editing the main text updates every copy.
- **fit** turns per-frame values into a few keyframes with AE eases (a push
  becomes 2–3 eased keys, not 40).
- **jsxwriter** writes an ExtendScript that builds the project, plus a
  `footage/` folder.

## Use

```bash
npm install
```

```bash
node src/cli.js examples/punch_demo/shot.json
```

The command writes `out/punch_demo/` with:

- `Punch_Demo_Einstein_vs_Bohr.jsx`. In After Effects, choose **File → Scripts → Run Script File…** and pick this file. Keep `footage/` next to it.
- `timeline.txt`: the comp and layer tree, as AE's timeline will show it
- `timeline.json`: the same tree as data

When the script finishes, it writes `hf2ae_report.txt` next to itself. The
report lists any warnings and the property names and ranges of every effect it
used, which are needed for calibration.

To fetch the example's media first:

```bash
examples/punch_demo/fetch.sh
```

## shot.json

```json
{
  "name": "Punch Demo – Einstein vs Bohr",
  "fps": 25,
  "inputs": [
    { "file": "src/solvay.png", "name": "Solvay 1927" },
    { "file": "src/punch_title.webm", "name": "Punch Title", "hyperframes": "src/punch_title.html" }
  ],
  "graphFile": "graph.txt",
  "output": "v",
  "names": { "A": "Shot 1 – Einstein push" }
}
```

`inputs` are the ffmpeg `-i` files, in order. An input that has `hyperframes`
is rebuilt from its HTML; the rendered file is kept as a switched-off guide
layer so you can compare the two. `names` turns graph labels into comp names.

## Fonts

AE only sees fonts installed on the Mac, so web fonts have to be installed as
OTF/TTF:

- **TeX Gyre Heros** (PostScript `TeXGyreHeros-Bold`) from GUST:
  https://www.gust.org.pl/projects/e-foundry/tex-gyre/heros
- **Instrument Serif**, from Google Fonts

If a font is missing, the report says which one AE used instead.

## Checked in After Effects

`src/aerun.js` builds a converted shot in real After Effects (26.5) and renders
it with `aerender`; `verify.js --candidate ae_render.mov` then compares AE's
render with Frameo's.

```bash
node src/aerun.js out/punch_demo
```

```bash
node src/verify.js out/punch_demo --comp "Punch Demo – Einstein vs Bohr" --ref reference_444.mp4 --candidate ae_render.mov
```

After Effects must be open, with Settings → Scripting & Expressions → "Allow
Scripts to Write Files and Access Network" on. Fonts the shots use must be
installed (TeX Gyre Heros, Anton, Instrument Serif).

What running in AE found and fixed:
- AE can't import WebM: WebM footage is handed over as ProRes 4444 .mov (alpha kept).
- Text tracking must be a whole number in AE: tracking is rounded (under 0.1px per letter).
- ExtendScript groups `a ? b : c ? d : e` left to right, which centred right-aligned
  text; the script uses lookups, and a test forbids unbracketed chained `?:`.
- Levels takes 0–1 values from scripts (a new Levels reads Input White = 1).
- Drop Shadow opacity takes 0–255 (as mapped).
- Shift Channels' "Full Off" is 10 (the menu runs 1–10).
- Radial Blur (Zoom) amount: 400 per 1.0 of zoom spread (100–900 tried in AE).
- Optics Compensation isn't linear: field of view = 104 · k^0.41 matches Frameo's
  lens margins (22/44/69px at k 0.05/0.1125/0.2).
- AE's errors and dates don't join into text with `+`; the script converts them first.
- Faux Bold adds 26/1000 em of advance per letter in AE; tracking takes it off.
- Polar Coordinates only fills the circle inside its layer and wraps counter-clockwise:
  a conic gradient is a diagonal-sized solid (ramp right to left, turned by Offset)
  inside a box-sized precomp that crops it.

AE render vs Frameo render, whole frame, mean PSNR (AE 26.5, all 15 shots built
with no warnings):

| shot | AE | browser preview | note |
|---|---|---|---|
| punch_demo | flashes 34–36, push 27.4 | same | |
| a1 ICONIC flip | 22.2 | | AE text engine vs Chrome glyphs |
| a2 1965 scramble | 22.0 | | Frameo's Linux monospace font |
| a3 per-word reveal | 26.2 | 43.1 | AE text engine vs Chrome glyphs |
| a4 gradient sweep | 19.0 | 19.2 | conversion gap, not AE |
| a5 SOLVAY matte | 47.1 | | |
| a6 shape booleans | 30.1 | | |
| a7 radial/conic | 30.1 (each gradient 37–41) | 29.7 | |
| a8 paintPath | 27.7 | | |
| a10 eight eases | 25.8 | 26.3 | |
| w1 whip flash | 37.7 | | |
| w2 DOM whip | 38.6 | | |
| x1 directional whip | 36.8 | | |
| x2 cut distort | 37.2 | | |
| e1 expr | 15.6 | 15.6 | Frameo's random/noise seeds unknown |

## Calibration (still to check)

Some ffmpeg units have no exact AE equivalent. The current values are best
guesses, kept in `CALIBRATION` in `src/ffreader.js`:

| ffmpeg | AE | constant |
|---|---|---|
| 8 averaged zoompan copies (spread 0.245) | Radial Blur, Zoom, amount | `radialBlurPerZoom` |
| `noise=alls=4` | Noise, amount % | `noisePerStrength` |
| `gblur=sigma` | Gaussian Blur, blurriness | `gaussianPerSigma` |

Also to verify in AE:

- the sign of Text Animator Rotation X/Y and Position z (CSS z points at the viewer, AE z away; hf2ae flips both)
- Grouping Alignment 0, −50% putting the character pivot in the middle of the em box, as CSS does
- the property names for Character Offset, the Wiggly Selector and `setTrackMatte` (AE 2023+; older versions use the layer above)
- Polar Coordinates starting the conic at 12 o'clock and going clockwise, like CSS `conic-gradient`
- the sign of shape-group Skew against CSS `skewX`, and CC Light Sweep's direction and width against the band
- colour keyframes taking a single ease (hf2ae assumes so)
- Directional Blur length per Gaussian sigma (`blurLengthPerSigma`)
- turning on AE motion blur for whips to match Frameo's render motion blur

- the units Levels and Drop Shadow take from scripts (the report lists their ranges)
- the right-aligned text's x position with negative tracking
- Drop Shadow softness against the CSS blur

To check the result, render with `aerender` and compare frames against
`out/punch_demo/reference_ffmpeg.mp4`, which is rendered locally from the same graph.

## Supported so far

ffmpeg: `scale` (incl. `force_original_aspect_ratio`), `crop`, `overlay` (static
or expression x/y, `enable`), `zoompan` (`d=1`), `mix`, `concat`, `trim`,
`loop` (stills), `fade` (alpha), `eq`, `hue=s`, `negate`, `noise`, `gblur`,
`colorchannelmixer`, `drawbox` (fill), `blend` (`all_mode`), `color`, `split`,
plus the no-ops (`format`, `setsar`, `setpts`, `fps`). Unsupported filters stop
the conversion and name the filter.

HyperFrames:
- Text anywhere in the page (inside wrapper clips too) and SVG `<text>`, with
  opacity and 2D transforms from the GSAP timeline. A synthetic bold or italic
  becomes AE Faux Bold / Faux Italic.
- `<video>` and `<img>` (downloaded to `src/remote/`), fitted like `object-fit`.
- The page's background colour becomes a solid.
- Frameo's `hfPlus` helpers (`plus/*.js`) only exist inside its render
  service, so the reader stands in for them and records the calls:
  - `hfPlus.text.animate` becomes an AE **Text Animator** with a **Range
    Selector** (start/end/offset keyed; based on characters, words or lines),
    per-character 3D and a camera whose zoom is the CSS `perspective`.
  - `hfPlus.composite.matte` becomes a **track matte** (alpha or luma).
  - `hfPlus.ease` curves run as-is (bezier, ae, the easyEase/motion family,
    springBouncy, the Penner set) and the motion they make is keyed with AE
    eases; springs and overshoots get a keyframe at every turning point.
  - `hfPlus.gradient` (linear, radial, conic) becomes a solid with Gradient
    Ramp driven by an Angle or Radius slider through expressions; conic adds
    Offset + Polar Coordinates. On gradient text (`background-clip: text`)
    the gradient solid is cut by the text as an alpha track matte.
  - `hfPlus.sweep` becomes **CC Light Sweep**, centre keyed.
  - `hfPlus.shapes` (ellipse, star, polygon, rect, union, intersect,
    exclude, offset, live) becomes a **shape layer**: Ellipse / Polystar /
    Rectangle, **Merge Paths**, **Offset Paths**, Fill / Stroke; live shapes
    key their parameters (polygon sides as hold keys).
  - `hfPlus.craft.matchState` animates like the original (smoothstep);
    `craft.paintPath`'s brush reveal becomes a keyed **mask** wipe (its
    organic edge and drips are not reproduced).
  - `hfPlus.whip` slides the two layers with **Easy Ease** (Frameo's
    whip.state is exactly smoothstep) and adds one **Directional Blur**
    adjustment layer over both, keyed to its blur curve; in/out points trimmed.
  - `hfPlus.fx(canvas, source, ops)` becomes a precomp: the source layer,
    then per op: `blend` (the top image with that blending mode, opacity
    keyed), `directionalBlur` (Directional Blur), `whip`, `chromaticAberration`
    (three Shift Channels copies, red in / blue out, added),
    `lensDistortion` (Optics Compensation), `grain` (Noise), `spinBlur`
    (Radial Blur, Spin). Off-screen canvases (the top image) are saved as PNG
    footage. `crt`, `paper`, `lowpoly`, `meshgrid`, `ascii` have no mapping.
  - `hfPlus.expr.bind` runs the page's functions every frame and keys the
    result; `lookAt`, `springTrack` and the page's own maths are exact.
    `noise` and the seeded randoms use hf2ae's generator, so their values
    differ from Frameo's.
  - `hfPlus.particles` is recorded (emitters, sprites) but not converted.
  - Any other helper call is reported in the notes as not mapped yet.
- Text is placed by where its glyphs are (flex-centred labels included),
  and static transforms (a card rotated once) are kept.
- Plain `<div>` boxes become **shape layers** (Rectangle + Fill, Stroke for
  a border) with size, position, rotation, skew and colour keyed; a
  `clip-path: inset()` becomes a mask.

Behaviour of the hfPlus stand-ins was read off Frameo's renders (`src/hfplus_stub.js`
says where each number comes from); they reproduce the renders, not the
helpers' source.

## Verify without After Effects

`src/verify.js` checks a conversion without AE. It redraws a comp in headless
Chrome from `timeline.json` alone (comps, layers, transforms, keyframe eases,
effects, blending modes; none of the original HTML), then compares it frame by
frame with a reference using ffmpeg's PSNR. 40 dB and above looks identical;
50 dB and above is essentially pixel-identical.

```bash
node src/verify.js out/punch_demo --comp "Punch Title" --ref ../../examples/punch_demo/src/punch_title.html
```

`--ref` can be the HyperFrames HTML (rendered in Chrome by seeking its
timeline, so no video compression gets in the way) or a video. The verifier
writes `out/<shot>/verify/<comp>/`: the frames, `sheet.png` (reference |
preview | difference ×4) and `report.json`.

Results for the punch demo:

| What | Against | PSNR |
|---|---|---|
| Punch Title (HyperFrames → AE text layers) | the HTML in Chrome | 56.5 dB mean, worst 54.5 |
| Punch Title | Frameo's webm render | 36 dB (the render service draws text 1px higher; VP9 4:2:0 alone costs ~41 dB) |
| Full shot | ffmpeg render (no grain, yuv444p) | flashes 31–34, money 32, zoom blur 30, push 27.5 |

HyperFrames type tests from Frameo's "HF Motion Studio Test" (`examples/hf_motion`,
fetch the renders with `fetch.sh`), against Frameo's own MP4 renders:

| Render | Becomes in AE | PSNR |
|---|---|---|
| SOLVAY: video inside the text, text scales 1.2→1 | video layer with an alpha track matte from the SVG text; scale keys pivoted at the SVG origin | 46.2 dB mean, worst 44.3 |
| Per-word reveal: words fade and rise | Text Animator by words: Opacity 0, Position y 30 | 43.1 dB mean, worst 42.3 |
| ICONIC: characters flip up in 3D | Text Animator by characters: Opacity 0, Position z, Rotation X; per-character 3D; camera zoom 900 | 38.6 dB mean, 36.6 while animating |
| 1965: characters scramble then settle | Text Animator: Character Offset with a Wiggly Selector | 47.5 dB once settled; the scrambling frames differ (both are random) |
| Radial + conic gradients | solids with Gradient Ramp + Radius/Angle slider; conic via Polar Coordinates | gradients 41.5–45 dB (29.7 whole frame: the labels' font) |
| Shapes: union / intersect / exclude, offset ±12, live polygon 3→8 | shape layers with Merge Paths, Offset Paths, Polystar Points held | 33.4 dB |
| Gradient text + shine sweep | gradient solid matted by the text, CC Light Sweep keyed | 30.6 dB; static gradient within 1–3 levels |
| paintPath underline + matchState box | mask wipe; rectangle size/position/colour keyed | box 32 dB; reveal timing matched, brush edge not |
| Eight eases | shape-layer dots with eased position keys | dots within 1–3 px, 41.7 dB on the motion (26.3 whole frame: labels) |

| Whip between video and photo (`whip`) | two Easy Ease keys per layer + Directional Blur adjustment | 39.9 dB mean; mid-whip 22 dB (Frameo adds render motion blur) |
| Whip with flash frame (`whip`, blur 60) | same | 34.4 dB mean |
| Directional blur + canvas whip (`fx`) | fx precomp: Directional Blur adjustment, whip | 36.3 dB mean |
| Dissolve cut with RGB split + lens (`fx`) | dissolve blend, Shift Channels rig, Optics Compensation | 37.5 dB mean; lens margins identical to the pixel |
| lookAt / noise / spring / seeded random (`expr`) | sampled and keyed | lookAt 34–46 dB; noise and random values differ by design |

Where whole-frame numbers are lower, it is the `monospace` labels and big
white type: Frameo renders on Linux with different monospace fonts and
anti-aliasing, then compresses to H.264. Measured on the animated content
alone, the conversions sit at 32–45 dB.

The push frames are lower because ffmpeg's `zoompan` crops at whole pixels
(and at even pixels in yuv420p), so its push steps by up to 1–2px a frame.
AE moves smoothly. Shifted by that sub-pixel offset, the push frames match at
33–35 dB.

What the verifier taught the converter:
- CSS `opacity` fades text and its shadows together, so a fading text with
  shadows goes in its own precomp and the precomp fades.
- ffmpeg's `eq` works on TV-range luma (16–235) and keeps the colour, so it
  becomes Levels with the TV-range offset, on an adjustment layer in
  Luminosity mode.

The preview reproduces AE as hf2ae assumes it works (tracking, Drop Shadow
softness, Radial Blur amount). It checks the conversion, not After Effects
itself. One run in real AE is still needed to confirm those assumptions (see
Calibration).

## Tests

```bash
npm test
```

The tests run the generated `.jsx` against a mock of the AE scripting API,
which catches script errors but not rendering differences.
