# Animation catalog

Every animation clip we own: 594 clips (360 Mixamo_HF, 234 original packs).
The data is measured from the FBX files by `tools/anim/analyze.ts` and tagged by `tools/anim/catalog.ts`. The machine-readable version is `docs/animation-catalog.json`, which also carries start and end poses, contacts and per-effector peaks.

**Columns:**
- **dur**: seconds.
- **root**: hips travel in metres (dz forward, dx sideways); yaw is the turn in degrees. `·` means in place.
- **posture**: start>end posture.
- **strike/contact**: the fastest effector and its time. For deaths and knockdowns it is the end posture.
- **L**: loopable cycle (locomotion or idle whose start and end poses match).
- **M**: asymmetric, so a mirrored copy gives a distinct opposite-side variant.
- **used**: current in-game use.

| category | clips | in game |
|---|---|---|
| error | 1 | 0 |
| attack | 64 | 19 |
| block | 15 | 4 |
| cast | 25 | 12 |
| combo | 20 | 3 |
| cover | 6 | 0 |
| death | 32 | 6 |
| dodge | 38 | 3 |
| emote | 24 | 5 |
| equip | 12 | 2 |
| finisher | 18 | 0 |
| getup | 10 | 0 |
| grapple | 14 | 0 |
| hit-react | 83 | 12 |
| idle | 36 | 11 |
| jump-fall | 20 | 3 |
| kick | 20 | 4 |
| knockdown | 12 | 0 |
| locomotion | 67 | 28 |
| misc | 1 | 1 |
| parry | 2 | 2 |
| talk | 18 | 0 |
| throw-prop | 7 | 0 |
| transition | 5 | 2 |
| turn | 25 | 0 |
| victory-defeat | 19 | 0 |

## error (1)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| ProMeleeAxe/standing melee attack horizontal.fbx | error: THREE.FBXLoader: Unknown property type  |||||||| 

## attack (64)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| Creature/jump attack | creature | 3.8 | dz 2.17 dx 0.14 yaw -64 | stand>crouch (via kneel) | LeftHand @1.6 |  |  | fenrik.pounce, maw.crushing_leap |
| Creature/mutant jump attack | creature | 3.7 | dz 1.65 dx 0.14 | stand>stand (via kneel) | LeftHand @1.6 |  |  | fenrik.maul, maw.earthshaker |
| Creature/mutant punch | creature | 1.1 | · | stand>stand (via crouch) | RightHand @0.3 |  | M | fenrik.rend, maw.hammerfist +1 |
| Creature/mutant swiping | creature | 2.667 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @1.3 |  | M | fenrik.rake, fenrik.swipe_feint +1 |
| HF/brawler_kicks/Boxing_10 | unarmed | 2 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @0.533 |  | M |  |
| HF/brawler_kicks/Boxing_2 | unarmed | 2.1 | dz -0.01 dx 0 | stand>stand (via crouch) | RightHand @0.567 |  |  |  |
| HF/brawler_kicks/Boxing_3 | unarmed | 2.133 | dz 0 dx 0 | stand>stand (via crouch) | RightHand @0.6 |  |  |  |
| HF/brawler_kicks/Boxing_4 | unarmed | 2.167 | dz 0 dx 0 | stand>stand (via crouch) | RightHand @0.633 |  | M |  |
| HF/brawler_kicks/Boxing_5 | unarmed | 2.467 | dz 0 dx 0 | stand>stand (via crouch) | RightFoot @0.8 |  | M |  |
| HF/brawler_kicks/Boxing_6 | unarmed | 2.2 | dz 0 dx 0 | stand>stand | LeftHand @0.733 |  |  |  |
| HF/brawler_kicks/Boxing_7 | unarmed | 2.2 | dz 0 dx 0 | stand>stand (via crouch) | RightHand @0.6 |  | M |  |
| HF/brawler_kicks/Boxing_8 | unarmed | 4.233 | dz 0 dx 0 | stand>stand (via kneel) | RightHand @1.033 |  | M |  |
| HF/brawler_kicks/Boxing_9 | unarmed | 2.2 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @0.667 |  | M |  |
| HF/brawler_kicks/Boxing | unarmed | 1.733 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @0.367 |  | M |  |
| HF/brawler_kicks/Hook_2 | unarmed | 2.267 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @0.633 |  | M |  |
| HF/brawler_kicks/Hook_3 | unarmed | 1.3 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @0.4 |  | M |  |
| HF/brawler_kicks/Hook_4 | unarmed | 2.933 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @1.133 |  |  |  |
| HF/brawler_kicks/Hook_5 | unarmed | 1.9 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @0.867 |  | M |  |
| HF/brawler_kicks/Hook_6 | unarmed | 2 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @0.467 |  | M |  |
| HF/brawler_kicks/Hook_Punch | unarmed | 2.167 | · | stand>stand (via crouch) | RightHand @0.967 |  | M |  |
| HF/brawler_kicks/Hook | unarmed | 2.4 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @1 |  | M |  |
| HF/brawler_kicks/Illegal_Knee_2 | unarmed | 2.267 | dz 0 dx 0 | stand>stand | RightFoot @0.533 |  | M |  |
| HF/brawler_kicks/Illegal_Knee | unarmed | 2.267 | dz 0 dx 0 | stand>stand | RightFoot @0.533 |  | M |  |
| HF/brawler_kicks/Lead_Jab_2 | unarmed | 1.8 | dz -0.01 dx 0 | stand>stand (via crouch) | LeftHand @0.4 |  | M |  |
| HF/brawler_kicks/Lead_Jab_3 | unarmed | 1.5 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @0.333 |  | M |  |
| HF/brawler_kicks/Lead_Jab_4 | unarmed | 1.967 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @0.4 |  |  |  |
| HF/brawler_kicks/Lead_Jab_5 | unarmed | 1.067 | · | stand>stand (via crouch) | LeftHand @0.367 |  | M |  |
| HF/brawler_kicks/Lead_Jab_6 | unarmed | 1.833 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @0.4 |  | M |  |
| HF/brawler_kicks/Lead_Jab | unarmed | 1.333 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @0.3 |  | M |  |
| HF/brawler_kicks/Right_Hook | unarmed | 1.1 | · | stand>stand (via crouch) | RightHand @0.3 |  | M |  |
| HF/weapons_extra/Great_Sword_Attack | 2h-greatsword | 1.2 | · | stand>stand (via crouch) | RightHand @0.467 |  |  |  |
| HF/weapons_extra/Great_Sword_High_Spin_Attack | 2h-greatsword | 1.867 | dz 2.28 dx 0 yaw 366 | stand>stand | RightHand @1.1 |  |  |  |
| HF/weapons_extra/Great_Sword_Jump_Attack | 2h-greatsword | 2.167 | dz 3.11 dx -0.08 yaw 728 | stand>stand | RightHand @1.067 |  |  |  |
| HF/weapons_extra/Great_Sword_Kick_2 | 2h-greatsword | 1.5 | dz 0 dx 0 yaw 360 | stand>stand | RightFoot @0.533 |  | M |  |
| HF/weapons_extra/Great_Sword_Kick | 2h-greatsword | 1.733 | dz 0 dx 0 | stand>stand (via crouch) | LeftFoot @0.7 |  | M |  |
| HF/weapons_extra/Great_Sword_Slash_2 | 2h-greatsword | 1.8 | dz 1.1 dx 0 yaw -361 | stand>stand | RightHand @0.767 |  |  |  |
| HF/weapons_extra/Great_Sword_Slash_3 | 2h-greatsword | 1.433 | dz 0.02 dx 0 | kneel>kneel | RightFoot @0.367 |  | M |  |
| HF/weapons_extra/Great_Sword_Slash_4 | 2h-greatsword | 3.533 | dz 3.03 dx 0 yaw -360 | stand>stand (via crouch) | LeftHand @0.733 |  |  |  |
| HF/weapons_extra/Great_Sword_Slash_5 | 2h-greatsword | 1.267 | dz 0.01 dx 0 | stand>stand (via crouch) | LeftHand @0.567 |  | M |  |
| HF/weapons_extra/Great_Sword_Slash | 2h-greatsword | 1.833 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @0.767 |  | M |  |
| HF/weapons_extra/Great_Sword_Slide_Attack | 2h-greatsword | 2.133 | dz 3.41 dx -0.07 yaw 370 | stand>stand (via kneel) | RightHand @1.5 |  |  |  |
| HF/weapons_extra/Stable_Sword_Inward_Slash | 1h-sword | 2.2 | dz 0 dx 0 | crouch>crouch | RightHand @1.2 |  | M |  |
| HF/weapons_extra/Stable_Sword_Outward_Slash | 1h-sword | 2.033 | · | crouch>crouch | RightHand @0.867 |  | M |  |
| HF/weapons_extra/Standing_Torch_Melee_Attack_01 | 1h-torch/club | 2 | · | stand>stand | LeftHand @0.9 |  | M |  |
| HF/weapons_extra/Standing_Torch_Melee_Attack_02 | 1h-torch/club | 2.333 | · | stand>stand (via crouch) | LeftHand @0.667 |  |  |  |
| HF/weapons_extra/Standing_Torch_Melee_Attack_03 | 1h-torch/club | 3.5 | · | stand>stand (via crouch) | LeftHand @1.667 |  |  |  |
| HF/weapons_extra/Standing_Torch_Melee_Attack_04 | 1h-torch/club | 3.833 | dz 1.74 dx 0 | stand>stand (via crouch) | LeftHand @1.133 |  |  |  |
| HF/weapons_extra/Standing_Torch_Melee_Attack_05 | 1h-torch/club | 3.2 | dz 1.73 dx 0 | stand>stand (via crouch) | LeftHand @1.667 |  |  |  |
| HF/weapons_extra/Standing_Torch_Melee_Attack_Stab | 1h-torch/club | 2.433 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @0.833 |  | M |  |
| ProLongbow/standing melee punch | bow | 1 | · | stand>stand | LeftHand @0.333 |  | M | erika.jab, hollowjack.gourd_punch +1 |
| ProMeleeAxe/standing melee attack 360 high | 1h-axe | 3.167 | dz 0 dx 0 yaw -360 | stand>stand (via crouch) | RightHand @1.067 |  | M | gorak.skullsplitter, maw.devour +1 |
| ProMeleeAxe/standing melee attack 360 low | 1h-axe | 2.5 | dz 0 dx 0 yaw -360 | stand>stand (via crouch) | RightHand @0.933 |  | M | gorak.cleave, fenrik.tail_sweep +2 |
| ProMeleeAxe/standing melee attack backhand | 1h-axe | 3.167 | dz 0 dx 0 | crouch>crouch | RightHand @1.033 |  | M | gorak.backswing |
| ProMeleeAxe/standing melee attack downward | 1h-axe | 2.267 | · | crouch>crouch | RightHand @0.833 |  | M | gorak.skull_crack, gorak.axe_feint +2 |
| ProMeleeAxe/standing melee run jump attack | 1h-axe | 3.667 | dz 3.57 dx 0 | stand>crouch (via kneel) | LeftHand @1.7 |  |  | gorak.brute_rush |
| ProSwordandShield/sword and shield attack (2) | sword-shield | 1.3 | dz 2.58 dx 1.07 yaw -419 | stand>crouch | RightHand @0.633 |  |  | aldric.counter_riposte, vex.shadow_step |
| ProSwordandShield/sword and shield attack (3) | sword-shield | 1.733 | dz 2.32 dx 0 yaw -397 | stand>crouch | RightHand @0.767 |  |  | aldric.lunging_strike |
| ProSwordandShield/sword and shield attack (4) | sword-shield | 1 | · | crouch>crouch | RightHand @0.433 |  | M | aldric.riposte, vex.fade_cut |
| ProSwordandShield/sword and shield attack | sword-shield | 2.333 | dz 3.48 dx 0.01 yaw -45 | stand>crouch (via kneel) | LeftHand @1.233 |  |  | aldric.bulwark_rush, maw.shoulder_barge +1 |
| ProSwordandShield/sword and shield slash (2) | sword-shield | 3.533 | dz 2.35 dx 0.01 yaw -362 | stand>stand (via kneel) | RightFoot @1.867 |  |  | aldric.oath_of_steel |
| ProSwordandShield/sword and shield slash (3) | sword-shield | 1.667 | dz 0 dx 0 | crouch>crouch | RightHand @0.833 |  | M | aldric.cross_cut |
| ProSwordandShield/sword and shield slash (4) | sword-shield | 2.433 | dz 1 dx 0 yaw -360 | crouch>crouch (via kneel) | RightHand @1.333 |  |  | aldric.rising_slash |
| ProSwordandShield/sword and shield slash (5) | sword-shield | 1.367 | dz 0 dx 0 | kneel>kneel | RightHand @0.6 |  | M | aldric.reaping_cut |
| ProSwordandShield/sword and shield slash | sword-shield | 1.5 | dz 0 dx 0 | crouch>crouch | RightHand @0.6 |  | M | aldric.slash, aldric.blade_feint |

