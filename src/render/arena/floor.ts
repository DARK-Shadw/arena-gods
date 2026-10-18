/**
 * WET FLOOR (arena art plan 5.7 / 6.1, milestone A2): the shared stone floor of the kit themes.
 *
 * One elliptical mesh at y = 0 with a MeshStandardMaterial patched in onBeforeCompile (so shadows, fog, the IBL
 * BRDF and every light keep working) that samples, in WORLD space:
 *   floor set  (tools/arena/blender/floor_set.py)   baseColor / normal / orm (R AO, G dry roughness, B water rank)
 *              tiled every `tileM` metres
 *   macro mask (built here, seeded, 128 x 128 over the floor bounds; never tiles)  R = puddle level, G = albedo
 *              variation. Puddle coverage at a point = puddles x (0.2 + 1.6 R) x wetness, and the tile's water rank
 *              decides WHERE inside that coverage the water sits (in the scan's hollows, joints and cracks first)
 *   inlay      (tools/arena/blender/inlay_moongate.py)  albedo multiplier / normal / orm (R AO, G roughness hint,
 *              B groove mask) over a `sizeM` square at the arena centre; grooves hold water
 *   light map  (lightmap.ts)  the warm pools of the flames without a real light, x a global flicker
 *   reflection (reflection.ts)  medium / high: the planar reflection, mip by roughness, normal distortion and a
 *              vertical streak (5 taps); it replaces the IBL radiance, so the standard BRDF applies Fresnel.
 *              low: the IBL probe (scene.environment, the sky with the moon) only, plus streak cards.
 * Wet look (plan 5.7): albedo darkened 35-40 % when damp, 25 % more in water; roughness to 0.035 in water and about
 * halved when damp; normals flattened in water.
 * `surfaceAt(x, z)` mirrors the shader's water test on the CPU (macro mask + a 128 x 128 read-back of the water rank)
 * for footstep / splash FX (A20).
 */
import * as THREE from 'three';
import type { ArenaLayout } from '../../sim/arenaGen';
import type { FloorSurface } from '../fx/fxSurfaces';
import type { FloorArt } from './art';
import type { KitAsset } from './assets';
import type { FloorLightMap } from './lightmap';
import { fbm2 } from './noise';
import type { ReflectUniforms } from './reflection';

/** the three textures of a texset carrier GLB (build_assets.mjs: baseColor -> map, normal, orm -> roughnessMap) */
export function texsetTextures(a: KitAsset): { alb: THREE.Texture; nrm: THREE.Texture; orm: THREE.Texture; extras: Record<string, unknown> } | null {
  let mat: THREE.MeshStandardMaterial | null = null;
  a.root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (!mat && m && m.map) mat = m;
  });
  const m = mat as THREE.MeshStandardMaterial | null;
  if (!m || !m.map || !m.normalMap || !m.roughnessMap) return null;
  for (const t of [m.map, m.normalMap, m.roughnessMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.needsUpdate = true;
  }
  return { alb: m.map, nrm: m.normalMap, orm: m.roughnessMap, extras: a.extras };
}

const VERT_PARS = /* glsl */ `
varying vec3 vFWorld;
varying vec4 vFRefl;
uniform mat4 uReflMatrix;
`;
const VERT_MAIN = /* glsl */ `
vec4 fWp = modelMatrix * vec4( transformed, 1.0 );
vFWorld = fWp.xyz;
vFRefl = uReflMatrix * fWp;
`;

const FRAG_PARS = /* glsl */ `
varying vec3 vFWorld;
varying vec4 vFRefl;
uniform sampler2D uFAlb;
uniform sampler2D uFNrm;
uniform sampler2D uFOrm;
uniform sampler2D uFMacro;
uniform sampler2D uFInAlb;
uniform sampler2D uFInNrm;
uniform sampler2D uFInOrm;
uniform sampler2D uFLm;
uniform sampler2D tRefl;
uniform float uFTile;
uniform float uFWet;
uniform float uFPuddle;
uniform float uFInOn;
uniform float uFInMetal;
uniform float uFLmGain;
uniform float uReflOn;
uniform float uReflLod;
uniform float uReflStretch;
uniform float uReflDistort;
uniform float uReflMinStreak;
uniform float uReflHot;
uniform vec2 uReflTexel;
uniform vec4 uFMacroXf;
uniform vec4 uFLmXf;
uniform vec3 uFInXf;
uniform vec3 uFTint;
`;

