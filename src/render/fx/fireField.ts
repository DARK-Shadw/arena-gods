/**
 * A19 FIRE FIELD (F4 E01 for the Moon Gate): every static arena fire (braziers, fire bowls, torches, tier fires, burning
 * debris, the fire cage, burning-oil pools, fire-jet vents) drawn as ONE layered, stateless GPU system instead of one
 * flipbook card per flame (F3's FxFlames, still used by every other theme and by `?arena=legacy`).
 *
 * The arena registers each fire (`add`) with the object that carries it (position, visibility, parent scale), its size,
 * kind and width; every frame `update` writes one RGBA32F texel pair per fire into a tiny data texture (position, size x
 * live intensity | flicker, height scale, width, kind) and sets the clock / wind uniforms. Everything else is a pure
 * function of (fire, role, seed, time) in the vertex shaders, so the same clock gives the same picture (seeks, replays,
 * the concept harness) and the CPU cost is one small texture upload. Draws (one each):
 *
 *   flames  FX_ALPHA (+ the planar reflection): per fire up to 6 cards from the Unity Flame02 atlas (already loaded for
 *           F3): 0 a soft additive glow halo (the haze lit round the fire, procedural), 1 the wide body, 2 a short white-hot
 *           core, 3 / 4 side licks with their own phase and lean, 5 a tall back lick. World-space cylindrical cards (upright
 *           flames in the mirrored reflection camera too), leaning with the wind, height x the flicker.
 *   smoke   FX_ALPHA: per fire up to 6 looping puffs of the Unity WispySmoke01 atlas (core) rising, slowing, growing and
 *           drifting downwind, warm-lit at the base by the fire, cold and dark above, so the columns spread into haze.
 *   embers  FX_ALPHA, additive (alpha 0): per fire up to 12 sparks on looping seeded cycles (some cycles skipped), rising
 *           with drag, curling, carried by the wind, cooling from yellow-white to deep red; velocity-stretched dots.
 *   heat    FX_DIST (the F1 distortion pass): one shimmer column per large fire within 32 m (high tier only).
 *
 * Tiers scale counts, not the look: flame cards 4 / 5 / 6, smoke puffs 3 / 4 / 6, embers 4 / 7 / 12 per fire (q0 / q1 /
 * q2), heat on q2. Far fires (> 40 m) drop their side licks. Render only: nothing here reads or writes sim state.
 */
import * as THREE from 'three';
import { FLIPBOOK_PARS, type FxAtlases } from './atlas';
import { LAYER } from './fxLayers';
import { SOFT_DEPTH_PARS, softDepthUniforms } from './softDepth';

export type FireKind = 'bowl' | 'torch' | 'candle' | 'oil' | 'jet';
const KIND_ID: Record<FireKind, number> = { bowl: 0, torch: 1, candle: 2, oil: 3, jet: 4 };

/** ThemeArt.fire: the A19 fire field + environment knobs (kit Moon Gate) */
export interface FireArt {
  /** wind: base azimuth (deg, direction the wind blows TOWARD, sim / three x-z), mean strength, gust share */
  wind: { az: number; base: number; gust: number };
  /** smoke colour (lit by the fire at the base), opacity */
  smoke: { color: string; opacity: number };
  /** HDR multipliers: flame body, core, glow halo, embers */
  gain: { body: number; core: number; glow: number; embers: number };
  /** heat shimmer strength (q2) */
  heat: number;
  /** real fire PointLights per tier [q0, q1, q2] (the rest light stone through the stage-light loop) */
  lights: [number, number, number];
}

export interface FireSrc {
  /** the arena's flame group: position, visibility chain, parent scale */
  obj: THREE.Object3D;
  size: number;
  kind: FireKind;
  /** lateral spread (m): wide bowls and oil pools get licks across their width */
  wid: number;
  /** flicker multiplier (arena) */
  k: number;
  /** live intensity 0..1 (owners: fire jets, oil pools); 1 by default */
  amp: number;
  /** height scale (fire jets) */
  h: number;
  /** index in the data texture */
  i: number;
}

const MAXS = 128;
/** cards per role table: flame roles 0..5, smoke puffs 0..5, embers 0..11 */
const N_FLAME = 6,
  N_SMOKE = 6,
  N_EMBER = 12;
