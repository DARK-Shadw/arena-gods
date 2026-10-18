// Arena sky build (milestone A7c): an authored sky spec -> shipped files.
//   node tools/arena/build_sky.mjs [--id=moongate] [--formats=ktx2,webp] [--no-compose]        (npm run arena:sky)
// 1. tools/arena/sky_compose.py --spec tools/arena/sky/<id>.json (numpy + OpenCV + Pillow, about 10 s, about 1.5 GB):
//    the CC0 HDRI(s) -> the band data texture (R structure, G density, B rim potential, A moon shafts) per tier +
//    layout.json (palette ramp sampled from the concept image, look) + a by-eye preview from the concept camera.
// 2. Encodes each tier PNG as KTX2 (UASTC + zstd, linear RGBA, mips: `dataA`) and WebP (quality 95, RGBA).
// 3. Writes public/arena/sky/<id>/sky.json (what ArenaAssets.loadSky + sky.ts read: palette, look, per-tier texture,
//    GPU MB) and registers it in public/arena/manifest.json under `skies` (check_budget.mjs adds its GPU memory per tier
//    and checks the download caps); fills `usedBy` of the source rows in public/arena/credits.json.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ktxEncode, pillow } from './build_assets.mjs';
import { readLedger, writeLedger } from './fetch_cc0.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const ID = opt('id', 'moongate');
const FORMATS = opt('formats', 'ktx2,webp').split(',');
const SPEC = path.join(ROOT, 'tools', 'arena', 'sky', `${ID}.json`);
const WORK = path.join(ROOT, 'tools', 'arena', '_work', 'sky', ID);
const PUB = path.join(ROOT, 'public', 'arena');
const OUT = path.join(PUB, 'sky', ID);
const PY = process.env.PYTHON || 'python';
const PY_WEBP = 'import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert("RGBA");im.save(sys.argv[2],"WEBP",quality=int(sys.argv[3]),method=6,exact=True);print(im.size[0],im.size[1])';

function compose() {
  const t = Date.now();
  const r = spawnSync(PY, ['tools/arena/sky_compose.py', '--spec', SPEC, '--out', WORK], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`sky_compose.py failed:\n${r.stderr}`);
  console.log(`compose ${((Date.now() - t) / 1000).toFixed(1)} s\n${r.stdout.trim()}`);
}

function main() {
  if (!args.includes('--no-compose')) compose();
  const L = JSON.parse(fs.readFileSync(path.join(WORK, 'layout.json'), 'utf8'));
  const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const out = {
    _doc: 'Arena authored sky (tools/arena/build_sky.mjs from tools/arena/sky/<id>.json, milestone A7c). Loaded by ArenaAssets.loadSky, drawn by src/render/arena/sky.ts (skyTex). Band: u = 0.5 + az / 360 (game azimuth atan2(z, x)), v = 1 - (dir.y + 0.1) / 1.1 (row 0 = zenith). Channels (linear): R cloud structure, G density, B rim potential, A moon shafts. palette = 6 linear RGB ramp stops (dark -> bright); look = the lighting (sky.ts SkyLook).',
    id: ID,
    source: L.source,
    sources: [spec.source.asset, ...(spec.back ? [spec.back.asset] : [])].filter((v, i, a) => a.indexOf(v) === i),
    moon: L.moon,
    palette: L.palette,
    look: spec.look,
    tiers: {},
  };
  const files = [`sky/${ID}/sky.json`];
  for (const [tier, [w, h]] of Object.entries(L.tiers)) {
    const png = path.join(WORK, tier, 'sky.png');
    const tex = {};
    let dl = 0;
    for (const fmt of FORMATS) {
      const rel = `${tier}/sky.${fmt}`;
      const dst = path.join(OUT, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (fmt === 'ktx2') ktxEncode(png, dst, 'dataA');
      else pillow(PY_WEBP, png, dst, '95');
      tex[fmt] = `sky/${ID}/${rel}`;
      files.push(tex[fmt]);
      if (fmt === 'ktx2') dl = fs.statSync(dst).size;
    }
    // GPU: UASTC transcodes to BC7 / ASTC 4x4 (1 B/px) + 1/3 for the mips
    out.tiers[tier] = { size: [w, h], tex, gpuMB: +((w * h * (4 / 3)) / 2 ** 20).toFixed(2), downloadMB: +(dl / 2 ** 20).toFixed(2) };
  }
  fs.writeFileSync(path.join(OUT, 'sky.json'), JSON.stringify(out, null, 1) + '\n');
  const manPath = path.join(PUB, 'manifest.json');
  const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
  man.skies ??= {};
  man.skies[ID] = { json: `sky/${ID}/sky.json`, files, sources: out.sources, tiers: Object.fromEntries(Object.entries(out.tiers).map(([t, v]) => [t, { gpuMB: v.gpuMB, downloadMB: v.downloadMB }])) };
  fs.writeFileSync(manPath, JSON.stringify(man, null, 1) + '\n');
  const led = readLedger();
  for (const s of out.sources) {
    const row = led.assets[s];
    if (!row) throw new Error(`${s} is not in public/arena/credits.json (fetch it with tools/arena/fetch_cc0.mjs)`);
    if (!row.usedBy.includes(`sky/${ID}`)) row.usedBy.push(`sky/${ID}`);
  }
  writeLedger(led);
  console.log(`sky/${ID}: ${files.length} files`, JSON.stringify(man.skies[ID].tiers));
}

try {
  main();
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
