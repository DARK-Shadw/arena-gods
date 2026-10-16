/**
 * SFX manifest: sound pools (with source files for the offline build) and
 * runtime playback parameters. `npm run audio:build` converts the sources
 * (audio-src/, extracted from the downloaded packs) into trimmed, normalised
 * mono .ogg files in public/audio/sfx/ and writes public/audio/sfx/manifest.json
 * with each file's duration and transient-peak offset (used to line the
 * impact up exactly with the animation's strike moment).
 *
 * Packs (see public/audio/CREDITS.txt):
 *   H  = Hove Audio "Sword Combat Sound Effects Pack FREE VERSION"
 *   SB = The Soundrack "Swords & Blades SFX Pack" (CC BY 4.0)
 *   KI = Kenney "Impact Sounds" (CC0), KR = Kenney "RPG Audio" (CC0)
 *   KF = Kenney "Voiceover Pack: Fighter" (CC0)
 *   MO = Ogrebane "Monster Sounds Volume 2"
 */
export interface PoolDef {
  src: string[];
  /** linear gain at runtime */
  vol: number;
  /** random playback-rate range */
  pitch: [number, number];
  /** max length kept by the build (s); longer files are faded out */
  maxDur?: number;
  /** bus: sfx | voice | ui */
  bus?: 'sfx' | 'voice' | 'ui';
}

const H = 'Sword_Combat_Sound_Effects_Pack_FREE_VERSION/Sword Combat Sound Effects Pack FREE VERSION/';
const HS = H + 'Main Sounds/Sword Stabs/';
const SB = 'Swords___Blades_SFX_Pack/Swords & Blades/';
const KI = 'kenney_impact-sounds/Audio/';
const KR = 'kenney_rpg-audio/Audio/';
const KF = 'kenney_voiceover-pack-fighter/Audio/';
const MO = 'monster-sounds-volume-2/Monster-Sounds-Volume-2/';
const n5 = (p: string) => [0, 1, 2, 3, 4].map((i) => `${p}_00${i}.ogg`);
const sb = (dir: string, ids: number[]) => ids.map((i) => `${SB}${dir}/${dir}${dir === 'Sword Hit' ? '  ' : ' '}${String(i).padStart(2, '0')}.wav`);

