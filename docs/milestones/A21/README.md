# A21: Moon Gate performance and loading (+ the hosted-build check)

Branch `anim-plan`, 2026-10-19. Scope: the Moon Gate (theme `colosseum`, kit mode), so the owner can show it to friends
on modest machines and over the web. `src/sim` is untouched. Everything was measured on PRODUCTION builds (`vite build`,
served as static files; one run on `vite preview`), headless Chromium on the Arc iGPU (ANGLE D3D11).

## Results in one table

| | Before (`385df7e`) | After | Note |
|---|---|---|---|
| First visit, q1 (Moon Gate, Gorak vs Maw, everything incl. audio, gzip on the wire) | 46.3 MB | **34.9 MB** | GitHub Pages gzips every file, so these are wire sizes |
| First visit, q2 / q0 | 50.5 / 25.3 MB | **39.1 / 22.1 MB** | |
| Arena art only (kit + floor + sky + backdrop), q2 / q1 / q0 | 33.3 / 29.1 / 9.4 MB | **25.4 / 21.2 / 9.4 MB** | plan: 14-22 MB first visit; q1 now inside it |
| Arena GPU texture memory, low / medium / high (`arena:budget`) | 30.95 / **127.35** / 179.41 MB | 30.95 / **103.35** / 155.41 MB | 24.65 MB headroom on medium |
| Shader compiles after the loading screen (intro + fight) | 2.0 s + 0.65 s + 0.37 s at the intro start, 0.43 s first heavy hit, 0.75 s first crate break, 0.07 s first kill cam | **none** | `prodcheck live`, q2 |
| Intro, real time 1080p (frames per second, % frames over 20 ms) | q2 48.6 fps / 32 %, q1 42.9 fps / 42 % (measured mid-milestone, before the line-of-sight fix) | **q2 57.4 / 10 %, q1 59.6 / 1.8 %** | cause: the entrance camera's line-of-sight raycasts (20-30 ms CPU per frame) |
| Fight, real time 1080p | not measured on the old build (the before / after run was stopped by a low-memory reap; not restarted) | q2 56.7-60 fps / 8-17 %, q1 59.4-60 / 4-7 %, q0 60 / 2.5 % | headless RAF is 60-capped and jittery; q0 shows the floor of the jitter |
| CPU per tick (submit, fight frame, q2) | about 10 ms | **about 8 ms** | matrices once per frame, no per-frame program re-derivation |
| Hosted (sub-path) build | the Moon Gate never loaded (arena, FX atlases, KTX2 transcoder 404 under `/arena-gods/`) | loads | fixed, see "Production build" |

## 1. Download size

What a first visit downloads (gzip size; `node tools/perf/prodcheck.cjs net --q=<0|1|2>`; JSON in `net/`):

| Part (MB on the wire) | q2 before | q2 after | q1 before | q1 after | q0 before | q0 after |
|---|---|---|---|---|---|---|
| arena kit (props, pillars, statues, trims) | 22.81 | **14.97** | 22.81 | **14.97** | 7.45 | 7.45 |
| floor (slab set + ring inlay) | 4.38 | 4.38 | 4.38 | 4.38 | 1.39 | 1.39 |
| sky | 4.26 | 4.26 | 1.33 | 1.33 | 0.41 | 0.41 |
| backdrop | 1.81 | 1.81 | 0.54 | 0.54 | 0.11 | 0.11 |
| animation library (core + entrance + finisher) | 6.31 | **3.66** | 6.31 | **3.66** | 6.31 | **3.66** |
| fighters (Gorak + Maw + shared clips) | 5.60 | **3.93** | 5.60 | **3.93** | 5.60 | **3.93** |
| audio (all sfx + music, on the first click) | 3.69 | 3.69 | 3.69 | 3.69 | 2.76 | 3.69 |
| FX atlases | 0.90 | 1.61 | 0.90 | 1.61 | 0.48 | 0.72 |
| JS + CSS + KTX2 transcoder | 0.75 | 0.75 | 0.75 | 0.75 | 0.75 | 0.75 |
| **total** | **50.53** | **39.06** | **46.32** | **34.85** | **25.27** | **22.12** |

What dominates now: the arena kit (15 MB on q1 / q2; the 2048 stone trim 4.0 MB and the 2048 slab floor 3.6 MB are the
biggest single files), then the fighters (Gorak alone 3.2 MB), the animation core (2.6 MB) and audio (3.7 MB, all of it
on the first click). FX grew 0.7 MB because the dust / explosion flipbooks now load up front (they loaded on the first
dust puff / explosion before, mid-fight).

