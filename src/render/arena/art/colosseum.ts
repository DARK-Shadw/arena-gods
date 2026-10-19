/**
 * Colosseum ThemeArt (kit mode). A2 gives it the wet floor (blue-grey flagstone + the Moon Gate engraved ring) and,
 * until A7 builds "The Moon Gate" for real, a NIGHT PREVIEW of its look (plan 3.1 / 3.3: moon az -1.7, elev 27,
 * #d8d4ff, inside the arch from the ref-3 camera; violet ground mist; indigo shadows) plus ten decorative tripod
 * braziers on the boundary, so the floor has a moon and fires to reflect. `?moongate=0` keeps the floor but drops
 * the preview look and the braziers (the golden-hour colosseum on a wet floor); `?arena=legacy` is unchanged.
 */
import * as THREE from 'three';
import type { ThemeArt } from './types';
import { discRadius } from '../sky';

const dirFrom = (elevDeg: number, azDeg: number) => {
  const e = (elevDeg * Math.PI) / 180,
    a = (azDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)).normalize();
};
const C = (c: string) => new THREE.Color(c);
const hdr = (c: string, k: number) => new THREE.Color(c).multiplyScalar(k);
// A8: the moon sits centred in the ring arch as in ref-3 (A2-A7c: az -1.7, elev 27)
const MOON = dirFrom(26, 0);

