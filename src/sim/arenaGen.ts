/**
 * PROCEDURAL ARENA GENERATOR (pure data, deterministic, headless-safe).
 *
 * (theme, layout, seed) -> ArenaLayout: boundary shape, obstacles (cover /
 * toppleable pillars & statues, rocks, crystals), props (breakables,
 * throwables, explosives), hazards (lava, fire pits, spike traps, geysers,
 * water, falling chandeliers/stalactites, swinging chains, fire jets,
 * collapsing floor) and navigation waypoints.
 *
 * A2b (sim milestone "bigger arenas + more interactables"): every arena is
 * ARENA_SCALE bigger (playable radius), and each theme adds features
 * (banner poles that topple, breakable barricades / gates), braziers that tip
 * and ignite, and per-theme interactive hazards (THEME_RULES.extras).
 * The sim collides/damages against this data; the renderer dresses it.
 */
import { atan2, cos, hypot, sin } from './dmath';
import { Rng, hashSeed } from './rng';

export type ThemeId = 'colosseum' | 'skytemple' | 'sakura' | 'forge' | 'glacier' | 'moonlake' | 'desert';
export type LayoutId = 'pit' | 'oval' | 'cross' | 'split' | 'gauntlet';

export const THEMES: ThemeId[] = ['colosseum', 'skytemple', 'sakura', 'forge', 'glacier', 'moonlake', 'desert'];
export const LAYOUTS: LayoutId[] = ['pit', 'oval', 'cross', 'split', 'gauntlet'];

export type ObstacleKind = 'column' | 'statue' | 'rock' | 'crystal' | 'obelisk' | 'lantern_post' | 'banner' | 'barricade';
export type PropKind = 'crate' | 'barrel' | 'urn' | 'rock' | 'explosive' | 'brazier' | 'lantern';
export type HazardKind = 'lava' | 'firepit' | 'spikes' | 'geyser' | 'water' | 'chandelier' | 'chains' | 'flamejet' | 'crumble';

/**
 * A2b: playable radius multiplier over the pre-A2b arenas (pit 12.3 m -> 16.6 m, oval 14.5 x 10.5 -> 19.6 x 14.2).
 * Owner: "bigger arenas, start about +30-40 %": +35 %, measured with sim:test (mean fight +0.8 s) and kept.
 */
export const ARENA_SCALE = 1.35;
/** chains: pivot height and chain length (m); the weight swings at 4.3 - 3.2 cos(theta) */
export const CHAIN_PIVOT_H = 4.3;
export const CHAIN_LEN = 3.2;
/** chains: swing duration (s) and period (s); amplitude 1.05 rad decaying linearly to 0 */
export const CHAIN_SWING = { dur: 3.0, period: 1.7, amp: 1.05 };
/** Chain weight offset (along the swing axis, height) tau seconds into a swing. */
export function chainSwing(tau: number): { off: number; y: number; theta: number } {
  if (tau < 0 || tau >= CHAIN_SWING.dur) return { off: 0, y: CHAIN_PIVOT_H - CHAIN_LEN, theta: 0 };
  const theta = CHAIN_SWING.amp * sin((tau / CHAIN_SWING.period) * Math.PI * 2) * (1 - tau / CHAIN_SWING.dur);
  return { off: CHAIN_LEN * sin(theta), y: CHAIN_PIVOT_H - CHAIN_LEN * cos(theta), theta };
}

export interface Obstacle {
  id: number;
  kind: ObstacleKind;
  x: number;
  z: number;
  r: number;
  h: number;
  hp: number;
  /** blocks projectiles + line of sight */
  cover: boolean;
  /** topples (crushing what's in its path) when destroyed */
  toppleable: boolean;
}

export interface PropDef {
  id: number;
  kind: PropKind;
  x: number;
  z: number;
  r: number;
  hp: number;
  /** kg-ish scale 0.5..2: damage/stagger of a throw, carry slowdown */
  mass: number;
  throwable: boolean;
  explosive: boolean;
}

export interface HazardDef {
  id: number;
  kind: HazardKind;
  x: number;
  z: number;
  r: number;
  /** cycle (s) for spikes / geysers / fire jets */
  period: number;
  /** cycle phase (s); for 'chains' the swing axis angle (rad, atan2(x, z) convention) */
  phase: number;
}

export interface ArenaSpec {
  theme: ThemeId;
  layout: LayoutId;
  seed: number;
}

