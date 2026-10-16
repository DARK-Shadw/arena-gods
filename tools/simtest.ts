/**
 * Headless balance & drama analysis.
 *   npm run sim:test              (default: 40 seeds per ordered pair)
 *   npm run sim:test -- 100       (seeds per pair)
 *   npm run sim:test -- 20 gorak vex   (single matchup, verbose)
 */
import { FIGHTERS } from '../src/sim/fighters';
import { simulate } from '../src/sim/match';
import { arenaForSeed, LAYOUTS, THEMES, type ArenaSpec, type LayoutId, type ThemeId } from '../src/sim/arenaGen';
import type { MatchRecord } from '../src/sim/types';
import { accountAi, newAgg, printAi } from './aiMetrics';
import { AI_TUNING } from '../src/sim/ai';
if (process.env.ARENA_AI === '0') {
  AI_TUNING.arenaTactics = false;
  console.log('(arena tactics layer DISABLED: no grabbing / toppling / barrel shots / hazard baiting)');
}
const ai = newAgg();

const argv = process.argv.slice(2);
// --arena theme:layout  (fixed arena for every match; default: a generated arena per seed)
const ai0 = argv.indexOf('--arena');
const fixedArena = ai0 >= 0 ? argv[ai0 + 1] : null;
const args = argv.filter((a, i) => !a.startsWith('--') && (ai0 < 0 || i !== ai0 + 1));
const N = Number(args[0] ?? 40);
const only = args.length >= 3 ? [args[1], args[2]] : null;
function arenaFor(seed: number): ArenaSpec {
  if (fixedArena) {
    const [t, l] = fixedArena.split(':');
    return { theme: (t || 'colosseum') as ThemeId, layout: (l || 'pit') as LayoutId, seed };
  }
  return arenaForSeed(seed);
}
const byArena: Record<string, { n: number; dur: number; swings2: number; timeout: number; env: number }> = {};
const ids = FIGHTERS.map((f) => f.id);

interface Agg {
  n: number;
  dur: number[];
  swings: number[];
  leads: number[];
  oneSided: number;
  timeout: number;
  comeback: number;
  draws: number;
  ults: number;
  parries: number;
  dodges: number;
  hits: number;
  lastStand: number;
  secondWind: number;
  stalemate: number;
  shrink: number;
}
const agg: Agg = { n: 0, dur: [], swings: [], leads: [], oneSided: 0, timeout: 0, comeback: 0, draws: 0, ults: 0, parries: 0, dodges: 0, hits: 0, lastStand: 0, secondWind: 0, stalemate: 0, shrink: 0 };
const wins: Record<string, Record<string, number>> = {};
const games: Record<string, Record<string, number>> = {};
const totalWins: Record<string, number> = {};
const totalGames: Record<string, number> = {};
for (const a of ids) {
  wins[a] = {};
  games[a] = {};
  totalWins[a] = 0;
  totalGames[a] = 0;
  for (const b of ids) {
    wins[a][b] = 0;
    games[a][b] = 0;
  }
}

interface Diag { matches: number; attacks: number; hits: number; blocked: number; parried: number; dodged: number; whiffs: number; dmg: number; ults: number; ultHits: number }
const diag: Record<string, Diag> = {};
for (const id of ids) diag[id] = { matches: 0, attacks: 0, hits: 0, blocked: 0, parried: 0, dodged: 0, whiffs: 0, dmg: 0, ults: 0, ultHits: 0 };

