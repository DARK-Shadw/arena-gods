# F2: FX asset pipeline, first atlases, FX Lab

Branch `anim-plan`, 2026-10-17. Spec: `docs/fx-plan.md` §4 and §3.9.
- Formats and commands: `docs/fx-pipeline.md`.
- Licences: `public/fx/CREDITS.md`.
- Runtime API used by the lab: `docs/fx-api.md` (F0).

## What shipped

| Area | Files |
|---|---|
| Blender bake scripts (headless, bpy, Blender 5.0.1) | `tools/fx/blender/`: `fxbake.py` (shared: args, dry run, peak-RAM log, free-RAM guard, node builder, EXR output), `bake_fire_loop.py`, `bake_fireball.py` (burst / explosion, Mantaflow path + procedural fallback), `bake_smoke_wisp.py`, `bake_dust.py` (puff / ring), `bake_liquid.py` (splash / blood), `bake_embers.py`, `bake_energy.py`; `tools/fx/bake_all.sh` runs them one at a time and retries once after 30 s |
| Atlas pipeline | `tools/fx/pack_atlas.py` (EXR → premultiplied sRGB WebP atlases, low tier, optical-flow motion vectors, manifest), `ingest_packs.py`, `make_decals.py`, `encode_ktx2.mjs`, `check_budget.mjs`, `write_credits.py`, `contact_sheets.py`, `fxlib.py` |
| Shipped assets | `public/fx/`: 23 atlases (46 images), `atlas.json` (manifest), `credits.json` (ledger), `CREDITS.md` |
| FX Lab | `tools/fxlab/` (`index.html`, `lab.ts`, `fxAtlas.ts` = reference atlas loader + flipbook shader); `tools/shots/fxsheet.cjs` (contact strips per effect) |
| Docs | `docs/fx-pipeline.md` (new), this README, sheets in `sheets/` and `lab/`, `docs/BACKLOG.md` updated |

**Totals:**
- **Download: 4.27 MB** of the 6 MB budget, all 50 files in `public/fx`; `dist/fx` is 4.4 MB.
- **Estimated GPU memory, high:** 45.0 MB of 48 MB. This counts the core set plus the largest on-demand ("alt") atlas.
- **Estimated GPU memory, low:** 11.7 MB of 24 MB.
- `node tools/fx/check_budget.mjs` passes.

**Format:** WebP only. `toktx` is not installed; `encode_ktx2.mjs` detects that and writes `format: webp` and the reason into the manifest.

## Atlases

The **set** column:
- `core` atlases are loaded at session start and count against the GPU budget.
- `alt` atlases are shipped but loaded on demand. They are kept for comparison in the FX Lab and for the F8 magic work.

