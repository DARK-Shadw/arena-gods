// Optional KTX2 (Basis Universal) encoding of the FX atlases (plan §2.2 / §4.1).
//   node tools/fx/encode_ktx2.mjs            -> detects `toktx`; encodes when present, else reports WebP-only
//   node tools/fx/encode_ktx2.mjs --off      -> force WebP-only (manifest.format = 'webp')
// Needs KTX-Software 4.x `toktx` on PATH (https://github.com/KhronosGroup/KTX-Software/releases).
// Inputs are the lossless PNG intermediates in tools/fx/_work/ written by pack_atlas / ingest / decals.
// Encoding: UASTC + zstd for flipbooks, channel-packed masks, noise, normals/data;
//           ETC1S for the decal colour atlas. The WebP files stay as the fallback.
// When KTX2 is produced, the three.js Basis transcoder is copied to public/basis/ (KTX2Loader path).
// Note (KTX-Software 4.3): Basis output is not bit-identical across machines: never hash .ktx2 in tests.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUB = path.join(ROOT, 'public', 'fx');
const WORK = path.join(ROOT, 'tools', 'fx', '_work');
const MAN = path.join(PUB, 'atlas.json');
const m = JSON.parse(fs.readFileSync(MAN, 'utf8'));

function findToktx() {
  try {
    const v = execFileSync('toktx', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return v.trim();
  } catch { return null; }
}

const off = process.argv.includes('--off');
const ver = off ? null : findToktx();
if (!ver) {
  m.format = 'webp';
  m.ktx2 = { available: false, reason: off ? 'disabled with --off' : 'toktx not found on PATH', checked: new Date().toISOString().slice(0, 10) };
  for (const e of Object.values(m.atlases)) for (const k of ['full', 'low', 'mv', 'data']) if (e[k]) { delete e[k].ktx2; delete e[k].ktx2Encoding; }
  fs.writeFileSync(MAN, JSON.stringify(m, null, 1));
  console.log(`KTX2: ${m.ktx2.reason} -> WebP only (format = webp). Install KTX-Software and re-run to enable.`);
  process.exit(0);
}
console.log('KTX2: using', ver);
const ledger = JSON.parse(fs.readFileSync(path.join(PUB, 'credits.json'), 'utf8'));
for (const [id, e] of Object.entries(m.atlases)) {
  for (const k of ['full', 'low', 'mv', 'data']) {
    const t = e[k];
    if (!t) continue;
    const png = path.join(WORK, t.file.replace(/\.webp$/, '.png'));
    if (!fs.existsSync(png)) { console.log(`  skip ${t.file}: no PNG intermediate (re-run the packer)`); continue; }
    const out = t.file.replace(/\.webp$/, '.ktx2');
    const linear = k === 'mv' || k === 'data' || e.colorSpace === 'linear';
    const etc1s = e.type === 'decals' && (k === 'full' || k === 'low');
    const args = ['--t2', '--genmipmap', '--target_type', 'RGBA', '--assign_oetf', linear ? 'linear' : 'srgb'];
    if (etc1s) args.push('--encode', 'etc1s', '--clevel', '4', '--qlevel', '220');
    else args.push('--encode', 'uastc', '--uastc_quality', '2', '--zcmp', '18');
    execFileSync('toktx', [...args, path.join(PUB, out), png], { stdio: 'inherit' });
    t.ktx2 = out;
    t.ktx2Encoding = etc1s ? 'etc1s' : 'uastc';
    t.ktx2Bytes = fs.statSync(path.join(PUB, out)).size;
    if (ledger[t.file]) ledger[out] = { ...ledger[t.file], notes: (ledger[t.file].notes || '') + ' (KTX2 re-encode)' };
    console.log(`  ${out} ${(t.ktx2Bytes / 1024).toFixed(0)} KB (${t.ktx2Encoding})`);
  }
}
const basisSrc = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
const basisDst = path.join(ROOT, 'public', 'basis');
fs.mkdirSync(basisDst, { recursive: true });
for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) fs.copyFileSync(path.join(basisSrc, f), path.join(basisDst, f));
ledger['../basis/basis_transcoder.js'] = { source: 'three.js r170 examples/jsm/libs/basis', licence: 'Apache-2.0 (Binomial Basis Universal)', url: 'https://github.com/BinomialLLC/basis_universal', attribution: 'licence notice kept in the file', notes: '' };
fs.writeFileSync(path.join(PUB, 'credits.json'), JSON.stringify(ledger, null, 1));
m.format = 'ktx2';
m.ktx2 = { available: true, toktx: ver, transcoderPath: 'basis/' };
fs.writeFileSync(MAN, JSON.stringify(m, null, 1));
console.log('KTX2 done: manifest.format = ktx2 (WebP kept as fallback). Re-run check_budget.mjs.');
