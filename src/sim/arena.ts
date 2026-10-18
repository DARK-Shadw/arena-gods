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

/** Current ring radius for anti-stall shrink at time t (pre-A2b arena size). */
export function ringRadiusAt(t: number): number {
  if (t <= ARENA.shrinkStart) return ARENA.fightR;
  const k = Math.min(1, (t - ARENA.shrinkStart) / (ARENA.shrinkEnd - ARENA.shrinkStart));
  const e = k * k * (3 - 2 * k);
  return ARENA.fightR + (ARENA.minR - ARENA.fightR) * e;
}

/**
 * A2b: ring-of-fire scale of an arena's ellipse at time t. Arenas are ARENA_SCALE bigger since A2b; the ring closes
 * to the same ABSOLUTE size as before (6.5 m geometric-mean radius x RING_END_GROW), so the end game stays as tight as it was
 * (tried 1.1 and 0.95: mean duration moved by less than 0.1 s; starting the shrink 4 s earlier moved it 0.3 s).
 */
export const RING_END_GROW = 1.0;
export function ringScaleAt(t: number, L: { rx: number; rz: number }): number {
  if (t <= ARENA.shrinkStart) return 1;
  const k = Math.min(1, (t - ARENA.shrinkStart) / (ARENA.shrinkEnd - ARENA.shrinkStart));
  const e = k * k * (3 - 2 * k);
  const minS = Math.min(1, (ARENA.minR * RING_END_GROW) / Math.sqrt(L.rx * L.rz));
  return 1 + (minS - 1) * e;
}