const TIER = {
  flame: [3, 4, 5],
  smoke: [3, 4, 6],
  ember: [4, 7, 12],
} as const;

const COMMON_VS = /* glsl */ `
uniform sampler2D uSrc;
uniform float uTime;
uniform vec3 uWind; // x, z: wind vector (m/s-ish), y: gust 0..1
attribute vec4 aI;  // fire index, role, r1, r2
vec4 srcA() { return texelFetch(uSrc, ivec2(int(aI.x + 0.5), 0), 0); }
vec4 srcB() { return texelFetch(uSrc, ivec2(int(aI.x + 0.5), 1), 0); }
float h11(float x) { return fract(sin(x * 127.1 + 31.7) * 43758.5453); }
vec3 camRightH() { vec3 r = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]); r.y = 0.0; float l = length(r); return l > 1e-3 ? r / l : vec3(1.0, 0.0, 0.0); }
`;

// ------------------------------------------------------------------ flames (+ glow halo)
const FLAME_VS = /* glsl */ `
${COMMON_VS}
uniform float uFrames;
uniform float uFps;
uniform float uMaxRole;
uniform vec2 uNear;
varying vec2 vUv;
varying float vDepth;
varying vec4 vC;
varying float vFr;
varying float vRole;
varying float vFlip;
void main() {
  vec4 A = srcA();
  vec4 B = srcB();
  float size = A.w;
  float role = aI.y;
  float kind = B.w;
  float candle = step(1.5, kind) * step(kind, 2.5);
  float oil = step(2.5, kind) * step(kind, 3.5);
  float jet = step(3.5, kind);
  vec4 c0 = modelViewMatrix * vec4(A.xyz, 1.0);
  float dist = -c0.z;
  bool cull = size <= 0.002 || role > uMaxRole + 0.5;
  if (candle > 0.5 && role > 0.5 && role != 2.0) cull = true;
  if (dist > 40.0 && role > 2.5) cull = true;
  if (cull) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vC = vec4(0.0); return; }
  float flick = B.x, hs = B.y, wid = B.z;
  float r1 = aI.z, r2 = aI.w;
  // per role: lateral offset (m), width, height, base lift, intensity, frame rate scale
  float ox = 0.0, w = size, h = size, lift = 0.0, I = 1.0, rate = 1.0;
  float sway = sin(uTime * (1.3 + r1) + r2 * 6.28);
  if (role < 0.5) {         // glow halo: centred on the flame body
    w = h = (size * 2.1 + wid * 0.8) * (0.85 + 0.15 * flick) * (candle > 0.5 ? 0.8 : 1.0);
    lift = size * 0.35 * hs - h * 0.5;
  } else if (role < 1.5) {  // body
    w = size * 0.62 + wid * 0.55;
    h = size * 1.75 * hs * flick * (1.0 - 0.4 * oil);
    lift = -size * 0.1;
  } else if (role < 2.5) {  // core (candles: the whole flame)
    w = candle > 0.5 ? size * 0.85 : size * 0.42 + wid * 0.4;
    h = (candle > 0.5 ? size * 1.7 : size * 0.95 * (1.0 - 0.3 * oil)) * hs * mix(1.0, flick, 0.6);
    lift = -size * 0.12;
    rate = 1.25;
  } else if (role < 4.5) {  // side licks
    float sd = role < 3.5 ? -1.0 : 1.0;
    ox = sd * (wid * 0.5 + size * 0.08 + 0.04 * sway * size);
    w = size * 0.55 + wid * 0.15;
    h = size * (1.2 + 0.6 * r1) * hs * (0.85 + 0.25 * sin(uTime * (2.1 + r2) + r1 * 9.0)) * flick * (1.0 - 0.4 * oil);
    lift = -size * 0.08;
    rate = 0.9 + 0.3 * r2;
  } else {                  // tall back lick
    ox = (r1 - 0.5) * wid * 0.5;
    w = size * 0.6;
    h = size * 2.0 * hs * flick * (1.0 - 0.45 * oil);
    lift = -size * 0.05;
    rate = 0.8;
  }
  vec2 q = position.xy; // -0.5..0.5
  vec3 right = camRightH();
  vec3 wp;
  if (role < 0.5) {
    // the glow halo faces the camera (a haze sphere)
    vec4 mv = c0;
    mv.y += lift + h * 0.5;
    mv.xy += q * vec2(w, h);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  } else {
    // flame cards: upright (world y), turned to the camera about y; the top leans downwind (more at the tip)
    float y01 = q.y + 0.5;
    vec2 lean = uWind.xz * (0.16 + 0.1 * uWind.y) * y01 * y01 * h / max(size, 0.2) * (1.0 + 0.6 * jet);
    wp = A.xyz + right * (ox + q.x * w) + vec3(lean.x, lift + y01 * h, lean.y);
    vec4 mv = modelViewMatrix * vec4(wp, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
  vUv = q + 0.5;
  vFlip = role > 3.5 && role < 4.5 ? 1.0 : 0.0;
  vFr = mod(uTime * uFps * rate * (0.85 + 0.3 * r1) + r2 * uFrames, uFrames);
  vRole = role;
  float near = smoothstep(uNear.x, uNear.y, dist);
  vC = vec4(flick, I, 0.0, near);
}`;

