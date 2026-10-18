/**
 * FINISHERS (sim side, deterministic): MK-style two-person scenes that replace
 * a killing blow.
 *
 *  pair   - both fighters play the two roles of a solved paired clip
 *           (src/sim/scenes.gen.ts): positions follow the roles' root curves in a
 *           scene frame anchored on the attacker, damage / the kill happen on
 *           the frames where the bodies measurably touch.
 *  downed - the killing blow knocks the victim down; the attacker walks up and
 *           executes the lying victim (own downward heavy, or a stomp); the kill
 *           is the strike point reaching the body (reach data).
 *  launch - the killing blow launches the victim INTO a hazard (lava, fire,
 *           spikes) on the sim's ballistic arc.
 *
 * The blow that triggers a finisher is already lethal: the finisher only
 * decides HOW the fighter dies (the winner never changes), and the kill still
 * happens on a visible contact frame.
 */
import { SCENES, type SceneGen } from './scenes.gen';
import { ANIM } from './anim.gen';
import { REACH } from './reach.gen';
import { atan2, cos, hypot, sin } from './dmath';

export type GoreFx = 'crush' | 'drain' | 'behead' | 'bisect' | 'burn' | 'shatter' | 'impale' | 'dissolve';

export interface FinisherDef {
  id: string;
  name: string;
  kind: 'pair' | 'downed' | 'launch' | 'spell';
  users: string[];
  /** pair: solved scene id + clip window [from, to] (seconds, scene clock = clip clock) */
  scene?: string;
  trim?: [number, number];
  /** pair: non-lethal contacts before the kill: [clip seconds, attacker effector] - only frames where
   * tools/anim/scenes.ts MEASURED the effector touching the victim's body */
  hits?: [number, string][];
  /** pair: the killing contact (clip seconds) and the attacker effector that makes it (measured) */
  kill?: number;
  killEff?: string;
  /** downed: attacker clip per fighter ('own:<move>' uses the fighter's move clip + reach data, 'lib:<id>' a library clip) */
  exec?: Record<string, string>;
  /** finisher FX (render, filtered by the gore setting) */
  fx: GoreFx | Record<string, GoreFx>;
  weight: number;
  /** attacker must be at least this heavy (pair scenes with lifting) */
  minWeight?: number;
  /** victim no heavier than this */
  maxVictimWeight?: number;
}

export const FINISHERS: FinisherDef[] = [
  { id: 'shoulder_throw_stomp', name: 'SHOULDER THROW', kind: 'pair', users: ['aldric', 'hollowjack', 'fenrik', 'gorak'], scene: 'shoulder_throw', trim: [2.7, 6.3], hits: [], kill: 5.03, killEff: 'RightFoot', fx: 'crush', weight: 1, maxVictimWeight: 1.6 },
  { id: 'hell_slammer', name: 'HELL SLAMMER', kind: 'pair', users: ['maw', 'gorak', 'hollowjack'], scene: 'hell_slammer', trim: [0.9, 7.2], hits: [[1.4, 'RightHand'], [2.433, 'RightHand'], [3.433, 'RightHand']], kill: 5.47, fx: 'crush', weight: 1.4, minWeight: 1.3, maxVictimWeight: 1.6 },
  { id: 'vampire_kiss', name: "VAMPIRE'S KISS", kind: 'pair', users: ['vex'], scene: 'vampire_kiss', trim: [0.3, 4.0], hits: [[1.167, 'LeftHand']], kill: 1.97, killEff: 'RightHand', fx: 'drain', weight: 2.5 },
  { id: 'silent_blade', name: 'SILENT BLADE', kind: 'pair', users: ['vex', 'erika'], scene: 'silent_blade', trim: [2.2, 6.6], hits: [[2.433, 'RightHand']], kill: 3.5, killEff: 'LeftHand', fx: 'behead', weight: 1.2 },
  {
    id: 'executioner',
    name: 'EXECUTIONER',
    kind: 'downed',
    // (Aldric's two-handed plunge was cut: on a lying body its blade stops ~0.16 m short on our rigs)
    // (Hollowjack's two-fist slam was cut too: the fists land beside a lying body, 0.16 m off)
    users: ['gorak', 'maw'],
    exec: { gorak: 'own:skull_crack', maw: 'own:hammer_of_ages' },
    fx: { gorak: 'behead', maw: 'crush' },
    weight: 1.3,
  },
  { id: 'curb_stomp', name: 'CURB STOMP', kind: 'downed', users: ['gorak', 'maw', 'hollowjack', 'fenrik', 'aldric', 'vex'], exec: { '*': 'lib:Stomp' }, fx: 'crush', weight: 0.9 },
  { id: 'into_the_fire', name: 'INTO THE FIRE', kind: 'launch', users: ['*'], fx: 'burn', weight: 5.0 },
  // spell finisher: the caster holds the staggered victim in the flames (no contact: the burn starts on the cast's release frame)
  { id: 'immolation', name: 'IMMOLATION', kind: 'spell', users: ['ozrel'], exec: { ozrel: 'own:flame_lash' }, fx: 'burn', weight: 2.0 },
];

