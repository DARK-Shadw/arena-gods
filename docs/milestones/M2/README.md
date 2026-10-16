# M2: reaction / fall / get-up / death / dodge variety + LAUNCHES

- The sim picks every timing-relevant clip (hit reaction, fall, get-up, death, dodge, launch) from the measured shared library with its own seeded RNG stream and a per-fighter memory (never the same clip twice in a row, strong penalty within 8 s, mirrors share a softer penalty), weighted by context (hit direction, head/body height, severity, space behind, fighter style, how the body lies for the get-up). The choice and its clip time are recorded in every frame (`FighterFrame.clip / clipT`), so replays and the renderer show exactly what the sim timed.
- LAUNCH: knockdown blows with enough force (knockback x sqrt(attacker weight), x1.2 heavy/ultimate, x1.3 if the victim is off-balance, / victim weight) can throw the victim on a sim-owned ballistic arc (distance 2.4-6.2 m, height 0.8-1.9 m, 0.7-1.05 s). Props on the path break, walls / cover stop the flight (slam), hazards apply only after landing. Geysers and point-blank powder kegs launch too. At most one melee launch per match; the AI favours launchers into hazards / walls (`envCunning`). Render: the clip is warped onto the arc, the body tips back along the flight and the limbs flail on cosmetic springs that settle before landing.

How to judge it
- Launch: `http://localhost:5173/?auto=1&a=maw&b=vex&seed=404&theme=colosseum&layout=pit&aseed=7&t=7.6` (Earthshaker at 8.1 s). Lethal launch: `?auto=1&a=gorak&b=aldric&seed=4242&theme=colosseum&layout=pit&aseed=7&t=77` (killing Skullsplitter at 78.2 s).
- Variety: same match, knockdowns at 1.3 / 10.6 / 14.3 / 37.4 / 69.0 / 72.4 s are six different falls (`knockdown_variety.png`).
- Browse every pool in the Animation Lab: `http://localhost:5173/tools/animlab/` (filter e.g. `hit from:l sev:3`).

Metrics (`repetition.json`, 224 matches; `simtest-40.txt`, 2240 matches)

| pool | R1 same twice | R2 within 8 s | R3 entropy | R4 top share (max / mean) | distinct used | old R1 / distinct |
|---|---|---|---|---|---|---|
| hit | 0% | 0.3% | 0.94 | 7.7 / 6.7% | 86 | 99.4% / 4 |
| fall | 0% | 0.1% | 0.94 | 11.3 / 9.7% | 22 | 100% / 1 |
| get-up | 0% | 0.2% | 0.89 | 22 / 16.9% | 11 | 100% / 1 |
| death | 0% | 0% | - | 16.7 / 11.4% | 59 (R5 = 6) | 1 |
| dodge | 0% | 0.1% | 0.94 | 11.6 / 8.5% | 25 | 43% / 3 |
| launch | 0% | 0% | - | 42.9 / 25.5% | 15 | - |

Balance (40 seeds/pair): duration 69.2 s mean (93% in 45-90 s), >=2 swings 54%, timeouts 0%, win rates 45.4-55.0%, kills without contact 0/2239, determinism true. Launches 0.89/match (0.70 melee + 0.19 environment), present in 77% of matches; heavy fighters launch most (Maw ~1.0 per appearance, Vex ~0.15).
Phantom-hit audit (16 matches, 405 melee hits): p99 0.245 m, max 0.273 m, 0 deaths without a hit.
