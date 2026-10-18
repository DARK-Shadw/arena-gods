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
import type { SkyParams } from '../sky';
import type { AmbientKind, Grade } from '../themes';
import type { DebrisMat } from '../debris';
import type { BackdropTuning } from '../backdrop';

/** id of a kit or theme asset in public/arena/manifest.json, e.g. 'kit/brazier_tripod' */
export type AssetId = string;

/** asset tier: 'full' = LOD0 + full texture set (quality medium / high), 'low' = LOD1 + half set (low) */
export type AssetTier = 'full' | 'low';
export const tierOf = (quality: number): AssetTier => (quality <= 0 ? 'low' : 'full');

export interface FloorArt {
  /** floor texture set (A2: role texset, kind floor; e.g. 'floor/flagstone_bluegrey') */
  set: AssetId;
  /** inlaid ritual circle at the arena centre (role texset, kind inlay; e.g. 'floor/inlay_moongate') */
  inlay?: AssetId;
  /** global wetness 0..1 (damp darkening / gloss everywhere; puddles need about 0.4+) */
  wetness?: number;
  /** average puddle coverage 0..1 at full wetness (plan 3.1: Moon Gate 35 %) */
  puddles?: number;
  /** albedo multiplier (linear RGB) on top of the set's grading */
  tint?: [number, number, number];
}

/**
 * A2: decorative braziers placed along the boundary (render only, no sim object): fire for the wet floor to reflect
 * and pools for the floor light map. A4 / A7 replace this with the theme's ring sockets.
 */
export interface RingFlamesArt {
  asset: AssetId;
  /** A4: alternate between these brazier assets along the ring (else `asset` everywhere) */
  assets?: AssetId[];
  count: number;
  /** offset outside the fight ellipse (m, + = outward) */
  offset: number;
  /** flame size (the legacy brazier flame is 0.9) */
  size: number;
}

/**
 * A2: kit-mode overrides of the theme's display data (themes.ts ThemeDef), e.g. the Moon Gate night preview on the
 * colosseum until A7 makes the theme for real. `?moongate=0` (or ?arena=legacy) skips it.
 */
export interface LookArt {
  sky?: Partial<SkyParams>;
  sunIntensity?: number;
  sunColor?: string;
  hemi?: [string, string, number];
  fog?: { color: string; density: number; height: number };
  exposure?: number;
  bloom?: { strength: number; radius: number; threshold: number };
  grade?: Grade;
  godrays?: number;
  ambient?: AmbientKind[];
  fire?: string;
  key?: string;
  rim?: string;
  accent?: string;
  /** fxLook.ts THEME_LOOK row to use instead of the theme's own (bloom knee, split toning) */
  lookId?: string;
}

