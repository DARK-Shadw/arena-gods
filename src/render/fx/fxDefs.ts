/**
 * DATA: effect definitions, event resolution and continuous emitters.
 *
 * Add an effect = add an `FxDef` to DEFS (and a line in RESOLVE / CONTINUOUS if
 * an event or a state should trigger it). The director (fxDirector.ts) never
 * needs to change for that.
 *
 * F0 content: every effect the game showed before F0, moved here from the
 * literal `vfx.*` calls in main.ts with the SAME numbers (colours, counts,
 * sizes, speeds). F3+ replace these rows with the material-aware, flipbook,
 * decal and light versions from docs/fx-catalog.md.
 *
 * HDR convention for new rows (plan §2.4; F0 rows predate it): core 8-30,
 * body 1.5-4, smoke/dust lit at scene level (<= 1), sparks 6-12.
 */
import type { Frame, FighterFrame, MoveDef, SimEvent } from '../../sim/types';
import type { DecalCell } from './atlas';
import { BLEEDS, CUTS, type Surface, type WeaponClass } from './fxSurfaces';

// ------------------------------------------------------------------ types
/**
 * Where a layer is placed. `a` = the event's actor (e.a), `b` = its target (e.b).
 * Chest / head / cast / feet come from the FighterView; `event` uses data.x/y/z;
 * `obstacle` / `hazard` use the layout entry named by data.obs / data.haz.
 * Without a world (FX Lab, standalone director) every anchor resolves to the
 * spawn position (feet anchors with y = 0).
 */
export type Anchor =
  | 'origin'
  | 'contact' // b chest -> a chest at 0.25 (hit)
  | 'blockContact' // a chest -> b chest at 0.3
  | 'parryContact' // a chest -> b chest at 0.35
  | 'aChest'
  | 'bChest'
  | 'aFeet'
  | 'bFeet'
  | 'aHead'
  | 'aCast'
  | 'event'
  | 'obstacle'
  | 'hazard'
  | 'ringEdge'; // a seeded random point just outside the ring of fire

/** colour: '#rrggbb', '$accent' (actor's accent), '$accentB' (target's accent) */
export type FxColor = string;
export type Vec3 = [number, number, number];

/**
 * One emission. Kinds map 1:1 to the primitives in legacyVfx.ts (F0); F1 adds the distortion kinds
 * `heat` and `ripple`; F3+ add flipbook/ribbon/decal/card/light kinds.
 * `hdr` (sparks, flash, fire, fireBurst, embers) overrides the primitive's HDR multiplier (HDR_SCALE).
 */
export type FxOp =
  | { k: 'sparks'; n: number; color?: FxColor; speed?: number; hdr?: number }
  | { k: 'flash'; color?: FxColor; size?: number; light?: number; hdr?: number }
  | { k: 'dust'; n: number; spread?: number; color?: FxColor }
  | { k: 'smoke'; n: number; color?: FxColor; size?: number; rise?: number }
  /** vel: fixed velocity, or 'facing' (actor facing x speed, y = -0.05) */
  | { k: 'fire'; n: number; size?: number; spread?: number; vel?: Vec3; facing?: number; hdr?: number }
  /**
   * Fire burst, one particle per direction:
   *  sphere: dir = normalize(r-0.5, r*0.9+0.2, r-0.5) * speed[0..1]
   *  ring:   n evenly spaced horizontal dirs * speed[0], vy = speed[1]
   *  box:    ((r-0.5)*box[0], box[1] + r*box[1], (r-0.5)*box[2])
   */
  | { k: 'fireBurst'; n: number; shape: 'sphere' | 'ring' | 'box'; speed?: [number, number]; box?: Vec3; size: number; spread: number; hdr?: number }
  | { k: 'embers'; n: number; color?: FxColor; area?: number; hdr?: number }
  | { k: 'shock'; color?: FxColor; size?: number; life?: number }
  | { k: 'debris'; n: number; color?: FxColor }
  /**
   * F1 screen distortion (distortion.ts). heat: shimmer column standing on the anchor (width `size`,
   * `height`, rising at `rise` m/s); ripple: expanding pressure ring of radius `size`.
   * `strength` 1 = a few pixels at 5 m. `tier` = lowest distortion tier that shows it
   * (TIER_CAPS.dist: 1 = heavy events, also on medium; 2 = high only). Defaults: heat 2, ripple 1.
   */
  | { k: 'heat'; size: number; height: number; life: number; strength?: number; rise?: number; tier?: 1 | 2 }
  | { k: 'ripple'; size: number; life: number; strength?: number; tier?: 1 | 2 }
  // ---------------- F3 op kinds (docs/fx-api.md "F3 additions")
  /**
   * Textured stateless particles (sprites.ts). `tex`: a Kenney mask sprite name (atlas.ts SPRITES) or
   * '@<atlas id>' for a flipbook. Velocity = normalize(mix(dir, random unit, cone)) * speed + vy.
   * `add`: pure glow (alpha 0, additive); otherwise the particle occludes (dust, blood, smoke).
   * `minQ`: lowest quality tier that shows the layer. Counts scale with TIER_CAPS.spriteScale.
   */
  | {
      k: 'sp';
      tex: string;
      n: number;
      color?: FxColor;
      hdr?: number;
      alpha?: number;
      add?: boolean;
      dir?: SpDir;
      cone?: number;
      speed?: [number, number];
      vy?: [number, number];
      size?: [number, number];
      grow?: number;
      life?: [number, number];
      drag?: number;
      grav?: number;
      /** velocity stretch (seconds of motion): a streak */
      stretch?: number;
      /** width / length of the quad */
      aspect?: number;
      spin?: number;
      /** random start rotation (default true for cards) */
      rot?: boolean;
      floor?: boolean;
      /** spawn position jitter radius (m) */
      jitter?: number;
      /** flipbook start frame range and playback (fps <= 0: once over the particle life) */
      frame0?: [number, number];
      fps?: number;
      loop?: boolean;
      minQ?: 0 | 1 | 2;
    }
  /**
   * Blood droplets (gore): dark-red streaks on ballistic arcs; `drops` of them leave a small floor
   * decal where (and when) they land. Decal positions come from recorded frame data (seek-exact).
   */
  | { k: 'blood'; n: number; speed: [number, number]; size?: [number, number]; dir?: SpDir; cone?: number; drops?: number; color?: FxColor; vy?: [number, number] }
  /**
   * Floor decal(s) (decals.ts), placed from recorded frame data: `who` = whose feet ('b' victim, 'a'
   * actor) or the event position; `off` = metres along the hit direction; `body` = look up the body's
   * position this many seconds after the event (pools under a fallen fighter).
   */
  | {
      k: 'decal';
      cell: DecalCell | DecalCell[];
      size: [number, number];
      n?: number;
      who?: 'a' | 'b' | 'event';
      off?: [number, number];
      side?: number;
      align?: 'hit' | 'random';
      grow?: number;
      alpha?: [number, number];
      nrm?: number;
      rough?: number;
      blood?: boolean;
      aspect?: [number, number];
      body?: number;
    }
  /** a wound on the victim (wounds.ts), bone and offset seeded */
  | { k: 'wound'; r: [number, number]; amt?: number }
  /** blood on the actor's weapon (grows with each cutting hit) */
  | { k: 'bladeBlood'; amt: number }
  /** FX light pool request (lights.ts); dur = seconds to fade */
  | { k: 'light'; color: FxColor; i: number; dur: number; radius?: number }
  /** small instanced chips (debris pool) launched from the anchor */
  | { k: 'chips'; n: number; color?: FxColor; scale?: number; speed?: number }
  /** afterimage ghosts of the actor: n snapshots `gap` seconds apart, each fading over `life` */
  | { k: 'ghost'; n: number; gap: number; life: number; color?: FxColor; strength?: number };

/**
 * Emission directions for 'sp' / 'blood' (from recorded frame data: attacker -> victim on the floor plane).
 * hit: along the blow; back: towards the attacker; cut: along the blow, swept sideways and up (spray);
 * deflect: sideways off the blow and up (block sparks); facing: the actor's facing; none: random.
 */
export type SpDir = 'hit' | 'back' | 'up' | 'down' | 'none' | 'cut' | 'deflect' | 'facing';

