/**
 * DRESS KIT: the generic, data-driven theme builder (arena art plan 4.1). It implements the `Dressing`
 * contract from a ThemeArt + the loaded ArenaPack, so arenaView.ts does not care whether a slot comes from
 * baked kit assets or from the legacy procedural builders.
 *
 * A1 skeleton: the legacy builder still makes the boundary, gates, backdrop, obstacles and hazards;
 * dressKit replaces the props that the ThemeArt maps to a loaded kit asset (the tripod brazier).
 * A2: the FLOOR. When the art names a floor set that loaded, the legacy floor meshes (floorDisc and the meshes a
 * theme flagged `floorDeco`, e.g. the colosseum medallion) are removed and the wet floor (floor.ts) takes their
 * place with the same pad; the arena wires its reflection / light map (arenaView.ts).
 * Each later milestone moves one slot here (A3-A7 ring / gates / obstacles / hazards, A6 backdrop,
 * A19 lights / sockets), keeping the legacy builder as the fallback for slots the art leaves undefined or whose
 * asset failed to load.
 */
import * as THREE from 'three';
import type { Arena } from './arenaView';
import type { ArenaPack, KitInstance } from './assets';
import type { Dressing } from './dressing';
import { WetFloor } from './floor';

export function dressKit(a: Arena, pack: ArenaPack, legacy: (a: Arena) => Dressing): Dressing {
  // TODO(A3-A7): ring modules, gates, obstacles, hazards; TODO(A6): backdrop
  const D = legacy(a);
  const art = pack.art;
  const wetFloor = art.floor ? buildFloor(a, pack, D) : undefined;
  return {
    ...D,
    wetFloor,
    propAsset(kind: string): KitInstance | null {
      const id = art.props?.[kind as keyof NonNullable<typeof art.props>];
      const asset = id ? pack.assets.get(id) : undefined;
      return asset ? asset.instantiate() : null;
    },
  };
}

/** A2: swap the legacy floor for the kit wet floor (legacy floor kept when the set did not load or fails) */
function buildFloor(a: Arena, pack: ArenaPack, D: Dressing): WetFloor | undefined {
  const F = pack.art.floor!;
  const set = pack.assets.get(F.set);
  if (!set) return undefined;
  const old = a.group.children.filter((o) => o.userData.floor || o.userData.floorDeco);
  const pad = Number(old.find((o) => o.userData.floor)?.userData.floorPad ?? 1.5);
  let wf: WetFloor;
  try {
    wf = new WetFloor({ layout: a.layout, pad, set, inlay: F.inlay ? (pack.assets.get(F.inlay) ?? null) : null, art: F, seed: a.layout.seed, quality: a.quality });
  } catch (e) {
    console.warn('[arena] kit floor failed, legacy floor kept', e);
    return undefined;
  }
  // remove the legacy floor; dispose its geometry and the materials nothing else in the arena uses
  const mats = new Set<THREE.Material>();
  for (const o of old) {
    a.group.remove(o);
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    for (const x of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) mats.add(x);
  }
  for (const m of Object.values(D.mats)) mats.delete(m); // still handed out to obstacles / props / hazards
  const keepTex = new Set<THREE.Texture>();
  for (const m of Object.values(D.mats)) for (const v of Object.values(m)) if (v instanceof THREE.Texture) keepTex.add(v);
  a.group.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    for (const x of Array.isArray(m) ? m : m ? [m] : []) {
      mats.delete(x);
      for (const v of Object.values(x)) if (v instanceof THREE.Texture) keepTex.add(v);
    }
  });
  for (const m of mats) {
    for (const v of Object.values(m)) if (v instanceof THREE.Texture && !keepTex.has(v)) v.dispose();
    m.dispose();
  }
  a.group.add(wf.mesh);
  return wf;
}
