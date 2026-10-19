/**
 * SHARED ANIMATION LIBRARY BUILDER (Node, FBXLoader).
 *
 *   npx tsx tools/anim/build-lib.ts            # all libraries
 *   npx tsx tools/anim/build-lib.ts --report   # also print per-clip measurements
 *
 * For every entry of src/data/animLibrary.ts:
 *  1. load the source FBX (Mixamo skeleton, 30 fps), sample local bone
 *     rotations + hips position per frame (30 Hz)
 *  2. normalise: rotate so the clip starts facing +Z at the origin (unless raw);
 *     split the hips XZ path into a smoothed ROOT curve (travel, for sim/root
 *     motion) and the residual sway kept on the hips (in-place playback)
 *  3. measure (all in hips-height units): posture start/end, ground contact,
 *     facing when lying (prone/supine/side), hit direction/severity/height from
 *     the head excursion, impact frame, apex/lift for launches, travel/yaw
 *  4. auto-trim by role (get-ups start where the body leaves the ground, falls
 *     end when the body settles ...), unless an explicit trim is given
 *  5. optional MIRROR: model-space reflection of each bone's rotation relative
 *     to its rest orientation + left/right swap; VERIFIED by forward kinematics
 *     (mirrored joints must equal the reflected original joints within 1 cm)
 *  6. quantise (int16; constant tracks stored once) into public/anim/<lib>.bin,
 *     write public/anim/index.json and the sim timing table src/sim/anim.gen.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { ANIM_LIBRARY, type LibClipSpec } from '../../src/data/animLibrary';
import { encodeLib } from '../../src/render/animCodec';

(globalThis as any).self ??= globalThis;
(globalThis as any).window ??= globalThis;

const SRC = 'C:/Programming/GameDev/Research/Assets/Animations/';
const OUT = path.resolve('public/anim');
const FPS = 30;
const REPORT = process.argv.includes('--report');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

const strip = (n: string) => n.replace(/^mixamorig\d*:?/, '');
const mirrorName = (n: string) => (n.startsWith('Left') ? 'Right' + n.slice(4) : n.startsWith('Right') ? 'Left' + n.slice(5) : n);

interface Sampled {
  names: string[]; // animated bones (stripped)
  n: number;
  q: Float32Array[]; // per bone: n*4 local quats
  hips: Float32Array; // n*3 (hips-height units, anim frame)
  joints: Record<string, Float32Array>; // n*3 world positions (hips units)
  chestFwd: Float32Array; // n*3 Spine2 forward axis (world)
  restHips: number;
}

const KEYJ = ['Hips', 'Spine2', 'Head', 'LeftHand', 'RightHand', 'LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'];

function loadFBX(rel: string): { g: THREE.Group; clip: THREE.AnimationClip } {
  const buf = fs.readFileSync(SRC + rel);
  const g = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  const clip = g.animations.find((a) => a.duration > 0.05) ?? g.animations[0];
  // remember the bind pose (the mixer leaves bones at the last sampled frame)
  const rest = new Map<string, THREE.Quaternion>();
  g.traverse((o) => {
    if ((o as THREE.Bone).isBone) rest.set(strip(o.name), o.quaternion.clone());
  });
  g.userData.rest = rest;
  return { g, clip };
}

function boneMap(g: THREE.Object3D) {
  const m: Record<string, THREE.Bone> = {};
  g.traverse((o) => {
    if ((o as THREE.Bone).isBone) m[strip(o.name)] = o as THREE.Bone;
  });
  return m;
}

/** Sample a clip at 30 Hz: local quats of animated bones, hips, key joint world positions. */
function sample(g: THREE.Group, clip: THREE.AnimationClip): Sampled {
  const bones = boneMap(g);
  g.updateMatrixWorld(true);
  const restHips = bones.Hips.getWorldPosition(new THREE.Vector3()).y;
  const names = [...new Set(clip.tracks.filter((t) => t.name.endsWith('.quaternion')).map((t) => strip(t.name.split('.')[0])))].filter((n) => bones[n]);
  const mixer = new THREE.AnimationMixer(g);
  mixer.clipAction(clip).play();
  const n = Math.max(2, Math.round(clip.duration * FPS) + 1);
  const q = names.map(() => new Float32Array(n * 4));
  const hips = new Float32Array(n * 3);
  const joints: Record<string, Float32Array> = {};
  for (const j of KEYJ) joints[j] = new Float32Array(n * 3);
  const chestFwd = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  const wq = new THREE.Quaternion();
  for (let i = 0; i < n; i++) {
    mixer.setTime(Math.min(i / FPS, clip.duration - 1e-4));
    g.updateMatrixWorld(true);
    names.forEach((nm, k) => {
      const b = bones[nm].quaternion;
      q[k].set([b.x, b.y, b.z, b.w], i * 4);
    });
    bones.Hips.getWorldPosition(v);
    hips.set([v.x / restHips, v.y / restHips, v.z / restHips], i * 3);
    for (const j of KEYJ) {
      if (!bones[j]) continue;
      bones[j].getWorldPosition(v);
      joints[j].set([v.x / restHips, v.y / restHips, v.z / restHips], i * 3);
    }
    bones.Spine2.getWorldQuaternion(wq);
    v.set(0, 0, 1).applyQuaternion(wq);
    chestFwd.set([v.x, v.y, v.z], i * 3);
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(g);
  return { names, n, q, hips, joints, chestFwd, restHips };
}

/** world quaternion of each animated bone per frame, from local quats (FK over the FBX hierarchy) */
function worldQuats(g: THREE.Group, S: Sampled): Map<string, Float32Array> {
  const bones = boneMap(g);
  const out = new Map<string, Float32Array>();
  for (const nm of S.names) out.set(nm, new Float32Array(S.n * 4));
  const tmp = new THREE.Quaternion();
  for (let i = 0; i < S.n; i++) {
    S.names.forEach((nm, k) => bones[nm].quaternion.fromArray(S.q[k], i * 4));
    g.updateMatrixWorld(true);
    for (const nm of S.names) {
      bones[nm].getWorldQuaternion(tmp);
      out.get(nm)!.set([tmp.x, tmp.y, tmp.z, tmp.w], i * 4);
    }
  }
  return out;
}

/**
 * Mirror: D = G * R^-1 (rotation relative to rest, model space), reflect across
 * the sagittal plane (x -> -x: q -> (x,-y,-z,w)), give it to the mirrored bone,
 * G' = D' * R'; local' = G'parent^-1 * G'.
 */
function mirrorSampled(g: THREE.Group, S: Sampled): { M: Sampled; err: number } {
  const bones = boneMap(g);
  // rest world quats (bind pose of the source skeleton)
  const restLocal = g.userData.rest as Map<string, THREE.Quaternion>;
  for (const [nm, q] of restLocal) bones[nm].quaternion.copy(q);
  bones.Hips.position.set(0, S.restHips, 0); // position irrelevant for rotations
  g.updateMatrixWorld(true);
  const restW = new Map<string, THREE.Quaternion>();
  for (const nm of Object.keys(bones)) restW.set(nm, bones[nm].getWorldQuaternion(new THREE.Quaternion()));
  const parentW = g.getWorldQuaternion(new THREE.Quaternion());
  const W = worldQuats(g, S);
  const M: Sampled = { ...S, q: S.names.map(() => new Float32Array(S.n * 4)), hips: new Float32Array(S.n * 3), joints: {}, chestFwd: new Float32Array(S.n * 3) };
  const has = new Set(S.names);
  const G = new Map<string, THREE.Quaternion>();
  const D = new THREE.Quaternion(),
    tmp = new THREE.Quaternion();
  // parent chain order: S.names follow FBX track order (parents first for Mixamo)
  const order = [...S.names].sort((a, b) => depth(bones[a]) - depth(bones[b]));
  for (let i = 0; i < S.n; i++) {
    G.clear();
    for (const nm of order) {
      const src = mirrorName(nm); // the bone whose motion this bone takes
      if (!has.has(src)) continue;
      const gs = new THREE.Quaternion().fromArray(W.get(src)!, i * 4);
      D.copy(gs).multiply(tmp.copy(restW.get(src)!).invert());
      D.set(D.x, -D.y, -D.z, D.w);
      const gm = D.clone().multiply(restW.get(nm)!);
      G.set(nm, gm);
      const par = bones[nm].parent as THREE.Object3D;
      const pName = strip(par.name);
      const pw = G.get(pName) ?? (bones[pName] ? restW.get(pName)! : parentW);
      const loc = tmp.copy(pw).invert().multiply(gm).normalize();
      M.q[S.names.indexOf(nm)].set([loc.x, loc.y, loc.z, loc.w], i * 4);
    }
    M.hips.set([-S.hips[i * 3], S.hips[i * 3 + 1], S.hips[i * 3 + 2]], i * 3);
  }
  // verification by FK: mirrored skeleton joints vs reflected original joints
  let err = 0;
  const v = new THREE.Vector3();
  for (const j of KEYJ) M.joints[j] = new Float32Array(S.n * 3);
  for (let i = 0; i < S.n; i += 3) {
    S.names.forEach((nm, k) => bones[nm].quaternion.fromArray(M.q[k], i * 4));
    bones.Hips.position.set(M.hips[i * 3] * S.restHips, M.hips[i * 3 + 1] * S.restHips, M.hips[i * 3 + 2] * S.restHips);
    g.updateMatrixWorld(true);
    for (const j of KEYJ) {
      if (!bones[j]) continue;
      bones[j].getWorldPosition(v).divideScalar(S.restHips);
      const o = S.joints[mirrorName(j)];
      err = Math.max(err, Math.hypot(v.x + o[i * 3], v.y - o[i * 3 + 1], v.z - o[i * 3 + 2]) * S.restHips);
    }
  }
  // full-rate joints + chest for the measurements of the mirrored clip
  for (let i = 0; i < S.n; i++) {
    for (const j of KEYJ) {
      const o = S.joints[mirrorName(j)];
      if (o) M.joints[j].set([-o[i * 3], o[i * 3 + 1], o[i * 3 + 2]], i * 3);
    }
    M.chestFwd.set([-S.chestFwd[i * 3], S.chestFwd[i * 3 + 1], S.chestFwd[i * 3 + 2]], i * 3);
  }
  for (const [nm, q] of restLocal) bones[nm].quaternion.copy(q);
  return { M, err };
}
function depth(o: THREE.Object3D) {
  let d = 0;
  for (let p = o.parent; p; p = p.parent) d++;
  return d;
}

// ------------------------------------------------------------------ measurements
const H = (S: Sampled, i: number) => S.hips[i * 3 + 1];
const J = (S: Sampled, j: string, i: number) => [S.joints[j][i * 3], S.joints[j][i * 3 + 1], S.joints[j][i * 3 + 2]];
const posture = (h: number) => (h > 0.78 ? 'stand' : h > 0.5 ? 'crouch' : h > 0.33 ? 'kneel' : 'ground');
function face(S: Sampled, i: number) {
  const y = S.chestFwd[i * 3 + 1];
  return y > 0.45 ? 'supine' : y < -0.45 ? 'prone' : 'side';
}
/** per-frame motion energy (sum of joint speeds) */
function energy(S: Sampled): number[] {
  const out: number[] = [0];
  for (let i = 1; i < S.n; i++) {
    let e = 0;
    for (const j of KEYJ) {
      const a = J(S, j, i - 1),
        b = J(S, j, i);
      e += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * FPS;
    }
    out.push(e);
  }
  return out;
}

function autoTrim(spec: LibClipSpec, S: Sampled): [number, number] {
  const n = S.n;
  const E = energy(S);
  const settle = (from: number) => {
    // first frame >= from after which the energy stays low for 0.3 s
    for (let i = from; i < n - 9; i++) {
      let ok = true;
      for (let k = 0; k < 9; k++) if (E[i + k] > 0.9) ok = false;
      if (ok) return i;
    }
    return n - 1;
  };
  if (spec.role === 'getup') {
    let rise = -1;
    for (let i = 0; i < n; i++) if (H(S, i) > 0.55) { rise = i; break; }
    if (rise < 0) return [0, n - 1];
    let start = 0;
    for (let i = rise; i >= 0; i--) if (H(S, i) < 0.36) { start = i; break; }
    // walk back further while the body is still (lying)
    while (start > 0 && E[start] > 1.2) start--;
    start = Math.max(0, start - 4);
    let stood = n - 1;
    for (let i = rise; i < n; i++) if (H(S, i) > 0.9) { stood = i; break; }
    return [start, Math.min(n - 1, settle(stood) + 8)];
  }
  if (spec.role === 'knockdown' || spec.role === 'death' || spec.role === 'launch') {
    let g = -1;
    for (let i = 3; i < n; i++) if (H(S, i) < 0.4) { g = i; break; }
    if (g < 0) return [0, n - 1];
    return [0, Math.min(n - 1, Math.max(g + 15, Math.min(settle(g) + 9, g + 50)))];
  }
  if (spec.role === 'hit') {
    // drop a long tail of idle
    let last = n - 1;
    while (last > 10 && E[last] < 0.35) last--;
    return [0, Math.min(n - 1, last + 6)];
  }
  return [0, n - 1];
}

function sliceS(S: Sampled, a: number, b: number): Sampled {
  const n = b - a + 1;
  const sub = (x: Float32Array, w: number) => x.slice(a * w, (b + 1) * w);
  const joints: Record<string, Float32Array> = {};
  for (const j of Object.keys(S.joints)) joints[j] = sub(S.joints[j], 3);
  return { ...S, n, q: S.q.map((x) => sub(x, 4)), hips: sub(S.hips, 3), joints, chestFwd: sub(S.chestFwd, 3) };
}

/** rotate the whole clip about Y by -yaw0 and move the start to the origin (hips + joints + hips rotation) */
function normalise(S: Sampled): { yaw0: number; x0: number; z0: number } {
  const hipF = (i: number) => {
    // facing from hips->feet? use chest forward projected on the ground at the first frame
    return Math.atan2(S.chestFwd[i * 3], S.chestFwd[i * 3 + 2]);
  };
  // Mixamo exports always face +Z at frame 0 (authored stances may turn the chest,
  // e.g. the archer's side-on guard), so only translate to the origin.
  void hipF;
  const yaw0 = 0;
  const x0 = S.hips[0],
    z0 = S.hips[2];
  const c = Math.cos(-yaw0),
    s = Math.sin(-yaw0);
  const rot = (arr: Float32Array) => {
    for (let i = 0; i < arr.length; i += 3) {
      const x = arr[i] - x0,
        z = arr[i + 2] - z0;
      arr[i] = x * c + z * s;
      arr[i + 2] = -x * s + z * c;
    }
  };
  rot(S.hips);
  for (const j of Object.keys(S.joints)) rot(S.joints[j]);
  for (let i = 0; i < S.chestFwd.length; i += 3) {
    const x = S.chestFwd[i],
      z = S.chestFwd[i + 2];
    S.chestFwd[i] = x * c + z * s;
    S.chestFwd[i + 2] = -x * s + z * c;
  }
  const hk = S.names.indexOf('Hips');
  const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw0);
  const t = new THREE.Quaternion();
  for (let i = 0; i < S.n; i++) {
    t.fromArray(S.q[hk], i * 4).premultiply(qy);
    S.q[hk].set([t.x, t.y, t.z, t.w], i * 4);
  }
  return { yaw0, x0, z0 };
}

