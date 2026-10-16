/**
 * Procedural PBR texture sets (albedo + normal + roughness/metalness [+ emissive]),
 * generated on the CPU at load time from tiling noise. Every recipe is seamless
 * (periodic noise) so it can repeat across large surfaces; materials add a
 * world-space macro variation on top to hide the repetition.
 */
import * as THREE from 'three';
import { fbm2, hash2, vnoise2, worley2 } from './noise';

export interface Px {
  /** albedo 0..1 (sRGB) */
  r: number;
  g: number;
  b: number;
  /** height 0..1 */
  h: number;
  /** roughness 0..1 */
  ro: number;
  /** metalness 0..1 */
  me?: number;
  /** emissive 0..1 (sRGB) */
  er?: number;
  eg?: number;
  eb?: number;
}
export interface TexSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  ormMap: THREE.Texture;
  emissiveMap?: THREE.Texture;
}

const cache = new Map<string, TexSet>();
const px: Px = { r: 0, g: 0, b: 0, h: 0, ro: 1 };

function makeTex(data: Uint8ClampedArray, size: number, srgb: boolean): THREE.Texture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Generate a texture set. fn receives tiling coords u,v in [0,1) and writes the pixel.
 * normalStrength scales the height-derived normal.
 */
export function genSet(key: string, size: number, normalStrength: number, fn: (u: number, v: number, p: Px) => void, emissive = false): TexSet {
  const hit = cache.get(key);
  if (hit) return hit;
  const N = size * size;
  const alb = new Uint8ClampedArray(N * 4);
  const orm = new Uint8ClampedArray(N * 4);
  const emi = emissive ? new Uint8ClampedArray(N * 4) : null;
  const H = new Float32Array(N);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      px.me = 0;
      px.er = px.eg = px.eb = 0;
      fn(x / size, y / size, px);
      alb[i * 4] = px.r * 255;
      alb[i * 4 + 1] = px.g * 255;
      alb[i * 4 + 2] = px.b * 255;
      alb[i * 4 + 3] = 255;
      orm[i * 4] = 255;
      orm[i * 4 + 1] = px.ro * 255;
      orm[i * 4 + 2] = (px.me ?? 0) * 255;
      orm[i * 4 + 3] = 255;
      H[i] = px.h;
      if (emi) {
        emi[i * 4] = (px.er ?? 0) * 255;
        emi[i * 4 + 1] = (px.eg ?? 0) * 255;
        emi[i * 4 + 2] = (px.eb ?? 0) * 255;
        emi[i * 4 + 3] = 255;
      }
    }
  const nor = new Uint8ClampedArray(N * 4);
  const k = normalStrength * size / 256;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size,
        xp = (x + 1) % size,
        ym = (y - 1 + size) % size,
        yp = (y + 1) % size;
      const dx = (H[y * size + xp] - H[y * size + xm]) * k;
      const dy = (H[yp * size + x] - H[ym * size + x]) * k;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      nor[i] = (-dx / l) * 127.5 + 127.5;
      nor[i + 1] = (dy / l) * 127.5 + 127.5;
      nor[i + 2] = (1 / l) * 127.5 + 127.5;
      nor[i + 3] = 255;
    }
  const set: TexSet = { map: makeTex(alb, size, true), normalMap: makeTex(nor, size, false), ormMap: makeTex(orm, size, false), emissiveMap: emi ? makeTex(emi, size, true) : undefined };
  cache.set(key, set);
  return set;
}

