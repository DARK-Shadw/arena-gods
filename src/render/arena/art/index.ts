/**
 * Theme art registry (arena art plan 4.1). `artFor(theme)` merges the shared kit defaults with the theme's own
 * ThemeArt file (art/<theme>.ts, added from A7 on). A1 ships only the shared default: the tripod brazier for the
 * sim's `brazier` prop, used by every theme that spawns braziers (today: forge).
 */
import type { ArenaLayout, ThemeId } from '../../../sim/arenaGen';
import type { AssetId, LookArt, ThemeArt } from './types';
import type { ThemeDef } from '../themes';
import { COLOSSEUM_ART } from './colosseum';

export * from './types';

/** shared kit used by every theme unless the theme overrides a slot */
export const KIT_DEFAULT: ThemeArt = {
  id: 'default',
  // A4: the shared dressing kit: every prop kind, the A2b features and hazards; theme files may override any slot
  props: {
    brazier: 'kit/brazier_tripod',
    rock: 'kit/rock_prop',
    crate: 'kit/crate',
    barrel: 'kit/barrel',
    urn: 'kit/urn',
    explosive: 'kit/keg',
    chunk: 'kit/chunk',
    lantern: 'kit/lantern_toro',
  },
  features: { banner: 'kit/banner_pole', barricade: 'kit/barricade' },
  hazards: { spikes: 'kit/spike_grate', chains: 'kit/chain_weight', flamejet: 'kit/vent_grate', crumble: 'kit/crumble' },
  banners: 'kit/banners',
  chains: 'kit/chain_link',
  // A5: posed-fighter statues for the sim's toppling `statue` obstacles (variants by obstacle id); kit chunk / plank / shard
  // meshes for the debris pools
  obstacles: { statue: ['kit/statue_hooded', 'kit/statue_knight', 'kit/statue_mage'] },
  debris: { stone: 'kit/chunk', marble: 'kit/chunk', sandstone: 'kit/chunk', wood: 'kit/crate', ceramic: 'kit/urn' },
};

/** per-theme ThemeArt files (A2: colosseum floor + Moon Gate preview; A7: colosseum for real, A11+: the others) */
const THEME_ART: Partial<Record<ThemeId, ThemeArt>> = { colosseum: COLOSSEUM_ART };

export function artFor(theme: ThemeId): ThemeArt {
  const t = THEME_ART[theme];
  if (!t) return { ...KIT_DEFAULT, id: theme };
  const art: ThemeArt = {
    ...KIT_DEFAULT,
    ...t,
    props: { ...KIT_DEFAULT.props, ...t.props },
    features: { ...KIT_DEFAULT.features, ...t.features },
    hazards: { ...KIT_DEFAULT.hazards, ...t.hazards },
    obstacles: { ...KIT_DEFAULT.obstacles, ...t.obstacles },
    debris: { ...KIT_DEFAULT.debris, ...t.debris },
  };
  // A3: `?kitstone=0` keeps the A2 colosseum (legacy pillars and walls) on the kit floor, for before / after shots
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('kitstone') === '0') {
    delete art.obstacles;
    delete art.ring;
  }
  // A2: `?moongate=0` keeps the kit floor but drops the preview look and the decorative braziers
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('moongate') === '0') {
    delete art.look;
    delete art.ringFlames;
  }
  // A7b: `?stage=0` keeps the night look but drops the stage light (moon rim, fire pools, sky fog, mist, backdrop probe)
  if (art.look?.stage && typeof location !== 'undefined' && new URLSearchParams(location.search).get('stage') === '0') art.look = { ...art.look, stage: undefined };
  // A6: `?backdrop=0` drops the baked panorama (before / after shots, perf A/B)
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('backdrop') === '0') delete art.backdrop;
  // A2: `?floorset=slate_slabs` previews another floor set on a theme that has a kit floor
  const fs = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('floorset') : null;
  if (fs && art.floor && /^[a-z0-9_]+$/.test(fs)) art.floor = { ...art.floor, set: `floor/${fs}` };
  return art;
}

/** A2: the theme's display data with the kit art's look overrides (a new object; THEME_DEFS stays untouched) */
export function withLook(T: ThemeDef, look?: LookArt): ThemeDef {
  if (!look) return T;
  const { sky, lookId, stage: _stage, ...rest } = look;
  return { ...T, ...rest, sky: { ...T.sky, ...(sky ?? {}) }, lookId: lookId ?? T.lookId };
}

/**
 * the assets a ThemeArt needs for one generated layout (what ArenaAssets.load fetches): props / obstacles /
 * hazards only for kinds the layout contains (rubble `chunk` props spawn at runtime from topples, so always),
 * everything else (floor, ring, gates, extra) always (the A6 backdrop is not a manifest asset: ArenaAssets.loadBackdrop). Without a layout: every referenced asset.
 */
export function assetsOf(art: ThemeArt, layout?: ArenaLayout): AssetId[] {
  const ids = new Set<AssetId>();
  const add = (x?: AssetId) => x && ids.add(x);
  const has = (list: { kind: string }[] | undefined, k: string) => !layout || k === 'chunk' || !!list?.some((x) => x.kind === k);
  const hasKind = (list: { kind: string }[] | undefined, k: string) => !layout || !!list?.some((x) => x.kind === k);
  for (const [k, v] of Object.entries(art.props ?? {})) if (has(layout?.props, k)) add(v);
  for (const [k, v] of Object.entries(art.obstacles ?? {})) if (has(layout?.obstacles, k)) for (const x of Array.isArray(v) ? v : [v]) add(x);
  for (const [k, v] of Object.entries(art.hazards ?? {})) if (has(layout?.hazards, k)) add(v);
  // A4: feature obstacles; the banner cloth / chain links only when something uses them (the atlas is the biggest A4 file)
  for (const [k, v] of Object.entries(art.features ?? {})) if (has(layout?.obstacles, k) && k !== 'chunk') add(v);
  const ringBanners = !!art.ring?.wallBanners;
  if (ringBanners || (art.features?.banner && hasKind(layout?.obstacles, 'banner'))) add(art.banners);
  if ((ringBanners && art.ring?.wallBanners?.chains) || (art.hazards?.chains && hasKind(layout?.hazards, 'chains'))) add(art.chains);
  add(art.ringFlames?.asset);
  for (const x of art.ringFlames?.assets ?? []) add(x);
  add(art.ring?.wallBraziers?.asset);
  for (const x of art.ring?.decor?.assets ?? []) add(x);
  add(art.ring?.guardians?.asset);
  add(art.floor?.set);
  add(art.floor?.inlay);
  for (const m of art.ring?.modules ?? []) add(m.asset);
  const R = art.ring;
  if (R) {
    add(R.trim);
    for (const x of [...(R.podium?.intact ?? []), ...(R.podium?.broken ?? []), ...(R.gallery?.assets ?? [])]) add(x);
    add(R.rubble?.asset);
    // A7: the Moon Gate near field
    const N = R.ruins;
    if (N) {
      for (const x of N.arcade?.assets ?? []) add(x);
      add(N.pillars?.asset);
      if (N.pillars?.banner) add(art.banners);
      if (N.pillars?.chains) add(art.chains);
      add(N.fires?.asset);
      for (const G of [N.east, N.west]) {
        if (!G) continue;
        add(G.arch);
        add(G.braziers?.asset);
        add(G.stair?.doorway);
        add(G.stair?.guardians?.statue);
        add(G.stair?.guardians?.plinth);
        add(G.stair?.braziers?.asset);
      }
    }
  }
  add(art.gates?.asset);
  for (const e of art.extra ?? []) add(e);
  return [...ids];
}
