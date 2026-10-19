/**
 * A21: lossless transport coding for the shared animation library bins (public/anim/<lib>.bin), 'tdp1':
 *   1. per track (each bone's x / y / z / w quaternion component over the clip's frames, then the hips / root
 *      curves' six components) the values are stored planar and as frame-to-frame differences (int16, wrapping),
 *   2. the int16 stream is split into a block of low bytes followed by a block of high bytes.
 * Smooth curves turn into long runs of small numbers that gzip (GitHub Pages / any static host) packs about 45 %
 * smaller (core 4.7 -> 2.6 MB on the wire). Decoding restores the exact int16 values, so every pose is bit-identical.
 * Layout per clip (from index.json): at `off`, for each bone (static bones: 1 frame) frames x 4 values, then n x 6
 * (hips x y z, root x z yaw); clips of a lib are contiguous.
 */
export interface CodecClip {
  lib: string;
  off: number;
  n: number;
  bones: number[]; // nameIdx * 2 + static
}

/** calls fn(start, frames, components) for every track block of a lib in file order; returns the end offset */
function blocks(clips: CodecClip[], fn: (start: number, frames: number, comps: number) => void): { covered: number; ok: boolean } {
  const sorted = [...clips].sort((a, b) => a.off - b.off);
  let p = 0;
  let ok = true;
  for (const c of sorted) {
    if (c.off !== p) ok = false;
    p = c.off;
    for (const b of c.bones) {
      const fr = (b & 1) === 1 ? 1 : c.n;
      fn(p, fr, 4);
      p += fr * 4;
    }
    fn(p, c.n, 6);
    p += c.n * 6;
  }
  return { covered: p, ok };
}

/** raw interleaved int16 -> 'tdp1' bytes */
export function encodeLib(raw: Int16Array, clips: CodecClip[]): Uint8Array {
  const y = new Int16Array(raw.length);
  const r = blocks(clips, (s, fr, k) => {
    for (let c = 0; c < k; c++) {
      let prev = 0;
      for (let f = 0; f < fr; f++) {
        const v = raw[s + f * k + c];
        y[s + c * fr + f] = v - prev; // Int16Array wraps
        prev = v;
      }
    }
  });
  if (!r.ok || r.covered !== raw.length) throw new Error(`animCodec: clips cover ${r.covered} of ${raw.length} values (or overlap)`);
  const n = y.length;
  const out = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const v = y[i] & 0xffff;
    out[i] = v & 0xff;
    out[n + i] = v >> 8;
  }
  return out;
}

/** 'tdp1' bytes -> raw interleaved int16 (exact) */
export function decodeLib(bytes: Uint8Array, clips: CodecClip[]): Int16Array {
  const n = bytes.length >> 1;
  const y = new Int16Array(n);
  for (let i = 0; i < n; i++) y[i] = bytes[i] | (bytes[n + i] << 8);
  const raw = new Int16Array(n);
  const r = blocks(clips, (s, fr, k) => {
    for (let c = 0; c < k; c++) {
      let acc = 0;
      for (let f = 0; f < fr; f++) {
        acc = (acc + y[s + c * fr + f]) << 16 >> 16;
        raw[s + f * k + c] = acc;
      }
    }
  });
  if (!r.ok || r.covered !== n) throw new Error(`animCodec: clips cover ${r.covered} of ${n} values`);
  return raw;
}
