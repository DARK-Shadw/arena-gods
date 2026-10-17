/**
 * FX director: turns the sim event stream (and observations of recorded
 * frames) into effects, on the FX clock, with seeded randomness.
 *
 *   game:  fx.setMatch(rec, seed, world)                 new match
 *          fx.frame({ events, frame, simT, simDt })     once per fight tick, before handleEvents
 *          fx.update(fxDt, realDt)                      once per rendered tick
 *          fx.seek(simT)                                on ?t= / debugSeekFight: full replay (below)
 *   lab:   createFxDirector({ scene }).spawn(id, pos, { seed, t }); fx.setTime(t) / fx.step(dt)
 *
 * What fires is data (fxDefs.ts); this file only resolves anchors, colours and
 * seeds and calls the primitives. Seeds: hash(match seed, key, effect id, layer)
 * with key = the event's index in rec.events (stable: the record is
 * deterministic), (fighter, attack id) for phase observations, (emitter,
 * fighter, tick) for continuous emitters, (fighter, stride) for footsteps and
 * (projectile id, tick) for trails. Nothing here reads the wall clock or an
 * unseeded random source, and nothing writes sim data.
 *
 * F3:
 *  - spawn times are the exact sim times of what caused them (event time, tick time, stride time),
 *    mapped onto the FX clock, so the result does not depend on the frame rate or on how a
 *    play-through was stepped;
 *  - anchors come from the animated bones in live play, and from recorded frame data when there are
 *    no bones (Node tests) or during a seek replay; persistent things (decals, wounds, weapon blood,
 *    footsteps) always use recorded frame data, so a seek rebuilds them exactly;
 *  - seek(t) is a full replay: persistent state from every event in [0, t - REPLAY_TAIL), then every
 *    effect, continuous emitter and footstep of the last REPLAY_TAIL seconds on recorded frames, so
 *    long tails (smoke, debris, embers, pools) are alive at t as in a play-through. Bounded cost:
 *    one pass over the events + REPLAY_TAIL / rec.dt director steps (fx:check measures it).
 */
import * as THREE from 'three';
import type { FighterFrame, Frame, MatchRecord, MoveDef, SimEvent } from '../../sim/types';
import { VFX } from './legacyVfx';
import { FxRng, hashN, hashStr } from './fxRng';
import { fxSettings, goreLevel, type GoreLevel } from './fxSettings';
import { CONTINUOUS, DEFS, ON_ACTIVE, PROJ_TRAIL_RATE, RESOLVE, RING_FIRE_RATE, RING_HEAT_RATE, defDuration, projEnd, projTrail, type Anchor, type FxDef, type FxLayer, type FxOp, type ResolveCtx, type SpDir } from './fxDefs';
import { fxProfiler } from './profiler';
import { SPRITES, DECAL_CELLS, type DecalCell } from './atlas';
import { SP_ADD, SP_FLOOR, SP_LOOP, SP_STREAK, newSpawn } from './sprites';
import { BODY, FLOOR_DUST, HEIGHT, weaponClassOf, type FloorSurface, type Surface, type WeaponClass } from './fxSurfaces';
import { FighterBlood } from './wounds';
import { CLAW_CORE, TRAIL_PROFILES } from './ribbons';

type V3 = { x: number; y: number; z: number };

/** What the director may read from the live game (all read-only). Everything is optional: without bones the anchors come from recorded frames. */
export interface FxWorld {
  chest?(i: number): V3;
  head?(i: number): V3;
  cast?(i: number): V3;
  /** fighter root position (feet anchors use its x/z on the floor) */
  feet?(i: number): V3;
  accent(i: number): string;
  move(i: number, id: string): MoveDef | undefined;
  obstacle(i: number): { x: number; z: number } | undefined;
  hazard(i: number): { x: number; z: number; kind: string } | undefined;
  /** ring of fire half-axes at full size */
  ring(): { rx: number; rz: number };
  isFinisher(move: string): boolean;
  // ---- F3 (optional)
  /** effector bone of a move ('RightHand', 'RightFoot', ...) and whether the model has a weapon tip */
  effector?(i: number, move: string): string | undefined;
  hasWeapon?(i: number): boolean;
  /** model height (m) */
  height?(i: number): number;
  /** floor surface at a point (theme floor, water hazards) */
  floorAt?(x: number, z: number): FloorSurface;
  /** this frame's weapon-trail base / tip (world) and whether the attack's trail window is on */
  trail?(i: number, base: THREE.Vector3, tip: THREE.Vector3): boolean;
  /** this frame's blade base / tip (world) for weapon blood; false = no blade */
  blade?(i: number, base: THREE.Vector3, tip: THREE.Vector3): boolean;
  /** a bone of fighter i by Mixamo name without the prefix ('Spine2') */
  bone?(i: number, name: string): THREE.Object3D | undefined;
  /** fighter i's model (afterimage source) and its materials + world metres per model unit (wounds) */
  fighter?(i: number): { model: THREE.Object3D; materials: THREE.Material[]; objScale: number } | undefined;
}

/** Per-spawn context: who and where. Everything optional for lab spawns. */
export interface SpawnCtx {
  a?: number;
  b?: number;
  data?: Record<string, unknown>;
  /** explicit position: the 'origin' anchor, and every anchor when there is no world */
  pos?: V3;
  /** actor accent colour when there is no world (lab) */
  accent?: string;
  /** ring scale (frame.ringS) for 'ringEdge' */
  ringS?: number;
  /** actor facing (rad) when there is no frame (lab) */
  facing?: number;
  /** sim time of the cause (event, tick, stride): frame-data anchors and decal times */
  t?: number;
  /** lab: direction of the blow (x, z) when there are no frames */
  dir?: { x: number; z: number };
}

export interface FxFrameInput {
  events: SimEvent[];
  frame: Frame;
  simT: number;
  simDt: number;
}

/** Post kicks requested by defs since the last takePost() (main.ts maxes them into the post state). */
export interface FxPostKicks {
  aberration: number;
  flash: number;
  vignette: number;
  /** grade preset kicks (post.ts GRADE_PRESETS): strongest weight per id this frame */
  grades: { id: string; weight: number; dur: number }[];
}

export interface FxStats {
  t: number;
  particles: { add: number; alpha: number; addCap: number; alphaCap: number };
  /** F3: live sprites per layer ('mask' = fx_sprites, else the flipbook atlas id) */
  sprites: Record<string, number>;
  /** live distortion sprites (F1) */
  dist: number;
  rings: number;
  arrows: number;
  debris: number;
  decals: number;
  ribbons: number;
  ghosts: number;
  wounds: [number, number];
  lights: number;
  effects: number;
  pending: number;
  spawns: number;
  light: number;
  quality: number;
  gore: GoreLevel;
  cpu: { frameMs: number; updateMs: number; frameMax: number; updateMax: number };
  /** last seek: replayed events / director steps and its CPU ms (0 without a profiler clock) */
  seek: { events: number; steps: number; ms: number };
}

interface Pending {
  at: number;
  def: FxDef;
  layer: number;
  seed: number;
  ctx: SpawnCtx;
}

/** seconds of full replay before the warm-up start on seek (the longest effect tail: debris 6 s) */
export const REPLAY_TAIL = 6;
/** footstep stride (m) and the speed above which strides leave dust (catalog C01) */
const STRIDE = 1.15;
const STEP_SPEED = 2.5;
const WOUND_BONES = ['Spine2', 'Spine1', 'Spine', 'Spine2', 'Neck', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'Hips', 'LeftUpLeg', 'RightUpLeg'];

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _d = new THREE.Vector3();
const _u = new THREE.Vector3();
const _side = new THREE.Vector3();
const _b0 = new THREE.Vector3();
const _b1 = new THREE.Vector3();
const _c = new THREE.Color();
const _rng = new FxRng(1);
const SP = newSpawn();
/** scratch fighter state from recorded frames */
const _ff = { x: 0, y: 0, z: 0, facing: 0, hp: 0 };

