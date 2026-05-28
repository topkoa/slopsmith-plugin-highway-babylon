# 3D Highway (Babylon) — Slopsmith Plugin

A [Slopsmith](https://github.com/byrongamatos/slopsmith) visualization plugin that renders the note highway in 3D using [Babylon.js](https://www.babylonjs.com/). An alternative to the bundled `highway_3d` plugin, built for higher effects ceiling (GPU particles, real bloom + HDR tonemap, post-FX pipeline, future audio-reactive shaders) while staying inside the slopsmith#36 `setRenderer` contract.

Status: **work in progress**. Many features ported from `highway_3d`; several still pending (see below).

## Install

Drop this directory into your Slopsmith plugins folder:

- **Slopsmith Desktop**: `%APPDATA%\slopsmith-desktop\plugins\highway_babylon\` (Windows), `~/Library/Application Support/slopsmith-desktop/plugins/highway_babylon/` (macOS), `~/.config/slopsmith-desktop/plugins/highway_babylon/` (Linux).
- **Slopsmith Docker / standalone**: `slopsmith/plugins/highway_babylon/`.

The plugin id is `highway_babylon` — the folder name MUST match.

After install, restart slopsmith, open a song, and pick **"3D Highway (Babylon)"** from the visualization picker.

Babylon.js is loaded from CDN (`https://cdn.babylonjs.com/babylon.js`) on first use. The 3D text-mesh font (`Droid Sans_Regular.json`) and the `earcut` polygon triangulator are also loaded from CDN on demand.

## Requirements

- Slopsmith with `setRenderer` support (slopsmith#36).
- Browser/Electron with WebGL2 (Electron 35+ has WebGPU too, plugin currently forces WebGL2).
- Network access on first load to fetch Babylon.js + font + earcut from public CDNs.

## What's implemented

### Scene & geometry
- Babylon `WebGL2` engine (WebGPU init scaffolded but disabled — Babylon v9 WebGPU init quirks need separate work).
- Right-handed coordinate system to match Three.js conventions (Babylon defaults to left-handed).
- All world dimensions expressed in `N * K` where `K = SCALE / 300` (mirrors the `highway_3d` scale convention so geometry scales as one unit).
- Static board, headstock, nut bar at hit zone.
- 24 fret wires (octave/inlay frets thicker).
- 6 colored string lines at `Z = 0` (hit line).

### Notes
- Per-string thin-instance pools (one mesh per string × 3 material variants: idle, hit-glow, sustain).
- Z-axis "approach rotation" (portrait at far → landscape at hit line) matching `highway_3d`.
- Open-string notes use wide flat slab geometry (`OPEN_SCALE_X = 40K / NW`, exact `highway_3d` ratio).
- Hit-line `Z` clamp — past notes pile at `Z = 0`, never fly past the camera.
- Linger windows (`NOTE_LINGER = 0.10`, `CHORD_LINGER = 0.55`).
- Source meshes hidden via `Y = -100` offset trick (Babylon thin-instances also render the source — `writeMatrix` compensates with `y - OFFSCREEN_Y`).

### Chords
- Full chord box rendering: fill quad + 4 edge bars per chord (cyan-teal `0x00d2d5` matching `highway_3d`).
- Box Y bounds span the full string range (not just the chord's strings), matching `highway_3d`.
- Box X bounds use `fretX(fMin-1)` to `fretX(max(fMax, fMin+2))` (asymmetric extension to ensure min 3-fret width).
- Rim thickness proportional to box height (`CHORD_FRAME_RIM_MIN`, `CHORD_FRAME_RIM_FRAC_H`).
- Per-chord `openWScale = max(0.22, (boxW * 0.96) / OPEN_NOTE_WORLD_W)` shrinks open chord notes to fit the chord frame.
- `chordCX` clamped so open notes never overflow the chord box.

### Sustains
- Single-trail sustain for fretted notes.
- **Double-trail sustain** for standalone open notes (`x - offset` + `x + offset` where `offset = NW * 3`) — visually echoes the wide open-note body.
- Chord-member open notes skip sustains (matches `highway_3d` — the chord frame covers them).
- Sustain `Z` end clamped at hit line so trails shrink as sustain is consumed.

### Hit/active glow (`bundle.getNoteState`)
- Separate hit-mesh per string with brighter emissive (white-tinted string color).
- Bloom pipeline (DefaultRenderingPipeline) catches the overdriven emissive and produces a glow halo.
- Notes flagged `'hit'` / `'active'` by a scorer (e.g. `note_detect`) route to the hit-glow pool.

### Beat lines
- Two thin-instance pools: measure-beat (thicker, brighter blue) and quarter-beat (thinner, dim gray).
- Scrolling along `Z` with notes.

### Camera (full `highway_3d` lookahead port)
- `_lookaheadComputeFretBounds` — scans notes/chords in `[now, now + CAM_LOOKAHEAD_SEC]` (3 sec) window.
- `_lookaheadTargetWorldX` — `fretMid(minF)+fretMid(maxF)` midpoint biased 10% toward `0.6 * fretX(0) + 0.4 * fretX(NFRETS)`.
- `_lookaheadSmoothCamStep` — frame-rate-independent blend rate (`CAM_FOCUS_BLEND_RATE = 0.7/sec`) for `camX`, span, and low-fret bonus.
- Two-stage smoothing: lookahead `fs` blend → outer `CAM_LERP_BASE * bpm/120` lerp on `curX`/`curDist`.
- Aspect compensation (`aspectScale = max(1, REF_ASPECT / max(camAspect, 0.5))`).
- NDC self-correcting tilt (`DESIRED_NDC_Y = -0.35` keeps fretboard in lower-third of frame regardless of panel aspect).
- Shoulder offset (`20 * K` flipped sign in lefty).
- BPM-scaled lerp speed.
- Camera operating distance matches `highway_3d` locked-mode default: `CAM_DEFAULT_DIST = (camBaseDistU(12) + camLowFretPullbackU(1)) * K = 117 * K`.
- FOV 70° vertical (matches `highway_3d`).

### Open-note X stability
- `_stableOpenX(noteT, notes, chords)` — open-note X anchored to the **note's own time**, not current playback time.
- Computes `_lookaheadTargetWorldX` over notes in `[noteT - 0.05, noteT + CAM_LOOKAHEAD_SEC]`.
- Prevents past-clamped open notes from jittering sideways as the camera moves.

### Highway lane (active-fret highlight)
- Per-fret striped lanes via two thin-instance meshes (odd/even with `0x3d739e` / `0x62a5d8` colors).
- `highwayIntensity = max(1 - dt/AHEAD)` over upcoming notes.
- Lane alpha = `LANE_OP_BASE + intensity * LANE_OP_INT` (exact `highway_3d` constants: `0.12 + 0.24 * intensity`).
- Lane dividers (vertical bars at fret boundaries) with **blue glow**: emissive ramps `1.0 + 2.0 * intensity` for bloom catch.
- Lane span clamped via `highway_3d`'s exact formula (`LANE_SPAN = 4` minimum width, centered re-clamp when chord span exceeds).
- Lane only renders when `activeFrets.size > 0` (matches `highway_3d`'s `hasChartAnchors || activeFrets.size > 0` gate).

### Fret labels
- 24 **true 3D extruded text** meshes via Babylon `MeshBuilder.CreateText` (uses `earcut` triangulator + `Droid Sans` font, both CDN-loaded).
- Specular highlights via `StandardMaterial` (`specularPower = 64`) for visible bevel sheen on the extruded edges.
- Heat dynamics: active frets get **gold** emissive `(1.0, 0.91, 0.30)` + scale × 1.35 + alpha 1.0. Inactive frets get **blue-grey** `(0.60, 0.72, 0.80)` + alpha 0.55.
- Active fret detection window: `[now, now + 2.0]` (matches `highway_3d` exactly).
- Labels rotate to lie flat on board surface, mirror correctly in lefty via per-frame X update.

### Lefty + inverted handling
- `fretboardRoot` TransformNode parents all geometry. Per frame: `fretboardRoot.scaling.x = lefty ? -1 : 1` mirrors the entire fretboard scene.
- All material `backFaceCulling = false` so inverted-winding faces stay visible after the `-1` scale.
- Camera mirrors via `curX * mir` and shoulder offset sign flip.
- `sY(s)` honors `bundle.inverted` (flips string Y order).
- 3D fret labels NOT parented to `fretboardRoot` (would mirror text glyphs backwards); manual X mirror per frame instead.

### Fret spacing
- Uniform spacing default (matches `highway_3d`'s `_h3dFretUniform = true` default).
- Real-guitar log spacing (`12√2`) available via `localStorage.setItem('highway_babylon.fretSpacing', 'logarithmic')`.

### XYZ axis gizmo (top-left)
- Three colored bars + tip cubes (X red, Y green, Z blue) + DynamicTexture letter labels.
- Rendered in a secondary `gizmoCam` viewport (`0.005, 0.82, 0.12, 0.18` — top-left ~12% × 18%).
- Layer mask isolation so only gizmoCam sees the axes.
- Each frame: `gizmoCam.position = -mainForward * 1.8` looking at origin → tracks main camera orientation in real time.
- Parented to `fretboardRoot` so axes mirror with lefty too.

### FPS counter
- HTML overlay div, `position:absolute` top-left next to gizmo.
- Updated 4× per second via `engine.getFps()`.

### Post-FX (DefaultRenderingPipeline)
- Bloom (threshold 0.25, weight 1.2, kernel 96, scale 0.65).
- FXAA.
- ACES tonemap, exposure 1.1, contrast 1.15.
- Vignette weight 2.0.

## What's NOT implemented yet

In rough order of likely usefulness:

- **Chord name labels** (gold sprite above chord box) — 3D text mesh per chord name (CreateText already wired for fret labels).
- **Note-hit sizzle particles** — `highway_3d`'s contained sparkle effect when a note is judged hit/active.
- **Repeat-chord detection** — same shape within 0.5 s → frame halves height + dims.
- **Barre indicator** — white vertical line at the barre fret during chord linger.
- **Verdict tinting** (`bundle.getNoteState`) — chord frame turns green on clean hit, red on miss.
- **Splitscreen support** — currently single-canvas only. Needs per-panel state isolation, DPR clamp, localStorage namespacing per panel.
- **Technique labels** — bend chevrons, slide arrows, H/P/T markers, accent halo, palm-mute X, pinch-harmonic.
- **Section labels on highway** — section name sprites at fret 12.
- **Section HUD card** — top-right floating section name.
- **Lyrics overlay** — top-center 2D canvas (would need a separate overlay element, not part of the 3D scene).
- **Chord diagram overlay** — top-left 2D canvas showing recent chord shape.
- **Board projection ghost** — preview fretboard position before note arrives.
- **Active string emissive pulse** — strings briefly glow on note hit.
- **Per-panel localStorage settings** (`highway_babylon_panel<N>_<key>` pattern).
- **Anchor-driven chord frame + lane** — currently uses fretted-span fallback; `bundle.anchors` ignored.
- **Arpeggio lavender frames** — special-case styling for arpeggio handshapes.
- **Lefty shoulder offset polish** — works but not deeply tested in lefty + splitscreen combo.
- **WebGPU engine** — scaffolded in `_init` but disabled. Babylon v9 WebGPU init needs `glslang` + `twgsl` URL config that we haven't sorted out yet.
- **Settings panel** (`settings.html`) — no user-tunable settings yet.

## File layout

```
highway_babylon/
├── plugin.json   # Slopsmith manifest (id, name, type: visualization, script)
├── screen.js     # All rendering code, single IIFE
├── README.md     # This file
└── LICENSE       # AGPL-3.0
```

## License

AGPL-3.0-only. See [LICENSE](LICENSE).

This plugin uses [Babylon.js](https://www.babylonjs.com/) (Apache-2.0) loaded at runtime from CDN.

## Contributing

PRs welcome. Slopsmith convention is DCO sign-off on commits (`git commit -s`).