/**
 * HDR convention (plan §2.4, applied from F1): linear colour multipliers per primitive, so cores
 * reach the bloom threshold (~1) and bodies glow softly while smoke and dust stay at scene level.
 * The hex colours in the rows below are the hue; this table is the intensity. Tune here, or per
 * op with `hdr`. Plan targets: cores 8-30, bodies 1.5-4, sparks 6-12, smoke/dust <= 1. The
 * values are lower than the plan's because the F0 shapes overlap (additive) and a soft dot
 * already sums 2-4 deep in a burst; F3 sprite atlases should move towards the plan's numbers.
 */
export const HDR_SCALE = { sparks: 3, flash: 2.2, fire: 1.8, embers: 3, dust: 1, smoke: 1 } as const;

export interface FxLayer {
  op: FxOp;
  /** overrides the def's anchor */
  at?: Anchor;
  /** replace the anchor's y (setY), e.g. 0.3 for "at the feet, a little up" */
  y?: number;
  /** keep y at least this (explosions) */
  minY?: number;
  /** seconds after the spawn, on FX time (replaces a wall-clock timer) */
  delay?: number;
  /** soft-particle fade distance (m) for this layer; overrides the def's `soft` and the primitive default (softDepth.ts SOFTNESS). 0 = hard */
  soft?: number;
}

export interface FxDef {
  id: string;
  /** what it is (FX Lab tooltip) */
  desc?: string;
  at: Anchor;
  y?: number;
  layers: FxLayer[];
  /**
   * post kicks the game applies this frame (max with what is already running). `vignette` darkens the
   * frame edge (0..1, decays in ~0.4 s); `grade` kicks a grade preset (post.ts GRADE_PRESETS) at
   * `gradeWeight` (default 1) that fades out over `gradeDur` seconds (default 0.6).
   */
  post?: { aberration?: number; flash?: number; vignette?: number; grade?: string; gradeWeight?: number; gradeDur?: number };
  /** soft-particle fade distance (m) for every particle layer of this def (default: per primitive) */
  soft?: number;
  /** id substitution by gore level (blood rows from F3 on). null = nothing at that level */
  gore?: { off?: string | null; standard?: string | null; full?: string | null };
  /** budget culling order (higher survives); unused until the F3 budget */
  priority: number;
  /** camera shake amplitude, read by the camera director once plan §3.6 is agreed; ignored now */
  shake?: number;
  /** behaviour during hit-stop (plan CI1); F0 effects all run on the FX clock ('slow') */
  stop?: 'freeze' | 'slow' | 'real';
}

// ------------------------------------------------------------------ the table
const HIT_COLOR: Record<string, string> = { fire: '#ff8a30', pyre: '#ff8a30', nova: '#ff8a30', shadow: '#c79bff', holy: '#ffe08a' };
const HIT_KIND = (fx: string) => (fx in HIT_COLOR ? (fx === 'pyre' || fx === 'nova' ? 'fire' : fx) : 'default');

const list: FxDef[] = [];
const def = (d: FxDef) => list.push(d);

