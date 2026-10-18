/**
 * A3 KIT GALLERY: every shared-kit asset from public/arena/manifest.json rendered lit (moon key + warm fire lights + a
 * soft sky environment) on a dark floor, through the same runtime path as the game (ArenaAssets: meshopt + KTX2 /
 * WebP, the trim material binding and the obstacle 9-slice fit of dressKit.ts).
 *   dev server:  /tools/arena/gallery/            ?tier=low (LOD1 + half sets)   ?tex=webp   ?view=<n>
 *   headless:    node tools/arena/check_gallery.cjs   (screenshots per view into docs/milestones/A3/gallery/)
 * Rows: obstacles (pillar at its nominal 5 m and stretched to 4.4 / 5.6 m by the SHAFT band, ruin column, rubble pile),
 * architecture modules (trim sheet), small pieces (props, decor, the brazier), and the trim sheet itself on a 2 x 1
 * tiled wall (the U wrap seam runs down the middle).
 * A4 rows (the shared dressing kit): braziers / lanterns / candles / bell / bones / stakes with flame cards and lights at
 * their sockets, hazards (spike grate raised, chain weight on kit links, vent, crumble) and features (banner pole with a
 * kit banner, barricade), the 8 banner cells on rods + 2 swags along swinging chains (vertex-shader sway, animated), and
 * every prop's FRAC_* breakage pieces exploded. `?still=1` freezes the sway clock (screenshots of the same pose).
 * A5 rows: the posed-fighter statues through the game's statue fit (sim statue r 0.85, h 5.0 and a smaller / bigger one),
 * and toppled copies of a statue and a pillar broken into their FRAC_* pieces by the runtime FracSet (debris.ts), at rest
 * 1.6 s after landing along their fall line, exactly as the arena spawns them.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Obstacle } from '../../../src/sim/arenaGen';
import { ArenaAssets, type KitAsset } from '../../../src/render/arena/assets';
import { kitObstacle, trimMaterial } from '../../../src/render/arena/dressKit';
import type { ArenaPack } from '../../../src/render/arena/assets';
import { BannerKit, swayTime } from '../../../src/render/arena/cloth';
import { ChainKit } from '../../../src/render/arena/chains';
import { FracSet } from '../../../src/render/arena/debris';

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
    // statues face the arena centre from their position: z -1 turns them toward the gallery camera (+z)
    const o: Obstacle = { id: n, kind, x: 0, z: kind === 'statue' ? -1 : 0, r, h, hp: 200, cover: true, toppleable: true };
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
  // ---------------- A4 rows
  const flameTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(32, 40, 2, 32, 36, 30);
    grd.addColorStop(0, 'rgba(255,240,200,1)');
    grd.addColorStop(0.35, 'rgba(255,150,60,0.8)');
    grd.addColorStop(1, 'rgba(255,80,20,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const flameMat = new THREE.MeshBasicMaterial({ map: flameTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  /** flame card + light at a socket (the game uses the FX flipbook flame; this is only a stand-in) */
  const lightSockets = (o: THREE.Object3D, id: string) => {
    const a = loaded.get(id)!;
    for (const sk of a.sockets) {
      const p = new THREE.Vector3(...sk.pos);
      if (sk.name === 'SOCK_flame' || sk.name.startsWith('SOCK_candle')) {
        const size = Number(sk.extras.size) || 0.9;
        for (const r of [0, Math.PI / 2]) {
          const q = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.6, size), flameMat);
          q.position.set(p.x, p.y + size * 0.4, p.z);
          q.rotation.y = r;
          o.add(q);
        }
        if (sk.name === 'SOCK_flame') {
          const l = new THREE.PointLight('#ff8a3a', 6 * size, 6, 1.7);
          l.position.set(p.x, p.y + 0.3, p.z);
          o.add(l);
        }
      } else if (sk.name === 'SOCK_glow') {
        const l = new THREE.PointLight(String(sk.extras.color ?? '#ffb060'), 1.5, Number(sk.extras.radius) || 2, 1.8);
        l.position.copy(p);
        o.add(l);
      }
    }
    return o;
  };
  const instA4 = (id: string, y = 0) => {
    const o = inst(id);
    if (!o) return null;
    const g = new THREE.Group();
    o.position.y = y;
    g.add(lightSockets(o, id));
    return g;
  };
  // row 4: dressing (braziers, lanterns, candles, bell, bones, stakes); hanging pieces at 2.4 m
  const row4: Item[] = [];
  for (const id of ids.filter((x) => role(x) === 'dress' || x === 'kit/brazier_tripod' || x === 'kit/lantern_toro')) {
    const hang = Number(loaded.get(id)?.extras.hang) > 0;
    const o = instA4(id, hang ? 2.4 : 0);
    if (o) row4.push({ label: id.slice(4), obj: o, w: id.includes('pedestal') || id.includes('stakes') ? 2.4 : id.includes('bell') ? 1.8 : 1.3 });
  }
  // row 5: hazards (spike grate with the spikes up, chain weight on kit links, vent, crumble) + features
  const row5: Item[] = [];
  const bannerAsset = loaded.get('kit/banners');
  const banners = bannerAsset ? new BannerKit(bannerAsset, 0.05) : null;
  const chainAsset = loaded.get('kit/chain_link');
  for (const id of ids.filter((x) => role(x) === 'hazard' || role(x) === 'feature')) {
    const o = inst(id);
    if (!o) continue;
    const g = new THREE.Group();
    g.add(o);
    const x = loaded.get(id)!;
    if (x.extras.kind === 'chains' && chainAsset) {
      o.position.y = 1.0;
      const ck = new ChainKit(chainAsset);
      const top = x.socket('SOCK_chain')?.pos[1] ?? 0.42;
      ck.straight(0, 4.2, 1.0 + top, 0, 'big', 1.25);
      for (const im of ck.build()) g.add(im);
    }
    if (x.extras.kind === 'banner' && banners) {
      const sk = x.socket('SOCK_banner');
      const b = sk ? banners.banner('vertical', 0, Number(sk.extras.w) || 1.1, Number(sk.extras.h) || 2.6) : null;
      if (b && sk) {
        b.position.set(sk.pos[0], sk.pos[1], sk.pos[2] + 0.04);
        g.add(b);
      }
    }
    row5.push({ label: `${id.slice(4)} (${role(id)})`, obj: g, w: x.extras.kind === 'crumble' ? 4.2 : x.extras.kind === 'banner' ? 1.8 : 2.4 });
  }
  // row 6: banners: the 8 vertical cells on rods hung from a beam + 2 swags along swinging chains between posts
  const bannerRow = new THREE.Group();
  if (banners) {
    for (let k = 0; k < 8; k++) {
      const b = banners.banner('vertical', k, 1.2, 3.2, true);
      if (b) {
        b.position.set((k - 3.5) * 1.6, 4.4, 0);
        bannerRow.add(b);
      }
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(13.6, 0.18, 0.18), new THREE.MeshStandardMaterial({ color: '#1c1714', roughness: 0.8 }));
    beam.position.set(0, 4.52, 0);
    bannerRow.add(beam);
    if (chainAsset) {
      const ck = new ChainKit(chainAsset);
      for (let s = 0; s < 2; s++) {
        const x0 = (s - 1) * 5.6 + 0.4;
        const a = new THREE.Vector3(x0, 4.2, 3.2),
          b = new THREE.Vector3(x0 + 4.8, 4.2, 3.2);
        ck.hang(a, b, 0.9, 'big', 0.12);
        const sw = banners.banner('swag', s, 2.4, 1.1);
        if (sw) {
          sw.position.set(x0 + 2.4, 3.55, 3.2);
          bannerRow.add(sw);
        }
        for (const px of [a.x, b.x]) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, 4.3, 0.25), beam.material);
          post.position.set(px, 2.15, 3.2);
          bannerRow.add(post);
        }
      }
      for (const im of ck.build()) bannerRow.add(im);
    }
    bannerRow.position.set(0, 0, 26);
    scene.add(bannerRow);
    label('kit/banners: 8 sigil cells (claw, sun, moon, skull, eye, flame, swords, rune ring) + 2 swags on kit chains', new THREE.Vector3(0, -0.1, 30));
  }
  // row 7: FRAC_* pieces of every prop / feature, exploded (render-only debris for A5)
  const row7: Item[] = [];
  for (const id of ids.filter((x) => role(x) === 'prop' || role(x) === 'feature')) {
    const a = loaded.get(id)!;
    const fr: THREE.Mesh[] = [];
    a.root.traverse((n) => {
      if (n.userData.frac && (n as THREE.Mesh).isMesh) fr.push(n as THREE.Mesh);
    });
    if (!fr.length) continue;
    const g = new THREE.Group();
    a.root.updateMatrixWorld(true);
    for (const m of fr) {
      const c = m.clone();
      c.visible = true;
      m.geometry.computeBoundingBox();
      const ctr = m.geometry.boundingBox!.getCenter(new THREE.Vector3());
      m.matrixWorld.decompose(c.position, c.quaternion, c.scale);
      c.position.add(new THREE.Vector3(ctr.x * 1.8, ctr.y * 0.35 + 0.05, ctr.z * 1.8));
      c.castShadow = true;
      g.add(c);
    }
    row7.push({ label: `${id.slice(4)} FRAC x${fr.length}`, obj: g, w: Number(a.extras.r0) > 0.5 || id.includes('banner') ? 2.6 : 1.5 });
  }
  // ---------------- A5 rows: statues (game fit) and toppled statue / pillar broken into FRAC_* pieces (runtime FracSet)
  const row8: Item[] = [];
  for (const id of ids.filter((x) => role(x) === 'statue')) {
    const it = ob(id, 'statue', 0.85, 5.0, row8.length);
    if (it) row8.push({ ...it, w: 3.0 });
  }
  const big = ids.find((x) => role(x) === 'statue');
  if (big) {
    const it = ob(big, 'statue', 0.98, 5.1, 7);
    if (it) row8.push({ ...it, w: 3.2 });
  }
  const w8 = rowZ(row8, 46, 1.2);
  const fallen: { id: string; kind: Obstacle['kind']; r: number; h: number; x: number }[] = [];
  if (big) fallen.push({ id: big, kind: 'statue', r: 0.85, h: 5.0, x: -7 });
  if (loaded.has('kit/pillar_square')) fallen.push({ id: 'kit/pillar_square', kind: 'column', r: 0.7, h: 5.0, x: 1 });
  for (const f of fallen) {
    const o: Obstacle = { id: 3, kind: f.kind, x: 0, z: 0, r: f.r, h: f.h, hp: 200, cover: true, toppleable: true };
    const obj = kitObstacle(loaded.get(f.id)!, o, { value: 0 });
    const pivot = new THREE.Group();
    pivot.position.set(f.x + f.r * 0.8, 0, 54);
    obj.position.set(-f.r * 0.8, 0, 0);
    pivot.add(obj);
    pivot.setRotationFromAxisAngle(new THREE.Vector3(0, 0, -1), Math.PI / 2 - 0.06);
    scene.add(pivot);
    pivot.updateMatrixWorld(true);
    const set = new FracSet(obj, 'lie', 3 * 31 + 7, { dir: new THREE.Vector3(1, 0, 0), speed: 1 });
    for (const m of set.meshes) scene.add(m);
    set.update(set.settle + 0.5);
    pivot.visible = false;
    label(`${f.id.slice(4)} toppled -> ${set.meshes.length ? 'FRAC pieces at rest' : 'no FRAC'}`, new THREE.Vector3(f.x + 2.5, -0.1, 56));
    fire(f.x + 2.5, 1.6, 57, 0.9);
  }
  for (const [x, z] of [[-w8 / 3, 48.5], [w8 / 3, 48.5], [0, 48.5]]) fire(x, 1.8, z, 1);

  const w4 = rowZ(row4, 12, 1.0);
  const w5 = rowZ(row5, 19, 1.2);
  const w7 = rowZ(row7, 34, 1.0);
  for (const [x, z] of [[-w4 / 3, 14.5], [w4 / 3, 14.5], [0, 14.5], [-w5 / 3, 21.5], [w5 / 3, 21.5], [0, 21.5], [-5, 29], [5, 29], [-w7 / 4, 36], [w7 / 4, 36]]) fire(x, 1.8, z, 0.8);

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
    // A4
    { name: 'dress_l', pos: new THREE.Vector3(-w4 / 4, 2.6, 18.5), look: new THREE.Vector3(-w4 / 4, 1.1, 12) },
    { name: 'dress_r', pos: new THREE.Vector3(w4 / 4, 2.6, 18.5), look: new THREE.Vector3(w4 / 4, 1.1, 12) },
    { name: 'hazards', pos: new THREE.Vector3(0, 5.5, 13.0), look: new THREE.Vector3(0, 0.6, 19.5) },
    { name: 'banners', pos: new THREE.Vector3(0, 3.0, 40), look: new THREE.Vector3(0, 2.8, 26) },
    { name: 'banner_close', pos: new THREE.Vector3(-3.2, 3.0, 30.5), look: new THREE.Vector3(-3.2, 2.9, 26) },
    { name: 'frac', pos: new THREE.Vector3(0, 2.4, 40.5), look: new THREE.Vector3(0, 0.5, 34) },
    // A5
    { name: 'statues', pos: new THREE.Vector3(0, 3.0, 57.5), look: new THREE.Vector3(0, 2.7, 46) },
    { name: 'statue_close', pos: new THREE.Vector3(-w8 / 2 + 1.5, 3.4, 51.5), look: new THREE.Vector3(-w8 / 2 + 1.5, 3.1, 46) },
    { name: 'toppled', pos: new THREE.Vector3(-1.5, 4.5, 63), look: new THREE.Vector3(-1.5, 0.4, 54) },
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
  hud.textContent = `A3 stone kit + A4 dressing kit + A5 statues  |  tier ${tier}  |  textures ${assets.format}  |  ${loaded.size} assets`;
  // A4: animate the banner sway / chain swing (vertex shaders); ?still=1 keeps one pose for screenshots
  const still = q.get('still') === '1';
  const t0 = performance.now();
  const loop = () => {
    swayTime.value = still ? 1.7 : (performance.now() - t0) / 1000;
    frame();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  void w5;
  void w8;
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
