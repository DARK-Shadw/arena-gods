/**
 * CONTACT WARP (render only): paired clips were authored on one pair of bodies;
 * on our rigs (different proportions and sizes) the hand / foot that should
 * land on the victim misses by a few tens of centimetres. Around every
 * finisher contact the moving role's root is warped (smoothly, max 0.7 m) so
 * the striking effector meets the victim's body exactly on the contact frame
 * - a standard motion-warping step (cf. UE Motion Warping). The sim positions
 * are untouched; only what is drawn bends toward the contact.
 */
import * as THREE from 'three';
import type { MatchRecord, SimEvent } from '../sim/types';
import { FIN_BY_ID } from '../sim/finishers';

interface WarpView {
  root: THREE.Object3D;
  model: THREE.Object3D;
  tipWorld: (o?: THREE.Vector3) => THREE.Vector3;
}

const EFF = ['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot', 'Head'];
const BODY: [string, string, number][] = [
  ['Hips', 'Spine1', 0.16],
  ['Spine1', 'Neck', 0.17],
  ['Neck', 'Head', 0.1],
];
const BEFORE = 0.38,
  AFTER = 0.3;

export class ContactWarp {
  private contacts: { t: number; a: number; b: number; move: 'att' | 'vic' }[] = [];
  /** last applied offset per view (metrics) */
  last = [new THREE.Vector3(), new THREE.Vector3()];
  constructor(rec: MatchRecord) {
    let kind = 'pair';
    for (const e of rec.events) {
      if (e.type === 'finisher_start') kind = FIN_BY_ID[String(e.data?.id)]?.kind ?? 'pair';
      if (e.type === 'finisher_contact' && e.b !== undefined && kind !== 'spell' && kind !== 'launch') this.contacts.push({ t: e.t, a: e.a, b: e.b, move: kind === 'downed' ? 'att' : 'vic' });
    }
  }
  get active() {
    return this.contacts.length > 0;
  }

  /** gap vector from the attacker's nearest effector to the victim's body surface (world) */
  static gap(A: WarpView, V: WarpView): THREE.Vector3 {
    let best = 9;
    const out = new THREE.Vector3();
    const pts = EFF.map((n) => (A.model.getObjectByName('mixamorig' + n) ?? A.model).getWorldPosition(new THREE.Vector3()));
    pts.push(A.tipWorld(new THREE.Vector3()));
    for (const p of pts)
      for (const [s0, s1, r] of BODY) {
        const o0 = V.model.getObjectByName('mixamorig' + s0),
          o1 = V.model.getObjectByName('mixamorig' + s1);
        if (!o0 || !o1) continue;
        const seg = new THREE.Line3(o0.getWorldPosition(new THREE.Vector3()), o1.getWorldPosition(new THREE.Vector3()));
        const c = seg.closestPointToPoint(p, true, new THREE.Vector3());
        const d = c.distanceTo(p) - r;
        if (d < best) {
          best = d;
          // move the body so its surface (not its axis) reaches the effector
          const dir = c.clone().sub(p);
          const l = dir.length() || 1;
          out.copy(dir).multiplyScalar(Math.max(0, d) / l);
        }
      }
    return out; // victim body needs to move by -out (or the attacker by +out)
  }

  /** call after the views were posed for time t */
  apply(views: WarpView[], t: number) {
    this.last[0].set(0, 0, 0);
    this.last[1].set(0, 0, 0);
    for (const c of this.contacts) {
      if (t < c.t - BEFORE || t > c.t + AFTER) continue;
      const k = t <= c.t ? (t - (c.t - BEFORE)) / BEFORE : 1 - (t - c.t) / AFTER;
      const w = k * k * (3 - 2 * k);
      const A = views[c.a],
        V = views[c.b];
      A.root.updateMatrixWorld(true);
      V.root.updateMatrixWorld(true);
      const g = ContactWarp.gap(A, V).setY(0);
      if (g.length() > 0.7) g.setLength(0.7);
      const mover = c.move === 'vic' ? V : A;
      const off = c.move === 'vic' ? g.multiplyScalar(-w) : g.multiplyScalar(w);
      mover.root.position.add(off);
      mover.root.updateMatrixWorld(true);
      this.last[c.move === 'vic' ? c.b : c.a].copy(off);
      break;
    }
  }
}
export type { SimEvent };
