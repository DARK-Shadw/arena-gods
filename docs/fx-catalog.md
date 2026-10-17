# Arena Gods: FX catalog (effect inventory)

Companion to `docs/fx-plan.md`. One row per effect. Every effect is cosmetic: it is triggered by a sim event or a render-side observation of recorded frames, and it never writes back into sim state.

**Columns**
- **Trigger** is the sim event (`src/sim/types.ts` `EventType`) or a render observation.
- **Dur** is the visible lifetime in seconds. **Layers** are what is drawn, front to back.
- **Tech** codes:
  - `GP`: GPU particles (stateless, analytic, soft).
  - `FB`: flipbook particle (atlas).
  - `RB`: ribbon.
  - `MESH`: real geometry (instanced).
  - `DEC`: decal (floor atlas or mesh-projected).
  - `DIST`: distortion buffer.
  - `MAT`: material patch on a fighter or prop.
  - `POST`: post-process uniform.
  - `AFT`: afterimage ghosts.
  - `LITE`: FX light pool.
  - `CARD`: glow or light card.
- **Assets** are atlas ids from the plan's §4. **Light** is what the effect contributes to the FX light pool (`LITE`) or to cards.
- **Cost** is a rough GPU+CPU estimate on the Intel Arc iGPU at 1080p, high quality.
- **Tier** says what degrades on medium (M) and low (L).
- **Audio** names the existing sfx key from `src/data/sfx.ts`, or `NEW:` for a sound that does not exist yet. Event sounds stay in `SoundDirector`; FX never doubles them.
- **P** is the priority: P0 must ship with the first FX milestones, P1 next, P2 polish.

Gore levels below are `off / standard / full` (see plan §3.7). "Standard" means roughly Elden Ring level and is the proposed default.

---

## 1. Everyday combat (seen every second)

