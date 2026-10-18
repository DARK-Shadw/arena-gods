/**
 * A7b STAGE LIGHT: the Moon Gate night look's light model (kit colosseum only; ThemeArt.look.stage).
 *
 * Three.js' standard lights cannot give ref-3's look on their own: the moon is a BACKLIGHT (az -1.7, elev 27, behind
 * the arch), so every face the hero camera sees is in its shadow and the near field read as flat silhouettes; and the
 * thirty-odd arena flames have 3-6 real PointLights between them (plan 6.2 budget), so tier fires, wall braziers and
 * ring braziers lit nothing but the floor light map. This module adds, to every MeshStandardMaterial of the arena
 * (stone kit, statues, banners, chains, props; not the wet floor, which has its own light map, and not the fighters):
 *
 *   moon rim   a cold back-rim from the moon direction: (1 - N.V)^p, strongest when the camera looks toward the moon
 *              and on faces turned toward it, so pillar sides, stair nosings, statue hoods and tier lips catch a lavender
 *              edge as in ref-3 (the "glowing clouds light every stone edge" of the owner's review);
 *   fire pools a cheap diffuse-only light loop over the N flames nearest the camera (12 / 8 / 4 per tier): wrapped Lambert
 *              x windowed inverse-square falloff, colour = the flame colour x its flicker. Flames that own a real
 *              PointLight are skipped (they already light). World space throughout (the planar reflection's mirrored
 *              camera sees the same pools);
 *
 * plus, per frame, the scene FOG COLOUR from the sky in the view direction (bright moon haze looking toward the arch,
 * dark storm blue away from it) and soft GROUND-MIST cards (q1 / q2, FX_ALPHA with the F1 soft-depth fade) at the
 * foot of the tiers and the stair. Materials are shared with the ArenaAssets cache, so the patch is undone in
 * dispose() (no other theme ever compiles it). Legacy and the other themes never construct this (pixel-identical).
 */
import * as THREE from 'three';
import { LAYER } from '../fx/fxLayers';
import { SOFT_DEPTH_PARS, softDepthUniforms } from '../fx/softDepth';

export interface StageLightArt {
  /** scene.environmentIntensity (IBL for every standard material incl. fighters; three ignores material.envMapIntensity) */
  envIntensity: number;
  /** bake the backdrop layers into the IBL probe (the sky / clouds / arch then light and reflect on stone and fighters) */
  envBackdrop?: boolean;
  /** multiplier on main.ts's camera-relative key light (fighters stay readable in the darker look) */
  keyGain?: number;
  /** moon back-rim on the arena's standard materials */
  rim: { color: string; intensity: number; power: number; /** share kept when the camera looks away from the moon */ away: number };
  /** fire-pool light loop: flames per tier [q0, q1, q2], intensity per metre of flame size, reach (m) per metre of size */
  fires: { count: [number, number, number]; gain: number; reach: number; color: string };
  /** fog colour by view direction: `toward` looking at the moon (horizontal), `away` opposite; exponent of the blend */
  fogSky?: { toward: string; away: string; power: number };
  /** ground mist cards (q1 / q2 counts), ring radius beyond the boundary (m), size, opacity, colour */
  mist?: { count: [number, number]; offset: number; w: number; h: number; opacity: number; color: string };
}

export interface StageFlame {
  obj: THREE.Object3D;
  size: number;
  light?: THREE.PointLight;
  /** current flicker multiplier */
  k: number;
}

const MAXF = 12;

/** the shared uniforms of every patched material (one object: updated once per frame) */
const U = {
  /** 1 = on; 0 skips the whole block (uniform branch: the perf probe's same-page A/B) */
  uMgOn: { value: 1 },
  uMgMoon: { value: new THREE.Vector3(1, 0.5, 0) },
  uMgRim: { value: new THREE.Color(0, 0, 0) },
  uMgRimPow: { value: 3 },
  uMgRimAway: { value: 0.3 },
  uMgFireP: { value: Array.from({ length: MAXF }, () => new THREE.Vector4(0, -1000, 0, 1)) },
  uMgFireC: { value: Array.from({ length: MAXF }, () => new THREE.Vector3()) },
};

const FRAG_PARS = /* glsl */ `
uniform float uMgOn; uniform vec3 uMgMoon; uniform vec3 uMgRim; uniform float uMgRimPow; uniform float uMgRimAway;
uniform vec4 uMgFireP[${MAXF}]; uniform vec3 uMgFireC[${MAXF}];
`;

