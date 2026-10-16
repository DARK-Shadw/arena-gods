# Arenas: generator, destruction, rendering

Round B replaced the single fixed arena with a seeded **arena generator**. Seven
visual themes combine with five layout archetypes. The arenas have destructible
cover, throwable props, explosives, hazards, and AI that uses all of them. Everything that can affect the fight lives in the
deterministic sim. The renderer only dresses it.

```
ArenaSpec {theme, layout, seed}
   │  sim/arenaGen.ts  (pure data, seeded)
   ▼
ArenaLayout  ── boundary ellipse (rx, rz), obstacles (cover / toppleable), props (HP, mass,
   │             throwable, explosive), hazards (lava, fire pit, spikes, geyser, water,
   │             chandelier), waypoints (bridges)
   ├──► sim/world.ts      runtime state: obstacle HP + topple, prop physics, fuses, hazard cycles
   │    sim/match.ts      collisions, melee/projectile vs world, lift/throw states, envHit()
   │    sim/ai.ts         arena tactics (grab, smash/topple, barrel shots, hazard baiting, routing)
   │    → MatchRecord.arena + per-frame props / obs / haz arrays + destruction events
   │
   └──► render/arena/arenaView.ts   builds the visuals from the same layout + theme
        dressing.ts → dressClassic.ts / dressNature.ts / dressForge.ts   (per theme)
        sky.ts, fog.ts, materials.ts, textures.ts, kit.ts, ambient.ts, debris.ts, common.ts
```

The same `ArenaSpec` always produces the same `ArenaLayout`, both in Node and in the browser. The
`MatchRecord` stores the spec, so the renderer, the director (`camera/director.ts`) and
the metrics (`tools/aiMetrics.ts`) all regenerate an identical layout from it.

## Determinism across engines

`Math.sin/cos/atan2/exp/pow` are implementation-defined in JavaScript. Node 22
and the bundled Chromium return different last bits; `tools/shots/probe.cjs`
plus a hash over 20k calls showed differences in 9 of 14 functions. The fight
is chaotic, so a one-ulp difference eventually flips an AI decision. Before this
round, the same seed therefore played out differently in `npm run sim:test` and
in the browser.

`src/sim/dmath.ts` now provides `sin`, `cos`, `atan2`, `exp`, `pow`, `log` and `hypot`. They are built
only from `+ - * /` and `sqrt`, which are correctly rounded in IEEE-754 on every engine, and
they are accurate to about 1e-15. The whole `src/sim` tree uses them. A cross-check (event
stream + frame-position hash) is identical in Node and Chromium for three
matches on three themes. `sim:test` also checks same-seed / same-arena identity
for every theme.

## Layout archetypes (`sim/arenaGen.ts`)

| Layout | Shape | Skeleton |
|---|---|---|
| `pit` | circle r 12.3 | 4 columns on a ring |
| `oval` | ellipse 14.5 × 10.5 | 6 columns around an elongated floor |
| `cross` | circle | a central 4-column cluster (four lanes) + 4 outer columns |
| `split` | circle 12.6 | a river of the theme's hazard down x = 0 (lava / water / spike plates), two bridges at z = ±5 (AI routes via `waypoints`) |
| `gauntlet` | ellipse 15.5 × 7.8 | narrow corridor with staggered cover |

On top of each skeleton: 2 boulders (indestructible low cover), 1–2 hazards
from the theme rules, and 7–10 props. Placement uses rejection sampling with
clearance constraints: the start marks, the centre, the gate lanes, other obstacles,
props and hazards. Fighters start at x = ±5 and enter from gates at ±rx.

## Theme rules (sim side)

| Theme | Cover | Props | Hazards |
|---|---|---|---|
| colosseum | marble columns | crates, barrels, urns, powder kegs | spike traps, hanging fire-cage (chandelier) |
| skytemple | columns | urns, crates, rocks | wind vents (geyser), water river |
| sakura | stone lanterns | lanterns, urns, sake barrels, crates | koi pond (water), bonfire |
| forge | obsidian obelisks | barrels, kegs, crates, braziers | lava pools / lava river, hanging crucible |
| glacier | ice crystal clusters | rocks, crates, barrels, kegs | ice-spike traps, cryo vents |
| moonlake | moonstone columns | lanterns, urns, crates, barrels | shallow pools, braziers |
| desert | statues | urns, rocks, crates, kegs | fire pits, sand vents |