// ---- melee impacts (F3 replaces these with impact.<weaponClass>.<surface>)
for (const [kind, color] of [
  ['default', '#fff1c8'],
  ['fire', '#ff8a30'],
  ['shadow', '#c79bff'],
  ['holy', '#ffe08a'],
] as const) {
  def({ id: `impact.${kind}`, desc: `light hit (${kind})`, at: 'contact', priority: 50, layers: [{ op: { k: 'sparks', n: 14, color, speed: 6 } }, { op: { k: 'flash', color, size: 0.8, light: 5 } }] });
  def({
    id: `impact.${kind}.heavy`,
    desc: `heavy hit (${kind})`,
    at: 'contact',
    priority: 60,
    post: { aberration: 1, flash: 0.06, vignette: 0.12 },
    layers: [
      { op: { k: 'sparks', n: 40, color, speed: 9 } },
      { op: { k: 'flash', color, size: 1.6, light: 14 } },
      { op: { k: 'dust', n: 10, spread: 1.2 }, at: 'bFeet' },
      { op: { k: 'ripple', size: 1.4, life: 0.32, strength: 0.9 } },
    ],
  });
}
def({
  id: 'impact.quake',
  desc: 'quake hit: ground ring at the attacker',
  at: 'aFeet',
  priority: 55,
  layers: [
    { op: { k: 'sp', tex: '@dust_ring', n: 1, color: '$floor', alpha: 0.6, dir: 'none', speed: [0, 0], size: [2.6, 2.6], grow: 1.45, life: [1.1, 1.1], rot: false } },
    { op: { k: 'sp', tex: '@dust_puff', n: 3, color: '$floor', alpha: 0.38, dir: 'none', cone: 1, speed: [1.5, 3], size: [0.55, 0.7], grow: 1.6, life: [0.9, 1.2], drag: 2.4, jitter: 0.8, rot: false } },
    { op: { k: 'chips', n: 10, color: '$floor', scale: 0.25, speed: 0.9 }, y: 0.1 },
    { op: { k: 'decal', cell: ['crack_0', 'crack_1', 'crack_2'], who: 'a', size: [2.0, 2.6], off: [0.6, 1.0], align: 'hit', alpha: [0.85, 0.95], nrm: 1, rough: 0.9 } },
    { op: { k: 'ripple', size: 4, life: 0.5, strength: 1.1 }, y: 0.4 },
    { op: { k: 'light', color: '#ffc080', i: 6, dur: 0.2, radius: 7 }, y: 0.6 },
  ],
});
def({
  id: 'impact.fireBurst',
  desc: 'fire hit: a small fireball flipbook off the contact, flames, warm light',
  at: 'contact',
  priority: 45,
  layers: [
    { op: { k: 'sp', tex: '@unity_fireball01', n: 1, color: '#ffffff', hdr: 3, add: true, dir: 'none', speed: [0, 0], size: [0.7, 0.7], grow: 1.6, life: [0.4, 0.4], fps: 30, frame0: [0, 40] } },
    { op: { k: 'fire', n: 6, size: 0.4, spread: 1, vel: [0, 2, 0] } },
    { op: { k: 'light', color: '#ff9040', i: 6, dur: 0.25, radius: 6 } },
  ],
});
// C07 block: a spark fan off the guard along the deflection, a small hot flare, a short light
def({
  id: 'block.sparks',
  desc: 'C07 blocked strike: spark fan along the deflection, small flare, light',
  at: 'blockContact',
  priority: 50,
  shake: 0,
  layers: [
    { op: { k: 'sp', tex: 'trace_07', n: 18, color: '#ffc890', hdr: 8, add: true, dir: 'deflect', cone: 0.55, speed: [3, 8], vy: [0.5, 2.5], size: [0.05, 0.09], aspect: 0.22, stretch: 0.03, grav: 9, drag: 1.5, life: [0.2, 0.45] } },
    { op: { k: 'sp', tex: 'star_06', n: 1, color: '#ffe6c0', hdr: 7, add: true, dir: 'none', speed: [0, 0], size: [0.32, 0.4], life: [0.07, 0.07] } },
    { op: { k: 'light', color: '#ffd8a8', i: 3, dur: 0.1, radius: 5 } },
  ],
});
// C09 shield ripple: Aldric blocks on his shield (a gold rune ring opening at the guard)
def({
  id: 'block.shield',
  desc: 'C09 shield ripple: gold ring opening at the guard (Aldric)',
  at: 'blockContact',
  priority: 45,
  layers: [
    { op: { k: 'sp', tex: 'circle_03', n: 1, color: '#ffcf7a', hdr: 3, add: true, dir: 'none', speed: [0, 0], size: [0.35, 0.35], grow: 3.2, life: [0.32, 0.32], rot: true } },
    { op: { k: 'sp', tex: 'circle_05', n: 1, color: '#ffd890', hdr: 1.2, add: true, dir: 'none', speed: [0, 0], size: [0.5, 0.5], grow: 1.6, life: [0.18, 0.18] } },
    { op: { k: 'light', color: '#ffd38a', i: 2.5, dur: 0.2, radius: 4 } },
  ],
});
// C08 parry: big anamorphic flare, spark cone, ring shock, CA (slow-mo is the camera director's)
def({
  id: 'parry.flash',
  desc: 'C08 parry: anamorphic flare (HDR 20), spark cone, ring distortion, CA pulse, cool light',
  at: 'parryContact',
  priority: 70,
  post: { aberration: 0.8 },
  layers: [
    { op: { k: 'sp', tex: 'flare_01', n: 1, color: '#dcecff', hdr: 20, add: true, dir: 'none', speed: [0, 0], size: [2.1, 2.1], aspect: 0.16, rot: false, life: [0.2, 0.2] } },
    { op: { k: 'sp', tex: 'star_06', n: 1, color: '#eef6ff', hdr: 14, add: true, dir: 'none', speed: [0, 0], size: [0.7, 0.7], grow: 0.6, life: [0.14, 0.14] } },
    { op: { k: 'sp', tex: 'trace_07', n: 40, color: '#cfe6ff', hdr: 9, add: true, dir: 'deflect', cone: 0.85, speed: [4, 11], vy: [0.5, 3], size: [0.05, 0.1], aspect: 0.2, stretch: 0.03, grav: 9, drag: 1.2, life: [0.25, 0.55] } },
    { op: { k: 'ripple', size: 1.1, life: 0.25, strength: 0.7, tier: 2 } },
    { op: { k: 'light', color: '#d8ecff', i: 16, dur: 0.16, radius: 8 } },
  ],
});
def({
  id: 'guard.break',
  desc: 'C19 guard broken: shatter flare, ring of large sparks, orange light',
  at: 'aChest',
  priority: 55,
  layers: [
    { op: { k: 'sp', tex: 'star_06', n: 1, color: '#ffb070', hdr: 12, add: true, dir: 'none', speed: [0, 0], size: [0.9, 0.9], life: [0.12, 0.12] } },
    { op: { k: 'sp', tex: 'trace_07', n: 30, color: '#ffb070', hdr: 8, add: true, dir: 'none', speed: [4, 9], vy: [0.5, 2.5], size: [0.07, 0.12], aspect: 0.22, stretch: 0.035, grav: 9, drag: 1.2, life: [0.3, 0.6] } },
    { op: { k: 'ripple', size: 1.3, life: 0.28, strength: 0.8, tier: 2 } },
    { op: { k: 'light', color: '#ff9a50', i: 10, dur: 0.18, radius: 7 } },
  ],
});
// C10 dodge: skid dust where the dodge starts, and afterimage ghosts of the pose
def({
  id: 'dodge.dust',
  desc: 'C10 dodge start: skid dust puffs + afterimage ghosts (tier: 0 / 1 / 3)',
  at: 'aFeet',
  priority: 20,
  layers: [
    { op: { k: 'sp', tex: '@dust_puff', n: 2, color: '$floor', alpha: 0.55, dir: 'none', cone: 1, speed: [0.3, 0.8], size: [0.45, 0.6], grow: 1.5, life: [0.7, 0.9], drag: 3, jitter: 0.25, rot: false } },
    { op: { k: 'ghost', n: 3, gap: 0.07, life: 0.3, color: '$accent', strength: 0.55 } },
  ],
});
def({
  id: 'knockdown.dust',
  desc: 'C03 body hits the floor (0.15 s after the event): ground dust ring, puffs, stone chips (the crack is the arena decal)',
  at: 'aFeet',
  priority: 40,
  layers: [
    { op: { k: 'sp', tex: '@dust_ring', n: 1, color: '$floor', alpha: 0.55, dir: 'none', speed: [0, 0], size: [1.3, 1.3], grow: 1.45, life: [1.0, 1.0], rot: false }, delay: 0.15 },
    { op: { k: 'sp', tex: '@dust_puff', n: 3, color: '$floor', alpha: 0.4, dir: 'none', cone: 1, speed: [0.6, 1.4], size: [0.45, 0.6], grow: 1.5, life: [0.9, 1.2], drag: 2.5, jitter: 0.45, rot: false, minQ: 1 }, delay: 0.15 },
    { op: { k: 'chips', n: 5, color: '$floor', scale: 0.2, speed: 0.6 }, delay: 0.15, y: 0.1 },
  ],
});
def({ id: 'slam.wall', desc: 'wall / pillar slam', at: 'aChest', priority: 50, layers: [{ op: { k: 'dust', n: 20, spread: 1.5 }, at: 'aFeet' }, { op: { k: 'sparks', n: 20, color: '#ffcf8a', speed: 6 } }] });
def({ id: 'prop.break', desc: 'prop destroyed', at: 'event', priority: 30, layers: [{ op: { k: 'dust', n: 10, spread: 1.0 } }] });
def({
  id: 'ult.cast',
  desc: 'ultimate used',
  at: 'aChest',
  priority: 80,
  post: { flash: 0.08, vignette: 0.2 },
  layers: [{ op: { k: 'flash', color: '$accent', size: 2.5, light: 20 } }, { op: { k: 'shock', color: '$accent', size: 4, life: 0.6 }, at: 'aFeet' }, { op: { k: 'ripple', size: 3, life: 0.5, strength: 1.2 } }],
});
def({ id: 'secondWind.burst', desc: 'second wind / cornered', at: 'aFeet', priority: 70, layers: [{ op: { k: 'embers', n: 60, color: '$accent', area: 1.2 }, y: 0.3 }, { op: { k: 'shock', color: '$accent', size: 5, life: 0.7 } }] });
def({ id: 'lastStand.burst', desc: 'last stand', at: 'aFeet', priority: 75, layers: [{ op: { k: 'embers', n: 80, color: '#ff3a2a', area: 1.4 }, y: 0.3 }, { op: { k: 'shock', color: '#ff3a2a', size: 6, life: 0.8 } }] });
def({ id: 'hazard.burn', desc: 'standing in fire / lava (tick)', at: 'aFeet', y: 0.4, priority: 40, layers: [{ op: { k: 'fire', n: 6, size: 0.4, spread: 0.5, vel: [0, 2, 0] } }, { op: { k: 'heat', size: 0.9, height: 1.8, life: 0.9, strength: 0.8 }, y: 0.2 }] });
def({ id: 'finisher.start', desc: 'finisher begins (post only)', at: 'aChest', priority: 90, post: { flash: 0.12, vignette: 0.25 }, layers: [] });
def({ id: 'finisher.graze', desc: 'non-lethal finisher contact', at: 'bChest', priority: 50, layers: [{ op: { k: 'sparks', n: 24, color: '#fff0c8', speed: 6 } }, { op: { k: 'dust', n: 8, spread: 1.0 }, at: 'bFeet' }] });
def({ id: 'finisher.kill', desc: 'finisher kill contact (geometry FX are FinisherFx)', at: 'bChest', priority: 90, post: { aberration: 1.4 }, layers: [] });
def({
  id: 'launch.land',
  desc: 'C03 landing after a launch: big ground dust ring, puffs, chips',
  at: 'aFeet',
  priority: 50,
  layers: [
    { op: { k: 'sp', tex: '@dust_ring', n: 1, color: '$floor', alpha: 0.6, dir: 'none', speed: [0, 0], size: [1.8, 1.8], grow: 1.45, life: [1.1, 1.1], rot: false } },
    { op: { k: 'sp', tex: '@dust_puff', n: 4, color: '$floor', alpha: 0.45, dir: 'none', cone: 1, speed: [0.8, 1.8], size: [0.55, 0.7], grow: 1.6, life: [1.0, 1.3], drag: 2.5, jitter: 0.6, rot: false } },
    { op: { k: 'chips', n: 8, color: '$floor', scale: 0.22, speed: 0.75 }, y: 0.1 },
  ],
});
// CI7 death (non-finisher): no white ring any more; flash + CA + ripple, dust settling around the body, blood by gore
def({
  id: 'kill.plain',
  desc: 'CI7 killing blow (no finisher): flash, ripple, vignette; dust settles around the body (blood: blood.kill)',
  at: 'bChest',
  priority: 95,
  post: { flash: 0.18, aberration: 1.5, vignette: 0.35 },
  layers: [
    { op: { k: 'sp', tex: 'star_06', n: 1, color: '#fff0d8', hdr: 14, add: true, dir: 'none', speed: [0, 0], size: [1.1, 1.1], life: [0.14, 0.14] } },
    { op: { k: 'sp', tex: 'trace_07', n: 30, color: '#ffe0b0', hdr: 7, add: true, dir: 'none', speed: [3, 9], vy: [0.5, 2.5], size: [0.05, 0.1], aspect: 0.22, stretch: 0.03, grav: 9, drag: 1.4, life: [0.3, 0.6] } },
    { op: { k: 'light', color: '#fff0d0', i: 20, dur: 0.25, radius: 9 } },
    { op: { k: 'ripple', size: 3.5, life: 0.55, strength: 1.5 } },
    { op: { k: 'sp', tex: '@dust_puff', n: 4, color: '$floor', alpha: 0.5, dir: 'none', cone: 1, speed: [0.5, 1.2], size: [0.8, 1.0], grow: 1.6, life: [1.3, 1.6], drag: 2, jitter: 0.7, rot: false }, at: 'bFeet', delay: 0.7 },
  ],
});
def({ id: 'kill.finisher', desc: 'finisher kill (its FX played on contact)', at: 'bChest', priority: 90, post: { aberration: 0.8 }, layers: [] });

