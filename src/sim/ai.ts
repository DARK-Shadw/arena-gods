/**
 * FIGHTER AI - layered utility AI (see docs/ai-design.md).
 *
 *   1. REACTION (every tick, "System 1"): notice an incoming attack whose real
 *      reach (animation strike points + lunge) covers us; after a human
 *      reaction delay choose block / parry / dodge / back-step out of measure /
 *      counter-attack into the windup / eat it. Learned opponent habits
 *      (feint rate) modulate how readily we bite.
 *   2. PERCEPTION + ASSESSMENT (every ~0.15-0.35 s, an OODA loop): spacing vs
 *      own preferred band and the opponent's threat range, openings
 *      (recovery / stagger / whiff windows), stamina, HP, cornered, cover,
 *      line of sight, matchup (my doctrine vs theirs).
 *   3. GOAL SELECTION by utility (+ commitment hysteresis + seeded noise):
 *      punish, pressure, close, kite, footsies, bait, guard, regroup, cover,
 *      escape, finish, gambit.
 *   4. ACTION SELECTION: footwork vector for the goal and a move chosen by
 *      utility over reach, tags, opponent model, repetition, risk, personality.
 *
 * Human-like mistakes (not random flailing): misjudged spacing scaled by skill,
 * greed after a landed hit, panic rolls at low HP, stubborn personalities
 * adapting slowly. Everything uses the match's seeded RNG - deterministic.
 */
import { LAUNCH, launchForce } from './launch';
import { atan2, cos, hypot, pow, sin } from './dmath';
import type { Rng } from './rng';
import { PS_REST, THROW_RELEASE, segPointDist } from './world';
import type { MoveDef } from './types';
import type { FighterState, Match } from './match';
import { doctrineOf, type Doctrine } from './doctrine';
import { edgeReach } from './reach';

/** Switches for A/B metrics (tools/simtest ARENA_AI=0 disables the arena tactics layer). */
export const AI_TUNING = { arenaTactics: true };

/**
 * A2b environment-use tuning (owner: fighters must use the environment much more often). Before A2b: search radius
 * 6 m, grab base 1.2 + usesProps * 1.6, decay x0.8 per pickup, no brazier tipping.
 */
export const ENV_AI = { propSearch: 8.5, grabBase: 1.7, grabProps: 1.9, grabDecay: 0.9, liftSafety: 0.45, igniteChance: 0.35 };

export type Goal = 'pressure' | 'close' | 'kite' | 'footsies' | 'bait' | 'guard' | 'regroup' | 'cover' | 'escape' | 'punish' | 'finish' | 'gambit' | 'grab' | 'smash';

interface OppModel {
  attacks: number;
  heavy: number;
  ranged: number;
  feints: number;
  pressureT: number; // time of their last attack start
  /** how often they block / dodge / parry my attacks (EMA) */
  blockRate: number;
  dodgeRate: number;
  parryRate: number;
  lastId: number;
  lastState: string;
}

export interface AIState {
  nextThink: number;
  goal: Goal;
  goalUntil: number;
  circleDir: number;
  reactedTo: number;
  pending: { at: number; kind: 'block' | 'parry' | 'dodge' | 'counter' | 'backstep'; attackId: number; until: number } | null;
  boostUntil: number;
  /** pending attack decided earlier, released after a timing mix-up delay */
  queued: { move: MoveDef; at: number } | null;
  backstepUntil: number;
  zig: number;
  recent: string[];
  greedUntil: number;
  mem: { myAttacks: number; blocked: number; dodged: number; parried: number; seen: Record<string, number> };
  opp: OppModel;
  lastBlocked: number;
  lastDodged: number;
  lastParried: number;
  lastMyAttacks: number;
  /** analytics: ticks spent per goal */
  goalTicks: Partial<Record<Goal, number>>;
  /** arena play: prop we're going for, obstacle we're smashing, when we picked something up */
  propTarget: number;
  obsTarget: number;
  carryT: number;
  pickups: number;
  /** analytics: ticks with cover between us and a ranged opponent */
  coverTicks: number;
  /** analytics: environment tactics attempted */
  tactics: Record<string, number>;
}

export function createAIState(rng: Rng): AIState {
  return {
    nextThink: 0.5 + rng.next() * 0.4,
    goal: 'close',
    goalUntil: 0,
    circleDir: rng.chance(0.5) ? 1 : -1,
    reactedTo: -1,
    pending: null,
    boostUntil: 0,
    queued: null,
    backstepUntil: 0,
    zig: rng.next() * 6,
    recent: [],
    greedUntil: 0,
    mem: { myAttacks: 0, blocked: 0, dodged: 0, parried: 0, seen: {} },
    opp: { attacks: 0, heavy: 0, ranged: 0, feints: 0, pressureT: -9, blockRate: 0.2, dodgeRate: 0.15, parryRate: 0.05, lastId: -1, lastState: 'idle' },
    lastBlocked: 0,
    lastDodged: 0,
    lastParried: 0,
    lastMyAttacks: 0,
    goalTicks: {},
    propTarget: -1,
    obsTarget: -1,
    carryT: 0,
    pickups: 0,
    coverTicks: 0,
    tactics: {},
  };
}

const hpf = (f: FighterState) => f.hp / f.maxHp;
const gapOf = (f: FighterState, o: FighterState) => hypot(o.x - f.x, o.z - f.z) - f.def.stats.radius - o.def.stats.radius;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const hasTag = (m: MoveDef, t: string) => !!m.tags?.includes(t);
/** zoners/kiters fight from range; others may carry a ranged poke but are not "ranged fighters" */
const isRangedFighter = (f: FighterState) => {
  const r = doctrineOf(f.def.id).role;
  return r === 'zoner' || r === 'kiter';
};
const MAGNET = 0.6;

/** Usable reach (edge gap) of a move for this fighter, including lunge/magnetism. */
function reachOf(f: FighterState, m: MoveDef): number {
  const base = edgeReach(f.def.id, m, f.def.stats.radius);
  if (m.ranged) return base;
  return base + Math.max(0, m.lunge ?? 0) * 0.85 + MAGNET * 0.8;
}

/** Opponent's threat range: how far their quick attacks reach (their "measure"). */
function threatRange(o: FighterState): number {
  let r = 0.4;
  for (const m of o.def.moves) {
    if (m.ranged || m.feint || m.kind === 'ultimate' || m.windup > 0.65) continue;
    r = Math.max(r, reachOf(o, m));
  }
  return r;
}

function lineBlocked(m: Match, a: FighterState, b: FighterState): boolean {
  return m.world.blocked(a.x, a.z, b.x, b.z);
}
/** distance to the (shrinking) arena edge */
const edgeAt = (m: Match, x: number, z: number) => m.world.edgeGap(x, z, m.ringS);
/** 1 when the prop lies roughly between me and them, 0 when it's behind me */
const onTheWay = (f: FighterState, o: FighterState, p: { x: number; z: number }) => {
  const ax = o.x - f.x,
    az = o.z - f.z,
    bx = p.x - f.x,
    bz = p.z - f.z;
  const c = (ax * bx + az * bz) / ((hypot(ax, az) || 1) * (hypot(bx, bz) || 1));
  return Math.max(0, c);
};
const tactic = (f: FighterState, k: string) => (f.ai.tactics[k] = (f.ai.tactics[k] ?? 0) + 1);

/** Furthest any of their melee moves (incl. gap closers) reaches - safe distance to bend over. */
const maxReachCache = new Map<string, number>();
function maxReach(o: FighterState): number {
  let r = maxReachCache.get(o.def.id);
  if (r === undefined) {
    r = 0.5;
    for (const m of o.def.moves) if (!m.ranged && !m.feint && !m.furyCost) r = Math.max(r, reachOf(o, m));
    maxReachCache.set(o.def.id, r);
  }
  return r;
}

/** is there time to bend over and pick something up? */
function safeToLift(m: Match, f: FighterState, o: FighterState, q: { gap: number; los: boolean; oppRanged: boolean; prop: number }): boolean {
  const p = m.world.props[q.prop];
  const d = hypot(p.x - f.x, p.z - f.z);
  if ((o.state === 'knockdown' || o.state === 'launched') && o.stateDur - o.stateT > 0.5 && d < 3.5) return true;
  if (oppBusy(m, o) && q.gap > 2.5) return true;
  if (q.oppRanged) return !q.los && q.gap > 3;
  // brutes who love throwing things take the risk sooner
  return q.gap > Math.min(maxReach(o) + 0.3, 6.0) * (1 - ENV_AI.liftSafety * doctrineOf(f.def.id).usesProps) || (!q.los && q.gap > 3);
}

