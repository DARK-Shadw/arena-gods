/**
 * SOUND DIRECTOR: maps the sim event stream + per-frame fighter state to
 * sample pools (src/data/sfx.ts). Render-side only: it never touches the sim,
 * so determinism and balance are unaffected.
 *
 * Timing: swing whooshes are scheduled so their transient peaks land on the
 * animation's strike moment (the sim's active-window start, which the
 * animation time-warp maps to the clip's measured strike frame); impacts play
 * from their transient (hitNow) on the hit event. Footsteps follow distance
 * travelled.
 */
import type { Frame, FighterFrame, MoveDef, SimEvent } from '../sim/types';
import { getFighter } from '../sim/fighters';
import { ANNOUNCER, CREATURE, HEAVY_STEPS, HIT_FAMILY } from '../data/sfx';
import { audio } from './audio';

interface Pos {
  x: number;
  z: number;
}

export class SoundDirector {
  ids: [string, string];
  private moves: Record<string, MoveDef>[] = [];
  private whooshed = [-1, -1];
  private effort = [-1, -1];
  private stepAcc = [0, 0];
  private lastPos: (Pos | null)[] = [null, null];
  private lastState = ['', ''];
  private lastPain = [-9, -9];
  private realT = 0;
  /** Set by DialogueManager when a hurt line is spoken (suppresses grunts). */
  voiceBusy: () => boolean = () => false;

  constructor(ids: [string, string]) {
    this.ids = ids;
    for (const id of ids) this.moves.push(Object.fromEntries(getFighter(id).moves.map((m) => [m.id, m])));
  }

  private pos(f: FighterFrame) {
    return { x: f.x, z: f.z };
  }

  /** Per-frame: footsteps, swing whooshes timed to the strike, dodge cloth. */
  frame(fr: Frame, simDt: number, realDt: number, timeScale: number) {
    this.realT += realDt;
    for (let i = 0; i < 2; i++) {
      const f = fr.f[i];
      const id = this.ids[i];
      // footsteps by distance
      const lp = this.lastPos[i];
      if (lp && simDt > 0 && (f.state === 'idle' || f.state === 'block')) {
        this.stepAcc[i] += Math.hypot(f.x - lp.x, f.z - lp.z);
        const stride = HEAVY_STEPS.has(id) ? 1.1 : 0.85;
        if (this.stepAcc[i] > stride) {
          this.stepAcc[i] = 0;
          audio.play(HEAVY_STEPS.has(id) ? 'footstep_heavy' : 'footstep', { pos: this.pos(f), vol: HEAVY_STEPS.has(id) ? 0.9 : 0.7 });
        }
      }
      this.lastPos[i] = { x: f.x, z: f.z };
      // dodge roll cloth + scuff
      if (f.state === 'dodge' && this.lastState[i] !== 'dodge') {
        audio.play('cloth', { pos: this.pos(f) });
        audio.play('footstep', { pos: this.pos(f), at: 0.25, rate: 0.8 });
      }
      if (f.state === 'getup' && this.lastState[i] !== 'getup') audio.play('cloth', { pos: this.pos(f), vol: 0.7 });
      this.lastState[i] = f.state;
      // attacks: effort grunt at windup start, whoosh peak on the strike
      if (f.state === 'attack' && f.moveId) {
        const mv = this.moves[i][f.moveId];
        if (!mv) continue;
        const big = mv.kind === 'heavy' || mv.kind === 'ultimate' || mv.kind === 'gap';
        if (f.phase === 0 && this.effort[i] !== f.attackId) {
          this.effort[i] = f.attackId;
          if (big && !this.voiceBusy()) {
            if (CREATURE[id]) audio.play('creature_grunt', { pos: this.pos(f), rate: CREATURE[id], vol: 0.8 });
            else audio.play('grunt_effort', { pos: this.pos(f), rate: id === 'erika' ? 1.35 : id === 'ozrel' ? 1.08 : 0.95, vol: 0.7 });
          }
        }
        if (f.phase === 0 && this.whooshed[i] !== f.attackId) {
          const remainSim = (1 - f.phaseT) * mv.windup;
          if (remainSim < 0.16 || f.phaseT > 0.85) {
            this.whooshed[i] = f.attackId;
            const remainReal = remainSim / Math.max(0.05, timeScale);
            if (mv.ranged && mv.fx === 'arrow') audio.play('whoosh_light', { pos: this.pos(f), at: Math.min(0.5, remainReal), rate: 1.5, vol: 0.8 });
            else if (mv.fx === 'fire' || mv.fx === 'pyre' || mv.fx === 'nova') audio.play('whoosh_heavy', { pos: this.pos(f), at: Math.min(0.5, remainReal), rate: 0.7 });
            else audio.play(big ? 'whoosh_heavy' : 'whoosh_light', { pos: this.pos(f), at: Math.min(0.5, remainReal) });
          }
        }
      }
    }
  }