const FLAME_FS = /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uGrid;
uniform float uFrames;
uniform vec3 uGlowCol;
uniform vec3 uGain; // body, core, glow
varying vec2 vUv;
varying float vDepth;
varying vec4 vC;
varying float vFr;
varying float vRole;
varying float vFlip;
${SOFT_DEPTH_PARS}
${FLIPBOOK_PARS}
void main() {
  if (vC.w <= 0.002) discard;
  if (vRole < 0.5) {
    vec2 d = vUv - 0.5;
    float r = length(d) * 2.0;
    if (r >= 1.0) discard;
    float g = exp(-r * r * 5.0) * (1.0 - r);
    float f = vC.w * fxSoftFade(vDepth, 0.8) * uGain.z * vC.x;
    gl_FragColor = vec4(uGlowCol * g * f, 0.0);
    return;
  }
  vec2 uv = vec2(vFlip > 0.5 ? 1.0 - vUv.x : vUv.x, vUv.y);
  vec4 c = fbSample(uTex, uTex, 0.0, 0.0, uGrid, uFrames, vFr, uv);
  if (c.a + c.r + c.g < 0.006) discard;
  vec3 rgb = c.rgb;
  float I = uGain.x;
  if (vRole > 1.5 && vRole < 2.5) {
    // white-hot core: the flipbook's brightest part pushed towards pale yellow
    float lum = dot(rgb, vec3(0.3, 0.55, 0.15));
    rgb = mix(rgb, vec3(1.0, 0.86, 0.6) * lum * 1.4, 0.55);
    I = uGain.y;
  }
  float f = vC.w * fxSoftFade(vDepth, 0.25);
  gl_FragColor = vec4(rgb * I * (0.8 + 0.25 * vC.x) * f, c.a * f * 0.85);
}`;

// ------------------------------------------------------------------ smoke
const SMOKE_VS = /* glsl */ `
${COMMON_VS}
uniform float uFrames;
uniform float uMaxRole;
uniform vec2 uNear;
uniform vec3 uFireCol;
uniform vec3 uSmokeCol;
varying vec2 vUv;
varying float vDepth;
varying vec4 vC;
varying float vFr;
void main() {
  vec4 A = srcA();
  vec4 B = srcB();
  float size = A.w;
  float kind = B.w;
  float candle = step(1.5, kind) * step(kind, 2.5);
  float jet = step(3.5, kind);
  float role = aI.y;
  if (size <= 0.002 || role > uMaxRole + 0.5 || (candle > 0.5 && role > 1.5)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vC = vec4(0.0); return; }
  float r1 = aI.z, r2 = aI.w;
  float life = (3.6 + 2.4 * r1) * (candle > 0.5 ? 0.6 : 1.0);
  float x = uTime / life + r2;
  float ph = fract(x);
  float cyc = floor(x);
  float age = ph * life;
  float sz0 = max(size, 0.25);
  vec3 p = A.xyz + vec3(0.0, size * (0.7 + 0.5 * jet) * B.y, 0.0);
  float rise = (0.45 + 0.35 * r1) * (0.7 + 0.35 * sz0) * (1.0 + jet);
  p.y += rise * age - 0.025 * age * age;
  p.xz += uWind.xz * (0.22 * age + 0.07 * age * age) * (0.8 + 0.4 * uWind.y);
  float wob = 0.18 * sz0 * ph;
  p.x += sin(age * 0.9 + r1 * 6.28 + cyc * 1.7) * wob;
  p.z += cos(age * 0.7 + r2 * 6.28 + cyc * 2.3) * wob;
  float s = sz0 * (0.45 + 1.1 * ph + 1.2 * ph * ph) * (candle > 0.5 ? 0.35 : 1.0) * (0.85 + 0.3 * h11(cyc + r1 * 7.0));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float rot = r1 * 6.28 + age * 0.12 * (r2 - 0.5);
  vec2 q = position.xy;
  vec2 ax = vec2(cos(rot), sin(rot));
  vec2 ay = vec2(-ax.y, ax.x);
  mv.xy += (ax * q.x + ay * q.y) * s;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
  vUv = q + 0.5;
  vFr = mod(r1 * uFrames + age * 14.0, uFrames);
  float env = smoothstep(0.0, 0.12, ph) * (1.0 - smoothstep(0.55, 1.0, ph));
  // warm-lit at the base (the fire under it, flickering), cold grey smoke above (moonlit)
  float warm = (1.0 - smoothstep(0.0, 0.45, ph)) * B.x;
  vec3 col = mix(uSmokeCol, uFireCol, warm);
  float near = smoothstep(uNear.x, uNear.y, -mv.z);
  vC = vec4(col, env * near * min(1.0, size * 2.5));
}`;

const SMOKE_FS = /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uGrid;
uniform float uFrames;
uniform float uOpacity;
varying vec2 vUv;
varying float vDepth;
varying vec4 vC;
varying float vFr;
${SOFT_DEPTH_PARS}
${FLIPBOOK_PARS}
void main() {
  if (vC.a <= 0.002) discard;
  vec4 c = fbSample(uTex, uTex, 0.0, 0.0, uGrid, uFrames, vFr, vUv);
  float f = vC.a * uOpacity * fxSoftFade(vDepth, 0.6);
  float a = c.a * f;
  if (a < 0.003) discard;
  // the atlas is premultiplied grey: shade it with the colour (lum keeps its internal light / dark)
  float lum = dot(c.rgb, vec3(0.33)) / max(c.a, 0.02);
  gl_FragColor = vec4(vC.rgb * (0.35 + 0.9 * lum) * a, a);
}`;