// ================================================================== F3: everyday combat (catalog §1)
// Shared layer recipes. Colours are the hue; `hdr` the intensity (plan 2.4: sparks 6-12, cores 8-30,
// smoke / dust / blood at scene level <= 1).
type L = FxLayer;
const SPARK = (n: number, color = '#ffc888', speed: [number, number] = [4, 11], hdr = 9): L => ({
  op: { k: 'sp', tex: 'trace_07', n, color, hdr, add: true, dir: 'deflect', cone: 0.6, speed, vy: [0.8, 3], size: [0.05, 0.09], aspect: 0.2, stretch: 0.03, grav: 9, drag: 1.4, life: [0.25, 0.55] },
});
const FLARE = (size: number, color = '#fff2dc', hdr = 10, life = 0.07): L => ({ op: { k: 'sp', tex: 'star_06', n: 1, color, hdr: hdr * 0.7, add: true, dir: 'none', speed: [0, 0], size: [size * 0.7, size * 0.7], grow: 0.7, life: [life, life] } });
const GLINT = (n: number): L => ({ op: { k: 'sp', tex: 'star_01', n, color: '#fff6e8', hdr: 6, add: true, dir: 'none', speed: [1, 3], size: [0.06, 0.1], life: [0.1, 0.18], drag: 3 } });
const WISP = (color = '#55504a', alpha = 0.35): L => ({
  op: { k: 'sp', tex: '@unity_wispysmoke01', n: 1, color, alpha, dir: 'up', cone: 0.3, speed: [0.15, 0.35], size: [0.45, 0.55], grow: 1.5, life: [0.9, 1.2], drag: 1, fps: 30, frame0: [0, 40], rot: false, minQ: 1 },
});
const MIST = (color: string, alpha: number, n = 2, size: [number, number] = [0.22, 0.32]): L => ({
  op: { k: 'sp', tex: 'smoke_07', n, color, alpha, hdr: 1, dir: 'cut', cone: 0.5, speed: [0.4, 1.0], size, grow: 2.6, life: [0.45, 0.75], drag: 3.5, minQ: 1 },
});
const FIBRES = (color: string, n = 7): L => ({
  op: { k: 'sp', tex: 'trace_04', n, color, alpha: 0.9, hdr: 0.9, dir: 'cut', cone: 0.7, speed: [1, 3], vy: [0.5, 1.5], size: [0.03, 0.06], aspect: 0.3, grav: 2.5, drag: 3, spin: 6, life: [0.5, 0.9] },
});
const LIGHT = (color: string, i: number, dur = 0.12): L => ({ op: { k: 'light', color, i, dur, radius: 6 } });

// ---- C06a-f impacts by strike class x victim surface (RESOLVE.hit picks impact.<group>.<surface>)
def({ id: 'impact.cut.metal', desc: 'C06a blade / claw on metal (Aldric\'s plate): white-hot flare, spark streaks with gravity, glints, smoke wisp, warm light', at: 'contact', priority: 60, layers: [FLARE(0.42), SPARK(28), GLINT(4), WISP(), LIGHT('#ffd8b0', 9)] });
def({ id: 'impact.blunt.metal', desc: 'C06c blunt on metal: dull flare, a few sparks, smoke wisp', at: 'contact', priority: 55, layers: [FLARE(0.3, '#ffe8c8', 6), SPARK(10, '#ffbf80', [3, 7], 7), WISP('#5a554e', 0.3), LIGHT('#ffd0a0', 4)] });
def({ id: 'impact.cut.flesh', desc: 'C06b blade / claw on flesh: a dark mist and fibres (blood is blood.cut, by gore)', at: 'contact', priority: 50, layers: [MIST('#2a2220', 0.28, 1), FIBRES('#5a4a3c', 4)] });
def({ id: 'impact.cut.fur', desc: 'C06b blade / claw on fur (Fenrik): hair tufts drifting down, mist', at: 'contact', priority: 50, layers: [MIST('#2a2420', 0.25, 1), { op: { k: 'sp', tex: 'trace_03', n: 9, color: '#bdb4a6', alpha: 0.9, hdr: 0.9, dir: 'cut', cone: 0.8, speed: [0.8, 2.4], vy: [0.6, 1.6], size: [0.05, 0.08], aspect: 0.25, grav: 1.6, drag: 3.5, spin: 5, life: [0.8, 1.3] } }] });
def({ id: 'impact.cut.cloth', desc: 'C06b blade on cloth (Ozrel\'s robes): fibres and lint', at: 'contact', priority: 50, layers: [MIST('#2a2420', 0.22, 1), FIBRES('#6a5a48', 9)] });
const BLUNT_BODY: L[] = [
  { op: { k: 'sp', tex: '@dust_puff', n: 2, color: '#8a7c6c', alpha: 0.45, dir: 'hit', cone: 0.6, speed: [0.6, 1.4], size: [0.4, 0.5], grow: 1.5, life: [0.5, 0.7], drag: 4, jitter: 0.08, rot: false } },
  { op: { k: 'sp', tex: 'circle_05', n: 8, color: '#c8d0d8', alpha: 0.55, hdr: 0.9, dir: 'hit', cone: 0.6, speed: [1.5, 3.5], vy: [0.3, 1.2], size: [0.02, 0.035], stretch: 0.02, grav: 9, drag: 1, life: [0.3, 0.5] } },
  { op: { k: 'ripple', size: 0.9, life: 0.22, strength: 0.6, tier: 2 } },
];
def({ id: 'impact.blunt.flesh', desc: 'C06c blunt on a body: compression dust off the surface, sweat spray, short shock ripple (high)', at: 'contact', priority: 50, layers: BLUNT_BODY });
def({ id: 'impact.blunt.fur', desc: 'C06c blunt on fur', at: 'contact', priority: 50, layers: [...BLUNT_BODY.slice(0, 1), BLUNT_BODY[2]] });
def({ id: 'impact.blunt.cloth', desc: 'C06c blunt on cloth', at: 'contact', priority: 50, layers: [...BLUNT_BODY.slice(0, 1), BLUNT_BODY[2]] });
def({
  id: 'impact.any.pumpkin',
  desc: 'C06d any hit on Hollowjack: orange pulp chunks, seeds, pulp spatter (never blood)',
  at: 'contact',
  priority: 55,
  layers: [
    { op: { k: 'chips', n: 7, color: '#d8701c', scale: 0.32, speed: 0.7 } },
    { op: { k: 'sp', tex: 'circle_05', n: 12, color: '#efe2a8', alpha: 1, hdr: 0.8, dir: 'cut', cone: 0.7, speed: [2, 4.5], vy: [0.5, 2], size: [0.025, 0.035], aspect: 0.6, grav: 9, drag: 0.8, life: [0.5, 0.8] } },
    { op: { k: 'sp', tex: 'dirt_02', n: 2, color: '#c8641a', alpha: 0.95, hdr: 0.8, dir: 'cut', cone: 0.4, speed: [1.2, 2.2], size: [0.28, 0.36], grow: 1.6, drag: 6, life: [0.18, 0.26] } },
  ],
});
def({ id: 'impact.pierce.metal', desc: 'C20 arrow on metal: a short spark spray and a glint', at: 'contact', priority: 50, layers: [FLARE(0.25, '#fff2dc', 6), SPARK(10, '#ffd0a0', [3, 7], 7)] });
def({ id: 'impact.pierce.flesh', desc: 'C20 arrow into a body: a puff of dark mist (blood: blood.pierce)', at: 'contact', priority: 45, layers: [MIST('#2a2220', 0.22, 1)] });
// heavy hits add a hot core + post punch at the contact and a ground shockwave (C11)
def({
  id: 'impact.heavy',
  desc: 'heavy hit core: flare, CA, flash, vignette, pressure ripple, light',
  at: 'contact',
  priority: 60,
  post: { aberration: 1, flash: 0.05, vignette: 0.12 },
  layers: [FLARE(0.8, '#fff0dc', 9, 0.1), { op: { k: 'ripple', size: 1.4, life: 0.32, strength: 0.9 } }, LIGHT('#ffd8b0', 8, 0.16)],
});
def({
  id: 'shock.heavy',
  desc: 'C11 heavy-hit shockwave under the victim: ground dust ring, puffs, stone chips, floor crack decal',
  at: 'bFeet',
  priority: 55,
  layers: [
    { op: { k: 'sp', tex: '@dust_ring', n: 1, color: '$floor', alpha: 0.45, dir: 'none', speed: [0, 0], size: [1.1, 1.1], grow: 1.4, life: [0.9, 0.9], rot: false } },
    { op: { k: 'sp', tex: '@dust_puff', n: 2, color: '$floor', alpha: 0.35, dir: 'none', cone: 1, speed: [0.5, 1.2], size: [0.4, 0.5], grow: 1.5, life: [0.7, 0.9], drag: 2.5, jitter: 0.35, rot: false, minQ: 1 } },
    { op: { k: 'chips', n: 5, color: '$floor', scale: 0.2, speed: 0.6 }, y: 0.08 },
    { op: { k: 'decal', cell: ['crack_1', 'crack_2', 'crack_3'], who: 'b', size: [1.0, 1.5], off: [-0.1, 0.3], align: 'hit', alpha: [0.6, 0.85], nrm: 1, rough: 0.9 } },
  ],
});