## Destruction and props (`sim/world.ts`)

- **Cover** blocks movement, projectiles and line of sight. Projectiles, slams, melee swings and thrown props
  that hit it chip its HP (`cover_hit`). The renderer shows the damage as a
  world-space crack overlay (`materials.ts` `crack` uniform), and debris chips
  fly off.
- **Toppling:** when cover breaks, the column / statue / obelisk / crystal
  falls in the direction of the blow (`topple`). It lands 0.9 s later (`topple_impact`).
  At that moment it **crushes** whoever is under the fall line: 48 × bloodlust damage plus a knockdown. This can be lethal, because the
  column visibly lands on them. It then shatters into two throwable rubble
  `chunk`s and shakes loose nearby chandeliers.
- **Props**: crates, barrels, urns, powder kegs, braziers, lanterns, rocks and chunks.
  Fragile props break on melee contact (swept strike points vs the prop
  cylinder), on projectiles, and when a fighter is knocked into them.
- **Throwables** (`lift` → carry → `throw`): one Mixamo clip,
  `Assets/Animations/Mixamo_HF/grabs_throws/Throw_Object.fbx`. It is converted by
  `tools/convert/shared-clips.ts` (runs FBXLoader in Node) into
  `public/models/shared_clips.json` and retargeted onto every fighter at runtime.
  The sim states map linearly onto clip segments (`THROW_CLIP` in `world.ts`):
  - the crouch / grab lasts 0.95 s, and the prop attaches at the clip's lowest-hand frame (1.0 s)
  - while carrying, an upper-body hold pose is overlaid on the locomotion
  - the throw lasts 1.0 s, and the prop leaves the hands exactly at the clip's
    measured release frame (2.383 s, the fastest-hand frame)

  Flight is ballistic with lead aiming and skill-based scatter. A hit is a swept
  prop-vs-capsule contact (the hit-contact rule), and damage, stagger and knockdown scale with mass.
  Throws can be **dodged** (i-frames), **blocked** (chip + stamina), or **swatted** out of the air by
  an active melee swing. A carried prop also **shields** its carrier from frontal shots.
  Any hit or dodge makes the carrier drop it.
- **Powder kegs** light a fuse when broken (0.4 s, sparks), then explode (r 3.2 m). The blast damages and
  knocks down fighters, breaks props, damages cover and chains to other kegs. A
  thrown keg explodes on impact.
- **Hazards**:
  - Lava and fire pits deal burst damage and pop you out.
  - Spike traps are pressure plates: arm 0.45 s, spikes 0.7 s, cooldown 2.2 s.
  - Geysers and vents run on a period with a 1.2 s warning.
  - Shallow water slows you to 68%.
  - Chandeliers, the hanging fire cage and the crucible are shaken loose by
    slams, explosions or a toppling column within ~6 m. They creak for 0.9 s, fall
    for 0.55 s, then crush.
- Environmental damage goes through `Match.envHit()`. It is applied on the tick the
  thing visibly reaches the fighter, and it credits the opponent (for drama and
  momentum). Chip and fire-ring damage stay non-lethal.

## AI arena tactics (`sim/ai.ts`)

New goals and behaviours, all scored by the existing utility system:

- **grab**:
  - Fighters pick up a throwable that is closer to them than to the opponent, but only when
    it is safe to bend over (`safeToLift`):
    - beyond the opponent's longest gap-closer reach (prop-loving brutes accept less margin)
    - or the opponent is busy (stagger, recovery, winded) or knocked down next to the prop
    - or there is cover between the two
    - against ranged opponents, only behind cover or while they are busy
  - Weighted by doctrine `usesProps` (Maw 0.9, Gorak 0.8, Hollowjack 0.7 … Ozrel 0.2), and it decays per pickup.
  - While carrying, the fighter closes to about 5 m, keeps a clear lane and throws at a good moment. It throws
    immediately if the opponent closes in or is about to swing, which interrupts them.
- **smash** (doctrine `envCunning`):
  - *Topple*: attack a damaged column whose fall line covers the opponent.
    Ranged fighters do this by shooting it.
  - *Break the shield*: smash or shoot the cover a ranged opponent hides behind.
- **Barrel shots**: a ranged fighter shoots a powder keg standing next to the opponent.
- **Hazard baiting**:
  - Pressure footwork approaches from the side opposite a nearby hazard.
  - Knockback-heavy moves get extra utility when a hazard, the wall or cover is
    right behind the opponent.
