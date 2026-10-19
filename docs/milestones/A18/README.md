# A18: Moon Gate entrances, camera and reveal (+ one wide stair)

Branch `anim-plan`, 2026-10-19. Scope: the Moon Gate (theme `colosseum`, kit mode) only, so the owner can show it to friends.
`src/sim` is untouched (`git diff 75ed53c -- src/sim` is empty). Legacy (`?arena=legacy`) and every other theme take the
old code paths: the new behaviour is switched on by ThemeArt data that only the colosseum kit art carries
(`ring.ruins.east.stair.wide`, `cine`, `look.name`).

## What changed

| Part | What | Files |
|---|---|---|
| **One wide stair (ref-3)** | The A7-A8b portal block between two flights is gone. One flight (16 x 0.275 m, 11.2 m wide) climbs from the floor to the dais; each step is a row of worn blocks (some sit 2-5 cm low, tints vary); stepped cheek walls ride the flight on both sides; guardians and fire bowls as A8. The **gate moved up onto the dais**: two slim stone posts with caps and a frieze lintel frame the old portcullis (its group is lifted there, so barrier events, the gate light and the reset work unchanged in the group's frame). From the ref-3 camera the barred gate sits inside the backdrop arch's lit portal | `nearField.ts` (`wideStair`, `stairFlanks`), `art/types.ts` (`stair.wide`, `stair.topGate`), `art/colosseum.ts` |
| **Entrances down the stair** | `GateAnchors.ground` (the stair profile) makes every gate-frame y relative to the ground under it (floor, stair, dais); `GateFrame.w` adds it, `snapAnchors` snaps relative to it. So every entrance variant plays unchanged on the dais and walks / runs / leaps down the stair. `GateAnchors.flat` (the old floor-level barrier) is the speed reference: `stairRetime` builds the variant twice and slows any moving beat that now covers more ground to at most 1.25x its authored speed; cues inside the beat keep their place on the path, camera shots / extra cues / the title follow a piecewise-linear time warp. Airborne lerps (Fenrik's leap, Vex's drop) arc between their take-off and landing heights instead of following the steps. A gate on a dais lowers its bars into the dais (`gate_open`) instead of raising them into the sky. Vex's perch drop lands on the dais in front of the post | `cinematic/entrance.ts`, `render/arena/arenaView.ts` (`ground`, `flat`, `groundY`), `data/entranceVariants.ts` (one line) |
| **Stair establishing shot** | Every entrance at the stair gate opens with 2.8 s low in the arena looking up the stair at the gate, the ring arch and the moon (gate light flaring), pushing in; candidates (side x 3 distances) are scored on hazard intrusion and cover | `entrance.ts` (`stairEstablish`) |
| **Landmark reveal** | 9 s: opens on the storm sky and the moon with the name card ("The Moon Gate"), tilts down onto the ring arch, cranes down toward the stair, ends in a low three-quarter glide on the stair, gate, bowls and guardians. One Catmull-Rom path, eased; side / end distance / lateral offset (18 candidates) chosen per layout on hazard intrusion and clearance from columns / props. The generic reveal is unchanged for everything else | `cinematic/reveal.ts`, `art/types.ts` (`CineArt`), `look.name / tagline` |
| **Face-off in the ref-3 composition** | The last face-off shot sits low behind the west fighter's shoulder, tilted up so the east fighter, the stair, the gate, the arch and the moon are in frame (12 candidates scored on hazards, columns in the line of sight, props near the lens); no collision orbit during this composed shot | `entrance.ts` (`buildFaceoff`) |
| **Fight camera handover** | When the face-off ends on its own, the director starts with `ots_0` on the side the camera already is, blending (smooth 0.75 / 0.45) instead of cutting to the high establishing crane: FIGHT! -> HUD -> first coverage is one continuous move. Skips and every other theme keep the old start; the camera audit (skipIntro) is unaffected | `camera/director.ts`, `main.ts` (`beginFight(handover)`) |
| **Hazard-aware hero framing** | `cinematic/framing.ts`: sample points of the hanging hazards (fire cage + its chains, chain weight + chain) projected into a candidate frame, weighted by centrality and by closeness to the lens; used by the reveal, the stair establishing shot and the face-off. Camera / composition only, no sim change | `cinematic/framing.ts` |
| **Validator fix** | The entrance validator listed variants on the UNSNAPPED anchors, so a stand / perch that snapping drops later was validated as a "legacy" fallback the game never plays (5 phantom failures for Hollowjack at the west gate when he is validated first; present in the A8b build too, hidden by the chunk order). It now snaps first | `cinematic/validateEntrances.ts` |

Sheets: `sheets/ref3_before_after.jpg` (row 1: ref-3 | A8b; row 2: A18 ref-3 preset (pit#7) | the same preset with arena seed 11; row 3: A8b gate view | A18 gate view), `sheets/intro_sequence.jpg` (A18 intro at 960 x 540: reveal 0.5 / 2.5 / 4.5 / 7.5 s, east entrance establishing 29 s, bars sinking 31.5, Maw on the dais 33, down the stair 35, face-off ref-3 shot 55, FIGHT 57.2, handover 58, director 59.5; Gorak vs Maw seed 4242, colosseum pit#7, q1), `sheets/intro_before.jpg` (the A8b intro: high orbit reveal titled "The Gilded Colosseum", Maw walking out of the portal). Note: the reveal frames 0.5-4.5 s in the sequence sheet were taken before the gate posts were slimmed (0.6 -> 0.45 m); the later frames and the concept renders show the final posts. Concept renders: `concept/q1/` (ref-3 preset + gate, tiers, overview, counter, flank).

## Gates

| Gate | Result |
|---|---|
| `npm run build` | passes |
| `npm run fx:check` | all FX checks passed |
| `npm run sim:test -- 40` | sim untouched; 0 timeouts, 0/2240 kills without contact, determinism true (same seed + arena identical, different arena differs) |
| `npm run arena:budget` | PASS, unchanged: low 30.95 / 64, **medium 127.35 / 128**, high 179.41 / 192 MB (no new textures: the stair is trim-sheet geometry) |
| Entrance validator, kit colosseum, 5 layouts x 2 gates x 8 fighters (4 chunks) | **90 configs, 0 failures** (A8b: 95 configs; the 5 fewer are the phantom "legacy" configs the fixed enumeration no longer lists: every east-gate entrance now runs on the dais + stair). Chunks 1, 3, 4 ran before the enumeration fix, chunk 2 after it (`entrances.json`) |
| Camera audit, standard list | **95.5 % readable** (A8b 95.6, floor 93.8), contact 96.9 %, cuts/min 21.1; colosseum matches 98.1 / 98.0 % (`camera_standard.json`) |
| Legacy (`?arena=legacy` ref-3, ref-4, ref-6) and other kit themes (ref-4 .. ref-9) | **pixel-identical** to `75ed53c` (frames + sky-geo + sky-only masks, 27 images, max difference 0; the baseline is a copy of the `75ed53c` dist, no worktree). Caught on the way: a module-level probe camera in `framing.ts` drew a UUID from `Math.random` at import and shifted the seeded legacy banner / flame phases; it is created on first use now |

## Concept metrics (ref-3 preset, q1)

| Check | A8b | A18 | A18, arena seed 11 |
|---|---|---|---|
| C1 sky IoU | 0.37 | 0.37 | 0.39 |
| C2 colour median / worst | 7.0 / 13.5 | 7.1 / 13.5 | 7.4 / 12.6 |
| C3 warm ratio | 1.05 | about 1.1 (0.007 -> 0.008) | 1.0 |
| C4 floor / streaks | 0.71, 3 | 0.71, 3 | 0.65, 4 |

The stair barely moves the numbers (it is a small part of the frame); by eye it is the main change in the centre.

## How close to ref-3 now (honest)

- **Stair**: the centre now reads as ref-3's: one wide stair rising to the dais under the arch, guardians and fire bowls at its sides, the barred gate standing in the backdrop portal. From the ref-3 camera (1 m high) the treads are seen almost edge-on, so the flight reads as a dark stepped ramp; ref-3's stair has brighter lit treads and a narrower, taller look. The barred gate on top is an addition ref-3 does not have (it is the functional gate; ref-3's portal is open).
- **Hazards**: in the calibrated ref-3 preset (pit#7) the fire cage and the chain weight are still in frame: they are sim hazards of that arena seed and the preset camera is calibrated, so they stay. The same preset with arena seed 11 (one of 12 pit seeds of 80 whose hazards fall outside the ref-3 frustum and leave the fighter mark free) shows the frame without them (`sheets/ref3_before_after.jpg`, row 2 right). In the cinematics the camera chooses: the stair establishing shot of pit#7 moved past both hazards (none in frame); the reveal's end avoids them; the face-off of pit#7 cannot (the cage and the chain hang either side of the axis between the east fighter and the stair, so every lens behind the west fighter sees one of them; the scorer keeps the cage near the top centre).
- **Cinematics**: sky -> moon -> arch -> stair reveal with the right name; the east fighter appears backlit on the dais, the bars sink, they come down the stair; the face-off ends on the arch and the moon; the fight starts without a cut.

## Decisions made without the owner (please confirm)

1. **The gate moved to the top of the stair** (slim posts + lintel framing the portcullis) instead of a floor-level portal: every east entrance comes down the stair. The west gate (kit arch, floor level) is unchanged.
2. **Bars sink into the dais** when a stair gate opens (no gatehouse to lift them into).
3. **Entrances at the stair are longer**: moving beats are slowed to at most 1.25x their floor-level speed (Maw's walk-out about 9 s instead of 5), plus the 2.8 s establishing shot. With Gorak's monologue the whole intro of the test match runs to about 57 s (FIGHT! at about 57 s), roughly 15-20 s longer than before. Skips (Space / Enter) still work.
4. **Reveal 9 s** (generic 6.2 s) and the display name **"The Moon Gate"** with the tagline "where the moon watches the ring and the old gods keep score" (kit mode only; legacy keeps "The Gilded Colosseum").
5. **Handover only on the Moon Gate** (`cine.handover`); it would suit every theme, but the other themes are kept identical for now.
6. **The ref-3 preset keeps arena seed 7** (calibration baseline, legacy pixel identity); arena seed 11 is the hazard-free alternative if the owner prefers it for screenshots (`npm run arena:concept -- --refs=ref-3 --aseed=11`).
7. The establishing shot is used for every entrance at the stair gate, also for Ozrel / Vex's shadow rise (they appear on the floor, not on the stair): it shows the stair and arch while they are still hidden.

## What I could not judge

- Motion: only stills at 30 Hz steps. Walking down the stair uses a smooth ramp through the tread centres (feet within half a riser of the step tops; the validator's support check passes), so feet may slide over the step noses a little; a stair-locomotion clip would fix it properly. The reveal's speed and the handover blend were judged from frame sequences, not in real time.
- The subtitles of Gorak's monologue stay on screen into Maw's entrance (also in the A8b build; not changed here).
- Hollowjack's `stands_leap` never plays at the kit colosseum (no stands survive snapping at either gate): pre-existing.
- Headless Chromium on the Arc iGPU only, q1 at 960 x 540 / 1793 x 877.

## For the next agent (A19-A20 fire / environment FX for the Moon Gate)

- The stair gate light (gate group, local (0, 2.4, 1.6)) now sits above the top steps; the fire bowls / guardians are where A8 put them.
- Cinematic hints live in `COLOSSEUM_ART.cine`; the hazard scorer is `cinematic/framing.ts` (`hazardPenalty`, `leastHazard`).
- `?arena=legacy` and the other themes never see `anchors.ground`: `GateFrame.gy` returns 0 without it.
