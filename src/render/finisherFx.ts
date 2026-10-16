/**
 * FINISHER FX (render only, data-driven: a finisher names its effect, the
 * gore setting decides how it is shown).
 *
 *  bisect   two renders of the victim with opposite clipping planes; the plane is
 *           the attacker's blade path at the contact (blade direction x swing
 *           velocity), back faces drawn as a flat cap; the upper half slides off
 *  behead   the skinned mesh is split at the bone-weight boundary of the neck:
 *           the head triangles are baked out and fly free, the body keeps a
 *           capped stump (back faces drawn as the cap)
 *  burn     charring noise front with glowing edges, embers, then collapse
 *  shatter  freeze tint, then the posed mesh is baked and broken into chunks
 *  drain    desaturate / darken, wisps drawn out toward the attacker
 *  dissolve noise dissolve with a glowing edge (the clean version of the cuts)
 *  crush / impale  impact flash + dust (+ blood at full gore)
 *
 * GORE: 'off' (default) never renders blood or severing: cuts become a
 * dissolve-flash, blood becomes dust; 'stylised' severs with dark ink caps and
 * dark particles; 'full' uses red caps and blood.
 */
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { VFX } from './vfx';

export type GoreLevel = 'off' | 'stylised' | 'full';
export type FinFx = 'crush' | 'drain' | 'behead' | 'bisect' | 'burn' | 'shatter' | 'impale' | 'dissolve';

const KEY = 'arena.gore';
export function goreLevel(): GoreLevel {
  try {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('gore') : null;
    if (q === 'off' || q === 'stylised' || q === 'full') return q;
    const v = localStorage.getItem(KEY);
    if (v === 'off' || v === 'stylised' || v === 'full') return v;
  } catch {
    /* storage blocked */
  }
  return 'off';
}
export function setGoreLevel(g: GoreLevel) {
  try {
    localStorage.setItem(KEY, g);
  } catch {
    /* storage blocked */
  }
}

/** what is actually shown for an effect at a gore level */
export function resolveFx(fx: FinFx, gore: GoreLevel): FinFx {
  if (gore !== 'off') return fx;
  if (fx === 'behead' || fx === 'bisect' || fx === 'drain') return 'dissolve';
  return fx;
}

const capColor = (gore: GoreLevel) => new THREE.Color(gore === 'full' ? '#5a0606' : '#16070c');
const bloodColor = (gore: GoreLevel) => (gore === 'full' ? '#8a0a0a' : '#1a0d14');

// ------------------------------------------------------------------ shader hooks
interface FxUniforms {
  uCap: { value: THREE.Color };
  uCapOn: { value: number };
  uBurn: { value: number };
  uDissolve: { value: number };
  uEdge: { value: THREE.Color };
  uIce: { value: number };
  uDrain: { value: number };
}
/** patch a material once: back-face cap colour, burn / dissolve / ice / drain in the fragment shader */
const FXU = new WeakMap<THREE.Material, FxUniforms>();
function patchMaterial(m: THREE.MeshStandardMaterial): FxUniforms {
  const had = FXU.get(m);
  if (had) return had;
  const U: FxUniforms = {
    uCap: { value: new THREE.Color('#16070c') },
    uCapOn: { value: 0 },
    uBurn: { value: 0 },
    uDissolve: { value: 0 },
    uEdge: { value: new THREE.Color('#ff8a30') },
    uIce: { value: 0 },
    uDrain: { value: 0 },
  };
  FXU.set(m, U);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vFxPos;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvFxPos = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vFxPos;
uniform vec3 uCap; uniform float uCapOn; uniform float uBurn; uniform float uDissolve; uniform vec3 uEdge; uniform float uIce; uniform float uDrain;
float fxHash(vec3 p){ p = fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float fxNoise(vec3 x){ vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(fxHash(i+vec3(0,0,0)),fxHash(i+vec3(1,0,0)),f.x),mix(fxHash(i+vec3(0,1,0)),fxHash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(fxHash(i+vec3(0,0,1)),fxHash(i+vec3(1,0,1)),f.x),mix(fxHash(i+vec3(0,1,1)),fxHash(i+vec3(1,1,1)),f.x),f.y),f.z); }`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
{
  float n = fxNoise(vFxPos * 0.06) * 0.65 + fxNoise(vFxPos * 0.21) * 0.35;
  if (uDissolve > 0.0) {
    if (n < uDissolve) discard;
    float e = smoothstep(uDissolve + 0.07, uDissolve, n);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, uEdge * 3.0, e);
  }
  if (uBurn > 0.0) {
    float front = uBurn * 1.25 - n;
    float charK = smoothstep(-0.05, 0.12, front);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.03, 0.025, 0.02), charK);
    float edge = smoothstep(0.0, 0.05, front) * (1.0 - smoothstep(0.05, 0.16, front));
    gl_FragColor.rgb += uEdge * edge * 4.0;
    gl_FragColor.rgb += vec3(1.0, 0.35, 0.08) * charK * step(0.86, fxNoise(vFxPos * 0.9 + uBurn * 6.0)) * 1.5;
  }
  if (uIce > 0.0) {
    float l = dot(gl_FragColor.rgb, vec3(0.3, 0.59, 0.11));
    vec3 ice = vec3(0.55, 0.8, 1.0) * (0.45 + l) + vec3(0.25, 0.35, 0.45) * step(0.8, n);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, ice, uIce);
  }
  if (uDrain > 0.0) {
    float l = dot(gl_FragColor.rgb, vec3(0.3, 0.59, 0.11));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(l * 0.55, l * 0.5, l * 0.48), uDrain);
  }
  if (uCapOn > 0.5 && !gl_FrontFacing) gl_FragColor = vec4(uCap * (0.7 + 0.3 * n), 1.0);
}`,
      );
  };
  m.customProgramCacheKey = () => 'finfx';
  m.needsUpdate = true;
  return U;
}

