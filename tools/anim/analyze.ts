/**
 * Clip analyser: loads every animation FBX we own (FBXLoader in Node), samples the
 * Mixamo skeleton at 30 Hz and extracts timing/shape metrics for the animation catalog.
 *
 *   npx tsx tools/anim/analyze.ts <outJson> [posesJson] [startIndex] [count]
 *
 * Metrics per clip (metres, seconds, Mixamo +Z = forward, +X = character's left):
 *  - duration, frames, rest hips height
 *  - root motion: hips XZ displacement, path length, vertical range, yaw change
 *  - loopability: start/end pose distance (hips-relative joints) + velocity mismatch
 *  - start/end posture: standing / crouch / kneel / ground (hips height ratio)
 *  - per effector (hands, feet, head): peak speed + time, max forward reach + time
 *  - strike candidate (fastest effector after the first 10%), handedness/footedness
 *  - foot contacts (planted intervals), airborne intervals
 *  - left/right asymmetry (mirroring doubles variety for asymmetric clips)
 * Optional: pose samples (16 frames x 15 joints) for filmstrip previews.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

(globalThis as any).self ??= globalThis;
(globalThis as any).window ??= globalThis;

const ROOT = 'C:/Programming/GameDev/Research/Assets/Animations';
const PACKS = ['ActionAdventure', 'Creature', 'ProLongbow', 'ProMagic', 'ProMeleeAxe', 'ProSwordandShield', 'Mixamo_HF', 'Mixamo_HF2'];
const JOINTS = ['Hips', 'Spine2', 'Neck', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot', 'LeftToeBase', 'RightToeBase'];
const EFF = ['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot', 'Head'];

function listFbx(dir: string, out: string[] = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFbx(p, out);
    else if (/\.fbx$/i.test(e.name)) out.push(p);
  }
  return out;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;

function analyse(file: string, wantPoses: boolean) {
  const buf = fs.readFileSync(file);
  const g = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  const clip = g.animations.find((a) => a.duration > 0.05) ?? g.animations[0];
  if (!clip) throw new Error('no animation');
  const bones: Record<string, THREE.Object3D> = {};
  g.traverse((o) => {
    const n = o.name.replace(/^mixamorig\d*:?/, '');
    if (JOINTS.includes(n) && o.name.startsWith('mixamorig')) bones[n] = o;
  });
  const missing = JOINTS.filter((j) => !bones[j]);
  g.updateMatrixWorld(true);
  // rest (bind) hips height from the skeleton before animating
  const restHips = bones.Hips ? bones.Hips.getWorldPosition(new THREE.Vector3()).y : 100;
  const unit = restHips > 10 ? 0.01 : 1; // cm -> m
  const mixer = new THREE.AnimationMixer(g);
  mixer.clipAction(clip).play();
  const dt = 1 / 30;
  const N = Math.max(2, Math.floor(clip.duration / dt) + 1);
  const P: Record<string, THREE.Vector3[]> = {};
  for (const j of JOINTS) P[j] = [];
  const yaw: number[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    mixer.setTime(Math.min(i * dt, clip.duration - 1e-4));
    g.updateMatrixWorld(true);
    for (const j of JOINTS) P[j].push(bones[j] ? bones[j].getWorldPosition(v).clone().multiplyScalar(unit) : new THREE.Vector3());
    if (bones.Hips) {
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(bones.Hips.getWorldQuaternion(new THREE.Quaternion()));
      yaw.push(Math.atan2(f.x, f.z));
    }
  }
  const H = P.Hips;
  const hips0 = restHips * unit;
  const ground = Math.min(...P.LeftToeBase.map((p) => p.y), ...P.RightToeBase.map((p) => p.y), ...P.LeftFoot.map((p) => p.y), ...P.RightFoot.map((p) => p.y));
  const floor = Math.min(0.05, ground); // most clips have the floor at y=0
  // root motion
  const disp = new THREE.Vector2(H[N - 1].x - H[0].x, H[N - 1].z - H[0].z);
  let pathLen = 0;
  for (let i = 1; i < N; i++) pathLen += Math.hypot(H[i].x - H[i - 1].x, H[i].z - H[i - 1].z);
  const hy = H.map((p) => p.y - floor);
  let dyaw = 0;
  for (let i = 1; i < yaw.length; i++) {
    let d = yaw[i] - yaw[i - 1];
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    dyaw += d;
  }
  // hips-relative pose for loop / transition matching (yaw-normalised)
  const rel = (i: number) => {
    const c = Math.cos(-yaw[i] || 0),
      s = Math.sin(-yaw[i] || 0);
    return JOINTS.map((j) => {
      const p = P[j][i];
      const x = p.x - H[i].x,
        z = p.z - H[i].z;
      return [x * c + z * s, p.y - floor, -x * s + z * c];
    });
  };
  const poseDist = (a: number[][], b: number[][]) => a.reduce((s, p, k) => s + Math.hypot(p[0] - b[k][0], p[1] - b[k][1], p[2] - b[k][2]), 0) / a.length;
  const loopDist = poseDist(rel(0), rel(N - 1));
  // posture classification
  const posture = (y: number) => (y > hips0 * 0.82 ? 'stand' : y > hips0 * 0.55 ? 'crouch' : y > hips0 * 0.3 ? 'kneel' : 'ground');
  // effectors
  const eff: Record<string, { peak: number; peakT: number; reach: number; reachT: number; lift: number }> = {};
  for (const e of EFF) {
    let peak = 0,
      peakT = 0,
      reach = -9,
      reachT = 0,
      lift = 0;
    for (let i = 1; i < N; i++) {
      // speed relative to the hips' horizontal motion (in-place equivalent)
      const a = P[e][i],
        b = P[e][i - 1];
      const sp = Math.hypot(a.x - H[i].x - (b.x - H[i - 1].x), a.y - b.y, a.z - H[i].z - (b.z - H[i - 1].z)) / dt;
      if (i > N * 0.08 && sp > peak) {
        peak = sp;
        peakT = i * dt;
      }
      // forward reach in the clip's initial facing frame
      const c = Math.cos(-(yaw[0] || 0)),
        s = Math.sin(-(yaw[0] || 0));
      const x = a.x - H[0].x,
        z = a.z - H[0].z;
      const fwd = -x * s + z * c;
      if (fwd > reach) {
        reach = fwd;
        reachT = i * dt;
      }
      lift = Math.max(lift, a.y - floor);
    }
    eff[e] = { peak: r2(peak), peakT: r3(peakT), reach: r2(reach), reachT: r3(reachT), lift: r2(lift) };
  }
  const strikeEff = (['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot'] as const).reduce((a, b) => (eff[b].peak > eff[a].peak ? b : a), 'RightHand' as string);
  // foot contacts (planted: low and slow)
  const contacts = (foot: string) => {
    const out: [number, number][] = [];
    let st = -1;
    for (let i = 1; i < N; i++) {
      const a = P[foot][i],
        b = P[foot][i - 1];
      const sp = Math.hypot(a.x - b.x, a.z - b.z) / dt;
      const low = a.y - floor < 0.16;
      const planted = low && sp < 0.35;
      if (planted && st < 0) st = i;
      if ((!planted || i === N - 1) && st >= 0) {
        if (i - st >= 3) out.push([r2(st * dt), r2(i * dt)]);
        st = -1;
      }
    }
    return out;
  };
  // airborne: both toes high
  let air = 0;
  for (let i = 0; i < N; i++) if (P.LeftToeBase[i].y - floor > 0.25 && P.RightToeBase[i].y - floor > 0.25 && P.LeftFoot[i].y - floor > 0.25) air++;
  // asymmetry: activity of left vs right limbs
  const act = (j: string) => {
    let s = 0;
    for (let i = 1; i < N; i++) s += P[j][i].distanceTo(P[j][i - 1]);
    return s;
  };
  const lh = act('LeftHand'),
    rh = act('RightHand'),
    lf = act('LeftFoot'),
    rf = act('RightFoot');
  const asym = r2((rh - lh) / Math.max(0.01, rh + lh));
  const fasym = r2((rf - lf) / Math.max(0.01, rf + lf));
  const out: any = {
    dur: r3(clip.duration),
    frames: N,
    restHips: r2(hips0),
    missingJoints: missing.length ? missing : undefined,
    root: { dx: r2(disp.x), dz: r2(disp.y), dist: r2(disp.length()), path: r2(pathLen), yMin: r2(Math.min(...hy)), yMax: r2(Math.max(...hy)), yaw: Math.round((dyaw * 180) / Math.PI) },
    inPlace: disp.length() < 0.15 && pathLen < 0.6,
    loop: { dist: r3(loopDist), loopable: loopDist < 0.06 },
    postureStart: posture(hy[0]),
    postureEnd: posture(hy[N - 1]),
    postureMin: posture(Math.min(...hy)),
    eff,
    strike: { eff: strikeEff, t: eff[strikeEff].peakT, speed: eff[strikeEff].peak },
    asymHands: asym,
    asymFeet: fasym,
    airborne: r2(air * dt),
    contactsL: contacts('LeftToeBase'),
    contactsR: contacts('RightToeBase'),
    startPose: rel(0).map((p) => p.map(r2)),
    endPose: rel(N - 1).map((p) => p.map(r2)),
  };
  let poses: number[][][] | undefined;
  if (wantPoses) {
    poses = [];
    for (let k = 0; k < 16; k++) {
      const i = Math.round((k / 15) * (N - 1));
      poses.push(JOINTS.map((j) => [r2(P[j][i].x - H[0].x), r2(P[j][i].y - floor), r2(P[j][i].z - H[0].z)]));
    }
  }
  mixer.uncacheRoot(g);
  return { out, poses };
}

const [outJson, posesJson, startS, countS] = process.argv.slice(2);
const files = PACKS.flatMap((p) => listFbx(path.join(ROOT, p))).sort();
const start = Number(startS ?? 0),
  count = Number(countS ?? files.length);
const res: Record<string, any> = fs.existsSync(outJson) ? JSON.parse(fs.readFileSync(outJson, 'utf8')) : {};
const poses: Record<string, any> = posesJson && fs.existsSync(posesJson) ? JSON.parse(fs.readFileSync(posesJson, 'utf8')) : {};
let ok = 0,
  fail = 0;
for (const f of files.slice(start, start + count)) {
  const key = path.relative(ROOT, f).replace(/\\/g, '/');
  try {
    const r = analyse(f, !!posesJson);
    res[key] = r.out;
    if (posesJson && r.poses) poses[key] = r.poses;
    ok++;
  } catch (e) {
    res[key] = { error: (e as Error).message };
    fail++;
  }
}
fs.writeFileSync(outJson, JSON.stringify(res));
if (posesJson) fs.writeFileSync(posesJson, JSON.stringify(poses));
console.log(`analysed ${ok}, failed ${fail}, total files ${files.length}, range ${start}..${start + count}`);
