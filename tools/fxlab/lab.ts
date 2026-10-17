/**
 * FX LAB (dev tool):  npm run dev  ->  http://localhost:5173/tools/fxlab/
 *
 * Previews every effect in isolation:
 *  - every FxDef of the F0 director (src/render/fx, docs/fx-api.md), spawned standalone;
 *  - every F2 atlas in public/fx/atlas.json (flipbooks as camera-facing cards with the
 *    reference flipbook shader in ./fxAtlas.ts; sprites, noise and decals as flat sheets);
 *  - a brazier composite (fire_loop + smoke_wisp + embers + flickering light);
 *  - every row of docs/fx-catalog.md, mapped to its nearest current preview; rows that
 *    are not built yet are grey.
 * Effects are pure functions of (seed, t), so the time slider is a frame-exact scrub.
 *
 * F1: the lab renders through the game's Post (src/render/post.ts): shared depth, soft particles,
 * distortion, dual bloom and grade. 'F1 tests' items judge each in isolation (soft vs hard, heat
 * shimmer over the brazier, ripples, bloom / grade presets); the post / soft / distortion switches
 * and the look, preset and bloom controls in the side bar A/B them.
 *
 * URL: ?id=<item key>&seed=1&t=0.4&q=2&gore=standard&bg=dark&pause=1&look=forge&post=0  (gore default: GORE_DEFAULT)
 * Automation (tools/shots/fxsheet.cjs): window.__fxlab = { ready, list(), play(key, {seed, q, gore}),
 *   at(t), stats(), sheet(key, times[]) -> PNG data URL, shot() -> PNG data URL }
 *
 * INTEGRATION TODOs (F3+):
 *  - flipbook atlases are drawn by the lab's own card shader (fxAtlas.ts). Once
 *    src/render/fx gains a 'flipbook' op kind, list atlas-backed FxDefs instead.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createFxDirector, fxProfiler, fxSettings, goreLevel, FxRng, type FxDirector, type GoreLevel } from '../../src/render/fx';
import { Post } from '../../src/render/post';
import { MASK_FX, MASK_WORLD } from '../../src/render/fx/fxLayers';
import { softDepthUniforms } from '../../src/render/fx/softDepth';
import { GRADE_PRESETS, THEME_LOOK } from '../../src/render/fx/fxLook';
import { THEME_DEFS } from '../../src/render/arena/themes';
// GORE_DEFAULT / parseGore are not re-exported by src/render/fx/index.ts (F0 API); read-only import.
import { GORE_DEFAULT, parseGore } from '../../src/render/fx/fxSettings';
import { instantiate, loadCharacter } from '../../src/render/character';
import catalogMd from '../../docs/fx-catalog.md?raw';
import { FxAtlases, flipbookAge, makeFlipbookCard, makeFlipbookMaterial, type AtlasEntry } from './fxAtlas';
import { FxFlames, TRAIL_PROFILES } from '../../src/render/fx';
const CLAW_CORE_LAB: [number, number, number] = [2.4, 0.25, 0.3];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const qs = new URLSearchParams(location.search);

// ------------------------------------------------------------------ renderer / scene
const canvas = $('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.info.autoReset = false;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 200);
camera.position.set(0, 1.9, 5.6);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1.0, 0);
controls.update();

const hemi = new THREE.HemisphereLight('#9fb0d0', '#1a1612', 0.4);
const key = new THREE.DirectionalLight('#c8d4ff', 1.2);
key.position.set(-3, 6, 3);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
const torch = new THREE.PointLight('#ff9a48', 0, 9, 1.6);
torch.position.set(-2.2, 1.6, 1.2);
scene.add(hemi, key, torch);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 16), new THREE.MeshStandardMaterial({ color: '#2b2927', roughness: 0.34, metalness: 0.05 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const PRESETS = {
  dark: { bg: '#07080c', fog: '#07080c', hemi: 0.35, key: 1.0, keyCol: '#b8c6ff', torch: 0, fbKey: '#9fb0e0', fbAmb: '#141824' },
  torch: { bg: '#120c08', fog: '#120c08', hemi: 0.15, key: 0.25, keyCol: '#ffd0a0', torch: 14, fbKey: '#ffb070', fbAmb: '#20140c' },
  neutral: { bg: '#3a3d43', fog: '#3a3d43', hemi: 1.2, key: 2.0, keyCol: '#fff2dc', torch: 0, fbKey: '#fff2dc', fbAmb: '#3a3f4a' },
} as const;
type PresetId = keyof typeof PRESETS;
let preset: PresetId = (qs.get('bg') as PresetId) in PRESETS ? (qs.get('bg') as PresetId) : 'dark';
function applyPreset() {
  const p = PRESETS[preset];
  scene.background = new THREE.Color(p.bg);
  scene.fog = new THREE.Fog(p.fog, 12, 30);
  hemi.intensity = p.hemi;
  key.intensity = p.key;
  key.color.set(p.keyCol);
  torch.intensity = p.torch;
}

function resize() {
  const r = canvas.parentElement!.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  post.setSize(r.width, r.height);
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

// ------------------------------------------------------------------ FX systems
fxProfiler.now = () => performance.now();
let seed = Number(qs.get('seed') ?? 1) || 1;
let quality = Number(qs.get('q') ?? 2) as 0 | 1 | 2;
// ?gore= (off | standard | full; 'stylised' alias), else the game's saved choice (arena.gore.v2), else GORE_DEFAULT
let gore: GoreLevel = parseGore(qs.get('gore')) ?? goreLevel() ?? GORE_DEFAULT;
const fx: FxDirector = createFxDirector({ scene, seed, quality });
const atlases = new FxAtlases(renderer, '/fx/');
// F3: the director's flipbook / sprite particles, decals and ribbons read the same atlases as the game
fx.vfx.useAtlases(atlases);

// ------------------------------------------------------------------ post (F1): the game's pipeline
const post = new Post(renderer, scene, camera);
post.distActive = () => fx.vfx.dist.active;
let postOn = qs.get('post') !== '0';
/** look ids: 'lab' (neutral grade, forge-like bloom) or a ThemeId (that theme's grade + its F1 look row) */
let lookId = qs.get('look') ?? 'lab';
let presetId = '';
let presetW = 1;
function applyLook() {
  const T = (THEME_DEFS as Record<string, (typeof THEME_DEFS)[keyof typeof THEME_DEFS]>)[lookId];
  if (T) {
    renderer.toneMappingExposure = T.exposure;
    post.setLook({ id: T.id, bloom: T.bloom, grade: T.grade, godrays: 0, sunDir: new THREE.Vector3(0, 1, 0) });
  } else {
    renderer.toneMappingExposure = 1;
    post.setLook({ bloom: { strength: 0.4, radius: 0.6, threshold: 1.2 }, grade: { tint: [1, 1, 1], contrast: 1.05, saturation: 1.05, lift: [0, 0, 0.01], gain: [1, 1, 1], vignette: 0.7 }, godrays: 0, sunDir: new THREE.Vector3(0, 1, 0) });
    post.setBloom({ threshold: 1.15, knee: 0.55, strength: 0.4, radius: 0.6 });
    post.setExtras({ shadowTint: [0.92, 0.96, 1.1], highlightTint: [1.06, 1.0, 0.92], crush: 0.015 });
  }
  const b = post.currentLook.bloom;
  ($('bStr') as HTMLInputElement).value = String(b.strength);
  ($('bThr') as HTMLInputElement).value = String(b.threshold);
  for (const k of Object.keys(GRADE_PRESETS)) post.setPreset(k, k === presetId ? presetW : 0);
}

