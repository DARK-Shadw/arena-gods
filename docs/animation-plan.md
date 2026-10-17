# The Animation Overhaul: master plan

**Status: PLAN for review. Nothing in the game has been changed yet.**

**Companion documents:**
- `docs/animation-research.md`: research notes, sources, and techniques ranked by impact vs effort.
- `docs/animation-catalog.md` and `.json`: every clip we own (753), measured and tagged.
- `docs/animation-pairs.json`: alignment probe for paired (two-actor) clips.
- `tools/anim/*`: the analysers that produced the data (re-runnable).

The goal, in the user's words: *"this game heavily relies on animation and characters feeling real"*. For a spectator game, that means four things:
1. **Every action has a readable cause and effect.** Wind-up, then contact, then reaction, then recovery. The contact frame is visible.
2. **Nothing repeats noticeably.** Two knockdowns, two deaths or two entrances are never the same.
3. **Characters are individuals.** Gorak moves, idles, celebrates and dies differently from Vex.
4. **Big moments are staged.** Entrances, finishers and turning points have choreography and camera, like Mortal Kombat or Shadow of War.

---

## 0. Where we are today (diagnosis)

| Area | Today | Problem |
|---|---|---|
| Clip use | 117 of 753 owned clips (16%) are used | Huge untapped library |
| Hit reactions | 4 per fighter (front/left/right/back), fixed mapping | The same flinch every time. No height or severity |
| Deaths | **1 clip per fighter** | Every death of a fighter looks identical |
| Knockdown | The death clip, played to 55% and held, then the get-up clip | It reads as "death, then reverse". No variety |
| Get-up | 1 clip per fighter | Repetitive |
| Dodges | 3 shared clips (Longbow pack) | Everyone dodges like an archer |
| Transitions | Normalised-weight crossfade, fade 8–30/s | Pops on interrupts, mushy blends, foot sliding |
| Attack timing | The clip is time-warped so its strike frame lands on the sim's active frame | Good: contact is consistent. This must be preserved |
| Root motion | The converter locks hips X/Z, so every clip plays in place | 230 Mixamo_HF clips that travel (flips, takedowns, leaps) would moonwalk |
| Paired actions | Only one: the throw-object clip | No grabs or finishers |
| Faces | No blendshapes on any model; eye bones on 6 of 8 fighters | Expression must come from head, eyes and body |
| Entrances | Hand-authored gate-local keyframes with absolute-time cues | Breaks when arenas differ (see the two bugs) |

### The two reported bugs: root causes

**Bug 1: "Gorak breaks the cage but there's no animation of how."** (`src/data/entrances.ts` gorak + `src/cinematic/entrance.ts` `gate_shake` / `gate_smash`)
- From t = 0 to 2.15 s the actor is keyed as `state: 'idle'` at gate-local `z = -4`, deep inside the dark tunnel.
- The three `gate_shake` cues at 0.3, 0.95 and 1.55 s only nudge `portcullis.position.z` for 90 ms. Nothing in Gorak's body does anything at those moments, and he is barely visible.
- At 2.15 s `gate_smash` launches the portcullis on a canned velocity in the **same tick** that Gorak switches to `run`.
- **Root cause:** cues are bound to absolute timeline seconds, not to animation events. There is no clip that contacts the gate, no hand-to-bar contact, and no wind-up before the break. The camera frames the gate, not the cause.

**Bug 2: "Vex flies down from the middle of nowhere, depending on the arena."** (`entrances.ts` vex)
- Vex starts crouched at gate-local `[0, 5.35, 0.1]`. That height was tuned for the old night arena's gate lintel.
- In the generated arenas, each theme builds a different gate:
  - colosseum pediment top: about 7.4 m
  - torii beam: 5.6 m
  - moon gate: about 5 m
  - sky-temple pylons with a floating halo and *nothing* between them
  - glacier ice arch: none
- On most themes the perch doesn't exist, so he is crouching on air. The `airborne` key then uses the looping `fall` clip with a 1.2 m arc, which reads as flying.
- **Root cause:** entrances have no notion of the arena's actual structure (anchors) and no validation step.
- Hollowjack has the same flaw: he "leaps from the stands" at `[3.5, 5, -2.5]`, and stands only exist in the colosseum.

Both fixes are designed in §H.

---

## A. Target architecture

```
                    OFFLINE                                       RUNTIME
 Assets/*.fbx ──► tools/anim/analyze ──► animation-catalog.json
                         │                                 ┌─────────────────────────────────────┐
                         ▼                                 │ SIM (deterministic, authoritative)  │
 converter v2 ──► per-fighter GLB (base set)               │  ActionDefs reference ClipVariants  │
            ├──► shared clip libraries (by category,       │  (timing, reach, root profile come  │
            │     meshopt animation-only GLBs, on demand)  │   from anim.gen) ; seeded variant   │
            ├──► mirrored variants (generated + verified)  │  choice + variety memory ; paired   │
            └──► src/sim/anim.gen.ts  (timing / events /   │  scenes ; records clip id per action│
                  root curves / pair offsets / reach)      └──────────────┬──────────────────────┘
                                                                          │ MatchRecord (frames +
                                                                          ▼  events incl. clip ids)
                                                           ┌─────────────────────────────────────┐
                                                           │ RENDER: FighterAnimator             │
                                                           │  ClipSelector (cosmetic variety)    │
                                                           │  PoseGraph: sample → layer/mask →   │
                                                           │  additive → inertialize → warp →    │
                                                           │  look-at → IK → springs → bones     │
                                                           │  SceneDirector (paired/cinematic)   │
                                                           └─────────────────────────────────────┘
```

### A.1 Sim/render contract (determinism stays intact)

- The **sim decides everything that changes outcomes**: which action, which *timing variant* of it, displacements, contacts, damage, paired-scene start and alignment. It decides from **precomputed clip data** in `src/sim/anim.gen.ts`, generated offline like today's `reach.gen.ts`. It never reads a pose at runtime.
- The sim records the **chosen clip id** in the event (`attack_start {move, clip}`, `hit {..., reactClip}`, `knockdown {clip, getupClip}`, `scene_start {scene, roles}`).
- The **renderer decides only cosmetics**:
  - which of several *timing-identical* clips to show (flinch flavours, idle fidgets, gestures)
  - additive springs, look-at and IK
  - It uses a renderer RNG seeded from the match seed, so a replay looks identical.
- **Rule:** if two clips differ in duration, reach, contact time or displacement by more than the tolerance (±15% time, ±0.1 m reach), the choice between them is a sim choice.

### A.2 Offline clip data (`anim.gen.ts`): the sim's view of every clip

```ts
interface ClipData {
  id: string;                 // 'HF/finishers/Stomp' | 'HF/finishers/Stomp~M' (mirrored)
  dur: number;
  events: {
    anticipation?: [number, number];  // wind-up segment (start, apex)
    contact?: number[];               // strike / impact frames (multi-hit)
    release?: number;                 // projectile or prop release (hand speed peak)
    recoverable?: number;             // earliest cancel / blend-out frame
    land?: number;                    // airborne -> ground contact
    groundTouch?: number;             // body hits the floor (deaths / knockdowns)
    footPlants: [number, number][];   // per-foot planted intervals (for foot locking)
  };
  root: { t: Float32Array; x: Float32Array; z: Float32Array; yaw: Float32Array }; // extracted root motion, 30 Hz
  reach?: number[][];               // strike-point samples (as today's reach.gen)
  startPose: PoseFeature; endPose: PoseFeature; // hips height, foot and hand positions rel. hips (matching)
  posture: 'stand'|'crouch'|'kneel'|'ground' /* start */; postureEnd: ...;
  tags: { cat; stance; dir?: 'F'|'B'|'L'|'R'; height?: 'head'|'torso'|'legs'; severity?: 1|2|3|4; weightClass?: 'light'|'mid'|'heavy' };
}
```

Most of this already exists in `docs/animation-catalog.json` (analyser v1). The work is to make the extraction precise per category: contact frames for hits and deaths, anticipation segments, recoverable frames.

### A.3 FighterAnimator: render-side pose pipeline

We stop relying on `AnimationMixer`'s normalised weights for everything. The mixer has no masks, no pose-relative additives, no inertialization and no IK. Instead there is a small **PoseGraph** over a flat pose buffer. Clips are still sampled with three's `KeyframeTrack` interpolants (fast, already loaded), but blending is ours.