// ------------------------------------------------------------------ helpers
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const sstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function setC(p: Px, c: [number, number, number], k = 1) {
  p.r = clamp01(c[0] * k);
  p.g = clamp01(c[1] * k);
  p.b = clamp01(c[2] * k);
}
function mixC(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

/** marble pattern value: 0 = base, 1 = vein */
function marbleVein(u: number, v: number, seed: number, P: number) {
  const n = fbm2(u * P, v * P, 5, seed, P);
  const w = fbm2(u * P * 2 + 3.1, v * P * 2, 4, seed + 5, P * 2);
  const s = Math.sin((u + v * 0.6 + n * 1.6 + w * 0.35) * Math.PI * 2 * 2);
  const vein = Math.pow(1 - Math.abs(s), 18);
  const fine = Math.pow(1 - Math.abs(Math.sin((u * 0.7 - v + w * 1.2) * Math.PI * 2 * 3)), 40) * 0.5;
  return { vein: clamp01(vein + fine), cloud: n };
}

// ------------------------------------------------------------------ recipes
export const TEX = {
  /** polished marble slab */
  marble(base: string, vein: string, seed = 1, rough = 0.28): TexSet {
    const B = hex(base),
      V = hex(vein);
    return genSet(`marble:${base}:${vein}:${seed}`, 512, 0.6, (u, v, p) => {
      const m = marbleVein(u, v, seed, 3);
      const c = mixC(B, V, m.vein * 0.85);
      setC(p, c, 0.9 + m.cloud * 0.18);
      p.h = 0.5 - m.vein * 0.08;
      p.ro = rough + m.vein * 0.12 + (vnoise2(u * 64, v * 64, seed, 64) - 0.5) * 0.06;
    });
  },
  /** floor of square marble tiles with grout and an optional gold border inlay */
  marbleTiles(base: string, base2: string, vein: string, grout: string, tiles = 4, gold = false, seed = 2): TexSet {
    const B = hex(base),
      B2 = hex(base2),
      V = hex(vein),
      G = hex(grout),
      Au = hex('#d8b25a');
    return genSet(`mtiles:${base}:${base2}:${vein}:${tiles}:${gold}:${seed}`, 1024, 1.2, (u, v, p) => {
      const tx = Math.floor(u * tiles),
        ty = Math.floor(v * tiles);
      const fx = u * tiles - tx,
        fy = v * tiles - ty;
      const alt = (tx + ty) % 2 === 0;
      const rot = hash2(tx, ty, seed) > 0.5;
      const m = marbleVein(rot ? fy / tiles + tx * 0.37 : fx / tiles + ty * 0.23, rot ? fx / tiles : fy / tiles, seed + (alt ? 0 : 9), 3);
      const e = Math.min(fx, fy, 1 - fx, 1 - fy);
      const groutW = 0.012;
      const bevel = sstep(groutW, groutW + 0.02, e);
      let c = mixC(alt ? B : B2, V, m.vein * 0.8);
      c = mixC(c, c.map((x) => x * (0.85 + hash2(tx, ty, seed + 3) * 0.25)) as [number, number, number], 0.6);
      let rough = 0.22 + m.vein * 0.1;
      let metal = 0;
      if (gold) {
        const ring = Math.abs(e - 0.08);
        if (ring < 0.01) {
          c = Au;
          rough = 0.3;
          metal = 1;
        }
      }
      if (e < groutW) {
        c = G;
        rough = 0.9;
        metal = 0;
      }
      // fine wear
      const wear = fbm2(u * 16, v * 16, 3, seed + 4, 16);
      setC(p, c, 0.92 + wear * 0.14);
      p.h = 0.25 + bevel * 0.6 - m.vein * 0.03;
      p.ro = clamp01(rough + (wear - 0.5) * 0.15);
      p.me = metal;
    });
  },
  /** raked arena sand */
  sand(base = '#c9a173', seed = 3, ripples = true): TexSet {
    const B = hex(base);
    return genSet(`sand:${base}:${seed}:${ripples}`, 1024, 0.9, (u, v, p) => {
      const n = fbm2(u * 8, v * 8, 4, seed, 8);
      const grain = hash2(Math.floor(u * 1024), Math.floor(v * 1024), seed);
      const rip = ripples ? Math.sin((v * 22 + fbm2(u * 3, v * 3, 3, seed + 2, 3) * 2.5) * Math.PI * 2) * 0.5 + 0.5 : 0.5;
      const prints = fbm2(u * 24, v * 24, 2, seed + 9, 24);
      setC(p, B, 0.82 + n * 0.28 + (grain - 0.5) * 0.12 - rip * 0.05);
      p.h = rip * 0.35 + n * 0.4 + grain * 0.08 + prints * 0.1;
      p.ro = 0.92 - grain * 0.06;
    });
  },
  /** irregular flagstones with (mossy) joints */
  flagstones(stone: string, joint: string, seed = 4, moss = 0, cells = 6, wet = 0): TexSet {
    const S = hex(stone),
      J = hex(joint),
      M = hex('#4f6b2c');
    return genSet(`flag:${stone}:${joint}:${seed}:${moss}:${cells}:${wet}`, 1024, 1.4, (u, v, p) => {
      const [f1, f2, id] = worley2(u * cells + fbm2(u * 9, v * 9, 2, seed, 9) * 0.25, v * cells, seed, cells);
      const edge = f2 - f1;
      const stoneK = sstep(0.025, 0.075, edge);
      const n = fbm2(u * 20, v * 20, 4, seed + 3, 20);
      const tint = 0.82 + id * 0.3;
      let c = S.map((x) => x * tint) as [number, number, number];
      c = mixC(c, c.map((x) => x * 0.7) as [number, number, number], n * 0.6);
      const mossK = moss * clamp01((1 - stoneK) * 1.4 + (fbm2(u * 6, v * 6, 3, seed + 8, 6) - 0.55) * 2.2 * (1 - stoneK * 0.6));
      const jc = mixC(J, M, Math.min(1, moss * 1.2));
      c = mixC(jc, c, stoneK);
      c = mixC(c, M.map((x) => x * (0.8 + n * 0.4)) as [number, number, number], clamp01(mossK));
      setC(p, c, 1);
      const puddle = wet > 0 ? sstep(0.55, 0.62, fbm2(u * 3, v * 3, 3, seed + 21, 3)) * wet : 0;
      p.h = stoneK * (0.6 + n * 0.25) + mossK * 0.1;
      p.ro = clamp01(mix(0.95, 0.72 - wet * 0.3, stoneK) - n * 0.08 - puddle * 0.6);
    });
  },
  /** ashlar block wall (rows of cut stone), e.g. travertine, sandstone, basalt */
  blocks(stone: string, mortar: string, rows = 4, cols = 3, seed = 5, pores = 0.5, strata = 0): TexSet {
    const S = hex(stone),
      Mo = hex(mortar);
    return genSet(`blocks:${stone}:${mortar}:${rows}:${cols}:${seed}:${pores}:${strata}`, 512, 1.2, (u, v, p) => {
      const ry = Math.floor(v * rows);
      const off = (ry % 2) * 0.5;
      const cx = Math.floor(u * cols + off);
      const fx = u * cols + off - cx,
        fy = v * rows - ry;
      const e = Math.min(fx * cols * 0.5, (1 - fx) * cols * 0.5, fy, 1 - fy) / rows;
      const blockK = sstep(0.004, 0.012, e + (fbm2(u * 30, v * 30, 2, seed, 30) - 0.5) * 0.006);
      const n = fbm2(u * 12, v * 12, 5, seed + 2, 12);
      const pore = pores > 0 ? sstep(0.12, 0.05, worley2(u * 40, v * 40, seed + 4, 40)[0]) * pores : 0;
      const strat = strata > 0 ? (Math.sin(v * rows * 9 * Math.PI + n * 4) * 0.5 + 0.5) * strata : 0;
      const tint = 0.85 + hash2(cx % cols, ry, seed) * 0.25;
      let c = S.map((x) => x * tint * (0.86 + n * 0.28) * (1 - strat * 0.18)) as [number, number, number];
      c = c.map((x) => x * (1 - pore * 0.45)) as [number, number, number];
      c = mixC(Mo, c, blockK);
      setC(p, c, 1);
      p.h = blockK * (0.55 + n * 0.35) - pore * 0.2 - strat * 0.05;
      p.ro = mix(0.95, 0.78 - n * 0.1, blockK);
    });
  },
  /** obsidian / basalt slabs with glowing magma cracks */
  basalt(seed = 6, glow = 1): TexSet {
    const D = hex('#2a2629'),
      D2 = hex('#463c3a');
    return genSet(`basalt:${seed}:${glow}`, 1024, 1.8, (u, v, p) => {
      const [f1, f2] = worley2(u * 7 + fbm2(u * 6, v * 6, 3, seed, 6) * 0.35, v * 7, seed, 7);
      const edge = f2 - f1;
      const crack = 1 - sstep(0.0, 0.035, edge);
      const n = fbm2(u * 18, v * 18, 5, seed + 1, 18);
      const glass = sstep(0.62, 0.7, fbm2(u * 9, v * 9, 4, seed + 7, 9));
      const c = mixC(D, D2, n * 0.9).map((x) => x * 1.15) as [number, number, number];
      setC(p, mixC(c, [0.1, 0.03, 0.02], crack), 1);
      p.h = (1 - crack) * (0.55 + n * 0.3);
      p.ro = mix(0.78, 0.22, glass) + crack * 0.2;
      const hot = Math.pow(crack, 2.0) * glow * sstep(0.35, 0.65, fbm2(u * 4, v * 4, 2, seed + 3, 4));
      p.er = clamp01(hot * 1.0);
      p.eg = clamp01(hot * 0.36);
      p.eb = clamp01(hot * 0.06);
    }, true);
  },
  /** glacier ice with frost and deep cracks */
  ice(seed = 7): TexSet {
    const A = hex('#a9d8f0'),
      B = hex('#e8f8ff'),
      Deep = hex('#3f86b8');
    return genSet(`ice:${seed}`, 1024, 0.8, (u, v, p) => {
      const n = fbm2(u * 5, v * 5, 5, seed, 5);
      const [f1, f2] = worley2(u * 5, v * 5, seed + 1, 5);
      const crack = 1 - sstep(0.0, 0.025, f2 - f1);
      const frost = sstep(0.5, 0.75, fbm2(u * 14, v * 14, 4, seed + 2, 14));
      const snow = sstep(0.58, 0.7, fbm2(u * 3, v * 3, 4, seed + 5, 3));
      let c = mixC(Deep, A, 0.45 + n * 0.55);
      c = mixC(c, B, frost * 0.6);
      c = mixC(c, [0.96, 0.98, 1], snow);
      c = mixC(c, [0.92, 0.97, 1], crack * 0.8);
      setC(p, c, 1);
      p.h = n * 0.3 + snow * 0.4 - crack * 0.25 + frost * 0.05;
      p.ro = clamp01(0.06 + frost * 0.35 + snow * 0.7 + crack * 0.2);
    });
  },
  /** fresh snow */
  snow(seed = 8): TexSet {
    return genSet(`snow:${seed}`, 512, 0.7, (u, v, p) => {
      const n = fbm2(u * 6, v * 6, 5, seed, 6);
      const sp = hash2(Math.floor(u * 512), Math.floor(v * 512), seed) > 0.995 ? 1 : 0;
      setC(p, [0.9 + n * 0.08, 0.94 + n * 0.05, 1], 1);
      p.h = n;
      p.ro = 0.75 - sp * 0.6;
    });
  },
  /** wood planks / staves */
  wood(base = '#7a5232', seed = 9, planks = 4): TexSet {
    const B = hex(base);
    return genSet(`wood:${base}:${seed}:${planks}`, 512, 1.0, (u, v, p) => {
      const pi = Math.floor(u * planks);
      const fx = u * planks - pi;
      const gap = sstep(0.0, 0.04, Math.min(fx, 1 - fx));
      const grain = fbm2(u * 6 + pi * 3.3, v * 60, 3, seed + pi, 0);
      const ring = Math.sin((grain * 10 + fx * 3) * Math.PI) * 0.5 + 0.5;
      const knot = sstep(0.07, 0.0, Math.hypot(fx - 0.5, ((v * 3 + pi * 0.37) % 1) - 0.5) - 0.02 * hash2(pi, 0, seed));
      const tint = 0.8 + hash2(pi, 1, seed) * 0.35;
      setC(p, B, tint * (0.75 + ring * 0.3) * (1 - knot * 0.4) * (0.4 + gap * 0.6));
      p.h = gap * (0.6 + ring * 0.15) - knot * 0.1;
      p.ro = 0.82 - ring * 0.1;
    });
  },
  /** hammered / brushed metal */
  metal(base: string, seed = 10, rough = 0.35): TexSet {
    const B = hex(base);
    return genSet(`metal:${base}:${seed}:${rough}`, 256, 0.6, (u, v, p) => {
      const n = fbm2(u * 8, v * 8, 4, seed, 8);
      const dent = worley2(u * 10, v * 10, seed + 1, 10)[0];
      setC(p, B, 0.85 + n * 0.3);
      p.h = dent * 0.5 + n * 0.2;
      p.ro = clamp01(rough + (n - 0.5) * 0.25);
      p.me = 1;
    });
  },
  /** tree bark */
  bark(base = '#4a3428', seed = 11): TexSet {
    const B = hex(base);
    return genSet(`bark:${base}:${seed}`, 256, 1.6, (u, v, p) => {
      const n = fbm2(u * 6, v * 2, 4, seed, 0);
      const ridge = Math.abs(Math.sin((u * 8 + n * 2) * Math.PI));
      setC(p, B, 0.6 + ridge * 0.5);
      p.h = ridge;
      p.ro = 0.95;
    });
  },
  /** sandstone (desert): warm layered stone */
  sandstone(seed = 12): TexSet {
    return TEX.blocks('#d79a62', '#a26a42', 4, 2, seed, 0.25, 0.6);
  },
};

// ------------------------------------------------------------------ sprite / alpha canvases
export function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** soft round particle sprite */
export const softDot = () =>
  canvasTexture(64, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  });

