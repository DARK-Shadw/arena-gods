# Animation research notes

These notes cover how top-tier games make combat animation feel real, and what translates to this project.

The constraints:
- a browser / Three.js renderer
- a Mixamo-skeleton library of about 750 clips (after the extra fetch)
- a deterministic sim that is authoritative over timing and contact

Sources are listed per section. Where a claim comes from secondary or community sources it is marked *(secondary)*. Several GDC talks are only available as session descriptions; I have not watched those talks, so treat their summaries as abstracts.

---

## 1. Principles that matter most for *combat*

**Telegraph and anticipation.**
- Jonathan Cooper (*Game Anim*) treats telegraphing as anticipation adapted for gameplay. NPC attacks exaggerate both the length of the wind-up and the posing so the observer can read them *(secondary quote)*.
- We are a spectator game. The "player" is the viewer, so **every** attack should read: wind-up pose, then strike, then follow-through.
- **What it means for us:**
  - The sim's windup durations must map onto a clip segment that actually *is* a wind-up.
  - Today the time-warp squeezes or stretches clips by up to roughly 2× to fit sim timings. That is fine for strikes, but bad for anticipation if the wind-up gets compressed below about 0.15 s.

**Follow-through and weight.**
- A blow that stops dead feels weightless. Overshoot and settle sells mass *(secondary)*.
- Sony Santa Monica said they *reduced* camera shake in God of War (2018) for legibility, then put the punch back with huge impact audio, very large swing arcs with powerful follow-throughs, and exaggerated enemy reactions: big pose changes, flips, juggles ([PlayStation Blog](https://blog.playstation.com/?p=370399)).
- **For us:** don't fade out of attack clips early. Let recovery play, and blend out on the follow-through, not before it.

**Hit-stop (hit-pause).**
- Freezing both actors for a few frames at contact gives the eye time to register that the hit happened.
- Typical values are 1–4 frames for light hits, scaled up for heavier ones *(secondary: [critpoints](https://critpoints.net/2017/05/17/hitstophitfreezehitlaghitpausehitshit/), [game-feel primer](https://uhiyama-lab.com/en/notes/unity/unity-game-feel-hit-feedback/))*.
- We already do this (35–110 ms).
- **New idea:** asymmetric hit-stop. The *attacker's* weapon freezes while the *victim* starts the reaction a frame earlier. That reads as penetration rather than a frozen video.

**Readable silhouettes and key poses.** The strongest frames (wind-up apex, contact, recovery) should be held or slowed. An attack time-warp that keeps the contact pose on screen for 2–3 frames reads far better than one at a uniform playback rate.

## 2. Transitions: crossfade vs inertialization

- **Crossfade** is our current approach (normalised layer weights). It is cheap, but it evaluates two poses and produces "mushy" in-between poses, including foot sliding and knee pops.
- **Inertialization** (David Bollo, *Gears of War 4*) cuts immediately to the target animation. The difference from the source pose is stored, along with its velocity. Each frame a quintic curve that decays to zero over the blend time is added to the target.
  - Matching velocity is what removes visible pops.
  - Controlling the curve's initial acceleration prevents overshoot.
  - Only one animation is evaluated, which was 60% cheaper than a classic blend ([SIGGRAPH '17 talk PDF](https://history.siggraph.org/wp-content/uploads/2022/09/2017-Talks-Bollo_High-Performance-Animation-in-Gears-of-War-4.pdf), [GDC 2018](https://www.gdcvault.com/play/1025331/Inertialization)).
- **Dead blending** (Daniel Holden, [theorangeduck](https://www.theorangeduck.com/page/dead-blending)):
  - Record the source pose and velocity, extrapolate them forward with a decaying velocity (`v *= exp(-ln2·dt/halflife)`), and crossfade from the extrapolation to the target (smoothstep).
  - It needs no target-pose offset and is very simple. Holden notes it can dampen target detail somewhat.
  - Unreal now ships both inertialization and dead blending.
- **Phase matching** (Bollo): when returning to a locomotion cycle, compute a foot-phase scalar from the left foot's position relative to the right along the velocity. Enter the cycle at the matching frame. This prevents the "wrong foot" shuffle.
- **Takeaway for us:**
  - Inertialization or dead blending is **implementable on top of `THREE.AnimationMixer`** as a post-process on bone quaternions. We already post-process for the carry overlay.
  - It is the single biggest perceived-quality upgrade for transitions: hit reactions interrupting attacks, dodges, recoveries.
  - Cost is a handful of quaternion operations per bone per frame, for 2 characters × ~65 bones. Negligible.

## 3. Motion matching (and whether it fits)

- **Motion matching** (Simon Clavet, *For Honor*, GDC 2016 / nucl.ai):
  - Instead of a hand-built state graph, the game searches a database of long mocap takes every few frames.
  - It picks the frame whose *features* match: current pose (mostly foot positions and velocities) plus the desired future trajectory.
  - It then blends there.
  - Combat moves are layered on top ([Game Developer](https://gamedeveloper.com/programming/most-inspiring-game-animation-tech-talks-of-2016), [gameanim.com](https://www.gameanim.com/?p=13538)).
- **Learned Motion Matching** (Holden et al., SIGGRAPH 2020) replaces the database with networks to save memory ([paper](https://www.theorangeduck.com/media/uploads/other_stuff/Learned_Motion_Matching.pdf), [Ubisoft La Forge](https://www.ubisoft.com/en-us/studio/laforge/news/6xXL85Q3bF2vEj76xmnmIu/introducing-learned-motion-matching)).
- **Fit for us:**
  - Full motion matching needs dense, unstructured mocap: long walks and turns with lots of overlap. Mixamo gives short, curated clips, one motion each. A matcher would mostly find "the same clip", so the data is the wrong shape.
  - **What is viable** is a *motion-matching-style clip selector* for discrete choices:
    - which hit reaction, death, get-up, dodge or transition-in clip
    - chosen by feature distance: start pose vs current pose, required root displacement and direction, facing, height/zone of the hit, and the remaining space to the wall
  - We already measure start and end poses, root travel and contacts for every clip (`docs/animation-catalog.json`). This is exactly the data that selector needs.
  - Locomotion should stay a blend tree. Phase matching and stride/speed warping are what remove the remaining foot sliding.

## 4. Motion warping (aligning motions to targets)

- **Gears of War 4 "warp points"**:
  - Animators mark landmarks in a clip.
  - At runtime the game places matching points in the world.
  - The character's root trajectory is warped so authored and runtime points align, with separate timing for translation, rotation and facing.
  - It evaluates a single sequence, about 2× cheaper than blend spaces ([SIGGRAPH '17](https://history.siggraph.org/wp-content/uploads/2022/09/2017-Talks-Bollo_High-Performance-Animation-in-Gears-of-War-4.pdf), [GDC 2017](https://gdcvault.com/play/1024219/Motion-Warping-in-Gears-of)).
- **Unreal Motion Warping** generalises this:
  - notify windows inside the clip
  - named warp targets
  - a "skew warp" that bends root motion so the character arrives at the target location and rotation at the end of the window ([Epic docs](https://dev.epicgames.com/documentation/unreal-engine/motion-warping-in-unreal-engine)).
- **Stride warping, orientation warping, distance matching** (Lyra):
  - scale step length to the capsule speed
  - twist the spine and legs to the movement direction
  - choose the clip time by distance to the stop or start point
  - Epic's rule of thumb is to keep play-rate and stride adjustments within **15–20%**, and accept a little foot slide beyond that ([Lyra blog](https://www.unrealengine.com/tech-blog/adapting-lyra-animation-to-your-ue5-game), [pose warping docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/pose-warping-in-unreal-engine)).
- **Takeaway for us:**
  - Our sim already implements "attack magnetism": a lunge budget during the windup that re-aims at the target.
  - What we lack is **warping the visual root motion of clips that travel**. 230 of the new Mixamo_HF clips are *not* in place (e.g. `Flying_Shoulder_Throw` travels 6.3 m, `Pick_Up_Item` 5.4 m, `Double_Leg_Takedown` 2.8 m).
  - Today the converter locks hips X/Z, so these clips would moonwalk on the spot.
  - The plan: **extract root motion per clip, then let the sim decide the displacement** (deterministic). The renderer warps the clip's extracted root curve to the sim's start and end transforms with a skew warp.
  - The sim gets the clip's root-displacement profile as data. That keeps animation and sim in agreement without the animation driving the sim at runtime.

## 5. Paired / synchronised animation (grabs, throws, executions)

- **Unreal Contextual Animation**:
  - A "scene" holds one track per role (attacker, victim, object), authored together.
  - Warp points give the alignment transform of each role relative to a reference.
  - Alignment tracks are precomputed offline.
  - At start, each actor is warped to its role's start transform, then all tracks play on a shared clock ([Epic API docs](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/ContextualAnimation/FContextualAnimSet)).
- **The Last of Us** melee was built around syncing animations between attacker and target, with context-sensitive variants baked per environment: glass, walls, improvised weapons ([GDC 2014 "Unsynced: The Last of Us Melee System"](https://gdcvault.com/play/1020368/Unsynced-The-Last-of-Us), [Naughty Dog blog](https://naughtydog.com/blog/2014_naughty_dog_gdc_talks_and_the_last_of_us_accolades)).
- **Mortal Kombat** fatalities: concept boards, then mocap of both performers, then hand animation, then FX and lighting, then QA. Each fatality has its own planned camera ([EventHubs on NetherRealm's process](https://eventhubs.com/news/2019/mar/09/netherrealm-studios-reveals-fatality-creation-process-mortal-kombat-11)). Fatal Blows use faster action edits.
- **Arkham** gives momentum and readability through slow-motion beats on the last hit and on multi-takedowns. The team doubled the animation set to convey variety ([Game Informer](https://www.gameinformer.com/b/features/archive/2014/03/14/five-reasons-batman-arkham-knight-has-us-excited.aspx), [vidaextra](https://www.vidaextra.com/industria/conocemos-como-combate-batman-arkham-assassins-creed-quien-invento-realmente)).
- **Takeaway for us:**
  - Mixamo contains a few *true* pairs, recorded together: `Shoulder_Throw_Aggressor/Victim`, `Hell_Slammer_A/B`, `Rockin_Shackle_A/B`, `Double_Leg_Takedown Attacker/Victim`, `Fist_Fight_A/B`, `Strangling / Being_Strangled`, `Taken_Hostage Villain/Victim`, `Stealth_Assassination`, `Brutal_Assassination`.
  - These pairs share a coordinate frame and a timeline. Playing both with the **same start frame and a fixed relative transform** gives correct contact.
  - Other combinations (e.g. `Grab_And_Slam` + `Getting_Thrown`) are *not* synced. They need **contact-point warping**: measure the aggressor's hand path and the victim's chest path from the clips, then solve a relative offset and time scaling so they meet at the contact frames. The analyser already outputs per-frame effector positions.
  - The relative transform of a true pair is measurable offline. Both clips are recorded in one world frame, so their hips start positions give the offset directly.

## 6. Hit reactions, physical animation, death

- Reactions are selected by **direction × height × severity**, often with an **additive** flinch layered on top of the current action so a light hit doesn't interrupt the base motion.
- Procedural options:
  - **Spring-driven impulses** on the spine, neck and head bones at the hit point. Plugins do exactly this: hit location, direction, bone and strength feed a damped spring additive on the existing animation ([UE "Easy Procedural Hit Reactions"](https://forums.unrealengine.com/t/kettunen-easy-procedural-hit-reactions/2741781), [s&box Shrimple Ragdolls](https://sbox.game/fish/shrimple_ragdolls)).
  - **Partial / active ragdoll** (Euphoria / NaturalMotion style). Physics joints are driven toward the animation with springs, and the springs are softened on impact *(secondary: [Unity active ragdoll thread](https://discussions.unity.com/t/wip-how-we-made-our-active-ragdolls-somewhat-convincing/848337), [Wikipedia: ragdoll physics](https://en.wikipedia.org/wiki/Ragdoll_physics))*.
- **Takeaway for us:**
  - A **spring additive** on spine, neck, head and the hit-side clavicle is cheap and deterministic-free: it is render-only.
  - It makes *every* hit unique, including blocked and chip hits, on top of the clip-based reactions.
  - Full ragdoll physics in the browser is possible (rapier) but risky to keep matched with the sim, which decides where bodies lie.
  - Recommendation:
    - Deaths and knockdowns stay clip-based: pick the clip by direction and available space.
    - Add a short **"ragdoll-lite"**: a spring settle on spine and limbs at the end of a fall, plus ground IK for the hands and head so a body lies *on* uneven props or slopes.

## 7. IK, look-at, foot planting, secondary motion

- **Look-at:** layered rotation of head, neck and upper spine toward a target, with per-bone weights and clamps (Unity's `TLookAtIK` with clamp weight, Unreal's Look At node, the [Vulkan glTF tutorial](https://docs.vulkan.org/tutorial/latest/Advanced_glTF/Procedural_Animation_IK/05_look_at.html)).
  - Six of our eight converted fighters have eye bones (`mixamorigLeftEye/RightEye`: aldric, erika, gorak, ozrel, vex, hollowjack), so **eye look-at is possible**.
  - Nobody has blendshapes.
- **Foot IK:**
  - Three.js has `CCDIKSolver`. Analytic two-bone IK is simple to write and more stable for legs; CCD on short chains can over-rotate near the root ([three.js CCDIKSolver docs](https://threejs.org/docs/pages/CCDIKSolver.html), [IK guide](https://mocaponline.com/blogs/mocap-news/inverse-kinematics-games-guide)).
  - Our arena floors are flat apart from rubble and steps, so foot IK is mostly for **foot locking**. That means pinning planted feet during turns, blends and warps to kill sliding, which is the main visible flaw left in locomotion.
- **Foot-slide measurement:** the standard metrics are height-gated horizontal foot velocity and a "skating ratio": frames where a foot within about 5 cm of the floor moves more than 2.5 cm ([OmniControl](https://arxiv.org/pdf/2310.08580), [NeMF](https://arxiv.org/pdf/2206.03287), [Kimodo metrics](https://research.nvidia.com/labs/sil/projects/kimodo/docs/benchmark/metrics.html)). Perceptual studies show viewers notice and prefer cleanup ([Eurographics](https://diglib7.eg.org/items/74844741-a900-4f91-886f-b89bf331cf98/full)).
- **Secondary motion:** spring chains (cloth, hair, capes, pouches) on bones exist in some of our rigs. Even without dedicated bones, an overall jiggle of shoulder pads or weapons via springs is possible.

## 8. Entrances and staging

- **FromSoftware:**
  - Boss arenas are built *without obstacles that disrupt the camera* ([Siliconera](https://www.siliconera.com/dark-souls-boss-arenas-were-made-to-leave-an-impression/)).
  - Fog gates and slamming gates are physical, readable signals of commitment ([Game Developer](https://www.gamedeveloper.com/design/cutting-through-the-fog-of-dark-souls-part-two-)).
- **Shadow of Mordor / War:** the Nemesis intros are procedurally assembled from a captain's traits (randomly generated, not individually crafted). The camera skews wildly for attention ([PlayStation Blog](https://blog.playstation.com/archive/2017/03/08/a-first-look-at-middle-earth-shadow-of-wars-deeper-richer-nemesis-system), [Game Developer analysis](https://www.gamedeveloper.com/design/core-system-analysis-of-middle-earth-shadow-of-war)). I could not find a technical breakdown of how the intros are assembled.
- **The lesson for us:**
  - An entrance is **a physical event in a real place**: a gate, a ledge, a doorway, a rim.
  - It needs a **readable cause-and-effect chain**: approach, then contact, then consequence.
  - It needs a **camera that frames the cause** before the effect.
  - Our two bugs (the cage breaks without a visible blow; Vex appears in mid-air) are violations of exactly this. See the plan, §H.

## 9. Spells and VFX sync

- Industry practice:
  - Key the effect to authored frames: wind-up / charge, a **release frame**, then recovery.
  - VFX timing is blocked out with placeholder shapes before polish ([VFX Apprentice](https://www.vfxapprentice.com/blog/the-soul-of-effects-what-is-timing-in-vfx)).
  - Engines expose per-frame notifies to spawn effects ([Unity thread](https://discussions.unity.com/t/solved-how-can-i-connect-varying-cast-times-to-a-specific-animation-frame/818801)).
- **For us:**
  - We already measure the fastest-hand frame per clip, and that is the release.
  - Add *charge-hold* support: loop or slow the wind-up segment while charging.
  - Add *hand selection*: left, right or both, from per-hand peak speeds in the catalog. VFX attach to the correct hand and fly from it.

## 10. Variety and anti-repetition

- Common techniques:
  - **Weighted random with "never twice in a row"** (Autodesk Interactive [clip state docs](https://help.autodesk.com/cloudhelp/2018/ENU/Max-Interactive-Help/interactive_help/animation/animation_controllers/clip_state_properties.html)).
  - **Shuffle bags** that visit every entry before repeating (Unreal `RandomPlayer` shuffle mode, [Epic API](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/AnimNode_RandomPlayer)).
  - **Distance or time-based suppression**: don't reuse a clip within N seconds ([Atoms Clips Randomizer](https://toolchefs.atlassian.net/wiki/spaces/ASD/pages/2680291329/Clips+Randomizer)).
  - **Constraint-aware weights**: zero the weight when the clip's end position is blocked ([Exodus SDK](https://exodus-sdk.atlassian.net/wiki/spaces/ESDK/pages/1714595549/random+AS)).
- Arkham explicitly doubled its animation count for perceived variety.
- **Mirroring** doubles asymmetric clips for free. Three.js has no built-in clip mirror. Community attempts that only flip quaternion signs fail on non-symmetric rest poses ([three.js forum](https://discourse.threejs.org/t/how-to-mirror-animation-of-a-character-skeleton-and-skinmesh/28325)).
  - The robust method is mirroring in *model space* relative to each bone's rest orientation, with left/right bone swapping.
  - It can be verified with our analyser: the mirrored clip's joint positions must equal the X-reflected positions of the original.

## 11. Browser / Three.js constraints

- **Skinning:**
  - Three.js does GPU skinning, with bone matrices uploaded per skinned mesh and per frame.
  - With 2 fighters of 37–99 joints, plus the prop and cinematic extras, we are far below any limit.
  - The real costs are `AnimationMixer` evaluation (property bindings, per active action) and our own per-bone post-processing.
  - Crowds of hundreds would need bone-texture instancing ([dev.to InstancedSkinnedMesh](https://dev.to/sagacheng/using-instancedskinnedmesh-in-threejs-enabling-the-rendering-of-hundreds-of-3d-characters-on-screen-simultaneously-15gm), [three.js forum](https://discourse.threejs.org/t/how-to-handle-many-complex-skinned-mesh-models-animating-at-the-same-time-on-a-seenable-frustum-in-the-scene/5083)). That is not needed for 2 fighters.
- **`AnimationMixer`:**
  - It blends by normalised weights and has no masks, additive-relative-to-pose (it has additive mode, but relative to a reference clip), inertialization or IK.
  - All of those can be done as **post-process on `bone.quaternion` after `mixer.update()`**. Alternatively, evaluate tracks ourselves with `KeyframeTrack.createInterpolant()`, which `setOverlayPose` already uses.
  - Recommendation: keep the mixer for clip sampling, and add a small **pose pipeline**: sample, then layer and mask, then inertialize, then warp, then IK, then springs. We control the pose pipeline; the mixer just evaluates clips.
- **Memory:** about 750 clips at 30 fps and 65 bones would be large as JSON. Load per fighter only what its profile uses, as today's per-fighter GLBs do. Shared clip libraries can be meshopt-compressed animation-only GLBs, loaded on demand per category.

---

## Ranked techniques: impact on feel vs effort / risk

| # | Technique | Feel impact | Effort | Risk | Notes |
|---|---|---|---|---|---|
| 1 | **Inertialization / dead-blend transitions** (pose post-process) | ★★★★★ | M | Low | Removes pops and mush on every interrupt. It also makes the sim's hard state changes look intentional. |
| 2 | **Context-aware clip selection with variation memory** (feature-scored pools, no-repeat, mirroring) | ★★★★★ | M | Low | Uses the catalog data. It directly answers "nothing should feel repetitive". |
| 3 | **Paired-animation framework** (true pairs + contact-point warping) for grabs, throws and finishers | ★★★★★ | L | Med | The MK-style finisher system and the cage-break entrance both build on it. |
| 4 | **Root-motion extraction + skew warping** to sim-decided displacements | ★★★★ | M | Med | Unlocks the 230 travelling clips: flips, takedowns, leaps, rolls. |
| 5 | **Arena-aware entrance framework** (structural anchors, validation, causal beats) | ★★★★ | M | Low | Fixes both reported bugs at the root. |
| 6 | **Spring additive hit flinches + hit-stop asymmetry** | ★★★★ | S | Low | Every hit becomes unique and contact feels physical. |
| 7 | **Look-at** (head, neck, eyes) + dialogue gesture layer synced to audio length | ★★★ | S–M | Low | Characters feel alive between blows and during talk. |
| 8 | **Foot locking / phase matching / stride warp** | ★★★ | M | Med | Kills residual sliding. Measure first with the foot-slide metric. |
| 9 | **Personality profiles** (gait, idle set, speed and amplitude multipliers, signature clips) | ★★★ | S | Low | The same model feels different per fighter and per run. |
| 10 | **Spell charge/release sync + hand selection + VFX attach** | ★★★ | S | Low | |
| 11 | **Ragdoll-lite settle** (springs + ground IK at the end of deaths and knockdowns) | ★★ | M | Med | Nice to have. |
| 12 | Full motion matching / learned MM | ★ (for our data) | XL | High | Wrong data shape (curated short clips). Not recommended. |
| 13 | Full active ragdoll (rapier) | ★★ | XL | High | Conflicts with the sim being authoritative over body positions. Defer. |
