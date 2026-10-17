/**
 * FX core + the old VFX API (facade).
 *
 * `VFX` keeps every method the game, the entrances, the finisher FX and the
 * Animation Lab already call (sparks / flash / dust / smoke / fire / embers /
 * shockwave / arrow / debrisBurst / update / clear / group / flashLight), so
 * nothing outside had to change. Internally:
 *  - particles are stateless GPU instances (particles.ts) evaluated at FX time;
 *  - shockwave rings, arrows and debris are fixed pools created once (the old
 *    code allocated a geometry + material per call and never disposed debris);
 *  - every random number comes from a seeded stream (fxRng.ts): legacy calls
 *    draw their seed from a per-match stream, director spawns pass an explicit
 *    seed (match seed, event index, effect id);
 *  - everything (particles, rings, arrows, debris, impact light) is a function
 *    of the FX clock, so `setTime(t)` shows the exact state at t.
 *
 * The primitives are also called by the FX director with an explicit rng and
 * spawn time (`*At` methods); the colour/size/speed numbers are the old ones.
 */
import * as THREE from 'three';
import { FxClock } from './fxClock';
import { FxRng, hashN, hashStr } from './fxRng';
import { GpuParticles } from './particles';
import { fxSettings, TIER_CAPS } from './fxSettings';
import { DistortionSprites } from './distortion';
import { LAYER } from './fxLayers';
import { SOFTNESS } from './softDepth';
import { HDR_SCALE } from './fxDefs';
import { SpriteLayer, hashFloats } from './sprites';
import { FloorDecals } from './decals';
import { FxLights } from './lights';
import { Ribbon } from './ribbons';
import { Afterimages } from './afterimage';
import type { FxAtlases } from './atlas';

type V3 = { x: number; y: number; z: number };

/** live-effect ring capacity (for fxHash / stats; oldest entries are overwritten) */
const LIVE_CAP = 1024;
/** velocity stretch (seconds of motion) for spark streaks: a slightly better dot, not a restyle */
const SPARK_STRETCH = 0.012;
const DEBRIS_G = 14;
const DEBRIS_FLOOR = 0.05;
const DEBRIS_LIFE = 6;

/** live effect lifetimes of the legacy primitives (max particle life) */
export const PRIM_LIFE = { sparks: 0.6, flash: 0.2, dust: 1.3, smoke: 2.5, fire: 0.6, embers: 2.5, shockwave: 0.5, arrow: 0.85, debris: DEBRIS_LIFE } as const;

interface Ring {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  t0: number;
  life: number;
  size: number;
  on: boolean;
}
interface Arrow {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t0: number;
  dur: number;
  seed: number;
  /** trail ticks (60 Hz on FX time) already emitted */
  ticks: number;
  hit: boolean;
  on: boolean;
}

const _c = new THREE.Color();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _rng = new FxRng(1);

export class VFX {
  group = new THREE.Group();
  /** additive (sparks, flashes, fire, embers) and alpha (dust, smoke) particle layers */
  add: GpuParticles;
  alpha: GpuParticles;
  /** F1 screen distortion sprites (heat shimmer, shock ripples) on LAYER.FX_DIST */
  dist: DistortionSprites;
  /**
   * Per-spawn overrides set by the director around a layer (undefined = the primitive's default):
   * soft-particle fade distance (m, 0 = hard) and HDR colour multiplier (fxDefs HDR_SCALE).
   */
  softOverride: number | undefined = undefined;
  hdrOverride: number | undefined = undefined;
  readonly clock = new FxClock();
  /** first FX light slot (compat: the old single impact light) */
  flashLight: THREE.PointLight;
  /** F3: FX light pool (plan 2.5), textured sprite / flipbook layers, floor decals, weapon ribbons, ghosts */
  readonly lights: FxLights;
  readonly sprites = new Map<string, SpriteLayer>();
  readonly decals = new FloorDecals(256);
  readonly ribbons: Ribbon[] = [];
  readonly ghosts = new Afterimages();
  /** noise_a (ribbon streak noise) */
  readonly noise = { value: null as THREE.Texture | null };
  atlases: FxAtlases | null = null;
  /** time the decals are evaluated at (sim time in a fight; undefined = FX time) */
  decalTime: number | undefined = undefined;
  /** time the ribbons are evaluated at (sim time in a fight; undefined = FX time) */
  ribbonTime: number | undefined = undefined;

