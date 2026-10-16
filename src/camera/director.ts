/**
 * AUTO-DIRECTOR. Chooses camera shots from the sim's event stream + tension,
 * like a live sports/cinema director:
 *
 *  - Coverage shots (two-shot, low two-shot, over-the-shoulder, wide) rotate
 *    on a timer that shortens as tension rises.
 *  - Event shots interrupt coverage by priority: killcam (with slow-mo, known
 *    in advance thanks to the pre-simulated record), ultimate hero shots,
 *    last-stand/second-wind reaction close-ups, knockdown crane shots,
 *    heavy-hit low-angle hero shots, dodge tracking shots.
 *  - Cut cooldowns stop it from cutting too often; a 180-degree "side" is
 *    kept across cuts unless geometry forces a flip.
 *  - It also drives time: hit-stop on heavy hits, slow-mo around the kill.
 */
import * as THREE from 'three';
import type { Frame, MatchRecord, SimEvent } from '../sim/types';
import { CameraRig, camWorld } from './cameraRig';
import { getFighter } from '../sim/fighters';
import { generateArena, type ArenaLayout } from '../sim/arenaGen';

export type ShotName =
  | 'establish'
  | 'two_shot'
  | 'two_shot_low'
  | 'ots_0'
  | 'ots_1'
  | 'wide'
  | 'hero_0'
  | 'hero_1'
  | 'track_0'
  | 'track_1'
  | 'crane_0'
  | 'crane_1'
  | 'react_0'
  | 'react_1'
  | 'killcam'
  | 'victory'
  | 'destruct'
  | 'throw_0'
  | 'throw_1';

interface ShotState {
  name: ShotName;
  start: number; // real time
  dur: number;
  priority: number;
  smoothPos: number;
  smoothLook: number;
  /** per-shot random variation */
  seed: number;
}

export interface DirectorInput {
  realT: number;
  simT: number;
  frame: Frame;
  /** chest positions of both fighters */
  chest: [THREE.Vector3, THREE.Vector3];
  heads: [THREE.Vector3, THREE.Vector3];
  newEvents: SimEvent[];
}

const UP = new THREE.Vector3(0, 1, 0);

export class Director {
  rig: CameraRig;
  rec: MatchRecord;
  shot: ShotState;
  side = 1;
  lastCut = -99;
  /** Recent notable events for the debug overlay. */
  log: string[] = [];
  private killT = -1;
  private killStart = -1;
  private killer = -1;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private fov = 50;
  private hitStopUntil = -1; // real time
  private slowUntilSim = -1;
  private slowScale = 1;
  letterbox = false;
  /** Manual override: if set, the director only computes timeScale. */
  enabled = true;
  /** Fighter bulk (collision radius) for framing distances. */
  private size: [number, number];
  private victoryAngle = 0;
  /** arena geometry (regenerated from the record's arena spec) */
  private L: ArenaLayout;
  /** world point a destruction shot looks at */
  private focus = new THREE.Vector3();
  private focusH = 1;

  constructor(rig: CameraRig, rec: MatchRecord) {
    this.rig = rig;
    this.rec = rec;
    const kill = rec.events.find((e) => e.type === 'kill');
    if (kill) {
      this.killT = kill.t;
      this.killer = kill.a;
      const atk = [...rec.events].reverse().find((e) => e.type === 'attack_start' && e.a === kill.a && e.t <= kill.t);
      this.killStart = Math.max(atk ? atk.t : kill.t - 0.8, kill.t - 1.1);
    }
    this.size = [getFighter(rec.ids[0]).stats.radius, getFighter(rec.ids[1]).stats.radius];
    this.L = generateArena(rec.arena);
    this.shot = { name: 'establish', start: 0, dur: 2.5, priority: 0, smoothPos: 0.6, smoothLook: 0.4, seed: 0.5 };
  }

  /** Time scale for the playback clock (slow-mo + hit-stop). */
  timeScale(realT: number, simT: number): number {
    if (realT < this.hitStopUntil) return 0.02;
    let s = 1;
    if (this.killT > 0) {
      if (simT >= this.killStart && simT < this.killT) s = 0.22;
      else if (simT >= this.killT && simT < this.killT + 1.4) s = 0.12 + ((simT - this.killT) / 1.4) * 0.5;
      else if (simT >= this.killT + 1.4 && simT < this.killT + 2.2) s = 0.62 + ((simT - this.killT - 1.4) / 0.8) * 0.38;
    }
    if (simT < this.slowUntilSim) s = Math.min(s, this.slowScale);
    return s;
  }

