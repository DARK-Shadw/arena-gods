/**
 * Fighter blood (catalog C15 wounds, C16 weapon blood): one material patch per fighter material
 * (plan §2.1 "Material patch"). Must deform with the skinned mesh, so it is computed per fragment from
 * the skinned world position:
 *  - up to 8 wound spheres per fighter (tier cap 4 / 6 / 8), each anchored to a bone with an offset,
 *    dark red, wet (low roughness, no metal), with a noise edge in the mesh's own (bind) space so the
 *    blotch sticks to the skin instead of swimming;
 *  - weapon blood: a capsule along the blade (base -> tip) whose coverage grows towards the tip with
 *    each cutting hit.
 * The wounds are chosen from (match seed, event index), never from the animated pose, so a `?t=`
 * seek rebuilds exactly the same wounds from the hits before t.
 *
 * finisherFx.ts patches the same materials for its cuts and burns; it chains this patch (one program).
 */
import * as THREE from 'three';

export const MAX_WOUNDS = 8;

interface Wound {
  bone: THREE.Object3D | null;
  /** offset from the bone (metres, in the bone's world orientation) */
  off: THREE.Vector3;
  r: number;
  t0: number;
  amt: number;
}

const PATCH_VERT_PARS = /* glsl */ `
varying vec3 vFxW;
varying vec3 vFxO;`;
const PATCH_FRAG_PARS = /* glsl */ `
varying vec3 vFxW;
varying vec3 vFxO;
uniform vec4 uWound[${MAX_WOUNDS}];
uniform float uWoundAmt[${MAX_WOUNDS}];
uniform vec4 uBladeA;
uniform vec4 uBladeB;
uniform float uWoundNoise;
uniform vec3 uBloodCol;
float fxH3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float fxN3(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(fxH3(i), fxH3(i + vec3(1,0,0)), f.x), mix(fxH3(i + vec3(0,1,0)), fxH3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(fxH3(i + vec3(0,0,1)), fxH3(i + vec3(1,0,1)), f.x), mix(fxH3(i + vec3(0,1,1)), fxH3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fxBloodMask(out float shade) {
  vec3 o = vFxO * uWoundNoise;
  float n = fxN3(o), n2 = fxN3(o * 3.1 + 7.0);
  shade = 0.55 + 0.45 * n2;
  float m = 0.0;
  for (int i = 0; i < ${MAX_WOUNDS}; i++) {
    vec4 w = uWound[i];
    if (w.w <= 0.0) continue;
    float d = length(vFxW - w.xyz) / w.w;
    float e = d + (n - 0.5) * 0.75 + (n2 - 0.5) * 0.3;
    m = max(m, uWoundAmt[i] * (1.0 - smoothstep(0.5, 0.9, e)));
  }
  if (uBladeB.w > 0.0) {
    vec3 ab = uBladeB.xyz - uBladeA.xyz;
    float h = clamp(dot(vFxW - uBladeA.xyz, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    float d = length(vFxW - uBladeA.xyz - ab * h) / max(uBladeA.w, 1e-3);
    float reach = 0.85 - 0.6 * uBladeB.w;                  // more hits: blood further down the blade
    float along = smoothstep(reach, reach + 0.25, h);
    float spots = smoothstep(0.62 - 0.3 * uBladeB.w, 0.8, n2 + n * 0.3);
    m = max(m, along * spots * (1.0 - smoothstep(0.7, 1.0, d)) * min(1.0, uBladeB.w * 2.0));
  }
  return m;
}`;

/** Shared GLSL injection (also used by the FX Lab dummies). Keeps every include token intact for chained patches. */
export function injectBlood(sh: { vertexShader: string; fragmentShader: string }) {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\n' + PATCH_VERT_PARS)
    .replace('#include <skinning_vertex>', '#include <skinning_vertex>\nvFxW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvFxO = position;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\n' + PATCH_FRAG_PARS)
    .replace('#include <color_fragment>', '#include <color_fragment>\nfloat fxShade;\nfloat fxBlood = fxBloodMask(fxShade);\ndiffuseColor.rgb = mix(diffuseColor.rgb, uBloodCol * fxShade, fxBlood * 0.92);')
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.2, fxBlood);')
    .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.0, fxBlood);');
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _o = new THREE.Vector3();