// ------------------------------------------------------------------ embers
const EMBER_VS = /* glsl */ `
${COMMON_VS}
uniform float uMaxRole;
uniform vec2 uNear;
varying vec2 vUv;
varying float vDepth;
varying vec4 vC;
void main() {
  vec4 A = srcA();
  vec4 B = srcB();
  float size = A.w;
  float kind = B.w;
  float candle = step(1.5, kind) * step(kind, 2.5);
  float jet = step(3.5, kind);
  float oil = step(2.5, kind) * step(kind, 3.5);
  float role = aI.y;
  float maxR = candle > 0.5 ? -1.0 : uMaxRole;
  if (size <= 0.002 || role > maxR + 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vC = vec4(0.0); return; }
  float r1 = aI.z, r2 = aI.w;
  float life = (1.3 + 1.7 * r1) * (1.0 - 0.4 * jet);
  float x = uTime / life + r2;
  float ph = fract(x);
  float cyc = floor(x) + aI.x * 17.31 + role * 3.7;
  // irregular emission: 60 % of the cycles carry a spark, a few of them hot pops
  float keep = h11(cyc * 1.37);
  if (keep > 0.6 + 0.3 * jet) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vC = vec4(0.0); return; }
  float pop = step(0.9, h11(cyc * 2.11));
  float age = ph * life;
  float wid = B.z;
  vec3 p0 = A.xyz + vec3((h11(cyc + 0.3) - 0.5) * (wid * 1.6 + size * 0.3), size * (0.25 + 0.3 * h11(cyc + 5.1)) * B.y, (h11(cyc + 9.7) - 0.5) * (wid * 1.6 + size * 0.3));
  float v0 = (1.0 + 1.8 * h11(cyc + 2.9) + 1.5 * pop) * (0.55 + 0.5 * min(size, 1.8)) * (1.0 + 1.6 * jet) * (1.0 - 0.3 * oil);
  float kd = 0.7;
  float e = exp(-kd * age);
  float fz = (1.0 - e) / kd;
  vec3 p = p0 + vec3(0.0, v0 * fz, 0.0);
  vec2 side = vec2(h11(cyc + 4.4) - 0.5, h11(cyc + 6.6) - 0.5) * (0.6 + 1.4 * pop);
  vec2 drift = uWind.xz * (0.75 + 0.5 * h11(cyc + 8.8)) * (age - fz * 0.4) + side * fz;
  vec2 curl = vec2(sin(age * 3.3 + r1 * 20.0), cos(age * 2.9 + r2 * 20.0)) * 0.16 * age;
  p.xz += drift + curl;
  p.y -= 0.12 * age * age; // the cooling spark sinks a little
  vec3 vel = vec3(uWind.x + side.x * e + cos(age * 3.3 + r1 * 20.0) * 0.5, v0 * e - 0.24 * age, uWind.y * 0.0 + uWind.z + side.y * e - sin(age * 2.9 + r2 * 20.0) * 0.45);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec2 vv = (modelViewMatrix * vec4(vel, 0.0)).xy;
  float sp = length(vv);
  vec2 ax = sp > 1e-4 ? vv / sp : vec2(0.0, 1.0);
  vec2 ay = vec2(-ax.y, ax.x);
  float s = 0.014 * (0.7 + 0.8 * h11(cyc + 1.1)) * (1.0 + 0.6 * pop) * (1.0 - 0.45 * ph);
  float len = s + sp * 0.035;
  vec2 q = position.xy;
  mv.xy += ax * q.y * len * 2.0 + ay * q.x * s * 2.0;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
  vUv = q + 0.5;
  float tw = 0.65 + 0.35 * sin(age * (18.0 + 14.0 * r1) + r2 * 40.0);
  float heat = 1.0 - ph;
  vec3 col = mix(vec3(1.0, 0.18, 0.03) * 1.6, vec3(1.0, 0.78, 0.42) * 5.0, heat * heat);
  float env = smoothstep(0.0, 0.05, ph) * (1.0 - smoothstep(0.7, 1.0, ph));
  float near = smoothstep(uNear.x, uNear.y, -mv.z);
  vC = vec4(col * tw * (1.0 + pop), env * near * B.x * min(1.0, size * 2.0));
}`;

