/**
 * Pose post-processing for the fighter animation pipeline (render only):
 *
 *  - Inertializer: on a discontinuity (new clip, interrupt, restart) the new
 *    pose is shown at FULL weight immediately and the difference to the last
 *    displayed pose (offset + its velocity) decays to zero with Bollo's quintic
 *    (GDC 2018 "Inertialization: High-Performance Animation Transitions in
 *    Gears of War"). No mushy cross-fade, no pop, and the incoming motion is
 *    never delayed (hit reactions start on the contact frame).
 *  - SpringFlinch: procedural additive hit reaction. An angular impulse along
 *    the hit direction drives under-damped springs on the spine / neck / head /
 *    shoulders; integrated on REAL time so the victim keeps reacting while
 *    hit-stop freezes the attacker (asymmetric hit-stop).
 *  - Airborne flail: velocity-driven springs on the limbs while launched
 *    (cosmetic partial "ragdoll" that never changes where the body lands).
 */
import * as THREE from 'three';

// ------------------------------------------------------------------ inertialization
interface Quintic {
  A: number;
  B: number;
  C: number;
  a0: number;
  v0: number;
  x0: number;
  t1: number;
}
function quintic(x0: number, v0: number, t1: number): Quintic {
  // Bollo: clamp so the offset never overshoots, shorten the blend if it would
  if (v0 > 0) v0 = 0;
  if (v0 < 0) t1 = Math.min(t1, (-5 * x0) / v0);
  t1 = Math.max(1e-3, t1);
  let a0 = (-8 * v0 * t1 - 20 * x0) / (t1 * t1);
  if (a0 < 0) a0 = 0;
  const t2 = t1 * t1,
    t3 = t2 * t1,
    t4 = t3 * t1,
    t5 = t4 * t1;
  const A = -(a0 * t2 + 6 * v0 * t1 + 12 * x0) / (2 * t5);
  const B = (3 * a0 * t2 + 16 * v0 * t1 + 30 * x0) / (2 * t4);
  const C = -(3 * a0 * t2 + 12 * v0 * t1 + 20 * x0) / (2 * t3);
  return { A, B, C, a0, v0, x0, t1 };
}
function evalQ(q: Quintic, t: number) {
  if (t >= q.t1) return 0;
  const t2 = t * t;
  return q.A * t2 * t2 * t + q.B * t2 * t2 + q.C * t2 * t + (q.a0 / 2) * t2 + q.v0 * t + q.x0;
}

const _q = new THREE.Quaternion(),
  _q2 = new THREE.Quaternion(),
  _v = new THREE.Vector3(),
  _ax = new THREE.Vector3();

export class Inertializer {
  bones: THREE.Object3D[] = [];
  private prev: Float32Array;
  private prev2: Float32Array;
  private prevH = new THREE.Vector3();
  private prev2H = new THREE.Vector3();
  private hips: THREE.Object3D | null = null;
  private axes: Float32Array;
  private curves: (Quintic | null)[] = [];
  private hAxis = new THREE.Vector3();
  private hCurve: Quintic | null = null;
  private t = 0;
  private active = false;
  private havePrev = 0;
  private lastDt = 1 / 60;
  /** total transitions handled (metrics) */
  count = 0;
  /** seconds since the last transition (metrics: pop detector window) */
  sinceLast = 99;

