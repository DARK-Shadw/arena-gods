/**
 * PAIRED-SCENE SOLVER (Node, FBXLoader): aligns the two roles of every paired
 * clip and measures where they actually touch.
 *
 *   npx tsx tools/anim/scenes.ts
 *
 * Shared-frame pairs (exported together) keep their recorded relative
 * transform. Pairs Mixamo re-centred are aligned by a CONTACT SPEC (which
 * attacker effector must reach which victim body part, and when) with a grid
 * search over (dx, dz, yaw) that also penalises the two torsos overlapping.
 * For every scene the per-frame effector -> body distances give the contact
 * windows; the kill / damage events of the finishers are placed on them, so
 * the sim's damage happens on frames where the bodies visibly touch.
 *
 * Output: src/sim/scenes.gen.ts (scene frame = attacker start position and
 * facing; root curves of both roles at 10 Hz, contact windows, alignment).
 */
import * as fs from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

(globalThis as any).self ??= globalThis;
(globalThis as any).window ??= globalThis;
const A = 'C:/Programming/GameDev/Research/Assets/Animations/';
const J = ['Hips', 'Spine2', 'Neck', 'Head', 'LeftHand', 'RightHand', 'LeftFoot', 'RightFoot'];
const FPS = 30;

interface Spec {
  id: string;
  att: string; // library id (role pair)
  vic: string;
  attSrc: string;
  vicSrc: string;
  shared: boolean;
  /** contact spec for the solve: attacker effector -> victim part within an attacker-time window, wanted distance */
  spec?: { eff: string; part: string; t: [number, number]; d: number }[];
  /** prefer the victim facing the attacker (true) or facing away (false) */
  faceToFace?: boolean;
}
const SCENES: Spec[] = [
  { id: 'shoulder_throw', att: 'Shoulder_Throw_Aggressor', vic: 'Shoulder_Throw_Victim', attSrc: 'Mixamo_HF/grabs_throws/Shoulder_Throw_Aggressor', vicSrc: 'Mixamo_HF/grabs_throws/Shoulder_Throw_Victim', shared: true },
  { id: 'hell_slammer', att: 'Hell_Slammer_A', vic: 'Hell_Slammer_B', attSrc: 'Mixamo_HF/finishers/Hell_Slammer_A', vicSrc: 'Mixamo_HF/finishers/Hell_Slammer_B', shared: true },
  { id: 'rockin_shackle', att: 'Rockin_Shackle_A', vic: 'Rockin_Shackle_B', attSrc: 'Mixamo_HF/finishers/Rockin_Shackle_A', vicSrc: 'Mixamo_HF/finishers/Rockin_Shackle_B', shared: true },
  {
    id: 'vampire_kiss',
    att: 'Vampiric_Bite',
    vic: 'Getting_Bit',
    attSrc: 'Mixamo_HF2/paired/Vampiric_Bite',
    vicSrc: 'Mixamo_HF2/paired/Getting_Bit',
    shared: false,
    faceToFace: true,
    spec: [
      { eff: 'Head', part: 'Neck', t: [1.0, 2.4], d: 0.12 },
      { eff: 'RightHand', part: 'Spine2', t: [0.8, 2.4], d: 0.16 },
      { eff: 'LeftHand', part: 'Spine2', t: [0.8, 2.4], d: 0.16 },
    ],
  },
  {
    id: 'silent_blade',
    att: 'Stealth_Assassination_2',
    vic: 'Stealth_Assassination',
    attSrc: 'Mixamo_HF/finishers/Stealth_Assassination_2',
    vicSrc: 'Mixamo_HF/finishers/Stealth_Assassination',
    shared: false,
    faceToFace: false,
    spec: [
      { eff: 'RightHand', part: 'Neck', t: [4.2, 5.6], d: 0.12 },
      { eff: 'LeftHand', part: 'Head', t: [4.2, 5.6], d: 0.14 },
    ],
  },
  {
    id: 'grab_and_slam',
    att: 'Grab_And_Slam',
    vic: 'Getting_Thrown',
    attSrc: 'Mixamo_HF/grabs_throws/Grab_And_Slam',
    vicSrc: 'Mixamo_HF/grabs_throws/Getting_Thrown',
    shared: false,
    faceToFace: true,
    spec: [
      { eff: 'LeftHand', part: 'Spine2', t: [0.5, 1.1], d: 0.14 },
      { eff: 'RightHand', part: 'Spine2', t: [0.8, 2.0], d: 0.14 },
    ],
  },
];

