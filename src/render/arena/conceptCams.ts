/**
 * Concept-match camera presets (arena art plan section 3.3, milestone A0).
 *
 * One preset per concept image `docs/concept-art/ref-N.png`: theme + layout + arena seed, the camera
 * (position, yaw / pitch / roll, vertical FOV, render size = the concept's pixel size) and the two
 * fighter marks. `?concept=ref-3` (debug URL) or `__arena.conceptView('ref-3')` loads it, freezes the
 * fight, hides the HUD and renders from the preset; `tools/shots/concept.cjs` screenshots every preset
 * and `tools/arena/concept_compare.py` scores the render against the concept image.
 *
 * Conventions (match `dirFrom(elev, az)` in themes.ts): yaw 0 looks along +x (behind the east gate,
 * where every theme's landmark sits at azimuth 0); positive yaw turns towards +z, which is screen right;
 * positive pitch looks up; positive roll lifts the camera's right side, so on screen the horizon
 * falls towards the right (the picture looks turned clockwise).
 *
 * The numbers are CALIBRATED by `tools/arena/calibrate.py` from the by-eye annotations in
 * `tools/arena/concept_targets.json`: camera height + pitch solved jointly so that the opponent (used
 * as a ruler, assumed height) spans the annotated feet..head AND the far floor edge of OUR arena
 * boundary lands on the concept's floor edge; yaw so the azimuth-0 landmark lands on its annotated x;
 * the opponent mark = its feet ray cast onto the floor; the foreground fighter from its shoulder width,
 * backed off until an upright game fighter's head stays in frame (the concepts draw it hunched).
 * `python -I tools/arena/calibrate.py --write` rewrites the block below; re-run it after changing a
 * target or the arena size (bigger arenas move the floor edge).
 */
import * as THREE from 'three';
import type { LayoutId, ThemeId } from '../../sim/arenaGen';

export interface ConceptMark {
  /** fighter id */
  id: string;
  x: number;
  z: number;
}

export interface ConceptPreset {
  id: string;
  /** concept image (relative to the repo root) */
  image: string;
  /** render size = the concept's pixel size */
  w: number;
  h: number;
  /** theme the concept belongs to (the plan's final id; `rootwood` does not exist before A17) */
  theme: ThemeId | 'rootwood';
  /** theme rendered while `theme` does not exist yet (A0 baseline of ref-10) */
  standIn?: ThemeId;
  layout: LayoutId;
  /** arena generator seed */
  aseed: number;
  /** match seed (only picks the recorded fight whose frame 0 poses the fighters) */
  seed: number;
  /** vertical FOV, degrees */
  vfov: number;
  pos: [number, number, number];
  yaw: number;
  pitch: number;
  roll: number;
  /** foreground fighter (back to camera) */
  a: ConceptMark;
  /** opponent; null = hidden (ref-3 has no opponent) */
  b: ConceptMark | null;
  /** distance of the azimuth-0 landmark from the arena centre (plan 3.1), for the landmark guide */
  landmarkDist: number;
}

/** Hidden stand-in opponent for presets without one (a match always needs two fighters). */
const HIDDEN_B = 'vex';

