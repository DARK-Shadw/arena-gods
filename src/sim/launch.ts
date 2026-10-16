/** Launch (big knockback) tuning + force model, shared by the sim and the AI. */
import type { FighterState } from './match';
import type { MoveDef } from './types';

/**
 * Launch force of a knockdown blow: knockback x sqrt(attacker mass), more for
 * heavies / ultimates and off-balance victims (recovering, staggered, winded,
 * countered), less on heavy victims. Arrows never launch.
 */
export function launchForce(att: FighterState, def: FighterState, m: MoveDef, defPhase: number): number {
  if (m.fx === 'arrow') return 0;
  const offBalance = defPhase === 2 || def.state === 'stagger' || def.state === 'winded' || def.exhausted || defPhase === 0;
  return (m.knockback * Math.sqrt(att.def.stats.weight) * (m.kind === 'heavy' || m.kind === 'ultimate' ? 1.2 : 1) * (offBalance ? 1.3 : 1)) / Math.max(0.8, def.def.stats.weight);
}

/** Launch tuning: rare, force x weight driven (see docs/animation-plan.md, M2) */
export const LAUNCH = {
  minForce: 7.6,
  maxPerMatch: 1,
  cooldown: 18,
  gravityK: 1,
};
