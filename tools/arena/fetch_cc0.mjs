// CC0 source fetcher for the arena art pipeline (arena art plan 5.1 / 7, milestone A1).
//   node tools/arena/fetch_cc0.mjs <source:id> [...] [--res=1k] [--maps=diff,rough,metal,nor_gl,arm,disp] [--force]
//   node tools/arena/fetch_cc0.mjs --list            (what is in the ledger and on disk)
// Sources (both CC0, public APIs, so agents may script the download):
//   polyhaven:<id>   textures (per map, jpg/png at --res), HDRIs (hdr/exr at --res), models (gltf/blend zip at --res)
//   ambientcg:<id>   surfaces (zip at <RES>-JPG, unpacked with the Windows / bsdtar `tar`)
// Raw files go OUTSIDE git: <repo>/../Assets/arena-src/<source>/<id>/ (override with ARENA_SRC=<dir>),
// each with a meta.json (what was fetched, md5, licence, authors, source url). Blender jobs read them
// with abake.load_cc0('<source>/<id>'). The ledger public/arena/credits.json (tracked) gets one row per
// asset: name, authors, licence, url, files, fetched date and `usedBy` (filled by build_assets.mjs).
// Downloads are md5-checked when the API gives an md5 (Poly Haven) and skipped when already on disk.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SRC = path.resolve(process.env.ARENA_SRC || path.join(ROOT, '..', 'Assets', 'arena-src'));
const LEDGER = path.join(ROOT, 'public', 'arena', 'credits.json');
const UA = { 'User-Agent': 'arena-gods-asset-pipeline/1.0 (CC0 fetch; contact via repo owner)' };

const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const FORCE = args.includes('--force');

export function readLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  } catch {
    return { _doc: 'CC0 / third-party sources used by the arena art (public/arena). One row per source asset. Written by tools/arena/fetch_cc0.mjs; usedBy filled by tools/arena/build_assets.mjs; checked by tools/arena/check_budget.mjs.', assets: {} };
  }
}
export function writeLedger(l) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(l.assets).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(LEDGER, JSON.stringify({ ...l, assets: sorted }, null, 1) + '\n');
}

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
async function download(url, dst, md5) {
  if (!FORCE && fs.existsSync(dst) && (!md5 || md5sum(dst) === md5)) return { path: dst, cached: true };
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, buf);
  if (md5 && md5sum(dst) !== md5) throw new Error(`${dst}: md5 mismatch (download corrupted?)`);
  return { path: dst, cached: false, bytes: buf.length };
}
const md5sum = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

// Poly Haven map keys in /files: Diffuse, Rough, Metal, nor_gl, nor_dx, arm, AO, Displacement, ... (case as returned)
const PH_MAPS = { diff: 'Diffuse', rough: 'Rough', metal: 'Metal', nor_gl: 'nor_gl', arm: 'arm', ao: 'AO', disp: 'Displacement', bump: 'Bump', mask: 'Mask' };

async function polyhaven(id, res) {
  const info = await getJson(`https://api.polyhaven.com/info/${id}`);
  const files = await getJson(`https://api.polyhaven.com/files/${id}`);
  const dir = path.join(SRC, 'polyhaven', id);
  const got = {};
  const type = ['hdri', 'texture', 'model'][info.type];
  if (type === 'texture') {
    const want = opt('maps', 'diff,rough,metal,nor_gl,arm').split(',');
    for (const k of want) {
      const key = PH_MAPS[k] ?? k;
      const ent = files[key]?.[res];
      if (!ent) {
        console.log(`  ${id}: no ${key} at ${res} (skipped)`);
        continue;
      }
      const f = ent.png && k !== 'diff' ? ent.png : ent.jpg || ent.png; // colour as jpg (small), data maps as png (no JPEG blocks in normals)
      const fmt = f === ent.png ? 'png' : 'jpg';
      const dst = path.join(dir, `${id}_${k}_${res}.${fmt}`);
      const r = await download(f.url, dst, f.md5);
      got[k] = path.basename(dst);
      console.log(`  ${k.padEnd(7)} ${r.cached ? 'cached' : 'fetched'} ${path.basename(dst)}`);
    }
  } else if (type === 'hdri') {
    const ent = files.hdri?.[res];
    if (!ent) throw new Error(`${id}: no HDRI at ${res}`);
    const f = ent.hdr || ent.exr;
    const dst = path.join(dir, `${id}_${res}.${ent.hdr ? 'hdr' : 'exr'}`);
    await download(f.url, dst, f.md5);
    got.hdri = path.basename(dst);
  } else {
    const ent = files.gltf?.[res]?.gltf;
    if (!ent) throw new Error(`${id}: no glTF model at ${res}`);
    const dst = path.join(dir, `${id}_${res}.gltf`);
    await download(ent.url, dst, ent.md5);
    for (const [rel, inc] of Object.entries(ent.include || {})) await download(inc.url, path.join(dir, rel), inc.md5);
    got.gltf = path.basename(dst);
  }
  return { dir, type, files: got, name: info.name, authors: Object.keys(info.authors || {}), url: `https://polyhaven.com/a/${id}`, licence: 'CC0-1.0', dims: info.dimensions };
}

