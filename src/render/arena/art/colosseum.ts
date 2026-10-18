/**
 * Colosseum ThemeArt (kit mode). A2 gives it the wet floor (blue-grey flagstone + the Moon Gate engraved ring) and,
 * until A7 builds "The Moon Gate" for real, a NIGHT PREVIEW of its look (plan 3.1 / 3.3: moon az -1.7, elev 27,
 * #d8d4ff, inside the arch from the ref-3 camera; violet ground mist; indigo shadows) plus ten decorative tripod
 * braziers on the boundary, so the floor has a moon and fires to reflect. `?moongate=0` keeps the floor but drops
 * the preview look and the braziers (the golden-hour colosseum on a wet floor); `?arena=legacy` is unchanged.
 */
import * as THREE from 'three';
import type { ThemeArt } from './types';

const dirFrom = (elevDeg: number, azDeg: number) => {
  const e = (elevDeg * Math.PI) / 180,
    a = (azDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)).normalize();
};
const C = (c: string) => new THREE.Color(c);
const hdr = (c: string, k: number) => new THREE.Color(c).multiplyScalar(k);
const MOON = dirFrom(27, -1.7);

export const COLOSSEUM_ART: ThemeArt = {
  id: 'colosseum',
  floor: { set: 'floor/flagstone_bluegrey', inlay: 'floor/inlay_moongate', wetness: 0.9, puddles: 0.35 },
  // A4: ref-3's big bowls on stone pedestals alternate with the tripods (the pedestal flame is bigger: SOCK_flame size)
  ringFlames: { asset: 'kit/brazier_tripod', assets: ['kit/brazier_pedestal', 'kit/brazier_tripod'], count: 10, offset: 0.55, size: 0.95 },
  // A3: the shared stone kit. Square masonry pillars (ref-3) for the sim's columns (every third one a fluted ruin column),
  // rubble piles for the indestructible boulders; podium wall, gallery arcade and wall-foot rubble from the trim-sheet
  // modules. A7 replaces the rest of the legacy ring (stands, gates) and places stairs / dais / statues by the east gate.
  obstacles: { column: ['kit/pillar_square', 'kit/pillar_square', 'kit/column_ruin'], rock: 'kit/rubble_pile' },
  ring: {
    trim: 'kit/stone_trim',
    podium: { intact: ['kit/wall_a', 'kit/wall_b'], broken: ['kit/wall_broken'], brokenShare: 0.5, offset: 0.9, spacing: 3.85, gateHalf: 4.6 },
    gallery: { assets: ['kit/arcade_bay', 'kit/arcade_broken', 'kit/arcade_broken'] },
    rubble: { asset: 'kit/rubble_scatter', spacing: 7.5, offset: 0.35 },
    retint: [0.36, 0.37, 0.43],
    // A4: the shared dressing kit on the ring: kit wall braziers, the wall banners as tattered kit banners on rods and short
    // chains (one merged swaying mesh), candles / skulls / bone piles at the wall foot
    wallBraziers: { asset: 'kit/brazier_wall' },
    wallBanners: { w: 1.25, h: 2.6, rod: true, chains: true },
    decor: { assets: ['kit/candles', 'kit/skull', 'kit/bone_pile', 'kit/candles'], spacing: 6.5, offset: 0.25, skip: 0.45 },
  },
  look: {
    sky: {
      sunDir: MOON,
      sunColor: hdr('#d8d4ff', 2),
      sunSize: 0,
      sunGlow: 0,
      zenith: C('#0a0d26'),
      horizon: C('#363866'),
      ground: C('#15132a'),
      horizonGlow: C('#5c4c9a'),
      cloudCover: 0.5,
      cloudScale: 0.75,
      cloudColor: C('#8a86b4'),
      cloudShade: C('#1a1934'),
      stars: 0.45,
      moonDir: MOON,
      moonSize: 0.08,
      moonColor: hdr('#ece8ff', 2.4),
    },
    sunIntensity: 1.5,
    sunColor: '#c9c4ff',
    hemi: ['#4c4a8c', '#1c1828', 0.6],
    fog: { color: '#3b3462', density: 0.0065, height: 0.07 },
    exposure: 1.15,
    bloom: { strength: 0.45, radius: 0.65, threshold: 1.2 },
    grade: { tint: [0.99, 0.98, 1.04], contrast: 1.12, saturation: 1.04, lift: [0.0, 0.0, 0.02], gain: [1.02, 1.0, 1.0], vignette: 0.95 },
    godrays: 0, // moon rays cost about 1.5 ms on high (A2 measurement); A7 decides
    ambient: ['embers'],
    fire: '#ff7a2a',
    key: '#c8c8ff',
    rim: '#b4b0ff', // the camera rim light sits behind the fighters: on the wet floor it is the moonlit sheen
    accent: '#ff8a40',
    lookId: 'moonlake',
  },
};
