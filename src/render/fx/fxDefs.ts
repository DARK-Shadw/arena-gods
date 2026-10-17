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

/** One emission. Kinds map 1:1 to the primitives in legacyVfx.ts (F0); F1+ add flipbook/ribbon/decal/card/dist/light kinds. */
export type FxOp =
  | { k: 'sparks'; n: number; color?: FxColor; speed?: number }
  | { k: 'flash'; color?: FxColor; size?: number; light?: number }
  | { k: 'dust'; n: number; spread?: number; color?: FxColor }
  | { k: 'smoke'; n: number; color?: FxColor; size?: number; rise?: number }
  /** vel: fixed velocity, or 'facing' (actor facing x speed, y = -0.05) */
  | { k: 'fire'; n: number; size?: number; spread?: number; vel?: Vec3; facing?: number }
  /**
   * Fire burst, one particle per direction:
   *  sphere: dir = normalize(r-0.5, r*0.9+0.2, r-0.5) * speed[0..1]
   *  ring:   n evenly spaced horizontal dirs * speed[0], vy = speed[1]
   *  box:    ((r-0.5)*box[0], box[1] + r*box[1], (r-0.5)*box[2])
   */
  | { k: 'fireBurst'; n: number; shape: 'sphere' | 'ring' | 'box'; speed?: [number, number]; box?: Vec3; size: number; spread: number }
  | { k: 'embers'; n: number; color?: FxColor; area?: number }
  | { k: 'shock'; color?: FxColor; size?: number; life?: number }
  | { k: 'debris'; n: number; color?: FxColor };

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
}