/** opponent tied up for a moment (safe-ish to bend over for a prop) */
function oppBusy(m: Match, o: FighterState): boolean {
  if (o.state === 'stagger' || (o.state === 'knockdown' || o.state === 'launched') || o.state === 'getup' || o.state === 'winded' || o.state === 'taunt' || o.state === 'lift') return true;
  return o.state === 'attack' && !!o.move && m.attackPhase(o) === 2 && o.stateDur - o.stateT > 0.4;
}

/** Seconds the opponent stays punishable (0 = not open). */
function openWindow(m: Match, o: FighterState): number {
  if (o.state === 'stagger' || o.state === 'taunt' || o.state === 'winded') return Math.max(0, o.stateDur - o.stateT);
  if (o.state === 'getup') return Math.max(0, o.stateDur - o.stateT - 0.3);
  if ((o.state === 'knockdown' || o.state === 'launched')) return o.stateDur - o.stateT < 0.5 ? 0.25 : 0;
  if (o.state === 'attack' && o.move && m.attackPhase(o) === 2) return o.move.windup + o.move.active + o.move.recovery - o.stateT;
  if (o.state === 'roar') return 0;
  // bending over to pick something up / winding up a throw: free hit
  if (o.state === 'lift' || o.state === 'throw') return Math.max(0, o.stateDur - o.stateT - 0.15);
  return 0;
}

function aggression(m: Match, f: FighterState, o: FighterState): number {
  const P = f.def.personality;
  let a = P.aggression;
  const h = hpf(f);
  if (m.t < f.ai.boostUntil) a += 0.4;
  if (f.buffT > 0) a += 0.25;
  if (h < 0.35) a += P.desperation * 0.4;
  if (f.lastStand) a += 0.4;
  if (hpf(o) < 0.25) a += 0.15;
  if (f.exhausted) a -= 0.35;
  if (h - hpf(o) > 0.2) a -= P.pride * 0.2; // complacent showboat
  a += Math.max(0, (m.t - 45) / 60) * 0.3; // crowd wants blood
  return clamp(a, 0.05, 1.5);
}

function caution(f: FighterState): number {
  const P = f.def.personality;
  let c = P.caution;
  if (P.desperation < 0 && hpf(f) < 0.4 && !f.lastStand) c += -P.desperation * 0.5;
  return c;
}

export function wantsCombo(m: Match, f: FighterState, o: FighterState, next: MoveDef): boolean {
  if (f.stamina < next.stamina * 0.6) return false;
  if ((o.state === 'knockdown' || o.state === 'launched') || o.state === 'dead' || m.isInvulnerable(o)) return false;
  if (gapOf(f, o) > reachOf(f, next) + 0.2) return false;
  // after a block, only continue with a guard-breaker (or out of greed)
  const greedy = m.t < f.ai.greedUntil;
  if (o.state === 'block' && !hasTag(next, 'guardbreak') && !greedy) return m.rng.chance(0.15);
  const p = 0.3 + aggression(m, f, o) * 0.3 + (f.hitLanded ? 0.4 : -0.2) + (greedy ? 0.25 : 0);
  return m.rng.chance(p);
}

// =====================================================================================

export function aiTick(m: Match, f: FighterState, o: FighterState) {
  const ai = f.ai;
  if (f.state === 'dead' || f.state === 'victory') {
    f.wantX = f.wantZ = 0;
    return;
  }
  observe(m, f, o);
  ai.goalTicks[ai.goal] = (ai.goalTicks[ai.goal] ?? 0) + 1;
  if (isRangedFighter(o) && lineBlocked(m, f, o)) ai.coverTicks++;
  // ---- 1. notice new incoming attacks
  if (o.state === 'attack' && o.move && o.attackId !== ai.reactedTo && m.attackPhase(o) === 0) {
    ai.reactedTo = o.attackId;
    planReaction(m, f, o, o.move);
  }
  // incoming projectiles: sidestep if one is about to hit us
  dodgeProjectiles(m, f);
  if (!m.canAct(f)) return;

  // ---- 2. scheduled reaction
  if (ai.pending && m.t >= ai.pending.at) {
    const p = ai.pending;
    ai.pending = null;
    if (o.state === 'attack' && o.attackId === p.attackId && o.move) {
      executeReaction(m, f, o, o.move, p.kind, p.until);
      if (!m.canAct(f) || f.state === 'block') return;
    }
  }
  if (f.state === 'block' || ai.pending) {
    steer(m, f, o);
    return;
  }
  // ---- 3. a queued attack (timing mix-up) fires when its moment comes
  if (ai.queued && m.t >= ai.queued.at) {
    const q = ai.queued;
    ai.queued = null;
    if (moveUsable(m, f, o, q.move, gapOf(f, o))) {
      if (m.startAttack(f, q.move)) {
        remember(f, q.move);
        return;
      }
    }
  }
  if (f.carry >= 0) {
    carryTick(m, f, o);
    return;
  }
  if (f.ai.carryT > 0) f.ai.carryT = 0;
  if (m.t < ai.nextThink) {
    steer(m, f, o);
    return;
  }
  ai.nextThink = m.t + m.rng.range(0.14, 0.3) * (1.2 - Math.min(1, aggression(m, f, o)) * 0.4);
  think(m, f, o);
  if (m.canAct(f)) steer(m, f, o);
}

/** Update the opponent model from what we can observe. */
function observe(m: Match, f: FighterState, o: FighterState) {
  const ai = f.ai;
  const om = ai.opp;
  const P = f.def.personality;
  const lr = 0.1 + P.adaptability * 0.35; // stubborn fighters learn slowly
  if (o.state === 'attack' && o.move && o.attackId !== om.lastId) {
    om.lastId = o.attackId;
    om.attacks++;
    om.pressureT = m.t;
    const heavy = o.move.kind === 'heavy' || o.move.kind === 'ultimate' ? 1 : 0;
    om.heavy += (heavy - om.heavy) * lr;
    om.ranged += ((o.move.ranged ? 1 : 0) - om.ranged) * lr;
    om.feints += ((o.move.feint ? 1 : 0) - om.feints) * lr * 0.8;
  }
  // outcomes of MY attacks (block/dodge/parry counters are bumped by the sim)
  if (ai.mem.myAttacks !== ai.lastMyAttacks) {
    const n = ai.mem.myAttacks - ai.lastMyAttacks;
    const b = ai.mem.blocked - ai.lastBlocked,
      d = ai.mem.dodged - ai.lastDodged,
      p = ai.mem.parried - ai.lastParried;
    om.blockRate += (Math.min(1, b / n) - om.blockRate) * lr;
    om.dodgeRate += (Math.min(1, d / n) - om.dodgeRate) * lr;
    om.parryRate += (Math.min(1, p / n) - om.parryRate) * lr;
    ai.lastMyAttacks = ai.mem.myAttacks;
    ai.lastBlocked = ai.mem.blocked;
    ai.lastDodged = ai.mem.dodged;
    ai.lastParried = ai.mem.parried;
  }
  om.lastState = o.state;
  if (f.hitLanded && f.state === 'attack') ai.greedUntil = m.t + 0.8 * P.aggression;
}

function remember(f: FighterState, mv: MoveDef) {
  f.ai.recent.push(mv.id);
  if (f.ai.recent.length > 5) f.ai.recent.shift();
}

