/**
 * Paired-clip alignment probe: for clips recorded together (aggressor/victim),
 * report each clip's hips start position + facing in its own FBX frame, the
 * implied relative transform, and the closest approach between the
 * aggressor's hands/feet and the victim's torso over time (the contact frames).
 *
 *   npx tsx tools/anim/pairs.ts
 */
import * as fs from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

(globalThis as any).self ??= globalThis;
(globalThis as any).window ??= globalThis;
const A = 'C:/Programming/GameDev/Research/Assets/Animations/';
const PAIRS: [string, string][] = [
  ['Mixamo_HF/grabs_throws/Shoulder_Throw_Aggressor', 'Mixamo_HF/grabs_throws/Shoulder_Throw_Victim'],
  ['Mixamo_HF/finishers/Hell_Slammer_A', 'Mixamo_HF/finishers/Hell_Slammer_B'],
  ['Mixamo_HF/finishers/Rockin_Shackle_A', 'Mixamo_HF/finishers/Rockin_Shackle_B'],
  ['Mixamo_HF/finishers/Brutal_Assassination_2', 'Mixamo_HF/finishers/Brutal_Assassination'],
  ['Mixamo_HF/finishers/Stealth_Assassination_2', 'Mixamo_HF/finishers/Stealth_Assassination'],
  ['Mixamo_HF/grabs_throws/Double_Leg_Takedown_-_Attacker', 'Mixamo_HF2/paired/Double_Leg_Takedown_-_Victim'],
  ['Mixamo_HF/grabs_throws/Double_Leg_Takedown_-_Attacker_2', 'Mixamo_HF2/paired/Double_Leg_Takedown_-_Victim_2'],
  ['Mixamo_HF2/paired/Fist_Fight_A', 'Mixamo_HF2/paired/Fist_Fight_B'],
  ['Mixamo_HF2/paired/Strangling', 'Mixamo_HF2/paired/Being_Strangled'],
  ['Mixamo_HF2/paired/Taken_Hostage_-_Villain', 'Mixamo_HF2/paired/Taken_Hostage_-_Victim'],
  ['Mixamo_HF2/paired/Release_Hostage_-_Villain', 'Mixamo_HF2/paired/Release_Hostage_-_Hostage'],
  ['Mixamo_HF2/paired/Shaking_Hands_1', 'Mixamo_HF2/paired/Shaking_Hands_2'],
  ['Mixamo_HF2/paired/Spat_In_Face', 'Mixamo_HF2/paired/Spit_Reaction'],
  ['Mixamo_HF2/paired/Vampiric_Bite', 'Mixamo_HF2/paired/Getting_Bit'],
  ['Mixamo_HF/grabs_throws/Flying_Shoulder_Throw', 'Mixamo_HF/grabs_throws/Getting_Thrown'],
  ['Mixamo_HF/grabs_throws/Grab_And_Slam', 'Mixamo_HF/grabs_throws/Getting_Thrown'],
];
const J = ['Hips', 'Spine2', 'Head', 'LeftHand', 'RightHand', 'LeftFoot', 'RightFoot'];

function sample(rel: string) {
  const buf = fs.readFileSync(A + rel + '.fbx');
  const g = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  const clip = g.animations.find((a) => a.duration > 0.05) ?? g.animations[0];
  const bones: Record<string, THREE.Object3D> = {};
  g.traverse((o) => {
    const n = o.name.replace(/^mixamorig\d*:?/, '');
    if (J.includes(n) && o.name.startsWith('mixamorig')) bones[n] = o;
  });
  const mixer = new THREE.AnimationMixer(g);
  mixer.clipAction(clip).play();
  const fr: Record<string, THREE.Vector3>[] = [];
  const yaw: number[] = [];
  for (let t = 0; t <= clip.duration; t += 1 / 30) {
    mixer.setTime(Math.min(t, clip.duration - 1e-4));
    g.updateMatrixWorld(true);
    const o: Record<string, THREE.Vector3> = {};
    for (const j of J) o[j] = bones[j].getWorldPosition(new THREE.Vector3()).multiplyScalar(0.01);
    fr.push(o);
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(bones.Hips.getWorldQuaternion(new THREE.Quaternion()));
    yaw.push((Math.atan2(f.x, f.z) * 180) / Math.PI);
  }
  return { dur: clip.duration, fr, yaw };
}

