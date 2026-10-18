/**
 * AI v1 diagnosis (scratch, read-only w.r.t. src/). Steps matches tick by tick and
 * measures why the fighters look "basic". Also runs scripted exploit bots against v1.
 *   npx tsx tools/ai/_scratch/diag.ts [seedsPerPair=4] [botSeeds=6]
 * Writes tools/ai/_scratch/diag-out.json and trace-sample.txt.
 */
import { writeFileSync } from 'node:fs';
import { Match, type FighterState } from '../../../src/sim/match';
import { FIGHTERS } from '../../../src/sim/fighters';
import { arenaForSeed } from '../../../src/sim/arenaGen';
import { ARENA } from '../../../src/sim/arena';
import { edgeReach } from '../../../src/sim/reach';
import type { FighterDef, MoveDef } from '../../../src/sim/types';

const SEEDS = Number(process.argv[2] ?? 4);
const BOT_SEEDS = Number(process.argv[3] ?? 6);
const ids = FIGHTERS.map((f) => f.id);
const DT = 1 / 60;

const reachOf = (d: FighterDef, mv: MoveDef) => (mv.ranged ? mv.range - 0.6 : edgeReach(d.id, mv, d.stats.radius) + Math.max(0, mv.lunge ?? 0) * 0.85 + 0.48);
const threatCache = new Map<string, number>();
function threat(d: FighterDef) {
  let r = threatCache.get(d.id);
  if (r === undefined) {
    r = 0.4;
    // poke threat: v1's threatRange also counts 'gap' lunges (5-6 m); POKE=0 env reproduces v1
    for (const m of d.moves) if (!m.ranged && !m.feint && m.kind !== 'ultimate' && m.windup <= 0.65 && (process.env.POKE === '0' || m.kind !== 'gap')) r = Math.max(r, reachOf(d, m));
    threatCache.set(d.id, r);
  }
  return r;
}
const gapOf = (a: FighterState, b: FighterState) => Math.hypot(a.x - b.x, a.z - b.z) - a.def.stats.radius - b.def.stats.radius;
/** fastest time-to-contact of an attack I can start now at this gap (s), Infinity if none */
function fastest(f: FighterState, gap: number): number {
  let best = Infinity;
  for (const mv of f.def.moves) {
    if (mv.kind === 'ultimate' || mv.kind === 'combo' || mv.feint) continue;
    if (mv.minRange !== undefined && gap < mv.minRange) continue;
    if (f.stamina < mv.stamina * 0.6) continue;
    if (gap > reachOf(f.def, mv) - 0.1) continue;
    const t = mv.windup + (mv.ranged ? gap / (mv.speed ?? 20) : 0);
    if (t < best) best = t;
  }
  return best;
}
function cls(m: Match, f: FighterState): string {
  if (f.state === 'attack' && f.move) {
    if (f.move.feint) return 'windup';
    const ph = m.attackPhase(f);
    return ph === 0 ? 'windup' : ph === 1 ? 'active' : 'recovery';
  }
  if (f.state === 'stagger' || f.state === 'winded' || f.state === 'taunt' || f.state === 'lift' || f.state === 'throw') return 'open';
  if (f.state === 'knockdown' || f.state === 'launched' || f.state === 'getup') return 'down';
  if (f.state === 'block') return 'block';
  if (f.state === 'dodge') return 'dodge';
  return 'neutral';
}
/** seconds the opponent stays punishable */
function openRemaining(m: Match, o: FighterState): number {
  if (o.state === 'attack' && o.move && !o.move.feint && m.attackPhase(o) === 2) return o.move.windup + o.move.active + o.move.recovery - o.stateT;
  if (o.state === 'stagger' || o.state === 'winded' || o.state === 'taunt' || o.state === 'lift' || o.state === 'throw') return o.stateDur - o.stateT;
  return 0;
}