// ------------------------------------------------------------------ reaction layer
function planReaction(m: Match, f: FighterState, o: FighterState, mv: MoveDef) {
  const ai = f.ai;
  const S = f.def.stats;
  const P = f.def.personality;
  const gap = gapOf(f, o);
  if (mv.feint) {
    // a feint looks like a real windup; the more they feint, the less we bite
    if (m.rng.chance(ai.opp.feints * (0.4 + P.adaptability * 0.6))) return;
  }
  if (mv.ranged) return; // projectiles are handled when they're in flight
  // carrying something: hurl it into their face before the swing lands
  if (f.carry >= 0 && f.state === 'idle' && mv.windup - o.stateT > THROW_RELEASE + 0.05 && gap > 0.6) {
    if (m.startThrow(f)) {
      tactic(f, 'throw_interrupt');
      return;
    }
  }
  const reach = reachOf(o, mv) + 0.3;
  if (gap > reach) return;
  ai.mem.seen[mv.id] = (ai.mem.seen[mv.id] ?? 0) + 1;
  const familiarity = Math.min(0.2, (ai.mem.seen[mv.id] - 1) * 0.04 * P.adaptability);
  let notice = 0.4 + 0.42 * S.skill + familiarity - (f.exhausted ? 0.25 : 0);
  if (mv.kind === 'heavy' || mv.kind === 'ultimate' || mv.windup >= 0.6) notice += 0.12; // big telegraph
  if (!m.rng.chance(notice)) return;
  const timeToActive = mv.windup - o.stateT;
  const react = S.reaction * m.rng.range(0.75, 1.4);
  const until = m.t + timeToActive + mv.active + 0.12;
  const unb = !!mv.unblockable;
  const big = mv.kind === 'heavy' || mv.kind === 'ultimate';
  const multi = (mv.hits ?? 1) > 1;
  const c = caution(f);
  const fast = fastestMove(f, gap, true);
  const canCounter = !!fast && fast.windup + react < timeToActive - 0.03 && f.stamina > fast.stamina;
  // "measure" defence: step out of reach before it lands (fencing distance)
  const needOut = reach - gap + 0.25;
  const canBackstep = needOut > 0 && needOut < 1.2 && (timeToActive - react) * S.speed * 0.7 > needOut && !f.exhausted && mv.kind !== 'gap';
  const hasCounterMove = f.def.moves.some((x) => x.counter);
  const w = [
    unb ? 0 : (0.45 + c * 0.7) * (f.stamina > 30 ? 1 : 0.3) * (S.hasShield ? 1.8 : 1) * (1 - S.agility * 0.45),
    !unb && !multi ? S.skill * (S.hasShield ? 1.1 : 0.5) * (0.5 + P.patience * 0.6) * (hasCounterMove ? 1.4 : 1) : 0,
    f.stamina >= 18 ? (0.2 + S.agility * 1.1 + c * 0.3) * (unb ? 2.5 : 1) * (big ? 1.3 : 1) : 0,
    canCounter ? P.aggression * (big ? 1.6 : 0.45) : 0,
    canBackstep ? (0.2 + S.skill * 0.5 + P.patience * 0.3) * (big ? 1.3 : 1) : 0,
    0.12 + P.pride * 0.1,
  ];
  const kinds = ['block', 'parry', 'dodge', 'counter', 'backstep', 'none'] as const;
  const k = kinds[m.rng.weighted(w)];
  if (!k || k === 'none') return;
  let at = m.t + react;
  if (k === 'parry') at = Math.max(at, m.t + timeToActive - 0.08 + m.rng.gauss() * 0.07 * (1.2 - S.skill));
  if (k === 'dodge') at = Math.max(at, m.t + timeToActive - 0.18 + m.rng.gauss() * 0.09 * (1.2 - S.skill));
  ai.pending = { at, kind: k, attackId: o.attackId, until };
}

function executeReaction(m: Match, f: FighterState, o: FighterState, mv: MoveDef, kind: string, until: number) {
  if (kind === 'block' || kind === 'parry') {
    m.startBlock(f, until);
    f.parryIntent = kind === 'parry';
    return;
  }
  if (kind === 'counter') {
    const fast = fastestMove(f, gapOf(f, o), true);
    if (fast && m.startAttack(f, fast)) remember(f, fast);
    return;
  }
  if (kind === 'backstep') {
    f.ai.backstepUntil = m.t + 0.32;
    return;
  }
  // dodge: sidestep narrow attacks, back-roll wide ones; avoid walls
  const ux = o.x - f.x,
    uz = o.z - f.z;
  const l = hypot(ux, uz) || 1;
  const nx = ux / l,
    nz = uz / l;
  const wide = mv.aoe || mv.arc >= 70;
  const side = pickSide(m, f, -nz, nx);
  const back = wide ? 0.8 : 0.25;
  const lat = wide ? 0.45 : 1;
  let dx = -nx * back + -nz * side * lat;
  let dz = -nz * back + nx * side * lat;
  if (edgeAt(m, f.x + dx * 2.5, f.z + dz * 2.5) < 0.8 || m.world.danger(m, f.x + dx * 2.2, f.z + dz * 2.2) > 1) {
    dx = -nz * side;
    dz = nx * side;
  }
  m.startDodge(f, dx, dz);
}

/** Roll/sidestep out of the path of a projectile that will hit us soon. */
function dodgeProjectiles(m: Match, f: FighterState) {
  if (!m.canAct(f) || f.stamina < 15) return;
  const flying = m.world.props.filter((p) => p.state === 2 && p.owner >= 0).map((p) => ({ owner: p.owner, x: p.x, z: p.z, vx: p.vx, vz: p.vz, id: p.id + 2e6, thrown: true }));
  for (const p of [...m.projectiles.map((q) => ({ owner: q.owner, x: q.x, z: q.z, vx: q.vx, vz: q.vz, id: q.id, thrown: false })), ...flying]) {
    if (p.owner === f.idx) continue;
    const dx = f.x - p.x,
      dz = f.z - p.z;
    const sp = hypot(p.vx, p.vz) || 1;
    const along = (dx * p.vx + dz * p.vz) / sp;
    if (along < 0) continue;
    const tHit = along / sp;
    const perp = Math.abs(dx * p.vz - dz * p.vx) / sp;
    if (perp > f.def.stats.radius + 0.3 || tHit > 0.45) continue;
    const key = p.id + 1e6;
    if (f.ai.reactedTo === key) return;
    f.ai.reactedTo = key;
    const S = f.def.stats;
    const P = f.def.personality;
    // seeing the shot: skill + agility; shields just block it
    if (!m.rng.chance(0.25 + S.skill * 0.45 + S.agility * 0.2 + (S.hasShield ? 0.3 : 0) - (tHit < S.reaction ? 0.35 : 0))) return;
    if (AI_TUNING.arenaTactics && p.thrown && f.carry < 0 && tHit > 0.12) {
      // swat a thrown prop out of the air with a quick swing (if one comes out in time)
      const fast = fastestMove(f, 0, true);
      if (fast && fast.windup < tHit - 0.02 && m.rng.chance(0.25 + S.skill * 0.4) && m.startAttack(f, fast)) {
        tactic(f, 'swat');
        remember(f, fast);
        return;
      }
    }
    if (S.hasShield || (m.rng.chance(caution(f) * 0.5) && f.stamina > 30)) {
      m.startBlock(f, m.t + tHit + 0.15);
      return;
    }
    const side = m.rng.chance(0.5) ? 1 : -1;
    const ok = m.startDodge(f, (-p.vz / sp) * side, (p.vx / sp) * side);
    void ok;
    void P;
    return;
  }
}

function pickSide(m: Match, f: FighterState, px: number, pz: number): number {
  const score = (s: number) => {
    const x = f.x + px * s * 2.5,
      z = f.z + pz * s * 2.5;
    let sc = -Math.max(0, 1.5 - edgeAt(m, x, z)) * 3 - m.world.danger(m, x, z) * 2;
    for (let i = 0; i < m.arena.obstacles.length; i++) {
      if (!m.world.standing(i)) continue;
      const p = m.arena.obstacles[i];
      sc -= Math.max(0, 2 - hypot(x - p.x, z - p.z));
    }
    return sc + m.rng.next() * 0.3;
  };
  return score(1) >= score(-1) ? 1 : -1;
}

function fastestMove(f: FighterState, gap: number, meleeOnly = false): MoveDef | null {
  let best: MoveDef | null = null;
  for (const mv of f.def.moves) {
    if (mv.kind === 'ultimate' || mv.kind === 'combo' || mv.feint) continue;
    if (meleeOnly && mv.ranged) continue;
    if (gap > reachOf(f, mv) - 0.2) continue;
    if (!best || mv.windup < best.windup) best = mv;
  }
  return best;
}

function moveUsable(m: Match, f: FighterState, o: FighterState, mv: MoveDef, gap: number): boolean {
  if (mv.furyCost) {
    if (f.fury < mv.furyCost) return false;
  } else if (f.stamina < mv.stamina * 0.6) return false;
  if (mv.kind === 'combo') return false;
  if (mv.minRange !== undefined && gap < mv.minRange) return false;
  if (mv.ranged) return gap <= mv.range - 0.6 && !lineBlocked(m, f, o);
  return gap <= reachOf(f, mv);
}