## block (15)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| HF/hit_reactions/Standing_Block_React_Large_2 | unarmed | 1.333 | · | crouch>crouch |  |  |  |  |
| HF/weapons_extra/Great_Sword_Blocking_2 | 2h-greatsword | 0.967 | · | crouch>crouch |  |  | M |  |
| HF/weapons_extra/Great_Sword_Blocking_3 | 2h-greatsword | 0.5 | · | crouch>stand |  |  | M |  |
| HF/weapons_extra/Great_Sword_Blocking | 2h-greatsword | 0.5 | · | stand>crouch |  |  | M |  |
| ProLongbow/standing block | bow | 2 | · | stand>stand (via crouch) |  |  | M | erika.block |
| ProMagic/Standing Block End | caster | 1.3 | · | crouch>stand |  |  | M |  |
| ProMagic/Standing Block Idle | caster | 2.767 | · | crouch>crouch |  |  | M | ozrel.block, vex.block |
| ProMagic/Standing Block Start | caster | 0.5 | · | stand>crouch |  |  | M |  |
| ProMeleeAxe/standing block idle | 1h-axe | 1.833 | · | crouch>crouch |  |  | M | gorak.block, fenrik.block +2 |
| ProSwordandShield/sword and shield block (2) | sword-shield | 0.667 | dz -0.24 dx 0 | crouch>crouch |  |  | M |  |
| ProSwordandShield/sword and shield block idle | sword-shield | 1.4 | · | crouch>crouch |  |  |  | aldric.block |
| ProSwordandShield/sword and shield block | sword-shield | 0.567 | dz 0.25 dx -0.03 | crouch>crouch |  |  | M |  |
| ProSwordandShield/sword and shield crouch block (2) | sword-shield | 0.8 | · | kneel>kneel |  |  | M |  |
| ProSwordandShield/sword and shield crouch block idle | sword-shield | 0.5 | · | kneel>kneel |  |  |  |  |
| ProSwordandShield/sword and shield crouch block | sword-shield | 0.5 | dz 0.29 dx 0.11 | kneel>kneel |  |  | M |  |

## cast (25)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| HF/spells/Casting_Spell | caster | 7.7 | dz 0 dx 0 | crouch>crouch | RightHand @5.4 |  | M |  |
| HF/spells/Charge | caster | 5.7 | dz 0 dx 0 | stand>stand | RightHand @2.067 |  | M |  |
| HF/spells/Great_Sword_Casting | 2h-greatsword | 4.8 | dz 0 dx 0 | stand>stand (via kneel) | LeftHand @2.233 |  |  |  |
| HF/spells/Magic_Heal | caster | 2.667 | dz 0 dx 0 | stand>stand | RightHand @1.9 |  | M |  |
| HF/spells/Magic_Spell_Casting | caster | 4.267 | dz 0 dx 0 | stand>stand (via crouch) | RightHand @0.9 |  | M |  |
| HF/spells/Spell_Cast | caster | 1.133 | · | stand>stand | LeftHand @0.3 |  | M |  |
| HF/spells/Spell_Casting | caster | 4.2 | dz 0 dx 0 | crouch>crouch | RightFoot @3.333 |  | M |  |
| HF/spells/Two_Hand_Spell_Casting | caster | 3.433 | dz 0 dx 0 | stand>stand (via crouch) | RightHand @1.4 |  | M |  |
| HF/spells/Wide_Arm_Spell_Casting | caster | 3.533 | dz 0 dx 0 | stand>stand (via crouch) | RightHand @1.4 |  | M |  |
| HF/weapons_extra/Great_Sword_Casting | 2h-greatsword | 4.8 | dz 0 dx 0 | stand>stand (via kneel) | LeftHand @2.233 |  |  |  |
| HF/weapons_extra/Great_Sword_Power_Up | 2h-greatsword | 3.5 | · | stand>stand | RightFoot @0.433 |  | M |  |
| ProMagic/standing 1H cast spell 01 | caster | 2.267 | · | stand>stand (via crouch) | RightHand @0.6 |  | M | ozrel.taunt, ozrel.fire_bolt +3 |
| ProMagic/Standing 1H Magic Attack 01 | caster | 2.3 | · | stand>stand (via crouch) | RightHand @0.8 |  | M | ozrel.flame_whip, vex.claw_feint |
| ProMagic/Standing 1H Magic Attack 02 | caster | 2.2 | · | stand>stand (via crouch) | RightHand @0.5 |  | M | ozrel.ember_strike, vex.raking_claw +1 |
| ProMagic/Standing 1H Magic Attack 03 | caster | 2.3 | dz 0 dx 0 | stand>stand (via crouch) | RightHand @0.8 |  | M | ozrel.ember_flurry, vex.blood_lash |
| ProMagic/Standing 2H Cast Spell 01 | caster | 2.167 | · | stand>stand (via crouch) | RightHand @0.633 |  | M | ozrel.roar, ozrel.cinder_ward +1 |
| ProMagic/Standing 2H Magic Area Attack 01 | caster | 2.967 | dz 0 dx 0 | stand>stand (via kneel) | RightHand @1.267 |  |  | ozrel.cinder_nova |
| ProMagic/Standing 2H Magic Area Attack 02 | caster | 3.267 | · | stand>stand (via crouch) | RightHand @1.8 |  | M | ozrel.pyre |
| ProMagic/Standing 2H Magic Attack 01 | caster | 2.7 | dz 0 dx 0 | stand>stand (via crouch) | RightHand @1.133 |  | M | ozrel.flame_lash |
| ProMagic/Standing 2H Magic Attack 02 | caster | 2.633 | dz 0 dx 0 | stand>stand (via crouch) | RightHand @1.3 |  | M |  |
| ProMagic/Standing 2H Magic Attack 03 | caster | 4.3 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @1 |  | M | ozrel.falling_star |
| ProMagic/Standing 2H Magic Attack 04 | caster | 3.333 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @0.933 |  | M |  |
| ProMagic/Standing 2H Magic Attack 05 | caster | 3.533 | dz 0 dx 0 | stand>stand (via kneel) | RightHand @0.6 |  | M | ozrel.ember_barrage |
| ProSwordandShield/sword and shield casting (2) | sword-shield | 1.033 | · | crouch>stand | LeftHand @0.167 |  | M | aldric.ward_pulse |
| ProSwordandShield/sword and shield casting | sword-shield | 2.967 | · | stand>stand (via kneel) | RightHand @1.633 |  | M | aldric.roar |

## combo (20)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| HF/brawler_kicks/Body_Jab_Cross_2 | unarmed | 2.2 | dz 0 dx 0 | stand>stand (via crouch) | RightHand @0.6 |  |  |  |
| HF/brawler_kicks/Body_Jab_Cross_3 | unarmed | 1.367 | · | stand>stand (via crouch) | RightHand @0.533 |  | M |  |
| HF/brawler_kicks/Body_Jab_Cross | unarmed | 2.1 | dz -0.01 dx 0 | stand>stand (via crouch) | RightHand @0.567 |  |  |  |
| HF/brawler_kicks/Combo_Punch | unarmed | 2.967 | · | stand>stand (via crouch) | LeftHand @1.6 |  |  |  |
| HF/brawler_kicks/Elbow_Uppercut_Combo | unarmed | 2.433 | · | stand>stand (via crouch) | RightHand @1.233 |  | M |  |
| HF/brawler_kicks/Flying_Knee_Punch_Combo | unarmed | 2.667 | dz 3.83 dx 0 | stand>stand (via kneel) | RightHand @0.6 |  |  |  |
| HF/brawler_kicks/Jab_Cross_2 | unarmed | 2.233 | dz 0 dx 0 | stand>stand (via crouch) | RightHand @0.567 |  |  |  |
| HF/brawler_kicks/Jab_Cross_3 | unarmed | 2.133 | dz 0 dx 0 | stand>stand (via crouch) | RightHand @0.633 |  |  |  |
| HF/brawler_kicks/Jab_Cross | unarmed | 1.967 | dz 0 dx 0 | stand>stand (via crouch) | RightHand @0.567 |  |  |  |
| HF/brawler_kicks/Knee_Jabs_To_Uppercut | unarmed | 5.667 | dz 0 dx 0 | stand>stand (via crouch) | RightHand @3.5 |  | M |  |
| HF/brawler_kicks/Punch_Combo | unarmed | 2.2 | · | stand>stand (via crouch) | RightHand @0.8 |  | M |  |
| HF/brawler_kicks/Punch_To_Elbow_Combo | unarmed | 5 | dz 1.67 dx 0 | crouch>crouch | RightHand @2.967 |  |  |  |
| HF/brawler_kicks/Quad_Punch | unarmed | 2.167 | · | stand>stand | RightHand @1.1 |  |  |  |
| HF/weapons_extra/Dual_Weapon_Combo | dual | 3.633 | dz 1.99 dx 0 | crouch>crouch | RightHand @1.8 |  |  |  |
| HF/weapons_extra/One_Hand_Club_Combo | 1h-club | 3.633 | dz 1.39 dx 0 | stand>stand (via crouch) | RightHand @2.167 |  | M |  |
| HF/weapons_extra/One_Hand_Sword_Combo | 1h-sword | 4.533 | dz 1.12 dx 0 | crouch>crouch | RightHand @3 |  | M |  |
| HF/weapons_extra/Two_Hand_Sword_Combo | 2h-greatsword | 3.267 | dz 1.81 dx 0 | stand>stand | LeftHand @2.2 |  |  |  |
| ProMeleeAxe/standing melee combo attack ver. 1 | 1h-axe | 4.667 | dz 1.5 dx 0 | crouch>crouch | LeftHand @2.133 |  |  | gorak.reavers_fury, vex.thousand_cuts |
| ProMeleeAxe/standing melee combo attack ver. 2 | 1h-axe | 4.2 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @2.5 |  | M | gorak.headsman, fenrik.savage_string |
| ProMeleeAxe/standing melee combo attack ver. 3 | 1h-axe | 2.733 | dz 0 dx 0 | stand>stand (via crouch) | RightHand @1.033 |  | M | fenrik.feral_frenzy, hollowjack.harvest_combo |