const EMBER_FS = /* glsl */ `
uniform float uGainE;
varying vec2 vUv;
varying float vDepth;
varying vec4 vC;
${SOFT_DEPTH_PARS}
void main() {
  if (vC.a <= 0.002) discard;
  vec2 d = (vUv - 0.5) * 2.0;
  float r = dot(d, d);
  if (r >= 1.0) discard;
  float a = (1.0 - r) * (1.0 - r) * vC.a * fxSoftFade(vDepth, 0.05);
  gl_FragColor = vec4(vC.rgb * a * uGainE, 0.0);
}`;

// ------------------------------------------------------------------ heat (FX_DIST)
const HEAT_VS = /* glsl */ `
${COMMON_VS}
uniform float uOn;
varying vec2 vUv;
varying float vDepth;
varying float vStrength;
varying float vPhase;
varying float vSeed;
void main() {
  vec4 A = srcA();
  vec4 B = srcB();
  float size = A.w;
  float kind = B.w;
  float candle = step(1.5, kind) * step(kind, 2.5);
  vec4 c0 = modelViewMatrix * vec4(A.xyz, 1.0);
  if (uOn < 0.5 || size < 0.45 || candle > 0.5 || -c0.z > 32.0 || -c0.z < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vStrength = 0.0; return; }
  float wid = B.z;
  float h = size * 2.6 * B.y;
  vec4 mv = c0;
  vec2 q = position.xy;
  mv.xy += vec2(q.x * (size * 1.1 + wid * 1.2), size * 0.4 + (q.y + 0.5) * h);
  vUv = q + 0.5;
  vDepth = -mv.z;
  vStrength = clamp(5.0 / max(vDepth, 0.5), 0.25, 1.6) * min(1.0, size);
  vPhase = uTime * (0.9 + 0.3 * aI.z);
  vSeed = aI.w;
  gl_Position = projectionMatrix * mv;
}`;

