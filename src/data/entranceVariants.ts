/**
 * Arena-aware entrance variants (see src/cinematic/beats.ts). Positions are
 * in the GATE FRAME: x right (looking into the arena), y up, z = metres into
 * the arena from the boundary at the gate; the fighter's mark is z = 7.6.
 *
 * Gorak "The Cage Breaker": seen behind the lit barrier, grips and shakes it
 * (each shake is a body pulse that moves the bars), steps back, and his
 * downward axe blow breaks it ON the axe's contact frame.
 * Vex "From the Dark": drops from a REAL perch the gate provides (wall,
 * lintel, torii beam, gate roof), or climbs up over a causeway / bridge edge,
 * or rises out of a shadow pool on open floor - never from thin air.
 * Hollowjack: leaps from the stands only where stands exist; otherwise vaults
 * the low fence or bursts through the gate at a run.
 */
import * as THREE from 'three';
import type { V3 } from '../render/arena/arenaView';
import type { Beat, CompiledEntrance, EntranceVariant, VariantCtx } from '../cinematic/beats';
import { beatTimes } from '../cinematic/beats';
import type { CamShot, Mood } from './entrances';

const MARK = 7.6;
const shot = (t: number, dur: number, from: [V3, V3 | 'actor' | 'head', number], to: [V3, V3 | 'actor' | 'head', number], ease: CamShot['ease'] = 'inOut'): CamShot => ({
  t,
  dur,
  from: { pos: from[0], look: from[1], fov: from[2] },
  to: { pos: to[0], look: to[1], fov: to[2] },
  ease,
});
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

function compile(id: string, start: V3, beats: Beat[], camera: CamShot[], mood: Mood, title: number, extra: CompiledEntrance['cues'] = []): CompiledEntrance {
  const T = beatTimes(beats);
  return { id, start, beats, camera, cues: extra, mood, title, duration: T[T.length - 1] };
}

// ------------------------------------------------------------------ GORAK: the Cage Breaker
/** best "gripping the bars" pose: both hands forward at chest-head height, close together */
function gripPose(c: VariantCtx): { clip: string; t: number; reach: number } {
  let best = { clip: 'block', t: 0.3, reach: 0.45, score: -9 };
  for (const [clip, ts] of [
    ['lib:Smash', [0.3, 0.45, 0.6]],
    ['lib:Bash', [0.9, 1.2, 1.5]],
    ['block', [0.2, 0.5]],
  ] as [string, number[]][])
    for (const t of ts) {
      const p = c.probe(clip, t, ['LeftHand', 'RightHand']);
      if (!p.LeftHand || !p.RightHand) continue;
      const fwd = Math.min(p.LeftHand.z, p.RightHand.z);
      const h = (p.LeftHand.y + p.RightHand.y) / 2;
      const spread = Math.abs(p.LeftHand.x - p.RightHand.x);
      const score = fwd * 2 - Math.abs(h - c.height * 0.72) * 1.5 - Math.abs(spread - 0.5);
      if (score > best.score) best = { clip, t, reach: Math.max(p.LeftHand.z, p.RightHand.z), score };
    }
  return best;
}

