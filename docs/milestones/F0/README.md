# Milestone F0: FX foundation

Branch `anim-plan`. Spec: `docs/fx-plan.md` §5 (F0), §3.1–3.5. API for the FX Lab and later milestones: `docs/fx-api.md`.

This milestone does not restyle anything. The goal was the same effects on a foundation that is reproducible, leak-free and data-driven.

## What changed

- **New `src/render/fx/`:**
  - `fxDirector.ts`: the director, fed by the sim event stream.
  - `fxDefs.ts`: data tables `DEFS`, `RESOLVE`, `ON_ACTIVE` and `CONTINUOUS`, with 57 effects.
  - `legacyVfx.ts`: the FX core plus the old `VFX` API.
  - `particles.ts`: stateless GPU particles.
  - `fxRng.ts`, `fxClock.ts`, `fxSettings.ts`, `profiler.ts`, `index.ts`.
- **`main.ts`:**
  - Added a single hook, `fx.frame({events, frame, simT, simDt})`, called before `handleEvents`.
  - Added `fx.update(fxDt, realDt)`, `fx.takePost()` and `fx.seek()`, which `debugSeekFight` now calls.
  - Removed about 70 literal `vfx.*` calls from `handleEvents`, `arenaFx`, `continuousFx`, `updateProjectiles` and `onActiveStart`. Their numbers now live in `fxDefs.ts`, unchanged. The toasts, `onHit`, finisher geometry and audio stay in `main.ts`.
  - Added `__arena.fxStats()`, `fxHash()` and `fxStateHash()`, plus an `fx` line in the debug overlay.
- **`vfx.ts`:** keeps `Trail` and `Telegraph` and re-exports `VFX`. `finisherFx.ts`, `entrance.ts` and `tools/animlab` work through the unchanged facade.
- **Particles:**
  - One instanced quad per particle. Position is the closed-form solution of the old drag and gravity integrator.
  - Uploads happen only for bursts, through update ranges; the old code re-uploaded about 144 KB every frame.
  - Each layer is hidden once everything in it has expired.
  - Sparks are slightly velocity-stretched (0.012 s), the one deliberate "slightly better dot".
- **Determinism:**
  - Every random number now comes from `hash(matchSeed, event index | (fighter, attackId) | (emitter, tick), effect id, layer)`.
  - Continuous emitters tick at fixed sim-time rates instead of `Math.random() < p·rate` per frame, so they are also frame-rate independent.
  - Knockdown dust is a layer delayed by 0.15 s on the FX clock; it used to be `setTimeout(150)`.
  - The telegraph and aura pulses use sim time; they used `performance.now()`.
  - Finisher FX and entrance FX draw from `vfx.rand()`, a seeded stream. The portcullis `setTimeout` became a timeline cue.
  - The grep gate on `src/render/fx` is clean.
- **Leaks fixed:**
  - Shockwave rings now use a pool of 24 meshes with one shared geometry; before, each call allocated a material and never disposed it.
  - `debrisBurst` now uses one `InstancedMesh` with analytic bounces; before, it created a box geometry per piece and a material per burst and never disposed either.
  - `arrow` uses a pool.
  - Projectile meshes share one geometry and one material per kind; before, each projectile allocated new ones.
- **Gore:** the code moved to `fxSettings.ts` and `finisherFx` re-exports it. **The default is still `off` and the key is unchanged.**
- **Fixed in passing:**
  - Dust ignored its height, so the chandelier and gate-top dust spawned on the floor.
  - Particle size was in pixels, so particles shrank on HiDPI and 4K screens. Size is now in world units, calibrated to look the same as before on a 1080 px framebuffer.
  - `debugSeekFight` never cleared live FX or finisher pieces.
  - Post kicks now take the max of the current value and the new one. Before, they were assigned, so a weak kick could cut a strong one short.
- **Tests:**
  - `npm run fx:check` (Node, no GPU): every def spawns; same seed and time give the same state in two directors; stepping and scrubbing give the same state; different seeds differ; everything expires; `clear()` empties everything; the grep gate passes.
  - `tools/shots/fxprobe.cjs`: perf, counts, leak, seek and screenshots. It works against both the old and the new build (`--dist`, `--only=bench|shots`).

## Measurements (headless Chromium, Intel Arc iGPU, 1920×1080, q=2)

Blender was rendering on the same GPU throughout (another agent), so **GPU frame times are noisy and indicative only**.

