/**
 * FX light pool (plan §2.5): a fixed set of point lights created once (never added or removed, so
 * shader permutations stay put). Impacts, parries and explosions request light for a short time;
 * every frame the strongest requests (decayed intensity) take the slots.
 *
 * Tiers: 1 / 2 / 3 slots (TIER_CAPS.lights). Slots above the tier are made invisible, which changes
 * the light count once on a tier switch (a recompile), not per effect.
 * Lights run on the FX light clock (real time), so a hit-stop does not hold a frame bloomed white.
 * Stateless: a request is (light-clock spawn time, colour, peak, decay, radius, position); the slot
 * assignment at time t is a pure function of the requests.
 */
import * as THREE from 'three';

interface Req {
  t: number;
  i: number;
  /** exponential decay rate (1/s) */
  k: number;
  color: THREE.Color;
  pos: THREE.Vector3;
  radius: number;
}

const MAX_REQ = 16;
const _cands: { r: Req; v: number }[] = [];

export class FxLights {
  readonly lights: THREE.PointLight[] = [];
  private reqs: Req[] = [];
  private slots = 3;

  constructor(group: THREE.Object3D, n = 3) {
    for (let i = 0; i < n; i++) {
      const L = new THREE.PointLight('#ffd0a0', 0, 9, 2);
      L.name = `fx.light${i}`;
      group.add(L);
      this.lights.push(L);
    }
    for (let i = 0; i < MAX_REQ; i++) this.reqs.push({ t: -1e9, i: 0, k: 14, color: new THREE.Color(), pos: new THREE.Vector3(), radius: 9 });
  }

  setSlots(n: number) {
    this.slots = Math.max(1, Math.min(this.lights.length, n));
    this.lights.forEach((L, i) => (L.visible = i < this.slots));
  }

  /** request light: lt = spawn time on the light clock, dur = time to fade to ~5 % */
  add(lt: number, color: string | THREE.Color, intensity: number, dur: number, pos: { x: number; y: number; z: number }, radius = 9) {
    // reuse the request that has decayed the most
    let best = this.reqs[0];
    let bv = Infinity;
    for (const r of this.reqs) {
      const v = r.i * Math.exp(-(lt - r.t) * r.k);
      if (v < bv) (bv = v), (best = r);
    }
    best.t = lt;
    best.i = intensity;
    best.k = 3 / Math.max(0.03, dur);
    best.color.set(color);
    best.pos.set(pos.x, pos.y, pos.z);
    best.radius = radius;
  }

  update(lt: number) {
    _cands.length = 0;
    for (const r of this.reqs) {
      if (r.t > lt) continue;
      const v = r.i * Math.exp(-(lt - r.t) * r.k);
      if (v > 0.02) _cands.push({ r, v });
    }
    _cands.sort((a, b) => b.v - a.v);
    for (let s = 0; s < this.lights.length; s++) {
      const L = this.lights[s];
      const c = s < this.slots ? _cands[s] : undefined;
      if (!c) {
        L.intensity = 0;
        continue;
      }
      L.intensity = c.v;
      L.color.copy(c.r.color);
      L.position.copy(c.r.pos);
      L.distance = c.r.radius;
    }
  }

  /** strongest current intensity (stats) */
  get peak(): number {
    return this.lights.reduce((m, L) => Math.max(m, L.intensity), 0);
  }

  clear() {
    for (const r of this.reqs) (r.t = -1e9), (r.i = 0);
    for (const L of this.lights) L.intensity = 0;
  }
}
