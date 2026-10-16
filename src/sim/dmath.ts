/**
 * Cross-engine deterministic math for the simulation.
 *
 * Math.sin / cos / atan2 / exp / pow are implementation-defined in JavaScript:
 * Node and Chromium (different V8 builds) return different last bits, and the
 * fight is chaotic, so one ulp eventually flips an AI decision and the "same
 * seed" plays out differently in the browser and in `npm run sim:test`.
 * These versions only use + - * / and sqrt (correctly rounded IEEE-754
 * everywhere), so every engine computes bit-identical results.
 * Accuracy ~1e-15, far below anything the sim cares about.
 */
const PI = Math.PI;
const HALF_PI = PI / 2;
const LN2 = Math.LN2;
const SQRT3 = Math.sqrt(3);
const TAN_PI_12 = 2 - SQRT3; // tan(15 deg)

const S3 = -1 / 6,
  S5 = 1 / 120,
  S7 = -1 / 5040,
  S9 = 1 / 362880,
  S11 = -1 / 39916800,
  S13 = 1 / 6227020800,
  S15 = -1 / 1307674368000;
const C2 = -1 / 2,
  C4 = 1 / 24,
  C6 = -1 / 720,
  C8 = 1 / 40320,
  C10 = -1 / 3628800,
  C12 = 1 / 479001600,
  C14 = -1 / 87178291200;

function sinPoly(x: number) {
  const x2 = x * x;
  return x * (1 + x2 * (S3 + x2 * (S5 + x2 * (S7 + x2 * (S9 + x2 * (S11 + x2 * (S13 + x2 * S15)))))));
}
function cosPoly(x: number) {
  const x2 = x * x;
  return 1 + x2 * (C2 + x2 * (C4 + x2 * (C6 + x2 * (C8 + x2 * (C10 + x2 * (C12 + x2 * C14))))));
}

export function sin(x: number): number {
  const q = Math.round(x / HALF_PI);
  const r = x - q * HALF_PI;
  switch (((q % 4) + 4) % 4) {
    case 0:
      return sinPoly(r);
    case 1:
      return cosPoly(r);
    case 2:
      return -sinPoly(r);
    default:
      return -cosPoly(r);
  }
}

export function cos(x: number): number {
  const q = Math.round(x / HALF_PI);
  const r = x - q * HALF_PI;
  switch (((q % 4) + 4) % 4) {
    case 0:
      return cosPoly(r);
    case 1:
      return -sinPoly(r);
    case 2:
      return -cosPoly(r);
    default:
      return sinPoly(r);
  }
}

function atanPoly(z: number) {
  // |z| <= tan(15deg): alternating series to z^23
  const z2 = z * z;
  let term = z,
    sum = z;
  for (let k = 3; k <= 23; k += 2) {
    term *= -z2;
    sum += term / k;
  }
  return sum;
}

export function atan(x: number): number {
  if (x !== x) return x;
  let sign = 1;
  if (x < 0) {
    x = -x;
    sign = -1;
  }
  let inv = false;
  if (x > 1) {
    x = 1 / x;
    inv = true;
  }
  let off = 0;
  if (x > TAN_PI_12) {
    // atan(x) = pi/6 + atan((x*sqrt3 - 1) / (x + sqrt3))
    off = PI / 6;
    x = (x * SQRT3 - 1) / (x + SQRT3);
  }
  let r = off + atanPoly(x);
  if (inv) r = HALF_PI - r;
  return sign * r;
}

export function atan2(y: number, x: number): number {
  if (x > 0) return atan(y / x);
  if (x < 0) return y >= 0 ? atan(y / x) + PI : atan(y / x) - PI;
  return y > 0 ? HALF_PI : y < 0 ? -HALF_PI : 0;
}

/** exact power of two */
function pow2(k: number): number {
  let r = 1;
  let b = k >= 0 ? 2 : 0.5;
  let n = Math.abs(k);
  while (n) {
    if (n & 1) r *= b;
    b *= b;
    n >>>= 1;
  }
  return r;
}

export function exp(x: number): number {
  if (x > 709) return Infinity;
  if (x < -745) return 0;
  const k = Math.round(x / LN2);
  const r = x - k * LN2;
  let s = 1,
    t = 1;
  for (let i = 1; i <= 16; i++) {
    t *= r / i;
    s += t;
  }
  return s * pow2(k);
}

/** natural log (x > 0) */
export function log(x: number): number {
  if (!(x > 0)) return x === 0 ? -Infinity : NaN;
  let e = 0;
  while (x > 2) {
    x /= 2;
    e++;
  }
  while (x < 1) {
    x *= 2;
    e--;
  }
  // x in [1, 2): log(x) = 2 atanh(u), u = (x-1)/(x+1) in [0, 1/3)
  const u = (x - 1) / (x + 1);
  const u2 = u * u;
  let term = u,
    sum = u;
  for (let k = 3; k <= 41; k += 2) {
    term *= u2;
    sum += term / k;
  }
  return 2 * sum + e * LN2;
}

/** a^b; integer exponents are exact repeated multiplication */
export function pow(a: number, b: number): number {
  if (Number.isInteger(b) && Math.abs(b) <= 64) {
    let r = 1;
    let base = b >= 0 ? a : 1 / a;
    let n = Math.abs(b);
    while (n) {
      if (n & 1) r *= base;
      base *= base;
      n >>>= 1;
    }
    return r;
  }
  if (a === 0) return 0;
  return exp(b * log(a));
}

/** sqrt is correctly rounded everywhere; Math.hypot is not guaranteed to be */
export function hypot(a: number, b: number, c = 0): number {
  return Math.sqrt(a * a + b * b + c * c);
}
