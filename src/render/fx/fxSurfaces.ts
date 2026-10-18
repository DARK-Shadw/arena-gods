/**
 * DATA (plan §3.1 fxSurfaces.ts): what each fighter's body is made of, what each strike hits with,
 * and what the floor is. New characters need one row in each table.
 *
 * Weapon class of a strike = the move's effector: a fighter with a weapon tip striking with the right
 * hand uses its weapon (axe / sword); feet are kicks (blunt); the other hands follow WEAPON_HAND
 * (claws, fists, magic). Projectile hits use the move's fx tag (arrow = pierce, fire / pyre = fire).
 */
export type WeaponClass = 'axe' | 'sword' | 'claw' | 'blunt' | 'pierce' | 'fire' | 'shadow';
export type Surface = 'metal' | 'flesh' | 'fur' | 'cloth' | 'pumpkin';
export type FloorSurface = 'stone' | 'sand' | 'snow' | 'wet' | 'water' | 'earth' | 'ash';

/** fighter id -> body surface (where most hits land) */
export const BODY: Record<string, Surface> = {
  gorak: 'flesh',
  aldric: 'metal',
  ozrel: 'cloth',
  erika: 'flesh',
  vex: 'flesh',
  fenrik: 'fur',
  maw: 'flesh',
  hollowjack: 'pumpkin',
};

/** fighter id -> weapon on the right hand when the model has a weapon tip */
export const WEAPON: Record<string, WeaponClass> = { gorak: 'axe', aldric: 'sword' };
/** fighter id -> class of a bare-hand strike */
export const WEAPON_HAND: Record<string, WeaponClass> = { vex: 'claw', fenrik: 'claw', maw: 'blunt', hollowjack: 'blunt', ozrel: 'blunt', erika: 'blunt', gorak: 'blunt', aldric: 'blunt' };

/** model heights (m, public/models/*.json `height`): frame-data anchors when no bones are available */
export const HEIGHT: Record<string, number> = { aldric: 1.86, erika: 1.81, fenrik: 1.86, gorak: 1.72, hollowjack: 2.04, maw: 2.38, ozrel: 2.12, vex: 1.94 };

/** which body surfaces bleed (gore >= standard); pumpkin never does (plan §3.7) */
export const BLEEDS: Record<Surface, boolean> = { metal: true, flesh: true, fur: true, cloth: true, pumpkin: false };

/** theme -> default floor surface (footstep FX); water hazards override per position */
export const THEME_FLOOR: Record<string, FloorSurface> = {
  colosseum: 'sand',
  forge: 'ash',
  glacier: 'snow',
  skytemple: 'stone',
  sakura: 'earth',
  moonlake: 'wet',
  desert: 'sand',
};

/** dust tint per floor surface (footsteps, landings) */
export const FLOOR_DUST: Record<FloorSurface, string> = {
  stone: '#6e6860',
  sand: '#8c7656',
  snow: '#c8d2dc',
  wet: '#5a5652',
  water: '#a8c4d8',
  earth: '#5e4e40',
  ash: '#4a4440',
};

/** strike class from (fighter, effector bone of the move, move fx tag) */
export function weaponClassOf(fighter: string, eff: string | undefined, fx: string, hasTip: boolean): WeaponClass {
  if (fx === 'arrow') return 'pierce';
  if (fx === 'fire' || fx === 'pyre' || fx === 'nova') return 'fire';
  if (eff && /Foot|Leg|Toe/.test(eff)) return 'blunt';
  if (hasTip && (!eff || eff === 'RightHand') && WEAPON[fighter]) return WEAPON[fighter];
  if (fx === 'shadow' && fighter === 'vex') return 'claw';
  return WEAPON_HAND[fighter] ?? 'blunt';
}

/** blade-like classes leave blood on the weapon and cut (sprays) rather than bruise */
export const CUTS: Record<WeaponClass, boolean> = { axe: true, sword: true, claw: true, pierce: true, blunt: false, fire: false, shadow: false };