const gorakCage: EntranceVariant = {
  id: 'cage_breaker',
  needs: (A) => A.barrier !== 'none',
  build: (c) => {
    const A = c.A;
    const bz = A.barrierZ;
    const bars = A.barrier === 'portcullis';
    // the strike: the axe tip must arrive at the barrier on the clip's contact frame
    const strikeClip = 'skull_crack';
    const strikeT = c.impacts(strikeClip)[0] ?? 0.97;
    const tip = c.probe(strikeClip, strikeT, ['tip']).tip ?? new THREE.Vector3(0, 1, 1.4);
    const smashZ = bz - tip.z + 0.06;
    const grip = gripPose(c);
    const gripZ = bz - grip.reach + 0.04;
    const lurkZ = Math.max(bz - (A.tunnel?.depth ?? 3) + 0.6, bz - 2.2);
    const beats: Beat[] = [];
    // 0. lurking in the dark behind the barrier
    beats.push({ dur: 1.3, state: 'idle', move: { type: 'hold' }, cues: [{ at: 0.1, sfx: 'growl' }, { at: 0.5, fx: 'gate_light' }, { at: 0.8, fx: 'eyes_glint' }] });
    if (bars) {
      // 1. up to the bars
      beats.push({ dur: 0.9, state: 'idle', move: { type: 'lerp', to: [0, 0, gripZ], ease: 'inOut' } });
      // 2. grip + three pulls: the bars move exactly when his body does
      beats.push({
        dur: 1.9,
        state: 'clip',
        clip: grip.clip,
        from: grip.t,
        rate: 0,
        move: { type: 'hold' },
        pulses: [0.3, 0.85, 1.35],
        cues: [0.3, 0.85, 1.35].map((t, i) => ({ at: t, fx: 'barrier_shake', sfx: i === 2 ? 'clang' : 'drum', arg: i, cause: 'hands' as const })),
      });
      // 3. step back to striking distance
      beats.push({ dur: 0.7, state: 'clip', clip: 'walkBack', from: 0, rate: 1, move: { type: 'lerp', to: [0, 0, smashZ], ease: 'inOut' } });
    } else {
      // veil / rope / icicles: walk straight up to striking distance
      beats.push({ dur: 1.3, state: 'idle', move: { type: 'lerp', to: [0, 0, smashZ], ease: 'inOut' } });
    }
    // 4. the blow: barrier breaks ON the axe contact frame
    const kind = A.barrier;
    beats.push({
      dur: strikeT + 0.55,
      state: 'clip',
      clip: strikeClip,
      from: 0,
      rate: 1,
      move: { type: 'hold' },
      cues: [
        { at: { impact: 0 }, fx: 'barrier_break', sfx: 'crash', arg: kind === 'portcullis' ? 1 : 0, cause: 'tip' },
        { at: { impact: 0 }, fx: 'slowmo', dur: 0.45, arg: 0.3 },
        { at: strikeT + 0.1, sfx: 'gasp' },
      ],
    });
    // 5. stride out through the debris, 6. roar, 7. taunt
    beats.push({ dur: 1.4, state: 'run', move: { type: 'lerp', to: [0, 0, 3.4], ease: 'in' }, cues: [{ at: 0.5, fx: 'step_dust', sfx: 'thud' }, { at: 1.0, fx: 'step_dust', sfx: 'thud' }] });
    beats.push({ dur: 1.4, state: 'idle', move: { type: 'lerp', to: [0, 0, MARK], ease: 'out' } });
    beats.push({ dur: 1.8, state: 'roar', move: { type: 'hold' }, cues: [{ at: 0.05, fx: 'embers_burst', sfx: 'roar' }, { at: 0.4, sfx: 'stinger_dread' }, { at: 1.2, sfx: 'cheer' }] });
    beats.push({ dur: 2.0, state: 'taunt', move: { type: 'hold' } });
    const T = beatTimes(beats);
    const iStrike = bars ? 4 : 2;
    const tHit = T[iStrike] + strikeT;
    const cam: CamShot[] = [
      // through the barrier, inside the arena at chest height: the cause is in frame
      shot(0, T[bars ? 3 : 2], [[1.5, 1.15, bz + 4.4], [0, 1.6, bz - 0.9], 40], [[1.05, 1.05, bz + 3.3], [0, 1.65, bz - 0.5], 34]),
      shot(T[bars ? 3 : 2], tHit - T[bars ? 3 : 2], [[-2.7, 1.25, bz + 5.2], [0, 1.6, bz - 0.4], 46], [[-2.4, 1.2, bz + 4.8], [0, 1.5, bz - 0.2], 44]),
      // reverse angle on the impact: the pieces fly at the camera's side of the frame
      shot(tHit, T[iStrike + 2] - tHit, [[2.9, 0.55, bz + 3.4], 'actor', 50], [[3.2, 0.6, bz + 4.6], 'actor', 52], 'out'),
      shot(T[iStrike + 2], T[iStrike + 3] - T[iStrike + 2], [[-2.6, 0.45, 10.6], 'actor', 44], [[-2.0, 0.4, 10.0], 'actor', 40]),
      shot(T[iStrike + 3], T[iStrike + 4] - T[iStrike + 3], [[1.3, 2.0, 11.4], 'head', 36], [[1.0, 1.9, 10.8], 'head', 32]),
      shot(T[iStrike + 4], T[iStrike + 5] - T[iStrike + 4], [[-2.2, 0.5, 11.6], 'actor', 40], [[-2.7, 0.7, 12.2], 'actor', 42]),
    ];
    return compile('cage_breaker:' + kind, [0, 0, lurkZ], beats, cam, { moon: 0.52, hemi: 0.47, fog: 0.034, gateColor: '#ff4a1a', spot: 0 }, T[iStrike + 3] + 0.2);
  },
};

// ------------------------------------------------------------------ VEX: From the Dark
const VEX_MOOD: Mood = { moon: 1.0, hemi: 0.31, fog: 0.04, gateColor: '#8a5cff', spot: 0 };

function vexTail(beats: Beat[], from: V3) {
  void from;
  beats.push({ dur: 1.6, state: 'idle', move: { type: 'lerp', to: [0, 0, MARK], ease: 'inOut' }, cues: [{ at: 0, fx: 'shadow_trail', dur: 1.4 }, { at: 0.1, sfx: 'whoosh' }] });
  beats.push({ dur: 2.8, state: 'taunt', move: { type: 'hold' }, cues: [{ at: 0.05, sfx: 'stinger_intro' }, { at: 0.6, sfx: 'cheer' }] });
}

