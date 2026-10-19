// A21: lossless download cut for the fighter GLBs: every embedded PNG is re-encoded as LOSSLESS WebP (exact: the RGB
// under fully transparent texels is kept too) when that is smaller, and the GLB's image / texture entries switch to
// EXT_texture_webp. Pixels are identical (checked by decoding both with Pillow before writing); geometry, skins and
// the meshopt-compressed animation buffers are copied byte for byte (the BIN chunk is spliced, offsets shifted), so
// nothing is re-quantised. Gorak 5.4 -> 3.7 MB, Erika 3.6 -> 2.6 MB.
//   node tools/convert/webp_textures.mjs [public/models/<id>.glb ...]   (default: every model GLB with a PNG)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const PY = process.env.PYTHON || 'python';
const PY_WEBP = `import sys, io
from PIL import Image
import numpy as np
im = Image.open(sys.argv[1]); im.load()
b = io.BytesIO(); im.save(b, 'WEBP', lossless=True, method=6, quality=100, exact=True)
back = Image.open(io.BytesIO(b.getvalue())); back.load()
mode = 'RGBA' if 'A' in im.mode else 'RGB'
if not np.array_equal(np.asarray(im.convert(mode)), np.asarray(back.convert(mode))): sys.exit('not identical')
open(sys.argv[2], 'wb').write(b.getvalue())`;

const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync('public/models').filter((f) => f.endsWith('.glb')).map((f) => path.join('public/models', f));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webptex-'));
const pad4 = (n) => (n + 3) & ~3;
for (const file of files) {
  const glb = fs.readFileSync(file);
  if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
  const binHdr = 20 + jsonLen;
  const binLen = glb.readUInt32LE(binHdr);
  const bin = glb.subarray(binHdr + 8, binHdr + 8 + binLen);
  const pngs = (json.images ?? []).map((im, i) => ({ im, i })).filter(({ im }) => im.mimeType === 'image/png' && im.bufferView !== undefined);
  if (!pngs.length) continue;
  // replacement bytes per buffer-0 range [off, off + len)
  const repl = [];
  for (const { im, i } of pngs) {
    const bv = json.bufferViews[im.bufferView];
    if ((bv.buffer ?? 0) !== 0) continue;
    const off = bv.byteOffset ?? 0;
    const src = path.join(tmp, `img${i}.png`),
      dst = path.join(tmp, `img${i}.webp`);
    fs.writeFileSync(src, bin.subarray(off, off + bv.byteLength));
    const r = spawnSync(PY, ['-c', PY_WEBP, src, dst], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${file} image ${i}: ${r.stderr || r.stdout}`);
    const webp = fs.readFileSync(dst);
    if (webp.length >= bv.byteLength) continue;
    repl.push({ off, len: bv.byteLength, data: webp, bv, im });
  }
  if (!repl.length) continue;
  repl.sort((a, b) => a.off - b.off);
  // new BIN: copy the gaps, insert the WebP bytes (each range keeps a 4-byte aligned start)
  const parts = [];
  let cur = 0,
    out = 0;
  const shifts = []; // [oldStart, delta] for offsets >= oldStart
  for (const r of repl) {
    parts.push(bin.subarray(cur, r.off));
    out += r.off - cur;
    const newOff = out;
    parts.push(r.data, Buffer.alloc(pad4(r.data.length) - r.data.length));
    out += pad4(r.data.length);
    cur = pad4(r.off + r.len) <= bin.length ? pad4(r.off + r.len) : r.off + r.len;
    shifts.push({ start: r.off, end: cur, newOff, delta: out - cur });
    r.newOff = newOff;
  }
  parts.push(bin.subarray(cur));
  out += bin.length - cur;
  const newBin = Buffer.concat(parts);
  const mapOff = (o) => {
    for (let k = shifts.length - 1; k >= 0; k--) if (o >= shifts[k].end) return o + shifts[k].delta;
    for (const s of shifts) if (o >= s.start && o < s.end) throw new Error(`offset ${o} inside a replaced image`);
    return o;
  };
  for (const bv of json.bufferViews) {
    const r = repl.find((x) => x.bv === bv);
    if (r) {
      bv.byteOffset = r.newOff;
      bv.byteLength = r.data.length;
    } else if ((bv.buffer ?? 0) === 0) bv.byteOffset = mapOff(bv.byteOffset ?? 0);
    const mo = bv.extensions?.EXT_meshopt_compression;
    if (mo && (mo.buffer ?? 0) === 0) mo.byteOffset = mapOff(mo.byteOffset ?? 0);
  }
  json.buffers[0].byteLength = newBin.length;
  for (const r of repl) r.im.mimeType = 'image/webp';
  const webpImages = new Set(repl.map((r) => json.images.indexOf(r.im)));
  for (const t of json.textures ?? []) {
    if (!webpImages.has(t.source)) continue;
    t.extensions = { ...(t.extensions ?? {}), EXT_texture_webp: { source: t.source } };
    delete t.source;
  }
  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), 'EXT_texture_webp'])];
  json.extensionsRequired = [...new Set([...(json.extensionsRequired ?? []), 'EXT_texture_webp'])];
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  js = Buffer.concat([js, Buffer.alloc(pad4(js.length) - js.length, 0x20)]);
  const binPadded = Buffer.concat([newBin, Buffer.alloc(pad4(newBin.length) - newBin.length)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + js.length + 8 + binPadded.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(js.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(binPadded.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  const before = glb.length;
  fs.writeFileSync(file, Buffer.concat([head, jh, js, bh, binPadded]));
  console.log(`${file}: ${repl.length} PNG -> lossless WebP, ${(before / 1048576).toFixed(2)} -> ${(fs.statSync(file).size / 1048576).toFixed(2)} MB`);
}
fs.rmSync(tmp, { recursive: true, force: true });