## cover (6)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| ActionAdventure/cover to stand (2) | unarmed | 1.4 | dz -0.98 dx 0 yaw 110 | stand>stand (via crouch) |  |  |  |  |
| ActionAdventure/cover to stand | unarmed | 1.5 | dz -0.97 dx 0.01 yaw 133 | crouch>stand |  |  | M |  |
| ActionAdventure/left cover sneak | unarmed | 1.133 | dz 0 dx -1.26 | stand>stand |  |  |  |  |
| ActionAdventure/right cover sneak | unarmed | 1.133 | dz 0 dx 1.25 | stand>stand |  |  |  |  |
| ActionAdventure/stand to cover (2) | unarmed | 1.267 | dz 1.19 dx -0.01 yaw -132 | stand>crouch (via kneel) |  |  |  |  |
| ActionAdventure/stand to cover | unarmed | 1.133 | dz 1.15 dx -0.01 yaw -110 | stand>stand (via crouch) |  |  |  |  |

## death (32)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| Creature/mutant dying | creature | 4.6 | dz -0.93 dx -0.05 yaw 83 | stand>ground | ends on ground |  |  | fenrik.death, maw.death |
| HF/deaths/Death_From_Back_Headshot | unarmed | 3.7 | dz 0.95 dx -0.06 yaw 152 | stand>ground | ends on ground |  |  |  |
| HF/deaths/Death_From_Front_Headshot | unarmed | 2.833 | dz -0.25 dx -0.29 yaw -38 | stand>ground | ends on ground |  | M |  |
| HF/deaths/Death_From_Right | unarmed | 3.3 | dz -0.11 dx 0.85 yaw 70 | stand>ground | ends on ground |  |  |  |
| HF/deaths/Death_From_The_Back | unarmed | 2.967 | dz 1.1 dx 0.25 | stand>ground | ends on ground |  | M |  |
| HF/deaths/Death_From_The_Front | unarmed | 3.433 | dz 1.02 dx 0.26 yaw -26 | stand>ground | ends on ground |  |  |  |
| HF/deaths/Dying_Backwards | unarmed | 4.6 | dz -0.92 dx -0.06 yaw 84 | stand>ground | ends on ground |  |  |  |
| HF/deaths/Falling_Back_Death_2 | unarmed | 2.2 | dz -0.6 dx -0.17 yaw 166 | crouch>ground | ends on ground |  | M |  |
| HF/deaths/Falling_Back_Death | unarmed | 2.6 | dz -0.91 dx -0.27 yaw 491 | stand>ground | ends on ground |  |  |  |
| HF/deaths/Falling_Forward_Death | unarmed | 2.567 | dz 0.85 dx -0.15 yaw -62 | stand>ground | ends on ground |  |  |  |
| HF/deaths/Flying_Back_Death | unarmed | 3.033 | dz -1.37 dx -0.04 yaw 165 | crouch>ground | ends on ground |  |  |  |
| HF/deaths/Prone_Death | unarmed | 1.867 | · | ground>ground | ends on ground |  | M |  |
| HF/deaths/Standing_Death_Backward_01_2 | unarmed | 3.1 | dz -1.06 dx 0.19 | stand>ground | ends on ground |  |  |  |
| HF/deaths/Standing_Death_Forward_02 | unarmed | 2.367 | dz 1.33 dx -0.22 yaw -125 | stand>ground | ends on ground |  |  |  |
| HF/deaths/Standing_Death_Left_01 | unarmed | 2.267 | dz -0.05 dx 1.11 yaw 58 | stand>ground | ends on ground |  | M |  |
| HF/deaths/Standing_Death_Left_02 | unarmed | 2.267 | dz -0.03 dx 0.87 yaw -118 | stand>ground | ends on ground |  | M |  |
| HF/deaths/Standing_Death_Right_01 | unarmed | 2 | dz 0 dx -1.1 yaw 57 | stand>ground | ends on ground |  |  |  |
| HF/deaths/Standing_Death_Right_02 | unarmed | 2.333 | dz -0.08 dx -1.41 yaw -513 | stand>ground | ends on ground |  |  |  |
| HF/deaths/Two_Handed_Sword_Death_2 | 2h-greatsword | 2.6 | dz 1.24 dx -0.07 yaw -102 | stand>ground | ends on ground |  | M |  |
| HF/deaths/Two_Handed_Sword_Death | 2h-greatsword | 2.4 | dz -0.82 dx -0.01 yaw 132 | stand>ground | ends on ground |  | M |  |
| HF/deaths/Zombie_Death | zombie | 2.967 | dz -0.99 dx -0.14 yaw -113 | stand>ground | ends on ground |  |  |  |
| HF/deaths/Zombie_Dying | zombie | 3.333 | dz 1.19 dx -0.17 yaw 142 | stand>ground | ends on ground |  |  |  |
| HF/weapons_extra/Two_Handed_Sword_Death_2 | 2h-greatsword | 2.6 | dz 1.24 dx -0.07 yaw -102 | stand>ground | ends on ground |  | M |  |
| HF/weapons_extra/Two_Handed_Sword_Death | 2h-greatsword | 2.4 | dz -0.82 dx -0.01 yaw 132 | stand>ground | ends on ground |  | M |  |
| ProLongbow/standing death backward 01 | bow | 3.1 | dz -1.06 dx 0.19 | stand>ground | ends on ground |  |  | erika.death |
| ProLongbow/standing death forward 01 | bow | 3.167 | dz 1.28 dx -0.2 yaw 107 | stand>ground | ends on ground |  |  |  |
| ProMagic/Standing React Death Backward | caster | 3.633 | dz -0.85 dx -0.13 | stand>ground | ends on ground |  | M | ozrel.death |
| ProMagic/Standing React Death Forward | caster | 3.667 | dz 1.32 dx -0.08 yaw 215 | stand>ground | ends on ground |  |  |  |
| ProMagic/Standing React Death Left | caster | 3.6 | dz -0.13 dx 0.92 yaw 44 | stand>ground | ends on ground |  |  | vex.death |
| ProMagic/Standing React Death Right | caster | 3.5 | dz 0.24 dx -1.32 yaw 187 | stand>ground | ends on ground |  |  |  |
| ProSwordandShield/sword and shield death (2) | sword-shield | 3.9 | dz 0.98 dx -0.26 yaw 161 | stand>ground | ends on ground |  |  | hollowjack.death |
| ProSwordandShield/sword and shield death | sword-shield | 2.3 | dz -1.2 dx 0.03 yaw -64 | crouch>ground | ends on ground |  |  | gorak.death, aldric.death |

## dodge (38)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| HF/dodges/Aerial_Evade | unarmed | 3.667 | dz -1.1 dx -2.35 yaw 986 | stand>stand (via crouch) |  |  |  |  |
| HF/dodges/Backflip_2 | unarmed | 2.167 | dz 0 dx 0 yaw 360 | stand>stand (via crouch) |  |  |  |  |
| HF/dodges/Backflip | unarmed | 4.1 | dz -0.62 dx 0.01 | stand>stand (via crouch) |  |  |  |  |
| HF/dodges/Corkscrew_Evade | unarmed | 2.5 | dz -1.58 dx -2.25 yaw 302 | crouch>stand (via ground) |  |  |  |  |
| HF/dodges/Dive_Roll_2 | unarmed | 3.933 | dz 3.54 dx 0 yaw -359 | stand>stand (via ground) |  |  |  |  |
| HF/dodges/Dive_Roll | unarmed | 2.367 | dz 3.59 dx 0 yaw -360 | stand>stand (via ground) |  |  |  |  |
| HF/dodges/Dodging_2 | unarmed | 2.333 | dz 0.87 dx 0 | stand>stand (via crouch) |  |  |  |  |
| HF/dodges/Dodging_3 | unarmed | 2.233 | dz -0.49 dx 0 | crouch>crouch |  |  |  |  |
| HF/dodges/Dodging_Back | unarmed | 2.667 | dz -2.24 dx 0 | stand>stand (via crouch) |  |  |  |  |
| HF/dodges/Ducking_2 | unarmed | 1.533 | dz -0.38 dx 0.11 yaw -36 | stand>crouch |  |  | M |  |
| HF/dodges/Ducking | unarmed | 1.467 | · | kneel>kneel |  |  |  |  |
| HF/dodges/Esquiva_1 | unarmed | 4.6 | dz 0 dx 0 yaw -357 | crouch>crouch (via kneel) |  |  |  |  |
| HF/dodges/Evading_A_Threat | unarmed | 3.7 | dz 2.1 dx -4.14 yaw 87 | stand>stand (via kneel) |  |  |  |  |
| HF/dodges/Front_Flip | unarmed | 1.667 | dz 6.18 dx 0 yaw -341 | stand>crouch |  |  |  |  |
| HF/dodges/Jump_Backward_2 | unarmed | 0.9 | dz -1.66 dx 0 | stand>stand |  |  |  |  |
| HF/dodges/Jump_Backward | unarmed | 0.867 | dz -2.05 dx 0 | stand>stand |  |  |  |  |
| HF/dodges/Long_Left_Side_Step | unarmed | 0.8 | dz 0 dx 0.52 | stand>stand (via crouch) |  |  |  |  |
| HF/dodges/Long_Right_Side_Step | unarmed | 0.833 | dz -0.01 dx -0.67 | stand>stand (via crouch) |  |  |  |  |
| HF/dodges/Macaco_Side | unarmed | 3.3 | dz -0.45 dx 1.04 | crouch>crouch (via kneel) |  |  |  |  |
| HF/dodges/Medium_Left_Side_Step | unarmed | 0.833 | dz 0 dx 0.36 | stand>stand (via crouch) |  |  |  |  |
| HF/dodges/Medium_Right_Side_Step | unarmed | 0.833 | dz -0.01 dx -0.44 | stand>stand (via crouch) |  |  |  |  |
| HF/dodges/Queshada_1 | unarmed | 2.6 | dz 1.28 dx 1.25 yaw -47 | crouch>crouch |  |  | M |  |
| HF/dodges/Queshada_2 | unarmed | 2 | dz 0.77 dx -0.92 | crouch>crouch |  |  | M |  |
| HF/dodges/Quick_Roll_To_Run | unarmed | 1.4 | dz 5.46 dx -0.03 yaw -356 | crouch>stand (via ground) |  |  |  |  |
| HF/dodges/Roll_Left_2 | unarmed | 1.5 | dz 0.01 dx 1.14 | ground>ground |  |  |  |  |
| HF/dodges/Roll_Left | unarmed | 2.5 | dz 0 dx 1.22 | ground>ground |  |  |  |  |
| HF/dodges/Run_To_Flip | unarmed | 2.233 | dz 0.28 dx 0.06 yaw 307 | stand>stand (via crouch) |  |  |  |  |
| HF/dodges/Short_Left_Side_Step | unarmed | 0.8 | dz 0 dx 0.21 | stand>stand (via crouch) |  |  |  |  |
| HF/dodges/Short_Right_Side_Step | unarmed | 0.867 | dz 0 dx -0.26 | stand>stand (via crouch) |  |  |  |  |
| HF/dodges/Side_Step | unarmed | 1.467 | dz 0.04 dx -0.81 | crouch>crouch |  |  |  |  |
| HF/dodges/Sprinting_Forward_Roll | unarmed | 1.167 | dz 5.44 dx -0.02 yaw -352 | stand>crouch (via ground) |  |  |  |  |
| HF/dodges/Stand_To_Roll | unarmed | 2.367 | dz 4.34 dx 0 | stand>stand (via ground) |  |  |  |  |
| HF/dodges/Stylish_Flip | unarmed | 2.133 | dz 4.75 dx -0.11 yaw -332 | stand>kneel |  |  |  |  |
| ProLongbow/standing dive forward | bow | 1.633 | dz 3.47 dx 0 | stand>stand (via ground) |  |  |  |  |
| ProLongbow/standing dodge backward | bow | 1.633 | dz -2.1 dx 0 | stand>stand (via crouch) |  |  |  | gorak.dodgeBack, aldric.dodgeBack +6 |
| ProLongbow/standing dodge forward | bow | 1 | dz 2.07 dx 0 | stand>stand (via crouch) |  |  |  |  |
| ProLongbow/standing dodge left | bow | 0.967 | dz 0 dx 1.79 | stand>stand |  |  |  | gorak.dodgeLeft, aldric.dodgeLeft +6 |
| ProLongbow/standing dodge right | bow | 0.967 | dz 0 dx -1.84 | stand>stand (via crouch) |  |  |  | gorak.dodgeRight, aldric.dodgeRight +6 |

