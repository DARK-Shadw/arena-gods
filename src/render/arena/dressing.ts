/**
 * Theme dressing dispatcher: each theme builds its floor, boundary, gates and
 * backdrop into the arena group and returns the materials / builders the
 * common arena systems need (obstacles, props, hazards, debris types).
 * A1: with a loaded kit pack (assets.ts) the data-driven dressKit.ts wraps the legacy builder and replaces
 * the slots its ThemeArt maps to baked assets; `?arena=legacy` (or a failed load) keeps the legacy builders only.
 */
import * as THREE from 'three';
import type { HazardDef, Obstacle, ObstacleKind } from '../../sim/arenaGen';
import type { Arena } from './arenaView';
import type { DebrisMat } from './debris';
import { dressColosseum, dressDesert, dressSkytemple } from './dressClassic';
import { dressGlacier, dressMoonlake, dressSakura } from './dressNature';
import { dressForge } from './dressForge';
import { dressKit } from './dressKit';
import type { KitInstance } from './assets';
import type { ChainKit } from './chains';
import type { WetFloor } from './floor';

export interface Dressing {
  mats: Record<string, THREE.Material>;
  /** build the visual for a layout obstacle (base at origin, y up) */
  obstacle(o: Obstacle, crack: { value: number }): THREE.Object3D;
  propMat(kind: string): THREE.Material;
  debrisOf(kind: ObstacleKind): DebrisMat;
  urnDebris: DebrisMat;
  chandelier(h: HazardDef): THREE.Object3D;
  chandelierDebris: DebrisMat;
  waterColor?: string;
  geyserColor?: string;
  decorateWater?(g: THREE.Group, h: HazardDef): void;
  /** objects included when baking the environment map (e.g. cloud sea) */
  envExtras: THREE.Object3D[];
  /** base intensity of the overhead arena spot */
  spot?: number;
  /** A1: a baked kit asset for a prop kind (dressKit.ts); absent / null = the legacy procedural prop */
  propAsset?(kind: string): KitInstance | null;
  /** A2: the kit wet floor (floor.ts), when the theme's art has a floor set that loaded */
  wetFloor?: WetFloor;
  /** A4: kit visual for an A2b feature obstacle (banner pole, barricade); absent / null = the arena's placeholder */
  feature?(o: Obstacle): THREE.Object3D | null;
  /** A4: kit asset instance for a hazard kind (spike grate, chain weight, vent, crumble), scaled to h.r; null = legacy */
  hazardKit?(h: HazardDef): KitInstance | null;
  /** A4: a chain-link builder (kit/chain_link), null when the theme has none loaded */
  chainKit?(): ChainKit | null;
}

/** kit art when the arena was given a loaded pack, else (and always with ?arena=legacy) the legacy builders */
export function buildDressing(a: Arena): Dressing {
  return a.kit ? dressKit(a, a.kit, legacyDressing) : legacyDressing(a);
}

/** the pre-A1 procedural theme builders, unchanged (fallback until A21 removes them) */
export function legacyDressing(a: Arena): Dressing {
  switch (a.layout.theme) {
    case 'colosseum':
      return dressColosseum(a);
    case 'skytemple':
      return dressSkytemple(a);
    case 'desert':
      return dressDesert(a);
    case 'sakura':
      return dressSakura(a);
    case 'moonlake':
      return dressMoonlake(a);
    case 'glacier':
      return dressGlacier(a);
    case 'forge':
      return dressForge(a);
  }
}
