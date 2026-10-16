/**
 * Data-driven entrance choreography (Shadow-of-War style intros).
 *
 * All positions are in GATE-LOCAL space so the same entrance works from
 * either gate:  x = right (looking into the arena), y = up,
 * z = distance into the arena from the gate opening (negative = inside the
 * tunnel / outside the wall). The fighter's starting mark is z ≈ 8.
 *
 * Tracks:
 *  - actor:  keyframes; between key i and i+1 the actor moves (eased) and plays
 *            key i's state ('idle'/'relaxed'/'run' locomote if moving, 'crouch',
 *            'airborne', 'land', 'kneel', 'roar', 'taunt', or 'clip' + clip name;
 *            these map to the fighter's Mixamo clips in data/animsets.ts).
 *  - camera: shots with from/to poses (look may be 'actor' chest or 'head').
 *  - cues:   one-shot fx / sfx triggers (see cinematic/entrance.ts handlers).
 *  - mood:   lighting preset for the whole entrance.
 */
import type { EaseName } from '../cinematic/timeline';

export type V3 = [number, number, number];
export interface ActorKey {
  t: number;
  pos: V3;
  state: string;
  /** Clip name for state 'clip' / 'attack'. */
  clip?: string;
  phase?: number;
  ease?: EaseName;
  /** Jump arc height added over the segment. */
  arc?: number;
}
export interface CamPose {
  pos: V3;
  look: V3 | 'actor' | 'head';
  fov: number;
}
export interface CamShot {
  t: number;
  dur: number;
  from: CamPose;
  to: CamPose;
  ease?: EaseName;
}
export interface Cue {
  t: number;
  fx?: string;
  sfx?: string;
  arg?: number;
  dur?: number;
}
export interface Mood {
  moon: number;
  hemi: number;
  fog: number;
  gateColor: string;
  spot: number;
}
export interface EntranceSpec {
  duration: number;
  mood: Mood;
  title: number;
  actor: ActorKey[];
  camera: CamShot[];
  cues: Cue[];
}