  private pain(i: number, f: FighterFrame, heavy: boolean) {
    if (this.realT - this.lastPain[i] < 0.7 || this.voiceBusy()) return;
    this.lastPain[i] = this.realT;
    const id = this.ids[i];
    if (CREATURE[id]) audio.play('creature_grunt', { pos: this.pos(f), rate: CREATURE[id], vol: heavy ? 1 : 0.75 });
    else audio.play('grunt_pain', { pos: this.pos(f), rate: id === 'erika' ? 1.35 : id === 'vex' ? 0.92 : 1, vol: heavy ? 0.9 : 0.6 });
  }

  events(evs: SimEvent[], fr: Frame) {
    for (const e of evs) {
      const a = e.a >= 0 ? fr.f[e.a] : undefined;
      const b = e.b !== undefined && e.b >= 0 ? fr.f[e.b] : undefined;
      switch (e.type) {
        case 'hit': {
          if (!a || !b) break;
          const fam = HIT_FAMILY[this.ids[e.a]];
          const heavy = !!e.data?.heavy;
          const ult = e.data?.kind === 'ultimate';
          const p = this.pos(b);
          if (fam === 'blade') audio.play(heavy ? 'hit_heavy' : 'hit_blade', { pos: p, hitNow: true });
          else if (fam === 'arrow') audio.play('arrow_hit', { pos: p, hitNow: true });
          else if (fam === 'magic') {
            audio.fire(heavy);
            audio.play('hit_blunt', { pos: p, hitNow: true, vol: 0.6 });
          } else audio.play('hit_blunt', { pos: p, hitNow: true, rate: this.ids[e.a] === 'maw' ? 0.75 : 1 });
          if (heavy) {
            audio.play('body_thud', { pos: p, hitNow: true });
            audio.hitDuck(0.5, 0.1);
          }
          if (ult) {
            audio.boom(0.6);
            audio.play('ring', { pos: p, vol: 0.6 });
          }
          if (heavy || Number(e.data?.dmg ?? 0) >= 45) this.pain(e.b!, b, heavy);
          if (heavy) audio.cheer(0.5);
          break;
        }
        case 'block':
          if (a) audio.play('clang', { pos: this.pos(a), hitNow: true });
          break;
        case 'parry':
          if (a) {
            audio.play('parry', { pos: this.pos(a), hitNow: true });
            audio.play('ring', { pos: this.pos(a), vol: 0.7 });
            audio.cheer(0.7);
          }
          break;
        case 'guard_break':
          if (a) {
            audio.play('clang', { pos: this.pos(a), hitNow: true, rate: 0.75 });
            audio.play('body_thud', { pos: this.pos(a), hitNow: true });
          }
          break;
        case 'knockdown':
          if (a) audio.play('body_thud', { pos: this.pos(a), at: 0.35, rate: 0.8 });
          break;
        case 'wall_slam':
          if (a) {
            audio.play('wall_slam', { pos: this.pos(a), hitNow: true });
            audio.boom(0.4);
            audio.gasp();
          }
          break;
        case 'pillar_slam':
          if (a) {
            audio.play('stone_slam', { pos: this.pos(a), hitNow: true });
            audio.boom(0.4);
            audio.gasp();
          }
          break;
        case 'prop_break': {
          // destruction: pick the pool by material, positioned at the prop
          const k = String(e.data?.kind ?? '');
          const p = { x: Number(e.data?.x ?? (a ? a.x : 0)), z: Number(e.data?.z ?? (a ? a.z : 0)) };
          if (k === 'urn' || k === 'lantern') audio.play('clang', { pos: p, hitNow: true, rate: 1.6, vol: 0.45 });
          if (k === 'brazier') audio.play('wall_slam', { pos: p, hitNow: true, rate: 1.2, vol: 0.7 });
          else audio.play('wood_break', { pos: p, hitNow: true, rate: k === 'urn' ? 1.3 : 1 });
          break;
        }
        case 'cover_hit': {
          const ob = Number(e.data?.obs);
          void ob;
          if (Number(e.data?.dmg ?? 0) >= 25) audio.play('stone_slam', { pos: a ? this.pos(a) : undefined, hitNow: true, rate: 1.3, vol: 0.45 });
          break;
        }
        case 'topple':
          audio.play('stone_slam', { rate: 0.55, vol: 0.8 });
          audio.gasp();
          break;
        case 'topple_impact':
          audio.play('stone_slam', { pos: { x: Number(e.data?.x ?? 0), z: Number(e.data?.z ?? 0) }, hitNow: true, rate: 0.5, vol: 1.1 });
          audio.play('wall_slam', { pos: { x: Number(e.data?.x ?? 0), z: Number(e.data?.z ?? 0) }, hitNow: true, rate: 0.6 });
          audio.boom(0.9);
          audio.cheer(1.2);
          break;
        case 'crush':
          if (b) audio.play('body_thud', { pos: this.pos(b), hitNow: true, rate: 0.7 });
          break;
        case 'explosion': {
          const p = { x: Number(e.data?.x ?? 0), z: Number(e.data?.z ?? 0) };
          audio.boom(1.4);
          audio.fire(true);
          audio.play('wood_break', { pos: p, hitNow: true, rate: 0.7, vol: 1.1 });
          audio.hitDuck(0.7, 0.3);
          audio.cheer(1.5);
          break;
        }
        case 'fuse':
          audio.fire(false);
          break;
        case 'prop_hit':
          if (b) {
            audio.play('hit_blunt', { pos: this.pos(b), hitNow: true, rate: 0.8 });
            audio.play('body_thud', { pos: this.pos(b), hitNow: true });
            this.pain(e.b!, b, true);
            audio.cheer(0.8);
          }
          break;
        case 'prop_batted':
          if (a) audio.play('clang', { pos: this.pos(a), hitNow: true, rate: 0.8 });
          break;
        case 'prop_land':
          audio.play('footstep_heavy', { pos: { x: Number(e.data?.x ?? 0), z: Number(e.data?.z ?? 0) }, vol: 0.5, rate: 0.8 });
          break;
        case 'hazard_hit': {
          const kind = String(e.data?.kind ?? '');
          if (kind === 'lava' || kind === 'firepit') audio.fire(true);
          else if (kind === 'spikes') audio.play('hit_blade', { pos: b ? this.pos(b) : undefined, hitNow: true, rate: 0.85 });
          else if (kind === 'geyser') audio.play('whoosh_heavy', { pos: b ? this.pos(b) : undefined, rate: 0.6 });
          else if (kind === 'flamejet' || kind === 'oil') audio.fire(true);
          else if (kind === 'chains') audio.play('hit_blunt', { pos: b ? this.pos(b) : undefined, hitNow: true, rate: 0.6 });
          else if (kind === 'crumble') audio.play('body_thud', { pos: b ? this.pos(b) : undefined, hitNow: true, rate: 0.7 });
          if (b) this.pain(e.b!, b, true);
          audio.gasp();
          break;
        }
        case 'hazard_trigger': {
          const kind = String(e.data?.kind ?? '');
          if (kind === 'spikes') audio.play('clang', { rate: 1.4, vol: 0.4 });
          else if (kind === 'geyser') audio.play('whoosh_light', { rate: 0.5, vol: 0.5 });
          else if (kind === 'chains') audio.play('clang', { rate: 0.7, vol: 0.5 });
          else if (kind === 'flamejet') audio.fire(false);
          else if (kind === 'crumble') audio.play('stone_slam', { rate: 1.4, vol: 0.4 });
          break;
        }
        // A2b interactables
        case 'brazier_tip':
          audio.play('wall_slam', { pos: { x: Number(e.data?.x ?? 0), z: Number(e.data?.z ?? 0) }, hitNow: true, rate: 1.2, vol: 0.6 });
          audio.fire(true);
          audio.cheer(0.8);
          break;
        case 'obstacle_break':
          audio.play('wood_break', { pos: { x: Number(e.data?.x ?? 0), z: Number(e.data?.z ?? 0) }, hitNow: true, rate: 0.75, vol: 1.1 });
          audio.cheer(0.7);
          break;
        case 'floor_collapse':
          audio.play('stone_slam', { pos: { x: Number(e.data?.x ?? 0), z: Number(e.data?.z ?? 0) }, hitNow: true, rate: 0.45, vol: 1.1 });
          audio.boom(0.9);
          audio.gasp();
          break;
        case 'chandelier_fall':
          audio.play('clang', { rate: 0.55, vol: 0.7 });
          audio.gasp();
          break;
        case 'ability_used':
          audio.stinger('dread');
          audio.musicSwell(0.3);
          if (a && CREATURE[this.ids[e.a]]) audio.play('creature_roar', { pos: this.pos(a), rate: CREATURE[this.ids[e.a]] });
          break;
        case 'taunt':
          audio.cheer(0.5);
          break;
        case 'second_wind':
        case 'last_stand':
          audio.musicSwell(0.35);
          audio.cheer(1.2);
          if (a && CREATURE[this.ids[e.a]]) audio.play('creature_roar', { pos: this.pos(a), rate: CREATURE[this.ids[e.a]] });
          break;
        case 'momentum_swing':
        case 'comeback':
          audio.musicSwell(0.25);
          audio.cheer(e.type === 'comeback' ? 2 : 1.2);
          break;
        case 'near_death':
          audio.gasp();
          break;
        case 'stalemate_break':
          audio.gasp();
          break;
        case 'arena_shrink':
          audio.fire(true);
          audio.stinger('dread');
          break;
        case 'sudden_death':
          audio.play('announcer', { idx: ANNOUNCER.suddenDeath });
          break;
        case 'hazard_burn':
          audio.fire(false);
          break;
        case 'kill':
          // layered slow-mo finisher: heavy impact pitched down + thud + sub boom + ring
          if (b) {
            audio.play('hit_heavy', { pos: this.pos(b), hitNow: true, rate: 0.7, vol: 1.2 });
            audio.play('body_thud', { pos: this.pos(b), hitNow: true, rate: 0.7 });
            audio.play('ring', { pos: this.pos(b), rate: 0.6 });
          }
          audio.boom(1.3);
          audio.hitDuck(0.8, 0.4);
          audio.gasp();
          break;
      }
    }
  }

  announce(which: keyof typeof ANNOUNCER) {
    audio.play('announcer', { idx: ANNOUNCER[which] });
  }
}