// ------------------------------------------------------------------ aggregation
interface FAgg {
  matches: number;
  ticks: number;
  attacks: number;
  atkCtx: Record<string, number>; // opp class at attack start
  atkOutOfReach: number;
  outcome: Record<string, number>; // hit / blocked / dodged / parried / whiff / feint / counterHitMe(traded or got hit in my attack)
  punishEp: number;
  punishEpFeasible: number; // window >= 0.35 s beyond fastest (human-feasible)
  punished: number;
  punishedFeasible: number;
  punishLatency: number[];
  punishHit: number;
  incoming: number;
  resp: Record<string, number>;
  respLatency: number[];
  incomingResult: Record<string, number>;
  spacing: Record<string, number>; // gap - oppThreat buckets (idle/block ticks)
  stillTicks: number;
  freeTicks: number;
  jitter: number;
  goalSwitches: number;
  moveCtx: Record<string, Record<string, number>>; // ctx -> move -> n
  hpAtk: [number, number][]; // per hp bucket: [attacks, freeTicks]
  leadAtk: [number, number][]; // behind / even / ahead
  heavyByHp: [number, number][]; // [heavy, attacks]
  ngram: [number, number, number, number]; // order0 hits, order1 hits, order2 hits, predictions
  blockedEarly: [number, number];
  blockedLate: [number, number];
  gbEarly: [number, number];
  gbLate: [number, number];
  feints: number;
  feintOppReact: number;
  feintFollow: number;
  feintConvert: number;
  ults: number;
  ultHit: number;
  ultCtx: Record<string, number>;
  lowStamAtk: number;
  exhausted: number;
  afterBlockedNext: Record<string, number>; // my next action after my attack was blocked
}
const newF = (): FAgg => ({
  matches: 0, ticks: 0, attacks: 0, atkCtx: {}, atkOutOfReach: 0, outcome: {}, punishEp: 0, punishEpFeasible: 0, punished: 0, punishedFeasible: 0, punishLatency: [], punishHit: 0,
  incoming: 0, resp: {}, respLatency: [], incomingResult: {}, spacing: {}, stillTicks: 0, freeTicks: 0, jitter: 0, goalSwitches: 0, moveCtx: {},
  hpAtk: [[0, 0], [0, 0], [0, 0]], leadAtk: [[0, 0], [0, 0], [0, 0]], heavyByHp: [[0, 0], [0, 0], [0, 0]], ngram: [0, 0, 0, 0], blockedEarly: [0, 0], blockedLate: [0, 0], gbEarly: [0, 0], gbLate: [0, 0],
  feints: 0, feintOppReact: 0, feintFollow: 0, feintConvert: 0, ults: 0, ultHit: 0, ultCtx: {}, lowStamAtk: 0, exhausted: 0, afterBlockedNext: {},
});
const inc = (r: Record<string, number>, k: string, n = 1) => (r[k] = (r[k] ?? 0) + n);
const FA: Record<string, FAgg> = Object.fromEntries(ids.map((i) => [i, newF()]));
const CTXOUT: Record<string, Record<string, number>> = {};
const GOALS: Record<string, Record<string, number>> = {};
const CADENCE: number[] = [];
let heavyWhiffs = 0, heavyAtt = 0, tradeHits = 0, followHits = 0, ultLanded = 0, exhaustedTicks = 0, liveTicks = 0;
const G = { matches: 0, dur: [] as number[], trades: 0, simulStarts: 0, lullTime: 0, lulls: 0, fightTime: 0, msPerMatch: [] as number[], ticks: 0, exchangesPerMin: [] as number[] };

// ------------------------------------------------------------------ bots
type Bot = 'spam' | 'turtle' | 'heavy';
function botPre(f: FighterState, o: FighterState) {
  f.ai.nextThink = 1e9;
  f.ai.queued = null;
  f.ai.pending = null;
  f.ai.reactedTo = o.attackId;
}
function botAct(m: Match, f: FighterState, o: FighterState, kind: Bot) {
  if (m.over || !m.canAct(f) || f.carry >= 0) return;
  const gap = gapOf(f, o);
  const usable = f.def.moves.filter((mv) => mv.kind !== 'ultimate' && mv.kind !== 'combo' && !mv.feint && f.stamina >= mv.stamina * 0.6 && !(mv.minRange !== undefined && gap < mv.minRange) && gap <= reachOf(f.def, mv) - 0.05);
  if (kind === 'spam' || kind === 'heavy') {
    f.ai.goal = 'punish';
    if (!usable.length) return;
    usable.sort((a, b) => (kind === 'spam' ? a.windup - b.windup : b.damage * (b.hits ?? 1) - a.damage * (a.hits ?? 1)));
    m.startAttack(f, usable[0]);
    return;
  }
  // turtle: block anything coming, punish recovery, otherwise hold guard at the edge of their reach
  f.ai.goal = 'guard';
  if (o.state === 'attack' && o.move && m.attackPhase(o) <= 1 && gap <= reachOf(o.def, o.move) + 0.5) {
    m.startBlock(f, m.t + 0.3);
    return;
  }
  const R = openRemaining(m, o);
  if (R > 0 && usable.length) {
    usable.sort((a, b) => a.windup - b.windup);
    if (usable[0].windup + 0.05 < R) {
      m.startAttack(f, usable[0]);
      return;
    }
  }
  if (gap < threat(o.def) + 0.3) m.startBlock(f, m.t + 0.25);
}