## emote (24)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| Creature/mutant flexing muscles | creature | 4.667 | · | stand>stand (via crouch) |  |  | M | fenrik.taunt, maw.taunt |
| Creature/mutant roaring | creature | 5.4 | dz 0 dx 0 | stand>stand (via crouch) |  |  | M | fenrik.roar, fenrik.howl +3 |
| HF/spells/Great_Sword_Power_Up | 2h-greatsword | 3.5 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Angry_Point | unarmed | 2.433 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Laughing | unarmed | 9.767 | dz 0 dx 0 | stand>stand |  |  |  |  |
| HF/talk_gesture/Roar | unarmed | 5.4 | dz 0 dx 0 | stand>stand (via crouch) |  |  | M |  |
| HF/talk_gesture/Salute | unarmed | 2.833 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Standing_Yell_2 | unarmed | 4.067 | dz 0 dx 0 | crouch>crouch |  |  |  |  |
| HF/talk_gesture/Standing_Yell_3 | unarmed | 5.567 | dz 0 dx 0 | crouch>crouch |  |  |  |  |
| HF/talk_gesture/Standing_Yell_4 | unarmed | 4.067 | dz 0 dx 0 | crouch>crouch |  |  |  |  |
| HF/talk_gesture/Standing_Yell | unarmed | 5.967 | dz 0 dx 0 | crouch>crouch |  |  |  |  |
| HF/talk_gesture/Taunt_2 | unarmed | 3.233 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Taunt_3 | unarmed | 1.633 | · | stand>crouch |  |  | M |  |
| HF/talk_gesture/Taunt_4 | unarmed | 5.167 | dz 0 dx 0 | stand>stand |  |  | M |  |
| HF/talk_gesture/Taunt_5 | unarmed | 3.867 | dz 0 dx 0 | stand>stand (via crouch) |  |  | M |  |
| HF/talk_gesture/Taunt | unarmed | 2.833 | · | stand>stand |  |  |  |  |
| HF/talk_gesture/Threatening | unarmed | 4.4 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Yelling_Out | unarmed | 4.3 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Yelling_While_Standing_2 | unarmed | 4.033 | dz 0 dx 0 | crouch>crouch |  |  |  |  |
| HF/talk_gesture/Yelling_While_Standing | unarmed | 5.5 | dz 0 dx 0 | crouch>crouch |  |  |  |  |
| HF/talk_gesture/Yelling | unarmed | 7.833 | · | stand>stand |  |  |  |  |
| ProMeleeAxe/standing taunt battlecry | 1h-axe | 2.833 | · | crouch>crouch |  |  | M | gorak.roar |
| ProMeleeAxe/standing taunt chest thump | 1h-axe | 2.833 | · | crouch>stand |  |  | M | gorak.taunt, hollowjack.taunt |
| ProSwordandShield/sword and shield power up | sword-shield | 2.367 | · | crouch>crouch |  |  | M | aldric.taunt |

## equip (12)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| ProLongbow/standing aim overdraw | bow | 3.767 | · | stand>stand |  |  | M | erika.pinning_shot |
| ProLongbow/standing disarm bow | bow | 1.1 | · | stand>stand |  |  | M |  |
| ProLongbow/standing draw arrow | bow | 1.033 | · | stand>stand |  |  | M | erika.roar, erika.quick_draw +1 |
| ProLongbow/standing equip bow | bow | 0.9 | · | stand>stand |  |  | M |  |
| ProMeleeAxe/standing disarm over shoulder | 1h-axe | 1.667 | dz 0.2 dx 0 yaw 38 | crouch>stand |  |  | M |  |
| ProMeleeAxe/standing disarm underarm | 1h-axe | 1.7 | · | crouch>stand |  |  | M |  |
| ProMeleeAxe/unarmed equip over shoulder | unarmed | 1.667 | dz -0.2 dx 0 yaw -38 | stand>crouch |  |  | M |  |
| ProMeleeAxe/unarmed equip underarm | unarmed | 1.233 | · | stand>crouch |  |  | M |  |
| ProSwordandShield/draw sword 1 | sword-shield | 0.5 | · | stand>stand |  |  | M |  |
| ProSwordandShield/draw sword 2 | sword-shield | 0.767 | · | stand>crouch |  |  | M |  |
| ProSwordandShield/sheath sword 1 | sword-shield | 1.267 | · | crouch>stand |  |  | M |  |
| ProSwordandShield/sheath sword 2 | sword-shield | 0.833 | · | stand>stand |  |  | M |  |

## finisher (18)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| HF/finishers/Bayonet_Stab | dagger/blade | 3.267 | dz 0 dx 0 | crouch>crouch | RightHand @0.4 |  | M |  |
| HF/finishers/Brutal_Assassination_2 ⇄ aggressor | unarmed | 4.933 | dz 1.4 dx 0.09 | stand>stand (via crouch) | RightHand @2.767 |  | M |  |
| HF/finishers/Brutal_Assassination ⇄ victim | unarmed | 4.933 | dz 0.17 dx 0.6 yaw 108 | stand>ground | RightFoot @3.233 |  |  |  |
| HF/finishers/Double_Dagger_Stab | dual | 3.067 | dz 0 dx 0 | crouch>crouch | RightHand @1.133 |  | M |  |
| HF/finishers/Hell_Slammer_A ⇄ aggressor | unarmed | 7.567 | dz 0.28 dx -1.5 yaw -371 | stand>stand (via crouch) | LeftHand @3.467 |  |  |  |
| HF/finishers/Hell_Slammer_B ⇄ victim | unarmed | 7.567 | dz 0.18 dx -1.17 yaw 128 | stand>ground | LeftFoot @5.9 |  |  |  |
| HF/finishers/Kick_To_The_Groin_2 ⇄ victim | unarmed | 3.267 | · | stand>stand (via crouch) | LeftHand @0.267 |  |  |  |
| HF/finishers/Knock_Off_Assailant | unarmed | 2.767 | · | kneel>kneel | RightHand @0.8 |  | M |  |
| HF/finishers/Rockin_Shackle_A ⇄ aggressor | unarmed | 5 | dz 0.62 dx 0.21 | stand>stand (via crouch) | LeftFoot @2.367 |  |  |  |
| HF/finishers/Rockin_Shackle_B ⇄ victim | unarmed | 5 | dz 1.17 dx 0.35 yaw 192 | stand>ground | LeftHand @1.433 |  | M |  |
| HF/finishers/Stabbing_2 | dagger/blade | 2.133 | · | stand>stand (via crouch) | RightHand @1.1 |  | M |  |
| HF/finishers/Stabbing_3 | dagger/blade | 2.633 | dz 0 dx 0 | stand>stand | RightHand @1.667 |  | M |  |
| HF/finishers/Stabbing | dagger/blade | 2.367 | · | stand>stand (via crouch) | LeftHand @0.633 |  | M |  |
| HF/finishers/Stealth_Assassination_2 ⇄ aggressor | unarmed | 7 | dz 1.42 dx 0.03 | stand>stand (via crouch) | RightHand @4.5 |  |  |  |
| HF/finishers/Stealth_Assassination ⇄ victim | unarmed | 7 | dz 1.35 dx 0.12 yaw 182 | stand>ground | LeftHand @4.433 |  |  |  |
| HF/finishers/Stomp | unarmed | 1.867 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @0.767 |  | M |  |
| HF/finishers/Stomping | unarmed | 1.8 | · | stand>stand (via crouch) | RightFoot @0.633 |  | M |  |
| HF/finishers/Zombie_Neck_Bite | zombie | 4.167 | dz 0 dx 0 | stand>stand (via crouch) | LeftHand @3.433 |  |  |  |

## getup (10)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| HF/hit_reactions/Getting_Up_2 | unarmed | 7.6 | dz -0.66 dx 0.01 yaw 111 | ground>stand |  |  |  |  |
| HF/hit_reactions/Getting_Up_3 | unarmed | 8.333 | dz 0.71 dx 0.04 yaw 80 | ground>stand |  |  |  |  |
| HF/hit_reactions/Getting_Up_4 | unarmed | 8.6 | dz -0.29 dx 0.09 yaw -61 | ground>stand |  |  | M |  |
| HF/hit_reactions/Getting_Up | unarmed | 2.7 | · | ground>stand |  |  |  |  |
| HF/hit_reactions/Stand_Up_2 | unarmed | 8.267 | dz 0.81 dx 0.02 yaw -105 | ground>stand |  |  |  |  |
| HF/hit_reactions/Stand_Up_3 | unarmed | 2.333 | dz -0.37 dx 0.08 | ground>stand |  |  |  |  |
| HF/hit_reactions/Stand_Up | unarmed | 4.833 | dz 0.41 dx -0.03 | crouch>stand |  |  | M |  |
| HF/hit_reactions/Zombie_Stand_Up_2 | zombie | 5.8 | dz 0.18 dx -0.09 yaw -122 | ground>crouch |  |  |  |  |
| HF/hit_reactions/Zombie_Stand_Up_3 | zombie | 6 | dz -1.17 dx 0.2 yaw 97 | ground>crouch |  |  |  |  |
| HF/hit_reactions/Zombie_Stand_Up | zombie | 3.1 | dz 0.05 dx 0.09 yaw 70 | ground>crouch |  |  |  |  |