export class FxDirector {
  readonly vfx: VFX;
  private world?: FxWorld;
  private rec?: MatchRecord;
  private evIndex = new Map<SimEvent, number>();
  private matchSeed = 1;
  private pending: Pending[] = [];
  private post: FxPostKicks = { aberration: 0, flash: 0, vignette: 0, grades: [] };
  private lastPhase = [-1, -1];
  private lastAttackId = [0, 0];
  private lastSimT = 0;
  /** FX clock minus sim time at the current frame (spawns are backdated by the sim lag of their cause) */
  private ownsVfx: boolean;
  /** the frame being processed (facing for streams); undefined outside frame() */
  private curFrame?: Frame;
  /** current sim time (frame()) */
  private simNow = 0;
  /** FX time of the current frame's sim time (inside frame()) */
  private fxNow = 0;
  private inFrame = false;
  /** seek replay in progress: anchors from recorded frames, no ribbons / ghosts */
  private replaying = false;
  /** replay pass 1: only persistent layers (decals, wounds, weapon blood) */
  private persistOnly = false;
  /** precomputed footsteps per fighter: [t, x, z, stride index] x n, and the next index */
  private steps: Float64Array[] = [new Float64Array(0), new Float64Array(0)];
  private stepIdx = [0, 0];
  /** pending ghost snapshots (FX time) */
  private ghostQ: { at: number; i: number; life: number; color: string; strength: number }[] = [];
  /** weapon-trail profile per fighter is set per attack id */
  private trailAttack = [-1, -1];
  readonly blood: [FighterBlood, FighterBlood] = [new FighterBlood(), new FighterBlood()];
  private seekStats = { events: 0, steps: 0, ms: 0 };
  gore: GoreLevel = goreLevel();
  /** FX Lab (no world): bone and blade lookups for the dummies' wounds and weapon blood */
  labBone?: (i: number, name: string) => THREE.Object3D | undefined;
  labBlade?: (i: number, base: THREE.Vector3, tip: THREE.Vector3) => boolean;

  constructor(vfx?: VFX) {
    this.ownsVfx = !vfx;
    this.vfx = vfx ?? new VFX();
    fxSettings.onChange(() => {
      const c = fxSettings.caps();
      for (const b of this.blood) b.setLimit(c.wounds);
    });
  }

  // ------------------------------------------------------------------ match lifecycle
  /** New match: index the events, attach the world, clear and reseed at FX time t. */
  setMatch(rec: MatchRecord, matchSeed: number, world: FxWorld, t = this.vfx.clock.t) {
    this.rec = rec;
    this.world = world;
    this.matchSeed = matchSeed >>> 0;
    this.evIndex.clear();
    rec.events.forEach((e, i) => this.evIndex.set(e, i));
    this.gore = goreLevel();
    for (let i = 0; i < 2; i++) {
      const F = world.fighter?.(i);
      this.blood[i] = new FighterBlood();
      this.blood[i].setLimit(fxSettings.caps().wounds);
      if (F) this.blood[i].attach(F.materials, F.objScale);
      this.vfx.ghosts.setSource(i, F?.model ?? null);
    }
    this.buildSteps();
    this.resetState(t, 0);
  }

  /** the materials and blood uniforms of fighter i (FX Lab dummies) */
  attachBlood(i: number, materials: THREE.Material[], objScale: number) {
    this.blood[i].attach(materials, objScale);
  }

  /**
   * Jump to sim time `simT` (debugSeekFight / ?t=; the game then warms up from here at fixed steps).
   * Full replay: persistent state (decals, wounds, weapon blood) from every event before
   * simT - REPLAY_TAIL, then the last REPLAY_TAIL seconds of effects on recorded frames.
   */
  seek(simT: number) {
    const c0 = fxProfiler.begin();
    this.resetState(simT, simT);
    const rec = this.rec;
    this.seekStats = { events: 0, steps: 0, ms: 0 };
    if (!rec) return;
    const tStart = Math.max(0, simT - REPLAY_TAIL);
    const C = this.vfx.clock;
    this.replaying = true;
    try {
      // 1. persistent state from [0, tStart]
      this.persistOnly = true;
      let ei = 0;
      const ev = rec.events;
      for (; ei < ev.length && ev[ei].t <= tStart; ei++) {
        const e = ev[ei];
        C.seek(e.t);
        this.simNow = e.t;
        this.onEvent(e, e.t);
        this.seekStats.events++;
      }
      this.persistOnly = false;
      // 2. effects whose lifetime reaches the warm-up start: replay (tStart, simT] on recorded frames
      const fr = rec.frames;
      let k = this.frameIndex(tStart);
      const pre = fr[Math.max(0, k - 1)];
      for (let i = 0; i < 2; i++) {
        this.lastPhase[i] = pre.f[i].state === 'attack' ? pre.f[i].phase : -1;
        this.lastAttackId[i] = pre.f[i].attackId;
      }
      this.lastSimT = tStart;
      for (let i = 0; i < 2; i++) this.stepIdx[i] = this.firstStep(i, tStart);
      while (k < fr.length && fr[k].t <= tStart) k++;
      const evs: SimEvent[] = [];
      for (; k < fr.length && fr[k].t <= simT; k++) {
        const ft = fr[k].t;
        evs.length = 0;
        while (ei < ev.length && ev[ei].t <= ft) evs.push(ev[ei++]);
        C.seek(ft);
        this.firePending();
        this.frame({ events: evs, frame: fr[k], simT: ft, simDt: rec.dt });
        this.seekStats.steps++;
        this.seekStats.events += evs.length;
      }
      evs.length = 0;
      while (ei < ev.length && ev[ei].t <= simT) evs.push(ev[ei++]);
      C.seek(simT);
      this.firePending();
      this.frame({ events: evs, frame: fr[Math.min(fr.length - 1, k)], simT, simDt: rec.dt });
      this.seekStats.events += evs.length;
    } finally {
      this.replaying = false;
      this.persistOnly = false;
    }
    C.seek(simT);
    this.lastSimT = simT;
    this.post.aberration = this.post.flash = this.post.vignette = 0;
    this.post.grades.length = 0;
    for (const r of this.vfx.ribbons) r.reset();
    this.ghostQ.length = 0;
    this.vfx.decalTime = simT;
    this.vfx.ribbonTime = simT;
    this.vfx.render();
    this.seekStats.ms = +(fxProfiler.now() - c0).toFixed(3);
  }

  /** t: FX time; simT: the sim time continuous emitters count ticks from */
  private resetState(t: number, simT = t) {
    this.vfx.reset(this.matchSeed, t);
    this.pending.length = 0;
    this.post.aberration = this.post.flash = this.post.vignette = 0;
    this.post.grades.length = 0;
    this.lastPhase = [-1, -1];
    this.lastAttackId = [0, 0];
    this.lastSimT = simT;
    this.simNow = simT;
    this.trailAttack = [-1, -1];
    this.ghostQ.length = 0;
    for (const b of this.blood) b.clear();
    for (let i = 0; i < 2; i++) this.stepIdx[i] = this.firstStep(i, simT);
    if (this.rec) {
      this.vfx.decalTime = simT;
      this.vfx.ribbonTime = simT;
    }
  }

  /** Standalone use: set the match seed, clear, FX time := t. */
  reset(matchSeed: number, t = 0) {
    this.matchSeed = matchSeed >>> 0;
    this.resetState(t);
  }

  /** Clear everything (keeps the clock and the match). */
  clear() {
    this.vfx.clear();
    this.pending.length = 0;
    this.ghostQ.length = 0;
    for (const b of this.blood) b.clear();
  }

