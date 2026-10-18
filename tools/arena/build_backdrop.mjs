// Arena backdrop build (arena art plan 5.6 / 6.4 / 6.6, milestone A6): Blender panorama outputs -> shipped files.
//   node tools/arena/build_backdrop.mjs [--id=moongate] [--src=backdrop_moongate] [--inset=backdrop_moongate_inset]
//        [--cards=backdrop_cards] [--formats=ktx2,webp] [--preview=<dir>]          (npm run arena:backdrop)
// 1. tools/arena/backdrop_post.py (numpy + Pillow, run without -I): stitches strips, fills alpha-0 colour, derives the
//    cloud AOV, composites the medium / low layers, resizes per tier, builds the coarse depth grids (layout.json).
// 2. Encodes every PNG as KTX2 (`ktx create` directly, log checked: build_assets.mjs ktxEncode) and WebP (Pillow):
//    layer colour + hero inset ETC1S q220 sRGB with alpha (colorAhq), AOV masks ETC1S linear (data), cards colorA.
// 3. Writes public/arena/backdrop/<id>/backdrop.json (what src/render/arena/backdrop.ts loads: latitude band, origin,
//    per tier q0 / q1 / q2 the layers far -> near with texture files, depth grid file, grid size, AOV channels used,
//    the hero inset with its camera, the card atlases) and registers it in public/arena/manifest.json under
//    `backdrops` (check_budget.mjs measures the files and adds their GPU memory to the kit's per tier).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ktxEncode, pillow } from './build_assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BAKE = path.join(ROOT, 'tools', 'arena', '_bake');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const ID = opt('id', 'moongate');
const SRC = path.join(BAKE, opt('src', `backdrop_${ID}`));
const INSET = path.join(BAKE, opt('inset', `backdrop_${ID}_inset`));
const CARDS = path.join(BAKE, opt('cards', 'backdrop_cards'));
const FORMATS = opt('formats', 'ktx2,webp').split(',');
const WORK = path.join(ROOT, 'tools', 'arena', '_work', 'backdrop', ID);
const PUB = path.join(ROOT, 'public', 'arena');
const OUT = path.join(PUB, 'backdrop', ID);
const PY = process.env.PYTHON || 'python';
const PY_WEBP = 'import sys;from PIL import Image;im=Image.open(sys.argv[1]);im=im.convert("RGBA" if sys.argv[-1]=="A" else "RGB");im.save(sys.argv[2],"WEBP",quality=int(sys.argv[3]),method=6);print(im.size[0],im.size[1])';

function post() {
  const a = ['tools/arena/backdrop_post.py', '--src', SRC, '--out', WORK];
  if (fs.existsSync(path.join(INSET, 'inset_color.png'))) a.push('--inset', INSET);
  if (fs.existsSync(path.join(CARDS, 'result.json'))) a.push('--cards', CARDS);
  if (opt('preview', '')) a.push('--preview', opt('preview', ''));
  const t = Date.now();
  const r = spawnSync(PY, a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`backdrop_post.py failed:\n${r.stderr}`);
  console.log(`post-process ${((Date.now() - t) / 1000).toFixed(1)} s ${r.stdout.trim().slice(0, 300)}`);
  return JSON.parse(fs.readFileSync(path.join(WORK, 'layout.json'), 'utf8'));
}

/** encode one PNG in every format into OUT; returns {ktx2: rel, webp: rel} + byte counts */
function encode(png, base, kind, alpha) {
  const files = {};
  const bytes = {};
  for (const fmt of FORMATS) {
    const rel = `${base}.${fmt}`;
    const dst = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fmt === 'ktx2') ktxEncode(png, dst, kind);
    else pillow(PY_WEBP, png, dst, kind === 'data' ? '95' : '90', alpha ? 'A' : 'N');
    files[fmt] = `backdrop/${ID}/${rel}`;
    bytes[fmt] = fs.statSync(dst).size;
  }
  return { files, bytes };
}