// ------------------------------------------------------------------ perception / goals
interface Percept {
  gap: number;
  my: number;
  their: number;
  open: number;
  threat: number;
  band: [number, number];
  doc: Doctrine;
  oppDoc: Doctrine;
  ranged: boolean;
  oppRanged: boolean;
  cornered: boolean;
  oppCornered: boolean;
  los: boolean;
  aggr: number;
  caut: number;
  stam: number;
  oppPressing: boolean;
  /** what's behind the opponent (along my line of attack) within ~2.5 m: hazard / wall / cover */
  backHazard: number;
  /** a throwable prop worth grabbing */
  prop: number;
  /** cover obstacle I could bring down on them */
  topple: number;
  /** cover between us that hides a ranged opponent / blocks my shots */
  blocker: number;
  /** explosive barrel next to the opponent I can shoot */
  barrel: number;
  /** A2b: a brazier right next to them I can knock over (burning oil under their feet) */
  ignite: number;
  /** A2b: a still chain weight between us whose swing would sweep through them */
  chain: number;
}

function perceive(m: Match, f: FighterState, o: FighterState): Percept {
  const gap = gapOf(f, o);
  const ef = edgeAt(m, f.x, f.z),
    eo = edgeAt(m, o.x, o.z);
  const doc = doctrineOf(f.def.id);
  const W = m.world;
  // what's behind them
  let backHazard = 0;
  {
    const dx = o.x - f.x,
      dz = o.z - f.z;
    const l = hypot(dx, dz) || 1;
    for (const k of [1.2, 2.2]) {
      const x = o.x + (dx / l) * k,
        z = o.z + (dz / l) * k;
      backHazard = Math.max(backHazard, Math.min(3, W.danger(m, x, z, 0.4)) * 0.6, edgeAt(m, x, z) < 0.3 ? 0.8 : 0, W.blocked(o.x, o.z, x, z, 0.05) ? 0.7 : 0);
    }
  }
  // throwable prop I'm closer to (and that's not under their nose)
  let prop = -1,
    pd = 1e9;
  for (const p of W.props) {
    if (p.state !== PS_REST || !p.throwable || p.carrier >= 0 || p.fuseAt >= 0) continue;
    const d = hypot(p.x - f.x, p.z - f.z);
    const dOpp = hypot(p.x - o.x, p.z - o.z);
    if (d > ENV_AI.propSearch || dOpp < d + 0.6 || dOpp < 2.6) continue;
    const sc = d - (p.explosive ? 1.5 : 0) - p.mass * 0.5;
    if (sc < pd) {
      pd = sc;
      prop = p.id;
    }
  }
  // a damaged column next to me whose fall line covers them
  let topple = -1;
  let blocker = -1;
  for (let i = 0; i < m.arena.obstacles.length; i++) {
    const ob = m.arena.obstacles[i];
    if (!W.standing(i) || !ob.toppleable) continue;
    const st = W.obs[i];
    const dMe = hypot(ob.x - f.x, ob.z - f.z);
    const dx = ob.x - f.x,
      dz = ob.z - f.z;
    const l = dMe || 1;
    const line = segPointDist(ob.x, ob.z, ob.x + (dx / l) * ob.h, ob.z + (dz / l) * ob.h, o.x, o.z);
    const beyond = (o.x - ob.x) * dx + (o.z - ob.z) * dz > 0;
    if (beyond && line < o.def.stats.radius + ob.r * 0.6 + 0.3 && st.hp < 150 && dMe < (isRangedFighter(f) ? 11 : 4.5)) topple = i;
    if (blocker < 0 && W.blocked(f.x, f.z, o.x, o.z) && segPointDist(f.x, f.z, o.x, o.z, ob.x, ob.z) < ob.r + 0.2) blocker = i;
  }
  // explosive barrel beside them
  let barrel = -1;
  for (const p of W.props) {
    if (p.state !== PS_REST || !p.explosive || p.fuseAt >= 0) continue;
    if (hypot(p.x - o.x, p.z - o.z) < 2.4 && hypot(p.x - f.x, p.z - f.z) > 4.2 && !W.blocked(f.x, f.z, p.x, p.z)) barrel = p.id;
  }
  // a brazier beside them (its oil spills ~1.25 m around it) that I can reach and knock over
  let ignite = -1;
  if (AI_TUNING.arenaTactics)
    for (const p of W.props) {
      if (p.state !== PS_REST || p.kind !== 'brazier') continue;
      if (hypot(p.x - o.x, p.z - o.z) > 1.15 + o.def.stats.radius) continue;
      if (hypot(p.x - f.x, p.z - f.z) < 1.6) continue; // not under my own feet
      ignite = p.id;
    }
  // a still chain weight I can strike so that it swings through them
  let chain = -1;
  if (AI_TUNING.arenaTactics)
    for (let i = 0; i < m.arena.hazards.length; i++) {
      const h = m.arena.hazards[i];
      if (h.kind !== 'chains' || W.haz[i].state !== 0) continue;
      const ax = sin(h.phase),
        az = cos(h.phase);
      const sm = (f.x - h.x) * ax + (f.z - h.z) * az,
        so = (o.x - h.x) * ax + (o.z - h.z) * az;
      const pm = Math.abs((f.x - h.x) * az - (f.z - h.z) * ax),
        po = Math.abs((o.x - h.x) * az - (o.z - h.z) * ax);
      if (sm * so < 0 && Math.abs(so) < 2.2 && po < 0.9 && pm < 1.6 && hypot(h.x - f.x, h.z - f.z) < 2.6) chain = i;
    }
  return {
    gap,
    my: hpf(f),
    their: hpf(o),
    open: openWindow(m, o),
    threat: threatRange(o),
    band: doc.band,
    doc,
    oppDoc: doctrineOf(o.def.id),
    ranged: isRangedFighter(f),
    oppRanged: isRangedFighter(o),
    cornered: ef < 1.8 && eo > ef + 0.6 && gap < 3.2,
    oppCornered: eo < 1.8 && ef > eo + 0.6 && gap < 3.2,
    los: !lineBlocked(m, f, o),
    aggr: aggression(m, f, o),
    caut: caution(f),
    stam: f.stamina / f.def.stats.stamina,
    oppPressing: m.t - f.ai.opp.pressureT < 1.2 && gap < threatRange(o) + 0.5,
    backHazard,
    prop,
    topple,
    blocker,
    barrel,
    ignite,
    chain,
  };
}