  // ------------------------------------------------------------------ recorded frames
  /** index of the first recorded frame at or after sim time t (frames[k].t = (k + 1) * dt) */
  private frameIndex(t: number): number {
    const rec = this.rec!;
    return Math.max(0, Math.min(rec.frames.length - 1, Math.ceil(t / rec.dt - 1 - 1e-9)));
  }

  /** fighter i at sim time t from the recording (interpolated position / facing, nearest hp) into _ff */
  private fstate(i: number, t: number) {
    const rec = this.rec!;
    const fr = rec.frames;
    const x = t / rec.dt - 1;
    const a = Math.max(0, Math.min(fr.length - 1, Math.floor(x)));
    const b = Math.min(fr.length - 1, a + 1);
    const k = Math.max(0, Math.min(1, x - a));
    const A = fr[a].f[i],
      B = fr[b].f[i];
    _ff.x = A.x + (B.x - A.x) * k;
    _ff.z = A.z + (B.z - A.z) * k;
    _ff.y = A.y + (B.y - A.y) * k;
    let d = (B.facing - A.facing) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    _ff.facing = A.facing + d * k;
    _ff.hp = k < 0.5 ? A.hp : B.hp;
    return _ff;
  }

  /** the recorded fighter frame nearest to sim time t (state, move, attack phase) */
  private fframe(i: number, t: number): FighterFrame {
    const rec = this.rec!;
    const x = t / rec.dt - 1;
    const k = Math.max(0, Math.min(rec.frames.length - 1, Math.round(x)));
    return rec.frames[k].f[i];
  }

  private fighterId(i: number): string {
    return this.rec?.ids[i] ?? '';
  }

  private heightOf(i: number): number {
    return this.world?.height?.(i) ?? HEIGHT[this.fighterId(i)] ?? 1.9;
  }

  // ------------------------------------------------------------------ footsteps (C01 / C02)
  /** Stride ticks from the recorded motion: every STRIDE metres while moving faster than STEP_SPEED. */
  private buildSteps() {
    const rec = this.rec;
    if (!rec) return;
    for (let i = 0; i < 2; i++) {
      const out: number[] = [];
      let s = 0;
      let k = 0;
      let prev = rec.frames[0].f[i];
      for (let j = 1; j < rec.frames.length; j++) {
        const f = rec.frames[j].f[i];
        const sp = Math.hypot(f.vx, f.vz);
        const moving = (f.state === 'idle' || f.state === 'block' || f.state === 'attack') && sp > STEP_SPEED && f.y < 0.05;
        if (moving) {
          s += Math.hypot(f.x - prev.x, f.z - prev.z);
          if (s >= STRIDE) {
            s -= STRIDE;
            k++;
            const side = k % 2 ? 1 : -1;
            const c = Math.cos(f.facing),
              sn = Math.sin(f.facing);
            out.push(rec.frames[j].t, f.x + c * 0.13 * side, f.z - sn * 0.13 * side, k);
          }
        } else s = Math.min(s, STRIDE * 0.5);
        prev = f;
      }
      this.steps[i] = Float64Array.from(out);
    }
  }

  private firstStep(i: number, t: number): number {
    const S = this.steps[i];
    let n = 0;
    while (n * 4 < S.length && S[n * 4] <= t) n++;
    return n;
  }

  private emitSteps(t1: number) {
    const W = this.world;
    const on = fxSettings.caps().steps > 0;
    for (let i = 0; i < 2; i++) {
      const S = this.steps[i];
      while (this.stepIdx[i] * 4 < S.length && S[this.stepIdx[i] * 4] <= t1) {
        const o = this.stepIdx[i]++ * 4;
        if (!on || this.persistOnly) continue;
        const surf = W?.floorAt?.(S[o + 1], S[o + 2]) ?? 'stone';
        const id = surf === 'snow' ? 'step.snow' : surf === 'water' ? 'step.water' : surf === 'wet' ? 'step.wet' : 'step.dust';
        this.spawnKeyed(id, hashN(0x57e9, i, S[o + 3]), { a: i, pos: { x: S[o + 1], y: 0, z: S[o + 2] }, t: S[o] }, S[o]);
      }
    }
  }

  // ------------------------------------------------------------------ per frame
  /** Feed one fight tick: events, attack-phase observations, continuous emitters, footsteps, projectile trails, weapon trails. */
  frame(inp: FxFrameInput) {
    const t0 = fxProfiler.begin();
    const W = this.world;
    const fr = inp.frame;
    this.curFrame = fr;
    this.simNow = inp.simT;
    // the FX time that corresponds to this frame's sim time: the game advances the FX clock by about
    // simDt right after frame() (tickFight -> tick -> fx.update); a seek replay has already set it
    this.fxNow = this.vfx.clock.t + (this.replaying ? 0 : Math.max(0, inp.simDt));
    this.inFrame = true;
    for (const e of inp.events) this.onEvent(e, e.t);
    if (W) {
      for (let i = 0; i < 2; i++) {
        const f = fr.f[i];
        const mv = f.moveId ? W.move(i, f.moveId) : undefined;
        const newAttack = f.attackId !== this.lastAttackId[i];
        if (f.state === 'attack' && mv && f.phase === 1 && (f.phase !== this.lastPhase[i] || newAttack)) {
          const key = hashN(0xac, i, f.attackId);
          const ta = this.activeStart(i, f.attackId, inp.simT);
          for (const rule of ON_ACTIVE) for (const id of rule(mv)) if (id) this.spawnKeyed(id, key, { a: i, t: ta }, ta);
        }
        this.lastPhase[i] = f.state === 'attack' ? f.phase : -1;
        this.lastAttackId[i] = f.attackId;
      }
    }
    const t1 = inp.simT;
    if (t1 < this.lastSimT) this.lastSimT = t1; // playback moved back without a seek: re-sync, no ticks
    const tPrev = this.lastSimT;
    if (inp.simDt > 0 && t1 > tPrev) {
      if (W) {
        for (let i = 0; i < 2; i++) {
          for (const c of CONTINUOUS) this.ticksFor(c, i, tPrev, t1);
        }
      }
      this.ringTicks(tPrev, t1, fr);
      this.projTicks(tPrev, t1, fr);
      this.emitSteps(t1);
    }
    this.projEnds(tPrev, t1, fr);
    this.trails(fr, t1);
    this.lastSimT = Math.max(this.lastSimT, t1);
    if (this.rec) this.vfx.decalTime = t1;
    this.curFrame = undefined;
    this.inFrame = false;
    fxProfiler.end('frame', t0);
  }

  /** sim time the attack entered its active phase (exact from the recording; else now) */
  private activeStart(i: number, attackId: number, now: number): number {
    const rec = this.rec;
    if (!rec) return now;
    let k = this.frameIndex(now);
    const fr = rec.frames;
    while (k > 0 && fr[k - 1].f[i].attackId === attackId && fr[k - 1].f[i].state === 'attack' && fr[k - 1].f[i].phase === 1) k--;
    return Math.min(now, fr[k].t);
  }

  /** continuous emitter ticks in (t0, t1]: each tick checks the recorded state at its own time (step-independent) */
  private ticksFor(c: (typeof CONTINUOUS)[number], i: number, t0: number, t1: number) {
    const W = this.world!;
    const n0 = Math.floor(t0 * c.rate);
    let n1 = Math.floor(t1 * c.rate);
    if (n1 - n0 > 64) n1 = n0 + 64;
    const key = hashN(hashStr(c.key), i);
    for (let n = n0 + 1; n <= n1; n++) {
      const tt = n / c.rate;
      const f = this.rec ? this.fframe(i, tt) : this.curFrame!.f[i];
      const mv = f.moveId ? W.move(i, f.moveId) : undefined;
      const id = c.when(f, mv);
      if (id) this.spawnKeyed(id, hashN(key, n), { a: i, t: tt }, tt);
    }
  }

