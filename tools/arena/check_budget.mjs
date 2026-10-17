// Arena asset budget + contract gate (arena art plan 4.3 / 6.6, milestone A1).
//   node tools/arena/check_budget.mjs [--json]          (npm run arena:budget)  -> table, exit 1 on any failure
// Reads public/arena/manifest.json and MEASURES every shipped GLB (all tiers x formats), it does not trust the
// manifest's numbers:
//   * contract: prop assets must match the sim tables parsed from the source (src/sim/arenaGen.ts PROP_BASE r,
//     src/sim/world.ts TOP): max horizontal radius of the visible LOD vertices = r, top = TOP, base at y = 0
//     (tolerance 5 mm / 2 mm), and the KIT_ root extras footprint / height agree with them;
//   * structure: KIT_<id> root with role, LOD0 (full) / LOD1 (low), hidden COL proxy, SOCK_flame on braziers and
//     lanterns, required extensions (EXT_meshopt_compression, KHR_texture_basisu or EXT_texture_webp);
//   * budgets per role (BUDGET below): triangles per LOD, texture size, draw calls (primitives), file size;
//   * texture GPU memory per tier (ETC1S ~0.5 B/px, UASTC 1 B/px, WebP decoded RGBA8 4 B/px, x4/3 mips) summed
//     over the whole kit against the arena budget of plan 6.6 (64 / 128 / 192 MB for low / medium / high);
//   * licences: every source in the manifest has a CC0 row in public/arena/credits.json; no stray files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUB = path.join(ROOT, 'public', 'arena');
const MB = 1024 * 1024;
const TIER_TEX_MB = { low: 64, medium: 128, high: 192 };
const BUDGET = {
  prop: { lod0Tris: 2000, lod1Tris: 800, fullTex: 1024, lowTex: 512, prims: 4, fullBytes: 1.0 * MB, lowBytes: 0.45 * MB },
};