/** replaces <map_fragment>: albedo, water, inlay */
const FRAG_MAP = /* glsl */ `
vec2 fUv = vFWorld.xz / uFTile;
vec4 fOrm = texture2D( uFOrm, fUv );
vec2 fMac = texture2D( uFMacro, ( vFWorld.xz - uFMacroXf.xy ) * uFMacroXf.zw ).rg;
float fDamp = uFWet * ( 0.65 + 0.35 * fMac.r );
float fCover = clamp( uFPuddle * ( 0.2 + 1.6 * fMac.r ), 0.0, 0.95 ) * smoothstep( 0.15, 0.7, uFWet );
float fWater = smoothstep( 1.0 - fCover - 0.05, 1.0 - fCover + 0.04, fOrm.b );
vec3 fInMul = vec3( 1.0 );
vec4 fInOrm = vec4( 1.0, 0.5, 0.0, 1.0 );
vec3 fInN = vec3( 0.0, 0.0, 1.0 );
float fGroove = 0.0;
if ( uFInOn > 0.5 ) {
  vec2 iuv = ( vFWorld.xz - uFInXf.xy ) * uFInXf.z + 0.5;
  if ( iuv.x > 0.0 && iuv.y > 0.0 && iuv.x < 1.0 && iuv.y < 1.0 ) {
    fInMul = texture2D( uFInAlb, iuv ).rgb;
    fInOrm = texture2D( uFInOrm, iuv );
    fInN = texture2D( uFInNrm, iuv ).xyz * 2.0 - 1.0;
    fGroove = fInOrm.b;
  }
}
// engraved grooves collect water (metal inlays: B is the metal mask instead)
fWater = max( fWater, fGroove * ( 1.0 - uFInMetal ) * smoothstep( 0.2, 0.6, uFWet ) * 0.9 );
vec3 fAlb = texture2D( uFAlb, fUv ).rgb * uFTint * ( 0.86 + 0.28 * fMac.g ) * fInMul;
fAlb *= mix( 1.0, 0.62, fDamp );
fAlb *= mix( 1.0, 0.75, fWater );
diffuseColor.rgb *= fAlb;
`;

/** replaces <roughnessmap_fragment> */
const FRAG_ROUGH = /* glsl */ `
float roughnessFactor = fOrm.g;
roughnessFactor = mix( roughnessFactor, mix( fInOrm.g, 0.28, 0.4 ), fGroove * uFInMetal );
roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.34 + 0.05, fDamp );
roughnessFactor = mix( roughnessFactor, 0.035, fWater );
`;

/** replaces <metalnessmap_fragment> */
const FRAG_METAL = /* glsl */ `
float metalnessFactor = metalness + fGroove * uFInMetal;
`;

/** after <normal_fragment_maps>: world-space tangent frame of the y = 0 floor (u = +x, image up = -z) */
const FRAG_NORMAL = /* glsl */ `
vec3 fTn = texture2D( uFNrm, fUv ).xyz * 2.0 - 1.0;
fTn.xy *= 1.0 - 0.9 * fWater;
fTn.xy += fInN.xy * ( 1.0 - 0.6 * fWater );
fTn = normalize( fTn );
vec3 fWn = normalize( vec3( fTn.x, fTn.z, -fTn.y ) );
normal = normalize( ( viewMatrix * vec4( fWn, 0.0 ) ).xyz );
`;

