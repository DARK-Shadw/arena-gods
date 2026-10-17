/**
 * ANIMATION QUALITY AUDIT (debug tool, browser, real rigs, no rendering).
 *
 * Plays recorded matches through the FighterViews at the sim rate and measures:
 *  - transition pops: peak joint acceleration (head / chest / hands / feet,
 *    relative to the fighter root) in the 4 frames after every clip
 *    transition, against the clip-internal baseline
 *  - foot sliding: share of "planted" frames (foot within 4 cm of its
 *    ground level) where the foot moves horizontally faster than 0.35 m/s
 *  - clip usage per pool (for the repetition / variety metrics)
 *  - CPU cost of the per-fighter animation update
 *
 *   await __arena.animAudit([['gorak','vex']], 2, { blend: 'xfade' | 'inertial' })
 */
import * as THREE from 'three';
import { simulate } from '../sim/match';
import { FighterView } from './fighterView';
import { initLib } from './animLib';
import { LOCO_MAX_RATE, loadCharacter, setBlendMode, setFootLock, setLocoMaxRate } from './character';
import type { MatchRecord } from '../sim/types';

export interface AnimAuditResult {
  feet: boolean;
  blend: string;
  matches: number;
  frames: number;
  transitions: number;
  /** m/s^2 */
  transPeakP50: number;
  transPeakP95: number;
  allAccP50: number;
  allAccP95: number;
  /** transitions whose peak joint acceleration exceeds 3x the all-frame p95 */
  popRate: number;
  footPlanted: number;
  footSkateRatio: number;
  /** ms per fighter update (mean) */
  updateMs: number;
  usage: Record<string, string[]>;
}

const JOINTS = ['Head', 'Spine2', 'LeftHand', 'RightHand', 'LeftFoot', 'RightFoot'];