// ------------------------------------------------------------------ dummies + brazier
const dummies = new THREE.Group();
scene.add(dummies);
/** F3: dummy bones (wounds) and gorak's blade markers (weapon blood); 0 = gorak (left, the attacker), 1 = aldric (right, the victim) */
const dummyBones: Record<string, THREE.Object3D>[] = [{}, {}];
const dummyBlade: ({ base: THREE.Object3D; tip: THREE.Object3D } | null)[] = [null, null];
async function loadDummies() {
  for (const [i, fid, x, rot] of [[0, 'gorak', -0.95, Math.PI / 2], [1, 'aldric', 0.95, -Math.PI / 2]] as const) {
    try {
      const asset = await loadCharacter(fid);
      const model = instantiate(asset);
      model.scale.setScalar(0.01 * asset.meta.scale);
      const mats: THREE.Material[] = [];
      model.traverse((o) => {
        if ((o as THREE.Bone).isBone) dummyBones[i][o.name.replace('mixamorig', '')] = o;
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : (m.material as THREE.Material).clone();
          for (const x of Array.isArray(m.material) ? m.material : [m.material]) mats.push(x);
          m.castShadow = true;
        }
      });
      fx.attachBlood(i, mats, model.scale.x);
      const meta = asset.meta as { weaponTip?: { pos: number[]; base: number[] } };
      if (meta.weaponTip && dummyBones[i].RightHand) {
        const tip = new THREE.Object3D(), base = new THREE.Object3D();
        tip.position.fromArray(meta.weaponTip.pos);
        base.position.fromArray(meta.weaponTip.base);
        dummyBones[i].RightHand.add(tip, base);
        dummyBlade[i] = { base, tip };
      }
      const root = new THREE.Group();
      root.add(model);
      root.position.set(x, 0, 0);
      root.rotation.y = rot;
      const clip = asset.clips.find((c) => /idle|guard|stance/i.test(c.name)) ?? asset.clips[0];
      if (clip) {
        const mixer = new THREE.AnimationMixer(model);
        mixer.clipAction(clip).play();
        mixer.update(0.4);            // a fixed pose: the lab is about FX, not motion
      }
      dummies.add(root);
    } catch (e) {
      console.warn('[fxlab] dummy', fid, e);
    }
  }
  dummies.updateMatrixWorld(true);
  fx.labBone = (i, name) => dummyBones[i]?.[name];
  fx.labBlade = (i, b, t) => {
    const B = dummyBlade[i];
    if (!B) return false;
    B.base.getWorldPosition(b);
    B.tip.getWorldPosition(t);
    return true;
  };
}

const brazier = new THREE.Group();
brazier.position.set(-2.2, 0, -0.6);
scene.add(brazier);
const brazierParts: { mesh: THREE.Mesh; e: AtlasEntry; phase: number }[] = [];
const brazierLight = new THREE.PointLight('#ff8a3a', 0, 7, 1.6);
brazierLight.position.set(0, 1.35, 0);
brazier.add(brazierLight);
async function buildBrazier() {
  const metal = new THREE.MeshStandardMaterial({ color: '#2a2622', roughness: 0.55, metalness: 0.7 });
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.22, 0.28, 18, 1, true), metal);
  bowl.position.y = 0.95;
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.12, 0.85, 8), metal);
  leg.position.y = 0.42;
  bowl.castShadow = leg.castShadow = true;
  brazier.add(bowl, leg);
  // first available atlas of each role (Unity core sets preferred, own bakes as fallback)
  for (const [ids, scale, y, phase] of [[['unity_candlesmoke01', 'smoke_wisp'], 1.3, 1.55, 0.3], [['unity_flame02', 'fire_loop'], 0.9, 0.98, 0], [['embers'], 0.8, 1.05, 0.5]] as const) {
    const id = ids.find((i) => atlases.manifest?.atlases[i]);
    if (!id) continue;
    const e = atlases.entry(id);
    const mesh = await atlasCard(id, scale);
    mesh.position.y = y;
    brazier.add(mesh);
    brazierParts.push({ mesh, e, phase });
  }
}

// ------------------------------------------------------------------ atlas cards / sheets
const TINTS: Record<string, string> = { dust_puff: '#9d8c74', dust_ring: '#9d8c74', smoke_wisp: '#8d8984', splash: '#c8daf0', energy_swirl: '#6aa0ff' };
const SCALES: Record<string, number> = { fire_loop: 0.6, embers: 0.8, energy_swirl: 0.8, unity_flame02: 0.8 };

async function atlasCard(id: string, scale = SCALES[id] ?? 1): Promise<THREE.Mesh> {
  const e = atlases.entry(id);
  const tier = quality === 0 ? 'low' : 'full';
  const tex = await atlases.texture(id, tier);
  const mv = e.mv && quality > 0 ? await atlases.texture(id, 'mv') : null;
  const mat = makeFlipbookMaterial(e, tex, mv, { tint: e.tint ? TINTS[id] ?? '#ffffff' : '#ffffff', intensity: e.kind === 'emissive' ? 3.5 : e.kind === 'emissive+smoke' ? 1.6 : 1, motionVectors: ($('mvOn') as HTMLInputElement).checked });
  const m = makeFlipbookCard(e, mat, scale);
  m.userData.atlas = id;
  return m;
}

