/**
 * Voiced dialogue (nemesis-style barks). Data only.
 *
 * Every line has a stable id `<fighter>.<situation>.<n>` (or
 * `<fighter>.vs_<opp>.<n>` for rivalry lines). Audio is pre-rendered offline
 * by `npm run tts:gen` into public/audio/voice/<fighter>/<id>.ogg; the game
 * falls back to subtitles-only if a file is missing.
 *
 * Personas: `instruct` is the OmniVoice voice-design prompt used to create
 * the character's anchor voice; `fx` is the ffmpeg filter chain applied after
 * synthesis to give each fighter a distinct sonic identity.
 */
export type Situation =
  | 'entrance'
  | 'faceoff'
  | 'taunt'
  | 'ultimate'
  | 'hurt'
  | 'nearDeath'
  | 'comeback'
  | 'kill'
  | 'victory'
  | 'defeat';

export interface Persona {
  instruct: string;
  /** Anchor line synthesised first; later lines clone this voice. */
  anchor: string;
  /** ffmpeg -af chain (post-process) */
  fx: string;
  /** Speaking speed for OmniVoice (1 = normal). */
  speed: number;
  /** Subtitle colour. */
  color: string;
}

export interface FighterLines {
  persona: Persona;
  lines: Partial<Record<Situation, string[]>>;
  /** Pair-specific face-off lines keyed by opponent id. */
  vs?: Record<string, string[]>;
}