const HEAT_FS = /* glsl */ `
uniform float uStrength;
varying vec2 vUv;
varying float vDepth;
varying float vStrength;
varying float vPhase;
varying float vSeed;
${SOFT_DEPTH_PARS}
float hh(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hh(i), hh(i + vec2(1.0, 0.0)), f.x), mix(hh(i + vec2(0.0, 1.0)), hh(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  if (vStrength <= 0.001) discard;
  vec2 p = vec2(vUv.x * 3.0, vUv.y * 4.5 - vPhase) + vSeed * 17.0;
  float n1 = vnoise(p) + 0.5 * vnoise(p * 2.1 + 3.7);
  float n2 = vnoise(p + 11.3) + 0.5 * vnoise(p * 2.3 - 5.1);
  float mask = sin(3.14159 * vUv.x) * smoothstep(0.0, 0.2, vUv.y) * (1.0 - smoothstep(0.5, 1.0, vUv.y));
  vec2 off = (vec2(n1, n2 * 0.6) - vec2(0.75, 0.45)) * mask * 0.010;
  float a = vStrength * uStrength * fxSoftFade(vDepth, 0.4);
  if (a <= 0.0005) discard;
  gl_FragColor = vec4(off * a, 0.0, 1.0);
}`;

const QUAD = (): THREE.Float32BufferAttribute => new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3);

/** deterministic per-fire seeds (no Math.random: the pixel-identical gates replace it, and seeks must match) */
function hash01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

export class FireField {
  readonly group = new THREE.Group();
  readonly srcs: FireSrc[] = [];
  private data = new Float32Array(MAXS * 2 * 4);
  private tex: THREE.DataTexture;
  private time = { value: 0 };
  private wind = { value: new THREE.Vector3() };
  private meshes: THREE.Mesh[] = [];
  private mats: THREE.ShaderMaterial[] = [];
  private flameMat!: THREE.ShaderMaterial;
  private smokeMat!: THREE.ShaderMaterial;
  private heatMat!: THREE.ShaderMaterial;
  private built = false;
  private wp = new THREE.Vector3();
  private ws = new THREE.Vector3();
  /** resolves when the flame and smoke atlases are bound (the concept harness waits for it) */
  ready: Promise<unknown> = Promise.resolve();
  /** any heat column drawn this frame (Post's distortion pass runs only then) */
  heatActive = false;

  constructor(
    private atlases: FxAtlases | null,
    readonly quality: number,
    readonly art: FireArt,
    private fireColor: string,
  ) {
    this.tex = new THREE.DataTexture(this.data, MAXS, 2, THREE.RGBAFormat, THREE.FloatType);
    this.tex.magFilter = this.tex.minFilter = THREE.NearestFilter;
    this.tex.needsUpdate = true;
    this.group.name = 'fx.fireField';
  }

  /** register a fire; the returned object is live (the arena writes k, the owner amp / h) */
  add(obj: THREE.Object3D, size: number, kind: FireKind, wid: number): FireSrc | null {
    if (this.srcs.length >= MAXS) return null;
    const s: FireSrc = { obj, size, kind, wid, k: 1, amp: 1, h: 1, i: this.srcs.length };
    this.srcs.push(s);
    if (this.built) this.rebuildInstances();
    return s;
  }