function scoreGoals(m: Match, f: FighterState, o: FighterState, q: Percept): Record<Goal, number> {
  const P = f.def.personality;
  const S = f.def.stats;
  const role = q.doc.role;
  const meleeRole = !q.ranged;
  const far = q.gap > q.band[1] + 0.3;
  const near = q.gap < q.band[0] - 0.2;
  const inBand = !far && !near;
  const g: Record<Goal, number> = {
    punish: q.open > 0.15 ? 2.6 + S.skill * 0.8 : 0,
    finish: q.their < 0.22 ? 1.0 + q.aggr * 0.8 + P.pride * 0.3 : 0,
    pressure: inBand ? 0.7 + q.aggr * 1.0 + (o.exhausted ? 0.6 : 0) + (q.oppCornered ? 0.7 : 0) + (f.buffT > 0 ? 0.4 : 0) : 0.1,
    close: far ? 0.9 + q.aggr * 0.6 + (meleeRole && q.oppRanged ? 1.0 : 0) : 0,
    kite: q.ranged ? (near || q.gap < q.band[0] + 1.0 ? 1.4 + q.caut * 0.8 : inBand ? 0.6 : 0) + (q.oppRanged ? -0.4 : 0.4) : 0,
    footsies: Math.abs(q.gap - q.threat) < 1.0 && !q.ranged ? 0.5 + P.patience * 0.9 + S.skill * 0.4 : 0,
    bait: Math.abs(q.gap - q.threat) < 1.4 ? q.doc.mindGames * (0.5 + (f.ai.opp.dodgeRate + f.ai.opp.parryRate + f.ai.opp.blockRate) * P.adaptability * 1.2) : 0,
    guard: q.oppPressing && f.stamina > 25 ? 0.35 + q.caut * 0.8 + (S.hasShield ? 0.5 : 0) : 0,
    regroup: (q.stam < 0.3 ? 1.0 + q.caut : 0) + (f.exhausted ? 0.8 : 0) + (q.my < 0.3 && q.caut > 0.5 ? 0.5 : 0),
    cover: q.oppRanged && !q.ranged ? (q.my < 0.5 || q.stam < 0.35 ? 0.4 + q.doc.usesCover * 1.2 : q.doc.usesCover * 0.3) : q.oppRanged && q.ranged && q.my < q.their ? q.doc.usesCover * 0.8 : 0,
    escape: q.cornered ? 1.3 + q.caut * 0.8 + (q.ranged ? 1.0 : 0) - (role === 'tank' ? 0.6 : 0) : 0,
    gambit: q.my < 0.2 && P.desperation > 0 ? 0.8 + P.desperation : 0,
    // arena play: grab something to throw (melee vs a kiter / opponent hiding / brutes showing off)
    grab:
      AI_TUNING.arenaTactics && q.prop >= 0 && !q.oppPressing && safeToLift(m, f, o, q)
        ? (q.ranged ? 0.45 : 1) * (ENV_AI.grabBase + q.doc.usesProps * ENV_AI.grabProps + ((o.state === 'knockdown' || o.state === 'launched') ? 0.8 : 0) + (q.oppRanged && !q.ranged ? 1.0 : 0) + (!q.los ? 0.4 : 0) + (m.world.props[q.prop].explosive ? 0.4 : 0) + onTheWay(f, o, m.world.props[q.prop]) * 0.6) * pow(ENV_AI.grabDecay, f.ai.pickups)
        : 0,
    // bring the cover down: topple it onto them, or smash the cover a shooter hides behind
    smash: !AI_TUNING.arenaTactics ? 0 : (q.topple >= 0 ? 0.8 + q.doc.envCunning * 1.6 : 0) + (q.blocker >= 0 && q.oppRanged && !q.ranged && q.gap < 7 ? 0.3 + q.doc.envCunning * 0.6 : 0) + (q.blocker >= 0 && q.ranged ? 0.2 + q.doc.envCunning * 0.5 : 0),
  };
  // the observed failure: a ranged fighter walking up to finish a melee brute -> keep shooting
  if (q.ranged && !q.oppRanged) g.finish *= 0.3;
  // doctrine flavour
  if (role === 'rushdown' || role === 'bruiser') {
    g.pressure *= 1.3;
    g.close *= 1.2;
    g.footsies *= 0.6;
  }
  if (role === 'duelist') {
    g.footsies *= 1.3;
    g.guard *= 1.2;
  }
  if (role === 'tank') {
    g.close *= 1.1;
    g.regroup *= 0.6;
  }
  if (role === 'trickster') {
    g.bait *= 1.4;
    g.footsies *= 1.2;
  }
  // fear of the matchup (e.g. bruiser vs kiter: cut them off, don't dither)
  if (q.doc.fears.includes('ranged') && q.oppRanged) g.close *= 1.25;
  if (q.doc.fears.includes('pressure') && q.oppPressing) g.escape += 0.4;
  // commitment: stick with the current goal for a moment (no dithering)
  if (m.t < f.ai.goalUntil) g[f.ai.goal] += 0.45;
  for (const k of Object.keys(g) as Goal[]) g[k] = Math.max(0, g[k] + m.rng.next() * 0.25);
  return g;
}

function think(m: Match, f: FighterState, o: FighterState) {
  const ai = f.ai;
  const P = f.def.personality;
  const q = perceive(m, f, o);
  const g = scoreGoals(m, f, o, q);
  let best: Goal = 'pressure';
  for (const k of Object.keys(g) as Goal[]) if (g[k] > g[best]) best = k;
  if (best !== ai.goal) {
    ai.goal = best;
    ai.goalUntil = m.t + m.rng.range(0.5, 1.3) * (0.6 + P.patience * 0.8);
    if (m.rng.chance(0.3)) ai.circleDir *= -1;
  }
  // panic: low HP, low composure -> a wild roll now and then (a human mistake)
  if (q.my < 0.2 && q.caut < 0.5 && f.stamina > 20 && m.rng.chance(0.04) && q.gap < q.threat) {
    const ux = f.x - o.x,
      uz = f.z - o.z;
    m.startDodge(f, ux, uz);
    return;
  }
  // shoot the explosive barrel they're standing next to
  if (AI_TUNING.arenaTactics && q.barrel >= 0 && m.rng.chance(0.25 + q.doc.envCunning * 0.5)) {
    const b = m.world.props[q.barrel];
    const d = hypot(b.x - f.x, b.z - f.z) - b.r;
    const shot = f.def.moves.find((x) => x.ranged && !x.furyCost && x.range - 0.6 >= d && f.stamina >= x.stamina * 0.6 && (x.hits ?? 1) <= 2);
    if (shot && m.startAttack(f, shot, { x: b.x, z: b.z })) {
      tactic(f, 'shoot_barrel');
      remember(f, shot);
      return;
    }
  }
  // A2b: knock the brazier beside them over (burning oil under their feet): a melee swing or a shot at it
  if (q.ignite >= 0 && ai.goal !== 'punish' && m.rng.chance(ENV_AI.igniteChance * (0.4 + q.doc.envCunning))) {
    const b = m.world.props[q.ignite];
    if (smashAt(m, f, b.x, b.z, b.r, 'tip_brazier')) return;
  }
  // A2b: send the chain weight swinging through them
  if (q.chain >= 0 && ai.goal !== 'punish' && m.rng.chance(0.3 + q.doc.envCunning * 0.4)) {
    const h = m.arena.hazards[q.chain];
    if (smashAt(m, f, h.x, h.z, 0.4, 'swing_chain')) return;
  }
  // arena goals act directly
  if (ai.goal === 'grab' && q.prop >= 0) {
    ai.propTarget = q.prop;
    if (m.world.canLift(f, q.prop) && m.startLift(f, q.prop)) {
      tactic(f, 'pickup');
      return;
    }
  } else ai.propTarget = -1;
  if (ai.goal === 'smash') {
    const target = q.topple >= 0 ? q.topple : q.blocker;
    ai.obsTarget = target;
    if (target >= 0 && smashObstacle(m, f, target, q.topple >= 0)) return;
  } else ai.obsTarget = -1;
  // ultimate: when it will land / when desperate (pride saves it for a moment that matters)
  if (f.fury >= 100) {
    const ult = f.def.moves.find((x) => x.kind === 'ultimate');
    if (ult && moveUsable(m, f, o, ult, q.gap)) {
      let want = 0.2 + (q.my < 0.3 ? 0.5 : 0) + (q.open > ult.windup * 0.7 ? 0.6 : 0) + P.aggression * 0.15 + (ai.goal === 'finish' || ai.goal === 'gambit' ? 0.4 : 0);
      if (P.pride > 0.6 && q.their > 0.4 && q.my > 0.4) want *= 0.3;
      if ((o.state === 'knockdown' || o.state === 'launched') && o.stateDur - o.stateT > 0.5) want = 0;
      if (m.rng.chance(want) && m.startAttack(f, ult)) {
        remember(f, ult);
        return;
      }
    }
  }
  // taunt (pride) when safely ahead and out of reach
  if (P.pride > 0.35 && q.my - q.their > 0.12 && q.gap > q.threat + 1.2 && o.state !== 'attack' && m.rng.chance(P.pride * (q.my - q.their > 0.25 ? 0.07 : 0.03))) {
    m.startTaunt(f);
    return;
  }
  if (ai.goal === 'guard' && q.gap < q.threat + 0.4 && f.stamina > 20 && m.rng.chance(0.5)) {
    m.startBlock(f, m.t + m.rng.range(0.4, 0.9));
    return;
  }
  // attack decision
  const pAtk = attackChance(m, f, o, q);
  if (!ai.queued && m.rng.chance(pAtk)) {
    const mv = chooseMove(m, f, o, q);
    if (mv) {
      // timing mix-up: not always the instant we're ready (anti-pattern)
      const delay = ai.goal === 'punish' ? 0 : m.rng.next() < 0.35 ? m.rng.range(0.05, 0.3) * (1.2 - q.aggr * 0.5) : 0;
      if (delay <= 0.02) {
        if (m.startAttack(f, mv)) remember(f, mv);
      } else ai.queued = { move: mv, at: m.t + delay };
    }
  }
}