function account(rec: MatchRecord) {
  accountAi(ai, rec);
  const r = rec.result;
  for (const key of [`theme ${rec.arena.theme}`, `layout ${rec.arena.layout}`]) {
    const b = (byArena[key] ??= { n: 0, dur: 0, swings2: 0, timeout: 0, env: 0 });
    b.n++;
    b.dur += r.duration;
    if (r.swings >= 2) b.swings2++;
    if (r.timeout) b.timeout++;
    if (rec.events.some((e) => e.type === 'prop_hit' || e.type === 'crush' || e.type === 'explosion' || e.type === 'hazard_hit')) b.env++;
  }
  const [a, b] = rec.ids;
  diag[a].matches++;
  diag[b].matches++;
  for (const e of rec.events) {
    const att = e.type === 'block' || e.type === 'parry' || e.type === 'dodge' ? e.b : e.a;
    if (att === undefined || att < 0) continue;
    const d = diag[rec.ids[att]];
    if (e.type === 'attack_start') d.attacks++;
    else if (e.type === 'hit') {
      d.hits++;
      d.dmg += Number(e.data?.dmg ?? 0);
      if (e.data?.kind === 'ultimate') d.ultHits++;
    } else if (e.type === 'block') d.blocked++;
    else if (e.type === 'parry') d.parried++;
    else if (e.type === 'dodge') d.dodged++;
    else if (e.type === 'whiff') d.whiffs++;
    else if (e.type === 'ability_used') d.ults++;
  }
  agg.n++;
  agg.dur.push(r.duration);
  agg.swings.push(r.swings);
  agg.leads.push(r.leadChanges);
  if (r.oneSided) agg.oneSided++;
  if (r.timeout) agg.timeout++;
  if (r.comeback) agg.comeback++;
  if (r.winner < 0) agg.draws++;
  for (const e of rec.events) {
    if (e.type === 'ability_used') agg.ults++;
    else if (e.type === 'parry') agg.parries++;
    else if (e.type === 'dodge') agg.dodges++;
    else if (e.type === 'hit') agg.hits++;
    else if (e.type === 'last_stand') agg.lastStand++;
    else if (e.type === 'second_wind') agg.secondWind++;
    else if (e.type === 'stalemate_break') agg.stalemate++;
    else if (e.type === 'arena_shrink') agg.shrink++;
  }
  games[a][b]++;
  games[b][a]++;
  totalGames[a]++;
  totalGames[b]++;
  if (r.winner === 0) {
    wins[a][b]++;
    totalWins[a]++;
  } else if (r.winner === 1) {
    wins[b][a]++;
    totalWins[b]++;
  }
}

const t0 = Date.now();
if (only) {
  for (let s = 1; s <= N; s++) {
    const rec = simulate(only[0], only[1], s * 7919, true, arenaFor(s * 7919));
    account(rec);
    const r = rec.result;
    console.log(
      `seed ${s * 7919} [${rec.arena.theme}/${rec.arena.layout}]: winner=${r.winner < 0 ? 'draw' : rec.ids[r.winner]} dur=${r.duration}s swings=${r.swings} comeback=${r.comeback} hp=${r.finalHp.map((h) => h.toFixed(2)).join('/')} kill=${r.killMove}`,
    );
  }
} else {
  for (let i = 0; i < ids.length; i++)
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      for (let s = 1; s <= N; s++) {
        const seed = s * 7919 + i * 131 + j * 17;
        account(simulate(ids[i], ids[j], seed, true, arenaFor(seed)));
      }
    }
}
const ms = Date.now() - t0;

const pct = (x: number) => `${((x / agg.n) * 100).toFixed(1)}%`;
const sorted = [...agg.dur].sort((a, b) => a - b);
const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const inRange = agg.dur.filter((d) => d >= 45 && d <= 90).length;

