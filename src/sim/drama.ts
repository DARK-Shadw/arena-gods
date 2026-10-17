/**
 * DRAMA ENGINE — a hidden layer inside the simulation that shapes pacing.
 *
 * Design rule: every lever must be explainable in-fiction, so viewers read it
 * as character, not as rubber-banding:
 *
 *  - Bloodlust: damage ramps up over time (crowd/adrenaline). Keeps early
 *    exchanges from ending fights in 15 s and late fights from dragging.
 *  - Underdog grit: a fighter far behind takes slightly less damage. Small and
 *    capped, so leads still matter, but steamrolls stretch into a contest.
 *  - Fury rubber band: taking damage builds fury faster when behind, so the
 *    trailing fighter reaches their ultimate first (a natural comeback tool).
 *  - Second wind (personality: desperation >= 0): once per fight, when badly
 *    behind, a roar that restores stamina, a little HP and a damage buff.
 *    Cowards (desperation < 0) don't get it; they turtle instead, until...
 *  - Last stand: below 12% HP everyone roars once, gets full fury and a buff.
 *  - Stalemate break: no clean hit for a while -> crowd jeers, both AIs get an
 *    aggression boost.
 *  - Ring of fire (arena/ARENA.shrinkStart) + sudden death: hard anti-stall.
 *
 * It also measures the fight (momentum swings, comeback, tension) and emits
 * drama events that the camera, VFX, audio and HUD react to.
 */
import { exp } from './dmath';
import { ARENA } from './arena';
import type { FighterState, Match } from './match';
import type { MatchResult } from './types';

const SWING_HYST = 0.08; // hp-fraction lead needed to (re)take the lead

export class Drama {
  m: Match;
  leader = -1;
  leadChanges = 0;
  swings = 0;
  maxDeficit: [number, number] = [0, 0];
  lastHitT = 0;
  lastStallT = -99;
  tension = 0.2;
  momentum = 0;
  private flow: [number, number] = [0, 0]; // decaying recent damage dealt
  private lowFired: [boolean, boolean] = [false, false];
  private nearFired: [boolean, boolean] = [false, false];
  private lastStandFired: [boolean, boolean] = [false, false];
  private secondWindUsed: [boolean, boolean] = [false, false];
  private shrinkAnnounced = false;
  private sdAnnounced = false;
  private recentHits = 0;

  constructor(m: Match) {
    this.m = m;
  }

  hpf(i: number) {
    const f = this.m.f[i];
    return f.hp / f.maxHp;
  }

  /** Outgoing damage multiplier (bloodlust + sudden death). */
  damageMul(att: FighterState, def: FighterState): number {
    const t = this.m.t;
    let mul = 0.76 + Math.min(1.2, t / 70);
    // sudden death escalates (x1.5, +0.25 per second after) so no fight can stall into the time limit
    if (t >= ARENA.suddenDeath) mul *= 1.5 + (t - ARENA.suddenDeath) * 0.25;
    if (att.lastStand) mul *= 1.15;
    return mul;
  }

  /** Incoming damage multiplier ("underdog grit"). */
  incomingMul(def: FighterState): number {
    const deficit = this.hpf(1 - def.idx) - this.hpf(def.idx);
    const k = Math.min(1, Math.max(0, (deficit - 0.08) / 0.25));
    return 1 - 0.5 * k;
  }

  onHit(att: FighterState, def: FighterState, dmg: number) {
    this.lastHitT = this.m.t;
    this.recentHits += 1;
    this.flow[att.idx] += dmg / att.maxHp;
    // fury rubber band: trailing fighters gain more from taking damage
    const deficit = Math.max(0, this.hpf(1 - def.idx) - this.hpf(def.idx));
    def.fury = Math.min(100, def.fury + (dmg / def.maxHp) * 100 * 0.6 * (1 + deficit * 6.5));
    // the leader's own fury builds slower (complacency)
    const lead = Math.max(0, this.hpf(att.idx) - this.hpf(def.idx));
    att.fury = Math.max(0, att.fury - (dmg / def.maxHp) * 100 * 0.3 * Math.min(1, lead * 3));
  }

  /** destruction spectacle (explosions, toppling columns, falling chandeliers): raises tension only */
  spectacle(amount: number) {
    this.recentHits += amount;
  }

  onAction() {
    // blocks / parries count partially as action for the stall timer
    this.lastHitT = Math.max(this.lastHitT, this.m.t - 3);
  }

  onDamage(def: FighterState, amount: number) {}

  preTick() {
    const m = this.m;
    const t = m.t;
    if (!this.shrinkAnnounced && t >= ARENA.shrinkStart) {
      this.shrinkAnnounced = true;
      m.emit('arena_shrink', -1, undefined, { from: ARENA.fightR, to: ARENA.minR });
    }
    if (!this.sdAnnounced && t >= ARENA.suddenDeath) {
      this.sdAnnounced = true;
      m.emit('sudden_death', -1);
    }
    if (!m.over && t - this.lastHitT > 6.5 && t - this.lastStallT > 9) {
      this.lastStallT = t;
      this.lastHitT = t - 2; // give the boost time to work before re-firing
      m.emit('stalemate_break', -1);
      for (const f of m.f) f.ai.boostUntil = t + 7;
    }
  }

