/**
 * Screen distortion sprites (plan §2.1 "Screen distortion", F1): heat shimmer and shockwave
 * ripples. Stateless like particles.ts: a sprite is a pure function of (spawn data, uTime).
 *
 * The sprites live on LAYER.FX_DIST. Post renders that layer into a half-res RG16F target
 * (cleared to 0, additive), and the final post pass offsets its scene and bloom lookups by
 * the RG value (screen-uv units). Occlusion: each fragment fades with the shared linear depth
 * (softDepth.ts), so a fighter standing in front of a heat column is not smeared.
 *
 * kind 0 HEAT:   a camera-facing column standing on its anchor (base), rising value-noise
 *                offsets, strongest in the middle, fading in / out over its life.
 * kind 1 RIPPLE: a camera-facing disc whose radius eases out to `size`; a thin ring pushes
 *                pixels outwards (refraction of a pressure front), fading as it grows.
 *
 * Tiers (fxSettings TIER_CAPS.dist): 0 = off (nothing spawns, Post skips the pass),
 * 1 = only ops with tier <= 1 (heavy events), 2 = everything.
 */
import * as THREE from 'three';
import { LAYER } from './fxLayers';
import { SOFT_DEPTH_PARS, softDepthUniforms } from './softDepth';

/** floats per sprite: p.xyz t0 | life size strength kind | height rise soft seed */
const STRIDE = 12;

