/**
 * Render-side accent colour per fighter (weapon trails, auras, telegraphs,
 * entrance lights). Models and clips live in data/animsets.ts.
 */
export interface Appearance {
  accent: string;
}

export const APPEARANCE: Record<string, Appearance> = {
  gorak: { accent: '#ff5a1f' },
  aldric: { accent: '#7cc4ff' },
  ozrel: { accent: '#ff9a2a' },
  erika: { accent: '#6dffb8' },
  vex: { accent: '#ff3a6a' },
  fenrik: { accent: '#8bff5a' },
  maw: { accent: '#b07bff' },
  hollowjack: { accent: '#ff8a1a' },
};
