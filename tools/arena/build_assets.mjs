// Arena asset build (arena art plan 5.8, milestone A1): Blender job outputs -> shipped GLBs + manifest.
//   node tools/arena/build_assets.mjs [jobId ...] [--formats=ktx2,webp] [--keep-work]
//   npm run arena:assets
// A2: role 'texset' (floor_set.py, inlay_moongate.py): texture-only assets shipped as a carrier GLB (one TEXSET quad +
// one material holding baseColor / normal / orm), so they reuse this pipeline, the loader and the WebP fallback.
// Input: every tools/arena/_bake/<job>/asset.json (written by the kit jobs, e.g. kit_brazier.py) with its
// raw GLB (geometry + named materials, no images) and the baked PNG sets per material.
// Per asset, 2 tiers x 2 texture formats = 4 GLBs in public/arena/<id>[.low][.webp].glb:
//   tier  full = LOD0 (+ COL, SOCK_*) with the LOD0 texture set (medium / high quality)
//         low  = LOD1 with its own (half-size) set; when a material has no low set, its full set is halved (Pillow)
//   fmt   ktx2 = KHR_texture_basisu, encoded with `ktx create` DIRECTLY (KTX-Software 5.0; gltf-transform 4.x's
//                uastc/etc1s pass the 4.x flag --assign-oetf and fail silently, A0 README). The tool's LOG is
//                checked (error / warning lines, KTX2 magic in the output), never only its exit code.
//                colour: ETC1S (basis-lz q128, sRGB); ORM: ETC1S q192 (linear); normal: UASTC q2 + RDO (lambda 1)
//                + zstd 18 (linear); all mipmapped. (UASTC ORM was 785 KB at 1024 vs 184 KB ETC1S.)
//         webp = EXT_texture_webp fallback (Pillow; gltf-transform `webp` is broken in this install: sharp)
// Geometry: dedup, prune (keepLeaves: sockets are empty leaves), meshopt (EXT_meshopt_compression, medium).
// Writes public/arena/manifest.json (asset id -> files, stats) and fills `usedBy` in public/arena/credits.json.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP, KHRMaterialsEmissiveStrength, KHRTextureBasisu } from '@gltf-transform/extensions';
import { dedup, meshopt, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { findKtx } from './ktx_probe.mjs';
import { readLedger, writeLedger } from './fetch_cc0.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BAKE = path.join(ROOT, 'tools', 'arena', '_bake');
const WORK = path.join(ROOT, 'tools', 'arena', '_work', 'assets');
const PUB = path.join(ROOT, 'public', 'arena');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const FORMATS = opt('formats', 'ktx2,webp').split(',');
const PY = process.env.PYTHON || 'python';

const KTX_ARGS = {
  // A4: colour + alpha (banner tear masks, alphaMode MASK)
  colorA: ['--format', 'R8G8B8A8_SRGB', '--assign-tf', 'srgb', '--encode', 'basis-lz', '--qlevel', '128', '--generate-mipmap'],
  color: ['--format', 'R8G8B8_SRGB', '--assign-tf', 'srgb', '--encode', 'basis-lz', '--qlevel', '128', '--generate-mipmap'],
  data: ['--format', 'R8G8B8_UNORM', '--assign-tf', 'linear', '--encode', 'basis-lz', '--qlevel', '192', '--generate-mipmap'],
  linear: ['--format', 'R8G8B8_UNORM', '--assign-tf', 'linear', '--encode', 'uastc', '--uastc-quality', '2', '--uastc-rdo', '--uastc-rdo-l', '1.0', '--zstd', '18', '--generate-mipmap'],
};

let KTX = null;
function ktxEncode(png, dst, kind) {
  KTX ??= findKtx();
  if (!KTX) throw new Error('KTX-Software (ktx.exe) not found: install it or run with --formats=webp');
  const t = Date.now();
  if (fs.existsSync(dst)) fs.rmSync(dst);
  const r = spawnSync(KTX.exe, ['create', ...KTX_ARGS[kind], png, dst], { encoding: 'utf8' });
  const log = `${r.stdout || ''}${r.stderr || ''}`;
  // the exit code is not trusted (A0: tools exit 0 on failure): look at the log and the output itself
  const bad = log.split(/\r?\n/).filter((l) => /error|fatal|fail|invalid|not exist|unrecognized|warning/i.test(l));
  const ok = fs.existsSync(dst) && fs.readFileSync(dst).subarray(0, 12).toString('latin1') === '«KTX 20»\r\n\u001a\n';
  if (bad.length || !ok) throw new Error(`ktx create ${path.basename(png)} (${kind}) failed (exit ${r.status}, output ${ok ? 'ok' : 'missing / not KTX2'}):\n  ${bad.join('\n  ') || log.slice(0, 400)}`);
  return { bytes: fs.statSync(dst).size, seconds: (Date.now() - t) / 1000, codec: kind === 'linear' ? 'uastc+zstd' : 'etc1s' };
}

function pillow(script, ...a) {
  const r = spawnSync(PY, ['-c', script, ...a], { encoding: 'utf8' });
  if (r.status !== 0 || /Traceback|Error/.test(r.stderr || '')) throw new Error(`python/Pillow failed: ${r.stderr}`);
  return (r.stdout || '').trim();
}
// A4: images with an alpha channel keep it (banner tear masks)
const PY_MODE = 'im=im.convert("RGBA" if sys.argv[-1]=="A" else "RGB");';
const PY_WEBP = 'import sys;from PIL import Image;im=Image.open(sys.argv[1]);' + PY_MODE + 'im.save(sys.argv[2],"WEBP",quality=int(sys.argv[3]),method=6);print(im.size[0],im.size[1])';
const PY_HALF = 'import sys;from PIL import Image;im=Image.open(sys.argv[1]);' + PY_MODE + 'im=im.resize((max(1,im.size[0]//2),max(1,im.size[1]//2)),Image.LANCZOS);im.save(sys.argv[2]);print(im.size[0],im.size[1])';
const pngSize = (p) => {
  const b = fs.readFileSync(p);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

/** encode one PNG for a format; cached in _work by name + mtime */
function encodeImage(png, kind, fmt) {
  fs.mkdirSync(WORK, { recursive: true });
  const base = path.basename(png, '.png');
  const dst = path.join(WORK, `${base}.${fmt === 'ktx2' ? 'ktx2' : 'webp'}`);
  const stamp = dst + '.stamp';
  const key = `${fs.statSync(png).mtimeMs}|${kind}|${JSON.stringify(KTX_ARGS[kind])}`;
  let info;
  if (fs.existsSync(dst) && fs.existsSync(stamp) && JSON.parse(fs.readFileSync(stamp, 'utf8')).key === key) info = JSON.parse(fs.readFileSync(stamp, 'utf8')).info;
  else {
    info = fmt === 'ktx2' ? ktxEncode(png, dst, kind) : { bytes: (pillow(PY_WEBP, png, dst, kind === 'color' || kind === 'colorA' ? '90' : '95', kind === 'colorA' ? 'A' : 'N'), fs.statSync(dst).size), codec: 'webp' };
    fs.writeFileSync(stamp, JSON.stringify({ key, info }));
  }
  const [w, h] = pngSize(png);
  return { data: fs.readFileSync(dst), mime: fmt === 'ktx2' ? 'image/ktx2' : 'image/webp', w, h, ...info };
}

function halfPng(png, alpha = false) {
  fs.mkdirSync(WORK, { recursive: true });
  const dst = path.join(WORK, path.basename(png, '.png') + '_half.png');
  if (!fs.existsSync(dst) || fs.statSync(dst).mtimeMs < fs.statSync(png).mtimeMs) pillow(PY_HALF, png, dst, alpha ? 'A' : 'N');
  return dst;
}

function disposeTree(n) {
  for (const c of n.listChildren()) disposeTree(c);
  const m = n.getMesh();
  n.dispose();
  if (m && !m.listParents().some((p) => p.propertyType === 'Node')) m.dispose();
}

async function buildVariant(io, A, dir, tier, fmt) {
  const doc = await io.read(path.join(dir, A.glb));
  // A2: texture sets (role 'texset': floor sets, inlays) are one TEXSET quad carrying a material, the same node
  // for both tiers (low = the set at half size); kit assets drop the other tier's LOD node
  const drop = A.role === 'texset' ? null : tier === 'full' ? 'LOD1' : 'LOD0';
  for (const n of doc.getRoot().listNodes()) if (drop && n.getName() === drop) disposeTree(n);
  const texInfo = [];
  const lodMats = new Set(A.lods[tier === 'full' ? 'LOD0' : 'LOD1'].materials);
  let emissive = null;
  for (const mat of doc.getRoot().listMaterials()) {
    const spec = A.materials[mat.getName()];
    if (!spec || !lodMats.has(mat.getName())) continue;
    if (spec.baseColorFactor) mat.setBaseColorFactor(spec.baseColorFactor);
    if (spec.roughnessFactor !== undefined) mat.setRoughnessFactor(spec.roughnessFactor);
    if (spec.metallicFactor !== undefined) mat.setMetallicFactor(spec.metallicFactor);
    if (spec.emissiveFactor) {
      mat.setEmissiveFactor(spec.emissiveFactor);
      if (spec.emissiveStrength && spec.emissiveStrength !== 1) {
        emissive ??= doc.createExtension(KHRMaterialsEmissiveStrength);
        mat.setExtension('KHR_materials_emissive_strength', emissive.createEmissiveStrength().setEmissiveStrength(spec.emissiveStrength));
      }
    }
    // A4: alpha-tested materials (banner cloth with tear masks)
    if (spec.alpha === 'MASK') mat.setAlphaMode('MASK').setAlphaCutoff(spec.alphaCutoff ?? 0.5);
    if (spec.doubleSided) mat.setDoubleSided(true);
    const slots = [
      ['baseColor', spec.alpha ? 'colorA' : 'color', (t) => mat.setBaseColorTexture(t)],
      ['normal', 'linear', (t) => mat.setNormalTexture(t)],
      ['orm', 'data', (t) => (mat.setOcclusionTexture(t), mat.setMetallicRoughnessTexture(t))],
    ];
    for (const [key, kind, set] of slots) {
      if (!spec[key]) continue;
      let png = path.join(dir, spec[key]);
      // a low tier that shares the full set gets it at half size
      if (tier === 'low' && !A.lods.LOD1.ownTextures && A.lods.LOD0.materials.includes(mat.getName())) png = halfPng(png, kind === 'colorA');
      const e = encodeImage(png, kind, fmt);
      const tex = doc.createTexture(`${mat.getName()}_${key}`).setImage(e.data).setMimeType(e.mime).setURI(`${mat.getName()}_${key}.${fmt}`);
      set(tex);
      texInfo.push({ material: mat.getName(), slot: key, w: e.w, h: e.h, codec: e.codec, bytes: e.bytes });
    }
  }
  if (fmt === 'ktx2' && texInfo.length) doc.createExtension(KHRTextureBasisu).setRequired(true);
  if (fmt === 'webp' && texInfo.length) doc.createExtension(EXTTextureWebP).setRequired(true);
  // A3: modules carry UVs for the shared trim set (bound at runtime), not by their own (texture-less) material: keep them
  await doc.transform(dedup(), prune({ keepLeaves: true, keepExtras: true, keepAttributes: A.role === 'module' }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const rel = `${A.id}${tier === 'low' ? '.low' : ''}${fmt === 'webp' ? '.webp' : ''}.glb`;
  const out = path.join(PUB, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await io.write(out, doc);
  let tris = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3;
  return { file: rel, bytes: fs.statSync(out).size, textures: texInfo, primitives: doc.getRoot().listMeshes().reduce((s, m) => s + m.listPrimitives().length, 0), trisAllMeshes: tris };
}

async function main() {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  const want = args.filter((a) => !a.startsWith('--'));
  const jobs = fs.readdirSync(BAKE).filter((d) => fs.existsSync(path.join(BAKE, d, 'asset.json')) && (!want.length || want.includes(d)));
  if (!jobs.length) throw new Error('no asset.json under tools/arena/_bake (run the kit jobs first: npm run arena:bake -- kit)');
  const manPath = path.join(PUB, 'manifest.json');
  const man = fs.existsSync(manPath) ? JSON.parse(fs.readFileSync(manPath, 'utf8')) : { _doc: 'Arena art manifest (tools/arena/build_assets.mjs). files[tier][format] relative to /arena/. tier full = LOD0 (medium/high), low = LOD1 (low). Loaded by src/render/arena/assets.ts.', version: 1, assets: {} };
  const ledger = readLedger();
  for (const j of jobs) {
    const dir = path.join(BAKE, j);
    const A = JSON.parse(fs.readFileSync(path.join(dir, 'asset.json'), 'utf8'));
    A.lods.LOD1.ownTextures ??= A.lods.LOD1.materials.some((m) => !A.lods.LOD0.materials.includes(m) && A.materials[m]?.baseColor);
    const entry = { role: A.role, kind: A.kind, contract: A.contract, texset: A.texset, sources: A.sources, files: {}, stats: {} };
    for (const tier of ['full', 'low']) {
      entry.files[tier] = {};
      entry.stats[tier] = {};
      for (const fmt of FORMATS) {
        const t = Date.now();
        const r = await buildVariant(io, A, dir, tier, fmt);
        entry.files[tier][fmt] = r.file;
        entry.stats[tier][fmt] = { bytes: r.bytes, primitives: r.primitives, textures: r.textures };
        console.log(`${r.file.padEnd(34)} ${(r.bytes / 1024).toFixed(0).padStart(5)} KB  ${r.primitives} prims  ${r.textures.map((x) => `${x.slot}:${x.w}:${x.codec}`).join(' ')}  ${((Date.now() - t) / 1000).toFixed(1)} s`);
      }
    }
    man.assets[A.id] = entry;
    for (const s of A.sources || []) {
      if (!ledger.assets[s]) throw new Error(`${A.id}: source ${s} has no row in public/arena/credits.json (fetch it with fetch_cc0.mjs)`);
      ledger.assets[s].usedBy = [...new Set([...(ledger.assets[s].usedBy || []), A.id])].sort();
    }
  }
  man.generated = new Date().toISOString().slice(0, 10);
  man.assets = Object.fromEntries(Object.entries(man.assets).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(manPath, JSON.stringify(man, null, 1) + '\n');
  writeLedger(ledger);
  if (!args.includes('--keep-work')) for (const f of fs.existsSync(WORK) ? fs.readdirSync(WORK) : []) if (f.endsWith('_half.png')) fs.rmSync(path.join(WORK, f));
  console.log(`manifest: ${path.relative(ROOT, manPath)} (${Object.keys(man.assets).length} assets)`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
