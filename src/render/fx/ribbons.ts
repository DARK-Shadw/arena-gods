/**
 * Weapon trails v2 (plan §2.1 "Ribbons", §2.3 per-weapon profiles, catalog C04 / C05).
 *
 * Sampling is on SIM time at a fixed 120 Hz, interpolated between rendered frames (quadratic
 * through the last three frame samples), so the trail has the same length at 30 fps and at 144 fps
 * and it holds still during hit-stop (no sim time passes, no samples, ages frozen). The old trail
 * pushed 9 samples per render frame (4.8x longer at 30 fps) and collapsed during hit-stop.
 *
 * The ribbon is rebuilt each frame into a preallocated strip (base -> tip pairs, newest first), with
 * uv.x = age / life and uv.y = 0 at the base, 1 at the tip. The fragment shader draws the profile:
 * a hot leading edge near the tip, a faint dark smoky body, streak noise (noise_a "Streak 1", offset
 * by a seed per attack), or three thin claw lines. Heavy swings add a distortion ribbon (FX_DIST)
 * sharing the same geometry (air shear, C05). Blend: premultiplied additive-alpha on FX_ADD.
 */
import * as THREE from 'three';
import { LAYER } from './fxLayers';
import { SOFT_DEPTH_PARS, softDepthUniforms } from './softDepth';
import type { WeaponClass } from './fxSurfaces';

export interface TrailProfile {
  /** seconds a sample stays visible */
  life: number;
  /** where the ribbon starts along base -> tip (0 = base) */
  from: number;
  /** extend the tip by this fraction of the span */
  over: number;
  /** hot core colour (linear, HDR) */
  core: [number, number, number];
  /** smoky body colour (linear) and its opacity */
  body: [number, number, number];
  bodyA: number;
  /** width of the hot edge (fraction of the ribbon from the tip) */
  edge: number;
  /** 3 = claw lines */
  stripes: 0 | 3;
  /** distortion strength on heavy swings (0 = none) */
  dist: number;
}

/** plan §2.3. Colours are linear HDR (cores bloom; bodies stay at scene level). */
export const TRAIL_PROFILES: Record<WeaponClass | 'magic', TrailProfile> = {
  axe: { life: 0.12, from: 0.05, over: 0.04, core: [3.2, 2.9, 2.5], body: [0.05, 0.045, 0.04], bodyA: 0.35, edge: 0.18, stripes: 0, dist: 1.2 },
  sword: { life: 0.18, from: 0.3, over: 0.03, core: [2.6, 2.9, 3.4], body: [0.06, 0.065, 0.075], bodyA: 0.22, edge: 0.14, stripes: 0, dist: 0.9 },
  claw: { life: 0.14, from: 0.0, over: 0.25, core: [2.2, 0.35, 0.3], body: [0.04, 0.0, 0.0], bodyA: 0.25, edge: 0.0, stripes: 3, dist: 0.6 },
  blunt: { life: 0.08, from: 0.2, over: 0.1, core: [0.55, 0.5, 0.45], body: [0.12, 0.1, 0.08], bodyA: 0.12, edge: 0.3, stripes: 0, dist: 1.0 },
  pierce: { life: 0.1, from: 0.2, over: 0.0, core: [1.5, 1.6, 1.6], body: [0.05, 0.05, 0.05], bodyA: 0.1, edge: 0.2, stripes: 0, dist: 0 },
  fire: { life: 0.16, from: 0.0, over: 0.15, core: [4.0, 1.6, 0.4], body: [0.08, 0.03, 0.01], bodyA: 0.25, edge: 0.4, stripes: 0, dist: 0.8 },
  shadow: { life: 0.16, from: 0.0, over: 0.15, core: [1.9, 0.25, 0.45], body: [0.03, 0.0, 0.03], bodyA: 0.5, edge: 0.25, stripes: 0, dist: 0.6 },
  magic: { life: 0.16, from: 0.0, over: 0.15, core: [4.0, 1.6, 0.4], body: [0.08, 0.03, 0.01], bodyA: 0.25, edge: 0.4, stripes: 0, dist: 0.8 },
};