// ---- blood (gore: off -> substitutes, standard = Elden-Ring-like, full = more volume). Decals and
// wounds are positioned from recorded frame data and seeded: a seek rebuilds them exactly.
const BLOOD = '#a0101a';
const BLOOD_MIST = '#6a0c12';
const SPLATS: DecalCell[] = ['blood_splat_0', 'blood_splat_1', 'blood_splat_2', 'blood_splat_3'];
const SPATTER = (n: number, size: [number, number]): L => ({
  op: { k: 'sp', tex: 'dirt_02', n, color: '#8a0c14', alpha: 1, hdr: 1, dir: 'cut', cone: 0.35, speed: [1.4, 2.6], size: [size[0] * 1.5, size[1] * 1.5], grow: 1.8, drag: 6, life: [0.18, 0.28] },
});
const STRANDS = (n: number): L => ({
  op: { k: 'sp', tex: 'trace_04', n, color: BLOOD, alpha: 1, hdr: 1, dir: 'cut', cone: 0.35, speed: [3, 6], vy: [0.5, 1.5], size: [0.08, 0.13], aspect: 0.35, stretch: 0.05, grav: 9, drag: 0.8, life: [0.25, 0.45] },
});
const SPLAT = (size: [number, number], n = 1, delay = 0.22): L => ({ op: { k: 'decal', cell: SPLATS, n, who: 'b', size, off: [0.35, 1.0], side: 0.35, align: 'hit', alpha: [0.8, 0.95], nrm: 0.45, rough: 0.16, blood: true, grow: 0.12, aspect: [1, 1.5] }, delay });
const OFF_MIST: L[] = [MIST('#1c1816', 0.3, 2), FIBRES('#4a3e34', 5)];

def({
  id: 'blood.cut',
  desc: 'C06b/C17 cut on flesh (gore standard): arterial droplets + strands + spatter + mist, floor splat and drops, a wound',
  at: 'contact',
  priority: 55,
  gore: { off: 'blood.cut.off', full: 'blood.cut.full' },
  layers: [
    { op: { k: 'blood', n: 30, speed: [2.5, 6.5], dir: 'cut', cone: 0.45, size: [0.035, 0.07], drops: 5 } },
    SPATTER(2, [0.22, 0.34]),
    STRANDS(5),
    MIST(BLOOD_MIST, 0.32, 2),
    SPLAT([0.45, 0.8]),
    { op: { k: 'wound', r: [0.09, 0.13], amt: 1 } },
  ],
});
def({
  id: 'blood.cut.full',
  desc: 'gore full: more droplets, larger splats, a second splat',
  at: 'contact',
  priority: 55,
  layers: [
    { op: { k: 'blood', n: 48, speed: [2.5, 7.5], dir: 'cut', cone: 0.5, size: [0.04, 0.075], drops: 10 } },
    SPATTER(3, [0.28, 0.42]),
    STRANDS(9),
    MIST(BLOOD_MIST, 0.4, 4, [0.3, 0.42]),
    SPLAT([0.7, 1.1], 2),
    { op: { k: 'wound', r: [0.11, 0.16], amt: 1 } },
  ],
});
def({ id: 'blood.cut.off', desc: 'gore off: dark mist and fibres instead of blood', at: 'contact', priority: 40, layers: OFF_MIST });
def({
  id: 'blood.cut.armor',
  desc: 'cut on plate (Aldric): less blood, through the gaps',
  at: 'contact',
  priority: 50,
  gore: { off: null, full: 'blood.cut' },
  layers: [{ op: { k: 'blood', n: 10, speed: [2, 5], dir: 'cut', cone: 0.5, size: [0.016, 0.028], drops: 2 } }, STRANDS(2), SPLAT([0.3, 0.5]), { op: { k: 'wound', r: [0.07, 0.1], amt: 0.8 } }],
});
def({
  id: 'blood.pierce',
  desc: 'arrow wound: a thin spray along the arrow, drops, a wound',
  at: 'contact',
  priority: 50,
  gore: { off: 'blood.cut.off', full: 'blood.cut' },
  layers: [{ op: { k: 'blood', n: 12, speed: [2, 5], dir: 'hit', cone: 0.3, size: [0.016, 0.028], drops: 3 } }, MIST(BLOOD_MIST, 0.25, 1), SPLAT([0.3, 0.5]), { op: { k: 'wound', r: [0.06, 0.09], amt: 1 } }],
});
def({
  id: 'blood.blunt',
  desc: 'heavy blunt hit: a short burst of blood (mouth / nose), small splat, bruise wound',
  at: 'contact',
  priority: 45,
  gore: { off: null },
  layers: [{ op: { k: 'blood', n: 10, speed: [1.5, 4], dir: 'hit', cone: 0.6, size: [0.016, 0.03], drops: 3 } }, SPLAT([0.3, 0.5]), { op: { k: 'wound', r: [0.07, 0.1], amt: 0.6 } }],
});
def({ id: 'blood.blade', desc: 'C16 blood on the attacker\'s blade / claws (grows towards the hilt with each cut)', at: 'aChest', priority: 30, gore: { off: null }, layers: [{ op: { k: 'bladeBlood', amt: 0.22 } }] });
def({
  id: 'blood.kill',
  desc: 'CI7/C17 killing blow (gore): blood burst, splats, a pool growing under the body over ~3 s',
  at: 'bChest',
  priority: 90,
  gore: { off: 'blood.kill.off', full: 'blood.kill.full' },
  layers: [
    { op: { k: 'blood', n: 34, speed: [2, 6], dir: 'cut', cone: 0.7, size: [0.02, 0.04], drops: 6 } },
    SPATTER(3, [0.3, 0.45]),
    MIST(BLOOD_MIST, 0.4, 3, [0.3, 0.42]),
    SPLAT([0.6, 1.0], 2),
    { op: { k: 'decal', cell: 'blood_pool', who: 'b', body: 1.4, size: [1.3, 1.7], grow: 3.2, alpha: [0.92, 0.98], nrm: 0.3, rough: 0.1, blood: true, align: 'random', aspect: [1, 1.35] }, delay: 1.0 },
    { op: { k: 'wound', r: [0.13, 0.17], amt: 1 } },
  ],
});
def({
  id: 'blood.kill.full',
  desc: 'gore full kill: more blood, a larger pool',
  at: 'bChest',
  priority: 90,
  layers: [
    { op: { k: 'blood', n: 56, speed: [2, 7], dir: 'cut', cone: 0.75, size: [0.02, 0.045], drops: 10 } },
    SPATTER(4, [0.34, 0.5]),
    MIST(BLOOD_MIST, 0.45, 4, [0.34, 0.46]),
    SPLAT([0.8, 1.3], 3),
    { op: { k: 'decal', cell: 'blood_pool', who: 'b', body: 1.4, size: [1.9, 2.4], grow: 4, alpha: [0.95, 1], nrm: 0.3, rough: 0.1, blood: true, align: 'random', aspect: [1, 1.35] }, delay: 1.0 },
    { op: { k: 'wound', r: [0.15, 0.2], amt: 1 } },
  ],
});
def({ id: 'blood.kill.off', desc: 'gore off kill: dark mist', at: 'bChest', priority: 60, layers: [MIST('#1c1816', 0.35, 3, [0.3, 0.4])] });
def({
  id: 'blood.pool',
  desc: 'C17 pool growing under a body (finisher kills, knockdowns when badly hurt)',
  at: 'bFeet',
  priority: 40,
  gore: { off: null },
  layers: [{ op: { k: 'decal', cell: 'blood_pool', who: 'b', body: 1.2, size: [1.1, 1.5], grow: 3.2, alpha: [0.9, 0.98], nrm: 0.3, rough: 0.1, blood: true, align: 'random', aspect: [1, 1.35] }, delay: 0.9 }],
});
def({
  id: 'blood.down',
  desc: 'C17 small pool under a downed, badly hurt fighter',
  at: 'aFeet',
  priority: 30,
  gore: { off: null },
  layers: [{ op: { k: 'decal', cell: 'blood_pool', who: 'a', body: 0.8, size: [0.6, 0.85], grow: 2.2, alpha: [0.85, 0.95], nrm: 0.3, rough: 0.12, blood: true, align: 'random', aspect: [1, 1.3] }, delay: 0.6 }],
});