// ---- calibrated presets (tools/arena/calibrate.py output; see the A0 README for the method) ----
// CALIBRATED-BEGIN
export const CONCEPT_PRESETS: ConceptPreset[] = [
  { id: 'ref-3', image: 'docs/concept-art/ref-3.png', w: 1793, h: 877, theme: 'colosseum', layout: 'pit', aseed: 7, seed: 4242, vfov: 44.7, pos: [-7.5, 1, -0.3], yaw: -17.37, pitch: 6.94, roll: 0, a: { id: 'maw', x: -4.11, z: -2.7 }, b: null, landmarkDist: 70 },
  { id: 'ref-4', image: 'docs/concept-art/ref-4.png', w: 1665, h: 944, theme: 'forge', layout: 'oval', aseed: 7, seed: 4242, vfov: 41.86, pos: [-6.8, 1.36, -1.2], yaw: -7.53, pitch: -1.58, roll: 0, a: { id: 'gorak', x: -4.18, z: -0.85 }, b: { id: 'aldric', x: 1.53, z: -2.42 }, landmarkDist: 450 },
  { id: 'ref-5', image: 'docs/concept-art/ref-5.png', w: 1672, h: 941, theme: 'sakura', layout: 'pit', aseed: 7, seed: 4242, vfov: 43.02, pos: [-6.6, 1.24, -1], yaw: -6.96, pitch: -0.02, roll: 0, a: { id: 'gorak', x: -4.03, z: -0.64 }, b: { id: 'ozrel', x: -0.14, z: -2.07 }, landmarkDist: 250 },
  { id: 'ref-6', image: 'docs/concept-art/ref-6.png', w: 1672, h: 941, theme: 'desert', layout: 'pit', aseed: 7, seed: 4242, vfov: 43.02, pos: [-7, 0.71, -1], yaw: -8.94, pitch: 3.51, roll: 0, a: { id: 'gorak', x: -3.4, z: -0.54 }, b: { id: 'maw', x: 0.3, z: -2.57 }, landmarkDist: 35 },
  { id: 'ref-7', image: 'docs/concept-art/ref-7.png', w: 1672, h: 941, theme: 'glacier', layout: 'pit', aseed: 7, seed: 4242, vfov: 43.02, pos: [-6.6, 0.88, -1.1], yaw: -5.44, pitch: 2.42, roll: 0, a: { id: 'gorak', x: -3.29, z: -0.29 }, b: { id: 'aldric', x: -0.32, z: -2.19 }, landmarkDist: 400 },
  { id: 'ref-8', image: 'docs/concept-art/ref-8.png', w: 1672, h: 941, theme: 'skytemple', layout: 'pit', aseed: 7, seed: 4242, vfov: 46.71, pos: [-6.2, 0.86, -0.9], yaw: -13.47, pitch: 3.07, roll: -3, a: { id: 'aldric', x: -3.61, z: -0.74 }, b: { id: 'ozrel', x: -0.53, z: -2.46 }, landmarkDist: 300 },
  { id: 'ref-9', image: 'docs/concept-art/ref-9.png', w: 1672, h: 941, theme: 'moonlake', layout: 'pit', aseed: 7, seed: 4242, vfov: 46.71, pos: [-6.4, 0.57, -1], yaw: 11.7, pitch: 7.63, roll: -2, a: { id: 'vex', x: -4.01, z: 0.53 }, b: { id: 'fenrik', x: -1.16, z: -0.52 }, landmarkDist: 220 },
  { id: 'ref-10', image: 'docs/concept-art/ref-10.png', w: 1672, h: 941, theme: 'rootwood', standIn: 'sakura', layout: 'pit', aseed: 7, seed: 4242, vfov: 43.02, pos: [-6.6, 0.78, -1], yaw: 2.04, pitch: 7.11, roll: 0, a: { id: 'erika', x: -3.9, z: -0.07 }, b: { id: 'ozrel', x: -0.06, z: -1.3 }, landmarkDist: 120 },
];
// CALIBRATED-END

/** Extra game-only views per theme (no concept image): the director orbits, and A-milestones
 *  that make arenas bigger need views that scale with the layout. */
export type ExtraView = 'counter' | 'flank' | 'overview' | 'pillar' | 'wall';
/** A3 added `pillar` (low look at the pit's north-east pillar) and `wall` (the south ring: wall modules, arcade) */
export const EXTRA_VIEWS: ExtraView[] = ['counter', 'flank', 'overview', 'pillar', 'wall'];

export function conceptPreset(id: string): ConceptPreset | undefined {
  return CONCEPT_PRESETS.find((p) => p.id === id);
}