- **Terrain & safety**:
  - The retreat direction is scored over 8 headings: away from the opponent, open space, no hazards, not into a corner.
    Shooters avoid retreating behind their own cover.
  - Fighters steer around fire, armed traps, venting geysers, creaking chandeliers and lit kegs.
  - Hard river hazards are crossed via the bridge waypoints.
- **Cover**: the existing cover goal uses any standing obstacle.
- `ARENA_AI=0 npm run sim:test` disables the tactics layer (A/B metrics). Avoidance stays on.

Metrics added to `sim:test`:
- matches with arena interaction or destruction
- pickups, throws, throw hit rate (blocked / swatted)
- cover hits, topples, crush hits, explosions, chandeliers, hazard hits
- environmental kills by source
- a per-theme and per-layout breakdown

## Rendering

- **Sky** (`sky.ts`): a procedural HDR dome with gradient, horizon glow toward the sun, mie halo,
  fbm clouds lit from the sun side, stars and a milky band, aurora curtains, and a
  cratered moon. The same shader bakes the **PMREM environment** (`bakeEnvironment`), so every PBR
  surface is lit by, and reflects, the theme's sky. Skytemple also bakes its cloud sea.
- **Fog** (`fog.ts`): three's fog chunks are replaced globally with distance fog plus
  ground-hugging **height fog**. The parameters ride on `THREE.Fog` near/far.
- **Materials** (`textures.ts`, `materials.ts`): procedural tiling PBR sets (albedo, height→normal,
  roughness/metalness) generated on the CPU from periodic noise. Recipes include marble, marble tiles with
  gold inlay, raked sand, mossy / wet flagstones, ashlar blocks with pores and strata,
  basalt with emissive magma cracks, glacier ice, snow, wood, metal and bark. Patches add:
  - world-space macro variation (anti-tiling)
  - triplanar mapping for displaced rocks
  - contact AO
  - a crack overlay
  - animated lava (fbm flow, emissive)
  - water (two scrolling normal maps + clearcoat + env reflections)
- **Kit** (`kit.ts`): fluted columns with entasis and ionic/doric capitals (lathe), extruded arcades,
  balusters, toro lanterns, torii, pagodas, statues, a seated colossus, obelisks,
  crystal clusters, noise rocks, branching trees (tubes + alpha-card canopies),
  palms, eroded ruin blocks, crates, barrels, amphorae, braziers, spike plates, chains.
- **Dressing**: per-theme boundary, gates (each with a moving "portcullis" so the entrance
  cinematics keep working), and backdrop:
  - stands with ~3,400 GPU-animated spectators and a velarium
  - a cloud sea and floating isles
  - cherry trees with instanced wind-swayed grass
  - a lava moat, cavern walls with lava falls, gothic pillars
  - ice cliffs and crystal spires
  - a reflective lake with drifting lanterns and pagoda isles
  - dunes, colossi, pyramids and palms
- **Particles** (`ambient.ts`): GPU-only points whose positions come from a seed and time in the
  vertex shader: dust motes, light motes, cherry petals (rotating sprite), embers, snow,
  fireflies and blowing sand.
- **Destruction visuals** (`debris.ts`):
  - instanced pre-fractured chunk pools with ballistic bounce physics, stepped in sim time, so slow-mo works
  - a canvas floor-decal layer: scorch marks, impact cracks, knockdown scuffs
  - toppling columns pivot on their base edge along the recorded fall direction