export const POOLS: Record<string, PoolDef> = {
  whoosh_light: { src: [...sb('Sword Whoosh', [1, 2, 7, 8, 12]), `${H}Whooshes/WHSH_Whoosh_HoveAud_SwordCombat_26.wav`], vol: 0.55, pitch: [0.92, 1.15], maxDur: 0.8 },
  whoosh_heavy: { src: [...sb('Sword Whoosh', [3, 5, 6, 9, 13]), `${H}Whooshes/WHSH_Whoosh_HoveAud_SwordCombat_07.wav`], vol: 0.7, pitch: [0.78, 0.95], maxDur: 1.0 },
  clang: { src: [...sb('Sword Hit', [1, 2, 14, 16, 18, 19, 20, 21, 22, 25]), `${H}Main Sounds/Sword Collisions/Base Metal/WEAPSwrd_BaseMetal_HoveAud_SwordCombat_03.wav`, `${H}Main Sounds/Sword Collisions/Base Metal/WEAPSwrd_BaseMetal_HoveAud_SwordCombat_06.wav`], vol: 0.8, pitch: [0.9, 1.1], maxDur: 1.0 },
  parry: { src: sb('Sword Hit', [3, 4, 5, 8, 11]), vol: 0.9, pitch: [0.95, 1.08], maxDur: 1.0 },
  ring: { src: [1, 11, 17].map((i) => `${H}Ring FX/MAGShim_Ring_HoveAud_SwordCombat_${String(i).padStart(2, '0')}.wav`), vol: 0.45, pitch: [0.95, 1.05], maxDur: 2.2 },
  hit_blade: { src: [...[1, 11, 17].map((i) => `${HS}Base Stabs/WEAPSwrd_SwordStab_HoveAud_SwordCombat_${String(i).padStart(2, '0')}.wav`), ...sb('Sword Impact', [7, 8])], vol: 0.85, pitch: [0.9, 1.1], maxDur: 0.8 },
  hit_heavy: { src: sb('Sword Impact', [1, 3, 4, 5]), vol: 0.9, pitch: [0.8, 0.95], maxDur: 1.2 },
  hit_blunt: { src: [...n5(`${KI}impactPunch_heavy`), ...n5(`${KI}impactPunch_medium`)], vol: 0.85, pitch: [0.85, 1.1], maxDur: 0.6 },
  body_thud: { src: n5(`${KI}impactSoft_heavy`), vol: 0.9, pitch: [0.7, 0.9], maxDur: 0.8 },
  arrow_hit: { src: [`${KR}knifeSlice.ogg`, `${KR}knifeSlice2.ogg`, ...n5(`${KI}impactSoft_medium`).slice(0, 3)], vol: 0.8, pitch: [0.95, 1.2], maxDur: 0.6 },
  cloth: { src: [1, 2, 3, 4].map((i) => `${KR}cloth${i}.ogg`).concat([`${KR}clothBelt.ogg`, `${KR}clothBelt2.ogg`]), vol: 0.6, pitch: [0.9, 1.15], maxDur: 0.8 },
  footstep: { src: Array.from({ length: 10 }, (_, i) => `${KR}footstep0${i}.ogg`), vol: 0.35, pitch: [0.85, 1.1], maxDur: 0.5 },
  footstep_heavy: { src: n5(`${KI}footstep_concrete`), vol: 0.6, pitch: [0.55, 0.7], maxDur: 0.6 },
  wall_slam: { src: n5(`${KI}impactPlate_heavy`), vol: 0.9, pitch: [0.75, 0.9], maxDur: 1.0 },
  stone_slam: { src: n5(`${KI}impactMining`), vol: 0.9, pitch: [0.6, 0.75], maxDur: 1.0 },
  wood_break: { src: [...n5(`${KI}impactWood_heavy`), ...n5(`${KI}impactPlank_medium`)], vol: 0.9, pitch: [0.8, 1.0], maxDur: 1.0 },
  grunt_effort: { src: [1, 7, 23, 29, 54].map((i) => `${H}Voicelines/Action Grunts/VOXEfrt_ActionGrunt_HoveAud_SwordCombat_${String(i).padStart(2, '0')}.wav`), vol: 0.55, pitch: [0.95, 1.05], maxDur: 1.3, bus: 'voice' },
  grunt_pain: { src: [1, 13, 22, 27].map((i) => `${H}Voicelines/Damage Grunts/VOXScrm_DamageGrunt_HoveAudio_SwordCombat_${String(i).padStart(2, '0')}.wav`), vol: 0.6, pitch: [0.95, 1.05], maxDur: 1.4, bus: 'voice' },
  creature_roar: { src: [1, 2, 3, 5].map((i) => `${MO}Monster-${i}.wav`), vol: 0.9, pitch: [0.6, 0.75], maxDur: 1.2, bus: 'voice' },
  creature_grunt: { src: [4, 6, 7, 8].map((i) => `${MO}Monster-${i}.wav`).concat([9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((i) => `${MO}monster-${i}.wav`)), vol: 0.8, pitch: [0.65, 0.85], maxDur: 0.8, bus: 'voice' },
  announcer: { src: ['fight', 'prepare_yourself', 'sudden_death', 'winner', 'flawless_victory', 'final_round', 'combo_breaker'].map((n) => `${KF}${n}.ogg`), vol: 0.9, pitch: [1, 1], maxDur: 2.5, bus: 'ui' },
};

/** Announcer clip index by name (order of POOLS.announcer.src). */
export const ANNOUNCER = { fight: 0, prepare: 1, suddenDeath: 2, winner: 3, flawless: 4, finalRound: 5, comboBreaker: 6 } as const;

/** Which impact family a fighter's strikes use. */
export const HIT_FAMILY: Record<string, 'blade' | 'blunt' | 'magic' | 'arrow'> = {
  gorak: 'blade',
  aldric: 'blade',
  ozrel: 'magic',
  erika: 'arrow',
  vex: 'blunt',
  fenrik: 'blunt',
  maw: 'blunt',
  hollowjack: 'blunt',
};
/** Creature voices use the monster pool instead of human grunts. */
export const CREATURE: Record<string, number> = { fenrik: 0.9, maw: 0.62, hollowjack: 0.95 };
/** Heavy footsteps for big fighters. */
export const HEAVY_STEPS = new Set(['gorak', 'maw', 'hollowjack']);

export const MUSIC = { src: 'Juhani Junkala - Epic Boss Battle [Seamlessly Looping].wav', out: 'music/boss_battle.ogg' };
