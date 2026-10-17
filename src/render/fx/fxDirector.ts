/**
 * FX director: turns the sim event stream (and observations of recorded
 * frames) into effects, on the FX clock, with seeded randomness.
 *
 *   game:  fx.frame({ events, frame, simT, simDt })   once per fight tick, before handleEvents
 *          fx.update(fxDt, realDt)                      once per rendered tick
 *          fx.seek(simT)                                on ?t= / debugSeekFight (clears, reseeds)
 *   lab:   createFxDirector({ scene }).spawn(id, pos, { seed, t }); fx.setTime(t) / fx.step(dt)
 *
 * What fires is data (fxDefs.ts); this file only resolves anchors, colours and
 * seeds and calls the primitives. Seeds: hash(match seed, key, effect id, layer)
 * with key = the event's index in rec.events (stable: the record is
 * deterministic), (fighter, attack id) for phase observations, (emitter,
 * fighter, tick) for continuous emitters and (projectile id, tick) for trails.
 * Nothing here reads the wall clock or an unseeded random source, and nothing writes sim data.
 */
import * as THREE from 'three';
import type { Frame, MatchRecord, MoveDef, SimEvent } from '../../sim/types';
import { VFX } from './legacyVfx';
import { FxRng, hashN, hashStr } from './fxRng';
import { fxSettings, goreLevel, type GoreLevel } from './fxSettings';
import { CONTINUOUS, DEFS, ON_ACTIVE, PROJ_TRAIL_RATE, RESOLVE, RING_FIRE_RATE, RING_HEAT_RATE, defDuration, projEnd, projTrail, type Anchor, type FxDef, type FxLayer } from './fxDefs';
import { fxProfiler } from './profiler';

type V3 = { x: number; y: number; z: number };

/** What the director may read from the live game (all read-only). */
export interface FxWorld {
  chest(i: number): V3;
  head(i: number): V3;
  cast(i: number): V3;
  /** fighter root position (feet anchors use its x/z on the floor) */
  feet(i: number): V3;
  accent(i: number): string;
  move(i: number, id: string): MoveDef | undefined;
  obstacle(i: number): { x: number; z: number } | undefined;
  hazard(i: number): { x: number; z: number; kind: string } | undefined;
  /** ring of fire half-axes at full size */
  ring(): { rx: number; rz: number };
  isFinisher(move: string): boolean;
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
  /** live distortion sprites (F1) */
  dist: number;
  rings: number;
  arrows: number;
  debris: number;
  effects: number;
  pending: number;
  spawns: number;
  light: number;
  quality: number;
  gore: GoreLevel;
  cpu: { frameMs: number; updateMs: number; frameMax: number; updateMax: number };
}