  /** build the four draws (after the arena placed its fires; later adds rebuild the instance lists) */
  build(): THREE.Group {
    if (this.built) return this.group;
    this.built = true;
    const q = Math.max(0, Math.min(2, this.quality));
    const A = this.art;
    const common = { uSrc: { value: this.tex }, uTime: this.time, uWind: this.wind, ...softDepthUniforms };
    const blend = {
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    } as const;
    const fire = new THREE.Color(this.fireColor);
    this.flameMat = new THREE.ShaderMaterial({
      name: 'fx.fireField.flames',
      uniforms: {
        ...common,
        uTex: { value: null },
        uGrid: { value: new THREE.Vector2(16, 4) },
        uFrames: { value: 64 },
        uFps: { value: 30 },
        uMaxRole: { value: TIER.flame[q] },
        uNear: { value: new THREE.Vector2(0.3, 1.2) },
        uGlowCol: { value: fire.clone().multiplyScalar(0.55) },
        uGain: { value: new THREE.Vector3(A.gain.body, A.gain.core, A.gain.glow) },
      },
      vertexShader: FLAME_VS,
      fragmentShader: FLAME_FS,
      ...blend,
    });
    this.smokeMat = new THREE.ShaderMaterial({
      name: 'fx.fireField.smoke',
      uniforms: {
        ...common,
        uTex: { value: null },
        uGrid: { value: new THREE.Vector2(8, 8) },
        uFrames: { value: 64 },
        uMaxRole: { value: TIER.smoke[q] - 1 },
        uNear: { value: new THREE.Vector2(0.6, 2.4) },
        uFireCol: { value: fire.clone().multiplyScalar(1.6) },
        uSmokeCol: { value: new THREE.Color(A.smoke.color) },
        uOpacity: { value: A.smoke.opacity },
      },
      vertexShader: SMOKE_VS,
      fragmentShader: SMOKE_FS,
      ...blend,
    });
    const emberMat = new THREE.ShaderMaterial({
      name: 'fx.fireField.embers',
      uniforms: { ...common, uMaxRole: { value: TIER.ember[q] - 1 }, uNear: { value: new THREE.Vector2(0.2, 0.8) }, uGainE: { value: A.gain.embers } },
      vertexShader: EMBER_VS,
      fragmentShader: EMBER_FS,
      ...blend,
    });
    this.heatMat = new THREE.ShaderMaterial({
      name: 'fx.fireField.heat',
      uniforms: { ...common, uOn: { value: q >= 2 ? 1 : 0 }, uStrength: { value: A.heat } },
      vertexShader: HEAT_VS,
      fragmentShader: HEAT_FS,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    const mk = (mat: THREE.ShaderMaterial, name: string, layer: number, order: number, reflect: boolean) => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', QUAD());
      g.setIndex([0, 1, 2, 0, 2, 3]);
      const m = new THREE.Mesh(g, mat);
      m.name = name;
      m.frustumCulled = false;
      m.layers.set(layer);
      m.renderOrder = order;
      m.userData = { dyn: true, noReflect: !reflect, fireField: true };
      m.visible = false;
      this.meshes.push(m);
      this.mats.push(mat);
      this.group.add(m);
      return m;
    };
    mk(this.smokeMat, 'fx.fireField.smoke', LAYER.FX_ALPHA, 1, false);
    mk(this.flameMat, 'fx.fireField.flames', LAYER.FX_ALPHA, 3, true);
    mk(emberMat, 'fx.fireField.embers', LAYER.FX_ALPHA, 4, false);
    const heat = mk(this.heatMat, 'fx.fireField.heat', LAYER.FX_DIST, 0, false);
    heat.visible = q >= 2;
    this.rebuildInstances();
    this.bindTextures();
    return this.group;
  }

  private rebuildInstances() {
    const per = [N_SMOKE, N_FLAME, N_EMBER, 1];
    this.meshes.forEach((m, mi) => {
      const n = per[mi];
      const arr = new Float32Array(this.srcs.length * n * 4);
      let o = 0;
      for (const s of this.srcs)
        for (let r = 0; r < n; r++) {
          arr[o++] = s.i;
          arr[o++] = r;
          arr[o++] = hash01(s.i * 31 + mi, r * 7 + 1);
          arr[o++] = hash01(s.i * 17 + 5 + mi, r * 13 + 3);
        }
      const g = m.geometry as THREE.InstancedBufferGeometry;
      g.setAttribute('aI', new THREE.InstancedBufferAttribute(arr, 4));
      g.instanceCount = this.srcs.length * n;
    });
  }

  private bindTextures() {
    const A = this.atlases;
    if (!A) return;
    const q = this.quality;
    const bind = (mat: THREE.ShaderMaterial, id: string, show: THREE.Mesh) =>
      A.load()
        .then(() => {
          if (!A.has(id)) return null;
          const e = A.entry(id);
          if (e.grid) mat.uniforms.uGrid.value.set(e.grid[0], e.grid[1]);
          mat.uniforms.uFrames.value = e.frames ?? 64;
          if (mat.uniforms.uFps) mat.uniforms.uFps.value = e.fps ?? 30;
          return A.tierTexture(id, q);
        })
        .then((tex) => {
          if (!tex) return;
          mat.uniforms.uTex.value = tex;
          show.userData.ready = true;
        })
        .catch((e) => console.warn('[fire field]', e));
    this.ready = Promise.all([bind(this.smokeMat, 'unity_wispysmoke01', this.meshes[0]), bind(this.flameMat, 'unity_flame02', this.meshes[1])]);
    this.meshes[2].userData.ready = true;
    this.meshes[3].userData.ready = true;
  }

  /**
   * per frame: the fire clock (seconds, seeded flicker / flipbooks), the wind (x, z, gust) and the camera; writes every
   * fire's live state into the data texture
   */
  update(t: number, wind: { x: number; z: number; gust: number }, cam?: THREE.Camera) {
    if (!this.built) return;
    this.time.value = t;
    this.wind.value.set(wind.x, wind.gust, wind.z);
    const d = this.data;
    let heat = false;
    for (const s of this.srcs) {
      const o = s.i * 4,
        o2 = (MAXS + s.i) * 4;
      let live = s.amp > 0.001;
      for (let p: THREE.Object3D | null = s.obj; p && live; p = p.parent) if (!p.visible) live = false;
      if (!live) {
        d[o + 3] = 0;
        continue;
      }
      s.obj.getWorldPosition(this.wp);
      // the owner's group scale (oil pools grow / shrink) scales the fire; the flame group's own y-scale is the flicker
      let sc = 1;
      if (s.obj.parent) {
        s.obj.parent.getWorldScale(this.ws);
        sc = (this.ws.x + this.ws.z) * 0.5;
      }
      d[o] = this.wp.x;
      d[o + 1] = this.wp.y;
      d[o + 2] = this.wp.z;
      d[o + 3] = s.size * sc * Math.min(1, s.amp * 1.5);
      d[o2] = s.k * (0.4 + 0.6 * Math.min(1, s.amp));
      d[o2 + 1] = s.h;
      d[o2 + 2] = s.wid * sc;
      d[o2 + 3] = KIND_ID[s.kind];
      if (s.size * sc >= 0.45 && s.kind !== 'candle' && cam && this.wp.distanceToSquared(cam.position) < 32 * 32) heat = true;
    }
    this.tex.needsUpdate = true;
    for (const m of this.meshes) m.visible = !!m.userData.ready && this.srcs.length > 0;
    const hm = this.meshes[3];
    this.heatActive = !!hm && this.quality >= 2 && heat;
    if (hm) hm.visible = this.heatActive;
  }

  /** live fires (checks) */
  liveCount(): number {
    let n = 0;
    for (const s of this.srcs) if (this.data[s.i * 4 + 3] > 0) n++;
    return n;
  }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
    for (const m of this.mats) m.dispose();
    this.tex.dispose();
    this.meshes.length = 0;
  }
}

