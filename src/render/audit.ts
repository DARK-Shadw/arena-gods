/**
 * PHANTOM-HIT AUDIT (debug tool, runs in the browser with the real rigs).
 *
 * Plays recorded matches through the actual FighterViews (no rendering) and,
 * at every hit event, measures the distance from the attacker's RENDERED
 * striking point (effector bone / weapon tip of the move's clip) to the
 * defender's body capsule. Projectile hits are measured from the projectile's
 * last recorded position. Usage (devtools / Playwright):
 *   await __arena.audit([['gorak','vex'], ...], seedsPerPair)
 */
import * as THREE from 'three';
import { simulate } from '../sim/match';
import { getFighter } from '../sim/fighters';
import { FighterView } from './fighterView';
import { initLib } from './animLib';
import { loadCharacter } from './character';
import type { MatchRecord } from '../sim/types';

export interface AuditRow {
  pair: string;
  seed: number;
  t: number;
  move: string;
  ranged: boolean;
  dist: number; // metres from strike point to capsule surface (<= 0 = touching)
  kill: boolean;
}

/** distance from a segment (the strike point's motion over the last rendered frame) to the capsule surface */
function segCapsuleDist(a: THREE.Vector3, b: THREE.Vector3, x: number, z: number, r: number, top: number): number {
  let best = 1e9;
  for (let i = 0; i <= 8; i++) best = Math.min(best, capsuleDist(a.clone().lerp(b, i / 8), x, z, r, top));
  return best;
}

function capsuleDist(p: THREE.Vector3, x: number, z: number, r: number, top: number): number {
  const y = Math.max(0.15, Math.min(top, p.y));
  return Math.hypot(p.x - x, p.y - y, p.z - z) - r;
}

