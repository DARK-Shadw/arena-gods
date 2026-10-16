/**
 * Animation-consistent attack geometry for the sim.
 *
 * REACH (generated from the Mixamo clips by tools/convert) gives, for every
 * move, the strike point (striking hand/foot, plus the weapon tip for armed
 * fighters) sampled around the contact frame in character space (+Z forward,
 * +X = the character's left, metres). The sim maps active-window progress to
 * clip time exactly like the renderer's time-warp, so the point it tests for
 * contact is where the viewer sees the weapon at that moment.
 */
import { cos, hypot, sin } from './dmath';
import { REACH, type ReachClip } from './reach.gen';
import type { MoveDef } from './types';

export interface MoveReach {
  clip: ReachClip;
  /** contact strike clip time */
  s: number;
  /** end of the active segment in clip time */
  aEnd: number;
  /** max forward reach of any strike point (m, from character centre) */
  maxFwd: number;
  /** max horizontal radius of any strike point */
  maxRad: number;
}

const cache = new Map<string, MoveReach | null>();

export function moveReach(fid: string, mv: MoveDef): MoveReach | null {
  const key = `${fid}:${mv.id}`;
  if (cache.has(key)) return cache.get(key)!;
  const clip = REACH[fid]?.[mv.id];
  let r: MoveReach | null = null;
  if (clip) {
    const s = clip.strike;
    let aEnd = s + 0.12;
    const hits = mv.hits ?? 1;
    if (!clip.loopActive && hits > 1 && clip.peaks.length > 1) aEnd = Math.max(aEnd, clip.peaks[clip.peaks.length - 1] + 0.1);
    aEnd = Math.min(clip.dur - 0.05, aEnd);
    let maxFwd = 0,
      maxRad = 0;
    for (const p of clip.pts) {
      if (p[0] < s - 0.1 || p[0] > aEnd + 0.05) continue;
      for (let o = 1; o + 2 < p.length; o += 3) {
        maxFwd = Math.max(maxFwd, p[o + 2]);
        maxRad = Math.max(maxRad, hypot(p[o], p[o + 2]));
      }
    }
    r = { clip, s, aEnd, maxFwd, maxRad };
  }
  cache.set(key, r);
  return r;
}

/**
 * Clip time for an attack at (phase, k). MUST match FighterView.warpAttack.
 * phase 0 windup, 1 active, 2 recovery; k = 0..1 progress in the phase.
 */
export function clipTime(r: MoveReach, mv: MoveDef, phase: number, k: number): number {
  const st = Math.min(r.clip.start, r.s - 0.05);
  if (phase === 0) return st + (r.s - st) * k;
  if (phase === 1) {
    if (r.clip.loopActive) {
      const hits = mv.hits ?? 1;
      const seg = (k * hits) % 1;
      return Math.max(0, r.s - 0.2) + seg * 0.32;
    }
    return r.s + (r.aEnd - r.s) * k;
  }
  return r.aEnd;
}

/** Interpolated strike points at clip time t: returns 1 or 2 points [x,y,z]. */
export function strikePoints(r: MoveReach, t: number): number[][] {
  const pts = r.clip.pts;
  let i = 0;
  while (i < pts.length - 2 && pts[i + 1][0] < t) i++;
  const a = pts[i],
    b = pts[Math.min(pts.length - 1, i + 1)];
  const span = b[0] - a[0];
  const u = span > 1e-6 ? Math.max(0, Math.min(1, (t - a[0]) / span)) : 0;
  const out: number[][] = [];
  for (let o = 1; o + 2 < a.length; o += 3) out.push([a[o] + (b[o] - a[o]) * u, a[o + 1] + (b[o + 1] - a[o + 1]) * u, a[o + 2] + (b[o + 2] - a[o + 2]) * u]);
  return out;
}

/** Character-space point -> world (facing f: forward = (sin f, cos f), left = (cos f, -sin f)). */
export function toWorld(px: number, pz: number, f: number, lx: number, ly: number, lz: number): [number, number, number] {
  const s = sin(f),
    c = cos(f);
  return [px + lx * c + lz * s, ly, pz - lx * s + lz * c];
}

/** Closest distance between segment P0P1 and segment Q0Q1 (3D). */
export function segSegDist(p0: number[], p1: number[], q0: number[], q1: number[]): number {
  const d1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const d2 = [q1[0] - q0[0], q1[1] - q0[1], q1[2] - q0[2]];
  const r = [p0[0] - q0[0], p0[1] - q0[1], p0[2] - q0[2]];
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const a = dot(d1, d1),
    e = dot(d2, d2),
    f = dot(d2, r);
  let s = 0,
    t = 0;
  if (a <= 1e-9 && e <= 1e-9) return Math.sqrt(dot(r, r));
  if (a <= 1e-9) t = Math.max(0, Math.min(1, f / e));
  else {
    const c = dot(d1, r);
    if (e <= 1e-9) s = Math.max(0, Math.min(1, -c / a));
    else {
      const b = dot(d1, d2);
      const den = a * e - b * b;
      s = den > 1e-9 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }
  const cp = [p0[0] + d1[0] * s - (q0[0] + d2[0] * t), p0[1] + d1[1] * s - (q0[1] + d2[1] * t), p0[2] + d1[2] * s - (q0[2] + d2[2] * t)];
  return Math.sqrt(dot(cp, cp));
}

/** Edge-to-edge reach of a move for AI spacing (excluding lunge). */
export function edgeReach(fid: string, mv: MoveDef, selfRadius: number): number {
  if (mv.ranged) return mv.range;
  const r = moveReach(fid, mv);
  if (!r) return mv.range - selfRadius;
  const wave = mv.aoe && (mv.fx === 'quake' || mv.fx === 'nova' || mv.fx === 'holy') ? mv.range + selfRadius : 0;
  const reach = mv.aoe ? Math.max(r.maxRad, wave) : r.maxFwd;
  return Math.max(0.05, reach + 0.2 - selfRadius);
}
