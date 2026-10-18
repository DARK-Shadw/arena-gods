/**
 * Seeded FX randomness. Every random number an effect uses comes from here, so
 * the same (match seed, event, effect, layer) always produces the same particles
 * in live play, in a replay and after a `?t=` jump.
 *
 * Never use the sim RNG (src/sim has its own; FX must not consume it) and never call
 * unseeded randomness, the wall clock or timers from `src/render/fx` (grep gate in docs/fx-api.md).
 */

/** 32-bit integer hash of one value (lowbias32 by Chris Wellons). */
export function hash1(x: number): number {
  x = (x | 0) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Combine several integers into one 32-bit hash (order matters). */
export function hashN(...xs: number[]): number {
  let h = 0x9e3779b9;
  for (const x of xs) h = hash1((h ^ hash1(x)) + 0x9e3779b9 + (h << 6) + (h >>> 2));
  return h >>> 0;
}

/** FNV-1a hash of a string (effect ids, emitter names). */
export function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Small, fast seeded stream (mulberry32). One stream per spawned effect layer;
 * it is cheap to create, so create one per spawn rather than sharing.
 */
export class FxRng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x6d2b79f5;
  }
  reseed(seed: number) {
    this.s = seed >>> 0 || 0x6d2b79f5;
    return this;
  }
  /** next unsigned 32-bit value */
  u32(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let z = this.s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return (z ^ (z >>> 14)) >>> 0;
  }
  /** uniform in [0, 1) */
  next(): number {
    return this.u32() / 4294967296;
  }
  /** uniform in [a, b) */
  range(a: number, b: number): number {
    return a + this.next() * (b - a);
  }
}

/** Seed for one spawn: hash(matchSeed, key, effect id hash, sub index). */
export function spawnSeed(matchSeed: number, key: number, idHash: number, sub = 0): number {
  return hashN(matchSeed, key, idHash, sub);
}
