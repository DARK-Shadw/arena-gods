/**
 * DETERMINISTIC ANIMATION VARIANT SELECTION (sim side).
 *
 * The sim picks every clip whose timing matters (hit reactions, knockdown
 * falls, get-ups, deaths, dodges, launches) from the measured library
 * (anim.gen.ts) and records the choice in the frame / events, so replays and
 * the renderer show exactly what the sim timed. It uses its OWN random stream
 * (seeded from the match seed) so animation variety never perturbs the fight
 * RNG, plus a per-fighter memory: no immediate repeats, recent picks and the
 * same clip within 8 s are strongly penalised, mirrors share a softer penalty,
 * and context features (direction / height / severity / posture / space /
 * fighter style) weight the candidates.
 */
import { ANIM, type AnimClipData } from './anim.gen';
import { Rng } from './rng';

export type Dir = 'F' | 'B' | 'L' | 'R';
export interface Ctx {
  from?: Dir;
  height?: 'head' | 'body';
  sev?: number; // 1 light .. 3 big
  /** fighter style tags: creature, acrobatic, heavy, caster ... */
  style?: string[];
  /** metres of free space behind (for deaths / falls) */
  spaceBehind?: number;
  dodgeDir?: Dir;
  /** lying posture to get up from */
  face?: string;
}

interface Cand {
  id: string;
  d: AnimClipData;
  base: string; // id without the mirror suffix
}
const base = (id: string) => id.replace(/~M$/, '');
const all: Cand[] = Object.entries(ANIM).map(([id, d]) => ({ id, d, base: base(id) }));
const trav = (d: AnimClipData) => Math.hypot(d.travel[0], d.travel[1]);

/** Library pools (filtered once). */
export const POOLS = {
  hit: all.filter((c) => c.d.role === 'hit' && c.d.posture[0] === 'stand' && c.d.posture[1] === 'stand' && trav(c.d) <= 1.3 && c.d.dur <= 3.0 && (c.d.exc ?? 0) >= 0.08),
  knockdown: all.filter((c) => c.d.role === 'knockdown' && c.d.posture[0] === 'stand' && c.d.groundT > 0 && c.d.groundT <= 1.6),
  getup: all.filter((c) => c.d.role === 'getup' && c.d.dur <= 3.1),
  death: all.filter((c) => c.d.role === 'death' && c.d.posture[0] !== 'ground' && c.d.groundT > 0),
  launch: all.filter((c) => (c.d.role === 'launch' || (c.d.role === 'knockdown' && trav(c.d) >= 1.4)) && c.d.groundT >= 0.6),
  dodge: all.filter((c) => c.d.role === 'dodge' && c.d.posture[0] === 'stand' && trav(c.d) >= 0.18 && c.d.travelT > 0 && c.d.travelT <= 0.95),
};

const STYLE: Record<string, string[]> = {
  gorak: ['heavy', 'brute'],
  aldric: ['knight'],
  ozrel: ['caster'],
  erika: ['agile', 'archer'],
  vex: ['agile', 'acrobatic'],
  fenrik: ['creature', 'agile'],
  maw: ['creature', 'heavy'],
  hollowjack: ['brute'],
};
export const styleOf = (fid: string) => STYLE[fid] ?? [];

interface Memory {
  last: Record<string, string>;
  recent: Record<string, { id: string; t: number }[]>;
}

export class AnimSelector {
  private rng: Rng;
  private mem: Memory[] = [
    { last: {}, recent: {} },
    { last: {}, recent: {} },
  ];
  constructor(seed: number) {
    this.rng = new Rng((seed ^ 0x5eed5a11) >>> 0);
  }

  /** weighted index from the animation stream */
  pickIndex(w: number[]): number {
    const i = this.rng.weighted(w);
    return i < 0 ? 0 : i;
  }
  /** uniform [0,1) from the animation stream (launch rolls) */
  roll(): number {
    return this.rng.next();
  }