/** fighter accents for claws (vex crimson-black, fenrik pale) */
export const CLAW_CORE: Record<string, [number, number, number]> = { vex: [2.4, 0.25, 0.3], fenrik: [2.2, 2.3, 2.5] };

const RATE = 120;
const MAX = 64;
const SPS = 8; // floats per sample: t, base xyz, tip xyz, on

const VERT = /* glsl */ `
  attribute vec3 aT; // age01, side (0 base / 1 tip), on
  varying vec3 vT;
  varying float vDepth;
  void main() {
    vT = aT;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = /* glsl */ `
  uniform vec3 uCore;
  uniform vec3 uBody;
  uniform float uBodyA;
  uniform float uEdge;
  uniform float uStripes;
  uniform float uSeed;
  uniform sampler2D uNoise;
  uniform float uNoiseOn;
  uniform float uOpacity;
  varying vec3 vT;
  varying float vDepth;
  ${SOFT_DEPTH_PARS}
  void main() {
    float age = clamp(vT.x, 0.0, 1.0);
    float side = vT.y;
    float on = vT.z;
    float fade = (1.0 - age) * (1.0 - age);
    float n = uNoiseOn > 0.5 ? texture2D(uNoise, vec2(age * 0.9 + uSeed, side * 1.7 + uSeed * 0.37)).b : 0.55;
    float edge, body;
    if (uStripes > 0.5) {
      float s = 0.0;
      for (int i = 0; i < 3; i++) { float c = 0.32 + float(i) * 0.24; s = max(s, exp(-pow((side - c) / 0.045, 2.0))); }
      edge = s * smoothstep(0.0, 0.15, side);
      body = s * 0.5;
    } else {
      edge = uEdge > 0.0 ? smoothstep(1.0 - uEdge, 1.0, side) * (1.0 - smoothstep(0.985, 1.0, side) * 0.6) : 0.0;
      body = smoothstep(0.0, 0.3, side) * (1.0 - smoothstep(0.9, 1.0, side));
    }
    float hot = edge * pow(1.0 - age, 1.6) * (0.55 + 0.9 * n);
    float bodyA = body * fade * uBodyA * (0.35 + 0.9 * n);
    // a faint core-tinted smear over the whole swept band reads as motion blur of the blade
    float smear = body * fade * (0.35 + 0.65 * n) * 0.09;
    float k = on * uOpacity * fxSoftFade(vDepth, 0.05);
    vec3 rgb = uCore * (hot + smear) + uBody * bodyA;
    if (hot + bodyA + smear < 0.002) discard;
    gl_FragColor = vec4(rgb * k, bodyA * k * 0.8);
  }`;

const DFRAG = /* glsl */ `
  uniform float uStrength;
  uniform float uSeed;
  varying vec3 vT;
  varying float vDepth;
  ${SOFT_DEPTH_PARS}
  float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  void main() {
    float age = clamp(vT.x, 0.0, 1.0);
    float side = vT.y;
    float m = sin(3.14159 * side) * (1.0 - age) * vT.z;
    vec2 p = vec2(age * 7.0 + uSeed, side * 3.0);
    vec2 i = floor(p), f = fract(p);
    float n = mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x);
    vec2 off = (vec2(n, 1.0 - n) - 0.5) * 0.014 * m * uStrength * clamp(5.0 / max(vDepth, 0.5), 0.25, 1.6);
    gl_FragColor = vec4(off * fxSoftFade(vDepth, 0.2), 0.0, 1.0);
  }`;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** One fighter's trail (ribbon + optional distortion ribbon). */
export class Ribbon {
  readonly mesh: THREE.Mesh;
  readonly distMesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private att: Float32Array;
  private mat: THREE.ShaderMaterial;
  private dmat: THREE.ShaderMaterial;
  /** sample ring (newest at head) */
  private s = new Float32Array(MAX * SPS);
  private head = -1;
  private count = 0;
  /** last three frame records: t, base xyz, tip xyz, on */
  private fr = new Float32Array(3 * SPS);
  private nfr = 0;
  private lastTick = -1;
  profile: TrailProfile = TRAIL_PROFILES.blunt;
  heavy = false;
  distOn = false;
  /** sample stride for the low tier (2 = every other sample) */
  step = 1;

  constructor(noise: { value: THREE.Texture | null }) {
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX * 2 * 3);
    this.att = new Float32Array(MAX * 2 * 3);
    const idx: number[] = [];
    for (let i = 0; i < MAX - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aT', new THREE.BufferAttribute(this.att, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      name: 'fx.ribbon',
      uniforms: {
        uCore: { value: new THREE.Color() },
        uBody: { value: new THREE.Color() },
        uBodyA: { value: 0 },
        uEdge: { value: 0 },
        uStripes: { value: 0 },
        uSeed: { value: 0 },
        uNoise: noise,
        uNoiseOn: { value: 1 },
        uOpacity: { value: 1 },
        ...softDepthUniforms,
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      premultipliedAlpha: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'fx.ribbon';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.layers.set(LAYER.FX_ADD);
    this.dmat = new THREE.ShaderMaterial({
      name: 'fx.ribbon.dist',
      uniforms: { uStrength: { value: 1 }, uSeed: { value: 0 }, ...softDepthUniforms },
      vertexShader: VERT,
      fragmentShader: DFRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.distMesh = new THREE.Mesh(this.geo, this.dmat);
    this.distMesh.name = 'fx.ribbon.dist';
    this.distMesh.frustumCulled = false;
    this.distMesh.visible = false;
    this.distMesh.layers.set(LAYER.FX_DIST);
  }

  setProfile(p: TrailProfile, core: [number, number, number] | undefined, seed: number, heavy: boolean, distTier: number) {
    this.profile = p;
    this.heavy = heavy;
    const u = this.mat.uniforms;
    const c = core ?? p.core;
    u.uCore.value.setRGB(c[0], c[1], c[2]);
    u.uBody.value.setRGB(p.body[0], p.body[1], p.body[2]);
    u.uBodyA.value = p.bodyA;
    u.uEdge.value = p.edge;
    u.uStripes.value = p.stripes;
    u.uSeed.value = (seed % 997) / 997;
    this.dmat.uniforms.uSeed.value = (seed % 89) * 0.37;
    this.dmat.uniforms.uStrength.value = p.dist * (heavy ? 1 : 0);
    this.distOn = heavy && p.dist > 0 && distTier >= 2;
  }

  setTier(q: number) {
    this.step = q === 0 ? 2 : 1;
    this.mat.uniforms.uNoiseOn.value = q === 0 ? 0 : 1;
  }

  /**
   * One rendered frame's blade sample at sim time t. Ticks at fixed 120 Hz sim time between the
   * previous frame and this one are interpolated (quadratic through the last 3 frames).
   */
  push(t: number, base: THREE.Vector3, tip: THREE.Vector3, on: boolean) {
    const F = this.fr;
    if (this.nfr > 0 && t <= F[(this.nfr - 1) * SPS]) {
      if (t < F[(this.nfr - 1) * SPS] - 1e-6) this.reset(); // time went back (seek / replay)
      else return; // hit-stop: no sim time passed
    }
    if (this.nfr === 3) {
      F.copyWithin(0, SPS, 3 * SPS);
      this.nfr = 2;
    }
    const o = this.nfr * SPS;
    F[o] = t;
    F[o + 1] = base.x; F[o + 2] = base.y; F[o + 3] = base.z;
    F[o + 4] = tip.x; F[o + 5] = tip.y; F[o + 6] = tip.z;
    F[o + 7] = on ? 1 : 0;
    this.nfr++;
    if (this.nfr < 2) {
      this.lastTick = Math.floor(t * RATE);
      return;
    }
    let n0 = this.lastTick;
    const n1 = Math.floor(t * RATE);
    if (n1 - n0 > MAX) n0 = n1 - MAX;
    for (let n = n0 + 1; n <= n1; n++) this.sampleAt(n / RATE);
    this.lastTick = n1;
  }

  private sampleAt(tt: number) {
    const F = this.fr;
    const m = this.nfr;
    const i2 = (m - 1) * SPS,
      i1 = (m - 2) * SPS;
    const t2 = F[i2],
      t1 = F[i1];
    this.head = (this.head + 1) % MAX;
    if (this.count < MAX) this.count++;
    const o = this.head * SPS;
    const S = this.s;
    S[o] = tt;
    S[o + 7] = F[i2 + 7];
    if (m === 3) {
      // Lagrange quadratic through (t0, p0), (t1, p1), (t2, p2)
      const t0 = F[0];
      const l0 = ((tt - t1) * (tt - t2)) / ((t0 - t1) * (t0 - t2) || 1e-9);
      const l1 = ((tt - t0) * (tt - t2)) / ((t1 - t0) * (t1 - t2) || 1e-9);
      const l2 = ((tt - t0) * (tt - t1)) / ((t2 - t0) * (t2 - t1) || 1e-9);
      for (let j = 1; j <= 6; j++) S[o + j] = F[j] * l0 + F[i1 + j] * l1 + F[i2 + j] * l2;
    } else {
      const k = (tt - t1) / (t2 - t1 || 1e-9);
      for (let j = 1; j <= 6; j++) S[o + j] = F[i1 + j] + (F[i2 + j] - F[i1 + j]) * k;
    }
  }

  /** rebuild the strip for sim time t; returns true when something is visible */
  build(t: number): boolean {
    const p = this.profile;
    const S = this.s;
    let v = 0;
    let anyOn = false;
    for (let j = 0; j < this.count && v < MAX; j += this.step) {
      const o = ((this.head - j + MAX) % MAX) * SPS;
      const age = (t - S[o]) / p.life;
      if (age > 1) break;
      _a.set(S[o + 1], S[o + 2], S[o + 3]);
      _b.set(S[o + 4], S[o + 5], S[o + 6]);
      const bx = _a.x + (_b.x - _a.x) * p.from,
        by = _a.y + (_b.y - _a.y) * p.from,
        bz = _a.z + (_b.z - _a.z) * p.from;
      const tx = _b.x + (_b.x - _a.x) * p.over,
        ty = _b.y + (_b.y - _a.y) * p.over,
        tz = _b.z + (_b.z - _a.z) * p.over;
      const q = v * 6;
      this.pos[q] = bx; this.pos[q + 1] = by; this.pos[q + 2] = bz;
      this.pos[q + 3] = tx; this.pos[q + 4] = ty; this.pos[q + 5] = tz;
      const on = S[o + 7];
      if (on > 0) anyOn = true;
      this.att[q] = Math.max(0, age); this.att[q + 1] = 0; this.att[q + 2] = on;
      this.att[q + 3] = Math.max(0, age); this.att[q + 4] = 1; this.att[q + 5] = on;
      v++;
    }
    const vis = anyOn && v >= 2;
    this.mesh.visible = vis;
    this.distMesh.visible = vis && this.distOn;
    if (!vis) return false;
    this.geo.setDrawRange(0, (v - 1) * 6);
    const pa = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const ta = this.geo.getAttribute('aT') as THREE.BufferAttribute;
    pa.clearUpdateRanges();
    pa.addUpdateRange(0, v * 6);
    pa.needsUpdate = true;
    ta.clearUpdateRanges();
    ta.addUpdateRange(0, v * 6);
    ta.needsUpdate = true;
    return true;
  }

  /** samples currently stored (tests) */
  get samples() {
    return this.count;
  }

  reset() {
    this.head = -1;
    this.count = 0;
    this.nfr = 0;
    this.lastTick = -1;
    this.mesh.visible = false;
    this.distMesh.visible = false;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    this.dmat.dispose();
  }
}