const CHANNEL_FRAG = /* glsl */ `
uniform sampler2D uTex; uniform vec4 uCh; varying vec2 vUv;
void main() { float v = dot(texture2D(uTex, vUv), uCh); gl_FragColor = vec4(vec3(v), 1.0);
  #include <colorspace_fragment>
}`;
async function staticSheet(id: string): Promise<THREE.Object3D> {
  const e = atlases.entry(id);
  const tex = await atlases.texture(id, quality === 0 && e.low ? 'low' : 'full');
  const g = new THREE.Group();
  if (e.type === 'decals') {
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, premultipliedAlpha: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor });
    const p = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), mat);
    p.rotation.x = -Math.PI / 2;
    p.position.set(0, 0.002, 0.6);
    g.add(p);
    return g;
  }
  ['R', 'G', 'B', 'A'].forEach((c, i) => {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: tex }, uCh: { value: new THREE.Vector4(+(i === 0), +(i === 1), +(i === 2), +(i === 3)) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: CHANNEL_FRAG,
    });
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.3), mat);
    p.position.set((i - 1.5) * 1.4, 1.2, 0.3);
    p.userData.label = c;
    g.add(p);
  });
  return g;
}

// ------------------------------------------------------------------ items
type Part = { kind: 'def'; id: string } | { kind: 'atlas'; id: string } | { kind: 'static'; id: string } | { kind: 'brazier' } | { kind: 'fn'; id: string; dur: number; run: () => void };
interface Item { key: string; group: string; label: string; small?: string; desc: string; planned?: boolean; parts: Part[]; cam?: [[number, number, number], [number, number, number]] }
const items: Item[] = [];

/** Catalog row -> nearest current preview (F0 def ids and F2 atlases). Unknown ids are dropped at runtime. */
const CATALOG_PREVIEW: Record<string, string[]> = {
  // F3: the everyday-combat rows preview the built effects ('>' = another lab item)
  C01: ['>f3.steps'], C02: ['>f3.steps'], C03: ['>f3.knockdown'], C04: ['>f3.trail.axe', '>f3.trail.sword', '>f3.trail.claw', '>f3.trail.blunt'], C05: ['>f3.trail.axe.heavy'],
  C06a: ['>f3.metal'], C06b: ['>f3.blood.cut'], C06c: ['impact.blunt.flesh', 'blood.blunt'], C06d: ['>f3.pumpkin'], C06e: ['cover.hit', 'impact.quake'], C06f: ['prop.break', 'prop.hit'], C07: ['>f3.block'],
  C08: ['>f3.parry'], C09: ['block.shield'], C10: ['>f3.dodge'], C11: ['impact.heavy', 'shock.heavy'], C12: ['shock.heavy', 'impact.quake'],
  C13: ['prop.break', 'shock.heavy'], C14: [], C15: ['>f3.blood.three'], C16: ['>f3.blood.cut'], C17: ['>f3.blood.three'], C18: [], C19: ['guard.break'], C20: ['proj.arrow.trail', 'proj.arrow.end', 'impact.pierce.flesh', 'blood.pierce'],
  C21: ['#decals'], E01: ['>f3.flame', '@unity_flame02', '@fire_loop', '@unity_wispysmoke01', '@smoke_wisp', '@embers'], E02: ['@embers'], E06: ['ring.fire', '@unity_flame02'],
  E07: ['explosion.keg', '@unity_explosion00', '@explosion'], E08: ['@unity_flame03', '@fire_loop'], E03: ['@unity_cloud01'], E09: ['@fire_burst'], E10: ['@splash'], E11: ['hazard.geyser.trigger'],
  E14: ['topple.impact', '@unity_explosion01_nofire', '@dust_ring'], E15: ['chandelier.impact'], E16: ['#decals'],
  ST1: ['hazard.burn', '@unity_flame03'], ST4: ['blood.cut'], ST7: ['aura.buff'], ST8: ['aura.lastStand', 'lastStand.burst'], ST11: ['secondWind.burst'],
  CI6: ['finisher.kill', 'kill.finisher'], CI7: ['kill.plain'], CI8: ['@embers'],
  'Ranged fire': ['stream.fire', 'proj.fire.trail', 'proj.fire.end', '@unity_fireball01', '@fire_burst'], 'Ranged heavy fire': ['stream.pyre', 'proj.pyre.trail', '@unity_fireball01', '@unity_explosion00'],
  Nova: ['active.nova', '@fire_burst'], Arrow: ['proj.arrow.trail', 'proj.arrow.end'], Shadow: ['aura.shadow', 'proj.shadow.trail'],
  'Charge / rush': ['active.lunge', '@dust_puff'], Slam: ['impact.quake', '@dust_ring'], Quake: ['impact.quake', '@dust_ring'],
  'Buff / ward / rage aura': ['aura.buff', '@energy_swirl'], 'PYRE': ['stream.pyre', '@unity_flame02', '@unity_wispysmoke01'], 'BONFIRE NIGHT': ['active.nova', '@fire_burst'],
  'SKULLSPLITTER': ['impact.quake'], 'DEVOUR': ['impact.quake', '@energy_swirl'], 'OATH OF STEEL': ['ult.cast'], 'THOUSAND CUTS': ['aura.ultWindup', '#fx_sprites'],
};