function meshesOf(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const out: THREE.SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) out.push(o as THREE.SkinnedMesh);
  });
  return out;
}
function matsOf(m: THREE.Mesh): THREE.MeshStandardMaterial[] {
  return (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[];
}

/** bake a skinned mesh (current pose) into a static world-space geometry, optionally only some triangles */
function bake(m: THREE.SkinnedMesh, keepTri?: (a: number, b: number, c: number) => boolean): THREE.BufferGeometry {
  m.updateMatrixWorld(true);
  m.skeleton.update();
  const g = m.geometry;
  const pos = g.attributes.position;
  const idx = g.index;
  const v = new THREE.Vector3();
  const out: number[] = [];
  const uvOut: number[] = [];
  const uv = g.attributes.uv as THREE.BufferAttribute | undefined;
  const nTri = (idx ? idx.count : pos.count) / 3;
  for (let t = 0; t < nTri; t++) {
    const ia = idx ? idx.getX(t * 3) : t * 3,
      ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1,
      ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    if (keepTri && !keepTri(ia, ib, ic)) continue;
    for (const i of [ia, ib, ic]) {
      v.fromBufferAttribute(pos, i);
      m.applyBoneTransform(i, v);
      v.applyMatrix4(m.matrixWorld);
      out.push(v.x, v.y, v.z);
      if (uv) uvOut.push(uv.getX(i), uv.getY(i));
    }
  }
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  if (uv) bg.setAttribute('uv', new THREE.Float32BufferAttribute(uvOut, 2));
  bg.computeVertexNormals();
  return bg;
}

/** bones of a subtree (by name suffix of its root) */
function subtree(root: THREE.Object3D, name: RegExp): Set<THREE.Object3D> {
  const set = new Set<THREE.Object3D>();
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone && name.test(o.name)) o.traverse((c) => set.add(c));
  });
  return set;
}
function dominantBone(m: THREE.SkinnedMesh, i: number): number {
  const si = m.geometry.attributes.skinIndex,
    sw = m.geometry.attributes.skinWeight;
  let b = 0,
    w = -1;
  for (let k = 0; k < 4; k++) {
    const x = sw.getComponent(i, k);
    if (x > w) {
      w = x;
      b = si.getComponent(i, k);
    }
  }
  return b;
}