const vexPerch: EntranceVariant = {
  id: 'perch_drop',
  needs: (A) => A.perches.some((p) => p.pos[1] >= 2.5),
  build: (c) => {
    const P = [...c.A.perches].filter((p) => p.pos[1] >= 2.5).sort((a, b) => Math.abs(a.pos[0]) - Math.abs(b.pos[0]))[0];
    const top = P.pos;
    const h = c.hipsM;
    // Jumping_Down_6 is authored from a 0.82-hips ledge: the takeoff uses a ledge-normalised copy
    // (hips shifted down) so the root stays ON the perch until the feet leave it
    const ledge = 0.82 * h;
    const clip = 'lib:Jumping_Down_6';
    const takeoff = 'lib:Jumping_Down_6@-0.82';
    const land = c.impacts(clip).find((t) => t > 1.4) ?? 1.67;
    const drop = top[1];
    const fallT = Math.min(1.05, Math.max(0.45, Math.sqrt((2 * Math.max(0.3, drop)) / 9.8)));
    void ledge;
    const beats: Beat[] = [
      { dur: 2.1, state: 'crouch', move: { type: 'hold' }, cues: [{ at: 0.2, sfx: 'whisper' }, { at: 1.1, fx: 'eyes_glint' }] },
      // takeoff off the real edge (root curve from the clip, still on the perch)
      { dur: 0.3, state: 'clip', clip: takeoff, from: 0.95, rate: 1, move: { type: 'root' }, air: true, cues: [{ at: 0.05, sfx: 'whoosh' }] },
      // the fall (as long as the real drop needs; A18: a perch up a stair lands on the dais in front of it)
      { dur: fallT, state: 'airborne', move: { type: 'lerp', to: [top[0], 0, c.A.ground ? top[2] + 0.8 : Math.max(top[2] + 0.8, 0.7)], ease: 'in' }, air: true },
      // landing: the clip's own landing, impact cue on the measured foot contact
      {
        dur: 2.45 - 1.48,
        state: 'clip',
        clip,
        from: 1.48,
        rate: 1,
        move: { type: 'root', y: { from: 0, to: 0, t0: 0, t1: 1 } },
        cues: [{ at: { impact: 0, effector: 'RightFoot' }, fx: 'smoke_burst', sfx: 'thud' }, { at: { impact: 0, effector: 'RightFoot' }, fx: 'dust_land' }, { at: 0.3, sfx: 'gasp' }],
      },
    ];
    void land;
    vexTail(beats, top);
    const T = beatTimes(beats);
    const cx = top[0] + (top[0] >= 0 ? -1 : 1) * 2.2;
    const cam: CamShot[] = [
      // the perch, with the structure it stands on, from inside the arena
      shot(0, T[1], [[cx, 1.0, top[2] + 8.2], [top[0], top[1] + 0.6, top[2]], 38], [[cx * 0.8, 1.1, top[2] + 7.0], [top[0], top[1] + 0.7, top[2]], 32]),
      shot(T[1], T[3] - T[1], [[top[0] * 0.4, 2.6, top[2] + 7.5], 'actor', 52], [[top[0] * 0.4, 1.4, top[2] + 6.5], 'actor', 50]),
      shot(T[3], T[4] - T[3], [[top[0] + 1.5, 0.4, top[2] + 3.6], 'actor', 40], [[top[0] + 1.2, 0.35, top[2] + 3.2], 'actor', 34]),
      shot(T[4], T[5] - T[4], [[-3.0, 1.2, 9.4], 'actor', 45], [[-2.6, 1.0, 10.2], 'actor', 44]),
      shot(T[5], T[6] - T[5], [[0.9, 1.15, 9.6], 'head', 34], [[1.4, 1.0, 10.2], 'head', 38]),
    ];
    return compile('perch_drop:' + P.id, [top[0], top[1], top[2] - 0.15], beats, cam, VEX_MOOD, T[5] + 0.1);
  },
};