export async function runAudit(scene: THREE.Scene, pairs: [string, string][], seeds: number): Promise<{ rows: AuditRow[]; deathsWithoutHit: number; matches: number }> {
  const rows: AuditRow[] = [];
  let deathsWithoutHit = 0;
  let matches = 0;
  for (const [a, b] of pairs) {
    const [assets] = await Promise.all([Promise.all([loadCharacter(a), loadCharacter(b)]), initLib('core')]);
    for (let s = 1; s <= seeds; s++) {
      const seed = s * 7919 + a.length * 31 + b.length;
      const rec: MatchRecord = simulate(a, b, seed);
      matches++;
      const views = [new FighterView(a, assets[0], scene), new FighterView(b, assets[1], scene)];
      const defs = [getFighter(a), getFighter(b)];
      const hits = rec.events.filter((e) => e.type === 'hit' || e.type === 'prop_hit');
      const kill = rec.events.find((e) => e.type === 'kill');
      const contactAt = (t: number, victim: number | undefined) =>
        rec.events.some(
          (e) =>
            Math.abs(e.t - t) < 0.02 &&
            (((e.type === 'hit' || e.type === 'prop_hit' || e.type === 'crush' || e.type === 'hazard_hit') && e.b === victim) || (e.type === 'finisher_contact' && e.data?.kind === 'kill' && e.b === victim) || e.type === 'wall_slam' || e.type === 'pillar_slam' || e.type === 'explosion'),
        );
      if (kill && !contactAt(kill.t, kill.b)) deathsWithoutHit++;
      let hi = 0;
      const prevPts: (THREE.Vector3[] | null)[] = [null, null];
      for (let i = 0; i < rec.frames.length && hi < hits.length; i++) {
        const fr = rec.frames[i];
        for (let k = 0; k < 2; k++) views[k].updateFromFrame(fr.f[k], rec.dt, fr.f[1 - k]);
        const curPts = [0, 1].map((k) => (fr.f[k].moveId ? views[k].strikePointsWorld(fr.f[k].moveId) : null));
        while (hi < hits.length && hits[hi].t <= fr.t + 1e-4) {
          const e = hits[hi++];
          if (e.type === 'prop_hit') {
            // thrown prop: measure from its last recorded position (previous frame) minus one step
            const pi = Number(e.data?.prop);
            const P = rec.frames[Math.max(0, i - 1)].props,
              P2 = rec.frames[Math.max(0, i - 2)].props;
            const def = fr.f[e.b!];
            const top = defs[e.b!].id === 'maw' ? 2.35 : 2.05;
            const pos = new THREE.Vector3(P[pi * 6], P[pi * 6 + 1], P[pi * 6 + 2]);
            const step = P2.length > pi * 6 + 2 ? Math.hypot(P[pi * 6] - P2[pi * 6], P[pi * 6 + 1] - P2[pi * 6 + 1], P[pi * 6 + 2] - P2[pi * 6 + 2]) : 0.3;
            const dist = Math.max(-0.05, capsuleDist(pos, def.x, def.z, defs[e.b!].stats.radius + 0.34, top) - step);
            rows.push({ pair: `${a}-${b}`, seed, t: e.t, move: `thrown.${e.data?.kind}`, ranged: true, dist: +dist.toFixed(3), kill: !!kill && Math.abs(kill.t - e.t) < 0.02 });
            continue;
          }
          const mv = defs[e.a].moves.find((m) => m.id === e.data?.move);
          const def = fr.f[e.b!];
          const top = e.b !== undefined && defs[e.b].id === 'maw' ? 2.35 : 2.05;
          const r = defs[e.b!].stats.radius;
          let dist: number;
          if (mv?.ranged) {
            // the projectile that hit was last recorded in the previous frame
            // the projectile was last recorded in the previous frame; it then travelled one more step
            const prev = rec.frames[Math.max(0, i - 1)].proj.filter((p) => p.o === e.a);
            const prev2 = rec.frames[Math.max(0, i - 2)].proj;
            dist = prev.length
              ? Math.min(
                  ...prev.map((p) => {
                    const q = prev2.find((x) => x.id === p.id);
                    const step = q ? Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) : 0.5;
                    return Math.max(-0.05, capsuleDist(new THREE.Vector3(p.x, p.y, p.z), def.x, def.z, r, top) - step);
                  }),
                )
              : 0; // spawned and hit within one tick (point blank)
          } else if (mv?.aoe) {
            dist = Math.hypot(def.x - fr.f[e.a].x, def.z - fr.f[e.a].z) - r - (mv.range + defs[e.a].stats.radius);
          } else {
            // swept over the last rendered frame (what a viewer perceives at 60 fps)
            const pts = views[e.a].strikePointsWorld(String(e.data?.move));
            const before = prevPts[e.a] && prevPts[e.a]!.length === pts.length ? prevPts[e.a]! : pts;
            dist = Math.min(...pts.map((p, j) => segCapsuleDist(before[j], p, def.x, def.z, r, top)));
            if (dist > 0.4 && (globalThis as unknown as { __auditDebug?: unknown[] }).__auditDebug) {
              const att = fr.f[e.a];
              (globalThis as unknown as { __auditDebug: unknown[] }).__auditDebug.push({ move: e.data?.move, dist, attState: att.state, phase: att.phase, phaseT: att.phaseT, moveId: att.moveId, pts: pts.map((p) => p.toArray().map((v) => +v.toFixed(2))), att: [att.x, att.z, att.facing].map((v) => +v.toFixed(2)), def: [def.x, def.z].map((v) => +v.toFixed(2)), clip: views[e.a].anim.current });
            }
          }
          rows.push({ pair: `${a}-${b}`, seed, t: e.t, move: `${defs[e.a].id}.${e.data?.move}`, ranged: !!mv?.ranged, dist: +dist.toFixed(3), kill: !!kill && Math.abs(kill.t - e.t) < 0.02 });
        }
        prevPts[0] = curPts[0];
        prevPts[1] = curPts[1];
      }
      for (const v of views) v.dispose(scene);
      void prevPts;
    }
  }
  return { rows, deathsWithoutHit, matches };
}
