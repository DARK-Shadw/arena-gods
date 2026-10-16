/**
 * AI behaviour metrics computed from recorded matches (frames + events).
 * Used by tools/simtest.ts (`npm run sim:test`).
 */
import { getFighter } from '../src/sim/fighters';
import { doctrineOf } from '../src/sim/doctrine';
import { generateArena, boundR } from '../src/sim/arenaGen';
import type { MatchRecord } from '../src/sim/types';

export interface AiAgg {
  matches: number;
  inBand: Record<string, [number, number]>; // id -> [ticks in band, ticks]
  retreats: number;
  kites: number;
  whiffs: number;
  punished: number;
  moveCounts: number;
  maxShareSum: number;
  maxShareOver35: number;
  entropySum: number;
  attacks: number;
  repeats: number;
  dumbHits: number;
  hits: number;
  corneredEp: number;
  corneredEsc: number;
  rangedLowTicks: number;
  rangedLowApproach: number;
  coverTicks: number;
  feints: number;
  counters: number;
  noContactKills: number;
  kills: number;
  attacksByRole: Record<string, Record<string, number>>;
  // arena play
  pickups: number;
  throws: number;
  throwHits: number;
  throwBlocked: number;
  batted: number;
  topples: number;
  crush: number;
  explosions: number;
  hazardHits: number;
  envKills: number;
  coverHits: number;
  propBreaks: number;
  chandeliers: number;
  matchesWithProp: number;
  matchesWithDestruction: number;
  envKillSources: Record<string, number>;
}

export function newAgg(): AiAgg {
  return {
    matches: 0, inBand: {}, retreats: 0, kites: 0, whiffs: 0, punished: 0, moveCounts: 0, maxShareSum: 0, maxShareOver35: 0, entropySum: 0,
    attacks: 0, repeats: 0, dumbHits: 0, hits: 0, corneredEp: 0, corneredEsc: 0, rangedLowTicks: 0, rangedLowApproach: 0, coverTicks: 0,
    feints: 0, counters: 0, noContactKills: 0, kills: 0, attacksByRole: {},
    pickups: 0, throws: 0, throwHits: 0, throwBlocked: 0, batted: 0, topples: 0, crush: 0, explosions: 0, hazardHits: 0, envKills: 0, coverHits: 0, propBreaks: 0, chandeliers: 0, matchesWithProp: 0, matchesWithDestruction: 0, envKillSources: {},
  };
}

/** ranged FIGHTER = zoner/kiter doctrine (melee fighters may carry a ranged poke) */
const hasRanged = (id: string) => ['zoner', 'kiter'].includes(doctrineOf(id).role);

