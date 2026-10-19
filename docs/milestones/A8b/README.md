# A8b: independent ref-3 review of the Moon Gate, and fixes

Branch `anim-plan`, 2026-10-19. An independent reviewer (not A8) rendered fresh shots with the concept harness
(`node tools/shots/concept.cjs --refs=ref-3 --q=<0|1|2> --views=gate,tiers,overview,counter,flank`), looked at them next
to `docs/concept-art/ref-3.png` and fixed the biggest gaps in order of visual impact. `src/sim` is untouched.

## Step 1: ranked gap list (before, A8 `7d190a4`)

Shots: `before/q1/` (ref-3 preset + gate, tiers, overview, counter, flank views of seeded fights), `before/q2/`, `before/q0/`.
Ranked by what a viewer notices first:

1. **Floor reads as pale, clean lavender tiles.** It is the brightest large surface in the frame (ref-3: the darkest,
   near-black wet stone with glare only in the water). Cause: a broad moonlit specular sheen on the dry slab tops (direct
   moon key + planar reflection of the bright sky at roughness 0.7), plus a flat mid-grey baked albedo with thin even
   joints and small white puddle blotches that look like paint. No rubble / grit in the joints, stains barely visible.
2. **Fire reflections are straight orange bars** (5-10 per frame, uniform width, from the stair braziers to the bottom
   edge): the streak cards. In ref-3 the fire glints are broken by the wet stone and sit under the fires.
3. **Embers are large orange bokeh dots across the whole frame**, including the sky: reads as snow / dust, not sparks.
4. **The centre of the frame is a lit bronze portcullis in a flat wall** with a tripod brazier in front; the eye goes
   to it instead of the arch. Ref-3: one wide stair to the arch's portal (A7 decision: two flights + floor-level portal).
5. **Hanging hazards in the frame**: the fire cage (chandelier hazard) and the chain weight hang in the open air where
   ref-3 has sky. They are sim hazards of this seed (not dressing), so they stay; ref-3's preset seed shows them.
6. **Near-field swags** read as scalloped bunting (party decoration) with gold target sigils, not shredded rags;
   the near banners carry a round "target" sigil where ref-3 has a sharp glyph.
7. **Moon**: a flat white clipped disc; the ring arch reads as a tall horseshoe with a blocky bridge rather than
   ref-3's slim ring with the moon behind its crown.
8. **Left side plain**: tidy, flat-lit brick tiers and barrels; ref-3 has a huge near pillar with a banner, broken
   blocks, burning debris, chains.
9. **Props**: the terracotta urns and banded barrels are the most saturated non-fire objects (orange), off-palette.
10. **Backdrop stone** is clean blockout with a procedural shader (painterly carved stone in ref-3); arcade height and
    the sky between the ruins are right.
11. **Counter / tiers views**: away from the moon the sky is a flat navy with stars; the walls are clean bright brick.
12. **Tiers**: q2 (hero inset) and q1 look nearly the same in the ref-3 frame; q0 holds up (slightly softer stone,
    stronger streaks). No tier loses the likeness badly.
13. Haze colour and ground mist are close enough; overall brightness is fine except the floor (item 1).

Owner feedback carried in: floor darker, rougher, thicker broken slabs, deep joints, rubble, blood / soot, wet mostly in
puddles and cracks; keep the sky; dark overall with strong accents.

## Step 2: what was fixed (in order of visual impact)