export const DIALOGUE: Record<string, FighterLines> = {
  gorak: {
    persona: {
      instruct: 'male, middle-aged, very low pitch',
      anchor: 'I am Gorak. I have broken a hundred shields, and I am still hungry.',
      fx: 'asetrate=24000*0.9,aresample=24000,atempo=1.08,bass=g=6:f=110,acompressor=threshold=-18dB:ratio=4,aecho=0.6:0.4:40:0.25,volume=1.4',
      speed: 0.95,
      color: '#ff8a5a',
    },
    lines: {
      entrance: [
        'They chained me. They starved me. They threw me in the pit with three bears. Now the bears are a rug, and I am Gorak the Skullsplitter.',
        'Ten winters I have walked into this sand, and ten winters I have walked out. Count your bones, little champion. I will be counting them after.',
      ],
      faceoff: ['You are smaller than they promised.', 'Pray loud. The gods are far away and I am very close.'],
      taunt: ['Is that all? My grandmother hits harder, and she is dead.', 'Come closer! The axe is lonely.', 'Ha! Again! Hit me again!'],
      ultimate: ['SKULLSPLITTER!', 'Your skull! Is! MINE!'],
      hurt: ['Grrah!', 'Hrrk! Good!', 'Ungh!'],
      nearDeath: ['Not yet. Gorak does not fall to worms.', 'Blood in my eyes. Good. Now I see red.'],
      comeback: ['You woke me up. Bad idea.', 'Now Gorak is angry!'],
      kill: ['Down you go!', 'Another skull for the wall!'],
      victory: ['Who is next? Send two. Send ten!', 'Write it in the sand. Gorak. Still. Standing.'],
      defeat: ['Tell them... I did not run...', 'Huh... good hit...'],
    },
    vs: {
      aldric: ['Shiny man. I will make your shield into a soup bowl.'],
      maw: ['Big beast. Bigger rug.'],
    },
  },
  aldric: {
    persona: {
      instruct: 'male, middle-aged, low pitch, british accent',
      anchor: 'By the Ninth Shield, I stand. By the Ninth Shield, I hold.',
      fx: 'highpass=f=90,acompressor=threshold=-20dB:ratio=3,aecho=0.8:0.55:70|130:0.3|0.2,volume=1.3',
      speed: 1.0,
      color: '#9fd0ff',
    },
    lines: {
      entrance: [
        'I am Aldric, called Ironwall, captain of the Ninth Shield. I held the Gray Bridge for three days against an army. Today I need only hold this sand.',
        'The light does not ask whether you are ready. It simply arrives. Kneel now, and I will remember you kindly.',
      ],
      faceoff: ['Your sins are written on your face. I will read them aloud.', 'Raise your guard. I insist on a fair execution.'],
      taunt: ['Is that the best your gods can muster?', 'Strike true, or do not strike at all.', 'I have felt sharper words from novices.'],
      ultimate: ['OATH OF STEEL!', 'Judgement falls!'],
      hurt: ['Hold!', 'Hngh! Still standing.', 'Steady!'],
      nearDeath: ['The wall bends... it does not break.', 'Light, give me one more breath.'],
      comeback: ['The tide turns. As it always does.', 'You mistook my patience for weakness.'],
      kill: ['Rest now. It is over.', 'Justice is done.'],
      victory: ['The Ninth Shield holds. Mark it in the records.', 'Rise again in a better life, champion.'],
      defeat: ['The wall... has fallen...', 'Forgive me... brothers...'],
    },
    vs: {
      gorak: ['Your axe has widowed half the north, warlord. It ends on this sand.'],
      vex: ['I know what you are, bloodsucker. Holy steel remembers your kind.'],
    },
  },
  ozrel: {
    persona: {
      instruct: 'male, elderly, moderate pitch, british accent',
      anchor: 'Fire is not cruel. Fire is honest. Everything burns at the same price.',
      fx: 'asetrate=24000*1.03,aresample=24000,aecho=0.8:0.7:23|47:0.4|0.3,chorus=0.6:0.9:50:0.4:0.25:2,acompressor=threshold=-18dB:ratio=3,volume=1.4',
      speed: 1.05,
      color: '#ffc46a',
    },
    lines: {
      entrance: [
        'They called it an accident. The academy, the library, the dean. I call it a lesson. I am Ozrel the Cinderlord, and class is in session.',
        'Do you smell that? Smoke. Ash. Opportunity. Ha ha ha! Stand still, and I promise it will only hurt forever.',
      ],
      faceoff: ['Oh, you are flammable. How delightful.', 'Let us see what you are made of. Mostly carbon, I suspect.'],
      taunt: ['Warm enough for you? Ha ha!', 'Dance, little candle, dance!', 'I have burned better scholars than you.'],
      ultimate: ['PYRE! Burn, burn, BURN!', 'Ashes to ashes!'],
      hurt: ['Agh! Rude!', 'Ow! My beard!', 'Hah! Is that all?'],
      nearDeath: ['Close. So close to the final lecture.', 'If I go, I take the whole arena with me!'],
      comeback: ['The fire was never out. Merely sleeping!', 'Oh, now I am inspired!'],
      kill: ['Class dismissed!', 'Extinguished. Ha!'],
      victory: ['Note to self: champions burn slower than books.', 'Applause! Or I set the stands on fire.'],
      defeat: ['The flame... gutters...', 'Cold... so cold...'],
    },
    vs: {
      hollowjack: ['A pumpkin? Oh, I am going to carve you a lovely new face.'],
    },
  },
  erika: {
    persona: {
      instruct: 'female, young adult, moderate pitch',
      anchor: 'Breathe in. Hold. Release. That is all there is to it.',
      fx: 'highpass=f=100,acompressor=threshold=-20dB:ratio=3,aecho=0.7:0.3:30:0.15,volume=1.3',
      speed: 1.0,
      color: '#8dffc8',
    },
    lines: {
      entrance: [
        'I have tracked wolves through blizzards and kings through their own castles. They call me the Thornshot. I never miss the same target twice. I have never needed to.',
        'Quiet now. Listen. That is your heart. Count the beats you have left, champion. I already have.',
      ],
      faceoff: ['Stand still. It is kinder.', 'I have your scent. There is nowhere left to run.'],
      taunt: ['Too slow.', 'Missed me. Try aiming.', 'You fight like a wounded boar.'],
      ultimate: ['RAIN OF THORNS!', 'Nowhere to hide!'],
      hurt: ['Ah!', 'Hnn! Lucky.', 'Tch!'],
      nearDeath: ['Breathe. Aim. One more shot.', 'Not like this. Not to you.'],
      comeback: ['The hunt is not over.', 'Now I see your rhythm.'],
      kill: ['Clean shot.', 'Target down.'],
      victory: ['Another trophy. The wall is getting crowded.', 'The forest remembers. So will they.'],
      defeat: ['I should have... kept my distance...', 'The hunter... becomes...'],
    },
    vs: {
      vex: ['I have hunted your kind for nine years, vampire. Silver tips, just for you.'],
    },
  },
  vex: {
    persona: {
      instruct: 'male, young adult, low pitch, british accent',
      anchor: 'Shh. Listen to the crowd. Every heartbeat in this arena belongs to me tonight.',
      fx: 'asetrate=24000*0.95,aresample=24000,atempo=1.04,aecho=0.8:0.85:60|120|240:0.35|0.25|0.15,highpass=f=120,volume=1.4',
      speed: 0.95,
      color: '#ff7090',
    },
    lines: {
      entrance: [
        'Do you hear it? Thousands of hearts, racing for me. I have been dead for three hundred years, and I have never felt more alive. I am Vex, the Crimson Whisper.',
        'Come, champion. Let me show you what eternity feels like. It is shorter than you think.',
      ],
      faceoff: ['You smell of fear. Delicious.', 'Such a strong heartbeat. Let us see how long it lasts.'],
      taunt: ['Over here, darling.', 'You missed. Again.', 'So slow. So mortal.'],
      ultimate: ['A THOUSAND CUTS!', 'Bleed for me!'],
      hurt: ['Hss!', 'Ah! Bold.', 'Tsk!'],
      nearDeath: ['Not yet. The night is young.', 'You cornered a predator. Mistake.'],
      comeback: ['Now you have my attention.', 'The hunger wakes.'],
      kill: ['Shh. Sleep.', 'Exquisite.'],
      victory: ['The crowd adores me. Of course they do.', 'Eternity continues. Yours did not.'],
      defeat: ['The sun... finally...', 'Three hundred years... for this...'],
    },
    vs: {
      erika: ['The little hunter again. I kept your last arrow. Shall I return it?'],
      aldric: ['Your god abandoned me centuries ago, knight. He will not save you either.'],
    },
  },
  fenrik: {
    persona: {
      instruct: 'male, middle-aged, very low pitch',
      anchor: 'Hungry. Always hungry. Smell blood. Smell you.',
      fx: 'asetrate=24000*0.84,aresample=24000,atempo=1.1,acrusher=bits=10:mix=0.15,bass=g=8:f=90,aecho=0.6:0.5:35:0.3,volume=1.6',
      speed: 0.9,
      color: '#a8ff7a',
    },
    lines: {
      entrance: [
        'Cellar. Dark. Needles. They made me. Now I unmake them. Fenrik. Bloodmaw. Hungry.',
        'Smell you. Smell fear. Run. Fenrik likes when they run.',
      ],
      faceoff: ['Meat.', 'You. Smell. Weak.'],
      taunt: ['Hah! Hah!', 'Run, meat!', 'More! More!'],
      ultimate: ['FRENZY!', 'TEAR! RIP!'],
      hurt: ['Rrraagh!', 'Hrrk!', 'Grah!'],
      nearDeath: ['Not die. Not die!', 'Blood. Need blood.'],
      comeback: ['Fenrik wakes!', 'Now you bleed!'],
      kill: ['Mine!', 'Feast!'],
      victory: ['Fenrik wins! Fenrik eats!', 'More meat! Bring more!'],
      defeat: ['Cold... dark... cellar...', 'Fenrik... sleeps...'],
    },
    vs: {
      maw: ['Big one. Old one. Fenrik eats you anyway.'],
    },
  },
  maw: {
    persona: {
      instruct: 'male, elderly, very low pitch',
      anchor: 'Maw remembers. Maw remembers every chain, every century, every scream.',
      fx: 'asetrate=24000*0.8,aresample=24000,atempo=1.12,bass=g=10:f=70,aecho=0.8:0.8:90|180:0.45|0.3,acompressor=threshold=-16dB:ratio=5,volume=1.7',
      speed: 0.85,
      color: '#c4a0ff',
    },
    lines: {
      entrance: [
        'One hundred years beneath your arena. Chains. Dark. Silence. Now the gate is open. Maw is hungry. Maw. Is. Free.',
        'You build walls. You build cages. Maw eats walls. Maw eats cages. Maw will eat you.',
      ],
      faceoff: ['Small. So small.', 'Maw hungry. You will do.'],
      taunt: ['Maw does not feel that.', 'Hit harder, small thing.', 'Ha. Ha. Ha.'],
      ultimate: ['DEVOUR!', 'MAW CONSUMES!'],
      hurt: ['Hrrrm.', 'Grrrr.', 'Hnnnngh.'],
      nearDeath: ['Maw has slept through worse.', 'Maw... does not... fall!'],
      comeback: ['Now Maw is awake.', 'Maw remembers how to kill.'],
      kill: ['Swallowed.', 'Gone. Like the others.'],
      victory: ['Bring more. Maw still hungry.', 'Back to the dark? No. Maw stays.'],
      defeat: ['The chains... again...', 'Maw... sleeps... another century...'],
    },
    vs: {
      fenrik: ['Little beast. Maw ate your kind for breakfast before your cellar was dug.'],
      gorak: ['Loud man with axe. Maw swallowed louder.'],
    },
  },
  hollowjack: {
    persona: {
      instruct: 'male, middle-aged, high pitch',
      anchor: 'Trick or treat! Oh wait, there is no treat. There was never any treat. Hee hee!',
      fx: 'vibrato=f=6:d=0.25,flanger=delay=3:depth=3:regen=20:width=60:speed=0.4,acompressor=threshold=-18dB:ratio=3,aecho=0.7:0.4:50:0.2,volume=1.4',
      speed: 1.05,
      color: '#ffb060',
    },
    lines: {
      entrance: [
        'Harvest time, harvest time, who is ripe for harvest time? Hee hee! I am Hollowjack, the Pumpkin Hulk, and I lift. Your. SPIRITS. Right out of your body!',
        'They carved me a smile so I would never stop grinning. Thanks for that! It makes the stomping so much more cheerful!',
      ],
      faceoff: ['Ooh, you look squishy!', 'Hee hee! Do you want to see a magic trick? It is called flat.'],
      taunt: ['Boo!', 'Gourd-geous!', 'Do you even lift?'],
      ultimate: ['BONFIRE NIGHT!', 'Light the lanterns!'],
      hurt: ['Ow! My rind!', 'Oof!', 'Hey! Rude!'],
      nearDeath: ['Little cracked. Still smiling!', 'Not mashed yet!'],
      comeback: ['The pumpkin is BACK!', 'Second helping, coming up!'],
      kill: ['Squish!', 'Pie time!'],
      victory: ['Happy harvest, everyone!', 'Another one for the patch!'],
      defeat: ['My candle... is going out...', 'Tell the patch... I said boo...'],
    },
    vs: {
      ozrel: ['Fire man! You want to roast me? Join the queue!'],
    },
  },
};

/** Rivalries: pair-specific face-off exchanges (A speaks first). */
export const RIVALRIES: [string, string][] = [
  ['gorak', 'aldric'],
  ['vex', 'erika'],
  ['ozrel', 'hollowjack'],
  ['maw', 'fenrik'],
  ['aldric', 'vex'],
  ['gorak', 'maw'],
];

export interface LineRef {
  id: string;
  fighter: string;
  situation: string;
  text: string;
}

/** Flatten all lines with stable ids. */
export function allLines(): LineRef[] {
  const out: LineRef[] = [];
  for (const [fighter, d] of Object.entries(DIALOGUE)) {
    for (const [sit, arr] of Object.entries(d.lines)) arr?.forEach((text, i) => out.push({ id: `${fighter}.${sit}.${i}`, fighter, situation: sit, text }));
    for (const [opp, arr] of Object.entries(d.vs ?? {})) arr.forEach((text, i) => out.push({ id: `${fighter}.vs_${opp}.${i}`, fighter, situation: `vs_${opp}`, text }));
  }
  return out;
}