/** Split check used by the lab: how cleanly the neck cut separates (head piece size / stray triangles). */
export function headSplitStats(model: THREE.Object3D) {
  const head = subtree(model, /Neck$/);
  let headTris = 0,
    total = 0,
    mixed = 0;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const m of meshesOf(model)) {
    const bones = m.skeleton.bones;
    const inHead = (i: number) => head.has(bones[dominantBone(m, i)]);
    const idx = m.geometry.index;
    const n = (idx ? idx.count : m.geometry.attributes.position.count) / 3;
    m.updateMatrixWorld(true);
    m.skeleton.update();
    for (let t = 0; t < n; t++) {
      const a = idx ? idx.getX(t * 3) : t * 3,
        b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1,
        c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      const k = +inHead(a) + +inHead(b) + +inHead(c);
      total++;
      if (k === 3) {
        headTris++;
        v.fromBufferAttribute(m.geometry.attributes.position, a);
        m.applyBoneTransform(a, v);
        v.applyMatrix4(m.matrixWorld);
        box.expandByPoint(v);
      } else if (k > 0) mixed++;
    }
  }
  const size = box.getSize(new THREE.Vector3());
  return { headTris, total, mixed, size: size.toArray().map((x) => +x.toFixed(2)) };
}

// ------------------------------------------------------------------ effect runner
interface Piece {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
}
export class FinisherFx {
  private scene: THREE.Scene;
  private vfx: VFX;
  private pieces: Piece[] = [];
  private tasks: ((dt: number) => boolean)[] = [];
  private temp: THREE.Object3D[] = [];
  private restore: (() => void)[] = [];
  gore: GoreLevel;
  constructor(scene: THREE.Scene, vfx: VFX) {
    this.scene = scene;
    this.vfx = vfx;
    this.gore = goreLevel();
  }

  /**
   * victim / attacker: the FighterViews' model roots. cut: the blade plane (world) for bisect.
   * Returns the effect actually shown (after the gore filter).
   */
  play(fx: FinFx, victim: THREE.Object3D, opts: { attacker?: THREE.Object3D; plane?: THREE.Plane; at?: THREE.Vector3; dir?: THREE.Vector3 } = {}): FinFx {
    const shown = resolveFx(fx, this.gore);
    const at = opts.at ?? new THREE.Box3().setFromObject(victim).getCenter(new THREE.Vector3());
    const blood = bloodColor(this.gore);
    switch (shown) {
      case 'dissolve':
        this.vfx.flash(at, '#fff4e0', 1.0, 6);
        this.vfx.sparks(at, 40, '#ffe6c0', 7);
        this.dissolve(victim, 1.6, new THREE.Color('#ffd9a0'));
        break;
      case 'burn':
        this.burn(victim, 2.6);
        break;
      case 'shatter':
        this.shatter(victim, at);
        break;
      case 'drain':
        this.drain(victim, opts.attacker);
        if (this.gore === 'full') this.vfx.sparks(at, 30, blood, 3);
        break;
      case 'behead':
        this.behead(victim, opts.dir ?? new THREE.Vector3(0, 1, 0));
        break;
      case 'bisect':
        this.bisect(victim, opts.plane ?? new THREE.Plane(new THREE.Vector3(0, 1, 0), -at.y), opts.dir ?? new THREE.Vector3(1, 0, 0));
        break;
      case 'crush':
      case 'impale':
        this.vfx.flash(at, '#fff0d0', 2.5, 22);
        this.vfx.dust(at.clone().setY(0.1), 30, 2.2);
        if (this.gore !== 'off') this.vfx.sparks(at, 50, blood, 8);
        break;
    }
    return shown;
  }

