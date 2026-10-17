# M4: paired finishers, finisher FX, camera grammar

## What it is
- **8 finishers** (`src/sim/finishers.ts`). The sim decides when one fires and when it kills, and the renderer plays it from the record:
  - Pair scenes: Shoulder Throw + Stomp, Hell Slammer, Vampire Kiss, Silent Blade.
  - Downed victim: Executioner (Gorak, Maw), Curb Stomp.
  - Launch: Into the Fire (the knockdown launches the victim into a hazard).
  - Spell: Immolation (Ozrel).
  - About 25% of kills are finishers: 572 of 2240 in the 40-seed run.
- **Contacts happen on measured frames.**
  - `tools/anim/scenes.ts` measures, for every paired clip, the frames where the attacker's hand or foot actually touches the victim's body. Only those frames emit `finisher_contact` (hits and the kill).
  - Downed executions are placed from the measured `impactPos` of the attacking clip, so the blow lands on the lying body.
- **Contact warp (render only, `src/render/contactWarp.ts`).** Around each contact frame (0.38 s before, 0.3 s after, smooth weight):
  - The moving role's root slides at most 0.7 m horizontally.
  - The striking limb then reaches the rest of the way with two-bone IK (`solveTwoBone` in `poseFx.ts`). This makes up for rig height differences, since Mixamo pairs were authored on other bodies.
- **Finisher FX (`src/render/finisherFx.ts`).**
  - Effects: bisect (clipping planes plus a capped cut face), behead (bone-weight split; clean on 5 of 8 rigs, the others fall back to bisect), burn, shatter (glacier), crush, dissolve, drain.
  - Gore setting: off (the default; dissolve and flash versions), stylised, full.
  - Render only. `src/sim` imports nothing from render, and the 40-seed determinism check passes.
- **Camera.**
  - On a finisher: freeze beat (0.35 s), then an authored track around the pair, then a cut-in on the kill.
  - The finisher track's side is chosen by shot score.
  - Spell finishers frame over the caster's shoulder.
  - The cut-in is placed beside and slightly beyond the victim, so the attacker is never between the lens and the blow. A body on the floor is seen from above. Both sides are tested against the attacker and the arena geometry.
  - Shot scoring now raycasts against the built arena (trees, stands, rubble), using tiled ray proxies at 0.08 ms per test (3 ms on the raw meshes).

## Contact quality (pair audit, `pair-contact-audit.json`, 40 finisher examples)

| | before this round | now |
|---|---|---|
| non-lethal paired hits within 0.12 m | 18 / 36 (worst 0.31 m) | **29 / 29** (worst 0.103 m) |
| all contacts within 0.12 m | 54 / 66 | **69 / 69** |
| lethal misses | 1 (executioner, 0.157 m) | **0** |

Per finisher, max distance from the effector to the victim's body:
- shoulder throw kill 0.000
- hell slammer hits 0.103, kill 0.120
- vampire kiss 0.000
- silent blade 0.000
- curb stomp 0.002
- executioner 0.003

**Cut:** Aldric's two-handed plunge and Hollowjack's two-fisted slam stopped 0.14 to 0.16 m short of a lying body on our rigs, even with the IK reach. Executioner is now Gorak and Maw only; Aldric and Hollowjack use Curb Stomp instead.

## Bugs found by looking at the sheets (fixed)

1. **Bodies sinking or flying at the start of every finisher**, and in general on any paused or held clip. three.js only writes a bone when its sampled value changes. While a clip is held (the freeze beat, the alignment window, the last frame of a fall), last frame's post-processing (inertial offsets, IK, springs) stayed on the bones and compounded every frame. One measured case: Vex's chest went to y = -7.4 m for 0.35 s.
   - Fix: each update now starts from the mixer's own previous output (`character.ts`).
   - Side effect: animation pops dropped from 2.3% to 1.1% of transitions, and the transition p95 went from 1674 to 1364.
2. **White-out frames.** These were the closing ring of fire seen from outside (its 0.95-opacity wall filled the lens) and VFX particles right in front of the camera.
   - The ring now thins to 20% when the camera is outside it and low.
   - Particles fade out near the lens: sparks from 0.5 to 2.2 m, smoke from 1.2 to 4.5 m.
   - The impact light now decays in real time during the freeze.
   - The freeze desaturation is softer (0.45).
3. **Banners over finishers.** WINDED and LAST STAND appeared over the kill. Drama banners are now muted during finisher and cut-in shots, and the finisher's own name always shows.
4. **Cut-in blocked by the attacker's back, or a lens at floor level** (only legs visible). Fixed by the new cut-in placement described above.

## Sheets (`sheets/`, director camera, gore off)
- `shoulder_throw_stomp_gorak_erika.jpg`, `hell_slammer_gorak_vex.jpg`, `vampire_kiss_gorak_vex.jpg`, `silent_blade_vex_aldric.jpg`, `executioner_gorak_fenrik.jpg`, `curb_stomp_aldric_gorak.jpg`, `into_the_fire_gorak_erika.jpg`, `immolation_ozrel_gorak.jpg`.
- `finisher-fx.jpg`: every effect in the lab, at gore off, stylised and full.
- I captured and looked at 3 pairings for each finisher (24 filmstrips). They are in `tools/anim/_scratch/fincaps`, which is not committed; one per finisher is committed here.