// ------------------------------------------------------------------ one match
interface Track {
  punish: { start: number; R: number; feasible: boolean; done: boolean } | null;
  incoming: { id: number; t: number; end: number; done: boolean; resp: string } | null;
  lastAtkT: number;
  feintT: number;
  feintReact: boolean;
  feintFollow: boolean;
  lastBlockedT: number;
  wantAng: number | null;
  goal: string;
  seq: string[];
  n1: Record<string, Record<string, number>>;
  n2: Record<string, Record<string, number>>;
  n0: Record<string, number>;
  atkBlocked: boolean;
  cur: { ctx: string; heavy: boolean; ult: boolean; resolved: boolean; landed: boolean } | null;
  atkTimes: number[];
}
const resolveCur = (tr: Track, out: string) => {
  const c = tr.cur;
  if (!c || c.resolved) return;
  c.resolved = true;
  inc((CTXOUT[c.ctx] ??= {}), out);
  if (c.heavy && out === 'whiff') heavyWhiffs++;
  if (c.ult && out === 'hit') ultLanded++;
};
const newT = (): Track => ({
  cur: null,
  atkTimes: [], punish: null, incoming: null, lastAtkT: -9, feintT: -9, feintReact: false, feintFollow: false, lastBlockedT: -9, wantAng: null, goal: '', seq: [], n1: {}, n2: {}, n0: {}, atkBlocked: false });
const argmax = (r: Record<string, number> | undefined) => {
  if (!r) return '';
  let b = '',
    bv = -1;
  for (const [k, v] of Object.entries(r)) if (v > bv) ((bv = v), (b = k));
  return b;
};
function token(f: FAgg, T: Track, tok: string) {
  // online n-gram prediction of MY next action (as an opponent model would see it)
  const s = T.seq;
  const p0 = argmax(T.n0);
  const p1 = s.length >= 1 ? argmax(T.n1[s[s.length - 1]]) || p0 : p0;
  const p2 = s.length >= 2 ? argmax(T.n2[s[s.length - 2] + '|' + s[s.length - 1]]) || p1 : p1;
  if (s.length >= 2) {
    f.ngram[3]++;
    if (p0 === tok) f.ngram[0]++;
    if (p1 === tok) f.ngram[1]++;
    if (p2 === tok) f.ngram[2]++;
  }
  inc(T.n0, tok);
  if (s.length >= 1) inc((T.n1[s[s.length - 1]] ??= {}), tok);
  if (s.length >= 2) inc((T.n2[s[s.length - 2] + '|' + s[s.length - 1]] ??= {}), tok);
  s.push(tok);
}

