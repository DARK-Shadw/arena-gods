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
  props: { brazier: 'kit/brazier_tripod' },
};

/** per-theme ThemeArt files (A2: colosseum floor + Moon Gate preview; A7: colosseum for real, A11+: the others) */
const THEME_ART: Partial<Record<ThemeId, ThemeArt>> = { colosseum: COLOSSEUM_ART };

export function artFor(theme: ThemeId): ThemeArt {
  const t = THEME_ART[theme];
  if (!t) return { ...KIT_DEFAULT, id: theme };
  const art: ThemeArt = { ...KIT_DEFAULT, ...t, props: { ...KIT_DEFAULT.props, ...t.props } };
  // A2: `?moongate=0` keeps the kit floor but drops the preview look and the decorative braziers
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('moongate') === '0') {
    delete art.look;
    delete art.ringFlames;
  }
  // A2: `?floorset=slate_slabs` previews another floor set on a theme that has a kit floor
  const fs = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('floorset') : null;
  if (fs && art.floor && /^[a-z0-9_]+$/.test(fs)) art.floor = { ...art.floor, set: `floor/${fs}` };
  return art;
}

/** A2: the theme's display data with the kit art's look overrides (a new object; THEME_DEFS stays untouched) */
export function withLook(T: ThemeDef, look?: LookArt): ThemeDef {
  if (!look) return T;
  const { sky, lookId, ...rest } = look;
  return { ...T, ...rest, sky: { ...T.sky, ...(sky ?? {}) }, lookId: lookId ?? T.lookId };
}

/**
 * the assets a ThemeArt needs for one generated layout (what ArenaAssets.load fetches): props / obstacles /
 * hazards only for kinds the layout contains (rubble `chunk` props spawn at runtime from topples, so always),
 * everything else (floor, ring, gates, backdrop, extra) always. Without a layout: every referenced asset.
 */
export function assetsOf(art: ThemeArt, layout?: ArenaLayout): AssetId[] {
  const ids = new Set<AssetId>();
  const add = (x?: AssetId) => x && ids.add(x);
  const has = (list: { kind: string }[] | undefined, k: string) => !layout || k === 'chunk' || !!list?.some((x) => x.kind === k);
  for (const [k, v] of Object.entries(art.props ?? {})) if (has(layout?.props, k)) add(v);
  for (const [k, v] of Object.entries(art.obstacles ?? {})) if (has(layout?.obstacles, k)) add(v);
  for (const [k, v] of Object.entries(art.hazards ?? {})) if (has(layout?.hazards, k)) add(v);
  add(art.ringFlames?.asset);
  add(art.floor?.set);
  add(art.floor?.inlay);
  for (const m of art.ring?.modules ?? []) add(m.asset);
  add(art.gates?.asset);
  for (const l of art.backdrop?.layers ?? []) add(l);
  add(art.backdrop?.inset);
  for (const e of art.extra ?? []) add(e);
  return [...ids];
}
