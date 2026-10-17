/**
 * FX settings: quality tier and gore level (single source of truth).
 *
 * Gore (plan §3.7, confirmed by the owner 2026-10-17): DEFAULT ON at
 * 'standard' (Elden-Ring-like: severing finishers shown with dark-red caps,
 * combat blood from F3). 'off' = clean (dissolve versions), 'full' = more blood.
 * The default is the single constant GORE_DEFAULT below. The storage key is new
 * ('arena.gore.v2') so an 'off' that the old menu saved on every submit cannot
 * mask the default; the old key 'arena.gore' is ignored.
 * 'stylised' (the old name of 'standard') is accepted as an alias in URLs.
 */

export type GoreLevel = 'off' | 'standard' | 'full';
export type FxQuality = 0 | 1 | 2;

/** THE gore default (one place). */
export const GORE_DEFAULT: GoreLevel = 'standard';
export const GORE_LEVELS: readonly GoreLevel[] = ['off', 'standard', 'full'];
const GORE_KEY = 'arena.gore.v2';

/** parse a gore value ('stylised' is the legacy alias of 'standard'); undefined if invalid */
export function parseGore(v: string | null | undefined): GoreLevel | undefined {
  if (v === 'stylised') return 'standard';
  return v === 'off' || v === 'standard' || v === 'full' ? v : undefined;
}

/** ?gore= in the URL, else the saved choice, else GORE_DEFAULT */
export function goreLevel(): GoreLevel {
  try {
    const q = typeof location !== 'undefined' ? parseGore(new URLSearchParams(location.search).get('gore')) : undefined;
    if (q) return q;
    const v = typeof localStorage !== 'undefined' ? parseGore(localStorage.getItem(GORE_KEY)) : undefined;
    if (v) return v;
  } catch {
    /* storage blocked */
  }
  return GORE_DEFAULT;
}

export function setGoreLevel(g: GoreLevel) {
  g = parseGore(g) ?? GORE_DEFAULT;
  try {
    localStorage.setItem(GORE_KEY, g);
  } catch {
    /* storage blocked */
  }
  fxSettings.gore = g;
  fxSettings.emit();
}

/**
 * Per-tier caps (plan §2.6). Pools are allocated at the high cap once; lower tiers only shorten the ring.
 * F1: `soft` = soft-particle depth fade (needs Post's linear-depth copy), `dist` = distortion
 * sprites (0 off, 1 heavy events only = ops with tier <= 1, 2 all). Post reads the same table.
 */
export interface TierCaps {
  add: number;
  alpha: number;
  rings: number;
  debris: number;
  /** legacy (F0) primitive count scale: 1 everywhere (F0 visuals unchanged) */
  countScale: number;
  soft: boolean;
  dist: 0 | 1 | 2;
  /** F3: mask-sprite ring (sparks, blood, mist) and per-flipbook-atlas ring (dust, smoke) */
  sprites: number;
  flipbooks: number;
  /** F3: count scale of the new sprite / flipbook ops (catalog: low = 50 %) */
  spriteScale: number;
  /** F3: persistent floor decals (plan 2.6) */
  decals: number;
  /** F3: FX light pool slots (plan 2.5) */
  lights: number;
  /** F3: afterimage ghosts per fighter */
  ghosts: number;
  /** F3: wound spheres per fighter */
  wounds: number;
  /** F3: footstep dust / splashes (0 off, 1 on) */
  steps: 0 | 1;
}
export const TIER_CAPS: Record<FxQuality, TierCaps> = {
  0: { add: 1500, alpha: 800, rings: 12, debris: 48, countScale: 1, soft: false, dist: 0, sprites: 1024, flipbooks: 40, spriteScale: 0.5, decals: 64, lights: 1, ghosts: 0, wounds: 4, steps: 0 },
  1: { add: 3000, alpha: 1500, rings: 20, debris: 96, countScale: 1, soft: true, dist: 1, sprites: 2048, flipbooks: 96, spriteScale: 0.75, decals: 128, lights: 2, ghosts: 1, wounds: 6, steps: 1 },
  2: { add: 4096, alpha: 2048, rings: 24, debris: 128, countScale: 1, soft: true, dist: 2, sprites: 3072, flipbooks: 160, spriteScale: 1, decals: 256, lights: 3, ghosts: 3, wounds: 8, steps: 1 },
};

type Listener = (s: typeof fxSettings) => void;

export const fxSettings = {
  quality: 2 as FxQuality,
  gore: goreLevel(),
  listeners: [] as Listener[],
  setQuality(q: number) {
    const v = Math.max(0, Math.min(2, Math.round(q))) as FxQuality;
    if (v === this.quality) return;
    this.quality = v;
    this.emit();
  },
  onChange(fn: Listener) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== fn);
    };
  },
  emit() {
    for (const l of this.listeners) l(this);
  },
  caps() {
    return TIER_CAPS[this.quality];
  },
};