## grapple (14)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| HF/grabs_throws/Defender | unarmed | 3.6 | dz 1.04 dx 8.07 yaw -29 | stand>ground | RightFoot @1.433 |  |  |  |
| HF/grabs_throws/Double_Leg_Takedown_-_Attacker_2 ⇄ aggressor | unarmed | 3.5 | dz 0.81 dx -0.17 | stand>stand (via kneel) | LeftHand @1.3 |  |  |  |
| HF/grabs_throws/Double_Leg_Takedown_-_Attacker ⇄ aggressor | unarmed | 7.233 | dz 2.78 dx -0.35 yaw 53 | stand>kneel | RightHand @1.7 |  |  |  |
| HF/grabs_throws/Flying_Shoulder_Throw ⇄ aggressor | unarmed | 3.7 | dz 6.35 dx -0.01 yaw -384 | stand>crouch (via kneel) | LeftFoot @0.667 |  |  |  |
| HF/grabs_throws/Getting_Thrown ⇄ victim | unarmed | 4.333 | dz 2.72 dx 2.1 | stand>crouch (via ground) | RightHand @2.3 |  |  |  |
| HF/grabs_throws/Grab_And_Slam | unarmed | 4.267 | dz 0.21 dx 0.01 yaw 128 | stand>kneel | RightHand @3.467 |  |  |  |
| HF/grabs_throws/Headbutt | unarmed | 2.1 | dz -0.01 dx 0 | stand>stand (via crouch) | LeftFoot @1.267 |  | M |  |
| HF/grabs_throws/Illegal_Headbutt | unarmed | 2.233 | dz 0 dx 0 | stand>stand (via crouch) | LeftFoot @1.467 |  | M |  |
| HF/grabs_throws/Shoulder_Throw_Aggressor ⇄ aggressor | unarmed | 6.667 | dz -0.48 dx -4.23 yaw 361 | stand>stand (via crouch) | RightFoot @4.167 |  | M |  |
| HF/grabs_throws/Shoulder_Throw_Victim ⇄ victim | unarmed | 6.667 | dz 0.61 dx 1 yaw 151 | stand>ground | RightFoot @3.4 |  |  |  |
| HF/grabs_throws/Soccer_Tackle | unarmed | 2.733 | dz 3.79 dx 0.74 yaw 353 | stand>stand (via ground) | RightFoot @0.633 |  |  |  |
| HF/grabs_throws/Soccer_Trip | unarmed | 1.6 | dz 3.91 dx -1.15 yaw -74 | stand>ground | LeftHand @0.433 |  |  |  |
| HF/grabs_throws/Superhuman_Choke_Lift | unarmed | 6.367 | dz 0 dx 0 | stand>stand | RightHand @3.967 |  | M |  |
| HF/grabs_throws/Zombie_Headbutt | zombie | 2.6 | · | stand>stand (via crouch) | LeftHand @1.333 |  |  |  |

## hit-react (83)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| HF/hit_reactions/Big_Hit_To_Head_2 | unarmed | 1.567 | · | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Big_Hit_To_Head_3 | unarmed | 1.3 | · | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Big_Hit_To_Head | unarmed | 1.633 | dz 0 dx 0 | stand>stand (via crouch) |  |  | M |  |
| HF/hit_reactions/Big_Kidney_Hit | unarmed | 1.6 | · | stand>stand (via crouch) |  |  | M |  |
| HF/hit_reactions/Big_Rib_Hit | unarmed | 1.6 | dz 0 dx 0 | stand>stand (via crouch) |  |  | M |  |
| HF/hit_reactions/Big_Side_Hit | unarmed | 1.467 | · | stand>stand (via crouch) |  |  | M |  |
| HF/hit_reactions/Big_Stomach_Hit | unarmed | 1.4 | · | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Getting_Hit_Backwards | unarmed | 2.667 | dz -1.56 dx -0.02 | stand>crouch (via ground) |  |  |  |  |
| HF/hit_reactions/Getting_Hit | unarmed | 4.6 | · | stand>stand |  |  |  |  |
| HF/hit_reactions/Great_Sword_Impact_2 | 2h-greatsword | 0.867 | · | crouch>crouch |  |  |  |  |
| HF/hit_reactions/Great_Sword_Impact_3 | 2h-greatsword | 1.267 | · | stand>stand |  |  |  |  |
| HF/hit_reactions/Great_Sword_Impact_4 | 2h-greatsword | 0.667 | · | kneel>kneel |  |  |  |  |
| HF/hit_reactions/Great_Sword_Impact_5 | 2h-greatsword | 1.2 | · | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Great_Sword_Impact | 2h-greatsword | 0.967 | · | kneel>kneel |  |  |  |  |
| HF/hit_reactions/Head_Hit_2 | unarmed | 1.433 | · | stand>stand (via crouch) |  |  | M |  |
| HF/hit_reactions/Head_Hit_3 | unarmed | 1.167 | · | stand>stand |  |  |  |  |
| HF/hit_reactions/Head_Hit_4 | unarmed | 1.067 | · | stand>stand |  |  | M |  |
| HF/hit_reactions/Head_Hit_5 | unarmed | 1.067 | · | stand>stand |  |  |  |  |
| HF/hit_reactions/Head_Hit | unarmed | 0.933 | · | stand>stand |  |  |  |  |
| HF/hit_reactions/Hit_On_Back_Of_Head | unarmed | 3.667 | dz 3.78 dx 0.08 | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Hit_On_Side_Of_Body_2 | unarmed | 2.467 | dz 5.12 dx -0.12 | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Hit_On_Side_Of_Body | unarmed | 2.767 | dz 4.73 dx 1.06 | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Hit_On_Side_Of_Head_2 | unarmed | 3.267 | dz 5.69 dx -0.94 | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Hit_On_Side_Of_Head | unarmed | 3.3 | dz 3.94 dx 1.85 | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Hit_On_The_Back | unarmed | 2.5 | dz 4.29 dx -0.16 | stand>stand |  |  |  |  |
| HF/hit_reactions/Hit_Reaction_2 | unarmed | 2.3 | · | stand>stand (via crouch) |  |  | M |  |
| HF/hit_reactions/Hit_Reaction_3 | unarmed | 2.6 | · | stand>stand |  |  |  |  |
| HF/hit_reactions/Hit_Reaction_4 | unarmed | 0.433 | · | stand>stand |  |  | M |  |
| HF/hit_reactions/Hit_Reaction_5 | unarmed | 2.433 | · | stand>stand (via crouch) |  |  | M |  |
| HF/hit_reactions/Hit_Reaction_6 | unarmed | 1.6 | · | stand>stand (via crouch) |  |  | M |  |
| HF/hit_reactions/Hit_Reaction_7 | unarmed | 3.1 | dz 0 dx 0 | stand>stand (via crouch) |  |  | M |  |
| HF/hit_reactions/Hit_Reaction_8 | unarmed | 0.6 | dz 2.57 dx 0 | crouch>crouch |  |  |  |  |
| HF/hit_reactions/Hit_Reaction_9 | unarmed | 1.833 | · | kneel>kneel |  |  | M |  |
| HF/hit_reactions/Hit_Reaction | unarmed | 2.733 | · | stand>stand (via crouch) |  |  | M |  |
| HF/hit_reactions/Hit_To_Body_2 | unarmed | 1.5 | · | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Hit_To_Body_3 | unarmed | 1.333 | · | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Hit_To_Body_4 | unarmed | 1.2 | · | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Hit_To_Body_5 | unarmed | 1.333 | · | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Hit_To_Body | unarmed | 1.167 | · | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Receive_Punch_To_The_Face | unarmed | 1.3 | · | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Receive_Soccerball | unarmed | 5.133 | dz 2.73 dx -0.08 | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Receive_Stomach_Uppercut | unarmed | 1.5 | · | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Receive_Uppercut_To_The_Face | unarmed | 1.233 | · | stand>stand |  |  | M |  |
| HF/hit_reactions/Receive | unarmed | 1.4 | · | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Receiving_A_Big_Uppercut | unarmed | 2.433 | dz -1.45 dx 0 | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Receiving_An_Uppercut | unarmed | 1.667 | dz -1.08 dx 0 | stand>crouch |  |  |  |  |
| HF/hit_reactions/Shove_Reaction_2 | unarmed | 3 | · | stand>stand |  |  | M |  |
| HF/hit_reactions/Shove_Reaction | unarmed | 2.433 | dz 2.66 dx 0 | stand>stand |  |  |  |  |
| HF/hit_reactions/Standing_React_Large_From_Back_2 | unarmed | 1 | dz 1.27 dx 0 | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Standing_React_Large_From_Front_2 | unarmed | 1.367 | dz -1.08 dx 0 | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Standing_React_Large_From_Left_2 | unarmed | 1 | dz 0 dx -0.86 | stand>stand (via crouch) |  |  |  |  |
| HF/hit_reactions/Standing_React_Large_From_Left_3 | unarmed | 1.033 | · | crouch>crouch |  |  | M |  |
| HF/hit_reactions/Standing_React_Large_From_Right_2 | unarmed | 1.767 | · | crouch>crouch |  |  | M |  |
| HF/hit_reactions/Standing_React_Large_From_Right_3 | unarmed | 1.633 | dz 0 dx 1.08 | stand>stand |  |  |  |  |
| HF/hit_reactions/Standing_React_Small_From_Back_2 | unarmed | 1.267 | · | stand>stand |  |  | M |  |
| HF/hit_reactions/Standing_React_Small_From_Front_02 | unarmed | 0.767 | · | stand>stand |  |  | M |  |
| HF/hit_reactions/Standing_React_Small_From_Front_2 | unarmed | 1.267 | · | stand>stand |  |  |  |  |
| HF/hit_reactions/Standing_React_Small_From_Left_2 | unarmed | 1.2 | · | stand>stand |  |  | M |  |
| HF/hit_reactions/Standing_React_Small_From_Right_2 | unarmed | 1 | · | stand>stand |  |  | M |  |
| HF/hit_reactions/Walking_Hit_Reaction | unarmed | 1.367 | dz 1.27 dx -0.01 | stand>stand |  |  |  |  |
| HF/hit_reactions/Zombie_Reaction_Hit_2 | zombie | 2.167 | dz -0.71 dx 0.06 | stand>stand |  |  |  |  |
| HF/hit_reactions/Zombie_Reaction_Hit | zombie | 2 | · | stand>stand |  |  |  |  |
| HF/weapons_extra/Great_Sword_Impact_2 | 2h-greatsword | 0.867 | · | crouch>crouch |  |  |  |  |
| HF/weapons_extra/Great_Sword_Impact_3 | 2h-greatsword | 1.267 | · | stand>stand |  |  |  |  |
| HF/weapons_extra/Great_Sword_Impact_4 | 2h-greatsword | 0.667 | · | kneel>kneel |  |  |  |  |
| HF/weapons_extra/Great_Sword_Impact_5 | 2h-greatsword | 1.2 | · | stand>stand (via crouch) |  |  |  |  |
| HF/weapons_extra/Great_Sword_Impact | 2h-greatsword | 0.967 | · | kneel>kneel |  |  |  |  |
| ProLongbow/standing react small from front | bow | 1.267 | · | stand>stand |  |  |  | erika.blockHit, erika.hitFront +1 |
| ProLongbow/standing react small from headshot | bow | 0.967 | · | stand>stand |  |  |  | erika.hitLeft, erika.hitBack |
| ProMagic/Standing React Large From Back | caster | 1.667 | dz 1.56 dx 0 | stand>stand (via crouch) |  |  |  |  |
| ProMagic/Standing React Large From Front | caster | 1.367 | dz -1.08 dx 0 | stand>stand (via crouch) |  |  |  |  |
| ProMagic/Standing React Large From Left | caster | 1.567 | dz 0 dx -1.21 | stand>stand (via crouch) |  |  |  |  |
| ProMagic/Standing React Large From Right | caster | 1.633 | dz 0 dx 1.08 | stand>stand |  |  |  |  |
| ProMagic/Standing React Small From Back | caster | 1.267 | · | stand>stand |  |  | M | ozrel.hitBack, vex.hitBack |
| ProMagic/Standing React Small From Front | caster | 1.2 | · | stand>stand |  |  | M | ozrel.hitFront, vex.hitFront |
| ProMagic/Standing React Small From Left | caster | 1.2 | · | stand>stand |  |  | M | ozrel.hitLeft, vex.hitLeft |
| ProMagic/Standing React Small From Right | caster | 1 | · | stand>stand |  |  | M | ozrel.hitRight, vex.hitRight |
| ProMeleeAxe/standing react large from left | 1h-axe | 1.033 | · | crouch>crouch |  |  | M | gorak.hitLeft, fenrik.hitLeft +2 |
| ProMeleeAxe/standing react large from right | 1h-axe | 1.767 | · | crouch>crouch |  |  | M | gorak.hitRight, fenrik.hitRight +2 |
| ProMeleeAxe/standing react large gut | 1h-axe | 1.6 | · | crouch>crouch |  |  |  | gorak.hitFront, gorak.hitBack +6 |
| ProSwordandShield/sword and shield impact (2) | sword-shield | 0.967 | · | crouch>crouch |  |  | M | aldric.hitLeft |
| ProSwordandShield/sword and shield impact (3) | sword-shield | 0.7 | · | crouch>crouch |  |  | M | aldric.blockHit, aldric.hitRight |
| ProSwordandShield/sword and shield impact | sword-shield | 0.767 | · | crouch>crouch |  |  | M | aldric.hitFront, aldric.hitBack |