const vexRim: EntranceVariant = {
  id: 'rim_climb',
  needs: (A) => A.rims.length > 0,
  build: (c) => {
    const R = c.A.rims[0];
    const h = c.hipsM;
    const dir = R.dir;
    const yaw = Math.atan2(-dir[0], dir[1]); // gate-frame facing: forward = (-sin yaw, cos yaw)
    // Climbing_To_Top climbs 1.56 hips and moves 1.32 hips forward: start that far below / behind the edge
    const start: V3 = [R.pos[0] - dir[0] * 0.45, R.pos[1] - 1.56 * h, R.pos[2] - dir[1] * 0.45];
    const beats: Beat[] = [
      { dur: 0.6, state: 'clip', clip: 'lib:Climbing_To_Top', from: 0, rate: 0, move: { type: 'hold' }, yaw, air: true, cues: [{ at: 0.1, sfx: 'whisper' }] },
      { dur: 3.6, state: 'clip', clip: 'lib:Climbing_To_Top', from: 0, rate: 1.05, move: { type: 'root' }, yaw, air: true, exitY: R.pos[1], cues: [{ at: 1.2, fx: 'eyes_glint' }] },
      // turn toward the gate and walk in along the causeway / bridge, then to the mark
      { dur: 1.2, state: 'idle', move: { type: 'lerp', to: [0, 0, c.A.barrierZ - 0.8], ease: 'inOut' } },
    ];
    vexTail(beats, start);
    const T = beatTimes(beats);
    const side = R.pos[0] >= 0 ? 1 : -1;
    const cam: CamShot[] = [
      shot(0, T[2], [[side * 4.4, 1.4, R.pos[2] + 4.0], [R.pos[0], 0.2, R.pos[2]], 44], [[side * 4.0, 1.2, R.pos[2] + 3.4], [R.pos[0], 0.5, R.pos[2]], 40]),
      shot(T[2], T[3] - T[2], [[side * 2.5, 1.5, 3.0], 'actor', 46], [[side * 2.0, 1.3, 4.4], 'actor', 44]),
      shot(T[3], T[4] - T[3], [[-3.0, 1.2, 9.4], 'actor', 45], [[-2.6, 1.0, 10.2], 'actor', 44]),
      shot(T[4], T[5] - T[4], [[0.9, 1.15, 9.6], 'head', 34], [[1.4, 1.0, 10.2], 'head', 38]),
    ];
    return compile('rim_climb:' + R.id, start, beats, cam, VEX_MOOD, T[4] + 0.1);
  },
};

const vexShadow: EntranceVariant = {
  id: 'shadow_rise',
  needs: () => true,
  build: (c) => {
    const spot: V3 = c.free([0, 0, 4.6]);
    const beats: Beat[] = [
      { dur: 1.0, state: 'crouch', move: { type: 'hold' }, air: true, hidden: true, cues: [{ at: 0.05, fx: 'shadow_pool', dur: 3.0 }, { at: 0.2, sfx: 'whisper' }] },
      // rises out of the shadow pool
      { dur: 1.3, state: 'crouch', move: { type: 'lerp', to: spot, ease: 'out' }, air: true, cues: [{ at: 0.0, fx: 'smoke_burst', sfx: 'whoosh' }, { at: 0.9, fx: 'eyes_glint' }] },
      { dur: 0.6, state: 'getup', move: { type: 'hold' }, cues: [{ at: 0.1, sfx: 'gasp' }] },
    ];
    vexTail(beats, spot);
    const T = beatTimes(beats);
    const cam: CamShot[] = [
      shot(0, T[1], [[2.4, 0.5, 9.6], [0, 0.2, 4.6], 42], [[2.2, 0.55, 9.2], [0, 0.3, 4.6], 40]),
      shot(T[1], T[3] - T[1], [[2.2, 0.6, 8.8], [0, 0.6, 4.6], 40], [[1.6, 1.1, 7.2], 'head', 36]),
      shot(T[3], T[4] - T[3], [[-3.0, 1.2, 9.4], 'actor', 45], [[-2.6, 1.0, 10.2], 'actor', 44]),
      shot(T[4], T[5] - T[4], [[0.9, 1.15, 9.6], 'head', 34], [[1.4, 1.0, 10.2], 'head', 38]),
    ];
    return compile('shadow_rise', [spot[0], -1.9, spot[2]], beats, cam, VEX_MOOD, T[4] + 0.1);
  },
};

// ------------------------------------------------------------------ HOLLOWJACK
const HJ_MOOD: Mood = { moon: 0.45, hemi: 0.3, fog: 0.03, gateColor: '#ff8a1a', spot: 0 };
function hjTail(beats: Beat[]) {
  beats.push({ dur: 1.2, state: 'idle', move: { type: 'lerp', to: [0, 0, MARK], ease: 'inOut' } });
  beats.push({ dur: 3.0, state: 'taunt', move: { type: 'hold' }, cues: [{ at: 0.05, sfx: 'stinger_intro' }, { at: 0.6, sfx: 'cheer' }] });
}