const fragLight = (n: number) => /* glsl */ `
#include <lights_fragment_end>
if (uMgOn > 0.5) {
  // A7b stage light (world space: also right in the mirrored reflection camera)
  mat3 mgVT = transpose(mat3(viewMatrix));
  vec3 mgW = mgVT * (-vViewPosition - viewMatrix[3].xyz);
  vec3 mgN = normalize(mgVT * normal);
  vec3 mgV = normalize(cameraPosition - mgW);
  float mgNdV = clamp(abs(dot(mgN, mgV)), 0.0, 1.0);
  float mgBack = mix(uMgRimAway, 1.0, smoothstep(-0.2, 0.85, dot(-mgV, uMgMoon)));
  float mgSide = clamp(dot(mgN, uMgMoon) * 0.6 + 0.55, 0.0, 1.0);
  float mgRim = pow(1.0 - mgNdV, uMgRimPow) * mgBack * mgSide;
  reflectedLight.directDiffuse += uMgRim * mgRim * (diffuseColor.rgb * 0.7 + 0.06);
#if ${n} > 0
  for (int i = 0; i < ${n}; i++) {
    vec4 P = uMgFireP[i];
    vec3 d = P.xyz - mgW;
    float d2 = dot(d, d);
    float r2 = P.w * P.w;
    if (d2 >= r2) continue;
    vec3 L = d * inversesqrt(max(d2, 1e-4));
    float win = 1.0 - d2 / r2;
    win *= win;
    float wrap = clamp(dot(mgN, L) * 0.7 + 0.3, 0.0, 1.0);
    reflectedLight.directDiffuse += uMgFireC[i] * diffuseColor.rgb * (wrap * win / (1.0 + d2 * 0.25));
  }
#endif
}`;

interface Patched {
  m: THREE.MeshStandardMaterial;
  hadOwn: boolean;
  prev: THREE.Material['onBeforeCompile'];
  prevKey: THREE.Material['customProgramCacheKey'];
}

