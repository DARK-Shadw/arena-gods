# M1: pose pipeline (inertialization, spring flinch, sync groups, foot locking)

What changed (render only, the sim is untouched):
- Inertialized transitions (Bollo's quintic) replace the normalised cross-fade: the new clip is shown at full weight immediately and the old pose decays out; the transition table (blend time per from/to category) lives in `src/render/character.ts` (`TRANSITIONS`).
- Spring flinch additive on spine / neck / head / shoulders / arms, driven by the hit direction, integrated in real time, so the victim keeps reacting while hit-stop freezes the attacker (asymmetric hit-stop).
- Locomotion sync group (walk / strafe / run share one foot phase) and phase-matched re-entry into locomotion.
- Two-bone IK foot locking while the clip has a foot planted.

How to judge it
- Game: `http://localhost:5173/?auto=1&a=gorak&b=aldric&seed=4242&theme=colosseum&layout=pit&aseed=7&t=12.4` (Skull Crack + knockdown at 12.9 s). Press P to pause, C for a free camera.
- A/B in the same match: add `&blend=xfade` (old cross-fade) and/or `&feet=0` (no foot locking).
- `heavy_hit_flinch_sequence.png`: 0.05 s steps around a heavy hit.

Measured (`anim-audit.json`, 8 matchups, 34.6k frames, 1708 transitions):

| | cross-fade (old) | inertial | inertial + foot lock |
|---|---|---|---|
| transition peak joint accel p50 (m/s^2) | 1174 | 457 (-61%) | ~600 |
| transition peak p95 | 3332 | 1682 (-50%) | ~1674 |
| pop rate (peak > 3x global p95) | 35.7% | 4.6% | ~2% |
| foot skate ratio (planted frames sliding > 0.35 m/s) | 0.89 | 0.89 | ~0.45 |
| CPU per fighter update | ~0.2 ms | ~0.2 ms | ~0.15-0.25 ms |

Known: foot skating is halved, not solved (fighters move faster than the clips' stride; stride warping is M9). Foot-lock releases raise the overall joint-acceleration p95 slightly.