| ID | Effect | Trigger | Dur | Layers | Tech | Assets | Light | Cost | Tier | Audio | P |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C01 | Footstep dust puff | Render: foot plant. This is the FootLock "planted" edge in `poseFx.ts`, read through a FighterView getter, and only when the speed is above 2.5 m/s or on dodge/rush starts. | 0.5 | 2–3 small dust puffs, a faint ground scuff | FB soft | `dust_puff` | none | ~0.02 ms | M: run only. L: off | `footstep` (exists) | P1 |
| C02 | Mud / water / snow splash on step | Same as C01, when the arena surface query returns `water`, `mud`, `snow` or `sand` (hazard water cells, river, theme floor tags) | 0.5 | droplets (GP streaks), splash crown (FB), ripple ring (DEC, animated) | GP+FB+DEC | `splash_small`, `ripple` | none | ~0.04 ms | L: droplets only | `NEW:splash_step` | P1 |
| C03 | Landing / knockdown dust | `knockdown`, `launch_land`. Today this uses a `setTimeout(150)` in `main.ts`; it must instead be scheduled on sim time from the clip's ground-contact time. | 1.2 | ground dust ring (FB, radial, low), 6–10 stone chips (MESH instanced, via `arena/debris.ts`), crack decal (exists), small shake | FB+MESH+DEC | `dust_ring`, `crack_*` | none | ~0.1 ms | L: half the dust, no chips | `body_thud`, `stone_slam` | P0 |
| C04 | Weapon trails (per weapon type) | Render: attack phase 1 window, already computed in `fighterView.ts:401`. Samples are time-stamped on sim time. | active + 0.15 | trail ribbon (hot edge, dark smoky body), optional distortion ribbon on heavy moves | RB (+DIST) | `trail_blade`, `trail_claw3`, `trail_smear`, `trail_magic` | none (heavy: a weak LITE on ultimates) | ~0.05 ms per trail | M: no DIST. L: 12 segments, no texture noise | `whoosh_light` / `whoosh_heavy` (exists) | P0 |
| C05 | Swing air distortion | Heavy / ultimate / `lunge > 3` active start (`onActiveStart` in `main.ts`) | 0.25 | distortion ribbon that follows the trail | DIST | `noise_dist` | none | ~0.05 ms | M/L off | same as C04 | P1 |
| C06a | Impact: blade on metal (Aldric's plate) | `hit` where the attacker class is blade and the victim surface is metal | 0.35 | white-hot core flare (CARD), 20–40 stretched spark streaks with gravity and bounce (GP), metal glints, small smoke wisp (FB) | GP+CARD+FB+LITE | `flare_star`, `spark_streak`, `smoke_wisp` | LITE warm white 6–14 for 0.12 s | ~0.08 ms | L: 50% sparks, no wisp | `hit_blade`, `clang` | P0 |
| C06b | Impact: blade / claw on flesh | `hit`, victim surface flesh / fur / leather | 0.6 | gore off: dust and cloth fibres plus a dark mist. Standard/full: arterial blood spray (FB `blood_spray` oriented along the cut, plus GP droplets that fall and leave floor dots), a small blood mist, a wound added to the victim (C15). Fur: hair tufts. | FB+GP+DEC+MAT | `blood_spray`, `blood_drop`, `mist`, `fibre` | none | ~0.07 ms | L: no mist, 50% droplets | `hit_blade` | P0 |
| C06c | Impact: blunt on body (fists, kicks, hammerfist, shield kick) | `hit`, attacker class blunt (from the move's effector: `anim.meta.clips[move].eff` = hand or foot) | 0.4 | compression burst: a dust ring off the body surface, a short shock ring (DIST), sweat or blood spatter at standard gore on heavy hits | FB+DIST | `dust_burst`, `ring_dist` | none | ~0.05 ms | M/L: no DIST | `hit_blunt`, `hit_heavy` | P0 |
| C06d | Impact: on Hollowjack (pumpkin / plant) | `hit` where the victim is hollowjack | 0.6 | orange pulp chunks (MESH instanced), seeds (GP), splinters; no blood at any gore level | MESH+GP | `seed`, `pulp_chunk` mesh | none | ~0.06 ms | L: chunks only | `wood_break` (light) | P1 |
| C06e | Impact: stone / cover / pillar | `cover_hit`, `projectile{hit:'pillar'}`, `wall_slam`, `pillar_slam` | 1.0 | stone chips (MESH, debris.ts), dust plume (FB), crack decal on the obstacle (MAT `crack` uniform, exists) | MESH+FB | `dust_plume` | none | ~0.1 ms | L: half | `stone_slam`, `wall_slam` | P0 |
| C06f | Impact: wood / prop | `prop_break`, `prop_hit` | 1.0 | splinters (MESH, thin), dust, paper scraps for lanterns plus a fire burst | MESH+FB | `dust_puff` | lantern: LITE | ~0.08 ms | L: half | `wood_break` | P1 |
| C07 | Block sparks | `block` | 0.3 | spark fan along the deflection tangent (GP streaks), small flare, guard-arm flinch (exists) | GP+CARD+LITE | `spark_streak`, `flare_star` | LITE 3, 0.08 s | ~0.04 ms | L: 50% | `clang` (exists) | P0 |
| C08 | Parry flash | `parry` | 0.5 | big anamorphic flare (CARD, HDR 20+), spark cone (60), ring shock (DIST), chromatic aberration pulse (POST, exists `aberration`), slow-mo (exists in director) | CARD+GP+DIST+POST+LITE | `flare_anamorphic`, `ring_dist` | LITE cool white 16 | ~0.12 ms | M: no DIST. L: no DIST, 50% sparks | `parry` | P0 |
| C09 | Shield ripple / ward | `block` by Aldric (shield) and the Ward Pulse active | 0.4 | a fresnel half-sphere at the shield bone, an expanding hex/rune ripple, holy gold tint | MESH (shader) | `rune_ring` | LITE gold 3 | ~0.05 ms | L: no ripple texture | `ring` | P1 |
| C10 | Dodge afterimage + skid dust | `dodge` event and the `dodge` state | 0.35 | 2–3 ghost copies of the pose (AFT, fresnel, accent tint), skid dust line (FB), scuff decal (exists `Decals.scuff`, unused today) | AFT+FB+DEC | `dust_puff` | none | AFT ~0.25 ms (skinned redraw) | M: 1 ghost. L: no ghost | `cloth` | P1 |
| C11 | Heavy-hit shockwave | `hit` with `heavy`, `fx:'quake'`/`'slam'`, ultimates | 0.6 | ground dust ring (FB radial), DIST ring, ground-crack decal, debris chips, short LITE | FB+DIST+DEC+MESH+LITE | `dust_ring`, `ring_dist`, `crack_*` | LITE 8 | ~0.15 ms | M: no DIST. L: dust only | `hit_heavy`, `stone_slam` | P0 |
| C12 | Floor cracks (persistent) | slams, knockdowns, topple / chandelier impacts (`Arena.onEvent` already paints canvas cracks) | match | normal-mapped crack decal (DEC atlas, darkens and roughens, catches the wet-floor spec) | DEC | `crack_*` (4 variants) | none | ~0 (one batch) | L: canvas fallback | n/a | P1 |
| C13 | Debris | destruction events (exists `arena/debris.ts`, instanced, seeded) | 4 | per-material chunks; add dust trails on large chunks, and sparks for metal | MESH+GP | — | none | ~0.1 ms | L: half | `wood_break` / `stone_slam` | P1 |
| C14 | Camera shake + hit-stop | Owned by `camera/director.ts` + `cameraRig.ts` (do not duplicate) | — | FX defs carry `shake`/`stop` values that the director reads (one source of truth) | — | — | — | 0 | — | — | P0 (coordination) |
| C15 | Blood: wounds on fighters | `hit` at gore ≥ standard | match | wound mask in the fighter material: up to 8 bone-anchored wound spheres per fighter (dark red, wet spec, noise edge), plus drips (GP) for 2 s after a heavy cut | MAT+GP | `wound_noise` | none | ~0.05 ms (fragment ALU) | L: 4 wounds, no drips | — | P1 |
| C16 | Blood: weapon blood | `hit` with a blade or claw at gore ≥ standard | match | a `blood` uniform on the weapon or hand material (noise mask that grows towards the tip with each hit); drips during idle | MAT+GP | `wound_noise` | none | ~0 | — | — | P1 |
| C17 | Blood: floor splatter + pooling | `hit` (droplet landings), `knockdown`, `kill` | match | splatter decals (DEC atlas, oriented along the hit direction), a pool decal growing under a downed or dead fighter (radius over ~3 s), footprint decals when walking through a pool | DEC | `blood_splat_*` (8), `blood_pool` | none | ~0.02 ms | L: fewer variants | `NEW:splat` | P0 |
| C18 | Victim hit pulse | `hit` | 0.08 | a short fresnel brighten on the victim (MAT); at gore off it reads as "hit" without blood | MAT | — | none | ~0 | — | — | P1 |
| C19 | Guard break | `guard_break` | 0.5 | shatter flare, a ring of large sparks, orange flash, DIST | GP+CARD+DIST+LITE | `flare_star` | LITE orange 10 | ~0.1 ms | M/L no DIST | `clang` | P1 |
| C20 | Arrow flight + impact | `projectile` with fx `arrow`, `fr.proj` | flight + 2 | real arrow mesh (exists, a cylinder today → shaft + fletching), a thin ribbon trail with sub-frame positions, impact by surface (C06b/e); the arrow sticks for 2 s, bone-attached on a body hit | MESH+RB | `trail_thin` | none | ~0.03 ms | — | `arrow_hit`, `whoosh_light` | P1 |
| C21 | Telegraph decal | windup of heavy / gap / ultimate (exists `vfx.ts Telegraph`) | windup | keep the readability ring, retexture it as a scorched rune circle; remove the `performance.now()` pulse (use the sim phase) | DEC | `rune_ring` | none | ~0 | — | — | P1 |

## 2. Skill FX (per move class, then the bespoke ultimates)

Move fx tags today (`src/sim/fighters.ts`): `slam`×3, `quake`×5, `fire`×6, `pyre`×2, `nova`×3, `arrow`×6, `shadow`×8, `holy`×2, `blood`×1, `seed`×1; the other ~47 moves have no tag. The FX director keys its definitions on `(fighter, moveId)` first, then on the move's `fx` tag, then on `kind` plus the effector class. The tables below are the proposed treatment. The per-fighter weapon class comes from `public/models/*.json` (`weaponTip` exists only for gorak = axe and aldric = sword).

### 2a. Move classes

| Class | Moves (examples) | Windup | Active | Impact | Tech | P |
|---|---|---|---|---|---|---|
| Light melee, blade | slash, riposte, cross_cut, fade_cut, cleave, backswing | none | blade trail (C04) | C06a/b | RB | P0 |
| Light melee, blunt / kick | stomp_kick, boot, jab, kick, hammerfist, gourd_punch, hind_kick, heel_hook | none | short smear trail on the limb (C04 smear) | C06c | RB | P0 |
| Claw | raking_claw, rake, rend, backhand_swipe | none | triple claw streaks (3 parallel ribbons from the finger bones) | C06b + 3 parallel cut lines (CARD, 0.15 s) | RB+CARD | P0 |
| Multi-hit strings | headsman, reavers_fury, savage_string, harvest_combo, ember_flurry | none | trail stays on for the whole string, fades between hits | each hit C06, the last hit gets C11 if `knockdownLast` | RB | P0 |
| Charge / rush (gap) | brute_rush, bulwark_rush, lunging_strike, shoulder_barge, rolling_charge, pounce, crushing_leap | dust kick-off at windup end | speed trail (afterimage ×2 + ground dust line + DIST cone in front of the body on high) | C11 small, skid decal | AFT+FB+DIST | P1 |
| Slam (`fx:'slam'`) | skull_crack, hammer_of_ages, harvest_slam | weapon glint at the windup apex | heavy trail + DIST | C11 + crack decal + rubble chunks thrown up + dust column + LITE flash | FB+MESH+DEC+DIST | P0 |
| Quake (`fx:'quake'`) | earthshaker, quake_stomp, crushing_leap, devour, skullsplitter | ground glow cracks pre-forming (DEC emissive, windup progress) | — | radial crack decal with emissive edges fading over 1.5 s, a ring of rubble chunks popping up (MESH), a dust wall ring (FB), strong DIST ring | DEC+MESH+FB+DIST | P0 |
| Spin / sweep | cleave (360 low), tail_sweep, scarecrow_spin | — | a full-circle trail, plus a low dust disc swept along the floor arc | C06 + dust | RB+FB | P1 |
| Ranged fire (`fire`) | ember_strike, flame_whip, fire_bolt, flame_lash, ember_barrage | hand ember gather (GP inward) + hand light | a flipbook fire core + smoke wake + embers on the projectile; for whips a fire ribbon (RB with fire texture) | fire burst FB + scorch decal (small) + LITE | FB+GP+RB+LITE | P1 |
| Ranged heavy fire (`pyre`) | falling_star, pyre | sky glow / ground rune at the target | a falling meteor: FB fire core + long smoke ribbon + heat DIST | explosion (E07 small) | FB+RB+DIST+LITE | P1 |
| Nova (`nova`) | cinder_ward, cinder_nova, bonfire_night | ground rune + inward embers | radial fire wave: an expanding fire-wall ring (FB on a ring of quads) + DIST | scorch ring decal | FB+DIST+DEC+LITE | P1 |
| Arrow (`arrow`) | quick_draw, snap_shot, twin_shot, heartseeker, pinning_shot, rain_of_thorns | bowstring glint; heartseeker: a wind spiral gathering at the arrow tip | C20 trail; heavy: spiral wind ribbon + DIST | C20 impact; pinning: the arrow pins with a dust burst | MESH+RB+DIST | P1 |
| Shadow (`shadow`) | raking_claw, blood_lash, fade_cut, crimson_bolt, shadow_step, bat_dive, mirror_riposte, thousand_cuts | dark smoke curling up the legs (FB, alpha-blended dark with a crimson rim) | crimson-cored trails, smoke wake; shadow_step: dissolve-out / dissolve-in (MAT dissolve, exists in finisherFx) + afterimages | dark burst + crimson sparks | FB+RB+MAT+AFT | P1 |
| Holy (`holy`) | ward_pulse, oath_of_steel | light rune circle under the feet, god-ray card from above | gold blade-light trail (HDR core) | gold flare + rune ring | CARD+RB+DEC+LITE | P1 |
| Shout / roar | howl, dread_roar | — | sonic ring DIST ×3 from the mouth (head bone), dust blown outward on the floor, breath vapour on cold themes | — | DIST+FB | P1 |
| Counter | counter_riposte, mirror_riposte, gourd_uppercut (`counter` event) | — | a gleam on the weapon at the counter start | counter flare (C08 light) | CARD | P1 |
| Feint | axe_feint, blade_feint, claw_feint, swipe_feint, punch_feint, feinted_draw | trail starts then snaps off (shows the bait) | — | — | RB | P2 |
| Buff / ward / rage aura | ward_of_cinders, rage, second_wind, last_stand, fury full | ground rune + rising embers | body aura: fresnel rim shell (MAT emissive) + heat DIST column + embers (GP); last stand: red pulsing rim + dripping blood (gore) | — | MAT+GP+DIST | P1 |
| Seed (`seed`) | seed_spit | — | small green-brown projectile with a faint trail | splat of pulp | GP+DEC | P2 |

### 2b. Ultimates and signature moves (bespoke)

| Move (fighter) | Treatment | P |
|---|---|---|
| **THOUSAND CUTS** (Vex, 6 hits over 1.0 s, lunge 2.4, `shadow`) | Windup (0.5 s): Vex dissolves at the edges into crimson-black smoke (MAT dissolve edge 0.2) and the screen colour drains slightly. Active: Vex flickers between 3–5 positions around the target. Each flicker leaves an **afterimage** (AFT, crimson rim, fading 0.4 s), and each hit draws a thin **slash line** across the target's chest (camera-facing streak card, HDR white core with a crimson edge, seeded angle, 1.2–1.8 m long) that **stays lit** while only a tiny spark flashes. On the 6th hit: a **brief freeze** (director hold of 0.25 s real time; needs the director owner) with the world desaturated to 0.6, every slash line flaring at once (brightness ×4, width ×2), then **all cuts land together**: a blood burst along each line (gore ≥ standard) or a crimson ember burst (gore off), a chromatic pulse, a DIST ring, and wounds added along every line. The deferred hits 1–5 show only the line plus a micro-spark at their contact time; the big impact is cosmetic batching, and the sim's damage timing is unchanged. | P1 |
| **SKULLSPLITTER** (Gorak, 360 high, 2 hits, `quake`) | A double spin with a heavy axe trail plus fire embers in the trail. The 2nd hit gets the quake class at full size, emissive cracks, and an ember geyser from the cracks. | P1 |
| **OATH OF STEEL** (Aldric, 3 hits, `holy`) | A light pillar from above on the windup (CARD + god-ray), the blade glowing white-gold, 3 golden cross-slash lines, and the last hit drops a rune circle that flashes. | P1 |
| **PYRE** (Ozrel, ranged, 5 hits) | A fire tornado or column at the target: a stacked ring of fire flipbooks rotating, embers spiralling, heat DIST, strong LITE, scorch decal, then a smoke column that lingers 3 s. | P1 |
| **RAIN OF THORNS** (Erika, 4 hits) | Arrows arc into the sky, then streak down with green-white trails; dust and splinter impacts around the target; the ground stays studded with arrows for 3 s. | P1 |
| **FERAL FRENZY** (Fenrik, 7 hits, `blood`) | A bestial claw flurry: 7 claw triple-streak cards stacking, blood mist (gore) or a green-black spirit mist (off), and a howl ring at the end. | P1 |
| **DEVOUR** (Maw, 2 hits, `quake`) | A jaw-shaped dark-violet DIST cone, the floor cracking in a bite pattern, violet embers sucked into Maw (inward GP). | P1 |
| **BONFIRE NIGHT** (Hollowjack, `nova`) | Hollowjack's head flares (MAT emissive), a fire nova ring with pumpkin-seed embers, and a burning ring decal that smoulders for 4 s. | P1 |
| Earthshaker (Maw) / Cinder Nova (Ozrel) / Falling Star (Ozrel) / Bat Dive and Shadow Step (Vex) / Heartseeker (Erika) | Class treatment from 2a plus one signature element each: Earthshaker = rubble ring; Cinder Nova = fire-wall ring; Falling Star = meteor trail; Bat Dive = bat-shaped smoke flipbook trail; Shadow Step = dissolve teleport; Heartseeker = spiral wind trail. | P1 |

## 3. Environment and ambient

| ID | Effect | Trigger | Dur | Layers | Tech | Assets | Light | Cost | Tier | Audio | P |
|---|---|---|---|---|---|---|---|---|---|---|---|
| E01 | Torch / brazier fire (concept art) | arena build (`Arena.flame()`, `arenaView.ts:284`) | loop | 2–3 crossed **flipbook** fire cards with sub-frame (motion-vector) blending, a hot core card, a heat DIST card above, a smoke wisp (FB, alpha) rising 1–2 m, embers (GP, seeded), a floor light-pool card plus a **reflection streak card** on the wet floor | FB+DIST+GP+CARD | `fire_loop`, `smoke_wisp`, `glow_pool` | ≤ 4 real lights (high), 2 (M), 1 (L); flicker = deterministic noise of arena time; the others are cards only | ~0.03 ms per brazier (cards); the light is the expensive part | M: no DIST, no wisp. L: 1 card + core | `NEW:fire_loop` (positional) | P0 (most visible env FX) |
| E02 | Embers (local) | from E01, E05, E07, burning | loop | spark-sized GP with curl-noise drift, HDR orange, short motion stretch | GP | `ember` | none | ~0.01 ms | L: 30% | — | P1 |
| E03 | Drifting fog layers | arena build | loop | 6–20 large soft fog cards near the ground (depth-faded, scroll noise, lit by the moon or ambient colour), plus the existing height fog (`fog.ts`) | FB soft (static texture + scrolling) | `fog_card` | none | **overdraw-heavy**: ~0.3–0.6 ms | M: half the cards. L: off (height fog only) | — | P1 |
| E04 | God rays / light shafts | theme (`godrays` param, exists in `post.ts`) + local shaft cards through arches and windows | loop | screen-space rays (exists) + volumetric shaft cards (additive, depth-faded, dust motes inside) | POST+CARD | `shaft_card` | none | ~0.1 ms cards | L: off | — | P2 |
| E05 | Dust motes / petals / snow / sand | exists (`ambient.ts`, GPU, seeded) | loop | keep; add soft depth fade near surfaces and light-direction sparkle | GP | — | — | exists | exists | — | P2 |
| E06 | Ring of fire | `fr.ringS < 0.995` (today `main.ts:740` spawns CPU fire with Math.random) | phase | ring of flipbook fire cards placed deterministically along the ellipse (instanced quads, seeded phase), DIST wall, embers, floor scorch line, glow along the ring | FB+DIST+GP+DEC | `fire_loop`, `fire_wall` | 2 LITE slots follow the ring's nearest point to the camera | ~0.3 ms | M: no DIST. L: half the cards | `NEW:fire_wall_loop` | P1 |
| E07 | Powder keg explosion | `fuse` (spark fountain, exists as glow) then `explosion` | 2.5 | white flash (CARD + LITE 40), fireball **flipbook** (one-shot 48 f), smoke column (FB lit), shock DIST ring, debris (exists), scorch decal (exists), burning fragments (GP), ground fire patches (E08) | FB+CARD+DIST+MESH+DEC+LITE | `explosion`, `smoke_column` | LITE 40 → 0 over 0.6 s | ~0.6 ms peak | M: no DIST, fewer fragments. L: fireball + smoke only | `boom` (exists), `NEW:debris_rain` | P1 |
| E08 | Fire spreading (cosmetic) | explosion, brazier break, `hazard_burn`, fire moves hitting the floor | 3–6 | small burning patches (FB `fire_loop` small) on the floor, seeded positions, a scorch decal left behind; purely visual, never damages | FB+DEC | `fire_loop` | none (cards) | ~0.05 ms each | L: 1 patch | — | P2 |
| E09 | Lava | lava hazard / river (exists `lavaMaterial`) | loop | crust flow (exists), bubbles popping (FB), heat DIST over the surface, rising embers, an orange underglow card on nearby walls | FB+DIST+GP | `lava_bubble` | existing lava light budget | ~0.1 ms | M/L no DIST | `NEW:lava_loop` | P2 |
| E10 | Water splashes + ripples | fighter in water (`hazard_hit` water, position test), knockdown in water, geyser | 0.8 | splash crown (FB), droplets (GP), expanding ripple normal decal on the water surface | FB+GP+DEC | `splash_big`, `ripple` | none | ~0.08 ms | L: crown only | `NEW:splash` | P2 |
| E11 | Geyser eruption | `hazard_trigger` geyser state 2 (exists as a cylinder) | 2 | a column of steam flipbooks stacked, falling droplets, mist ring on the floor | FB+GP | `steam` | none | ~0.2 ms | L: fewer cards | (exists) | P2 |
| E12 | Ice cracking | glacier theme impacts, shatter finisher | 1.0 | crack decal with blue subsurface glow, ice chips (MESH, debris `ice`), frost mist | DEC+MESH+FB | `crack_ice` | none | ~0.05 ms | — | `NEW:ice_crack` | P2 |
| E13 | Wind + leaves | themes with leaves / petals | loop | exists for petals; add a gust system that drives ambient + banners + fire lean from one deterministic wind function of time | GP | — | — | ~0 | — | — | P2 |
| E14 | Destruction dust + falling pillars | `topple` (dust at the base), `topple_impact` (exists debris + crack) | 3 | dust trail from the falling column top (GP along its arc), large dust wall at impact (FB), rubble | FB+GP+MESH | `dust_plume` | none | ~0.3 ms peak | L: half | `stone_slam` | P1 |
| E15 | Chandelier fall | `chandelier_fall`, `chandelier_impact` | 2 | candle flames trailing, impact: sparks + metal chunks + candle fire patches (E08) | FB+GP+MESH | — | LITE 8 | ~0.2 ms | — | `clang` | P2 |
| E16 | Persistent decals | scorch, cracks, frost, mud, wet footprints, blood | match | one decal atlas; floor decals in a **single instanced projected-quad batch** (max 256, oldest fade); fighters walking through blood or mud leave footprint decals for ~10 steps | DEC | decal atlas | none | ~0.05 ms | L: max 64 | — | P1 |

## 4. Status effects on a fighter

The sim states that exist today:
- `buff` (rage and second wind)
- `lastStand`
- `exhausted`
- `fury`
- the `stagger` state
- `hazard_burn`
- `near_death` / `low_hp_state`

Frozen, poisoned and slowed have no sim state yet; they arrive with magic. Build the status system now and hook the existing states.

| ID | Status | Hook today | Visual | Tech | P |
|---|---|---|---|---|---|
| ST1 | Burning | `hazard_burn` + 2.5 s render timer (later: a sim status) | small fire flipbooks attached to 4 bones (spine, arms), embers, smoke, char darkening (finisherFx `uBurn` at 0.15), LITE slot if it is the hero | FB+GP+MAT | P1 |
| ST2 | Frozen | (magic) | frost material layer (finisherFx `uIce` partial), ice crystal meshes on the feet, cold breath vapour | MAT+MESH | P2 |
| ST3 | Poisoned | (magic) | green-black veins (noise mask), dripping, a faint sick aura mist | MAT+GP | P2 |
| ST4 | Bleeding | gore ≥ standard: render-side after a blade hit ≥ 60 dmg, for 3 s | drips from the wound spheres (GP), a floor drip trail of decals while moving | GP+DEC | P1 |
| ST5 | Stunned / staggered | `stagger` event / state, guard_break | head-orbit faint sparks? **No**: cartoonish. Use a dizzy camera-shake on the victim's flinch, a desaturated rim, and dust shaken loose | MAT | P2 |
| ST6 | Slowed | (magic) | dark ground tendrils / frost on the legs, afterimage lag | AFT+MAT | P2 |
| ST7 | Enraged (`rage`, `buff`) | `rage`, `fr.buff > 0` (today: a random ember drip, `main.ts:736`) | a red-orange heat aura: fresnel rim emission + heat DIST column + rising embers + eye glow (head bone card) | MAT+DIST+GP+CARD | P1 |
| ST8 | Last stand | `last_stand`, `fr.lastStand` | a crimson pulsing rim synced to a heartbeat, blood drips (gore), a dark vignette pulse in post when they are on camera | MAT+GP+POST | P1 |
| ST9 | Winded | `exhausted` | breath vapour puffs from the head (cold themes always, other themes faint), slumped (anim) | FB | P2 |
| ST10 | Low health | `low_hp_state`, `near_death` | more wounds visible, heavier drip rate, darker rim, post vignette heartbeat (exists as an audio low-pass), a slight colour drain | MAT+POST | P1 |
| ST11 | Second wind | `second_wind` (today embers + ring) | an inward wind of embers, then a burst; a short fresnel bloom | GP+MAT | P1 |

## 5. Cinematic moments

| ID | Moment | Today | Plan | P |
|---|---|---|---|---|
| CI1 | Freeze-frames (hit-stop) | `director.ts` `hitStopUntil` (0.035–0.35 s); `tickFight` keeps FX running at 8% (`main.ts:669`) | FX use the **FX clock**: sparks and flares keep animating at 15% during a stop (energy reads), smoke freezes, trails hold. Add a per-effect `stopBehaviour: 'freeze' \| 'slow' \| 'real'`. | P0 |
| CI2 | Slow-mo | killcam, parry, launch, destruction (director) | particles honour the FX clock; LITE flicker and screen post run on real time (already the flash-light rule at `main.ts:561`) | P0 |
| CI3 | Speed lines | `ui.speedLines` (CSS) | keep the CSS, add a world-space radial streak card behind the attacker on rush and ultimate starts | P2 |
| CI4 | Colour grade shifts | `post.ts` grade (`desat`, `flash`, `aberration`) | a **grade preset stack**: `finisher` (cold desat + crushed blacks), `ultimate` (accent tint), `lastStand` (red lift), `killcam` (exists), `victory` (warm lift); blended by weight with the theme grade | P1 |
| CI5 | Letterbox | `director.letterbox` + `ui.setLetterbox` | keep | — |
| CI6 | Finisher FX integration | `finisherFx.ts` (bisect, behead, burn, shatter, drain, dissolve) | Do not rewrite. Swap its calls to `vfx.sparks/flash/fire/smoke/embers` for named FX defs (`fin.behead.blood`, `fin.burn.fire`), which get blood flipbooks, a fire flipbook for burn, ice chips + frost decal for shatter, and smoke wisps for drain. Replace its `Math.random()` with the FX RNG. Its material patch (`patchMaterial`) becomes the base of the fighter FX material patch (wounds, rim, status) so there is ONE onBeforeCompile per fighter material. | P1 |
| CI7 | Death (non-finisher kill) | `kill` → 80 sparks + flash + white ring (`main.ts:994`) | gore-dependent: standard = blood burst + body pool (C17) + slow dust settle; magic kills = ash dissolve (finisherFx `burn`/`dissolve`); the white ring is removed (cartoonish) | P1 |
| CI8 | Victory | splash text | slow embers rising around the winner, a god-ray card, warm grade | P2 |

## 6. Post-processing

| ID | Item | Today | Plan | P |
|---|---|---|---|---|
| PP1 | Bloom tuning | UnrealBloom half-res, per-theme threshold 1.3–2.6 | Define an **FX HDR scale**: cores 8–30, bodies 1.5–4, edges below 1, so cores always bloom and bodies do not. Lower the thresholds towards ~1.0–1.2 with lower strength so fire bodies glow softly. Optional: replace UnrealBloom with a dual-filter bloom (13-tap down / tent up, CoD 2014 style): fewer passes, so it is cheaper on the iGPU. | P1 |
| PP2 | Heat distortion | none | a half-res distortion buffer (RG offsets) rendered from the DIST layer; applied in the grade pass (one extra texture fetch) | P1 |
| PP3 | Chromatic aberration on big hits | exists (`aberration`) | drive it from FX defs (values per effect), radial only, capped | P0 |
| PP4 | Vignette pulse | static vignette | `vignettePulse` uniform for last stand / near death | P2 |
| PP5 | Per-moment grade | `desat` only | CI4 | P1 |
| PP6 | Depth of field | BokehPass on medium/high in killcam / react shots (re-renders scene depth) | feed it the shared depth texture (F1), so the extra scene depth render is gone; keep it on the existing shots only | P2 |
| PP7 | Shared depth texture | GTAO and Bokeh each render their own depth/normal pass | one depth texture from the main render; used by soft particles, fog cards, DIST masking, Bokeh, (GTAO if the API allows) | P0 (F1) |