What changed:
- **Half-size normal maps for the props / statues / pillars / rubble / banners** (full tier only;
  `tools/arena/tex_caps.json`, applied by `build_assets.mjs` before encoding). Normals are UASTC: about 70 % of a kit
  GLB and 1 byte per pixel on the GPU (BC7). The 2048 stone trim and the floor keep their 2048 normals (the budget's
  texel-density rule for trims / floors, and they are the surfaces the camera gets closest to). Low tier untouched.
  Visual check: ref-3 preset + gate / tiers / overview / counter / flank / fire views, q2 / q1: PSNR 47-60 dB, at most
  0.24 % of pixels move by more than 8 levels (of 255), only on rim-lit bevels at the closest view (`fire`); q0 is
  pixel-identical; concept metrics C1-C8 unchanged (C1 0.35, C2 6.0 / 13.5). Sheets: `sheets/ref3_before_after.jpg`,
  `sheets/gate_before_after.jpg`, `sheets/fire_closeup_crops.jpg` (1:1 crops brightened 2.2x: the bevel highlights
  are a touch softer, nothing else).
- **Animation bins in a lossless transport coding** ('tdp1': per-track planar frame deltas + low / high byte split;
  `src/render/animCodec.ts`, `tools/anim/encode-lib.ts`; `build-lib.ts` writes it from now on, the loader still reads
  raw bins). Same int16 values (round trip checked value by value), so every pose is bit-identical; gzip 6.31 -> 3.66 MB.
- **Fighter PNG textures as lossless WebP** (exact RGB under transparent texels; `tools/convert/webp_textures.mjs`
  splices the GLB, geometry / skins / meshopt animation buffers copied byte for byte): Gorak 5.40 -> 3.72 MB, Erika
  3.63 -> 2.57 MB, decoded pixels identical (checked in Pillow before writing; the browser decodes lossless WebP exactly, but I did not render a Gorak close-up before / after to prove it in game).
- Not done (no first-visit effect): the unused `blood_spray` / `splash` bakes are never fetched (F3 owner decision
  still open, ~0.15 MB of repo only); kit pieces the Moon Gate does not use are never fetched either (per-theme loads).
  KTX2 vs WebP: KTX2 stays the default (WebP would be 4-8x the GPU memory); the WebP fallback files keep matching sizes.

## 2. Loading

- **Loading screen** (`src/ui/loading.ts`): arena name ("The Moon Gate"), a thin gold progress bar weighted by expected
  download size (kit file sizes from the manifest; fixed estimates for fighters / library / sky / backdrop), a status
  line ("Summoning the fighters", "Raising the arena", "Lighting the braziers"); fades out into the intro, vanishes at
  once when skipping into the fight. Screenshot: `sheets/loading_screen.jpg`.
- **Parallel streaming**: the arena art, both fighters and the animation library load together (before: fighters +
  library, then the voice lines, then the arena); inside the arena the kit, backdrop and sky load together (the
  backdrop and sky used to wait for the last kit file). Only `core` (+ `entrance` when the intro plays) blocks the
  start; `finisher` (and `entrance` when skipping) stream behind the intro / fight (a `?t=` jump waits for them). A
  'random' menu choice reuses the arena the constructor already started loading instead of rolling a second one.
- **Shader / upload warm-up behind the loading screen** (`App.prewarm`): `compileAsync` with the HDR scene target bound
  (the variant the frame uses); the FX sprite layers every fight uses (hit sprites, dust; explosion flipbooks when the
  arena has kegs), the first afterimage ghost and the debris pools are created hidden up front; every texture is
  uploaded to the GPU (`initTexture`); one warm frame through the post chain with the hidden FX objects, distortion and
  DOF switched on. Result (`prodcheck live`, q2, full intro + fight): **no program compiles after the loading screen**
  (before: 2.0 s + 0.65 s + 0.37 s frozen frames at the start of the intro, 0.43 s on the first heavy hit, 0.75 s on
  the first crate break, 0.07 s at the kill cam). The compiles now happen while the bar sits at about 90 %: on this
  machine the time from page open to the first intro frame is about 3 s longer locally (7.3 -> 10.2 s at q1), which is
  the same work moved out of the intro.
- Local timings (no network, `net` marks, ms): arena built 6.3 s -> 7.1 s (q1), intro start 6.3 -> 10.2 s; over a real
  connection the download dominates (34.9 MB at 50 Mbit/s is about 6 s, at 10 Mbit/s about 28 s).

## 3. Frame time