  private ringTicks(t0: number, t1: number, fr: Frame) {
    const one = (id: string, rate: number, key: number) => {
      const n0 = Math.floor(t0 * rate);
      let n1 = Math.floor(t1 * rate);
      if (n1 - n0 > 64) n1 = n0 + 64;
      for (let n = n0 + 1; n <= n1; n++) {
        const tt = n / rate;
        const rs = this.rec ? this.rec.frames[this.frameIndex(tt)].ringS : fr.ringS;
        if (rs < 0.995) this.spawnKeyed(id, hashN(key, n), { ringS: rs, t: tt }, tt);
      }
    };
    if (fr.ringS < 0.995 || (this.rec && this.rec.frames[this.frameIndex(t0)].ringS < 0.995)) {
      one('ring.fire', RING_FIRE_RATE, 0x7121);
      if (fxSettings.caps().dist >= 2) one('ring.heat', RING_HEAT_RATE, 0x7122);
    }
  }

  /** projectile trail ticks at their recorded positions (interpolated between recorded frames) */
  private projTicks(t0: number, t1: number, fr: Frame) {
    const rec = this.rec;
    const rate = PROJ_TRAIL_RATE;
    const n0 = Math.floor(t0 * rate);
    let n1 = Math.floor(t1 * rate);
    if (n1 - n0 > 64) n1 = n0 + 64;
    if (!rec) {
      for (const p of fr.proj) {
        const id = projTrail(p.fx);
        if (id) for (let n = n0 + 1; n <= n1; n++) this.spawnKeyed(id, hashN(hashN(0x9e, p.id), n), { pos: { x: p.x, y: p.y, z: p.z }, t: n / rate }, n / rate);
      }
      return;
    }
    for (let n = n0 + 1; n <= n1; n++) {
      const tt = n / rate;
      const x = tt / rec.dt - 1;
      const a = Math.max(0, Math.min(rec.frames.length - 1, Math.floor(x)));
      const b = Math.min(rec.frames.length - 1, a + 1);
      const k = Math.max(0, Math.min(1, x - a));
      const A = rec.frames[a],
        B = rec.frames[b];
      for (const p of A.proj) {
        const id = projTrail(p.fx);
        if (!id) continue;
        const q = B.proj.find((z) => z.id === p.id) ?? p;
        _p.set(p.x + (q.x - p.x) * k, p.y + (q.y - p.y) * k, p.z + (q.z - p.z) * k);
        this.spawnKeyed(id, hashN(hashN(0x9e, p.id), n), { pos: { x: _p.x, y: _p.y, z: _p.z }, t: tt }, tt);
      }
    }
  }

  /** projectiles that vanished in (t0, t1]: impact sparks at their last recorded position and time */
  private projEnds(t0: number, t1: number, fr: Frame) {
    const rec = this.rec;
    if (!rec) {
      void fr;
      return;
    }
    let k = this.frameIndex(t0);
    while (k < rec.frames.length && rec.frames[k].t <= t0) k++;
    for (; k < rec.frames.length && rec.frames[k].t <= t1; k++) {
      if (k === 0) continue;
      const A = rec.frames[k - 1],
        B = rec.frames[k];
      for (const p of A.proj) {
        if (B.proj.some((z) => z.id === p.id)) continue;
        this.spawnKeyed(projEnd(p.fx), hashN(0x9f, p.id), { pos: { x: p.x, y: p.y, z: p.z }, t: B.t }, B.t);
      }
    }
  }

  /** weapon trails: one sample per rendered frame on sim time; the profile is chosen per attack */
  private trails(fr: Frame, simT: number) {
    const W = this.world;
    if (!W?.trail || this.replaying) return;
    for (let i = 0; i < 2; i++) {
      const R = this.vfx.ribbons[i];
      const f = fr.f[i];
      const on = W.trail(i, _b0, _b1);
      if (on && f.attackId !== this.trailAttack[i]) {
        this.trailAttack[i] = f.attackId;
        const mv = f.moveId ? W.move(i, f.moveId) : undefined;
        const cls = this.classOf(i, f.moveId, mv?.fx ?? '');
        const heavy = !!mv && (mv.kind === 'heavy' || mv.kind === 'ultimate' || mv.damage >= 70);
        const prof = mv?.fx === 'shadow' && cls !== 'claw' ? TRAIL_PROFILES.shadow : TRAIL_PROFILES[cls];
        R.setProfile(prof, cls === 'claw' ? CLAW_CORE[this.fighterId(i)] : undefined, hashN(this.matchSeed, i, f.attackId), heavy, fxSettings.caps().dist);
      }
      R.push(simT, _b0, _b1, on);
    }
    this.vfx.ribbonTime = simT;
  }

  private classOf(i: number, move: string, fx: string): WeaponClass {
    const W = this.world;
    return weaponClassOf(this.fighterId(i), W?.effector?.(i, move), fx, W?.hasWeapon?.(i) ?? false);
  }

  private resolveCtx(): ResolveCtx {
    const W = this.world;
    return {
      isFinisher: W?.isFinisher,
      hazardKind: (i) => W?.hazard(i)?.kind,
      weaponClass: (i, move, fx) => this.classOf(i, move, fx),
      surface: (i): Surface => BODY[this.fighterId(i)] ?? 'flesh',
      hpFrac: (i, t) => {
        if (!this.rec) return 1;
        const f = this.fstate(i, t);
        const max = this.rec.frames[0].f[i].hp || 1;
        return f.hp / max;
      },
      fighterId: (i) => this.fighterId(i),
    };
  }

  private onEvent(e: SimEvent, t: number) {
    const R = RESOLVE[e.type];
    if (!R) return;
    const ids = R(e, this.resolveCtx());
    const key = this.evIndex.get(e) ?? hashN(0xe0, Math.round(e.t * 1000), hashStr(e.type));
    const ctx: SpawnCtx = { a: e.a, b: e.b, data: e.data as Record<string, unknown> | undefined, ringS: this.rec ? this.rec.frames[this.frameIndex(t)].ringS : 1, t };
    for (const id of ids) if (id) this.spawnKeyed(id, key, ctx, t);
  }

  /** spawn at the FX time that corresponds to sim time `simT` (backdated by how late it is processed) */
  private spawnKeyed(id: string, key: number, ctx: SpawnCtx, simT = this.simNow) {
    const t = (this.inFrame ? this.fxNow : this.vfx.clock.t) - Math.max(0, this.simNow - simT);
    this.spawnDef(id, hashN(this.matchSeed, key, hashStr(id)), t, ctx);
  }

  /** Advance FX time and evaluate every layer; fires delayed layers that came due. */
  update(dt: number, realDt = dt) {
    const t0 = fxProfiler.begin();
    this.vfx.clock.advance(dt, realDt);
    this.firePending();
    this.fireGhosts();
    this.vfx.render();
    this.updateBlood();
    fxProfiler.end('update', t0);
  }

  private updateBlood() {
    const W = this.world;
    const t = this.vfx.clock.t;
    for (let i = 0; i < 2; i++) {
      const B = this.blood[i];
      if (W?.blade ? W.blade(i, _b0, _b1) : this.labBlade?.(i, _b0, _b1)) {
        B.bladeBase = _b0;
        B.bladeTip = _b1;
        B.update(t);
        B.bladeBase = B.bladeTip = null;
      } else B.update(t);
    }
  }

  private firePending() {
    const t = this.vfx.clock.t;
    for (let i = 0; i < this.pending.length; ) {
      const p = this.pending[i];
      if (p.at <= t) {
        this.pending.splice(i, 1);
        this.runLayer(p.def, p.def.layers[p.layer], p.ctx, _rng.reseed(hashN(p.seed, p.layer)), p.at);
      } else i++;
    }
  }