export const FIN_BY_ID: Record<string, FinisherDef> = Object.fromEntries(FINISHERS.map((f) => [f.id, f]));

/** hips height (m) per fighter = scale of the authored clips on that rig (public/models/<id>.json: hipsY * 0.01 * scale) */
export const HIPS_M: Record<string, number> = { gorak: 1.219, aldric: 1.032, ozrel: 1.201, erika: 1.042, vex: 1.121, fenrik: 0.926, maw: 0.974, hollowjack: 1.013 };

/**
 * Rigs whose neck split is clean (lab check, docs/milestones/M4): the others keep hood / fused
 * head geometry on the body, so a beheading falls back to the blade cut.
 */
export const BEHEAD_CLEAN = new Set(['gorak', 'aldric', 'vex', 'fenrik', 'hollowjack']);

export function fxOf(f: FinisherDef, att: string): GoreFx {
  return typeof f.fx === 'string' ? f.fx : f.fx[att] ?? 'crush';
}

/** root curve sample (scene frame, hips units) at clip time t (10 Hz table) */
export function sceneRoot(curve: number[], t: number): [number, number] {
  const f = Math.max(0, t * 10);
  const n = curve.length / 2;
  const i = Math.min(n - 1, Math.floor(f)),
    j = Math.min(n - 1, i + 1),
    k = Math.min(1, f - i);
  return [curve[i * 2] + (curve[j * 2] - curve[i * 2]) * k, curve[i * 2 + 1] + (curve[j * 2 + 1] - curve[i * 2 + 1]) * k];
}
export function sceneOf(f: FinisherDef): SceneGen | undefined {
  return f.scene ? SCENES[f.scene] : undefined;
}

/**
 * Execution placement (downed): attacker clip, the clip time of the killing
 * contact, and where the strike point is at that moment relative to the
 * attacker root (character space, metres: x left, z forward).
 */
export function execInfo(attId: string, f: FinisherDef): { clip: string; t: number; off: [number, number]; dur: number; eff?: string } | null {
  const ref = f.exec?.[attId] ?? f.exec?.['*'];
  if (!ref) return null;
  if (ref.startsWith('own:')) {
    const mv = ref.slice(4);
    const r = REACH[attId]?.[mv];
    if (!r) return null;
    // the strike point coming down to body height on a lying victim (<= 0.35 m), at or after the strike frame
    let best = r.pts[0];
    for (const p of r.pts) {
      if (p[0] < r.strike - 0.05) continue;
      const y = p.length > 4 ? Math.min(p[2], p[5]) : p[2];
      best = p;
      if (y <= 0.35) break;
    }
    const tip = best.length > 4 ? [best[4], best[6]] : [best[1], best[3]];
    return { clip: ref, t: best[0], off: [tip[0], tip[1]], dur: r.dur };
  }
  const id = ref.slice(4);
  const d = ANIM[id] as unknown as { dur: number; impacts?: [number, string][]; impactPos?: [number, number, number][] };
  if (!d) return null;
  const k = Math.max(0, d.impacts?.findIndex((x) => x[1] !== 'Head' && x[1] !== 'Spine2') ?? 0);
  const imp = d.impacts?.[k];
  // measured: where the stomping foot / plunging hand is relative to the root on that frame
  const p = d.impactPos?.[k] ?? [0.05, 0, 0.5];
  const h = HIPS_M[attId] ?? 1;
  return { clip: id, t: imp ? imp[0] : d.dur * 0.5, off: [p[0] * h, p[2] * h], dur: d.dur, eff: imp?.[1] };
}

/** rotate a scene-frame (x, z) offset by the scene yaw (world facing angle) */
export function sceneToWorld(ox: number, oz: number, yaw: number, x: number, z: number): [number, number] {
  return [ox + x * cos(yaw) + z * sin(yaw), oz - x * sin(yaw) + z * cos(yaw)];
}
export const angleOf = (dx: number, dz: number) => atan2(dx, dz);
export const dist2 = (ax: number, az: number, bx: number, bz: number) => hypot(ax - bx, az - bz);
