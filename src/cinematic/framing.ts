/**
 * A18: composition helpers for the hero cinematics (reveal, stair entrances, face-off, fight handover).
 *
 * The sim's hanging hazards (the chandelier / fire cage at CHANDELIER_H and the chain weight on its chain) are part of
 * the fight and stay where the arena generator put them; the cinematics keep them out of the HERO framing by choosing,
 * among a few equally good camera poses, the one whose frame they intrude on least (render-only: nothing here reads or
 * writes sim state beyond the immutable layout).
 */
import * as THREE from 'three';
import type { ArenaLayout } from '../sim/arenaGen';
import { CHAIN_LEN, CHAIN_PIVOT_H } from '../sim/arenaGen';
import { CHANDELIER_H } from '../render/arena/arenaView';

const probe = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 500);
const tmp = new THREE.Vector3();

/** sample points of every hanging hazard (cage body + its chains up into the dark; the chain weight + its chain) */
export function hangingPoints(L: ArenaLayout): THREE.Vector3[][] {
  const out: THREE.Vector3[][] = [];
  for (const h of L.hazards) {
    if (h.kind === 'chandelier') {
      const pts: THREE.Vector3[] = [];
      for (const y of [-1.8, -1.2, -0.6, 0, 1.5, 3, 5, 8]) for (const d of [-0.9, 0, 0.9]) pts.push(new THREE.Vector3(h.x + (y < 0.5 ? d : 0), CHANDELIER_H + y, h.z + (y < 0.5 ? d * 0.6 : 0)));
      out.push(pts);
    } else if (h.kind === 'chains') {
      const pts: THREE.Vector3[] = [];
      const y0 = CHAIN_PIVOT_H - CHAIN_LEN;
      for (const y of [y0 - 0.3, y0, y0 + 0.4, y0 + 1, y0 + 2, CHAIN_PIVOT_H, CHAIN_PIVOT_H + 2, CHAIN_PIVOT_H + 5]) pts.push(new THREE.Vector3(h.x, y, h.z));
      out.push(pts);
    }
  }
  return out;
}

/**
 * How badly the hanging hazards intrude on a frame (0 = not visible). Each hazard counts by its most central visible
 * sample: the frame centre weighs most, the outer fifth of the frame little; a hazard right next to the lens (would fill
 * the frame) counts double.
 */
export function hazardPenalty(L: ArenaLayout, pos: THREE.Vector3, look: THREE.Vector3, fov: number, aspect: number): number {
  probe.fov = fov;
  probe.aspect = aspect;
  probe.position.copy(pos);
  probe.lookAt(look);
  probe.updateProjectionMatrix();
  probe.updateMatrixWorld(true);
  let pen = 0;
  for (const pts of hangingPoints(L)) {
    let worst = 0;
    for (const p of pts) {
      const d = p.distanceTo(pos);
      tmp.copy(p).project(probe);
      if (tmp.z >= 1 || Math.abs(tmp.x) > 1.05 || Math.abs(tmp.y) > 1.05) continue;
      const centre = (1 - Math.min(1, Math.abs(tmp.x))) * (0.6 + 0.4 * (1 - Math.min(1, Math.abs(tmp.y))));
      const w = (0.15 + centre) * (d < 4 ? 2 : 1);
      worst = Math.max(worst, w);
    }
    pen += worst;
  }
  return pen;
}

/** pick the candidate with the least hazard intrusion (summed over its sample poses); ties keep the first */
export function leastHazard<T>(L: ArenaLayout, cands: T[], poses: (c: T) => [THREE.Vector3, THREE.Vector3, number][], aspect: number): T {
  let best = cands[0],
    bp = Infinity;
  for (const c of cands) {
    let pen = 0;
    for (const [p, l, f] of poses(c)) pen += hazardPenalty(L, p, l, f, aspect);
    if (pen < bp - 1e-3) {
      bp = pen;
      best = c;
    }
  }
  return best;
}
