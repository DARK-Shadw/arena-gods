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
//   * A2 texture sets (role texset): carrier quad only, 3 square power-of-two textures, tileM / sizeM extras,
//     minimum texel density per tier (TEXEL_MIN).
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
  prop: { lod0Tris: 2000, lod1Tris: 800, fullTex: 1024, lowTex: 512, prims: 4, fullBytes: 1.4 * MB, lowBytes: 0.45 * MB, fracTris: 2500 },
  // A2: texture sets (floor sets over a tile of tileM metres, inlays over a square of sizeM metres); one carrier quad
  texset: { lod0Tris: 2, lod1Tris: 2, fullTex: 2048, lowTex: 1024, prims: 1, fullBytes: 6.0 * MB, lowBytes: 2.0 * MB },
  // A3: hero obstacles (pillars, columns, rubble): unique bakes; FRAC_* pieces counted separately (fracTris), COL included in prims
  obstacle: { lod0Tris: 1500, lod1Tris: 700, fullTex: 2048, lowTex: 1024, prims: 10, fullBytes: 5.5 * MB, lowBytes: 1.6 * MB, fracTris: 1500 },
  // A3: trim-sheet architecture modules: geometry + vertex AO only (the trim texture set is shared: kit/stone_trim)
  module: { lod0Tris: 2600, lod1Tris: 1400, fullTex: 0, lowTex: 0, prims: 3, fullBytes: 0.25 * MB, lowBytes: 0.15 * MB },
  // A3: render-only decor (rubble scatter)
  decor: { lod0Tris: 1600, lod1Tris: 600, fullTex: 1024, lowTex: 512, prims: 2, fullBytes: 1.4 * MB, lowBytes: 0.45 * MB },
  // A4: render-only dressing (braziers, lanterns, candles, bell, skulls, bones, stakes): one baked set + constant emissive parts
  dress: { lod0Tris: 4000, lod1Tris: 1600, fullTex: 1024, lowTex: 512, prims: 4, fullBytes: 1.4 * MB, lowBytes: 0.45 * MB },
  // A4: sim features (banner pole, barricade): obstacle kinds dressed by the kit; FRAC_* pieces counted separately
  feature: { lod0Tris: 2500, lod1Tris: 1000, fullTex: 1024, lowTex: 512, prims: 4, fullBytes: 1.4 * MB, lowBytes: 0.45 * MB, fracTris: 2500 },
  // A4: hazard visuals (spike grate, chain weight, fire-jet vent, crumbling floor); moving nodes (SPIKES, SLAB_*) are primitives
  hazard: { lod0Tris: 4000, lod1Tris: 1800, fullTex: 1024, lowTex: 512, prims: 10, fullBytes: 1.4 * MB, lowBytes: 0.45 * MB },
  // A4: chain links (instanced at runtime: LINK_big, LINK_small)
  chain: { lod0Tris: 400, lod1Tris: 200, fullTex: 512, lowTex: 256, prims: 3, fullBytes: 0.6 * MB, lowBytes: 0.25 * MB },
  // A4: banner cloth (cloth-sim drapes + the 8-sigil atlas with tear masks in alpha) + rod
  cloth: { lod0Tris: 2500, lod1Tris: 900, fullTex: 2048, lowTex: 1024, prims: 4, fullBytes: 3.5 * MB, lowBytes: 1.2 * MB },
};
// A4: fragile props must ship breakage pieces (FRAC_*), inside the prop's contract
const FRAGILE_KINDS = ['crate', 'barrel', 'urn', 'explosive', 'lantern'];
// A4: hazard visuals may reach this factor of their nominal radius (r0 extra): spikes / rims / weights stick out
const HAZARD_R_MAX = 1.5;
// A4: required sockets / nodes per (role, kind)
const NEED_SOCK = { 'dress|brazier': ['SOCK_flame'], 'dress|lantern': ['SOCK_glow'], 'dress|candle': ['SOCK_candle_'], 'feature|banner': ['SOCK_banner'], 'hazard|chains': ['SOCK_chain'], 'prop|explosive': ['SOCK_glow'] };
const NEED_NODE = { 'hazard|spikes': ['SPIKES'], 'hazard|crumble': ['RIM', 'SLAB_'], 'chain|chain': ['LINK_big', 'LINK_small'], 'cloth|banner': ['BANNER_vertical', 'BANNER_swag', 'ROD'] };
// A3: plan 4.3 - the visible base of an obstacle may reach at most 1.55 x the sim radius (the camera's standing() factor)
const OBSTACLE_FOOTPRINT_MAX = 1.55;
// A2: minimum texel density (px per metre) of texture sets per tier (plan 5.2: floor 2048 over about 4 m; inlay 2048 over 16 m)
const TEXEL_MIN = { floor: { full: 256, low: 128 }, inlay: { full: 120, low: 60 }, trim: { full: 240, low: 120 } };

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
  // A4: rubble `chunk` props have no PROP_BASE row: their radius is set where the sim spawns them (World: kind 'chunk', r: 0.38)
  const ch = /kind: 'chunk'[^\n]*?\br: ([\d.]+)/.exec(world);
  if (ch) base.chunk = +ch[1];
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
  const isFrac = (n) => {
    for (let p = n; p; p = p.getParentNode()) if (p.getName().startsWith('FRAC_')) return true;
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
  let frac = 0,
    fracTris = 0,
    colored = 0,
    meshes = 0;
  // A4: FRAC piece bounds (props: inside the contract), radius of the visible base (y < 0.6 m: features' footprint)
  let fracR = 0,
    fracYmin = 1e9,
    fracYmax = -1e9,
    rLow = 0;
  const names = [];
  let alphaMask = false;
  const v = [0, 0, 0];
  for (const n of nodes) {
    const mesh = n.getMesh();
    if (!mesh) continue;
    // A4: hidden FRAC_* pieces are not draw calls of the shown asset (counted in fracTris instead)
    if (!isFrac(n)) prims += mesh.listPrimitives().length;
    if (isCol(n)) {
      col = true;
      continue;
    }
    if (isFrac(n)) {
      frac++;
      const M = n.getWorldMatrix();
      for (const p of mesh.listPrimitives()) {
        fracTris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3;
        const pos = p.getAttribute('POSITION');
        for (let i = 0; i < pos.getCount(); i++) {
          pos.getElement(i, v);
          const x = M[0] * v[0] + M[4] * v[1] + M[8] * v[2] + M[12];
          const y = M[1] * v[0] + M[5] * v[1] + M[9] * v[2] + M[13];
          const z = M[2] * v[0] + M[6] * v[1] + M[10] * v[2] + M[14];
          fracR = Math.max(fracR, Math.hypot(x, z));
          fracYmin = Math.min(fracYmin, y);
          fracYmax = Math.max(fracYmax, y);
        }
      }
      continue;
    }
    names.push(n.getName());
    for (const p of mesh.listPrimitives()) if (p.getMaterial()?.getAlphaMode() === 'MASK') alphaMask = true;
    if (mesh.listPrimitives().every((p) => p.getAttribute('COLOR_0'))) colored++;
    meshes++;
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
        if (y < 0.6) rLow = Math.max(rLow, Math.hypot(x, z));
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
  const shaft = nodes.find((n) => n.getName() === 'SHAFT');
  return { kit: kit ? { name: kit.getName(), extras: kit.getExtras() } : null, used, lods: [...lods], col, r, ymin, ymax, tris, prims, tex, socks, frac, fracTris, colored, meshes, shaft: shaft ? shaft.getExtras() : null, fracR, fracYmin, fracYmax, rLow, names, alphaMask, bytes: fs.statSync(path.join(PUB, file)).size };
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
        if (A.role === 'texset') {
          // carrier GLB: no LODs / COL; a tiling (floor) or sized (inlay) square set with power-of-two textures
          const x = m.kit?.extras ?? {};
          const span = A.kind === 'floor' ? x.tileM : x.sizeM;
          if (!(span > 0)) f(`texset ${A.kind}: KIT_ extras ${A.kind === 'floor' ? 'tileM' : 'sizeM'} missing`);
          if (m.tex.length !== 3) f(`texset: ${m.tex.length} textures (expected baseColor, normal, orm)`);
          for (const t of m.tex) {
            if (t.w !== t.h || (t.w & (t.w - 1)) !== 0) f(`texset texture ${t.name} ${t.w}x${t.h} is not square power-of-two (tiling / mips)`);
            const need = TEXEL_MIN[A.kind]?.[tier];
            if (span > 0 && need && t.w / span < need) f(`texset texture ${t.name}: ${(t.w / span).toFixed(0)} px/m < ${need} px/m`);
          }
        } else {
          if (m.lods.length !== 1 || m.lods[0] !== lod) f(`expected only ${lod}, found ${m.lods.join(',') || 'none'}`);
          if (!m.col) f('no COL proxy');
        }
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
          // A4: breakage pieces of fragile props, fitted inside the same contract
          if (FRAGILE_KINDS.includes(A.kind) && A.id !== 'kit/brazier_tripod' && m.frac < 4) f(`fragile prop with ${m.frac} FRAC_* pieces (< 4)`);
          if (m.frac && r0 !== undefined && h0 !== undefined) {
            if (m.fracR > r0 + 0.005) f(`FRAC pieces reach r ${m.fracR.toFixed(4)} > PROP_BASE ${r0}`);
            if (m.fracYmin < -0.002 || m.fracYmax > h0 + 0.005) f(`FRAC pieces span y ${m.fracYmin.toFixed(4)}..${m.fracYmax.toFixed(4)} outside 0..${h0}`);
          }
          if (B && m.fracTris > B.fracTris) f(`FRAC tris ${m.fracTris} > ${B.fracTris}`);
        }
        // A4: sockets / nodes the runtime needs
        for (const sname of NEED_SOCK[`${A.role}|${A.kind}`] ?? []) if (!m.socks.some((s) => s.name.startsWith(sname))) f(`no ${sname}* socket`);
        for (const nname of NEED_NODE[`${A.role}|${A.kind}`] ?? []) if (!m.names.some((x) => x.startsWith(nname) || x.includes(`_${nname}`))) f(`no ${nname}* node`);
        if (A.role === 'feature') {
          const x = m.kit?.extras ?? {};
          if (!(x.r0 > 0) || !(x.height > 0)) f('feature: KIT_ extras r0 / height missing');
          else {
            if (Math.abs(m.ymax - x.height) > 0.01) f(`feature top ${m.ymax.toFixed(3)} != sim height ${x.height}`);
            if (m.rLow > x.r0 * OBSTACLE_FOOTPRINT_MAX + 0.005) f(`feature base footprint ${m.rLow.toFixed(3)} > ${OBSTACLE_FOOTPRINT_MAX} x r0 ${x.r0}`);
          }
          if (m.ymin < -0.01) f(`feature sinks ${(-m.ymin).toFixed(3)} m below the floor`);
          if (B && m.fracTris > B.fracTris) f(`FRAC tris ${m.fracTris} > ${B.fracTris}`);
        }
        if (A.role === 'hazard') {
          const x = m.kit?.extras ?? {};
          if (!(x.r0 > 0)) f('hazard: KIT_ extras r0 missing');
          else if (m.r > x.r0 * HAZARD_R_MAX + 0.005) f(`hazard visual r ${m.r.toFixed(3)} > ${HAZARD_R_MAX} x r0 ${x.r0}`);
        }
        if (A.role === 'cloth' && !m.alphaMask) f('cloth without an alphaMode MASK material (tear masks)');
        if (A.role === 'obstacle') {
          // A3: footprint vs the nominal sim radius, measured height vs extras, 9-slice band, fracture pieces
          const x = m.kit?.extras ?? {};
          if (!(x.r0 > 0)) f('obstacle: KIT_ extras r0 (nominal sim radius) missing');
          else if (m.r > x.r0 * OBSTACLE_FOOTPRINT_MAX + 0.005) f(`obstacle footprint ${m.r.toFixed(3)} m > ${OBSTACLE_FOOTPRINT_MAX} x r0 ${x.r0}`);
          if (Math.abs(m.ymax - (x.height ?? -1)) > 0.01) f(`top ${m.ymax.toFixed(3)} != extras height ${x.height}`);
          if (m.ymin < -0.12) f(`sinks ${(-m.ymin).toFixed(3)} m below the floor`);
          if (x.stretch === 'SHAFT' && !(m.shaft && m.shaft.y0 < m.shaft.y1 && m.shaft.y1 < m.ymax)) f('stretch SHAFT without a valid SHAFT {y0 < y1 < top} node');
          if (x.kind === 'column' && m.frac < 2) f(`only ${m.frac} FRAC_* pieces`);
          if (B && m.fracTris > B.fracTris) f(`FRAC tris ${m.fracTris} > ${B.fracTris}`);
        }
        if (A.role === 'module') {
          const x = m.kit?.extras ?? {};
          if (!x.trim) f('module without a trim extra (the shared texture set)');
          else if (!man.assets[x.trim]) f(`module trim ${x.trim} not in the manifest`);
          if (m.colored < m.meshes) f('module mesh without COLOR_0 (vertex AO)');
          if (Math.abs(m.ymax - (x.height ?? -1)) > 0.01) f(`top ${m.ymax.toFixed(3)} != extras height ${x.height}`);
        }
        if (B) {
          const triMax = tier === 'full' ? B.lod0Tris : B.lod1Tris;
          const texMax = tier === 'full' ? B.fullTex : B.lowTex;
          const byteMax = tier === 'full' ? B.fullBytes : B.lowBytes;
          if (m.tris > triMax) f(`${m.tris} tris > ${triMax}`);
          if (m.tex.some((t) => Math.max(t.w, t.h) > texMax)) f(texMax ? `texture over ${texMax}px` : 'textures in a module GLB (modules use the shared trim set)');
          if (m.prims > B.prims) f(`${m.prims} primitives > ${B.prims}`);
          if (m.bytes > byteMax) f(`${(m.bytes / MB).toFixed(2)} MB > ${(byteMax / MB).toFixed(2)} MB`);
        }
        const g = m.tex.reduce((s, t) => s + t.gpu, 0);
        gpu[tier][fmt] += g;
        rows.push([file, `${tier}/${fmt}`, String(m.tris) + (m.frac ? `+${m.fracTris}f` : ''), String(m.prims), m.r.toFixed(4), `${m.ymin.toFixed(4)}..${m.ymax.toFixed(4)}`, m.tex.map((t) => `${t.w}${t.codec[0]}`).join(' '), (g / MB).toFixed(2), (m.bytes / 1024).toFixed(0)]);
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
