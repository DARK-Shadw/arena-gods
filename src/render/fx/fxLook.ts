/**
 * F1 look tuning (bloom + grade extras per arena theme, and the per-moment grade presets).
 *
 * The theme table itself (src/render/arena/themes.ts) belongs to the arena session, so F1 does
 * not edit it: Post.setLook() takes the theme's numbers and, when the theme id is known, replaces
 * the bloom numbers with the F1 row below and adds the grade extras. Delete a row to fall back to
 * the theme's own numbers (converted by `fallbackLook`).
 *
 * Target (docs/concept-art/ref-3..10.png): hot over-bright cores that bloom while the scene does
 * not glow overall (soft-knee threshold near 1-2 with a lower strength), cool shadows against warm
 * highlights (split toning), crushed blacks (a toe), and a faint wide glow in fog and around light
 * sources (the bloom's deep levels, `radius`).
 */

export type RGB = [number, number, number];

export interface BloomLook {
  /** HDR level where bloom starts (linear, before exposure) */
  threshold: number;
  /** soft-knee width around the threshold (0 = hard cut) */
  knee: number;
  strength: number;
  /** 0..1: how much the wide (deep) levels add, i.e. halo size / fog glow */
  radius: number;
}

export interface LookExtras {
  /** multiplier on dark tones (luminance-normalised by Post) */
  shadowTint: RGB;
  /** multiplier on bright tones (luminance-normalised by Post) */
  highlightTint: RGB;
  /** black toe: x * x / (x + crush); 0 = off */
  crush: number;
}

export interface ThemeLook {
  bloom: BloomLook;
  extras: LookExtras;
}

const NEUTRAL: LookExtras = { shadowTint: [1, 1, 1], highlightTint: [1, 1, 1], crush: 0 };

/** Per theme (ThemeId). Day themes keep a higher threshold so sunlit stone does not haze over. */
export const THEME_LOOK: Record<string, ThemeLook> = {
  colosseum: { bloom: { threshold: 1.7, knee: 0.7, strength: 0.3, radius: 0.55 }, extras: { shadowTint: [0.93, 0.97, 1.08], highlightTint: [1.05, 1.0, 0.94], crush: 0.012 } },
  skytemple: { bloom: { threshold: 2.2, knee: 0.8, strength: 0.22, radius: 0.5 }, extras: { shadowTint: [0.94, 0.98, 1.08], highlightTint: [1.03, 1.0, 0.96], crush: 0.01 } },
  sakura: { bloom: { threshold: 1.6, knee: 0.7, strength: 0.32, radius: 0.6 }, extras: { shadowTint: [0.95, 0.96, 1.07], highlightTint: [1.04, 0.99, 0.97], crush: 0.012 } },
  forge: { bloom: { threshold: 1.15, knee: 0.55, strength: 0.4, radius: 0.6 }, extras: { shadowTint: [0.9, 0.95, 1.12], highlightTint: [1.07, 0.99, 0.9], crush: 0.02 } },
  glacier: { bloom: { threshold: 1.25, knee: 0.55, strength: 0.36, radius: 0.62 }, extras: { shadowTint: [0.95, 0.98, 1.06], highlightTint: [1.04, 1.0, 0.95], crush: 0.015 } },
  moonlake: { bloom: { threshold: 1.1, knee: 0.55, strength: 0.38, radius: 0.68 }, extras: { shadowTint: [0.9, 0.95, 1.12], highlightTint: [1.08, 0.98, 0.9], crush: 0.02 } },
  desert: { bloom: { threshold: 1.8, knee: 0.7, strength: 0.28, radius: 0.6 }, extras: { shadowTint: [0.94, 0.97, 1.07], highlightTint: [1.04, 1.0, 0.94], crush: 0.012 } },
};

/** A theme without an F1 row: keep its bloom numbers (hard knee), no extras. */
export function fallbackLook(b: { strength: number; radius: number; threshold: number }): ThemeLook {
  return { bloom: { threshold: b.threshold, knee: 0.2, strength: b.strength, radius: b.radius }, extras: NEUTRAL };
}

/**
 * Per-moment grade presets (hooks for F7 cinematics and FxDef.post.grade kicks). Each is a delta
 * blended on top of the theme grade by its weight 0..1:
 *   multiplicative fields (exposure, saturation, tint, bloom) lerp from 1 to the value,
 *   additive fields (contrast, vignette, desat, crush, lift) scale by the weight.
 * Post.setPreset(id, w) holds a weight (eased); Post.kickPreset(id, w, dur) adds a decaying one.
 */
export interface GradeDelta {
  exposure?: number;
  contrast?: number;
  saturation?: number;
  tint?: RGB;
  lift?: RGB;
  vignette?: number;
  desat?: number;
  crush?: number;
  /** bloom strength multiplier */
  bloom?: number;
}

export const GRADE_PRESETS: Record<string, GradeDelta> = {
  /** finisher freeze / cut-in: drained, contrasty, heavier edges */
  finisher: { exposure: 0.92, contrast: 0.12, saturation: 0.8, vignette: 0.3, crush: 0.02, tint: [1.03, 0.98, 0.95] },
  /** ultimate release: hotter, a little brighter, more glow */
  ultimate: { exposure: 1.06, contrast: 0.08, saturation: 1.12, bloom: 1.4 },
  /** last stand: blood-warm, desaturated, tunnel vignette */
  lastStand: { saturation: 0.72, contrast: 0.1, vignette: 0.4, tint: [1.08, 0.93, 0.9] },
  /** kill cam: the existing killcam desaturation as a preset */
  killcam: { desat: 0.35, contrast: 0.1, vignette: 0.2, exposure: 0.95 },
  /** victory: warm, open, glowing */
  victory: { exposure: 1.05, saturation: 1.1, tint: [1.05, 1.0, 0.93], bloom: 1.3, crush: -0.008 },
  /** big hit pulse (short kick) */
  impact: { exposure: 1.08, contrast: 0.06, vignette: 0.12 },
};
