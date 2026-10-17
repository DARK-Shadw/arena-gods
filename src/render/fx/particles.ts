/**
 * Stateless GPU particles (plan §2.1, §3.4, §3.5).
 *
 * A particle's state is a pure function of (spawn time, initial position and
 * velocity, drag, gravity, growth, life) and the FX time uniform `uTime`:
 *   v(t) = (v0 + g/k) e^{-kt} - g/k            (linear drag k, gravity g on y)
 *   p(t) = p0 + v0 (1 - e^{-kt}) / k - g (t - (1 - e^{-kt}) / k) / k
 * which is the exact solution of the ODE the old CPU pool integrated per frame.
 *
 * So:
 *  - the CPU does nothing per frame except set one uniform (and upload the
 *    instances written by this frame's bursts, as an update range);
 *  - rendering at time t does not depend on frame history: setting `uTime`
 *    to any t (FX Lab scrub, `?t=` seek) shows exactly the state at t;
 *  - expired instances collapse in the vertex shader (no CPU compaction).
 *
 * One instanced quad per particle (not THREE.Points): quads can be stretched
 * along their screen-space velocity (sparks read as streaks) and are not
 * capped by the driver's max point size.
 */
import * as THREE from 'three';
import { SOFT_DEPTH_PARS, softDepthUniforms } from './softDepth';

/** floats per particle: p0.xyz t0 | v0.xyz life | rgb size | drag grav grow stretch | softness - - - */
const STRIDE = 20;

/**
 * World size of a particle of nominal `size` 1. The old Points shader used
 * gl_PointSize = size * 600 / depth (pixels); 0.52 m gives the same on-screen
 * size on a 1080-pixel-high framebuffer at the default 50° FOV, and unlike the
 * old points it no longer shrinks on high-DPI / 4K framebuffers.
 */
export const PARTICLE_WORLD_SCALE = 0.52;

export interface ParticleLayerOpts {
  name: string;
  additive: boolean;
  /** alpha multiplier of the whole layer (the old alpha pool used 0.45) */
  maxAlpha?: number;
  /** camera-near fade (start, end) in metres: particles at the lens would cover the frame */
  near?: [number, number];
  /** render layer (fxLayers.ts LAYER.FX_ADD / FX_ALPHA); default 0 */
  layer?: number;
}

const VERT = /* glsl */ `
  attribute vec4 aP0;   // spawn position, spawn time
  attribute vec4 aV0;   // initial velocity, life
  attribute vec4 aCol;  // linear rgb, size
  attribute vec4 aPhys; // drag, gravity, grow, stretch (s)
  attribute vec4 aExt;  // soft-depth fade distance (m), unused x3
  uniform float uTime;
  uniform float uScale;
  uniform float uMaxAlpha;
  uniform vec2 uNear;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vDepth;
  varying float vSoft;
  void main() {
    float age = uTime - aP0.w;
    float life = aV0.w;
    if (age < 0.0 || age >= life) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // collapsed: outside the clip volume
      vAlpha = 0.0;
      return;
    }
    float k = aPhys.x;
    float g = aPhys.y;
    float e = exp(-k * age);
    float f = k > 1e-4 ? (1.0 - e) / k : age;            // integral of e^{-ks} ds over [0, age]
    vec3 p = aP0.xyz + aV0.xyz * f;
    p.y -= k > 1e-4 ? g * (age - f) / k : 0.5 * g * age * age;
    vec3 vel = aV0.xyz * e;
    vel.y -= k > 1e-4 ? g * (1.0 - e) / k : g * age;
    if (g > 0.0 && p.y < 0.02) { p.y = 0.02; vel.y = 0.0; } // falling particles rest on the floor
    float rem = 1.0 - age / life;                            // remaining life fraction
    vAlpha = (rem < 0.3 ? rem / 0.3 : 1.0) * uMaxAlpha;
    float sz = aCol.w * (1.0 + aPhys.z * (1.0 - rem)) * uScale;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec2 d = (modelViewMatrix * vec4(vel, 0.0)).xy;
    float sp = length(d);
    vec2 ax = sp > 1e-4 ? d / sp : vec2(1.0, 0.0);
    vec2 ay = vec2(-ax.y, ax.x);
    float len = sz + sp * aPhys.w;
    mv.xy += ax * position.x * len + ay * position.y * sz;
    vAlpha *= smoothstep(uNear.x, uNear.y, -mv.z);
    vColor = aCol.rgb;
    vUv = position.xy + 0.5;
    vDepth = -mv.z;
    vSoft = aExt.x;
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vDepth;
  varying float vSoft;
  ${SOFT_DEPTH_PARS}
  void main() {
    // the old 64-px soft dot: alpha 1 at the centre, 0.6 at 30 % radius, 0 at the edge
    float r = length(vUv - 0.5) * 2.0;
    float a = r < 0.3 ? mix(1.0, 0.6, r / 0.3) : mix(0.6, 0.0, clamp((r - 0.3) / 0.7, 0.0, 1.0));
    a *= vAlpha;
    if (a < 0.004) discard;
    // soft particles: fade where the quad meets the floor / a body (F1)
    a *= fxSoftFade(vDepth, vSoft);
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor, a);
  }`;

export class GpuParticles {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  readonly name: string;
  private limit: number;
  private data: Float32Array;
  private buf: THREE.InstancedInterleavedBuffer;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private cursor = 0;
  private highWater = 0;
  /** first slot written since the last flush, and how many (ring order) */
  private dirtyStart = -1;
  private dirtyCount = 0;
  private fullUpload = false;
  /** latest death time of anything emitted: past it the layer is hidden (zero GPU cost when idle) */
  private lastDeath = -Infinity;
  /** total emitted since the last clear (stats) */
  emitted = 0;