/** after <lights_fragment_maps>: the planar reflection replaces the IBL radiance (same BRDF / Fresnel after) */
const FRAG_REFL = /* glsl */ `
#if defined( RE_IndirectSpecular ) && !defined( FLOOR_LOW )
if ( uReflOn > 0.5 ) {
  vec2 ruv = vFRefl.xy / vFRefl.w;
  ruv += ( normal.xy - normalize( vNormal ).xy ) * uReflDistort;
  float rr = material.roughness;
  // isotropic blur from the mip chain; a longer VERTICAL stretch (7 taps): wet-floor streaks under every light
  float blur = 0.2 * pow( rr, 1.6 );
  float lod = clamp( log2( max( 1.0, 0.35 * blur / uReflTexel.y ) ), 0.0, uReflLod );
  float sv = blur * uReflStretch / 3.0 + uReflMinStreak + uReflTexel.y;
  vec3 pr = textureLod( tRefl, ruv, lod ).rgb * 0.22;
  pr += ( textureLod( tRefl, ruv + vec2( 0.0, sv ), lod ).rgb + textureLod( tRefl, ruv - vec2( 0.0, sv ), lod ).rgb ) * 0.18;
  pr += ( textureLod( tRefl, ruv + vec2( 0.0, 2.0 * sv ), lod + 0.3 ).rgb + textureLod( tRefl, ruv - vec2( 0.0, 2.0 * sv ), lod + 0.3 ).rgb ) * 0.12;
  pr += ( textureLod( tRefl, ruv + vec2( 0.0, 3.0 * sv ), lod + 0.6 ).rgb + textureLod( tRefl, ruv - vec2( 0.0, 3.0 * sv ), lod + 0.6 ).rgb ) * 0.09;
  vec2 e = min( ruv, 1.0 - ruv );
  float edge = smoothstep( 0.0, 0.03, min( e.x, e.y ) );
  // hot sources (flames, the moon) get extra gain after the streak blur spread them out (art direction: the
  // concepts' streaks are about as bright as the fires); dim walls are unchanged
  float pl = dot( pr, vec3( 0.2126, 0.7152, 0.0722 ) );
  pr *= 1.0 + uReflHot * smoothstep( 0.35, 1.6, pl );
  radiance = mix( radiance, pr, edge );
}
#endif
`;

/** after <aomap_fragment>: baked AO + the floor light map (warm pools) */
const FRAG_AO = /* glsl */ `
float fAO = fOrm.r * fInOrm.r;
reflectedLight.indirectDiffuse *= fAO;
reflectedLight.indirectSpecular *= mix( 1.0, fAO, 0.6 );
vec3 fLm = texture2D( uFLm, ( vFWorld.xz - uFLmXf.xy ) * uFLmXf.zw ).rgb * uFLmGain;
reflectedLight.indirectDiffuse += fLm * diffuseColor.rgb * fAO;
`;

export interface WetFloorOpts {
  layout: ArenaLayout;
  /** extra floor beyond the ellipse (under the boundary dressing), m */
  pad: number;
  set: KitAsset;
  inlay?: KitAsset | null;
  art: FloorArt;
  seed: number;
  /** quality tier: 0 compiles the planar-reflection code out (FLOOR_LOW) */
  quality: number;
}

const MACRO = 128;

export class WetFloor {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  readonly tileM: number;
  readonly halfW: number;
  readonly halfD: number;
  readonly uniforms: Record<string, THREE.IUniform>;
  private macro: THREE.DataTexture;
  private macroR: Float32Array;
  private cpuWater: Uint8Array | null = null;
  private blank: THREE.DataTexture;
  readonly inlayStyle: 'engraved' | 'metal' | 'none';