- **Post** (`post.ts`): GTAO (high quality only; it skips alpha-tested and glow geometry), god rays (screen-space
  radial from the sun's HDR pixels, high only), half-resolution bloom, and a per-theme grade
  (lift / gain, log-contrast, saturation, tint, vignette). A NaN/Inf flush keeps one bad pixel from blooming over the frame.
- **Static merge**: all static dressing that is a direct child of the arena group is merged
  per material and shadow flags. Glacier went from 551 to 197 draw calls.

## Camera

- `camWorld` (cameraRig.ts) holds the current boundary ellipse, the standing cover (with heights) and the hanging hazards.
  `resolveCamera` clamps to the wall, orbits to the nearest clear angle when cover or a chandelier hides the
  target or fighters (each candidate is wall-clamped first), rises above the cover when nothing is
  clear, and finally pushes out of columns and hanging objects.
- Director:
  - The new `destruct` shot frames toppling columns, explosions and falling
    chandeliers, with short slow-mo so the fall reads.
  - `throw_*` is an over-the-shoulder shot on throws.
  - There is hit-stop and shake on impacts.
  - The establishing crane is sized to the arena.
- Arena **reveal** (`cinematic/reveal.ts`): a 6 s crane flythrough that stays above the backdrop
  until it is inside the wall, with the arena's name card. It runs before the entrances.

## Performance

`tools/shots/shots.cjs … --bench` measures GPU-synced frame times headless on this
machine (Intel Arc integrated GPU, 1280×720). The numbers include the CPU tick.
Measured average / p95 frame times on this machine (Intel Arc integrated GPU, 1280×720, pit layout, the fight playing, 90 frames):

| Theme | high | medium | low |
|---|---|---|---|
| colosseum | 19.5 / 23.0 ms | 17.3 / 20.5 | 15.9 / 21.0 |
| skytemple | 15.0 / 18.9 | 13.2 / 15.1 | 12.8 / 14.8 |
| sakura | 17.7 / 20.6 | 15.9 / 18.1 | 15.1 / 17.2 |
| forge | 15.1 / 17.0 | 14.2 / 15.7 | 15.0 / 16.7 |
| glacier | 18.5 / 21.3 | 15.8 / 17.3 | 15.0 / 16.9 |
| moonlake | 13.5 / 17.8 | 13.3 / 15.1 | (one hitch) |
| desert | 16.2 / 20.8 | 13.1 / 14.3 | 14.2 / 15.9 |

Medium and low land in nearly the same place (~13–16 ms). That means the floor on this iGPU is the per-frame CPU tick plus the forced GPU sync in the benchmark, not fill rate. Real-GPU frame rates were not measured. Costs and how they scale:

| Feature | Low | Medium | High |
|---|---|---|---|
| pixel ratio cap | 1 | 1.5 | 2 |
| sun shadow map | 1024 PCF | 2048 PCFSoft | 2048 PCFSoft |
| bloom | quarter-res | half-res | half-res |
| GTAO / god rays / DOF | off | DOF only | all |
| ambient particles | 30% | 60% | 100% |

Without `?q=`, the game auto-tunes. It starts at high and measures the median frame time over 150
frames. Below about 48 fps it steps down a level. **Q** cycles the level manually.

## How to add …

**A theme**
1. Add the id to `ThemeId` and `THEMES`, and add rules in `THEME_RULES` (`sim/arenaGen.ts`). The rules define cover kind and
   size, the prop mix, the hazards, and the river kind for split layouts.
2. Add a `ThemeDef` in `render/arena/themes.ts`: sky params, sun, hemi, fog, exposure, bloom,
   grade, god rays, ambient particle kinds, fire / key / rim / accent colours.
3. Write `dress<Theme>(a: Arena): Dressing` (see `dressClassic.ts`). It builds the floor
   (`floorDisc`), the boundary (`sweepEllipse`, `alongEllipse`), the gates (`makeGate` must return the moving
   portcullis) and the backdrop. It returns the materials, an `obstacle()` builder (wrap the main material in
   `withCrack` for damage), `propMat()`, debris kinds, the chandelier builder and the water colour.
4. Register it in `dressing.ts`. Run `npm run sim:test`, then take screenshots with
   `node tools/shots/shots.cjs <outDir> <theme>:<layout>:<seed> --bench --fight=20`.

**A prop**
1. Add the kind to `PropKind` and `PROP_BASE` (radius, HP, mass, throwable, explosive), plus the
   `TOP` / `FRAGILE` tables in `world.ts`.
2. Add a geometry in `kit.ts` and map it in `Arena.propGeo()`. Each theme supplies the material in `propMat()`.
3. List it in some theme's `props`.

**A layout**
- Add a `LayoutId` and a `case` in `generateArena()`. It sets rx/rz and places the
  skeleton obstacles, hazards and `waypoints`.
- Keep the start marks (±5, 0), the centre and the gate lanes clear (`clearOf`).
- Check balance per layout in the `sim:test` "By arena" table.

**A hazard**
1. Add a `HazardKind`.
2. Add sim behaviour in `World.updateHazard()`, plus AI danger in `World.danger()`
   and `steer()` avoidance.
3. Add visuals in `Arena.addHazard()` with an `update(state, t, dt)` driven by the frame's `haz` codes.