export interface ArenaLayout extends ArenaSpec {
  /** fight-area semi-axes (fighter centres stay inside) */
  rx: number;
  rz: number;
  /** wall/balustrade height (visual + camera) */
  wallH: number;
  obstacles: Obstacle[];
  props: PropDef[];
  hazards: HazardDef[];
  /** navigation waypoints (e.g. bridges over a split arena) */
  waypoints: { x: number; z: number }[];
}

interface ThemeRules {
  wallH: number;
  obstacle: ObstacleKind;
  obstacleR: number;
  obstacleH: number;
  props: PropKind[];
  hazard: HazardKind;
  /** river type for 'split' layouts */
  river: HazardKind;
  extraHazard?: HazardKind;
  /** A2b: extra interactive hazards (placed after hazard / extraHazard) */
  extras: HazardKind[];
  /** A2b: interactive features: toppling banner poles, breakable barricades */
  features: ObstacleKind[];
}

export const THEME_RULES: Record<ThemeId, ThemeRules> = {
  colosseum: { wallH: 3.4, obstacle: 'column', obstacleR: 0.7, obstacleH: 5.2, props: ['crate', 'barrel', 'urn', 'explosive', 'brazier'], hazard: 'spikes', river: 'spikes', extraHazard: 'chandelier', extras: ['chains', 'crumble'], features: ['banner', 'banner', 'barricade'] },
  skytemple: { wallH: 1.1, obstacle: 'column', obstacleR: 0.65, obstacleH: 4.6, props: ['urn', 'urn', 'crate', 'rock', 'brazier'], hazard: 'geyser', river: 'water', extras: ['crumble', 'crumble'], features: ['banner', 'banner'] },
  sakura: { wallH: 1.0, obstacle: 'lantern_post', obstacleR: 0.55, obstacleH: 3.2, props: ['lantern', 'urn', 'barrel', 'crate'], hazard: 'water', river: 'water', extraHazard: 'firepit', extras: ['chains'], features: ['banner', 'banner', 'barricade'] },
  forge: { wallH: 3.0, obstacle: 'obelisk', obstacleR: 0.75, obstacleH: 5.5, props: ['barrel', 'explosive', 'crate', 'brazier'], hazard: 'lava', river: 'lava', extraHazard: 'chandelier', extras: ['flamejet', 'flamejet'], features: ['barricade', 'banner'] },
  glacier: { wallH: 1.6, obstacle: 'crystal', obstacleR: 0.7, obstacleH: 4.2, props: ['rock', 'rock', 'crate', 'barrel', 'explosive'], hazard: 'spikes', river: 'water', extraHazard: 'geyser', extras: ['crumble', 'chains'], features: ['banner'] },
  moonlake: { wallH: 0.8, obstacle: 'column', obstacleR: 0.6, obstacleH: 4.4, props: ['lantern', 'urn', 'crate', 'barrel', 'brazier'], hazard: 'water', river: 'water', extraHazard: 'firepit', extras: ['crumble', 'chains'], features: ['banner', 'banner'] },
  desert: { wallH: 2.2, obstacle: 'statue', obstacleR: 0.85, obstacleH: 5.0, props: ['urn', 'rock', 'crate', 'explosive', 'brazier'], hazard: 'firepit', river: 'spikes', extraHazard: 'geyser', extras: ['flamejet', 'crumble'], features: ['banner', 'barricade'] },
};

const PROP_BASE: Record<PropKind, { r: number; hp: number; mass: number; throwable: boolean; explosive: boolean }> = {
  crate: { r: 0.45, hp: 30, mass: 1.0, throwable: true, explosive: false },
  barrel: { r: 0.4, hp: 30, mass: 1.2, throwable: true, explosive: false },
  urn: { r: 0.32, hp: 12, mass: 0.6, throwable: true, explosive: false },
  rock: { r: 0.4, hp: 999, mass: 1.6, throwable: true, explosive: false },
  explosive: { r: 0.4, hp: 18, mass: 1.1, throwable: true, explosive: true },
  brazier: { r: 0.45, hp: 40, mass: 2, throwable: false, explosive: false },
  lantern: { r: 0.35, hp: 25, mass: 2, throwable: false, explosive: false },
};

/** Fighter start marks (must stay clear). */
const START = [
  { x: -5, z: 0 },
  { x: 5, z: 0 },
];

