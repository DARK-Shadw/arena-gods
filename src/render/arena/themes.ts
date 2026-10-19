/**
 * Visual themes: sky, light, fog, grading and ambience per arena theme.
 * (Geometry / dressing lives in arenaView.ts + backdrops.ts.)
 */
import * as THREE from 'three';
import type { ThemeId } from '../../sim/arenaGen';
import type { SkyParams } from './sky';

export type AmbientKind = 'dust' | 'motes' | 'petals' | 'embers' | 'snow' | 'fireflies' | 'sand' | 'embersFine';

export interface Grade {
  tint: [number, number, number];
  contrast: number;
  saturation: number;
  lift: [number, number, number];
  gain: [number, number, number];
  vignette: number;
}

export interface ThemeDef {
  id: ThemeId;
  name: string;
  tagline: string;
  sky: SkyParams;
  sunIntensity: number;
  sunColor: string;
  hemi: [string, string, number];
  fog: { color: string; density: number; height: number };
  exposure: number;
  bloom: { strength: number; radius: number; threshold: number };
  grade: Grade;
  godrays: number;
  ambient: AmbientKind[];
  /** ring-of-fire flame tint */
  fire: string;
  /** camera key / rim light tints for fighter readability */
  key: string;
  rim: string;
  /** colour of gate / accent lights */
  accent: string;
  /** A2: fxLook.ts THEME_LOOK row to use instead of `id` (kit-mode look overrides) */
  lookId?: string;
}

const C = (c: string) => new THREE.Color(c);
const dirFrom = (elevDeg: number, azDeg: number) => {
  const e = (elevDeg * Math.PI) / 180,
    a = (azDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)).normalize();
};
const hdr = (c: string, k: number) => new THREE.Color(c).multiplyScalar(k);

function sky(o: Partial<SkyParams> & { sunDir: THREE.Vector3 }): SkyParams {
  return {
    sunColor: hdr('#fff1d8', 30),
    sunSize: 0.012,
    sunGlow: 1,
    zenith: C('#2f63b8'),
    horizon: C('#bcd6f2'),
    ground: C('#6d7f92'),
    horizonGlow: C('#000000'),
    cloudCover: 0.4,
    cloudScale: 0.9,
    cloudColor: C('#ffffff'),
    cloudShade: C('#9aa8bd'),
    cloudSpeed: 0.004,
    stars: 0,
    aurora: 0,
    auroraA: C('#30ff90'),
    auroraB: C('#9040ff'),
    moonDir: new THREE.Vector3(0, 1, 0),
    moonSize: 0,
    moonColor: hdr('#ffffff', 2),
    ...o,
  };
}

