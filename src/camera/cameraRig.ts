/**
 * Physical camera rig: critically-damped springs for position / look target /
 * FOV, trauma-based shake, FOV punches, and geometry avoidance (arena wall,
 * pillars, floor) so the camera never clips or loses the fighters behind a
 * pillar.
 */
import * as THREE from 'three';
/** Arena geometry the camera must respect (set by the app for the current arena). */
export const camWorld = {
  /** standing cover / columns: x, z, radius, height */
  obstacles: [] as { x: number; z: number; r: number; h: number }[],
  /** boundary radius (fighter limit) in the direction of (x, z) */
  boundR: (_x: number, _z: number) => 12.3,
  /** wall height + clearance above which the camera may leave the arena */
  wallH: 3.2,
  /** hanging hazards (chandeliers): sphere centre + radius */
  hanging: [] as { x: number; y: number; z: number; r: number }[],
  /** real line-of-sight test against the built arena (decor the layout data does not know); set by the app */
  occluded: (_from: THREE.Vector3, _to: THREE.Vector3) => false,
};

/** Unity-style SmoothDamp for a scalar (critically damped). */
export function smoothDamp(cur: number, target: number, vel: { v: number }, smoothTime: number, dt: number): number {
  smoothTime = Math.max(0.0001, smoothTime);
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel.v + omega * change) * dt;
  vel.v = (vel.v - omega * temp) * exp;
  return target + (change + temp) * exp;
}

class SpringV3 {
  v = new THREE.Vector3();
  private vx = { v: 0 };
  private vy = { v: 0 };
  private vz = { v: 0 };
  update(target: THREE.Vector3, smooth: number, dt: number) {
    this.v.x = smoothDamp(this.v.x, target.x, this.vx, smooth, dt);
    this.v.y = smoothDamp(this.v.y, target.y, this.vy, smooth, dt);
    this.v.z = smoothDamp(this.v.z, target.z, this.vz, smooth, dt);
  }
  snap(p: THREE.Vector3) {
    this.v.copy(p);
    this.vx.v = this.vy.v = this.vz.v = 0;
  }
}

export class CameraRig {
  cam: THREE.PerspectiveCamera;
  private pos = new SpringV3();
  private look = new SpringV3();
  private fovV = { v: 0 };
  fov = 50;
  trauma = 0;
  fovKick = 0;
  roll = 0;
  private t = 0;
  smoothPos = 0.35;
  smoothLook = 0.2;
  smoothFov = 0.3;
  /** Disable geometry avoidance (cutscenes may place the camera in tunnels). */
  collide = true;

  constructor(cam: THREE.PerspectiveCamera) {
    this.cam = cam;
  }

  get position() {
    return this.pos.v;
  }
  get target() {
    return this.look.v;
  }

  cut(pos: THREE.Vector3, look: THREE.Vector3, fov: number) {
    this.pos.snap(this.collide ? resolveCamera(pos.clone(), look, true, this.subjects) : pos);
    this.look.snap(look);
    this.fov = fov;
    this.fovV.v = 0;
  }

  addShake(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }
  punchFov(amount: number) {
    this.fovKick += amount;
  }

  /** Points that must stay visible (fighters); used for pillar occlusion. */
  subjects: THREE.Vector3[] = [];

  update(desiredPos: THREE.Vector3, desiredLook: THREE.Vector3, desiredFov: number, dt: number) {
    this.t += dt;
    const safe = this.collide ? resolveCamera(desiredPos.clone(), desiredLook, true, this.subjects) : desiredPos;
    this.pos.update(safe, this.smoothPos, dt);
    this.look.update(desiredLook, this.smoothLook, dt);
    this.fov = smoothDamp(this.fov, desiredFov, this.fovV, this.smoothFov, dt);
    // final safety after springs (spring overshoot can't push through geometry)
    const p = this.collide ? resolveCamera(this.pos.v.clone(), this.look.v, false) : this.pos.v.clone();
    this.cam.position.copy(p);
    // shake
    const s = this.trauma * this.trauma;
    if (s > 0.0001) {
      const n = (f: number, o: number) => Math.sin(this.t * f + o) * 0.6 + Math.sin(this.t * f * 2.3 + o * 1.7) * 0.4;
      this.cam.position.x += n(37, 1) * s * 0.35;
      this.cam.position.y += n(41, 2) * s * 0.3;
      this.cam.position.z += n(33, 3) * s * 0.35;
    }
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    this.fovKick *= Math.exp(-dt * 6);
    this.cam.fov = this.fov + this.fovKick;
    this.cam.updateProjectionMatrix();
    this.cam.lookAt(this.look.v);
    const rollShake = s * Math.sin(this.t * 29) * 0.04;
    this.cam.rotateZ(this.roll + rollShake);
  }
}

const _a = new THREE.Vector2();
const _b = new THREE.Vector2();

/** Does the 2D segment a->b pass through a circle (c, r)? */
function segHitsCircle(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, r: number): boolean {
  const dx = bx - ax,
    dz = bz - az;
  const l2 = dx * dx + dz * dz || 1e-6;
  let t = ((cx - ax) * dx + (cz - az) * dz) / l2;
  t = Math.max(0, Math.min(1, t));
  const px = ax + dx * t - cx,
    pz = az + dz * t - cz;
  return px * px + pz * pz < r * r;
}


