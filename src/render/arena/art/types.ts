/**
 * ThemeArt: the data that says how a theme is dressed from baked kit assets (arena art plan 4.1 / 4.2).
 * A theme becomes a ~150-line data file (art/<theme>.ts) read by the generic builder dressKit.ts, instead of
 * 300-800 lines of procedural code (dressClassic / dressNature / dressForge, which stay as the `?arena=legacy`
 * fallback until A21).
 *
 * A1 (this milestone) wires only `props` end to end (the tripod brazier). The other sections are typed now so
 * later milestones fill them without changing the contract: floor (A2), ring / gates / obstacles / hazards
 * (A3-A7), backdrop (A6), lights and sockets (A19). A section left undefined keeps the legacy builder's output
 * for that part of the arena.
 */
import type { HazardKind, ObstacleKind, ThemeId } from '../../../sim/arenaGen';
import type { RtPropKind } from '../../../sim/world';

/** id of a kit or theme asset in public/arena/manifest.json, e.g. 'kit/brazier_tripod' */
export type AssetId = string;

/** asset tier: 'full' = LOD0 + full texture set (quality medium / high), 'low' = LOD1 + half set (low) */
export type AssetTier = 'full' | 'low';
export const tierOf = (quality: number): AssetTier => (quality <= 0 ? 'low' : 'full');

export interface FloorArt {
  /** floor material set (A2: scan flagstone + wetness / puddle masks) */
  set: AssetId;
  /** inlaid ritual circle (A2 / per theme) */
  inlay?: AssetId;
  /** wetness 0..1 scale applied to the baked masks */
  wetness?: number;
}

export interface RingArt {
  /** boundary modules placed along the ellipse (alongEllipse with arc spacing) */
  modules: { asset: AssetId; spacing: number; offset?: number }[];
  /** visual wall height the camera clamps to (else the sim's wallH) */
  wallH?: number;
}

export interface GateArt {
  /** gate asset with BARRIER, ANCHOR_*, TUNNEL nodes (plan 4.2) */
  asset: AssetId;
}

export interface BackdropArt {
  /** panorama layers far -> near (A6), hero inset */
  layers: AssetId[];
  inset?: AssetId;
}

export interface ThemeArt {
  id: ThemeId | 'default';
  /** sim props -> kit asset (authored to PROP_BASE radius / TOP height, origin at the base centre) */
  props?: Partial<Record<RtPropKind, AssetId>>;
  /** sim obstacles -> kit asset (footprint <= 1.55 r; SHAFT stretched to o.h) */
  obstacles?: Partial<Record<ObstacleKind, AssetId>>;
  /** hazard visual builders (A7+) */
  hazards?: Partial<Record<HazardKind, AssetId>>;
  floor?: FloorArt;
  ring?: RingArt;
  gates?: GateArt;
  backdrop?: BackdropArt;
  /** extra assets to load with the theme (ambient dressing placed by sockets, A4+) */
  extra?: AssetId[];
}

/** a socket node (SOCK_*) of a kit asset: position in the asset's frame (origin at the base centre) + its extras */
export interface KitSocket {
  name: string;
  pos: [number, number, number];
  extras: Record<string, unknown>;
}