## idle (36)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| ActionAdventure/idle (2) | unarmed | 10 | · | stand>stand |  | L |  |  |
| ActionAdventure/idle (3) | unarmed | 3.267 | · | stand>stand |  | L | M |  |
| ActionAdventure/idle (4) | unarmed | 2.567 | · | crouch>crouch |  | L |  |  |
| ActionAdventure/idle (5) | unarmed | 2.267 | · | stand>stand |  | L |  |  |
| ActionAdventure/idle | unarmed | 4 | · | stand>stand |  | L | M |  |
| Creature/mutant breathing idle | creature | 4.033 | · | stand>stand |  | L | M | fenrik.winded, maw.idle +2 |
| Creature/mutant idle (2) | creature | 5.3 | · | stand>stand |  | L |  | fenrik.idle |
| Creature/mutant idle | creature | 14.233 | · | stand>stand |  | L | M |  |
| HF/brawler_kicks/Mma_Idle | unarmed | 5 | · | stand>stand |  | L | M |  |
| HF/weapons_extra/2hand_Idle | 2h-greatsword | 4.767 | · | stand>stand |  | L | M |  |
| HF/weapons_extra/Great_Sword_Idle_2 | 2h-greatsword | 3.767 | · | stand>stand |  | L |  |  |
| HF/weapons_extra/Great_Sword_Idle_3 | 2h-greatsword | 3.667 | · | stand>stand |  | L |  |  |
| HF/weapons_extra/Great_Sword_Idle_4 | 2h-greatsword | 3.7 | · | stand>stand |  | L |  |  |
| HF/weapons_extra/Great_Sword_Idle_5 | 2h-greatsword | 7.567 | dz 0 dx 0 | stand>stand |  | L |  |  |
| HF/weapons_extra/Great_Sword_Idle | 2h-greatsword | 2 | · | stand>stand |  | L |  |  |
| ProLongbow/standing idle 01 | bow | 5.1 | · | stand>stand |  | L |  | erika.idle |
| ProLongbow/standing idle 02 looking | bow | 3.2 | · | stand>stand |  | L |  |  |
| ProLongbow/standing idle 03 examine | bow | 5.1 | · | stand>stand |  | L | M | erika.taunt |
| ProLongbow/unarmed idle 01 | bow | 5.1 | · | stand>stand |  | L |  |  |
| ProMagic/Crouch Idle | caster | 1.367 | · | kneel>kneel |  | L | M | ozrel.crouch, ozrel.winded +4 |
| ProMagic/standing idle 02 | caster | 5.2 | · | stand>stand |  | L |  |  |
| ProMagic/Standing Idle 03 | caster | 11.4 | dz 0 dx 0 | stand>stand |  | L | M |  |
| ProMagic/Standing Idle 04 | caster | 7.467 | dz 0 dx 0 | stand>stand (via crouch) |  | L | M |  |
| ProMagic/standing idle | caster | 1.867 | · | stand>stand (via crouch) |  | L | M | ozrel.idle, vex.idle |
| ProMeleeAxe/crouch idle | 1h-axe | 1.667 | · | crouch>crouch |  | L |  | gorak.crouch, gorak.winded +3 |
| ProMeleeAxe/standing idle looking ver. 1 | 1h-axe | 11.267 | dz 0 dx 0 | crouch>crouch |  | L |  |  |
| ProMeleeAxe/standing idle looking ver. 2 | 1h-axe | 7.833 | · | crouch>crouch |  | L |  |  |
| ProMeleeAxe/standing idle | 1h-axe | 1.833 | · | crouch>crouch |  | L | M | gorak.idle |
| ProMeleeAxe/unarmed idle looking ver. 1 | unarmed | 11.267 | dz 0 dx 0 | stand>stand |  | L |  |  |
| ProMeleeAxe/unarmed idle looking ver. 2 | unarmed | 7.833 | · | stand>stand |  | L |  |  |
| ProMeleeAxe/unarmed idle | unarmed | 1.9 | · | stand>stand |  | L |  | hollowjack.idle |
| ProSwordandShield/sword and shield crouch idle | sword-shield | 2.433 | · | kneel>kneel |  | L |  | aldric.crouch, aldric.winded |
| ProSwordandShield/sword and shield idle (2) | sword-shield | 7.533 | · | crouch>crouch |  | L | M |  |
| ProSwordandShield/sword and shield idle (3) | sword-shield | 8.667 | · | crouch>crouch |  | L |  |  |
| ProSwordandShield/sword and shield idle (4) | sword-shield | 2.533 | · | crouch>crouch |  | L |  |  |
| ProSwordandShield/sword and shield idle | sword-shield | 3.667 | · | crouch>crouch |  | L |  | aldric.idle |

## jump-fall (20)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| ActionAdventure/falling idle | unarmed | 0.7 | · | stand>stand |  |  |  | gorak.fall, aldric.fall +6 |
| ActionAdventure/falling to roll | unarmed | 1.8 | dz 2.93 dx -0.04 | stand>stand (via ground) |  |  |  |  |
| ActionAdventure/hard landing | unarmed | 2 | dz 0.17 dx -0.01 | stand>stand (via kneel) |  |  |  | gorak.land, aldric.land +6 |
| ActionAdventure/jumping up | unarmed | 0.233 | · | stand>stand |  |  |  |  |
| Creature/mutant jumping (2) | creature | 0.6 | · | stand>stand |  |  |  |  |
| Creature/mutant jumping | creature | 3.167 | · | stand>stand (via kneel) |  |  |  |  |
| HF/weapons_extra/Great_Sword_Jump_2 | 2h-greatsword | 0.633 | dz 1.59 dx 0 | stand>stand |  |  |  |  |
| HF/weapons_extra/Great_Sword_Jump | 2h-greatsword | 0.9 | · | stand>stand |  |  |  |  |
| ProLongbow/fall a land to run forward | bow | 0.933 | dz 1.69 dx 0.08 yaw 37 | stand>stand (via crouch) |  |  |  |  |
| ProLongbow/fall a land to standing idle 01 | bow | 0.7 | · | stand>stand (via crouch) |  |  | M |  |
| ProLongbow/fall a loop | bow | 1.067 | · | stand>stand |  |  |  |  |
| ProMagic/Standing Jump Running Landing | caster | 1.367 | dz 4.56 dx 0 | stand>stand (via crouch) |  |  |  |  |
| ProMagic/Standing Jump Running | caster | 1.067 | dz 3.97 dx 0 | stand>stand |  |  |  | vex.bat_dive |
| ProMagic/Standing Jump | caster | 2.367 | dz 0 dx 0 | stand>stand (via crouch) |  |  |  |  |
| ProMagic/Standing Land To Standing Idle | caster | 1.1 | dz 1.28 dx 0 yaw -37 | stand>stand (via crouch) |  |  |  |  |
| ProMeleeAxe/standing jump | 1h-axe | 1.9 | dz 0 dx 0 | crouch>crouch (via kneel) |  |  |  |  |
| ProMeleeAxe/unarmed jump running | unarmed | 1.4 | dz 3.27 dx 0.01 | stand>stand (via crouch) |  |  |  |  |
| ProMeleeAxe/unarmed jump | unarmed | 2.333 | · | stand>stand (via crouch) |  |  |  |  |
| ProSwordandShield/sword and shield jump (2) | sword-shield | 0.967 | · | crouch>crouch |  |  |  |  |
| ProSwordandShield/sword and shield jump | sword-shield | 0.833 | dz 2.44 dx 0 | stand>stand |  |  |  |  |

## kick (20)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| HF/brawler_kicks/Drop_Kick | unarmed | 2.9 | dz -0.01 dx 0.72 yaw 257 | crouch>crouch (via kneel) | LeftHand @0.733 |  |  |  |
| HF/brawler_kicks/Flying_Kick | unarmed | 1.5 | dz 2.11 dx -0.08 yaw -27 | crouch>stand | LeftHand @0.133 |  |  |  |
| HF/brawler_kicks/Hurricane_Kick | unarmed | 1.833 | dz 3.3 dx 0 yaw 1440 | stand>stand | LeftFoot @1.133 |  | M |  |
| HF/brawler_kicks/Inside_Crescent_Kick | unarmed | 2.667 | dz 0 dx 0 yaw 360 | stand>stand (via crouch) | RightFoot @1.433 |  | M |  |
| HF/brawler_kicks/Knee_Kick_Lead | unarmed | 2.333 | dz 0 dx 0 | stand>stand | LeftHand @0.8 |  | M |  |
| HF/brawler_kicks/Mma_Kick_2 | unarmed | 2 | dz 0 dx 0 | stand>stand | LeftHand @0.2 |  | M |  |
| HF/brawler_kicks/Mma_Kick_3 | unarmed | 1.6 | dz 0 dx 0 | stand>stand | LeftFoot @0.5 |  | M |  |
| HF/brawler_kicks/Mma_Kick_4 | unarmed | 1.667 | dz 0.01 dx 0.02 yaw 358 | stand>stand | RightFoot @0.767 |  | M |  |
| HF/brawler_kicks/Mma_Kick_5 | unarmed | 1.5 | dz 0 dx 0 | stand>stand | RightFoot @0.5 |  | M |  |
| HF/brawler_kicks/Mma_Kick_6 | unarmed | 1.6 | dz 0 dx 0 | stand>stand | RightFoot @0.6 |  | M |  |
| HF/brawler_kicks/Mma_Kick | unarmed | 2.033 | dz 0.26 dx -0.44 yaw -359 | stand>stand (via crouch) | LeftHand @0.6 |  | M |  |
| HF/brawler_kicks/Roundhouse_Kick_2 | unarmed | 2.5 | dz 0 dx 0 | stand>stand (via crouch) | RightFoot @0.867 |  | M |  |
| HF/brawler_kicks/Roundhouse_Kick | unarmed | 2.133 | dz 0.63 dx 0 | stand>stand | LeftHand @0.9 |  | M |  |
| HF/brawler_kicks/Scissor_Kick | unarmed | 2.767 | dz -0.23 dx 0.19 yaw 191 | stand>stand (via ground) | LeftHand @1 |  |  |  |
| HF/brawler_kicks/Side_Kick | unarmed | 2 | dz 0 dx 0 | crouch>crouch | RightFoot @0.633 |  | M |  |
| HF/brawler_kicks/Spin_Flip_Kick | unarmed | 3.7 | dz 2.33 dx 1.3 yaw -337 | stand>crouch (via ground) | RightHand @1.467 |  |  |  |
| ProLongbow/standing melee kick | bow | 1.433 | dz 0 dx 0 | stand>stand (via crouch) | RightFoot @0.533 |  | M | erika.kick |
| ProMeleeAxe/standing melee attack kick ver. 1 | 1h-axe | 1.867 | dz 0 dx 0 | crouch>crouch | RightFoot @0.567 |  | M | gorak.boot, erika.ankle_sweep +3 |
| ProMeleeAxe/standing melee attack kick ver. 2 | 1h-axe | 1.4 | dz 0.02 dx 0 | crouch>stand | RightFoot @0.6 |  | M | gorak.stomp_kick, vex.spinning_heel +2 |
| ProSwordandShield/sword and shield kick | sword-shield | 1.2 | dz 0 dx 0 | crouch>crouch | RightFoot @0.4 |  | M | aldric.shield_kick |

