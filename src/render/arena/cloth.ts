/**
 * A4 BANNER CLOTH (arena art plan 5.2 / 6.5): the kit banners (kit/banners: cloth-sim drapes + an 8-sigil tattered atlas)
 * placed as plain meshes whose sway runs in the VERTEX SHADER: displacement grows with the hang depth below the pin line
 * (-y in the banner's own frame), two sine octaves, and a per-banner phase taken from the banner's world position
 * (modelMatrix), so there is no CPU loop, no per-banner uniform and no Math.random (the A2b / legacy `banner()` phase
 * used Math.random: A4 fix). The CPU cost per frame is one shared uniform write (`swayTime`), measured by Arena.swayStats.
 *
 * The atlas cell is chosen per banner by offsetting a cloned geometry's UVs (cells: 4 x 2 vertical banners of
 * cellUV = [0.25, 0.375], 2 swags of swagUV = [0.5, 0.25] below them, from the asset's KIT_ extras). Render only: nothing
 * here reads or writes sim state.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { KitAsset } from './assets';

/** fill aSway (axis x, axis z, hang, phase) of a banner geometry in its own frame: hang = -y x hangScale (metres) */
function setSway(g: THREE.BufferGeometry, axX: number, axZ: number, hangScale: number, phase: number) {
  const p = g.attributes.position as THREE.BufferAttribute;
  const a = new Float32Array(p.count * 4);
  for (let i = 0; i < p.count; i++) a.set([axX, axZ, Math.max(0, -p.getY(i)) * hangScale, phase], i * 4);
  g.setAttribute('aSway', new THREE.BufferAttribute(a, 4));
}

/** shared sway clock (seconds) and switch (0 = static: the low tier, plan 6.6 "banner sway / chain swing: off") */
export const swayTime = { value: 0 };
export const swayOn = { value: 1 };

// aSway = (sway axis x, sway axis z, hang depth in metres, phase): object space, so merged banners (one mesh in world space)
// and single banners (cached geometry under a moving group: the phase adds the model translation) share one shader
const SWAY_VERT = /* glsl */ `
  float hang = aSway.z;
  vec3 wpo = vec3(modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2]);
  float ph = aSway.w + dot(wpo, vec3(0.73, 0.21, 1.31)) + uSwayPhase;
  float s1 = sin(uSwayTime * 1.55 + ph + hang * 1.1);
  float s2 = sin(uSwayTime * 2.7 + ph * 1.7 + hang * 2.2 + aSway.w * 0.37);
  float kk = uSwayAmp * uSwayOn * hang * hang / (hang + 0.8);
  vec3 swAx = vec3(aSway.x, 0.0, aSway.y);
  vec3 swSd = vec3(-aSway.y, 0.0, aSway.x);
  transformed += swAx * ((0.65 * s1 + 0.35 * s2) * kk) + swSd * (sin(uSwayTime * 1.05 + ph * 0.6 + hang * 0.7) * kk * 0.2);
`;

/** a clone of `src` whose vertex shader sways it (amp: metres of sideways motion per metre of hang, roughly) */
export function swayMaterial(src: THREE.MeshStandardMaterial, amp = 0.05, phase = 0): THREE.MeshStandardMaterial {
  const m = src.clone();
  m.name = `${src.name}_sway`;
  const U = { uSwayTime: swayTime, uSwayOn: swayOn, uSwayAmp: { value: amp }, uSwayPhase: { value: phase } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uSwayTime; uniform float uSwayOn; uniform float uSwayAmp; uniform float uSwayPhase; attribute vec4 aSway;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + SWAY_VERT);
  };
  m.customProgramCacheKey = () => `sway|${src.uuid}`;
  m.userData.sway = U;
  return m;
}

/** a plain float, non-normalised copy (meshopt / quantised attributes cannot take applyMatrix4) */
export function floatGeo(src: THREE.BufferGeometry, keep?: string[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) {
    if (keep && !keep.includes(name)) continue;
    const at = attr as THREE.BufferAttribute;
    const n = at.count,
      k = at.itemSize;
    const arr = new Float32Array(n * k);
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) arr[i * k + c] = at.getComponent(i, c);
    g.setAttribute(name, new THREE.BufferAttribute(arr, k));
  }
  if (src.index) g.setIndex(new THREE.BufferAttribute(Uint32Array.from(src.index.array as ArrayLike<number>), 1));
  return g;
}