  private fireGhosts() {
    const t = this.vfx.clock.t;
    for (let i = 0; i < this.ghostQ.length; ) {
      const g = this.ghostQ[i];
      if (g.at <= t) {
        this.ghostQ.splice(i, 1);
        this.vfx.ghosts.snap(g.i, g.at, g.life, g.color, g.strength);
      } else i++;
    }
  }

  /** Post kicks requested since the last call (the game maxes them into its aberration / flash / vignette). */
  takePost(): FxPostKicks {
    const P = this.post;
    const out: FxPostKicks = { aberration: P.aberration, flash: P.flash, vignette: P.vignette, grades: P.grades.slice() };
    P.aberration = P.flash = P.vignette = 0;
    P.grades.length = 0;
    return out;
  }

  // ------------------------------------------------------------------ spawning
  /**
   * Spawn a def by id. t0 = spawn time on the FX clock (may be in the past: the
   * effect appears mid-life, exactly as it would have in continuous play).
   * Returns false when the id is unknown or the gore level removes it.
   */
  spawnDef(id: string, seed: number, t0: number, ctx: SpawnCtx): boolean {
    let def = DEFS[id];
    if (!def) return false;
    if (def.gore && this.gore in def.gore) {
      const sub = def.gore[this.gore];
      if (!sub) return false;
      def = DEFS[sub] ?? def;
    }
    if (this.persistOnly) {
      // seek pass 1: only what persists (decals, wounds, weapon blood), at its own time, no post kicks
      def.layers.forEach((L, i) => {
        const k = L.op.k;
        if (k === 'decal' || k === 'wound' || k === 'bladeBlood' || k === 'blood') this.runLayer(def!, L, ctx, _rng.reseed(hashN(seed, i)), t0 + (L.delay ?? 0));
      });
      return true;
    }
    const pk = def.post;
    if (pk && !this.replaying) {
      const P = this.post;
      if (pk.aberration) P.aberration = Math.max(P.aberration, pk.aberration);
      if (pk.flash) P.flash = Math.max(P.flash, pk.flash);
      if (pk.vignette) P.vignette = Math.max(P.vignette, pk.vignette);
      if (pk.grade) {
        const w = pk.gradeWeight ?? 1;
        const g = P.grades.find((x) => x.id === pk.grade);
        if (g) (g.weight = Math.max(g.weight, w)), (g.dur = Math.max(g.dur, pk.gradeDur ?? 0.6));
        else if (P.grades.length < 8) P.grades.push({ id: pk.grade, weight: w, dur: pk.gradeDur ?? 0.6 });
      }
    }
    const now = this.vfx.clock.t;
    def.layers.forEach((L, i) => {
      const at = t0 + (L.delay ?? 0);
      if (at > now) this.pending.push({ at, def: def!, layer: i, seed, ctx: { ...ctx, pos: ctx.pos ? { x: ctx.pos.x, y: ctx.pos.y, z: ctx.pos.z } : undefined } });
      else this.runLayer(def!, L, ctx, _rng.reseed(hashN(seed, i)), at);
    });
    this.vfx.track(def.id, t0, seed, defDuration(def));
    return true;
  }

  /**
   * Public spawn (FX Lab, tests, game code that has a position but no event).
   * Without a world every anchor resolves to `pos` (feet anchors on the floor).
   */
  spawn(id: string, pos: V3, o: { seed?: number; t?: number; a?: number; b?: number; accent?: string; facing?: number; data?: Record<string, unknown>; dir?: { x: number; z: number } } = {}): boolean {
    const seed = o.seed ?? hashN(this.matchSeed, hashStr(id), Math.round(this.vfx.clock.t * 1000));
    return this.spawnDef(id, seed >>> 0, o.t ?? this.vfx.clock.t, { pos, a: o.a, b: o.b, accent: o.accent, facing: o.facing, data: o.data, ringS: 1, dir: o.dir });
  }

  /** bones available (live play) or recorded-frame anchors (Node, seek replay) */
  private get boneAnchors(): boolean {
    return !this.replaying && !!this.world?.chest;
  }

  /** frame-data anchor of fighter i at sim time t */
  private fAnchor(kind: 'chest' | 'head' | 'cast' | 'feet', i: number, t: number, out: THREE.Vector3): THREE.Vector3 {
    const f = this.fstate(i, t);
    const h = this.heightOf(i);
    if (kind === 'feet') return out.set(f.x, 0, f.z);
    if (kind === 'head') return out.set(f.x, f.y + h * 0.93, f.z);
    if (kind === 'cast') return out.set(f.x + Math.sin(f.facing) * 0.45, f.y + h * 0.75, f.z + Math.cos(f.facing) * 0.45);
    return out.set(f.x, f.y + h * 0.7, f.z);
  }

  private anchor(at: Anchor, ctx: SpawnCtx, r: FxRng, out: THREE.Vector3, forceFrames = false): THREE.Vector3 {
    const W = this.world;
    const a = ctx.a ?? -1,
      b = ctx.b ?? -1;
    const P = ctx.pos;
    const d = ctx.data;
    if (at === 'origin' || !W) {
      if (at === 'ringEdge') {
        const ang = r.next() * Math.PI * 2;
        const c = P ?? { x: 0, y: 0, z: 0 };
        return out.set(c.x + Math.cos(ang) * 3, 0, c.z + Math.sin(ang) * 3);
      }
      if (P) out.set(P.x, P.y, P.z);
      else out.set(0, 1, 0);
      if (at === 'aFeet' || at === 'bFeet') out.y = 0;
      return out;
    }
    const bones = this.boneAnchors && !forceFrames;
    const fr = !bones && !!this.rec;
    const t = ctx.t ?? this.simNow;
    const get = (kind: 'chest' | 'head' | 'cast' | 'feet', i: number, o: THREE.Vector3): THREE.Vector3 | null => {
      if (fr) return this.fAnchor(kind, i, t, o);
      const fn = kind === 'chest' ? W.chest : kind === 'head' ? W.head : kind === 'cast' ? W.cast : W.feet;
      const v = fn?.call(W, i);
      return v ? o.set(v.x, v.y, v.z) : null;
    };
    switch (at) {
      // F3: contacts sit on the body surface facing the other fighter (a fixed distance from the chest),
      // not a fraction of the gap: with long weapons the fighters stand 2-3 m apart
      case 'contact':
        if (a < 0 || b < 0) break;
        if (get('chest', b, out) && get('chest', a, _q)) return this.towards(out, _q, 0.24);
        break;
      case 'blockContact':
      case 'parryContact':
        if (a < 0 || b < 0) break;
        if (get('chest', a, out) && get('chest', b, _q)) return this.towards(out, _q, at === 'blockContact' ? 0.42 : 0.5);
        break;
      case 'aChest':
        if (a >= 0 && get('chest', a, out)) return out;
        break;
      case 'bChest':
        if (b >= 0 && get('chest', b, out)) return out;
        break;
      case 'aHead':
        if (a >= 0 && get('head', a, out)) return out;
        break;
      case 'aCast':
        if (a >= 0 && get('cast', a, out)) return out;
        break;
      case 'aFeet':
        if (P && ctx.t !== undefined && !d) return out.set(P.x, 0, P.z); // footsteps carry their exact position
        if (a >= 0 && get('feet', a, out)) return out.setY(0);
        break;
      case 'bFeet':
        if (b >= 0 && get('feet', b, out)) return out.setY(0);
        break;
      case 'event':
        if (d && d.x !== undefined) return out.set(Number(d.x ?? 0), Number(d.y ?? 0), Number(d.z ?? 0));
        break;
      case 'obstacle': {
        const o = W.obstacle(Number(d?.obs));
        if (o) return out.set(o.x, 0, o.z);
        break;
      }
      case 'hazard': {
        const h = W.hazard(Number(d?.haz));
        if (h) return out.set(h.x, 0, h.z);
        break;
      }
      case 'ringEdge': {
        const R = W.ring();
        const s = ctx.ringS ?? 1;
        const ang = r.next() * Math.PI * 2;
        return out.set(Math.cos(ang) * (R.rx * s + 0.4), 0, Math.sin(ang) * (R.rz * s + 0.4));
      }
    }
    if (P) return out.set(P.x, P.y, P.z);
    return out.set(0, 1, 0);
  }