/** Theme actually rendered for a preset (stand-in until the theme exists). */
export function renderTheme(p: ConceptPreset, known: readonly string[]): ThemeId {
  return (known.includes(p.theme) ? p.theme : (p.standIn ?? 'colosseum')) as ThemeId;
}

const D = Math.PI / 180;

/** Camera basis for yaw / pitch / roll (degrees): forward, right, up (world space). */
export function conceptBasis(yaw: number, pitch: number, roll: number) {
  const y = yaw * D,
    p = pitch * D,
    r = roll * D;
  const f = new THREE.Vector3(Math.cos(p) * Math.cos(y), Math.sin(p), Math.cos(p) * Math.sin(y));
  const right = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, f).normalize();
  // roll: rotate right/up about forward (positive = clockwise camera turn)
  const r2 = right.clone().multiplyScalar(Math.cos(r)).addScaledVector(up, Math.sin(r));
  const u2 = up.clone().multiplyScalar(Math.cos(r)).addScaledVector(right, -Math.sin(r));
  return { f, right: r2, up: u2 };
}

export interface CamPose {
  pos: [number, number, number];
  yaw: number;
  pitch: number;
  roll: number;
  vfov: number;
}

/** Put a perspective camera at a pose (fov, orientation; aspect is set by the caller's resize). */
export function applyCamPose(cam: THREE.PerspectiveCamera, c: CamPose) {
  const { f, right, up } = conceptBasis(c.yaw, c.pitch, c.roll);
  cam.position.set(...c.pos);
  const m = new THREE.Matrix4().makeBasis(right, up, f.clone().negate());
  cam.quaternion.setFromRotationMatrix(m);
  cam.fov = c.vfov;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
}

/**
 * Game-only views that scale with the layout (rx, rz = arena half-extents), so a bigger arena keeps
 * a comparable frame: `counter` = the face-off seen from behind the east fighter (az 180),
 * `flank` = from the south boundary (az -90), `overview` = high three-quarter view of the whole floor.
 */
export function extraViewPose(v: ExtraView, rx: number, rz: number): CamPose {
  if (v === 'counter') return { pos: [rx * 0.55, 1.6, 1.0], yaw: 180 + 4, pitch: 3.5, roll: 0, vfov: 43 };
  if (v === 'flank') return { pos: [0.5, 1.7, -rz * 0.62], yaw: 90, pitch: 3.0, roll: 0, vfov: 43 };
  if (v === 'pillar' || v === 'wall') {
    const pos: [number, number, number] = v === 'pillar' ? [rx * 0.12, 1.3, rz * 0.08] : [rx * 0.15, 1.5, rz * 0.35];
    const at = v === 'pillar' ? new THREE.Vector3(rx * 0.43, 2.6, rz * 0.43) : new THREE.Vector3(-rx * 0.1, 3.8, rz * 1.05);
    const look = at.sub(new THREE.Vector3(...pos));
    return { pos, yaw: Math.atan2(look.z, look.x) / D, pitch: Math.atan2(look.y, Math.hypot(look.x, look.z)) / D, roll: 0, vfov: 50 };
  }
  const R = Math.max(rx, rz);
  const pos: [number, number, number] = [-(rx + 1.5), 4.5 + R * 0.35, -(rz * 0.35)];
  const look = new THREE.Vector3(rx * 0.25, 0, 0).sub(new THREE.Vector3(...pos));
  return { pos, yaw: Math.atan2(look.z, look.x) / D, pitch: Math.atan2(look.y, Math.hypot(look.x, look.z)) / D, roll: 0, vfov: 50 };
}

/** Facing (rotation.y, sim convention: forward = (sin a, cos a)) from (x, z) towards (tx, tz). */
export function faceTowards(x: number, z: number, tx: number, tz: number) {
  return Math.atan2(tx - x, tz - z);
}

export { HIDDEN_B };
