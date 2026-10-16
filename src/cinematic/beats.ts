/**
 * ARENA-AWARE ENTRANCES: beats instead of absolute keyframes.
 *
 * A variant declares what it NEEDS from the gate's StageAnchors (a real perch,
 * a barrier to break, a rim to climb, stands...). The first variants whose
 * needs pass are candidates (seeded pick); the chosen one is compiled into a
 * sequence of beats. Each beat plays a clip (own or shared-library) and moves
 * the actor (hold / eased path / the clip's own ROOT curve with an optional
 * vertical drop or climb profile). Physical cues are bound to the clip's
 * measured IMPACT frames (fist on bars, axe into the gate, feet landing) so a
 * gate cannot break before something visibly hits it.
 */
import * as THREE from 'three';
import type { GateAnchors, V3 } from '../render/arena/arenaView';
import type { CamShot, Mood } from '../data/entrances';
import type { EaseName } from './timeline';

export interface BeatCue {
  /** seconds into the beat, or the n-th measured impact of the beat's clip */
  at: number | { impact: number; effector?: string };
  fx?: string;
  sfx?: string;
  arg?: number;
  dur?: number;
  /** validator: this cue is a physical barrier event - which part of the actor causes it */
  cause?: 'hands' | 'tip' | 'body' | 'feet';
}

export type BeatMove =
  | { type: 'hold' }
  | { type: 'lerp'; to: V3; ease?: EaseName; arc?: number }
  /** follow the clip's root curve (scaled by the actor's hips height); y: vertical profile in clip time */
  | { type: 'root'; scale?: number; y?: { from: number; to: number; t0: number; t1: number; curve?: 'fall' | 'rise' | 'smooth' } };

export interface Beat {
  dur: number;
  /** state for FighterView.updateManual: idle | run | crouch | roar | taunt | land | clip ... */
  state: string;
  clip?: string;
  /** clip time at the beat start and playback rate */
  from?: number;
  rate?: number;
  move: BeatMove;
  /** facing, radians in the gate frame (0 = into the arena) */
  yaw?: number;
  /** airborne (validator skips the support check) */
  air?: boolean;
  /** intentionally out of sight (rising from under the floor...): validator skips framing checks */
  hidden?: boolean;
  /** root height for the NEXT beat (a clip that climbs up ends higher than its root) */
  exitY?: number;
  cues?: BeatCue[];
  /** procedural shake pulses on the actor (spring impulses), seconds into the beat */
  pulses?: number[];
}

export interface CompiledEntrance {
  id: string;
  start: V3;
  beats: Beat[];
  camera: CamShot[];
  cues: { t: number; fx?: string; sfx?: string; arg?: number; dur?: number }[];
  mood: Mood;
  title: number;
  duration: number;
}

export interface VariantCtx {
  A: GateAnchors;
  /** pose probe on the actual rig: joint positions (character space) at a clip time */
  probe: (clip: string, t: number, joints: string[]) => Record<string, THREE.Vector3>;
  hipsM: number;
  /** measured impacts of a clip (seconds) */
  impacts: (clip: string) => number[];
  /** clip duration */
  dur: (clip: string) => number;
  /** fighter height (m) */
  height: number;
  /** nearest point to p (gate frame) clear of cover / props / hazards */
  free: (p: V3) => V3;
}

export interface EntranceVariant {
  id: string;
  needs: (A: GateAnchors) => boolean;
  build: (c: VariantCtx) => CompiledEntrance;
}

/** start time of each beat */
export function beatTimes(beats: Beat[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (const b of beats) {
    out.push(t);
    t += b.dur;
  }
  out.push(t);
  return out;
}