export interface RingArt {
  /** boundary modules placed along the ellipse (alongEllipse with arc spacing) (generic form, A7+) */
  modules?: { asset: AssetId; spacing: number; offset?: number }[];
  /** visual wall height the camera clamps to (else the sim's wallH) */
  wallH?: number;
  /** A3: the stone trim texture set the modules' 'stone_trim' material binds to (role texset, kind trim) */
  trim?: AssetId;
  /**
   * A3: kit wall modules replacing the legacy podium wall (meshes flagged userData.ring 'podium'): `intact` modules keep the
   * full coping height (wallH, under wall braziers and next to the gates, where entrance perches stand), `broken` ones
   * elsewhere, picked by the render seed. Placed with their front face `offset` m outside the boundary.
   */
  podium?: { intact: AssetId[]; broken?: AssetId[]; brokenShare?: number; offset: number; spacing: number; gateHalf: number };
  /** A3: kit arcade bays replacing the legacy gallery segments in place (userData.ring 'gallery'; caps removed) */
  gallery?: { assets: AssetId[] };
  /** A3: render-only rubble clusters scattered at the wall foot (outside the fight ellipse) */
  rubble?: { asset: AssetId; spacing: number; offset: number };
  /** A3: legacy stone left in place (stands, curb, gate facades: userData.legacyStone) re-tinted toward the kit stone */
  retint?: [number, number, number];
  /** A4: the legacy wall-top brazier stands (userData.wallBrazier / wallBrazierBowl) become this kit brazier (merged statics) */
  wallBraziers?: { asset: AssetId };
  /** A4: the legacy wall banners (userData.ring 'banner', Math.random sway phase) become kit banners hung from a rod on two
   * short chains, all merged into one swaying mesh; w / h in metres, cells picked by the render seed */
  wallBanners?: { w: number; h: number; rod?: boolean; chains?: boolean };
  /** A4: render-only dressing at the wall foot (candles, skulls, bone piles), merged; candle wicks get glow cards */
  decor?: { assets: AssetId[]; spacing: number; offset: number; skip?: number };
  /**
   * A5: a pair of render-only statues (kit statues, merged with the ring) flanking the east gate (azimuth 0, where every
   * concept's hero landmark sits), `offset` m outside the boundary and `side` m either side of the gate axis, scaled
   * uniformly (the kit statue is 5 m on its plinth), facing the arena centre; onWall stands them on the podium coping (wallH)
   */
  guardians?: { asset: AssetId; scale: number; offset: number; side: number; onWall?: boolean };
  /** A7: the Moon Gate near field (ruined tiers, pillars with banners and chains, gates, watchers) */
  ruins?: RuinsArt;
}

/**
 * A7: kit gates. The legacy gate builder still makes the functional parts (portcullis, tunnel, gate light, anchors);
 * kit mode removes its decorative parts (userData.gateDeco / gateFlame) and builds these around the opening. Positions in
 * the GATE FRAME (x lateral, y up, z metres into the arena from the boundary; everything built sits at z < 0, outside the
 * fight ellipse), anchors are re-declared for the new geometry and still pass through snapAnchors.
 */
export interface GateArt {
  /** gate asset with BARRIER, ANCHOR_*, TUNNEL nodes (plan 4.2; not used yet) */
  asset?: AssetId;
  /** plain gates (west): this arch module frames the opening (kit/arch: 3.2 m opening, the legacy tunnel stays) */
  arch?: AssetId;
  /** braziers flanking a plain gate */
  braziers?: { asset: AssetId; lateral: number; z: number; scale: number; flame: number };
  /**
   * the hero gate (east, azimuth 0, ref-3): two stair flights rising away from the arena on either side of a central
   * portal (the gate passage runs under a landing at the dais height), a dais behind them carrying the doorway arch
   * (dark doorway), hooded guardians on plinths beside the flights, big pedestal braziers at the stair foot
   */
  stair?: {
    /** half width of the portal block (passage 3.1 m wide inside) */
    portalHalf: number;
    /** lateral extent of each flight (from portalHalf to flightOuter) */
    flightOuter: number;
    /** steps: rise / run (m), dais height = steps x rise */
    steps: number;
    rise: number;
    run: number;
    /** frame z of the first riser (negative = outside the boundary) */
    z0: number;
    /** dais depth behind the flights and half width */
    daisDepth: number;
    daisHalf: number;
    doorway: AssetId;
    /** uniform scale of the doorway arch */
    doorwayScale?: number;
    guardians?: { statue: AssetId; plinth: AssetId; lateral: number; z: number; plinthScale: number; scale: number };
    braziers?: { asset: AssetId; lateral: number; z: number; scale: number; flame: number };
  };
  /** lateral half width of the zone around this gate where the ring (walls, tiers, pillars, decor, ring braziers) stays out */
  zoneHalf: number;
}

/**
 * A7: the Moon Gate near field (ref-3): ruined tiers replacing the legacy stands (and the crowd, velarium and gallery), tall
 * square pillars with long banners and heavy chains swagging between them, sparse hooded watchers, tier fires, a ruined
 * arcade on the top tier, forecourt ground at the gates, the fire-cage chandelier.
 */
