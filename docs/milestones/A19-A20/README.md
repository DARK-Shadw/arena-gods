# A19-A20 (F4): Moon Gate fire and environment FX

Branch `anim-plan`, 2026-10-19. Scope: the Moon Gate (theme `colosseum`, kit mode) only. Everything new is switched on by
`ThemeArt.fire` (only `COLOSSEUM_ART` has it) or by the FX variant `moongate` that the game reports only when that art
is loaded. `src/sim` is untouched. Legacy (`?arena=legacy`) and the other six kit themes are pixel-identical.

## What changed

| Part | What | Files |
|---|---|---|
| **Fire field** (new) | Every Moon Gate fire (pedestal bowls, tripods, wall / tier braziers, burning floor debris, the fire cage, oil pools, fire jets) is drawn by one layered, stateless GPU system instead of one F3 flipbook card per flame. Per fire: **glow halo** (procedural additive haze), **wide body**, **white-hot core**, **two side licks** with their own phase and lean, a **tall back lick** (Unity Flame02 atlas, already loaded by F3); **smoke** (WispySmoke01 puffs that rise, slow, grow and drift downwind, warm-lit at the base by the fire, grey above); **embers** (seeded spark cycles, some skipped, some "pops", drag, curl, wind drift, yellow-white cooling to red, velocity-stretched); **heat shimmer** columns on the F1 distortion pass (high tier, fires within 32 m). Flames are world-space cylindrical cards, so they stay upright in the planar floor reflection. One data texture (2 texels per fire) is the only per-frame upload; 4 draw calls in total | new `src/render/fx/fireField.ts`, `arenaView.ts` (`fieldFlame`, `updateFire`) |
| **Seeded flicker + fire clock** | Each fire flickers with seeded value noise (slow breathing, tremble, gust dips) on the **fire clock**: match time during a fight (a replay / seek shows the same flicker), plus real time while the match clock stands still (hit-stop, pause), arena time in menus and cinematics. The flicker drives the flame height, the real fire lights, the stage-light fire pools on stone and the floor light map / streak cards (weighted to the fires nearest the camera) | `fireField.ts` (`fireFlicker`), `arenaView.ts` |
| **Real fire lights per tier** | 2 / 4 / 6 PointLights (q0 / q1 / q2; was 7 on every tier); the stage-light loop lights the stone round the rest. Lights hang off the arena root and follow their fire, so a fire jet firing or an oil pool dying dims a light instead of changing the scene's light count (that was a full shader recompile hitch each time) | `arenaView.ts`, `art/colosseum.ts` (`fire.lights`) |
| **Wind** | A seeded gusting night wind (base direction + slow wander + gusts): flames lean, smoke and embers drift, banners / swags sway faster and wider in gusts (sway clock warp + amplitude), chains swing wider (opt-in `uSwayWind` in the chain shader: other themes compile the old source) | `fireField.ts` (`fireWind`), `arenaView.ts`, `chains.ts`, `dressKit.ts` |
| **Burning-oil pools** | A tipped brazier's spill is a near-black glossy pool with a moving net of burning tongues (procedural) and five low wide fires spread over it (one with a light), smoke and embers; fades with the sim's fire life | `arenaView.ts` (`addOilFireField`, `burningOilMat`) |
| **Fire-jet vents** | Sputtering tongues while the vent glows, a roaring ~5 m column of stacked flames with fast embers, dark smoke and heat when it fires (ramps up over 0.18 s); the old plume cylinder is hidden on the Moon Gate | `arenaView.ts` (flamejet) |
| **Lightning** | The sky's existing seeded lightning now lights the arena: a cold wash from the strike's side on every stage-lit stone material plus a brief rim boost, and a pulse of the moon key (fighters) | `stageLight.ts` (`setFlash`), `arenaView.ts` |
| **Destruction dust, debris, splashes** (A20) | FX theme variants `<id>@moongate` (the director swaps them in only for the Moon Gate): cold grey stone-dust rings that roll along the floor, billowing puffs, hanging dust plumes (the Unity plume flipbook as a slow cloud), grit and chips for topple start / impact, cover hits, prop / barricade breaks, floor collapse, the crumble warning; the falling fire cage scatters burning coals, sparks, smoke and a flash of fire light; oil ignition whooshes (fireball flipbook, sparks, light, heat); vents spit sparks and smoke. **Splashes**: a body hitting the floor (knockdown, launch landing) in a puddle throws a droplet crown + spray mist (`splash.body`), on wet stone a low spray; **footsteps** on the Moon Gate now ask the wet floor (`surfaceAt`) so runs through puddles splash (`step.water` / `step.wet`, F3 rows that never fired on the kit floor) | `fxDefs.ts`, `fxDirector.ts` (`FxWorld.variant`, `ResolveCtx.floorOf`), `main.ts` (fxWorld) |
| Checks | `fx:check` replays a fourth fight with the `moongate` variant and a wet / puddle floor on q2 and q0 (seek identical), and checks every variant row has a base def | `tools/fxcheck.ts` |
| Debug | concept view `fire` (close look at the south stair bowl); `arena.fire.enabled` for A/B | `conceptCams.ts` |

