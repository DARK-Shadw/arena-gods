/**
 * Textured stateless particles (F3): flipbook particles and Kenney mask sprites, instanced quads.
 *
 * Same contract as particles.ts: a particle is a pure function of its spawn data and the FX time
 * uniform, so scrubbing and `?t=` seeks show the exact state; the CPU only writes a burst's
 * instances once (an update range) and sets one uniform per frame.
 *
 * One `SpriteLayer` per texture (one draw call each):
 *  - mode 'flip':  a flipbook atlas (atlas.json `type: 'flipbook'`), frame from age (one-shot over the
 *                  particle's life, or a fixed fps with loop / clamp), sub-frame blend: motion vectors
 *                  when the atlas has them and the tier allows, otherwise a plain crossfade;
 *                  kinds emissive / lit3 (relit from the FX key light) / lit-fixed;
 *  - mode 'mask':  fx_sprites (64 grey masks, channel-packed): the particle stores a sprite index.
 * Output is premultiplied "additive-alpha" (blend ONE, ONE_MINUS_SRC_ALPHA): a particle flagged
 * additive writes alpha 0 (pure glow: sparks, flares), others occlude (dust, blood, smoke), all in one
 * draw. Soft-particle fade against the shared depth (F1).
 *
 * Orientation per particle: camera-facing card (with rotation + spin), velocity-stretched streak
 * (sparks, droplets: `stretch` seconds of motion), or flat on the floor (rings, scuffs).
 */
import * as THREE from 'three';
import { SOFT_DEPTH_PARS, softDepthUniforms } from './softDepth';
import { FLIPBOOK_PARS, type AtlasEntry } from './atlas';

/** floats per particle: p0 t0 | v0 life | rgb alpha | drag grav stretch soft | size0 size1 rot spin | sel fps flags aspect */
const STRIDE = 24;
export const SP_ADD = 1;
export const SP_STREAK = 2;
export const SP_FLOOR = 4;
export const SP_LOOP = 8;

/** shared key light for lit flipbooks (world direction towards the light); the game sets it per theme / camera */
export const fxKeyLight = {
  dir: new THREE.Vector3(-0.4, 0.8, 0.45).normalize(),
  color: new THREE.Color('#ffe2c0'),
  ambient: new THREE.Color('#2a2f3a'),
};

/** one emission (reused scratch object: fill and pass to emit()) */
export interface SpriteSpawn {
  t0: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  r: number; g: number; b: number; a: number;
  drag: number; grav: number; stretch: number; soft: number;
  size0: number; size1: number; rot: number; spin: number;
  sel: number; fps: number; flags: number; aspect: number;
}
export const newSpawn = (): SpriteSpawn => ({ t0: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, r: 1, g: 1, b: 1, a: 1, drag: 0, grav: 0, stretch: 0, soft: 0.3, size0: 0.2, size1: 0.2, rot: 0, spin: 0, sel: 0, fps: -1, flags: 0, aspect: 1 });

