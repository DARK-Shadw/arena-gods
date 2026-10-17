// FX asset budget + licence-ledger gate (plan §4.1).
//   node tools/fx/check_budget.mjs          -> table, exit 1 when over budget or a file has no ledger row
// Budgets: download <= 6 MB (all files in public/fx), GPU memory <= 48 MB (high) / 24 MB (low).
// GPU estimate: RGBA8 = 4 B/px for WebP-decoded textures, KTX2 UASTC = 1 B/px, ETC1S ~0.5 B/px,
// x 4/3 for mipmaps. The tier picks `full` (high/medium) or `low` (low tier) and the format
// in manifest.format ('webp' or 'ktx2').
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUB = path.join(ROOT, 'public', 'fx');
const MB = 1024 * 1024;
const BUDGET = { download: 6 * MB, high: 48 * MB, low: 24 * MB };

const m = JSON.parse(fs.readFileSync(path.join(PUB, 'atlas.json'), 'utf8'));
const ledger = fs.existsSync(path.join(PUB, 'credits.json')) ? JSON.parse(fs.readFileSync(path.join(PUB, 'credits.json'), 'utf8')) : {};
const useKtx = m.format === 'ktx2';
const bpp = (t) => (useKtx && t.ktx2 ? (t.ktx2Encoding === 'etc1s' ? 0.5 : 1) : 4);
const vram = (t) => (t ? t.w * t.h * bpp(t) * (4 / 3) : 0);

// 'core' atlases are loaded at session start and must fit the budget; 'alt' ones are shipped but
// loaded on demand (FX Lab comparisons, rare effects): reported, and the largest alt atlas is
// added on top as the worst case of one extra atlas being live.
let high = 0, low = 0, altHigh = 0, altLow = 0, altMax = 0, altMaxLow = 0;
const rows = [];
for (const [id, e] of Object.entries(m.atlases)) {
  const extra = vram(e.mv) + vram(e.data);
  const h = vram(e.full) + extra;
  const l = vram(e.low || e.full) + (e.mv ? vram(e.mv) / 4 : 0) + (e.data ? vram(e.data) / 4 : 0);
  const set = e.set || 'core';
  if (set === 'core') { high += h; low += l; } else { altHigh += h; altLow += l; altMax = Math.max(altMax, h); altMaxLow = Math.max(altMaxLow, l); }
  rows.push([id, set, `${e.full.w}x${e.full.h}`, e.low ? `${e.low.w}x${e.low.h}` : '-', (h / MB).toFixed(2), (l / MB).toFixed(2)]);
}
high += altMax; low += altMaxLow;
let dl = 0;
const files = fs.readdirSync(PUB).filter((f) => !f.startsWith('.'));
const missing = [];
for (const f of files) {
  dl += fs.statSync(path.join(PUB, f)).size;
  if (/\.(webp|ktx2|png)$/i.test(f) && !ledger[f]) missing.push(f);
}
console.log('id'.padEnd(26), 'set'.padEnd(5), 'full'.padEnd(10), 'low'.padEnd(10), 'GPU high MB', ' GPU low MB');
for (const r of rows) console.log(r[0].padEnd(26), r[1].padEnd(5), r[2].padEnd(10), r[3].padEnd(10), r[4].padStart(11), r[5].padStart(11));
console.log(`\nformat: ${useKtx ? 'KTX2 (Basis)' : 'WebP (decoded to RGBA8 on the GPU)'}`);
console.log(`download: ${(dl / MB).toFixed(2)} MB of ${BUDGET.download / MB} MB (${files.length} files in public/fx)`);
console.log(`GPU high (core + largest alt): ${(high / MB).toFixed(1)} MB of ${BUDGET.high / MB} MB;  GPU low: ${(low / MB).toFixed(1)} MB of ${BUDGET.low / MB} MB`);
console.log(`alt atlases (on demand, all of them): ${(altHigh / MB).toFixed(1)} MB high / ${(altLow / MB).toFixed(1)} MB low`);
let bad = false;
if (dl > BUDGET.download) { console.log('FAIL: download over budget'); bad = true; }
if (high > BUDGET.high) { console.log('FAIL: GPU memory (high) over budget'); bad = true; }
if (low > BUDGET.low) { console.log('FAIL: GPU memory (low) over budget'); bad = true; }
if (missing.length) { console.log('FAIL: no licence ledger row for:', missing.join(', ')); bad = true; }
console.log(bad ? 'BUDGET CHECK FAILED' : 'budget check passed');
process.exit(bad ? 1 : 0);