const pngSize = (p) => {
  const b = fs.readFileSync(p);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

function main() {
  if (!fs.existsSync(path.join(SRC, 'backdrop_src.json'))) throw new Error(`no panorama render in ${SRC} (npm run arena:bake -- a6)`);
  const L = post();
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const out = {
    _doc: 'Arena backdrop (tools/arena/build_backdrop.mjs, plan 5.6). Loaded by src/render/arena/backdrop.ts. Panorama u = 0.5 + az / 360 (game azimuth, 0 = +x, + toward +z), v = 0 at latMax; depth grids: uint16 decimetres, (grid[1] + 1) rows x (grid[0] + 1) columns, row 0 = latMax.',
    id: ID,
    scene: L.scene,
    latMin: L.latMin,
    latMax: L.latMax,
    origin: L.origin,
    tiers: {},
    cards: {},
  };
  const stats = {};
  for (const [tier, T] of Object.entries(L.tiers)) {
    const td = path.join(WORK, tier);
    const layers = [];
    let gpu = 0;
    let bytes = 0;
    // far -> near (draw order)
    for (const l of [...T.layers].reverse()) {
      const c = encode(path.join(td, `${l.name}.png`), `${tier}/${l.name}`, 'colorAhq', true);
      const a = encode(path.join(td, `${l.name}_aov.png`), `${tier}/${l.name}_aov`, 'data', false);
      const dep = `${tier}/${l.name}_depth.bin`;
      fs.copyFileSync(path.join(td, `${l.name}_depth.bin`), path.join(OUT, dep));
      const cov = `${tier}/${l.name}_cover.bin`;
      fs.copyFileSync(path.join(td, `${l.name}_cover.bin`), path.join(OUT, cov));
      const [w, h] = pngSize(path.join(td, `${l.name}.png`));
      const [aw, ah] = pngSize(path.join(td, `${l.name}_aov.png`));
      // GPU: KTX2 ETC1S transcodes to BC7 / ETC2 RGBA on desktop: 1 B/px, + 1/3 mips
      gpu += (w * h + aw * ah) * (4 / 3);
      bytes += c.bytes.ktx2 + a.bytes.ktx2 + fs.statSync(path.join(OUT, dep)).size;
      layers.push({ name: l.name, size: [w, h], tex: c.files, aov: a.files, aovSize: [aw, ah], aovUsed: l.aovUsed, depth: `backdrop/${ID}/${dep}`, cover: `backdrop/${ID}/${cov}`, coverShare: l.cover, grid: l.grid, depthMin: l.depthMin, depthMax: l.depthMax });
    }
    const entry = { layers };
    if (T.inset) {
      const c = encode(path.join(td, 'inset.png'), `${tier}/inset`, 'colorAhq', true);
      gpu += T.inset.size[0] * T.inset.size[1] * (4 / 3);
      bytes += c.bytes.ktx2;
      entry.inset = { tex: c.files, size: T.inset.size, camera: T.inset.camera };
    }
    entry.gpuMB = +(gpu / 2 ** 20).toFixed(2);
    entry.downloadMB = +(bytes / 2 ** 20).toFixed(2);
    out.tiers[tier] = entry;
    stats[tier] = { gpuMB: entry.gpuMB, downloadMB: entry.downloadMB };
  }
  for (const [kind, c] of Object.entries(L.cards || {})) {
    const e = encode(path.join(WORK, `card_${kind}.png`), `card_${kind}`, 'colorA', true);
    out.cards[kind] = { tex: e.files, grid: c.grid, frames: c.frames, px: c.px };
    const [w, h] = pngSize(path.join(WORK, `card_${kind}.png`));
    // cards load on medium / high only
    for (const t of ['q1', 'q2']) if (out.tiers[t]) (out.tiers[t].gpuMB = +(out.tiers[t].gpuMB + (w * h * (4 / 3)) / 2 ** 20).toFixed(2)), (out.tiers[t].downloadMB = +(out.tiers[t].downloadMB + e.bytes.ktx2 / 2 ** 20).toFixed(2));
  }
  fs.writeFileSync(path.join(OUT, 'backdrop.json'), JSON.stringify(out, null, 1) + '\n');
  // manifest registration (check_budget.mjs lists every shipped file through the manifest)
  const manPath = path.join(PUB, 'manifest.json');
  const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
  man.backdrops ??= {};
  const files = [`backdrop/${ID}/backdrop.json`];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(PUB, path.join(d, e.name)).replace(/\\/g, '/')]));
  for (const f of walk(OUT)) if (!files.includes(f)) files.push(f);
  man.backdrops[ID] = { json: `backdrop/${ID}/backdrop.json`, files, tiers: Object.fromEntries(Object.entries(out.tiers).map(([t, v]) => [t, { gpuMB: v.gpuMB, downloadMB: v.downloadMB }])) };
  fs.writeFileSync(manPath, JSON.stringify(man, null, 1) + '\n');
  console.log(`backdrop/${ID}: ${files.length} files`, JSON.stringify(Object.fromEntries(Object.entries(out.tiers).map(([t, v]) => [t, { gpuMB: v.gpuMB, downloadMB: v.downloadMB }]))));
}

try {
  main();
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
