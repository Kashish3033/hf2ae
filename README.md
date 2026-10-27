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

## Calibration (to do once After Effects is installed)

Some ffmpeg units have no exact AE equivalent. The current values are best
guesses, kept in `CALIBRATION` in `src/ffreader.js`:

| ffmpeg | AE | constant |
|---|---|---|
| 8 averaged zoompan copies (spread 0.245) | Radial Blur, Zoom, amount | `radialBlurPerZoom` |
| `noise=alls=4` | Noise, amount % | `noisePerStrength` |
| `gblur=sigma` | Gaussian Blur, blurriness | `gaussianPerSigma` |

Also to verify in AE:

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

HyperFrames: plain-text `.clip` elements with opacity and 2D transforms
animated by the composition's GSAP timeline. Pages that load `plus/*.js`
helpers need those files next to the HTML.

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