/** zero-phase moving average of the hips XZ path = root travel */
function rootCurve(S: Sampled): { rx: Float32Array; rz: Float32Array; yaw: Float32Array } {
  const n = S.n,
    w = 6;
  const rx = new Float32Array(n),
    rz = new Float32Array(n),
    yaw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0,
      sz = 0,
      c = 0;
    for (let k = -w; k <= w; k++) {
      const j = Math.max(0, Math.min(n - 1, i + k));
      sx += S.hips[j * 3];
      sz += S.hips[j * 3 + 2];
      c++;
    }
    rx[i] = sx / c;
    rz[i] = sz / c;
  }
  // anchor: root starts exactly at the start
  const ox = rx[0],
    oz = rz[0];
  for (let i = 0; i < n; i++) {
    rx[i] -= ox - S.hips[0];
    rz[i] -= oz - S.hips[2];
  }
  let prev = Math.atan2(S.chestFwd[0], S.chestFwd[2]),
    acc = prev;
  for (let i = 0; i < n; i++) {
    const a = Math.atan2(S.chestFwd[i * 3], S.chestFwd[i * 3 + 2]);
    let d = a - prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    acc += d;
    prev = a;
    yaw[i] = acc;
  }
  return { rx, rz, yaw };
}

function measure(spec: LibClipSpec, S: Sampled) {
  const n = S.n;
  const dur = (n - 1) / FPS;
  const hStart = H(S, 0),
    hEnd = H(S, n - 1);
  let hMin = 9,
    hMax = -9,
    apex = 0;
  for (let i = 0; i < n; i++) {
    const h = H(S, i);
    if (h < hMin) hMin = h;
    if (h > hMax) {
      hMax = h;
      apex = i;
    }
  }
  let groundT = -1;
  for (let i = 2; i < n; i++)
    if (H(S, i) < 0.4) {
      groundT = i / FPS;
      break;
    }
  const m: Record<string, unknown> = {
    dur: +dur.toFixed(3),
    posture: [posture(hStart), posture(hEnd)],
    hMin: +hMin.toFixed(2),
    lift: +Math.max(0, hMax - Math.max(1, hStart)).toFixed(2),
    apexT: +(apex / FPS).toFixed(2),
    groundT: +groundT.toFixed(2),
    startFace: posture(hStart) === 'ground' ? face(S, 0) : 'up',
    endFace: posture(hEnd) === 'ground' || hEnd < 0.45 ? face(S, n - 1) : 'up',
    travel: [+(S.hips[(n - 1) * 3] - S.hips[0]).toFixed(2), +(S.hips[(n - 1) * 3 + 2] - S.hips[2]).toFixed(2)],
  };
  // ---- hit tagging from the head excursion in the first 0.7 s (relative to the start pose)
  if (spec.role === 'hit' || spec.role === 'knockdown' || spec.role === 'death' || spec.role === 'launch') {
    const win = Math.min(n - 1, Math.round(0.7 * FPS));
    let best = 0,
      bi = 0;
    const h0 = J(S, 'Head', 0),
      c0 = J(S, 'Spine2', 0);
    let chestAtBest = 0;
    for (let i = 1; i <= win; i++) {
      const h = J(S, 'Head', i);
      const d = Math.hypot(h[0] - h0[0], h[2] - h0[2]) + Math.max(0, h0[1] - h[1]) * 0.5;
      if (d > best) {
        best = d;
        bi = i;
        const c = J(S, 'Spine2', i);
        chestAtBest = Math.hypot(c[0] - c0[0], c[2] - c0[2]);
      }
    }
    const hb = J(S, 'Head', bi);
    const dx = hb[0] - h0[0],
      dz = hb[2] - h0[2];
    // the head is pushed AWAY from the blow: blow from = opposite of the displacement
    let from = 'F';
    if (Math.abs(dz) >= Math.abs(dx) * 0.8) from = dz < 0 ? 'F' : 'B';
    else from = dx < 0 ? 'L' : 'R';
    // impact = largest head acceleration in the first 0.45 s
    let acc = 0,
      ai = 0;
    for (let i = 1; i < Math.min(n - 1, Math.round(0.45 * FPS)); i++) {
      const a = J(S, 'Head', i - 1),
        b = J(S, 'Head', i),
        c = J(S, 'Head', i + 1);
      const ax = c[0] - 2 * b[0] + a[0],
        ay = c[1] - 2 * b[1] + a[1],
        az = c[2] - 2 * b[2] + a[2];
      const v = Math.hypot(ax, ay, az);
      if (v > acc) {
        acc = v;
        ai = i;
      }
    }
    // big travelling reactions: the body is thrown AWAY from the blow
    const tx = S.hips[(n - 1) * 3] - S.hips[0],
      tz = S.hips[(n - 1) * 3 + 2] - S.hips[2];
    if (spec.role !== 'hit' && Math.hypot(tx, tz) > 0.8) from = Math.abs(tz) >= Math.abs(tx) * 0.8 ? (tz < 0 ? 'F' : 'B') : tx < 0 ? 'L' : 'R';
    m.from = from;
    m.exc = +best.toFixed(2);
    m.sev = best < 0.2 ? 1 : best < 0.42 ? 2 : 3;
    m.height = chestAtBest > 1e-3 && best / chestAtBest > 1.7 ? 'head' : 'body';
    m.impactT = +(ai / FPS).toFixed(2);
  }
  {
    // when the travel is (85%) done - dodges / launches are time-warped onto the sim's displacement window
    const D = Math.hypot(S.hips[(n - 1) * 3] - S.hips[0], S.hips[(n - 1) * 3 + 2] - S.hips[2]);
    let tt = 0;
    if (D > 0.2)
      for (let i = 0; i < n; i++)
        if (Math.hypot(S.hips[i * 3] - S.hips[0], S.hips[i * 3 + 2] - S.hips[2]) >= 0.85 * D) {
          tt = i / FPS;
          break;
        }
    m.travelT = +tt.toFixed(2);
  }
  if (spec.role === 'entrance' || spec.role === 'pair' || spec.role === 'finisher') {
    // IMPACTS: an effector moving fast that suddenly stops (fist on bars, shoulder into a door,
    // axe into the ground, foot stomp) - cues bind to these frames, not to timeline seconds
    const effs = ['RightHand', 'LeftHand', 'RightFoot', 'LeftFoot', 'Head', 'Spine2'];
    const sp = (j: string, i: number) => {
      const a = J(S, j, Math.max(0, i - 1)),
        b = J(S, j, i);
      return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * FPS;
    };
    const imp: [number, string][] = [];
    for (let i = 3; i < n - 1; i++)
      for (const j of effs) {
        const before = Math.max(sp(j, i - 1), sp(j, i - 2));
        const now = sp(j, i);
        const thr = j === 'Spine2' || j === 'Head' ? 1.4 : 2.2;
        if (before > thr && now < before * 0.35 && !imp.some(([t]) => Math.abs(t - i / FPS) < 0.2)) imp.push([+(i / FPS).toFixed(2), j]);
      }
    m.impacts = imp.slice(0, 16);
    // where the impacting effector is relative to the (smoothed) root at that moment: [x left, y, z forward] hips units
    const R = rootCurve(S);
    m.impactPos = m.impacts && (m.impacts as [number, string][]).map(([t, j]) => {
      const i = Math.min(n - 1, Math.round(t * FPS));
      const p = J(S, j, i);
      return [+(p[0] - R.rx[i]).toFixed(3), +p[1].toFixed(3), +(p[2] - R.rz[i]).toFixed(3)];
    });
  }
  if (spec.role === 'knockdown' || spec.role === 'launch' || spec.role === 'death') {
    // lying body: chest relative to the end root (finishers aim at it)
    const R = rootCurve(S);
    const c = J(S, 'Spine2', n - 1);
    m.endChest = [+(c[0] - R.rx[n - 1]).toFixed(3), +c[1].toFixed(3), +(c[2] - R.rz[n - 1]).toFixed(3)];
  }
  if (spec.role === 'dodge') {
    const [dx, dz] = m.travel as number[];
    m.dir = Math.abs(dz) >= Math.abs(dx) ? (dz < 0 ? 'B' : 'F') : dx > 0 ? 'L' : 'R';
  }
  return m;
}