  constructor(model: THREE.Object3D) {
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone) {
        this.bones.push(o);
        if (/Hips$/.test(o.name)) this.hips = o;
      }
    });
    const n = this.bones.length;
    this.prev = new Float32Array(n * 4);
    this.prev2 = new Float32Array(n * 4);
    this.axes = new Float32Array(n * 3);
  }

  /** Call right after the mixer produced the NEW target pose on a transition frame. */
  begin(blend: number) {
    this.count++;
    this.sinceLast = 0;
    if (this.havePrev < 2) return;
    const n = this.bones.length;
    this.curves.length = n;
    for (let i = 0; i < n; i++) {
      const target = this.bones[i].quaternion;
      // offset = prev * target^-1  (applied as out = offset * target)
      _q.fromArray(this.prev, i * 4).multiply(_q2.copy(target).invert());
      if (_q.w < 0) _q.set(-_q.x, -_q.y, -_q.z, -_q.w);
      const x0 = 2 * Math.acos(Math.min(1, _q.w));
      if (x0 < 1e-4) {
        this.curves[i] = null;
        continue;
      }
      const s = Math.sqrt(Math.max(1e-12, 1 - _q.w * _q.w));
      _ax.set(_q.x / s, _q.y / s, _q.z / s);
      this.axes.set([_ax.x, _ax.y, _ax.z], i * 3);
      // previous offset projected on the same axis -> velocity
      _q2.fromArray(this.prev2, i * 4).multiply(_q.copy(target).invert());
      if (_q2.w < 0) _q2.set(-_q2.x, -_q2.y, -_q2.z, -_q2.w);
      const xm1 = 2 * Math.atan2(_q2.x * _ax.x + _q2.y * _ax.y + _q2.z * _ax.z, _q2.w);
      const v0 = (x0 - xm1) / Math.max(1e-3, this.lastDt);
      this.curves[i] = quintic(x0, v0, blend);
    }
    if (this.hips) {
      _v.copy(this.prevH).sub(this.hips.position);
      const x0 = _v.length();
      if (x0 > 1e-4) {
        this.hAxis.copy(_v).divideScalar(x0);
        const xm1 = _v.copy(this.prev2H).sub(this.hips.position).dot(this.hAxis);
        this.hCurve = quintic(x0, (x0 - xm1) / Math.max(1e-3, this.lastDt), blend);
      } else this.hCurve = null;
    }
    this.t = 0;
    this.active = true;
  }

  /** Apply the decaying offsets to the current target pose, then remember it. dt = animation (sim) time. */
  apply(dt: number) {
    this.sinceLast += dt;
    if (this.active) {
      this.t += dt;
      let any = false;
      const n = this.bones.length;
      for (let i = 0; i < n; i++) {
        const c = this.curves[i];
        if (!c) continue;
        const x = evalQ(c, this.t);
        if (this.t < c.t1) any = true;
        if (Math.abs(x) < 1e-5) continue;
        _ax.fromArray(this.axes, i * 3);
        _q.setFromAxisAngle(_ax, x);
        this.bones[i].quaternion.premultiply(_q);
      }
      if (this.hips && this.hCurve) {
        const x = evalQ(this.hCurve, this.t);
        if (this.t < this.hCurve.t1) any = true;
        this.hips.position.addScaledVector(this.hAxis, x);
      }
      if (!any) this.active = false;
    }
    this.remember(dt);
  }

  private remember(dt: number) {
    const n = this.bones.length;
    this.prev2.set(this.prev);
    for (let i = 0; i < n; i++) {
      const q = this.bones[i].quaternion;
      this.prev[i * 4] = q.x;
      this.prev[i * 4 + 1] = q.y;
      this.prev[i * 4 + 2] = q.z;
      this.prev[i * 4 + 3] = q.w;
    }
    if (this.hips) {
      this.prev2H.copy(this.prevH);
      this.prevH.copy(this.hips.position);
    }
    if (dt > 0) this.lastDt = dt;
    this.havePrev = Math.min(2, this.havePrev + 1);
  }
}

// ------------------------------------------------------------------ spring additive (flinch + airborne flail)
interface SpringBone {
  bone: THREE.Object3D;
  w: number; // impulse share
  th: THREE.Vector3; // axis-angle (character space)
  om: THREE.Vector3;
  k: number;
  c: number;
}
const FLINCH: [RegExp, number, number][] = [
  // bone, impulse weight, stiffness
  [/Spine$/, 0.22, 170],
  [/Spine1$/, 0.24, 170],
  [/Spine2$/, 0.3, 160],
  [/Neck$/, 0.35, 190],
  [/Head$/, 0.55, 210],
  [/LeftShoulder$/, 0.3, 150],
  [/RightShoulder$/, 0.3, 150],
  [/LeftArm$/, 0.45, 110],
  [/RightArm$/, 0.45, 110],
  [/LeftForeArm$/, 0.35, 120],
  [/RightForeArm$/, 0.35, 120],
  [/LeftUpLeg$/, 0.12, 160],
  [/RightUpLeg$/, 0.12, 160],
];