## Sheets

- `sheets/ref3_before_after.jpg`: ref-3 | A18 | A19-A20, ref-3 preset, q1.
- `sheets/gate_tiers_before_after.jpg`: the stair / gate view before | after on q0, q1, q2 (fire reads on every tier: the same cards, fewer smoke puffs / embers on low).
- `sheets/fire_closeup_tiers.jpg`: the new `fire` view (south stair bowl) on q0 | q1 | q2.
- `sheets/views_before_after.jpg`: tiers, west gate, overview views before | after (q1).
- `sheets/motion_fire_0.07s.jpg`: 8 frames 0.067 s apart (fire view, q1); `sheets/motion_gate_0.67s.jpg`: 8 frames 0.67 s apart (gate view): flames change shape, smoke rises and drifts, no popping between frames.
- `sheets/jet_oil.jpg`: a fire jet firing and a burning-oil pool, forced on in the gate view (q2).
- `sheets/lightning.jpg`: the same frame without / with a lightning strike (`?skyflash=40.02`).

## Gates

| Gate | Result |
|---|---|
| `npm run build` | passes |
| `npm run fx:check` | all FX checks passed (now 4 fights x 2 times x q2 / q0 seek-identical, incl. the `moongate` variants on a wet / puddle floor) |
| `npm run sim:test -- 40` | sim untouched (`git diff f642b20 -- src/sim` empty): 0.0 % timeouts, 0/2240 kills without contact, determinism true (same seed + arena identical, different arena differs) |
| `npm run arena:budget` | PASS, unchanged: low 30.95 / 64, **medium 127.35 / 128**, high 179.41 / 192 MB (no new textures; the fire field reuses FX atlases F3 already ships, and its data texture is 128 x 2 RGBA32F = 4 KB) |
| Entrance validator, kit colosseum, 5 layouts x 2 gates x 8 fighters (4 chunks) | **90 configs, 0 failures** (`entrances.json`) |
| Camera audit, standard list | **95.3 % readable** (A18 95.5, floor 93.8), contact 96.6 %, cuts/min 22.1; colosseum matches 98.4 / 96.1 % (camera code untouched: run-to-run noise) (`camera_standard.json`) |
| Legacy (`?arena=legacy` ref-3, ref-4, ref-6) and other kit themes (ref-4 .. ref-9) | **pixel-identical** to `f642b20` (frames + sky-geo + sky-only masks, 27 images, max difference 0; baseline = a copy of the `f642b20` dist) |

## Perf (GPU timer queries, same page A/B)

The `gate` view (38 live fires in frame or near it, stair bowls close), 1920 x 1080, headless Chromium on the Arc iGPU;
blocks of 12 frames alternating fire field on / off (`arena.fire.enabled`), 14 rounds, median of the paired differences:

