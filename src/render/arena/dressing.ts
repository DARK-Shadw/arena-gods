/**
 * Theme dressing dispatcher: each theme builds its floor, boundary, gates and
 * backdrop into the arena group and returns the materials / builders the
 * common arena systems need (obstacles, props, hazards, debris types).
 */
import * as THREE from 'three';
import type { HazardDef, Obstacle, ObstacleKind } from '../../sim/arenaGen';
import type { Arena } from './arenaView';
import type { DebrisMat } from './debris';
import { dressColosseum, dressDesert, dressSkytemple } from './dressClassic';
import { dressGlacier, dressMoonlake, dressSakura } from './dressNature';
import { dressForge } from './dressForge';

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
}

export function buildDressing(a: Arena): Dressing {
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