function attackChance(m: Match, f: FighterState, o: FighterState, q: Percept): number {
  const goal = f.ai.goal;
  let p = 0.1 + q.aggr * 0.35;
  switch (goal) {
    case 'punish':
      p = 0.95;
      break;
    case 'pressure':
    case 'finish':
    case 'gambit':
      p += 0.25;
      break;
    case 'close':
      p += 0.1;
      break;
    case 'kite':
      p = q.ranged ? 0.5 + q.aggr * 0.2 : p;
      break;
    case 'footsies':
      p = q.gap <= q.threat - 0.1 ? 0.55 : 0.12; // poke them as they step into OUR range
      break;
    case 'bait':
      p = 0.45;
      break;
    case 'guard':
    case 'regroup':
    case 'cover':
    case 'escape':
      p *= 0.35;
      break;
  }
  if (o.state === 'block') p *= 0.5 + f.def.personality.adaptability * 0.5;
  if ((o.state === 'knockdown' || o.state === 'launched') && q.open === 0) p = 0;
  if (f.stamina < 25) p -= 0.2;
  return clamp(p, 0, 1);
}

/** Utility over every usable move for the current goal and opponent model. */
function chooseMove(m: Match, f: FighterState, o: FighterState, q: Percept): MoveDef | null {
  const ai = f.ai;
  const P = f.def.personality;
  const S = f.def.stats;
  const om = ai.opp;
  // misjudged spacing: low-skill fighters occasionally think they reach further
  const misjudge = (1 - S.skill) * 0.5 * Math.max(0, m.rng.gauss());
  const gapSeen = Math.max(0, q.gap - misjudge);
  const cands: MoveDef[] = [];
  const w: number[] = [];
  for (const mv of f.def.moves) {
    if (mv.kind === 'ultimate' || mv.kind === 'combo') continue;
    if (!moveUsable(m, f, o, mv, gapSeen)) continue;
    if (mv.counter && q.open <= 0.1 && f.ai.goal !== 'punish') continue; // counters only into openings
    const t = (x: string) => hasTag(mv, x);
    let u = 1;
    const goal = ai.goal;
    if (goal === 'punish') {
      u = mv.windup < q.open ? 2 + (t('counter') ? 2 : 0) + (t('launcher') ? 1 : 0) + (mv.kind === 'heavy' && mv.windup < q.open * 0.8 ? 1.2 : 0) : 0.1;
    } else if (goal === 'pressure' || goal === 'finish' || goal === 'gambit') {
      u = (t('opener') ? 1.4 : 0.8) + (t('string') ? 0.4 : 0) + (mv.kind === 'heavy' ? 0.4 + P.pride * 0.4 : 0) + (goal !== 'pressure' && mv.kind === 'heavy' ? 1 : 0);
      if (t('feint')) u = 0.2 + q.doc.mindGames * 0.6;
    } else if (goal === 'close') {
      u = t('gapclose') ? 2.2 + (q.oppRanged && t('antizone') ? 1 : 0) : mv.ranged ? 0.6 : 0.3;
    } else if (goal === 'kite' || goal === 'cover' || goal === 'regroup') {
      u = mv.ranged ? 1.8 + (t('poke') ? 0.4 : 0) + (q.gap > 4 && mv.kind === 'heavy' ? 0.8 : 0) : t('escape') || t('antirush') ? (q.gap < 1.2 ? 2.2 : 0.3) : 0.15;
    } else if (goal === 'footsies') {
      u = t('poke') ? 2 : t('antirush') ? 1.2 : mv.kind === 'heavy' ? 0.3 : 0.6;
    } else if (goal === 'bait') {
      u = t('feint') ? 3 : t('poke') ? 0.6 : 0.2;
    } else if (goal === 'escape') {
      u = t('escape') ? 2.5 : t('antirush') ? 1.8 : 0.2;
    } else if (goal === 'guard') {
      u = t('counter') || t('antirush') ? 1.5 : 0.3;
    }
    // opponent model: they block -> guard-breakers / feints; they dodge -> multi-hit / sweeps
    u += om.blockRate * P.adaptability * (t('guardbreak') ? 2.5 : t('feint') ? 1.2 : 0);
    u += om.dodgeRate * P.adaptability * ((mv.hits ?? 1) > 1 || t('sweep') || mv.aoe ? 1.5 : 0);
    u += om.parryRate * P.adaptability * (t('feint') ? 2 : mv.unblockable ? 1 : 0);
    if (o.exhausted && t('guardbreak')) u += 1;
    if (q.open > 0 && mv.windup > q.open) u *= 0.3;
    // variety: penalise recently used moves (stubborn personalities care less)
    const rep = ai.recent.filter((x) => x === mv.id).length;
    u *= pow(0.42 + (1 - P.adaptability) * 0.2, rep);
    // risk: long recovery outside a punish window against a fast opponent
    if (goal !== 'punish' && mv.recovery > 0.6 && o.def.stats.speed > 4) u *= 0.75;
    // something nasty behind them (hazard / wall / cover): big knockback sends them into it
    if (AI_TUNING.arenaTactics && q.backHazard > 0 && (mv.knockback >= 4 || mv.knockdown)) u += q.backHazard * (0.6 + q.doc.envCunning * 1.2);
    // LAUNCH exploitation: a knockdown blow strong enough to send an off-balance opponent flying,
    // ideally into a hazard / wall / cover behind them
    if (AI_TUNING.arenaTactics && mv.knockdown && m.launches < LAUNCH.maxPerMatch && launchForce(f, o, mv, m.attackPhase(o)) >= LAUNCH.minForce)
      u += 0.25 + P.pride * 0.25 + (q.backHazard > 0 ? 0.5 + q.doc.envCunning : 0);
    if (f.stamina - mv.stamina < 12 && !mv.furyCost) u *= 0.6;
    cands.push(mv);
    w.push(Math.max(0.02, u * (0.85 + m.rng.next() * 0.3)));
  }
  if (!cands.length) return null;
  const i = m.rng.weighted(w);
  return i >= 0 ? cands[i] : null;
}