function runMatch(a: string, b: string, seed: number, bots: [Bot | null, Bot | null], analyse: boolean, trace?: string[]): number {
  const m = new Match(a, b, seed, { record: false, arena: arenaForSeed(seed) });
  const hard = ARENA.timeLimit + 10;
  const T = [newT(), newT()];
  let ev = 0;
  let lastAction = 0;
  let exch = 0;
  const t0 = performance.now();
  while (m.t < hard) {
    // ---- pre-step snapshot (what each AI sees when it decides this tick)
    const pre = m.f.map((f) => ({ state: f.state, cls: cls(m, f), gap: 0, hp: f.hp / f.maxHp, stam: f.stamina / f.def.stats.stamina, attackId: f.attackId, canAct: m.canAct(f) && f.carry < 0, R: openRemaining(m, f) }));
    for (let i = 0; i < 2; i++) pre[i].gap = gapOf(m.f[i], m.f[1 - i]);
    for (let i = 0; i < 2; i++) if (bots[i]) botPre(m.f[i], m.f[1 - i]);
    m.step();
    for (let i = 0; i < 2; i++) if (bots[i]) botAct(m, m.f[i], m.f[1 - i], bots[i]!);
    if (!analyse) {
      if (m.over && m.t >= m.endT) break;
      continue;
    }
    const live = !m.over;
    // ---- per-tick
    for (let i = 0; i < 2; i++) {
      const f = m.f[i],
        o = m.f[1 - i];
      const A = FA[f.def.id];
      const tr = T[i];
      if (!live) continue;
      A.ticks++;
      liveTicks++;
      if (f.exhausted) exhaustedTicks++;
      if (f.ai.goal !== tr.goal) {
        if (tr.goal) A.goalSwitches++;
        tr.goal = f.ai.goal;
      }
      if (f.state === 'idle' || f.state === 'block') {
        A.freeTicks++;
        const hb = pre[i].hp > 0.66 ? 0 : pre[i].hp > 0.33 ? 1 : 2;
        A.hpAtk[hb][1]++;
        const lead = pre[i].hp - pre[1 - i].hp;
        A.leadAtk[lead < -0.1 ? 0 : lead > 0.1 ? 2 : 1][1]++;
        const d = gapOf(f, o) - threat(o.def);
        inc(A.spacing, d < -0.75 ? 'deep_inside' : d < 0 ? 'inside_edge' : d < 1 ? 'outside_edge' : d < 3 ? 'mid' : 'far');
        if (f.state === 'idle' && Math.hypot(f.mx, f.mz) < 0.3) A.stillTicks++;
        if (Math.hypot(f.wantX, f.wantZ) > 0.5) {
          const ang = Math.atan2(f.wantX, f.wantZ);
          if (tr.wantAng !== null) {
            let dd = Math.abs(ang - tr.wantAng) % (2 * Math.PI);
            if (dd > Math.PI) dd = 2 * Math.PI - dd;
            if (dd > 2.1) A.jitter++;
          }
          tr.wantAng = ang;
        } else tr.wantAng = null;
      }
      // punish windows: opponent punishable now, I can act, a fast enough move reaches
      const R = pre[1 - i].R;
      const fast = pre[i].canAct && R > 0 ? fastest(f, pre[i].gap) : Infinity;
      const can = fast + 0.05 < R;
      if (can && !tr.punish) {
        tr.punish = { start: m.t, R, feasible: R - fast >= 0.3, done: false };
        A.punishEp++;
        if (tr.punish.feasible) A.punishEpFeasible++;
      } else if (!can && tr.punish && !tr.punish.done) tr.punish = null;
      // incoming attack bookkeeping (response = my first state change)
      const inc0 = tr.incoming;
      if (inc0 && !inc0.done) {
        if (m.t > inc0.end) {
          inc0.done = true;
          if (inc0.resp === '') inc(A.resp, 'none');
        } else if (inc0.resp === '') {
          let r = '';
          if (f.state === 'block' && pre[i].state !== 'block') r = 'block';
          else if (f.state === 'dodge' && pre[i].state !== 'dodge') r = 'dodge';
          else if (f.state === 'attack' && pre[i].state !== 'attack') r = 'attack';
          else if (f.ai.backstepUntil > m.t) r = 'backstep';
          else if (pre[i].state === 'block') r = 'already_block';
          if (r) {
            inc0.resp = r;
            inc(A.resp, r);
            A.respLatency.push(m.t - inc0.t);
          }
        }
      }
    }
    // ---- events of this tick
    for (; ev < m.events.length; ev++) {
      const e = m.events[ev];
      if (e.t > (m.over ? m.endT - 5 + 0.02 : 1e9)) continue;
      const ty = e.type;
      if (ty === 'hit' || ty === 'block' || ty === 'parry' || ty === 'dodge') {
        const gapT = e.t - lastAction;
        if (gapT > 4) {
          G.lulls++;
          G.lullTime += gapT;
        }
        lastAction = e.t;
        exch++;
      }
      if (ty === 'attack_start') {
        const i = e.a,
          f = m.f[i],
          o = m.f[1 - i];
        const A = FA[f.def.id];
        const tr = T[i];
        const mv = f.def.moves.find((x) => x.id === e.data?.move)!;
        const other = T[1 - i];
        if (Math.abs(other.lastAtkT - e.t) < 0.1) G.simulStarts++;
        tr.lastAtkT = e.t;
        if (mv.kind !== 'combo') {
          A.attacks++;
          const c0 = pre[1 - i].cls;
          const c = c0 === 'down' && o.state === 'getup' ? 'getup' : c0;
          resolveCur(tr, 'superseded');
          tr.cur = { ctx: mv.feint ? 'FEINT' : c, heavy: mv.kind === 'heavy', ult: mv.kind === 'ultimate', resolved: !!mv.feint, landed: false };
          if (mv.kind === 'heavy') heavyAtt++;
          tr.atkTimes.push(e.t);
          inc(A.atkCtx, c);
          if (!mv.ranged && pre[i].gap > reachOf(f.def, mv) + 0.05) A.atkOutOfReach++;
          if (pre[i].stam < 0.25 && !mv.furyCost) A.lowStamAtk++;
          const hb = pre[i].hp > 0.66 ? 0 : pre[i].hp > 0.33 ? 1 : 2;
          A.hpAtk[hb][0]++;
          const lead = pre[i].hp - pre[1 - i].hp;
          A.leadAtk[lead < -0.1 ? 0 : lead > 0.1 ? 2 : 1][0]++;
          A.heavyByHp[hb][1]++;
          if (mv.kind === 'heavy') A.heavyByHp[hb][0]++;
          const gb = pre[i].gap < 1 ? 'close' : pre[i].gap < 3 ? 'mid' : 'far';
          const ctx = gb + ':' + (c === 'recovery' || c === 'open' || c === 'down' ? 'open' : c === 'windup' || c === 'active' ? 'attacking' : c);
          inc((A.moveCtx[ctx] ??= {}), mv.id);
          const early = e.t < 30;
          const gbk = mv.tags?.includes('guardbreak') ? 1 : 0;
          if (early) ((A.gbEarly[0] += gbk), A.gbEarly[1]++);
          else ((A.gbLate[0] += gbk), A.gbLate[1]++);
          token(A, tr, mv.id);
          if (e.t - tr.lastBlockedT < 1.5) {
            inc(A.afterBlockedNext, mv.tags?.includes('guardbreak') ? 'guardbreak' : mv.feint ? 'feint' : mv.kind === 'heavy' ? 'heavy' : mv.ranged ? 'ranged' : 'same_kind_poke');
            tr.lastBlockedT = -9;
          }
          if (e.t - tr.feintT < 0.8) tr.feintFollow = true;
          if (e.t - other.feintT < 0.5) other.feintReact = true;
          if (mv.kind === 'ultimate') {
            A.ults++;
            inc(A.ultCtx, c);
          }
        }
        if (tr.punish && !tr.punish.done) {
          tr.punish.done = true;
          A.punished++;
          if (tr.punish.feasible) A.punishedFeasible++;
          A.punishLatency.push(e.t - tr.punish.start);
        }
        if (other.incoming && !other.incoming.done && other.incoming.resp === '' && !mv.feint) {
          // I started an attack while their attack is incoming: counted in their response tracking via state
        }
        // new incoming attack for the other fighter
        if (!mv.feint && !mv.ranged && pre[i].gap <= reachOf(f.def, mv) + 0.3) {
          const D = FA[o.def.id];
          D.incoming++;
          other.incoming = { id: f.attackId, t: e.t, end: e.t + mv.windup + mv.active, done: false, resp: pre[1 - i].state === 'block' ? '' : '' };
        }
        tr.atkBlocked = false;
      } else if (ty === 'hit') {
        const A = FA[m.f[e.a].def.id];
        inc(A.outcome, 'hit');
        resolveCur(T[e.a], 'hit');
        {
          const vs = m.f[e.b!].state;
          // victim state after the hit is stagger/knockdown; use the victim's pre-step class
          const vc = pre[e.b!].cls;
          if (vc === 'windup' || vc === 'active' || vc === 'recovery') tradeHits++;
          else if (vc === 'open' || vc === 'down') followHits++;
          void vs;
        }
        if (T[e.a].punish && T[e.a].punish!.done && e.t - T[e.a].punish!.start < T[e.a].punish!.R + 0.6) {
          A.punishHit++;
          T[e.a].punish = null;
        }
        if (m.f[e.b!].state === 'attack' || m.f[e.b!].state === 'stagger') inc(FA[m.f[e.b!].def.id].outcome, 'got_hit_in_own_attack');
        if (e.data?.kind === 'ultimate') A.ultHit++;
        const inc0 = T[e.b!].incoming;
        if (inc0 && !inc0.done && e.t <= inc0.end + 0.05) inc(FA[m.f[e.b!].def.id].incomingResult, 'ate_it');
        if (e.t - T[e.a].feintT < 1.2 && T[e.a].feintFollow) {
          A.feintConvert++;
          T[e.a].feintT = -9;
        }
        if (Math.abs(T[0].lastAtkT - T[1].lastAtkT) < 0.15 && e.t - Math.max(T[0].lastAtkT, T[1].lastAtkT) < 1.2) G.trades++;
      } else if (ty === 'block' || ty === 'parry' || ty === 'dodge') {
        const att = e.b!,
          def = e.a;
        inc(FA[m.f[att].def.id].outcome, ty === 'block' ? 'blocked' : ty === 'parry' ? 'parried' : 'dodged');
        resolveCur(T[att], ty === 'block' ? 'blocked' : ty === 'parry' ? 'parried' : 'dodged');
        if (ty === 'block') {
          T[att].lastBlockedT = e.t;
          const A = FA[m.f[att].def.id];
          if (e.t < 30) A.blockedEarly[0]++;
          else A.blockedLate[0]++;
        }
        const inc0 = T[def].incoming;
        if (inc0 && !inc0.done && e.t <= inc0.end + 0.05) inc(FA[m.f[def].def.id].incomingResult, ty);
      } else if (ty === 'whiff' && e.data?.projectile) {
        resolveCur(T[e.a], 'whiff');
      } else if (ty === 'whiff' && !e.data?.projectile) {
        inc(FA[m.f[e.a].def.id].outcome, 'whiff');
        resolveCur(T[e.a], 'whiff');
        const inc0 = T[e.b!].incoming;
        if (inc0 && !inc0.done) inc(FA[m.f[e.b!].def.id].incomingResult, 'they_whiffed');
      } else if (ty === 'feint') {
        const A = FA[m.f[e.a].def.id];
        inc(A.outcome, 'feint');
        A.feints++;
        T[e.a].feintT = e.t;
        T[e.a].feintFollow = false;
        T[e.a].feintReact = false;
      } else if (ty === 'exhausted') FA[m.f[e.a].def.id].exhausted++;
    }
    // feint reaction: opponent changed to block/dodge within 0.5 s of my feint's windup start (approximate)
    for (let i = 0; i < 2; i++) {
      const tr = T[i];
      if (tr.feintT > 0 && m.t - tr.feintT < 0.05) {
        const o = m.f[1 - i];
        if (o.state === 'block' || o.state === 'dodge' || (o.state === 'attack' && m.attackPhase(o) <= 1)) tr.feintReact = true;
      }
    }
    if (trace && m.t < 25) {
      const f = m.f;
      if (Math.round(m.t * 60) % 6 === 0)
        trace.push(`${m.t.toFixed(2)} gap=${gapOf(f[0], f[1]).toFixed(2)} | ${f[0].def.id} ${f[0].state}${f[0].move ? ':' + f[0].move.id : ''} goal=${f[0].ai.goal} hp=${(f[0].hp / f[0].maxHp).toFixed(2)} st=${f[0].stamina.toFixed(0)} | ${f[1].def.id} ${f[1].state}${f[1].move ? ':' + f[1].move.id : ''} goal=${f[1].ai.goal} hp=${(f[1].hp / f[1].maxHp).toFixed(2)} st=${f[1].stamina.toFixed(0)}`);
    }
    if (m.over && m.t >= m.endT) break;
  }
  const ms = performance.now() - t0;
  if (analyse) {
    G.matches++;
    const dur = m.drama.result().duration;
    G.dur.push(dur);
    G.fightTime += dur;
    G.msPerMatch.push(ms);
    G.ticks += Math.round(m.t * 60);
    G.exchangesPerMin.push(exch / (dur / 60));
    for (let i = 0; i < 2; i++) {
      FA[m.f[i].def.id].matches++;
      const gr = (GOALS[m.f[i].def.id] ??= {});
      for (const [g, n] of Object.entries(m.f[i].ai.goalTicks)) inc(gr, g, n ?? 0);
      const ts = T[i].atkTimes;
      if (ts.length > 6) {
        const iv = ts.slice(1).map((t, k) => t - ts[k]);
        const mu = iv.reduce((s, x) => s + x, 0) / iv.length;
        const sd = Math.sqrt(iv.reduce((s, x) => s + (x - mu) * (x - mu), 0) / iv.length);
        CADENCE.push(sd / mu);
      }
    }
    // feint stats: count reacted
  }
  return m.winner;
}