// ---- C01 / C02 footsteps by floor surface (render observation: stride ticks of recorded motion > 2.5 m/s)
const STEP_DUST = (color: string, alpha: number, size: [number, number]): L => ({
  op: { k: 'sp', tex: '@dust_puff', n: 1, color, alpha, dir: 'back', cone: 0.6, speed: [0.3, 0.7], size, grow: 1.5, life: [0.55, 0.75], drag: 3, jitter: 0.05, rot: false },
});
def({ id: 'step.dust', desc: 'C01 running footstep: a small dust puff (stone, sand, earth, ash)', at: 'aFeet', priority: 10, layers: [STEP_DUST('$floor', 0.4, [0.28, 0.38])] });
def({
  id: 'step.snow',
  desc: 'C02 footstep in snow: a bright powder puff and flakes',
  at: 'aFeet',
  priority: 10,
  layers: [STEP_DUST('#e8f0f8', 0.55, [0.32, 0.42]), { op: { k: 'sp', tex: 'circle_05', n: 5, color: '#f4f8ff', alpha: 0.8, hdr: 1, dir: 'back', cone: 0.7, speed: [0.8, 1.8], vy: [0.8, 1.6], size: [0.015, 0.025], grav: 6, drag: 1.5, life: [0.35, 0.55] } }],
});
def({
  id: 'step.wet',
  desc: 'C02 footstep on a wet floor: fine droplets',
  at: 'aFeet',
  priority: 10,
  layers: [{ op: { k: 'sp', tex: 'circle_05', n: 7, color: '#a8b8c8', alpha: 0.6, hdr: 1, dir: 'back', cone: 0.8, speed: [0.6, 1.6], vy: [0.8, 1.8], size: [0.012, 0.022], stretch: 0.02, grav: 9, drag: 1, life: [0.25, 0.45] } }],
});
def({
  id: 'step.water',
  desc: 'C02 footstep in water: a splash crown and droplets',
  at: 'aFeet',
  priority: 12,
  layers: [
    { op: { k: 'sp', tex: '@splash', n: 1, color: '#c8daf0', alpha: 0.85, dir: 'none', speed: [0, 0], size: [0.55, 0.65], life: [0.55, 0.6], rot: false } },
    { op: { k: 'sp', tex: 'circle_05', n: 10, color: '#c8dcf0', alpha: 0.7, hdr: 1.1, dir: 'up', cone: 0.6, speed: [1.5, 3], size: [0.015, 0.028], stretch: 0.02, grav: 9, drag: 0.6, life: [0.35, 0.6] } },
  ],
});
def({ id: 'dodge.skid', desc: 'C10 dodge skid dust (per tick while dodging)', at: 'aFeet', priority: 10, layers: [STEP_DUST('$floor', 0.38, [0.3, 0.42])] });

// ---- arena / destruction
def({
  id: 'explosion.keg',
  desc: 'powder keg explosion',
  at: 'event',
  priority: 90,
  post: { flash: 0.07, aberration: 1.2, vignette: 0.3 },
  layers: [
    { op: { k: 'ripple', size: 6, life: 0.6, strength: 2 }, minY: 0.6 },
    { op: { k: 'heat', size: 3.2, height: 4.5, life: 2.6, strength: 1.4, rise: 2.2, tier: 1 }, y: 0.1 },
    { op: { k: 'flash', color: '#ffc070', size: 4, light: 40 }, minY: 0.6 },
    // F3: the Unity Labs flipbooks are the default fireball and smoke (the own bakes are 'alt' atlases)
    { op: { k: 'sp', tex: '@unity_explosion00', n: 1, color: '#ffffff', hdr: 2.2, dir: 'none', speed: [0, 0], size: [4.2, 4.2], grow: 1.25, life: [1.6, 1.6], rot: false }, minY: 1.4 },
    { op: { k: 'sp', tex: '@unity_explosion01_nofire', n: 2, color: '#3a3430', alpha: 0.85, dir: 'up', cone: 0.5, speed: [0.4, 0.9], size: [3.2, 3.6], grow: 1.5, life: [2.4, 2.8], drag: 0.6, jitter: 0.6, rot: false }, minY: 1.6, delay: 0.25 },
    { op: { k: 'sp', tex: '@dust_ring', n: 1, color: '$floor', alpha: 0.8, dir: 'none', speed: [0, 0], size: [3.6, 3.6], grow: 1.6, life: [1.3, 1.3], rot: false }, y: 0 },
    { op: { k: 'fireBurst', n: 24, shape: 'sphere', speed: [6, 12], size: 0.6, spread: 0.6 }, minY: 0.6 },
    { op: { k: 'sparks', n: 50, color: '#ffd090', speed: 12 }, minY: 0.6 },
  ],
});
def({ id: 'prop.hit', desc: 'thrown prop hits a fighter', at: 'event', priority: 55, post: { aberration: 0.8 }, layers: [{ op: { k: 'sparks', n: 24, color: '#fff0c8', speed: 7 } }, { op: { k: 'flash', color: '#fff0d0', size: 1.4, light: 10 } }, { op: { k: 'dust', n: 10, spread: 1.2 }, at: 'bFeet' }] });
def({ id: 'prop.batted', desc: 'thrown prop swatted aside', at: 'aChest', priority: 45, layers: [{ op: { k: 'sparks', n: 30, color: '#ffe0a0', speed: 8 } }] });
def({ id: 'topple.start', desc: 'cover starts to fall', at: 'obstacle', y: 0.2, priority: 40, layers: [{ op: { k: 'dust', n: 16, spread: 1.6 } }] });
def({ id: 'topple.impact', desc: 'fallen cover hits the floor', at: 'event', y: 0.2, priority: 60, layers: [{ op: { k: 'dust', n: 40, spread: 3.5 } }, { op: { k: 'shock', color: '#d8c8a8', size: 6, life: 0.7 } }] });
def({ id: 'crush', desc: 'fighter crushed by falling cover', at: 'bChest', priority: 70, post: { flash: 0.1 }, layers: [{ op: { k: 'sparks', n: 40, color: '#fff0c0', speed: 9 } }] });
def({ id: 'cover.hit', desc: 'strike lands on cover', at: 'obstacle', y: 1.2, priority: 20, layers: [{ op: { k: 'dust', n: 4, spread: 0.8 } }] });
def({ id: 'hazard.spikes.trigger', desc: 'spike trap fires', at: 'hazard', y: 0.2, priority: 30, layers: [{ op: { k: 'sparks', n: 10, color: '#ffb070', speed: 4 } }] });
def({ id: 'hazard.geyser.trigger', desc: 'geyser erupts', at: 'hazard', y: 0.2, priority: 30, layers: [{ op: { k: 'smoke', n: 8, color: '#e8f0f8', size: 1.0, rise: 0.6 } }] });
def({ id: 'hazard.chandelier.trigger', desc: 'chandelier chain snaps', at: 'hazard', y: 6.5, priority: 30, layers: [{ op: { k: 'dust', n: 12, spread: 1.0 } }] });
def({
  id: 'chandelier.impact',
  desc: 'chandelier hits the floor',
  at: 'event',
  y: 0.3,
  priority: 70,
  layers: [{ op: { k: 'sparks', n: 50, color: '#ffcf80', speed: 9 } }, { op: { k: 'dust', n: 30, spread: 2.5 } }, { op: { k: 'shock', color: '#e0c8a0', size: 5, life: 0.6 } }],
});
def({
  id: 'hazard.fire.hit',
  desc: 'thrown into lava / a fire pit',
  at: 'bFeet',
  y: 0.4,
  priority: 60,
  layers: [{ op: { k: 'fireBurst', n: 24, shape: 'box', box: [3, 3, 3], size: 0.6, spread: 0.6 } }, { op: { k: 'heat', size: 1.6, height: 2.6, life: 1.4, strength: 1.2, tier: 1 }, y: 0.1 }],
});
def({ id: 'hazard.spikes.hit', desc: 'thrown onto spikes', at: 'bFeet', y: 0.4, priority: 55, layers: [{ op: { k: 'sparks', n: 30, color: '#ffd0a0', speed: 8 } }] });
def({ id: 'hazard.geyser.hit', desc: 'launched by a geyser', at: 'bFeet', y: 0.4, priority: 55, layers: [{ op: { k: 'smoke', n: 30, color: '#eef6ff', size: 2.2, rise: 2.5 } }] });

