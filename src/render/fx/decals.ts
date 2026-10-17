/**
 * Persistent floor decals (plan §2.1 "Decals", catalog C12 / C17 / E16): blood splatter, drops,
 * growing pools, cracks, scorch, scuffs. One instanced batch (one draw call), lit by the scene:
 * a MeshStandardMaterial patched to read the decal atlas (colour) and decals_nrm (tangent normal xy +
 * roughness), so wet blood is glossy and cracks catch the light; fog and shadows work as on the floor.
 *
 * Stateless like the particles: a decal is a pure function of its spawn data and `uTime` (sim time),
 * so a `?t=` seek that re-spawns the decal-producing events of [0, t] rebuilds the same floor. Spawn
 * data are seeded and positioned from recorded frame data (never from animated bones), so the
 * floor after a seek is identical to the floor after a play-through (`hash()`; fx:check tests it).
 *
 * The ring capacity is the quality tier's cap (TIER_CAPS.decals: 64 / 128 / 256); past it the oldest
 * decal is overwritten. Lives on the WORLD layer (drawn in the scene pass after the opaque floor,
 * depthWrite off, polygon offset), so post (AO excluded: it is transparent) treats it like the floor.
 */
import * as THREE from 'three';
import { DECAL_CELLS, type DecalCell } from './atlas';
import { hashFloats } from './sprites';

/** floats per decal: x z rot size | t0 grow cell alpha | nrm rough tintMode lift */
const STRIDE = 12;

export interface DecalSpawn {
  x: number;
  z: number;
  rot: number;
  size: number;
  /** spawn time (sim time); hidden before it */
  t0: number;
  /** seconds to grow from 25 % to full size (pools ~3 s, splats ~0.1 s) */
  grow: number;
  cell: DecalCell;
  alpha: number;
  /** normal-map strength (cracks 1, blood 0.5) */
  nrm: number;
  /** roughness (blood 0.2 wet, cracks 0.9) */
  rough: number;
  /** 1 = blood (darkens as it dries), 0 = as authored */
  blood: number;
  /** aspect (x stretch) */
  aspect?: number;
}

export class FloorDecals {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private limit: number;
  private data: Float32Array;
  private buf: THREE.InstancedInterleavedBuffer;
  private geo: THREE.InstancedBufferGeometry;
  readonly mat: THREE.MeshStandardMaterial;
  private U = {
    uDecTime: { value: 0 },
    uDecMap: { value: null as THREE.Texture | null },
    uDecNrm: { value: null as THREE.Texture | null },
  };
  private cursor = 0;
  private highWater = 0;
  private dirty = false;
  private hasTex = false;
  /** sequence number (lift order: newer decals draw above older ones) */
  private seq = 0;