// ------------------------------------------------------------------ encoding
interface IndexClip {
  id: string;
  lib: string;
  role: string;
  tags: string[];
  src: string;
  mirrorOf?: string;
  fps: number;
  n: number;
  off: number; // int16 offset into the lib bin
  bones: [string, number][]; // name, static(1)/animated(0)
  origin?: [number, number, number]; // raw clips: start hips x,z (hips units), facing yaw
  meta: Record<string, unknown>;
}

function encode(S: Sampled, root: ReturnType<typeof rootCurve>, out: number[]): [string, number][] {
  const bones: [string, number][] = [];
  const q = new THREE.Quaternion(),
    q0 = new THREE.Quaternion();
  S.names.forEach((nm, k) => {
    const arr = S.q[k];
    q0.fromArray(arr, 0);
    let maxAng = 0;
    for (let i = 1; i < S.n; i++) {
      q.fromArray(arr, i * 4);
      maxAng = Math.max(maxAng, q.angleTo(q0));
    }
    const isStatic = maxAng < 0.006 ? 1 : 0;
    bones.push([nm, isStatic]);
    const frames = isStatic ? 1 : S.n;
    let prev: THREE.Quaternion | null = null;
    for (let i = 0; i < frames; i++) {
      q.fromArray(arr, i * 4).normalize();
      // keep the hemisphere continuous (interpolation-safe)
      if (prev && q.dot(prev) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      prev = q.clone();
      out.push(Math.round(q.x * 32767), Math.round(q.y * 32767), Math.round(q.z * 32767), Math.round(q.w * 32767));
    }
  });
  const c16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 1000)));
  for (let i = 0; i < S.n; i++) out.push(c16(S.hips[i * 3]), c16(S.hips[i * 3 + 1]), c16(S.hips[i * 3 + 2]), c16(root.rx[i]), c16(root.rz[i]), c16(root.yaw[i]));
  return bones;
}

