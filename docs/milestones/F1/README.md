# F1: shared depth, soft particles, distortion, bloom / grade, quality tiers

Branch `anim-plan`, 2026-10-17. Spec: `docs/fx-plan.md` §2.2, §2.4, §2.6 and the F1 row of §5. API: `docs/fx-api.md` ("F1 additions").

## What changed

| Area | Files |
|---|---|
| Post pipeline (rewritten, no EffectComposer) | `src/render/post.ts` |
| Shared depth / soft particles | `src/render/fx/softDepth.ts`, `src/render/fx/fxLayers.ts`, `src/render/fx/particles.ts` |
| Distortion (heat shimmer, ripples) | `src/render/fx/distortion.ts`, `fxDefs.ts` (new op kinds `heat`, `ripple`, layers on 9 defs), `fxDirector.ts`, `legacyVfx.ts` |
| Look: bloom per theme, split toning, black toe, grade presets | `src/render/fx/fxLook.ts`, `post.ts` |
| HDR convention for FX colours | `fxDefs.ts` `HDR_SCALE`, `legacyVfx.ts` |
| Tiers | `post.ts` `POST_TIERS`, `fxSettings.ts` `TIER_CAPS.soft / .dist` |
| Game hooks (5 lines) | `src/main.ts`: theme id to `setLook`, vignette kick, grade kicks, `distActive` |
| FX Lab | `tools/fxlab/lab.ts`, `index.html`, `fxAtlas.ts` (flipbook cards are soft, on `FX_ALPHA`) |
| Tools | `tools/shots/postprobe.cjs` (GPU timer queries per pass, fixed camera, A/B two builds), `tools/shots/f1lab.cjs` (lab sheets), `tools/fxcheck.ts` (distortion tiers + expiry) |
| Animation Lab (1 line) | `tools/animlab/lab.ts` enables the FX layers on its camera, otherwise its finisher-FX preview lost its particles |

### The pipeline (`post.ts`)

1. **scene**: the WORLD layer into `sceneRT` (HalfFloat colour + `DepthTexture` = the shared depth).
2. **depth** (medium, high): half-res RGBA16F; A = linear view depth for soft particles and distortion; RGB = view normals rebuilt from depth once, for GTAO (high).
3. **ao** (high): GTAO on the shared depth + those normals, multiplied into `sceneRT`. No second scene render.
4. **fx**: layers `FX_ADD`, `FX_ALPHA`, `FX_GHOST` into `sceneRT`, hardware depth test against the shared depth, soft fade from the linear copy. FX are no longer darkened by AO.
5. **dist** (medium: heavy events, high: all): `FX_DIST` sprites into a half-res RG16F offset target. Runs only while a sprite lives.
6. **rays** (high): only while the sun is on screen (it used to run every frame as the NaN sanitiser; the sanitise now also happens in the bloom prefilter and the final pass).
7. **dof** (medium, high, when the camera director asks): Bokeh reading the shared depth (`DEPTH_PACKING 0`), no own depth render.
8. **bloom**: dual-filter (Karis soft-knee prefilter, 4-5 downsamples, tent upsamples), composited inside the final pass.
9. **final**: distortion offset, chromatic aberration, bloom, grade (theme + F1 extras + presets), vignette (+ kick), flash, tone mapping, sRGB, straight to the canvas. (Replaces the old grade pass, the bloom blend pass and the OutputPass.)

### Shared depth: the r170 experiment

Tiny page (`exp.html` in the session scratchpad; the facts are reproduced here), headless Chromium on the Arc iGPU (ANGLE D3D11):

| Question | Result |
|---|---|
| `DepthTexture` (UnsignedIntType) on a HalfFloat target, then sampled in a later pass | works; linear depth at the screen centre 5.57 m, as expected |
| same with `samples: 4` (MSAA) | works: three resolves the depth texture (`resolveDepthBuffer`) |
| R16F / RG16F / RGBA16F render targets | render (EXT_color_buffer_float present) |
| `GTAOPass` with `parameters.depthTexture` | **throws** in r170: `setGBuffer()` reads `normalRenderTarget.depthTexture` and `setSize()` calls `normalRenderTarget.setSize`, and that target only exists when GTAO renders its own G-buffer. A 6-line subclass with a stand-in fixes it (`AOPass` in `post.ts`). |
| GTAO with the shared depth and no normals | correct AO, but its denoiser rebuilds normals from depth 13x per pixel: measured 6.3 ms vs 2.7-4.4 ms for the old G-buffer path. Fixed by rebuilding normals once in the depth pass: 2.2-2.6 ms. |
| Bokeh | `BokehShader` with `DEPTH_PACKING 0` reads the depth texture directly. |
| GPU timer queries (`EXT_disjoint_timer_query_webgl2`) | **available** on the Arc driver. All GPU numbers below are timer queries. |
| Does rendering into a depth *texture* cost more than a depth renderbuffer? | no: same page, 160 interleaved frames each: renderbuffer 7.77, D24 texture 7.83, D32F texture 7.84, D24S8 texture 7.77 ms |