/** noise texture for the mist cards (deterministic value noise, tileable in u) */
function mistTexture(): THREE.DataTexture {
  const W = 256,
    H = 64;
  const data = new Uint8Array(W * H * 4);
  const hash = (x: number, y: number) => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const noise = (x: number, y: number, per: number) => {
    const xi = Math.floor(x),
      yi = Math.floor(y);
    const fx = x - xi,
      fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx),
      sy = fy * fy * (3 - 2 * fy);
    const h = (a: number, b: number) => hash(((a % per) + per) % per, b);
    return (h(xi, yi) * (1 - sx) + h(xi + 1, yi) * sx) * (1 - sy) + (h(xi, yi + 1) * (1 - sx) + h(xi + 1, yi + 1) * sx) * sy;
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let v = 0,
        a = 0.55,
        f = 1;
      for (let o = 0; o < 4; o++) {
        v += a * noise((x / W) * 8 * f, (y / H) * 2 * f, 8 * f);
        f *= 2;
        a *= 0.5;
      }
      const vy = y / (H - 1); // 0 = top row
      const prof = Math.pow(Math.sin(Math.PI * Math.min(1, vy * 1.1)), 1.2) * Math.min(1, (1 - vy) * 4 + 0.15);
      const k = Math.max(0, Math.min(1, (v - 0.25) * 1.6)) * prof;
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(k * 255);
    }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const MIST_VERT = /* glsl */ `
varying vec2 vUv; varying float vViewZ; varying float vCamD;
void main(){
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewZ = -mv.z; vCamD = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const MIST_FRAG = /* glsl */ `
uniform sampler2D uMap; uniform vec3 uColor; uniform float uOpacity; uniform float uTime; uniform float uPhase;
varying vec2 vUv; varying float vViewZ; varying float vCamD;
${SOFT_DEPTH_PARS}
void main(){
  vec2 uv = vec2(vUv.x * 0.5 + uTime * 0.006 + uPhase, 1.0 - vUv.y);
  float a = texture2D(uMap, uv).a * 0.65 + texture2D(uMap, vec2(uv.x * 1.7 - uTime * 0.004 + 0.31, uv.y)).a * 0.35;
  vec2 e = smoothstep(vec2(0.0), vec2(0.18, 0.08), vUv) * smoothstep(vec2(0.0), vec2(0.18, 0.25), 1.0 - vUv);
  a *= e.x * e.y * uOpacity;
  a *= smoothstep(2.5, 7.0, vCamD);          // never a wall of fog in the camera's face
  a *= fxSoftFade(vViewZ, 1.5);
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
}`;

export class StageLight {
  private patched: Patched[] = [];
  private nFires: number;
  private fireCol: THREE.Color;
  private fogToward?: THREE.Color;
  private fogAway?: THREE.Color;
  readonly mist: THREE.Mesh[] = [];
  private mistTex?: THREE.DataTexture;
  private tmp = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private cand: { p: THREE.Vector3; d: number; f: StageFlame }[] = [];
  private pool: THREE.Vector3[] = [];

  constructor(
    readonly art: StageLightArt,
    readonly quality: number,
    moonDir: THREE.Vector3,
  ) {
    this.nFires = Math.min(MAXF, art.fires.count[Math.max(0, Math.min(2, quality))]);
    this.fireCol = new THREE.Color(art.fires.color);
    U.uMgMoon.value.copy(moonDir).normalize();
    U.uMgRim.value.set(art.rim.color).multiplyScalar(art.rim.intensity);
    U.uMgRimPow.value = art.rim.power;
    U.uMgRimAway.value = art.rim.away;
    if (art.fogSky) {
      this.fogToward = new THREE.Color(art.fogSky.toward);
      this.fogAway = new THREE.Color(art.fogSky.away);
    }
  }

  /** patch every standard material under `root` except the meshes in `skip` (the wet floor) */
  patch(root: THREE.Object3D, skip: Set<THREE.Object3D>) {
    const seen = new Set<THREE.Material>();
    const n = this.nFires;
    root.traverse((o) => {
      if (skip.has(o)) return;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const m = mat as THREE.MeshStandardMaterial;
        if (!m?.isMeshStandardMaterial || seen.has(m) || m.userData.floor) continue;
        seen.add(m);
        const hadOwn = Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile');
        const prev = m.onBeforeCompile;
        const hadKey = Object.prototype.hasOwnProperty.call(m, 'customProgramCacheKey');
        const prevKey = m.customProgramCacheKey;
        this.patched.push({ m, hadOwn, prev, prevKey: hadKey ? prevKey : (undefined as unknown as Patched['prevKey']) });
        m.onBeforeCompile = (sh, r) => {
          if (hadOwn) prev.call(m, sh, r);
          Object.assign(sh.uniforms, U);
          sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\n${FRAG_PARS}`).replace('#include <lights_fragment_end>', fragLight(n));
        };
        // without its own key three keys a program by onBeforeCompile.toString(): keep the previous patch's source in the key
        const base = hadKey ? '' : hadOwn ? prev.toString() : '';
        m.customProgramCacheKey = () => `${hadKey ? prevKey.call(m) : base}|mgstage${n}`;
        m.needsUpdate = true;
      }
    });
  }

  /** ground mist cards on a ring just outside the fight boundary (q1 / q2) */
  buildMist(group: THREE.Group, rx: number, rz: number, time: { value: number }) {
    const M = this.art.mist;
    if (!M || this.quality < 1) return;
    const n = M.count[this.quality >= 2 ? 1 : 0];
    if (!n) return;
    this.mistTex = mistTexture();
    const geo = new THREE.PlaneGeometry(M.w, M.h);
    geo.translate(0, M.h * 0.42, 0);
    for (let k = 0; k < n; k++) {
      const a = ((k + 0.5) / n) * Math.PI * 2;
      const mat = new THREE.ShaderMaterial({
        vertexShader: MIST_VERT,
        fragmentShader: MIST_FRAG,
        transparent: true,
        depthWrite: false,
        uniforms: { ...softDepthUniforms, uMap: { value: this.mistTex }, uColor: { value: new THREE.Color(M.color) }, uOpacity: { value: M.opacity }, uTime: time, uPhase: { value: k * 0.37 } },
      });
      const m = new THREE.Mesh(geo, mat);
      const r = 1 + (0.08 * ((k * 5) % 3)) / 2;
      m.position.set(Math.cos(a) * (rx + M.offset) * r, 0, Math.sin(a) * (rz + M.offset) * r);
      m.lookAt(0, 0, 0);
      m.layers.set(LAYER.FX_ALPHA);
      m.frustumCulled = false;
      m.renderOrder = 2;
      m.userData = { dyn: true, noReflect: true, mist: true };
      this.mist.push(m);
      group.add(m);
    }
  }

  /** per frame: fire-pool uniforms from the flames nearest the camera, mist cards face the camera, fog colour */
  update(cam: THREE.Camera | undefined, flames: StageFlame[], fog: THREE.Fog | null) {
    if (!cam) return;
    const cp = cam.position;
    cam.getWorldDirection(this.fwd);
    // candidates: visible flames without a real light; behind the camera counts double distance
    const C = this.cand;
    C.length = 0;
    for (const f of flames) {
      if (f.light || !visibleChain(f.obj)) continue;
      const p = (this.pool[C.length] ??= new THREE.Vector3());
      f.obj.getWorldPosition(p);
      this.tmp.subVectors(p, cp);
      const d = this.tmp.length() * (this.tmp.dot(this.fwd) < -2 ? 2 : 1);
      C.push({ p, d, f });
    }
    C.sort((a, b) => a.d - b.d);
    const n = this.nFires;
    const cut = C.length > n ? C[n].d : Infinity;
    const g = this.art.fires;
    for (let i = 0; i < MAXF; i++) {
      const P = U.uMgFireP.value[i],
        Cc = U.uMgFireC.value[i];
      const c = i < n ? C[i] : undefined;
      if (!c) {
        P.set(0, -1000, 0, 0.001);
        Cc.set(0, 0, 0);
        continue;
      }
      // fade out the farthest selected flames towards the cut so a flame entering / leaving the set does not pop
      const w = cut === Infinity ? 1 : THREE.MathUtils.clamp((cut - c.d) / Math.max(1, cut * 0.25), 0, 1);
      P.set(c.p.x, c.p.y + c.f.size * 0.35, c.p.z, Math.max(2, c.f.size * g.reach));
      const k = g.gain * c.f.size * c.f.k * w;
      Cc.set(this.fireCol.r * k, this.fireCol.g * k, this.fireCol.b * k);
    }
    // mist cards turn about Y only and fade out when seen from above (a vertical card seen steeply reads as a blob)
    for (const m of this.mist) {
      this.tmp.subVectors(cp, m.position);
      const len = this.tmp.length() || 1;
      m.rotation.set(0, Math.atan2(this.tmp.x, this.tmp.z), 0);
      const steep = Math.abs(this.tmp.y) / len;
      const mu = (m.material as THREE.ShaderMaterial).uniforms.uOpacity;
      mu.value = this.art.mist!.opacity * (1 - THREE.MathUtils.smoothstep(steep, 0.3, 0.6));
      m.visible = mu.value > 0.002;
    }
    if (fog && this.fogToward && this.fogAway) {
      const mh = Math.hypot(U.uMgMoon.value.x, U.uMgMoon.value.z) || 1;
      const fh = Math.hypot(this.fwd.x, this.fwd.z) || 1;
      const dot = (this.fwd.x * U.uMgMoon.value.x + this.fwd.z * U.uMgMoon.value.z) / (mh * fh);
      const t = Math.pow(Math.max(0, dot * 0.5 + 0.5), this.art.fogSky!.power);
      fog.color.copy(this.fogAway).lerp(this.fogToward, t);
    }
  }

  /** perf probe: switch the rim / fire-pool shader block (all patched materials) */
  set shaderOn(v: boolean) {
    U.uMgOn.value = v ? 1 : 0;
  }

  dispose() {
    U.uMgOn.value = 1;
    for (const P of this.patched) {
      if (P.hadOwn) P.m.onBeforeCompile = P.prev;
      else delete (P.m as { onBeforeCompile?: unknown }).onBeforeCompile;
      if (P.prevKey) P.m.customProgramCacheKey = P.prevKey;
      else delete (P.m as { customProgramCacheKey?: unknown }).customProgramCacheKey;
      P.m.needsUpdate = true;
    }
    this.patched = [];
    for (const m of this.mist) (m.material as THREE.Material).dispose();
    this.mist[0]?.geometry.dispose();
    this.mistTex?.dispose();
  }
}

function visibleChain(o: THREE.Object3D | null): boolean {
  for (let x = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}