  /** move `p` towards `q` on the floor plane by d metres (at most half the gap) */
  private towards(p: THREE.Vector3, q: THREE.Vector3, d: number): THREE.Vector3 {
    const dx = q.x - p.x,
      dz = q.z - p.z;
    const l = Math.hypot(dx, dz);
    if (l < 1e-6) return p;
    const k = Math.min(d, l * 0.5) / l;
    p.x += dx * k;
    p.z += dz * k;
    return p;
  }

  /** direction of the blow on the floor plane (a -> b) from recorded frames; lab: ctx.dir or +x */
  private hitDir(ctx: SpawnCtx, out: THREE.Vector3): THREE.Vector3 {
    const a = ctx.a ?? -1,
      b = ctx.b ?? -1;
    if (this.rec && a >= 0 && b >= 0) {
      const t = ctx.t ?? this.simNow;
      const A = this.fstate(a, t);
      const ax = A.x,
        az = A.z;
      const B = this.fstate(b, t);
      out.set(B.x - ax, 0, B.z - az);
      if (out.lengthSq() > 1e-8) return out.normalize();
    }
    if (this.rec && a >= 0) {
      const A = this.fstate(a, ctx.t ?? this.simNow);
      return out.set(Math.sin(A.facing), 0, Math.cos(A.facing));
    }
    if (ctx.dir) return out.set(ctx.dir.x, 0, ctx.dir.z).normalize();
    return out.set(1, 0, 0);
  }

  private color(c: string | undefined, ctx: SpawnCtx, fallback: string, at?: V3): string {
    if (!c) return fallback;
    if (c[0] !== '$') return c;
    if (c === '$floor') {
      const s = at && this.world?.floorAt ? this.world.floorAt(at.x, at.z) : undefined;
      return s ? FLOOR_DUST[s] : '#9a8a74';
    }
    const i = c === '$accentB' ? ctx.b : ctx.a;
    if (this.world && i !== undefined && i >= 0) return this.world.accent(i);
    return ctx.accent ?? '#ffb060';
  }

  private runLayer(def: FxDef, L: FxLayer, ctx: SpawnCtx, r: FxRng, t: number) {
    const V = this.vfx;
    const op = L.op;
    // persistent ops place themselves from recorded frames (seek-exact); the rest use the live anchors
    const persistent = op.k === 'decal' || op.k === 'wound' || op.k === 'bladeBlood';
    const p = this.anchor(L.at ?? def.at, ctx, r, _p, persistent);
    const y = L.y ?? (L.at ? undefined : def.y);
    if (y !== undefined) p.y = y;
    if (L.minY !== undefined) p.y = Math.max(L.minY, p.y);
    const s = fxSettings.caps().countScale;
    const N = (n: number) => (s === 1 ? n : Math.max(1, Math.round(n * s)));
    V.softOverride = L.soft ?? def.soft;
    V.hdrOverride = 'hdr' in op ? op.hdr : undefined;
    try {
      this.runOp(op, ctx, r, t, p, N, L, def);
    } finally {
      V.softOverride = undefined;
      V.hdrOverride = undefined;
    }
  }

  private runOp(op: FxOp, ctx: SpawnCtx, r: FxRng, t: number, p: THREE.Vector3, N: (n: number) => number, L: FxLayer, def: FxDef) {
    const V = this.vfx;
    switch (op.k) {
      case 'sparks':
        V.sparksAt(r, t, p, N(op.n), this.color(op.color, ctx, '#ffc070'), op.speed ?? 7);
        break;
      case 'flash':
        V.flashAt(r, t, p, this.color(op.color, ctx, '#fff0d0'), op.size ?? 1.2, op.light ?? 6);
        break;
      case 'dust':
        V.dustAt(r, t, p, N(op.n), op.spread ?? 1, this.color(op.color, ctx, '#9a8064', p));
        break;
      case 'smoke':
        V.smokeAt(r, t, p, N(op.n), this.color(op.color, ctx, '#2a2230'), op.size ?? 1.2, op.rise ?? 0.8);
        break;
      case 'embers':
        V.embersAt(r, t, p, N(op.n), this.color(op.color, ctx, '#ff8a30'), op.area ?? 1);
        break;
      case 'shock':
        V.shockwaveAt(t, p, this.color(op.color, ctx, '#ffd8a0'), op.size ?? 4, op.life ?? 0.5);
        break;
      case 'debris':
        V.debrisAt(r, t, p, this.color(op.color, ctx, '#6b4a2c'), N(op.n));
        break;
      case 'fire': {
        if (op.facing !== undefined) {
          const a = ctx.a ?? -1;
          const f = this.curFrame && a >= 0 ? this.curFrame.f[a].facing : (ctx.facing ?? 0);
          _vel.set(Math.sin(f), -0.05, Math.cos(f)).multiplyScalar(op.facing);
        } else if (op.vel) _vel.set(op.vel[0], op.vel[1], op.vel[2]);
        else _vel.set(0, 0, 0);
        V.fireAt(r, t, p, _vel, N(op.n), op.size ?? 0.35, op.spread ?? 0.6);
        break;
      }
      case 'fireBurst': {
        const n = N(op.n);
        for (let k = 0; k < n; k++) {
          if (op.shape === 'sphere') {
            const [lo, hi] = op.speed ?? [6, 12];
            _vel.set(r.next() - 0.5, r.next() * 0.9 + 0.2, r.next() - 0.5).normalize().multiplyScalar(lo + r.next() * (hi - lo));
          } else if (op.shape === 'ring') {
            const ang = (k / n) * Math.PI * 2;
            const [sp, vy] = op.speed ?? [8, 1];
            _vel.set(Math.cos(ang) * sp, vy, Math.sin(ang) * sp);
          } else {
            const B = op.box ?? [3, 3, 3];
            _vel.set((r.next() - 0.5) * B[0], B[1] + r.next() * B[1], (r.next() - 0.5) * B[2]);
          }
          V.fireAt(r, t, p, _vel, 1, op.size, op.spread);
        }
        break;
      }
      case 'heat':
        V.heatAt(r, t, p, op.size, op.height, op.life, op.strength ?? 1, op.rise ?? 1.5, op.tier ?? 2);
        break;
      case 'ripple':
        V.rippleAt(r, t, p, op.size, op.life, op.strength ?? 1, op.tier ?? 1);
        break;
      // ---------------- F3
      case 'sp':
        this.emitSprites(op, ctx, r, t, p, L, def);
        break;
      case 'blood':
        this.emitBlood(op, ctx, r, t, p, L.delay ?? 0);
        break;
      case 'decal':
        this.emitDecals(op, ctx, r, t, L);
        break;
      case 'wound': {
        const b = ctx.b ?? -1;
        const bone = WOUND_BONES[Math.floor(r.next() * WOUND_BONES.length)];
        const off = { x: r.range(-0.07, 0.07), y: r.range(-0.08, 0.08), z: r.range(-0.07, 0.07) };
        const rad = r.range(op.r[0], op.r[1]);
        if (b >= 0) this.blood[b].add(this.world?.bone?.(b, bone) ?? this.labBone?.(b, bone) ?? null, off, rad, t, op.amt ?? 1);
        else if (ctx.b === undefined && !this.rec) this.blood[1].add(this.labBone?.(1, bone) ?? null, off, rad, t, op.amt ?? 1); // lab: the right dummy
        break;
      }
      case 'bladeBlood': {
        const a = ctx.a ?? (this.rec ? -1 : 0);
        if (a >= 0) this.blood[a].addBlade(t, op.amt);
        break;
      }
      case 'light':
        if (!this.persistOnly) V.lightAt(t, this.color(op.color, ctx, '#ffd0a0'), op.i, op.dur, p, op.radius ?? 8);
        break;
      case 'chips': {
        const n = Math.max(1, Math.round(N(op.n) * fxSettings.caps().spriteScale));
        V.debrisAt(r, t, p, this.color(op.color, ctx, '#7a7068', p), n, op.scale ?? 0.3, op.speed ?? 0.6, false);
        break;
      }
      case 'ghost': {
        const a = ctx.a ?? -1;
        if (this.replaying || a < 0 || fxSettings.caps().ghosts <= 0) break;
        const color = this.color(op.color, ctx, '#9fc0ff');
        for (let k = 0; k < Math.min(op.n, fxSettings.caps().ghosts); k++) this.ghostQ.push({ at: t + k * op.gap, i: a, life: op.life, color, strength: op.strength ?? 1 });
        break;
      }
    }
  }