| id | set | source | grid | full size | KB (all tiers) | loop | sheet |
|---|---|---|---|---|---|---|---|
| unity_flame02 | core | Unity Labs Flame02 | 16x4 (64x128 cells) | 1024x512 | 263 | yes | `sheets/unity_flame02.jpg` |
| unity_flame03 | core | Unity Labs Flame03 | 16x4 (64x128) | 1024x512 | 261 | yes | `sheets/unity_flame03.jpg` |
| unity_fireball01 | core | Unity Labs FireBall01 (RGB, additive) | 8x8 | 512x512 | 65 | yes | `sheets/unity_fireball01.jpg` |
| unity_explosion00 | core | Unity Labs Explosion00 | 5x5 | 765x765 | 161 | - | `sheets/unity_explosion00.jpg` |
| unity_explosion01_nofire | core | Unity Labs Explosion01-nofire (smoke / dust plume) | 5x5 | 765x765 | 150 | - | `sheets/unity_explosion01_nofire.jpg` |
| unity_wispysmoke01 | core | Unity Labs WispySmoke01 | 8x8 | 768x768 | 257 | yes | `sheets/unity_wispysmoke01.jpg` |
| unity_candlesmoke01 | core | Unity Labs CandleSmoke01 | 20x4 (51x128) | 1020x512 | 176 | yes | `sheets/unity_candlesmoke01.jpg` |
| unity_cloud01 | core | Unity Labs Cloud01 (fog cards) | 8x8 | 512x512 | 140 | yes | `sheets/unity_cloud01.jpg` |
| unity_smallflame01 | alt | Unity Labs SmallFlame01 | 16x4 | 1024x512 | 315 | yes | `sheets/unity_smallflame01.jpg` |
| dust_puff | core | own bake (procedural volume, 3-light relightable) | 6x6 | 768 | 148 | - | `sheets/dust_puff.jpg` |
| dust_ring | core | own bake (procedural volume, 3-light) | 6x6 | 768 | 248 | - | `sheets/dust_ring.jpg` |
| splash | core | own bake (metaball particles) | 6x6 | 576 | 89 | - | `sheets/splash.jpg` |
| blood_spray | core | own bake (metaball particles) | 4x4 | 512 | 63 | - | `sheets/blood_spray.jpg` |
| embers | core | own bake (emissive spheres + motion blur) | 6x6 | 576 | 48 | yes | `sheets/embers.jpg` |
| fire_loop | alt | own bake (procedural volume, seamless, + MV) | 8x8 | 1024 | 290 | yes | `sheets/fire_loop.jpg` |
| fire_burst | alt | own bake | 6x6 | 768 | 148 | - | `sheets/fire_burst.jpg` |
| explosion | alt | own bake (method B) | 8x8 | 1024 | 241 | - | `sheets/explosion.jpg` |
| smoke_wisp | alt | own bake (3-light relightable, seamless, + MV) | 8x8 | 1024 | 288 | yes | `sheets/smoke_wisp.jpg` |
| energy_swirl | alt | own bake (for F8 magic) | 8x8 | 1024 | 162 | yes | `sheets/energy_swirl.jpg` |
| fx_sprites | core | Kenney Particle Pack, 64 masks channel-packed | 4x4 x RGBA | 768 | 272 | | `sheets/fx_sprites.jpg` |
| noise_a, noise_b | core | Screaming Brain noise, 8 tileable noises | RGBA | 256 | 245 | | `sheets/noise_a.jpg`, `sheets/noise_b.jpg` |
| decals | core | procedural (+ SBS cracks): blood splats x4, pool, drips, scorch x3, cracks x4, frost, mud, wet footprint | 4x4 | 768 + 512 normal/rough | 271 | | `sheets/decals.jpg` |

The contact sheets show 8 frames each:
- the top row over a "dark arena" background;
- the bottom row over a "torchlight" background.

They are decoded from the shipped WebP files, so compression artefacts are visible.

### Bake log (Blender 5.0.1, EEVEE, 256-px frames, one process at a time)

| bake | frames | seconds | peak RAM |
|---|---|---|---|
| fire_loop | 64 | 69 | 1402 MB |
| fire_burst | 36 | 55 | 1385 MB |
| explosion | 64 | 84 | 1368 MB |
| smoke_wisp | 64 x 3 light passes | 287 | 1396 MB |
| dust_puff | 36 x 3 | 157 | 1372 MB |
| dust_ring | 36 x 3 | 94 | 1418 MB |
| splash | 36 | 23 | 1197 MB |
| blood_spray | 16 | 10 | 1165 MB |
| embers | 36 | 18 | 1157 MB |
| energy_swirl | 64 | 45 | 1396 MB |

**Command:** `bash tools/fx/bake_all.sh`, then:
- `python -P tools/fx/pack_atlas.py`
- `python -P tools/fx/ingest_packs.py`
- `python -P tools/fx/make_decals.py`
- `node tools/fx/encode_ktx2.mjs`
- `python -P tools/fx/write_credits.py`
- `node tools/fx/check_budget.mjs`
- `python -P tools/fx/contact_sheets.py`

The full sequence takes about 20 minutes. The system never fell below 5.7 GB of free RAM.

**Mantaflow in 5.0.1:**
- The dry run passes: the FLUID modifier and `fluid.bake_all` work headless, with a 3-frame bake in under 1 s at 187 MB.
- `quick_smoke()` is broken in background mode: it gives the emitter no Fluid modifier. The script sets up the domain and flow by hand.
- The untuned Mantaflow plume read as a thin column, so explosions default to the procedural method B. `--method mantaflow` keeps A.

## Packs

