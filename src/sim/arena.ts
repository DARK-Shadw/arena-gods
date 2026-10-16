/**
 * Match-wide arena constants (timings, start marks). The arena GEOMETRY
 * (boundary ellipse, cover, props, hazards) is generated per match by
 * sim/arenaGen.ts; fightR / minR here define the ring-of-fire shrink scale.
 * Coordinates: x/z ground plane, origin at arena center. Units are meters.
 */
export const ARENA = {
  /** Inner radius of the spiked arena wall. */
  wallR: 13,
  /** Max radius for fighter centers (before shrink). */
  fightR: 12.3,
  wallHeight: 3.2,
  /** Ring shrink (anti-stall): starts at shrinkStart, reaches minR at shrinkEnd. */
  shrinkStart: 62,
  shrinkEnd: 92,
  minR: 6.5,
  suddenDeath: 100,
  timeLimit: 120,
  /** Fighters start this far from center. */
  startR: 5,
  /** Gates: fighter 0 enters from -X, fighter 1 from +X. */
  gateAngle: [Math.PI, 0] as const,
};

/** Current ring radius for anti-stall shrink at time t. */
export function ringRadiusAt(t: number): number {
  if (t <= ARENA.shrinkStart) return ARENA.fightR;
  const k = Math.min(1, (t - ARENA.shrinkStart) / (ARENA.shrinkEnd - ARENA.shrinkStart));
  const e = k * k * (3 - 2 * k);
  return ARENA.fightR + (ARENA.minR - ARENA.fightR) * e;
}