### Soft particles

- Every particle carries a fade distance (new 5th attribute vec4). Defaults per primitive (`softDepth.ts` `SOFTNESS`): sparks and embers 0.05 m, fire 0.25, flash 0.3, dust 0.4, smoke 0.5, heat 0.4, ripple 0.3. A def or a layer can set `soft` (0 = hard).
- Flipbook cards in the FX Lab (`fxAtlas.ts`) use the same fade (0.25 emissive, 0.6 smoke) and sit on `FX_ALPHA`. Flipbooks are **not** wired into the game (F3).
- Low tier: no fade (no depth copy), as the plan says. No fog cards exist yet, so "except fog" has nothing to apply to.

### Distortion

- `heat`: a camera-facing column standing on its anchor, two octaves of rising value noise, strongest in the middle, fades in 0.15 s and out over the last 40 % of its life.
- `ripple`: an expanding disc with a thin ring at 80 % radius pushing pixels outwards, fading as it grows.
- Both fade against the shared depth, so a fighter standing in front is not smeared.
- In the game (defs): ripples on heavy hits (1.4 m), parry (1.1 m), quake (4 m), ultimate cast (3 m), plain kill (3.5 m), nova (4.5 m), keg explosion (6 m); heat on the keg explosion (4.5 m column, 2.6 s, also on medium), fire-pit / lava throws (also on medium), standing in fire, nova, fire streams (8/s) and the ring of fire (9/s, high only).
- Arena braziers and the arena's own flames are not FX-owned yet (F4), so they have no shimmer in the game. The FX Lab shows it on its brazier.

### Bloom and grade