export function accountAi(agg: AiAgg, rec: MatchRecord) {
  agg.matches++;
  const ids = rec.ids;
  const defs = ids.map(getFighter);
  const killT = rec.events.find((e) => e.type === 'kill' || e.type === 'timeout')?.t ?? 1e9;
  const frames = rec.frames.filter((f) => f.t <= killT);
  const L = generateArena(rec.arena);
  const edge = (x: number, z: number, s: number) => boundR(L, x, z) * s - Math.hypot(x, z);
  // --- per-tick: range band, retreats, cornered, ranged approaching low-hp melee, cover
  const retreatRun = [0, 0];
  const lastRetreatEnd = [-9, -9];
  const cornered: (number | null)[] = [null, null];
  for (const fr of frames) {
    const [a, b] = fr.f;
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    for (let i = 0; i < 2; i++) {
      const me = fr.f[i],
        op = fr.f[1 - i];
      const id = ids[i];
      const gap = d - defs[i].stats.radius - defs[1 - i].stats.radius;
      const band = doctrineOf(id).band;
      const ib = (agg.inBand[id] ??= [0, 0]);
      ib[1]++;
      if (gap >= band[0] - 0.15 && gap <= band[1] + 0.15) ib[0]++;
      // radial velocity (positive = moving away from opponent)
      const ux = (me.x - op.x) / (d || 1),
        uz = (me.z - op.z) / (d || 1);
      const vr = me.vx * ux + me.vz * uz;
      if (vr > 1.0 && (me.state === 'idle' || me.state === 'block')) retreatRun[i]++;
      else {
        if (retreatRun[i] >= 24) {
          agg.retreats++;
          lastRetreatEnd[i] = fr.t;
        }
        retreatRun[i] = 0;
      }
      // cornered: near the (ring) edge with the opponent between me and the centre
      const r = edge(me.x, me.z, fr.ringS),
        ro = edge(op.x, op.z, fr.ringS);
      const isCornered = r < 1.6 && ro > r + 0.8 && gap < 3;
      if (isCornered && cornered[i] === null) {
        cornered[i] = fr.t;
        agg.corneredEp++;
      } else if (cornered[i] !== null && !isCornered && r > 2.5) {
        if (fr.t - cornered[i]! <= 4) agg.corneredEsc++;
        cornered[i] = null;
      } else if (cornered[i] !== null && fr.t - cornered[i]! > 4) cornered[i] = -1e9; // failed episode; wait for reset
      if (cornered[i] !== null && cornered[i]! < -1e8 && !isCornered) cornered[i] = null;
      // ranged fighter vs low-HP melee: should not walk in
      if (hasRanged(id) && !hasRanged(ids[1 - i]) && op.hp / defs[1 - i].stats.hp < 0.35 && gap > 1.2 && me.state === 'idle') {
        agg.rangedLowTicks++;
        if (vr < -0.6) agg.rangedLowApproach++;
      }
      // cover: a pillar between me and a ranged opponent
      if (hasRanged(ids[1 - i])) {
        const blocked = L.obstacles.some((p, k) => fr.obs[k] >= 0 && segCircle(me.x, me.z, op.x, op.z, p.x, p.z, p.r + 0.2));
        if (blocked) agg.coverTicks++;
      }
    }
  }
  // --- events: kites, whiff punish, variety, repeats, dumb hits, feints/counters
  const lastAtk: string[][] = [[], []];
  const counts: Record<string, number>[] = [{}, {}];
  const evs = rec.events;
  for (let k = 0; k < evs.length; k++) {
    const e = evs[k];
    if (e.t > killT + 0.01) break;
    if (e.type === 'attack_start') {
      const mv = String(e.data?.move);
      const i = e.a;
      agg.attacks++;
      counts[i][mv] = (counts[i][mv] ?? 0) + 1;
      const L = lastAtk[i];
      if (L.length >= 2 && L[L.length - 1] === mv && L[L.length - 2] === mv) agg.repeats++;
      L.push(mv);
      const role = doctrineOf(ids[i]).role;
      const kind = String(e.data?.kind);
      ((agg.attacksByRole[role] ??= {})[kind] = (agg.attacksByRole[role][kind] ?? 0) + 1);
      const mvDef = defs[i].moves.find((m) => m.id === mv);
      if (mvDef?.ranged && e.t - lastRetreatEnd[i] < 1.5) agg.kites++;
    }
    if (e.type === 'feint') agg.feints++;
    if (e.type === 'prop_pickup') agg.pickups++;
    if (e.type === 'prop_throw') agg.throws++;
    if (e.type === 'prop_hit') agg.throwHits++;
    if (e.type === 'block' && e.data?.move === 'thrown') agg.throwBlocked++;
    if (e.type === 'prop_batted') agg.batted++;
    if (e.type === 'topple') agg.topples++;
    if (e.type === 'crush') agg.crush++;
    if (e.type === 'explosion') agg.explosions++;
    if (e.type === 'hazard_hit') agg.hazardHits++;
    if (e.type === 'cover_hit') agg.coverHits++;
    if (e.type === 'prop_break') agg.propBreaks++;
    if (e.type === 'chandelier_fall') agg.chandeliers++;
    if (e.type === 'counter') agg.counters++;
    if (e.type === 'whiff' || e.type === 'dodge' || e.type === 'parry') {
      // the "punisher" is the side that did NOT attack
      const attacker = e.type === 'whiff' ? e.a : e.b!;
      const punisher = 1 - attacker;
      agg.whiffs++;
      for (let j = k + 1; j < evs.length && evs[j].t <= e.t + 1.3; j++) {
        if (evs[j].type === 'hit' && evs[j].a === punisher) {
          agg.punished++;
          break;
        }
      }
    }
    if (e.type === 'hit') {
      agg.hits++;
      // dumb hit: walked toward a telegraphed attack during its windup
      const atk = defs[e.a].moves.find((m) => m.id === e.data?.move);
      if (atk && atk.windup >= 0.5) {
        const t1 = e.t - (atk.active ?? 0.1),
          t0 = t1 - atk.windup;
        let toward = 0,
          n = 0;
        for (const fr of frames) {
          if (fr.t < t0 || fr.t > t1) continue;
          const me = fr.f[e.b!],
            op = fr.f[e.a];
          const d = Math.hypot(me.x - op.x, me.z - op.z) || 1;
          const vr = (me.vx * (me.x - op.x) + me.vz * (me.z - op.z)) / d;
          n++;
          if (me.state === 'idle' && vr < -0.8) toward++;
        }
        if (n > 0 && toward / n > 0.4) agg.dumbHits++;
      }
    }
    if (e.type === 'kill') {
      agg.kills++;
      // contact kill = a hit/slam/block event on the victim at (almost) the same instant
      const ok = evs.some(
        (x) =>
          Math.abs(x.t - e.t) < 0.02 &&
          (((x.type === 'hit' || x.type === 'prop_hit' || x.type === 'crush' || x.type === 'hazard_hit') && x.b === e.b) ||
            ((x.type === 'wall_slam' || x.type === 'pillar_slam') && x.a === e.b) ||
            x.type === 'explosion'),
      );
      if (!ok) agg.noContactKills++;
      const mv = String(e.data?.move ?? '');
      const isMove = defs[e.a]?.moves.some((m) => m.id === mv);
      if (!isMove) {
        agg.envKills++;
        const k = mv.replace(/^(thrown|falling) .*/, '$1');
        agg.envKillSources[k] = (agg.envKillSources[k] ?? 0) + 1;
      }
    }
  }
  if (evs.some((e) => e.type === 'prop_pickup' || e.type === 'topple' || e.type === 'explosion' || e.type === 'hazard_hit')) agg.matchesWithProp++;
  if (evs.some((e) => e.type === 'prop_break' || e.type === 'cover_hit' || e.type === 'topple' || e.type === 'explosion')) agg.matchesWithDestruction++;
  for (let i = 0; i < 2; i++) {
    const c = Object.values(counts[i]);
    const tot = c.reduce((s, x) => s + x, 0);
    if (!tot) continue;
    const share = Math.max(...c) / tot;
    agg.moveCounts++;
    agg.maxShareSum += share;
    if (share > 0.35) agg.maxShareOver35++;
    const H = -c.reduce((s, x) => s + (x / tot) * Math.log(x / tot), 0);
    const nMoves = defs[i].moves.filter((m) => m.kind !== 'combo').length;
    agg.entropySum += H / Math.log(Math.max(2, nMoves));
  }
}

