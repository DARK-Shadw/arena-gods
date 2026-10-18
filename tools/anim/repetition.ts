/**
 * ANIMATION VARIETY / REPETITION METRICS (headless, from recorded matches).
 *
 *   npx tsx tools/anim/repetition.ts [seedsPerPair=4] [--json out.json]
 *
 * Clip choices are read from the recorded frames (the sim records the clip of
 * every reaction / fall / get-up / death / dodge / launch). For comparison the
 * same events are also mapped through the OLD fixed scheme (one clip per
 * direction for hits, one death, one get-up, the death clip for knockdowns,
 * three shared dodges).
 *
 *  R1 immediate repeat rate   same clip on consecutive uses of a pool      target 0%
 *  R2 near repeat             same clip within 8 s in the same pool        target < 10%
 *  R3 pool entropy            normalised Shannon entropy per match/pool    target >= 0.8 (>= 4 picks)
 *  R4 top-clip share          largest single-clip share per fighter/pool   target <= 25% (pools >= 6)
 *  R5 death uniqueness        min distinct deaths in any 10 consecutive    target >= 6
 */
import * as fs from 'node:fs';
import { FIGHTERS } from '../../src/sim/fighters';
import { simulate } from '../../src/sim/match';
import { POOLS } from '../../src/sim/animSelect';
import type { MatchRecord } from '../../src/sim/types';

const args = process.argv.slice(2);
const N = Number(args.find((a) => /^\d+$/.test(a)) ?? 4);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const ids = FIGHTERS.map((f) => f.id);
const POOL_OF: Record<string, string> = { stagger: 'hit', knockdown: 'fall', getup: 'getup', dead: 'death', dodge: 'dodge', launched: 'launch' };

type Pick = { t: number; clip: string };
interface Agg {
  picks: number;
  imm: number;
  near: number;
  pairs: number;
  ent: number[];
  share: Record<string, Record<string, number>>; // fighter:pool -> clip -> count
  deaths: Record<string, string[]>;
}
const mk = (): Agg => ({ picks: 0, imm: 0, near: 0, pairs: 0, ent: [], share: {}, deaths: {} });
const NEW: Record<string, Agg> = {},
  OLD: Record<string, Agg> = {};
const POOLS_SEEN = ['hit', 'fall', 'getup', 'death', 'dodge', 'launch'];
for (const p of POOLS_SEEN) {
  NEW[p] = mk();
  OLD[p] = mk();
}

function entropy(clips: string[]): number {
  const c: Record<string, number> = {};
  for (const x of clips) c[x] = (c[x] ?? 0) + 1;
  const n = clips.length;
  let h = 0;
  for (const v of Object.values(c)) h -= (v / n) * Math.log(v / n);
  return h / Math.log(n);
}

function account(agg: Agg, fid: string, pool: string, seq: Pick[]) {
  if (!seq.length) return;
  agg.picks += seq.length;
  for (let i = 1; i < seq.length; i++) {
    agg.pairs++;
    if (seq[i].clip === seq[i - 1].clip) agg.imm++;
  }
  for (let i = 0; i < seq.length; i++) if (seq.slice(0, i).some((p) => p.clip === seq[i].clip && seq[i].t - p.t < 8)) agg.near++;
  if (seq.length >= 4) agg.ent.push(entropy(seq.map((p) => p.clip)));
  const sh = (agg.share[`${fid}:${pool}`] ??= {});
  for (const p of seq) sh[p.clip] = (sh[p.clip] ?? 0) + 1;
  if (pool === 'death') (agg.deaths[fid] ??= []).push(...seq.map((p) => p.clip));
}

/** the pre-overhaul mapping (src/render/fighterView.ts before M2) */
function oldClip(state: string, fr: { facing: number; x: number; z: number }, opp: { x: number; z: number }, vel: [number, number]): string {
  if (state === 'stagger') {
    let d = (Math.atan2(opp.x - fr.x, opp.z - fr.z) - fr.facing) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d) < Math.PI / 4 ? 'hitFront' : Math.abs(d) > (Math.PI * 3) / 4 ? 'hitBack' : d > 0 ? 'hitLeft' : 'hitRight';
  }
  if (state === 'dodge') {
    const s = Math.sin(fr.facing),
      c = Math.cos(fr.facing);
    const l = Math.hypot(vel[0], vel[1]) || 1;
    const lf = (vel[0] * s + vel[1] * c) / l,
      ls = (vel[0] * c - vel[1] * s) / l;
    return lf < -0.5 || Math.abs(ls) < 0.4 ? 'dodgeBack' : ls > 0 ? 'dodgeLeft' : 'dodgeRight';
  }
  if (state === 'knockdown' || state === 'dead' || state === 'launched') return 'death';
  if (state === 'getup') return 'getup';
  return '';
}