  constructor(capacity = 256) {
    this.capacity = capacity;
    this.limit = capacity;
    this.data = new Float32Array(capacity * STRIDE);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    g.setIndex(plane.index);
    g.setAttribute('position', plane.getAttribute('position'));
    g.setAttribute('normal', plane.getAttribute('normal'));
    g.setAttribute('aD0', new THREE.InterleavedBufferAttribute(this.buf, 4, 0));
    g.setAttribute('aD1', new THREE.InterleavedBufferAttribute(this.buf, 4, 4));
    g.setAttribute('aD2', new THREE.InterleavedBufferAttribute(this.buf, 4, 8));
    g.instanceCount = 0;
    this.geo = g;
    const U = this.U;
    this.mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.5, metalness: 0, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this.mat.name = 'fx.decals';
    this.mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute vec4 aD0; attribute vec4 aD1; attribute vec4 aD2;
          uniform float uDecTime;
          varying vec2 vDecUv; varying float vDecA; varying float vDecRot; varying float vDecN; varying float vDecRough; varying float vDecDry;`,
        )
        .replace(
          '#include <begin_vertex>',
          `float dAge = uDecTime - aD1.x;
          float dGrow = aD1.y > 0.0 ? 1.0 - pow(1.0 - clamp(dAge / aD1.y, 0.0, 1.0), 3.0) : 1.0;
          float dSize = dAge < 0.0 ? 0.0 : aD0.w * (0.25 + 0.75 * dGrow);
          float dc = cos(aD0.z), ds = sin(aD0.z);
          vec2 dl = vec2(position.x * aD2.w, position.z) * dSize;
          vec3 transformed = vec3(aD0.x + dl.x * dc - dl.y * ds, 0.012 + mod(aD2.z, 64.0) * 0.00012, aD0.y + dl.x * ds + dl.y * dc);
          float dCell = aD1.z;
          vDecUv = (vec2(mod(dCell, 4.0), 3.0 - floor(dCell / 4.0)) + clamp(vec2(position.x + 0.5, 0.5 - position.z), 0.004, 0.996)) / 4.0;
          vDecA = aD1.w * clamp(dAge / 0.05, 0.0, 1.0);
          vDecRot = aD0.z;
          vDecN = aD2.x;
          vDecRough = aD2.y;
          vDecDry = aD2.z >= 64.0 ? clamp(dAge / 40.0, 0.0, 1.0) : -1.0;`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform sampler2D uDecMap; uniform sampler2D uDecNrm;
          varying vec2 vDecUv; varying float vDecA; varying float vDecRot; varying float vDecN; varying float vDecRough; varying float vDecDry;`,
        )
        .replace(
          '#include <map_fragment>',
          `vec4 dTex = texture2D(uDecMap, vDecUv);
          float dA = dTex.a * vDecA;
          if (dA < 0.004) discard;
          vec3 dCol = dTex.rgb / max(dTex.a, 0.03);
          if (vDecDry >= 0.0) dCol *= mix(1.0, 0.55, vDecDry);   // blood darkens as it dries
          diffuseColor = vec4(dCol, dA);`,
        )
        .replace('#include <roughnessmap_fragment>', `float roughnessFactor = vDecDry >= 0.0 ? mix(vDecRough, 0.55, vDecDry * 0.6) : vDecRough;`)
        .replace(
          '#include <normal_fragment_maps>',
          `{
            vec4 dN = texture2D(uDecNrm, vDecUv);
            vec2 nxy = (dN.rg * 2.0 - 1.0) * vDecN;
            float c = cos(vDecRot), s = sin(vDecRot);
            vec3 nW = normalize(vec3(nxy.x * c + nxy.y * s, 1.0, nxy.x * s - nxy.y * c));
            normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
          }`,
        );
    };
    this.mat.customProgramCacheKey = () => 'fx.decals';
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.name = 'fx.decals';
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = -1; // before other transparent world geometry
    this.mesh.visible = false;
  }

  setTextures(map: THREE.Texture | null, nrm: THREE.Texture | null) {
    this.U.uDecMap.value = map;
    this.U.uDecNrm.value = nrm ?? map;
    this.hasTex = !!map && !!nrm;
  }

  setLimit(n: number) {
    this.limit = Math.max(8, Math.min(this.capacity, Math.floor(n)));
    if (this.cursor >= this.limit) this.cursor = 0;
    if (this.highWater > this.limit) {
      // shrinking: drop what lies past the new ring (oldest-first order is not tracked; keep the first slots)
      this.data.fill(0, this.limit * STRIDE);
      this.highWater = this.limit;
      this.dirty = true;
    }
  }

  emit(s: DecalSpawn) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.limit;
    const o = i * STRIDE;
    const d = this.data;
    const cell = Math.max(0, DECAL_CELLS.indexOf(s.cell));
    const seq = this.seq++ % 64;
    d[o] = s.x; d[o + 1] = s.z; d[o + 2] = s.rot; d[o + 3] = s.size;
    d[o + 4] = s.t0; d[o + 5] = s.grow; d[o + 6] = cell; d[o + 7] = s.alpha;
    d[o + 8] = s.nrm; d[o + 9] = s.rough; d[o + 10] = seq + (s.blood ? 64 : 0); d[o + 11] = s.aspect ?? 1;
    if (i + 1 > this.highWater) this.highWater = i + 1;
    this.dirty = true;
  }

  flush() {
    if (this.dirty) {
      this.buf.clearUpdateRanges();
      this.buf.needsUpdate = true;
      this.dirty = false;
    }
    this.geo.instanceCount = this.highWater;
  }

  setTime(t: number) {
    this.U.uDecTime.value = t;
    this.mesh.visible = this.hasTex && this.highWater > 0;
  }

  clear() {
    this.data.fill(0);
    this.cursor = 0;
    this.highWater = 0;
    this.seq = 0;
    this.dirty = true;
    this.mesh.visible = false;
    this.geo.instanceCount = 0;
  }

  /** decals spawned at or before t */
  count(t: number): number {
    let n = 0;
    for (let i = 0; i < this.highWater; i++) if (this.data[i * STRIDE + 3] > 0 && this.data[i * STRIDE + 4] <= t) n++;
    return n;
  }

  /**
   * Order-independent hash of the decals visible at t (position, rotation, size, spawn time, cell,
   * alpha, normal, roughness): equal after a play-through and after a seek to t.
   */
  hash(t: number): string {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < this.highWater; i++) {
      const o = i * STRIDE;
      if (!(this.data[o + 3] > 0) || this.data[o + 4] > t) continue;
      // the lift-order field (o + 10) holds a ring sequence number: hash only its blood flag
      const h = (hashFloats(this.data, o, 10) ^ (this.data[o + 10] >= 64 ? 0x5bd1e995 : 0) ^ hashFloats(this.data, o + 11, 1)) >>> 0;
      sum = (sum + h) >>> 0;
      n++;
    }
    return `${n}:${sum.toString(16)}`;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}