  private request(name: ShotName, priority: number, dur: number, realT: number, opts: { force?: boolean; smoothPos?: number; smoothLook?: number } = {}) {
    const cur = this.shot;
    const elapsed = realT - cur.start;
    const cooldownOk = realT - this.lastCut > (priority >= 80 ? 0.25 : 1.3);
    const canInterrupt = priority > cur.priority || elapsed > Math.min(cur.dur, 1.6);
    if (!opts.force && (!cooldownOk || !canInterrupt)) return false;
    if (cur.name === name && elapsed < cur.dur) {
      cur.dur = Math.max(cur.dur, elapsed + dur);
      return true;
    }
    this.shot = { name, start: realT, dur, priority, smoothPos: opts.smoothPos ?? 0.12, smoothLook: opts.smoothLook ?? 0.08, seed: Math.random() };
    this.cutNext = true;
    this.log.unshift(`[cam] ${name}`);
    return true;
  }
  private cutNext = true;

  private chooseCoverage(inp: DirectorInput) {
    const f = inp.frame;
    const sep = Math.hypot(f.f[0].x - f.f[1].x, f.f[0].z - f.f[1].z);
    const ten = f.tension;
    const w: [ShotName, number][] = [
      ['two_shot', 3],
      ['two_shot_low', 1.5 + ten * 2],
      ['ots_0', sep < 6 ? 1.2 : 0.2],
      ['ots_1', sep < 6 ? 1.2 : 0.2],
      ['wide', sep > 6 ? 2 : 0.4],
    ];
    // don't repeat the same shot
    for (const x of w) if (x[0] === this.shot.name) x[1] *= 0.2;
    const sum = w.reduce((s, x) => s + x[1], 0);
    let r = Math.random() * sum;
    let pick: ShotName = 'two_shot';
    for (const [n, wt] of w) {
      r -= wt;
      if (r <= 0) {
        pick = n;
        break;
      }
    }
    const dur = (4.5 - ten * 2.2) * (0.8 + Math.random() * 0.5);
    // coverage-to-coverage at low tension blends instead of cutting
    const blend = ten < 0.45 && Math.random() < 0.5;
    this.shot = { name: pick, start: inp.realT, dur, priority: 10, smoothPos: blend ? 0.6 : 0.12, smoothLook: blend ? 0.4 : 0.08, seed: Math.random() };
    this.cutNext = !blend;
    if (this.cutNext && Math.random() < 0.2) this.side *= -1; // occasional reverse angle on a cut
    this.log.unshift(`[cam] ${pick}${blend ? ' (blend)' : ''}`);
  }