export const THEME_DEFS: Record<ThemeId, ThemeDef> = {
  colosseum: {
    id: 'colosseum',
    name: 'The Gilded Colosseum',
    tagline: 'golden hour over ten thousand roaring voices',
    sky: sky({
      sunDir: dirFrom(13, 200),
      sunColor: hdr('#ffd9a0', 34),
      zenith: C('#3a69ad'),
      horizon: C('#f4c494'),
      ground: C('#9a7458'),
      horizonGlow: C('#ff9548'),
      cloudCover: 0.42,
      cloudScale: 0.8,
      cloudColor: C('#fff0da'),
      cloudShade: C('#a3809a'),
    }),
    sunIntensity: 3.4,
    sunColor: '#ffd2a0',
    hemi: ['#a9c4ee', '#c78f5e', 0.75],
    fog: { color: '#e7b88e', density: 0.0065, height: 0.004 },
    exposure: 1.0,
    bloom: { strength: 0.38, radius: 0.55, threshold: 1.9 },
    grade: { tint: [1.03, 1.0, 0.95], contrast: 1.08, saturation: 1.14, lift: [0.0, 0.005, 0.02], gain: [1.03, 1.0, 0.95], vignette: 0.85 },
    godrays: 0.25,
    ambient: ['dust'],
    fire: '#ff8a30',
    key: '#ffe0c0',
    rim: '#ffd6a0',
    accent: '#ffb060',
  },
  skytemple: {
    id: 'skytemple',
    name: 'The Sky Sanctum',
    tagline: 'a marble ring floating above an ocean of cloud',
    sky: sky({
      sunDir: dirFrom(21, 140),
      sunColor: hdr('#ffe7c4', 34),
      zenith: C('#1544a8'),
      horizon: C('#bcd2f0'),
      ground: C('#dfe6f6'),
      horizonGlow: C('#ffd2a0'),
      cloudCover: 0.32,
      cloudScale: 0.7,
      cloudColor: C('#fff4e6'),
      cloudShade: C('#9aa6cc'),
    }),
    sunIntensity: 3.0,
    sunColor: '#ffe6c2',
    hemi: ['#8fb2ec', '#c9cde0', 0.55],
    fog: { color: '#bcd4f2', density: 0.0028, height: 0.0 },
    exposure: 0.92,
    bloom: { strength: 0.26, radius: 0.5, threshold: 2.6 },
    grade: { tint: [1.0, 1.01, 1.03], contrast: 1.06, saturation: 1.1, lift: [0.0, 0.0, 0.015], gain: [1.02, 1.01, 1.0], vignette: 0.75 },
    godrays: 0.18,
    ambient: ['motes'],
    fire: '#7fd8ff',
    key: '#fff4e4',
    rim: '#bfe0ff',
    accent: '#ffe08a',
  },
  sakura: {
    id: 'sakura',
    name: 'The Blossom Shrine',
    tagline: 'spring wind, falling petals, an old shrine that has seen many duels',
    sky: sky({
      sunDir: dirFrom(26, 320),
      sunColor: hdr('#ffeedd', 30),
      zenith: C('#6fa6e0'),
      horizon: C('#f6d8e2'),
      ground: C('#b89aa8'),
      horizonGlow: C('#ffc6b0'),
      cloudCover: 0.48,
      cloudScale: 0.85,
      cloudColor: C('#fff6f6'),
      cloudShade: C('#b7a3bd'),
    }),
    sunIntensity: 2.9,
    sunColor: '#ffeedd',
    hemi: ['#c8d8ff', '#a5b47a', 0.85],
    fog: { color: '#f0d6e0', density: 0.0072, height: 0.006 },
    exposure: 1.02,
    bloom: { strength: 0.4, radius: 0.6, threshold: 1.8 },
    grade: { tint: [1.03, 0.99, 1.0], contrast: 1.04, saturation: 1.12, lift: [0.02, 0.01, 0.025], gain: [1.02, 1.0, 1.0], vignette: 0.8 },
    godrays: 0.25,
    ambient: ['petals'],
    fire: '#ff9a50',
    key: '#fff0e8',
    rim: '#ffd0e0',
    accent: '#ff7a5a',
  },
  forge: {
    id: 'forge',
    name: 'The Molten Forge',
    tagline: 'a cathedral of basalt where rivers of fire run',
    sky: sky({
      sunDir: dirFrom(55, 30),
      sunColor: hdr('#ff9a50', 4),
      sunSize: 0.0,
      sunGlow: 0.2,
      zenith: C('#120604'),
      horizon: C('#4a160a'),
      ground: C('#7a2a10'),
      horizonGlow: C('#c8400c'),
      cloudCover: 0.78,
      cloudScale: 0.6,
      cloudColor: C('#8a3420'),
      cloudShade: C('#1c0a08'),
      cloudSpeed: 0.008,
    }),
    sunIntensity: 2.9,
    sunColor: '#ffd4a8',
    hemi: ['#6a5660', '#ff7a30', 0.75],
    fog: { color: '#3a1a12', density: 0.0068, height: 0.016 },
    exposure: 1.15,
    bloom: { strength: 0.5, radius: 0.55, threshold: 1.5 },
    grade: { tint: [1.02, 0.99, 0.95], contrast: 1.12, saturation: 1.05, lift: [0.01, 0.005, 0.015], gain: [1.03, 0.99, 0.95], vignette: 0.95 },
    godrays: 0.0,
    ambient: ['embers'],
    fire: '#ff6a1a',
    key: '#ffc890',
    rim: '#ff8a40',
    accent: '#ff6a20',
  },
  glacier: {
    id: 'glacier',
    name: 'The Aurora Glacier',
    tagline: 'under the singing lights of the far north',
    sky: sky({
      sunDir: dirFrom(30, 60),
      sunColor: hdr('#cfe0ff', 3),
      sunSize: 0,
      sunGlow: 0,
      zenith: C('#040b1f'),
      horizon: C('#18405e'),
      ground: C('#1d3550'),
      horizonGlow: C('#1a6a70'),
      cloudCover: 0.12,
      cloudScale: 0.7,
      cloudColor: C('#4a6a8a'),
      cloudShade: C('#0e1a2e'),
      stars: 1.0,
      aurora: 1.5,
      auroraA: C('#2cff9a'),
      auroraB: C('#b048ff'),
      moonDir: dirFrom(32, 62),
      moonSize: 0.03,
      moonColor: hdr('#eef4ff', 1.6),
    }),
    sunIntensity: 2.2,
    sunColor: '#b4ccff',
    hemi: ['#3a6aa0', '#4a7aa8', 0.7],
    fog: { color: '#132f48', density: 0.008, height: 0.012 },
    exposure: 1.15,
    bloom: { strength: 0.45, radius: 0.6, threshold: 1.3 },
    grade: { tint: [0.97, 1.02, 1.06], contrast: 1.06, saturation: 1.15, lift: [0.0, 0.015, 0.04], gain: [0.98, 1.02, 1.06], vignette: 0.9 },
    godrays: 0.0,
    ambient: ['snow'],
    fire: '#6ad8ff',
    key: '#dff0ff',
    rim: '#7affd0',
    accent: '#7ae0ff',
  },
  moonlake: {
    id: 'moonlake',
    name: 'The Moonlit Lake Temple',
    tagline: 'lanterns drift on still water beneath a giant moon',
    sky: sky({
      sunDir: dirFrom(14, 250),
      sunColor: hdr('#c8d8ff', 2),
      sunSize: 0,
      sunGlow: 0,
      zenith: C('#0a1634'),
      horizon: C('#3a5a8c'),
      ground: C('#14243e'),
      horizonGlow: C('#7a8ac8'),
      cloudCover: 0.32,
      cloudScale: 0.7,
      cloudColor: C('#8ea4cc'),
      cloudShade: C('#1b2846'),
      stars: 0.8,
      moonDir: dirFrom(14, 250),
      moonSize: 0.07,
      moonColor: hdr('#fff1d8', 1.7),
    }),
    sunIntensity: 2.1,
    sunColor: '#c4d4ff',
    hemi: ['#5a78b8', '#2a3a58', 0.9],
    fog: { color: '#2d4470', density: 0.0075, height: 0.05 },
    exposure: 1.2,
    bloom: { strength: 0.45, radius: 0.65, threshold: 1.3 },
    grade: { tint: [0.98, 1.0, 1.04], contrast: 1.1, saturation: 1.1, lift: [0.0, 0.008, 0.03], gain: [1.03, 1.0, 1.0], vignette: 0.9 },
    godrays: 0.0,
    ambient: ['fireflies'],
    fire: '#7ab0ff',
    key: '#ffe6c8',
    rim: '#a8c4ff',
    accent: '#ffb060',
  },
  desert: {
    id: 'desert',
    name: 'The Sunset Ruins',
    tagline: 'where colossal kings still watch the sands',
    sky: sky({
      sunDir: dirFrom(6, 170),
      sunColor: hdr('#ffb070', 40),
      sunSize: 0.016,
      zenith: C('#34407e'),
      horizon: C('#ff9a52'),
      ground: C('#a0603c'),
      horizonGlow: C('#ff5a24'),
      cloudCover: 0.36,
      cloudScale: 1.1,
      cloudColor: C('#ffb497'),
      cloudShade: C('#6e4a72'),
    }),
    sunIntensity: 3.2,
    sunColor: '#ffb684',
    hemi: ['#6e70c8', '#b8744c', 0.8],
    fog: { color: '#c98a72', density: 0.0052, height: 0.006 },
    exposure: 0.98,
    bloom: { strength: 0.35, radius: 0.6, threshold: 2.0 },
    grade: { tint: [1.02, 0.99, 0.97], contrast: 1.12, saturation: 1.06, lift: [0.0, 0.0, 0.03], gain: [1.03, 0.99, 0.96], vignette: 0.88 },
    godrays: 0.25,
    ambient: ['sand', 'dust'],
    fire: '#ff7a30',
    key: '#ffe0c0',
    rim: '#ffb080',
    accent: '#ff9a40',
  },
};