// ---- attack phase observations (render-side, keyed by fighter + attack id)
def({
  id: 'active.nova',
  desc: 'nova burst at active start',
  at: 'aFeet',
  priority: 70,
  layers: [{ op: { k: 'shock', color: '#ff7a20', size: 7, life: 0.5 } }, { op: { k: 'fireBurst', n: 40, shape: 'ring', speed: [8, 1], size: 0.5, spread: 0.3 }, y: 0.6 }, { op: { k: 'ripple', size: 4.5, life: 0.5, strength: 1.3 }, y: 0.6 }, { op: { k: 'heat', size: 3, height: 2.4, life: 1.2, strength: 1 } }],
});
def({ id: 'active.lunge', desc: 'lunge push-off dust', at: 'aFeet', priority: 25, layers: [{ op: { k: 'dust', n: 10, spread: 1 } }] });

// ---- continuous emitters (one spawn per tick; see CONTINUOUS)
def({ id: 'stream.fire', desc: 'fire stream (per tick)', at: 'aCast', priority: 35, layers: [{ op: { k: 'fire', n: 1, size: 0.3, spread: 0.5, facing: 3 } }] });
def({ id: 'stream.pyre', desc: 'pyre stream (per tick)', at: 'aCast', priority: 35, layers: [{ op: { k: 'fire', n: 1, size: 0.5, spread: 0.5, facing: 3 } }] });
def({ id: 'aura.shadow', desc: 'shadow move smoke (per tick)', at: 'aFeet', y: 0.3, priority: 15, layers: [{ op: { k: 'smoke', n: 1, color: '#1d1626', size: 0.7, rise: 0.3 } }] });
def({ id: 'aura.ultWindup', desc: 'ultimate windup embers (per tick)', at: 'aFeet', y: 0.4, priority: 20, layers: [{ op: { k: 'embers', n: 2, color: '$accent', area: 0.8 } }] });
def({ id: 'aura.buff', desc: 'buff embers (per tick)', at: 'aFeet', y: 0.2, priority: 10, layers: [{ op: { k: 'embers', n: 1, color: '$accent', area: 0.5 } }] });
def({ id: 'aura.lastStand', desc: 'last stand embers (per tick)', at: 'aFeet', y: 0.2, priority: 10, layers: [{ op: { k: 'embers', n: 1, color: '#ff3a2a', area: 0.5 } }] });
def({ id: 'dodge.trail', desc: 'dodge dust (per tick)', at: 'aFeet', priority: 10, layers: [{ op: { k: 'dust', n: 1, spread: 0.6 } }] });
def({ id: 'ring.fire', desc: 'ring of fire flame (per tick)', at: 'ringEdge', y: 0.1, priority: 15, layers: [{ op: { k: 'fire', n: 1, size: 0.45, spread: 0.3, vel: [0, 2.5, 0] } }] });
def({ id: 'ring.heat', desc: 'heat shimmer over the ring of fire (per tick, high tier)', at: 'ringEdge', priority: 5, layers: [{ op: { k: 'heat', size: 1.6, height: 2.2, life: 1.1, strength: 0.8 } }] });
def({ id: 'stream.heat', desc: 'heat shimmer along a fire stream (per tick, high tier)', at: 'aCast', priority: 5, layers: [{ op: { k: 'heat', size: 0.9, height: 1.2, life: 0.6, strength: 0.7, rise: 1 } }] });
def({ id: 'proj.arrow.trail', desc: 'arrow glints (per tick)', at: 'origin', priority: 10, layers: [{ op: { k: 'embers', n: 1, color: '#e8fff0', area: 0.02 } }] });
def({ id: 'proj.shadow.trail', desc: 'shadow bolt smoke (per tick)', at: 'origin', priority: 10, layers: [{ op: { k: 'smoke', n: 1, color: '#2a1838', size: 0.35, rise: 0.1 } }] });
def({ id: 'proj.fire.trail', desc: 'fireball flames (per tick)', at: 'origin', priority: 10, layers: [{ op: { k: 'fire', n: 2, size: 0.35, spread: 0.2, vel: [0, 0.6, 0] } }] });
def({ id: 'proj.pyre.trail', desc: 'pyre ball flames (per tick)', at: 'origin', priority: 10, layers: [{ op: { k: 'fire', n: 2, size: 0.6, spread: 0.2, vel: [0, 0.6, 0] } }] });
def({ id: 'proj.arrow.end', desc: 'arrow lands / vanishes', at: 'origin', priority: 30, layers: [{ op: { k: 'sparks', n: 10, color: '#e8fff0', speed: 4 } }] });
def({ id: 'proj.fire.end', desc: 'bolt lands / vanishes', at: 'origin', priority: 30, layers: [{ op: { k: 'sparks', n: 10, color: '#ffb060', speed: 4 } }] });

export const DEFS: Record<string, FxDef> = Object.fromEntries(list.map((d) => [d.id, d]));

// ------------------------------------------------------------------ event resolution
/** What the resolver can ask about the match (all optional: the FX Lab has none of it). */
export interface ResolveCtx {
  /** is this a finisher move id (kill by finisher)? */
  isFinisher?: (move: string) => boolean;
  hazardKind?: (i: number) => string | undefined;
  /** the camera is on a finisher / cut-in shot (no impact sparks over it); unused in F0 */
  inFinisher?: boolean;
  /** F3: strike class of fighter i's move (fxSurfaces.weaponClassOf) */
  weaponClass?: (i: number, move: string, fx: string) => WeaponClass;
  /** F3: body surface of fighter i */
  surface?: (i: number) => Surface;
  /** F3: fighter i's hp fraction at sim time t (recorded frames) */
  hpFrac?: (i: number, t: number) => number;
  /** F3: fighter id */
  fighterId?: (i: number) => string;
}

/** impact group of a strike class */
const GROUP: Record<WeaponClass, string> = { axe: 'cut', sword: 'cut', claw: 'cut', pierce: 'pierce', blunt: 'blunt', fire: 'fire', shadow: 'shadow' };
const pick = (...ids: string[]) => ids.find((x) => x in DEFS);

type Ids = (string | false | null | undefined)[];
/**
 * Sim event -> effect ids, one line per EventType that has visuals. Lookup order
 * for later milestones: (fighter, move) -> move -> fx tag -> kind + weapon class.
 */