// ------------------------------------------------------------------ footwork
function steer(m: Match, f: FighterState, o: FighterState) {
  const S = f.def.stats;
  const ai = f.ai;
  const dx = o.x - f.x,
    dz = o.z - f.z;
  const d = hypot(dx, dz) || 1;
  const ux = dx / d,
    uz = dz / d;
  const px = -uz * ai.circleDir,
    pz = ux * ai.circleDir;
  const gap = d - S.radius - o.def.stats.radius;
  const doc = doctrineOf(f.def.id);
  const threat = threatRange(o);
  let vx = 0,
    vz = 0,
    sp = 1;
  let avoidPillars = true;
  const r = hypot(f.x, f.z) || 1;
  const eg = edgeAt(m, f.x, f.z);
  // retreat to good ground: away from them, never into the wall or a hazard;
  // shooters like open lanes, everyone hates corners
  const retreatDir = () => {
    let best = [-ux, -uz],
      bs = -1e9;
    for (let k = 0; k < 8; k++) {
      const a = atan2(-ux, -uz) + ((k - 3.5) / 3.5) * 1.6;
      const dx = sin(a),
        dz = cos(a);
      const x = f.x + dx * 2.2,
        z = f.z + dz * 2.2;
      let sc = (dx * -ux + dz * -uz) * 1.2 + Math.min(3, edgeAt(m, x, z)) * 0.6 - m.world.danger(m, x, z) * 1.5;
      if (edgeAt(m, x, z) < 1) sc -= 2;
      if (isRangedFighter(f) && m.world.blocked(x, z, o.x, o.z)) sc -= 0.4;
      if (sc > bs) {
        bs = sc;
        best = [dx, dz];
      }
    }
    return best;
  };
  const rangedHold = isRangedFighter(f) && gap < doc.band[1] + 0.5 && (ai.goal === 'bait' || ai.goal === 'guard' || ai.goal === 'punish' || ai.goal === 'footsies');
  if (rangedHold) {
    // ranged roles never walk into melee to bait/guard/punish: hold the band and keep shooting
    const want = (doc.band[0] + doc.band[1]) / 2;
    const k = (gap - want) * 0.8;
    vx = ux * k + px * 0.7;
    vz = uz * k + pz * 0.7;
    sp = 0.85;
  } else if (m.t < ai.backstepUntil) {
    const [rx, rz] = retreatDir();
    vx = rx;
    vz = rz;
    sp = 1;
  } else
    switch (ai.goal) {
      case 'close':
      case 'finish':
      case 'gambit': {
        if (isRangedFighter(f) && gap < doc.band[1]) {
          // ranged fighters finish from range: hold the band instead of walking in
          const want = (doc.band[0] + doc.band[1]) / 2;
          const k = (gap - want) * 0.8;
          vx = ux * k + px * 0.6;
          vz = uz * k + pz * 0.6;
          sp = 0.8;
          break;
        }
        if (isRangedFighter(o) && !isRangedFighter(f)) {
          // approach in a zig-zag so shots are harder to land
          ai.zig += 0.05;
          const s = sin(ai.zig * 3);
          vx = ux + px * 0.9 * s;
          vz = uz + pz * 0.9 * s;
        } else {
          vx = ux + px * 0.2;
          vz = uz + pz * 0.2;
        }
        sp = 1;
        break;
      }
      case 'pressure': {
        if (isRangedFighter(f)) {
          // a zoner "pressures" from its band: hold distance, strafe, keep firing lanes open
          const want = (doc.band[0] + doc.band[1]) / 2;
          const k = (gap - want) * 0.6;
          vx = ux * k + px * 0.8;
          vz = uz * k + pz * 0.8;
          sp = 0.7;
          break;
        }
        // cut off the ring: approach on the line between them and the centre
        const ro = hypot(o.x, o.z) || 1;
        const cx = o.x - (o.x / ro) * 1.5 - f.x,
          cz = o.z - (o.z / ro) * 1.5 - f.z;
        const cl = hypot(cx, cz) || 1;
        const k = gap > doc.band[0] ? 1 : 0.15;
        vx = ux * k + (cx / cl) * 0.35 + px * 0.25;
        vz = uz * k + (cz / cl) * 0.35 + pz * 0.25;
        sp = 0.8;
        break;
      }
      case 'kite':
      case 'regroup': {
        const want = (doc.band[0] + doc.band[1]) / 2;
        if (gap < want) {
          const [rx, rz] = retreatDir();
          vx = rx + px * 0.6;
          vz = rz + pz * 0.6;
          sp = 1;
        } else {
          vx = px;
          vz = pz;
          sp = 0.6;
        }
        break;
      }
      case 'footsies': {
        // dance on the edge of their measure: step in and out
        ai.zig += 0.04;
        const target = threat + 0.25 + sin(ai.zig * 2.2) * 0.45;
        const k = (gap - target) * 1.2;
        vx = ux * k + px * 0.5;
        vz = uz * k + pz * 0.5;
        sp = 0.7;
        break;
      }
      case 'bait': {
        ai.zig += 0.05;
        const target = threat - 0.2 + sin(ai.zig * 3) * 0.6;
        const k = (gap - target) * 1.5;
        vx = ux * k + px * 0.3;
        vz = uz * k + pz * 0.3;
        sp = 0.85;
        break;
      }
      case 'guard': {
        const k = (gap - threat - 0.2) * 0.6;
        vx = ux * k + px * 0.3;
        vz = uz * k + pz * 0.3;
        sp = 0.4;
        break;
      }
      case 'cover': {
        // put the nearest standing cover between us and them
        let best = null as null | { x: number; z: number; d: number };
        for (let i = 0; i < m.arena.obstacles.length; i++) {
          if (!m.world.standing(i)) continue;
          const p = m.arena.obstacles[i];
          const ox = p.x - o.x,
            oz = p.z - o.z;
          const ol = hypot(ox, oz) || 1;
          const tx = p.x + (ox / ol) * (p.r + S.radius + 0.35),
            tz = p.z + (oz / ol) * (p.r + S.radius + 0.35);
          const dd = hypot(tx - f.x, tz - f.z);
          if (!best || dd < best.d) best = { x: tx, z: tz, d: dd };
        }
        if (best && best.d > 0.3) {
          vx = (best.x - f.x) / best.d;
          vz = (best.z - f.z) / best.d;
          sp = 1;
          avoidPillars = false;
        } else {
          vx = 0;
          vz = 0;
          sp = 0;
        }
        break;
      }
      case 'escape': {
        // slide along the wall away from them, then turn inward
        const tx = -f.z / r,
          tz = f.x / r;
        const side = tx * ux + tz * uz > 0 ? -1 : 1;
        vx = tx * side - (f.x / r) * 0.8 - ux * 0.3;
        vz = tz * side - (f.z / r) * 0.8 - uz * 0.3;
        sp = 1;
        break;
      }
      case 'punish':
        vx = ux;
        vz = uz;
        sp = 1;
        break;
      case 'grab': {
        const p = ai.propTarget >= 0 ? m.world.props[ai.propTarget] : null;
        if (p && p.state === PS_REST) {
          const dd = hypot(p.x - f.x, p.z - f.z) || 1;
          const stop = S.radius + p.r + 0.4;
          const k = dd > stop ? 1 : 0;
          vx = ((p.x - f.x) / dd) * k;
          vz = ((p.z - f.z) / dd) * k;
          sp = 1;
        } else {
          vx = px;
          vz = pz;
          sp = 0.5;
        }
        break;
      }
      case 'smash': {
        const ob = ai.obsTarget >= 0 && m.world.standing(ai.obsTarget) ? m.arena.obstacles[ai.obsTarget] : null;
        if (ob && !isRangedFighter(f)) {
          // stand on the far side of the column from them, at striking distance
          const ox = ob.x - o.x,
            oz = ob.z - o.z;
          const ol = hypot(ox, oz) || 1;
          const tx = ob.x + (ox / ol) * (ob.r + S.radius + 0.5),
            tz = ob.z + (oz / ol) * (ob.r + S.radius + 0.5);
          const dd = hypot(tx - f.x, tz - f.z) || 1;
          vx = dd > 0.25 ? (tx - f.x) / dd : 0;
          vz = dd > 0.25 ? (tz - f.z) / dd : 0;
          sp = dd > 0.25 ? 1 : 0;
          avoidPillars = false;
        } else {
          vx = px * 0.6;
          vz = pz * 0.6;
          sp = 0.6;
        }
        break;
      }
    }
    // pressure / punish into hazards: approach from the side opposite the danger behind them
    if (AI_TUNING.arenaTactics && (ai.goal === 'pressure' || ai.goal === 'close') && !isRangedFighter(f)) {
      for (let hi = 0; hi < m.arena.hazards.length; hi++) {
        const h = m.arena.hazards[hi];
        if (h.kind === 'water' || h.kind === 'chains' || (h.kind === 'flamejet' && m.world.haz[hi].state === 0)) continue;
        const hx = o.x - h.x,
          hz = o.z - h.z;
        const hl = hypot(hx, hz);
        if (hl > h.r + 3 || hl < 1e-3) continue;
        // ideal spot: on the line hazard -> opponent, beyond the opponent
        const tx = o.x + (hx / hl) * (S.radius + o.def.stats.radius + 0.8),
          tz = o.z + (hz / hl) * (S.radius + o.def.stats.radius + 0.8);
        const dd = hypot(tx - f.x, tz - f.z) || 1;
        const w = 0.5 * doctrineOf(f.def.id).envCunning;
        vx += ((tx - f.x) / dd) * w;
        vz += ((tz - f.z) / dd) * w;
      }
    }
  // stay inside the (possibly shrinking) ring
  if (eg < 2.0) {
    const k = Math.min(2.5, (2.0 - eg) * 1.2);
    vx -= (f.x / r) * k;
    vz -= (f.z / r) * k;
  }
  // route around impassable hazards (lava rivers): head for a bridge first
  if (m.arena.waypoints.length && (ai.goal === 'close' || ai.goal === 'pressure' || ai.goal === 'punish' || ai.goal === 'finish' || ai.goal === 'gambit')) {
    const hard = (h: { kind: string }) => h.kind === 'lava' || h.kind === 'spikes' || h.kind === 'firepit';
    const crosses = m.arena.hazards.some((h) => hard(h) && segPointDist(f.x, f.z, o.x, o.z, h.x, h.z) < h.r + 0.2);
    if (crosses) {
      let bw = m.arena.waypoints[0],
        bd = 1e9;
      for (const w of m.arena.waypoints) {
        const d = hypot(w.x - f.x, w.z - f.z) + hypot(o.x - w.x, o.z - w.z);
        if (d < bd) {
          bd = d;
          bw = w;
        }
      }
      // aim a bit past the bridge centre on the far side
      const side = Math.sign(o.x - bw.x) || 1;
      const tx = bw.x + side * 1.5 * (Math.abs(f.x - bw.x) < 1.2 ? 1 : 0),
        tz = bw.z;
      const dd = hypot(tx - f.x, tz - f.z) || 1;
      vx = (tx - f.x) / dd;
      vz = (tz - f.z) / dd;
      sp = Math.max(sp, 0.9);
    }
  }
  // hazards: keep clear of fire, armed traps, lit barrels, creaking chandeliers
  for (let i = 0; i < m.arena.hazards.length; i++) {
    const h = m.arena.hazards[i];
    const st = m.world.haz[i].state;
    let w = 0;
    if (h.kind === 'lava') w = 2.2;
    else if (h.kind === 'firepit') w = 1.6;
    else if (h.kind === 'spikes') w = st === 1 || st === 2 ? 2 : 0.5;
    else if (h.kind === 'geyser') w = st >= 1 ? 2 : 0.4;
    else if (h.kind === 'chandelier') w = st === 1 || st === 2 ? 2.5 : 0;
    else if (h.kind === 'water') w = 0.15;
    else if (h.kind === 'flamejet') w = st >= 1 ? 2.2 : 0.35;
    else if (h.kind === 'crumble') w = st === 1 || st === 2 ? 2.6 : st === 3 ? 2.2 : 0;
    if (w <= 0) continue;
    const qx = f.x - h.x,
      qz = f.z - h.z;
    const d = hypot(qx, qz) || 1e-3;
    const reach = h.r + S.radius + 0.9;
    if (d < reach) {
      const push = ((reach - d) / reach) * w * 2;
      vx += (qx / d) * push;
      vz += (qz / d) * push;
    }
  }
  // A2b: burning oil, and the sweep of a swinging chain weight
  for (const fr of m.world.fires) {
    const qx = f.x - fr.x,
      qz = f.z - fr.z;
    const d = hypot(qx, qz) || 1e-3;
    const reach = fr.r + S.radius + 0.7;
    if (d < reach) {
      const push = ((reach - d) / reach) * 3.5;
      vx += (qx / d) * push;
      vz += (qz / d) * push;
    }
  }
  for (let i = 0; i < m.arena.hazards.length; i++) {
    const h = m.arena.hazards[i];
    if (h.kind !== 'chains' || m.world.haz[i].state !== 1) continue;
    const ax = sin(h.phase),
      az = cos(h.phase);
    // distance to the sweep line, pushed out sideways
    const qx = f.x - h.x,
      qz = f.z - h.z;
    const along = qx * ax + qz * az;
    if (Math.abs(along) > 3.3) continue;
    const px = qx - ax * along,
      pz = qz - az * along;
    const d = hypot(px, pz) || 1e-3;
    const reach = S.radius + 1.0;
    if (d < reach) {
      vx += (px / d) * (reach - d) * 3;
      vz += (pz / d) * (reach - d) * 3;
    }
  }
  for (const p of m.world.props) {
    if (p.fuseAt < 0 || p.state === 3) continue;
    const qx = f.x - p.x,
      qz = f.z - p.z;
    const d = hypot(qx, qz) || 1e-3;
    if (d < 4) {
      vx += (qx / d) * (4 - d);
      vz += (qz / d) * (4 - d);
      sp = Math.max(sp, 1);
    }
  }
  if (avoidPillars)
    for (let i = 0; i < m.arena.obstacles.length; i++) {
      if (!m.world.standing(i)) continue;
      const p = m.arena.obstacles[i];
      const qx = p.x - f.x,
        qz = p.z - f.z;
      const pd = hypot(qx, qz);
      if (pd < p.r + S.radius + 1.0) {
        const push = (p.r + S.radius + 1.0 - pd) * 1.5;
        vx -= (qx / pd) * push;
        vz -= (qz / pd) * push;
      }
    }
  const l = hypot(vx, vz);
  if (l > 1e-4 && sp > 0) {
    const s = (S.speed * sp * (f.exhausted ? 0.65 : 1) * Math.min(1, l)) / l;
    f.wantX = vx * s;
    f.wantZ = vz * s;
  } else {
    f.wantX = f.wantZ = 0;
  }
}