export class SpringFlinch {
  private s: SpringBone[] = [];
  private rootQ = new THREE.Quaternion();
  private rng: () => number;
  /** airborne flail amount 0..1 (set by the view while launched) */
  flail = 0;
  private flailT = 0;
  constructor(model: THREE.Object3D, rng: () => number = Math.random) {
    this.rng = rng;
    for (const [re, w, k] of FLINCH) {
      let b: THREE.Object3D | undefined;
      model.traverse((o) => {
        if (!b && (o as THREE.Bone).isBone && re.test(o.name)) b = o;
      });
      if (b) this.s.push({ bone: b, w, th: new THREE.Vector3(), om: new THREE.Vector3(), k, c: 2 * 0.3 * Math.sqrt(k) });
    }
  }
  get energy() {
    let e = 0;
    for (const s of this.s) e += s.th.lengthSq() + s.om.lengthSq() * 0.01;
    return e;
  }
  /**
   * Hit impulse. push: horizontal direction the blow pushes the victim (character
   * space: +Z forward, +X left); strength ~ 0.5 light .. 3 huge; height head|body.
   */
  impulse(push: THREE.Vector3, strength: number, height: 'head' | 'body' = 'body') {
    const p = push.clone().setY(0);
    if (p.lengthSq() < 1e-6) p.set(0, 0, -1);
    p.normalize();
    // torso bends AWAY from the blow: rotate about up x push
    const axis = new THREE.Vector3(0, 1, 0).cross(p).normalize();
    const twist = (this.rng() - 0.5) * 0.6;
    for (const s of this.s) {
      let w = s.w * strength;
      const name = s.bone.name;
      if (/Head|Neck/.test(name)) w *= height === 'head' ? 1.6 : 0.8;
      if (/Arm/.test(name)) w *= 0.6 + this.rng() * 0.8; // arms flung a little differently every time
      const ax = axis.clone();
      if (/Arm|Shoulder/.test(name)) ax.add(new THREE.Vector3((this.rng() - 0.5) * 0.8, (this.rng() - 0.5) * 0.8, 0)).normalize();
      s.om.addScaledVector(ax, w * 9);
      s.om.y += twist * w * 4;
    }
  }
  /** integrate (real time) and apply as an additive on top of the current pose */
  update(realDt: number, root: THREE.Object3D) {
    const dt = Math.min(0.05, realDt);
    if (dt <= 0) return;
    if (this.flail > 0.01) {
      this.flailT += dt;
      // limbs trail behind the body's motion: low-frequency noise driving the arm / leg springs
      for (const s of this.s) {
        if (!/Arm|ForeArm|UpLeg|Shoulder/.test(s.bone.name)) continue;
        const ph = s.bone.name.length * 1.7;
        s.om.x += Math.sin(this.flailT * 7.3 + ph) * this.flail * 14 * dt * 10;
        s.om.z += Math.cos(this.flailT * 5.1 + ph * 0.7) * this.flail * 12 * dt * 10;
      }
    }
    let any = false;
    for (const s of this.s) {
      // semi-implicit Euler (stable for these stiffnesses at <= 50 ms steps with substeps)
      const sub = dt > 0.02 ? 2 : 1;
      const h = dt / sub;
      for (let k = 0; k < sub; k++) {
        s.om.x += (-s.k * s.th.x - s.c * s.om.x) * h;
        s.om.y += (-s.k * s.th.y - s.c * s.om.y) * h;
        s.om.z += (-s.k * s.th.z - s.c * s.om.z) * h;
        s.th.addScaledVector(s.om, h);
      }
      // safety clamp (~40 degrees)
      const l = s.th.length();
      if (l > 0.7) s.th.multiplyScalar(0.7 / l);
      if (l > 1e-4) any = true;
    }
    if (!any) return;
    root.updateMatrixWorld(true);
    root.getWorldQuaternion(this.rootQ);
    const bw = new THREE.Quaternion(),
      rw = new THREE.Quaternion(),
      d = new THREE.Quaternion();
    for (const s of this.s) {
      const a = s.th.length();
      if (a < 1e-4) continue;
      // character-space rotation -> world -> bone-local delta (applied on the local rotation)
      rw.setFromAxisAngle(_ax.copy(s.th).divideScalar(a), a);
      rw.premultiply(this.rootQ).multiply(_q.copy(this.rootQ).invert());
      s.bone.getWorldQuaternion(bw);
      d.copy(bw).invert().multiply(rw).multiply(bw);
      s.bone.quaternion.multiply(d);
    }
  }
  reset() {
    for (const s of this.s) {
      s.th.set(0, 0, 0);
      s.om.set(0, 0, 0);
    }
  }
}

// ------------------------------------------------------------------ locomotion phase matching
/**
 * Per locomotion clip: the "which foot is forward" signal over the cycle.
 * On returning to locomotion, the cycle is entered at the time whose signal
 * (and its trend) matches the current pose, so the first step continues the
 * stance instead of snapping legs through each other (Bollo 2016 / Lyra).
 */