interface Pending {
  at: number;
  def: FxDef;
  layer: number;
  seed: number;
  ctx: SpawnCtx;
}

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _rng = new FxRng(1);

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
  private proj = new Map<number, { x: number; y: number; z: number; fx: string }>();
  private projSeen = new Set<number>();
  private ownsVfx: boolean;
  /** the frame being processed (facing for streams); undefined outside frame() */
  private curFrame?: Frame;
  gore: GoreLevel = goreLevel();

  constructor(vfx?: VFX) {
    this.ownsVfx = !vfx;
    this.vfx = vfx ?? new VFX();
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
    this.resetState(t, 0);
  }

  /**
   * Jump to sim time t (debugSeekFight / ?t=): clear every live effect, reseed,
   * FX time := t. The game then re-runs its warm-up window at fixed steps, which
   * re-spawns the effects of the events in that window with their original seeds.
   */
  seek(simT: number) {
    this.resetState(simT, simT);
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
    this.proj.clear();
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
    this.proj.clear();
  }

  // ------------------------------------------------------------------ per frame
  /** Feed one fight tick: events, attack-phase observations, continuous emitters, projectile trails. */
  frame(inp: FxFrameInput) {
    const t0 = fxProfiler.begin();
    const W = this.world;
    const fr = inp.frame;
    this.curFrame = fr;
    for (const e of inp.events) this.onEvent(e, fr);
    if (W) {
      for (let i = 0; i < 2; i++) {
        const f = fr.f[i];
        const mv = f.moveId ? W.move(i, f.moveId) : undefined;
        const newAttack = f.attackId !== this.lastAttackId[i];
        if (f.state === 'attack' && mv && f.phase === 1 && (f.phase !== this.lastPhase[i] || newAttack)) {
          const key = hashN(0xac, i, f.attackId);
          for (const rule of ON_ACTIVE) for (const id of rule(mv)) if (id) this.spawnKeyed(id, key, { a: i });
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
          const f = fr.f[i];
          const mv = f.moveId ? W.move(i, f.moveId) : undefined;
          for (const c of CONTINUOUS) {
            const id = c.when(f, mv);
            if (id) this.ticks(id, c.rate, tPrev, t1, hashN(hashStr(c.key), i), { a: i });
          }
        }
      }
      if (fr.ringS < 0.995) {
        this.ticks('ring.fire', RING_FIRE_RATE, tPrev, t1, 0x7121, { ringS: fr.ringS });
        if (fxSettings.caps().dist >= 2) this.ticks('ring.heat', RING_HEAT_RATE, tPrev, t1, 0x7122, { ringS: fr.ringS });
      }
      for (const p of fr.proj) {
        const id = projTrail(p.fx);
        if (id) this.ticks(id, PROJ_TRAIL_RATE, tPrev, t1, hashN(0x9e, p.id), { pos: { x: p.x, y: p.y, z: p.z } });
      }
    }
    // projectiles that vanished this frame: impact sparks at their last position
    this.projSeen.clear();
    for (const p of fr.proj) {
      this.projSeen.add(p.id);
      const s = this.proj.get(p.id);
      if (s) (s.x = p.x), (s.y = p.y), (s.z = p.z);
      else this.proj.set(p.id, { x: p.x, y: p.y, z: p.z, fx: p.fx });
    }
    for (const [id, s] of this.proj) {
      if (this.projSeen.has(id)) continue;
      this.spawnKeyed(projEnd(s.fx), hashN(0x9f, id), { pos: s });
      this.proj.delete(id);
    }
    this.lastSimT = t1;
    this.curFrame = undefined;
    fxProfiler.end('frame', t0);
  }

  private onEvent(e: SimEvent, fr: Frame) {
    const R = RESOLVE[e.type];
    if (!R) return;
    const W = this.world;
    const ids = R(e, { isFinisher: W?.isFinisher, hazardKind: (i) => W?.hazard(i)?.kind });
    const key = this.evIndex.get(e) ?? hashN(0xe0, Math.round(e.t * 1000), hashStr(e.type));
    const ctx: SpawnCtx = { a: e.a, b: e.b, data: e.data as Record<string, unknown> | undefined, ringS: fr.ringS };
    for (const id of ids) if (id) this.spawnKeyed(id, key, ctx);
  }

  /** Fixed-rate ticks on sim time in (t0, t1]: tick n spawns with seed hash(key, n). */
  private ticks(id: string, rate: number, t0: number, t1: number, key: number, ctx: SpawnCtx) {
    const n0 = Math.floor(t0 * rate);
    let n1 = Math.floor(t1 * rate);
    if (n1 - n0 > 64) n1 = n0 + 64; // a large jump (paused tab) must not flood the pool
    for (let n = n0 + 1; n <= n1; n++) this.spawnKeyed(id, hashN(key, n), ctx);
  }

  private spawnKeyed(id: string, key: number, ctx: SpawnCtx) {
    this.spawnDef(id, hashN(this.matchSeed, key, hashStr(id)), this.vfx.clock.t, ctx);
  }

  /** Advance FX time and evaluate every layer; fires delayed layers that came due. */
  update(dt: number, realDt = dt) {
    const t0 = fxProfiler.begin();
    this.vfx.clock.advance(dt, realDt);
    this.firePending();
    this.vfx.render();
    fxProfiler.end('update', t0);
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
    const pk = def.post;
    if (pk) {
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
  spawn(id: string, pos: V3, o: { seed?: number; t?: number; a?: number; b?: number; accent?: string; facing?: number; data?: Record<string, unknown> } = {}): boolean {
    const seed = o.seed ?? hashN(this.matchSeed, hashStr(id), Math.round(this.vfx.clock.t * 1000));
    return this.spawnDef(id, seed >>> 0, o.t ?? this.vfx.clock.t, { pos, a: o.a, b: o.b, accent: o.accent, facing: o.facing, data: o.data, ringS: 1 });
  }

  private anchor(at: Anchor, ctx: SpawnCtx, r: FxRng, out: THREE.Vector3): THREE.Vector3 {
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
    const cp = (v: V3) => out.set(v.x, v.y, v.z);
    switch (at) {
      case 'contact':
        if (a < 0 || b < 0) break;
        cp(W.chest(b));
        return out.lerp(_q.copy(W.chest(a) as THREE.Vector3), 0.25);
      case 'blockContact':
      case 'parryContact':
        if (a < 0 || b < 0) break;
        cp(W.chest(a));
        return out.lerp(_q.copy(W.chest(b) as THREE.Vector3), at === 'blockContact' ? 0.3 : 0.35);
      case 'aChest':
        if (a >= 0) return cp(W.chest(a));
        break;
      case 'bChest':
        if (b >= 0) return cp(W.chest(b));
        break;
      case 'aHead':
        if (a >= 0) return cp(W.head(a));
        break;
      case 'aCast':
        if (a >= 0) return cp(W.cast(a));
        break;
      case 'aFeet':
        if (a >= 0) return cp(W.feet(a)).setY(0);
        break;
      case 'bFeet':
        if (b >= 0) return cp(W.feet(b)).setY(0);
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

  private color(c: string | undefined, ctx: SpawnCtx, fallback: string): string {
    if (!c) return fallback;
    if (c[0] !== '$') return c;
    const i = c === '$accentB' ? ctx.b : ctx.a;
    if (this.world && i !== undefined && i >= 0) return this.world.accent(i);
    return ctx.accent ?? '#ffb060';
  }

  private runLayer(def: FxDef, L: FxLayer, ctx: SpawnCtx, r: FxRng, t: number) {
    const V = this.vfx;
    const p = this.anchor(L.at ?? def.at, ctx, r, _p);
    const y = L.y ?? (L.at ? undefined : def.y);
    if (y !== undefined) p.y = y;
    if (L.minY !== undefined) p.y = Math.max(L.minY, p.y);
    const op = L.op;
    const s = fxSettings.caps().countScale;
    const N = (n: number) => (s === 1 ? n : Math.max(1, Math.round(n * s)));
    // per-layer overrides read by the primitives (soft-particle distance, HDR multiplier)
    V.softOverride = L.soft ?? def.soft;
    V.hdrOverride = 'hdr' in op ? op.hdr : undefined;
    try {
      this.runOp(op, ctx, r, t, p, N);
    } finally {
      V.softOverride = undefined;
      V.hdrOverride = undefined;
    }
  }

  private runOp(op: FxLayer['op'], ctx: SpawnCtx, r: FxRng, t: number, p: THREE.Vector3, N: (n: number) => number) {
    const V = this.vfx;
    switch (op.k) {
      case 'sparks':
        V.sparksAt(r, t, p, N(op.n), this.color(op.color, ctx, '#ffc070'), op.speed ?? 7);
        break;
      case 'flash':
        V.flashAt(r, t, p, this.color(op.color, ctx, '#fff0d0'), op.size ?? 1.2, op.light ?? 6);
        break;
      case 'dust':
        V.dustAt(r, t, p, N(op.n), op.spread ?? 1, this.color(op.color, ctx, '#9a8064'));
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
    this.vfx.render();
  }
  stats(): FxStats {
    const c = this.vfx.counts();
    const P = fxProfiler;
    return {
      t: +this.vfx.clock.t.toFixed(4),
      particles: { add: c.add, alpha: c.alpha, addCap: c.addCap, alphaCap: c.alphaCap },
      dist: c.dist,
      rings: c.rings,
      arrows: c.arrows,
      debris: c.debris,
      effects: c.effects,
      pending: this.pending.length,
      spawns: this.vfx.spawns,
      light: c.light,
      quality: fxSettings.quality,
      gore: this.gore,
      cpu: { frameMs: +P.avg.frame.toFixed(4), updateMs: +P.avg.update.toFixed(4), frameMax: +P.max.frame.toFixed(4), updateMax: +P.max.update.toFixed(4) },
    };
  }
  /** hash of the live effect list (id, spawn time, seed) */
  hash(): string {
    return this.vfx.hash();
  }
  /** hash of the full live state (every particle's spawn data, rings, debris, light) */
  stateHash(): string {
    return this.vfx.stateHash();
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
