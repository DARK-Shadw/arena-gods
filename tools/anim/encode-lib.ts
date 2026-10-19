/**
 * A21: re-encode the shipped animation library bins (public/anim/<lib>.bin, raw int16 from build-lib.ts before A21)
 * into the lossless 'tdp1' transport coding (src/render/animCodec.ts) and mark index.json `enc: 'tdp1'`.
 * Verifies the round trip value by value before writing. build-lib.ts writes 'tdp1' itself from A21 on.
 *   npx tsx tools/anim/encode-lib.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeLib, encodeLib, type CodecClip } from '../../src/render/animCodec';

const DIR = path.resolve('public/anim');
const ixPath = path.join(DIR, 'index.json');
const ix = JSON.parse(fs.readFileSync(ixPath, 'utf8')) as { enc?: string; clips: CodecClip[] };
if (ix.enc) {
  console.log(`index.json already '${ix.enc}', nothing to do`);
  process.exit(0);
}
const libs = [...new Set(ix.clips.map((c) => c.lib))];
for (const lib of libs) {
  const f = path.join(DIR, `${lib}.bin`);
  const b = fs.readFileSync(f);
  const raw = new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  const clips = ix.clips.filter((c) => c.lib === lib);
  const enc = encodeLib(raw, clips);
  const back = decodeLib(enc, clips);
  for (let i = 0; i < raw.length; i++) if (back[i] !== raw[i]) throw new Error(`${lib}: round trip differs at ${i}`);
  fs.writeFileSync(f, enc);
  const gz = (x: Uint8Array) => zlib.gzipSync(x, { level: 6 }).length / 1048576;
  console.log(`${lib}.bin ${(b.length / 1048576).toFixed(2)} MB: gzip ${gz(b).toFixed(2)} -> ${gz(enc).toFixed(2)} MB (round trip exact)`);
}
ix.enc = 'tdp1';
fs.writeFileSync(ixPath, JSON.stringify(ix));
console.log('index.json: enc tdp1');