const hjStands: EntranceVariant = {
  id: 'stands_leap',
  needs: (A) => A.stands.length > 0,
  build: (c) => {
    const S = c.A.stands[0];
    const landAt: V3 = [S[0] * 0.3, 0, 2.6];
    const beats: Beat[] = [
      { dur: 1.7, state: 'crouch', move: { type: 'hold' }, cues: [{ at: 0.2, sfx: 'cheer' }, { at: 0.4, fx: 'embers_burst' }] },
      { dur: 0.95, state: 'airborne', move: { type: 'lerp', to: landAt, ease: 'linear', arc: 1.5 }, air: true, cues: [{ at: 0.0, sfx: 'whoosh' }] },
      { dur: 1.0, state: 'land', move: { type: 'hold' }, cues: [{ at: 0.02, fx: 'dust_land', sfx: 'crash' }, { at: 0.1, sfx: 'gasp' }] },
    ];
    hjTail(beats);
    const T = beatTimes(beats);
    const cam: CamShot[] = [
      shot(0, T[1], [[S[0] * 0.2, 3.0, 8.5], [S[0], S[1] + 1.0, S[2]], 38], [[S[0] * 0.22, 2.9, 7.9], [S[0], S[1] + 0.9, S[2]], 34]),
      shot(T[1], T[2] - T[1], [[4.5, 1.5, 7.5], 'actor', 55], [[4.2, 1.2, 7.5], 'actor', 52]),
      shot(T[2], T[3] - T[2], [[1.8, 0.4, 5.8], 'actor', 42], [[1.6, 0.35, 5.6], 'actor', 40]),
      shot(T[3], T[4] - T[3], [[-2.4, 1.1, 10], 'actor', 44], [[-2.2, 1.0, 10.6], 'actor', 44]),
      shot(T[4], T[5] - T[4], [[1.0, 1.5, 10.6], 'head', 38], [[1.4, 1.3, 11.2], 'head', 40]),
    ];
    return compile('stands_leap', S, beats, cam, HJ_MOOD, T[4] + 0.1);
  },
};

const hjVault: EntranceVariant = {
  id: 'fence_vault',
  needs: (A) => !!A.lowWall && A.lowWall.height <= 1.6,
  build: (c) => {
    const W = c.A.lowWall!.pos;
    const h = c.hipsM;
    // Jumping_Over_Into_Combat from 1.5 s: the hips cross the fence ~1.4 hips-units later
    const start: V3 = [W[0], 0, W[2] - 0.95 * h];
    const beats: Beat[] = [
      { dur: 1.0, state: 'idle', move: { type: 'hold' }, cues: [{ at: 0.1, sfx: 'cheer' }, { at: 0.3, fx: 'embers_burst' }] },
      { dur: 2.4, state: 'clip', clip: 'lib:Jumping_Over_Into_Combat', from: 1.7, rate: 1, move: { type: 'root' }, air: true, cues: [{ at: { impact: 0, effector: 'RightFoot' }, fx: 'dust_land', sfx: 'crash' }, { at: 1.2, sfx: 'gasp' }] },
    ];
    hjTail(beats);
    const T = beatTimes(beats);
    const cam: CamShot[] = [
      shot(0, T[1], [[W[0] - 3.4, 1.3, W[2] + 4.6], [W[0], 1.2, W[2] - 0.6], 42], [[W[0] - 3.0, 1.2, W[2] + 4.2], [W[0], 1.2, W[2] - 0.3], 40]),
      shot(T[1], T[2] - T[1], [[W[0] - 3.6, 0.8, W[2] + 3.2], 'actor', 50], [[W[0] - 3.0, 0.7, W[2] + 4.4], 'actor', 48]),
      shot(T[2], T[3] - T[2], [[-2.4, 1.1, 10], 'actor', 44], [[-2.2, 1.0, 10.6], 'actor', 44]),
      shot(T[3], T[4] - T[3], [[1.0, 1.5, 10.6], 'head', 38], [[1.4, 1.3, 11.2], 'head', 40]),
    ];
    return compile('fence_vault', start, beats, cam, HJ_MOOD, T[3] + 0.1);
  },
};