export class PhaseMatcher {
  private tables = new Map<string, Float32Array>();
  private lf?: THREE.Object3D;
  private rf?: THREE.Object3D;
  private hips?: THREE.Object3D;
  prevS = 0;
  curS = 0;
  constructor(private model: THREE.Object3D) {
    model.traverse((o) => {
      if (!(o as THREE.Bone).isBone) return;
      if (/LeftFoot$/.test(o.name)) this.lf = o;
      if (/RightFoot$/.test(o.name)) this.rf = o;
      if (/Hips$/.test(o.name)) this.hips = o;
    });
  }
  /** forward offset of the left foot vs the right foot, in model units (character space) */
  private signal(): number {
    if (!this.lf || !this.rf) return 0;
    this.model.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.model.matrixWorld).invert();
    const a = this.lf.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    const b = this.rf.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    return a.z - b.z;
  }
  /** sample the current displayed pose (call once per frame after the pose is final) */
  track() {
    this.prevS = this.curS;
    this.curS = this.signal();
  }
  private table(clip: THREE.AnimationClip): Float32Array {
    let tb = this.tables.get(clip.name);
    if (tb) return tb;
    // sample the clip on a throwaway mixer, restoring the pose afterwards
    const saved: [THREE.Object3D, THREE.Quaternion, THREE.Vector3][] = [];
    this.model.traverse((o) => {
      if ((o as THREE.Bone).isBone) saved.push([o, o.quaternion.clone(), o.position.clone()]);
    });
    const mixer = new THREE.AnimationMixer(this.model);
    const act = mixer.clipAction(clip);
    act.play();
    const N = 32;
    tb = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      act.time = (i / N) * clip.duration;
      mixer.update(0);
      tb[i] = this.signal();
    }
    act.stop();
    mixer.uncacheRoot(this.model);
    for (const [o, q, p] of saved) {
      o.quaternion.copy(q);
      o.position.copy(p);
    }
    this.tables.set(clip.name, tb);
    return tb;
  }
  /** phase origin of a cycle: time at which the left foot is furthest forward */
  offset(clip: THREE.AnimationClip): number {
    const tb = this.table(clip);
    let bi = 0;
    for (let i = 1; i < tb.length; i++) if (tb[i] > tb[bi]) bi = i;
    return (bi / tb.length) * clip.duration;
  }
  /** best entry time into a loco cycle for the current pose */
  match(clip: THREE.AnimationClip): number {
    const tb = this.table(clip);
    const N = tb.length;
    const s = this.curS,
      ds = this.curS - this.prevS;
    let best = 0,
      bv = 1e9;
    for (let i = 0; i < N; i++) {
      const d = tb[(i + 1) % N] - tb[i];
      const cost = Math.abs(tb[i] - s) + (Math.sign(d) !== Math.sign(ds) && Math.abs(ds) > 1e-3 ? Math.abs(tb[i] - s) * 0.5 + 2 : 0);
      if (cost < bv) {
        bv = cost;
        best = i;
      }
    }
    return (best / N) * clip.duration;
  }
}

// ------------------------------------------------------------------ foot locking (two-bone IK)
interface Leg {
  up: THREE.Object3D;
  knee: THREE.Object3D;
  foot: THREE.Object3D;
  restY: number; // ankle height above the model origin in the bind pose (model units -> world via scale)
  lock: THREE.Vector3 | null;
  w: number;
  prevY: number;
}
const _a = new THREE.Vector3(),
  _b = new THREE.Vector3(),
  _c = new THREE.Vector3(),
  _t = new THREE.Vector3(),
  _qa = new THREE.Quaternion(),
  _qb = new THREE.Quaternion(),
  _qf = new THREE.Quaternion();

/**
 * FOOT LOCKING: while the animation has a foot planted (ankle at ground height,
 * not lifting) its world position is pinned and the leg is solved with
 * analytic two-bone IK, so feet stop skating when the root speed / turn rate
 * does not exactly match the clip (blended strafes, sim turning, knockback
 * slides). The lock releases when the clip lifts the foot or when the pinned
 * point drifts too far from the animated one (then it blends back smoothly).
 */
