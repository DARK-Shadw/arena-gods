/**
 * Deterministic fight simulation. Fixed 60 Hz tick, seeded RNG, no three.js.
 *
 *   const rec = new Match('gorak', 'vex', 1234).run();
 *
 * produces a MatchRecord: per-tick frames (positions, states, meters) and a
 * timestamped event stream. Renderer, camera director and audio only ever read
 * the record, so the same seed always shows the same fight.
 */
import { atan2, cos, exp, hypot, sin } from './dmath';
import { Rng } from './rng';
import { ARENA, ringRadiusAt } from './arena';
import { arenaForSeed, generateArena, type ArenaLayout, type ArenaSpec } from './arenaGen';
import { LIFT_DUR, LIFT_GRAB, PS_REST, THROW_DUR, THROW_RELEASE, World } from './world';
import { getFighter } from './fighters';
import type {
  EventType,
  FighterDef,
  FighterFrame,
  FState,
  Frame,
  MatchRecord,
  MoveDef,
  SimEvent,
} from './types';
import { AIState, aiTick, createAIState, wantsCombo } from './ai';
import { Drama } from './drama';
import { clipTime, moveReach, segSegDist, strikePoints, toWorld, type MoveReach } from './reach';
import { AnimSelector, clipData, styleOf, type Dir } from './animSelect';
import { LAUNCH, launchForce } from './launch';
import { FINISHERS, HIPS_M, execInfo, fxOf, sceneOf, sceneRoot, sceneToWorld, type FinisherDef } from './finishers';

/** a running finisher (see finishers.ts) */
interface FinRun {
  def: FinisherDef;
  att: number;
  vic: number;
  t: number;
  ox: number;
  oz: number;
  yaw: number;
  hA: number;
  from: number;
  to: number;
  alignT: number;
  a0: [number, number];
  v0: [number, number];
  hitsLeft: number[];
  killAt: number;
  killed: boolean;
  // downed
  fallDur?: number;
  walk?: { from: [number, number]; to: [number, number]; t0: number; t1: number; face: number };
  exec?: { clip: string; t: number; off: [number, number]; dur: number; start: number; from: number };
  end: number;
}
export { LAUNCH, launchForce } from './launch';

const MAGNET = 0.6; // max extra step-in during windup so attacks reach when they should
const CONTACT_TOL = 0.22; // strike point to body-capsule tolerance (m)

interface Projectile {
  id: number;
  owner: number;
  move: MoveDef;
  hit: number;
  hits: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  travelled: number;
  radius: number;
}

export const DT = 1 / 60;
const POST_KILL = 5.0; // seconds recorded after the kill (victory beat)

export interface FighterState {
  idx: number;
  def: FighterDef;
  maxHp: number;
  x: number;
  z: number;
  /** Locomotion velocity. */
  mx: number;
  mz: number;
  /** Desired locomotion velocity written by AI. */
  wantX: number;
  wantZ: number;
  /** Knockback velocity. */
  kx: number;
  kz: number;
  facing: number;
  y: number;
  hp: number;
  stamina: number;
  fury: number;
  state: FState;
  stateT: number;
  stateDur: number;
  move: MoveDef | null;
  attackId: number;
  hitsDone: number;
  hitResolved: boolean;
  hitLanded: boolean;
  comboChecked: boolean;
  lungeDist: number;
  blockStartT: number;
  blockUntil: number;
  dodgeX: number;
  dodgeZ: number;
  buffT: number;
  buffMul: number;
  lastStand: boolean;
  exhausted: boolean;
  windedPending: boolean;
  rageMeter: number;
  strafe: number;
  lastBurnEvt: number;
  /** Deferred dramatic beat (roar) waiting for the fighter to be actionable. */
  pendingBeat: 'second_wind' | 'cornered' | 'last_stand' | null;
  /** Block was deliberately timed as a parry attempt. */
  parryIntent: boolean;
  /** active-window progress at the previous tick (for swept contact tests) */
  prevK: number;
  /** analytics: closest strike-point gap this attack, gap at attack start */
  minGap: number;
  startGap: number;
  ai: AIState;
  /** prop index being carried / being lifted (-1 = none) */
  carry: number;
  liftProp: number;
  /** facing override (attacking cover, lifting a prop, shooting a barrel) */
  aimOn: boolean;
  aimX: number;
  aimZ: number;
  /** world targets already struck by the current attack */
  worldHits: number[];
  // analytics
  dmgDealt: number;
  hitsLanded: number;
  // ---- animation variants (sim-chosen, timing-relevant; recorded in frames)
  /** library clip for the current state ('' = the fighter's own clip set) */
  clip: string;
  clipT0: number;
  clipRate: number;
  /** how the body lies after the fall (prone / supine / side): selects the get-up */
  getupFace: string;
  /** context of the blow that caused the current reaction */
  react: { x: number; z: number; sev: number; height: 'head' | 'body' } | null;
  /** ballistic launch (sim-owned arc) */
  launch: Launch | null;
}

export interface Launch {
  x0: number;
  z0: number;
  dx: number;
  dz: number;
  D: number;
  H: number;
  T: number;
  /** horizontal travel progress (stops at walls / cover) */
  k: number;
  stopped: boolean;
  lethal: boolean;
}



