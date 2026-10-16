/**
 * Export dialogue lines as TTS jobs (audio-src/tts/jobs.json).
 *   npx tsx tools/tts/export-lines.ts [--subset first]
 * Each job carries a hash of (text, voice persona, engine) so re-runs only
 * regenerate lines that changed.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { allLines, DIALOGUE } from '../../src/data/dialogue';

const subset = process.argv.includes('--subset') ? process.argv[process.argv.indexOf('--subset') + 1] : '';
const ENGINE = process.env.TTS_ENGINE ?? 'omnivoice';
const lines = allLines().filter((l) => subset !== 'first' || l.situation === 'entrance' || l.situation === 'victory');
const jobs = lines.map((l) => {
  const p = DIALOGUE[l.fighter].persona;
  const hash = createHash('sha1').update(JSON.stringify([ENGINE, l.text, p.instruct, p.anchor, p.speed])).digest('hex').slice(0, 16);
  return { ...l, instruct: p.instruct, anchor: p.anchor, speed: p.speed, fx: p.fx, hash };
});
mkdirSync('audio-src/tts', { recursive: true });
writeFileSync('audio-src/tts/jobs.json', JSON.stringify(jobs, null, 1));
console.log(`[tts] exported ${jobs.length} jobs (${subset || 'all'}) for engine ${ENGINE}`);
