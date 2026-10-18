/**
 * A3 KIT GALLERY: every shared-kit asset from public/arena/manifest.json rendered lit (moon key + warm fire lights + a
 * soft sky environment) on a dark floor, through the same runtime path as the game (ArenaAssets: meshopt + KTX2 /
 * WebP, the trim material binding and the obstacle 9-slice fit of dressKit.ts).
 *   dev server:  /tools/arena/gallery/            ?tier=low (LOD1 + half sets)   ?tex=webp   ?view=<n>
 *   headless:    node tools/arena/check_gallery.cjs   (screenshots per view into docs/milestones/A3/gallery/)
 * Rows: obstacles (pillar at its nominal 5 m and stretched to 4.4 / 5.6 m by the SHAFT band, ruin column, rubble pile),
 * architecture modules (trim sheet), small pieces (props, decor, the brazier), and the trim sheet itself on a 2 x 1
 * tiled wall (the U wrap seam runs down the middle).
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Obstacle } from '../../../src/sim/arenaGen';
import { ArenaAssets, type KitAsset } from '../../../src/render/arena/assets';
import { kitObstacle, trimMaterial } from '../../../src/render/arena/dressKit';
import type { ArenaPack } from '../../../src/render/arena/assets';

const q = new URLSearchParams(location.search);
const tier = q.get('tier') === 'low' ? 'low' : 'full';
const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#0b0d1a');
scene.fog = new THREE.Fog('#0b0d1a', 40, 90);
const pm = new THREE.PMREMGenerator(renderer);
scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 300);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = false;

// lights: lavender moon from behind-left (rim), a cool fill, warm fires between the rows
const moon = new THREE.DirectionalLight('#c9c4ff', 2.8);
moon.position.set(-18, 22, -26);
moon.castShadow = true;
moon.shadow.mapSize.set(4096, 4096);
const sc = moon.shadow.camera;
sc.left = sc.bottom = -40;
sc.right = sc.top = 40;
sc.near = 1;
sc.far = 120;
moon.shadow.bias = -0.0004;
moon.shadow.normalBias = 0.03;
scene.add(moon);
const fill = new THREE.DirectionalLight('#8090c0', 0.7);
fill.position.set(14, 10, 22);
scene.add(fill);
scene.add(new THREE.HemisphereLight('#4c4a8c', '#16131f', 0.55));
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#15161c', roughness: 0.45, metalness: 0 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
function fire(x: number, y: number, z: number, k = 1) {
  const l = new THREE.PointLight('#ff8a3a', 14 * k, 11, 1.7);
  l.position.set(x, y, z);
  scene.add(l);
  const s = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffb070' }));
  s.position.copy(l.position);
  scene.add(s);
}

interface Item {
  label: string;
  obj: THREE.Object3D;
  w: number;
}
const labels: { el: HTMLDivElement; at: THREE.Vector3 }[] = [];
function label(text: string, at: THREE.Vector3) {
  const el = document.createElement('div');
  el.className = 'lbl';
  el.textContent = text;
  document.body.appendChild(el);
  labels.push({ el, at });
}

function trisOf(o: THREE.Object3D) {
  let t = 0;
  o.traverse((n) => {
    const m = n as THREE.Mesh;
    if (!m.isMesh || !n.visible || n.userData.col || n.userData.frac) return;
    const g = m.geometry;
    t += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return t;
}

function rowZ(items: Item[], z: number, gap: number) {
  const W = items.reduce((s, it) => s + it.w, 0) + gap * (items.length - 1);
  let x = -W / 2;
  const box = new THREE.Box3();
  for (const it of items) {
    it.obj.position.set(x + it.w / 2, 0, z);
    scene.add(it.obj);
    it.obj.updateMatrixWorld(true);
    box.setFromObject(it.obj);
    label(`${it.label}\n${Math.round(trisOf(it.obj))} tris`, new THREE.Vector3(x + it.w / 2, -0.15, z + 1.2));
    x += it.w + gap;
  }
  return W;
}

const views: { name: string; pos: THREE.Vector3; look: THREE.Vector3 }[] = [];

async function main() {
  const assets = new ArenaAssets(renderer, '/arena/', '/basis/', q.get('tex') === 'webp' ? 'webp' : undefined);
  const man = await assets.manifest();
  const ids = Object.keys(man.assets).filter((id) => id.startsWith('kit/'));
  const loaded = new Map<string, KitAsset>();
  await Promise.all(ids.map((id) => assets.asset(id, tier).then((a) => void loaded.set(id, a), (e) => console.warn(id, e))));
  const pack: ArenaPack = { theme: 'colosseum', tier, art: { id: 'colosseum' }, assets: loaded, missing: [], ms: 0 };
  const trim = trimMaterial(pack, 'kit/stone_trim');
  const inst = (id: string) => {
    const a = loaded.get(id);
    if (!a) return null;
    const o = a.instantiate().obj;
    if (trim)
      o.traverse((n) => {
        const m = n as THREE.Mesh;
        if (m.isMesh && (m.material as THREE.Material).name === 'stone_trim') m.material = trim;
      });
    return o;
  };
  const role = (id: string) => man.assets[id].role;
  // row 1: obstacles through the game's fit (scale by r / r0, SHAFT stretch to h)
  const ob = (id: string, kind: Obstacle['kind'], r: number, h: number, n: number): Item | null => {
    const a = loaded.get(id);
    if (!a) return null;
    const o: Obstacle = { id: n, kind, x: 0, z: 0, r, h, hp: 200, cover: true, toppleable: true };
    return { label: `${id.slice(4)}  r ${r} h ${h}`, obj: kitObstacle(a, o, { value: 0 }), w: Math.max(2.4, r * 3.2) };
  };
  const row1 = [ob('kit/pillar_square', 'column', 0.7, 5.0, 0), ob('kit/pillar_square', 'column', 0.6, 4.4, 1), ob('kit/pillar_square', 'column', 0.8, 5.6, 2), ob('kit/column_ruin', 'column', 0.6, 4.2, 0), ob('kit/column_ruin', 'column', 0.7, 5.2, 3), ob('kit/rubble_pile', 'rock', 0.525, 5, 0)].filter(Boolean) as Item[];
  // row 2: architecture modules (trim sheet)
  const row2: Item[] = [];
  for (const id of ids.filter((x) => role(x) === 'module')) {
    const o = inst(id);
    if (o) row2.push({ label: id.slice(4), obj: o, w: Number(loaded.get(id)!.extras.width) || 2 });
  }
  // row 3: props, decor, brazier
  const row3: Item[] = [];
  for (const id of ids.filter((x) => role(x) === 'prop' || role(x) === 'decor')) {
    const o = inst(id);
    if (o) row3.push({ label: id.slice(4), obj: o, w: role(id) === 'decor' ? 2.6 : 1.4 });
  }
  const w1 = rowZ(row1, 0, 1.6);
  const w2 = rowZ(row2, -9, 1.2);
  const w3 = rowZ(row3, 6, 1.4);
  // the trim sheet: a 16 x 8 m wall, the texture tiled twice in U (the wrap seam is at the middle)
  const T = loaded.get('kit/stone_trim');
  if (T && trim) {
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(16, 8), trim.clone());
    (sheet.material as THREE.MeshStandardMaterial).vertexColors = false;
    const uv = sheet.geometry.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 2);
    sheet.position.set(0, 4.05, -18);
    sheet.receiveShadow = true;
    scene.add(sheet);
    label('kit/stone_trim (U tiled x2, wrap seam at the centre line)', new THREE.Vector3(0, -0.1, -17.2));
  }
  for (const [x, z] of [[-w1 / 3, 2.2], [w1 / 3, 2.2], [0, 2.2], [-w2 / 3, -6.5], [w2 / 3, -6.5], [0, -6.5], [-w3 / 4, 8.5], [w3 / 4, 8.5], [0, -15]]) fire(x, 1.6, z, z === -15 ? 2.5 : 1);
  views.push(
    { name: 'overview', pos: new THREE.Vector3(0, 22, 36), look: new THREE.Vector3(0, 1, -5) },
    { name: 'obstacles', pos: new THREE.Vector3(0, 3.2, 12.5), look: new THREE.Vector3(0, 2.4, 0) },
    { name: 'modules_l', pos: new THREE.Vector3(-w2 / 4, 7.5, 5), look: new THREE.Vector3(-w2 / 4, 2.2, -9) },
    { name: 'modules_r', pos: new THREE.Vector3(w2 / 4, 7.5, 5), look: new THREE.Vector3(w2 / 4, 2.2, -9) },
    { name: 'small', pos: new THREE.Vector3(0, 2.6, 13), look: new THREE.Vector3(0, 0.5, 6) },
    { name: 'trim', pos: new THREE.Vector3(0, 4.1, -2.5), look: new THREE.Vector3(0, 4.05, -18) },
    { name: 'pillar_close', pos: new THREE.Vector3(-row1.length * 1.75 + 1.6, 1.8, 4.2), look: new THREE.Vector3(-row1.length * 1.75 + 1.4, 2.0, 0) },
  );
  const bar = document.getElementById('views')!;
  views.forEach((v, i) => {
    const b = document.createElement('button');
    b.textContent = v.name;
    b.onclick = () => setView(i);
    bar.appendChild(b);
  });
  setView(Number(q.get('view') ?? 0));
  const info = { tier, format: assets.format, assets: [...loaded.keys()], drawCalls: 0, triangles: 0 };
  (window as unknown as { __gallery: unknown }).__gallery = { ready: true, views: views.map((v) => v.name), setView, info, render: frame };
  hud.textContent = `A3 shared stone kit  |  tier ${tier}  |  textures ${assets.format}  |  ${loaded.size} assets`;
}

function setView(i: number) {
  const v = views[Math.max(0, Math.min(views.length - 1, i))];
  camera.position.copy(v.pos);
  controls.target.copy(v.look);
  controls.update();
  frame();
}

function frame() {
  const w = canvas.clientWidth,
    h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  renderer.render(scene, camera);
  const p = new THREE.Vector3();
  for (const l of labels) {
    p.copy(l.at).project(camera);
    const vis = p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
    l.el.style.display = vis ? '' : 'none';
    l.el.style.left = `${((p.x + 1) / 2) * w}px`;
    l.el.style.top = `${((1 - p.y) / 2) * h}px`;
  }
}

controls.addEventListener('change', frame);
addEventListener('resize', frame);
main().catch((e) => {
  hud.textContent = `gallery failed: ${e?.message ?? e}`;
  console.error(e);
});