const hjBurst: EntranceVariant = {
  id: 'gate_burst',
  needs: (A) => A.barrier !== 'none',
  build: (c) => {
    const bz = c.A.barrierZ;
    const runFrom = bz - Math.min(2.6, (c.A.tunnel?.depth ?? 3) - 0.3);
    // break when the body reaches the barrier plane: run speed 5 m/s
    const tBreak = (bz - 0.3 - runFrom) / 5;
    const beats: Beat[] = [
      { dur: 1.0, state: 'idle', move: { type: 'hold' }, cues: [{ at: 0.2, fx: 'gate_light' }, { at: 0.5, sfx: 'growl' }] },
      {
        dur: (3.2 - runFrom) / 5,
        state: 'run',
        move: { type: 'lerp', to: [0, 0, 3.2], ease: 'linear' },
        cues: [
          { at: tBreak, fx: 'barrier_break', sfx: 'crash', arg: 1, cause: 'body' },
          { at: tBreak, fx: 'slowmo', dur: 0.4, arg: 0.35 },
        ],
      },
      { dur: 0.8, state: 'idle', move: { type: 'lerp', to: [0, 0, 4.6], ease: 'out' } },
    ];
    hjTail(beats);
    const T = beatTimes(beats);
    const cam: CamShot[] = [
      shot(0, T[1] + tBreak, [[0.6, 1.0, bz + 4.8], [0, 1.4, bz - 2], 40], [[0.5, 1.0, bz + 4.2], [0, 1.4, bz - 1], 38]),
      shot(T[1] + tBreak, T[3] - T[1] - tBreak, [[3.0, 0.5, bz + 3.0], 'actor', 52], [[3.4, 0.6, bz + 4.6], 'actor', 50], 'out'),
      shot(T[3], T[4] - T[3], [[-2.4, 1.1, 10], 'actor', 44], [[-2.2, 1.0, 10.6], 'actor', 44]),
      shot(T[4], T[5] - T[4], [[1.0, 1.5, 10.6], 'head', 38], [[1.4, 1.3, 11.2], 'head', 40]),
    ];
    return compile('gate_burst', [0, 0, runFrom], beats, cam, HJ_MOOD, T[4] + 0.1);
  },
};

// ------------------------------------------------------------------ the other five, as beat specs (same choreography as before, but
// anchored to the real gate: they start in the walk-in space the gate has, steer around cover on the way to the mark, and
// the cameras step out of cover / hazard rims)
const walkIn = (c: VariantCtx) => c.A.barrierZ - Math.min(2.6, (c.A.tunnel?.depth ?? 2.4) - 0.4);

const aldricMarch: EntranceVariant = {
  id: 'shield_march',
  needs: () => true,
  build: (c) => {
    const z0 = walkIn(c);
    const beats: Beat[] = [
      { dur: 1.4, state: 'idle', move: { type: 'hold' }, cues: [{ at: 0.1, fx: 'gate_open', dur: 1.4, sfx: 'chain' }, { at: 0.2, fx: 'gate_light' }] },
      {
        dur: 3.6,
        state: 'idle',
        move: { type: 'lerp', to: [0, 0, MARK], ease: 'linear' },
        cues: [0, 0.55, 1.1, 1.65, 2.2, 2.75, 3.3].map((t) => ({ at: t, sfx: 'drum', fx: 'step_dust' })),
      },
      {
        dur: 3.5,
        state: 'taunt',
        move: { type: 'hold' },
        cues: [{ at: 0.3, sfx: 'clang', fx: 'shield_spark' }, { at: 0.62, sfx: 'clang', fx: 'shield_spark' }, { at: 0.94, sfx: 'clang', fx: 'shield_spark' }, { at: 0.5, sfx: 'stinger_intro' }, { at: 1.3, sfx: 'cheer' }],
      },
    ];
    const T = beatTimes(beats);
    const cam: CamShot[] = [
      shot(0, 1.6, [[0, 1.5, 7], [0, 1.8, c.A.barrierZ - 1], 45], [[0, 1.35, 6], [0, 1.6, c.A.barrierZ - 2], 42]),
      shot(1.6, 1.8, [[-1.4, 0.9, 6.0], 'actor', 40], [[-1.2, 0.8, 7.0], 'actor', 40]),
      shot(3.4, T[2] - 3.4, [[0.9, 1.9, 0.6], 'actor', 52], [[0.9, 1.9, 4.6], 'actor', 50]),
      shot(T[2], T[3] - T[2], [[1.6, 0.5, 10.2], 'head', 36], [[2.0, 0.6, 10.9], 'actor', 40]),
    ];
    return compile('shield_march', [0, 0, z0], beats, cam, { moon: 0.92, hemi: 0.6, fog: 0.026, gateColor: '#7cc4ff', spot: 0.35 }, T[2] + 0.4);
  },
};

