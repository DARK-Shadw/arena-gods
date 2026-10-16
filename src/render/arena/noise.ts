/**
 * Small seeded noise toolkit for CPU-side procedural content (textures,
 * geometry displacement). Value noise + fbm + domain warp + worley.
 */
export function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 1440662683 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const fade = (t: number) => t * t * (3 - 2 * t);

/** 2D value noise in [0,1], optionally periodic (for tiling textures). */
export function vnoise2(x: number, y: number, seed = 0, period = 0): number {
  const xi = Math.floor(x),
    yi = Math.floor(y);
  const xf = x - xi,
    yf = y - yi;
  const w = (v: number) => (period ? ((v % period) + period) % period : v);
  const a = hash2(w(xi), w(yi), seed),
    b = hash2(w(xi + 1), w(yi), seed),
    c = hash2(w(xi), w(yi + 1), seed),
    d = hash2(w(xi + 1), w(yi + 1), seed);
  const u = fade(xf),
    v = fade(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm2(x: number, y: number, oct = 5, seed = 0, period = 0, lac = 2, gain = 0.5): number {
  let s = 0,
    a = 0.5,
    f = 1,
    n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise2(x * f, y * f, seed + i * 17, period ? period * f : 0);
    n += a;
    a *= gain;
    f *= lac;
  }
  return s / n;
}

export function vnoise3(x: number, y: number, z: number, seed = 0): number {
  const xi = Math.floor(x),
    yi = Math.floor(y),
    zi = Math.floor(z);
  const xf = fade(x - xi),
    yf = fade(y - yi),
    zf = fade(z - zi);
  const h = (i: number, j: number, k: number) => hash3(xi + i, yi + j, zi + k, seed);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(l(l(h(0, 0, 0), h(1, 0, 0), xf), l(h(0, 1, 0), h(1, 1, 0), xf), yf), l(l(h(0, 0, 1), h(1, 0, 1), xf), l(h(0, 1, 1), h(1, 1, 1), xf), yf), zf);
}
export function fbm3(x: number, y: number, z: number, oct = 4, seed = 0): number {
  let s = 0,
    a = 0.5,
    f = 1,
    n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise3(x * f, y * f, z * f, seed + i * 31);
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / n;
}

/** Worley (cellular) distances F1, F2 for tiling cell patterns. */
export function worley2(x: number, y: number, seed = 0, period = 0): [number, number, number] {
  const xi = Math.floor(x),
    yi = Math.floor(y);
  let f1 = 9,
    f2 = 9,
    id = 0;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      let cx = xi + i,
        cy = yi + j;
      const wx = period ? ((cx % period) + period) % period : cx,
        wy = period ? ((cy % period) + period) % period : cy;
      const px = cx + hash2(wx, wy, seed),
        py = cy + hash2(wx, wy, seed + 7);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash2(wx, wy, seed + 13);
      } else if (d < f2) f2 = d;
      void cx;
      void cy;
    }
  return [f1, f2, id];
}

/** Mulberry-ish quick seeded random for render-side placement. */
export class R {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
  pick<T>(a: readonly T[]): T {
    return a[Math.floor(this.next() * a.length)];
  }
}