  private matchSeed = 1;
  private stream = new FxRng(1);
  private rings: Ring[] = [];
  private ringGeo = new THREE.RingGeometry(0.8, 1, 48);
  private arrows: Arrow[] = [];
  private arrowGeo: THREE.CylinderGeometry;
  // debris: one instanced mesh, analytic bounce
  private debrisMesh: THREE.InstancedMesh;
  private debrisCap: number;
  private dCursor = 0;
  private dHigh = 0;
  private dLastDeath = -Infinity;
  /** per piece: t0, p0 xyz, v0 xyz, spin xyz, scale xyz (13 floats) */
  private dData: Float32Array;
  // live effect list (ring buffer): id hash, spawn time, seed, end time
  private liveId = new Uint32Array(LIVE_CAP);
  private liveSeed = new Uint32Array(LIVE_CAP);
  private liveT0 = new Float64Array(LIVE_CAP);
  private liveEnd = new Float64Array(LIVE_CAP);
  private liveName: string[] = new Array(LIVE_CAP).fill('');
  private liveCursor = 0;
  private liveCount = 0;
  /** total spawns since the last clear (stats) */
  spawns = 0;
  private offTier: () => void;

  constructor() {
    const caps = TIER_CAPS[2];
    this.add = new GpuParticles(caps.add, { name: 'add', additive: true, layer: LAYER.FX_ADD });
    this.alpha = new GpuParticles(caps.alpha, { name: 'alpha', additive: false, maxAlpha: 0.45, layer: LAYER.FX_ALPHA });
    this.dist = new DistortionSprites(64);
    this.group.name = 'fx';
    // alpha first: the FX pass draws in scene order within a layer mask (dust behind sparks)
    this.group.add(this.alpha.mesh, this.add.mesh, this.dist.mesh);
    for (let i = 0; i < caps.rings; i++) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.name = 'fx.ring';
      mesh.layers.set(LAYER.FX_ADD);
      this.group.add(mesh);
      this.rings.push({ mesh, mat, t0: 0, life: 1, size: 1, on: false });
    }
    this.arrowGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.9, 5);
    this.arrowGeo.rotateX(Math.PI / 2);
    for (let i = 0; i < 8; i++) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
      const mesh = new THREE.Mesh(this.arrowGeo, mat);
      mesh.visible = false;
      mesh.name = 'fx.arrow';
      mesh.layers.set(LAYER.FX_ADD);
      this.group.add(mesh);
      this.arrows.push({ mesh, mat, from: new THREE.Vector3(), to: new THREE.Vector3(), t0: 0, dur: 1, seed: 0, ticks: 0, hit: false, on: false });
    }
    this.debrisCap = caps.debris;
    this.dData = new Float32Array(this.debrisCap * 13);
    this.debrisMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 }), this.debrisCap);
    this.debrisMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.debrisCap * 3), 3);
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debrisMesh.castShadow = true;
    this.debrisMesh.frustumCulled = false;
    this.debrisMesh.count = 0;
    this.debrisMesh.visible = false;
    this.debrisMesh.name = 'fx.debris';
    this.group.add(this.debrisMesh);
    this.lights = new FxLights(this.group, 3);
    this.flashLight = this.lights.lights[0];
    this.decals.mesh.layers.set(LAYER.WORLD);
    this.group.add(this.decals.mesh, this.ghosts.group);
    for (let i = 0; i < 2; i++) {
      const r = new Ribbon(this.noise);
      r.mesh.renderOrder = 5;
      this.group.add(r.mesh, r.distMesh);
      this.ribbons.push(r);
    }
    this.applyTier();
    this.offTier = fxSettings.onChange(() => this.applyTier());
  }

  private applyTier() {
    const c = fxSettings.caps();
    this.add.setLimit(c.add);
    this.alpha.setLimit(c.alpha);
    this.lights.setSlots(c.lights);
    this.decals.setLimit(c.decals);
    this.ghosts.setLimit(c.ghosts);
    for (const r of this.ribbons) r.setTier(fxSettings.quality);
    for (const [k, L] of this.sprites) {
      L.setLimit(k === 'mask' ? c.sprites : c.flipbooks);
      this.bindLayer(k, L);
    }
    this.bindStatic();
  }

  // ------------------------------------------------------------------ atlases (F3)
  /** Use the FX atlases (game: loaded once per session). Layers get their textures as they arrive. */
  useAtlases(a: FxAtlases | null) {
    this.atlases = a;
    for (const [k, L] of this.sprites) this.bindLayer(k, L);
    this.bindStatic();
  }

  /** the sprite layer for 'mask' (fx_sprites) or a flipbook atlas id (created on first use) */
  layer(key: string): SpriteLayer {
    let L = this.sprites.get(key);
    if (!L) {
      const mask = key === 'mask';
      const c = fxSettings.caps();
      L = new SpriteLayer({ name: key, mode: mask ? 'mask' : 'flip', capacity: mask ? TIER_CAPS[2].sprites : TIER_CAPS[2].flipbooks, layer: LAYER.FX_ALPHA });
      L.setLimit(mask ? c.sprites : c.flipbooks);
      // flipbook smoke / dust first, then the mask sprites (sparks, blood) over them
      L.mesh.renderOrder = mask ? 3 : 1;
      this.group.add(L.mesh);
      this.sprites.set(key, L);
      this.bindLayer(key, L);
    }
    return L;
  }

  private bindLayer(key: string, L: SpriteLayer) {
    const A = this.atlases;
    if (!A) return;
    const id = key === 'mask' ? 'fx_sprites' : key;
    const q = fxSettings.quality;
    void A.load()
      .then(async () => {
        if (!A.has(id)) return;
        const e = A.entry(id);
        if (e.type === 'flipbook') L.setEntry(e);
        const tex = await A.tierTexture(id, q);
        const mv = e.mv && q > 0 ? await A.texture(id, 'mv') : null;
        if (fxSettings.quality === q) L.setTexture(tex, mv);
      })
      .catch((err) => console.warn('[fx] atlas', id, err));
  }

  private bindStatic() {
    const A = this.atlases;
    if (!A) return;
    const q = fxSettings.quality;
    void A.load()
      .then(async () => {
        const [map, nrm, noise] = await Promise.all([A.tierTexture('decals', q), A.texture('decals', 'data'), A.texture('noise_a')]);
        if (fxSettings.quality !== q) return;
        this.decals.setTextures(map, nrm);
        this.noise.value = noise;
      })
      .catch((err) => console.warn('[fx] decal / noise atlas', err));
  }

  // ------------------------------------------------------------------ seeding
  /** New match / seek: reseed the legacy stream from (match seed, time) and clear everything. */
  reset(matchSeed: number, t: number) {
    this.matchSeed = matchSeed >>> 0;
    this.clear();
    this.clock.seek(t);
    this.stream.reseed(hashN(this.matchSeed, 0x1e9ac, Math.round(t * 1000)));
    this.render();
  }
  get seed() {
    return this.matchSeed;
  }
  /** Deterministic [0,1) for callers that used unseeded randomness on FX paths (entrances, finisher FX). */
  rand(): number {
    return this.stream.next();
  }
  /** Seed for the next legacy call (drawn from the per-match stream). */
  nextSeed(): number {
    return this.stream.u32();
  }

  /** Record a spawned effect in the live list (id, spawn time, seed). */
  track(id: string, t0: number, seed: number, life: number) {
    const i = this.liveCursor;
    this.liveCursor = (this.liveCursor + 1) % LIVE_CAP;
    this.liveId[i] = hashStr(id);
    this.liveName[i] = id;
    this.liveSeed[i] = seed >>> 0;
    this.liveT0[i] = t0;
    this.liveEnd[i] = t0 + life;
    if (this.liveCount < LIVE_CAP) this.liveCount++;
    this.spawns++;
  }

  private legacy(id: keyof typeof PRIM_LIFE, life: number = PRIM_LIFE[id]): FxRng {
    const seed = this.stream.u32();
    this.track(`legacy.${id}`, this.clock.t, seed, life);
    return _rng.reseed(seed);
  }

  // ------------------------------------------------------------------ old API (facade)
  sparks(p: V3, n: number, color = '#ffc070', speed = 7, dir?: V3) {
    this.sparksAt(this.legacy('sparks'), this.clock.t, p, n, color, speed, dir);
  }
  flash(p: V3, color = '#fff0d0', size = 1.2, light = 6) {
    this.flashAt(this.legacy('flash'), this.clock.t, p, color, size, light);
  }
  dust(p: V3, n: number, spread = 1, color = '#9a8064') {
    this.dustAt(this.legacy('dust'), this.clock.t, p, n, spread, color);
  }
  smoke(p: V3, n: number, color = '#2a2230', size = 1.2, rise = 0.8) {
    this.smokeAt(this.legacy('smoke'), this.clock.t, p, n, color, size, rise);
  }
  fire(p: V3, v: V3, n: number, size = 0.35, spread = 0.6) {
    this.fireAt(this.legacy('fire'), this.clock.t, p, v, n, size, spread);
  }
  embers(p: V3, n: number, color = '#ff8a30', area = 1) {
    this.embersAt(this.legacy('embers'), this.clock.t, p, n, color, area);
  }
  shockwave(p: V3, color = '#ffd8a0', size = 4, life = 0.5) {
    this.legacy('shockwave', life);
    this.shockwaveAt(this.clock.t, p, color, size, life);
  }
  /** Glowing arrow streak travelling from -> to. */
  arrow(from: V3, to: V3, color = '#c8ffe0') {
    const r = this.legacy('arrow');
    this.arrowAt(r.u32(), this.clock.t, from, to, color);
  }
  debrisBurst(p: V3, color = '#6b4a2c', n = 10) {
    this.debrisAt(this.legacy('debris'), this.clock.t, p, color, n);
  }

  // ------------------------------------------------------------------ primitives (explicit rng + spawn time)
  private soft(def: number) {
    return this.softOverride ?? def;
  }
  /** colour (hex) x HDR multiplier into _c */
  private hdrColor(color: string, def: number) {
    return _c.set(color).multiplyScalar(this.hdrOverride ?? def);
  }

  sparksAt(r: FxRng, t0: number, p: V3, n: number, color: string, speed = 7, dir?: V3) {
    this.hdrColor(color, HDR_SCALE.sparks);
    const sf = this.soft(SOFTNESS.sparks);
    for (let i = 0; i < n; i++) {
      _v.set(r.range(-1, 1), r.range(-0.2, 1.2), r.range(-1, 1)).normalize().multiplyScalar(speed * r.range(0.3, 1));
      if (dir) _v.set(_v.x + dir.x * speed * 0.6, _v.y + dir.y * speed * 0.6, _v.z + dir.z * speed * 0.6);
      this.add.emit(t0, p.x, p.y, p.z, _v.x, _v.y, _v.z, _c.r, _c.g, _c.b, r.range(0.04, 0.09), r.range(0.25, 0.6), 2, 9, 0, SPARK_STRETCH, sf);
    }
  }

  flashAt(_r: FxRng, t0: number, p: V3, color: string, size = 1.2, light = 6) {
    this.hdrColor(color, HDR_SCALE.flash);
    const sf = this.soft(SOFTNESS.flash);
    this.add.emit(t0, p.x, p.y, p.z, 0, 0, 0, _c.r, _c.g, _c.b, size, 0.12, 1, 0, 1.5, 0, sf);
    this.add.emit(t0, p.x, p.y, p.z, 0, 0, 0, _c.r, _c.g, _c.b, size * 0.5, 0.2, 1, 0, 0.5, 0, sf);
    // the light lives on the light clock (keeps fading during hit-stop); map the spawn onto it
    if (light > 0) this.lightAt(t0, color, light, 0.21, p, 9);
  }

  /** FX light pool request (plan 2.5): peak intensity fading over ~dur seconds of real time */
  lightAt(t0: number, color: string, intensity: number, dur: number, p: V3, radius = 9) {
    this.lights.add(this.clock.light - (this.clock.t - t0), color, intensity, dur, p, radius);
  }

  dustAt(r: FxRng, t0: number, p: V3, n: number, spread = 1, color = '#9a8064') {
    this.hdrColor(color, HDR_SCALE.dust);
    const sf = this.soft(SOFTNESS.dust);
    // dust now starts at the given height (was always the floor: the chandelier's ceiling dust and
    // the gate-top dust appeared on the ground); floor callers pass y = 0 and look as before
    const y0 = Math.max(0, p.y);
    for (let i = 0; i < n; i++) {
      const x = p.x + r.range(-0.3, 0.3) * spread,
        y = y0 + 0.1 + r.next() * 0.2,
        z = p.z + r.range(-0.3, 0.3) * spread;
      const vx = r.range(-1, 1) * 2 * spread,
        vy = r.range(0.2, 1.2),
        vz = r.range(-1, 1) * 2 * spread;
      this.alpha.emit(t0, x, y, z, vx, vy, vz, _c.r, _c.g, _c.b, r.range(0.3, 0.6) * spread, r.range(0.6, 1.3), 2.5, 0, 1.4, 0, sf);
    }
  }

  smokeAt(r: FxRng, t0: number, p: V3, n: number, color = '#2a2230', size = 1.2, rise = 0.8) {
    this.hdrColor(color, HDR_SCALE.smoke);
    const sf = this.soft(SOFTNESS.smoke);
    for (let i = 0; i < n; i++) {
      const x = p.x + r.range(-0.6, 0.6),
        y = p.y + r.range(0, 1.5),
        z = p.z + r.range(-0.6, 0.6);
      const vx = r.range(-1, 1),
        vy = r.range(0, rise),
        vz = r.range(-1, 1);
      this.alpha.emit(t0, x, y, z, vx, vy, vz, _c.r, _c.g, _c.b, size * r.range(0.7, 1.3), r.range(1.2, 2.5), 1.2, 0, 1.2, 0, sf);
    }
  }

  fireAt(r: FxRng, t0: number, p: V3, v: V3, n: number, size = 0.35, spread = 0.6) {
    const k = this.hdrOverride ?? HDR_SCALE.fire;
    const sf = this.soft(SOFTNESS.fire);
    for (let i = 0; i < n; i++) {
      _c.setHSL(r.range(0.02, 0.1), 1, r.range(0.45, 0.6)).multiplyScalar(k);
      const vx = v.x + r.range(-1, 1) * spread,
        vy = v.y + r.range(0, 1) * spread,
        vz = v.z + r.range(-1, 1) * spread;
      this.add.emit(t0, p.x, p.y, p.z, vx, vy, vz, _c.r, _c.g, _c.b, size * r.range(0.6, 1.2), r.range(0.3, 0.6), 1.5, -2, 0.8, 0, sf);
    }
  }

  embersAt(r: FxRng, t0: number, p: V3, n: number, color = '#ff8a30', area = 1) {
    this.hdrColor(color, HDR_SCALE.embers);
    const sf = this.soft(SOFTNESS.embers);
    for (let i = 0; i < n; i++) {
      const x = p.x + r.range(-1, 1) * area,
        y = p.y + r.range(0, 0.5),
        z = p.z + r.range(-1, 1) * area;
      this.add.emit(t0, x, y, z, r.range(-0.4, 0.4), r.range(0.8, 2.2), r.range(-0.4, 0.4), _c.r, _c.g, _c.b, r.range(0.03, 0.07), r.range(1, 2.5), 0.5, -0.3, 0, 0, sf);
    }
  }

  /**
   * Heat shimmer column standing at p (distortion.ts kind 0). `tier`: lowest distortion tier that
   * shows it (TIER_CAPS.dist); returns false when the current tier hides it.
   */
  heatAt(r: FxRng, t0: number, p: V3, size: number, height: number, life: number, strength = 1, rise = 1.5, tier: 1 | 2 = 2): boolean {
    if (fxSettings.caps().dist < tier) return false;
    this.dist.emit(t0, 0, p.x, p.y, p.z, life, size, strength, height, rise, this.soft(SOFTNESS.heat), r.next() * 64);
    return true;
  }

  /** Expanding pressure ripple centred at p (distortion.ts kind 1). */
  rippleAt(r: FxRng, t0: number, p: V3, size: number, life: number, strength = 1, tier: 1 | 2 = 1): boolean {
    if (fxSettings.caps().dist < tier) return false;
    this.dist.emit(t0, 1, p.x, p.y, p.z, life, size, strength, 0, 0, this.soft(SOFTNESS.ripple), r.next() * 64);
    return true;
  }

  shockwaveAt(t0: number, p: V3, color = '#ffd8a0', size = 4, life = 0.5) {
    // reuse a free ring, else the one closest to expiry
    let best = this.rings[0];
    let bestEnd = Infinity;
    for (const g of this.rings) {
      if (!g.on) {
        best = g;
        break;
      }
      const end = g.t0 + g.life;
      if (end < bestEnd) (bestEnd = end), (best = g);
    }
    best.on = true;
    best.t0 = t0;
    best.life = life;
    best.size = size;
    best.mat.color.set(color);
    best.mesh.position.set(p.x, 0.05, p.z);
  }

  arrowAt(seed: number, t0: number, from: V3, to: V3, color = '#c8ffe0') {
    let a = this.arrows.find((x) => !x.on);
    if (!a) a = this.arrows.reduce((m, x) => (x.t0 < m.t0 ? x : m), this.arrows[0]);
    a.on = true;
    a.hit = false;
    a.ticks = 0;
    a.seed = seed;
    a.t0 = t0;
    a.from.set(from.x, from.y, from.z);
    a.to.set(to.x, to.y, to.z);
    a.dur = Math.max(0.06, a.from.distanceTo(a.to) / 45);
    a.mat.color.set(color);
    a.mesh.position.copy(a.from);
    a.mesh.lookAt(a.to);
  }

  /** scale < 1: small chips launched from p (impact chips); dust: the old dust puff with the burst */
  debrisAt(r: FxRng, t0: number, p: V3, color: string, n = 10, scale = 1, speed = 1, dust = true) {
    _c.set(color);
    const col = this.debrisMesh.instanceColor!;
    for (let i = 0; i < n; i++) {
      const k = this.dCursor;
      this.dCursor = (this.dCursor + 1) % this.debrisCap;
      const o = k * 13;
      const d = this.dData;
      d[o + 10] = r.range(0.1, 0.35) * scale;
      d[o + 11] = r.range(0.05, 0.12) * scale;
      d[o + 12] = r.range(0.1, 0.4) * scale;
      d[o] = t0;
      d[o + 1] = p.x + r.range(-0.3, 0.3) * scale;
      d[o + 2] = scale < 1 ? Math.max(0.08, p.y) : 0.5 + r.range(0, 0.5);
      d[o + 3] = p.z + r.range(-0.3, 0.3) * scale;
      d[o + 4] = r.range(-4, 4) * speed;
      d[o + 5] = r.range(2, 6) * speed;
      d[o + 6] = r.range(-4, 4) * speed;
      d[o + 7] = r.range(-9, 9);
      d[o + 8] = r.range(-9, 9);
      d[o + 9] = r.range(-9, 9);
      col.setXYZ(k, _c.r, _c.g, _c.b);
      if (k + 1 > this.dHigh) this.dHigh = k + 1;
      if (t0 + DEBRIS_LIFE > this.dLastDeath) this.dLastDeath = t0 + DEBRIS_LIFE;
    }
    col.needsUpdate = true;
    _v.set(p.x, 0, p.z);
    if (dust) this.dustAt(r, t0, _v, 14, 1.2);
  }

  // ------------------------------------------------------------------ time
  /** Advance FX time by dt (and the impact-light clock by realDt) and update every layer. */
  update(dt: number, realDt = dt) {
    this.clock.advance(dt, realDt);
    this.render();
  }

  /** Jump to FX time t without clearing (FX Lab scrub). Everything stateless re-evaluates exactly. */
  setTime(t: number) {
    this.clock.seek(t);
    this.render();
  }

  /** Evaluate every layer at the current clock (no allocation). */
  render() {
    const t = this.clock.t;
    this.add.flush();
    this.alpha.flush();
    this.dist.flush();
    this.add.setTime(t);
    this.alpha.setTime(t);
    this.dist.setTime(t);
    for (const L of this.sprites.values()) L.flush(), L.setTime(t);
    this.decals.flush();
    this.decals.setTime(this.decalTime ?? t);
    const rt = this.ribbonTime ?? t;
    for (const r of this.ribbons) r.build(rt);
    this.ghosts.update(t);
    for (const g of this.rings) {
      if (!g.on) continue;
      const k = (t - g.t0) / g.life;
      if (k >= 1) {
        g.on = false;
        g.mesh.visible = false;
        continue;
      }
      g.mesh.visible = k >= 0;
      const s = 0.3 + Math.max(0, k) * g.size;
      g.mesh.scale.set(s, s, s);
      g.mat.opacity = (1 - Math.max(0, k)) * 0.8;
    }
    for (const a of this.arrows) if (a.on) this.updateArrow(a, t);
    this.updateDebris(t);
    this.updateLight();
  }

  private updateArrow(a: Arrow, t: number) {
    const age = t - a.t0;
    const k = Math.min(1, Math.max(0, age / a.dur));
    a.mesh.visible = age >= 0 && k < 1;
    a.mesh.position.lerpVectors(a.from, a.to, k);
    // trail: one 60 Hz tick of FX time = a 60 % chance of a glint, seeded per tick
    const ticks = Math.floor(Math.min(age, a.dur) * 60);
    _c.set('#e8fff0');
    while (a.ticks < ticks) {
      a.ticks++;
      const r = _rng.reseed(hashN(a.seed, a.ticks));
      if (r.next() < 0.6) {
        const tt = a.t0 + a.ticks / 60;
        _v.lerpVectors(a.from, a.to, Math.min(1, a.ticks / 60 / a.dur));
        this.add.emit(tt, _v.x, _v.y, _v.z, 0, 0, 0, _c.r, _c.g, _c.b, 0.06, 0.25, 1, 0, 0, 0);
      }
    }
    if (k >= 1 && !a.hit) {
      a.hit = true;
      this.sparksAt(_rng.reseed(hashN(a.seed, 0xa770)), a.t0 + a.dur, a.to, 8, '#e8fff0', 4);
    }
    if (age > a.dur + 0.1) {
      a.on = false;
      a.mesh.visible = false;
    }
  }

  /** Analytic debris: ballistic arcs with bounces (old integrator's constants), at rest after that. */
  private updateDebris(t: number) {
    const M = this.debrisMesh;
    if (this.dHigh === 0 || t >= this.dLastDeath) {
      if (M.visible) {
        M.visible = false;
        M.count = 0;
      }
      return;
    }
    M.visible = true;
    M.count = this.dHigh;
    const d = this.dData;
    for (let k = 0; k < this.dHigh; k++) {
      const o = k * 13;
      let tau = t - d[o];
      if (d[o + 10] === 0 || tau < 0 || tau >= DEBRIS_LIFE) {
        _m.makeScale(0, 0, 0);
        M.setMatrixAt(k, _m);
        continue;
      }
      let x = d[o + 1],
        y = d[o + 2],
        z = d[o + 3],
        vx = d[o + 4],
        vy = d[o + 5],
        vz = d[o + 6],
        wx = d[o + 7],
        wy = d[o + 8],
        wz = d[o + 9],
        rx = 0,
        ry = 0,
        rz = 0;
      for (let b = 0; b < 8; b++) {
        const h = Math.max(0, y - DEBRIS_FLOOR);
        const s = (vy + Math.sqrt(vy * vy + 2 * DEBRIS_G * h)) / DEBRIS_G;
        const dt = Math.min(tau, s);
        x += vx * dt;
        z += vz * dt;
        y += vy * dt - 0.5 * DEBRIS_G * dt * dt;
        rx += wx * dt;
        ry += wy * dt;
        rz += wz * dt;
        if (tau <= s) break;
        tau -= s;
        // bounce: the old integrator's response (v *= 0.4, vy = |vy| * 0.3, spin halves)
        const vLand = vy - DEBRIS_G * s;
        y = DEBRIS_FLOOR;
        vx *= 0.4;
        vz *= 0.4;
        vy = Math.abs(vLand * 0.4) * 0.3;
        wx *= 0.5;
        wy *= 0.5;
        wz *= 0.5;
        if (vy < 0.3) break; // at rest
      }
      if (y < DEBRIS_FLOOR) y = DEBRIS_FLOOR;
      const age = t - d[o];
      const shrink = Math.min(1, (DEBRIS_LIFE - age) / 0.4);
      _v.set(x, y, z);
      _q.setFromEuler(_e.set(rx, ry, rz));
      _s.set(d[o + 10] * shrink, d[o + 11] * shrink, d[o + 12] * shrink);
      _m.compose(_v, _q, _s);
      M.setMatrixAt(k, _m);
    }
    M.instanceMatrix.needsUpdate = true;
  }

  private updateLight() {
    // F3: the strongest requests take the light pool's slots (lights.ts)
    this.lights.update(this.clock.light);
  }

  // ------------------------------------------------------------------ housekeeping
  clear() {
    this.add.clear();
    this.alpha.clear();
    this.dist.clear();
    for (const g of this.rings) (g.on = false), (g.mesh.visible = false);
    for (const a of this.arrows) (a.on = false), (a.mesh.visible = false);
    this.dData.fill(0);
    this.dCursor = 0;
    this.dHigh = 0;
    this.dLastDeath = -Infinity;
    this.debrisMesh.count = 0;
    this.debrisMesh.visible = false;
    this.lights.clear();
    for (const L of this.sprites.values()) L.clear();
    this.decals.clear();
    for (const r of this.ribbons) r.reset();
    this.ghosts.clear();
    this.liveCount = 0;
    this.liveCursor = 0;
    this.spawns = 0;
  }

  /** Live effects at the current time (id, spawn time, seed), oldest first. */
  liveEffects(): { id: string; t0: number; seed: number; end: number }[] {
    const t = this.clock.t;
    const out: { id: string; t0: number; seed: number; end: number }[] = [];
    for (let j = 0; j < this.liveCount; j++) {
      const i = (this.liveCursor - this.liveCount + j + LIVE_CAP) % LIVE_CAP;
      if (this.liveEnd[i] > t && this.liveT0[i] <= t) out.push({ id: this.liveName[i], t0: this.liveT0[i], seed: this.liveSeed[i], end: this.liveEnd[i] });
    }
    return out;
  }

  /** Hash of the live effect list (id, spawn time, seed): the plan's seek test. */
  hash(): string {
    const t = this.clock.t;
    // order-independent (F3): a seek replay spawns the same effects in a different order than a play-through
    let h = 0;
    let n = 0;
    for (let j = 0; j < this.liveCount; j++) {
      const i = (this.liveCursor - this.liveCount + j + LIVE_CAP) % LIVE_CAP;
      if (!(this.liveEnd[i] > t && this.liveT0[i] <= t)) continue;
      h = (h + hashN(this.liveId[i], Math.round(this.liveT0[i] * 1e4), this.liveSeed[i])) >>> 0;
      n++;
    }
    return `${n}:${h.toString(16)}`;
  }

  /**
   * Hash of the full live state: every live particle's spawn data (legacy dots, sprites, flipbooks,
   * distortion), rings, debris, decals, the light pool. Order-independent per layer (ring slots differ
   * between a play-through and a seek replay).
   */
  stateHash(): string {
    const t = this.clock.t;
    let h = 0x811c9dc5 >>> 0;
    const mix = (x: number) => {
      h ^= Math.round(x * 1e4) | 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(this.add.hashLive(t));
    mix(this.alpha.hashLive(t));
    mix(this.dist.hashLive(t));
    // layers are created on first use: an empty layer must not change the hash
    for (const k of [...this.sprites.keys()].sort()) {
      const v = this.sprites.get(k)!.hashLive(t);
      if (v) mix(hashStr(k)), mix(v);
    }
    let s = 0;
    for (const g of this.rings) if (g.on && t >= g.t0) s = (s + hashN(Math.round(g.t0 * 1e4), Math.round(g.size * 1e4), Math.round(g.mesh.position.x * 1e4), Math.round(g.mesh.position.z * 1e4))) >>> 0;
    mix(s);
    s = 0;
    for (let k = 0; k < this.dHigh; k++) {
      const o = k * 13;
      if (t - this.dData[o] >= 0 && t - this.dData[o] < DEBRIS_LIFE) s = (s + hashFloats(this.dData, o, 13)) >>> 0;
    }
    mix(s);
    mix(hashN(...this.decals.hash(this.decalTime ?? t).split(':').map((x) => parseInt(x, 16))));
    mix(this.lights.peak);
    return h.toString(16);
  }

  counts() {
    const t = this.clock.t;
    let debris = 0;
    for (let k = 0; k < this.dHigh; k++) {
      const a = t - this.dData[k * 13];
      if (this.dData[k * 13 + 10] > 0 && a >= 0 && a < DEBRIS_LIFE) debris++;
    }
    return {
      add: this.add.alive(t),
      alpha: this.alpha.alive(t),
      addCap: this.add.capacity,
      alphaCap: this.alpha.capacity,
      rings: this.rings.filter((g) => g.on && t >= g.t0).length,
      arrows: this.arrows.filter((a) => a.on).length,
      debris,
      dist: this.dist.alive(t),
      effects: this.liveEffects().length,
      light: +this.lights.peak.toFixed(3),
      lights: this.lights.lights.filter((L) => L.visible && L.intensity > 0).length,
      sprites: this.spriteCounts(t),
      decals: this.decals.count(this.decalTime ?? t),
      ribbons: this.ribbons.filter((r) => r.mesh.visible).length,
      ghosts: this.ghosts.live,
    };
  }

  /** live sprites per layer ('mask' and each flipbook atlas) */
  spriteCounts(t = this.clock.t): Record<string, number> {
    const o: Record<string, number> = {};
    for (const [k, L] of this.sprites) o[k] = L.alive(t);
    return o;
  }

  /** anything on the distortion layer at the current time (Post skips its pass otherwise) */
  get distActive(): boolean {
    return this.dist.active || this.ribbons.some((r) => r.distMesh.visible);
  }

  dispose() {
    this.offTier();
    this.add.dispose();
    this.alpha.dispose();
    this.dist.dispose();
    this.ringGeo.dispose();
    for (const g of this.rings) g.mat.dispose();
    this.arrowGeo.dispose();
    for (const a of this.arrows) a.mat.dispose();
    this.debrisMesh.geometry.dispose();
    (this.debrisMesh.material as THREE.Material).dispose();
    this.debrisMesh.dispose();
    for (const L of this.sprites.values()) L.dispose();
    this.decals.dispose();
    for (const r of this.ribbons) r.dispose();
    this.ghosts.dispose();
    this.group.removeFromParent();
  }
}