/** a node of a kit asset as float geometry in the asset frame (+ its material) */
export function nodeGeo(asset: KitAsset, prefix: string): { geo: THREE.BufferGeometry; mat: THREE.Material } | null {
  asset.root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(asset.root.matrixWorld).invert();
  let out: { geo: THREE.BufferGeometry; mat: THREE.Material } | null = null;
  asset.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (out || !m.isMesh || !(o.name.startsWith(prefix) || o.name.includes(`_${prefix}`)) || o.userData.col || o.userData.frac) return;
    const g = floatGeo(m.geometry, ['position', 'normal', 'uv']);
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    g.computeBoundingSphere();
    out = { geo: g, mat: m.material as THREE.Material };
  });
  return out;
}

export type BannerShape = 'vertical' | 'swag';

/**
 * Builds banner meshes from the kit/banners asset: per (shape, cell) one cached geometry with offset UVs, one shared sway
 * material per arena. dispose() frees what it created (the asset cache owns the textures).
 */
export class BannerKit {
  private geos = new Map<string, THREE.BufferGeometry>();
  private base = new Map<BannerShape, THREE.BufferGeometry>();
  private rodGeo: THREE.BufferGeometry | null = null;
  private rodMat: THREE.Material | null = null;
  readonly mat: THREE.MeshStandardMaterial | null = null;
  readonly cells: number;
  private cellUV: [number, number];
  private swagUV: [number, number];
  private src: THREE.MeshStandardMaterial | null = null;
  private amp = 0.05;

  constructor(
    readonly asset: KitAsset,
    amp = 0.05,
  ) {
    const x = asset.extras;
    this.cells = Number(x.cells) || 8;
    this.cellUV = (x.cellUV as [number, number]) ?? [0.25, 0.375];
    this.swagUV = (x.swagUV as [number, number]) ?? [0.5, 0.25];
    const v = nodeGeo(asset, 'BANNER_vertical');
    const s = nodeGeo(asset, 'BANNER_swag');
    const r = nodeGeo(asset, 'ROD');
    if (v) this.base.set('vertical', v.geo);
    if (s) this.base.set('swag', s.geo);
    if (r) {
      this.rodGeo = r.geo;
      this.rodMat = r.mat;
    }
    const src = (v ?? s)?.mat as THREE.MeshStandardMaterial | undefined;
    if (src) this.mat = swayMaterial(src, amp);
    this.src = src ?? null;
    this.amp = amp;
  }