## knockdown (12)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| HF/hit_reactions/Fall_Flat | unarmed | 2.533 | dz 3.08 dx 0.08 yaw -112 | stand>ground | ends on ground |  |  |  |
| HF/hit_reactions/Fall_Over | unarmed | 2 | dz -0.73 dx -0.21 yaw 247 | stand>ground | ends on ground |  | M |  |
| HF/hit_reactions/Falling_Down | unarmed | 2.267 | dz -0.83 dx -0.59 yaw 273 | stand>ground | ends on ground |  |  |  |
| HF/hit_reactions/Falling_Flat_Impact | unarmed | 1.567 | · | stand>ground | ends on ground |  |  |  |
| HF/hit_reactions/Hit_On_Legs | unarmed | 4.067 | dz 1.47 dx 0.04 yaw -361 | stand>ground | ends on ground |  |  |  |
| HF/hit_reactions/Knocked_Down | unarmed | 2.8 | dz -1.58 dx -0.67 yaw 264 | stand>ground | ends on ground |  |  |  |
| HF/hit_reactions/Livershot_Knockdown | unarmed | 2.8 | dz 0 dx 0 | stand>stand (via kneel) | ends stand |  | M |  |
| HF/hit_reactions/Receiver_Catch | unarmed | 3.467 | dz 0.5 dx 2.73 yaw 112 | crouch>ground | ends on ground |  |  |  |
| HF/hit_reactions/Receiving_Cpr | unarmed | 8.633 | · | ground>ground | ends on ground |  |  |  |
| HF/hit_reactions/Shoulder_Hit_And_Fall | unarmed | 3.1 | dz -1.49 dx -0.19 yaw 215 | stand>ground | ends on ground |  |  |  |
| HF/hit_reactions/Stunned | unarmed | 2.133 | dz -1.01 dx -0.2 yaw 194 | stand>ground | ends on ground |  |  |  |
| HF/hit_reactions/Sweep_Fall | unarmed | 2.5 | dz -0.65 dx -0.15 yaw 181 | stand>ground | ends on ground |  |  |  |

## locomotion (67)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| ActionAdventure/crouched sneaking left | unarmed | 1.267 | dz 0 dx -1.25 | crouch>crouch |  | L |  |  |
| ActionAdventure/crouched sneaking right | unarmed | 1.1 | dz 0 dx 1.19 | crouch>crouch |  | L |  |  |
| ActionAdventure/running | unarmed | 0.7 | dz 3.03 dx 0 | stand>stand |  |  |  |  |
| ActionAdventure/walking | unarmed | 1.033 | dz 1.71 dx 0 | stand>stand |  | L |  |  |
| Creature/mutant run | creature | 0.867 | dz 1.98 dx 0 | stand>stand (via crouch) |  | L |  | fenrik.run, maw.run |
| Creature/mutant walking | creature | 1.433 | dz 1.78 dx 0 | stand>stand (via crouch) |  | L |  | fenrik.walk, maw.walk |
| HF/weapons_extra/Great_Sword_Crouching_2 | 2h-greatsword | 0.467 | · | kneel>kneel |  |  |  |  |
| HF/weapons_extra/Great_Sword_Crouching_3 | 2h-greatsword | 1.833 | · | kneel>kneel |  | L | M |  |
| HF/weapons_extra/Great_Sword_Crouching_4 | 2h-greatsword | 0.667 | dz -0.33 dx 0.2 yaw -38 | stand>kneel |  |  | M |  |
| HF/weapons_extra/Great_Sword_Crouching_5 | 2h-greatsword | 0.367 | · | kneel>kneel |  |  |  |  |
| HF/weapons_extra/Great_Sword_Crouching_6 | 2h-greatsword | 1.4 | · | kneel>kneel |  | L |  |  |
| HF/weapons_extra/Great_Sword_Crouching | 2h-greatsword | 0.7 | dz 0.3 dx -0.2 yaw 32 | kneel>stand |  |  | M |  |
| HF/weapons_extra/Great_Sword_Run_2 | 2h-greatsword | 0.6 | dz 2.51 dx 0 | stand>stand |  | L |  |  |
| HF/weapons_extra/Great_Sword_Run | 2h-greatsword | 0.733 | dz -1.85 dx 0 | stand>stand |  | L |  |  |
| HF/weapons_extra/Great_Sword_Strafe_2 | 2h-greatsword | 0.633 | dz 0 dx -1.84 | stand>stand |  | L |  |  |
| HF/weapons_extra/Great_Sword_Strafe_3 | 2h-greatsword | 1.1 | dz 0 dx 1.24 | stand>stand |  | L |  |  |
| HF/weapons_extra/Great_Sword_Strafe_4 | 2h-greatsword | 0.567 | dz 0.01 dx 1.24 | stand>stand |  | L |  |  |
| HF/weapons_extra/Great_Sword_Strafe | 2h-greatsword | 1.167 | dz 0.01 dx -1.36 | stand>stand |  | L |  |  |
| HF/weapons_extra/Great_Sword_Walk_2 | 2h-greatsword | 1.3 | dz -1.26 dx 0 | stand>stand |  | L |  |  |
| HF/weapons_extra/Great_Sword_Walk | 2h-greatsword | 1.367 | dz 1.45 dx 0 | stand>stand |  | L |  |  |
| ProLongbow/standing aim walk back | bow | 1.467 | dz -1.33 dx 0 | stand>stand |  | L |  |  |
| ProLongbow/standing aim walk forward | bow | 1.2 | dz 1.33 dx 0 | stand>stand |  | L |  |  |
| ProLongbow/standing aim walk left | bow | 1.2 | dz 0 dx 1.72 | stand>stand (via crouch) |  | L |  |  |
| ProLongbow/standing aim walk right | bow | 1.3 | dz 0 dx -1.79 | stand>stand (via crouch) |  | L |  |  |
| ProLongbow/standing run back | bow | 0.667 | dz -1.85 dx 0 | crouch>crouch |  | L |  |  |
| ProLongbow/standing run forward | bow | 0.867 | dz 3.02 dx 0 | stand>stand |  | L |  | erika.run |
| ProLongbow/standing run left | bow | 0.667 | dz 0 dx 2.06 | stand>stand |  | L |  |  |
| ProLongbow/standing run right | bow | 0.767 | dz 0 dx -2.28 | stand>stand (via crouch) |  | L |  |  |
| ProLongbow/standing walk back | bow | 1.467 | dz -1.33 dx 0 | stand>stand |  | L |  | erika.walkBack |
| ProLongbow/standing walk forward | bow | 1.2 | dz 1.33 dx 0 | stand>stand |  | L |  | erika.walk |
| ProLongbow/standing walk left | bow | 1.2 | dz 0 dx 1.72 | stand>stand (via crouch) |  | L |  | erika.strafeL |
| ProLongbow/standing walk right | bow | 1.2 | dz 0 dx -1.84 | stand>stand (via crouch) |  | L |  | erika.strafeR |
| ProMagic/Crouch Walk Back | caster | 1.233 | dz -1.52 dx 0 | crouch>crouch |  | L |  |  |
| ProMagic/Crouch Walk Forward | caster | 1.133 | dz 1.88 dx 0 | crouch>crouch |  | L |  |  |
| ProMagic/Crouch Walk Left | caster | 1.167 | dz 0 dx 1.56 | crouch>crouch |  | L |  |  |
| ProMagic/Crouch Walk Right | caster | 1.267 | dz 0 dx -1.46 | crouch>crouch |  | L |  |  |
| ProMagic/Standing Run Back | caster | 0.633 | dz -1.87 dx 0 | stand>stand |  | L |  |  |
| ProMagic/Standing Run Forward | caster | 0.733 | dz 2.76 dx 0 | stand>stand |  | L |  | ozrel.run |
| ProMagic/Standing Run Left | caster | 0.767 | dz 0.01 dx 2.49 | stand>stand |  | L |  | vex.strafeL |
| ProMagic/Standing Run Right | caster | 0.767 | dz -0.01 dx -2.79 | stand>stand |  | L |  | vex.strafeR |
| ProMagic/Standing Sprint Forward | caster | 0.567 | dz 2.9 dx 0.01 | stand>stand |  |  |  | vex.run |
| ProMagic/Standing Walk Back | caster | 1.2 | dz -1.39 dx 0 | stand>stand |  | L |  | ozrel.walkBack, vex.walkBack |
| ProMagic/Standing Walk Forward | caster | 1.133 | dz 1.77 dx 0 | stand>stand |  | L |  | ozrel.walk, vex.walk |
| ProMagic/Standing Walk Left | caster | 1.167 | dz 0 dx 1.45 | stand>stand |  | L |  | ozrel.strafeL |
| ProMagic/Standing Walk Right | caster | 1.2 | dz 0 dx -1.58 | stand>stand |  | L |  | ozrel.strafeR |
| ProMeleeAxe/standing run back | 1h-axe | 0.8 | dz -1.5 dx 0 | stand>stand |  | L |  |  |
| ProMeleeAxe/standing run forward | 1h-axe | 0.733 | dz 1.79 dx 0 | stand>stand |  | L |  | gorak.run |
| ProMeleeAxe/standing walk back | 1h-axe | 1.367 | dz -1.25 dx 0 | stand>stand |  | L |  | gorak.walkBack |
| ProMeleeAxe/standing walk forward | 1h-axe | 1.333 | dz 1.34 dx 0 | stand>stand |  | L |  | gorak.walk |
| ProMeleeAxe/standing walk left | 1h-axe | 1.233 | dz 0 dx 1.15 | stand>stand |  | L |  | gorak.strafeL, fenrik.strafeL +2 |
| ProMeleeAxe/standing walk right | 1h-axe | 1.267 | dz 0 dx -1.3 | stand>stand |  | L |  | gorak.strafeR, fenrik.strafeR +2 |
| ProMeleeAxe/unarmed run back | unarmed | 0.767 | dz -1.47 dx 0.01 | stand>stand |  | L |  |  |
| ProMeleeAxe/unarmed run forward | unarmed | 0.8 | dz 2.1 dx 0 | stand>stand |  | L |  | hollowjack.run |
| ProMeleeAxe/unarmed walk back | unarmed | 1.3 | dz -1.1 dx 0 | stand>stand |  | L |  | fenrik.walkBack, maw.walkBack +1 |
| ProMeleeAxe/unarmed walk forward | unarmed | 1.367 | dz 1.33 dx 0 | stand>stand |  | L |  | hollowjack.walk |
| ProSwordandShield/sword and shield crouch | sword-shield | 0.567 | dz -0.26 dx -0.03 | crouch>kneel |  |  | M |  |
| ProSwordandShield/sword and shield crouching (2) | sword-shield | 0.6 | dz -0.29 dx -0.1 | kneel>kneel |  |  | M |  |
| ProSwordandShield/sword and shield crouching (3) | sword-shield | 0.633 | · | kneel>kneel |  | L | M |  |
| ProSwordandShield/sword and shield crouching | sword-shield | 0.5 | dz 0.26 dx 0.03 | kneel>crouch |  |  | M |  |
| ProSwordandShield/sword and shield run (2) | sword-shield | 0.533 | dz -2.25 dx 0 | stand>stand |  | L |  |  |
| ProSwordandShield/sword and shield run | sword-shield | 0.7 | dz 2.65 dx 0 | stand>stand |  |  |  | aldric.run |
| ProSwordandShield/sword and shield strafe (2) | sword-shield | 1.3 | dz -0.01 dx 1.31 | crouch>crouch |  | L |  | aldric.strafeL |
| ProSwordandShield/sword and shield strafe (3) | sword-shield | 0.667 | dz 0 dx 2.22 | stand>stand |  | L |  |  |
| ProSwordandShield/sword and shield strafe (4) | sword-shield | 0.7 | dz 0 dx -2.18 | stand>stand |  | L |  |  |
| ProSwordandShield/sword and shield strafe | sword-shield | 1.133 | dz 0.02 dx -1.29 | crouch>crouch |  | L |  | aldric.strafeR |
| ProSwordandShield/sword and shield walk (2) | sword-shield | 1.267 | dz -1.35 dx 0 | stand>stand |  | L |  | aldric.walkBack |
| ProSwordandShield/sword and shield walk | sword-shield | 1.1 | dz 1.58 dx 0 | stand>stand |  | L |  | aldric.walk |

