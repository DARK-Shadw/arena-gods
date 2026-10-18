/**
 * PAIRED-CONTACT AUDIT (browser, real rigs, no render): plays recorded matches
 * that contain finishers through the FighterViews and, at every finisher
 * contact (damage contacts and the kill), measures the distance from the
 * attacker's nearest effector (hands, feet, head, weapon tip) to the victim's
 * body (spine chain, head, upper arms / legs). Target: <= 0.12 m.
 *
 *   await __arena.pairAudit([[a, b, seed, theme, layout, aseed], ...])
 */
import * as THREE from 'three';
import { simulate } from '../sim/match';
import { FighterView } from './fighterView';
import { loadCharacter } from './character';
import { initLib } from './animLib';
import { ContactWarp } from './contactWarp';
import type { ArenaSpec } from '../sim/arenaGen';

export interface PairRow {
  key: string;
  id: string;
  kind: string;
  t: number;
  dist: number;
  eff: string;
}

const EFF = ['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot', 'Head'];
const BODY: [string, string][] = [
  ['Hips', 'Spine1'],
  ['Spine1', 'Neck'],
  ['Neck', 'Head'],
  ['LeftShoulder', 'LeftForeArm'],
  ['RightShoulder', 'RightForeArm'],
  ['LeftUpLeg', 'LeftLeg'],
  ['RightUpLeg', 'RightLeg'],
];
const RAD: Record<string, number> = { 'Hips-Spine1': 0.16, 'Spine1-Neck': 0.17, 'Neck-Head': 0.1, default: 0.07 };

export async function runPairAudit(scene: THREE.Scene, list: [string, string, number, string, string, number][]): Promise<{ rows: PairRow[]; matches: number }> {
  await initLib('core', 'finisher');
  const rows: PairRow[] = [];
  for (const [a, b, seed, theme, layout, aseed] of list) {
    const rec = simulate(a, b, seed, true, { theme, layout, seed: aseed } as ArenaSpec);
    const assets = await Promise.all([loadCharacter(a), loadCharacter(b)]);
    const views = [new FighterView(a, assets[0], scene), new FighterView(b, assets[1], scene)];
    await Promise.all(views.map((v) => v.ready));
    const contacts = rec.events.filter((e) => e.type === 'finisher_contact');
    const warp = new ContactWarp(rec);
    let ci = 0;
    for (let i = 0; i < rec.frames.length && ci < contacts.length; i++) {
      const fr = rec.frames[i];
      for (let k = 0; k < 2; k++) views[k].updateFromFrame(fr.f[k], rec.dt, fr.f[1 - k], rec.dt);
      warp.apply(views, fr.t);
      while (ci < contacts.length && contacts[ci].t <= fr.t + 1e-4) {
        const e = contacts[ci++];
        const A = views[e.a],
          V = views[e.b!];
        const pts: [string, THREE.Vector3][] = EFF.map((n) => [n, (A.model.getObjectByName('mixamorig' + n) ?? A.model).getWorldPosition(new THREE.Vector3())]);
        pts.push(['tip', A.tipWorld(new THREE.Vector3())]);
        let best = 9,
          eff = '';
        for (const [n, p] of pts)
          for (const [s0, s1] of BODY) {
            const o0 = V.model.getObjectByName('mixamorig' + s0),
              o1 = V.model.getObjectByName('mixamorig' + s1);
            if (!o0 || !o1) continue;
            const seg = new THREE.Line3(o0.getWorldPosition(new THREE.Vector3()), o1.getWorldPosition(new THREE.Vector3()));
            const r = RAD[`${s0}-${s1}`] ?? RAD.default;
            const d = seg.closestPointToPoint(p, true, new THREE.Vector3()).distanceTo(p) - r;
            if (d < best) {
              best = d;
              eff = n;
            }
          }
        rows.push({ key: `${a}-${b}#${seed}`, id: String(e.data?.id), kind: String(e.data?.kind), t: e.t, dist: +Math.max(0, best).toFixed(3), eff });
      }
    }
    for (const v of views) v.dispose(scene);
  }
  return { rows, matches: list.length };
}