export const COLOSSEUM_ART: ThemeArt = {
  id: 'colosseum',
  // A8 (owner feedback): big thick broken slabs (procedural, 8 m tile), dull damp stone, wet glints in puddles / joints /
  // cracks; the ring carved deeper (inlay re-baked at 26 mm)
  floor: { set: 'floor/slabs_moongate', inlay: 'floor/inlay_moongate', wetness: 0.9, puddles: 0.3, damp: [0.78, 0.1], streakGain: 0.35 },
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
    // A5 placed ref-3's two hooded guardians at the east gate here (`guardians`); A7 moved them onto plinths beside the stair
    // (ruins.east.stair.guardians)
    // A7: the Moon Gate near field (nearField.ts): ruined tiers instead of the stands / crowd / velarium / gallery, ref-3's tall
    // square pillars with long banners and heavy chains, the hero stair + portal + dais + doorway at the east gate, the kit
    // arch at the west gate, sparse hooded watchers, tier fires, the fire-cage chandelier
    ruins: {
      tiers: { rings: 4, depth: 1.6, rise: 0.85, base: 3.45, seg: 3.3, broken: 0.45, eastBroken: 0.8 },
      arcade: { assets: ['kit/arcade_broken', 'kit/arcade_bay', 'kit/arcade_broken'], share: 0.45, minAz: 70 },
      pillars: {
        asset: 'kit/pillar_square',
        az: [40, 64, 90, 116, 142],
        offset: 2.1,
        scale: 2.0,
        height: 14,
        banner: { w: 2.3, h: 8.6, pin: 12.2 },
        chains: { scale: 2.6, sag: 2.4, swags: true },
      },
      watchers: { count: [8, 14, 18], color: '#1b1722' },
      fires: { asset: 'kit/brazier_wall', count: 14, size: 0.8, vista: 6, ground: { asset: 'kit/rubble_scatter', count: 9, size: 0.55 } },
      // A8: ref-3's floor is littered with chunks and debris
      floorRubble: { asset: 'kit/rubble_scatter', band: [12, 22, 30], inner: [10, 22, 30] },
      fireCage: true,
      east: {
        zoneHalf: 11.2,
        stair: {
          portalHalf: 2.4,
          flightOuter: 5.6,
          steps: 16,
          rise: 0.275,
          run: 0.38,
          z0: -0.9,
          daisDepth: 6,
          daisHalf: 7.6,
          // A8: no doorway block on the dais: from the ref-3 camera it hid the backdrop arch's portal, which is
          // ref-3's doorway (the stair climbs toward it)
          guardians: { statue: 'kit/statue_hooded', plinth: 'kit/plinth', lateral: 6.9, z: -1.9, plinthScale: 1.3, scale: 1.2 },
          braziers: { asset: 'kit/brazier_pedestal', lateral: 7.8, z: 1.6, scale: 1.8, flame: 1.8 },
        },
      },
      west: { zoneHalf: 4.6, arch: 'kit/arch', braziers: { asset: 'kit/brazier_tripod', lateral: 4.3, z: -0.3, scale: 1.0, flame: 0.95 } },
    },
  },
  // A6: the Moon Gate test backdrop (arch blockout + ruined arcade ring + outer ruins + clouds, Cycles panorama layers);
  // A8 replaces the scene with the full one and tunes these
  backdrop: {
    id: 'moongate',
    tune: {
      gain: 1.1,
      emitGain: 3.2,
      fogRange: 140,
      fogMax: 0.8,
      // A7b: the baked Cycles layers are violet; ref-3's stone and cloud are blue-grey
      sat: 0.5,
      tint: [0.94, 0.97, 1.06],
      shafts: { count: 3, color: '#c4caf0', opacity: 0.22, az: 0, dist: 66 },
      fogBanks: { count: [8, 16], radius: 52, opacity: 0.5, lift: 1.3 },
      // A8: the EEVEE shaft / fog-bank atlases are rendered now (128 px frames; A7b's procedural stand-ins retired)
      proceduralCards: false,
      // A7b: the baked storm clouds: dark away from the moon, backlit round it
      cloud: { away: 0.24, near: 0.3, power: 8 },
      // A7c: the authored sky draws the storm now; the blockout's Cycles clouds fade out
      cloudHide: 1,
    },
  },
  // A7c: the authored storm sky (tools/arena/sky/moongate.json -> public/arena/sky/moongate/): a Poly Haven CC0 cloud
  // photo turned into structure / density / rim / shaft data, lit in sky.ts by the moon (glow, silver rims, dark far
  // banks), drifting, with rare distant lightning; replaces the A7b storm deck (look.sky.storm*) when it loads
  sky: { id: 'moongate' },
  // A7b: the real night look (light / fog / grade pass against ref-3): dark overall with strong accents, a cold moon
  // back-rim on every stone edge, warm fire pools on stone, desaturated blue-grey stone and storm cloud (warm only at the
  // fires), the sky + backdrop as the light probe, view-dependent haze, ground mist. See docs/milestones/A7b/README.md.
  look: {
    sky: {
      sunDir: MOON,
      // drives the cloud silver lining and the horizon glow toward the moon (no sun disc at night)
      sunColor: hdr('#d4d8ff', 2.2),
      sunSize: 0,
      sunGlow: 0,
      zenith: C('#06070d'),
      horizon: C('#262a3a'),
      ground: C('#0c0d13'),
      horizonGlow: C('#2e3346'),
      cloudCover: 0.0,
      cloudScale: 0.75,
      cloudColor: C('#7c8098'),
      cloudShade: C('#15171f'),
      stars: 0.3,
      moonDir: MOON,
      // A6: ref-3's moon is about 12 deg wide (plan 3.1), framed by the backdrop's ring arch; halo scaled to the disc
      moonSize: discRadius(12),
      moonHalo: 0.22,
      moonColor: hdr('#eef0ff', 1.3),
      storm: 1,
      stormLit: hdr('#a8aee8', 0.15),
      stormDark: C('#121428'),
      stormScale: 3.4,
    },
    sunIntensity: 2.4,
    sunColor: '#c6cbf2',
    hemi: ['#55566a', '#1a1618', 0.8],
    fog: { color: '#262a3a', density: 0.0068, height: 0.05 },
    exposure: 1.4,
    bloom: { strength: 0.45, radius: 0.65, threshold: 1.2 },
    grade: { tint: [1.0, 1.0, 1.0], contrast: 1.1, saturation: 0.86, lift: [0.004, 0.003, 0.008], gain: [1.0, 1.0, 1.0], vignette: 1.0 },
    godrays: 0, // moon rays cost about 1.5 ms on high (A2 measurement); the backdrop's shaft cards stand in for them
    ambient: ['embers'],
    fire: '#ff7a2a',
    key: '#bcc0dc',
    rim: '#c4c8ff', // the camera rim light sits behind the fighters: on the wet floor it is the moonlit sheen
    accent: '#ff8a40',
    lookId: 'moongate',
    stage: {
      envIntensity: 1.2,
      envBackdrop: true,
      keyGain: 1.8,
      rim: { color: '#b4bcff', intensity: 3.2, power: 2.6, away: 0.35 },
      fires: { count: [4, 8, 12], gain: 3.5, reach: 7, color: '#ff8a3a' },
      fogSky: { toward: '#56556e', away: '#1a1a26', power: 2.0 },
      mist: { count: [8, 14], offset: 1.2, w: 9, h: 2.6, opacity: 0.6, color: '#6a7090' },
    },
  },
};
