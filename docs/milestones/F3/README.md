# F3: everyday combat FX, blood, full replay on seek

Branch `anim-plan`, 2026-10-18. Spec: `docs/fx-plan.md` (F3 row, §2.1, §2.3, §3.4, §3.7), catalog §1 (`docs/fx-catalog.md`, every row now carries its status). API: `docs/fx-api.md` ("F3 additions").

## What shipped

| Area | Files |
|---|---|
| Atlases in the game (moved from the F2 lab), tier-aware (`.low` files on q0), the Unity flipbooks as the default, own Blender bakes on demand | `src/render/fx/atlas.ts` (`tools/fxlab/fxAtlas.ts` re-exports it) |
| Textured stateless particles: flipbooks (sub-frame blend: motion vectors where the atlas has them and the tier is not low, else crossfade; emissive / lit3 / lit-fixed) and the 64 Kenney mask sprites; glow or occluding per particle in one draw; card / velocity streak / floor quad | `sprites.ts` |
| Weapon trails v2: per weapon class (axe, sword, claw lines, blunt smear, pierce, fire, shadow), 120 Hz sim-time samples, the same length at any frame rate, held during hit-stop, seeded streak noise per attack; air-distortion ribbon on heavy swings (high tier). `fighterView.Trail` removed | `ribbons.ts`, `fighterView.ts` (getters only), `vfx.ts` |
| Material impacts: `impact.<cut/blunt/pierce/fire/shadow>.<metal/flesh/fur/cloth>`, Hollowjack pulp, heavy core + ground shockwave (dust ring, chips, crack decal) | `fxDefs.ts`, `fxSurfaces.ts` |
| Block sparks, Aldric's shield ring, parry (anamorphic flare HDR 20, spark cone, ring distortion, CA, light), guard break, dodge skid dust + afterimage ghosts, knockdown / landing dust, footsteps by floor surface (dust, snow, wet, water) | `fxDefs.ts`, `afterimage.ts`, `fxDirector.ts` (stride ticks) |
| Blood (gore standard default; off / full): sprays (droplets on ballistic arcs, strands, spatter, mist), floor splats and drops where droplets land, pools under the dead and the badly hurt, wounds on the body, blood on blades | `fxDefs.ts` (`blood.*`), `wounds.ts`, `decals.ts` |
| Persistent floor decals (lit: colour + normal + roughness; blood glossy and darkening as it dries; cracks), seeded, capped per tier | `decals.ts` |
| FX light pool (3 / 2 / 1 slots by tier) | `lights.ts` |
| Arena braziers, torches and candles on the Unity Flame02 / Flame03 flipbooks (a 4-line hook in `Arena.flame()`; the arena keeps its lights and flicker) | `flames.ts`, `arenaView.ts` (hook), `main.ts` |
| Keg explosion: Unity Explosion00 fireball + Explosion01 smoke flipbooks; fire hits: a FireBall01 flipbook | `fxDefs.ts` |
| Kill (no finisher): the white ring is gone; flash, ripple, settling dust, blood burst + pool | `fxDefs.ts` |
| Full replay on seek | `fxDirector.ts` (`seek`), `main.ts` (`replayArenaDecals`) |
| Tests and tools | `tools/fxcheck.ts` (seek replay, gore), `tools/shots/f3probe.cjs` (moment filmstrips, browser seek check), `tools/shots/f3ab.cjs` (same-page GPU A/B), `tools/shots/postprobe.cjs` (F3 stress + FX CPU), `tools/shots/fxsheet.cjs` (`--abs`, `--gore`, `--look`) |
| FX Lab | `tools/fxlab/lab.ts`: group "F3 everyday combat" (trails per weapon, blood cut / three cuts + kill, metal, block, parry, knockdown, footsteps, dodge, pumpkin, arena flame); catalog rows C01-C20 open those previews; dummies get wounds and weapon blood |

### Blood: what replaced the F2 bakes

The F2 `blood_spray` and `splash` bakes read as gummy beads (metaballs) and are no longer used. Blood is built from Kenney masks plus procedural particles, lit by the scene's key light so it is neither black in daylight nor glowing at night:
- `circle_05` droplets on closed-form drag + gravity arcs; the director solves each droplet's landing time and drops a small floor decal there, at that time;
- `dirt_02` spatter (the burst), `trace_04` strands, `smoke_07` mist;
- the spray leaves the wound towards the attacker's side, swept along the swing and up (the side camera sees it);
- decals: 4 splats, drips, pool (growing over about 3 s), wet (roughness 0.1-0.2) and darkening over 40 s;
- wounds: up to 8 per fighter (4 on low), dark red, wet, noise-edged in the mesh's own space, on seeded bones;
- blades (Gorak, Aldric) get blood that grows towards the hilt with each cut.

Hollowjack never bleeds (pulp, seeds, orange chunks). Gore `off`: dark mist and fibres, no decals, no wounds (checked in `fx:check`). Gore `full`: about 1.7x droplets, larger splats and pools.