// ------------------------------------------------------------------ main diag run
const trace: string[] = [];
const tStart = performance.now();
for (let i = 0; i < ids.length; i++)
  for (let j = 0; j < ids.length; j++) {
    if (i === j) continue;
    for (let s = 1; s <= SEEDS; s++) {
      const seed = s * 7919 + i * 131 + j * 17;
      runMatch(ids[i], ids[j], seed, [null, null], true, i === 0 && j === 4 && s === 1 ? trace : undefined);
    }
  }
const diagMs = performance.now() - tStart;
// attacks early/late denominators
// (blockedEarly[1]/blockedLate[1] = my non-combo attacks in that half = gbEarly[1]/gbLate[1])
for (const id of ids) {
  FA[id].blockedEarly[1] = FA[id].gbEarly[1];
  FA[id].blockedLate[1] = FA[id].gbLate[1];
}

// ------------------------------------------------------------------ cost of a plain step + state copy proxy
let stepUs = 0;
{
  const m = new Match('gorak', 'vex', 4242, { record: false, arena: arenaForSeed(4242) });
  for (let k = 0; k < 600; k++) m.step();
  const t0 = performance.now();
  for (let k = 0; k < 1200 && !m.over; k++) m.step();
  stepUs = ((performance.now() - t0) * 1000) / 1200;
  const t1 = performance.now();
  for (let k = 0; k < 2000; k++) {
    const c = structuredClone({ f: m.f.map((f) => ({ ...f, def: null, move: null, ai: { ...f.ai, mem: { ...f.ai.mem, seen: { ...f.ai.mem.seen } } } })), props: m.world.props, obs: m.world.obs, haz: m.world.haz, proj: m.projectiles.map((p) => ({ ...p, move: null })) });
    void c;
  }
  (G as any).cloneUs = ((performance.now() - t1) * 1000) / 2000;
}