export const RESOLVE: Partial<Record<SimEvent['type'], (e: SimEvent, c: ResolveCtx) => Ids>> = {
  // F3: impact by strike class x victim surface, a heavy core + ground shockwave, blood by gore
  hit: (e, c) => {
    const fx = String(e.data?.fx ?? '');
    const heavy = !!e.data?.heavy;
    const move = String(e.data?.move ?? '');
    const kind = HIT_KIND(fx);
    const b = e.b ?? -1;
    const cls: WeaponClass = c.weaponClass?.(e.a, move, fx) ?? 'blunt';
    const surf: Surface = c.surface?.(b) ?? 'flesh';
    const g = GROUP[cls];
    const ids: Ids = [];
    if (surf === 'pumpkin') ids.push('impact.any.pumpkin');
    else ids.push(pick(`impact.${g}.${surf}`, `impact.${g}.flesh`, g === 'fire' || g === 'shadow' ? `impact.${g}` : 'impact.default') ?? 'impact.default');
    // magic flavour sparks (fire / shadow / holy colours) on top of a physical strike
    if (kind !== 'default' && g !== kind) ids.push(`impact.${kind}`);
    if (heavy) ids.push('impact.heavy', 'shock.heavy');
    if (fx === 'quake') ids.push('impact.quake');
    if (fx === 'fire' || fx === 'pyre') ids.push('impact.fireBurst');
    if (BLEEDS[surf] && g !== 'fire') {
      if (CUTS[cls]) ids.push(cls === 'pierce' ? 'blood.pierce' : surf === 'metal' ? 'blood.cut.armor' : 'blood.cut');
      else if (heavy) ids.push('blood.blunt');
      if (CUTS[cls] && cls !== 'pierce') ids.push('blood.blade');
    }
    return ids;
  },
  block: (e, c) => ['block.sparks', c.fighterId?.(e.a) === 'aldric' && 'block.shield'],
  parry: () => ['parry.flash'],
  guard_break: () => ['guard.break'],
  dodge: () => ['dodge.dust'],
  knockdown: (e, c) => ['knockdown.dust', (c.hpFrac?.(e.a, e.t) ?? 1) < 0.4 && BLEEDS[c.surface?.(e.a) ?? 'flesh'] && 'blood.down'],
  wall_slam: () => ['slam.wall'],
  pillar_slam: () => ['slam.wall'],
  prop_break: () => ['prop.break'],
  ability_used: () => ['ult.cast'],
  second_wind: () => ['secondWind.burst'],
  last_stand: () => ['lastStand.burst'],
  hazard_burn: () => ['hazard.burn'],
  finisher_start: () => ['finisher.start'],
  finisher_contact: (e) => [e.data?.kind === 'kill' ? 'finisher.kill' : 'finisher.graze'],
  launch_land: () => ['launch.land'],
  kill: (e, c) => {
    const fin = c.isFinisher?.(String(e.data?.move ?? ''));
    const bleeds = BLEEDS[c.surface?.(e.b ?? -1) ?? 'flesh'];
    return [fin ? 'kill.finisher' : 'kill.plain', bleeds && (fin ? 'blood.pool' : 'blood.kill'), !bleeds && !fin && 'impact.any.pumpkin'];
  },
  explosion: () => ['explosion.keg'],
  prop_hit: () => ['prop.hit'],
  prop_batted: () => ['prop.batted'],
  topple: () => ['topple.start'],
  topple_impact: () => ['topple.impact'],
  crush: () => ['crush'],
  cover_hit: () => ['cover.hit'],
  hazard_trigger: (e, c) => {
    const k = c.hazardKind?.(Number(e.data?.haz));
    return [k === 'spikes' ? 'hazard.spikes.trigger' : k === 'geyser' ? 'hazard.geyser.trigger' : k === 'chandelier' ? 'hazard.chandelier.trigger' : null];
  },
  chandelier_impact: () => ['chandelier.impact'],
  hazard_hit: (e, c) => {
    const k = c.hazardKind?.(Number(e.data?.haz));
    return [k === 'lava' || k === 'firepit' ? 'hazard.fire.hit' : k === 'spikes' ? 'hazard.spikes.hit' : k === 'geyser' ? 'hazard.geyser.hit' : null];
  },
};

/** Attack-phase observations: fired once when a fighter's attack enters its active phase. */
export const ON_ACTIVE: ((mv: MoveDef) => Ids)[] = [(mv) => [mv.fx === 'nova' && 'active.nova'], (mv) => [(mv.lunge ?? 0) > 3 && 'active.lunge']];

/**
 * Continuous emitters. `rate` = spawns per second of SIM time (the old code
 * emitted per frame with probability p * simDt * 60, i.e. rate = 60 p): ticks
 * at fixed sim times make them frame-rate independent and reproducible.
 */
export interface ContinuousDef {
  key: string;
  rate: number;
  /** effect id while active, else null */
  when: (f: FighterFrame, mv: MoveDef | undefined) => string | null;
}
export const CONTINUOUS: ContinuousDef[] = [
  { key: 'fireStream', rate: 60, when: (f, mv) => (f.state === 'attack' && mv && f.phase === 1 && mv.fx === 'fire' ? 'stream.fire' : null) },
  { key: 'pyreStream', rate: 120, when: (f, mv) => (f.state === 'attack' && mv && f.phase === 1 && mv.fx === 'pyre' ? 'stream.pyre' : null) },
  { key: 'streamHeat', rate: 8, when: (f, mv) => (f.state === 'attack' && mv && f.phase === 1 && (mv.fx === 'fire' || mv.fx === 'pyre') ? 'stream.heat' : null) },
  { key: 'shadow', rate: 30, when: (f, mv) => (f.state === 'attack' && mv && mv.fx === 'shadow' && f.phase <= 1 ? 'aura.shadow' : null) },
  { key: 'ultWindup', rate: 36, when: (f, mv) => (f.state === 'attack' && mv?.kind === 'ultimate' && f.phase === 0 ? 'aura.ultWindup' : null) },
  { key: 'buff', rate: 21, when: (f) => (f.lastStand ? 'aura.lastStand' : f.buff > 0 ? 'aura.buff' : null) },
  { key: 'dodge', rate: 12, when: (f) => (f.state === 'dodge' ? 'dodge.skid' : null) },
];
/** ring of fire: flames per second of sim time while the ring is closing (old: 3 per frame) */
export const RING_FIRE_RATE = 180;
/** ring of fire heat shimmer sprites per second of sim time (F1; distortion tier 2 only) */
export const RING_HEAT_RATE = 9;
/** projectile trails per second of sim time (old: per frame) */
export const PROJ_TRAIL_RATE = 60;
export const projTrail = (fx: string) => (fx === 'arrow' ? 'proj.arrow.trail' : fx === 'shadow' ? 'proj.shadow.trail' : fx === 'seed' ? null : fx === 'pyre' ? 'proj.pyre.trail' : 'proj.fire.trail');
export const projEnd = (fx: string) => (fx === 'arrow' ? 'proj.arrow.end' : 'proj.fire.end');

/** Longest visible life of a def (s): spawn delay + the longest primitive life. */
export function defDuration(d: FxDef): number {
  const L: Record<FxOp['k'], number> = { sparks: 0.6, flash: 0.2, dust: 1.3, smoke: 2.5, fire: 0.6, fireBurst: 0.6, embers: 2.5, shock: 0.5, debris: 6, heat: 1, ripple: 0.5, sp: 1, blood: 1.2, decal: 0.5, wound: 0.3, bladeBlood: 0.2, light: 0.2, chips: 6, ghost: 0.5 };
  let m = 0;
  for (const l of d.layers) {
    const op = l.op;
    const life =
      op.k === 'shock' ? (op.life ?? 0.5)
      : op.k === 'heat' || op.k === 'ripple' ? op.life
      : op.k === 'sp' ? (op.life?.[1] ?? 1)
      : op.k === 'light' ? op.dur
      : op.k === 'ghost' ? op.gap * op.n + op.life
      : op.k === 'decal' ? 0.5 + (op.body ?? 0)
      : L[op.k];
    m = Math.max(m, (l.delay ?? 0) + life);
  }
  return m;
}

/** frame type re-export for the director */
export type { Frame };
