/**
 * SHARED ANIMATION LIBRARY: Mixamo clips that are not baked into the
 * per-fighter GLBs, retargeted at runtime onto any fighter (all rigs share the
 * Mixamo skeleton naming). Built offline by tools/anim/build-lib.ts into
 *   public/anim/<lib>.bin + public/anim/index.json   (render)
 *   src/sim/anim.gen.ts                              (sim timing data)
 *
 * Each entry names a source FBX (relative to Assets/Animations), the library
 * bundle it ships in (core = loaded with every match, the others lazily) and
 * its role. Measured tags (hit direction, severity, posture, ground contact,
 * root travel...) are computed by the builder, not written by hand.
 *
 * mirror: also emit a left/right mirrored copy (id + '~M'), generated in model
 * space relative to the rest pose and verified numerically by the builder.
 */
export type LibName = 'core' | 'entrance' | 'finisher';
export type ClipRole =
  | 'hit' // standing hit reaction (stagger)
  | 'knockdown' // stand -> ground
  | 'getup' // ground -> stand
  | 'death' // stand -> ground (terminal)
  | 'launch' // big airborne knockback (stand -> air -> ground)
  | 'dodge'
  | 'entrance'
  | 'pair' // one role of a two-person scene
  | 'finisher' // solo part of a finisher (stomp, plunge...)
  | 'social'
  | 'misc';

export interface LibClipSpec {
  id: string;
  src: string;
  lib: LibName;
  role: ClipRole;
  /** [start, end] seconds of the source to keep (end may be negative = from the end). Auto-trims apply when omitted. */
  trim?: [number, number];
  mirror?: boolean;
  /** keep the source facing / position (paired clips exported in a shared frame) */
  raw?: boolean;
  /** extra hand tags: 'blade', 'blunt', 'heavy', 'acrobatic', 'creature', 'agile', 'slow', 'kill-only' ... */
  tags?: string[];
}

const HR = 'Mixamo_HF/hit_reactions/';
const HF2R = 'Mixamo_HF2/reactions/';
const DE = 'Mixamo_HF/deaths/';
const DE2 = 'Mixamo_HF2/deaths/';
const DO = 'Mixamo_HF/dodges/';
const EN = 'Mixamo_HF2/entrance/';
const PA = 'Mixamo_HF2/paired/';
const FI = 'Mixamo_HF/finishers/';
const GT = 'Mixamo_HF/grabs_throws/';

const e = (lib: LibName, role: ClipRole, src: string, o: Partial<LibClipSpec> = {}): LibClipSpec => ({
  id: o.id ?? src.split('/').pop()!.replace(/\.fbx$/, '').replace(/[^A-Za-z0-9_]+/g, '_'),
  src: src.endsWith('.fbx') ? src : src + '.fbx',
  lib,
  role,
  ...o,
});
const hit = (src: string, o: Partial<LibClipSpec> = {}) => e('core', 'hit', src, { mirror: true, ...o });