Probes (all on `dist`): `tools/perf/a21perf.cjs` (fight frame Gorak vs Erika #4242, oval #7, t = 20 s, side-on camera
like `postprobe.cjs`, 1920 x 1080, with the A19-A20 events that were never timed: a **firing fire jet** injected beside
the fighters (the colosseum's sim never places one), a **burning-oil pool** in front, a **lightning strike** held at
its peak; per-pass GPU timer queries, frame GPU timer, paired A/B of subsystems, and a real-time RAF run on the same
frame), `tools/perf/prodcheck.cjs live` (a whole intro + fight in real time), `tools/perf/cpuprof.cjs` (DevTools CPU
profile on an unminified build). JSON: `perf_mid.json` (after sections 1-2, before the render-path cuts),
`perf_after.json`.

Honest caveat: the per-pass / per-frame GPU timer numbers on this iGPU swing by 30-60 % between runs (q2 frame 15.8 ms in
one run, 25.5 ms in another on the same build: the sync readback lets the GPU clock drop). They are good for ranking
passes and for paired A/B deltas, not for absolute budgets. The real-time RAF numbers are the ones to trust.

Fight frame with jet + oil + lightning, 1080p (`perf_after.json`; ranking from the per-pass timers):

| Tier | Real time (RAF) | % frames > 20 ms | CPU per tick (submit) | Biggest passes (GPU, ranked) | Draw calls / triangles |
|---|---|---|---|---|---|
| q2 | 60.1 fps | 7.9 % | 8.8 ms | scene (lit stone with 11 point + 3 spot lights, fighters, fire pools) >> AO (GTAO half-res, 1.7-4 ms) > reflection (1.1-2 ms, half rate) > FX / fire field > bloom, final | 206 / 672 k |
| q1 | 60.1 fps | 7.1 % | 8.7 ms | scene >> FX > reflection (0.6-0.9) > bloom / final | 187 / 625 k |
| q0 | 60 fps | 2.5 % | 7.6 ms | scene >> final > FX > bloom | 164 / 305 k |

Paired A/B on that frame (on minus off, ms, median of interleaved pairs; the spread is wide): events (jet + oil +
lightning) +0.7 .. +1.4; fire field +0.4 .. +1.4 (the jet column and the oil flames fill a lot of the screen close to
the camera); fighters +0.4 .. +1.2; moon shadow map +0.4 .. +0.8; sky +0.5 .. +1.3 before the reorder, +0.07 .. +0.3
after; backdrop, ambient embers / mist: within noise.

What changed (all pixel-identical, `tools/perf/abpixels.cjs`: same-page renders with the old paths restored at runtime:
max difference 0 on the Moon Gate q1 / q0, forge q2, legacy q2; the Moon Gate q2 differs by 1 level in 2 channel values,
which is that tier's own run-to-run noise):
- **Entrance camera line of sight** (`src/cinematic/losAccel.ts`): the per-frame raycasts against the arena's big merged
  meshes tested every triangle (65 % of the main thread during the intro). A per-mesh local-space bounding-volume tree
  with three's own early-outs and triangle maths gives the same answer (checked against `intersectObjects` on four full
  intros: 7560 checks, 0 differences). Intro q1 42.9 -> 59.6 fps, q2 48.6 -> 57.4 fps.
- **Scene matrices once per frame** (`Post.render`): each of the 3-4 scene renders per frame re-walked the graph (a
  fifth of the frame's CPU).
- **Lights on the FX layers**: the FX / distortion passes saw no lights, so the renderer's lights state flipped twice a
  frame and every lit material re-derived its program (getParameters / cache key) each frame. FX materials are unlit,
  so they draw the same; those passes skip the shadow re-render.
- **Kit sky drawn last among opaques** (renderOrder 1000): depth test rejects the covered sky instead of shading the
  whole screen first.

Against the brief's budget: q2 "solid 60" is close but not solid on this iGPU at 1080p: 8-17 % of fight frames miss a
vsync in the worst-case close-up and over a whole fight (q1 4-7 %, q0 2.5 %, which is the headless RAF jitter floor). q1 is
comfortable, q0 has plenty of headroom (GPU about half of q1). The auto-tune (no `?q=`) steps down below 48 fps.
Not done (each would change the look; candidates for the owner): fewer real point lights on q2 (11 visible: 6 fire,
3 FX slots, 2 gate), GTAO samples 12 -> 8, dropping shadow casting on the tiny floor rubble (93 k triangles in the moon
shadow pass), a lower-res fire-field pass for near flames.

## 4. Production build and the "no falls on the hosted build" report

- **Found and fixed (hosted-only bug)**: the arena kit, its backdrop and sky, the FX atlases and the KTX2 transcoder were
  fetched from absolute `/arena/`, `/fx/`, `/basis/` URLs. That works on the dev server and at a domain root, but GitHub
  Pages serves the game from `/arena-gods/`, so all of them 404ed: **the hosted build has never shown the Moon Gate**
  (it falls back to the legacy dressing) and ran without FX atlases. They now use the Vite base like the models / audio /
  animation already did (`src/render/baseUrl.ts`). Checked by serving the build under `/arena-gods/` (Pages-style 404
  page): no 404s, no errors.
- **Falls: not reproduced.** Checked: (1) the bytes on https://dark-shadw.github.io/arena-gods/ are the `origin/main`
  (`b2e9309`) build exactly (`index-D2G_EjZB.js`, anim bins, models compared by hash; one JSON differs only in line
  endings); (2) that build (built locally, served under `/arena-gods/`) and **the live hosted URL itself**, played in
  headless Chromium: every knockdown / launch / get-up / death frame the sim emits is drawn with the sim-chosen library
  clip, and the hips drop to 0.09-0.12 m (a real fall; standing 0.85-1.11 m); (3) the same on the current build at the
  root and under the sub-path, stepped and real time (RAF, intro + fight), 2 seeds x 4 pairs; (4) `vite preview`
  (localhost:4173): 8 fights, all knockdown frames on library clips, hips 0.09-0.17 m, plus a real-time intro + fight
  (`preview_falls.json`, `preview_live.json`). What I could not check: the owner's own browser / GPU / cache. The one
  hosted-only difference I found is the missing Moon Gate / FX atlases above (the hosted fights ran in the old dressing
  with flat fallback FX), which may be what read as "different" there. Repro tool: `node tools/perf/prodcheck.cjs falls
  --remote=<url>` (or `--prefix=/arena-gods/` on a local `dist`).
- Prod build checked end to end: Moon Gate loads on every tier, entrances (validator 90 / 0), falls, a full fight with
  the finisher bundle streamed in the background, no console errors.

## Gates

| Gate | Result |
|---|---|
| `npm run build` | passes |
| `npm run fx:check` | all FX checks passed |
| `npm run sim:test -- 40` | sim untouched (`git diff 385df7e -- src/sim` empty): 0.0 % timeouts, 0/2240 kills without contact, determinism true (same seed + arena identical, different arena differs) |
| `npm run arena:budget` | PASS: low 30.95 / 64, **medium 103.35 / 128**, high 155.41 / 192 MB |
| Camera audit, standard list | **95.2 % readable** (floor 93.8), contact 95.6 %, cuts/min 22.7; colosseum matches 99.4 / 95.8 % (`camera_standard.json`) |
| Entrance validator, kit colosseum, 4 chunks | **90 configs, 0 failures** (`entrances.json`) |
| Legacy (`?arena=legacy` ref-3, ref-4, ref-6) | **pixel-identical** to `385df7e` (max difference 0) |
| Other kit themes (ref-4 .. ref-9) | **not pixel-identical, by design**: they share the kit props / pillars / statues whose normal maps were halved: PSNR 54-69 dB, at most 0.11 % of pixels move by more than 8 levels (ref-7 glacier the most). The render-path changes alone are pixel-identical there (abpixels, forge). Shared improvement: their downloads shrink the same way |

## Decisions made without the owner (please confirm)

1. **Half-size normals on the shared kit** (props, statues, pillars, rubble, banners) for every kit theme, not a Moon
   Gate-only copy (one set of files; other themes are rebuilt in A9-A17 anyway).
2. **Shader / texture warm-up before the intro**: the loading bar holds at about 90 % for 1-3 s while programs compile,
   instead of the intro freezing on its first frames.
3. **Dust / hit / explosion FX atlases load up front** (+0.7 MB first visit) so the first impact of a fight neither
   hitches nor shows a missing sprite.
4. **Finisher bundle streams in the background** (the fight is 60+ s long; `?t=` jumps wait for it).
5. Kept the look: no light-count, AO, shadow or fire-field quality cuts on q2 (see section 3 for the candidates).

## For the next agents (A9-A17)

- New theme art: run `npm run arena:assets` (caps in `tools/arena/tex_caps.json` apply to the full tier), check
  `node tools/perf/prodcheck.cjs net --q=1` and `live --skip=0` (compiles after the loading screen must stay at none).
- Any new hidden-until-used FX layer / pool: create it in `prewarm` paths (`vfx.prewarm`, `Arena.prewarm`) so it compiles
  behind the loading screen.
- Entrance / cinematic raycasts against arena meshes: use `anyHit` (`src/cinematic/losAccel.ts`).
- Pixel checks of render-path changes: `node tools/perf/abpixels.cjs`.
- To host for friends: merging `anim-plan` into `main` redeploys Pages (owner's call); the sub-path fix is required for
  the Moon Gate to appear there.