function segCircle(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, r: number) {
  const dx = bx - ax,
    dz = bz - az;
  const l2 = dx * dx + dz * dz || 1e-6;
  let t = ((cx - ax) * dx + (cz - az) * dz) / l2;
  t = Math.max(0, Math.min(1, t));
  const px = ax + dx * t - cx,
    pz = az + dz * t - cz;
  return px * px + pz * pz < r * r;
}

export function printAi(agg: AiAgg) {
  const p = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
  console.log(`\n--- AI metrics (${agg.matches} matches)`);
  console.log(
    'In preferred range band: ' +
      Object.entries(agg.inBand)
        .map(([id, [a, b]]) => `${id} ${p(a, b)}`)
        .join(' | '),
  );
  console.log(`Retreats/match ${(agg.retreats / agg.matches).toFixed(2)} | kiting shots/match ${(agg.kites / agg.matches).toFixed(2)} | feints/match ${(agg.feints / agg.matches).toFixed(2)} | counters/match ${(agg.counters / agg.matches).toFixed(2)}`);
  console.log(`Whiff/dodge/parry punish rate: ${p(agg.punished, agg.whiffs)} (${agg.whiffs} openings)`);
  console.log(`Move variety: mean top-move share ${(agg.maxShareSum / agg.moveCounts * 100).toFixed(1)}%, fighters with a move >35%: ${p(agg.maxShareOver35, agg.moveCounts)}, normalised entropy ${(agg.entropySum / agg.moveCounts).toFixed(2)}`);
  console.log(`Repeated-pattern rate (same move 3x in a row): ${p(agg.repeats, agg.attacks)}`);
  console.log(`Dumb hits (walked into a telegraphed windup): ${p(agg.dumbHits, agg.hits)} of hits`);
  console.log(`Cornered episodes/match ${(agg.corneredEp / agg.matches).toFixed(2)}, escaped within 4s: ${p(agg.corneredEsc, agg.corneredEp)}`);
  console.log(`Ranged fighter approaching low-HP melee: ${p(agg.rangedLowApproach, agg.rangedLowTicks)} of eligible ticks`);
  console.log(`Time behind cover vs ranged opponents: ${(agg.coverTicks / 60 / agg.matches).toFixed(2)} s/match`);
  console.log(`Kills without contact: ${agg.noContactKills}/${agg.kills}`);
  const n = agg.matches;
  const f = (x: number) => (x / n).toFixed(2);
  console.log(`\n--- Arena play (${n} matches)`);
  console.log(`Matches with arena interaction (pickup/topple/explosion/hazard hit): ${p(agg.matchesWithProp, n)} | with any destruction (prop/cover damage): ${p(agg.matchesWithDestruction, n)}`);
  console.log(`Props: pickups/match ${f(agg.pickups)} | throws/match ${f(agg.throws)} | throw hit rate ${p(agg.throwHits, agg.throws)} (blocked ${p(agg.throwBlocked, agg.throws)}, swatted ${p(agg.batted, agg.throws)}) | breaks/match ${f(agg.propBreaks)}`);
  console.log(`Cover: hits on cover/match ${f(agg.coverHits)} | topples/match ${f(agg.topples)} | crush hits/match ${f(agg.crush)} | explosions/match ${f(agg.explosions)} | chandeliers/match ${f(agg.chandeliers)}`);
  console.log(`Hazard hits/match ${f(agg.hazardHits)} | environmental kills ${agg.envKills}/${agg.kills} (${p(agg.envKills, agg.kills)}) ${JSON.stringify(agg.envKillSources)}`);
}