interface Samp {
  dur: number;
  n: number;
  fr: Record<string, THREE.Vector3>[];
  yaw0: number;
  hips0: THREE.Vector3;
}
function sample(rel: string): Samp {
  const buf = fs.readFileSync(A + rel + '.fbx');
  const g = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  const clip = g.animations.find((a) => a.duration > 0.05) ?? g.animations[0];
  const bones: Record<string, THREE.Object3D> = {};
  g.traverse((o) => {
    const nm = o.name.replace(/^mixamorig\d*:?/, '');
    if (J.includes(nm) && (o as THREE.Bone).isBone) bones[nm] = o;
  });
  g.updateMatrixWorld(true);
  const rest = bones.Hips.getWorldPosition(new THREE.Vector3()).y;
  const mixer = new THREE.AnimationMixer(g);
  mixer.clipAction(clip).play();
  const n = Math.round(clip.duration * FPS) + 1;
  const fr: Record<string, THREE.Vector3>[] = [];
  let yaw0 = 0;
  for (let i = 0; i < n; i++) {
    mixer.setTime(Math.min(i / FPS, clip.duration - 1e-4));
    g.updateMatrixWorld(true);
    const o: Record<string, THREE.Vector3> = {};
    for (const j of J) o[j] = bones[j].getWorldPosition(new THREE.Vector3()).divideScalar(rest); // hips units
    fr.push(o);
    if (i === 0) {
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(bones.Spine2.getWorldQuaternion(new THREE.Quaternion()));
      yaw0 = Math.atan2(f.x, f.z);
    }
  }
  return { dur: clip.duration, n, fr, yaw0, hips0: fr[0].Hips.clone() };
}

const rot = (x: number, z: number, a: number): [number, number] => [x * Math.cos(a) + z * Math.sin(a), -x * Math.sin(a) + z * Math.cos(a)];

function seg(fr: Record<string, THREE.Vector3>, m: THREE.Matrix4) {
  return new THREE.Line3(fr.Hips.clone().applyMatrix4(m), fr.Head.clone().applyMatrix4(m));
}

function solve(S: Spec, a: Samp, v: Samp) {
  const id = new THREE.Matrix4();
  let best = { score: 1e9, dx: 0, dz: 0, yaw: 0 };
  const n = Math.min(a.n, v.n);
  for (let yawDeg = 0; yawDeg < 360; yawDeg += 10)
    for (let dz = -1.6; dz <= 2.0; dz += 0.05)
      for (let dx = -1.4; dx <= 1.4; dx += 0.05) {
        const m = new THREE.Matrix4().makeRotationY((yawDeg * Math.PI) / 180).setPosition(dx, 0, dz);
        let score = 0;
        for (const c of S.spec!) {
          let md = 9;
          for (let i = Math.round(c.t[0] * FPS); i <= Math.min(n - 1, Math.round(c.t[1] * FPS)); i += 2) {
            const p = v.fr[i][c.part].clone().applyMatrix4(m);
            md = Math.min(md, p.distanceTo(a.fr[i][c.eff]));
          }
          score += Math.abs(md - c.d) * 3;
        }
        // torsos must not overlap (capsules, radius 0.15 hips units each)
        let pen = 0;
        for (let i = 0; i < n; i += 4) {
          const ta = seg(a.fr[i], id),
            tv = seg(v.fr[i], m);
          let dmin = 9;
          for (let k = 0; k <= 4; k++) {
            const pa = ta.at(k / 4, new THREE.Vector3());
            dmin = Math.min(dmin, tv.closestPointToPoint(pa, true, new THREE.Vector3()).distanceTo(pa));
          }
          pen += Math.max(0, 0.3 - dmin);
        }
        score += pen * 2;
        if (S.faceToFace !== undefined) {
          const fv = new THREE.Vector3(Math.sin(v.yaw0), 0, Math.cos(v.yaw0)).applyMatrix4(new THREE.Matrix4().makeRotationY((yawDeg * Math.PI) / 180));
          const fa = new THREE.Vector3(Math.sin(a.yaw0), 0, Math.cos(a.yaw0));
          const dot = fv.dot(fa);
          score += S.faceToFace ? Math.max(0, dot + 0.5) * 0.4 : Math.max(0, 0.5 - dot) * 0.4;
        }
        if (score < best.score) best = { score, dx: +dx.toFixed(3), dz: +dz.toFixed(3), yaw: yawDeg };
      }
  return best;
}

