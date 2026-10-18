// Fetch the clips listed in tools/anim/fetch-list.json from the Mixamo dataset into
// Assets/Animations/Mixamo_HF2/<category>/, sequentially, validating the FBX magic.
//   node tools/anim/fetch.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LIST = JSON.parse(fs.readFileSync(new URL('./fetch-list.json', import.meta.url), 'utf8'));
const DEST = 'C:/Programming/GameDev/Research/Assets/Animations/Mixamo_HF2';
const BASE = 'https://huggingface.co/datasets/Linzhan/Mixamo-Animations-Characters/resolve/main/animation_motion/';
const dry = process.argv.includes('--dry');
let total = 0,
  ok = 0,
  bad = [];
for (const [cat, items] of Object.entries(LIST)) {
  if (cat.startsWith('_')) continue;
  const dir = path.join(DEST, cat);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(items)) {
    const out = path.join(dir, name + '.fbx');
    if (!fs.existsSync(out) && !dry) {
      try {
        execFileSync('curl', ['-sSfL', '--retry', '2', '-o', out, BASE + encodeURIComponent(name) + '.fbx'], { stdio: 'pipe' });
      } catch (e) {
        bad.push(`${cat}/${name}: download failed`);
        continue;
      }
    }
    if (dry) continue;
    const head = fs.readFileSync(out).subarray(0, 18).toString('latin1');
    if (!head.startsWith('Kaydara FBX Binary')) {
      bad.push(`${cat}/${name}: not an FBX binary (removed)`);
      fs.unlinkSync(out);
      continue;
    }
    total += fs.statSync(out).size;
    ok++;
  }
}
console.log(`fetched/validated ${ok} clips, ${(total / 1048576).toFixed(1)} MB${bad.length ? '\nproblems:\n' + bad.join('\n') : ''}`);