const erikaTorches: EntranceVariant = {
  id: 'torch_path',
  needs: () => true,
  build: (c) => {
    const z0 = walkIn(c);
    const mark = c.free([0, 0, 7.2]);
    const beats: Beat[] = [
      { dur: 1.0, state: 'relaxed', move: { type: 'hold' }, cues: [...[0, 1, 2, 3, 4, 5].map((i) => ({ at: 0.35 + i * 0.32, fx: 'torch_path', arg: i, sfx: 'fire' })), { at: 0.4, fx: 'gate_light' }] },
      { dur: 4.2, state: 'relaxed', move: { type: 'lerp', to: mark, ease: 'linear' }, cues: [{ at: 0.5, sfx: 'drum' }, { at: 2.0, sfx: 'drum' }, { at: 3.5, sfx: 'drum' }] },
      { dur: 1.2, state: 'kneel', move: { type: 'hold' }, cues: [{ at: 0.05, sfx: 'thud' }] },
      { dur: 1.0, state: 'roar', move: { type: 'hold' }, cues: [{ at: 0.2, sfx: 'stinger_intro', fx: 'holy_burst' }] },
      { dur: 1.6, state: 'taunt', move: { type: 'hold' }, cues: [{ at: 0.6, sfx: 'cheer' }] },
    ];
    const T = beatTimes(beats);
    const cam: CamShot[] = [
      shot(0, 2.5, [[-2.2, 1.0, 9.5], [0, 1.4, 0], 42], [[-1.6, 0.9, 8.6], 'actor', 40]),
      shot(2.5, T[2] - 2.5, [[3.8, 1.0, 2.4], 'actor', 40], [[3.6, 0.9, 6.4], 'actor', 38]),
      shot(T[2], T[3] - T[2], [[mark[0] + 0.65, 0.65, mark[2] + 1.5], 'head', 30], [[mark[0] + 0.55, 0.6, mark[2] + 1.3], 'head', 27]),
      shot(T[3], T[5] - T[3], [[mark[0] + 0.4, 0.3, mark[2] + 2.4], 'head', 40], [[mark[0] + 0.9, 0.3, mark[2] + 3.6], [mark[0], 2.5, mark[2]], 44]),
    ];
    return compile('torch_path', [0, 0, z0], beats, cam, { moon: 0.44, hemi: 0.31, fog: 0.03, gateColor: '#ffd66b', spot: 0 }, T[3] + 0.2);
  },
};

const ozrelPillar: EntranceVariant = {
  id: 'fire_pillar',
  needs: () => true,
  build: (c) => {
    const spot = c.free([0, 0, 6.6]);
    const beats: Beat[] = [
      { dur: 1.2, state: 'roar', move: { type: 'hold' }, air: true, hidden: true, cues: [{ at: 0.1, fx: 'ground_embers', dur: 1.1 }] },
      { dur: 1.5, state: 'roar', move: { type: 'lerp', to: spot, ease: 'out' }, air: true, cues: [{ at: 0, fx: 'fire_pillar', dur: 2.1, sfx: 'fire_big' }, { at: 0.05, sfx: 'gasp' }, { at: 0.1, fx: 'gate_light' }] },
      { dur: 0.5, state: 'idle', move: { type: 'hold' } },
      { dur: 1.1, state: 'idle', move: { type: 'lerp', to: [spot[0], 0, Math.max(spot[2], MARK)], ease: 'inOut' } },
      { dur: 4.2, state: 'taunt', move: { type: 'hold' }, cues: [{ at: 0, fx: 'palm_fire', dur: 4.2, sfx: 'fire' }, { at: 0.2, sfx: 'stinger_intro' }, { at: 0.9, sfx: 'cheer' }] },
    ];
    const T = beatTimes(beats);
    const cam: CamShot[] = [
      shot(0, 1.2, [[spot[0] + 2.5, 0.5, spot[2] + 4.6], [spot[0], 0.3, spot[2]], 45], [[spot[0] + 2.2, 0.45, spot[2] + 4.0], [spot[0], 0.2, spot[2]], 42]),
      shot(1.2, 2.0, [[spot[0] + 3.6, 0.4, spot[2] + 3.2], [spot[0], 2.6, spot[2]], 52], [[spot[0] + 3.0, 0.5, spot[2] + 2.6], 'head', 44]),
      shot(3.2, T[4] - 3.2, [[-2.6, 1.2, 10], 'actor', 42], [[-2.2, 1.1, 10.5], 'actor', 40]),
      shot(T[4], T[5] - T[4], [[0.9, 1.3, 9.6], 'head', 34], [[1.3, 1.0, 10.2], 'head', 36]),
    ];
    return compile('fire_pillar', [spot[0], -2.4, spot[2]], beats, cam, { moon: 0.39, hemi: 0.28, fog: 0.035, gateColor: '#ff7a18', spot: 0 }, T[4] + 0.2);
  },
};