export async function runAnimAudit(scene: THREE.Scene, pairs: [string, string][], seeds: number, opts: { blend?: 'inertial' | 'xfade'; arenaSeed?: number; feet?: boolean; locoRate?: number } = {}): Promise<AnimAuditResult> {
  setBlendMode(opts.blend ?? 'inertial');
  setFootLock(opts.feet ?? true);
  const prevRate = LOCO_MAX_RATE;
  if (opts.locoRate) setLocoMaxRate(opts.locoRate);
  const transPeaks: number[] = [];
  const allAcc: number[] = [];
  let planted = 0,
    skate = 0,
    frames = 0,
    transitions = 0,
    matches = 0,
    upd = 0,
    updN = 0;
  const usage: Record<string, string[]> = {};
  for (const [a, b] of pairs) {
    const [assets] = await Promise.all([Promise.all([loadCharacter(a), loadCharacter(b)]), initLib('core')]);
    for (let s = 1; s <= seeds; s++) {
      const seed = s * 7919 + a.length * 31 + b.length;
      const rec: MatchRecord = simulate(a, b, seed);
      matches++;
      const views = [new FighterView(a, assets[0], scene), new FighterView(b, assets[1], scene)];
      await Promise.all(views.map((v) => v.ready));
      const bones = views.map((v) => JOINTS.map((j) => v.model.getObjectByName('mixamorig' + j) ?? v.model));
      const hist = views.map(() => [] as THREE.Vector3[][]);
      const footPrev = views.map(() => [new THREE.Vector3(), new THREE.Vector3()]);
      const footS = views.map(() => [] as [number, number, number][]);
      const toes = views.map((v) => ['LeftToeBase', 'RightToeBase'].map((j) => v.model.getObjectByName('mixamorig' + j) ?? v.model));
      const window = [0, 0];
      const winPeak = [0, 0];
      const dt = rec.dt;
      let ev = 0;
      for (let i = 0; i < rec.frames.length; i++) {
        const fr = rec.frames[i];
        while (ev < rec.events.length && rec.events[ev].t <= fr.t + 1e-6) {
          const e = rec.events[ev++];
          if (e.type === 'hit' && e.b !== undefined && e.b >= 0) views[e.b].onHit(views[e.a].position, e.data?.heavy ? 1.6 : 0.85);
          for (const k of [0, 1]) views[k].onEvent?.(e, rec);
        }
        for (let k = 0; k < 2; k++) {
          const t0 = performance.now();
          views[k].updateFromFrame(fr.f[k], dt, fr.f[1 - k], dt);
          upd += performance.now() - t0;
          updN++;
          const v = views[k];
          v.root.updateMatrixWorld(true);
          const inv = new THREE.Matrix4().copy(v.root.matrixWorld).invert();
          const pts = bones[k].map((o) => o.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv));
          const h = hist[k];
          h.push(pts);
          if (h.length > 3) h.shift();
          if (v.anim.justTransitioned) {
            if (window[k] > 0) transPeaks.push(winPeak[k]);
            window[k] = 5;
            winPeak[k] = 0;
            transitions++;
          }
          if (h.length === 3) {
            let peak = 0;
            for (let j = 0; j < pts.length; j++) {
              const acc = Math.hypot(h[2][j].x - 2 * h[1][j].x + h[0][j].x, h[2][j].y - 2 * h[1][j].y + h[0][j].y, h[2][j].z - 2 * h[1][j].z + h[0][j].z) / (dt * dt);
              peak = Math.max(peak, acc);
            }
            if (fr.f[k].state !== 'dead') allAcc.push(peak);
            if (window[k] > 0) {
              winPeak[k] = Math.max(winPeak[k], peak);
              window[k]--;
              if (window[k] === 0) transPeaks.push(winPeak[k]);
            }
          }
          // feet (world space): collect height / horizontal speed / vertical speed per toe while on the move
          const feet = [toes[k][0], toes[k][1]];
          feet.forEach((f, fi) => {
            const p = f.getWorldPosition(new THREE.Vector3());
            const st = fr.f[k].state;
            if (i > 2 && (st === 'idle' || st === 'block')) {
              const sp = Math.hypot(p.x - footPrev[k][fi].x, p.z - footPrev[k][fi].z) / dt;
              const vy = Math.abs(p.y - footPrev[k][fi].y) / dt;
              footS[k].push([p.y, sp, vy]);
            }
            footPrev[k][fi].copy(p);
          });
        }
        frames++;
      }
      // planted = within 3 cm of this fighter's typical toe ground height and not lifting
      for (const fs of footS) {
        const ys = fs.map((x) => x[0]).sort((x, y) => x - y);
        const ref = ys.length ? ys[Math.floor(ys.length * 0.1)] : 0;
        for (const [y, sp, vy] of fs)
          if (y < ref + 0.03 && vy < 0.25) {
            planted++;
            if (sp > 0.35) skate++;
          }
      }
      for (const v of views) {
        for (const [pool, ids] of Object.entries(v.usage)) (usage[`${v.def.id}:${pool}`] ??= []).push(...ids, '|');
        v.dispose(scene);
      }
    }
  }
  const q = (arr: number[], p: number) => {
    const s = [...arr].sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
  };
  const allP95 = q(allAcc, 0.95);
  setBlendMode('inertial');
  setFootLock(true);
  setLocoMaxRate(prevRate);
  return {
    feet: opts.feet ?? true,
    blend: opts.blend ?? 'inertial',
    matches,
    frames,
    transitions,
    transPeakP50: +q(transPeaks, 0.5).toFixed(1),
    transPeakP95: +q(transPeaks, 0.95).toFixed(1),
    allAccP50: +q(allAcc, 0.5).toFixed(1),
    allAccP95: +allP95.toFixed(1),
    popRate: +(transPeaks.filter((x) => x > allP95 * 3).length / Math.max(1, transPeaks.length)).toFixed(4),
    footPlanted: planted,
    footSkateRatio: +(skate / Math.max(1, planted)).toFixed(4),
    updateMs: +(upd / Math.max(1, updN)).toFixed(3),
    usage,
  };
}