  /** direction vector for 'sp' / 'blood' (consumes one rng draw for the side sign) */
  private spDir(dir: SpDir | undefined, ctx: SpawnCtx, r: FxRng, out: THREE.Vector3): THREE.Vector3 {
    const side = r.next() < 0.5 ? -1 : 1;
    if (!dir || dir === 'none') return out.set(0, 0, 0);
    if (dir === 'up') return out.set(0, 1, 0);
    if (dir === 'down') return out.set(0, -1, 0);
    if (dir === 'facing') {
      const a = ctx.a ?? -1;
      const f = this.rec && a >= 0 ? this.fstate(a, ctx.t ?? this.simNow).facing : (ctx.facing ?? 0);
      return out.set(Math.sin(f), 0, Math.cos(f));
    }
    this.hitDir(ctx, out);
    if (dir === 'hit') return out;
    if (dir === 'back') return out.negate();
    _side.set(-out.z, 0, out.x).multiplyScalar(side);
    // cut: blood leaves the wound, which faces the attacker, swept along the swing and up
    if (dir === 'cut') return out.multiplyScalar(-0.45).add(_side).setY(0.6).normalize();
    // deflect: off to the side of the blow and up
    return out.multiplyScalar(-0.25).add(_side).setY(0.55).normalize();
  }