export function generateArena(spec: ArenaSpec): ArenaLayout {
  const rng = new Rng(hashSeed(`${spec.theme}|${spec.layout}|${spec.seed}`));
  const rules = THEME_RULES[spec.theme];
  const S = ARENA_SCALE;
  let rx = 12.3 * S,
    rz = 12.3 * S;
  if (spec.layout === 'oval') {
    rx = 14.5 * S;
    rz = 10.5 * S;
  } else if (spec.layout === 'gauntlet') {
    rx = 15.5 * S;
    rz = 7.8 * S;
  } else if (spec.layout === 'split') {
    rx = rz = 12.6 * S;
  }
  const L: ArenaLayout = { ...spec, rx, rz, wallH: rules.wallH, obstacles: [], props: [], hazards: [], waypoints: [] };
  const inside = (x: number, z: number, m: number) => (x / (rx - m)) ** 2 + (z / (rz - m)) ** 2 <= 1;
  const clearOf = (x: number, z: number, r: number, obsGap = 1.4) => {
    for (const s of START) if (hypot(x - s.x, z - s.z) < r + 1.6) return false;
    if (hypot(x, z) < r + 1.2 && spec.layout !== 'cross') return false;
    // keep the gate lanes open
    if (Math.abs(z) < r + 1.2 && Math.abs(x) > rx - 3.2) return false;
    for (const o of L.obstacles) if (hypot(x - o.x, z - o.z) < r + o.r + obsGap) return false;
    for (const p of L.props) if (hypot(x - p.x, z - p.z) < r + p.r + 0.6) return false;
    for (const h of L.hazards) if (hypot(x - h.x, z - h.z) < r + h.r + 0.6) return false;
    return true;
  };
  const addObstacle = (x: number, z: number, scale = 1, kind = rules.obstacle) => {
    const feature = kind === 'banner' || kind === 'barricade';
    const r = kind === 'banner' ? 0.28 : kind === 'barricade' ? 0.7 : rules.obstacleR * scale;
    if (!inside(x, z, r + 0.8) || !clearOf(x, z, r, feature ? 1.1 : 1.4)) return false;
    // features stay off the entrance walk (gate -> start mark along the x axis): the entrance validator caught a barricade there
    if (feature && Math.abs(z) < r + 1.5 && Math.abs(x) > 3.5) return false;
    const toppleable = kind === 'column' || kind === 'statue' || kind === 'obelisk' || kind === 'crystal' || kind === 'lantern_post' || kind === 'banner';
    const h = kind === 'banner' ? 4.6 : kind === 'barricade' ? 1.5 : rules.obstacleH * (0.85 + 0.3 * scale * 0.5);
    const hp = kind === 'rock' ? 9999 : kind === 'banner' ? Math.round(50 + rng.range(0, 20)) : kind === 'barricade' ? Math.round(42 + rng.range(0, 16)) : Math.round(170 * scale + rng.range(0, 60));
    L.obstacles.push({ id: L.obstacles.length, kind, x, z, r, h, hp, cover: true, toppleable });
    return true;
  };
  const addHazard = (kind: HazardKind, x: number, z: number, r: number) => {
    if (!inside(x, z, kind === 'crumble' ? r + 0.3 : r * 0.5) || !clearOf(x, z, r)) return false;
    const period = kind === 'spikes' ? 3.2 : kind === 'geyser' ? 5.5 : kind === 'flamejet' ? 6.5 : 0;
    // chains: the swing axis (tangential to the arena, so the weight sweeps across the fighting lanes)
    const phase = kind === 'chains' ? atan2(-z, x) + rng.range(-0.4, 0.4) : rng.range(0, 3);
    L.hazards.push({ id: L.hazards.length, kind, x, z, r, period, phase });
    return true;
  };

  // ---------------- layout skeleton
  switch (spec.layout) {
    case 'pit':
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + (i * Math.PI) / 2 + rng.range(-0.12, 0.12);
        addObstacle(cos(a) * 7.4 * S, sin(a) * 7.4 * S, rng.range(0.9, 1.15));
      }
      break;
    case 'oval':
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        addObstacle(cos(a) * rx * 0.58, sin(a) * rz * 0.6, rng.range(0.85, 1.1));
      }
      break;
    case 'cross':
      // a central cluster splits the floor into four lanes
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + (i * Math.PI) / 2;
        addObstacle(cos(a) * 2.6, sin(a) * 2.6, 0.75);
        addObstacle(cos(a) * 8.6 * S, sin(a) * 8.6 * S, 1);
      }
      break;
    case 'split': {
      // a river of hazard down the middle, crossed by two bridges
      const kind = rules.river;
      const bz = 5 * S;
      for (let z = -rz + 0.6; z <= rz - 0.6; z += 1.1) {
        if (Math.abs(Math.abs(z) - bz) < 1.7) continue; // bridges at z = +-bz
        L.hazards.push({ id: L.hazards.length, kind, x: 0, z, r: 0.75, period: kind === 'spikes' ? 3.2 : 0, phase: rng.range(0, 3) });
      }
      L.waypoints.push({ x: 0, z: bz }, { x: 0, z: -bz });
      for (const s of [-1, 1]) {
        addObstacle(s * 6.5 * S, 7.5 * S, 0.95);
        addObstacle(s * 6.5 * S, -7.5 * S, 0.95);
      }
      break;
    }
    case 'gauntlet':
      for (let i = -2; i <= 2; i++) {
        if (i === 0) continue;
        addObstacle(i * 4.6 * S, rz * 0.62 * (i % 2 === 0 ? 1 : -1), 0.95);
        addObstacle(i * 4.6 * S + 1.5, -rz * 0.62 * (i % 2 === 0 ? 1 : -1), 0.8);
      }
      break;
  }
  // boulders / broken pieces as low extra cover
  for (let k = 0, tries = 0; k < 3 && tries < 50; tries++) {
    const a = rng.next() * Math.PI * 2,
      rr = rng.range(0.45, 0.8);
    if (addObstacle(cos(a) * rx * rr, sin(a) * rz * rr, 0.75, 'rock')) k++;
  }
  // A2b features: toppling banner poles, breakable barricades (near where fights happen)
  for (const kind of rules.features) {
    for (let tries = 0; tries < 40; tries++) {
      const a = rng.next() * Math.PI * 2,
        rr = rng.range(0.3, 0.75);
      if (addObstacle(cos(a) * rx * rr, sin(a) * rz * rr, 1, kind)) break;
    }
  }

  // ---------------- hazards
  const nHaz = spec.layout === 'split' ? 1 : 2;
  for (let k = 0, tries = 0; k < nHaz && tries < 60; tries++) {
    const a = rng.next() * Math.PI * 2,
      rr = rng.range(0.4, 0.75);
    const kind = k === 0 ? rules.hazard : rules.extraHazard ?? rules.hazard;
    const r = kind === 'chandelier' ? 1.7 : kind === 'water' ? rng.range(1.6, 2.4) : kind === 'lava' ? rng.range(1.2, 1.8) : rng.range(0.9, 1.3);
    if (addHazard(kind, cos(a) * rx * rr, sin(a) * rz * rr, r)) k++;
  }
  // A2b: per-theme interactive hazards
  for (const kind of rules.extras) {
    for (let tries = 0; tries < 60; tries++) {
      const a = rng.next() * Math.PI * 2;
      // collapsing floor favours the edges (crumbling rim); chains and fire jets sit in the fighting lanes
      const rr = kind === 'crumble' ? rng.range(0.55, 0.85) : rng.range(0.3, 0.7);
      const r = kind === 'chains' ? 0.6 : kind === 'flamejet' ? rng.range(0.85, 1.1) : kind === 'crumble' ? rng.range(1.4, 1.9) : 1;
      if (addHazard(kind, cos(a) * rx * rr, sin(a) * rz * rr, r)) break;
    }
  }

  // ---------------- props (more of them, biased toward the middle band where the fight happens)
  const nProps = 12 + Math.floor(rng.range(0, 5));
  for (let k = 0, tries = 0; k < nProps && tries < 300; tries++) {
    const a = rng.next() * Math.PI * 2;
    const rr = rng.range(0.22, 0.85);
    const x = cos(a) * rx * rr,
      z = sin(a) * rz * rr;
    const kind = rules.props[Math.floor(rng.next() * rules.props.length)];
    const b = PROP_BASE[kind];
    if (!inside(x, z, b.r + 0.5) || !clearOf(x, z, b.r)) continue;
    L.props.push({ id: L.props.length, kind, x, z, r: b.r, hp: b.hp, mass: b.mass, throwable: b.throwable, explosive: b.explosive });
    k++;
  }
  return L;
}

/** Boundary radius (scale 1) of the elliptical fight area in the direction of (x,z). */
export function boundR(L: { rx: number; rz: number }, x: number, z: number): number {
  const l = hypot(x, z);
  if (l < 1e-6) return Math.min(L.rx, L.rz);
  const ux = x / l,
    uz = z / l;
  return 1 / Math.sqrt((ux / L.rx) ** 2 + (uz / L.rz) ** 2);
}

/** Deterministic default arena for a match seed (used when none is chosen). */
export function arenaForSeed(seed: number): ArenaSpec {
  const r = new Rng(hashSeed(`arena:${seed}`));
  return { theme: THEMES[Math.floor(r.next() * THEMES.length)], layout: LAYOUTS[Math.floor(r.next() * LAYOUTS.length)], seed: Math.floor(r.next() * 1e6) };
}
