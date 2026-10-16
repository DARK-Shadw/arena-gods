/**
 * Pure data types for the deterministic simulation. No three.js imports here:
 * the sim must run headless in Node.
 */

export type MoveKind = 'light' | 'heavy' | 'combo' | 'gap' | 'ultimate';

export interface MoveDef {
  id: string;
  name: string;
  kind: MoveKind;
  /** Projectile attack: each hit spawns a projectile that must physically reach the target. */
  ranged?: boolean;
  /** projectile speed m/s (ranged moves) */
  speed?: number;
  /** Feint: the windup is cancelled before the active frames (bait). */
  feint?: boolean;
  /** Counter / riposte: only chosen into an opening, bonus damage. */
  counter?: boolean;
  /** AI tags: poke, opener, string, launcher, guardbreak, punish, sweep, antirush, escape, zone, control, gapclose, heavy */
  tags?: string[];
  /** Phase durations in seconds. */
  windup: number;
  active: number;
  recovery: number;
  /** Reach from attacker center to target edge (m). */
  range: number;
  /** Half-angle of the hit cone in degrees (ignored if aoe). */
  arc: number;
  damage: number;
  stamina: number;
  knockback: number;
  /** Stagger seconds applied on a clean hit (a short flinch is always applied). */
  stagger: number;
  knockdown?: boolean;
  /** For multi-hit moves: only the last hit knocks down. */
  knockdownLast?: boolean;
  unblockable?: boolean;
  /** Multiplier on stamina damage dealt to a blocking defender. */
  guardDamage?: number;
  /** Max forward travel during late windup + active (m). Negative = hop back. */
  lunge?: number;
  /** Number of hits spread over the active window. */
  hits?: number;
  /** Follow-up move id for combos. */
  next?: string;
  furyCost?: number;
  /** AI only uses this move when the gap is at least this. */
  minRange?: number;
  aoe?: boolean;
  /** Hyper armor during windup: light hits don't interrupt. */
  armor?: boolean;
  /** VFX tag for render (fire, slam, shadow...). */
  fx?: string;
  /** Does the attacker leave the ground (render hint + no ground collision). */
  airborne?: boolean;
}

export interface Personality {
  /** 0..1 how eagerly it attacks. */
  aggression: number;
  /** 0..1 preference for defense / spacing. */
  caution: number;
  /** 0..1 showboating: taunts, saves ultimate for a dramatic moment. */
  pride: number;
  /** -1..1 negative = cowardly when hurt, positive = desperate and dangerous when hurt. */
  desperation: number;
  /** 0..1 willingness to circle and wait for openings. */
  patience: number;
  /** 0..1 how fast damage taken turns into a rage buff. */
  rage: number;
  /** 0..1 how quickly it learns the opponent's habits. */
  adaptability: number;
}

export interface FighterStats {
  hp: number;
  speed: number;
  turnRate: number; // rad/s
  stamina: number;
  staminaRegen: number; // per second
  weight: number; // knockback resistance
  reaction: number; // seconds
  skill: number; // 0..1 defense accuracy / read quality
  agility: number; // 0..1 dodge preference/quality
  dodgeDist: number;
  blockStrength: number; // 0..1 reduces chip & guard damage
  radius: number;
  hasShield?: boolean;
  /** Preferred fighting gap (edge to edge). */
  prefGap: number;
}

export interface FighterDef {
  id: string;
  name: string;
  epithet: string;
  bio: string;
  grudge: string;
  color: string; // UI accent
  stats: FighterStats;
  personality: Personality;
  moves: MoveDef[];
}

export type FState =
  | 'idle'
  | 'attack'
  | 'block'
  | 'dodge'
  | 'stagger'
  | 'knockdown'
  | 'getup'
  | 'taunt'
  | 'roar'
  | 'winded'
  | 'lift'
  | 'throw'
  | 'dead'
  | 'victory'
  | 'launched'
  | 'scene';

