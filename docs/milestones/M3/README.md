# M3: arena-aware entrances

- **Stage anchors.** Every theme's gate builder (`src/render/arena/dress*.ts` → `makeGate`) declares named anchors: barrier, perches, stands, low wall, rim.
  - `snapAnchors` (`src/cinematic/entrance.ts`) raycasts each anchor onto the geometry that was actually built.
  - An anchor survives only if it lands on a real surface **and** has head room. Perches need 2.3 m of clear space above the landing point and above the take-off point.
  - The low wall used for a vault is searched sideways until the whole vault path has 1.2 m of clearance and there is real ground at the run-up and landing points.
  - A variant whose anchor is gone is never chosen. On low-rim themes, Vex and Hollowjack fall back to their other entrances (rim climb, shadow rise, gate burst).
- **Beat entrances, all 8 fighters** (`src/data/entranceVariants.ts`):
  - Gorak: cage breaker. The barrier breaks on the axe's measured contact frame.
  - Vex: perch drop, rim climb, or shadow rise.
  - Hollowjack: stands leap, fence vault, or gate burst.
  - Aldric: shield march. Ozrel: fire pillar. Erika: torch path. Fenrik: shadow leap. Maw: great gate.
  - Each is a list of beats with movement, clips and event-bound cues (impacts, debris, shake, slow motion), plus a camera track.
- **Camera.** Low cameras step out of cover/hazard rims (`pushOut`) and orbit around cover (`resolveCamera`). New in this round, a last check on the **interpolated** camera:
  - It does a real line-of-sight raycast against the built geometry, to catch decor the layout data does not know about (brazier stands, lanterns, rubble, stands).
  - If the view is blocked, it picks from fixed alternatives: higher, closer, higher still, or onto the gate axis. The chosen alternative sticks for that shot, and the camera re-aims at the actor.

## Validation (headless, every fighter × every theme × every layout × both gates)

`__arena.validateEntrances({})` checks each entrance frame by frame for:
- support: feet or root on a surface
- head room under ceiling-like faces
- body inside solid geometry
- camera inside geometry
- line of sight from the camera to the actor
- actor inside the frame
- barrier causality: a break happens with the hand, weapon or body at the barrier

Final run on this branch (vite build snapshot, `entrance-validation.json`): **638 configurations, 0 failures.**

| variant | configs | failed |
|---|---|---|
| gorak cage_breaker | 70 | 0 |
| aldric shield_march | 70 | 0 |
| ozrel fire_pillar | 70 | 0 |
| erika torch_path | 70 | 0 |
| vex perch_drop / rim_climb / shadow_rise | 40 / 20 / 70 | 0 |
| fenrik shadow_leap | 70 | 0 |
| maw great_gate | 70 | 0 |
| hollowjack stands_leap / fence_vault / gate_burst | 8 / 10 / 70 | 0 |

By theme: colosseum 98, skytemple 90, sakura 100, forge 80, glacier 80, moonlake 100, desert 90. All clean, including the low-rim themes (sakura, moonlake, desert, glacier).

How the earlier failures were fixed:
- Vex perch drop (10/40 failing): the colosseum perch moved to the entablature corners, perches got the head-room rule, and the drop lands inside the arena with a wider, higher camera.
- Hollowjack fence vault (sakura trees, the skytemple drop-off): the vault-path clearance and real-ground checks.
- Hollowjack gate burst: the run-up starts inside the tunnel's real depth (desert sand).
- Gorak forge/cross and Maw/Erika/Aldric occlusions: the line-of-sight fallback.
- Vex moonlake: the validator now ignores transparent non-BackSide planes, which were false positives.

## Sheets (`sheets/`)
`entrance_gorak_glacier.jpg` (cage breaker on ice), `entrance_gorak_sakura.jpg` (torii gate, low rim), `entrance_hollowjack_desert.jpg` (gate burst), `entrance_vex_colosseum.jpg` (shadow rise, then the walk to the mark).

How to judge it: `http://localhost:5173/?auto=1&a=gorak&b=vex&seed=4242&theme=sakura&layout=oval&aseed=5`. Change `a`, `theme` and `layout` to try others; the intro plays both entrances.

What was checked by eye, and what was not:
- I looked at the four sheets above. They show the barrier break with debris, the landing, the name card, and no clipping or floating in those frames.
- I did **not** look at every one of the 638 configurations. Those are covered only by the validator's geometric checks.
- One oddity in the Vex sheet: after her name card, the camera shows her up on the colosseum stands. I believe this is the start of the walk to her mark, but I did not confirm it by watching in real time.
- Timing and feel (pacing of slow motion and shake) were not judged.