  update(inp: DirectorInput, dt: number) {
    const { realT, simT } = inp;
    // ---- event reactions
    for (const e of inp.newEvents) {
      const name = e.type;
      if (name !== 'attack_start' && name !== 'whiff') this.log.unshift(`${e.t.toFixed(1)} ${name}${e.a >= 0 ? ' ' + this.rec.ids[e.a] : ''}${e.data?.move ? ' ' + e.data.move : ''}`);
      switch (name) {
        case 'hit': {
          const heavy = !!e.data?.heavy;
          const ult = e.data?.kind === 'ultimate';
          if (heavy || ult) {
            this.hitStopUntil = realT + (ult ? 0.11 : 0.085);
            this.rig.addShake(ult ? 0.55 : 0.4);
            this.rig.punchFov(-4);
            if (!ult && simT < this.killStart - 1) this.request(e.a === 0 ? 'hero_0' : 'hero_1', 50, 1.6, realT);
          } else {
            this.hitStopUntil = Math.max(this.hitStopUntil, realT + 0.035);
            this.rig.addShake(0.16);
          }
          break;
        }
        case 'block':
          this.rig.addShake(0.1);
          break;
        case 'parry':
          this.hitStopUntil = realT + 0.12;
          this.rig.addShake(0.25);
          this.slowUntilSim = simT + 0.5;
          this.slowScale = 0.35;
          break;
        case 'guard_break':
          this.rig.addShake(0.35);
          break;
        case 'ability_used':
          if (simT < this.killStart - 0.5 || this.killStart < 0) {
            this.request(e.a === 0 ? 'hero_0' : 'hero_1', 85, 1.4, realT);
            this.slowUntilSim = simT + 0.5;
            this.slowScale = 0.45;
          }
          break;
        case 'knockdown':
          this.rig.addShake(0.3);
          if (simT < this.killStart - 1 || this.killStart < 0) this.request(e.a === 0 ? 'crane_0' : 'crane_1', 60, 1.8, realT);
          break;
        case 'wall_slam':
        case 'pillar_slam':
          this.rig.addShake(0.5);
          this.hitStopUntil = realT + 0.08;
          break;
        case 'dodge':
          if (Math.random() < 0.5) this.request(e.a === 0 ? 'track_0' : 'track_1', 35, 1.3, realT, { smoothPos: 0.1 });
          break;
        case 'last_stand':
        case 'second_wind':
          this.request(e.a === 0 ? 'react_0' : 'react_1', 75, 2.0, realT);
          break;
        case 'momentum_swing':
          this.request(e.a === 0 ? 'react_0' : 'react_1', 40, 1.6, realT);
          break;
        case 'stalemate_break':
        case 'arena_shrink':
        case 'sudden_death':
          this.request('wide', 45, 3, realT, { smoothPos: 0.8 });
          break;
        case 'prop_break':
          this.rig.addShake(0.3);
          break;
        // ---- destruction feeds the camera: cut to it, slow time so the fall reads, shake on impact
        case 'topple': {
          const o = this.L.obstacles[Number(e.data?.obs)];
          if (!o || (this.killStart > 0 && simT > this.killStart - 1.2)) break;
          const h = Number(e.data?.h ?? o.h);
          this.focus.set(o.x + Number(e.data?.dx) * h * 0.45, 0, o.z + Number(e.data?.dz) * h * 0.45);
          this.focusH = h * 0.35;
          if (this.request('destruct', 70, 2.2, realT)) {
            this.slowUntilSim = simT + 1.0;
            this.slowScale = 0.45;
          }
          break;
        }
        case 'topple_impact':
          this.rig.addShake(0.8);
          this.rig.punchFov(-5);
          this.hitStopUntil = realT + 0.06;
          break;
        case 'explosion':
          this.rig.addShake(0.9);
          this.rig.punchFov(-6);
          this.hitStopUntil = realT + 0.09;
          if (!(this.killStart > 0 && simT > this.killStart - 1.2)) {
            this.focus.set(Number(e.data?.x), 0, Number(e.data?.z));
            this.focusH = 1.2;
            if (this.request('destruct', 72, 1.6, realT)) {
              this.slowUntilSim = simT + 0.5;
              this.slowScale = 0.4;
            }
          }
          break;
        case 'chandelier_fall': {
          const h = this.L.hazards[Number(e.data?.haz)];
          if (!h || (this.killStart > 0 && simT > this.killStart - 1.2)) break;
          this.focus.set(h.x, 0, h.z);
          this.focusH = 3.2;
          if (this.request('destruct', 70, 1.8, realT)) {
            this.slowUntilSim = simT + 0.55;
            this.slowScale = 0.45;
          }
          break;
        }
        case 'chandelier_impact':
          this.rig.addShake(0.7);
          break;
        case 'throw_start':
          if (simT < this.killStart - 1.5 || this.killStart < 0) this.request(e.a === 0 ? 'throw_0' : 'throw_1', 55, 1.5, realT);
          break;
        case 'prop_hit':
          this.hitStopUntil = realT + 0.08;
          this.rig.addShake(0.45);
          break;
        case 'crush':
        case 'hazard_hit':
          this.rig.addShake(0.5);
          this.hitStopUntil = realT + 0.07;
          break;
      }
    }
    if (this.log.length > 14) this.log.length = 14;

    // ---- kill cam / victory (known ahead of time)
    if (this.killT > 0) {
      if (simT >= this.killStart && simT < this.killT + 1.6 && this.shot.name !== 'killcam') {
        this.request('killcam', 100, 99, realT, { force: true });
        this.letterbox = true;
      }
      if (simT >= this.killT + 1.6 && this.shot.name !== 'victory') {
        this.request('victory', 101, 99, realT, { force: true, smoothPos: 0.5, smoothLook: 0.3 });
      }
      if (simT >= this.killT && simT < this.killT + 0.05) {
        this.rig.addShake(0.7);
        this.rig.punchFov(-6);
      }
    }

    if (realT - this.shot.start > this.shot.dur && this.shot.priority < 100) this.chooseCoverage(inp);

    if (!this.enabled) return;
    this.rig.subjects = [inp.chest[0], inp.chest[1]];
    this.computeShot(inp);
    if (this.cutNext) {
      this.rig.cut(this.pos, this.look, this.fov);
      this.lastCut = realT;
      this.cutNext = false;
    }
    this.rig.smoothPos = this.shot.smoothPos;
    this.rig.smoothLook = this.shot.smoothLook;
    this.rig.update(this.pos, this.look, this.fov, dt);
  }