// sim contract, parsed from the TS source (single source of truth; the sim is not imported into Node tooling here)
function simTables() {
  const gen = fs.readFileSync(path.join(ROOT, 'src/sim/arenaGen.ts'), 'utf8');
  const world = fs.readFileSync(path.join(ROOT, 'src/sim/world.ts'), 'utf8');
  const base = {};
  const pb = /const PROP_BASE[^{]*\{([\s\S]*?)\n\};/.exec(gen);
  for (const m of pb[1].matchAll(/(\w+):\s*\{\s*r:\s*([\d.]+)/g)) base[m[1]] = +m[2];
  const top = {};
  const tp = /const TOP\s*:[^{]*\{([^}]*)\}/.exec(world);
  for (const m of tp[1].matchAll(/(\w+):\s*([\d.]+)/g)) top[m[1]] = +m[2];
  return { base, top };
}

function ktx2Size(buf) {
  return [buf.readUInt32LE(20), buf.readUInt32LE(24)];
}
function webpSize(b) {
  const tag = b.subarray(12, 16).toString('latin1');
  if (tag === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  if (tag === 'VP8L') {
    const v = b.readUInt32LE(21);
    return [(v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1];
  }
  if (tag === 'VP8X') return [(b.readUIntLE(24, 3) & 0xffffff) + 1, (b.readUIntLE(27, 3) & 0xffffff) + 1];
  return [0, 0];
}

async function measure(io, file) {
  const doc = await io.read(path.join(PUB, file));
  const root = doc.getRoot();
  const used = root.listExtensionsUsed().map((e) => e.extensionName);
  const nodes = root.listNodes();
  const kit = nodes.find((n) => n.getName().startsWith('KIT_'));
  const isCol = (n) => {
    for (let p = n; p; p = p.getParentNode()) if (p.getName() === 'COL') return true;
    return false;
  };
  const lodOf = (n) => {
    for (let p = n; p; p = p.getParentNode()) if (/^LOD\d$/.test(p.getName())) return p.getName();
    return null;
  };
  let r = 0,
    ymin = 1e9,
    ymax = -1e9,
    tris = 0,
    prims = 0;
  const lods = new Set();
  let col = false;
  const v = [0, 0, 0];
  for (const n of nodes) {
    const mesh = n.getMesh();
    if (!mesh) continue;
    prims += mesh.listPrimitives().length;
    if (isCol(n)) {
      col = true;
      continue;
    }
    const lod = lodOf(n);
    if (lod) lods.add(lod);
    const M = n.getWorldMatrix();
    for (const p of mesh.listPrimitives()) {
      const pos = p.getAttribute('POSITION');
      tris += (p.getIndices()?.getCount() ?? pos.getCount()) / 3;
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        const x = M[0] * v[0] + M[4] * v[1] + M[8] * v[2] + M[12];
        const y = M[1] * v[0] + M[5] * v[1] + M[9] * v[2] + M[13];
        const z = M[2] * v[0] + M[6] * v[1] + M[10] * v[2] + M[14];
        r = Math.max(r, Math.hypot(x, z));
        ymin = Math.min(ymin, y);
        ymax = Math.max(ymax, y);
      }
    }
  }
  const tex = root.listTextures().map((t) => {
    const img = Buffer.from(t.getImage());
    const mime = t.getMimeType();
    const [w, h] = mime === 'image/ktx2' ? ktx2Size(img) : mime === 'image/webp' ? webpSize(img) : [0, 0];
    // KTX2 supercompression scheme: 1 = BasisLZ (ETC1S); otherwise UASTC (zstd 2 or none 0)
    const codec = mime === 'image/ktx2' ? (img.readUInt32LE(44) === 1 ? 'etc1s' : 'uastc') : mime.split('/')[1];
    const bpp = codec === 'etc1s' ? 0.5 : codec === 'uastc' ? 1 : 4;
    return { name: t.getName(), w, h, codec, gpu: w * h * bpp * (4 / 3) };
  });
  const socks = nodes.filter((n) => n.getName().startsWith('SOCK_')).map((n) => ({ name: n.getName(), extras: n.getExtras() }));
  return { kit: kit ? { name: kit.getName(), extras: kit.getExtras() } : null, used, lods: [...lods], col, r, ymin, ymax, tris, prims, tex, socks, bytes: fs.statSync(path.join(PUB, file)).size };
}

async function main() {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const man = JSON.parse(fs.readFileSync(path.join(PUB, 'manifest.json'), 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(path.join(PUB, 'credits.json'), 'utf8'));
  const sim = simTables();
  const fails = [];
  const rows = [];
  const gpu = { full: { ktx2: 0, webp: 0 }, low: { ktx2: 0, webp: 0 } };
  const listed = new Set(['manifest.json', 'credits.json']);
  for (const [id, A] of Object.entries(man.assets)) {
    const B = BUDGET[A.role];
    if (!B) fails.push(`${id}: no budget for role ${A.role}`);
    for (const s of A.sources || []) {
      const row = ledger.assets?.[s];
      if (!row) fails.push(`${id}: source ${s} missing from credits.json`);
      else if (!/^CC0/.test(row.licence)) fails.push(`${id}: source ${s} licence ${row.licence} is not CC0`);
    }
    for (const [tier, byFmt] of Object.entries(A.files)) {
      for (const [fmt, file] of Object.entries(byFmt)) {
        listed.add(file.replace(/\//g, path.sep));
        const f = (msg) => fails.push(`${file}: ${msg}`);
        if (!fs.existsSync(path.join(PUB, file))) {
          f('missing');
          continue;
        }
        const m = await measure(io, file);
        const lod = tier === 'full' ? 'LOD0' : 'LOD1';
        if (!m.kit) f('no KIT_ root node');
        else if (!m.kit.extras?.role) f('KIT_ root has no role extra');
        if (m.lods.length !== 1 || m.lods[0] !== lod) f(`expected only ${lod}, found ${m.lods.join(',') || 'none'}`);
        if (!m.col) f('no COL proxy');
        if (!m.used.includes('EXT_meshopt_compression')) f('not meshopt-compressed');
        if (m.tex.length && !m.used.includes(fmt === 'ktx2' ? 'KHR_texture_basisu' : 'EXT_texture_webp')) f(`textures without the ${fmt} extension`);
        if (fmt === 'webp' ? m.tex.some((t) => t.codec !== 'webp') : m.tex.some((t) => !['etc1s', 'uastc'].includes(t.codec))) f('texture format does not match the variant');
        if (A.role === 'prop') {
          const r0 = sim.base[A.kind],
            h0 = sim.top[A.kind];
          if (r0 === undefined || h0 === undefined) f(`kind ${A.kind} not in the sim tables`);
          else {
            if (Math.abs(m.r - r0) > 0.005) f(`radius ${m.r.toFixed(4)} != PROP_BASE.${A.kind}.r ${r0}`);
            if (Math.abs(m.ymax - h0) > 0.005) f(`top ${m.ymax.toFixed(4)} != TOP.${A.kind} ${h0}`);
            if (Math.abs(m.ymin) > 0.002) f(`base y ${m.ymin.toFixed(4)} != 0 (origin at the base centre)`);
            if (m.kit && (Math.abs((m.kit.extras.footprint ?? -1) - r0) > 1e-6 || Math.abs((m.kit.extras.height ?? -1) - h0) > 1e-6)) f(`KIT_ extras footprint/height ${m.kit.extras.footprint}/${m.kit.extras.height} != sim ${r0}/${h0}`);
          }
          if ((A.kind === 'brazier' || A.kind === 'lantern') && !m.socks.some((s) => s.name === 'SOCK_flame' || s.name === 'SOCK_glow')) f('no SOCK_flame / SOCK_glow');
        }
        if (B) {
          const triMax = tier === 'full' ? B.lod0Tris : B.lod1Tris;
          const texMax = tier === 'full' ? B.fullTex : B.lowTex;
          const byteMax = tier === 'full' ? B.fullBytes : B.lowBytes;
          if (m.tris > triMax) f(`${m.tris} tris > ${triMax}`);
          if (m.tex.some((t) => Math.max(t.w, t.h) > texMax)) f(`texture over ${texMax}px`);
          if (m.prims > B.prims) f(`${m.prims} primitives > ${B.prims}`);
          if (m.bytes > byteMax) f(`${(m.bytes / MB).toFixed(2)} MB > ${(byteMax / MB).toFixed(2)} MB`);
        }
        const g = m.tex.reduce((s, t) => s + t.gpu, 0);
        gpu[tier][fmt] += g;
        rows.push([file, `${tier}/${fmt}`, String(m.tris), String(m.prims), m.r.toFixed(4), `${m.ymin.toFixed(4)}..${m.ymax.toFixed(4)}`, m.tex.map((t) => `${t.w}${t.codec[0]}`).join(' '), (g / MB).toFixed(2), (m.bytes / 1024).toFixed(0)]);
      }
    }
  }
  // stray files in public/arena (everything shipped must be in the manifest, so the ledger covers it)
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(PUB, path.join(d, e.name))]));
  for (const f of walk(PUB)) if (!listed.has(f)) fails.push(`${f}: in public/arena but not in the manifest`);
  // whole-kit texture memory per tier (low uses the low files, medium / high the full ones; KTX2 is the shipped default)
  const tiers = { low: gpu.low.ktx2, medium: gpu.full.ktx2, high: gpu.full.ktx2 };
  for (const [t, v] of Object.entries(tiers)) if (v > TIER_TEX_MB[t] * MB) fails.push(`kit texture memory ${t} ${(v / MB).toFixed(1)} MB > ${TIER_TEX_MB[t]} MB`);
  const head = ['file', 'variant', 'tris', 'prims', 'radius', 'y', 'textures', 'GPU MB', 'KB'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  console.log(head.map((h, i) => h.padEnd(w[i])).join('  '));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(w[i])).join('  '));
  console.log(`kit texture GPU memory (KTX2): low ${(tiers.low / MB).toFixed(2)} MB / ${TIER_TEX_MB.low}, medium+high ${(tiers.high / MB).toFixed(2)} MB / ${TIER_TEX_MB.medium}-${TIER_TEX_MB.high}; WebP fallback: low ${(gpu.low.webp / MB).toFixed(2)}, full ${(gpu.full.webp / MB).toFixed(2)} MB`);
  console.log(`sim contract: PROP_BASE r ${JSON.stringify(sim.base)}; TOP ${JSON.stringify(sim.top)}`);
  if (args.includes('--json')) console.log(JSON.stringify({ rows, tiers, fails }, null, 1));
  if (fails.length) {
    console.log(`\nFAIL (${fails.length}):\n  ` + fails.join('\n  '));
    process.exit(1);
  }
  console.log('\nbudget + contract: PASS');
}
const args = process.argv.slice(2);
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