console.log(`\n=== ARENA SIM REPORT: ${agg.n} matches in ${(ms / 1000).toFixed(1)}s ===`);
console.log(`Duration  mean ${mean(agg.dur).toFixed(1)}s | p10 ${q(0.1).toFixed(1)} | median ${q(0.5).toFixed(1)} | p90 ${q(0.9).toFixed(1)} | in 45-90s: ${pct(inRange)}`);
const sw = [0, 0, 0, 0, 0];
for (const s of agg.swings) sw[Math.min(4, s)]++;
console.log(`Momentum swings (HP-lead flips, 8% hysteresis): 0:${pct(sw[0])}  1:${pct(sw[1])}  2:${pct(sw[2])}  3:${pct(sw[3])}  4+:${pct(sw[4])}  | mean ${mean(agg.swings).toFixed(2)} | >=2 swings: ${pct(sw[2] + sw[3] + sw[4])}`);
console.log(`One-sided: ${pct(agg.oneSided)} | Timeouts: ${pct(agg.timeout)} | Draws: ${pct(agg.draws)} | Comeback wins (winner was down >=25% HP): ${pct(agg.comeback)}`);
console.log(
  `Per match: hits ${(agg.hits / agg.n).toFixed(1)}, dodges ${(agg.dodges / agg.n).toFixed(1)}, parries ${(agg.parries / agg.n).toFixed(2)}, ultimates ${(agg.ults / agg.n).toFixed(2)}, last stands ${(agg.lastStand / agg.n).toFixed(2)}, second winds ${(agg.secondWind / agg.n).toFixed(2)}, stalemate breaks ${(agg.stalemate / agg.n).toFixed(2)}, ring-shrink reached ${pct(agg.shrink)}`,
);

if (!only) {
  console.log(`\nWin rate matrix (row beats column, both sides combined):`);
  const pad = (s: string, n = 8) => s.padEnd(n);
  console.log(pad('') + ids.map((i) => pad(i)).join('') + 'OVERALL');
  for (const a of ids) {
    let row = pad(a);
    for (const b of ids) row += pad(a === b ? '  -' : `${((wins[a][b] / games[a][b]) * 100).toFixed(0)}%`);
    row += `${((totalWins[a] / totalGames[a]) * 100).toFixed(1)}%`;
    console.log(row);
  }
}

printAi(ai);

console.log('\nBy arena: matches | mean duration | >=2 swings | timeouts | env-damage matches');
for (const k of [...THEMES.map((t) => `theme ${t}`), ...LAYOUTS.map((l) => `layout ${l}`)]) {
  const b = byArena[k];
  if (!b) continue;
  console.log(`  ${k.padEnd(18)} ${String(b.n).padStart(5)} | ${(b.dur / b.n).toFixed(1).padStart(5)}s | ${((b.swings2 / b.n) * 100).toFixed(1).padStart(5)}% | ${b.timeout} | ${((b.env / b.n) * 100).toFixed(0)}%`);
}

if (args.includes('--diag') || process.env.DIAG) {
  console.log('\nPer-fighter (per match): attacks  hits  dmg  blocked parried dodged whiffs  ults ultHits');
  for (const id of ids) {
    const d = diag[id];
    const n = d.matches || 1;
    const f = (x: number) => (x / n).toFixed(1).padStart(6);
    console.log(`${id.padEnd(8)} ${f(d.attacks)} ${f(d.hits)} ${f(d.dmg)} ${f(d.blocked)} ${f(d.parried)} ${f(d.dodged)} ${f(d.whiffs)} ${f(d.ults)} ${f(d.ultHits)}`);
  }
}

// Determinism check: same seed must give an identical record.
{
  const ser = (r: MatchRecord) => JSON.stringify(r, (_k, v) => (ArrayBuffer.isView(v) ? Array.from(v as Float32Array) : v));
  let same = true,
    differs = true;
  for (const th of THEMES) {
    const spec: ArenaSpec = { theme: th, layout: LAYOUTS[th.length % LAYOUTS.length], seed: 4242 };
    const a = ser(simulate('gorak', 'erika', 12345, true, spec));
    const b = ser(simulate('gorak', 'erika', 12345, true, { ...spec }));
    const c = ser(simulate('gorak', 'erika', 12345, true, { ...spec, seed: 4243 }));
    same &&= a === b;
    differs &&= a !== c;
  }
  console.log(`\nDeterminism (all themes): same seed+arena identical = ${same}, different arena seed differs = ${differs}`);
}