export class FighterBlood {
  readonly U = {
    uWound: { value: Array.from({ length: MAX_WOUNDS }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uWoundAmt: { value: new Array(MAX_WOUNDS).fill(0) as number[] },
    uBladeA: { value: new THREE.Vector4(0, 0, 0, 0.07) },
    uBladeB: { value: new THREE.Vector4(0, 0, 0, 0) },
    uWoundNoise: { value: 0.09 },
    uBloodCol: { value: new THREE.Color('#3a0204') },
  };
  private wounds: Wound[] = [];
  private cursor = 0;
  /** active wound slots (tier) */
  limit = MAX_WOUNDS;
  /** blade blood 0..1 and the time it last changed */
  bladeAmt = 0;
  private bladeT0 = 0;
  private bladeFrom = 0;
  /** blade endpoints (world), set each frame by the game; null = no blade */
  bladeBase: THREE.Vector3 | null = null;
  bladeTip: THREE.Vector3 | null = null;

  constructor() {
    for (let i = 0; i < MAX_WOUNDS; i++) this.wounds.push({ bone: null, off: new THREE.Vector3(), r: 0, t0: 0, amt: 0 });
  }

  /**
   * Patch a fighter's materials (MeshStandardMaterial). `objScale` = world metres per model unit
   * (the Mixamo models are in centimetres x meta.scale), so the noise has the same size on every rig.
   */
  attach(materials: THREE.Material[], objScale: number) {
    this.U.uWoundNoise.value = objScale * 9;
    for (const m of materials) {
      const sm = m as THREE.MeshStandardMaterial;
      if (!sm.isMeshStandardMaterial || sm.userData.fxBlood) continue;
      const U = this.U;
      sm.userData.fxBlood = true;
      sm.userData.fxKey = 'fxblood';
      sm.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, U);
        injectBlood(sh);
      };
      sm.customProgramCacheKey = () => 'fxblood';
      sm.needsUpdate = true;
    }
  }

  /** add a wound (ring order: the oldest is replaced past the tier cap) */
  add(bone: THREE.Object3D | null, off: { x: number; y: number; z: number }, r: number, t0: number, amt: number) {
    const w = this.wounds[this.cursor];
    this.cursor = (this.cursor + 1) % this.limit;
    w.bone = bone;
    w.off.set(off.x, off.y, off.z);
    w.r = r;
    w.t0 = t0;
    w.amt = amt;
  }

  /** a cutting hit with this fighter's weapon: blood grows towards the hilt */
  addBlade(t0: number, amt: number) {
    this.bladeFrom = this.bladeNow(t0);
    this.bladeAmt = Math.min(1, this.bladeFrom + amt);
    this.bladeT0 = t0;
  }
  private bladeNow(t: number) {
    const k = Math.min(1, Math.max(0, (t - this.bladeT0) / 0.15));
    return this.bladeFrom + (this.bladeAmt - this.bladeFrom) * k;
  }

  setLimit(n: number) {
    this.limit = Math.max(1, Math.min(MAX_WOUNDS, n));
    if (this.cursor >= this.limit) this.cursor = 0;
    for (let i = this.limit; i < MAX_WOUNDS; i++) this.wounds[i].amt = 0;
  }

  /** evaluate at FX time t (wounds open over 0.25 s) and write the uniforms */
  update(t: number) {
    const U = this.U;
    for (let i = 0; i < MAX_WOUNDS; i++) {
      const w = this.wounds[i];
      const v = U.uWound.value[i];
      if (!w.bone || w.amt <= 0 || t < w.t0 || i >= this.limit) {
        v.w = 0;
        U.uWoundAmt.value[i] = 0;
        continue;
      }
      w.bone.getWorldPosition(_p);
      w.bone.getWorldQuaternion(_q);
      _o.copy(w.off).applyQuaternion(_q);
      v.set(_p.x + _o.x, _p.y + _o.y, _p.z + _o.z, w.r * (0.6 + 0.4 * Math.min(1, (t - w.t0) / 0.25)));
      U.uWoundAmt.value[i] = w.amt * Math.min(1, (t - w.t0) / 0.25);
    }
    const b = this.bladeNow(t);
    if (this.bladeBase && this.bladeTip && b > 0) {
      U.uBladeA.value.set(this.bladeBase.x, this.bladeBase.y, this.bladeBase.z, 0.08);
      U.uBladeB.value.set(this.bladeTip.x, this.bladeTip.y, this.bladeTip.z, b);
    } else U.uBladeB.value.w = 0;
  }

  /** live wounds (stats / tests) */
  get count() {
    return this.wounds.filter((w, i) => i < this.limit && w.amt > 0).length;
  }

  /** hash of the persistent blood state (bone names, offsets, radii, spawn times; blade amount) */
  hash(): number {
    let h = 0x811c9dc5 >>> 0;
    const mix = (x: number) => {
      h ^= Math.round(x * 1e4) | 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    // (not the open time: it is on the FX clock, which drifts from sim time during hit-stops)
    for (const w of this.wounds) if (w.amt > 0) mix(w.off.x), mix(w.off.y), mix(w.off.z), mix(w.r), mix(w.amt), mix((w.bone?.name.length ?? 0) * 31 + (w.bone?.name.charCodeAt(w.bone.name.length - 1) ?? 0));
    mix(this.bladeAmt);
    return h;
  }

  clear() {
    for (const w of this.wounds) (w.amt = 0), (w.bone = null);
    this.cursor = 0;
    this.bladeAmt = this.bladeFrom = 0;
    this.bladeT0 = 0;
    for (let i = 0; i < MAX_WOUNDS; i++) (this.U.uWound.value[i].w = 0), (this.U.uWoundAmt.value[i] = 0);
    this.U.uBladeB.value.w = 0;
  }
}
