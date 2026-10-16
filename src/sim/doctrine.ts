/**
 * Combat DOCTRINE per fighter: the "how I win" layer the AI reasons with.
 * (See docs/ai-design.md for where the ideas come from.)
 *
 *  role          broad archetype (drives goal weights)
 *  band          preferred EDGE-TO-EDGE gap [min, max] in metres ("measure")
 *  winCondition  what the fighter is trying to make happen
 *  fears         opponent traits this doctrine is weak against
 */
export type Role = 'zoner' | 'kiter' | 'rushdown' | 'bruiser' | 'duelist' | 'tank' | 'trickster';

export interface Doctrine {
  role: Role;
  band: [number, number];
  winCondition: string;
  fears: ('reach' | 'speed' | 'ranged' | 'armor' | 'pressure')[];
  /** 0..1: how much this fighter likes to use pillars/cover. */
  usesCover: number;
  /** 0..1: willingness to bait / feint. */
  mindGames: number;
  /** 0..1: likes picking up and hurling props */
  usesProps: number;
  /** 0..1: environmental cunning (topple cover onto them, bait into hazards, shoot barrels) */
  envCunning: number;
}

export const DOCTRINE: Record<string, Doctrine> = {
  gorak: { role: 'bruiser', band: [0.3, 1.8], winCondition: 'corner the opponent and land armored heavies', fears: ['ranged', 'speed'], usesCover: 0.4, mindGames: 0.3, usesProps: 0.8, envCunning: 0.4 },
  aldric: { role: 'duelist', band: [0.7, 2.0], winCondition: 'block, parry, punish recovery with sword strings', fears: ['armor', 'pressure'], usesCover: 0.5, mindGames: 0.6, usesProps: 0.3, envCunning: 0.6 },
  ozrel: { role: 'zoner', band: [2.2, 5.0], winCondition: 'keep mid range, burn approaches, nova anyone who gets close', fears: ['speed', 'pressure'], usesCover: 0.5, mindGames: 0.4, usesProps: 0.2, envCunning: 0.8 },
  erika: { role: 'kiter', band: [2.6, 6.8], winCondition: 'shoot from distance, retreat when approached, kick to make space', fears: ['speed', 'pressure', 'armor'], usesCover: 0.7, mindGames: 0.5, usesProps: 0.25, envCunning: 0.7 },
  vex: { role: 'trickster', band: [0.6, 2.6], winCondition: 'dart in, strike, dart out; feint to draw whiffs', fears: ['armor', 'reach'], usesCover: 0.3, mindGames: 0.9, usesProps: 0.45, envCunning: 0.8 },
  fenrik: { role: 'rushdown', band: [0.0, 1.4], winCondition: 'stay in the face, chain claws, never let them breathe', fears: ['reach', 'armor'], usesCover: 0.1, mindGames: 0.2, usesProps: 0.3, envCunning: 0.3 },
  maw: { role: 'tank', band: [0.4, 2.2], winCondition: 'walk them down, absorb hits, land one crushing blow', fears: ['ranged', 'speed'], usesCover: 0.2, mindGames: 0.2, usesProps: 0.9, envCunning: 0.35 },
  hollowjack: { role: 'bruiser', band: [0.2, 1.7], winCondition: 'smother with kicks and punches, slam when they freeze', fears: ['ranged', 'reach'], usesCover: 0.3, mindGames: 0.5, usesProps: 0.7, envCunning: 0.6 },
};

export function doctrineOf(id: string): Doctrine {
  return DOCTRINE[id] ?? { role: 'duelist', band: [0.6, 2], winCondition: '', fears: [], usesCover: 0.3, mindGames: 0.3, usesProps: 0.4, envCunning: 0.4 };
}