Reproduce a finisher (`t` = a little before it starts):

| finisher | URL |
|---|---|
| Shoulder throw | `/?auto=1&a=gorak&b=erika&seed=87160&theme=colosseum&layout=cross&aseed=92006&t=48` |
| Hell Slammer | `/?auto=1&a=gorak&b=vex&seed=95096&theme=skytemple&layout=cross&aseed=583296&t=72` |
| Vampire Kiss | `/?auto=1&a=gorak&b=vex&seed=79258&theme=moonlake&layout=pit&aseed=581141&t=69` |
| Silent Blade | `/?auto=1&a=vex&b=aldric&seed=8460&theme=skytemple&layout=gauntlet&aseed=914226&t=95` |
| Executioner | `/?auto=1&a=gorak&b=fenrik&seed=95113&theme=desert&layout=split&aseed=771037&t=63` |
| Curb Stomp | `/?auto=1&a=aldric&b=gorak&seed=63483&theme=forge&layout=split&aseed=51382&t=70` |
| Into the Fire | `/?auto=1&a=gorak&b=erika&seed=15889&theme=sakura&layout=gauntlet&aseed=856741&t=75` |
| Immolation | `/?auto=1&a=ozrel&b=gorak&seed=8181&theme=colosseum&layout=cross&aseed=514322&t=61` |

Add `&gore=full` or `&gore=stylised` to see the gore versions.

## Camera readability (`camera-audit.json`, 8 matches, headless)
The director's cosmetic randomness is now seeded per match during audits, so A/B runs are comparable (within about ±0.3%).

| | start of this round | now |
|---|---|---|
| frames readable (both framed, not hidden, not tiny) | 94.6% | 94.3% |
| contacts on screen | 96.3% | 96.0% |
| cuts / min | 21.6 | 22.7 |
| forge / cross | 91.5% | 88.3% |
| desert / cross | 87.8% | 94.0% |

The before and after numbers come from different fights. The finisher set changed, and the "before" run used unseeded randomness. **The ≥95% target for the cross layouts was not reached.**
- Forge/cross (Erika kiting Fenrik) loses frames mostly to "fighters tiny": over-the-shoulder and crane shots at long range.
- Sakura/gauntlet loses frames to low two-shots behind trees.
- Tried and reverted, because they measured worse: a tighter crane lens (contacts on screen fell to 90%), and a rate-cap change.
- Kept: a stronger penalty for tiny framing in shot scoring (+0.5% overall, +1.6% on forge/cross).

## Animation metrics (`anim-audit.json`, same 4 pairs × 2 seeds as M1)

| | M1 crossfade | M1 inertial + foot lock | now |
|---|---|---|---|
| pop rate | 35.7% | 1.9% | **1.1%** |
| transition peak p95 | 3332 | 1670 | **1364** |
| foot skate (planted frames sliding > 0.35 m/s) | 0.889 | 0.459 | 0.541 |

Foot skate is **not** improved, and it reads worse than M1 on a different fight sample (the sim changed in M2 to M4: launches, finishers).
- The new breakdown shows that 97% of the remaining skate frames happen while the sim moves the fighter at more than 0.3 m/s in idle/block, which in practice means walking and strafing cycles.
- A/B tests of the locomotion rate cap (2.2 / 2.8 / 3.4) and of the idle-to-walk blend thresholds changed nothing (0.525 to 0.531).
- There is no cheap win left. The real fix is stride-matched locomotion (distance-matched cycle playback, or stride warping), which belongs to M5/M9.

## Balance gate (`simtest-40.txt`, 2240 matches)
- Win rates 45.7% to 54.6%.
- **0 timeouts.**
- 0 / 2240 kills without contact.
- Determinism true.
- Mean duration 69.7 s, 92.8% between 45 and 90 s.

One sim change in this round: **sudden death now escalates** (×1.5, then +0.25 per second after 100 s). Two grindy Vex/Aldric matches used to reach the 120 s time limit. Fights that end before 100 s are unaffected.

## Not verified by eye
- Real-time feel: the length of the freeze beat, slow motion, shake, and whether the warp's 0.7 m slide is visible at play speed. I only saw still filmstrips at 0.2 to 0.4 s spacing.
- Gore stylised/full inside real matches: only checked in the lab sheet. Gore off is the default and is what the match sheets show.
- Into the Fire: the landing in the hazard is outside the captured window. I saw the launch and flight, not the burn on landing.
- Immolation: Ozrel's back still fills much of the over-the-shoulder frame in one of the three pairings.
- Behead on Ozrel, Erika and Maw falls back to the cut by design. Their rigs can't split cleanly at the neck.