| | before (old CPU pools) | after (F0) |
|---|---|---|
| FX CPU per fight frame (emission + update + director), 600 frames | 0.017–0.019 ms | 0.042–0.051 ms (director resolution included; old emission was partly counted inside `handleEvents`) |
| FX `update()` with nothing alive | 0.008–0.027 ms (4500-slot loop) | 0.0007–0.003 ms |
| Peak live particles (10 s of fight) | add 52–88, alpha 40–45 | add 52–88, alpha 39–58 (same effects) |
| Per-frame attribute upload | 4 attributes × 4500 slots, always | only the slots written this frame |
| `bench(120)` at t=20, interleaved old/new/old/new runs | 46.6/38.8/42.3, then 35.8/27.7/27.4 ms | 32.5/31.2/40.7, then 22.3/18.1/30.3 ms |
| Leak test (40 × shockwave + debrisBurst, then 8 s) | geometries +400 (213→615, 105→507, 281→681) | geometries +0..2 (212→214, 103→103, 282→282) |
| FX draw calls | 2 + one per live ring, arrow and debris piece | 2 particle layers + live rings + 1 debris draw |

Draw-call totals per frame differ between runs by ±60. That comes from the camera director's random shot choice, not from FX: hiding the FX group changes the count by about 2.

**Seek reproducibility** (`?t=` fresh load, twice, at the first heavy-hit moment):

| fight | before | after |
|---|---|---|
| gorak–erika | state differs | effect list **and** full particle state identical (54 + 10 particles) |
| ozrel–maw | (nothing live) | identical (42 + 50 particles, 1 ring) |
| aldric–vex | state differs | identical (41 particles) |

In the same session (seek, play elsewhere, seek back to the same t), the effect list was identical in 13 of 14 moments. The full particle state was identical in 6 of 14. The remaining differences come from outside FX:
- **Pose history.** Spawn positions come from the fighters' animated bones, whose state (inertialization, springs) carries history across a seek.
- **Camera director.** Once, its hit-stop and slow-mo timing in the warm-up window differed, because of the director's unseeded shot state.

A fresh `?t=` load is exact.

**Sim:** `npm run sim:test -- 40` is byte-identical to the pre-F0 run except for wall time:
- win rates 45.7–54.6%;
- 0 timeouts;
- 0/2240 kills without contact;
- determinism true.

**Screenshots:** `shots/*_before.jpg` / `*_after.jpg` were taken with the same fixed side camera at the same sim times. Looking at them, the effects read the same. Sparks are thin streaks instead of dots, and the flash, dust and rings match. The glacier parry shot is blocked by a crystal: the side camera is not occlusion-aware. I have **not** judged the effects at real frame rates.

## Deviations from the plan

- **`fx.seek(t)` does not re-spawn effects from `[t − 4 s, t − 1.5 s]`.** It clears and reseeds at the start of the existing 1.5 s warm-up window, and the warm-up re-spawns that window's effects with their original seeds. Long tails that began earlier are not rebuilt: smoke and embers up to 2.5 s, debris up to 6 s. The stateless pieces (`spawnDef` with a past `t0`) are in place. True replay needs positions from frame data instead of the animated bones, which belongs with F3, when impacts are anchored to sim contact data.
- **The event blocks moved into defs in F0, not F3.** The task asked for the director to be fed by the event stream with data-defined effects. The numbers are unchanged.
- **Tier counts are not scaled (`countScale` is 1 on every tier).** Only the ring capacity changes with quality, to keep the visuals unchanged.
- **The impact light stays a single light,** now stateless on a real-dt clock. The 3-slot light pool is F3.
- **Trails are unchanged** and still frame-rate dependent. They belong to the F3 ribbons.

## Known issues

- There is no floor bounce for falling particles: they rest on the floor. The old CPU pool bounced them at 30%.
- Particles at large FOV changes now keep their world size. Before, they kept their pixel size, so the cut-in close-ups show bigger sparks than before (physically right).
- `Box3.setFromObject` per frame in `finisherFx` tasks is untouched (F7).

## What F1 needs next

- A `ScenePass` with a `DepthTexture` and a linear-depth copy, plus FX layers 20–23. Particles are already on their own meshes (`fx.particles.add`, `fx.particles.alpha`); give them `layers.set(FX_ADD/FX_ALPHA)` and a soft-depth uniform in `particles.ts` (`FRAG`).
- Premultiplied "additive-alpha" blending and the HDR scale convention: change it in `particles.ts`, one material per layer.
- New op kinds (flipbook, ribbon, decal, card, distortion, light): add them to `FxOp` in `fxDefs.ts` and one `case` each in `FxDirector.runLayer`.
- The F2 atlas loader (`tools/fxlab/fxAtlas.ts`) moves to `src/render/fx/atlas.ts`.
