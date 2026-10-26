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

## Tests

```bash
npm test
```

The tests run the generated `.jsx` against a mock of the AE scripting API,
which catches script errors but not rendering differences.
