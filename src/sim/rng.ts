/**
 * Seeded PRNG (mulberry32). Every random decision in the simulation MUST go
 * through an instance of this class so that the same seed reproduces the same
 * fight bit-for-bit (in Node and in the browser).
 */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }
  /** Uniform float in [0,1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  /** Approximate standard normal (sum of uniforms). */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.732;
  }
  /** Weighted choice; returns index or -1 if all weights are 0. */
  weighted(weights: number[]): number {
    let sum = 0;
    for (const w of weights) sum += Math.max(0, w);
    if (sum <= 0) return -1;
    let r = this.next() * sum;
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }
}

/** Hash a string seed into a 32-bit integer. */
export function hashSeed(s: string | number): number {
  if (typeof s === 'number') return s >>> 0;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