export function forwardOf(facing: number): [number, number] {
  return [sin(facing), cos(facing)];
}
export function angleTo(fx: number, fz: number, tx: number, tz: number): number {
  return atan2(tx - fx, tz - fz);
}
export function angDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export class Match {
  t = 0;
  rng: Rng;
  seed: number;
  f: [FighterState, FighterState];
  events: SimEvent[] = [];
  frames: Frame[] = [];
  /** ring-of-fire shrink scale (1 -> ARENA.minR/ARENA.fightR) */
  ringS = 1;
  arena: ArenaLayout;
  world: World;
  drama: Drama;
  over = false;
  endT = -1;
  winner = -1;
  timeout = false;
  killMove = '';
  private attackCounter = 0;
  /** deterministic animation-variant selector (own RNG stream) */
  anim: AnimSelector;
  launches = 0;
  private lastLaunchT = -99;
  /** running finisher scene (at most one, it ends the match) */
  fin: FinRun | null = null;
  finishers = 0;
  projectiles: Projectile[] = [];
  private projCounter = 0;
  /** analytics for tools/simtest: contact distance at every melee hit */
  contactLog: number[] = [];
  /** analytics: closest approach (m) of whiffed melee attacks, and gap at attack start */
  whiffLog: { move: string; fid: string; closest: number; startGap: number }[] = [];
  private record: boolean;

  constructor(idA: string, idB: string, seed: number, opts: { record?: boolean; arena?: ArenaSpec } = {}) {
    this.seed = seed;
    this.rng = new Rng(seed);
    this.anim = new AnimSelector(seed);
    this.record = opts.record ?? true;
    this.arena = generateArena(opts.arena ?? arenaForSeed(seed));
    this.world = new World(this.arena);
    this.f = [this.makeFighter(0, getFighter(idA)), this.makeFighter(1, getFighter(idB))];
    this.drama = new Drama(this);
    this.emit('match_start', -1);
  }

  private makeFighter(idx: number, def: FighterDef): FighterState {
    const a = ARENA.gateAngle[idx];
    const x = cos(a) * ARENA.startR;
    const z = sin(a) * ARENA.startR;
    return {
      idx, def, maxHp: def.stats.hp, x, z, mx: 0, mz: 0, wantX: 0, wantZ: 0, kx: 0, kz: 0,
      facing: angleTo(x, z, 0, 0), y: 0,
      hp: def.stats.hp, stamina: def.stats.stamina, fury: 0,
      state: 'idle', stateT: 0, stateDur: 0, move: null, attackId: 0, hitsDone: 0,
      hitResolved: false, hitLanded: false, comboChecked: false, lungeDist: 0,
      blockStartT: -10, blockUntil: 0, dodgeX: 0, dodgeZ: 0,
      buffT: 0, buffMul: 1, lastStand: false, exhausted: false, windedPending: false, rageMeter: 0, strafe: 0, lastBurnEvt: -10,
      pendingBeat: null,
      parryIntent: false,
      prevK: -1,
      minGap: 99,
      startGap: 0,
      ai: createAIState(this.rng),
      carry: -1, liftProp: -1, aimOn: false, aimX: 0, aimZ: 0, worldHits: [],
      dmgDealt: 0, hitsLanded: 0,
      clip: '', clipT0: 0, clipRate: 1, getupFace: 'side', react: null, launch: null,
    };
  }

  emit(type: EventType, a: number, b?: number, data?: SimEvent['data']) {
    this.events.push({ t: +this.t.toFixed(4), type, a, b, data });
  }

  // ---------------------------------------------------------------- actions
  // Called by AI. Each validates state so AI can't cheat.

  canAct(f: FighterState): boolean {
    return f.state === 'idle' || f.state === 'block';
  }

  setState(f: FighterState, s: FState, dur = 0) {
    // anything but walking / lifting / throwing makes you let go of what you carry
    if ((f.carry >= 0 || f.liftProp >= 0) && s !== 'idle' && s !== 'throw' && s !== 'lift' && s !== 'roar') this.world.drop(this, f);
    // a lift interrupted before the grab frees the prop
    if (f.liftProp >= 0 && f.state === 'lift' && s === 'idle') this.world.drop(this, f);
    if (s === 'idle' || s === 'stagger' || s === 'knockdown' || s === 'dead') f.aimOn = false;
    const prev = f.state;
    f.state = s;
    f.stateT = 0;
    f.stateDur = dur;
    if (s !== 'attack') f.move = null;
    this.chooseClip(f, s, prev);
  }

  /** where a blow came from, relative to the victim's facing */
  dirFrom(f: FighterState, x: number, z: number): Dir {
    const d = angDiff(f.facing, atan2(x - f.x, z - f.z));
    const a = Math.abs(d);
    return a < Math.PI / 4 ? 'F' : a > (Math.PI * 3) / 4 ? 'B' : d > 0 ? 'L' : 'R';
  }
  /** free distance (m) behind the fighter along (nx, nz), capped at 4 m */
  spaceAlong(f: FighterState, nx: number, nz: number): number {
    for (let d = 0.25; d <= 4; d += 0.25) {
      const x = f.x + nx * d,
        z = f.z + nz * d;
      if (this.world.edgeGap(x, z) < 0) return d - 0.25;
      for (let i = 0; i < this.arena.obstacles.length; i++) {
        if (!this.world.standing(i)) continue;
        const o = this.arena.obstacles[i];
        if (hypot(x - o.x, z - o.z) < o.r + 0.3) return d - 0.25;
      }
    }
    return 4;
  }

  /**
   * Pick the timing-relevant animation variant for a new state (deterministic,
   * own RNG + memory) and the matching state duration / clip-time mapping.
   */
  private chooseClip(f: FighterState, s: FState, prev: FState) {
    const style = styleOf(f.def.id);
    const r = f.react;
    const from: Dir = r ? this.dirFrom(f, r.x, r.z) : 'F';
    if (s === 'stagger') {
      const sev = r?.sev ?? (f.stateDur >= 0.6 ? 3 : f.stateDur >= 0.4 ? 2 : 1);
      f.clip = this.anim.hit(f.idx, this.t, { from, height: r?.height ?? 'body', sev, style });
      const d = clipData(f.clip);
      f.clipT0 = Math.max(0, (d?.impactT ?? 0.1) - 0.04);
      f.clipRate = sev >= 3 ? 1.0 : 1.12;
    } else if (s === 'knockdown') {
      if (prev === 'launched' && f.clip) {
        // continue the launch clip on the ground, then get up the way the body landed
        const d = clipData(f.clip);
        f.clipT0 = d ? Math.max(0, d.groundT) : 0;
        f.clipRate = 1;
        f.stateDur = 0.6;
        f.getupFace = d?.endFace ?? 'side';
        return;
      }
      const nx = r ? f.x - r.x : -Math.sin(f.facing),
        nz = r ? f.z - r.z : -Math.cos(f.facing);
      const l = hypot(nx, nz) || 1;
      f.clip = this.anim.knockdown(f.idx, this.t, { from, style, spaceBehind: this.spaceAlong(f, nx / l, nz / l) / 1.0 });
      const d = clipData(f.clip)!;
      f.clipT0 = 0;
      f.clipRate = 1.25;
      // fall until the body is on the ground, then a short settle
      f.stateDur = Math.max(0.7, d.groundT / f.clipRate + 0.32);
      f.getupFace = d.endFace;
    } else if (s === 'getup') {
      // chosen when actually getting up (memory sees only used clips), matching how the body lies
      f.clip = this.anim.getup(f.idx, this.t, { face: f.getupFace, style });
      const d = clipData(f.clip)!;
      f.clipT0 = 0;
      f.clipRate = Math.max(1.5, d.dur / 1.25);
      f.stateDur = d.dur / f.clipRate;
    } else if (s === 'dead') {
      if (f.launch) return; // the launch clip carries the death flight
      if (this.fin && this.fin.vic === f.idx) return; // the finisher scene carries the death
      const nx = r ? f.x - r.x : -Math.sin(f.facing),
        nz = r ? f.z - r.z : -Math.cos(f.facing);
      const l = hypot(nx, nz) || 1;
      f.clip = this.anim.death(f.idx, this.t, { from, sev: r?.sev ?? 3, style, spaceBehind: this.spaceAlong(f, nx / l, nz / l) });
      f.clipT0 = 0;
      f.clipRate = 1.05;
    } else if (s !== 'launched' && s !== 'dodge' && s !== 'scene') {
      f.clip = '';
    }
    if (s !== 'stagger' && s !== 'knockdown' && s !== 'dead' && s !== 'launched') f.react = null;
  }

  /**
   * LAUNCH: a big enough blow on an off-balance victim throws them through the
   * air on a sim-owned ballistic arc (deterministic); the render warps an
   * authored launch clip onto it. Returns true when launched.
   */
  tryLaunch(def: FighterState, att: FighterState, m: MoveDef | null, nx: number, nz: number, force: number, lethal: boolean, forced = false): boolean {
    if (!forced) {
      if (this.launches >= LAUNCH.maxPerMatch || this.t - this.lastLaunchT < LAUNCH.cooldown) return false;
      if (force < LAUNCH.minForce) return false;
      // rarer than knockdowns: chance grows with force; proud / showy attackers go for it
      const p = Math.min(0.5, 0.07 + (force - LAUNCH.minForce) * 0.12 + att.def.personality.pride * 0.08);
      if (this.anim.roll() > p) return false;
    }
    const l = hypot(nx, nz) || 1;
    const D = Math.min(6.2, Math.max(2.4, force * 0.62));
    const H = Math.min(1.9, Math.max(0.8, 0.22 * D + 0.35));
    const T = Math.min(1.05, Math.max(0.7, 0.4 + 0.1 * D));
    def.launch = { x0: def.x, z0: def.z, dx: nx / l, dz: nz / l, D, H, T, k: 0, stopped: false, lethal };
    def.kx = def.kz = 0;
    def.react = { x: att.x, z: att.z, sev: 3, height: 'body' };
    def.clip = this.anim.launch(def.idx, this.t, lethal, { from: this.dirFrom(def, def.x - nx, def.z - nz) });
    const d = clipData(def.clip)!;
    def.clipT0 = 0;
    def.clipRate = Math.min(2.6, Math.max(0.7, d.groundT / T));
    this.launches++;
    this.lastLaunchT = this.t;
    if (!lethal) this.setState(def, 'launched', T);
    this.emit('launch', def.idx, att.idx, { move: m?.id ?? 'env', clip: def.clip, D: +D.toFixed(2), H: +H.toFixed(2), T: +T.toFixed(2), force: +force.toFixed(2), x: +def.x.toFixed(2), z: +def.z.toFixed(2), dx: +(nx / l).toFixed(3), dz: +(nz / l).toFixed(3) });
    return true;
  }

  /** ballistic flight; props on the path break, walls / cover stop it (slam) */
  private flyLaunch(f: FighterState, o: FighterState, dt: number) {
    const L = f.launch!;
    const tt = Math.min(L.T, f.state === 'dead' ? f.stateT : f.stateT);
    const kNow = tt / L.T;
    f.y = 4 * L.H * kNow * (1 - kNow);
    if (!L.stopped) {
      const step = (L.D / L.T) * dt;
      const nx = f.x + L.dx * step,
        nz = f.z + L.dz * step;
      // wall / standing cover: slam and drop
      let hitWall = this.world.edgeGap(nx, nz) < 0;
      let hitObs = -1;
      for (let i = 0; i < this.arena.obstacles.length; i++) {
        if (!this.world.standing(i)) continue;
        const ob = this.arena.obstacles[i];
        if (f.y < ob.h && hypot(nx - ob.x, nz - ob.z) < ob.r + f.def.stats.radius) hitObs = i;
      }
      if (hitWall || hitObs >= 0) {
        L.stopped = true;
        const speed = L.D / L.T;
        if (hitObs >= 0) this.world.damageObstacle(this, hitObs, 18 + speed * 7, f.x, f.z, o.idx);
        else this.world.shake(this, f.x, f.z, 6);
        this.world.shake(this, f.x, f.z, 5);
        // the launch already paid for the blow: the slam is mostly spectacle
        const dmg = (14 + speed * 3.5) * 0.4;
        this.emit(hitObs >= 0 ? 'pillar_slam' : 'wall_slam', f.idx, o.idx, { dmg: Math.round(dmg), speed: +speed.toFixed(2), launched: true });
        if (f.state !== 'dead') this.applyDamage(f, dmg, o, hitObs >= 0 ? 'pillar_slam' : 'wall_slam', false);
        hitWall = false;
      } else {
        f.x = nx;
        f.z = nz;
        L.k += step / L.D;
      }
      // props in the flight path burst
      for (let i = 0; i < this.world.props.length; i++) {
        const p = this.world.props[i];
        if (p.state !== PS_REST || p.kind === 'rock' || p.kind === 'chunk') continue;
        if (f.y < (p.top ?? 1) + 0.3 && hypot(f.x - p.x, f.z - p.z) < p.r + f.def.stats.radius) {
          this.world.breakProp(this, i, o.idx);
          L.D *= 0.85;
        }
      }
    }
  }

  startAttack(f: FighterState, mv: MoveDef, aim?: { x: number; z: number }): boolean {
    if (!this.canAct(f) && !(f.state === 'attack' && mv.kind === 'combo')) return false;
    if (f.carry >= 0) return false;
    if (mv.furyCost) {
      if (f.fury < mv.furyCost) return false;
      f.fury -= mv.furyCost;
    } else {
      if (f.stamina < mv.stamina * 0.6) return false;
      f.stamina = Math.max(0, f.stamina - mv.stamina);
    }
    const o = this.f[1 - f.idx];
    this.setState(f, 'attack', mv.windup + mv.active + mv.recovery);
    f.move = mv;
    f.attackId = ++this.attackCounter;
    f.hitsDone = 0;
    f.hitResolved = false;
    f.hitLanded = false;
    f.comboChecked = false;
    f.prevK = -1;
    f.minGap = 99;
    f.worldHits.length = 0;
    if (aim) {
      f.aimOn = true;
      f.aimX = aim.x;
      f.aimZ = aim.z;
    } else f.aimOn = false;
    const dist = hypot(o.x - f.x, o.z - f.z);
    f.startGap = dist - f.def.stats.radius - o.def.stats.radius;
    const lunge = mv.lunge ?? 0;
    const r = mv.ranged || mv.feint ? null : moveReach(f.def.id, mv);
    if (aim) f.lungeDist = 0;
    else if (lunge < 0) f.lungeDist = lunge;
    else if (r) {
      // tracking/magnetism: step in just enough that the strike point lands on the target
      const reach = mv.aoe ? r.maxRad : r.maxFwd;
      f.lungeDist = clamp(dist - o.def.stats.radius - reach * 0.8, 0, lunge + MAGNET);
    } else f.lungeDist = lunge > 0 ? clamp(dist - f.def.stats.radius - o.def.stats.radius - mv.range * 0.45, 0, lunge) : 0;
    f.ai.mem.myAttacks++;
    this.emit('attack_start', f.idx, o.idx, { move: mv.id, kind: mv.kind, windup: mv.windup, name: mv.name });
    if (mv.kind === 'ultimate') this.emit('ability_used', f.idx, o.idx, { move: mv.id, name: mv.name });
    return true;
  }

  /** Pick up a throwable prop (Throw_Object clip: crouch, grab, lift to the chest). */
  startLift(f: FighterState, prop: number): boolean {
    if (f.state !== 'idle' || f.carry >= 0 || !this.world.canLift(f, prop)) return false;
    const p = this.world.props[prop];
    this.setState(f, 'lift', LIFT_DUR);
    this.world.reserve(f, prop);
    f.aimOn = true;
    f.aimX = p.x;
    f.aimZ = p.z;
    this.emit('prop_lift', f.idx, -1, { prop, kind: p.kind });
    return true;
  }

  /** Throw the carried prop; it leaves the hands on the clip's release frame. */
  startThrow(f: FighterState): boolean {
    if (f.state !== 'idle' || f.carry < 0) return false;
    this.setState(f, 'throw', THROW_DUR);
    f.hitsDone = 0;
    this.emit('throw_start', f.idx, 1 - f.idx, { prop: f.carry });
    return true;
  }

  startBlock(f: FighterState, until: number) {
    if (!this.canAct(f)) return;
    if (f.state !== 'block') {
      this.setState(f, 'block');
      f.blockStartT = this.t;
      f.parryIntent = false;
    }
    f.blockUntil = Math.max(f.blockUntil, until);
  }

  startDodge(f: FighterState, dx: number, dz: number): boolean {
    if (!this.canAct(f) || f.stamina < 12) return false;
    const l = hypot(dx, dz) || 1;
    f.stamina -= 18;
    this.setState(f, 'dodge', 0.5);
    f.dodgeX = dx / l;
    f.dodgeZ = dz / l;
    {
      // variant by direction relative to facing (time-warped so the clip's travel fits the sim's 0.4 s burst)
      const [fx, fz] = forwardOf(f.facing);
      const fw = f.dodgeX * fx + f.dodgeZ * fz;
      const sd = f.dodgeX * fz - f.dodgeZ * fx; // > 0: toward the character's left
      const dir: Dir = fw < -0.55 ? 'B' : fw > 0.6 ? 'F' : sd > 0 ? 'L' : 'R';
      f.clip = this.anim.dodge(f.idx, this.t, { dodgeDir: dir, style: styleOf(f.def.id) });
      const d = clipData(f.clip);
      f.clipT0 = 0;
      f.clipRate = d ? Math.min(2.2, Math.max(1.0, d.travelT / 0.42)) : 1;
    }
    return true;
  }

  startTaunt(f: FighterState) {
    if (!this.canAct(f)) return;
    this.setState(f, 'taunt', 1.3);
    f.fury = Math.min(100, f.fury + 12);
    this.emit('taunt', f.idx, 1 - f.idx);
  }

  startRoar(f: FighterState, dur: number) {
    this.setState(f, 'roar', dur);
  }

  /** State checks via method so TS doesn't over-narrow after mutating calls. */
  isDead(f: FighterState): boolean {
    return f.state === 'dead';
  }
  isDown(f: FighterState): boolean {
    return f.state === 'dead' || f.state === 'knockdown' || f.state === 'launched' || f.state === 'scene';
  }

  isInvulnerable(f: FighterState): boolean {
    if (f.state === 'dodge') return f.stateT >= 0.03 && f.stateT <= 0.34;
    if (f.state === 'knockdown' || f.state === 'launched' || f.state === 'scene') return true;
    if (f.state === 'getup') return f.stateT < Math.max(0.35, f.stateDur * 0.55);
    if (f.state === 'dead') return true;
    return false;
  }

  attackPhase(f: FighterState): number {
    if (f.state !== 'attack' || !f.move) return -1;
    const m = f.move;
    if (f.stateT < m.windup) return 0;
    if (f.stateT < m.windup + m.active) return 1;
    return 2;
  }

  // ---------------------------------------------------------------- tick
  step() {
    const dt = DT;
    this.t += dt;
    this.ringS = ringRadiusAt(this.t) / ARENA.fightR;
    this.drama.preTick();

    if (this.fin) this.tickFinisher(dt);
    const inScene = (f: FighterState) => !!this.fin && (f.idx === this.fin.att || f.idx === this.fin.vic);
    for (const f of this.f) if (!inScene(f)) this.updateFighter(f, this.f[1 - f.idx], dt);
    if (!this.over) for (const f of this.f) if (!inScene(f)) aiTick(this, f, this.f[1 - f.idx]);
    for (const f of this.f) if (!inScene(f)) this.integrate(f, this.f[1 - f.idx], dt);
    this.collideFighters();
    for (const f of this.f) this.resolveAttack(f, this.f[1 - f.idx]);
    this.updateProjectiles();
    this.world.update(this, dt);

    this.drama.postTick();

    if (!this.over && this.t >= ARENA.timeLimit) {
      this.over = true;
      this.timeout = true;
      const [a, b] = this.f;
      this.winner = a.hp / a.maxHp === b.hp / b.maxHp ? -1 : a.hp / a.maxHp > b.hp / b.maxHp ? 0 : 1;
      this.endT = this.t + 3;
      this.emit('timeout', this.winner);
      if (this.winner >= 0) this.setState(this.f[this.winner], 'victory');
    }
    if (this.over && this.winner >= 0) {
      const w = this.f[this.winner];
      if (w.state === 'idle' && this.t > this.endT - POST_KILL + 0.8) this.setState(w, 'victory');
    }
    if (this.record) this.frames.push(this.snapshot());
  }

  private updateFighter(f: FighterState, o: FighterState, dt: number) {
    f.stateT += dt;
    const S = f.def.stats;
    // stamina
    let regen = S.staminaRegen;
    if (f.state === 'attack' || f.state === 'dodge') regen *= 0.1;
    else if (f.state === 'winded') regen *= 2.5;
    else if (f.state === 'block') regen *= 0.4;
    else if (f.state === 'stagger') regen *= 0.6;
    if (f.exhausted) regen *= 1.15;
    f.stamina = Math.min(S.stamina, f.stamina + regen * dt);
    if (!f.exhausted && f.stamina <= 2) {
      f.exhausted = true;
      f.windedPending = true; // stamina crunch: gasps for air once the current action ends
    } else if (f.exhausted && f.stamina > S.stamina * 0.45) f.exhausted = false;
    // fury trickle
    if (f.state !== 'dead') f.fury = Math.min(100, f.fury + dt * 0.25);
    if (f.buffT > 0) {
      f.buffT -= dt;
      if (f.buffT <= 0) f.buffMul = 1;
    }

    if (f.windedPending && f.state === 'idle') {
      f.windedPending = false;
      this.setState(f, 'winded', 1.1);
      this.emit('exhausted', f.idx, 1 - f.idx);
    }

    switch (f.state) {
      case 'winded':
        if (f.stateT >= f.stateDur) this.setState(f, 'idle');
        break;
      case 'lift':
        if (f.liftProp >= 0 && f.stateT >= LIFT_GRAB) this.world.attach(this, f);
        if (f.stateT >= f.stateDur) this.setState(f, 'idle');
        break;
      case 'throw':
        if (f.hitsDone === 0 && f.stateT >= THROW_RELEASE) {
          f.hitsDone = 1;
          this.world.launch(this, f, o);
        }
        if (f.stateT >= f.stateDur) this.setState(f, 'idle');
        break;
      case 'attack': {
        const m = f.move!;
        const total = m.windup + m.active + m.recovery;
        if (m.feint && f.stateT >= m.windup * 0.62) {
          // feint: abort the swing before it commits; get some stamina back
          f.stamina = Math.min(S.stamina, f.stamina + m.stamina * 0.5);
          this.emit('feint', f.idx, o.idx, { move: m.id });
          this.setState(f, 'idle');
          break;
        }
        // combo cancel at start of recovery
        if (!f.comboChecked && f.stateT >= m.windup + m.active + 0.04) {
          f.comboChecked = true;
          if (m.next && !this.over) {
            const nm = f.def.moves.find((x) => x.id === m.next);
            if (nm && wantsCombo(this, f, o, nm)) {
              this.startAttack(f, nm);
              break;
            }
          }
        }
        if (f.stateT >= total) this.setState(f, 'idle');
        break;
      }
      case 'block':
        if (this.t >= f.blockUntil) this.setState(f, 'idle');
        break;
      case 'dodge':
      case 'stagger':
      case 'taunt':
        if (f.stateT >= f.stateDur) this.setState(f, 'idle');
        break;
      case 'roar':
        if (f.stateT >= f.stateDur) this.setState(f, 'idle');
        break;
      case 'knockdown':
        if (f.stateT >= f.stateDur) {
          this.setState(f, 'getup', 0.6);
          this.emit('getup', f.idx, -1, { clip: f.clip });
        }
        break;
      case 'launched':
        if (f.stateT >= f.stateDur) {
          f.y = 0;
          f.launch = null;
          this.world.shake(this, f.x, f.z, 3);
          this.emit('launch_land', f.idx, o.idx, { x: +f.x.toFixed(2), z: +f.z.toFixed(2) });
          this.setState(f, 'knockdown', 0.6);
        }
        break;
      case 'getup':
        if (f.stateT >= f.stateDur) this.setState(f, 'idle');
        break;
    }

    // facing
    if (f.state !== 'dead') {
      const want = f.aimOn ? angleTo(f.x, f.z, f.aimX, f.aimZ) : angleTo(f.x, f.z, o.x, o.z);
      let rate = 0;
      if (f.state === 'idle' || f.state === 'block' || f.state === 'taunt' || f.state === 'roar' || f.state === 'victory') rate = S.turnRate;
      else if (f.state === 'lift') rate = f.stateT < LIFT_GRAB ? S.turnRate : S.turnRate * 0.5;
      else if (f.state === 'throw') rate = f.stateT < THROW_RELEASE ? S.turnRate * 1.1 : 0;
      else if (f.state === 'attack' && f.move) {
        const ph = this.attackPhase(f);
        if (ph === 0) rate = S.turnRate * (f.move.kind === 'gap' ? 0.9 : f.move.kind === 'heavy' || f.move.kind === 'ultimate' ? 0.45 : 0.6);
        else if (ph === 1 && (f.move.hits ?? 1) > 1) rate = S.turnRate * 0.35; // flurries track a bit
      } else if (f.state === 'getup') rate = S.turnRate * 0.5;
      if (f.state === 'victory') rate = 0;
      const d = angDiff(f.facing, want);
      const step = rate * dt;
      f.facing += clamp(d, -step, step);
    }
  }

  private integrate(f: FighterState, o: FighterState, dt: number) {
    const S = f.def.stats;
    // Locomotion
    let wantX = 0,
      wantZ = 0;
    if (f.state === 'idle') {
      wantX = f.wantX;
      wantZ = f.wantZ;
    } else if (f.state === 'block') {
      // shield-bearers can advance behind their guard (e.g. walking into arrows)
      const k = S.hasShield ? 0.65 : 0.35;
      wantX = f.wantX * k;
      wantZ = f.wantZ * k;
    }
    // backpedalling is slower than advancing (kiters can't out-run a chaser forever)
    {
      const dxo = o.x - f.x,
        dzo = o.z - f.z;
      const dl = hypot(dxo, dzo) || 1;
      const wl = hypot(wantX, wantZ);
      if (wl > 0.1 && (wantX * dxo + wantZ * dzo) / (dl * wl) < -0.3) {
        wantX *= 0.8;
        wantZ *= 0.8;
      }
    }
    if (f.carry >= 0) {
      const k = 1 - 0.14 * this.world.props[f.carry].mass;
      wantX *= k;
      wantZ *= k;
    }
    {
      const slow = this.world.slowAt(f.x, f.z);
      wantX *= slow;
      wantZ *= slow;
    }
    const acc = 1 - exp(-14 * dt);
    f.mx += (wantX - f.mx) * acc;
    f.mz += (wantZ - f.mz) * acc;
    if (f.state !== 'idle' && f.state !== 'block') {
      f.mx *= exp(-10 * dt);
      f.mz *= exp(-10 * dt);
    }
    // strafe direction for render
    const [fx, fz] = forwardOf(f.facing);
    f.strafe = (f.mx * fz - f.mz * fx) / Math.max(1, S.speed);

    if (f.launch && (f.state === 'launched' || f.state === 'dead')) {
      if (f.state === 'dead' && f.stateT >= f.launch.T) {
        f.y = 0;
        f.clipT0 += f.launch.T * (f.clipRate - 1);
        f.clipRate = 1;
        f.launch = null;
        this.world.shake(this, f.x, f.z, 3);
        this.emit('launch_land', f.idx, o.idx, { x: +f.x.toFixed(2), z: +f.z.toFixed(2), dead: true });
      } else {
        this.flyLaunch(f, o, dt);
        return;
      }
    }
    let vx = f.mx + f.kx,
      vz = f.mz + f.kz;
    f.y = 0;
    // Lunge / attack tracking
    if (f.state === 'attack' && f.move && f.lungeDist !== 0) {
      const m = f.move;
      if (f.lungeDist > 0) {
        // travel mostly during the windup so the body ARRIVES as the strike lands
        const s0 = m.windup * (m.kind === 'gap' ? 0.2 : 0.55),
          s1 = m.windup + m.active * 0.35;
        if (f.stateT >= s0 && f.stateT < s1) {
          // re-aim each tick at where the target is NOW (tracking), within the move's lunge budget
          const r = moveReach(f.def.id, m);
          const dist = hypot(o.x - f.x, o.z - f.z);
          const reach = r ? (m.aoe ? r.maxRad : r.maxFwd) : m.range;
          const need = dist - o.def.stats.radius - reach * 0.8;
          const maxSp = ((Math.max(0, m.lunge ?? 0) + MAGNET) / (s1 - s0)) * 1.25;
          const sp = clamp(need / Math.max(0.05, s1 - f.stateT), 0, maxSp);
          const gap = dist - S.radius - o.def.stats.radius;
          if (gap > 0.1) {
            vx += fx * sp;
            vz += fz * sp;
          }
          if (m.airborne) f.y = sin(((f.stateT - s0) / (s1 - s0)) * Math.PI) * 1.3;
        }
      } else {
        // hop-back moves (hit-and-run): retreat AFTER the strike, during early recovery
        const s0 = m.windup + m.active,
          s1 = s0 + m.recovery * 0.7;
        if (f.stateT >= s0 && f.stateT < s1) {
          const sp = f.lungeDist / (s1 - s0);
          vx += fx * sp;
          vz += fz * sp;
        }
      }
    }
    // Dodge roll
    if (f.state === 'dodge') {
      const k = f.stateT / f.stateDur;
      const sp = (S.dodgeDist / f.stateDur) * 1.6 * (1 - k);
      vx += f.dodgeX * sp;
      vz += f.dodgeZ * sp;
    }
    f.x += vx * dt;
    f.z += vz * dt;
    // knockback friction
    const fr = exp(-5.5 * dt);
    f.kx *= fr;
    f.kz *= fr;

    this.collideWorld(f, o);
  }

  private collideWorld(f: FighterState, o: FighterState) {
    const R = f.def.stats.radius;
    const kSpeed = hypot(f.kx, f.kz);
    const W = this.world;
    // standing obstacles (cover)
    for (let i = 0; i < this.arena.obstacles.length; i++) {
      if (!W.standing(i)) continue;
      const p = this.arena.obstacles[i];
      const dx = f.x - p.x,
        dz = f.z - p.z;
      const d = hypot(dx, dz);
      const min = R + p.r;
      if (d < min && d > 1e-6) {
        f.x = p.x + (dx / d) * min;
        f.z = p.z + (dz / d) * min;
        if (kSpeed > 4.2 && f.state !== 'dead') {
          // slammed into it: hurts the fighter AND cracks the cover (may topple it)
          W.damageObstacle(this, i, 18 + kSpeed * 7, f.x - f.kx, f.z - f.kz, o.idx);
          this.environmentSlam(f, o, 'pillar_slam', kSpeed);
        }
      }
    }
    // props at rest
    for (let i = 0; i < W.props.length; i++) {
      const p = W.props[i];
      if (p.state !== PS_REST) continue;
      const dx = f.x - p.x,
        dz = f.z - p.z;
      const d = hypot(dx, dz);
      const min = R + p.r;
      if (d < min && d > 1e-6) {
        const charging = f.state === 'attack' && f.move?.lunge && f.move.lunge > 3;
        const breakable = p.kind !== 'rock' && p.kind !== 'chunk';
        if (breakable && (kSpeed > 2.5 || charging)) {
          W.breakProp(this, i, f.idx);
          if (kSpeed > 2.5 && f.state !== 'dead') {
            this.applyDamage(f, 18, o, 'prop', false);
            if (!this.isDown(f)) this.setState(f, 'stagger', 0.45);
          }
          f.kx *= 0.5;
          f.kz *= 0.5;
        } else {
          f.x = p.x + (dx / d) * min;
          f.z = p.z + (dz / d) * min;
        }
      }
    }
    // arena wall
    const r = hypot(f.x, f.z);
    const gap = W.edgeGap(f.x, f.z);
    if (gap < 0 && r > 1e-6) {
      const k = (r + gap) / r;
      f.x *= k;
      f.z *= k;
      if (kSpeed > 4.2 && f.state !== 'dead') {
        W.shake(this, f.x, f.z, 6);
        this.environmentSlam(f, o, 'wall_slam', kSpeed);
      }
    }
    // shrinking fire ring
    if (W.edgeGap(f.x, f.z, this.ringS) < -0.2 && f.state !== 'dead' && !this.over) {
      this.applyDamage(f, 10 * DT, o, 'fire', false);
      f.fury = Math.min(100, f.fury + DT * 2);
      if (this.t - f.lastBurnEvt > 1) {
        f.lastBurnEvt = this.t;
        this.emit('hazard_burn', f.idx);
      }
    }
  }

  private environmentSlam(f: FighterState, o: FighterState, type: 'wall_slam' | 'pillar_slam', speed: number) {
    this.world.shake(this, f.x, f.z, 5);
    f.react = { x: f.x - f.kx, z: f.z - f.kz, sev: 3, height: 'body' };
    const dmg = 14 + speed * 3.5;
    this.emit(type, f.idx, o.idx, { dmg: Math.round(dmg), speed: +speed.toFixed(2) });
    // bounce
    f.kx *= -0.3;
    f.kz *= -0.3;
    this.applyDamage(f, dmg, o, type);
    if (f.state !== 'knockdown' && f.state !== 'dead') this.setState(f, 'stagger', 0.7);
  }

  private collideFighters() {
    const [a, b] = this.f;
    if (a.y > 0.6 || b.y > 0.6) return;
    const dx = b.x - a.x,
      dz = b.z - a.z;
    const d = hypot(dx, dz);
    const min = a.def.stats.radius + b.def.stats.radius;
    if (d < min && d > 1e-6) {
      const push = min - d;
      const wa = b.def.stats.weight / (a.def.stats.weight + b.def.stats.weight);
      a.x -= (dx / d) * push * wa;
      a.z -= (dz / d) * push * wa;
      b.x += (dx / d) * push * (1 - wa);
      b.z += (dz / d) * push * (1 - wa);
    }
  }

  inReach(f: FighterState, o: FighterState, m: MoveDef): boolean {
    const dx = o.x - f.x,
      dz = o.z - f.z;
    const d = hypot(dx, dz);
    if (d - o.def.stats.radius > m.range) return false;
    if (o.y > 0.9) return false;
    if (m.aoe) return true;
    const a = Math.abs(angDiff(f.facing, atan2(dx, dz)));
    // generous at very close range so hugging doesn't produce whiffs
    const arc = (m.arc * Math.PI) / 180 + (d < 1.2 ? 0.5 : 0);
    return a <= arc;
  }

  /** Body capsule of a fighter (vertical segment + radius). */
  capsuleOf(o: FighterState) {
    return this.capsule(o);
  }

  /**
   * Environmental hit (thrown prop, explosion, falling column, hazard): damage +
   * knockback away from (x,z) + stagger / knockdown. Called on the tick the
   * thing visibly reaches the fighter.
   */
  envHit(def: FighterState, att: FighterState, dmg: number, source: string, o: { x: number; z: number; kb: number; knockdown: boolean; lethal: boolean; hitEvent?: boolean; minKb?: boolean }) {
    if (def.state === 'dead' || this.over) return;
    const dx = def.x - o.x,
      dz = def.z - o.z;
    const l = hypot(dx, dz) || 1;
    this.applyDamage(def, dmg, att, source, o.lethal);
    if (att !== def) this.drama.onHit(att, def, dmg);
    if (this.isDead(def)) return;
    const kb = o.kb / Math.max(0.7, def.def.stats.weight);
    def.react = { x: o.x, z: o.z, sev: o.knockdown ? 3 : 2, height: 'body' };
    // geysers and point-blank blasts throw fighters through the air
    if (o.knockdown && def.state !== 'launched' && (source === 'geyser' || (source === 'explosion' && kb >= 7.5)) && this.tryLaunch(def, att, null, dx / l, dz / l, Math.max(LAUNCH.minForce, kb), false, true)) return;
    if (o.knockdown && def.state !== 'knockdown' && def.state !== 'launched') {
      this.setState(def, 'knockdown', 1.15);
      this.emit('knockdown', def.idx, att.idx, { move: source, clip: def.clip, face: def.getupFace });
    } else if (!this.isDown(def) && def.state !== 'roar') this.setState(def, 'stagger', 0.5);
    def.kx = (dx / l) * kb;
    def.kz = (dz / l) * kb;
  }

  private capsule(o: FighterState): { a: number[]; b: number[]; r: number } {
    const top = o.state === 'knockdown' || o.state === 'getup' || o.state === 'launched' ? 0.6 : o.def.id === 'maw' ? 2.35 : 2.05;
    return { a: [o.x, 0.15 + o.y, o.z], b: [o.x, top + o.y, o.z], r: o.def.stats.radius };
  }

  /**
   * Swept contact test: does the strike point travelling between active
   * progress kA and kB pass within the target's body capsule? Returns the
   * closest distance (<= 0 means contact).
   */
  private contactGap(f: FighterState, o: FighterState, m: MoveDef, r: MoveReach, kA: number, kB: number): number {
    const cap = this.capsule(o);
    if (m.aoe) {
      // radial sweeps: horizontal distance against the swept limb radius;
      // ground-shockwave moves (quake/nova/holy fx) reach as far as their visible shockwave
      const d = hypot(o.x - f.x, o.z - f.z);
      const wave = m.fx === 'quake' || m.fx === 'nova' || m.fx === 'holy' ? m.range + f.def.stats.radius : 0;
      return d - cap.r - Math.max(r.maxRad, wave) - CONTACT_TOL;
    }
    const tA = clipTime(r, m, 1, kA),
      tB = clipTime(r, m, 1, kB);
    const pa = strikePoints(r, tA),
      pb = strikePoints(r, tB);
    let best = 1e9;
    for (let i = 0; i < pa.length; i++) {
      const wa = toWorld(f.x, f.z, f.facing, pa[i][0], pa[i][1] + f.y, pa[i][2]);
      const wb = toWorld(f.x, f.z, f.facing, pb[i][0], pb[i][1] + f.y, pb[i][2]);
      best = Math.min(best, segSegDist(wa, wb, cap.a, cap.b) - cap.r - CONTACT_TOL);
    }
    return best;
  }

  private resolveAttack(f: FighterState, o: FighterState) {
    if (f.state !== 'attack' || !f.move) return;
    const m = f.move;
    if (m.feint) return;
    const hits = m.hits ?? 1;
    const t0 = m.windup,
      t1 = m.windup + m.active;
    if (f.stateT < t0) return;
    const k = clamp((f.stateT - t0) / m.active, 0, 1);
    const kPrev = f.prevK < 0 ? 0 : f.prevK;
    f.prevK = k;
    // ---- projectiles: one per hit, released across the active window
    if (m.ranged) {
      const idx = f.stateT > t1 ? hits - 1 : Math.min(hits - 1, Math.floor(k * hits));
      while (f.hitsDone <= idx && f.hitsDone < hits) this.spawnProjectile(f, o, m, f.hitsDone++, hits);
      return;
    }
    const r = moveReach(f.def.id, m);
    if (!r) {
      // legacy abstract-range fallback (no clip data)
      if (hits === 1) {
        if (f.hitResolved) return;
        if (f.stateT <= t1 && this.inReach(f, o, m)) {
          f.hitResolved = true;
          this.resolveHit(f, o, m, 0, 1);
        } else if (f.stateT > t1) {
          f.hitResolved = true;
          this.emit('whiff', f.idx, o.idx, { move: m.id });
        }
        return;
      }
      const idx = Math.min(hits - 1, Math.floor(((f.stateT - t0) / m.active) * hits));
      while (f.hitsDone <= idx && f.hitsDone < hits && f.stateT <= t1 + 1e-6) {
        const kk = f.hitsDone++;
        if (this.inReach(f, o, m)) this.resolveHit(f, o, m, kk, hits);
      }
      return;
    }
    if (f.stateT <= t1 + 1e-6) this.worldContact(f, m, r, kPrev, k);
    // ---- melee: swept strike-point vs body capsule, hit i lives in window [i/h, (i+1)/h]
    while (f.hitsDone < hits) {
      const i = f.hitsDone;
      const w0 = i / hits,
        w1 = (i + 1) / hits;
      const a = Math.max(kPrev, w0),
        b = Math.min(k, w1);
      if (b >= a && b > w0 - 1e-9) {
        const gap = this.contactGap(f, o, m, r, a, b);
        f.minGap = Math.min(f.minGap, gap);
        if (gap <= 0) {
          f.hitsDone++;
          f.hitResolved = true;
          this.contactLog.push(gap);
          this.resolveHit(f, o, m, i, hits);
          continue;
        }
      }
      if (k >= w1 || f.stateT > t1) {
        f.hitsDone++; // this hit's window passed without contact
        if (f.hitsDone === hits && !f.hitResolved) {
          this.emit('whiff', f.idx, o.idx, { move: m.id });
          this.whiffLog.push({ move: m.id, fid: f.def.id, closest: f.minGap, startGap: f.startGap });
        }
        continue;
      }
      break;
    }
  }

  /** melee swings smash props and chip cover they physically pass through */
  private worldContact(f: FighterState, m: MoveDef, r: MoveReach, kA: number, kB: number) {
    const W = this.world;
    const near = (x: number, z: number, rad: number) => hypot(x - f.x, z - f.z) < rad + r.maxRad + 0.6;
    const test = (x: number, z: number, rad: number, h: number) => {
      if (m.aoe) return hypot(x - f.x, z - f.z) - rad - r.maxRad - CONTACT_TOL;
      const tA = clipTime(r, m, 1, kA),
        tB = clipTime(r, m, 1, kB);
      const pa = strikePoints(r, tA),
        pb = strikePoints(r, tB);
      let best = 1e9;
      for (let i = 0; i < pa.length; i++) {
        const wa = toWorld(f.x, f.z, f.facing, pa[i][0], pa[i][1] + f.y, pa[i][2]);
        const wb = toWorld(f.x, f.z, f.facing, pb[i][0], pb[i][1] + f.y, pb[i][2]);
        best = Math.min(best, segSegDist(wa, wb, [x, 0.05, z], [x, h, z]) - rad - CONTACT_TOL * 0.5);
      }
      return best;
    };
    const heavy = m.kind === 'heavy' || m.kind === 'ultimate' ? 1.5 : 1;
    for (let i = 0; i < W.props.length; i++) {
      const p = W.props[i];
      if (p.state !== PS_REST || p.kind === 'rock' || p.kind === 'chunk' || f.worldHits.includes(1000 + i)) continue;
      if (!near(p.x, p.z, p.r)) continue;
      if (test(p.x, p.z, p.r, p.top) <= 0) {
        f.worldHits.push(1000 + i);
        W.damageProp(this, i, m.damage * heavy, f.idx);
      }
    }
    for (let i = 0; i < this.arena.obstacles.length; i++) {
      const ob = this.arena.obstacles[i];
      if (!W.standing(i) || ob.kind === 'rock' || f.worldHits.includes(i)) continue;
      if (!near(ob.x, ob.z, ob.r)) continue;
      if (test(ob.x, ob.z, ob.r, ob.h) <= 0) {
        f.worldHits.push(i);
        W.damageObstacle(this, i, m.damage * 0.55 * heavy * (f.aimOn ? 1.6 : 1), f.x, f.z, f.idx);
      }
    }
  }

  private spawnProjectile(f: FighterState, o: FighterState, m: MoveDef, hit: number, hits: number) {
    const fx = sin(f.facing),
      fz = cos(f.facing);
    const ox = f.x + fx * (f.def.stats.radius + 0.25),
      oz = f.z + fz * (f.def.stats.radius + 0.25);
    const oy = 1.35;
    const tx = f.aimOn ? f.aimX : o.x,
      ty = f.aimOn ? 0.6 : 1.15 + o.y,
      tz = f.aimOn ? f.aimZ : o.z;
    const dx = tx - ox,
      dy = ty - oy,
      dz = tz - oz;
    const d = hypot(dx, dy, dz) || 1;
    // aim follows facing within a narrow cone (a mis-aimed shot can miss)
    const aim = atan2(dx, dz);
    const off = Math.max(-0.35, Math.min(0.35, angDiff(f.facing, aim)));
    const dir = f.facing + off;
    const sp = m.speed ?? 20;
    const horiz = hypot(dx, dz) / d;
    this.projectiles.push({
      id: ++this.projCounter, owner: f.idx, move: m, hit, hits,
      x: ox, y: oy, z: oz,
      vx: sin(dir) * sp * horiz, vy: (dy / d) * sp, vz: cos(dir) * sp * horiz,
      travelled: 0, radius: m.fx === 'pyre' || m.fx === 'fire' ? 0.3 : 0.18,
    });
  }

  private updateProjectiles() {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const step = hypot(p.vx, p.vy, p.vz) * DT;
      const nx = p.x + p.vx * DT,
        ny = p.y + p.vy * DT,
        nz = p.z + p.vz * DT;
      const att = this.f[p.owner],
        def = this.f[1 - p.owner];
      let done = false;
      // cover blocks shots (and gets chipped); props in the line of fire get hit
      const W = this.world;
      for (let j = 0; j < this.arena.obstacles.length && !done; j++) {
        const ob = this.arena.obstacles[j];
        if (W.standing(j) && ny < ob.h && hypot(nx - ob.x, nz - ob.z) < ob.r + p.radius) {
          done = true;
          this.emit('projectile', p.owner, -1, { hit: 'pillar', move: p.move.id, obs: j, x: +nx.toFixed(2), y: +ny.toFixed(2), z: +nz.toFixed(2) });
          W.damageObstacle(this, j, p.move.damage * 0.7, p.x, p.z, p.owner);
        }
      }
      for (let j = 0; j < W.props.length && !done; j++) {
        const q = W.props[j];
        if (q.state !== PS_REST || ny > q.top + 0.1) continue;
        if (hypot(nx - q.x, nz - q.z) < q.r + p.radius) {
          done = true;
          this.emit('projectile', p.owner, -1, { hit: 'prop', move: p.move.id, prop: j, x: +nx.toFixed(2), y: +ny.toFixed(2), z: +nz.toFixed(2) });
          W.damageProp(this, j, p.move.damage, p.owner);
        }
      }
      if (!done && !this.over && def.state !== 'dead' && def.carry >= 0) {
        // a carried barrel / crate / rock held up in front works as a shield against shots
        const cp = W.props[def.carry];
        const toShot = atan2(p.x - def.x, p.z - def.z);
        if (Math.abs(angDiff(def.facing, toShot)) < 1.1 && hypot(nx - def.x, nz - def.z) < def.def.stats.radius + cp.r + 0.35 && ny < 2.1) {
          done = true;
          this.emit('projectile', p.owner, -1, { hit: 'carried', move: p.move.id, prop: def.carry, x: +nx.toFixed(2), y: +ny.toFixed(2), z: +nz.toFixed(2) });
          if (cp.kind !== 'rock' && cp.kind !== 'chunk') {
            cp.hp -= p.move.damage;
            if (cp.hp <= 0) W.breakProp(this, def.carry, p.owner);
          }
        }
      }
      if (!done && !this.over && def.state !== 'dead') {
        const cap = this.capsule(def);
        const g = segSegDist([p.x, p.y, p.z], [nx, ny, nz], cap.a, cap.b) - cap.r - p.radius;
        if (g <= 0) {
          done = true;
          this.contactLog.push(g);
          this.resolveHit(att, def, p.move, p.hit, p.hits);
        }
      }
      p.x = nx;
      p.y = ny;
      p.z = nz;
      p.travelled += step;
      if (!done && (p.travelled > p.move.range + 1.5 || this.world.edgeGap(p.x, p.z) < -0.7 || p.y < 0)) {
        done = true;
        this.emit('whiff', p.owner, 1 - p.owner, { move: p.move.id, projectile: true });
      }
      if (done) this.projectiles.splice(i, 1);
    }
  }

  private resolveHit(att: FighterState, def: FighterState, m: MoveDef, k: number, hits: number) {
    if (def.state === 'dead' || this.over) return;
    const isLast = k === hits - 1;
    if (this.isInvulnerable(def)) {
      if (def.state === 'dodge' && (k === 0 || isLast)) {
        this.emit('dodge', def.idx, att.idx, { move: m.id });
        att.ai.mem.dodged++;
      }
      return;
    }
    const toAtt = atan2(att.x - def.x, att.z - def.z);
    const frontal = Math.abs(angDiff(def.facing, toAtt)) < 1.4;
    const dirX = def.x - att.x,
      dirZ = def.z - att.z;
    const dl = hypot(dirX, dirZ) || 1;
    const nx = dirX / dl,
      nz = dirZ / dl;
    const S = def.def.stats;

    if (def.state === 'block' && frontal && !m.unblockable) {
      const since = this.t - def.blockStartT;
      const parryWin = 0.16 + (S.hasShield ? 0.08 : 0);
      if (hits === 1 && def.parryIntent && since <= parryWin) {
        this.emit('parry', def.idx, att.idx, { move: m.id });
        att.react = { x: def.x, z: def.z, sev: 2, height: 'body' };
        this.setState(att, 'stagger', 1.0);
        att.kx = -nx * 2;
        att.kz = -nz * 2;
        def.fury = Math.min(100, def.fury + 14);
        def.stamina = Math.min(S.stamina, def.stamina + 12);
        att.ai.mem.parried++;
        this.drama.onAction();
        return;
      }
      const base = m.damage * this.drama.damageMul(att, def);
      const chip = base * 0.15 * (1 - S.blockStrength * 0.6);
      def.stamina -= m.damage * 0.3 * (m.guardDamage ?? 1) * (1.25 - S.blockStrength);
      def.kx += nx * m.knockback * 0.35;
      def.kz += nz * m.knockback * 0.35;
      att.ai.mem.blocked++;
      this.emit('block', def.idx, att.idx, { move: m.id, chip: Math.round(chip) });
      this.applyDamage(def, chip, att, m.id, false);
      att.fury = Math.min(100, att.fury + 1);
      if (!this.isDead(def) && def.stamina <= 0) {
        def.stamina = 0;
        def.react = { x: att.x, z: att.z, sev: 3, height: 'body' };
        this.setState(def, 'stagger', 1.15);
        this.emit('guard_break', def.idx, att.idx, { move: m.id });
      }
      this.drama.onAction();
      return;
    }

    // Clean hit
    const ph = this.attackPhase(def);
    const counter = ph === 0 || ph === 2;
    const dmg = m.damage * att.buffMul * this.drama.damageMul(att, def) * (counter && ph === 0 ? 1.2 : 1) * (m.counter ? 1.15 : 1);
    if (m.counter) this.emit('counter', att.idx, def.idx, { move: m.id });
    att.hitLanded = true;
    att.hitsLanded++;
    this.emit('hit', att.idx, def.idx, {
      dmg: Math.round(dmg),
      move: m.id,
      kind: m.kind,
      counter: counter && ph === 0,
      heavy: m.kind === 'heavy' || m.kind === 'ultimate' || m.damage >= 70,
      fx: m.fx ?? '',
      k,
    });
    // reaction context: where it came from, how high it landed, how hard
    const sev = m.kind === 'heavy' || m.kind === 'ultimate' || m.stagger >= 0.6 ? 3 : m.stagger >= 0.4 ? 2 : 1;
    def.react = { x: att.x, z: att.z, sev, height: this.hitHeight(att, def, m) };
    const knock = (m.knockdown && hits === 1) || (m.knockdownLast && isLast) || (m.knockdown && isLast);
    // launch force: knockback x the attacker's mass, more on counters / off-balance victims, less on heavy victims
    const force = knock ? launchForce(att, def, m, ph) : 0;
    const wouldKill = def.hp - dmg * this.drama.incomingMul(def) <= 0;
    if (wouldKill && !this.fin && !this.over && this.tryFinisher(att, def, m, nx, nz, !!knock, dmg)) return;
    if (knock && wouldKill && this.tryLaunch(def, att, m, nx, nz, force, true)) {
      // lethal launch: the body flies on the arc (the kill below happens at the same tick)
    }
    this.applyDamage(def, dmg, att, m.id);
    att.fury = Math.min(100, att.fury + dmg * 0.035);
    this.drama.onHit(att, def, dmg);
    if (this.isDead(def)) return;
    if (def.launch && def.state !== 'launched') {
      this.setState(def, 'launched', def.launch.T);
      return;
    }

    const kb = m.knockback / S.weight;
    if (knock) {
      if (this.tryLaunch(def, att, m, nx, nz, force, false)) return;
      this.setState(def, 'knockdown', 1.15);
      def.kx = nx * kb * 1.3;
      def.kz = nz * kb * 1.3;
      this.emit('knockdown', def.idx, att.idx, { move: m.id, clip: def.clip, face: def.getupFace });
      return;
    }
    const armored = def.state === 'attack' && def.move?.armor && ph === 0 && m.kind !== 'heavy' && m.kind !== 'ultimate';
    const roaring = def.state === 'roar';
    if (armored || roaring) {
      def.kx += nx * kb * 0.25;
      def.kz += nz * kb * 0.25;
      return;
    }
    const dur = Math.max(0.24, m.stagger);
    this.setState(def, 'stagger', dur);
    def.kx = nx * kb;
    def.kz = nz * kb;
    if (m.stagger >= 0.5) this.emit('stagger', def.idx, att.idx, { move: m.id });
  }

  // ---------------------------------------------------------------- finishers
  /**
   * The blow is lethal: maybe turn the death into a finisher (rarer in lopsided
   * fights, more likely for proud fighters and in tense ones). Returns true when
   * a finisher started (the death then happens on the scene's kill contact).
   */
  private tryFinisher(att: FighterState, def: FighterState, m: MoveDef, nx: number, nz: number, knock: boolean, dmg: number): boolean {
    if (this.t > ARENA.timeLimit - 7) return false;
    const P = att.def.personality;
    const hpGap = att.hp / att.maxHp - def.hp / def.maxHp;
    const p = Math.max(0.05, Math.min(0.6, 0.16 + P.pride * 0.22 + (this.drama.tension > 0.55 ? 0.08 : 0) - (hpGap > 0.6 ? 0.12 : 0)));
    if (this.anim.roll() > p) return false;
    const cands: { f: FinisherDef; w: number }[] = [];
    for (const f of FINISHERS) {
      if (!f.users.includes('*') && !f.users.includes(att.def.id)) continue;
      if (m.ranged && f.kind !== 'spell') continue;
      if (f.minWeight && att.def.stats.weight < f.minWeight) continue;
      if (f.maxVictimWeight && def.def.stats.weight > f.maxVictimWeight) continue;
      if (f.kind === 'downed' && (!knock || !execInfo(att.def.id, f))) continue;
      if (f.kind === 'spell' && (!execInfo(att.def.id, f) || hypot(def.x - att.x, def.z - att.z) > 6)) continue;
      if (f.kind === 'launch' && (!knock || !this.hazardBehind(def, nx, nz))) continue;
      if (f.kind === 'pair' && !this.pairFits(att, def, f)) continue;
      cands.push({ f, w: f.weight });
    }
    if (!cands.length) return false;
    const i = this.anim.pickIndex(cands.map((c) => c.w));
    const f = cands[i].f;
    // the blow lands (non-lethal now); the finisher kills on its own contact frame
    this.applyDamage(def, Math.min(dmg, Math.max(0, def.hp - 1)), att, m.id, false);
    att.fury = Math.min(100, att.fury + dmg * 0.035);
    if (f.kind === 'launch') {
      const hz = this.hazardBehind(def, nx, nz)!;
      this.finishers++;
      this.emit('finisher_start', att.idx, def.idx, { id: f.id, name: f.name, kind: f.kind, fx: hz.kind === 'spikes' ? 'impale' : this.arena.theme === 'glacier' ? 'shatter' : fxOf(f, att.def.id), x: +def.x.toFixed(2), z: +def.z.toFixed(2), hx: +hz.x.toFixed(2), hz: +hz.z.toFixed(2) });
      const dx = hz.x - def.x,
        dz = hz.z - def.z;
      const d = hypot(dx, dz);
      this.tryLaunch(def, att, m, dx / d, dz / d, Math.max(LAUNCH.minForce, d / 0.62), true, true);
      this.applyDamage(def, 1e6, att, f.id, true);
      return true;
    }
    this.startFinisher(f, att, def, nx, nz);
    return true;
  }

  /** a hazard 2.4-6.2 m behind the victim, within 40 degrees of the push direction */
  private hazardBehind(def: FighterState, nx: number, nz: number) {
    let best: (typeof this.arena.hazards)[number] | null = null,
      bd = 99;
    for (const h of this.arena.hazards) {
      if (h.kind !== 'lava' && h.kind !== 'firepit' && h.kind !== 'spikes') continue;
      const dx = h.x - def.x,
        dz = h.z - def.z;
      const d = hypot(dx, dz);
      if (d < 2.0 || d > 6.8) continue;
      const l = hypot(nx, nz) || 1;
      if ((dx * nx + dz * nz) / (d * l) < 0.6) continue;
      if (d < bd) {
        bd = d;
        best = h;
      }
    }
    return best;
  }

  /** scene frame for a pair finisher: anchored on the attacker, rotated so the victim's role starts toward the real victim */
  private pairFrame(att: FighterState, def: FighterState, f: FinisherDef) {
    const S = sceneOf(f)!;
    const hA = HIPS_M[att.def.id] ?? 1;
    const from = f.trim![0];
    const pa = sceneRoot(S.attRoot, from),
      pv = sceneRoot(S.vicRoot, from);
    const angScene = atan2(pv[0] - pa[0], pv[1] - pa[1]);
    const angReal = atan2(def.x - att.x, def.z - att.z);
    const yaw = angReal - angScene;
    // anchor: attacker stays where he is
    const [rx, rz] = sceneToWorld(0, 0, yaw, pa[0] * hA, pa[1] * hA);
    return { S, hA, yaw, ox: att.x - rx, oz: att.z - rz };
  }
  private pairFits(att: FighterState, def: FighterState, f: FinisherDef): boolean {
    const S = sceneOf(f);
    if (!S || !f.trim) return false;
    const { hA, yaw, ox, oz } = this.pairFrame(att, def, f);
    for (let t = f.trim[0]; t <= f.trim[1]; t += 0.4)
      for (const c of [S.attRoot, S.vicRoot]) {
        const p = sceneRoot(c, t);
        const [x, z] = sceneToWorld(ox, oz, yaw, p[0] * hA, p[1] * hA);
        if (this.world.edgeGap(x, z) < 0.5) return false;
        for (let i = 0; i < this.arena.obstacles.length; i++) {
          if (!this.world.standing(i)) continue;
          const o = this.arena.obstacles[i];
          if (hypot(x - o.x, z - o.z) < o.r + 0.55) return false;
        }
        for (const h of this.arena.hazards) if (h.kind !== 'chandelier' && hypot(x - h.x, z - h.z) < h.r + 0.3) return false;
      }
    return true;
  }

  private startFinisher(f: FinisherDef, att: FighterState, def: FighterState, nx: number, nz: number) {
    const both = [att, def];
    for (const x of both) {
      x.kx = x.kz = 0;
      x.mx = x.mz = 0;
      x.launch = null;
      x.y = 0;
    }
    const fx = fxOf(f, att.def.id);
    if (f.kind === 'pair') {
      const { S, hA, yaw, ox, oz } = this.pairFrame(att, def, f);
      const from = f.trim![0],
        to = Math.min(f.trim![1], S.dur);
      const pa = sceneRoot(S.attRoot, from),
        pv = sceneRoot(S.vicRoot, from);
      const run: FinRun = {
        def: f, att: att.idx, vic: def.idx, t: 0, ox, oz, yaw, hA, from, to, alignT: 0.25,
        a0: [att.x, att.z], v0: [def.x, def.z],
        hitsLeft: [...(f.hits ?? [])], killAt: f.kill!, killed: false, end: 0.25 + (to - from),
      };
      void pa;
      void pv;
      this.fin = run;
      this.setState(att, 'scene', run.end);
      this.setState(def, 'scene', run.end);
      att.clip = S.att;
      def.clip = S.vic;
      for (const x of both) {
        x.clipT0 = from;
        x.clipRate = 0; // frozen on the first frame during the alignment window
      }
      att.facing = yaw - S.attYaw0;
      def.facing = yaw - S.attYaw0 + S.align.yaw;
    } else if (f.kind === 'spell') {
      // the victim reels in place (slow big reaction), the caster casts; the kill lands on the release frame
      const ex = execInfo(att.def.id, f)!;
      def.react = { x: att.x, z: att.z, sev: 3, height: 'body' };
      this.setState(def, 'scene', 99);
      def.clip = this.anim.hit(def.idx, this.t, { from: this.dirFrom(def, att.x, att.z), sev: 3, style: styleOf(def.def.id) });
      def.clipT0 = 0;
      def.clipRate = 0.45;
      const from = Math.max(0, ex.t - 0.8);
      const start = 0.3;
      const run: FinRun = {
        def: f, att: att.idx, vic: def.idx, t: 0, ox: def.x, oz: def.z, yaw: atan2(def.x - att.x, def.z - att.z), hA: HIPS_M[att.def.id] ?? 1, from, to: ex.t + 1.2, alignT: 0,
        a0: [att.x, att.z], v0: [def.x, def.z], hitsLeft: [], killAt: start + (ex.t - from), killed: false,
        walk: { from: [att.x, att.z], to: [att.x, att.z], t0: 0, t1: 0.01, face: atan2(def.x - att.x, def.z - att.z) }, exec: { ...ex, start, from }, end: start + (ex.t - from) + 1.6,
      };
      this.fin = run;
      this.setState(att, 'scene', run.end);
      att.clip = '';
    } else {
      // downed: the victim goes down (fall clip), the attacker walks up and executes
      const ex = execInfo(att.def.id, f)!;
      const l = hypot(nx, nz) || 1;
      def.react = { x: att.x, z: att.z, sev: 3, height: 'body' };
      this.setState(def, 'scene', 99);
      def.clip = this.anim.knockdown(def.idx, this.t, { from: this.dirFrom(def, att.x, att.z), style: styleOf(def.def.id) });
      const kd = clipData(def.clip)!;
      def.clipT0 = 0;
      def.clipRate = 1.25;
      const fallDur = kd.groundT / 1.25 + 0.3;
      // aim at the lying body's chest (measured at the end of the chosen fall clip, victim's own scale)
      const hv = HIPS_M[def.def.id] ?? 1;
      const ec = (kd as unknown as { endChest?: [number, number, number] }).endChest ?? [0, 0.3, -0.35];
      const [cx, cz] = sceneToWorld(0, 0, def.facing, ec[0] * hv, ec[2] * hv);
      const tx = def.x + cx,
        tz = def.z + cz;
      void l;
      // stand so the strike point (character space x left, z forward) lands on it
      const face = atan2(tx - att.x, tz - att.z);
      const [ox, oz] = sceneToWorld(0, 0, face, ex.off[0], ex.off[1]);
      const spot: [number, number] = [tx - ox, tz - oz];
      const walkD = hypot(spot[0] - att.x, spot[1] - att.z);
      const walkT = Math.max(0.35, walkD / 2.4);
      const start = Math.max(fallDur, 0.3 + walkT);
      const from = Math.max(0, ex.t - 0.9);
      const run: FinRun = {
        def: f, att: att.idx, vic: def.idx, t: 0, ox: tx, oz: tz, yaw: face, hA: HIPS_M[att.def.id] ?? 1, from, to: ex.t + 0.8, alignT: 0,
        a0: [att.x, att.z], v0: [def.x, def.z], hitsLeft: [], killAt: start + (ex.t - from), killed: false,
        fallDur, walk: { from: [att.x, att.z], to: spot, t0: 0.3, t1: 0.3 + walkT, face }, exec: { ...ex, start, from }, end: start + (ex.t - from) + 0.8,
      };
      this.fin = run;
      this.setState(att, 'scene', run.end);
      att.clip = '';
    }
    this.finishers++;
    this.emit('finisher_start', att.idx, def.idx, { id: f.id, name: f.name, kind: f.kind, fx, x: +this.fin!.ox.toFixed(2), z: +this.fin!.oz.toFixed(2), yaw: +this.fin!.yaw.toFixed(3) });
  }

  private tickFinisher(dt: number) {
    const F = this.fin!;
    if (F.def.kind === 'launch') return;
    F.t += dt;
    const att = this.f[F.att],
      def = this.f[F.vic];
    for (const x of [att, def]) x.stateT += dt;
    if (F.def.kind === 'pair') {
      const S = sceneOf(F.def)!;
      const k = Math.min(1, F.t / F.alignT);
      const ct = F.from + Math.max(0, F.t - F.alignT);
      for (const [x, curve, p0] of [
        [att, S.attRoot, F.a0],
        [def, S.vicRoot, F.v0],
      ] as [FighterState, number[], [number, number]][]) {
        const p = sceneRoot(curve, ct);
        const [wx, wz] = sceneToWorld(F.ox, F.oz, F.yaw, p[0] * F.hA, p[1] * F.hA);
        // alignment window: slide from where they stood onto the scene's start marks
        x.x = k < 1 ? p0[0] + (wx - p0[0]) * k : wx;
        x.z = k < 1 ? p0[1] + (wz - p0[1]) * k : wz;
        x.clipT0 = ct;
        x.clipRate = 0;
        x.stateT = 0;
      }
      for (const h of F.hitsLeft.slice()) if (ct >= h) {
        F.hitsLeft.shift();
        this.emit('finisher_contact', att.idx, def.idx, { id: F.def.id, kind: 'hit', t: +h.toFixed(2) });
      }
      if (!F.killed && ct >= F.killAt) this.finisherKill(F, att, def);
      if (F.t >= F.end) this.endFinisher(F, att);
      return;
    }
    // downed execution
    const ex = F.exec!;
    // victim: fall (or reel, for spells), clip time keeps running, the render holds the last frame
    def.clipT0 = 0;
    def.clipRate = F.def.kind === 'spell' ? 0.45 : 1.25;
    def.stateT = F.t;
    const w = F.walk!;
    if (F.t < w.t0) {
      att.clip = '';
      att.mx = att.mz = 0;
    } else if (F.t < w.t1) {
      const k = (F.t - w.t0) / (w.t1 - w.t0);
      const nxp = w.from[0] + (w.to[0] - w.from[0]) * k,
        nzp = w.from[1] + (w.to[1] - w.from[1]) * k;
      att.mx = (nxp - att.x) / Math.max(1e-3, dt);
      att.mz = (nzp - att.z) / Math.max(1e-3, dt);
      att.x = nxp;
      att.z = nzp;
      att.facing = atan2(F.ox - att.x, F.oz - att.z);
      att.clip = '';
    } else {
      att.mx = att.mz = 0;
      att.x = w.to[0];
      att.z = w.to[1];
      att.facing = w.face;
      if (F.t >= ex.start) {
        att.clip = ex.clip;
        att.clipT0 = ex.from + (F.t - ex.start);
        att.clipRate = 0;
        att.stateT = 0;
      } else att.clip = '';
    }
    if (!F.killed && F.t >= F.killAt) this.finisherKill(F, att, def);
    if (F.t >= F.end) this.endFinisher(F, att);
  }

  private finisherKill(F: FinRun, att: FighterState, def: FighterState) {
    F.killed = true;
    this.emit('finisher_contact', att.idx, def.idx, { id: F.def.id, kind: 'kill', fx: fxOf(F.def, att.def.id) });
    def.react = { x: att.x, z: att.z, sev: 3, height: 'body' };
    const keep = { clip: att.clip, t0: att.clipT0, rate: att.clipRate, st: att.stateT };
    const vKeep = { clip: def.clip, t0: def.clipT0, rate: def.clipRate, st: def.stateT };
    this.applyDamage(def, 1e6, att, F.def.id, true);
    // the scene keeps both roles going (applyDamage idles the killer and kills the victim)
    att.state = 'scene';
    att.clip = keep.clip;
    att.clipT0 = keep.t0;
    att.clipRate = keep.rate;
    att.stateT = keep.st;
    def.clip = vKeep.clip;
    def.clipT0 = vKeep.t0;
    def.clipRate = vKeep.rate;
    def.stateT = vKeep.st;
  }

  private endFinisher(F: FinRun, att: FighterState) {
    this.emit('finisher_end', att.idx, F.vic, { id: F.def.id });
    this.fin = null;
    att.clip = '';
    this.setState(att, 'idle');
  }

  /** did the blow land high (head) or on the body: strike point height at the contact frame */
  private hitHeight(att: FighterState, def: FighterState, m: MoveDef): 'head' | 'body' {
    if (m.ranged) return 'body';
    const r = moveReach(att.def.id, m);
    if (!r) return 'body';
    const pts = strikePoints(r, r.s);
    const y = Math.max(...pts.map((p) => p[1])) + att.y;
    const h = def.def.id === 'maw' ? 2.35 : 2.05;
    return y > h * 0.7 ? 'head' : 'body';
  }

  /** lethal=false (chip, hazards, props): can't kill - deaths always come from a visible blow. */
  applyDamage(def: FighterState, amount: number, src: FighterState, source: string, lethal = true) {
    if (def.state === 'dead' || this.over) return;
    amount *= this.drama.incomingMul(def);
    def.hp -= amount;
    if (!lethal && def.hp < 1) def.hp = Math.min(1, def.hp + amount);
    src.dmgDealt += amount;
    // rage buildup -> temporary damage buff
    def.rageMeter += (amount / def.maxHp) * def.def.personality.rage * 2.6;
    if (def.rageMeter >= 1 && def.hp > 0) {
      def.rageMeter = 0;
      def.buffT = Math.max(def.buffT, 5);
      def.buffMul = Math.max(def.buffMul, 1.2);
      this.emit('rage', def.idx);
    }
    this.drama.onDamage(def, amount);
    if (def.hp <= 0) {
      def.hp = 0;
      this.setState(def, 'dead');
      def.kx *= 1.5;
      def.kz *= 1.5;
      this.over = true;
      this.winner = src.idx;
      this.killMove = source;
      this.endT = this.t + POST_KILL;
      this.emit('kill', src.idx, def.idx, { move: source, clip: def.clip });
      if (src.state !== 'attack' && src.state !== 'dead') this.setState(src, 'idle');
    }
  }

  private snapshot(): Frame {
    const ff = (f: FighterState): FighterFrame => {
      const ph = this.attackPhase(f);
      let phaseT = 0;
      if (f.move && ph >= 0) {
        const m = f.move;
        phaseT = ph === 0 ? f.stateT / m.windup : ph === 1 ? (f.stateT - m.windup) / m.active : (f.stateT - m.windup - m.active) / m.recovery;
      } else if (f.stateDur > 0) phaseT = f.stateT / f.stateDur;
      return {
        x: f.x, z: f.z, facing: f.facing, vx: f.mx, vz: f.mz, y: f.y,
        state: f.state, stateT: f.stateT, moveId: f.move?.id ?? '', phase: ph, phaseT: clamp(phaseT, 0, 1),
        hp: f.hp, stamina: f.stamina, fury: f.fury, blocking: f.state === 'block',
        buff: f.buffT > 0 ? f.buffT : 0, lastStand: f.lastStand, attackId: f.attackId, strafe: f.strafe, goal: f.ai.goal,
        carry: f.carry, aimOn: f.aimOn,
        clip: f.clip, clipT: f.clip ? f.clipT0 + f.stateT * f.clipRate : 0,
      };
    };
    return {
      t: this.t,
      f: [ff(this.f[0]), ff(this.f[1])],
      ringS: this.ringS,
      tension: this.drama.tension,
      momentum: this.drama.momentum,
      ...this.world.snapshot(),
      proj: this.projectiles.map((p) => ({ x: p.x, y: p.y, z: p.z, fx: p.move.fx ?? '', o: p.owner, id: p.id })),
    };
  }

  run(): MatchRecord {
    const hardCap = ARENA.timeLimit + 10;
    while (this.t < hardCap) {
      this.step();
      if (this.over && this.t >= this.endT) break;
    }
    this.emit('match_end', this.winner);
    return {
      seed: this.seed,
      arena: { theme: this.arena.theme, layout: this.arena.layout, seed: this.arena.seed },
      ids: [this.f[0].def.id, this.f[1].def.id],
      dt: DT,
      frames: this.frames,
      events: this.events,
      result: this.drama.result(),
    };
  }
}

export function simulate(idA: string, idB: string, seed: number, record = true, arena?: ArenaSpec): MatchRecord {
  return new Match(idA, idB, seed, { record, arena }).run();
}