| # | Gap | Fix | Files |
|---|---|---|---|
| 1 | Floor pale clean tiles | **Floor re-baked as dark irregular flagstones**: new `--layout flag` in `floor_set.py` (periodic jittered seeds, rotated + stretched Chebyshev Voronoi: rectangular-ish slabs of mixed size, no continuous joint lines, triangular gaps at the junctions), 55 % of slabs broken through, joints about 3-8 cm wide and 7 cm deep with bigger chips (24 cm), 3500 loose stones gathered in joints / breaks, heavier soot and blood, stronger micro surface (`--micro 1.8`), per-slab albedo 0.55-1.35, slab lift up to 4 cm, darker stone (`--albedo 0.06,0.063,0.076`). Same 2048 px set, same GPU memory. Bake peak 3.3 GB (grid 384 -> 320). **Runtime: the dry slab tops keep only 30 % of the moonlit specular** (`FloorArt.reflDry`, applied to the planar reflection and the direct specular outside the water): puddles, joints and cracks stay the mirrors. Puddles 0.30 -> 0.36 | `tools/arena/blender/floor_set.py`, job `floor_slabs_moongate`, `public/arena/floor/slabs_moongate*.glb`, `floor.ts`, `art/colosseum.ts` |
| 2 | Fire reflections as orange bars | Streak cards follow the water only (`streakDry 0`, `streakWater 0.22`) and are shorter (`streakLen 0.6`): they break into puddle-shaped glints under the fires. The moon path got its own knobs (`moonPath`: power 1.6, width 1.8, 0.4 on damp stone) so the silver glare runs from the stair toward the camera as in ref-3 | `reflection.ts`, `arenaView.ts`, `floor.ts`, `art/types.ts` |
| 3 | Embers as bokeh | New ambient kind `embersFine` (700 instead of 1800, half the size, lower box) for the Moon Gate only | `ambient.ts`, `themes.ts` |
| 4 | Bronze portcullis pulling the eye | Dark iron bars on both kit gates (`GateArt.portcullis`); the passage reads as a dark doorway under the arch | `nearField.ts` |
| 6 | Swags as bunting | Swag cloths torn into long irregular rags by a shred material on the atlas's swag row (`chains.swagShred 0.6`) and hung deeper (`swagSize [0.36, 2.6]`); one extra draw call | `cloth.ts`, `dressKit.ts`, `nearField.ts` |
| 9 | Orange urns | `ThemeArt.propTint` (urns x [0.2, 0.21, 0.27] on the Moon Gate) | `dressKit.ts` |
| - | Mist | ground mist opacity 0.6 -> 0.8, a little lighter | `art/colosseum.ts` |

Not fixed (bigger work, see "Still different"): the stair / portal composition, hanging hazards (sim), moon disc, left-side near pillar, backdrop carving, west / counter view walls.

## Metrics (ref-3 preset, q1; before = A8)

| Check | Before | After | Note |
|---|---|---|---|
| C1 sky IoU | 0.37 | 0.37 | geometry unchanged |
| C2 colour median / worst | 7.0 / 13.5 | 7.0 / 13.5 | pass |
| C3 warm share ratio | 1.93 (fail) | **1.05 (pass)** | the bars were most of the extra warm |
| C4 floor bright ratio, streaks | 1.13, 5 | 0.71, 3 | pass; the floor is darker, the glare sits in the water |
| C5 detail per cell | 0.41 1.01 1.25 / 0.46 0.83 0.83 / 0.41 0.65 0.52 | 0.39 0.94 1.22 / 0.45 0.82 0.69 / 0.34 0.61 0.46 | slightly lower: the dark floor has less contrast than the bright tiles had |
| Median L* (ref-3 21.6) | 17.9 | 15.8 | darker on purpose (owner: dark overall, strong accents) |
| q2 / q0 | C2 6.5 / 8.1, C3 1.87 / 2.6 | C2 6.6 / 7.5, C3 about 1.1 / 1.2 | |

Sheets: `sheets/ref3_before_after.jpg` (ref-3, then before | after for the ref-3 preset, gate, tiers, counter, overview), `sheets/ref3_tiers.jpg` (after q2 | q1 | q0), `sheets/floor_flags_basecolor.jpg`, `sheets/floor_flags_preview.jpg`; side-by-sides and contact sheets in `before/q*/` and `after/q*/` (`ref-3_side.jpg`, `ref-3_blend.jpg`, `contact_q*.jpg`; the PNG renders are not committed, regenerate them with the commands at the top).

## Gates