Contact sheets: `lab/f3.blood.cut[.off|.full].jpg`, `lab/f3.blood.three[.off|.full].jpg` (FX Lab, gorak's axe and aldric as dummies) and, in the game, `strips/gore_cut_flesh.jpg`, `strips/gore_claw_fur.jpg`, `strips/gore_kill.jpg` (rows: off / standard / full at the same moment).

### Full replay on seek (`fx.seek(t)`)

1. Persistent pass: the persistent layers (decals, blood-drop decals, wounds, weapon blood) of every event up to `t - 6 s`.
2. Tail pass: every effect of `(t - 6 s, t]` on recorded frames: events, attack-phase starts, continuous emitters, footsteps, projectile trails and impacts. 6 s = the longest tail (debris).
3. The game then warms up the last 1.5 s live as before. The arena's own canvas cracks / scorch are repainted from the events before `t` (`main.ts replayArenaDecals`).

What makes it exact: spawns happen at the sim time of their cause (not at the frame that noticed it); continuous emitters read the recorded state at each tick's own time; decals, wounds and blood drops are placed from recorded frame data, never from the animated bones; hashes and the decal ring are order-independent.

| Check | Result |
|---|---|
| `fx:check`, Node, 3 matches x 2 times x q2 / q0: play-through at 1/60 vs seek + warm-up | floor decals, wounds + weapon blood, live effect list and **full particle state identical** in all 12; long tails alive after the seek (e.g. 17 effects started before the warm-up in gorak-vex at 14 s) |
| `f3probe seek`, browser with bones, 2 fights x 2 times | two fresh `?t=` loads identical (full state, list, floor, blood); play-through vs seek: floor and blood identical (4/4) |
| Seek cost | about 360 director steps, 30-80 replayed events, 1.5-7 ms |

## Measurements

GPU timer queries (`EXT_disjoint_timer_query_webgl2`) on the Arc iGPU, headless Chromium 1920x1080, 3 fixed fights (colosseum gorak-erika, forge ozrel-maw, glacier aldric-vex), 120 frames per tier, builds interleaved before (F2 HEAD) / after / before / after (`perf/before_*`, `perf/after_*`). Stress = an explosion, a heavy hit, a cut with blood, metal sparks, a heavy shockwave, a block, a parry and a knockdown every 8 frames (plus a kill every 32). Medians of 6 runs per tier:

| Tier | GPU frame before -> after | FX pass (GPU) | distortion pass | FX CPU per fight frame (frame + update) | FX CPU, stress |
|---|---|---|---|---|---|
| High (q2) | 23.3 -> 23.1 ms | 0.07 ms (max run 0.29) | 0.08 ms | 0.04 -> **0.15 ms** | 0.23 ms |
| Medium (q1) | 18.2 -> 18.4 ms | 0.10 ms | 0 (no heavy distortion in these frames) | 0.04 -> **0.16 ms** | 0.24 ms |
| Low (q0, 0.75 scale) | 13.3 -> 11.9 ms | 0.06 ms | off | 0.04 -> **0.13 ms** | 0.20 ms |

Budgets (plan §2.6): 2.0 ms GPU and 0.6 ms CPU for FX in typical combat on high. The whole-frame totals move within the run-to-run noise (the scene pass of the same frame varies by several ms between runs, see F1); the FX pass itself stays under 0.3 ms and the FX CPU under 0.25 ms even in the stress run.

Same-page A/B (`tools/shots/f3ab.cjs`, frozen frame, 4 interleaved rounds, `perf/ab_q2.json`, `perf/ab_q0.json`): the two extra light-pool slots plus the decal batch add 0.0-0.6 ms to the scene pass (13.48 vs 13.00 ms colosseum, 15.68 vs 15.58 glacier on high) - inside the round-to-round spread (up to 2.5 ms), so not resolved better than "under about 0.5 ms".

Found and fixed while measuring: on low, the 19 arena flipbook flames of the colosseum cost 1.2 ms in the FX pass (blending the empty part of each card); a discard of empty texels brought it to 0.05 ms (q2 had been 0.02).

Counts seen: up to 218 floor decals by the end of a 69 s fight (cap 256 on high); 6-8 wounds per fighter after 30 s of a blade fight; 40-130 mask sprites live during an exchange.

## Screenshots and filmstrips

- `strips/<moment>.jpg`: the 11 fixed moments of `moments.txt` (cut on flesh, cut on metal, heavy hit, block on the shield, parry, dodge, knockdown, kill, claw on fur, blunt (Maw), Hollowjack), frames at +0.03 / 0.12 / 0.3 / 0.7 / 1.6 s after the event, F2 build above, F3 below, same seed and camera. `node tools/shots/f3probe.cjs strips --out=<dir> [--dist=] [--gore=]` re-shoots them.
- `strips/gore_*.jpg`: gore off / standard / full rows.
- `shots/<theme>.jpg`: the F1 fixed-camera frames (`postprobe.cjs --shots`), before / after, high and low, plain and with a spawned explosion + heavy hit + dodge.
- `lab/*.jpg`: FX Lab strips (neutral background, colosseum look) of every F3 lab item.

What the stills show (my reading): sprays are visible at the victim's chest within 0.1 s and leave splats and drops; wounds and axe blood read; trails are a white-silver sweep for the axe and sword (red lines for Vex's claws); impacts on Aldric's plate throw sparks and a short wisp; parries show the anamorphic flare; dodges leave fresnel ghosts; braziers keep their size and now flicker with the Unity flame; the old white blob of heavy hits and the flat white kill ring are gone.

