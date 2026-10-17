/**
 * DRESS KIT: the generic, data-driven theme builder (arena art plan 4.1). It implements the `Dressing`
 * contract from a ThemeArt + the loaded ArenaPack, so arenaView.ts does not care whether a slot comes from
 * baked kit assets or from the legacy procedural builders.
 *
 * A1 skeleton: the legacy builder still makes the floor, boundary, gates, backdrop, obstacles and hazards;
 * dressKit only replaces the props that the ThemeArt maps to a loaded kit asset (the tripod brazier).
 * Each later milestone moves one slot here (A2 floor, A3-A7 ring / gates / obstacles / hazards, A6 backdrop,
 * A19 lights / sockets), keeping the legacy builder as the fallback for slots the art leaves undefined or whose
 * asset failed to load.
 */
import type { Arena } from './arenaView';
import type { ArenaPack, KitInstance } from './assets';
import type { Dressing } from './dressing';

export function dressKit(a: Arena, pack: ArenaPack, legacy: (a: Arena) => Dressing): Dressing {
  // TODO(A2): floor from pack.art.floor; TODO(A3-A7): ring modules, gates, obstacles, hazards; TODO(A6): backdrop
  const D = legacy(a);
  const art = pack.art;
  return {
    ...D,
    propAsset(kind: string): KitInstance | null {
      const id = art.props?.[kind as keyof NonNullable<typeof art.props>];
      const asset = id ? pack.assets.get(id) : undefined;
      return asset ? asset.instantiate() : null;
    },
  };
}