  postTick() {
    const m = this.m;
    const dt = 1 / 60;
    this.flow[0] *= exp(-dt / 3);
    this.flow[1] *= exp(-dt / 3);
    this.recentHits *= exp(-dt / 5);
    const h0 = this.hpf(0),
      h1 = this.hpf(1);
    const adv = h0 - h1;
    this.maxDeficit[0] = Math.max(this.maxDeficit[0], -adv);
    this.maxDeficit[1] = Math.max(this.maxDeficit[1], adv);

    const live = !m.over || m.t - (m.endT - 5) < 0.02; // include the kill tick
    if (live) {
      // momentum swings (leader change with hysteresis)
      if (this.leader === -1) {
        if (Math.abs(adv) > SWING_HYST) this.leader = adv > 0 ? 0 : 1;
      } else {
        const lead = this.leader === 0 ? adv : -adv;
        if (lead < -SWING_HYST) {
          const newLeader = 1 - this.leader;
          this.leader = newLeader;
          this.leadChanges++;
          this.swings++;
          m.emit('momentum_swing', newLeader, 1 - newLeader, { n: this.swings });
          if (this.maxDeficit[newLeader] >= 0.25) m.emit('comeback', newLeader, 1 - newLeader, { deficit: +this.maxDeficit[newLeader].toFixed(2) });
        }
      }

      for (const f of m.f) this.personalBeats(f, f.idx === 0 ? h0 : h1, f.idx === 0 ? h1 : h0);
    }

    // momentum: blend of hp lead and recent damage flow
    const flow = Math.max(-1, Math.min(1, (this.flow[0] - this.flow[1]) * 3));
    const target = Math.max(-1, Math.min(1, adv * 0.4 + flow * 0.8));
    this.momentum += (target - this.momentum) * (1 - exp(-dt * 2));
    // tension 0..1
    const minHp = Math.min(h0, h1);
    const close = 1 - Math.min(1, Math.abs(adv) * 2);
    let tension = 0.15 + 0.4 * (1 - minHp) + 0.2 * close * (1 - minHp) + Math.min(0.2, this.recentHits * 0.03);
    if (m.t > ARENA.shrinkStart) tension += 0.1;
    if (m.f[0].lastStand || m.f[1].lastStand) tension += 0.15;
    this.tension += (Math.min(1, tension) - this.tension) * (1 - exp(-dt * 1.5));
  }

  private personalBeats(f: FighterState, my: number, opp: number) {
    const m = this.m;
    const i = f.idx;
    const P = f.def.personality;
    if (!this.lowFired[i] && my < 0.35) {
      this.lowFired[i] = true;
      m.emit('low_hp_state', i);
    }
    if (!this.nearFired[i] && my < 0.2) {
      this.nearFired[i] = true;
      m.emit('near_death', i);
    }
    // second wind: desperate personalities, badly behind
    if (!this.secondWindUsed[i] && P.desperation >= 0 && my < 0.45 && opp - my > 0.18) {
      this.secondWindUsed[i] = true;
      f.pendingBeat = 'second_wind';
    }
    // cowards don't get a second wind; cornered, they turn vicious instead
    if (!this.secondWindUsed[i] && P.desperation < 0 && my < 0.3 && opp - my > 0.15) {
      this.secondWindUsed[i] = true;
      f.pendingBeat = 'cornered';
    }
    if (!this.lastStandFired[i] && my < 0.13) {
      this.lastStandFired[i] = true;
      f.pendingBeat = 'last_stand';
    }
    // Trigger deferred beats once the fighter is free to roar
    if (f.pendingBeat && (f.state === 'idle' || f.state === 'block')) {
      const beat = f.pendingBeat;
      f.pendingBeat = null;
      if (beat === 'cornered') {
        f.fury = Math.min(100, f.fury + 60);
        f.stamina = f.def.stats.stamina;
        f.buffT = 9;
        f.buffMul = 1.35;
        f.ai.boostUntil = m.t + 9;
        m.startRoar(f, 0.7);
        m.emit('second_wind', i, 1 - i, { kind: 'cornered' });
      } else if (beat === 'second_wind') {
        f.stamina = f.def.stats.stamina;
        f.hp = Math.min(f.maxHp, f.hp + f.maxHp * (0.11 + 0.07 * P.desperation));
        f.fury = Math.min(100, f.fury + 35);
        f.buffT = 8;
        f.buffMul = 1.25;
        m.startRoar(f, 0.9);
        m.emit('second_wind', i, 1 - i, { kind: 'second_wind' });
      } else {
        f.lastStand = true;
        f.fury = 100;
        f.stamina = f.def.stats.stamina;
        f.buffT = 10;
        f.buffMul = Math.max(f.buffMul, 1.3);
        m.startRoar(f, 0.8);
        m.emit('last_stand', i, 1 - i);
      }
    }
  }

  result(): MatchResult {
    const m = this.m;
    const w = m.winner;
    const finalHp: [number, number] = [this.hpf(0), this.hpf(1)];
    const md = w >= 0 ? this.maxDeficit[w] : 0;
    return {
      winner: w,
      duration: +(m.events.find((e) => e.type === 'kill' || e.type === 'timeout')?.t ?? m.t).toFixed(2),
      timeout: m.timeout,
      swings: this.swings,
      leadChanges: this.leadChanges,
      comeback: w >= 0 && md >= 0.25,
      oneSided: w >= 0 && this.leadChanges === 0 && md < 0.1 && finalHp[w] > 0.4,
      maxDeficitWinner: +md.toFixed(3),
      finalHp,
      killMove: m.killMove,
    };
  }
}