let matches = 0;
const t0 = Date.now();
for (let i = 0; i < ids.length; i++)
  for (let j = 0; j < ids.length; j++) {
    if (i === j) continue;
    for (let s = 1; s <= N; s++) {
      const rec: MatchRecord = simulate(ids[i], ids[j], s * 7919 + i * 131 + j * 17);
      matches++;
      for (let k = 0; k < 2; k++) {
        const fid = rec.ids[k];
        const seqN: Record<string, Pick[]> = {},
          seqO: Record<string, Pick[]> = {};
        let prevState = '',
          prevClip = '';
        for (let fi = 0; fi < rec.frames.length; fi++) {
          const fr = rec.frames[fi].f[k];
          const pool = POOL_OF[fr.state];
          const entering = fr.state !== prevState || (fr.clip && fr.clip !== prevClip && fr.state !== 'knockdown');
          if (pool && entering && !(fr.state === 'knockdown' && prevState === 'launched')) {
            if (fr.clip) (seqN[pool] ??= []).push({ t: rec.frames[fi].t, clip: fr.clip });
            const prev = rec.frames[Math.max(0, fi - 1)].f[k];
            const oc = oldClip(fr.state, fr, rec.frames[fi].f[1 - k], [fr.x - prev.x, fr.z - prev.z]);
            const oldPool = fr.state === 'launched' ? 'fall' : pool;
            if (oc) (seqO[oldPool] ??= []).push({ t: rec.frames[fi].t, clip: oc });
          }
          prevState = fr.state;
          prevClip = fr.clip;
        }
        for (const p of POOLS_SEEN) {
          account(NEW[p], fid, p, seqN[p] ?? []);
          account(OLD[p], fid, p, seqO[p] ?? []);
        }
      }
    }
  }

const poolSize: Record<string, number> = { hit: POOLS.hit.length, fall: POOLS.knockdown.length, getup: POOLS.getup.length, death: POOLS.death.length, dodge: POOLS.dodge.length, launch: POOLS.launch.length };
function report(name: string, A: Record<string, Agg>) {
  const rows: Record<string, unknown>[] = [];
  for (const p of POOLS_SEEN) {
    const a = A[p];
    if (!a.picks) continue;
    const shares = Object.values(a.share).filter((c) => Object.values(c).reduce((x, y) => x + y, 0) >= 6);
    const top = shares.map((c) => Math.max(...Object.values(c)) / Object.values(c).reduce((x, y) => x + y, 0));
    let r5 = 99;
    for (const d of Object.values(a.deaths)) for (let i = 0; i + 10 <= d.length; i++) r5 = Math.min(r5, new Set(d.slice(i, i + 10)).size);
    rows.push({
      pool: p,
      picks: a.picks,
      R1_immediate: +((a.imm / Math.max(1, a.pairs)) * 100).toFixed(1),
      R2_within8s: +((a.near / a.picks) * 100).toFixed(1),
      R3_entropy: a.ent.length ? +(a.ent.reduce((x, y) => x + y, 0) / a.ent.length).toFixed(3) : null,
      R4_topShare: top.length ? +(Math.max(...top) * 100).toFixed(1) : null,
      R4_topShareMean: top.length ? +((top.reduce((x, y) => x + y, 0) / top.length) * 100).toFixed(1) : null,
      R5_deathDistinct10: p === 'death' && r5 < 99 ? r5 : undefined,
      distinctUsed: new Set(Object.values(a.share).flatMap((c) => Object.keys(c))).size,
      poolSize: name.startsWith('NEW') ? poolSize[p] : undefined,
    });
  }
  console.log(`\n== ${name} (${matches} matches)`);
  console.table(rows);
  return rows;
}
const out = { matches, seedsPerPair: N, new: report('NEW (M2 variety system)', NEW), old: report('OLD (fixed clip per state, pre-M2)', OLD) };
console.log(`[repetition] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