```ts
class PoseBuffer { q: Float32Array /* nBones*4 */; hips: Float32Array /* 3 */ }
interface Layer { name: 'base'|'upper'|'additive'|'face'; mask: Float32Array /* per-bone weight */; ... }

per frame:
  1. base     = Locomotion blend tree (speed x direction x stance, phase-matched)
                OR full-body Action clip at sim-driven time (time-warp as today)
  2. upper    = masked overlays: carry, block-while-walking, talk gestures, aim, spell charge
  3. additive = spring flinch (hit point + direction + strength), breathing amplitude,
                fury tremble, injured sway (pose-relative, not clip-relative)
  4. inertialize: on any discontinuity (new action, interrupt) store offset + velocity,
                decay with Bollo's quintic (or dead blending); then add it in
  5. warp     = root warp: clip root curve -> sim's start/end transform (skew warp)
  6. look-at  = head / neck / spine / eyes toward the focus target, clamped, weighted per state
  7. IK       = foot lock during plants (analytic two-bone), hand targets for grabs, props and bars
  8. springs  = secondary motion (weapon wobble, cloth / hair bones if present, belly / shoulder pads)
  9. write    = bones (one pass) ; the skinned mesh renders
```

- **Cost estimate:** 2 fighters × ~70 bones × (2–4 samples + ~10 quaternion operations) ≈ 3–5 k quaternion operations per frame, well under 0.5 ms in JS.
- The current carry-overlay (`AnimController.setOverlayPose`) is a one-layer prototype of step 2.

### A.4 Transitions (inertialization)

- Each `(fromCategory, toCategory)` pair has a transition rule in a table, so tuning is data, not code:
  - blend time
  - curve: inertial or dead-blend
  - phase-match yes/no
  - whether to keep the upper-body layer

| from → to | time | notes |
|---|---|---|
| any → hit/stagger | 0.06–0.10 s | Snappy. The flinch must start on the contact frame |
| attack → attack (combo) | 0.10 s | Enter the next clip at its anticipation start |
| idle/locomotion → attack | 0.12 s | |
| attack recovery → locomotion | 0.25 s | Phase-matched entry into the cycle (Bollo) |
| knockdown → get-up | 0.15 s | The get-up start pose is matched to the fall's end pose (§D) |
| anything → paired scene | 0.20 s | During the 0.2 s alignment window |

### A.5 Variation memory (sim and render)

```ts
class VarietyPool<T> {
  entries: { item: T; w: number; mirror?: T }[];
  recent: RingBuffer<T>;              // per fighter, last N picks
  pick(rng, ctx): T                   // weight *= featureScore(ctx) * noRepeat(recent) * cooldown(time since last use)
}
```

- `featureScore` scores the context: hit direction and height, severity, space behind (from the arena layout), weapon class, current posture or stance, and the opponent's size class.
- `noRepeat`: weight 0 if picked last time, and ×0.25 if picked within the last 3 picks or 8 s.
- Mirrored variants share the original's cooldown with a softer penalty, so the same move from the other side is acceptable.

---

## B. Per-system designs (with clip mapping)

Clip ids below refer to `docs/animation-catalog.md`:
- `HF/` means `Assets/Animations/Mixamo_HF/`.
- `HF2/` means `Mixamo_HF2/`, fetched this round.
- Pro packs are named by pack.
- `~M` means a mirrored copy, generated.

### (a) Locomotion, idles and stances