export interface FxDef {
  id: string;
  /** what it is (FX Lab tooltip) */
  desc?: string;
  at: Anchor;
  y?: number;
  layers: FxLayer[];
  /** post kicks the game applies this frame (max with what is already running) */
  post?: { aberration?: number; flash?: number };
  /** id substitution by gore level (blood rows from F3 on). null = nothing at that level */
  gore?: { off?: string | null; stylised?: string | null; full?: string | null };
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
    post: { aberration: 1, flash: 0.06 },
    layers: [{ op: { k: 'sparks', n: 40, color, speed: 9 } }, { op: { k: 'flash', color, size: 1.6, light: 14 } }, { op: { k: 'dust', n: 10, spread: 1.2 }, at: 'bFeet' }],
  });
}
def({ id: 'impact.quake', desc: 'quake hit: ground ring at the attacker', at: 'aFeet', priority: 55, layers: [{ op: { k: 'shock', color: '#ffb070', size: 8, life: 0.6 } }, { op: { k: 'dust', n: 30, spread: 2.5 } }] });
def({ id: 'impact.fireBurst', desc: 'fire hit: flames off the contact', at: 'contact', priority: 45, layers: [{ op: { k: 'fire', n: 6, size: 0.4, spread: 1, vel: [0, 2, 0] } }] });
def({ id: 'block.sparks', desc: 'blocked strike', at: 'blockContact', priority: 50, layers: [{ op: { k: 'sparks', n: 16, color: '#ffd59a', speed: 5 } }, { op: { k: 'flash', color: '#ffe2b0', size: 0.5, light: 3 } }] });
def({ id: 'parry.flash', desc: 'parry', at: 'parryContact', priority: 70, post: { aberration: 0.8 }, layers: [{ op: { k: 'sparks', n: 50, color: '#cfe6ff', speed: 9 } }, { op: { k: 'flash', color: '#d8ecff', size: 1.6, light: 16 } }] });
def({ id: 'guard.break', desc: 'guard broken', at: 'aChest', priority: 55, layers: [{ op: { k: 'sparks', n: 30, color: '#ffb070', speed: 7 } }] });
def({ id: 'dodge.dust', desc: 'dodge start', at: 'aFeet', priority: 20, layers: [{ op: { k: 'dust', n: 8, spread: 0.9 } }] });
def({
  id: 'knockdown.dust',
  desc: 'body hits the floor (0.15 s after the event, on FX time)',
  at: 'aFeet',
  priority: 40,
  layers: [
    { op: { k: 'dust', n: 18, spread: 1.6 }, delay: 0.15 },
    { op: { k: 'shock', color: '#c8b090', size: 3, life: 0.4 }, delay: 0.15 },
  ],
});
def({ id: 'slam.wall', desc: 'wall / pillar slam', at: 'aChest', priority: 50, layers: [{ op: { k: 'dust', n: 20, spread: 1.5 }, at: 'aFeet' }, { op: { k: 'sparks', n: 20, color: '#ffcf8a', speed: 6 } }] });
def({ id: 'prop.break', desc: 'prop destroyed', at: 'event', priority: 30, layers: [{ op: { k: 'dust', n: 10, spread: 1.0 } }] });
def({
  id: 'ult.cast',
  desc: 'ultimate used',
  at: 'aChest',
  priority: 80,
  post: { flash: 0.08 },
  layers: [{ op: { k: 'flash', color: '$accent', size: 2.5, light: 20 } }, { op: { k: 'shock', color: '$accent', size: 4, life: 0.6 }, at: 'aFeet' }],
});
def({ id: 'secondWind.burst', desc: 'second wind / cornered', at: 'aFeet', priority: 70, layers: [{ op: { k: 'embers', n: 60, color: '$accent', area: 1.2 }, y: 0.3 }, { op: { k: 'shock', color: '$accent', size: 5, life: 0.7 } }] });
def({ id: 'lastStand.burst', desc: 'last stand', at: 'aFeet', priority: 75, layers: [{ op: { k: 'embers', n: 80, color: '#ff3a2a', area: 1.4 }, y: 0.3 }, { op: { k: 'shock', color: '#ff3a2a', size: 6, life: 0.8 } }] });
def({ id: 'hazard.burn', desc: 'standing in fire / lava (tick)', at: 'aFeet', y: 0.4, priority: 40, layers: [{ op: { k: 'fire', n: 6, size: 0.4, spread: 0.5, vel: [0, 2, 0] } }] });
def({ id: 'finisher.start', desc: 'finisher begins (post only)', at: 'aChest', priority: 90, post: { flash: 0.12 }, layers: [] });
def({ id: 'finisher.graze', desc: 'non-lethal finisher contact', at: 'bChest', priority: 50, layers: [{ op: { k: 'sparks', n: 24, color: '#fff0c8', speed: 6 } }, { op: { k: 'dust', n: 8, spread: 1.0 }, at: 'bFeet' }] });
def({ id: 'finisher.kill', desc: 'finisher kill contact (geometry FX are FinisherFx)', at: 'bChest', priority: 90, post: { aberration: 1.4 }, layers: [] });
def({ id: 'launch.land', desc: 'landing after a launch', at: 'aFeet', priority: 50, layers: [{ op: { k: 'dust', n: 26, spread: 1.8 } }, { op: { k: 'shock', color: '#c8b090', size: 4, life: 0.5 } }] });
def({
  id: 'kill.plain',
  desc: 'killing blow (no finisher)',
  at: 'bChest',
  priority: 95,
  post: { flash: 0.25, aberration: 1.5 },
  layers: [{ op: { k: 'sparks', n: 80, color: '#fff0c0', speed: 11 } }, { op: { k: 'flash', color: '#fff0d0', size: 3, light: 30 } }, { op: { k: 'shock', color: '#ffffff', size: 7, life: 0.8 }, at: 'bFeet' }],
});
def({ id: 'kill.finisher', desc: 'finisher kill (its FX played on contact)', at: 'bChest', priority: 90, post: { aberration: 0.8 }, layers: [] });

