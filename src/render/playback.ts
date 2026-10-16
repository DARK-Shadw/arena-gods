/**
 * Playback of a pre-simulated MatchRecord. The renderer never runs the sim
 * live: it samples recorded frames (interpolated) at a playback clock that the
 * director can slow down (slow-mo) or freeze (hit-stop). Because the whole
 * fight is known up front, the camera can anticipate the killing blow.
 */
import type { FighterFrame, Frame, MatchRecord, SimEvent } from '../sim/types';

function lerpAngle(a: number, b: number, t: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function lerpFighter(a: FighterFrame, b: FighterFrame, t: number): FighterFrame {
  const near = t < 0.5 ? a : b;
  return {
    ...near,
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    y: a.y + (b.y - a.y) * t,
    vx: a.vx + (b.vx - a.vx) * t,
    vz: a.vz + (b.vz - a.vz) * t,
    facing: lerpAngle(a.facing, b.facing, t),
    hp: a.hp + (b.hp - a.hp) * t,
    stamina: a.stamina + (b.stamina - a.stamina) * t,
    fury: a.fury + (b.fury - a.fury) * t,
    // phase progress interpolates only within the same phase
    phaseT: a.phase === b.phase && a.state === b.state ? a.phaseT + (b.phaseT - a.phaseT) * t : near.phaseT,
    stateT: a.state === b.state ? a.stateT + (b.stateT - a.stateT) * t : near.stateT,
  };
}

/** props: [x,y,z,state,hp,rot] x n - positions interpolate while the state is unchanged */
function lerpProps(a: Float32Array, b: Float32Array, k: number): Float32Array {
  if (a.length !== b.length) return k < 0.5 ? a : b;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i += 6) {
    const same = a[i + 3] === b[i + 3];
    const src = k < 0.5 ? a : b;
    for (let j = 0; j < 6; j++) out[i + j] = same && j !== 3 && j !== 4 ? a[i + j] + (b[i + j] - a[i + j]) * k : src[i + j];
  }
  return out;
}

export class Playback {
  rec: MatchRecord;
  t = 0;
  private evIdx = 0;
  readonly duration: number;

  constructor(rec: MatchRecord) {
    this.rec = rec;
    this.duration = rec.frames[rec.frames.length - 1].t;
  }

  get done() {
    return this.t >= this.duration;
  }

  frameAt(t: number): Frame {
    const fr = this.rec.frames;
    const x = t / this.rec.dt - 1;
    const i = Math.max(0, Math.min(fr.length - 1, Math.floor(x)));
    const j = Math.min(fr.length - 1, i + 1);
    const k = Math.max(0, Math.min(1, x - i));
    const a = fr[i],
      b = fr[j];
    return {
      t,
      f: [lerpFighter(a.f[0], b.f[0], k), lerpFighter(a.f[1], b.f[1], k)],
      ringS: a.ringS + (b.ringS - a.ringS) * k,
      tension: a.tension + (b.tension - a.tension) * k,
      momentum: a.momentum + (b.momentum - a.momentum) * k,
      props: lerpProps(a.props, b.props, k),
      obs: k < 0.5 ? a.obs : b.obs,
      haz: k < 0.5 ? a.haz : b.haz,
      proj: a.proj.map((pa) => {
        const pb = b.proj.find((x) => x.id === pa.id);
        return pb ? { ...pa, x: pa.x + (pb.x - pa.x) * k, y: pa.y + (pb.y - pa.y) * k, z: pa.z + (pb.z - pa.z) * k } : pa;
      }),
    };
  }

  /** Advance the clock; returns events that fired in (old, new]. */
  advance(dt: number): SimEvent[] {
    const old = this.t;
    this.t = Math.min(this.duration, this.t + dt);
    const out: SimEvent[] = [];
    const ev = this.rec.events;
    while (this.evIdx < ev.length && ev[this.evIdx].t <= this.t) {
      if (ev[this.evIdx].t > old || old === 0) out.push(ev[this.evIdx]);
      this.evIdx++;
    }
    return out;
  }

  seek(t: number) {
    this.t = Math.max(0, Math.min(this.duration, t));
    this.evIdx = 0;
    while (this.evIdx < this.rec.events.length && this.rec.events[this.evIdx].t <= this.t) this.evIdx++;
  }
}