/** keep a point inside the arena wall (unless high above it) */
function clampWall(p: THREE.Vector3) {
  const r = Math.hypot(p.x, p.z);
  if (r < 1e-6) return;
  const maxR = camWorld.boundR(p.x, p.z) + 0.1;
  if (r > maxR && p.y < camWorld.wallH + 4.5) {
    p.x *= maxR / r;
    p.z *= maxR / r;
  }
}

/** push out of columns (cylinders) and hanging hazards (spheres) */
function pushOut(p: THREE.Vector3) {
  for (const pl of camWorld.obstacles) {
    if (p.y > pl.h + 2.5) continue;
    _a.set(p.x - pl.x, p.z - pl.z);
    const d = _a.length();
    const min = pl.r + (p.y > 3.5 ? 2.2 : 0.8);
    if (d < min) {
      if (d < 1e-4) _a.set(1, 0);
      _a.normalize().multiplyScalar(min);
      p.x = pl.x + _a.x;
      p.z = pl.z + _a.y;
    }
  }
  for (const b of camWorld.hanging) {
    const dx = p.x - b.x,
      dy = p.y - b.y,
      dz = p.z - b.z;
    const d = Math.hypot(dx, dy, dz);
    const min = b.r + 1.6;
    if (d < min) {
      const k = d < 1e-4 ? 0 : min / d;
      if (k === 0) p.y = b.y - min;
      else {
        p.x = b.x + dx * k;
        p.y = b.y + dy * k;
        p.z = b.z + dz * k;
      }
    }
  }
}

/**
 * Push a desired camera position out of geometry and, if a column / hanging
 * hazard blocks the view of the look target or fighters, orbit around the
 * target to the nearest clear angle (each candidate is wall-clamped first, so
 * the fix can't be undone by the wall).
 */
export function resolveCamera(p: THREE.Vector3, look: THREE.Vector3, avoidOcclusion = true, subjects: THREE.Vector3[] = []): THREE.Vector3 {
  const PILLARS = camWorld.obstacles;
  clampWall(p);
  if (avoidOcclusion && (PILLARS.length || camWorld.hanging.length)) {
    const targets = [look, ...subjects];
    const blocked = (x: number, y: number, z: number) =>
      PILLARS.some((pl) => {
        // standing right next to the pillar also counts (it would fill the frame)
        if (Math.hypot(x - pl.x, z - pl.z) < pl.r + (y > 3.5 ? 2.6 : 1.5)) return true;
        if (y > pl.h + 0.6) return false; // above it: only proximity matters
        return targets.some((t) => segHitsCircle(x, z, t.x, t.z, pl.x, pl.z, pl.r + 0.3));
      }) ||
      camWorld.hanging.some((b) => {
        if (Math.hypot(x - b.x, y - b.y, z - b.z) < b.r + 4.2) return true;
        // segment camera -> look passing through the hanging object
        const t = look;
        const dx = t.x - x,
          dy = t.y - y,
          dz = t.z - z;
        const l2 = dx * dx + dy * dy + dz * dz || 1e-6;
        const k = Math.max(0, Math.min(1, ((b.x - x) * dx + (b.y - y) * dy + (b.z - z) * dz) / l2));
        return Math.hypot(x + dx * k - b.x, y + dy * k - b.y, z + dz * k - b.z) < b.r + 0.4;
      });
    // looking straight down the line between the two fighters hides one behind the other
    const lined = (x: number, z: number) => {
      if (subjects.length < 2) return false;
      const a0 = Math.atan2(subjects[0].x - x, subjects[0].z - z),
        a1 = Math.atan2(subjects[1].x - x, subjects[1].z - z);
      let d = Math.abs(a0 - a1) % (Math.PI * 2);
      if (d > Math.PI) d = Math.PI * 2 - d;
      return d < 0.2 && Math.hypot(subjects[0].x - subjects[1].x, subjects[0].z - subjects[1].z) > 0.6;
    };
    const blockedOrLined = (x: number, y: number, z: number) => blocked(x, y, z) || lined(x, z);
    if (blockedOrLined(p.x, p.y, p.z)) {
      const dx = p.x - look.x,
        dz = p.z - look.z;
      const base = Math.atan2(dz, dx);
      const dist = Math.hypot(dx, dz);
      const c = new THREE.Vector3();
      let found = false;
      for (const step of [0.15, -0.15, 0.3, -0.3, 0.45, -0.45, 0.6, -0.6, 0.8, -0.8, 1.0, -1.0, 1.3, -1.3, 1.6, -1.6, 2.0, -2.0, 2.5, -2.5, 3.0]) {
        const a = base + step;
        c.set(look.x + Math.cos(a) * dist, p.y, look.z + Math.sin(a) * dist);
        clampWall(c);
        if (!blockedOrLined(c.x, c.y, c.z)) {
          p.copy(c);
          found = true;
          break;
        }
      }
      // nothing clear at this height: rise above the obstacles instead
      if (!found) p.y = Math.max(p.y, Math.min(9, PILLARS.reduce((m, o) => Math.max(m, o.h), 0) + 1.5));
    }
  }
  pushOut(p);
  clampWall(p);
  if (p.y < 0.35) p.y = 0.35;
  return p;
}