// ---- arena / destruction
def({
  id: 'explosion.keg',
  desc: 'powder keg explosion',
  at: 'event',
  priority: 90,
  post: { flash: 0.07, aberration: 1.2 },
  layers: [
    { op: { k: 'flash', color: '#ffc070', size: 4, light: 40 }, minY: 0.6 },
    { op: { k: 'shock', color: '#ffb060', size: 7, life: 0.6 }, y: 0.1 },
    { op: { k: 'fireBurst', n: 60, shape: 'sphere', speed: [6, 12], size: 0.7, spread: 0.6 }, minY: 0.6 },
    { op: { k: 'smoke', n: 14, color: '#1a1410', size: 2.0, rise: 1.4 }, minY: 0.6 },
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
def({ id: 'hazard.fire.hit', desc: 'thrown into lava / a fire pit', at: 'bFeet', y: 0.4, priority: 60, layers: [{ op: { k: 'fireBurst', n: 24, shape: 'box', box: [3, 3, 3], size: 0.6, spread: 0.6 } }] });
def({ id: 'hazard.spikes.hit', desc: 'thrown onto spikes', at: 'bFeet', y: 0.4, priority: 55, layers: [{ op: { k: 'sparks', n: 30, color: '#ffd0a0', speed: 8 } }] });
def({ id: 'hazard.geyser.hit', desc: 'launched by a geyser', at: 'bFeet', y: 0.4, priority: 55, layers: [{ op: { k: 'smoke', n: 30, color: '#eef6ff', size: 2.2, rise: 2.5 } }] });

// ---- attack phase observations (render-side, keyed by fighter + attack id)
def({ id: 'active.nova', desc: 'nova burst at active start', at: 'aFeet', priority: 70, layers: [{ op: { k: 'shock', color: '#ff7a20', size: 7, life: 0.5 } }, { op: { k: 'fireBurst', n: 40, shape: 'ring', speed: [8, 1], size: 0.5, spread: 0.3 }, y: 0.6 }] });
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
}

type Ids = (string | false | null | undefined)[];
/**
 * Sim event -> effect ids, one line per EventType that has visuals. Lookup order
 * for later milestones: (fighter, move) -> move -> fx tag -> kind + weapon class.
 */
export const RESOLVE: Partial<Record<SimEvent['type'], (e: SimEvent, c: ResolveCtx) => Ids>> = {
  hit: (e) => {
    const fx = String(e.data?.fx ?? '');
    const heavy = !!e.data?.heavy;
    const kind = HIT_KIND(fx);
    return [heavy ? `impact.${kind}.heavy` : `impact.${kind}`, fx === 'quake' && 'impact.quake', (fx === 'fire' || fx === 'pyre') && 'impact.fireBurst'];
  },
  block: () => ['block.sparks'],
  parry: () => ['parry.flash'],
  guard_break: () => ['guard.break'],
  dodge: () => ['dodge.dust'],
  knockdown: () => ['knockdown.dust'],
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
  kill: (e, c) => [c.isFinisher?.(String(e.data?.move ?? '')) ? 'kill.finisher' : 'kill.plain'],
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
  { key: 'shadow', rate: 30, when: (f, mv) => (f.state === 'attack' && mv && mv.fx === 'shadow' && f.phase <= 1 ? 'aura.shadow' : null) },
  { key: 'ultWindup', rate: 36, when: (f, mv) => (f.state === 'attack' && mv?.kind === 'ultimate' && f.phase === 0 ? 'aura.ultWindup' : null) },
  { key: 'buff', rate: 21, when: (f) => (f.lastStand ? 'aura.lastStand' : f.buff > 0 ? 'aura.buff' : null) },
  { key: 'dodge', rate: 30, when: (f) => (f.state === 'dodge' ? 'dodge.trail' : null) },
];
/** ring of fire: flames per second of sim time while the ring is closing (old: 3 per frame) */
export const RING_FIRE_RATE = 180;
/** projectile trails per second of sim time (old: per frame) */
export const PROJ_TRAIL_RATE = 60;
export const projTrail = (fx: string) => (fx === 'arrow' ? 'proj.arrow.trail' : fx === 'shadow' ? 'proj.shadow.trail' : fx === 'seed' ? null : fx === 'pyre' ? 'proj.pyre.trail' : 'proj.fire.trail');
export const projEnd = (fx: string) => (fx === 'arrow' ? 'proj.arrow.end' : 'proj.fire.end');

/** Longest visible life of a def (s): spawn delay + the longest primitive life. */
export function defDuration(d: FxDef): number {
  const L: Record<FxOp['k'], number> = { sparks: 0.6, flash: 0.2, dust: 1.3, smoke: 2.5, fire: 0.6, fireBurst: 0.6, embers: 2.5, shock: 0.5, debris: 6 };
  let m = 0;
  for (const l of d.layers) m = Math.max(m, (l.delay ?? 0) + (l.op.k === 'shock' ? (l.op.life ?? 0.5) : L[l.op.k]));
  return m;
}

/** frame type re-export for the director */
export type { Frame };