const out: any[] = [];
for (const [a, v] of PAIRS) {
  const A1 = sample(a),
    V1 = sample(v);
  const h0a = A1.fr[0].Hips,
    h0v = V1.fr[0].Hips;
  // closest approach of aggressor effectors to victim torso segment (hips->head), same clock
  let best = { d: 9, t: 0, eff: '' };
  const contacts: { t: number; d: number; eff: string }[] = [];
  const n = Math.min(A1.fr.length, V1.fr.length);
  for (let i = 0; i < n; i++) {
    for (const e of ['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot']) {
      const p = A1.fr[i][e];
      const s0 = V1.fr[i].Hips,
        s1 = V1.fr[i].Head;
      const seg = new THREE.Line3(s0, s1);
      const c = seg.closestPointToPoint(p, true, new THREE.Vector3());
      const d = c.distanceTo(p);
      if (d < best.d) best = { d, t: i / 30, eff: e };
      if (d < 0.25 && (!contacts.length || i / 30 - contacts[contacts.length - 1].t > 0.25)) contacts.push({ t: +(i / 30).toFixed(2), d: +d.toFixed(2), eff: e });
    }
  }
  const row = {
    aggressor: a.split('/').pop(),
    victim: v.split('/').pop(),
    durA: +A1.dur.toFixed(2),
    durV: +V1.dur.toFixed(2),
    startA: [+h0a.x.toFixed(2), +h0a.z.toFixed(2), Math.round(A1.yaw[0])],
    startV: [+h0v.x.toFixed(2), +h0v.z.toFixed(2), Math.round(V1.yaw[0])],
    startDist: +Math.hypot(h0a.x - h0v.x, h0a.z - h0v.z).toFixed(2),
    closest: { d: +best.d.toFixed(2), t: +best.t.toFixed(2), eff: best.eff },
    contacts: contacts.slice(0, 8),
    sharedFrame: Math.hypot(h0a.x - h0v.x, h0a.z - h0v.z) > 0.3,
  };
  // ---- solve the missing relative transform for pairs exported in separate frames:
  // victim placed at (dx,dz,yaw) in the aggressor's frame; minimise body interpenetration
  // and maximise the best effector->victim contact, preferring a face-to-face start.
  let solved: any = undefined;
  if (!row.sharedFrame) {
    const torso = (fr: Record<string, THREE.Vector3>, m: THREE.Matrix4) => new THREE.Line3(fr.Hips.clone().applyMatrix4(m), fr.Head.clone().applyMatrix4(m));
    let bestS = { score: 1e9, dx: 0, dz: 0, yaw: 0, contactD: 9, contactT: 0, pen: 0 };
    const id = new THREE.Matrix4();
    for (let yawDeg = 0; yawDeg < 360; yawDeg += 15)
      for (let dz = 0.3; dz <= 2.4; dz += 0.1)
        for (let dx = -0.8; dx <= 0.8; dx += 0.1) {
          const m = new THREE.Matrix4().makeRotationY((yawDeg * Math.PI) / 180).setPosition(dx, 0, dz);
          let pen = 0,
            cd = 9,
            ct = 0;
          for (let i = 0; i < n; i += 2) {
            const ta = torso(A1.fr[i], id),
              tv = torso(V1.fr[i], m);
            // capsule-capsule overlap (radius 0.17 each) via sampled closest points
            let dmin = 9;
            for (let k = 0; k <= 4; k++) {
              const pa = ta.at(k / 4, new THREE.Vector3());
              dmin = Math.min(dmin, tv.closestPointToPoint(pa, true, new THREE.Vector3()).distanceTo(pa));
            }
            pen += Math.max(0, 0.34 - dmin);
            for (const e of ['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot']) {
              const pe = A1.fr[i][e];
              const d = tv.closestPointToPoint(pe, true, new THREE.Vector3()).distanceTo(pe) - 0.12;
              if (d < cd) {
                cd = d;
                ct = i / 30;
              }
            }
          }
          const facing = Math.abs(((yawDeg + V1.yaw[0] - A1.yaw[0] + 540) % 360) - 180); // 0 = facing each other
          const score = pen * 4 + Math.max(0, cd) * 3 + (facing / 180) * 0.4;
          if (score < bestS.score) bestS = { score, dx: +dx.toFixed(2), dz: +dz.toFixed(2), yaw: yawDeg, contactD: +cd.toFixed(2), contactT: +ct.toFixed(2), pen: +pen.toFixed(2) };
        }
    solved = bestS;
  }
  (row as any).solved = solved;
  out.push(row);
  console.log(JSON.stringify({ a: row.aggressor, v: row.victim, shared: row.sharedFrame, solved }));
}
fs.writeFileSync('docs/animation-pairs.json', JSON.stringify(out, null, 1));