// ------------------------------------------------------------------ main
fs.mkdirSync(OUT, { recursive: true });
const libs: Record<string, number[]> = {};
const index: IndexClip[] = [];
const sim: Record<string, Record<string, unknown>> = {};
const problems: string[] = [];
let worstMirror = 0;
const t0 = Date.now();
for (const spec of ANIM_LIBRARY) {
  if (ONLY && !spec.id.includes(ONLY)) continue;
  if (!fs.existsSync(SRC + spec.src)) {
    problems.push(`${spec.id}: missing ${spec.src}`);
    continue;
  }
  let g: THREE.Group, clip: THREE.AnimationClip;
  try {
    ({ g, clip } = loadFBX(spec.src));
  } catch (e) {
    problems.push(`${spec.id}: load failed ${(e as Error).message}`);
    continue;
  }
  const full = sample(g, clip);
  const variants: { id: string; S: Sampled; mirrorOf?: string }[] = [{ id: spec.id, S: full }];
  if (spec.mirror) {
    const { M, err } = mirrorSampled(g, full);
    worstMirror = Math.max(worstMirror, err);
    if (err > 1.0) problems.push(`${spec.id}: mirror error ${err.toFixed(2)} cm (skipped)`);
    else variants.push({ id: spec.id + '~M', S: M, mirrorOf: spec.id });
  }
  for (const v of variants) {
    let S = v.S;
    let origin: [number, number, number] | undefined;
    if (spec.raw) {
      origin = [+S.hips[0].toFixed(3), +S.hips[2].toFixed(3), +Math.atan2(S.chestFwd[0], S.chestFwd[2]).toFixed(3)];
    }
    // trim (explicit seconds or by role)
    let [a, b] = spec.trim ? [Math.round(spec.trim[0] * FPS), spec.trim[1] < 0 ? S.n - 1 + Math.round(spec.trim[1] * FPS) : Math.round(spec.trim[1] * FPS)] : autoTrim(spec, S);
    a = Math.max(0, Math.min(S.n - 2, a));
    b = Math.max(a + 1, Math.min(S.n - 1, b));
    S = sliceS(S, a, b);
    if (!spec.raw) normalise(S);
    const root = rootCurve(S);
    const meta = measure(spec, S);
    meta.trim = [+(a / FPS).toFixed(2), +(b / FPS).toFixed(2), +((v.S.n - 1) / FPS).toFixed(2)];
    const arr = (libs[spec.lib] ??= []);
    const off = arr.length;
    const bones = encode(S, root, arr);
    index.push({ id: v.id, lib: spec.lib, role: spec.role, tags: spec.tags ?? [], src: spec.src, mirrorOf: v.mirrorOf, fps: FPS, n: S.n, off, bones, origin, meta });
    sim[v.id] = { role: spec.role, tags: spec.tags ?? [], ...meta, mirror: !!v.mirrorOf };
    if (REPORT) console.log(v.id.padEnd(34), JSON.stringify(meta));
  }
}
for (const [lib, arr] of Object.entries(libs)) {
  const i16 = Int16Array.from(arr);
  // A21: lossless 'tdp1' transport coding (planar deltas + byte split: about 45 % smaller after gzip)
  fs.writeFileSync(path.join(OUT, `${lib}.bin`), encodeLib(i16, index.filter((c) => c.lib === lib).map((c) => ({ lib: c.lib, off: c.off, n: c.n, bones: c.bones.map(([, st]) => st) }))));
  console.log(`[lib] ${lib}.bin ${(i16.byteLength / 1024).toFixed(0)} KB`);
}
if (!ONLY) {
  const names = [...new Set(index.flatMap((c) => c.bones.map((b) => b[0])))];
  const compact = index.map((c) => ({ ...c, bones: c.bones.map(([nm, st]) => names.indexOf(nm) * 2 + st) }));
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ fps: FPS, generated: 'tools/anim/build-lib.ts', boneNames: names, clips: compact, enc: 'tdp1' }));
  const simRows = Object.entries(sim)
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join('\n');
  fs.writeFileSync(
    'src/sim/anim.gen.ts',
    `/* AUTO-GENERATED by tools/anim/build-lib.ts from src/data/animLibrary.ts - do not edit.
 * Sim-side view of the shared animation library: timing + measured tags (hips-height units). */
export interface AnimClipData {
  role: string; tags: string[]; dur: number; posture: [string, string]; hMin: number; lift: number; apexT: number; groundT: number;
  startFace: string; endFace: string; travel: [number, number]; trim: [number, number, number]; mirror: boolean;
  from?: 'F' | 'B' | 'L' | 'R'; exc?: number; sev?: number; height?: 'head' | 'body'; impactT?: number; dir?: 'F' | 'B' | 'L' | 'R'; travelT: number; impacts?: [number, string][]; impactPos?: [number, number, number][]; endChest?: [number, number, number];
}
export const ANIM: Record<string, AnimClipData> = {
${simRows}
} as unknown as Record<string, AnimClipData>;
`,
  );
}
console.log(`[lib] ${index.length} clips in ${((Date.now() - t0) / 1000).toFixed(1)}s; worst mirror FK error ${worstMirror.toFixed(3)} cm`);
if (problems.length) console.log('problems:\n  ' + problems.join('\n  '));