| Tier | FX pass (fire field) | Distortion pass (heat) | Reflection pass | Whole frame (on / off, paired diff) | Draw calls | Real lights |
|---|---|---|---|---|---|---|
| q2 | **+0.14 ms** | +0.03 ms | +0.02 ms | 9.20 / 9.46 ms, +0.16 | +4 | 6 (+1 oil light held at 0) |
| q1 | **+0.12 ms** | - | +0.03 ms | 7.51 / 7.23 ms, +0.37 | +3 | 4 (+2 gate lights) |
| q0 | **+0.11 ms** | - | - | 4.86 / 4.26 ms, +0.02 | +3 | 2 (+2 gate lights) |

The fire field's own cost is the FX pass delta (about 0.1-0.15 ms); whole-frame deltas sit inside the clock noise of this
iGPU (blocks differ by up to 0.5 ms either way). The F3 flipbook cards it replaces cost about 0.02-0.05 ms (F3 README), so
the net is about +0.1 ms. Fewer real lights on q0 / q1 (2 / 4 instead of 7) make the scene shading cheaper there (not
isolated). CPU: `updateFire` (55 fires: flicker, wind, light follow, data texture) 0.046 ms per frame. Not measured: a
frame with a firing jet + a burning oil pool close to the camera (more overdraw from the tall column).

## Decisions made without the owner (please confirm)

1. **One fire field for the Moon Gate** instead of extending F3's per-flame card (`FxFlames` stays for every other theme
   and legacy, so they are unchanged). Other themes can switch over by adding `fire` to their ThemeArt.
2. **Real fire lights 2 / 4 / 6** per tier (plan: 4 / 2 / 1 for braziers; the old code had 7 on every tier). The stair
   bowls take them first (dressing order); the central tripod / jets / oil get one only when the budget allows.
3. **Fire clock = match time** in a fight (seek-stable flicker), but fires keep burning on real time through hit-stop /
   pause; the clock jumps from arena time to match time when the fight starts (a one-frame change in every flame's shape,
   during the handover blend).
4. **Wind** blows toward azimuth 150 deg with 0.55 base and 60 % gusts; banners, swags and chains follow it on the Moon
   Gate only. Ambient embers (`embersFine`) and ground mist do not follow the wind (their shaders integrate a constant
   velocity; changing it would make them jump).
5. **Smoke** is light grey-lavender and warm at the base (dark smoke disappeared against the night); fire jets get dark smoke.
6. **Theme variants** (`<id>@moongate`) for destruction / fire / splash FX instead of changing the shared rows: other
   themes keep their F0 / F3 dust. They could take the stone-dust rows later.
7. **No new textures, no Blender job**: the field uses atlases F3 already ships (Flame02, WispySmoke01, the Unity plume,
   dust_puff / dust_ring, fx_sprites). Arena texture memory is unchanged (medium 127.35 / 128 MB). The own Blender bakes
   `smoke_wisp` / `fire_loop` (alt atlases) were looked at: the Unity flames have more tongue detail, so they were not used.
   The unused `blood_spray` / `splash` bakes are still never loaded in game (so they cost no GPU memory); dropping the
   files would only save ~0.15 MB download (F3 decision 3 still open).

## Still different / not verified (honest)

- Judged from stills and short frame sequences only: flame motion at speed, the heat shimmer (invisible in stills),
  gust timing, ember density in a live fight, splash size in a real knockdown, lightning wash strength.
- Bowl interiors do not glow (the flames sit on the rim); ref-3's bowls are fuller and brighter at their base.
- The far tier fires are small cards; ref-3's left side has many more fires (dressing, not FX).
- The destruction variants were checked for seek determinism in Node and look right in the FX Lab sense, but no
  in-game filmstrip of a topple / collapse / fire-cage impact was shot (needs a seed search for those moments).
- Heat shimmer only on high (medium's distortion pass stays for heavy events, as F1 decided).

## For the next agent (A21 perf + loading for the Moon Gate)

- Fire field knobs: `COLOSSEUM_ART.fire` (wind, smoke, gains, heat, lights); tier tables `TIER` in `fireField.ts`.
- `arena.fire.enabled = false` turns the field off for A/B; `arena.updateFire` is the CPU side.
- The q2 light count includes one oil-pool light held at 0 (constant count, no recompiles); A21 may drop it on q2 if
  every light slot matters.
