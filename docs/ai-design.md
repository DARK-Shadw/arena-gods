# Arena AI: design notes

**Goal:** fights should read like two beings with intent. Each fighter plays to its strengths against this particular opponent, makes human mistakes, and adapts during the fight. The sim stays deterministic and runs headless.

Code: `src/sim/ai.ts` (decisions), `src/sim/doctrine.ts` (per-fighter doctrine), `src/sim/reach.ts` + `reach.gen.ts` (animation-true reach), `tools/aiMetrics.ts` (measurement).

## Ideas borrowed, and where they live in code

| Idea | Source | How it became code |
|---|---|---|
| **Utility AI**: score many options and pick by weighted utility, not by a rigid tree | Dave Mark / Kevin Dill GDC talks on utility theory and the Infinite Axis Utility System ([Wikipedia: Utility system](https://en.wikipedia.org/wiki/Utility_system), [gameai.com IAUS](https://gameai.com/iaus.php)) | `scoreGoals()` scores 12 goals; `chooseMove()` scores every usable move. Seeded noise plus a commitment bonus means no robotic determinism and no dithering. |
| **OODA loop**: Observe → Orient → Decide → Act; whoever cycles faster gets "inside" the opponent's loop | John Boyd ([SAGE encyclopedia entry](https://sk.sagepub.com/ency/edvol/embed/encyclopedia-of-military-science/chpt/ooda-observe-orient-decide-act), [LessWrong summary](https://www.lesswrong.com/posts/hgttKuASB55zjoCKd/the-ooda-loop-observe-orient-decide-act)) | Layered loop: `observe()` (opponent model) → `perceive()` (orientation: spacing, openings, cornered, LOS, matchup) → `scoreGoals()` → `chooseMove()` / `steer()`. Think rate scales with aggression and reaction time with skill, so faster, sharper fighters out-cycle slower ones. |
| **Neutral, footsies, whiff punishing**: control the space just outside the opponent's range and punish their recovery when they miss | Fighting-game community wikis and guides ([Dustloop neutral notes](https://dustloop.com/w/User:Cob/GGST/Anji/Neutral), [SRK wiki: Footsies](https://srk.shib.live/w/Footsies), [PlayStation footsies guide](https://compete.playstation.com/en-us/article/learn-how-to-play-neutral-footsies-mortal-kombat-11-ultimate-guide)) | `threatRange()` computes the opponent's effective reach from real animation reach + lunge. The `footsies` goal oscillates the gap around that edge and pokes when the opponent steps in. The `punish` goal fires the fastest move that lands inside the opening (`openWindow()`). Counter moves are only allowed into openings. |
| **Measure and tempo** (HEMA / fencing): distance and time are interchangeable, and you defend by stepping out of measure rather than only by parrying | Fencing/HEMA writing on measure and tempo ([David Biggs on measure](https://davidbiggs.substack.com/p/youre-probably-not-using-measure), [ARMA forum on tempo](https://www.thearma.org/forum/viewtopic.php?p=39567)) | Reaction option **backstep**: if `(timeToActive - reaction) × speed` exceeds the reach overlap, step out instead of blocking. That causes whiffs, which the other layer punishes. |
| **Yomi / mind games**: layered prediction; feints exploit an opponent who reacts | David Sirlin, *Playing to Win* ([sirlin.net/ptw](https://www.sirlin.net/ptw); [Game Developer: Designing for Yomi](https://www.gamedeveloper.com/design/know-thy-enemy-designing-for-yomi-in-games)) | **Feint** moves cancel at 62% of their windup. The `bait` goal and move utility favour feints against opponents with high block/dodge/parry rates. The defender learns the feint rate (`opp.feints`) and bites less often: one prediction layer up. |
| **Readable telegraphs; enemies attack at varied intervals** | Arkham-style melee design discussion ([Game Developer: AI in Game Design](https://www.gamedeveloper.com/design/artificial-intelligence-in-game-design); [GDC09 hands-on](https://www.engadget.com/2009-03-27-gdc09-batman-arkham-asylum-hands-on.html)) | Heavy windups notice more easily, and the telegraph decal remains. Timing mix-ups: about 35% of non-punish attacks are queued with a short random (seeded) delay, so fighters don't always swing the instant they can. |
| **Kiting and zoning** (MOBA/RTS micro): hold the range band, shoot while retreating, use terrain | General RTS/MOBA micro practice | Doctrine `band` per fighter. `kite`/`regroup` steer away from the opponent with an inward bias (never into the wall). Ranged roles hold their band for finish/punish/bait instead of walking in. Projectiles collide with pillars, so the `cover` goal puts a pillar between a melee fighter and a shooter. Backpedalling runs at 0.8× speed, so chasers can eventually close. |
| ***Book of Five Rings***: don't let the opponent recover, and "cut off" their ground | Miyamoto Musashi (classical text) | The `pressure` goal approaches on the opponent-to-centre line to cut off the ring. Greed after a landed hit extends strings. Cornered fighters run `escape`: slide along the wall, then turn inward. |

## Decision layers (per tick / per think)

1. **Reaction ("System 1")**, every tick. When a new opponent windup starts and its real reach covers us, roll a notice check (skill plus telegraph size). After a human reaction delay, choose one of: block, timed parry, dodge (timed to i-frames), backstep out of measure, counter-attack into the windup, or eat it. Shields and skill bias the choice. Incoming projectiles trigger a sidestep or shield block.
2. **Perception**: gap, both HP, opening window, opponent threat range, my band, doctrine pair, cornered (me or them), line of sight past pillars, stamina, whether the opponent is pressing.
3. **Goal utility**: punish, finish, pressure, close, kite, footsies, bait, guard, regroup, cover, escape, gambit. Each goal is weighted by personality (aggression, caution, pride, desperation, patience, adaptability), doctrine role (rushdown, bruiser, duelist, zoner, kiter, trickster, tank), matchup fears, and a commitment bonus.
4. **Action**: goal-specific footwork plus a move from `chooseMove()`. Its utility factors are:
   - Move tags for the goal: poke, opener, string, launcher, guardbreak, counter, feint, sweep, antirush, escape, zone, gapclose.
   - Opponent model. If they block a lot, use guard-breakers and feints. If they dodge, use multi-hit moves and sweeps. If they parry, feint.
   - A repetition penalty (stubborn fighters care less).
   - Recovery risk against fast opponents, stamina, and whether the windup fits the opening.
5. **Human mistakes**:
   - Spacing misjudged in proportion to (1 − skill), so low-skill fighters swing from too far.
   - Greed after a hit.
   - Panic rolls at low HP for low-composure fighters.
   - Slow learning for low-adaptability personalities.

## Doctrines

| Fighter | Role | Band (edge gap, m) | Win condition |
|---|---|---|---|
| Gorak | bruiser | 0.3–1.8 | corner, armored heavies |
| Aldric | duelist | 0.7–2.0 | block/parry, punish with sword strings, advance behind the shield vs shooters |
| Ozrel | zoner | 2.2–5.0 | mid-range fire, ward/nova anyone who closes |
| Erika | kiter | 2.6–6.8 | shoot from range, kick to make space, retreat |
| Vex | trickster | 0.6–2.6 | dart in, strike, fade out, feints |
| Fenrik | rushdown | 0–1.4 | stay in the face, chain claws |
| Maw | tank | 0.4–2.2 | walk down, absorb, one crushing blow |
| Hollowjack | bruiser | 0.2–1.7 | smother with kicks, slam when they freeze |

## Hit contact (A2)

- The sim tests the animation's actual strike points against the target's body capsule:
  - The points are the effector bone and the weapon tip, sampled from each Mixamo clip around its contact frame (the frame of maximum forward extension).
  - The test is a swept segment-vs-capsule check across each tick of the active window.
  - Clip time comes from the same time-warp the renderer uses.
- **Magnetism and tracking**: melee attacks step in up to 0.6 m beyond their lunge. The lunge re-aims every tick and travels during the windup, so the body arrives as the blow lands.
- **Projectiles** are physical sim entities. They must reach the target (or be blocked by a pillar) before damage applies.
- Chip, ring-fire and prop damage can no longer kill. Deaths always come from a visible blow or a wall/pillar slam.
- Audit: `__arena.audit(pairs, seeds)` in the browser measures, with the real rendered rigs, the swept distance from strike point to body at every hit event.