  constructor(capacity: number, o: ParticleLayerOpts) {
    this.capacity = capacity;
    this.limit = capacity;
    this.name = o.name;
    this.data = new Float32Array(capacity * STRIDE);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aP0', new THREE.InterleavedBufferAttribute(this.buf, 4, 0));
    g.setAttribute('aV0', new THREE.InterleavedBufferAttribute(this.buf, 4, 4));
    g.setAttribute('aCol', new THREE.InterleavedBufferAttribute(this.buf, 4, 8));
    g.setAttribute('aPhys', new THREE.InterleavedBufferAttribute(this.buf, 4, 12));
    g.setAttribute('aExt', new THREE.InterleavedBufferAttribute(this.buf, 4, 16));
    g.instanceCount = 0;
    this.geo = g;
    const near = o.near ?? (o.additive ? [0.5, 2.2] : [1.2, 4.5]);
    this.mat = new THREE.ShaderMaterial({
      name: `fx.particles.${o.name}`,
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: PARTICLE_WORLD_SCALE },
        uMaxAlpha: { value: o.maxAlpha ?? 1 },
        uNear: { value: new THREE.Vector2(near[0], near[1]) },
        ...softDepthUniforms,
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.name = `fx.particles.${o.name}`;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    if (o.layer !== undefined) this.mesh.layers.set(o.layer);
  }

  /** Shorten / restore the ring for a quality tier (no reallocation, no material rebuild). */
  setLimit(n: number) {
    this.limit = Math.max(16, Math.min(this.capacity, Math.floor(n)));
    if (this.cursor >= this.limit) this.cursor = 0;
  }

  emit(t0: number, px: number, py: number, pz: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, size: number, life: number, drag: number, grav: number, grow: number, stretch: number, soft = 0) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.limit;
    const o = i * STRIDE;
    const d = this.data;
    d[o] = px;
    d[o + 1] = py;
    d[o + 2] = pz;
    d[o + 3] = t0;
    d[o + 4] = vx;
    d[o + 5] = vy;
    d[o + 6] = vz;
    d[o + 7] = life;
    d[o + 8] = r;
    d[o + 9] = g;
    d[o + 10] = b;
    d[o + 11] = size;
    d[o + 12] = drag;
    d[o + 13] = grav;
    d[o + 14] = grow;
    d[o + 15] = stretch;
    d[o + 16] = soft;
    if (this.dirtyStart < 0) this.dirtyStart = i;
    this.dirtyCount++;
    if (i + 1 > this.highWater) this.highWater = i + 1;
    if (t0 + life > this.lastDeath) this.lastDeath = t0 + life;
    this.emitted++;
  }

  /** Upload only the instances written since the last flush (one or two ranges when the ring wraps). */
  flush() {
    const b = this.buf;
    if (this.fullUpload) {
      b.clearUpdateRanges();
      b.needsUpdate = true;
      this.fullUpload = false;
    } else if (this.dirtyCount > 0) {
      b.clearUpdateRanges();
      const n = Math.min(this.dirtyCount, this.limit);
      const s = this.dirtyStart;
      if (n >= this.limit) b.addUpdateRange(0, this.limit * STRIDE);
      else if (s + n <= this.limit) b.addUpdateRange(s * STRIDE, n * STRIDE);
      else {
        b.addUpdateRange(s * STRIDE, (this.limit - s) * STRIDE);
        b.addUpdateRange(0, (n - (this.limit - s)) * STRIDE);
      }
      b.needsUpdate = true;
    }
    this.dirtyStart = -1;
    this.dirtyCount = 0;
    this.geo.instanceCount = this.highWater;
  }

  /** Set FX time; hides the layer once everything emitted has expired. */
  setTime(t: number) {
    this.mat.uniforms.uTime.value = t;
    this.mesh.visible = this.highWater > 0 && t < this.lastDeath;
  }

  clear() {
    this.data.fill(0);
    this.cursor = 0;
    this.highWater = 0;
    this.lastDeath = -Infinity;
    this.dirtyStart = -1;
    this.dirtyCount = 0;
    this.fullUpload = true;
    this.emitted = 0;
    this.mesh.visible = false;
    this.geo.instanceCount = 0;
  }

  /** Live particles at time t (CPU scan; for stats and tests, not called per frame). */
  alive(t: number): number {
    let n = 0;
    const d = this.data;
    for (let i = 0; i < this.highWater; i++) {
      const o = i * STRIDE;
      const age = t - d[o + 3];
      if (age >= 0 && age < d[o + 7]) n++;
    }
    return n;
  }

  /** Mix the live particles' full spawn state into a hash (seek / replay reproducibility tests). */
  hashInto(t: number, mix: (x: number) => void) {
    const d = this.data;
    for (let i = 0; i < this.highWater; i++) {
      const o = i * STRIDE;
      const age = t - d[o + 3];
      if (!(age >= 0 && age < d[o + 7])) continue;
      for (let j = 0; j < STRIDE; j++) mix(d[o + j]);
    }
  }

  /** order-independent hash of the live particles (sum of per-particle hashes; ring slots differ between runs) */
  hashLive(t: number): number {
    let sum = 0;
    const d = this.data;
    for (let i = 0; i < this.highWater; i++) {
      const o = i * STRIDE;
      const age = t - d[o + 3];
      if (!(age >= 0 && age < d[o + 7])) continue;
      let h = 0x811c9dc5 >>> 0;
      for (let j = 0; j < STRIDE; j++) {
        h ^= Math.round(d[o + j] * 1e4) | 0;
        h = Math.imul(h, 16777619) >>> 0;
      }
      sum = (sum + h) >>> 0;
    }
    return sum;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}