// ------------------------------------------------------------------ exploit bots (mirror matches, bot on both sides alternately)
const botRes: Record<string, { botWins: number; n: number; byFighter: Record<string, [number, number]> }> = {};
for (const kind of ['spam', 'heavy', 'turtle'] as Bot[]) {
  const R = (botRes[kind] = { botWins: 0, n: 0, byFighter: {} as Record<string, [number, number]> });
  for (const id of ids)
    for (let s = 1; s <= BOT_SEEDS; s++) {
      const side = s % 2;
      const bots: [Bot | null, Bot | null] = side === 0 ? [kind, null] : [null, kind];
      const w = runMatch(id, id, 50000 + s * 313 + id.length * 7, bots, false);
      R.n++;
      const bf = (R.byFighter[id] ??= [0, 0]);
      bf[1]++;
      if (w === side) {
        R.botWins++;
        bf[0]++;
      }
    }
}

// ------------------------------------------------------------------ report
const pct = (a: number, b: number) => (b ? +((a / b) * 100).toFixed(1) : null);
const mean = (a: number[]) => (a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(3) : null);
const med = (a: number[]) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return +s[Math.floor(s.length / 2)].toFixed(3);
};
function entropyStats(mc: Record<string, Record<string, number>>) {
  const tot: Record<string, number> = {};
  let N = 0;
  for (const c of Object.values(mc)) for (const [k, v] of Object.entries(c)) ((tot[k] = (tot[k] ?? 0) + v), (N += v));
  const H = (r: Record<string, number>, n: number) => -Object.values(r).reduce((s, v) => s + (v / n) * Math.log2(v / n), 0);
  const Hm = H(tot, N);
  let Hc = 0;
  for (const c of Object.values(mc)) {
    const n = Object.values(c).reduce((s, v) => s + v, 0);
    Hc += (n / N) * H(c, n);
  }
  return { H_move_bits: +Hm.toFixed(2), H_move_given_ctx: +Hc.toFixed(2), MI_share: +((Hm - Hc) / Hm).toFixed(3) };
}
const out: any = { seedsPerPair: SEEDS, matches: G.matches, diagSeconds: +(diagMs / 1000).toFixed(1), global: {}, fighters: {}, bots: {} };
out.global = {
  meanDur: mean(G.dur),
  msPerMatchNoRecord_withAnalysis: mean(G.msPerMatch),
  stepUs_plain: +stepUs.toFixed(1),
  stateCopyUs_proxy: +(G as any).cloneUs.toFixed(1),
  exchangesPerMin: mean(G.exchangesPerMin),
  lullsOver4sPerMatch: +(G.lulls / G.matches).toFixed(2),
  lullShareOfFightTime: pct(G.lullTime, G.fightTime),
  simultaneousStartsPerMatch: +(G.simulStarts / G.matches).toFixed(2),
  tradesPerMatch: +(G.trades / G.matches).toFixed(2),
};
const sum = (k: (a: FAgg) => number) => ids.reduce((s, id) => s + k(FA[id]), 0);
const allLat = ids.flatMap((id) => FA[id].punishLatency);
const allResp = ids.flatMap((id) => FA[id].respLatency);
const mergeR = (k: (a: FAgg) => Record<string, number>) => {
  const r: Record<string, number> = {};
  for (const id of ids) for (const [a, b] of Object.entries(k(FA[id]))) inc(r, a, b);
  return r;
};
out.global.attacks = sum((a) => a.attacks);
out.global.atkCtx = mergeR((a) => a.atkCtx);
out.global.outcome = mergeR((a) => a.outcome);
out.global.atkOutOfReachPct = pct(sum((a) => a.atkOutOfReach), sum((a) => a.attacks));
out.global.punish = {
  episodes: sum((a) => a.punishEp),
  punishedPct: pct(sum((a) => a.punished), sum((a) => a.punishEp)),
  feasibleEpisodes: sum((a) => a.punishEpFeasible),
  feasiblePunishedPct: pct(sum((a) => a.punishedFeasible), sum((a) => a.punishEpFeasible)),
  latencyMedian: med(allLat),
  latencyMean: mean(allLat),
  punishAttackLandedPct: pct(sum((a) => a.punishHit), sum((a) => a.punished)),
};
out.global.incoming = { n: sum((a) => a.incoming), resp: mergeR((a) => a.resp), respLatencyMedian: med(allResp), result: mergeR((a) => a.incomingResult) };
out.global.spacing = mergeR((a) => a.spacing);
out.global.stillPctOfFree = pct(sum((a) => a.stillTicks), sum((a) => a.freeTicks));
out.global.jitterPerMin = +((sum((a) => a.jitter) / (sum((a) => a.ticks) / 3600))).toFixed(2);
out.global.goalSwitchesPerMin = +((sum((a) => a.goalSwitches) / (sum((a) => a.ticks) / 3600))).toFixed(2);
out.global.ngramAcc = { order0: pct(sum((a) => a.ngram[0]), sum((a) => a.ngram[3])), order1: pct(sum((a) => a.ngram[1]), sum((a) => a.ngram[3])), order2: pct(sum((a) => a.ngram[2]), sum((a) => a.ngram[3])) };
out.global.blockedPct = { early: pct(sum((a) => a.blockedEarly[0]), sum((a) => a.blockedEarly[1])), late: pct(sum((a) => a.blockedLate[0]), sum((a) => a.blockedLate[1])) };
out.global.guardbreakShare = { early: pct(sum((a) => a.gbEarly[0]), sum((a) => a.gbEarly[1])), late: pct(sum((a) => a.gbLate[0]), sum((a) => a.gbLate[1])) };
out.global.afterBlockedNext = mergeR((a) => a.afterBlockedNext);
out.global.feints = { n: sum((a) => a.feints), followUpPct: null as any, convertPct: pct(sum((a) => a.feintConvert), sum((a) => a.feints)) };
out.global.ults = { n: sum((a) => a.ults), hitPct: pct(sum((a) => a.ultHit), sum((a) => a.ults)), ctx: mergeR((a) => a.ultCtx) };
out.global.lowStaminaAttackPct = pct(sum((a) => a.lowStamAtk), sum((a) => a.attacks));
out.global.exhaustedPerMatch = +(sum((a) => a.exhausted) / (G.matches * 2)).toFixed(2);
const rate = (x: [number, number][]) => x.map(([a, t]) => (t ? +((a / (t / 60)) * 60).toFixed(1) : null)); // attacks per minute of free time
out.global.attacksPerFreeMinByHp = rate(ids.reduce((acc, id) => acc.map((v, k) => [v[0] + FA[id].hpAtk[k][0], v[1] + FA[id].hpAtk[k][1]] as [number, number]), [[0, 0], [0, 0], [0, 0]] as [number, number][]));
out.global.attacksPerFreeMinByLead = rate(ids.reduce((acc, id) => acc.map((v, k) => [v[0] + FA[id].leadAtk[k][0], v[1] + FA[id].leadAtk[k][1]] as [number, number]), [[0, 0], [0, 0], [0, 0]] as [number, number][]));
out.global.heavyShareByHp = [0, 1, 2].map((k) => pct(sum((a) => a.heavyByHp[k][0]), sum((a) => a.heavyByHp[k][1])));
for (const id of ids) {
  const A = FA[id];
  out.fighters[id] = {
    attacksPerMatch: +(A.attacks / A.matches).toFixed(1),
    atkCtx: Object.fromEntries(Object.entries(A.atkCtx).map(([k, v]) => [k, pct(v, A.attacks)])),
    outcome: Object.fromEntries(Object.entries(A.outcome).map(([k, v]) => [k, +(v / A.matches).toFixed(2)])),
    punishedPct: pct(A.punished, A.punishEp),
    feasiblePunishedPct: pct(A.punishedFeasible, A.punishEpFeasible),
    punishLatencyMed: med(A.punishLatency),
    incomingResp: Object.fromEntries(Object.entries(A.resp).map(([k, v]) => [k, pct(v, A.incoming)])),
    incomingResult: Object.fromEntries(Object.entries(A.incomingResult).map(([k, v]) => [k, pct(v, A.incoming)])),
    stillPct: pct(A.stillTicks, A.freeTicks),
    spacing: Object.fromEntries(Object.entries(A.spacing).map(([k, v]) => [k, pct(v, A.freeTicks)])),
    ctxEntropy: entropyStats(A.moveCtx),
    ngram: { o0: pct(A.ngram[0], A.ngram[3]), o1: pct(A.ngram[1], A.ngram[3]), o2: pct(A.ngram[2], A.ngram[3]) },
    blocked: { early: pct(A.blockedEarly[0], A.blockedEarly[1]), late: pct(A.blockedLate[0], A.blockedLate[1]) },
    gbShare: { early: pct(A.gbEarly[0], A.gbEarly[1]), late: pct(A.gbLate[0], A.gbLate[1]) },
    feintConvertPct: pct(A.feintConvert, A.feints),
    ults: A.ults, ultHitPct: pct(A.ultHit, A.ults),
  };
}
const ctxAll: Record<string, Record<string, number>> = {};
out.global.ctxEntropyMean = +(ids.reduce((s, id) => s + entropyStats(FA[id].moveCtx).MI_share, 0) / ids.length).toFixed(3);
void ctxAll;
out.global.ctxOutcome = Object.fromEntries(
  Object.entries(CTXOUT).map(([c, r]) => {
    const n = Object.values(r).reduce((s, v) => s + v, 0);
    return [c, { n, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, pct(v, n)])) }];
  }),
);
out.global.heavy = { attempts: heavyAtt, whiffPct: pct(heavyWhiffs, heavyAtt), whiffsPerMatch: +(heavyWhiffs / G.matches).toFixed(2) };
out.global.hitsOnAttackingVictimPerMatch = +(tradeHits / G.matches).toFixed(2);
out.global.hitsOnStaggeredOrDownPerMatch = +(followHits / G.matches).toFixed(2);
out.global.ultLandedPct = pct(ultLanded, sum((a) => a.ults));
out.global.exhaustedTimePct = pct(exhaustedTicks, liveTicks);
out.global.attackCadenceCV = { mean: mean(CADENCE), median: med(CADENCE) };
out.goals = Object.fromEntries(
  Object.entries(GOALS).map(([id, r]) => {
    const n = Object.values(r).reduce((s, v) => s + v, 0);
    return [id, Object.fromEntries(Object.entries(r).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, pct(v, n)]))];
  }),
);
for (const [k, R] of Object.entries(botRes)) out.bots[k] = { botWinPct: pct(R.botWins, R.n), n: R.n, byFighter: Object.fromEntries(Object.entries(R.byFighter).map(([id, [w, n]]) => [id, `${w}/${n}`])) };
writeFileSync('tools/ai/_scratch/diag-out.json', JSON.stringify(out, null, 1));
writeFileSync('tools/ai/_scratch/trace-sample.txt', trace.join('\n'));
console.log(JSON.stringify(out.global, null, 1));
console.log(JSON.stringify(out.bots, null, 1));
console.log('total s', ((performance.now() - tStart) / 1000).toFixed(1));
