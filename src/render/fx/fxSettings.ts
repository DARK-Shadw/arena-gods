/**
 * FX settings: quality tier and gore level (single source of truth).
 *
 * Gore: the code lives here now (finisherFx re-exports it unchanged). The
 * DEFAULT IS STILL 'off' and the storage key is unchanged: changing the default
 * (plan §3.7: 'standard' + a new key) waits for the owner's decision.
 */

export type GoreLevel = 'off' | 'stylised' | 'full';
export type FxQuality = 0 | 1 | 2;

const GORE_KEY = 'arena.gore';

export function goreLevel(): GoreLevel {
  try {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('gore') : null;
    if (q === 'off' || q === 'stylised' || q === 'full') return q;
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(GORE_KEY) : null;
    if (v === 'off' || v === 'stylised' || v === 'full') return v;
  } catch {
    /* storage blocked */
  }
  return 'off';
}

export function setGoreLevel(g: GoreLevel) {
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