function parseCatalog(): { id: string; name: string; section: string; text: string }[] {
  const out: { id: string; name: string; section: string; text: string }[] = [];
  let section = '';
  for (const line of catalogMd.split('\n')) {
    const h = line.match(/^##+\s+(.*)/);
    if (h) { section = h[1]; continue; }
    if (!line.startsWith('|') || /^\|\s*-/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3 || /^(ID|Class|Move \(fighter\)|Status)$/i.test(cells[0])) continue;
    const idCell = cells[0].replace(/\*\*/g, '');
    const isId = /^(C|E|ST|CI|PP)\d+[a-f]?$/.test(idCell);
    const name = isId ? cells[1] : idCell.replace(/\s*\(.*$/, '');
    out.push({ id: isId ? idCell : '', name, section, text: (isId ? cells[1] + ': ' + cells[2] : cells.slice(1).join(' · ')).slice(0, 300) });
  }
  return out;
}

function toParts(refs: string[] | undefined, defIds: Set<string>): Part[] {
  const parts: Part[] = [];
  for (const r of refs ?? []) {
    if (r === 'brazier') parts.push({ kind: 'brazier' });
    else if (r.startsWith('@')) { if (atlases.manifest?.atlases[r.slice(1)]) parts.push({ kind: 'atlas', id: r.slice(1) }); }
    else if (r.startsWith('#')) { if (atlases.manifest?.atlases[r.slice(1)]) parts.push({ kind: 'static', id: r.slice(1) }); }
    else if (r.startsWith('>')) { const it = items.find((x) => x.key === r.slice(1)); if (it) parts.push(...it.parts); }
    else if (defIds.has(r)) parts.push({ kind: 'def', id: r });
  }
  return parts;
}

// ------------------------------------------------------------------ F1 test scenes
/** spawn helpers on the lab director's VFX at FX time 0 with a fixed seed (scrub-exact) */
const rngFor = (k: number) => new FxRng(((seed * 2654435761) ^ (k * 40503)) >>> 0 || 1);
function withSoft(soft: number | undefined, fn: () => void) {
  fx.vfx.softOverride = soft;
  try {
    fn();
  } finally {
    fx.vfx.softOverride = undefined;
  }
}
function softVsHard(kind: 'dust' | 'smoke' | 'body') {
  const V = fx.vfx;
  for (const [side, soft] of [[-1, 0], [1, undefined]] as const) {
    withSoft(soft, () => {
      const x = side * 0.95;
      if (kind === 'dust') {
        V.dustAt(rngFor(1), 0, { x, y: 0, z: 0.35 }, 22, 1.4, '#9a8064');
        V.dustAt(rngFor(2), 0.25, { x, y: 0, z: -0.2 }, 16, 1.0, '#8a7462');
      } else if (kind === 'smoke') {
        V.smokeAt(rngFor(3), 0, { x, y: -0.4, z: 0.2 }, 10, '#6a625c', 1.6, 0.25);
      } else {
        // fog / smoke cards cutting through the dummy's body and the floor
        V.smokeAt(rngFor(4), 0, { x, y: 0.4, z: 0 }, 8, '#7d7570', 1.3, 0.1);
        V.sparksAt(rngFor(5), 0, { x, y: 1.2, z: 0.1 }, 30, '#ffd0a0', 6);
      }
    });
  }
}
const BRAZIER_CAM: Item['cam'] = [[-0.6, 1.55, 3.2], [-2.2, 1.45, -0.6]];
function brazierHeat() {
  // a long-lived shimmer column over the bowl; the lab loops the item
  fx.vfx.heatAt(rngFor(6), 0, { x: -2.2, y: 1.0, z: -0.6 }, 0.85, 1.9, 6, 1.0, 1.4, 2);
}
function f1Items(): Item[] {
  const G = 'F1 tests (post / depth / distortion)';
  const L = 'left: HARD (soft = 0) · right: SOFT (per-primitive default). Toggle "soft" in the side bar to A/B the whole frame.';
  return [
    { key: 'f1.soft.dust', group: G, label: 'soft vs hard: floor dust', desc: `Two identical dust bursts on the floor at the dummies' feet.\n${L}`, parts: [{ kind: 'fn', id: 'soft.dust', dur: 1.6, run: () => softVsHard('dust') }], cam: [[0, 0.9, 3.4], [0, 0.35, 0]] },
    { key: 'f1.soft.smoke', group: G, label: 'soft vs hard: smoke on the floor', desc: `Large smoke cards spawned partly below the floor.\n${L}`, parts: [{ kind: 'fn', id: 'soft.smoke', dur: 2.6, run: () => softVsHard('smoke') }], cam: [[0, 1.2, 3.8], [0, 0.4, 0]] },
    { key: 'f1.soft.body', group: G, label: 'soft vs hard: smoke through a fighter', desc: `Smoke cards cutting through the dummies' bodies, plus sparks (sparks are 5 cm soft).\n${L}`, parts: [{ kind: 'fn', id: 'soft.body', dur: 2.6, run: () => softVsHard('body') }], cam: [[0, 1.3, 3.2], [0, 1.0, 0]] },
    { key: 'f1.heat.brazier', group: G, label: 'heat shimmer over the brazier', desc: 'Flame02 brazier + a heat distortion column (distortion.ts kind 0). Toggle "distortion" to A/B. Off on low (q0), on medium only for heavy events (this one is high-only, tier 2).', parts: [{ kind: 'brazier' }, { kind: 'fn', id: 'heat', dur: 6, run: brazierHeat }], cam: BRAZIER_CAM },
    { key: 'f1.heat.explosion', group: G, label: 'explosion: ripple + heat', desc: 'explosion.keg with its F1 layers: a 6 m pressure ripple and a 4.5 m heat column (medium + high).', parts: [{ kind: 'def', id: 'explosion.keg' }], cam: [[0, 1.8, 7.5], [0, 1.5, 0]] },
    { key: 'f1.ripple.heavy', group: G, label: 'shockwave ripple on a heavy hit', desc: 'impact.default.heavy with its ripple layer (and kill.plain beside it: bigger ripple + vignette kick in game).', parts: [{ kind: 'def', id: 'impact.default.heavy' }, { kind: 'def', id: 'kill.plain' }] },
    { key: 'f1.bloom', group: G, label: 'bloom + grade: hot cores', desc: 'Brazier, a flash core, sparks and embers for judging bloom (strength / threshold sliders) and the grade presets (preset + weight). Pick a theme under "look" to see its F1 row.', parts: [{ kind: 'brazier' }, { kind: 'def', id: 'impact.fire.heavy' }, { kind: 'def', id: 'secondWind.burst' }], cam: [[-0.4, 1.6, 4.6], [-0.8, 1.1, 0]] },
  ];
}

// ------------------------------------------------------------------ F3 items (everyday combat)
/** weapon-trail demo: a deterministic swing (pure function of t, so the scrub is exact) */
let trailDemo: { cls: keyof typeof TRAIL_PROFILES; heavy: boolean } | null = null;
const _tb = new THREE.Vector3(), _tt = new THREE.Vector3();
function trailAt(time: number) {
  const R = fx.vfx.ribbons[0];
  R.reset();
  if (!trailDemo) return;
  const P = TRAIL_PROFILES[trailDemo.cls];
  R.setProfile(P, trailDemo.cls === 'claw' ? CLAW_CORE_LAB : undefined, seed * 7919, trailDemo.heavy, fxSettings.caps().dist);
  // the game samples once per rendered frame on sim time; here 60 Hz frames up to t
  for (let k = 0; k <= Math.floor(time * 60 + 1e-6); k++) {
    const tt = Math.min(time, k / 60);
    const u = Math.min(1, Math.max(0, (tt - 0.15) / 0.3));
    const s = u * u * (3 - 2 * u);
    const th = -1.9 + 3.6 * s; // a wide diagonal arc in front of the left dummy
    const cx = -0.55, cy = 1.25, cz = 0.15;
    const dirx = Math.cos(th), dirz = Math.sin(th);
    _tb.set(cx + dirx * 0.25, cy + 0.25 - s * 0.45, cz + dirz * 0.25);
    _tt.set(cx + dirx * 1.15, cy + 0.45 - s * 0.9, cz + dirz * 1.15);
    R.push(tt, _tb, _tt, tt > 0.12 && tt < 0.5);
  }
}
const flames = new FxFlames(atlases);
function f3Items(): Item[] {
  const G = 'F3 everyday combat';
  const out: Item[] = [];
  for (const cls of Object.keys(TRAIL_PROFILES) as (keyof typeof TRAIL_PROFILES)[]) {
    if (cls === 'magic') continue;
    for (const heavy of [false, true]) {
      out.push({ key: `f3.trail.${cls}${heavy ? '.heavy' : ''}`, group: G + ' · trails (C04 / C05)', label: `trail: ${cls}${heavy ? ' (heavy: + air distortion)' : ''}`,
        desc: `Weapon ribbon v2, profile '${cls}' (fx/ribbons.ts TRAIL_PROFILES): sampled on sim time at 120 Hz, so the same length at any frame rate; hot edge, smoky body, streak noise.${heavy ? ' Heavy swings add a distortion ribbon (high tier).' : ''}`,
        parts: [{ kind: 'fn', id: 'trail', dur: 0.8, run: () => (trailDemo = { cls, heavy }) }], cam: [[-0.4, 1.5, 3.4], [-0.5, 1.1, 0]] });
    }
  }
  const combo = (key: string, label: string, desc: string, ids: [string, number][], cam?: Item['cam']): Item => ({
    key, group: G, label, desc, cam,
    parts: [{ kind: 'fn', id: key, dur: Math.max(...ids.map(([id, t0]) => t0 + (fx.timing(id)?.duration ?? 1))) + 0.3, run: () => {
      for (const [k, [id, t0]] of ids.entries()) fx.spawn(id, { x: 0, y: 1.25, z: 0.2 }, { seed: seed * 31 + k, t: t0, dir: { x: 1, z: 0 } });
    } }],
  });
  out.push(combo('f3.blood.cut', 'blood: a cut (gore level from the side bar)', 'impact.cut.flesh + blood.cut + blood.blade on the right dummy: droplets, strands, spatter, mist, floor splat and drops, a wound, blood on the axe. Toggle gore off / standard / full.', [['impact.cut.flesh', 0], ['blood.cut', 0], ['blood.blade', 0]], [[0.6, 1.4, 2.6], [0.6, 0.9, 0]]));
  out.push(combo('f3.blood.three', 'blood: three cuts, then the kill', 'Three cuts 0.6 s apart, then blood.kill: wounds accumulate, splats, a pool growing under the body (3 s).', [['blood.cut', 0], ['blood.blade', 0], ['blood.cut', 0.6], ['blood.blade', 0.6], ['blood.cut', 1.2], ['blood.blade', 1.2], ['kill.plain', 1.8], ['blood.kill', 1.8]], [[0.9, 1.9, 3.4], [0.6, 0.6, 0]]));
  out.push(combo('f3.metal', 'C06a blade on metal (heavy)', 'impact.cut.metal + impact.heavy + shock.heavy: flare, spark streaks with gravity, glints, smoke wisp, light, ground dust ring, chips, crack decal.', [['impact.cut.metal', 0], ['impact.heavy', 0], ['shock.heavy', 0]]));
  out.push(combo('f3.block', "C07 / C09 block on Aldric's shield", 'block.sparks + block.shield.', [['block.sparks', 0], ['block.shield', 0]]));
  out.push(combo('f3.parry', 'C08 parry', 'parry.flash: anamorphic flare, spark cone, ring distortion, cool light.', [['parry.flash', 0]]));
  out.push(combo('f3.knockdown', 'C03 knockdown / landing', 'knockdown.dust then launch.land 1.2 s later.', [['knockdown.dust', 0], ['launch.land', 1.2]], [[0, 1.6, 4.6], [0, 0.4, 0]]));
  out.push(combo('f3.steps', 'C01 / C02 footsteps by surface', 'step.dust, step.snow, step.wet, step.water 0.3 s apart.', [['step.dust', 0], ['step.snow', 0.3], ['step.wet', 0.6], ['step.water', 0.9]], [[0, 1.0, 2.6], [0, 0.2, 0]]));
  out.push(combo('f3.dodge', 'C10 dodge dust (afterimages: in game)', "dodge.dust: skid puffs. The ghost layer copies a fighter's pose and only shows in the game.", [['dodge.dust', 0], ['dodge.skid', 0.08], ['dodge.skid', 0.16]], [[0, 1.0, 2.8], [0, 0.3, 0]]));
  out.push(combo('f3.pumpkin', 'C06d hit on Hollowjack', 'impact.any.pumpkin: pulp chunks, seeds, pulp spatter (never blood).', [['impact.any.pumpkin', 0]]));
  out.push({ key: 'f3.flame', group: G, label: 'E01 (part): arena flipbook flame', desc: 'The flame the arena now builds (fx/flames.ts: Unity Flame02, looped with a per-flame phase) beside the F2 reference brazier.', cam: BRAZIER_CAM,
    parts: [{ kind: 'brazier' }, { kind: 'fn', id: 'flame', dur: 4, run: () => { const f = flames.make(0.9, '#ff9a40', seed); f.position.set(-3.0, 1.0, -0.9); live.add(f); } }] });
  return out;
}

function buildItems() {
  items.push(...f3Items());
  items.push(...f1Items());
  const defIds = new Set(fx.list());
  for (const id of fx.list()) {
    const d = fx.def(id);
    items.push({ key: id, group: 'Director effects (F0 defs) · ' + id.split('.')[0], label: id, desc: d?.desc ?? '', parts: [{ kind: 'def', id }] });
  }
  for (const [id, e] of Object.entries(atlases.manifest?.atlases ?? {})) {
    const fb = e.type === 'flipbook';
    const set = e.set ?? 'core';
    items.push({ key: '@' + id, group: fb ? (id.startsWith('unity_') ? 'Flipbooks · Unity Labs (CC0)' : 'Flipbooks · own Blender bakes') : 'Static atlases (F2)', label: id,
      small: fb ? `${e.grid![0]}x${e.grid![1]} ${e.kind}${e.loop ? ' loop' : ''} · ${set}` : e.type,
      desc: `${e.notes ?? ''}\nsource: ${JSON.stringify(e.source ?? {})}`, parts: [{ kind: fb ? 'atlas' : 'static', id }] });
  }
  items.push({ key: 'composite.brazier', group: 'Composites (F2)', label: 'brazier (E01 preview)', desc: 'fire_loop + smoke_wisp + embers cards and a flickering point light (deterministic noise of t).', parts: [{ kind: 'brazier' }] });
  for (const row of parseCatalog()) {
    const refs = CATALOG_PREVIEW[row.id] ?? CATALOG_PREVIEW[row.name] ?? Object.entries(CATALOG_PREVIEW).find(([k]) => !/^(C|E|ST|CI)\d/.test(k) && row.name.toUpperCase().startsWith(k.toUpperCase()))?.[1];
    const parts = toParts(refs, defIds);
    items.push({ key: 'cat.' + (row.id || row.name), group: 'Catalog · ' + row.section.replace(/^\d+[a-z]?\.\s*/, ''), label: (row.id ? row.id + ' ' : '') + row.name,
      small: parts.length ? '' : 'not built', desc: row.text + (parts.length ? '\npreview: ' + parts.map((p) => ('id' in p ? p.id : p.kind)).join(', ') : '\n(not built yet; nothing to preview)'),
      planned: true, parts });
  }
}

// ------------------------------------------------------------------ playback
let current: Item | null = null;
let t = Number(qs.get('t') ?? 0);
let playing = qs.get('pause') !== '1';
let speed = 1;
let duration = 2;
const live = new THREE.Group();
scene.add(live);
const cards: { mesh: THREE.Mesh; e: AtlasEntry }[] = [];

function partDuration(p: Part): number {
  if (p.kind === 'fn') return p.dur;
  if (p.kind === 'def') return fx.timing(p.id)?.duration ?? 2;
  if (p.kind === 'atlas') {
    const e = atlases.entry(p.id);
    const d = (e.frames ?? 1) / (e.fps ?? 30);
    return e.loop ? d * 2 : d + 0.3;
  }
  return 4;
}

async function play(key: string, o: { seed?: number; q?: 0 | 1 | 2; gore?: GoreLevel } = {}) {
  const it = items.find((i) => i.key === key);
  if (!it) throw new Error('unknown item ' + key);
  if (o.seed !== undefined) { seed = o.seed; ($('seed') as HTMLInputElement).value = String(seed); }
  if (o.q !== undefined) setQuality(o.q);
  if (o.gore) setGore(o.gore);
  current = it;
  trailDemo = null;
  for (const c of [...live.children]) live.remove(c);
  cards.length = 0;
  fx.reset(seed, 0);
  fx.gore = gore;
  if (it.cam) {
    camera.position.set(...it.cam[0]);
    controls.target.set(...it.cam[1]);
    controls.update();
  }
  brazier.visible = ($('brazier') as HTMLInputElement).checked || it.parts.some((p) => p.kind === 'brazier');
  for (const p of it.parts) if (p.kind === 'fn') p.run();
  const spatial = it.parts.filter((p) => p.kind !== 'brazier' && p.kind !== 'fn');
  for (const [i, p] of spatial.entries()) {
    const x = spatial.length > 1 ? (i - (spatial.length - 1) / 2) * 1.7 : 0;
    if (p.kind === 'def') fx.spawn(p.id, { x, y: 1.1, z: 0.25 }, { seed, t: 0 });
    else if (p.kind === 'atlas') {
      const m = await atlasCard(p.id);
      m.position.set(x, 0.02, 0.4);
      const e = atlases.entry(p.id);
      if (e.pivot && e.pivot[1] > 0.3) m.position.y = 1.0;           // centred effects float at chest height
      live.add(m);
      cards.push({ mesh: m, e });
    } else if (p.kind === 'static') live.add(await staticSheet(p.id));
  }
  duration = Math.max(1, ...it.parts.map(partDuration));
  t = Math.min(t, duration);
  for (const el of document.querySelectorAll('#list .it')) el.classList.toggle('sel', (el as HTMLElement).dataset.key === key);
  $('desc').textContent = `${it.label}\n${it.desc}`;
  at(t);
}

function at(time: number) {
  t = Math.max(0, time);
  trailAt(t);
  flames.time.value = t;
  fx.setTime(t);
  for (const c of cards) (c.mesh.material as THREE.ShaderMaterial).uniforms.uAge.value = flipbookAge(c.e, t);
  for (const b of brazierParts) (b.mesh.material as THREE.ShaderMaterial).uniforms.uAge.value = flipbookAge(b.e, t + b.phase * 2);
  // deterministic flicker: sum of incommensurate sines of t (lab only; the game uses noise1 of arena time)
  const fl = 0.75 + 0.12 * Math.sin(t * 13.1) + 0.08 * Math.sin(t * 23.7 + 1.3) + 0.05 * Math.sin(t * 41.9 + 0.4);
  brazierLight.intensity = brazier.visible ? 9 * fl : 0;
  ($('scrub') as HTMLInputElement).value = String(Math.round((t / duration) * 1000));
}

function setQuality(q: 0 | 1 | 2) {
  quality = q;
  fxSettings.setQuality(q);
  post.quality = q;
  ($('qual') as HTMLSelectElement).value = String(q);
}
function setGore(g: GoreLevel) {
  // Lab-local: NOT persisted, so trying a level here never changes the game's saved choice
  // (the game persists under arena.gore.v2 via setGoreLevel). Both copies the director reads are set.
  gore = parseGore(g) ?? GORE_DEFAULT;
  fxSettings.gore = gore;
  fx.gore = gore;
  fxSettings.emit();
  ($('gore') as HTMLSelectElement).value = gore;
}

// ------------------------------------------------------------------ list UI
function renderList() {
  const q = ($('q') as HTMLInputElement).value.toLowerCase();
  const list = $('list');
  list.innerHTML = '';
  let grp = '';
  for (const it of items) {
    if (q && !(it.label + ' ' + it.desc + ' ' + it.group).toLowerCase().includes(q)) continue;
    if (it.group !== grp) {
      grp = it.group;
      const g = document.createElement('div');
      g.className = 'grp';
      g.textContent = grp;
      list.appendChild(g);
    }
    const d = document.createElement('div');
    d.className = 'it' + (it.planned && !it.parts.length ? ' plan' : '') + (current?.key === it.key ? ' sel' : '');
    d.dataset.key = it.key;
    d.title = it.desc;
    d.innerHTML = `${it.label}${it.small ? `<small>${it.small}</small>` : ''}`;
    d.onclick = () => { t = 0; playing = true; void play(it.key); };
    list.appendChild(d);
  }
}

// ------------------------------------------------------------------ stats / HUD
let frameMs = 16;
let renderMs = 0;
function stats() {
  const s = fx.stats();
  return {
    item: current?.key ?? null, t, duration, seed, quality, gore,
    fx: s,
    post: { on: postOn, look: lookId, preset: presetId, presetW, soft: post.softEnabled, dist: post.distEnabled, bloom: post.currentLook.bloom, gpu: post.gpuTimes() },
    drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
    frameMs, renderMs,
    atlasFormat: atlases.formatUsed, atlasGpuMB: atlases.gpuBytes() / 1048576,
    textures: renderer.info.memory.textures,
  };
}
function hud() {
  const s = stats();
  const p = s.fx.particles;
  $('hud').textContent =
    `${s.item ?? '-'}   t ${t.toFixed(3)} / ${duration.toFixed(2)} s   x${speed}${playing ? '' : '  (paused)'}\n` +
    `particles add ${p.add}/${p.addCap}  alpha ${p.alpha}/${p.alphaCap}  effects ${s.fx.effects}  pending ${s.fx.pending}  rings ${s.fx.rings}  debris ${s.fx.debris}\n` +
    `draw calls ${s.drawCalls}  tris ${s.triangles}  frame ${frameMs.toFixed(1)} ms  render(cpu) ${renderMs.toFixed(2)} ms  fx cpu ${s.fx.cpu.frameMs.toFixed(3)}/${s.fx.cpu.updateMs.toFixed(3)} ms\n` +
    `atlases ${s.atlasFormat}  ~${s.atlasGpuMB.toFixed(1)} MB GPU  textures ${s.textures}   q${quality}  gore ${gore}  seed ${seed}\n` +
    `post ${postOn ? 'on' : 'OFF'}  look ${lookId}  preset ${presetId || '-'} ${presetId ? presetW.toFixed(2) : ''}  soft ${post.softEnabled ? 'on' : 'off'}  dist ${post.distEnabled ? 'on' : 'off'} (${s.fx.dist} live)  bloom ${post.currentLook.bloom.strength.toFixed(2)} @ ${post.currentLook.bloom.threshold.toFixed(2)}` +
    (gpuLine ? `\ngpu ms  ${gpuLine}` : '');
  $('fmt').textContent = atlases.formatUsed;
}

// ------------------------------------------------------------------ screenshot / sheets
function litUniforms() {
  // lit3 cards: key light direction in view space for the reference shader (also before sheet renders)
  camera.updateMatrixWorld();
  const kd = key.position.clone().normalize().transformDirection(camera.matrixWorldInverse);
  for (const m of [...cards.map((c) => c.mesh), ...brazierParts.map((b) => b.mesh)]) {
    const u = (m.material as THREE.ShaderMaterial).uniforms;
    u.uKeyDir.value.copy(kd);
    u.uKeyColor.value.set(PRESETS[preset].fbKey);
    u.uAmbient.value.set(PRESETS[preset].fbAmb);
  }
}
let gpuLine = '';
let gpuFrames = 0;
function renderNow() {
  litUniforms();
  renderer.info.reset();
  const t0 = performance.now();
  if (postOn) {
    // dt = 1: presets snap to their weight (the lab is a still-frame tool)
    post.update(1, { dof: 0, focus: 5, aberration: 0, desat: 0, flash: 0, vignette: 0 });
    post.render();
  } else {
    // plain render (A/B): world + FX layers in one pass, no depth copy, no distortion
    const m = camera.layers.mask;
    camera.layers.mask = MASK_WORLD | MASK_FX;
    softDepthUniforms.uSoftOn.value = 0;
    renderer.render(scene, camera);
    camera.layers.mask = m;
  }
  renderMs = renderMs * 0.9 + (performance.now() - t0) * 0.1;
  if (($('gpu') as HTMLInputElement).checked) {
    if (++gpuFrames % 30 === 0) {
      const g = post.gpuTimes();
      gpuLine = Object.entries(g).map(([k, v]) => `${k} ${v.avg.toFixed(2)}`).join('  ');
      post.setProfiling(true);
    }
  }
}
function shot(): string {
  renderNow();
  return canvas.toDataURL('image/png');
}
function download() {
  const a = document.createElement('a');
  a.href = shot();
  a.download = `fxlab_${(current?.key ?? 'scene').replace(/[^a-z0-9._-]+/gi, '_')}_s${seed}_t${t.toFixed(2)}.png`;
  a.click();
}
async function sheet(key: string, times: number[]): Promise<string> {
  playing = false;
  await play(key);
  const w = 360;
  const h = Math.round((w * canvas.height) / canvas.width);
  const c2 = document.createElement('canvas');
  c2.width = w * times.length;
  c2.height = h + 18;
  const g = c2.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, c2.width, c2.height);
  for (const [i, tt] of times.entries()) {
    at(tt);
    renderNow();
    g.drawImage(canvas, i * w, 0, w, h);
    g.fillStyle = '#ddd';
    g.font = '12px monospace';
    g.fillText(`${key}  t=${tt.toFixed(2)}`, i * w + 6, h + 13);
  }
  return c2.toDataURL('image/png');
}

// ------------------------------------------------------------------ wiring
function wire() {
  $('q').oninput = renderList;
  $('seed').onchange = () => { seed = Number(($('seed') as HTMLInputElement).value) || 1; if (current) void play(current.key); };
  $('reseed').onclick = () => { seed = (seed * 48271) % 2147483647 || 1; ($('seed') as HTMLInputElement).value = String(seed); if (current) void play(current.key); };
  $('qual').onchange = () => { setQuality(Number(($('qual') as HTMLSelectElement).value) as 0 | 1 | 2); if (current) void play(current.key); };
  $('gore').onchange = () => { setGore(($('gore') as HTMLSelectElement).value as GoreLevel); if (current) void play(current.key); };
  $('bg').onchange = () => { preset = ($('bg') as HTMLSelectElement).value as PresetId; applyPreset(); };
  $('dummies').onchange = () => { dummies.visible = ($('dummies') as HTMLInputElement).checked; };
  $('brazier').onchange = () => { brazier.visible = ($('brazier') as HTMLInputElement).checked; };
  $('mvOn').onchange = () => { if (current) void play(current.key); };
  $('postOn').onchange = () => { postOn = ($('postOn') as HTMLInputElement).checked; };
  $('softOn').onchange = () => { post.softEnabled = ($('softOn') as HTMLInputElement).checked; };
  $('distOn').onchange = () => { post.distEnabled = ($('distOn') as HTMLInputElement).checked; };
  $('gpu').onchange = () => { const on = ($('gpu') as HTMLInputElement).checked; post.setProfiling(on); gpuLine = on ? '(measuring...)' : ''; };
  const lk = $('look') as HTMLSelectElement;
  lk.innerHTML = ['lab', ...Object.keys(THEME_LOOK)].map((k) => `<option value="${k}">${k === 'lab' ? 'lab (neutral)' : k}</option>`).join('');
  lk.value = lookId;
  lk.onchange = () => { lookId = lk.value; applyLook(); };
  const ps = $('preset') as HTMLSelectElement;
  ps.innerHTML = ['', ...Object.keys(GRADE_PRESETS)].map((k) => `<option value="${k}">${k || 'none'}</option>`).join('');
  ps.onchange = () => { presetId = ps.value; applyLook(); };
  $('presetW').oninput = () => { presetW = Number(($('presetW') as HTMLInputElement).value); applyLook(); };
  $('bStr').oninput = () => post.setBloom({ strength: Number(($('bStr') as HTMLInputElement).value) });
  $('bThr').oninput = () => post.setBloom({ threshold: Number(($('bThr') as HTMLInputElement).value) });
  $('scrub').oninput = () => { playing = false; at((Number(($('scrub') as HTMLInputElement).value) / 1000) * duration); };
  $('play').onclick = () => { playing = !playing; };
  $('restart').onclick = () => { at(0); playing = true; };
  $('prev').onclick = () => { playing = false; at(t - 1 / 60); };
  $('next').onclick = () => { playing = false; at(t + 1 / 60); };
  $('spd').onchange = () => { speed = Number(($('spd') as HTMLSelectElement).value); };
  $('shot').onclick = download;
  addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text') return;
    if (e.code === 'Space') { playing = !playing; e.preventDefault(); }
    else if (e.key === ',') { playing = false; at(t - 1 / 60); }
    else if (e.key === '.') { playing = false; at(t + 1 / 60); }
    else if (e.key === 'l' || e.key === 'L') { const l = $('loop') as HTMLInputElement; l.checked = !l.checked; }
    else if (e.key === 's' || e.key === 'S') download();
  });
  ($('bg') as HTMLSelectElement).value = preset;
}