  private computeShot(inp: DirectorInput) {
    const f = inp.frame;
    const A = new THREE.Vector3(f.f[0].x, 0, f.f[0].z);
    const B = new THREE.Vector3(f.f[1].x, 0, f.f[1].z);
    const mid = A.clone().add(B).multiplyScalar(0.5);
    const axis = B.clone().sub(A);
    const sep = Math.max(0.5, axis.length());
    axis.normalize();
    const perp = new THREE.Vector3(-axis.z, 0, axis.x);
    // keep the camera on the side facing the arena centre when near walls
    const toCenter = mid.clone().negate();
    if (mid.length() > 4 && perp.dot(toCenter) * this.side < 0 && this.cutNext) this.side *= -1;
    perp.multiplyScalar(this.side);
    const s = this.shot;
    const t = inp.realT - s.start;
    const chest = inp.chest;
    const P = this.pos,
      L = this.look;
    switch (s.name) {
      case 'establish': {
        // high, slow crane around the bowl, steep enough to clear the braziers
        // sit between pillars (they stand at 45° multiples)
        const base = Math.round(Math.atan2(perp.z, perp.x) / (Math.PI / 2)) * (Math.PI / 2);
        const a = base - 0.15 + t * 0.06;
        const R = camWorld.boundR(Math.cos(a), Math.sin(a)) * 0.85;
        P.set(Math.cos(a) * R, Math.max(9.5, camWorld.wallH + 5) - Math.min(2, t * 0.6), Math.sin(a) * R);
        L.copy(mid).multiplyScalar(0.6);
        L.y = 0.6;
        this.fov = 50;
        break;
      }
      case 'two_shot':
      case 'two_shot_low': {
        const low = s.name === 'two_shot_low';
        const dist = Math.min(11, Math.max(4.2, sep * 0.95 + (low ? 2.6 : 3.6)));
        const orbit = Math.sin(t * 0.25 + s.seed * 6) * 0.35;
        const dir = perp.clone().applyAxisAngle(UP, orbit);
        P.copy(mid).addScaledVector(dir, dist);
        P.y = low ? 0.75 : 2.1 + sep * 0.08;
        L.copy(mid);
        L.y = low ? 1.5 : 1.15;
        this.fov = low ? 48 : 44;
        break;
      }
      case 'wide': {
        const dir = perp.clone().applyAxisAngle(UP, Math.sin(t * 0.15) * 0.3);
        P.copy(mid).addScaledVector(dir, Math.max(8, sep + 6));
        P.y = 5.5;
        L.copy(mid);
        L.y = 0.8;
        this.fov = 50;
        break;
      }
      case 'ots_0':
      case 'ots_1': {
        const i = s.name === 'ots_0' ? 0 : 1;
        const me = i === 0 ? A : B,
          them = i === 0 ? B : A;
        const fwd = them.clone().sub(me).normalize();
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x).multiplyScalar(this.side * (i === 0 ? 1 : -1));
        const big = this.size[i] / 0.6;
        P.copy(me).addScaledVector(fwd, -2.2 - big * 1.3).addScaledVector(right, 0.9 + big * 0.7);
        P.y = 1.7 + big * 0.5;
        L.copy(chest[1 - i]);
        L.y -= 0.15;
        this.fov = 46;
        break;
      }
      case 'hero_0':
      case 'hero_1': {
        const i = s.name === 'hero_0' ? 0 : 1;
        const me = i === 0 ? A : B,
          them = i === 0 ? B : A;
        const fwd = them.clone().sub(me).normalize();
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x).multiplyScalar(this.side * (i === 0 ? 1 : -1));
        // low, in front-side of the attacker, looking up past them to the target
        P.copy(me).addScaledVector(fwd, 1.2 + t * 0.2).addScaledVector(right, 2.6 - t * 0.3);
        P.y = 0.45;
        L.copy(chest[i]).lerp(chest[1 - i], 0.35);
        L.y += 0.25;
        this.fov = 40 - Math.min(6, t * 4);
        break;
      }
      case 'track_0':
      case 'track_1': {
        const i = s.name === 'track_0' ? 0 : 1;
        const me = i === 0 ? A : B;
        P.copy(me).addScaledVector(perp, 3.6);
        P.y = 1.3;
        L.copy(chest[i]).lerp(chest[1 - i], 0.3);
        this.fov = 46;
        break;
      }
      case 'crane_0':
      case 'crane_1': {
        // crane up over the fighter who caused the knockdown, looking at the victim
        const victim = s.name === 'crane_0' ? B : A;
        P.copy(victim).addScaledVector(perp, 2.5 + t * 0.8).addScaledVector(axis, s.name === 'crane_0' ? 1.5 : -1.5);
        P.y = Math.min(6.5, 4.2 + t * 1.5);
        L.copy(victim);
        L.y = 0.5;
        this.fov = 46;
        break;
      }
      case 'react_0':
      case 'react_1': {
        const i = s.name === 'react_0' ? 0 : 1;
        const me = i === 0 ? A : B,
          them = i === 0 ? B : A;
        const fwd = them.clone().sub(me).normalize();
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x).multiplyScalar(this.side * (i === 0 ? 1 : -1));
        P.copy(me).addScaledVector(fwd, 2.4).addScaledVector(right, 1.1);
        P.y = inp.heads[i].y - 0.2;
        L.copy(inp.heads[i]);
        L.y -= 0.15;
        this.fov = 34 - Math.min(4, t * 2);
        break;
      }
      case 'killcam': {
        // slow-mo punch-in on the impact, low and from the side
        const k = Math.min(1, t / 2.2);
        const impact = chest[0].clone().lerp(chest[1], 0.5);
        this.fov = 40 - k * 8;
        // distance so both fighters stay in frame at the final (narrow) fov
        const halfH = Math.atan(Math.tan((this.fov * Math.PI) / 360) * this.rig.cam.aspect);
        const dist = Math.max(2.6, (sep / 2 + 1.1) / Math.tan(halfH)) * (1.12 - k * 0.12);
        P.copy(mid).addScaledVector(perp, dist).addScaledVector(axis, (this.killer === 0 ? -1 : 1) * 0.6);
        P.y = 0.75 + k * 0.15;
        L.copy(impact);
        break;
      }
      case 'destruct': {
        // stand off to the side of the event, low enough to feel the weight, both fighters ideally in frame
        const toF = this.focus.clone().sub(mid);
        const side = toF.lengthSq() > 0.01 ? new THREE.Vector3(-toF.z, 0, toF.x).normalize() : perp.clone();
        if (side.dot(perp) < 0) side.negate();
        P.copy(this.focus).lerp(mid, 0.35).addScaledVector(side, 7.5 + t * 0.4);
        P.y = 2.0 + this.focusH * 0.4;
        L.copy(this.focus).lerp(mid, 0.25);
        L.y = this.focusH;
        this.fov = 48 - Math.min(5, t * 3);
        break;
      }
      case 'throw_0':
      case 'throw_1': {
        // behind the thrower's shoulder: watch the prop fly at the target
        const i = s.name === 'throw_0' ? 0 : 1;
        const me = i === 0 ? A : B,
          them = i === 0 ? B : A;
        const fwd = them.clone().sub(me).normalize();
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x).multiplyScalar(this.side);
        P.copy(me).addScaledVector(fwd, -3.2).addScaledVector(right, 1.6);
        P.y = 2.4;
        L.copy(me).lerp(them, 0.6);
        L.y = 1.3;
        this.fov = 50;
        break;
      }
      case 'victory': {
        const w = this.killer >= 0 ? this.killer : 0;
        const me = w === 0 ? A : B,
          loser = w === 0 ? B : A;
        if (t < 0.05 || this.victoryAngle === 0) {
          // start on the far side of the winner from the fallen loser
          const away = me.clone().sub(loser);
          this.victoryAngle = Math.atan2(away.z, away.x) + 0.6;
        }
        const a = this.victoryAngle + Math.sin(t * 0.25) * 0.9;
        P.set(me.x + Math.cos(a) * 3.8, 1.0 + Math.min(1.0, t * 0.2), me.z + Math.sin(a) * 3.8);
        L.copy(inp.chest[w]);
        L.y += 0.3;
        this.fov = 40;
        break;
      }
    }
  }

  /** True once the killing-blow sequence has begun (suppress minor UI). */
  inKillSequence(simT: number) {
    return this.killStart > 0 && simT >= this.killStart;
  }

  get shotName(): string {
    return this.shot.name;
  }
}