  constructor(o: WetFloorOpts) {
    const L = o.layout;
    const set = texsetTextures(o.set);
    if (!set) throw new Error(`floor set ${o.set.id}: no texture set in the asset`);
    this.tileM = Number(set.extras.tileM) || 4;
    this.halfW = L.rx + o.pad + 0.5;
    this.halfD = L.rz + o.pad + 0.5;
    // ---- macro mask (seeded; R = puddle level, G = albedo variation)
    const px = new Uint8Array(MACRO * MACRO * 4);
    this.macroR = new Float32Array(MACRO * MACRO);
    const seed = (o.seed * 7919 + 17) | 0;
    let lo = 1e9,
      hi = -1e9;
    const raw = new Float32Array(MACRO * MACRO);
    for (let j = 0; j < MACRO; j++)
      for (let i = 0; i < MACRO; i++) {
        const x = ((i + 0.5) / MACRO) * 2 * this.halfW,
          z = ((j + 0.5) / MACRO) * 2 * this.halfD;
        const v = fbm2(x / 7.5, z / 7.5, 4, seed);
        raw[j * MACRO + i] = v;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    for (let k = 0; k < MACRO * MACRO; k++) {
      const i = k % MACRO,
        j = (k / MACRO) | 0;
      const r = Math.min(1, Math.max(0, ((raw[k] - lo) / Math.max(1e-6, hi - lo) - 0.5) * 1.4 + 0.5));
      this.macroR[k] = r;
      const g = fbm2((i / MACRO) * 2 * this.halfW / 3.1, (j / MACRO) * 2 * this.halfD / 3.1, 3, seed + 5);
      px[k * 4] = Math.round(r * 255);
      px[k * 4 + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255);
      px[k * 4 + 3] = 255;
    }
    this.macro = new THREE.DataTexture(px, MACRO, MACRO, THREE.RGBAFormat);
    this.macro.magFilter = this.macro.minFilter = THREE.LinearFilter;
    this.macro.needsUpdate = true;
    this.blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    this.blank.needsUpdate = true;
    // ---- inlay
    const inl = o.inlay ? texsetTextures(o.inlay) : null;
    if (inl) for (const t of [inl.alb, inl.nrm, inl.orm]) t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    this.inlayStyle = inl ? (inl.extras.style === 'metal' ? 'metal' : 'engraved') : 'none';
    const inSize = inl ? Number(inl.extras.sizeM) || 16 : 16;
    const tint = o.art.tint ?? [1, 1, 1];
    this.uniforms = {
      uFAlb: { value: set.alb },
      uFNrm: { value: set.nrm },
      uFOrm: { value: set.orm },
      uFMacro: { value: this.macro },
      uFInAlb: { value: inl?.alb ?? this.blank },
      uFInNrm: { value: inl?.nrm ?? this.blank },
      uFInOrm: { value: inl?.orm ?? this.blank },
      uFLm: { value: this.blank },
      uFTile: { value: this.tileM },
      uFWet: { value: o.art.wetness ?? 0.85 },
      uFPuddle: { value: o.art.puddles ?? 0.35 },
      uFInOn: { value: inl ? 1 : 0 },
      uFInMetal: { value: this.inlayStyle === 'metal' ? 1 : 0 },
      uFLmGain: { value: 0 },
      uFMacroXf: { value: new THREE.Vector4(-this.halfW, -this.halfD, 1 / (2 * this.halfW), 1 / (2 * this.halfD)) },
      uFLmXf: { value: new THREE.Vector4(0, 0, 1, 1) },
      uFInXf: { value: new THREE.Vector3(0, 0, 1 / inSize) },
      uFTint: { value: new THREE.Vector3(...tint) },
      // reflection (replaced by attachReflection)
      tRefl: { value: this.blank },
      uReflMatrix: { value: new THREE.Matrix4() },
      uReflOn: { value: 0 },
      uReflLod: { value: 0 },
      uReflTexel: { value: new THREE.Vector2(1, 1) },
      uReflStretch: { value: 4.0 },
      uReflDistort: { value: 0.035 },
      uReflMinStreak: { value: 0.008 },
      uReflHot: { value: 2.5 },
    };
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 1 });
    mat.name = 'arena.wetFloor';
    const U = this.uniforms;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${VERT_PARS}`).replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_MAIN}`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
        .replace('#include <map_fragment>', FRAG_MAP)
        .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
        .replace('#include <metalnessmap_fragment>', FRAG_METAL)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_NORMAL}`)
        .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n${FRAG_REFL}`)
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${FRAG_AO}`);
    };
    if (o.quality <= 0) mat.defines = { FLOOR_LOW: '' };
    mat.customProgramCacheKey = () => `arena.wetFloor.v1.${o.quality <= 0 ? 'low' : 'full'}`;
    this.material = mat;
    // ---- mesh: the ellipse + pad (like the legacy floorDisc), y = 0
    const g = new THREE.CircleGeometry(1, 160);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * (L.rx + o.pad), 0, p.getZ(i) * (L.rz + o.pad));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'arena.wetFloor';
    this.mesh.receiveShadow = true;
    this.mesh.userData.dyn = true;
    this.mesh.userData.floor = true;
  }

  attachReflection(u: ReflectUniforms) {
    Object.assign(this.uniforms, u);
  }
  attachLightMap(lm: FloorLightMap) {
    this.uniforms.uFLm.value = lm.rt.texture;
    (this.uniforms.uFLmXf.value as THREE.Vector4).copy(lm.xf);
  }
  setLightGain(g: number) {
    this.uniforms.uFLmGain.value = g;
  }

  /** read the tile's water rank back once (128 x 128) for surfaceAt; call after the textures exist on the GPU */
  readWater(r: THREE.WebGLRenderer) {
    if (this.cpuWater) return;
    const n = 128;
    const rt = new THREE.WebGLRenderTarget(n, n, { depthBuffer: false });
    const m = new THREE.ShaderMaterial({
      uniforms: { t: { value: this.uniforms.uFOrm.value } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D t; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(t, vUv).bbb, 1.0); }',
      depthTest: false,
      depthWrite: false,
    });
    const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m);
    const cam = new THREE.Camera();
    const prev = r.getRenderTarget();
    try {
      r.setRenderTarget(rt);
      r.render(q, cam);
      const buf = new Uint8Array(n * n * 4);
      r.readRenderTargetPixels(rt, 0, 0, n, n, buf);
      this.cpuWater = buf;
    } catch (e) {
      console.warn('[floor] water read-back failed; surfaceAt uses the macro mask only', e);
    } finally {
      r.setRenderTarget(prev);
      rt.dispose();
      m.dispose();
      q.geometry.dispose();
    }
  }

  /** standing water 0..1 at (x, z): the shader's test on the CPU */
  waterAt(x: number, z: number): number {
    const U = this.uniforms;
    const wet = U.uFWet.value as number;
    const mi = Math.min(MACRO - 1, Math.max(0, Math.floor(((x + this.halfW) / (2 * this.halfW)) * MACRO)));
    const mj = Math.min(MACRO - 1, Math.max(0, Math.floor(((z + this.halfD) / (2 * this.halfD)) * MACRO)));
    const mr = this.macroR[mj * MACRO + mi];
    const cover = Math.min(0.95, Math.max(0, (U.uFPuddle.value as number) * (0.2 + 1.6 * mr))) * smooth(0.15, 0.7, wet);
    let rank = 0.5;
    if (this.cpuWater) {
      const n = 128;
      const u = x / this.tileM,
        v = z / this.tileM;
      // texture v = 0 is the image top row; render-target row 0 is the bottom (uv.y = 0): row = v * n
      const i = ((Math.floor((u - Math.floor(u)) * n) % n) + n) % n;
      const j = ((Math.floor((v - Math.floor(v)) * n) % n) + n) % n;
      rank = this.cpuWater[(j * n + i) * 4] / 255;
    } else return cover > 0.5 ? 1 : 0;
    return smooth(1 - cover - 0.05, 1 - cover + 0.04, rank);
  }

  /** floor surface for FX (footsteps, splashes): water / wet / stone */
  surfaceAt(x: number, z: number): FloorSurface {
    const w = this.waterAt(x, z);
    if (w > 0.5) return 'water';
    return (this.uniforms.uFWet.value as number) > 0.3 ? 'wet' : 'stone';
  }

  dispose() {
    this.macro.dispose();
    this.blank.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