## Deviations from the plan

1. **Footsteps from recorded motion, not FootLock.** A stride tick every 1.15 m while a fighter moves faster than 2.5 m/s, precomputed from the record; exact on seek, independent of `poseFx.ts` (the animation owner's file). Feet are not matched to the visual foot plant.
2. **Contacts on the body surface.** `contact` / `blockContact` / `parryContact` were 25-35 % of the way between the chests, which put every impact in mid-air when fighters stand 2-3 m apart (long weapons). They are now 0.24 / 0.42 / 0.5 m from the chest. This also moves the old F0 effects that use them.
3. **No ribbon texture.** The profile (hot edge, smoky body, claw lines) is drawn in the shader with `noise_a` streak noise; no Catmull-Rom resample (the 120 Hz samples are dense enough).
4. **Afterimages shipped in F3** (planned for F5) for dodges, as skinned clones with a fresnel material; tiers 0 / 1 / 3. Not reproducible across a seek (they copy the animated pose); the replay skips them.
5. **Camera shake and hit-stop stay in the camera director** (§3.6 needs the camera owner's agreement); defs carry `shake` but nothing reads it. FX already run on the FX clock during hit-stop (sparks slow, trails hold, lights keep fading in real time).
6. **The arena canvas decals stay** for the arena's own cracks and scorch (`arenaView.ts` is the arena session's); FX decals add blood, heavy-hit and quake cracks. Their crack shapes come from a stream that is not reset on seek, so after a seek they are in the right places but drawn differently.
7. **Blood is procedural**, not a re-bake: sprites + droplet physics looked better than any metaball bake and cost no Blender time. No Blender bake ran in F3.
8. **Low tier**: half the sprite counts, 64 decals, 1 light, no ghosts, no footsteps, no distortion, trails at half the samples without noise, `.low` atlases, crossfade instead of motion vectors.

## Known issues

- Not judged at play speed or on a real monitor: blood amount, wound coverage (fighters get very bloody after 30-60 s: 8 wounds is the cap), spark brightness, trail width, footstep frequency, ghost strength. The owner should play with gore standard and full.
- Footsteps happen only on runs (> 2.5 m/s); a stride does not line up with the visible foot.
- No footprints through pools, no drips (ST4), no hit pulse (C18), no Ward Pulse ripple (C09), no arrow ribbon or stuck arrows (C20).
- Claws get no hand blood (only blades do).
- The water splash bake is no longer used (droplets + mist instead); the `splash` and `blood_spray` atlases still ship (about 0.15 MB) and could be dropped.
- Wounds sit on seeded bones, not where the blade hit (the hit point is pose history, which a seek cannot reproduce).
- `finisherFx.ts` patches the same materials: the patches are chained (one program), but cloned finisher halves (bisect) drop the wound patch.
- The FX Lab's `f3.flame` sheet was rendered before the flame was moved out from behind the left dummy.
- While stopping the Vite dev server I stopped every `node` process whose command line mentioned `vite` (4 on the first stop); if the owner had a dev server running in `arena-play`, it was stopped too.

## What F4 / F5 need next

- **F4 (fire + environment):** `FxFlames` is the brazier entry point; add smoke wisps (Unity WispySmoke01 / CandleSmoke01 are loaded the same way), embers, the heat column per flame and the floor light-pool / reflection cards; move the arena's flame lights into the per-tier budget. The ring of fire and fire patches can be `sp` flipbook ops on `unity_flame02`. Mud / frost / footprint decals: `decals.ts` already has the cells.
- **F5 (skills):** `Afterimages.snap()` takes any snapshot time, so rush and Thousand Cuts trails are data; slash lines can be `sp` ops on `slash_0x` / `scratch_01` (floor or card); the trail profile can be swapped per move (`Ribbon.setProfile`).
- **F6:** `FighterBlood` is the place for status layers (it is the one fighter material patch); bleeding drips can reuse the `blood` op with `drops`.
- Decide with the camera owner whether `def.shake` feeds the director (§3.6).

## Owner decisions

1. Blood level: is gore `standard` the right amount (sprays, splats, pools, wounds that accumulate to 8)? `full` is about 1.7x.
2. Keep 3 FX light slots on high (under ~0.5 ms, not resolved in the noise) or drop to 2.
3. Drop the unused `blood_spray` / `splash` bakes from `public/fx`?

## Checks

- `npm run build`: passes.
- `npm run fx:check`: passes (90 defs; seek replay 12/12 identical; gore off has no blood).
- `npm run sim:test -- 40`: win rates 45.7-54.6 %, timeouts 0.0 %, kills without contact 0/2240, determinism true (identical to F2; `src/sim` untouched).
- Memory: one headless browser at a time; no Blender; the dev server ran only for the lab sheets and was stopped.