  /** the geometry of a shape with its UVs moved to atlas cell `cell` */
  geo(shape: BannerShape, cell: number): THREE.BufferGeometry | null {
    const b = this.base.get(shape);
    if (!b) return null;
    const n = shape === 'vertical' ? this.cells : 2;
    const c = ((cell % n) + n) % n;
    const key = `${shape}|${c}`;
    let g = this.geos.get(key);
    if (!g) {
      g = b.clone();
      const du = shape === 'vertical' ? (c % 4) * this.cellUV[0] : c * this.swagUV[0];
      const dv = shape === 'vertical' ? Math.floor(c / 4) * this.cellUV[1] : 0;
      const uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + du, uv.getY(i) + dv);
      setSway(g, 0, 1, 1, 0);
      this.geos.set(key, g);
    }
    return g;
  }

  /** one banner (origin at the top centre of the pin line, hanging along -y, facing +z); w / h in metres */
  banner(shape: BannerShape, cell: number, w: number, h: number, rod = false): THREE.Object3D | null {
    const g = this.geo(shape, cell);
    if (!g || !this.mat) return null;
    const ext = this.asset.extras;
    const [W0, H0] = shape === 'vertical' ? ((ext.vertical as [number, number]) ?? [1, 2.8]) : [Number((ext.swag as number[])?.[0] ?? 2.2), Number((ext.swag as number[])?.[1] ?? 1)];
    const grp = new THREE.Group();
    const m = new THREE.Mesh(g, this.mat);
    m.scale.set(w / W0, h / H0, w / W0);
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.dyn = true;
    m.userData.banner = true;
    grp.add(m);
    if (rod && this.rodGeo && this.rodMat) {
      const r = new THREE.Mesh(this.rodGeo, this.rodMat);
      r.scale.set(w / W0, 1, 1);
      r.castShadow = true;
      r.userData.dyn = true;
      r.userData.sharedMat = true; // the asset cache's material (Arena.dispose skips it)
      grp.add(r);
    }
    grp.userData.dyn = true;
    return grp;
  }

  /**
   * A8b: a copy of the sway material that tears the swag row of the atlas (v > swag top) into long irregular shreds
   * (`depth` = the deepest tear as a share of the cloth height): the baked swag cells end in a regular zigzag that reads
   * as bunting. Only the swag row is touched; one extra material / draw for the arena that asks for it.
   */
  shredMaterial(depth: number): THREE.MeshStandardMaterial | null {
    if (!this.src) return null;
    // built from the source material (this.mat's onBeforeCompile may already carry the stage-light patch, which
    // the stage pass then adds to this material too)
    const m = swayMaterial(this.src, this.amp);
    const sway = m.onBeforeCompile;
    const v0 = 1 - this.swagUV[1];
    m.name = `${this.src.name}_shred`;
    m.onBeforeCompile = (sh, r) => {
      sway.call(m, sh, r);
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
#ifdef USE_MAP
if ( vMapUv.y > ${v0.toFixed(4)} ) {
  float lv = ( vMapUv.y - ${v0.toFixed(4)} ) / ${(1 - v0).toFixed(4)};
  float sx = vMapUv.x * 46.0;
  float k = floor( sx + 0.5 * sin( vMapUv.x * 97.0 ) );
  float h1 = fract( sin( k * 12.9898 ) * 43758.5453 );
  float h2 = fract( sin( k * 78.233 + 1.7 ) * 24634.6345 );
  float tear = ${depth.toFixed(3)} * ( 0.12 + 0.88 * h1 * h1 ) + 0.05 * sin( sx * 6.2831 ) * h2;
  if ( lv > 1.0 - tear - 0.03 ) discard;
  float hole = fract( sin( dot( floor( vMapUv * vec2( 70.0, 30.0 ) ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  if ( hole > 0.985 && lv > 0.3 ) discard;
}
#endif`,
      );
    };
    m.customProgramCacheKey = () => `sway|shred|${depth}|${this.src!.uuid}`;
    return m;
  }

  /**
   * many banners merged into ONE mesh (one draw call): each placement's geometry is transformed to the world, and its sway
   * axis (the banner's world +z), hang depth (metres, after scale) and phase (deterministic, from `phase`) go into aSway
   */
  merged(list: { shape: BannerShape; cell: number; w: number; h: number; m: THREE.Matrix4; phase: number }[], mat?: THREE.Material): THREE.Mesh | null {
    if (!this.mat || !list.length) return null;
    const geos: THREE.BufferGeometry[] = [];
    const ext = this.asset.extras;
    for (const b of list) {
      const src = this.geo(b.shape, b.cell);
      if (!src) continue;
      const [W0, H0] = b.shape === 'vertical' ? ((ext.vertical as [number, number]) ?? [1, 2.8]) : [Number((ext.swag as number[])?.[0] ?? 2.2), Number((ext.swag as number[])?.[1] ?? 1)];
      const g = src.clone();
      g.applyMatrix4(new THREE.Matrix4().makeScale(b.w / W0, b.h / H0, b.w / W0));
      const ax = new THREE.Vector3(0, 0, 1).transformDirection(b.m);
      const hz = Math.hypot(ax.x, ax.z) || 1;
      setSway(g, ax.x / hz, ax.z / hz, 1, b.phase);
      g.applyMatrix4(b.m);
      geos.push(g);
    }
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) return null;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, mat ?? this.mat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.dyn = true;
    mesh.userData.banner = true;
    mesh.name = 'kitBanners';
    return mesh;
  }

  /** the rod geometry (asset frame) and its material (owned by the asset cache) */
  rod(): { geo: THREE.BufferGeometry; mat: THREE.Material } | null {
    return this.rodGeo && this.rodMat ? { geo: this.rodGeo, mat: this.rodMat } : null;
  }

  dispose() {
    for (const g of this.geos.values()) g.dispose();
    for (const g of this.base.values()) g.dispose();
    this.rodGeo?.dispose();
    this.mat?.dispose();
  }
}