// ------------------------------------------------------------------ arena play
/** Attack a column / cover: topple it onto them, or break the shooter's shield. */
function smashObstacle(m: Match, f: FighterState, i: number, topple: boolean): boolean {
  const ob = m.arena.obstacles[i];
  const d = hypot(ob.x - f.x, ob.z - f.z) - ob.r - f.def.stats.radius;
  let best: MoveDef | null = null;
  let bu = -1;
  for (const mv of f.def.moves) {
    if (mv.kind === 'ultimate' || mv.kind === 'combo' || mv.feint || mv.furyCost) continue;
    if (f.stamina < mv.stamina * 0.6) continue;
    if (mv.ranged) {
      if (d > mv.range - 0.6 || m.world.blocked(f.x, f.z, ob.x, ob.z, -0.3)) continue;
    } else if (d > edgeReach(f.def.id, mv, f.def.stats.radius) - 0.15) continue;
    const u = mv.damage * (mv.kind === 'heavy' ? 1.5 : 1) * (mv.ranged ? 0.8 : 1) - mv.windup * 20;
    if (u > bu) {
      bu = u;
      best = mv;
    }
  }
  if (!best) return false;
  if (!m.startAttack(f, best, { x: ob.x, z: ob.z })) return false;
  tactic(f, topple ? 'topple_attempt' : 'smash_cover');
  remember(f, best);
  return true;
}

/** A2b: strike a point target (a brazier) with the best move that reaches it; false when nothing reaches. */
function smashAt(m: Match, f: FighterState, x: number, z: number, r: number, tag: string): boolean {
  const d = hypot(x - f.x, z - f.z) - r - f.def.stats.radius;
  let best: MoveDef | null = null;
  let bu = -1;
  for (const mv of f.def.moves) {
    if (mv.kind === 'ultimate' || mv.kind === 'combo' || mv.feint || mv.furyCost) continue;
    if (f.stamina < mv.stamina * 0.6) continue;
    if (mv.ranged) {
      if (d > mv.range - 0.6 || m.world.blocked(f.x, f.z, x, z, -0.3)) continue;
    } else if (d > edgeReach(f.def.id, mv, f.def.stats.radius) - 0.1) continue;
    const u = mv.damage - mv.windup * 30;
    if (u > bu) {
      bu = u;
      best = mv;
    }
  }
  if (!best || !m.startAttack(f, best, { x, z })) return false;
  tactic(f, tag);
  remember(f, best);
  return true;
}

/** Carrying a prop: walk it into throwing range and let fly at a good moment. */
function carryTick(m: Match, f: FighterState, o: FighterState) {
  const ai = f.ai;
  if (ai.carryT <= 0) {
    ai.carryT = m.t;
    ai.pickups++;
  }
  const gap = gapOf(f, o);
  const held = m.t - ai.carryT;
  const los = !lineBlocked(m, f, o);
  const good = los && gap > 1.2 && gap < 11 && o.state !== 'dodge' && o.state !== 'knockdown';
  const urgent = gap < 2.2 || held > 3.2 || (o.state === 'attack' && m.attackPhase(o) === 2);
  if (m.canAct(f) && f.state === 'idle' && ((good && (m.rng.chance(0.08 + held * 0.05) || o.state === 'stagger' || o.state === 'lift' || o.state === 'winded')) || urgent)) {
    if (m.startThrow(f)) {
      tactic(f, 'throw');
      ai.carryT = 0;
      return;
    }
  }
  // walk to ~5 m and keep a clear line
  const dx = o.x - f.x,
    dz = o.z - f.z;
  const d = hypot(dx, dz) || 1;
  const k = clamp((gap - 5) * 0.6, -1, 1);
  let vx = (dx / d) * k + (-dz / d) * ai.circleDir * (los ? 0.3 : 0.9),
    vz = (dz / d) * k + (dx / d) * ai.circleDir * (los ? 0.3 : 0.9);
  const eg = edgeAt(m, f.x, f.z);
  if (eg < 2) {
    const r = hypot(f.x, f.z) || 1;
    vx -= (f.x / r) * (2 - eg);
    vz -= (f.z / r) * (2 - eg);
  }
  const l = hypot(vx, vz);
  const S = f.def.stats;
  if (l > 1e-3) {
    f.wantX = (vx / l) * S.speed * 0.85 * Math.min(1, l);
    f.wantZ = (vz / l) * S.speed * 0.85 * Math.min(1, l);
  } else f.wantX = f.wantZ = 0;
}