const out: Record<string, unknown> = {};
for (const S of SCENES) {
  const a = sample(S.attSrc),
    v = sample(S.vicSrc);
  let al = { dx: 0, dz: 0, yaw: 0, score: 0 };
  if (!S.shared) al = solve(S, a, v);
  const m = new THREE.Matrix4().makeRotationY((al.yaw * Math.PI) / 180).setPosition(al.dx, 0, al.dz);
  // victim samples in the attacker's clip frame
  const vf = v.fr.map((fr) => Object.fromEntries(Object.entries(fr).map(([k, p]) => [k, p.clone().applyMatrix4(m)])) as Record<string, THREE.Vector3>);
  // scene frame: origin = attacker hips at t0 (ground), +z = attacker facing at t0
  const o = a.hips0;
  const toScene = (p: THREE.Vector3): [number, number, number] => {
    const [x, z] = rot(p.x - o.x, p.z - o.z, -a.yaw0);
    return [+x.toFixed(3), +p.y.toFixed(3), +z.toFixed(3)];
  };
  // contact windows: per attacker effector the min distance to the victim body (hips-head segment / head / neck)
  const n = Math.min(a.n, v.n);
  const contacts: { t: number; eff: string; part: string; d: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (const e of ['RightHand', 'LeftHand', 'RightFoot', 'LeftFoot', 'Head']) {
      const pe = a.fr[i][e];
      const torso = new THREE.Line3(vf[i].Hips, vf[i].Neck);
      const dT = torso.closestPointToPoint(pe, true, new THREE.Vector3()).distanceTo(pe) - 0.12;
      const dH = vf[i].Head.distanceTo(pe) - 0.1;
      const d = Math.min(dT, dH);
      const part = dH < dT ? 'Head' : 'Torso';
      if (d < 0.08) {
        const last = contacts[contacts.length - 1];
        if (!last || i / FPS - last.t > 0.2 || last.eff !== e) contacts.push({ t: +(i / FPS).toFixed(3), eff: e, part, d: +d.toFixed(3) });
      }
    }
  }
  // closest approach overall (for scenes without clean contacts)
  let best = { t: 0, d: 9, eff: '' };
  for (let i = 0; i < n; i++)
    for (const e of ['RightHand', 'LeftHand', 'RightFoot', 'LeftFoot', 'Head']) {
      const pe = a.fr[i][e];
      const torso = new THREE.Line3(vf[i].Hips, vf[i].Neck);
      const d = Math.min(torso.closestPointToPoint(pe, true, new THREE.Vector3()).distanceTo(pe) - 0.12, vf[i].Head.distanceTo(pe) - 0.1);
      if (d < best.d) best = { t: +(i / FPS).toFixed(3), d: +d.toFixed(3), eff: e };
    }
  console.log('   closest', JSON.stringify(best));
  // root curves (hips xz, scene frame, 10 Hz) of both roles
  // root = the SAME zero-phase smoothed hips path the runtime library uses (build-lib rootCurve, w = 6 frames):
  // the renderer adds the residual (hips - root) on the hips, so the sim must move the root, not the hips
  const rootOf = (fr: Record<string, THREE.Vector3>[]) => {
    const n = fr.length,
      w = 6;
    const sm: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      let sx = 0,
        sz = 0,
        c = 0;
      for (let k = -w; k <= w; k++) {
        const j = Math.max(0, Math.min(n - 1, i + k));
        sx += fr[j].Hips.x;
        sz += fr[j].Hips.z;
        c++;
      }
      sm.push(new THREE.Vector3(sx / c, 0, sz / c));
    }
    const off = sm[0].clone().sub(new THREE.Vector3(fr[0].Hips.x, 0, fr[0].Hips.z));
    const r: number[] = [];
    for (let i = 0; i < n; i += 3) {
      const s = toScene(sm[i].clone().sub(off));
      r.push(s[0], s[2]);
    }
    return r;
  };
  out[S.id] = {
    att: S.att,
    vic: S.vic,
    dur: +Math.min(a.dur, v.dur).toFixed(3),
    align: { dx: al.dx, dz: al.dz, yaw: (al.yaw * Math.PI) / 180, score: +al.score.toFixed(3) },
    attYaw0: +a.yaw0.toFixed(4),
    attRoot: rootOf(a.fr),
    vicRoot: rootOf(vf),
    vicStart: toScene(vf[0].Hips),
    contacts,
  };
  console.log(S.id.padEnd(16), 'align', JSON.stringify(al), 'contacts', contacts.length, contacts.slice(0, 10).map((c) => `${c.t}${c.eff[0]}${c.eff.includes('Right') ? 'R' : c.eff.includes('Left') ? 'L' : ''}:${c.part[0]}`).join(' '), 'victim start', JSON.stringify(toScene(vf[0].Hips)));
}
fs.writeFileSync(
  'src/sim/scenes.gen.ts',
  `/* AUTO-GENERATED by tools/anim/scenes.ts - do not edit.
 * Paired scenes in the SCENE FRAME (origin = attacker start, +z = attacker facing; hips-height units):
 * alignment of the victim role, root curves of both roles at 10 Hz [x,z,...], and the frames where an
 * attacker effector touches the victim's body (d = clearance, <= 0.08 hips units). */
export interface SceneGen { att: string; vic: string; dur: number; align: { dx: number; dz: number; yaw: number; score: number }; attYaw0: number; attRoot: number[]; vicRoot: number[]; vicStart: [number, number, number]; contacts: { t: number; eff: string; part: string; d: number }[] }
export const SCENES: Record<string, SceneGen> = ${JSON.stringify(out)};
`,
);
console.log('wrote src/sim/scenes.gen.ts');