  private uniforms(root: THREE.Object3D): FxUniforms[] {
    const out: FxUniforms[] = [];
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      for (const mat of matsOf(m)) if ((mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) out.push(patchMaterial(mat));
    });
    return out;
  }

  dissolve(root: THREE.Object3D, dur: number, edge: THREE.Color) {
    const U = this.uniforms(root);
    for (const u of U) u.uEdge.value.copy(edge);
    let t = 0;
    this.restore.push(() => U.forEach((u) => (u.uDissolve.value = 0)));
    this.tasks.push((dt) => {
      t += dt;
      const k = Math.min(1.05, t / dur);
      for (const u of U) u.uDissolve.value = k;
      if (Math.random() < 0.6) this.vfx.embers(new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3()), 2, '#ffd9a0', 0.8);
      return t < dur + 0.2;
    });
  }

  burn(root: THREE.Object3D, dur: number) {
    const U = this.uniforms(root);
    for (const u of U) u.uEdge.value.set('#ff7a20');
    let t = 0;
    this.restore.push(() => U.forEach((u) => ((u.uBurn.value = 0), (u.uDissolve.value = 0))));
    this.tasks.push((dt) => {
      t += dt;
      const k = Math.min(1, t / dur);
      for (const u of U) {
        u.uBurn.value = k;
        // the last third: the charred body falls apart into ash
        u.uDissolve.value = Math.max(0, (k - 0.65) / 0.35);
      }
      const c = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
      if (Math.random() < 0.9) this.vfx.fire(c.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.3) * 1.2, (Math.random() - 0.5) * 0.6)), new THREE.Vector3(0, 1.6, 0), 1, 0.35, 0.4);
      if (Math.random() < 0.7) this.vfx.embers(c, 3, '#ff9a40', 1.0);
      if (k > 0.6 && Math.random() < 0.5) this.vfx.smoke(c.clone().setY(0.3), 1, '#1a1410', 1.2, 0.8);
      return t < dur + 0.3;
    });
  }

  drain(root: THREE.Object3D, attacker?: THREE.Object3D) {
    const U = this.uniforms(root);
    let t = 0;
    this.restore.push(() => U.forEach((u) => (u.uDrain.value = 0)));
    this.tasks.push((dt) => {
      t += dt;
      for (const u of U) u.uDrain.value = Math.min(1, t / 1.4);
      const c = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
      if (attacker && Math.random() < 0.8) {
        const a = new THREE.Box3().setFromObject(attacker).getCenter(new THREE.Vector3());
        this.vfx.smoke(c, 1, this.gore === 'full' ? '#5a0a10' : '#2a1838', 0.4, 0.5);
        this.vfx.embers(c.clone().lerp(a, Math.random()), 1, this.gore === 'full' ? '#a01020' : '#b080ff', 0.4);
      }
      return t < 2.0;
    });
  }

  /** freeze tint, then break the posed body into chunks */
  shatter(root: THREE.Object3D, at: THREE.Vector3) {
    const U = this.uniforms(root);
    let t = 0;
    let broke = false;
    this.restore.push(() => U.forEach((u) => (u.uIce.value = 0)));
    this.tasks.push((dt) => {
      t += dt;
      for (const u of U) u.uIce.value = Math.min(1, t / 0.5);
      if (!broke && t > 0.7) {
        broke = true;
        const iceMat = new THREE.MeshStandardMaterial({ color: '#bfe6ff', roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.95 });
        for (const m of meshesOf(root)) {
          const g = bake(m);
          // chunk by a coarse spatial grid (25 cm cells)
          const cells = new Map<string, number[]>();
          const p = g.attributes.position;
          for (let tri = 0; tri < p.count / 3; tri++) {
            const cx = (p.getX(tri * 3) + p.getX(tri * 3 + 1) + p.getX(tri * 3 + 2)) / 3,
              cy = (p.getY(tri * 3) + p.getY(tri * 3 + 1) + p.getY(tri * 3 + 2)) / 3,
              cz = (p.getZ(tri * 3) + p.getZ(tri * 3 + 1) + p.getZ(tri * 3 + 2)) / 3;
            const key = `${Math.floor(cx / 0.25)},${Math.floor(cy / 0.25)},${Math.floor(cz / 0.25)}`;
            (cells.get(key) ?? cells.set(key, []).get(key)!).push(tri);
          }
          for (const tris of cells.values()) {
            const arr: number[] = [];
            for (const tri of tris) for (let k = 0; k < 3; k++) arr.push(p.getX(tri * 3 + k), p.getY(tri * 3 + k), p.getZ(tri * 3 + k));
            const cg = new THREE.BufferGeometry();
            cg.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
            cg.computeBoundingBox();
            const c = cg.boundingBox!.getCenter(new THREE.Vector3());
            cg.translate(-c.x, -c.y, -c.z);
            cg.computeVertexNormals();
            const mesh = new THREE.Mesh(cg, iceMat);
            mesh.position.copy(c);
            mesh.castShadow = true;
            this.add(mesh, c.clone().sub(at).setY(0).normalize().multiplyScalar(1.5 + Math.random() * 3).add(new THREE.Vector3(0, 1 + Math.random() * 2.5, 0)), 3.5);
          }
          g.dispose();
        }
        root.visible = false;
        this.restore.push(() => (root.visible = true));
        this.vfx.sparks(at, 80, '#dff4ff', 10);
        this.vfx.flash(at, '#cfefff', 2.5, 20);
      }
      return t < 1.0;
    });
  }

  /** neck cut at the bone-weight boundary: the head is baked and flies, the body keeps a capped stump */
  behead(root: THREE.Object3D, dir: THREE.Vector3) {
    const head = subtree(root, /Neck$/);
    if (!head.size) return;
    const cap = capColor(this.gore);
    let at = new THREE.Vector3();
    for (const m of meshesOf(root)) {
      const bones = m.skeleton.bones;
      const inHead = (i: number) => head.has(bones[dominantBone(m, i)]);
      const headGeo = bake(m, (a, b, c) => inHead(a) && inHead(b) && inHead(c));
      if (headGeo.attributes.position.count) {
        headGeo.computeBoundingBox();
        const c = headGeo.boundingBox!.getCenter(new THREE.Vector3());
        at = c.clone();
        headGeo.translate(-c.x, -c.y, -c.z);
        const mats = matsOf(m).map((x) => {
          const mm = x.clone();
          mm.side = THREE.DoubleSide;
          const u = patchMaterial(mm);
          u.uCap.value.copy(cap);
          u.uCapOn.value = 1;
          return mm;
        });
        const piece = new THREE.Mesh(headGeo, mats[0]);
        piece.position.copy(c);
        piece.castShadow = true;
        this.add(piece, dir.clone().setY(0).normalize().multiplyScalar(2.5).add(new THREE.Vector3(0, 3.2, 0)), 6);
      }
      // body: drop the head triangles from the index, show the stump's inside as the cap
      const idx = m.geometry.index;
      if (idx) {
        const keep: number[] = [];
        for (let t = 0; t < idx.count / 3; t++) {
          const a = idx.getX(t * 3),
            b = idx.getX(t * 3 + 1),
            c = idx.getX(t * 3 + 2);
          if (!(inHead(a) && inHead(b) && inHead(c))) keep.push(a, b, c);
        }
        const old = m.geometry;
        const ng = old.clone();
        ng.setIndex(keep);
        m.geometry = ng;
        this.restore.push(() => {
          m.geometry = old;
          ng.dispose();
        });
      }
      for (const mat of matsOf(m)) {
        const u = patchMaterial(mat);
        const side = mat.side;
        mat.side = THREE.DoubleSide;
        u.uCap.value.copy(cap);
        u.uCapOn.value = 1;
        this.restore.push(() => ((mat.side = side), (u.uCapOn.value = 0)));
      }
    }
    if (this.gore === 'full') {
      this.vfx.sparks(at, 70, bloodColor(this.gore), 6);
      let t = 0;
      this.tasks.push((dt) => {
        t += dt;
        if (Math.random() < 0.7) this.vfx.sparks(at.clone().setY(at.y - 0.25), 3, '#7a0808', 2);
        return t < 1.2;
      });
    } else this.vfx.sparks(at, 40, '#2a1420', 5);
  }

  /** two renders of the victim with opposite clipping planes; the upper half slides off along the cut */
  bisect(root: THREE.Object3D, plane: THREE.Plane, slideDir: THREE.Vector3) {
    const cap = capColor(this.gore);
    // half A: the victim itself keeps the lower side (legs stay); the upper half is the clone that slides off
    if (plane.normal.y < 0) plane = plane.clone().negate();
    const keepA = plane.clone().negate();
    const meshesA = meshesOf(root);
    for (const m of meshesA)
      for (const mat of matsOf(m)) {
        const u = patchMaterial(mat);
        const side = mat.side;
        mat.side = THREE.DoubleSide;
        mat.clippingPlanes = [keepA];
        u.uCap.value.copy(cap);
        u.uCapOn.value = 1;
        this.restore.push(() => ((mat.side = side), (mat.clippingPlanes = null), (u.uCapOn.value = 0)));
      }
    // half B: a clone posed like the victim (baked), the other side, sliding and toppling away
    const clone = SkeletonUtils.clone(root);
    const bakedGroup = new THREE.Group();
    const keepB = plane.clone();
    root.updateMatrixWorld(true);
    // the cut-off half keeps following the victim's (dying) pose
    const pairs: [THREE.Object3D, THREE.Object3D][] = [];
    clone.traverse((o) => {
      const src = root.getObjectByName(o.name);
      if (src && (o as THREE.Bone).isBone) pairs.push([o, src]);
    });
    const copyPose = () => {
      for (const [o, src] of pairs) {
        o.position.copy(src.position);
        o.quaternion.copy(src.quaternion);
      }
    };
    copyPose();
    clone.position.set(0, 0, 0);
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    root.parent?.updateWorldMatrix(true, false);
    holder.matrix.copy(root.parent ? root.parent.matrixWorld : new THREE.Matrix4());
    clone.position.copy(root.position);
    clone.quaternion.copy(root.quaternion);
    clone.scale.copy(root.scale);
    holder.add(clone);
    bakedGroup.add(holder);
    const matsB: THREE.MeshStandardMaterial[] = [];
    clone.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const wasArray = Array.isArray(m.material);
      const made = matsOf(m).map((x) => {
        const mm = x.clone();
        mm.side = THREE.DoubleSide;
        mm.clippingPlanes = [keepB];
        const u = patchMaterial(mm);
        u.uCap.value.copy(cap);
        u.uCapOn.value = 1;
        matsB.push(mm);
        return mm;
      });
      m.material = wasArray ? made : made[0];
    });
    this.scene.add(bakedGroup);
    this.temp.push(bakedGroup);
    // slide + topple around a pivot on the plane
    const pivot = plane.coplanarPoint(new THREE.Vector3());
    const axis = new THREE.Vector3().crossVectors(plane.normal, new THREE.Vector3(0, 1, 0));
    if (axis.lengthSq() < 1e-4) axis.copy(slideDir).cross(new THREE.Vector3(0, 1, 0));
    axis.normalize();
    const base = holder.matrix.clone();
    let t = 0;
    this.tasks.push((dt) => {
      t += dt;
      copyPose();
      const k = Math.min(1, t / 0.9);
      const slide = slideDir.clone().setY(0).normalize().multiplyScalar(0.35 * k * k);
      const drop = -Math.max(0, t - 0.5) * Math.max(0, t - 0.5) * 2.5;
      const rotM = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z).multiply(new THREE.Matrix4().makeRotationAxis(axis, k * 0.9)).multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
      const M = new THREE.Matrix4().makeTranslation(slide.x, Math.max(drop, -(pivot.y - 0.25)), slide.z).multiply(rotM);
      holder.matrix.copy(M).multiply(base);
      holder.matrixWorldNeedsUpdate = true;
      // the clipping plane travels with the half
      keepB.copy(plane).applyMatrix4(M);
      if (this.gore === 'full' && t < 1.2 && Math.random() < 0.6) this.vfx.sparks(pivot, 3, '#7a0808', 2);
      return t < 1.6;
    });
    if (this.gore !== 'off') this.vfx.sparks(pivot, 50, bloodColor(this.gore), 6);
    this.vfx.flash(pivot, '#fff0e0', 1.6, 12);
  }

  private add(obj: THREE.Object3D, vel: THREE.Vector3, life: number) {
    this.scene.add(obj);
    this.temp.push(obj);
    this.pieces.push({ obj, vel, spin: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8), life });
  }

  update(dt: number) {
    for (let i = this.tasks.length - 1; i >= 0; i--) if (!this.tasks[i](dt)) this.tasks.splice(i, 1);
    for (const p of this.pieces) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.vel.y -= 13 * dt;
      p.obj.position.addScaledVector(p.vel, dt);
      p.obj.rotation.x += p.spin.x * dt;
      p.obj.rotation.y += p.spin.y * dt;
      p.obj.rotation.z += p.spin.z * dt;
      if (p.obj.position.y < 0.08) {
        p.obj.position.y = 0.08;
        p.vel.multiplyScalar(0.35);
        p.vel.y = Math.abs(p.vel.y) * 0.3;
        p.spin.multiplyScalar(0.5);
      }
    }
  }

  /** remove everything and restore the victim's materials / geometry (new match) */
  clear() {
    for (const r of this.restore.reverse()) r();
    this.restore = [];
    for (const o of this.temp) this.scene.remove(o);
    this.temp = [];
    this.pieces = [];
    this.tasks = [];
    this.gore = goreLevel();
  }
}