export const ANIM_LIBRARY: LibClipSpec[] = [
  // ------------------------------------------------------------ hit reactions (stagger pool; tags measured)
  ...['Big_Hit_To_Head', 'Big_Hit_To_Head_2', 'Big_Hit_To_Head_3', 'Big_Kidney_Hit', 'Big_Rib_Hit', 'Big_Side_Hit', 'Big_Stomach_Hit', 'Getting_Hit', 'Getting_Hit_Backwards'].map((n) => hit(HR + n)),
  ...['Head_Hit', 'Head_Hit_2', 'Head_Hit_3', 'Head_Hit_4', 'Head_Hit_5', 'Hit_On_Back_Of_Head', 'Hit_On_Side_Of_Body', 'Hit_On_Side_Of_Body_2', 'Hit_On_Side_Of_Head', 'Hit_On_Side_Of_Head_2', 'Hit_On_The_Back'].map((n) => hit(HR + n)),
  ...['Hit_Reaction', 'Hit_Reaction_2', 'Hit_Reaction_3', 'Hit_Reaction_4', 'Hit_Reaction_5', 'Hit_Reaction_6', 'Hit_Reaction_7', 'Hit_Reaction_8', 'Hit_Reaction_9'].map((n) => hit(HR + n)),
  ...['Hit_To_Body', 'Hit_To_Body_2', 'Hit_To_Body_3', 'Hit_To_Body_4', 'Hit_To_Body_5', 'Receive_Punch_To_The_Face', 'Receive_Stomach_Uppercut', 'Receive_Uppercut_To_The_Face', 'Receiving_An_Uppercut'].map((n) => hit(HR + n)),
  ...['Shove_Reaction', 'Shove_Reaction_2', 'Standing_React_Large_From_Back_2', 'Standing_React_Large_From_Front_2', 'Standing_React_Large_From_Left_2', 'Standing_React_Large_From_Left_3', 'Standing_React_Large_From_Right_2', 'Standing_React_Large_From_Right_3'].map((n) => hit(HR + n)),
  ...['Standing_React_Small_From_Back_2', 'Standing_React_Small_From_Front_02', 'Standing_React_Small_From_Front_2', 'Standing_React_Small_From_Left_2', 'Standing_React_Small_From_Right_2'].map((n) => hit(HR + n)),
  ...['Great_Sword_Impact', 'Great_Sword_Impact_2', 'Great_Sword_Impact_3'].map((n) => hit(HR + n, { tags: ['blade'] })),
  ...['Struck_In_Head', 'Taking_Punch', 'Stumble_Backwards', 'Shoved_Reaction_With_Spin', 'Getting_Smashed'].map((n) => hit(HF2R + n)),
  hit(HR + 'Zombie_Reaction_Hit', { tags: ['creature'] }),
  hit(HR + 'Zombie_Reaction_Hit_2', { tags: ['creature'] }),

  // ------------------------------------------------------------ knockdowns (stand -> ground, then a get-up)
  ...['Fall_Flat', 'Fall_Over', 'Falling_Down', 'Falling_Flat_Impact', 'Knocked_Down', 'Shoulder_Hit_And_Fall', 'Stunned', 'Sweep_Fall', 'Hit_On_Legs'].map((n) => e('core', 'knockdown', HR + n, { mirror: true })),
  e('core', 'knockdown', HF2R + 'Tripping', { mirror: true }),
  e('core', 'knockdown', HF2R + 'Wall_Crash', { mirror: true, tags: ['wall'] }),
  // ------------------------------------------------------------ launches (sim-owned arc; render warps the clip onto it)
  e('core', 'launch', HF2R + 'Hit_By_Car', { mirror: true }),
  e('core', 'launch', HR + 'Receiving_A_Big_Uppercut', { mirror: true }),
  e('core', 'launch', DE + 'Flying_Back_Death', { id: 'Flying_Back_Launch', mirror: true }),
  e('core', 'launch', DE + 'Falling_Back_Death', { id: 'Falling_Back_Launch', mirror: true }),

  // ------------------------------------------------------------ get-ups (start posture measured: prone / supine / side)
  ...['Getting_Up', 'Getting_Up_2', 'Getting_Up_3', 'Getting_Up_4', 'Stand_Up_2', 'Stand_Up_3'].map((n) => e('core', 'getup', HR + n, { mirror: true })),
  e('core', 'getup', HF2R + 'Kip_Up', { mirror: true, tags: ['acrobatic'] }),
  e('core', 'getup', HF2R + 'Standing_Up_2', { mirror: true }),
  e('core', 'getup', HR + 'Zombie_Stand_Up', { mirror: true, tags: ['creature', 'slow'] }),

  // ------------------------------------------------------------ deaths
  ...['Death_From_Back_Headshot', 'Death_From_Front_Headshot', 'Death_From_Right', 'Death_From_The_Back', 'Death_From_The_Front', 'Dying_Backwards', 'Falling_Back_Death', 'Falling_Back_Death_2', 'Falling_Forward_Death', 'Flying_Back_Death', 'Standing_Death_Backward_01_2', 'Standing_Death_Forward_02', 'Standing_Death_Left_01', 'Standing_Death_Left_02', 'Standing_Death_Right_01', 'Standing_Death_Right_02', 'Two_Handed_Sword_Death', 'Two_Handed_Sword_Death_2'].map((n) => e('core', 'death', DE + n, { mirror: true })),
  e('core', 'death', DE + 'Zombie_Death', { tags: ['creature'], mirror: true }),
  e('core', 'death', DE + 'Zombie_Dying', { tags: ['creature'], mirror: true }),
  ...['Crouch_Death', 'Dying', 'Dying_3', 'Dying_5', 'Knocked_Out', 'Turn_To_Knocked_Unconscious', 'Walking_To_Dying'].map((n) => e('core', 'death', DE2 + n, { mirror: true })),
  e('core', 'death', 'ProMagic/Standing React Death Backward', { id: 'Mag_Death_Backward', mirror: true }),
  e('core', 'death', 'ProMagic/Standing React Death Forward', { id: 'Mag_Death_Forward', mirror: true }),
  e('core', 'death', 'ProMagic/Standing React Death Left', { id: 'Mag_Death_Left', mirror: true }),
  e('core', 'death', 'ProSwordandShield/sword and shield death (2)', { id: 'SS_Death_2', mirror: true }),
  e('core', 'death', 'Creature/mutant dying', { id: 'Mutant_Dying', tags: ['creature'], mirror: true }),

  // ------------------------------------------------------------ dodges (direction measured from root travel)
  ...['Jump_Backward', 'Jump_Backward_2', 'Long_Left_Side_Step', 'Long_Right_Side_Step', 'Medium_Left_Side_Step', 'Medium_Right_Side_Step', 'Short_Left_Side_Step', 'Short_Right_Side_Step', 'Dodging_Back', 'Ducking_2'].map((n) => e('core', 'dodge', DO + n, { mirror: true })),
  ...['Backflip_2', 'Front_Flip', 'Stylish_Flip', 'Aerial_Evade', 'Corkscrew_Evade'].map((n) => e('core', 'dodge', DO + n, { tags: ['acrobatic'] })),
  ...['Dive_Roll', 'Sprinting_Forward_Roll', 'Stand_To_Roll', 'Roll_Left_2'].map((n) => e('core', 'dodge', DO + n, { tags: ['roll'] })),
  ...['Queshada_1', 'Queshada_2', 'Macaco_Side'].map((n) => e('core', 'dodge', DO + n, { tags: ['capoeira'] })),
  e('core', 'dodge', 'ProLongbow/standing dodge backward', { id: 'Bow_Dodge_Back', mirror: true }),
  e('core', 'dodge', 'ProLongbow/standing dodge left', { id: 'Bow_Dodge_Left', mirror: true }),
  e('core', 'dodge', 'ProLongbow/standing dodge right', { id: 'Bow_Dodge_Right', mirror: true }),

  // ------------------------------------------------------------ entrances (arena-aware beats, lazily loaded)
  ...['Banging_Fist', 'Bash', 'Climbing_To_Top', 'Emerging', 'Fall_B_Land_To_Standing_Idle', 'Falling_To_Landing', 'Floating', 'Freehang_Climb', 'Jump_Down', 'Jumping_Down', 'Jumping_Down_2', 'Jumping_Down_6', 'Jumping_Over_Into_Combat', 'Vault_Over_Box', 'Kicking_Out', 'Smash', 'Pulling_Lever', 'Opening_Door_Inwards', 'Swagger_Walk', 'Strut_Walking', 'Standing_Taunt_Battlecry', 'Being_Cocky', 'Focus', 'Kneeling_Down', 'Stand_Up_3', 'Quick_Informal_Bow'].map((n) => e('entrance', 'entrance', EN + n)),
  e('entrance', 'entrance', 'ProMeleeAxe/standing melee attack downward', { id: 'Axe_Downward' }),
  e('entrance', 'entrance', 'ProMeleeAxe/standing walk back', { id: 'Axe_Walk_Back' }),
  e('entrance', 'entrance', 'ActionAdventure/falling idle', { id: 'Falling_Idle' }),
  e('entrance', 'entrance', 'ActionAdventure/hard landing', { id: 'Hard_Landing' }),
  e('entrance', 'entrance', 'Mixamo_HF2/social/Rallying', { id: 'Rallying' }),
  e('entrance', 'entrance', 'Mixamo_HF2/social/Fist_Pump', { id: 'Fist_Pump' }),
  e('entrance', 'entrance', 'Mixamo_HF2/idles_style/Orc_Idle', { id: 'Orc_Idle' }),

  // ------------------------------------------------------------ paired scenes + finisher solos (lazily loaded)
  e('finisher', 'pair', GT + 'Shoulder_Throw_Aggressor', { raw: true }),
  e('finisher', 'pair', GT + 'Shoulder_Throw_Victim', { raw: true }),
  e('finisher', 'pair', FI + 'Hell_Slammer_A', { raw: true }),
  e('finisher', 'pair', FI + 'Hell_Slammer_B', { raw: true }),
  e('finisher', 'pair', FI + 'Rockin_Shackle_A', { raw: true }),
  e('finisher', 'pair', FI + 'Rockin_Shackle_B', { raw: true }),
  e('finisher', 'pair', PA + 'Vampiric_Bite', { raw: true }),
  e('finisher', 'pair', PA + 'Getting_Bit', { raw: true }),
  e('finisher', 'pair', FI + 'Stealth_Assassination_2', { raw: true }),
  e('finisher', 'pair', FI + 'Stealth_Assassination', { raw: true }),
  e('finisher', 'pair', GT + 'Grab_And_Slam', { raw: true }),
  e('finisher', 'pair', GT + 'Getting_Thrown', { raw: true }),
  e('finisher', 'finisher', FI + 'Stomp', { raw: true }),
  e('finisher', 'finisher', FI + 'Stomping', { raw: true }),
  e('finisher', 'finisher', 'Mixamo_HF/weapons_extra/Great_Sword_Casting', { id: 'Great_Sword_Casting', raw: true }),
  e('finisher', 'finisher', 'ProMeleeAxe/standing melee attack downward', { id: 'Fin_Axe_Downward', raw: true }),
  e('finisher', 'finisher', DE2 + 'Crouch_Death', { id: 'Fin_Crouch_Death', raw: true }),
  e('finisher', 'finisher', HF2R + 'Edge_Slip', { id: 'Edge_Slip', raw: true }),
  e('finisher', 'finisher', HF2R + 'Teeter', { id: 'Teeter', raw: true }),
  e('finisher', 'finisher', DE + 'Prone_Death', { id: 'Prone_Death', raw: true }),
];

export const LIB_BY_ID: Record<string, LibClipSpec> = Object.fromEntries(ANIM_LIBRARY.map((c) => [c.id, c]));
