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

/** Per-tier caps (plan §2.6). Pools are allocated at the high cap once; lower tiers only shorten the ring. */
export const TIER_CAPS: Record<FxQuality, { add: number; alpha: number; rings: number; debris: number; countScale: number }> = {
  0: { add: 1500, alpha: 800, rings: 12, debris: 48, countScale: 1 },
  1: { add: 3000, alpha: 1500, rings: 20, debris: 96, countScale: 1 },
  2: { add: 4096, alpha: 2048, rings: 24, debris: 128, countScale: 1 },
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