const VERT = /* glsl */ `
  attribute vec4 aP;   // position (heat: base, ripple: centre), spawn time
  attribute vec4 aA;   // life, size (m), strength, kind
  attribute vec4 aB;   // height (heat, m), rise speed, soft (m), seed
  uniform float uTime;
  varying vec2 vUv;
  varying float vDepth;
  varying float vEnv;
  varying float vStrength;
  varying float vKind;
  varying float vSoft;
  varying float vPhase;
  varying float vSeed;
  void main() {
    float age = uTime - aP.w;
    float life = aA.x;
    if (age < 0.0 || age >= life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vEnv = 0.0; return; }
    float k = age / life;
    vec4 mv;
    vec2 q = position.xy;
    if (aA.w < 0.5) {
      // heat: column of width size, height aB.x, standing on its anchor; fade in 0.15 s, out over the last 40 %
      mv = modelViewMatrix * vec4(aP.xyz, 1.0);
      mv.xy += vec2(q.x * aA.y, (q.y + 0.5) * aB.x);
      vEnv = smoothstep(0.0, 0.15, age) * (1.0 - smoothstep(0.6, 1.0, k));
      vPhase = age * aB.y;
    } else {
      // ripple: radius eases out from 15 % to 100 % of size
      float e = 1.0 - pow(1.0 - k, 3.0);
      float r = aA.y * (0.15 + 0.85 * e);
      mv = modelViewMatrix * vec4(aP.xyz, 1.0);
      mv.xy += q * 2.0 * r;
      vEnv = (1.0 - k) * (1.0 - k);
      vPhase = k;
    }
    vUv = q + 0.5;
    vDepth = -mv.z;
    // keep the on-screen push roughly constant in angle: nearer sprites push more pixels
    vStrength = aA.z * clamp(5.0 / max(vDepth, 0.5), 0.25, 1.6);
    vKind = aA.w;
    vSoft = aB.z;
    vSeed = aB.w;
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = /* glsl */ `
  varying vec2 vUv;
  varying float vDepth;
  varying float vEnv;
  varying float vStrength;
  varying float vKind;
  varying float vSoft;
  varying float vPhase;
  varying float vSeed;
  ${SOFT_DEPTH_PARS}
  float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  void main() {
    if (vEnv <= 0.001) discard;
    vec2 off;
    if (vKind < 0.5) {
      // heat: two scrolling noise octaves; horizontal wobble dominates (rising convection cells)
      vec2 p = vec2(vUv.x * 3.0, vUv.y * 4.5 - vPhase) + vSeed * 17.0;
      float n1 = vnoise(p) + 0.5 * vnoise(p * 2.1 + 3.7);
      float n2 = vnoise(p + 11.3) + 0.5 * vnoise(p * 2.3 - 5.1);
      float mask = sin(3.14159 * vUv.x) * smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
      off = (vec2(n1, n2 * 0.6) - vec2(0.75, 0.45)) * mask * 0.010;
    } else {
      // ripple: thin ring at 80 % radius pushing outwards
      vec2 d = vUv - 0.5;
      float r = length(d) * 2.0;
      float ring = exp(-pow((r - 0.8) / 0.12, 2.0));
      off = (r > 1e-3 ? d / (r * 0.5) : vec2(0.0)) * ring * 0.012;
    }
    float a = vEnv * vStrength * fxSoftFade(vDepth, vSoft);
    if (a <= 0.0005) discard;
    gl_FragColor = vec4(off * a, 0.0, 1.0);
  }`;

export class DistortionSprites {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private data: Float32Array;
  private buf: THREE.InstancedInterleavedBuffer;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private cursor = 0;
  private highWater = 0;
  private dirtyCount = 0;
  private fullUpload = false;
  private lastDeath = -Infinity;
  private t = 0;

  constructor(capacity = 64) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * STRIDE);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aP', new THREE.InterleavedBufferAttribute(this.buf, 4, 0));
    g.setAttribute('aA', new THREE.InterleavedBufferAttribute(this.buf, 4, 4));
    g.setAttribute('aB', new THREE.InterleavedBufferAttribute(this.buf, 4, 8));
    g.instanceCount = 0;
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      name: 'fx.distortion',
      uniforms: { uTime: { value: 0 }, ...softDepthUniforms },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false, // the distortion target has no depth buffer; occlusion is the soft-depth fade
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.name = 'fx.distortion';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.layers.set(LAYER.FX_DIST);
  }

  /** kind 0 heat (p = base), 1 ripple (p = centre) */
  emit(t0: number, kind: 0 | 1, px: number, py: number, pz: number, life: number, size: number, strength: number, height = 0, rise = 1.5, soft = 0.3, seed = 0) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const o = i * STRIDE;
    const d = this.data;
    d[o] = px;
    d[o + 1] = py;
    d[o + 2] = pz;
    d[o + 3] = t0;
    d[o + 4] = life;
    d[o + 5] = size;
    d[o + 6] = strength;
    d[o + 7] = kind;
    d[o + 8] = height;
    d[o + 9] = rise;
    d[o + 10] = soft;
    d[o + 11] = seed;
    this.dirtyCount++;
    if (i + 1 > this.highWater) this.highWater = i + 1;
    if (t0 + life > this.lastDeath) this.lastDeath = t0 + life;
  }

  flush() {
    const b = this.buf;
    if (this.fullUpload || this.dirtyCount > 0) {
      // the pool is tiny (64 x 48 B): upload it whole instead of tracking ranges
      b.clearUpdateRanges();
      b.needsUpdate = true;
      this.fullUpload = false;
    }
    this.dirtyCount = 0;
    this.geo.instanceCount = this.highWater;
  }

  setTime(t: number) {
    this.t = t;
    this.mat.uniforms.uTime.value = t;
    this.mesh.visible = this.highWater > 0 && t < this.lastDeath;
  }

  /** anything to draw at the current time (Post skips the distortion pass otherwise) */
  get active(): boolean {
    return this.mesh.visible;
  }

  alive(t = this.t): number {
    let n = 0;
    for (let i = 0; i < this.highWater; i++) {
      const o = i * STRIDE;
      const age = t - this.data[o + 3];
      if (age >= 0 && age < this.data[o + 4]) n++;
    }
    return n;
  }

  hashInto(t: number, mix: (x: number) => void) {
    for (let i = 0; i < this.highWater; i++) {
      const o = i * STRIDE;
      const age = t - this.data[o + 3];
      if (!(age >= 0 && age < this.data[o + 4])) continue;
      for (let j = 0; j < STRIDE; j++) mix(this.data[o + j]);
    }
  }

  /** order-independent hash of the live sprites */
  hashLive(t: number): number {
    let sum = 0;
    for (let i = 0; i < this.highWater; i++) {
      const o = i * STRIDE;
      const age = t - this.data[o + 3];
      if (!(age >= 0 && age < this.data[o + 4])) continue;
      let h = 0x811c9dc5 >>> 0;
      for (let j = 0; j < STRIDE; j++) {
        h ^= Math.round(this.data[o + j] * 1e4) | 0;
        h = Math.imul(h, 16777619) >>> 0;
      }
      sum = (sum + h) >>> 0;
    }
    return sum;
  }

  clear() {
    this.data.fill(0);
    this.cursor = 0;
    this.highWater = 0;
    this.lastDeath = -Infinity;
    this.dirtyCount = 0;
    this.fullUpload = true;
    this.mesh.visible = false;
    this.geo.instanceCount = 0;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}
