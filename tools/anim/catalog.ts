/**
 * Builds docs/animation-catalog.json + docs/animation-catalog.md from the clip
 * analysis (tools/anim/analyze.ts output), the Mixamo dataset descriptions
 * (hf-scan/metadata.csv) and the current in-game usage (src/data/animsets.ts).
 *
 *   npx tsx tools/anim/catalog.ts <raw.json>
 *
 * Tagging is rule-based on the clip name + measured metrics; every rule is in
 * this file so the catalog can be regenerated after re-analysis.
 */
import * as fs from 'node:fs';
import { ANIMSETS } from '../../src/data/animsets';

const raw: Record<string, any> = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const META = 'C:/Programming/GameDev/Research/hf-scan/metadata.csv';

// ---------------------------------------------------------------- dataset descriptions
const desc: Record<string, string> = {};
for (const line of fs.readFileSync(META, 'utf8').split(/\r?\n/).slice(1)) {
  const m = line.match(/^animation\/([^,]+)\.fbx,([^,]*),([^,]*),/);
  if (m) desc[m[1]] = m[3];
}

// ---------------------------------------------------------------- in-game usage
const used: Record<string, string[]> = {};
for (const [fid, set] of Object.entries(ANIMSETS)) {
  for (const [logical, c] of Object.entries(set.clips)) {
    const k = c.src.replace(/^Animations\//, '');
    (used[k] ??= []).push(`${fid}.${logical}`);
  }
}

type Cat =
  | 'locomotion'
  | 'idle'
  | 'turn'
  | 'transition'
  | 'attack'
  | 'combo'
  | 'kick'
  | 'grapple'
  | 'finisher'
  | 'throw-prop'
  | 'block'
  | 'parry'
  | 'dodge'
  | 'hit-react'
  | 'knockdown'
  | 'getup'
  | 'death'
  | 'cast'
  | 'equip'
  | 'jump-fall'
  | 'emote'
  | 'talk'
  | 'victory-defeat'
  | 'cover'
  | 'misc';

const N = (k: string) => k.toLowerCase();
const has = (k: string, ...w: string[]) => w.some((x) => N(k).includes(x));

function stance(pack: string, name: string): string {
  if (pack === 'ProMeleeAxe') return has(name, 'unarmed') ? 'unarmed' : has(name, 'kick', 'react', 'idle', 'walk', 'run', 'turn', 'jump', 'crouch', 'block', 'taunt', 'disarm', 'equip') ? '1h-axe' : '1h-axe';
  if (pack === 'ProSwordandShield') return 'sword-shield';
  if (pack === 'ProLongbow') return 'bow';
  if (pack === 'ProMagic') return 'caster';
  if (pack === 'Creature') return 'creature';
  if (pack === 'ActionAdventure') return 'unarmed';
  if (has(name, 'great_sword', '2hand', 'two_hand_sword', 'two_handed')) return '2h-greatsword';
  if (has(name, 'two_hand_club', 'heavy_weapon')) return '2h-club';
  if (has(name, 'thrust')) return 'spear/2h';
  if (has(name, 'slash_advance', 'run_and_swing', 'withdrawing_sword', 'sheathing_sword')) return '1h-sword';
  if (has(name, 'sword_and_shield')) return 'sword-shield';
  if (has(name, 'knife')) return 'dagger/blade';
  if (has(name, 'torch')) return '1h-torch/club';
  if (has(name, 'one_hand_club')) return '1h-club';
  if (has(name, 'one_hand_sword', 'stable_sword')) return '1h-sword';
  if (has(name, 'dual_weapon', 'double_dagger')) return 'dual';
  if (has(name, 'zombie')) return 'zombie';
  if (has(name, 'bayonet', 'stabbing')) return 'dagger/blade';
  if (has(name, 'great_sword_casting', 'spell', 'magic', 'casting', 'charge')) return 'caster';
  return 'unarmed';
}

function category(path: string, name: string, m: any): Cat {
  const f = path.split('/')[1] ?? '';
  const n = N(name);
  if (path.startsWith('Mixamo_HF2')) {
    if (f === 'paired') return has(n, 'shaking_hands', 'spat', 'spit') ? 'emote' : has(n, 'strangl', 'bite', 'hostage', 'holding_down', 'restrain') ? 'finisher' : 'grapple';
    if (f === 'deaths') return 'death';
    if (f === 'reactions') return has(n, 'kip', 'waking') ? 'getup' : has(n, 'wall_crash', 'hit_by_car', 'tripping', 'edge_slip') ? 'knockdown' : 'hit-react';
    if (f === 'martial') return has(n, 'kick', 'sweep', 'armada', 'meia', 'martelo') ? 'kick' : 'attack';
    if (f === 'weapons') return has(n, 'draw', 'sheath', 'withdraw') ? 'equip' : has(n, 'power_up') ? 'emote' : has(n, 'combo') ? 'combo' : 'attack';
    if (f === 'idles_style') return 'idle';
    if (f === 'locomotion_style') return has(n, 'idle') ? 'idle' : has(n, 'turn') ? 'turn' : has(n, 'start', 'stop') ? 'transition' : 'locomotion';
    if (f === 'social') return has(n, 'nod', 'shake', 'gesture', 'turn', 'arguing') ? 'talk' : has(n, 'fist_pump', 'sad', 'kneel') ? 'victory-defeat' : 'emote';
    if (f === 'environment') return 'throw-prop';
    if (f === 'entrance') {
      if (has(n, 'jump', 'fall', 'climb', 'vault', 'emerg', 'float', 'flying')) return 'jump-fall';
      if (has(n, 'walk')) return 'locomotion';
      if (has(n, 'bang', 'bash', 'lever', 'door', 'kicking_out', 'smash')) return 'throw-prop';
      if (has(n, 'kneel', 'stand_up', 'bow')) return 'victory-defeat';
      return 'emote';
    }
  }
  if (path.startsWith('Mixamo_HF')) {
    if (f === 'finishers') return 'finisher';
    if (f === 'deaths') return 'death';
    if (f === 'dodges') return 'dodge';
    if (f === 'spells') return has(n, 'power_up') ? 'emote' : 'cast';
    if (f === 'grabs_throws') return has(n, 'lifting', 'pick_up', 'throw_object', 'throwing') || n === 'throw' ? 'throw-prop' : 'grapple';
    if (f === 'hit_reactions') {
      if (has(n, 'getting_up', 'stand_up')) return 'getup';
      if (has(n, 'fall', 'knocked', 'livershot', 'sweep', 'shoulder_hit_and_fall') || m.postureEnd === 'ground') return 'knockdown';
      if (has(n, 'block')) return 'block';
      return 'hit-react';
    }
    if (f === 'talk_gesture') {
      if (has(n, 'talking', 'pointing', 'beckoning', 'gesture')) return 'talk';
      if (has(n, 'victory', 'defeat', 'cheering', 'kneel', 'bow', 'praying', 'disappointed')) return 'victory-defeat';
      return 'emote';
    }
    if (f === 'brawler_kicks') return has(n, 'idle') ? 'idle' : has(n, 'kick') ? 'kick' : has(n, 'combo', 'cross', 'quad', 'jabs_to') ? 'combo' : 'attack';
    if (f === 'weapons_extra') {
      if (has(n, 'idle')) return 'idle';
      if (has(n, 'death')) return 'death';
      if (has(n, 'impact')) return 'hit-react';
      if (has(n, 'blocking')) return 'block';
      if (has(n, 'walk', 'run', 'strafe', 'crouching')) return 'locomotion';
      if (has(n, 'turn')) return 'turn';
      if (has(n, 'jump') && !has(n, 'attack')) return 'jump-fall';
      if (has(n, 'casting', 'power_up')) return 'cast';
      if (has(n, 'combo')) return 'combo';
      return 'attack';
    }
  }
  if (has(n, 'death', 'dying')) return 'death';
  if (has(n, 'react', 'impact')) return has(n, 'block') ? 'parry' : 'hit-react';
  if (has(n, 'block')) return 'block';
  if (has(n, 'dodge', 'dive')) return 'dodge';
  if (has(n, 'combo')) return 'combo';
  if (has(n, 'kick')) return 'kick';
  if (has(n, 'attack', 'slash', 'punch', 'swiping')) return n.includes('magic') ? 'cast' : 'attack';
  if (has(n, 'cast', 'magic')) return 'cast';
  if (has(n, 'draw', 'sheath', 'equip', 'disarm')) return 'equip';
  if (has(n, 'taunt', 'roar', 'flexing', 'power up', 'battlecry')) return 'emote';
  if (has(n, 'cover')) return 'cover';
  if (has(n, 'jump', 'fall', 'land')) return 'jump-fall';
  if (has(n, 'turn')) return 'turn';
  if (has(n, 'to standing', 'to crouch', 'to stop', 'run forward stop')) return 'transition';
  if (has(n, 'idle')) return 'idle';
  if (has(n, 'walk', 'run', 'sprint', 'strafe', 'sneak', 'crouch')) return 'locomotion';
  return 'misc';
}

/** paired-animation partner (aggressor/victim, A/B) */
const PAIRS: Record<string, { partner: string; role: 'aggressor' | 'victim'; note?: string }> = {
  Shoulder_Throw_Aggressor: { partner: 'Shoulder_Throw_Victim', role: 'aggressor' },
  Shoulder_Throw_Victim: { partner: 'Shoulder_Throw_Aggressor', role: 'victim' },
  Hell_Slammer_A: { partner: 'Hell_Slammer_B', role: 'aggressor' },
  Hell_Slammer_B: { partner: 'Hell_Slammer_A', role: 'victim' },
  Rockin_Shackle_A: { partner: 'Rockin_Shackle_B', role: 'aggressor' },
  Rockin_Shackle_B: { partner: 'Rockin_Shackle_A', role: 'victim' },
  Brutal_Assassination_2: { partner: 'Brutal_Assassination', role: 'aggressor', note: 'measured: _2 stays standing, base clip falls (victim)' },
  Brutal_Assassination: { partner: 'Brutal_Assassination_2', role: 'victim' },
  Stealth_Assassination_2: { partner: 'Stealth_Assassination', role: 'aggressor', note: 'measured: base clip ends on the ground (victim)' },
  Stealth_Assassination: { partner: 'Stealth_Assassination_2', role: 'victim' },
  'Double_Leg_Takedown_-_Attacker': { partner: 'Double_Leg_Takedown_-_Victim (NOT OWNED: fetch)', role: 'aggressor' },
  'Double_Leg_Takedown_-_Attacker_2': { partner: 'Double_Leg_Takedown_-_Victim_2 (NOT OWNED: fetch)', role: 'aggressor' },
  Flying_Shoulder_Throw: { partner: 'Getting_Thrown (approximate, unsynced)', role: 'aggressor' },
  Getting_Thrown: { partner: 'Flying_Shoulder_Throw / Grab_And_Slam (approximate)', role: 'victim' },
  Kick_To_The_Groin_2: { partner: 'any front kick via contact warp', role: 'victim', note: 'measured: doubles over. The whole dataset series is receivers, and no kicker clip exists.' },
};

const PAIRS2: Record<string, { partner: string; role: 'aggressor' | 'victim'; note?: string }> = {
  'Double_Leg_Takedown_-_Victim': { partner: 'Double_Leg_Takedown_-_Attacker', role: 'victim' },
  'Double_Leg_Takedown_-_Victim_2': { partner: 'Double_Leg_Takedown_-_Attacker_2', role: 'victim' },
  Kick_To_The_Groin: { partner: 'any front kick via contact warp', role: 'victim', note: 'measured: receiver (doubles over)' },
  Kick_To_The_Groin_3: { partner: 'any front kick via contact warp', role: 'victim', note: 'measured: receiver that collapses' },
  Fist_Fight_A: { partner: 'Fist_Fight_B', role: 'aggressor', note: 'mutual exchange' },
  Fist_Fight_B: { partner: 'Fist_Fight_A', role: 'victim', note: 'mutual exchange' },
  Strangling: { partner: 'Being_Strangled', role: 'aggressor' },
  Being_Strangled: { partner: 'Strangling', role: 'victim' },
  'Taken_Hostage_-_Villain': { partner: 'Taken_Hostage_-_Victim', role: 'aggressor' },
  'Taken_Hostage_-_Victim': { partner: 'Taken_Hostage_-_Villain', role: 'victim' },
  'Release_Hostage_-_Villain': { partner: 'Release_Hostage_-_Hostage', role: 'aggressor' },
  'Release_Hostage_-_Hostage': { partner: 'Release_Hostage_-_Villain', role: 'victim' },
  Vampiric_Bite: { partner: 'Getting_Bit (approximate)', role: 'aggressor' },
  Getting_Bit: { partner: 'Zombie_Neck_Bite / Vampiric_Bite (approximate)', role: 'victim' },
  Shaking_Hands_1: { partner: 'Shaking_Hands_2', role: 'aggressor', note: 'mutual' },
  Shaking_Hands_2: { partner: 'Shaking_Hands_1', role: 'victim', note: 'mutual' },
  Spat_In_Face: { partner: 'Spit_Reaction', role: 'aggressor' },
  Spit_Reaction: { partner: 'Spat_In_Face', role: 'victim' },
};

function uses(cat: Cat, st: string, m: any, name: string): string[] {
  const n = N(name);
  const u: string[] = [];
  switch (cat) {
    case 'attack':
    case 'combo':
    case 'kick':
      u.push(`${st} moveset (${m.strike.eff} strike @${m.strike.t}s)`);
      if (m.root.dist > 1) u.push('gap-closer / lunge (has root travel: drive sim lunge from it)');
      if (m.eff.LeftFoot.lift > 1.1 || m.eff.RightFoot.lift > 1.1) u.push('high kick / launcher read');
      break;
    case 'finisher':
      u.push('finisher / execution (paired or solo)');
      break;
    case 'grapple':
      u.push('grab / throw / takedown (paired)');
      break;
    case 'hit-react':
      u.push('hit reaction pool (direction/height/severity tagged by name)');
      break;
    case 'knockdown':
      u.push('knockdown / launch reaction (pair with a get-up)');
      break;
    case 'getup':
      u.push('get-up variant (start pose must match the knockdown end pose)');
      break;
    case 'death':
      u.push('death pool (direction from name + measured fall direction)');
      break;
    case 'dodge':
      u.push(m.root.dist > 0.8 ? `dodge with travel ${m.root.dist}m (dir dx ${m.root.dx}, dz ${m.root.dz})` : 'in-place evade / duck');
      break;
    case 'cast':
      u.push(`spell cast (${m.strike.eff} release @${m.strike.t}s)`);
      break;
    case 'talk':
      u.push('dialogue gesture layer (upper body)');
      break;
    case 'emote':
      u.push(has(n, 'taunt', 'yell', 'threat', 'roar') ? 'taunt / intimidation beat' : 'emote');
      break;
    case 'victory-defeat':
      u.push(has(n, 'defeat', 'disappoint', 'kneel', 'pray') ? 'defeat / submission / kneel' : 'victory / crowd pose');
      break;
    case 'throw-prop':
      u.push('environment: lift / carry / throw props');
      break;
    case 'locomotion':
    case 'idle':
    case 'turn':
    case 'transition':
      u.push(`${st} locomotion set`);
      break;
    case 'block':
    case 'parry':
      u.push('defence');
      break;
    case 'jump-fall':
      u.push('air: entrances (drop-in, landing), launches');
      break;
    case 'equip':
      u.push('entrance / weapon presentation beat');
      break;
  }
  return u;
}

const ROLE_BY_STANCE: Record<string, string[]> = {
  '1h-axe': ['gorak', 'heavy 1h brutes (Warrok, Pirate, Castle_Guard)'],
  'sword-shield': ['aldric', 'Knight_D_Pelegrini', 'Castle_Guard_01/02', 'Heraklios'],
  bow: ['erika', 'Eve', 'Nightshade (bow variant)'],
  caster: ['ozrel', 'Ganfaul', 'Medea', 'Uriel', 'Demon (fire)'],
  creature: ['fenrik', 'maw', 'Warrok', 'Parasite', 'Demon'],
  unarmed: ['hollowjack', 'vex', 'everyone (bare-hand finishers, brawling)'],
  '2h-greatsword': ['Knight_D_Pelegrini', 'Heraklios', 'Uriel', 'Akai'],
  '1h-sword': ['aldric (shield off)', 'Kachujin', 'Pirate'],
  '1h-club': ['Goblin', 'Prisoner', 'Whiteclown'],
  '1h-torch/club': ['Goblin', 'Prisoner', 'Skeletonzombie'],
  dual: ['Nightshade', 'Akai', 'Kachujin'],
  zombie: ['Skeletonzombie', 'Parasite'],
  'dagger/blade': ['vex', 'Nightshade', 'Whiteclown'],
  '2h-club': ['Warrok', 'maw (weapon variant)', 'Goblin'],
  'spear/2h': ['Heraklios', 'Knight_D_Pelegrini'],
};

const rows: any[] = [];
for (const [path, m] of Object.entries(raw)) {
  if (m.error) {
    rows.push({ id: path, error: m.error });
    continue;
  }
  const pack = path.split('/')[0];
  const name = path.split('/').pop()!.replace(/\.fbx$/i, '');
  const cat = category(path, name, m);
  const st = stance(pack, name);
  const asym = Math.max(Math.abs(m.asymHands), Math.abs(m.asymFeet));
  const pair = PAIRS[name] ?? PAIRS2[name];
  const usedBy = used[path] ?? used[path.replace(/\.fbx$/, '') + '.fbx'];
  const contact = (() => {
    // the frame where the clip "does its thing"
    if (['attack', 'combo', 'kick', 'cast', 'grapple', 'finisher'].includes(cat)) return { strike: m.strike.t, eff: m.strike.eff, reachMax: Math.max(m.eff.LeftHand.reach, m.eff.RightHand.reach, m.eff.LeftFoot.reach, m.eff.RightFoot.reach) };
    if (['death', 'knockdown'].includes(cat)) return { groundBy: m.postureEnd === 'ground' ? 'ends on ground' : 'ends ' + m.postureEnd };
    if (cat === 'throw-prop') return { release: m.eff.RightHand.peakT };
    return undefined;
  })();
  rows.push({
    id: path,
    name,
    pack,
    desc: desc[name] ?? undefined,
    cat,
    stance: st,
    dur: m.dur,
    frames30: m.frames,
    loop: m.loop.loopable && ['locomotion', 'idle'].includes(cat),
    returnsToStart: m.loop.loopable,
    loopDist: m.loop.dist,
    root: m.root,
    inPlace: m.inPlace,
    posture: `${m.postureStart}>${m.postureEnd}${m.postureMin !== m.postureStart && m.postureMin !== m.postureEnd ? ' (via ' + m.postureMin + ')' : ''}`,
    airborne: m.airborne,
    contact,
    handedness: Math.abs(m.asymHands) > 0.2 ? (m.asymHands > 0 ? 'right-hand' : 'left-hand') : 'both/none',
    footedness: Math.abs(m.asymFeet) > 0.2 ? (m.asymFeet > 0 ? 'right-foot' : 'left-foot') : 'both/none',
    mirrorable: asym > 0.25 ? 'yes: asymmetric, mirror = opposite-side variant' : 'symmetric-ish (mirror adds little)',
    pair: pair ? { ...pair } : undefined,
    roles: ROLE_BY_STANCE[st] ?? [],
    uses: uses(cat, st, m, name),
    inGame: usedBy ?? undefined,
  });
}
rows.sort((a, b) => (a.cat ?? '').localeCompare(b.cat ?? '') || a.id.localeCompare(b.id));
fs.writeFileSync('docs/animation-catalog.json', JSON.stringify({ generated: 'tools/anim/analyze.ts + tools/anim/catalog.ts', units: 'seconds, metres; Mixamo +Z forward', clips: rows }, null, 1));

// ---------------------------------------------------------------- markdown
const byCat: Record<string, any[]> = {};
for (const r of rows) (byCat[r.cat ?? 'error'] ??= []).push(r);
let md = `# Animation catalog\n\nEvery animation clip we own: ${rows.length} clips (${rows.filter((r) => r.pack === 'Mixamo_HF').length} Mixamo_HF, ${rows.filter((r) => r.pack === 'Mixamo_HF2').length} Mixamo_HF2 (fetched this round), ${rows.filter((r) => !String(r.pack).startsWith('Mixamo')).length} original packs).\n`;
md += `The data is measured from the FBX files by \`tools/anim/analyze.ts\` and tagged by \`tools/anim/catalog.ts\`. The machine-readable version is \`docs/animation-catalog.json\`, which also carries start and end poses, contacts and per-effector peaks.\n\n`;
md += `**Columns:**\n- **dur**: seconds.\n- **root**: hips travel in metres (dz forward, dx sideways); yaw is the turn in degrees. \`·\` means in place.\n- **posture**: start>end posture.\n- **strike/contact**: the fastest effector and its time. For deaths and knockdowns it is the end posture.\n- **L**: loopable cycle (locomotion or idle whose start and end poses match).\n- **M**: asymmetric, so a mirrored copy gives a distinct opposite-side variant.\n- **used**: current in-game use.\n\n`;
md += `| category | clips | in game |\n|---|---|---|\n`;
for (const [c, list] of Object.entries(byCat)) md += `| ${c} | ${list.length} | ${list.filter((r) => r.inGame).length} |\n`;
for (const [c, list] of Object.entries(byCat)) {
  md += `\n## ${c} (${list.length})\n\n| clip | stance | dur | root | posture | strike / contact | L | M | used |\n|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of list) {
    if (r.error) {
      md += `| ${r.id} | error: ${r.error} |||||||| \n`;
      continue;
    }
    const root = r.inPlace ? '·' : `dz ${r.root.dz} dx ${r.root.dx}${Math.abs(r.root.yaw) > 20 ? ' yaw ' + r.root.yaw : ''}`;
    const ct = r.contact ? (r.contact.strike !== undefined ? `${r.contact.eff} @${r.contact.strike}` : r.contact.release !== undefined ? `release @${r.contact.release}` : r.contact.groundBy) : '';
    const pair = r.pair ? ` ⇄ ${r.pair.role}` : '';
    md += `| ${r.pack === 'Mixamo_HF' ? 'HF/' + r.id.split('/')[1] + '/' : r.pack === 'Mixamo_HF2' ? 'HF2/' + r.id.split('/')[1] + '/' : r.pack + '/'}${r.name}${pair} | ${r.stance} | ${r.dur} | ${root} | ${r.posture} | ${ct} | ${r.loop ? 'L' : ''} | ${r.mirrorable.startsWith('yes') ? 'M' : ''} | ${r.inGame ? r.inGame.slice(0, 2).join(', ') + (r.inGame.length > 2 ? ` +${r.inGame.length - 2}` : '') : ''} |\n`;
  }
}
md += `
## Gap analysis vs the dataset (2,317 clips)

What the owned packs lacked, and how it was closed. The 159 clips fetched into \`Mixamo_HF2/\` are listed with reasons in \`tools/anim/fetch-list.json\`.

| Gap in owned packs | Closed by (HF2) | Still missing |
|---|---|---|
| Victim halves of paired clips (takedown, strangle, hostage, bite) | paired/* (21) | No groin-kick *kicker* exists in the dataset (contact-warp a front kick); Flying_Shoulder_Throw has no synced victim |
| Ledge drops, vaults, climbs, emerges, gate interaction (Gorak / Vex fixes) | entrance/* (31) | No true flying-descent-to-land; use Floating + Jumping_Down from a validated perch |
| Character gaits, injured / tired / dizzy sets, starts / stops / pivots | locomotion_style/* (22), idles_style/* (11) | Strafe sets for most styles (fall back to the stance's strafes) |
| Launchers, sweeps, clinch knees and elbows, capoeira | martial/* (15) | - |
| Spear, 2h club, draw / sheathe | weapons/* (13) | Dedicated dual-dagger and staff movesets (use Dual_Weapon_Combo and caster clips) |
| Wall slam, launch, edge teeter / slip, electrocution, kip-ups | reactions/* (14) | Directional knockdowns from left / right (mirror) |
| More deaths, KO collapses | deaths/* (9) | Possible later: more Dying_* / Standing_Death_* |
| Talk accents, crowd rally, defeat kneel | social/* (14) | Lip-sync (no jaw bones or blendshapes on the rigs) |
| Push / pull / carry poses | environment/* (9) | - |
`;
fs.writeFileSync('docs/animation-catalog.md', md);
console.log('rows', rows.length, Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, v.length])));