export class FootLock {
  legs: Leg[] = [];
  private scale = 1;
  enabled = true;
  constructor(model: THREE.Object3D) {
    const find = (re: RegExp) => {
      let b: THREE.Object3D | undefined;
      model.traverse((o) => {
        if (!b && (o as THREE.Bone).isBone && re.test(o.name)) b = o;
      });
      return b;
    };
    model.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
    for (const side of ['Left', 'Right']) {
      const up = find(new RegExp(side + 'UpLeg$')),
        knee = find(new RegExp(side + 'Leg$')),
        foot = find(new RegExp(side + 'Foot$'));
      if (!up || !knee || !foot) continue;
      const restY = foot.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv).y;
      this.legs.push({ up, knee, foot, restY, lock: null, w: 0, prevY: 0 });
    }
  }
  /** call after the pose is final (post inertialization); dt = animation time */
  update(dt: number, root: THREE.Object3D, active: boolean) {
    if (!this.legs.length) return;
    root.updateMatrixWorld(true);
    this.scale = root.getWorldScale(_a).y || 1;
    const rootY = root.getWorldPosition(_b).y;
    for (const L of this.legs) {
      const p = L.foot.getWorldPosition(new THREE.Vector3());
      const h = (p.y - rootY) / this.scale - L.restY; // ankle height above its standing height (model units)
      const vy = dt > 0 ? Math.abs(p.y - L.prevY) / dt : 0;
      L.prevY = p.y;
      const planted = active && h < 4.5 && vy < 0.35;
      if (planted && !L.lock) L.lock = p.clone();
      if (!planted) L.lock = null;
      if (L.lock) {
        // drifted too far from the animated foot: let go (the blend-out hides it)
        if (Math.hypot(p.x - L.lock.x, p.z - L.lock.z) > 0.22) L.lock = null;
      }
      const want = L.lock ? 1 : 0;
      L.w += (want - L.w) * Math.min(1, dt * (want ? 14 : 6));
      if (L.w < 0.01 || dt <= 0) {
        if (!L.lock) L.w = Math.max(0, L.w);
        continue;
      }
      const target = L.lock ? _t.set(L.lock.x, p.y, L.lock.z) : _t.copy(p);
      target.lerp(p, 1 - L.w);
      this.solve(L, target);
    }
  }
  private solve(L: Leg, T: THREE.Vector3) {
    const footW = L.foot.getWorldQuaternion(_qf.clone());
    const A = L.up.getWorldPosition(_a.clone()),
      B = L.knee.getWorldPosition(_b.clone()),
      C = L.foot.getWorldPosition(_c.clone());
    const lab = A.distanceTo(B),
      lbc = B.distanceTo(C);
    const d = Math.max(1e-4, Math.min(lab + lbc - 1e-4, A.distanceTo(T)));
    // 1) knee: set the interior angle for the needed hip->foot distance
    const cur = Math.acos(Math.max(-1, Math.min(1, B.clone().sub(A).normalize().dot(C.clone().sub(B).normalize()))));
    const want = Math.acos(Math.max(-1, Math.min(1, (lab * lab + lbc * lbc - d * d) / (2 * lab * lbc))));
    // bend (exterior) angle = PI - interior
    const delta = Math.PI - want - cur;
    let axis = C.clone().sub(B).cross(A.clone().sub(B));
    if (axis.lengthSq() < 1e-10) axis = new THREE.Vector3(1, 0, 0).applyQuaternion(L.up.getWorldQuaternion(new THREE.Quaternion()));
    axis.normalize();
    if (Math.abs(delta) > 1e-5) this.rotateWorld(L.knee, _qa.setFromAxisAngle(axis, delta));
    // 2) hip: swing the chain so the foot points at the target
    L.up.updateMatrixWorld(true);
    const C2 = L.foot.getWorldPosition(new THREE.Vector3());
    const from = C2.sub(A).normalize(),
      to = T.clone().sub(A).normalize();
    this.rotateWorld(L.up, _qb.setFromUnitVectors(from, to));
    // 3) keep the animated foot orientation
    L.up.updateMatrixWorld(true);
    const parentW = L.foot.parent!.getWorldQuaternion(new THREE.Quaternion());
    L.foot.quaternion.copy(parentW.invert().multiply(footW));
    L.foot.updateMatrixWorld(true);
  }
  private rotateWorld(bone: THREE.Object3D, qWorld: THREE.Quaternion) {
    const parentW = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
    const w = bone.getWorldQuaternion(new THREE.Quaternion());
    const nw = qWorld.clone().multiply(w);
    bone.quaternion.copy(parentW.invert().multiply(nw));
    bone.updateMatrixWorld(true);
  }
}