- **Blend tree per stance:**
  - Each stance has its own set: unarmed, 1h-axe, sword-shield, bow, caster, greatsword, creature, brawler.
  - Within a stance, clips are picked from (forward, back, strafe left/right, run) by local velocity, as today, with speed-matched playback within ±20% (Lyra's rule). Beyond that, stride warping scales the pelvis-to-foot horizontal offsets.
- **Starts, stops and pivots:** `HF2/locomotion_style/Start_Walking`, `Stop_Walking`, `Run_To_Stop`, `Quick_180_Turn`, `Standing_Turn_Left/Right_90`, plus pack turns.
  - These are triggered when the sim velocity crosses thresholds or the facing error exceeds 70°.
  - They play as short overlays with foot locking, so turns don't skate.
- **Condition gaits** (the selector swaps the walk/run set):
  - **Injured** (HP < 30%): `Injured_Walk`, `Injured_Run`, `Injured_Idle`, `Injured_Hurting_Idle`
  - **Near death** (HP < 12%): `Injured_Stumble_Idle`
  - **Exhausted / winded**: `Running_Tired`, `Breathing_Idle`
  - **Stunned / guard-broken**: `Dizzy_Idle`, `Drunk_Walk`
  - **Enraged** (buff): faster tempo plus the brute idles `Orc_Idle`, `Offensive_Idle`
- **Idle sets per profile:** 3–6 idles plus fidgets every 4–9 s, each a one-shot over the idle loop (the look-around idles, weapon checks).
  - Examples: `Ninja_Idle`, `Warrior_Idle`, `Orc_Idle 1/2`, `Bouncing_Fight_Idle`, `Fighting_Idle`, `Knife_Idle`, `Zombie_Idle`, the Mma and Box idles, `2hand_Idle`, `Great_Sword_Idle 1–5`.
- **Gait personalities:** `Orc_Walk` (Gorak/Warrok), `Dwarf_Walk` (Goblin/Castle Guards), `Old_Man_Walk` (Ganfaul), `Zombie_Walk` and `Walker_Walk` (Skeletonzombie, Parasite), `Scary_Clown_Walk` (Whiteclown), `Sneak_Walk` (Nightshade), `Swagger_Walk` and `Strut_Walking` (Pirate, Vex in pride mode), `Female_Tough_Walk` (Eve, Kachujin).

### (b) Attacks

- **Per-weapon moveset libraries.** Counts are owned clips; several are mirrorable.

  | Weapon | Sources |
  |---|---|
  | 1h axe | ProMeleeAxe (12 attacks) |
  | Sword + shield | ProSwordandShield (5 slashes, 4 attacks, kick) + `HF2/weapons/Sword_And_Shield_*` |
  | Greatsword | `HF/weapons_extra/Great_Sword_*`: 5 slashes, high spin, jump attack, slide attack, kicks |
  | 1h sword | `One_Hand_Sword_Combo`, `Stable_Sword_In/Outward_Slash`, `HF2/weapons/Thrust_Slash`, `Slash_Advance`, `Run_And_Swing` |
  | Club / torch | `Standing_Torch_Melee_Attack_01–05/Stab`, `One_Hand_Club_Combo`, `HF2 Two_Hand_Club_Combo`, `Heavy_Weapon_Swing` |
  | Dual / dagger | `Dual_Weapon_Combo`, `Double_Dagger_Stab`, `Stabbing 1–3` |
  | Spear | `HF2/weapons/Upward_Thrust`, `Bayonet_Stab` |
  | Unarmed boxing | `HF/brawler_kicks`: 10 Boxing, 6 Hook, 6 Lead_Jab, Jab_Cross, Body_Jab_Cross, Quad_Punch, elbows, knees |
  | Kicks | 6 Mma_Kick, Roundhouse, Side, Scissor, Hurricane, Spin_Flip, Inside_Crescent, Drop_Kick, Flying_Kick + HF2 martial |
  | Creature | Creature pack |

- **Move to variant pool:** each sim move (e.g. `gorak.cleave`) gets 1–4 interchangeable clips with matched timing class:
  - an anticipation segment of at least 0.15 s
  - contact frames normalised by time-warp
  - reach within ±0.1 m
  - The sim chooses the variant (seeded, with variety memory). `reach.gen` becomes per-variant.
- **Mirroring:** the mirror (`~M`) of an asymmetric unarmed or two-handed clip is a free extra variant.
  - **Never mirror clips with a one-hand weapon** unless the weapon prop also swaps hands. We won't do that for shield or axe users.
  - 248 clips are asymmetric enough to benefit.
- **Travel attacks** (gap closers, flying kicks, slide attacks, run-and-swing):
  - The sim's lunge uses the clip's **root curve** as its displacement profile, scaled to the needed distance, clamped to 0.75–1.25×.
  - The renderer applies the same scale, so the feet match.
  - This replaces today's generic lunge.
- **Combo chains:** the multi-hit clips (`Standing_Melee_Combo_Attack_1–3`, `Punch_To_Elbow_Combo`, `Knee_Jabs_To_Uppercut`, `Elbow_Uppercut_Combo`, `Flying_Knee_Punch_Combo`) provide authentic strings. The sim uses their measured contact frames for the per-hit windows. Today they are spread uniformly.
- **Hit-stop asymmetry** (render):
  - On contact, the attacker's pose freezes for 2–6 frames (by weight and severity) while the victim's flinch starts.
  - Heavy blows add a 1-frame hold on the victim at maximum deformation.
  - This is render-only: it is a display clock offset per actor that catches up at 1.5× afterwards.

### (c) Defence

- **Block:**
  - Stance-specific block idles: `Great_Sword_Blocking 1–3`, `sword and shield block idle / crouch block`, `Standing_Block_*`, ProMagic block start/end.
  - Block impacts by strength: small = an additive spring on the arms and spine; large = `standing block react large` clips.
  - **Guard-break** = `Standing_Block_React_Large_2` plus `Dizzy_Idle` (or `Stunned`).
- **Parry:** use the block-react large clips with a 3-frame hold. The attacker plays a deflection: a mirrored small hit react plus a weapon-arm spring kick. Freeze-frame staging is in (i).
- **Dodges, chosen by direction × space × profile** (38 owned):
  - Agile: `Backflip 1/2`, `Front_Flip`, `Aerial_Evade`, `Corkscrew_Evade`, `Stylish_Flip` for Vex and Kachujin.
  - Grounded: `Dive_Roll`, `Roll_Left~M`, `Sprinting_Forward_Roll`, `Stand_To_Roll`.
  - Measured: `Short/Medium/Long_Left/Right_Side_Step`, `Jump_Backward`, `Dodging_Back`.
  - Capoeira: `Esquiva_1`, `Queshada_1/2`, `Macaco_Side`.
  - Ducking: `Ducking 1/2`, `Evading_A_Threat`.
  - The sim's dodge displacement comes from the chosen clip's root curve (warped to the free space).

### (d) Hit reactions, knockdowns, get-ups, deaths

- **Reaction key** = direction (F/B/L/R from the hit vector vs facing) × height (head/torso/legs from the strike point's height) × severity (1 flinch, 2 stagger, 3 big stagger/launch, 4 knockdown) × weapon (blade/blunt/magic/projectile) × weight class.
- **Auto-tagging:** direction and severity are measured from each clip's hips and head displacement (the analyser already outputs root dx/dz and head motion). Height comes from the name, then gets verified. There are 90 hit-react clips plus 16 knockdowns.
- **Severity 1:** no clip switch. A **spring additive** on spine, neck, head and the hit-side clavicle (procedural, unique every time) plus a 0.1 s face/head snap.
- **Severity 2–3:** a pool, e.g.:
  - Head: `Head_Hit 1–5`, `Big_Hit_To_Head 1–3`, `Receive_Uppercut_To_The_Face`, `Struck_In_Head`
  - Body: `Hit_To_Body 1–5`, `Big_Stomach_Hit`, `Big_Kidney_Hit`, `Big_Rib_Hit`, `Receive_Stomach_Uppercut`, `Taking_Punch`
  - Side: `Hit_On_Side_Of_Head/Body`, `Big_Side_Hit`
  - Back: `Hit_On_The_Back`, `Hit_On_Back_Of_Head`, `Standing_React_Large_From_Back_2`
  - Spin-out: `Shoved_Reaction_With_Spin`
  - Stumble: `Stumble_Backwards`
- **Knockdown family:**
  - Falls: `Fall_Flat`, `Fall_Over`, `Falling_Down`, `Knocked_Down`, `Livershot_Knockdown`, `Shoulder_Hit_And_Fall`, `Sweep_Fall`, `Tripping`
  - Launch: `Hit_By_Car`, `Receiving_A_Big_Uppercut`
  - Wall: `Wall_Crash`
  - **Ground state:** the fallen pose is held with a breathing additive.
  - **Get-up:** chosen by the fall's end pose (prone vs supine, measured) plus profile:
    - `Getting_Up 1–4`, `Stand_Up 1–3`, `Zombie_Stand_Up 1–3`
    - agile: `Kip_Up`, `Corkscrew_Kip_Up`
    - slow / injured: `Waking`
  - The sim stores the knockdown's ground time from the chosen get-up clip's duration, so this is a sim choice.
- **Wall and pillar slams:** `Wall_Crash`, or a big stagger with root warped *into* the wall contact point. Camera shake starts at the clip's contact.
- **Deaths** (41): picked by the killing blow's direction and severity, the weapon, the space behind (don't fall *into* a wall), and the profile.
  - Direction-specific: `Standing_Death_Left/Right 01/02`, `Death_From_The_Front/Back`, `Death_From_Front/Back_Headshot`, `Death_From_Right`
  - Big hits: `Flying_Back_Death`, `Falling_Back_Death 1/2`, `Falling_Forward_Death`
  - Kneeling: `Crouch_Death`, `Dying 1/3/5/8`
  - KO: `Knocked_Out`, `Knocked_Unconscious`, `Turn_To_Knocked_Unconscious`
  - Weapon / creature: `Two_Handed_Sword_Death 1/2`, the S&S deaths, ProMagic `Standing React Death *`, `mutant dying`, `Zombie_Dying`
- **Ragdoll-lite settle:** for 0.3 s after `groundTouch`, run spring relaxation on the spine and limbs plus ground IK for the hands and head on uneven rubble. It is render-only.

### (e) Grabs, throws, takedowns, finishers and executions

**Key finding from the pair probe** (`tools/anim/pairs.ts` → `docs/animation-pairs.json`):
- Only **3 pairs are exported in a shared world frame**, so their relative transform is known: `Shoulder_Throw_Aggressor/Victim` (start distance 4.25 m), `Hell_Slammer_A/B` (1.79 m), `Rockin_Shackle_A/B` (1.6 m).
- Every other pair was re-centred by Mixamo, so both actors start at the origin. **Their alignment is lost and must be solved.**
- A grid-search solver (minimise body interpenetration, require effector-to-body contact) finds zero-penetration placements for all of them. On its own, though, the problem is under-constrained: it happily finds "any touch".
- **So each pair needs a small hand-authored contact spec** (frame window + aggressor effector + victim body part). For example:
  - Strangling: both hands on the victim's neck, t = 1.0–15 s
  - Double-leg takedown: attacker shoulder to victim waist at the shoot frame
  - Vampiric bite: head to neck
- With that spec, the solver output is meaningful, and the lab tool (§K) verifies it visually.

**Paired scene system:**

```ts
interface PairedScene {
  id: string;
  roles: { aggressor: ClipRef; victim: ClipRef };   // clip ids incl. trims (in/out times)
  align: { dx: number; dz: number; dyaw: number };  // victim root rel. aggressor at t0 (measured or solved)
  contacts: { t: number; aggr: Effector; vict: BodyPart; tolerance: number }[];  // authored + verified
  events: { t: number; type: 'damage'|'kill'|'camera'|'fx'|'sfx'|'freeze'; data?: any }[];
  requirements: { victimState: ('stagger'|'guardbreak'|'knockdown'|'lowhp'|'winded')[]; minSpace: number;
                  sizeClass?: [min, max]; stances?: Stance[]; hazard?: 'lava'|'spikes'|'pillar'|'wall'|'none' };
  camera: CameraTrack;  // authored shots relative to the pair frame
  outcome: 'finisher'|'damage'|'swap';  // finisher kills; others are mid-fight grabs or throws
}
```

- **Sim side:**
  - When a scene triggers, both fighters enter `scene` state.
  - Over 0.2 s the sim moves the victim and aggressor to the aligned transforms (deterministic, clamped).
  - Then both follow their clips' root curves on a shared clock. Damage, kill and hazard effects fire at the scene's contact events, which keeps the "visible contact" rule.
- **Size mismatch** (Maw at 1.3× vs Vex at 1.0×): the offset is scaled by the actors' hips heights, and contact IK pulls the hands onto the victim's actual bones within 0.15 m. Scenes beyond a ratio limit (e.g. choke lift on a giant) are excluded by `requirements.sizeClass`.

**Finisher rules ("MK-style"):**
- A finisher can replace the killing blow when **all** of these hold:
  1. The blow would be lethal, or the victim is below 8% HP and staggered, guard-broken or knocked down.
  2. The killer passes a chance from their pride and bloodlust traits plus how dramatic the fight was. Finishers are rarer in one-sided fights.
  3. A scene exists whose requirements match: stances, space, hazard nearby.
  4. Not the same finisher as last match for that fighter (cross-match memory, seeded).
- **Staging:**
  - Anime freeze on trigger: 0.35 s hold of both actors, speed-lines and desaturation, a camera snap to the scene's first shot.
  - The authored camera track runs.
  - Slow-mo on the kill contact. The victory beat follows.
- **Environmental finishers** use arena data (the sim already knows hazards and cover): a throw into lava or spikes, a pillar push-topple, a wall slam, a chandelier drop.

**Finisher concept catalogue:** 20 concepts. Each is aggressor clips → victim clips. NEW = fetched this round.

| # | Name | Aggressor | Victim | Who | Alignment |
|---|---|---|---|---|---|
| 1 | **Shoulder Throw & Stomp** | `Shoulder_Throw_Aggressor` → `Stomp` | `Shoulder_Throw_Victim` → hold → death settle | brawlers, Aldric (shield dropped) | shared frame ✔ |
| 2 | **Hell Slammer** | `Hell_Slammer_A` (trim to 4 s) | `Hell_Slammer_B` | Maw, Warrok, Gorak | shared frame ✔ |
| 3 | **Rockin' Shackle** | `Rockin_Shackle_A` | `Rockin_Shackle_B` | Hollowjack, Pirate | shared frame ✔ |
| 4 | **Double-Leg Takedown & Ground Pound** | `Double_Leg_Takedown_-_Attacker_2` → `Holding_Down` (NEW) + punch loop (Boxing clips on the upper layer) | `..._Victim_2` (NEW) → laying hold | Fenrik, Hollowjack, Prisoner | solve + spec |
| 5 | **Choke Lift** | `Superhuman_Choke_Lift` | Hang pose: the start of `Being_Strangled` (NEW) with leg-kick springs, then drop to `Knocked_Out` | Maw, Warrok, Demon, Uriel | contact spec: right hand to neck |
| 6 | **Strangle** | `Strangling` (NEW, trim) | `Being_Strangled` (NEW) | Nightshade, Prisoner | solve + spec |
| 7 | **Vampire's Kiss** | `Vampiric_Bite` (NEW) | `Getting_Bit` (NEW) → `Crouch_Death` | **Vex signature** | solve + spec |
| 8 | **Feast** | `Zombie_Neck_Bite` | `Getting_Bit` → `Zombie_Dying` | Skeletonzombie, Parasite, Fenrik | spec |
| 9 | **Silent Blade** | `Stealth_Assassination_2` | `Stealth_Assassination` | Nightshade, Akai, Vex | solve (from behind) |
| 10 | **Brutal Assassination** | `Brutal_Assassination_2` | `Brutal_Assassination` | Kachujin, Akai | solve |
| 11 | **Hostage Gloat** | `Taken_Hostage_-_Villain` → taunt held → `Release_Hostage_-_Villain` shoves the victim **into a hazard or spikes** | `Taken_Hostage_-_Victim` → `Release_Hostage_-_Hostage` → hazard death (`Edge_Slip`, burn) | Pirate, Whiteclown, Gorak | solve + hazard check |
| 12 | **Cheap Shot** | Front kick (`Mma_Kick_3`) → `Illegal_Headbutt` | `Kick_To_The_Groin_2` (owned) → `Kick_To_The_Groin_3` (NEW, collapse) | Hollowjack, Whiteclown, Pirate, Goblin | contact warp |
| 13 | **Gut & Twist** | `Stabbing_2` → `Stabbing_3` | `Big_Stomach_Hit` → `Crouch_Death` | Vex, Nightshade, Kachujin | contact warp |
| 14 | **Impale** | `Bayonet_Stab` / `Upward_Thrust` (NEW) | `Getting_Hit` (held) → `Falling_Back_Death` | Heraklios, Knight, Aldric | contact warp |
| 15 | **Executioner's Plunge** (on a downed foe) | `Great_Sword_Casting` (overhead two-handed plunge to the ground) | Lying hold + spring jolt | Knight, Heraklios, Uriel; Gorak with the axe variant `standing melee attack downward` | downed-victim placement |
| 16 | **Curb Stomp** (on a downed foe) | `Stomp` / `Stomping` | Lying hold + jolt | Maw, Gorak, Warrok | downed placement |
| 17 | **Pillar Fall** (environment) | `Push_Start` → `Pushing` (NEW): pushes a damaged column | Staggered victim → the existing column-crush → death | anyone near cover + victim in the fall line | sim: topple direction |
| 18 | **Into the Fire** (environment) | `Grab_And_Slam` or `Flying_Shoulder_Throw` (travels 6 m, so warp it) | `Getting_Thrown` → `Edge_Slip` / `Teeter` (NEW) → lava burn death | Forge, desert fire pits, sky-temple edge (fall into the clouds!) | contact warp + hazard path |
| 19 | **Thunderstrike** (spell) | `Charge` → `Two_Hand_Spell_Casting` (sustain) | `Being_Electrocuted` (NEW) → `Knocked_Out` | Uriel, Ganfaul, Medea, Ozrel (fire variant: burn) | ranged, no contact |
| 20 | **Flying Knee KO** | `Flying_Knee_Punch_Combo` (travel warp) | `Receiving_A_Big_Uppercut` → `Flying_Back_Death` | Kachujin, Fenrik, Vex | contact warp |

**Non-lethal paired moves** (mid-fight variety; the sim treats them as grab actions):
- `Double_Leg_Takedown` → mount → release
- `Shoulder_Throw` as a throw-for-damage
- `Fist_Fight_A/B` as a staged clinch exchange
- `Headbutt` / `Illegal_Headbutt` from a clinch
- `Soccer_Tackle` / `Soccer_Trip` as charge takedowns with travel
- `Hold_Off_Assailant` is a seated clip, so it is excluded

**Escapes:** `Restrain` (NEW) as a grab with a struggle outcome.

**Throws of props** (existing system):
- Upgrade to weight classes:
  - light, one hand: `Pick_Up_Item` then `Throw`
  - medium: `Throw_Object` (current)
  - heavy: `Lifting` with `Holding_Idle` / `Holding_Walk` (NEW) as the carry pose, and `Throwing` (a heavy two-handed heave) on release
- Also `Putting_Down` (NEW) to drop.

### (f) Spells and ranged

- **Per caster archetype, a cast set** built from:
  - `ProMagic` (1H attacks 1–3, 2H attacks 1–5, area attacks 1–2, cast spell 1H/2H)
  - `HF/spells`: Casting_Spell, Charge, Magic_Heal, Magic_Spell_Casting, Spell_Cast, Spell_Casting, Two_Hand_Spell_Casting, Wide_Arm_Spell_Casting, Great_Sword_Casting / Power_Up
  - S&S casting
- **Events from the analyser:**
  - `release` = the casting hand's speed peak. Hand selection comes from per-hand peaks. The VFX spawns at the correct hand and flies from it.
  - `anticipation` = the wind-up segment. It can be **held / looped while charging** (the sim's windup stretches for charged spells).
- **Same-skin variety:** Ozrel-like mages differ per run via a **cast-style profile**:
  - dominant hand (with `~M` mirrors)
  - one-hand flick vs two-hand push vs wide-arm channel vs staff-like slam (`Great_Sword_Casting`)
  - charge style: a held wind-up with a rising glow, or rapid-fire
  - colour/element tint
- **Projectile VFX attach points:** `castWorld()` becomes per-clip (left or right hand, or both mid-point).
- **Bow** (Erika): ProLongbow draw / overdraw / recoil is already used. Add the draw-time hold (aim) as a looped segment, `standing equip/disarm bow` for entrance and outro, plus melee fallbacks (kick, punch).

### (g) Environmental interactions

- **The cage / gate break** (Gorak's entrance; designed in §H). Barrier types and their actions:
  - portcullis: grip + shake, then smash
  - doors: shoulder `Bash`
  - rope or veil: cut or walk through
  - lever: `Pulling_Lever` raises the gate
- **Pillar push-topple:** `Push_Start` → `Pushing` (root advances 0.3 m) → the column leans.
  - The sim's existing topple uses the push direction. The column starts falling at the clip's push-peak frame, with hand IK on the column surface.
  - Available as an AI tactic for brutes with `envCunning`, and in finisher #17.
- **Props:** the weight classes above, plus `Pull_Heavy_Object` (drag a barrel), `Picking_Up_Object` and `Putting_Down`.
- **Rim, ledge and edge:**
  - `Teeter` + `Edge_Slip` when knocked near a lava rim or the sky-temple edge, as a cosmetic near-miss beat.
  - The sim can keep fighters inside, but a "teeter" stagger variant makes edges dramatic.
- **Climbing over the rim** (sky temple, moon lake): `Climbing_To_Top` and `Freehang_Climb` for entrances, and possibly for "pulled back up" recoveries in later rounds.

### (h) Entrances, outros, taunts, talking: the arena-aware framework

**1. Stage anchors.** Every theme's dressing publishes `StageAnchors` per gate. They are computed from the actual geometry it built, so they can't drift from the visuals.

```ts
interface StageAnchors {
  mouth: Transform;                        // gate opening, inward facing (exists today as Gate)
  tunnel?: { depth: number; height: number; lit: boolean };   // walk-out space behind the barrier
  barrier: { kind: 'portcullis'|'doors'|'veil'|'rope'|'none'; mesh: Object3D; width: number; height: number;
             breakPieces?: Object3D[]; gripPoints?: Vector3[] /* hand IK targets on bars */ };
  perches: { pos: Vector3; height: number; facing: number; reach: 'climb'|'appear' }[];   // real surfaces: lintel top, wall top, pylon cap
  rimEdges: { pos: Vector3; outward: Vector3; drop: number }[];                            // platform edges over void / water
  stands?: { pos: Vector3; height: number }[];                                              // crowd tiers (colosseum)
  floorSpawns: Vector3[];                                                                   // open floor for emerge-from-ground
  heroMarks: Vector3[];                                                                     // where to stop and pose (z≈8 today)
}
```

**2. Entrance = beats with requirements and fallbacks.** No absolute-time cues for physical events.

```ts
interface EntranceBeat {
  id: string;
  needs?: (a: StageAnchors) => boolean;                 // e.g. a perch >= 2.5 m with a visible approach
  actor: { clip: ClipRef; from: AnchorRef; to: AnchorRef; warp: 'root'|'curve'; ik?: IKTargets };
  sync: { event: 'contact'|'land'|'release'|'apex'; do: 'barrier.break'|'barrier.shake'|'dust'|'shake'|'sfx:...' }[]; // fired AT the clip's event frame
  camera: ShotRef;                                      // framed on the CAUSE first, then the effect
}
interface EntranceSpec { variants: { when: (a) => boolean; beats: EntranceBeat[] }[] }   // first variant whose needs pass
```

- Cues such as `barrier.break` are bound to **animation events** (the clip's measured contact frame). They are not bound to timeline seconds.
- That makes "the cage shakes without being touched" impossible by construction.

**3. Validation (headless, in CI).** `tools/anim/entrance-validate`:
- For every fighter × theme × layout × gate, the entrance timeline is simulated without rendering.
- **Asserts:**
  - **support:** the actor's feet are on a surface (raycast to colliders) except during declared airborne beats, and those start and end on supports
  - **visibility:** the actor's head projects inside the frame (NDC within 0.8) at every beat's key frame
  - **occlusion:** a camera-to-head ray is clear
  - **no interpenetration:** the actor capsule does not intersect static geometry
  - **causality:** every `barrier.*` event coincides with an actor contact within 0.1 m of the barrier
- The report lists failures, and the build fails on any.

**4. The two fixes.**

**Gorak: "The Cage Breaker".** Uses the portcullis and doors variants.

| Beat | Time | What happens |
|---|---|---|
| 1 | 0–1.2 s | Tunnel light comes on. Gorak is **seen behind the bars**: the gate-local z is -0.8 (not -4). The camera is inside the arena at chest height, looking through the bars. |
| 2 | 1.2–2.6 s | Grip and shake: `Banging_Fist` (NEW), hands IK'd to `gripPoints`. Each `contact` event fires `barrier.shake` (bars bend 2–4°, dust from the top rail, clang). Two cycles, faster the second time. |
| 3 | 2.6–3.1 s | Steps back 1 m (walk-back). The camera pulls back to a medium-wide shot. |
| 4 | 3.1–4.0 s | Wind-up: `standing melee attack downward` (owned, axe) or `Bash` (NEW, shoulder charge; used for doors). **`barrier.break` at the clip's contact frame:** bars fly inward along the strike direction (pre-fractured pieces), with a 0.25 s slow-mo on the impact and a cut to the reverse angle as the pieces fly. |
| 5 | 4.0– | Strides out through the debris, then roar, then taunt (as today). |

Variants by barrier type:
- **Veil** (sky temple): he rips through it with an arm sweep.
- **Rope** (torii): he cuts it with the axe.
- **None** (glacier): he smashes an ice-arch crystal instead, using the same beats on the crystal.

**Vex: "From the Dark".** Variants are tried in order; the first whose anchors validate wins.

1. **Perch drop** (needs a perch at least 2.5 m high with a visible approach): colosseum pediment, desert lintel, forge arch, torii beam, moon-gate roof.
   - Opening shot: Vex crouched *on the actual surface*, framed with the structure.
   - Then eyes glint, then `Jumping_Down_6` (NEW) with the root warped from the perch to the landing mark, `land` at the clip's land event, a smoke burst on landing, and a glide forward.
2. **Rim climb** (needs a rim edge with a drop: sky temple, moon lake): `Freehang_Climb` / `Climbing_To_Top` (NEW) over the platform edge, framed from inside the arena. Mist rises from below.
3. **Shadow emerge** (any arena): a smoke column on a floor spawn, then `Emerging` (NEW) rises out of the shadow pool, with a vampiric hiss.
4. **Tunnel shadow-step** (always valid): two cuts of a silhouette in the tunnel, then a fast walk-out with a shadow trail.

**Hollowjack:** the stands leap is only valid where `stands` exist (colosseum). Otherwise:
- `Jumping_Over_Into_Combat` (NEW) over the balustrade or fence (sky temple, sakura, moon lake)
- or a `Bash` through the doors

**All 8 current entrances** are rewritten as beat specs with ≥ 2 variants each. They are validated for 7 themes × 5 layouts × 2 gates = 70 configurations per fighter.

**5. Outros and taunts.**
- **Victory:** `Victory 1–3`, `Victory_Idle 1–3`, `Fist_Pump` (NEW), `Standing_Cheering 1/2`, `Rallying` (NEW, to the crowd), `Roar` / chest thump (brutes), `Quick_Formal_Bow` (Aldric, Knight), plus weapon sheathe (`Sheath_A_Great_Sword_1`, `sheath sword 1/2`).
- **Defeat (survivor of a non-lethal ending, or timeout loser):** `Defeat 1/2`, `Defeated`, `Defeat_Idle 1–3`, `Sad_Idle` (NEW), `Kneeling` (NEW).
- **Mid-fight taunts** (5 owned + `Insult`, `Shake_Fist`, `Being_Cocky`, `Threatening`, `Angry`): picked by profile, never back-to-back, and gated by the sim (`taunt` state, as today).

**6. Talking and dialogue sync.** Voice lines are 3–25 words, roughly 1–9 s.

- **Gesture layer:** an upper-body masked overlay from a per-profile talk pool:
  - `Talking 1–7`, `Pointing*`, `Angry_Gesture 1–3`, `Angry_Point`, `Beckoning`, `Threatening`
  - accents: `Hard_Head_Nod`, `Head_Nod_Yes`, `Annoyed_Head_Shake`, `Cocky_Head_Turn`, `Dismissing_Gesture`, `Look_Away_Gesture`
- **Sync to audio:**
  1. Offline, compute each voice file's RMS envelope and **emphasis peaks** (local maxima above the mean). This is a few lines in the existing `tools/tts/post.mjs`, stored in the voice manifest.
  2. At runtime, play a talk loop for the line's duration, time-scaled so its end aligns with the line end.
  3. On each emphasis peak, add a head-nod spring (pitch 6–10°) and, at the strongest peak, swap in an accent gesture (pointing at the opponent if the line mentions them, from tags in `dialogue.ts`).
- **Look-at during speech:** the opponent by default. During the face-off: the opponent, then the camera on the last words for the "breaking the fourth wall" lines.
- **No lip sync** (no jaw bones on most rigs, no blendshapes). Instead:
  - a subtle head bob with the amplitude
  - the chest breathing additive scaled up while speaking
- **Face-off interactions:** `Walk_In_Circle` (NEW) circling, `Spat_In_Face`/`Spit_Reaction` (NEW) for rivals, `Shaking_Hands_1/2` (NEW) for honourable pairs (Aldric and Knight), a stare-down with look-at, and a weapon presentation (`Draw_A_Great_Sword_1`, `draw sword 1/2`, `Withdrawing_Sword`, `unarmed equip`).

### (i) Cinematic moments and time

- **Freeze beats** (render clock per actor; the sim is unaffected):

  | Beat | Treatment |
  |---|---|
  | **Parry** | The attacker freezes for 6 frames in the deflection pose while the defender's counter wind-up continues at 1×, plus a flash. |
  | **Rage / second wind** | World 0.3×. The raging fighter at 1× for 0.6 s (they "move faster than time"), with a chromatic pulse. |
  | **Near death** | A 0.5 s heartbeat slow-mo when HP first drops below 12%, with a muffled audio low-pass (exists) and a vignette pulse. |
  | **Finisher start** | A full freeze of both for 0.35 s with speed lines and a camera snap. |
  | **Last hit** | The killcam exists. Add a 2-frame hold on contact plus a camera whip. |

- **Rule:** the per-actor display clock may lag the sim by at most 0.4 s and catches up at ≤ 1.6×. That keeps contact frames honest: no displayed hit can appear before the attacker's displayed contact.
- **Camera:**
  - Scene camera tracks are authored per paired scene and per entrance beat.
  - The director's existing `destruct` / `throw` / `killcam` shots get **contact-anchored** timing: cut *on* the contact frame, never just before it.

### (j) Faces, eyes and heads (no blendshapes)

- Checked in the converted GLBs:
  - **no morph targets** on any of the 8
  - eye bones on aldric, erika, gorak, ozrel, vex and hollowjack (right eye only)
  - Spot checks of the 19 new FBXs show no blendshape channels.
- **What we can do:**
  - **Eye look-at:** a saccade every 0.6–2 s toward the opponent's head or weapon, with a small random offset.
  - **Head and neck look-at with personality:** Vex tilts his head (cocky roll +8°); Maw keeps his head low.
  - **Blink:** not possible without lids. Skip.
  - **Emotion through posture additives:**
    - fear: shoulders up, head down
    - rage: chest out, fists clenched (finger curl on bones that exist)
    - exhaustion: shoulders down, head low, breathing amplitude up
  - **Emissive "eye glow" accents** for supernatural characters (Vex, Demon, Uriel, Skeletonzombie): a small additive sprite parented to the eye or head bone, pulsing on rage and ultimate.

### (k) Personality profiles and per-run variation

```ts
interface AnimProfile {
  id: string; weightClass: 'light'|'mid'|'heavy'|'giant';
  tempo: number;                 // global playback multiplier on non-sim cosmetics (idles, gestures) 0.85–1.15
  amplitude: number;             // additive strength (breathing, sway, flinch springs)
  stance: Stance;                // locomotion and idle family
  gait: { walk: ClipRef[]; run: ClipRef[]; injured: ClipRef[] };
  idles: ClipRef[]; fidgets: ClipRef[]; taunts: ClipRef[]; victory: ClipRef[]; defeat: ClipRef[];
  dodgeStyle: 'acrobatic'|'measured'|'rolling'|'stoic';
  reactStyle: 'stoic'|'dramatic';  // severity bias for hit reactions
  deathStyle: ClipRef[];
  castStyle?: CastStyle;           // hand, gesture family, charge style
  signature: { entrance: string; finishers: string[]; taunt: ClipRef };
  lookAt: { headWeight: number; eyeSaccades: boolean; tiltDeg: number };
  mirrorBias: number;              // preference for mirrored variants (e.g. a southpaw brawler)
}
```

**Current 8:**

| Fighter | Profile |
|---|---|
| **Gorak** | heavy; tempo 0.95; `Orc_Walk`/`Orc_Idle` blends; stoic reacts; taunts: battlecry, chest thump |
| **Aldric** | mid; measured dodges; formal bow; sword-salute idle; stoic |
| **Ozrel** | light; caster; cast style "wide-arm channel" (variants per run); floats in when possible |
| **Erika** | light; acrobatic dodges; bow presentation idle |
| **Vex** | light; acrobatic (flips); cocky head tilt; swagger walk |
| **Fenrik** | creature; prowling; howl taunts |
| **Maw** | giant; tempo 0.85; `Hell_Slammer` signature |
| **Hollowjack** | brawler; `Bouncing_Fight_Idle`; cheap-shot finisher |

**Per-run variation** (seeded by the match seed):
- the idle set subset (3 of 5)
- tempo ±5%
- the gait variant
- the cast hand
- which 2 of 4 taunts
- the entrance variant (when several validate)
- a colour tint offset of ±8% hue on cloth materials, which keeps identity but makes reruns feel fresh

---

## C. Casting the 19 new characters

The models have no weapons, so weapons attach to the hand bones as procedural meshes: axe, sword, greatsword, spear, daggers, club, staff, shield. The clips were authored for these grips.

| Character | Archetype | Weapon / stance | Animation set | Signature moves | Entrance | Finisher |
|---|---|---|---|---|---|---|
| Knight_D_Pelegrini | Crusader | Greatsword | Great_Sword_* (all), 2hand_Idle | High spin attack, slide attack, jump attack | Kneels at the gate, rises, draws the greatsword | Executioner's Plunge (#15) |
| Castle_Guard_01 | Shield guard | Sword + shield | ProSwordandShield | Shield bash, guard counters | Marches in step, salutes | Shoulder Throw & Stomp (#1) |
| Castle_Guard_02 | Halberdier | Spear | Upward_Thrust, Bayonet_Stab, Thrust_Slash | Long-reach thrusts | Sentry drill march | Impale (#14) |
| Warrok | Giant brute | 2h club | Two_Hand_Club_Combo, Heavy_Weapon_Swing, Creature pack | Ground slams, roars | Bursts the gate with `Bash` | Hell Slammer (#2) / Choke Lift (#5) |
| Demon_T_Wiezzorek | Fire demon | Caster + claws | ProMagic 2H area, Creature swipes, Fireball-style | Area blasts | Emerges from lava / fire (`Emerging`) | Thunderstrike, fire variant (#19) |
| Goblin_D_Shareyko | Trickster | Club / torch | Torch melee 01–05, Dwarf_Walk | Dirty tricks, kicks | Climbs over the rim | Cheap Shot (#12) |
| Skeletonzombie | Undead | Unarmed claws | Zombie_* idles, walks, attacks, deaths, stand-ups | Lurching grabs | Rises from the ground (`Emerging` + `Zombie_Stand_Up`) | Feast (#8) |
| Uriel_A_Plotexia | Golden angel paladin | Greatsword + light magic | Great_Sword_Casting, Power_Up, Magic_Heal | Smiting plunges | Descends with `Floating` → land (only with a visible origin: a halo or perch) | Thunderstrike (#19) |
| Nightshade | Assassin | Dual daggers | Dual_Weapon_Combo, Stabbing*, Ninja_Idle, Sneak_Walk | Flips, backstabs | Shadow step / perch drop | Silent Blade (#9) / Strangle (#6) |
| Ganfaul_M_Aure | Old dark wizard | Staff caster | ProMagic, Spell_*, Old_Man_Walk | Channelled blasts | Walks out of fog, `Focus` | Thunderstrike (#19) |
| Akai_E_Espiritu | Rogue / ninja | Dual or 1h sword | One_Hand_Sword_Combo, Ninja_Idle, flips | Fast strings | Perch drop | Brutal Assassination (#10) |
| Kachujin_G_Rosales | Samurai | Katana (1h sword, two-handed grip) | Stable_Sword slashes, Slash_Advance, Run_And_Swing | Draw-cut (iaijutsu) | Kneel, then draw | Flying Knee KO (#20) / Gut & Twist (#13) |
| Heraklios | Hooded gladiator | Spear + greatsword | Upward_Thrust, Great_Sword set | Heroic sweeps | `Warrior_Idle` stance, crowd rally | Impale (#14) |
| Parasite | Mutant | Claws | Creature + Zombie sets | Lunging bites | Crawls out of the tunnel | Feast (#8) |
| Whiteclown | Psycho clown | Knife / unarmed | Stabbing*, Knife_Idle, Scary_Clown_Walk | Erratic feints | Creepy walk-in, `Taunt_*` | Hostage Gloat (#11) / Cheap Shot (#12) |
| Medea | Sorceress | Caster | ProMagic 1H, Wide_Arm_Spell_Casting | Charm / curse casts | `Floating` levitation from a visible perch | Thunderstrike (#19) |
| Eve | Mercenary brawler | Unarmed / MMA | Mma_Kick*, Boxing*, Mma_Idle | Kick strings | `Female_Tough_Walk`, crowd point | Double-Leg Takedown (#4) |
| Pirate | Swashbuckler | 1h sword | One_Hand_Sword_Combo, Swagger_Walk | Taunting flourishes | Swagger, `Being_Cocky` | Rockin' Shackle (#3) / Hostage Gloat (#11) |
| Prisoner | Escaped convict | Unarmed brawler | Fist_Fight_A/B, Boxing, Illegal_* | Dirty boxing, headbutts | Breaks the shackle at the gate (cage-break variant) | Strangle (#6) / Takedown (#4) |

Integration order: start with the archetypes whose clip sets are complete and contrast with the current roster. Batch 1: Knight, Warrok, Nightshade, Uriel, Skeletonzombie, Kachujin.

---

## D. Variation and anti-repetition strategy (measurable)

- **Pools everywhere:** attacks (sim-picked), hit reactions, knockdowns and get-ups (sim-picked, since durations differ), deaths, dodges, idles and fidgets, taunts, gestures, victory poses, entrances (variant per arena) and finishers.
- **Memory:**
  - per fighter: the last N picks per pool, with a time-since-use cooldown
  - per match: usage counts
  - per fighter, across matches (finishers and entrances, in localStorage, render-side only): avoid repeating the last one
- **Mirrors** double the asymmetric pools (unarmed and two-handed).
- **Context features** make choices *feel* motivated rather than random: direction, height, severity, space and stance.

**Automated metric** (`tools/anim/repetition.ts`, run on recorded matches in `sim:test` plus a render audit):
- **R1 immediate repeat rate:** the same clip for consecutive uses of a pool. **Target 0%.**
- **R2 near repeat:** the same clip within 8 s in the same pool. **Target < 10%.**
- **R3 pool entropy:** normalised Shannon entropy of clip use per pool per match. **Target ≥ 0.8** for pools of size ≥ 4.
- **R4 top-clip share:** the largest single-clip share within a pool across 100 matches. **Target ≤ 25%** (pools ≥ 6).
- **R5 death and knockdown uniqueness:** distinct clips across a fighter's last 10 deaths. **Target ≥ 6.**
- Reported per fighter and per pool, with before/after.

---

## E. Contact consistency for the new systems (extends the Round A audit)

The rule stays: **no damage, kill or effect before something visibly reaches the body.**

| System | Sim guarantee | Audit (`render/audit.ts` extended) |
|---|---|---|
| Attacks (variants) | Per-variant reach data + swept strike points (as today) | Strike point to capsule distance at hit frames: p99 ≤ 0.3 m |
| Paired scenes | Damage only at authored contact events; actors aligned before t0 | At each contact event, the aggressor effector to the victim bone (named body part) ≤ the tolerance (0.12 m) after IK; alignment error at t0 ≤ 0.05 m |
| Thrown props | Swept prop vs capsule (exists) | Exists (all touching) |
| Spells | Projectile entity arrival (exists); beam spells by a swept segment | Same as projectiles |
| Environment (crush, lava, spikes, chandelier) | Existing geometric triggers | Victim within the falling object's footprint at its impact frame |
| Entrances | No damage. The barrier break is bound to a contact event | Validator causality check (contact within 0.1 m of the barrier) |
| Wall slams | Contact when the body capsule reaches the wall | Victim shoulder/back bone within 0.15 m of the wall plane at the slam frame |

---

## F. QA and tools

1. **Animation Lab** (`tools/animlab/`, a Vite page; it reuses the build and serves FBX/GLB through Playwright routing like the screenshot tools). It can:
   - pick any character and any clip, or a sim state / move / variant
   - scrub, play at 0.1×–2×, or step frame by frame
   - show bones, the root trajectory, foot-plant intervals and event markers (anticipation, contact, release, land, groundTouch)
   - **retarget check:** play the same clip on two characters side by side
   - **pair mode:** load a paired scene, show the alignment and contact distances per event, and drag the offset to tune it, then export it to the scene JSON
   - **mirror check:** the original next to `~M`, plus a numeric symmetry error
   - **transition preview:** clip A, then clip B with the chosen blend; plots pose velocity to show pops
2. **Batch analysers** (existing in `tools/anim`, extended):
   - foot-slide metric: height-gated horizontal foot velocity and skating ratio, per clip and per played match
   - transition-pop detector: the maximum bone angular acceleration within ±3 frames of a blend vs the clip's own baseline. Flag ratios above 3.
   - root-curve extraction
   - event detection
3. **Contact audit** extended to paired scenes, wall slams and environment kills (§E).
4. **Repetition metrics** (§D) in `sim:test`.
5. **Entrance validator** (§H.3).
6. **Performance budget**, measured in the Lab and the game:

   | Item | Budget |
   |---|---|
   | Pose pipeline per character | ≤ 0.35 ms (JS) |
   | Look-at + IK + springs | ≤ 0.15 ms |
   | Skinned characters on screen | 2 fighters + ≤ 2 cinematic extras |
   | Joints per character | ≤ 100 |
   | Animation data loaded per match | ≤ 25 MB (lazy libraries) |
   | First-match load added by the shared libraries | ≤ 1.5 s |

---

## G. Data pipeline changes

- **Converter v2:**
  - Keep hips X/Z **as a separate root track** (no longer discarded). Keep yaw. Lock in-clip.
  - Export *animation-only libraries* per category (meshopt-compressed, about 40–60 KB per clip per skeleton).
  - Generate **mirrored clips** with model-space reflection relative to the rest orientation, plus a left/right bone swap. Each mirrored clip is **verified** by the analyser: the mirrored joint positions must equal the X-reflected originals within 1 cm.
- **Runtime library loading:**
  - Per match, load the fighter's profile clips plus the pools it references: hit reactions, deaths, dodges and get-ups, filtered by stance and weight class (~80–150 clips).
  - Lazy-load finisher and entrance scenes during the intro, before they are needed.
- **`anim.gen.ts`** is generated from the catalog plus authored overrides (`src/data/animOverrides.ts` for contact specs, trims and tags the analyser can't infer).
- **Determinism:** the generated sim data uses only plain numbers. The sim's math stays in `sim/dmath.ts`.

---

## H. Roadmap

Estimates are for this agent working with the current codebase; "d" means agent working days. Each milestone ends with a demo the user can judge.

| M | Milestone | Content | Est. | Risk | Acceptance tests | What you see / judge |
|---|---|---|---|---|---|---|
| **M0** | Foundations & Lab | Converter v2 (root tracks, animation-only libraries, mirror generator + verifier), `anim.gen` generator, Animation Lab v1 (scrub, events, retarget, side by side) | 3–4 d | Low | Every catalog clip previews on 3 characters; mirror error < 1 cm on 20 sampled clips; root tracks reproduce the measured displacement | **Lab page:** browse all 753 clips on any fighter |
| **M1** | Pose pipeline + inertialization | PoseGraph, layers and masks, inertialization / dead-blend table, asymmetric hit-stop, spring flinch additive, phase-matched returns | 3–4 d | Med | Transition-pop metric improves ≥ 50% vs crossfade; no T-pose; frame-time budget met | Side-by-side video: old vs new interrupts, flinches, recoveries |
| **M2** | Reaction & death variety | Auto-tagged hit / knockdown / get-up / death / dodge pools, sim-side variant choice, context features, mirrors; repetition metrics | 3 d | Low | R1 = 0, R2 < 10%, R5 ≥ 6; audit clean; balance unchanged (±2%) | Ten knockdowns / deaths in a row, all different and motivated |
| **M3** | Arena-aware entrances | StageAnchors from all 7 dressings, beat-based entrance specs with variants, validator, **Gorak Cage Breaker + Vex From the Dark** first, then the other 6 | 3–4 d | Med | Validator passes 8 fighters × 7 themes × 5 layouts × 2 gates; causality check 100% | Gorak and Vex on every theme; then all entrances |
| **M4** | Paired scenes & first 8 finishers | Scene system (sim + render), alignment solver + contact specs, camera tracks, anime freeze beat, finisher rules; finishers #1, 2, 3, 7, 9, 15, 16, 18 | 5–6 d | High | Paired-contact audit: all contacts ≤ 0.12 m; determinism (Node = browser); no kills without contact; finisher rate 15–30% of kills | Finishers, MK-style |
| **M5** | Attack variants & travel moves | Per-weapon variant pools, root-curve lunges and dodges, combo contact frames, mirrored unarmed sets; rebalance | 3–4 d | Med | Balance 45–55%; reach audit clean; R4 ≤ 25% for attack pools | Fights look less samey; flips and takedowns travel properly |
| **M6** | Talking, look-at, face-off, taunts, outros | Gesture layer synced to voice envelopes, eye/head look-at, face-off interactions (circle, spit, handshake), victory/defeat sets | 2–3 d | Low | Every voice line has a gesture; look-at never exceeds clamps; no repeat of the outro clip in 5 consecutive wins | The intro and face-off feel alive; characters talk with their bodies |
| **M7** | Profiles + new characters batch 1 | AnimProfiles for the 8, per-run variation; 6 new characters with weapons, movesets, entrances and finishers; sim defs + balance | 5–7 d | Med | New characters pass every audit and validator; balance across 14 fighters 44–56% | 6 new fighters |
| **M8** | Spells & environment interactions | Cast styles, charge and release sync, VFX hand attach; pillar push, prop weight classes, edge teeter; finishers #11, 12, 13, 14, 17, 19, 20 | 4–5 d | Med | Release-frame VFX error ≤ 1 frame; environment finishers obey §E | Magic duels; environment kills |
| **M9** | Polish | Foot locking, stride warp, ragdoll-lite settle, eye glow, remaining finishers (#4, 5, 6, 8, 10); batch 2 characters | 4–6 d | Med | Foot-slide metric: skating ratio < 5% in locomotion; overall perf budget met | Final polish pass |

**Quick wins first** (high feel per effort, little dependency, inside M1–M3):
1. Hit-stop asymmetry plus the spring flinch.
2. Death, knockdown and get-up pools. This is the most visible repetition today.
3. The Gorak and Vex entrance fixes. This needs only anchors for gates plus event-bound cues. It can ship before the full beat framework.
4. Inertialized interrupts.

Total: about 35–45 agent-days for everything. M0–M4 (about 17–21 d) delivers the core of "AAA feel": blending, variety, entrances and finishers.

---

## I. Risks, unknowns and mitigations

| Risk / unknown | Mitigation |
|---|---|
| **Paired clips lost their relative alignment** (all but 3 pairs) | Contact-spec solver plus Lab tuning. Start M4 with the 3 shared-frame pairs. |
| **Character size mismatch** in pairs (Maw vs Vex, Warrok) | Hips-height scaling of offsets, contact IK, and size-class requirements per scene |
| **Mixamo retarget artefacts** (hand interpenetration, foot sliding on big characters) | Foot locking and hand IK. Measured per character in the Lab; a per-character blacklist for bad clips |
| **Root-motion clips vs sim determinism** | The sim consumes extracted root curves (plain data, generated); the renderer warps the same curve. Both use identical numbers. |
| **Balance drift** from variant timings and finishers | Variants constrained to a timing class; `sim:test` after each milestone; finishers only replace already-lethal blows |
| **Mirroring correctness** (non-symmetric rest poses) | Model-space mirror plus numeric verification. Mirror only unarmed or two-handed clips. |
| **Load time / memory** with hundreds of clips | Category libraries, lazy loading, meshopt; the budget in §F |
| **Quality varies across clips** (some Mixamo clips look floaty or wrong) | Curated `allow` flags in `animOverrides.ts`, set via Lab review; analyser heuristics (e.g. foot skating) flag candidates |
| **No facial animation** | Eyes, head, posture and VFX accents. Facial rigs are out of scope. |
| **Dataset clip licensing** (Adobe Mixamo terms, personal prototyping) | Already noted. Keep fetched clips out of git; the converted GLBs follow the same rule as today. |
| **Transition tuning time** (a feel-heavy, iterative task) | Data-driven transition table plus Lab preview; the user reviews short videos per milestone |
| **Headless verification can't judge "feel"** | Videos and frame sequences per milestone for the user to judge, plus the objective metrics (pop, slide, contact, repetition) |

---

## J. Extra downloads (done this round)

- **159 clips, 94.0 MB**, fetched into `Assets/Animations/Mixamo_HF2/<category>/`.
  - Every file was validated as `Kaydara FBX Binary`.
  - They are kept out of git. The list with reasons is in `tools/anim/fetch-list.json`; re-run with `node tools/anim/fetch.mjs`.
- **Categories:**

  | Category | Clips | For |
  |---|---|---|
  | paired | 21 | victims for owned attackers; strangle, hostage, bite and handshake pairs; brawl exchanges |
  | entrance | 31 | drops, vaults, climbs, emerges, levitation, gate interactions (`Banging_Fist`, `Bash`, `Pulling_Lever`, doors), walk-out styles |
  | locomotion_style | 22 | character gaits, injured / tired / dizzy sets, starts, stops, pivots |
  | idles_style | 11 | |
  | martial | 15 | sweeps, launchers, flips, elbows, knees, capoeira |
  | weapons | 13 | club, spear, thrusts, advancing slashes, draw / sheathe |
  | reactions | 14 | wall crash, launch, edge teeter / slip, electrocution, kip-ups |
  | deaths | 9 | |
  | social | 14 | taunts, talk accents, rally, defeat / kneel |
  | environment | 9 | push, pull, carry poses |

- **Correction found while analysing:** `Kick_To_The_Groin` and `_3` are *receivers* too. The dataset has no kicker clip, so finisher #12 uses contact warping with a front kick.
- **No new characters were downloaded.** The 19 in `Models_HF` cover the plan.
- **Possible later fetches:**
  - more `Dying_*` / `Standing_Death_*` variants
  - `Great_Sword_Slash_*` variants for a second greatsword user
  - `Sword_And_Shield_Death_2` / `Impact` variants
  - The remaining gaps are listed at the end of `docs/animation-catalog.md`.

---

## K. As built: deviations from this plan (M0 to M4, 2026-10)

These are the places where implementation differs from the plan above, and why.

- **M0: no converter v2.** The fighter GLBs were left as they were. Instead, a **shared animation library** holds the extra clips: `tools/anim/build-lib.ts` builds `public/anim/{core,entrance,finisher}.bin` and `index.json`, and the clips are retargeted at runtime by `src/render/animLib.ts`.
  - Root motion is kept as a separate smoothed root curve. Hips sway stays on the hips.
  - Mirrored clips are generated in model space and checked with forward kinematics: worst error 0.009 cm.
  - The sim's timing table (`src/sim/anim.gen.ts`) is generated from the same data.
- **M1: animation pipeline.** Inertialization, spring flinch and phase-matched locomotion were built as planned. Also added:
  - a locomotion **sync group**, so blended cycles keep their feet in step
  - **two-bone foot locking**, originally planned for M9
- **M2: launches.** The plan did not have launches; the user asked for them. The sim owns a ballistic arc, the launch clip is warped onto it, and light spring flailing is cosmetic only.
- **M3: entrances.** Stage anchors are declared by each theme's gate builder, then **snapped onto the built geometry with head-room checks** (`snapAnchors`). Any anchor that does not land on a real surface with room above it is dropped.
  - All 8 entrances are beat specs.
  - The headless validator also checks causality: a barrier event must happen with the hand, weapon or body at the barrier.
- **M4: finishers.**
  - Paired-clip alignment comes from `tools/anim/scenes.ts`. Mixamo re-centred most pairs, so alignment is solved from a contact spec.
  - **Rock'n Shackle was cut.** Its clip never touches the victim's torso (closest approach 0.115 hips). **Immolation** (Ozrel's spell finisher, burn effect) replaced it.
  - **Into the Fire** reuses the launch system: a killing knockdown launches the victim into a hazard. It is rare, about 1% of kills.
  - **Executions on a downed victim are Gorak and Maw only.** Aldric's two-handed plunge and Hollowjack's two-fisted slam stopped 0.14 to 0.16 m short of a lying body on our rigs, so they were cut. Those fighters use Curb Stomp instead.
  - **Contact warp** (render only, not in the plan): around each contact frame the moving role's root is warped (at most 0.7 m) and the striking limb reaches the rest of the way with two-bone IK. Paired clips were authored on other bodies, so without this hands miss by 0.2 to 0.7 m. Contacts happen only on frames where `scenes.ts` measured the effector touching the body.
  - **Beheading** is clean on 5 of 8 rigs: Gorak, Aldric, Vex, Fenrik and Hollowjack. Ozrel's and Erika's hoods are weighted to the spine, and Maw's head is fused to his shoulders, so on those three a beheading falls back to the blade cut.
  - Gore defaults to **off**, which plays dissolve and flash versions.
- **Camera (M3/M4).**
  - Shot scoring before every cut: framing, cover, the other fighter blocking the view, size.
  - Contact-aware re-picks when a blow would land off camera.
  - The camera rig refuses positions where the two fighters line up one behind the other.
  - New shots: launch follow, finisher track, cut-in.
  - A headless readability audit: `src/camera/cameraAudit.ts`.
  - Debug: `?t=` jumps to a time, and the B key copies a reproduction URL.