const VERT = /* glsl */ `
  attribute vec4 aP0;
  attribute vec4 aV0;
  attribute vec4 aCol;
  attribute vec4 aPhys;
  attribute vec4 aShape;
  attribute vec4 aSel;
  uniform float uTime;
  uniform float uFrames;
  uniform float uMode;
  uniform vec2 uNear;
  uniform vec2 uPivot;
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vDepth;
  varying float vSoft;
  varying float vFrame;
  varying float vAdd;
  varying float vSel;
  void main() {
    float age = uTime - aP0.w;
    float life = aV0.w;
    if (age < 0.0 || age >= life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vCol = vec4(0.0); return; }
    float k = aPhys.x, g = aPhys.y;
    float e = exp(-k * age);
    float f = k > 1e-4 ? (1.0 - e) / k : age;
    vec3 p = aP0.xyz + aV0.xyz * f;
    p.y -= k > 1e-4 ? g * (age - f) / k : 0.5 * g * age * age;
    vec3 vel = aV0.xyz * e;
    vel.y -= k > 1e-4 ? g * (1.0 - e) / k : g * age;
    if (g > 0.0 && p.y < 0.015) { p.y = 0.015; vel = vec3(0.0); }
    float u = age / life;
    float flags = aSel.z;
    float isAdd = mod(flags, 2.0);
    float isStreak = mod(floor(flags / 2.0), 2.0);
    float isFloor = mod(floor(flags / 4.0), 2.0);
    float isLoop = mod(floor(flags / 8.0), 2.0);
    // envelope: quick fade in, fade out over the last part of life (flipbooks animate their own alpha)
    float fin = clamp(age / max(0.02, life * 0.08), 0.0, 1.0);
    float fout = uMode < 0.5 ? 1.0 - smoothstep(0.82, 1.0, u) : 1.0 - smoothstep(0.45, 1.0, u);
    float grow = 1.0 - (1.0 - u) * (1.0 - u);
    float sz = mix(aShape.x, aShape.y, grow);
    float rot = aShape.z + aShape.w * age;
    vec4 mv;
    vec2 q = position.xy;
    if (isFloor > 0.5) {
      float c = cos(rot), s = sin(rot);
      vec2 l = vec2(q.x * aSel.w, q.y) * sz;
      vec3 wp = p + vec3(l.x * c - l.y * s, 0.0, l.x * s + l.y * c);
      mv = modelViewMatrix * vec4(wp, 1.0);
    } else {
      mv = modelViewMatrix * vec4(p, 1.0);
      vec2 ax, ay;
      float len = sz, wid = sz * aSel.w;
      if (isStreak > 0.5) {
        vec2 d = (modelViewMatrix * vec4(vel, 0.0)).xy;
        float sp = length(d);
        ax = sp > 1e-4 ? d / sp : vec2(cos(rot), sin(rot));
        len = sz + sp * aPhys.z;
      } else {
        ax = vec2(cos(rot), sin(rot));
        q += uPivot; // flipbook bake origin (dust puffs grow up from the ground)
      }
      ay = vec2(-ax.y, ax.x);
      // quad x runs along ax (length), y across (width)
      mv.xy += ax * q.x * len + ay * q.y * wid;
    }
    vCol = vec4(aCol.rgb, aCol.a * fin * fout * smoothstep(uNear.x, uNear.y, -mv.z));
    vAdd = isAdd;
    vSel = aSel.x;
    if (uMode < 0.5) {
      float fr = aSel.y > 0.0 ? aSel.x + age * aSel.y : aSel.x + u * (uFrames - 1.0 - aSel.x);
      vFrame = isLoop > 0.5 ? mod(fr, uFrames) : min(fr, uFrames - 1.0);
    } else vFrame = 0.0;
    // cards and floor quads: the atlas upright at rot 0; streaks: the texture's long (v) axis along the motion
    vUv = isStreak > 0.5 && isFloor < 0.5 ? position.yx + 0.5 : position.xy + 0.5;
    vDepth = -mv.z;
    vSoft = aPhys.w;
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = /* glsl */ `
  uniform sampler2D uTex;
  uniform sampler2D uMv;
  uniform float uMvOn;
  uniform float uMvScale;
  uniform vec2 uGrid;
  uniform float uFrames;
  uniform float uMode;
  uniform float uKind;
  uniform vec3 uKeyDirView;
  uniform vec3 uKeyColor;
  uniform vec3 uAmbient;
  uniform vec3 uLit;
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vDepth;
  varying float vSoft;
  varying float vFrame;
  varying float vAdd;
  varying float vSel;
  ${SOFT_DEPTH_PARS}
  ${FLIPBOOK_PARS}
  void main() {
    if (vCol.a <= 0.002) discard;
    vec3 rgb; float a;
    if (uMode > 0.5) {
      // mask sprite: cell i % 16 of a 4x4 grid, channel i / 16
      float cell = mod(vSel, 16.0);
      float ch = floor(vSel / 16.0);
      vec2 uv = (vec2(mod(cell, 4.0), 3.0 - floor(cell / 4.0)) + clamp(vUv, 0.004, 0.996)) / 4.0;
      vec4 t = texture2D(uTex, uv);
      a = ch < 0.5 ? t.r : ch < 1.5 ? t.g : ch < 2.5 ? t.b : t.a;
      // occluding mask sprites (blood, fibres, seeds) are albedo lit by the FX key light; glows are emissive
      rgb = vCol.rgb * a * (vAdd > 0.5 ? vec3(1.0) : uLit);
    } else {
      vec4 c = fbSample(uTex, uMv, uMvOn, uMvScale, uGrid, uFrames, vFrame, vUv);
      a = c.a;
      if (uKind > 0.5 && uKind < 1.5) rgb = fbLit3(c, uKeyDirView, uKeyColor, uAmbient) * vCol.rgb;
      else rgb = c.rgb * vCol.rgb;
    }
    float f = vCol.a * fxSoftFade(vDepth, vSoft);
    a *= f;
    if (a < 0.002 && vAdd < 0.5) discard;
    gl_FragColor = vec4(rgb * f, a * (1.0 - vAdd));
  }`;

export interface SpriteLayerOpts {
  name: string;
  mode: 'flip' | 'mask';
  capacity: number;
  layer: number;
  /** flipbook metadata (mode 'flip'); may arrive later with setAtlas() */
  entry?: AtlasEntry;
  near?: [number, number];
}

const _kd = new THREE.Vector3();

export class SpriteLayer {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  readonly name: string;
  readonly mode: 'flip' | 'mask';
  private limit: number;
  private data: Float32Array;
  private buf: THREE.InstancedInterleavedBuffer;
  private geo: THREE.InstancedBufferGeometry;
  readonly mat: THREE.ShaderMaterial;
  private cursor = 0;
  private highWater = 0;
  private dirtyStart = -1;
  private dirtyCount = 0;
  private fullUpload = false;
  private lastDeath = -Infinity;
  private hasTex = false;
  emitted = 0;

  constructor(o: SpriteLayerOpts) {
    this.capacity = o.capacity;
    this.limit = o.capacity;
    this.name = o.name;
    this.mode = o.mode;
    this.data = new Float32Array(o.capacity * STRIDE);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const names = ['aP0', 'aV0', 'aCol', 'aPhys', 'aShape', 'aSel'];
    names.forEach((n, i) => g.setAttribute(n, new THREE.InterleavedBufferAttribute(this.buf, 4, i * 4)));
    g.instanceCount = 0;
    this.geo = g;
    const near = o.near ?? [0.35, 1.6];
    this.mat = new THREE.ShaderMaterial({
      name: `fx.sprites.${o.name}`,
      uniforms: {
        uTime: { value: 0 },
        uTex: { value: null },
        uMv: { value: null },
        uMvOn: { value: 0 },
        uMvScale: { value: 0 },
        uGrid: { value: new THREE.Vector2(4, 4) },
        uFrames: { value: 1 },
        uMode: { value: o.mode === 'mask' ? 1 : 0 },
        uKind: { value: 0 },
        uKeyDirView: { value: new THREE.Vector3(0, 1, 0) },
        uKeyColor: { value: fxKeyLight.color },
        uAmbient: { value: fxKeyLight.ambient },
        uLit: { value: new THREE.Vector3(1, 1, 1) },
        uNear: { value: new THREE.Vector2(near[0], near[1]) },
        uPivot: { value: new THREE.Vector2(0, 0) },
        ...softDepthUniforms,
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.name = `fx.sprites.${o.name}`;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.layers.set(o.layer);
    // lit3 flipbooks: the key light in view space, per camera
    this.mesh.onBeforeRender = (_r, _s, cam) => {
      _kd.copy(fxKeyLight.dir).transformDirection(cam.matrixWorldInverse);
      this.mat.uniforms.uKeyDirView.value.copy(_kd);
      const k = fxKeyLight.color, a = fxKeyLight.ambient;
      this.mat.uniforms.uLit.value.set(k.r * 0.8 + a.r * 2, k.g * 0.8 + a.g * 2, k.b * 0.8 + a.b * 2);
    };
    if (o.entry) this.setEntry(o.entry);
  }

  /** flipbook metadata (grid, frames, kind) */
  setEntry(e: AtlasEntry) {
    const u = this.mat.uniforms;
    if (e.grid) u.uGrid.value.set(e.grid[0], e.grid[1]);
    u.uFrames.value = e.frames ?? 1;
    u.uKind.value = e.kind === 'lit3' ? 1 : e.kind === 'lit-fixed' ? 2 : 0;
    u.uMvScale.value = e.mv?.scale ?? 0;
    // cards are drawn centred on the particle; shift so the atlas pivot (bake origin) sits on it
    if (e.pivot) u.uPivot.value.set(0.5 - e.pivot[0], 0.5 - e.pivot[1]);
  }

  /** texture for the current tier (+ motion vectors when the tier uses them) */
  setTexture(tex: THREE.Texture | null, mv: THREE.Texture | null = null) {
    const u = this.mat.uniforms;
    u.uTex.value = tex;
    u.uMv.value = mv ?? tex;
    u.uMvOn.value = mv ? 1 : 0;
    this.hasTex = !!tex;
  }

  setLimit(n: number) {
    this.limit = Math.max(8, Math.min(this.capacity, Math.floor(n)));
    if (this.cursor >= this.limit) this.cursor = 0;
  }

  emit(s: SpriteSpawn) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.limit;
    const o = i * STRIDE;
    const d = this.data;
    d[o] = s.x; d[o + 1] = s.y; d[o + 2] = s.z; d[o + 3] = s.t0;
    d[o + 4] = s.vx; d[o + 5] = s.vy; d[o + 6] = s.vz; d[o + 7] = s.life;
    d[o + 8] = s.r; d[o + 9] = s.g; d[o + 10] = s.b; d[o + 11] = s.a;
    d[o + 12] = s.drag; d[o + 13] = s.grav; d[o + 14] = s.stretch; d[o + 15] = s.soft;
    d[o + 16] = s.size0; d[o + 17] = s.size1; d[o + 18] = s.rot; d[o + 19] = s.spin;
    d[o + 20] = s.sel; d[o + 21] = s.fps; d[o + 22] = s.flags; d[o + 23] = s.aspect;
    if (this.dirtyStart < 0) this.dirtyStart = i;
    this.dirtyCount++;
    if (i + 1 > this.highWater) this.highWater = i + 1;
    if (s.t0 + s.life > this.lastDeath) this.lastDeath = s.t0 + s.life;
    this.emitted++;
  }

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

  setTime(t: number) {
    this.mat.uniforms.uTime.value = t;
    this.mesh.visible = this.hasTex && this.highWater > 0 && t < this.lastDeath;
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

  alive(t: number): number {
    let n = 0;
    const d = this.data;
    for (let i = 0; i < this.highWater; i++) {
      const a = t - d[i * STRIDE + 3];
      if (a >= 0 && a < d[i * STRIDE + 7]) n++;
    }
    return n;
  }

  /** order-independent hash of the live particles' spawn data (ring slots differ between runs) */
  hashLive(t: number): number {
    let sum = 0;
    const d = this.data;
    for (let i = 0; i < this.highWater; i++) {
      const o = i * STRIDE;
      const a = t - d[o + 3];
      if (!(a >= 0 && a < d[o + 7])) continue;
      sum = (sum + hashFloats(d, o, STRIDE)) >>> 0;
    }
    return sum;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}

/** FNV-style hash of n floats (rounded to 1e-4) starting at o */
export function hashFloats(d: ArrayLike<number>, o: number, n: number): number {
  let h = 0x811c9dc5 >>> 0;
  for (let j = 0; j < n; j++) {
    h ^= Math.round(d[o + j] * 1e4) | 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