let last = performance.now();
function tick() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frameMs = frameMs * 0.92 + dt * 1000 * 0.08;
  if (playing && current) {
    let nt = t + dt * speed;
    if (nt > duration) nt = ($('loop') as HTMLInputElement).checked ? 0 : duration;
    if (nt === 0) void play(current.key);           // re-spawn so delayed layers replay too
    else at(nt);
  }
  controls.update();
  renderNow();
  hud();
  requestAnimationFrame(tick);
}

async function main() {
  resize();
  applyPreset();
  applyLook();
  setQuality(quality);
  setGore(gore);
  await atlases.load().catch((e) => console.warn('[fxlab] no atlas manifest', e));
  buildItems();
  wire();
  renderList();
  await Promise.all([loadDummies(), buildBrazier()]);
  brazier.visible = false;
  const first = qs.get('id') ?? items[0]?.key;
  if (first) await play(first);
  (window as unknown as { __fxlab: unknown }).__fxlab = {
    ready: true,
    list: () => items.map((i) => ({ key: i.key, group: i.group, parts: i.parts.length, planned: !!i.planned })),
    play: (key: string, o?: { seed?: number; q?: 0 | 1 | 2; gore?: GoreLevel }) => { playing = false; return play(key, o); },
    /** F1: post switches for A/B sheets: { post, soft, dist, look, preset, presetW, bloom: {strength, threshold} } */
    setPost: (o: { post?: boolean; soft?: boolean; dist?: boolean; look?: string; preset?: string; presetW?: number; bloom?: { strength?: number; threshold?: number } }) => {
      if (o.post !== undefined) postOn = o.post;
      if (o.soft !== undefined) post.softEnabled = o.soft;
      if (o.dist !== undefined) post.distEnabled = o.dist;
      if (o.look !== undefined) lookId = o.look;
      if (o.preset !== undefined) presetId = o.preset;
      if (o.presetW !== undefined) presetW = o.presetW;
      applyLook();
      if (o.bloom) post.setBloom(o.bloom);
      ($('postOn') as HTMLInputElement).checked = postOn;
      ($('softOn') as HTMLInputElement).checked = post.softEnabled;
      ($('distOn') as HTMLInputElement).checked = post.distEnabled;
      renderNow();
    },
    post,
    at: (tt: number) => { playing = false; at(tt); renderNow(); return t; },
    stats,
    sheet,
    shot,
    durationOf: () => duration,
  };
  tick();
}
void main();