| Gate | Result |
|---|---|
| `npm run build` | passes |
| `npm run fx:check` | all FX checks passed |
| `npm run sim:test -- 40` | sim untouched (`git diff 7d190a4 -- src/sim` empty): 0 timeouts, 0/2240 kills without contact, determinism true |
| `npm run arena:budget` | PASS, unchanged: low 30.95 / 64, **medium 127.35 / 128**, high 179.41 / 192 MB (the floor set keeps its size). Download: the floor GLBs are about 2 MB bigger in total (more detail compresses worse) |
| Entrance validator, kit colosseum, 5 layouts x 2 gates x 8 fighters (4 chunks) | **95 configs, 0 failures** (`entrances.json`) |
| Camera audit, standard list | **95.6 % readable** (A8 96.1; floor 93.8), contact 96.9 %; colosseum matches 98.9 / 98.0 % (A8 99.9 / 98.0). Non-colosseum matches (pixel-identical scenes) also moved by up to 1.4 points between runs, so this is mostly run-to-run noise (`camera_standard.json`) |
| Legacy (`?arena=legacy` ref-3, ref-4, ref-6) and other kit themes (ref-4 .. ref-9) | **pixel-identical** to `7d190a4` (frames + sky-geo + sky-only masks, max difference 0; baseline built in a temporary worktree whose node_modules junction was removed before the worktree) |
| Perf, GPU timers (`check_backdrop.cjs`, `check/check.json`) | scene pass q2 11.7 / q1 11.7 / q0 7.3 ms with the backdrop (A8 run: 15.2 / 14.1 / 12.8; GPU clock noise dominates, nothing got slower); backdrop isolated 0.29 / 0.34 / 0.11 ms; reflection pass 0.93 / 0.51 ms |

## Still different from ref-3 (honest, ranked)

1. **Centre composition**: a flat portal block with a (now dark) portcullis between two flights, instead of ref-3's one wide stair climbing to the arch's portal. The biggest remaining difference; needs the stair rebuilt (entrances walk in at floor level, so A18 has to agree).
2. **Hanging hazards** (fire cage, chain weight) in the ref-3 frame: sim hazards of this seed.
3. **Moon** is a flat clipped white disc; ref-3's has a soft glow and surface detail. The ring arch reads as a horseshoe with a block bridge rather than ref-3's slim ring.
4. **Left side**: ref-3 has a huge near pillar with a banner, broken blocks and burning debris; ours is tidy brick tiers and barrels.
5. **Backdrop stone** is clean blockout; ref-3's is carved and painterly. The near banners carry a round "target" sigil.
6. **Floor**: much closer (dark broken flagstones, wet glints, moon glare), but flatter than ref-3's chunky foreground rubble (the loose stones are only in the texture); in the high overview camera a puddle can mirror the moon as a hot white blob.
7. **Counter / tiers views**: the west-side walls are clean bright brick and the sky away from the moon is a plain navy.
8. **Overall brightness**: median L* 15.8 vs ref-3 21.6; ref-3's mid-ground mist and glare are brighter.

Score by eye ("would the owner show this to friends as the ref-3 arena?"): A8 about 5 / 10, A8b about 6.5 / 10. Top three next moves: one wide stair to the arch portal (with A18), a carved / painterly pass on the backdrop arch plus a softer moon, a heavy near pillar with rubble on the left of the ref-3 frame.

## Decisions made while the owner was asleep (please confirm)

1. **Irregular flagstone layout** instead of A8's running bond (ref-3's slabs are not laid in rows). The bond layout is still `--layout bond`.
2. **Darker overall** (median L* 17.9 -> 15.8, ref-3 21.6): the floor stopped being the brightest surface; the owner asked for dark with strong accents.
3. **Dry stone keeps 30 % of the moon specular** (`reflDry 0.3`); wetness lives in puddles, joints and cracks.
4. **Streak cards only in the water**, shorter; the moon path brighter and wider.
5. **Finer, sparser embers** on the Moon Gate (`embersFine`); other themes keep `embers`.
6. **Iron portcullis** on both colosseum kit gates (bronze kept on legacy and other themes).
7. **Shredded swags** via a shader tear (the shared banner atlas was not re-baked, so other themes cannot change).
8. **Urns tinted cold** on the Moon Gate only (`propTint`); their debris fragments keep the shared terracotta.
9. Hazards in the ref-3 frame and the stair / portal composition left for A18 / a stair milestone.

## What I could not judge

- Motion: streak glints while the camera moves, swag shreds swaying (the tear is in UV space, so it moves with the cloth), ember drift; stills only.
- The floor up close in a live fight on a real monitor; headless Chromium on the Arc iGPU only.
- Whole-frame perf numbers swing by several ms between runs; only the isolated timers are stable.