export type EventType =
  | 'match_start'
  | 'attack_start'
  | 'hit'
  | 'block'
  | 'parry'
  | 'guard_break'
  | 'dodge'
  | 'whiff'
  | 'feint'
  | 'counter'
  | 'projectile'
  | 'stagger'
  | 'knockdown'
  | 'getup'
  | 'launch'
  | 'launch_land'
  | 'finisher_start'
  | 'finisher_contact'
  | 'finisher_end'
  | 'wall_slam'
  | 'pillar_slam'
  | 'prop_break'
  // arena / destruction
  | 'prop_lift'
  | 'prop_pickup'
  | 'throw_start'
  | 'prop_throw'
  | 'prop_hit'
  | 'prop_batted'
  | 'prop_drop'
  | 'prop_land'
  | 'cover_hit'
  | 'topple'
  | 'topple_impact'
  | 'crush'
  | 'fuse'
  | 'explosion'
  | 'hazard_trigger'
  | 'hazard_hit'
  | 'chandelier_fall'
  | 'chandelier_impact'
  | 'ability_used'
  | 'exhausted'
  | 'taunt'
  | 'hazard_burn'
  | 'arena_shrink'
  | 'sudden_death'
  | 'kill'
  | 'timeout'
  | 'match_end'
  // drama
  | 'low_hp_state'
  | 'near_death'
  | 'momentum_swing'
  | 'comeback'
  | 'second_wind'
  | 'last_stand'
  | 'stalemate_break'
  | 'rage';

export const DRAMA_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  'momentum_swing',
  'near_death',
  'comeback',
  'second_wind',
  'last_stand',
  'stalemate_break',
  'low_hp_state',
  'rage',
]);

export interface SimEvent {
  t: number;
  type: EventType;
  /** Actor fighter index (0/1) or -1 for global. */
  a: number;
  /** Target fighter index, if any. */
  b?: number;
  data?: Record<string, number | string | boolean>;
}

/** Per-tick fighter snapshot (what render/camera consume). */
export interface FighterFrame {
  x: number;
  z: number;
  facing: number;
  /** Locomotion velocity (for walk cycles). */
  vx: number;
  vz: number;
  /** Airborne height (leaps). */
  y: number;
  state: FState;
  stateT: number;
  moveId: string;
  /** 0 windup,1 active,2 recovery */
  phase: number;
  /** 0..1 progress within phase */
  phaseT: number;
  hp: number;
  stamina: number;
  fury: number;
  blocking: boolean;
  buff: number; // >0 when rage/second wind active
  lastStand: boolean;
  attackId: number;
  /** Strafe direction for render (-1,0,1) */
  strafe: number;
  /** current AI goal (debug overlay / analytics) */
  goal: string;
  /** carried prop index (-1 none) */
  carry: number;
  /** facing a world target (cover / prop / barrel) rather than the opponent */
  aimOn: boolean;
  /** sim-chosen library clip for the current state ('' = own clip set) and its clip time */
  clip: string;
  clipT: number;
}

export interface Frame {
  t: number;
  f: [FighterFrame, FighterFrame];
  /** ring-of-fire scale of the arena ellipse (1 = full size) */
  ringS: number;
  tension: number;
  momentum: number; // -1..1 (positive = fighter 0 leading)
  /** props: 6 floats each [x, y, z, state(+10 if fuse lit), hp fraction, rotY]; state 0 rest 1 carried 2 flying 3 gone */
  props: Float32Array;
  /** obstacles: hp fraction while standing, or -(1 + topple start time) once toppled */
  obs: Float32Array;
  /** hazard state codes (spikes 0 idle 1 warn 2 up 3 cooldown; geyser 0/1 warn/2 erupt; chandelier 0 hang 1 shake 2 fall 3 down) */
  haz: Uint8Array;
  /** live projectiles */
  proj: { x: number; y: number; z: number; fx: string; o: number; id: number }[];
}

export interface MatchResult {
  winner: number; // -1 draw
  duration: number;
  timeout: boolean;
  /** Momentum swings = HP-lead changes (8% hysteresis). */
  swings: number;
  leadChanges: number;
  comeback: boolean;
  oneSided: boolean;
  maxDeficitWinner: number;
  finalHp: [number, number];
  killMove: string;
}

export interface MatchRecord {
  seed: number;
  /** arena generator input (theme + layout + seed): regenerates the exact same arena */
  arena: { theme: import('./arenaGen').ThemeId; layout: import('./arenaGen').LayoutId; seed: number };
  ids: [string, string];
  dt: number;
  frames: Frame[];
  events: SimEvent[];
  result: MatchResult;
}