  private pick(fi: number, pool: string, cands: Cand[], score: (c: Cand) => number, t: number): string {
    const m = this.mem[fi];
    const recent = (m.recent[pool] ??= []);
    while (recent.length && t - recent[0].t > 30) recent.shift();
    const w = cands.map((c) => {
      let s = score(c);
      if (s <= 0) return 0;
      if (m.last[pool] === c.id) return 0; // never the same clip twice in a row
      for (const r of recent) {
        const dt = t - r.t;
        if (r.id === c.id) s *= dt < 8 ? 0.05 : dt < 20 ? 0.35 : 0.7;
        else if (base(r.id) === c.base) s *= dt < 8 ? 0.45 : 0.85; // its mirror: softer
      }
      return s;
    });
    let i = this.rng.weighted(w);
    if (i < 0) {
      // everything excluded: fall back to any candidate except the last
      const alt = cands.filter((c) => c.id !== m.last[pool]);
      if (!alt.length) return cands[0]?.id ?? '';
      i = cands.indexOf(alt[Math.floor(this.rng.next() * alt.length)]);
    }
    const id = cands[i].id;
    m.last[pool] = id;
    recent.push({ id, t });
    return id;
  }

  hit(fi: number, t: number, ctx: Ctx): string {
    const style = ctx.style ?? [];
    return this.pick(fi, 'hit', POOLS.hit, (c) => {
      const d = c.d;
      if (d.tags.includes('creature') && !style.includes('creature')) return 0;
      let s = 1;
      if (ctx.from) s *= d.from === ctx.from ? 3 : (ctx.from === 'F' && d.from === 'B') || (ctx.from === 'B' && d.from === 'F') ? 0.05 : 0.35;
      if (ctx.height) s *= d.height === ctx.height ? 1.6 : 0.8;
      const sev = ctx.sev ?? 2;
      s *= d.sev === sev ? 2 : Math.abs((d.sev ?? 2) - sev) === 1 ? 0.8 : 0.25;
      if (d.dur < 0.6) s *= 0.4; // too short to read
      return s;
    }, t);
  }

  knockdown(fi: number, t: number, ctx: Ctx): string {
    return this.pick(fi, 'knockdown', POOLS.knockdown, (c) => {
      const d = c.d;
      let s = 1;
      if (ctx.from) s *= d.from === ctx.from ? 3 : 0.4;
      // falling a long way backwards into a wall looks wrong: prefer short falls when cornered
      if (ctx.spaceBehind !== undefined && trav(d) > ctx.spaceBehind) s *= 0.2;
      if (d.tags.includes('wall')) s *= 0.15;
      return s;
    }, t);
  }

  getup(fi: number, t: number, ctx: Ctx): string {
    const style = ctx.style ?? [];
    return this.pick(fi, 'getup', POOLS.getup, (c) => {
      const d = c.d;
      let s = 1;
      if (ctx.face) s *= d.startFace === ctx.face ? 4 : ctx.face === 'side' || d.startFace === 'side' ? 1 : 0.15;
      if (d.tags.includes('acrobatic')) s *= style.includes('agile') || style.includes('acrobatic') ? 2.5 : 0.25;
      if (d.tags.includes('creature')) s *= style.includes('creature') ? 2 : 0.1;
      return s;
    }, t);
  }

  death(fi: number, t: number, ctx: Ctx): string {
    const style = ctx.style ?? [];
    return this.pick(fi, 'death', POOLS.death, (c) => {
      const d = c.d;
      let s = 1;
      if (d.tags.includes('creature') && !style.includes('creature')) s *= 0.15;
      if (ctx.from) s *= d.from === ctx.from ? 2 : 0.6;
      if ((ctx.sev ?? 2) >= 3) s *= (d.sev ?? 2) >= 3 ? 1.6 : 0.7;
      if (ctx.spaceBehind !== undefined && trav(d) > ctx.spaceBehind + 0.3) s *= 0.25;
      return s;
    }, t);
  }

  launch(fi: number, t: number, lethal: boolean, ctx: Ctx = {}): string {
    return this.pick(fi, 'launch', POOLS.launch, (c) => {
      // real flying falls first; big travelling knockdowns as variety
      let s = c.d.role === 'launch' ? 2 : 1;
      if (ctx.from) s *= c.d.from === ctx.from ? 4 : 0.05;
      if (lethal && c.d.tags.includes('wall')) s *= 0.3;
      return s;
    }, t);
  }

  dodge(fi: number, t: number, ctx: Ctx): string {
    const style = ctx.style ?? [];
    return this.pick(fi, 'dodge', POOLS.dodge, (c) => {
      const d = c.d;
      if (!ctx.dodgeDir) return 1;
      let s = d.dir === ctx.dodgeDir ? 3 : 0.02;
      if (d.travelT > 0.8) s *= style.includes('agile') ? 1 : 0.3;
      return s;
    }, t);
  }
}

export function clipData(id: string): AnimClipData | undefined {
  return ANIM[id];
}
