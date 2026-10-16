/** Verify shipped audio: every manifest entry exists, pools match, voice coverage. */
import { existsSync, readFileSync } from 'node:fs';
import { POOLS } from '../../src/data/sfx';
import { allLines } from '../../src/data/dialogue';

let bad = 0;
const sfx = JSON.parse(readFileSync('public/audio/sfx/manifest.json', 'utf8')) as Record<string, { file: string }[]>;
for (const pool of Object.keys(POOLS)) {
  if (!sfx[pool]?.length) { console.log(`MISSING pool ${pool}`); bad++; continue; }
  if (sfx[pool].length !== POOLS[pool].src.length) { console.log(`pool ${pool}: ${sfx[pool].length} files vs ${POOLS[pool].src.length} sources`); bad++; }
  for (const f of sfx[pool]) if (!existsSync(`public/audio/${f.file}`)) { console.log(`MISSING file ${f.file}`); bad++; }
}
if (!existsSync('public/audio/music/boss_battle.ogg')) { console.log('MISSING music'); bad++; }
const vPath = 'public/audio/voice/manifest.json';
const voice = existsSync(vPath) ? (JSON.parse(readFileSync(vPath, 'utf8')) as Record<string, { file: string; text: string }>) : {};
let missingVoice = 0, stale = 0;
for (const l of allLines()) {
  const v = voice[l.id];
  if (!v) { missingVoice++; continue; }
  if (!existsSync(`public/audio/${v.file}`)) { console.log(`MISSING voice file ${v.file}`); bad++; }
  if (v.text !== l.text) stale++;
}
console.log(`[check] sfx pools ${Object.keys(POOLS).length}, files ${Object.values(sfx).flat().length}; voice lines ${allLines().length}, voiced ${allLines().length - missingVoice}, stale ${stale}; errors ${bad}`);
process.exit(bad ? 1 : 0);