## misc (1)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| ProLongbow/standing aim recoil | bow | 0.7 | · | stand>stand |  |  |  | erika.snap_shot, erika.heartseeker +2 |

## parry (2)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| ProMagic/Standing Block React Large | caster | 1.333 | · | crouch>crouch |  |  |  | ozrel.blockHit, vex.blockHit |
| ProMeleeAxe/standing block react large | 1h-axe | 1.333 | · | crouch>crouch |  |  | M | gorak.blockHit, fenrik.blockHit +2 |

## talk (18)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| HF/talk_gesture/Angry_Gesture_2 | unarmed | 5.833 | · | crouch>crouch |  |  | M |  |
| HF/talk_gesture/Angry_Gesture_3 | unarmed | 2.2 | · | stand>stand |  |  |  |  |
| HF/talk_gesture/Angry_Gesture | unarmed | 3.267 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Beckoning | unarmed | 2.6 | · | crouch>crouch |  |  | M |  |
| HF/talk_gesture/Pointing_2 | unarmed | 3.433 | · | crouch>crouch |  |  | M |  |
| HF/talk_gesture/Pointing_3 | unarmed | 2.767 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Pointing_Forward | unarmed | 4.7 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Pointing_Gesture_2 | unarmed | 1.833 | · | stand>stand |  |  |  |  |
| HF/talk_gesture/Pointing_Gesture | unarmed | 1.967 | · | stand>stand (via crouch) |  |  | M |  |
| HF/talk_gesture/Pointing | unarmed | 3.6 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Talking_2 | unarmed | 10.267 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Talking_3 | unarmed | 4.8 | dz 0 dx 0 | stand>stand |  |  | M |  |
| HF/talk_gesture/Talking_4 | unarmed | 3.767 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Talking_5 | unarmed | 5.933 | · | stand>stand |  |  |  |  |
| HF/talk_gesture/Talking_6 | unarmed | 5 | · | crouch>crouch |  |  | M |  |
| HF/talk_gesture/Talking_7 | unarmed | 3.933 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Talking | unarmed | 5.167 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Taunt_Gesture | unarmed | 1.967 | · | stand>stand |  |  | M |  |

## throw-prop (7)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| HF/grabs_throws/Lifting_Object | unarmed | 11.5 | dz 0 dx 0 | stand>stand (via kneel) | release @8.7 |  |  |  |
| HF/grabs_throws/Lifting | unarmed | 7.2 | · | stand>stand (via crouch) | release @1.067 |  | M |  |
| HF/grabs_throws/Pick_Up_Item_2 | unarmed | 1.2 | dz 5.11 dx 0 | stand>stand | release @0.6 |  |  |  |
| HF/grabs_throws/Pick_Up_Item | unarmed | 1.2 | dz 5.37 dx 0 | stand>stand (via crouch) | release @0.633 |  |  |  |
| HF/grabs_throws/Throw_Object | unarmed | 4.867 | dz 0 dx 0 | stand>stand (via crouch) | release @2.4 |  | M |  |
| HF/grabs_throws/Throw | unarmed | 2.2 | · | stand>stand | release @0.9 |  | M |  |
| HF/grabs_throws/Throwing | unarmed | 5.567 | dz 0.8 dx 0.05 yaw -21 | stand>stand (via crouch) | release @1.633 |  | M |  |

## transition (5)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| ActionAdventure/run to stop | unarmed | 0.9 | dz 0.79 dx 0 yaw -45 | stand>stand (via crouch) |  |  |  |  |
| ProLongbow/standing run forward stop | bow | 0.9 | dz 0.44 dx 0.1 yaw -36 | stand>stand (via crouch) |  |  | M |  |
| ProMagic/Crouch To Standing Idle | caster | 1 | · | kneel>stand |  |  | M | ozrel.getup, erika.getup +1 |
| ProMagic/Standing Idle To Crouch | caster | 1 | · | stand>kneel |  |  |  |  |
| ProMeleeAxe/crouch to standing idle | 1h-axe | 0.633 | · | crouch>crouch |  |  |  | gorak.getup, aldric.getup +3 |

## turn (25)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| ActionAdventure/left turn | unarmed | 1.033 | · | stand>stand |  |  | M |  |
| ActionAdventure/right turn | unarmed | 1.033 | · | stand>stand |  |  |  |  |
| Creature/left turn 45 | creature | 1.333 | · | stand>stand |  |  |  |  |
| Creature/mutant left turn 45 | creature | 1.333 | · | stand>stand |  |  |  |  |
| Creature/mutant right turn 45 (2) | creature | 1.333 | · | stand>stand |  |  |  |  |
| Creature/mutant right turn 45 | creature | 1.967 | · | stand>stand |  |  |  |  |
| Creature/mutant right turn 90 | creature | 2.4 | dz 0 dx 0.01 yaw -90 | stand>stand |  |  |  |  |
| HF/weapons_extra/Great_Sword_180_Turn_2 | 2h-greatsword | 0.567 | dz 0.35 dx 0 yaw -175 | stand>stand (via crouch) |  |  |  |  |
| HF/weapons_extra/Great_Sword_180_Turn | 2h-greatsword | 0.8 | dz 0.01 dx -0.03 yaw -188 | stand>stand (via crouch) |  |  | M |  |
| HF/weapons_extra/Great_Sword_Turn_2 | 2h-greatsword | 0.833 | dz 0.09 dx -0.12 yaw 86 | stand>stand |  |  | M |  |
| HF/weapons_extra/Great_Sword_Turn | 2h-greatsword | 0.733 | dz 0.19 dx 0.01 yaw -98 | stand>stand |  |  |  |  |
| ProLongbow/standing turn 90 left | bow | 1.267 | dz -0.01 dx -0.01 yaw 88 | stand>stand |  |  |  |  |
| ProLongbow/standing turn 90 right | bow | 1.1 | · | stand>stand |  |  |  |  |
| ProMagic/Crouch Turn Left 90 | caster | 1.833 | · | kneel>kneel |  |  |  |  |
| ProMagic/Crouch Turn Right 90 | caster | 1.633 | · | kneel>kneel |  |  |  |  |
| ProMagic/Standing Turn Left 90 | caster | 1.867 | · | stand>stand |  |  |  |  |
| ProMagic/Standing Turn Right 90 | caster | 1.633 | · | stand>stand |  |  |  |  |
| ProMeleeAxe/standing turn left 90 | 1h-axe | 1.767 | dz 0 dx 0.01 yaw 89 | crouch>crouch |  |  |  |  |
| ProMeleeAxe/standing turn right 90 | 1h-axe | 1.633 | dz 0 dx 0 yaw -90 | crouch>crouch |  |  |  |  |
| ProMeleeAxe/unarmed turn left 90 | unarmed | 1.5 | · | stand>stand |  |  |  |  |
| ProMeleeAxe/unarmed turn right 90 | unarmed | 1.5 | · | stand>stand |  |  |  |  |
| ProSwordandShield/sword and shield 180 turn (2) | sword-shield | 0.833 | dz 0.53 dx -0.08 yaw -170 | stand>stand (via crouch) |  |  | M |  |
| ProSwordandShield/sword and shield 180 turn | sword-shield | 0.8 | dz 0.27 dx -0.11 yaw -181 | stand>stand (via crouch) |  |  | M |  |
| ProSwordandShield/sword and shield turn (2) | sword-shield | 0.933 | dz 0 dx -0.01 yaw 99 | crouch>crouch |  |  |  |  |
| ProSwordandShield/sword and shield turn | sword-shield | 0.933 | dz 0.01 dx 0 yaw -99 | crouch>crouch |  |  |  |  |

## victory-defeat (19)

| clip | stance | dur | root | posture | strike / contact | L | M | used |
|---|---|---|---|---|---|---|---|---|
| HF/talk_gesture/Cheering_2 | unarmed | 1.9 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Defeat_2 | unarmed | 4.767 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Defeat_Idle_2 | unarmed | 1.733 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Defeat_Idle_3 | unarmed | 1.533 | · | stand>stand (via crouch) |  |  |  |  |
| HF/talk_gesture/Defeat_Idle | unarmed | 1.633 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Defeat | unarmed | 7.3 | · | stand>stand |  |  |  |  |
| HF/talk_gesture/Defeated | unarmed | 6.733 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Disappointed | unarmed | 4.2 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Kneel | unarmed | 10.8 | dz 0 dx 0 | stand>stand (via kneel) |  |  | M |  |
| HF/talk_gesture/Praying | unarmed | 6.867 | dz 0.05 dx -0.03 | kneel>stand |  |  |  |  |
| HF/talk_gesture/Quick_Formal_Bow | unarmed | 2.733 | · | stand>stand |  |  |  |  |
| HF/talk_gesture/Standing_Cheering_2 | unarmed | 3.433 | dz 0 dx 0 | crouch>crouch |  |  |  |  |
| HF/talk_gesture/Standing_Cheering | unarmed | 3.433 | dz 0 dx 0 | crouch>crouch |  |  |  |  |
| HF/talk_gesture/Victory_2 | unarmed | 4.5 | · | stand>stand |  |  |  |  |
| HF/talk_gesture/Victory_3 | unarmed | 6.1 | · | crouch>crouch |  |  | M |  |
| HF/talk_gesture/Victory_Idle_2 | unarmed | 1.667 | · | stand>stand |  |  | M |  |
| HF/talk_gesture/Victory_Idle_3 | unarmed | 1.867 | · | stand>stand (via crouch) |  |  | M |  |
| HF/talk_gesture/Victory_Idle | unarmed | 1.8 | · | stand>stand (via crouch) |  |  | M |  |
| HF/talk_gesture/Victory | unarmed | 8.533 | · | stand>stand |  |  |  |  |