export interface RuinsArt {
  /** ruined tiers behind the podium wall: `rings` steps of `depth` m, each `rise` m higher, from `base` (the podium top) */
  tiers: { rings: number; depth: number; rise: number; base: number; seg: number; broken: number; eastBroken: number };
  /** arcade bays on the top tier (a share of the sectors, never towards the hero gate's vista) */
  arcade?: { assets: AssetId[]; share: number; minAz: number };
  /** tall square pillars: azimuths (deg, 0 = east gate, both sides mirrored), offset of the centre outside the boundary */
  pillars?: {
    asset: AssetId;
    az: number[];
    offset: number;
    scale: number;
    height: number;
    /** long vertical banners on the pillars' arena faces (w x h m), every n-th pillar skipped by `skip` */
    banner?: { w: number; h: number; pin: number };
    /** heavy chains between neighbouring pillar tops (link scale, sag m) with swag cloths under them */
    chains?: { scale: number; sag: number; swags: boolean };
  };
  /** sparse hooded watchers standing on the tiers (count per quality tier low / medium / high) */
  watchers?: { count: [number, number, number]; color: string };
  /** small fires on the tiers (kit wall braziers) */
  fires?: { asset: AssetId; count: number; size: number };
  /** the fire-cage chandelier (procedural iron, hung at CHANDELIER_H) */
  fireCage?: boolean;
  /** east / west gate dressing */
  east?: GateArt;
  west?: GateArt;
}

/**
 * A6: the baked landmark panorama (backdrop.ts): `id` = public/arena/backdrop/<id>/backdrop.json (build_backdrop.mjs), the
 * layers / inset / cards for the quality tier are picked there; `tune` = gain, emission, fog match, shafts, fog banks.
 * `?backdrop=0` skips it (A/B and perf checks).
 */
export interface BackdropArt {
  id: string;
  tune?: BackdropTuning;
}

export interface ThemeArt {
  id: ThemeId | 'default';
  /** sim props -> kit asset (authored to PROP_BASE radius / TOP height, origin at the base centre) */
  props?: Partial<Record<RtPropKind, AssetId>>;
  /** sim obstacles -> kit asset (footprint <= 1.55 r; SHAFT stretched to o.h, or A5 statue fit); a list = variants picked by obstacle id */
  obstacles?: Partial<Record<ObstacleKind, AssetId | AssetId[]>>;
  /** A4: hazard visuals (spike grate, chain weight, fire-jet vent, crumbling floor), scaled to the hazard radius by r0 */
  hazards?: Partial<Record<HazardKind, AssetId>>;
  /** A4: the A2b feature obstacles (banner pole, barricade) */
  features?: Partial<Record<ObstacleKind, AssetId>>;
  /** A4: the banner cloth asset (kit/banners: drapes + sigil atlas) used by banner poles and ring banners */
  banners?: AssetId;
  /** A4: the chain links (kit/chain_link) for hanging chains, rod hangers and the chain-weight hazard */
  chains?: AssetId;
  /** A5: debris kind -> kit asset whose most block-like FRAC piece (and baked material) the debris pool instances; only
   * used when the asset is loaded anyway (no extra download) */
  debris?: Partial<Record<DebrisMat, AssetId>>;
  floor?: FloorArt;
  ring?: RingArt;
  gates?: GateArt;
  backdrop?: BackdropArt;
  /** A2: decorative boundary braziers (render only) */
  ringFlames?: RingFlamesArt;
  /** A2: display-data overrides in kit mode */
  look?: LookArt;
  /** extra assets to load with the theme (ambient dressing placed by sockets, A4+) */
  extra?: AssetId[];
}

/** a socket node (SOCK_*) of a kit asset: position in the asset's frame (origin at the base centre) + its extras */
export interface KitSocket {
  name: string;
  pos: [number, number, number];
  extras: Record<string, unknown>;
}