async function ambientcg(id, res) {
  const R = res.toUpperCase().replace('K', 'K');
  const j = await getJson(`https://ambientcg.com/api/v2/full_json?id=${encodeURIComponent(id)}&include=downloadData`);
  const a = j.foundAssets?.[0];
  if (!a) throw new Error(`ambientCG: ${id} not found`);
  const dls = a.downloadFolders?.default?.downloadFiletypeCategories?.zip?.downloads || [];
  const d = dls.find((x) => x.attribute === `${R}-JPG`) || dls.find((x) => /JPG/.test(x.attribute));
  if (!d) throw new Error(`ambientCG: ${id} has no JPG zip`);
  const dir = path.join(SRC, 'ambientcg', id);
  const zip = path.join(dir, d.fileName);
  await download(d.downloadLink || d.fullDownloadPath, zip);
  const t = spawnSync('tar', ['-xf', zip, '-C', dir], { encoding: 'utf8' });
  if (t.status !== 0) throw new Error(`unzip failed: ${t.stderr}`);
  const files = {};
  for (const f of fs.readdirSync(dir)) {
    const m = /_(Color|Roughness|Metalness|NormalGL|AmbientOcclusion|Displacement|Opacity)\.(jpg|png)$/i.exec(f);
    if (m) files[{ Color: 'diff', Roughness: 'rough', Metalness: 'metal', NormalGL: 'nor_gl', AmbientOcclusion: 'ao', Displacement: 'disp', Opacity: 'mask' }[m[1]]] = f;
  }
  return { dir, type: 'texture', files, name: a.displayName || id, authors: ['ambientCG (Lennart Demes)'], url: `https://ambientcg.com/view?id=${id}`, licence: 'CC0-1.0' };
}

async function fetchOne(spec, res) {
  const [source, id] = spec.split(':');
  if (!id) throw new Error(`expected <source>:<id>, got ${spec}`);
  console.log(`${source}:${id} @ ${res}`);
  const r = source === 'polyhaven' ? await polyhaven(id, res) : source === 'ambientcg' ? await ambientcg(id, res) : null;
  if (!r) throw new Error(`unknown source ${source} (polyhaven | ambientcg)`);
  const key = `${source}/${id}`;
  const meta = { id: key, source, res, type: r.type, name: r.name, authors: r.authors, licence: r.licence, url: r.url, files: r.files, dims: r.dims, fetched: new Date().toISOString().slice(0, 10) };
  fs.writeFileSync(path.join(r.dir, 'meta.json'), JSON.stringify(meta, null, 1));
  const L = readLedger();
  const prev = L.assets[key] || {};
  L.assets[key] = { name: r.name, authors: r.authors, licence: r.licence, url: r.url, res, files: Object.values(r.files), fetched: meta.fetched, usedBy: prev.usedBy || [] };
  writeLedger(L);
  return meta;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const specs = args.filter((a) => !a.startsWith('--'));
  if (args.includes('--list') || !specs.length) {
    const L = readLedger();
    console.log(`source dir: ${SRC}`);
    for (const [k, v] of Object.entries(L.assets)) console.log(`${k.padEnd(32)} ${fs.existsSync(path.join(SRC, k, 'meta.json')) ? 'on disk' : 'MISSING '} ${v.licence} ${v.name} (${v.authors.join(', ')}) used by ${v.usedBy.join(', ') || '-'}`);
    if (!specs.length) process.exit(0);
  }
  const res = opt('res', '1k');
  let fail = 0;
  for (const s of specs) {
    try {
      await fetchOne(s, res);
    } catch (e) {
      fail++;
      console.error(`!! ${s}: ${e.message}`);
    }
  }
  process.exit(fail ? 1 : 0);
}