/** cherry petal sprite */
export const petalSprite = () =>
  canvasTexture(64, (g, s) => {
    g.translate(s / 2, s / 2);
    g.rotate(0.6);
    const grd = g.createLinearGradient(0, -s * 0.4, 0, s * 0.4);
    grd.addColorStop(0, '#fff2f6');
    grd.addColorStop(1, '#f7a9c4');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(0, s * 0.42);
    g.bezierCurveTo(s * 0.34, s * 0.2, s * 0.3, -s * 0.3, s * 0.06, -s * 0.42);
    g.lineTo(0, -s * 0.34);
    g.lineTo(-s * 0.06, -s * 0.42);
    g.bezierCurveTo(-s * 0.3, -s * 0.3, -s * 0.34, s * 0.2, 0, s * 0.42);
    g.fill();
  });

/** blossom / leaf canopy card (alpha) */
export const foliageCard = (c1: string, c2: string, seed = 1) =>
  canvasTexture(256, (g, s) => {
    let r = seed * 9301 + 49297;
    const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
    for (let i = 0; i < 260; i++) {
      const a = rnd() * Math.PI * 2,
        d = Math.pow(rnd(), 0.6) * s * 0.42;
      const x = s / 2 + Math.cos(a) * d,
        y = s / 2 + Math.sin(a) * d * 0.8;
      const rr = s * (0.018 + rnd() * 0.03);
      g.fillStyle = rnd() < 0.5 ? c1 : c2;
      g.globalAlpha = 0.75 + rnd() * 0.25;
      g.beginPath();
      g.ellipse(x, y, rr, rr * 0.8, rnd() * 3, 0, Math.PI * 2);
      g.fill();
    }
  });