- `fxLook.ts` `THEME_LOOK`: per theme a soft-knee bloom (threshold, knee, strength, radius) and grade extras (split toning: cool shadows / warm highlights, luminance-normalised; black toe `crush`). `themes.ts` (the arena session's file) is untouched; `post.setLook` takes the theme id from `main.ts`.
- Night / fire themes: threshold 1.1-1.25. Day themes keep 1.6-2.2: at 1.2 sunlit stone (1.5-3 linear) hazed over.
- `HDR_SCALE` (`fxDefs.ts`): sparks 3, flash 2.2, fire 1.8, embers 3, dust / smoke 1. Below the plan's numbers (sparks 6-12, cores 8-30) because the F0 dots overlap additively; F3 sprites should move towards the plan.
- Grade presets (`GRADE_PRESETS`): finisher, ultimate, lastStand, killcam, victory, impact. `post.setPreset(id, w)` holds one (eased), `post.kickPreset(id, w, dur)` pulses one, and `FxDef.post.grade` kicks one from a def. **Nothing in the game holds a preset yet** (F7 wires beats); the existing killcam / finisher `desat` is unchanged.
- Vignette kick: `FxDef.post.vignette` on heavy hits (0.12), ultimate (0.2), finisher start (0.25), explosion (0.3), plain kill (0.35); decays in about 0.4 s. Chromatic aberration kicks were already there (F0).

### Quality tiers

| | Low (q0) | Medium (q1) | High (q2) |
|---|---|---|---|
| Scene render scale | **0.75** (final pass upsamples) | 1 | 1 |
| Soft particles / depth copy | off | on | on |
| Distortion | off (nothing spawns, no pass) | heavy events only (ops with `tier: 1`) | all |
| GTAO | off | off | on (shared depth) |
| God rays | off | off | on, only while the sun is on screen |
| DOF | off | on | on |
| Bloom | 4 levels from 1/4 res | 5 levels from 1/2 res | 5 levels from 1/2 res |
| MSAA | 0 | 0 | 0 (`?msaa=4` forces it) |

## Measurements

Method: **GPU timer queries** (`EXT_disjoint_timer_query_webgl2`, available on the Arc driver), per pass and around the whole `post.render()`. Headless Chromium, 1920x1080, DPR 1, `tools/shots/postprobe.cjs`: three fixed fights (colosseum gorak-erika seed 4242 t=20, forge ozrel-maw seed 77 t=14, glacier aldric-vex seed 1234 t=16), a fixed side-on camera, 120 frames per tier, plus a stress run (explosion + heavy hit every 8 frames, plain kill every 32). Builds were run interleaved: before, after, before, after. Raw logs and JSON: `perf/` (`before_*`, `after_*`: all tiers; `lowbefore_*`, `lowafter_*`: low tier with the final 0.75 scale).

**The whole-frame GPU total is dominated by noise.** The scene pass of the same build and frame varies 6-38 ms between runs (GPU clock and thermal state). Medians of the total over 6 runs per tier: high 22.4 before / 22.8 after, medium 17.8 / 21.4, low 17.7 / 18.2: within the noise, and the scene pass carries the drift. The controlled same-page test above shows the scene pass itself did not get more expensive. So the comparison below is **post cost excluding the scene pass**, which is stable within each run.

Post cost excluding the scene pass (GPU ms, median of 6 runs = 3 fights x 2 rounds, [min-max]):

| Tier | Before (EffectComposer) | After (F1) | Change |
|---|---|---|---|
| High | 7.70 [5.41-10.23] | 4.24 [3.68-6.37] | -3.5 ms (-45 %) |
| Medium | 3.63 [3.09-4.74] | 1.98 [1.32-2.26] | -1.7 ms (-45 %) |
| Low | 3.54 [3.01-4.54] | 1.29 [0.80-1.46] | -2.3 ms (-64 %) |

Per pass, after (median): high depth 0.23, AO 2.43, FX 0.00-0.07, distortion 0.05 (when live), bloom 0.72, final 0.61; medium depth 0.22, FX 0.06, bloom 0.88, final 0.68; low FX 0.04, bloom 0.48, final 0.62. Before: GTAO (with its own G-buffer render) 4.37, god rays + sanitise / grade 0.5-0.9 each, UnrealBloom 1.05-1.30, OutputPass 0.9-1.1.

Same-page interleaved scene-pass tests (160 frames each, colosseum, high):

| Scene target | GPU ms |
|---|---|
| 1920x1080, no MSAA | 6.79 |
| **MSAA 4x** | 10.11 (+3.3 ms, +49 %, opaque pass only; the FX pass and AO blend would add more) |
| MSAA 2x | 9.28 (+2.5 ms) |
| **0.75 render scale** (the new low tier) | 4.58 (-2.2 ms, -33 %) |

So low is cheaper by about 2.3 ms of post plus about 2.2 ms of scene (4.5 ms, a quarter of a typical low frame on this machine), and high is cheaper by about 3.5 ms of post. FX themselves stay far inside the plan's 2.0 ms budget: FX pass 0.00-0.5 ms in the stress runs, distortion pass 0.03-0.06 ms. MSAA is not affordable on this iGPU.

Low-tier A/B with the 0.75 scale (whole frame, same method, 2 interleaved rounds x 3 fights, medians): GPU total **16.5 -> 11.1 ms** (stress 16.8 -> 10.5), CPU-synced frame time 22.9 -> 16.0 ms, scene pass 13.6 -> 9.8, post 3.0 -> 0.9. Unlike the full-resolution tiers, this gain is larger than the run-to-run noise.

## Screenshots

`shots/` (all `postprobe.cjs --bench=0 --shots`, same seed, same sim time, same fixed camera):
- `<theme>_q<2|0>_<before|after>.jpg` for colosseum, forge and glacier (downscaled to 1280x720).
- `<theme>_q<2|0>_<before|after>_fx.jpg`: the same camera 0.12 s after an explosion behind the fighters, a heavy hit between them and a dodge dust puff.
- `tiers_<theme>.jpg`: before / after at q2, q1, q0 for the FX moment (distortion visible on q2 and q1, none on q0).
- `cmp_<theme>.jpg`: 2x2 grids (before / after, without / with FX) at q2 for all seven themes.

`lab/` (`tools/shots/f1lab.cjs`, FX Lab, seed 1):
- `f1_soft_*.png`, `*_diff.png`: soft vs hard. Each frame has a hard copy on the left dummy and a soft copy on the right; the strips also toggle soft for the whole frame, and the diff images show |soft - hard| x6.
- `f1_heat_brazier_diff.png`, `f1_heat_explosion_diff.png`, `f1_ripple_heavy_diff.png`: distortion on / off and |difference|.
- `f1_bloom_looks_a/b.png`: post off (the pre-F1 lab), the lab look and each theme's F1 look on one frame.
- `f1_preset_<id>.png`: each grade preset at weights 0, 0.5 and 1.
- `f1_tier_q<n>_explosion.png`: the explosion test at each tier.
- The lab sheets were taken before the final softness tweak (smoke 0.7 -> 0.5, dust 0.5 -> 0.4).

What the shots show (my reading; see the next section for its limits):
- Explosions and flashes no longer wash the whole frame white (glacier, moonlake): cores stay hot, the halo is tighter.
- Night themes are darker in the shadows and cooler, lamps and fire stay warm; day themes change little.
- Soft particles remove the hard line where smoke cuts the floor and a body; the soft side reads as smoke wrapping the leg.
- Heat shimmer over the lab brazier and the explosion is visible in the difference images; the ripple bends the arena gate bars in the colosseum FX shot.

## What I could not judge

- Whether the shimmer and ripples look physical or "wobbly" **in motion**: I only saw stills and difference images.
- Bloom balance and the black crush on a real monitor; headless screenshots go through the same tone map but not a real display.
- Whether the brighter F0 sparks (HDR x3) now read as hot metal or as neon.
- The look of the 0.75-scale low tier on a 1080p monitor (softer image).
- The GPU numbers are indicative: the iGPU's clock state moves the totals by up to 2x between runs; only per-pass and same-page comparisons are trustworthy.

## Deviations from the plan

1. **EffectComposer removed** instead of adding a `ScenePass`: the custom pipeline lets the final pass absorb grade, bloom composite and output, and skips passes per frame.
2. **Dual-filter bloom shipped in F1** (plan: P2 "measure first"): it was needed to make low cheaper and gives the soft knee and the wide fog glow.
3. **Theme bloom numbers live in `fxLook.ts`**, not `themes.ts` (the arena session's file). Day themes keep higher thresholds than the plan's 1.0-1.2.
4. **The linear-depth copy is RGBA16F with normals**, not R16F: GTAO needs normals and rebuilding them per denoiser tap was too slow.
5. **MSAA measured and left off** on every tier (`?msaa=4` remains).
6. **Low renders at 0.75 scale** (not in the plan).
7. **No new `perfprobe` rows**: `tools/shots/postprobe.cjs` does the post / FX measurement (per-pass GPU timer queries, two builds A/B, stress spawns). `perfprobe.cjs` still runs (`post.bloom.enabled`, `post.rays.uniforms`, `post.quality` still exist).
8. **`HDR_SCALE` below the plan's numbers** (see above).
9. **Grade presets are hooks only**; the game does not hold any yet (F7).

## Known issues

- GTAO now also sees alpha-tested and depth-writing transparent geometry (foliage cards); the old pass hid them. Sakura trees may get slightly more AO under them.
- FX (particles, rings) are no longer darkened by AO. That is intended but changes how dust in corners reads.
- The god-ray pass no longer runs when the sun is off screen, so the NaN sanitise moved into the bloom prefilter and the final pass; Bokeh (when on) runs before that sanitise.
- Heat over arena braziers waits for F4 (they are arena-owned flames).

## What F3 needs

- Move `tools/fxlab/fxAtlas.ts` into `src/render/fx/atlas.ts`; its flipbook material is already soft and on `FX_ALPHA`. Spawn flipbooks from a new op kind like `heat` / `ripple` (one `case` in `FxDirector.runOp`).
- Raise `HDR_SCALE` towards the plan's numbers once sparks are sprite streaks instead of overlapping dots; re-check the theme thresholds in the lab's `f1.bloom` item.
- Use `post.kickPreset('impact', ...)` / `post.vignette` from the impact defs if hits need more punch; CA and flash already come from defs.
- Distortion ribbons for heavy trails can reuse `distortion.ts`'s shader (add a ribbon geometry on `FX_DIST`).

## Owner decisions

1. Low tier at **0.75 render scale** (-2.2 ms, softer image) or back to 1.0 (`POST_TIERS[0].scale` in `post.ts`).
2. MSAA stays off (costs ~3.3 ms on this iGPU); revisit on a discrete GPU.
3. Judge in the FX Lab (`/tools/fxlab/`, group "F1 tests"): heat strength, ripple strength, soft distances, bloom per theme (the look and bloom sliders), and the grade presets for F7.

## Checks

- `npm run build`: passes.
- `npm run fx:check`: passes (59 defs; new: distortion sprites expire, distortion tier gating q0/q1/q2 = 0/2/3 sprites for an explosion + a burn tick; grep gate clean).
- `npm run sim:test -- 40`: overall win rates 45.7-54.6 %, timeouts 0.0 %, kills without contact 0/2240, determinism true (identical to F0; `src/sim` untouched).
- FX Lab: every F1 test item played headless with no page errors (`lab/f1lab-report.json`).
- Memory: one headless browser at a time; the dev server ran only for the lab sheets and was stopped.