const fenrikLeap: EntranceVariant = {
  id: 'shadow_leap',
  needs: () => true,
  build: (c) => {
    const bz = c.A.barrierZ;
    // crouch just inside the opening; the leap peaks outside the gate so it never meets a tunnel roof
    const z0 = bz - 0.9;
    const land = c.free([0, 0, 4.2]);
    const beats: Beat[] = [
      { dur: 1.55, state: 'crouch', move: { type: 'hold' }, cues: [{ at: 0.3, sfx: 'growl' }, { at: 0.5, fx: 'eyes_glint' }] },
      { dur: 0.45, state: 'crouch', move: { type: 'hold' }, cues: [{ at: 0, fx: 'gate_open', dur: 0.4, sfx: 'chain' }] },
      { dur: 0.85, state: 'airborne', move: { type: 'lerp', to: land, ease: 'linear', arc: 1.6 }, air: true, cues: [{ at: 0, sfx: 'roar_short', fx: 'gate_light' }] },
      { dur: 0.45, state: 'land', move: { type: 'hold' }, cues: [{ at: 0.02, sfx: 'thud', fx: 'dust_land' }, { at: 0.08, sfx: 'gasp' }] },
      { dur: 1.5, state: 'idle', move: { type: 'lerp', to: [land[0], 0, MARK], ease: 'inOut' } },
      { dur: 3.2, state: 'taunt', move: { type: 'hold' }, cues: [{ at: 0.1, sfx: 'howl' }, { at: 0.4, sfx: 'stinger_dread' }, { at: 1.2, sfx: 'cheer' }] },
    ];
    const T = beatTimes(beats);
    const cam: CamShot[] = [
      shot(0, T[2], [[0.2, 1.1, bz + 4.9], [0, 0.9, z0], 36], [[0.15, 1.05, bz + 3.7], [0, 0.85, z0], 30]),
      shot(T[2], T[3] - T[2], [[3.4, 0.5, 5.6], 'actor', 56], [[3.1, 0.4, 5.0], 'actor', 52]),
      shot(T[3], T[5] - T[3], [[-1.8, 0.35, 8.6], 'actor', 40], [[-1.6, 0.3, 9.6], 'actor', 38]),
      shot(T[5], T[6] - T[5], [[1.5, 1.3, 10.6], 'head', 38], [[1.9, 1.1, 11.2], 'head', 40]),
    ];
    return compile('shadow_leap', [0, 0, z0], beats, cam, { moon: 0.71, hemi: 0.28, fog: 0.04, gateColor: '#8bff5a', spot: 0 }, T[5] + 0.2);
  },
};

const mawEmerges: EntranceVariant = {
  id: 'great_gate',
  needs: () => true,
  build: (c) => {
    const z0 = walkIn(c);
    const beats: Beat[] = [
      { dur: 1.2, state: 'idle', move: { type: 'hold' }, cues: [{ at: 0.1, fx: 'gate_open', dur: 1.6, sfx: 'chain' }, { at: 0.2, fx: 'gate_light' }] },
      { dur: 5.2, state: 'relaxed', move: { type: 'lerp', to: [0, 0, 7.4], ease: 'linear' }, cues: [...[0.4, 1.25, 2.1, 2.95, 3.8, 4.65].map((t) => ({ at: t, sfx: 'thud', fx: 'step_dust' })), { at: 0.8, sfx: 'gasp' }] },
      { dur: 2.6, state: 'roar', move: { type: 'hold' }, cues: [{ at: 0.1, sfx: 'roar', fx: 'embers_burst' }, { at: 0.5, sfx: 'stinger_dread' }, { at: 1.2, sfx: 'cheer' }] },
    ];
    const T = beatTimes(beats);
    const cam: CamShot[] = [
      shot(0, 1.6, [[0, 1.2, 7], [0, 2.2, c.A.barrierZ - 1], 45], [[0, 1.0, 6], [0, 2.0, c.A.barrierZ - 2], 42]),
      shot(1.6, 2.4, [[-1.6, 0.3, 6.5], 'head', 46], [[-1.4, 0.3, 7.5], 'head', 44]),
      shot(4.0, T[2] - 4.0, [[3.8, 1.3, 3.0], 'actor', 46], [[3.4, 1.3, 6.2], 'actor', 46]),
      shot(T[2], T[3] - T[2], [[1.3, 1.7, 11.2], 'head', 40], [[1.1, 1.6, 10.6], 'head', 35]),
    ];
    return compile('great_gate', [0, 0, z0], beats, cam, { moon: 0.35, hemi: 0.25, fog: 0.04, gateColor: '#b07bff', spot: 0 }, T[2] + 0.2);
  },
};

/** variants per fighter, in preference order (the entrance picks among the valid ones with the seed) */
export const ENTRANCE_VARIANTS: Record<string, { v: EntranceVariant; w: number }[]> = {
  gorak: [{ v: gorakCage, w: 1 }],
  vex: [
    { v: vexPerch, w: 3 },
    { v: vexRim, w: 2 },
    { v: vexShadow, w: 1 },
  ],
  hollowjack: [
    { v: hjStands, w: 3 },
    { v: hjVault, w: 2 },
    { v: hjBurst, w: 1 },
  ],
  aldric: [{ v: aldricMarch, w: 1 }],
  erika: [{ v: erikaTorches, w: 1 }],
  ozrel: [{ v: ozrelPillar, w: 1 }],
  fenrik: [{ v: fenrikLeap, w: 1 }],
  maw: [{ v: mawEmerges, w: 1 }],
};
void add;