export const ENTRANCES: Record<string, EntranceSpec> = {
  // Gorak smashes through the portcullis, stomps out and roars.
  gorak: {
    duration: 9,
    title: 5.4,
    mood: { moon: 0.52, hemi: 0.47, fog: 0.034, gateColor: '#ff4a1a', spot: 0 },
    actor: [
      { t: 0, pos: [0, 0, -4], state: 'idle' },
      { t: 2.15, pos: [0, 0, -3.6], state: 'run' },
      { t: 3.1, pos: [0, 0, 2.6], state: 'idle', ease: 'out' },
      { t: 5.2, pos: [0, 0, 7.6], state: 'roar' },
      { t: 7.0, pos: [0, 0, 7.6], state: 'taunt' },
      { t: 9, pos: [0, 0, 7.6], state: 'taunt' },
    ],
    camera: [
      { t: 0, dur: 2.2, from: { pos: [2.6, 0.6, 9], look: [0, 2.2, 0], fov: 50 }, to: { pos: [1.9, 0.5, 7.6], look: [0, 2.4, 0], fov: 44 } },
      { t: 2.2, dur: 1.2, from: { pos: [3.8, 0.9, 6.8], look: 'actor', fov: 58 }, to: { pos: [3.2, 0.8, 6.2], look: 'actor', fov: 52 } },
      { t: 3.4, dur: 1.8, from: { pos: [-2.6, 0.4, 10.8], look: 'actor', fov: 44 }, to: { pos: [-1.9, 0.35, 10.2], look: 'actor', fov: 40 } },
      { t: 5.2, dur: 1.8, from: { pos: [1.3, 2.0, 11.4], look: 'head', fov: 36 }, to: { pos: [1.0, 1.9, 10.8], look: 'head', fov: 32 } },
      { t: 7.0, dur: 2.0, from: { pos: [-2.2, 0.5, 11.6], look: 'actor', fov: 40 }, to: { pos: [-2.7, 0.7, 12.2], look: 'actor', fov: 42 } },
    ],
    cues: [
      { t: 0.3, sfx: 'drum', fx: 'gate_shake' },
      { t: 0.95, sfx: 'drum', fx: 'gate_shake' },
      { t: 1.55, sfx: 'drum', fx: 'gate_shake' },
      { t: 2.15, sfx: 'crash', fx: 'gate_smash' },
      { t: 2.2, fx: 'gate_light' },
      { t: 2.3, sfx: 'gasp' },
      { t: 3.6, sfx: 'thud', fx: 'step_dust' },
      { t: 4.3, sfx: 'thud', fx: 'step_dust' },
      { t: 5.25, sfx: 'roar', fx: 'embers_burst' },
      { t: 5.6, sfx: 'stinger_dread' },
      { t: 6.4, sfx: 'cheer' },
    ],
  },
  // Vex waits on top of the gate, drops in a burst of smoke, slips forward.
  vex: {
    duration: 8,
    title: 5.0,
    mood: { moon: 1.00, hemi: 0.31, fog: 0.04, gateColor: '#8a5cff', spot: 0 },
    actor: [
      { t: 0, pos: [0, 5.35, 0.1], state: 'crouch' },
      { t: 2.0, pos: [0, 5.35, 0.3], state: 'airborne', arc: 1.2, ease: 'linear' },
      { t: 2.7, pos: [0, 0, 4.6], state: 'land' },
      { t: 3.7, pos: [0, 0, 4.6], state: 'idle', ease: 'inOut' },
      { t: 4.8, pos: [0, 0, 7.6], state: 'taunt' },
      { t: 8, pos: [0, 0, 7.6], state: 'taunt' },
    ],
    camera: [
      { t: 0, dur: 2.0, from: { pos: [2.0, 1.0, 8.5], look: [0, 5.4, 0], fov: 42 }, to: { pos: [1.6, 1.1, 7.3], look: [0, 5.7, 0], fov: 34 } },
      { t: 2.0, dur: 0.75, from: { pos: [4.2, 1.6, 6.2], look: 'actor', fov: 52 }, to: { pos: [3.8, 1.0, 6.0], look: 'actor', fov: 50 } },
      { t: 2.75, dur: 1.25, from: { pos: [1.5, 0.4, 7.3], look: 'actor', fov: 40 }, to: { pos: [1.2, 0.35, 6.9], look: 'actor', fov: 34 } },
      { t: 4.0, dur: 1.0, from: { pos: [-3.0, 1.2, 9.4], look: 'actor', fov: 45 }, to: { pos: [-2.6, 1.0, 10.2], look: 'actor', fov: 44 } },
      { t: 5.0, dur: 3.0, from: { pos: [0.9, 1.15, 9.6], look: 'head', fov: 34 }, to: { pos: [1.4, 1.0, 10.2], look: 'head', fov: 38 } },
    ],
    cues: [
      { t: 0.2, sfx: 'whisper' },
      { t: 1.2, fx: 'eyes_glint' },
      { t: 2.0, sfx: 'whoosh' },
      { t: 2.7, sfx: 'thud', fx: 'smoke_burst' },
      { t: 2.75, sfx: 'gasp' },
      { t: 3.7, fx: 'shadow_trail', dur: 1.1 },
      { t: 3.8, sfx: 'whoosh' },
      { t: 5.0, sfx: 'stinger_intro' },
      { t: 5.6, sfx: 'cheer' },
    ],
  },
  // Aldric: portcullis rises, he marches in to war drums and bangs his shield.
  aldric: {
    duration: 8.5,
    title: 5.4,
    mood: { moon: 0.92, hemi: 0.60, fog: 0.026, gateColor: '#7cc4ff', spot: 0.35 },
    actor: [
      { t: 0, pos: [0, 0, -3], state: 'idle' },
      { t: 1.4, pos: [0, 0, -3], state: 'idle', ease: 'linear' },
      { t: 5.0, pos: [0, 0, 7.6], state: 'taunt' },
      { t: 8.5, pos: [0, 0, 7.6], state: 'taunt' },
    ],
    camera: [
      { t: 0, dur: 1.6, from: { pos: [0, 1.5, 7], look: [0, 1.8, -1], fov: 45 }, to: { pos: [0, 1.35, 6], look: [0, 1.6, -2], fov: 42 } },
      { t: 1.6, dur: 1.8, from: { pos: [-1.4, 0.9, 6.0], look: 'actor', fov: 40 }, to: { pos: [-1.2, 0.8, 7.0], look: 'actor', fov: 40 } },
      { t: 3.4, dur: 1.6, from: { pos: [0.9, 1.9, 0.6], look: 'actor', fov: 52 }, to: { pos: [0.9, 1.9, 4.6], look: 'actor', fov: 50 } },
      { t: 5.0, dur: 3.5, from: { pos: [1.6, 0.5, 10.2], look: 'head', fov: 36 }, to: { pos: [2.0, 0.6, 10.9], look: 'actor', fov: 40 } },
    ],
    cues: [
      { t: 0.1, fx: 'gate_open', dur: 1.4, sfx: 'chain' },
      { t: 0.2, fx: 'gate_light' },
      ...[1.4, 1.95, 2.5, 3.05, 3.6, 4.15, 4.7].map((t) => ({ t, sfx: 'drum', fx: 'step_dust' })),
      { t: 5.3, sfx: 'clang', fx: 'shield_spark' },
      { t: 5.62, sfx: 'clang', fx: 'shield_spark' },
      { t: 5.94, sfx: 'clang', fx: 'shield_spark' },
      { t: 5.5, sfx: 'stinger_intro' },
      { t: 6.3, sfx: 'cheer' },
    ],
  },
  // Erika: torches ignite one by one along her path; she walks in slowly,
  // kneels, draws an arrow and sights down it at the crowd.
  erika: {
    duration: 9,
    title: 6.6,
    mood: { moon: 0.44, hemi: 0.31, fog: 0.03, gateColor: '#ffd66b', spot: 0 },
    actor: [
      { t: 0, pos: [0, 0, -3], state: 'relaxed' },
      { t: 1.0, pos: [0, 0, -3], state: 'relaxed', ease: 'linear' },
      { t: 5.2, pos: [0, 0, 7.2], state: 'kneel' },
      { t: 6.4, pos: [0, 0, 7.2], state: 'roar' },
      { t: 7.4, pos: [0, 0, 7.2], state: 'taunt' },
      { t: 9, pos: [0, 0, 7.4], state: 'taunt' },
    ],
    camera: [
      { t: 0, dur: 2.5, from: { pos: [-2.2, 1.0, 9.5], look: [0, 1.4, 0], fov: 42 }, to: { pos: [-1.6, 0.9, 8.6], look: 'actor', fov: 40 } },
      { t: 2.5, dur: 2.7, from: { pos: [3.8, 1.0, 2.4], look: 'actor', fov: 40 }, to: { pos: [3.6, 0.9, 6.4], look: 'actor', fov: 38 } },
      { t: 5.2, dur: 1.4, from: { pos: [0.65, 0.65, 8.7], look: 'head', fov: 30 }, to: { pos: [0.55, 0.6, 8.5], look: 'head', fov: 27 } },
      { t: 6.6, dur: 2.4, from: { pos: [0.4, 0.3, 9.6], look: 'head', fov: 40 }, to: { pos: [0.9, 0.3, 10.8], look: [0, 2.5, 7.2], fov: 44 } },
    ],
    cues: [
      ...[0, 1, 2, 3, 4, 5].map((i) => ({ t: 0.35 + i * 0.32, fx: 'torch_path', arg: i, sfx: 'fire' })),
      { t: 0.4, fx: 'gate_light' },
      { t: 1.5, sfx: 'drum' },
      { t: 3.0, sfx: 'drum' },
      { t: 4.5, sfx: 'drum' },
      { t: 5.25, sfx: 'thud' },
      { t: 6.6, sfx: 'stinger_intro', fx: 'holy_burst' },
      { t: 7.2, sfx: 'cheer' },
    ],
  },
  // Ozrel rises out of a pillar of fire in the middle of the sand.
  ozrel: {
    duration: 8.5,
    title: 4.5,
    mood: { moon: 0.39, hemi: 0.28, fog: 0.035, gateColor: '#ff7a18', spot: 0 },
    actor: [
      { t: 0, pos: [0, -2.4, 6.6], state: 'roar' },
      { t: 1.2, pos: [0, -2.4, 6.6], state: 'roar', ease: 'out' },
      { t: 2.7, pos: [0, 0, 6.6], state: 'idle' },
      { t: 3.2, pos: [0, 0, 6.6], state: 'idle', ease: 'inOut' },
      { t: 4.3, pos: [0, 0, 7.6], state: 'taunt' },
      { t: 8.5, pos: [0, 0, 7.6], state: 'taunt' },
    ],
    camera: [
      { t: 0, dur: 1.2, from: { pos: [2.5, 0.5, 11.2], look: [0, 0.3, 6.6], fov: 45 }, to: { pos: [2.2, 0.45, 10.6], look: [0, 0.2, 6.6], fov: 42 } },
      { t: 1.2, dur: 2.0, from: { pos: [3.6, 0.3, 9.8], look: [0, 2.6, 6.6], fov: 52 }, to: { pos: [3.0, 0.4, 9.2], look: 'head', fov: 44 } },
      { t: 3.2, dur: 1.2, from: { pos: [-2.6, 1.2, 10], look: 'actor', fov: 42 }, to: { pos: [-2.2, 1.1, 10.5], look: 'actor', fov: 40 } },
      { t: 4.4, dur: 4.1, from: { pos: [0.9, 1.3, 9.6], look: 'head', fov: 34 }, to: { pos: [1.3, 1.0, 10.2], look: 'head', fov: 36 } },
    ],
    cues: [
      { t: 0.1, fx: 'ground_embers', dur: 1.1 },
      { t: 1.2, fx: 'fire_pillar', dur: 2.1, sfx: 'fire_big' },
      { t: 1.25, sfx: 'gasp' },
      { t: 1.3, fx: 'gate_light' },
      { t: 4.3, fx: 'palm_fire', dur: 4.2, sfx: 'fire' },
      { t: 4.5, sfx: 'stinger_intro' },
      { t: 5.2, sfx: 'cheer' },
    ],
  },
  // Fenrik: green eyes in the dark tunnel, then a huge leap out of the shadows.
  fenrik: {
    duration: 8,
    title: 5.0,
    mood: { moon: 0.71, hemi: 0.28, fog: 0.04, gateColor: '#8bff5a', spot: 0 },
    actor: [
      { t: 0, pos: [0, 0, -3.6], state: 'crouch' },
      { t: 2.0, pos: [0, 0, -3.2], state: 'airborne', arc: 2.2, ease: 'linear' },
      { t: 2.85, pos: [0, 0, 4.2], state: 'land' },
      { t: 3.3, pos: [0, 0, 4.2], state: 'idle', ease: 'inOut' },
      { t: 4.8, pos: [0, 0, 7.6], state: 'taunt' },
      { t: 8, pos: [0, 0, 7.6], state: 'taunt' },
    ],
    camera: [
      { t: 0, dur: 2.0, from: { pos: [0.2, 1.1, 4.2], look: [0, 0.9, -3.6], fov: 36 }, to: { pos: [0.15, 1.05, 3.0], look: [0, 0.85, -3.6], fov: 30 } },
      { t: 2.0, dur: 1.0, from: { pos: [3.4, 0.5, 5.6], look: 'actor', fov: 56 }, to: { pos: [3.1, 0.4, 5.0], look: 'actor', fov: 52 } },
      { t: 3.0, dur: 1.9, from: { pos: [-1.8, 0.35, 8.6], look: 'actor', fov: 40 }, to: { pos: [-1.6, 0.3, 9.6], look: 'actor', fov: 38 } },
      { t: 4.9, dur: 3.1, from: { pos: [1.5, 1.3, 10.6], look: 'head', fov: 38 }, to: { pos: [1.9, 1.1, 11.2], look: 'head', fov: 40 } },
    ],
    cues: [
      { t: 0.3, sfx: 'growl' },
      { t: 0.5, fx: 'eyes_glint' },
      { t: 1.55, fx: 'gate_open', dur: 0.4, sfx: 'chain' },
      { t: 2.0, sfx: 'roar_short', fx: 'gate_light' },
      { t: 2.85, sfx: 'thud', fx: 'dust_land' },
      { t: 2.9, sfx: 'gasp' },
      { t: 4.9, sfx: 'howl' },
      { t: 5.2, sfx: 'stinger_dread' },
      { t: 6.0, sfx: 'cheer' },
    ],
  },
  // Maw: the great gate grinds open; the floor shakes with every step; it roars.
  maw: {
    duration: 9,
    title: 6.6,
    mood: { moon: 0.35, hemi: 0.25, fog: 0.04, gateColor: '#b07bff', spot: 0 },
    actor: [
      { t: 0, pos: [0, 0, -4], state: 'idle' },
      { t: 1.2, pos: [0, 0, -4], state: 'relaxed', ease: 'linear' },
      { t: 6.4, pos: [0, 0, 7.4], state: 'roar' },
      { t: 9, pos: [0, 0, 7.4], state: 'roar' },
    ],
    camera: [
      { t: 0, dur: 1.6, from: { pos: [0, 1.2, 7], look: [0, 2.2, -1], fov: 45 }, to: { pos: [0, 1.0, 6], look: [0, 2.0, -2], fov: 42 } },
      { t: 1.6, dur: 2.4, from: { pos: [-1.6, 0.3, 6.5], look: 'head', fov: 46 }, to: { pos: [-1.4, 0.3, 7.5], look: 'head', fov: 44 } },
      { t: 4.0, dur: 2.4, from: { pos: [3.8, 1.3, 3.0], look: 'actor', fov: 46 }, to: { pos: [3.4, 1.3, 6.2], look: 'actor', fov: 46 } },
      { t: 6.4, dur: 2.6, from: { pos: [1.3, 1.7, 11.2], look: 'head', fov: 40 }, to: { pos: [1.1, 1.6, 10.6], look: 'head', fov: 35 } },
    ],
    cues: [
      { t: 0.1, fx: 'gate_open', dur: 1.6, sfx: 'chain' },
      { t: 0.2, fx: 'gate_light' },
      ...[1.6, 2.45, 3.3, 4.15, 5.0, 5.85].map((t) => ({ t, sfx: 'thud', fx: 'step_dust' })),
      { t: 2.0, sfx: 'gasp' },
      { t: 6.5, sfx: 'roar', fx: 'embers_burst' },
      { t: 6.9, sfx: 'stinger_dread' },
      { t: 7.6, sfx: 'cheer' },
    ],
  },
  // Hollowjack: bursts out of the crowd, leaps from the stands, lands hard.
  hollowjack: {
    duration: 8.5,
    title: 4.8,
    mood: { moon: 0.45, hemi: 0.3, fog: 0.03, gateColor: '#ff8a1a', spot: 0 },
    actor: [
      { t: 0, pos: [3.5, 5.0, -2.5], state: 'crouch' },
      { t: 1.8, pos: [3.5, 5.0, -2.5], state: 'airborne', arc: 1.6, ease: 'linear' },
      { t: 2.7, pos: [0.5, 0, 5], state: 'land' },
      { t: 3.6, pos: [0.5, 0, 5], state: 'idle', ease: 'inOut' },
      { t: 4.6, pos: [0, 0, 7.6], state: 'taunt' },
      { t: 8.5, pos: [0, 0, 7.6], state: 'taunt' },
    ],
    camera: [
      { t: 0, dur: 1.8, from: { pos: [0.5, 1.2, 6], look: [3.5, 6.2, -2.5], fov: 40 }, to: { pos: [0.6, 1.1, 5.4], look: [3.5, 6.0, -2.5], fov: 36 } },
      { t: 1.8, dur: 0.9, from: { pos: [4.5, 1.5, 7.5], look: 'actor', fov: 55 }, to: { pos: [4.2, 1.2, 7.5], look: 'actor', fov: 52 } },
      { t: 2.7, dur: 1.1, from: { pos: [1.8, 0.4, 7.8], look: 'actor', fov: 42 }, to: { pos: [1.6, 0.35, 7.6], look: 'actor', fov: 40 } },
      { t: 3.8, dur: 1.0, from: { pos: [-2.4, 1.1, 10], look: 'actor', fov: 44 }, to: { pos: [-2.2, 1.0, 10.6], look: 'actor', fov: 44 } },
      { t: 4.8, dur: 3.7, from: { pos: [1.0, 1.5, 10.6], look: 'head', fov: 38 }, to: { pos: [1.4, 1.3, 11.2], look: 'head', fov: 40 } },
    ],
    cues: [
      { t: 0.2, sfx: 'cheer' },
      { t: 0.4, fx: 'embers_burst' },
      { t: 1.8, sfx: 'whoosh' },
      { t: 2.7, sfx: 'crash', fx: 'dust_land' },
      { t: 2.75, sfx: 'gasp' },
      { t: 4.8, sfx: 'stinger_intro' },
      { t: 5.4, sfx: 'cheer' },
    ],
  },
};