  private emitSprites(op: Extract<FxOp, { k: 'sp' }>, ctx: SpawnCtx, r: FxRng, t: number, p: THREE.Vector3, L: FxLayer, def: FxDef) {
    if (this.persistOnly) return;
    const caps = fxSettings.caps();
    if ((op.minQ ?? 0) > fxSettings.quality) return;
    const flip = op.tex[0] === '@';
    const layer = this.vfx.layer(flip ? op.tex.slice(1) : 'mask');
    const sel = flip ? 0 : Math.max(0, SPRITES.indexOf(op.tex as (typeof SPRITES)[number]));
    const n = op.n <= 1 ? op.n : Math.max(1, Math.round(op.n * caps.spriteScale));
    const dir = this.spDir(op.dir, ctx, r, _d);
    const hasDir = dir.lengthSq() > 0;
    const cone = op.cone ?? (hasDir ? 0.3 : 1);
    _c.set(this.color(op.color, ctx, '#ffffff', p)).multiplyScalar(op.hdr ?? 1);
    const soft = L.soft ?? def.soft ?? (op.add ? 0.05 : flip ? 0.4 : 0.12);
    const flags = (op.add ? SP_ADD : 0) | (op.stretch ? SP_STREAK : 0) | (op.floor ? SP_FLOOR : 0) | (op.loop ? SP_LOOP : 0);
    const sp = op.speed ?? [0, 0];
    const sz = op.size ?? [0.2, 0.2];
    const life = op.life ?? [0.5, 0.5];
    const jit = op.jitter ?? 0;
    for (let k = 0; k < n; k++) {
      // random unit vector, mixed with the direction by `cone`
      _u.set(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1));
      if (_u.lengthSq() < 1e-6) _u.set(0, 1, 0);
      _u.normalize();
      if (hasDir) _u.lerp(dir, 1 - cone).normalize();
      const speed = r.range(sp[0], sp[1]);
      SP.t0 = t;
      SP.x = p.x + (jit ? r.range(-jit, jit) : 0);
      SP.y = p.y + (jit ? r.range(-jit, jit) * 0.3 : 0);
      SP.z = p.z + (jit ? r.range(-jit, jit) : 0);
      SP.vx = _u.x * speed;
      SP.vy = _u.y * speed + (op.vy ? r.range(op.vy[0], op.vy[1]) : 0);
      SP.vz = _u.z * speed;
      SP.life = r.range(life[0], life[1]);
      SP.r = _c.r;
      SP.g = _c.g;
      SP.b = _c.b;
      SP.a = op.alpha ?? 1;
      SP.drag = op.drag ?? 0;
      SP.grav = op.grav ?? 0;
      SP.stretch = op.stretch ?? 0;
      SP.soft = soft;
      SP.size0 = r.range(sz[0], sz[1]);
      SP.size1 = SP.size0 * (op.grow ?? 1);
      SP.rot = op.rot === false ? 0 : r.next() * Math.PI * 2;
      SP.spin = op.spin ? r.range(-op.spin, op.spin) : 0;
      SP.sel = flip ? (op.frame0 ? Math.floor(r.range(op.frame0[0], op.frame0[1])) : 0) : sel;
      SP.fps = op.fps ?? -1;
      SP.flags = flags;
      SP.aspect = op.aspect ?? 1;
      layer.emit(SP);
    }
  }

  /** blood droplets: ballistic streaks; `drops` of them leave a floor decal where and when they land */
  private emitBlood(op: Extract<FxOp, { k: 'blood' }>, ctx: SpawnCtx, r: FxRng, t: number, p: THREE.Vector3, delay: number) {
    const caps = fxSettings.caps();
    const layer = this.persistOnly ? null : this.vfx.layer('mask');
    const sel = SPRITES.indexOf('circle_05');
    // decals land from the recorded-frame contact point (exact on seek); droplets fly from the live one
    // (the 'contact' anchor sits on the victim's front, between the chests)
    const fp = this.rec && this.world ? this.anchor('contact', ctx, r, _q, true) : _q.copy(p);
    const fx = fp.x,
      fy = fp.y,
      fz = fp.z;
    const dir = this.spDir(op.dir ?? 'cut', ctx, r, _d);
    _c.set(this.color(op.color, ctx, '#a0101a'));
    const n = Math.max(1, Math.round(op.n * caps.spriteScale));
    const drops = Math.min(op.drops ?? 0, n);
    const dropScale = caps.decals >= 128 ? 1 : 0.5;
    const sz = op.size ?? [0.018, 0.035];
    const G = 9.8,
      K = 0.8;
    // decal times: sim time of the cause + the layer delay (fight); FX time (lab)
    const base = ctx.t !== undefined && this.rec ? ctx.t + delay : t;
    for (let k = 0; k < n; k++) {
      _u.set(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalize().lerp(dir, 1 - (op.cone ?? 0.45)).normalize();
      const speed = r.range(op.speed[0], op.speed[1]);
      const vx = _u.x * speed,
        vy = _u.y * speed + (op.vy ? r.range(op.vy[0], op.vy[1]) : 0.6),
        vz = _u.z * speed;
      const size = r.range(sz[0], sz[1]);
      // landing time (closed-form drag + gravity, bisection)
      let lo = 0,
        hi = 3;
      const y0 = Math.max(0.2, fy);
      const yAt = (tt: number) => {
        const e = Math.exp(-K * tt);
        const f = (1 - e) / K;
        return y0 + vy * f - (G * (tt - f)) / K;
      };
      for (let it = 0; it < 22; it++) {
        const m = (lo + hi) / 2;
        if (yAt(m) > 0.015) lo = m;
        else hi = m;
      }
      const tl = hi;
      if (layer) {
        SP.t0 = t;
        SP.x = p.x;
        SP.y = p.y;
        SP.z = p.z;
        SP.vx = vx;
        SP.vy = vy;
        SP.vz = vz;
        SP.life = Math.min(1.4, tl + 0.05);
        SP.r = _c.r;
        SP.g = _c.g;
        SP.b = _c.b;
        SP.a = 1;
        SP.drag = K;
        SP.grav = G;
        SP.stretch = 0.035;
        SP.soft = 0.03;
        SP.size0 = size;
        SP.size1 = size * 0.8;
        SP.rot = 0;
        SP.spin = 0;
        SP.sel = sel;
        SP.fps = -1;
        SP.flags = SP_STREAK;
        SP.aspect = 0.75;
        layer.emit(SP);
      }
      if (k < drops && r.next() < dropScale + 0.001) {
        const f = (1 - Math.exp(-K * tl)) / K;
        this.vfx.decals.emit({
          x: fx + vx * f,
          z: fz + vz * f,
          rot: r.next() * Math.PI * 2,
          size: r.range(0.06, 0.16) * (1 + size * 10),
          t0: base + tl,
          grow: 0.06,
          cell: r.next() < 0.6 ? 'blood_drips' : (('blood_splat_' + Math.floor(r.next() * 4)) as DecalCell),
          alpha: r.range(0.7, 0.95),
          nrm: 0.4,
          rough: 0.16,
          blood: 1,
        });
      }
    }
  }

  /** floor decals from recorded frame data (seek-exact) */
  private emitDecals(op: Extract<FxOp, { k: 'decal' }>, ctx: SpawnCtx, r: FxRng, t: number, L: FxLayer) {
    const n = op.n ?? 1;
    // decal time: sim time of the cause + the layer delay (fight); FX time (lab)
    const t0 = ctx.t !== undefined && this.rec ? ctx.t + (L.delay ?? 0) : t;
    const dir = this.hitDir(ctx, _d);
    const who = op.who ?? 'b';
    const i = who === 'a' ? (ctx.a ?? -1) : who === 'b' ? (ctx.b ?? -1) : -1;
    let bx: number, bz: number;
    if (who === 'event' && ctx.data && ctx.data.x !== undefined) (bx = Number(ctx.data.x)), (bz = Number(ctx.data.z));
    else if (this.rec && i >= 0) {
      const f = this.fstate(i, (ctx.t ?? this.simNow) + (L.delay ?? 0) + (op.body ?? 0));
      (bx = f.x), (bz = f.z);
    } else {
      const P = ctx.pos ?? { x: 0, y: 0, z: 0 };
      (bx = P.x), (bz = P.z);
      if (!this.rec && who === 'b' && ctx.b === undefined) bx += 0.95; // lab: under the right dummy
    }
    const cells = Array.isArray(op.cell) ? op.cell : [op.cell];
    for (let k = 0; k < n; k++) {
      const off = op.off ? r.range(op.off[0], op.off[1]) : 0;
      const side = op.side ? r.range(-op.side, op.side) : 0;
      const cell = cells[Math.floor(r.next() * cells.length)];
      const size = r.range(op.size[0], op.size[1]);
      const rot = op.align === 'hit' ? Math.atan2(dir.z, dir.x) + r.range(-0.35, 0.35) : r.next() * Math.PI * 2;
      const alpha = op.alpha ? r.range(op.alpha[0], op.alpha[1]) : 0.9;
      const aspect = op.aspect ? r.range(op.aspect[0], op.aspect[1]) : 1;
      this.vfx.decals.emit({
        x: bx + dir.x * off - dir.z * side,
        z: bz + dir.z * off + dir.x * side,
        rot,
        size,
        t0,
        grow: op.grow ?? 0.08,
        cell: DECAL_CELLS.includes(cell) ? cell : 'crack_0',
        alpha,
        nrm: op.nrm ?? 0.5,
        rough: op.rough ?? 0.6,
        blood: op.blood ? 1 : 0,
        aspect,
      });
    }
  }

  // ------------------------------------------------------------------ queries (FX Lab, tests, debug overlay)
  /** every def id */
  list(): string[] {
    return Object.keys(DEFS);
  }
  def(id: string): FxDef | undefined {
    return DEFS[id];
  }
  /** visible duration of a def (s) and its layer kinds / delays */
  timing(id: string): { duration: number; layers: { kind: string; delay: number }[] } | undefined {
    const d = DEFS[id];
    if (!d) return undefined;
    return { duration: defDuration(d), layers: d.layers.map((l) => ({ kind: l.op.k, delay: l.delay ?? 0 })) };
  }
  get time() {
    return this.vfx.clock.t;
  }
  /** FX Lab: advance by dt (fixed steps are exactly reproducible) */
  step(dt: number) {
    this.update(dt, dt);
  }
  /** FX Lab scrub: show the exact state at FX time t (stateless layers; pending layers fire if due) */
  setTime(t: number) {
    this.vfx.clock.seek(t);
    this.firePending();
    this.fireGhosts();
    this.vfx.render();
    this.updateBlood();
  }
  stats(): FxStats {
    const c = this.vfx.counts();
    const P = fxProfiler;
    return {
      t: +this.vfx.clock.t.toFixed(4),
      particles: { add: c.add, alpha: c.alpha, addCap: c.addCap, alphaCap: c.alphaCap },
      sprites: c.sprites,
      dist: c.dist,
      rings: c.rings,
      arrows: c.arrows,
      debris: c.debris,
      decals: c.decals,
      ribbons: c.ribbons,
      ghosts: c.ghosts,
      wounds: [this.blood[0].count, this.blood[1].count],
      lights: c.lights,
      effects: c.effects,
      pending: this.pending.length,
      spawns: this.vfx.spawns,
      light: c.light,
      quality: fxSettings.quality,
      gore: this.gore,
      cpu: { frameMs: +P.avg.frame.toFixed(4), updateMs: +P.avg.update.toFixed(4), frameMax: +P.max.frame.toFixed(4), updateMax: +P.max.update.toFixed(4) },
      seek: { ...this.seekStats },
    };
  }
  /** hash of the live effect list (id, spawn time, seed) */
  hash(): string {
    return this.vfx.hash();
  }
  /** hash of the full live state (every particle's spawn data, rings, debris, decals, light) */
  stateHash(): string {
    return this.vfx.stateHash();
  }
  /** hash of the persistent floor (decals visible now): identical after a play-through and a seek */
  decalHash(t = this.vfx.decalTime ?? this.vfx.clock.t): string {
    return this.vfx.decals.hash(t);
  }
  /** hash of both fighters' wounds and weapon blood */
  bloodHash(): string {
    return `${this.blood[0].hash().toString(16)}:${this.blood[1].hash().toString(16)}`;
  }
  liveEffects() {
    return this.vfx.liveEffects();
  }
  dispose() {
    if (this.ownsVfx) this.vfx.dispose();
  }
}

/**
 * Standalone director (FX Lab, tests): its own VFX added to `scene`, no world,
 * FX time 0, match seed `seed`.
 */
export function createFxDirector(o: { scene?: THREE.Object3D; seed?: number; quality?: number } = {}): FxDirector {
  const fx = new FxDirector();
  if (o.quality !== undefined) fxSettings.setQuality(o.quality);
  fx.reset(o.seed ?? 1, 0);
  o.scene?.add(fx.vfx.group);
  return fx;
}