// ------------------------------------------------------------------ seeded flicker + wind (CPU, shared by lights / stage / floor)
/** smooth 1D value noise in [-1, 1] (deterministic, seeded) */
export function vnoise1(x: number, seed: number): number {
  const i = Math.floor(x),
    f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash01(i, seed) * 2 - 1,
    b = hash01(i + 1, seed) * 2 - 1;
  return a + (b - a) * u;
}

/**
 * A fire's flicker at fire-clock time t (seconds) for its seed: slow breathing + fast tremble + occasional dips where a
 * gust tears at the flame. About 0.72..1.08, mean ~0.92 (the old sine flicker's range).
 */
export function fireFlicker(t: number, seed: number, gust: number): number {
  const slow = vnoise1(t * 1.7, seed);
  const mid = vnoise1(t * 6.3, seed + 101);
  const fast = vnoise1(t * 17.0, seed + 202);
  const dip = Math.max(0, vnoise1(t * 0.9, seed + 303) - 0.45) * (0.5 + gust);
  return 0.92 + slow * 0.05 + mid * 0.045 + fast * 0.025 - dip * 0.22;
}

/** the arena wind at time t: direction (x, z) x strength and the gust level 0..1 (seeded, smooth) */
export function fireWind(t: number, art: FireArt['wind'], seed: number, out: { x: number; z: number; gust: number }) {
  const g0 = vnoise1(t * 0.13, seed) * 0.6 + vnoise1(t * 0.41, seed + 7) * 0.4; // -1..1
  const gust = Math.max(0, Math.min(1, 0.5 + g0 * 0.8));
  const az = ((art.az + vnoise1(t * 0.05, seed + 13) * 35) * Math.PI) / 180;
  const s = art.base * (1 - art.gust + art.gust * 2 * gust);
  out.x = Math.cos(az) * s;
  out.z = Math.sin(az) * s;
  out.gust = gust;
  return out;
}