| Pack | Location | Status |
|---|---|---|
| Unity Labs flipbooks (22 zips) | `Assets\fx\` | All 22 inspected (grid, frame size, alpha mode, wrap test: `atlas.json` → `packs`). 9 shipped (table above), 13 not shipped, see below. |
| Kenney Particle Pack | `Assets\VFX\` | Ingested, 64 of 80 sprites; `License.txt` says CC0. |
| Screaming Brain noise (512, 128) | `Assets\VFX\` | 512 ingested (8 noises + 4 crack sources for decals); the 128 zip is unused; `License.txt` says CC0. |
| ambientCG decals | — | Not used, per the owner (road markings only). All decals are procedural. |
| CGHEVEN | — | Not downloaded. It needs the owner's licence decision (plan §6 Q3). |

**Unity packs not shipped** (strip: `sheets/unity_not_shipped.jpg`):

| Packs | Reason |
|---|---|
| Explosion01, Explosion02 | near-duplicates of Explosion00 |
| Explosion01-light-nofire | near-duplicate of Explosion01-nofire |
| **Explosion02HD** | 2048² source (16.8 MB TGA). It is only worth shipping with KTX2: at the WebP budget it would shrink to the same 1024² as Explosion02. |
| FireBall02, FireBall03 | variants of FireBall01 |
| Flame03-hollow | variant of Flame03 |
| SmallFlame01-mini, SmallFlame01-smaller | variants of SmallFlame01 |
| Cloud02 | variant of Cloud01 |
| WispySmoke02, WispySmoke03, WispySmoke03b | variants of WispySmoke01 |

`ingest_packs.py --ship-all` ships them all, at the cost of the budget.

**Unity format facts (the plan listed them as unknown):**
- Each zip holds `<Pack>_<C>x<R>.tga` (8-bit sRGB) plus a linear `.exr`. Fire packs also have a `-temperature` EXR, which is unused.
- Grids are 5x5, 8x8, 16x4 or 20x4.
- Cells are not always square or a whole number of pixels: CandleSmoke01 is 51.2 x 128 px.
- Alpha is straight. SmallFlame01-smaller is premultiplied, and the FireBall packs and Flame03-hollow are RGB on black.
- All packs were converted to premultiplied.

**Licences:** CC0 for every shipped file. The licence of each Unity pack was checked only against the Unity blog page cited in `docs/fx-research.md` (CC0 [V]); the zips contain no licence file. I did not re-open the page in this session.

## FX Lab (`npm run dev` → `/tools/fxlab/`)

**What it lists:**
- every F0 FxDef, spawned standalone through `createFxDirector` (the API in `docs/fx-api.md`);
- every atlas: flipbooks as camera-facing cards drawn by the reference shader in `fxAtlas.ts`, with motion-vector blending, lit3 relighting, tint and premultiplied blending; sprites, noise and decals as flat sheets;
- a brazier composite (Flame02 + CandleSmoke01 + embers + a flickering light);
- every row of `docs/fx-catalog.md`, mapped to its nearest current preview. Rows that are not built yet are grey.

**Controls:**
- seed;
- time scrub (frame-exact, because everything is a function of seed and t), step ±1/60 s, slow motion down to 0.05x, and loop;
- quality q0/q1/q2 (FX tier caps, low/full atlases, motion vectors off on q0);
- gore, which defaults to `GORE_DEFAULT` ('standard') and accepts `?gore=`. The lab does not persist its choice, so it never changes the game's saved `arena.gore.v2`;
- light presets: dark arena, torchlight, neutral;
- dummies (gorak, aldric) and brazier toggles;
- a screenshot button (S).

**Readout:** live particles against caps, effects, pending layers, rings, debris, draw calls, triangles, frame ms, render CPU ms, FX CPU ms (`fxProfiler`), atlas format used and estimated atlas GPU MB.

**Automation:** `window.__fxlab` provides `list`, `play`, `at`, `stats`, `sheet`, `shot` and `durationOf`. `node tools/shots/fxsheet.cjs <out> --port=5173` writes one strip per item.

**Verified headless:**
- All 135 items with a preview played and rendered with no page errors; the only console error is a 404 for the favicon, now fixed. Report: `lab/fxsheet-report.json`.
- Strips: `lab/*.jpg` (brazier, E01, E07, C03, parry, decals, dust ring, smoke wisp, Unity explosion).
- At most 41 draw calls in the lab scene.

**Integration TODOs (marked in the code):**
- `fxAtlas.ts` moves to `src/render/fx/atlas.ts`, and a `flipbook` op kind in the F0 director replaces the lab's own cards (F3).
- The lab has no bloom or grade yet, so cores look less hot than they will in game.

## Checks

- `npm run build`: passes.
- `npm run sim:test -- 40`:
  - overall win rates 45.7–54.6% (all inside 45–55%);
  - timeouts 0.0%;
  - kills without contact 0/2240;
  - determinism true.

  F2 touches nothing in `src/`.
- `check_budget.mjs`: passes. `encode_ktx2.mjs`: reports "toktx not found → WebP only".

## Deviations from the plan

1. **WebP only, so frames are 128 px, not 256 px.** A 2048² atlas would cost 21 MB of VRAM as RGBA8, so the plan's 48 MB budget only fits 256-px frames with KTX2. The rule is:
   - full tier = 128-px frames;
   - low tier = 64-px frames;
   - sprites and decals are authored at 256 and shipped at 192;
   - embers and splash at 96.

   `pack_atlas.py --hires` together with `encode_ktx2.mjs` produces the plan's sizes once `toktx` is installed.
2. **Core and alt sets.** With 9 Unity atlases on top of the plan's list, the GPU budget only fits if some atlases load on demand.
   - The Unity sequences are clearly more realistic than my bakes, so they took the core slots for fire, explosion, fireball and smoke.
   - My fire_loop, explosion, fire_burst and smoke_wisp ship as `alt`, for comparison in the lab. They keep two features the Unity files lack: a seamless loop with motion vectors, and lit3 relighting.
3. **Explosion and fire_burst smoke are lit by a fixed key**, not by 3 light passes like smoke_wisp and dust.
4. **Motion vectors are computed, not rendered.** They come from OpenCV optical flow on the packed frames, because volumes have no Blender vector pass. They ship for fire_loop and smoke_wisp only.
5. **`python -P` instead of `python -I`**, because `-I` hides the user site-packages where opencv is installed. `-P` still keeps the cwd and script folder off `sys.path`.
6. **The runtime loader and flipbook shader are not in `src/`.** `atlas.ts` is in the plan's F2 list, but this session may not edit `src/`, so it lives in `tools/fxlab/fxAtlas.ts`.
7. **16 decal cells instead of the planned ~22.** There are 4 blood splats instead of 8, and the crack cells come from SBS noise rather than ambientCG.

## Known issues and what I could not judge

- **Not judged by eye at play speed or on a real monitor:** realism, bloom balance, motion quality of the flipbooks, fps choices. I looked at the contact sheets and the headless lab strips only.
- **My own bakes:**
  - The splash reads as beads (metaball look), not a water sheet.
  - The blood spray is gummy.
  - The dust ring is lumpy but still fairly regular.
  - The energy swirl is a plausible plasma ring.
  - Dust puff and embers look fine.
  - Fire and smoke are serviceable but clearly behind Unity's.
- **Unity data:** fps values are guesses (16–30). Loop flags come from a wrap test (score < 1.6); none of the flames is a perfectly seamless loop.
- **The lab's GPU MB readout counts every texture tier loaded during a session.** It is not the game figure; use `check_budget.mjs` for that.
- **The game does not load any FX atlas yet.** That happens in F3.
- **KTX2 decode on the Arc driver is untested,** because `toktx` is missing.

## Owner decisions

1. Install KTX-Software `toktx`, or accept WebP only. KTX2 would allow 256-px frames and Explosion02HD within the same budget.
2. Confirm the core picks: Unity Flame02 for the brazier, Explosion00 for the keg, WispySmoke01 and CandleSmoke01 for smoke. The own bakes are a click away in the lab.
3. Decide whether to keep the own splash and blood bakes or replace them, for example with a fluid-sim hero bake later or a licensed pack.
4. CGHEVEN (custom licence) is still undecided.
