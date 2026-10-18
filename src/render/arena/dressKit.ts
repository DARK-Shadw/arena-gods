/**
 * DRESS KIT: the generic, data-driven theme builder (arena art plan 4.1). It implements the `Dressing`
 * contract from a ThemeArt + the loaded ArenaPack, so arenaView.ts does not care whether a slot comes from
 * baked kit assets or from the legacy procedural builders.
 *
 * A1 skeleton: the legacy builder still makes the boundary, gates, backdrop, obstacles and hazards;
 * dressKit replaces the props that the ThemeArt maps to a loaded kit asset (the tripod brazier).
 * A2: the FLOOR. When the art names a floor set that loaded, the legacy floor meshes (floorDisc and the meshes a
 * theme flagged `floorDeco`, e.g. the colosseum medallion) are removed and the wet floor (floor.ts) takes their
 * place with the same pad; the arena wires its reflection / light map (arenaView.ts).
 * A3: OBSTACLES and the RING from the shared stone kit.
 *   obstacles  ThemeArt.obstacles[kind] (one id or variants picked by obstacle id): the asset is scaled in x / z by
 *              o.r / r0 and its SHAFT band stretched so the top lands exactly on the sim's o.h (base and capital keep
 *              their proportions); the crack overlay (withCrack) patches a per-obstacle clone of the kit material.
 *   ring       the legacy podium wall (userData.ring 'podium') becomes trim-sheet wall modules along the ellipse
 *              (intact under wall braziers and beside the gates, broken elsewhere), each gallery segment is replaced in
 *              place by an arcade bay, rubble clusters sit at the wall foot, and the legacy stone left in place
 *              (stands, curb, gate facades) is re-tinted toward the kit stone. Every module instance is merged into one
 *              mesh per material (the shared trim material: one draw call for the whole ring).
 * Each later milestone moves one slot here (A4-A7 gates / hazards, A6 backdrop, A19 lights / sockets), keeping the
 * legacy builder as the fallback for slots the art leaves undefined or whose asset failed to load.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Obstacle } from '../../sim/arenaGen';
import type { Arena } from './arenaView';
import type { ArenaPack, KitAsset, KitInstance } from './assets';
import type { AssetId } from './art';
import { alongEllipse, inGate } from './common';
import type { Dressing } from './dressing';
import { WetFloor } from './floor';
import { withCrack } from './materials';
import { R } from './noise';

export function dressKit(a: Arena, pack: ArenaPack, legacy: (a: Arena) => Dressing): Dressing {
  // TODO(A4-A7): gates, hazards; TODO(A6): backdrop
  const D = legacy(a);
  const art = pack.art;
  const wetFloor = art.floor ? buildFloor(a, pack, D) : undefined;
  if (art.ring) buildRing(a, pack, D);
  const legacyObstacle = D.obstacle;
  return {
    ...D,
    wetFloor,
    obstacle(o, crack) {
      const asset = pickObstacle(pack, o);
      if (asset) {
        try {
          return kitObstacle(asset, o, crack);
        } catch (e) {
          console.warn('[arena] kit obstacle failed, legacy used', asset.id, e);
        }
      }
      return legacyObstacle(o, crack);
    },
    propAsset(kind: string): KitInstance | null {
      const id = art.props?.[kind as keyof NonNullable<typeof art.props>];
      const asset = id ? pack.assets.get(id) : undefined;
      return asset ? asset.instantiate() : null;
    },
  };
}

// ------------------------------------------------------------------ geometry helpers

/** a plain float, non-normalised, non-interleaved copy (GLTF meshopt / quantised attributes can't take applyMatrix4) */
function floatGeo(src: THREE.BufferGeometry, keep?: string[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) {
    if (keep && !keep.includes(name)) continue;
    const at = attr as THREE.BufferAttribute;
    const n = at.count,
      k = at.itemSize;
    const arr = new Float32Array(n * k);
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) arr[i * k + c] = at.getComponent(i, c);
    g.setAttribute(name, new THREE.BufferAttribute(arr, k));
  }
  if (src.index) g.setIndex(new THREE.BufferAttribute(Uint32Array.from(src.index.array as ArrayLike<number>), 1));
  return g;
}

/** the obstacle asset for this obstacle (variants by id), when loaded */
function pickObstacle(pack: ArenaPack, o: Obstacle): KitAsset | null {
  const v = pack.art.obstacles?.[o.kind];
  if (!v) return null;
  const ids = (Array.isArray(v) ? v : [v]).filter((id) => pack.assets.has(id));
  if (!ids.length) return null;
  return pack.assets.get(ids[o.id % ids.length]) ?? null;
}

/**
 * A3: a kit obstacle fitted to the sim obstacle: x / z scaled by o.r / r0; with a SHAFT band the vertices above it move
 * up by (o.h - H) and the band stretches, so base and capital keep their size and the top is exactly o.h; without one
 * (rubble) the asset is scaled uniformly. Geometry and the crack material are per obstacle (flagged ownGeo / ownMat).
 */
export function kitObstacle(asset: KitAsset, o: Obstacle, crack: { value: number }): THREE.Object3D {
  const inst = asset.instantiate();
  const root = inst.obj;
  const x = asset.extras;
  const r0 = Number(x.r0) || o.r;
  const H = Number(x.height) || o.h;
  const s = o.r / r0;
  const sh = asset.shaft;
  const sy = sh ? 1 : s;
  const d = sh ? o.h - H : 0;
  const k = sh ? (sh[1] - sh[0] + d) / (sh[1] - sh[0]) : 1;
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  root.scale.set(1, 1, 1);
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((n) => {
    if ((n as THREE.Mesh).isMesh && !n.userData.col) meshes.push(n as THREE.Mesh);
  });
  // a stable orientation per obstacle (render seed from the id): pillars are not all turned the same way
  const yaw = (new R(o.id * 977 + 13).next() * 4) | 0;
  const rot = new THREE.Matrix4().makeRotationY((yaw * Math.PI) / 2 + (sh ? 0 : o.id * 1.3));
  const mats = new Map<THREE.Material, THREE.Material>();
  for (const m of meshes) {
    const g = floatGeo(m.geometry);
    g.applyMatrix4(m.matrixWorld);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i);
      if (sh) {
        if (y > sh[1]) y += d;
        else if (y > sh[0]) y = sh[0] + (y - sh[0]) * k;
      }
      p.setXYZ(i, p.getX(i) * s, y * sy, p.getZ(i) * s);
    }
    g.applyMatrix4(rot);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    m.geometry = g;
    m.userData.ownGeo = true;
    m.removeFromParent();
    m.position.set(0, 0, 0);
    m.quaternion.identity();
    m.scale.set(1, 1, 1);
    const base = m.material as THREE.MeshStandardMaterial;
    let cm = mats.get(base);
    if (!cm) {
      cm = withCrack(base, { macro: [0.25, 0.05] }, crack);
      mats.set(base, cm);
      cm.userData.ownMat = true;
    }
    m.material = cm;
    m.userData.ownMat = m.userData.frac ? false : true;
    root.add(m);
  }
  // only one mesh per material disposes it (FRAC pieces share the LOD's crack material)
  const owner = new Set<THREE.Material>();
  for (const m of meshes) {
    const mm = m.material as THREE.Material;
    m.userData.ownMat = !owner.has(mm);
    owner.add(mm);
  }
  // drop the now-empty LOD groups
  for (const c of [...root.children]) if (!(c as THREE.Mesh).isMesh && !c.userData.col && !c.children.length && /^LOD/.test(c.name)) root.remove(c);
  root.userData.footK = Number(x.footprintR) && r0 ? Number(x.footprintR) / r0 : undefined;
  return root;
}

// ------------------------------------------------------------------ A2 floor

/** A2: swap the legacy floor for the kit wet floor (legacy floor kept when the set did not load or fails) */
function buildFloor(a: Arena, pack: ArenaPack, D: Dressing): WetFloor | undefined {
  const F = pack.art.floor!;
  const set = pack.assets.get(F.set);
  if (!set) return undefined;
  const old = a.group.children.filter((o) => o.userData.floor || o.userData.floorDeco);
  const pad = Number(old.find((o) => o.userData.floor)?.userData.floorPad ?? 1.5);
  let wf: WetFloor;
  try {
    wf = new WetFloor({ layout: a.layout, pad, set, inlay: F.inlay ? (pack.assets.get(F.inlay) ?? null) : null, art: F, seed: a.layout.seed, quality: a.quality });
  } catch (e) {
    console.warn('[arena] kit floor failed, legacy floor kept', e);
    return undefined;
  }
  removeLegacy(a, D, old);
  a.group.add(wf.mesh);
  return wf;
}

/** remove legacy meshes from the arena group; dispose their geometry and the materials nothing else still uses */
function removeLegacy(a: Arena, D: Dressing, old: THREE.Object3D[]) {
  const mats = new Set<THREE.Material>();
  for (const o of old) {
    a.group.remove(o);
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    for (const x of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) mats.add(x);
  }
  for (const m of Object.values(D.mats)) mats.delete(m); // still handed out to obstacles / props / hazards
  const keepTex = new Set<THREE.Texture>();
  for (const m of Object.values(D.mats)) for (const v of Object.values(m)) if (v instanceof THREE.Texture) keepTex.add(v);
  a.group.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    for (const x of Array.isArray(m) ? m : m ? [m] : []) {
      mats.delete(x);
      for (const v of Object.values(x)) if (v instanceof THREE.Texture) keepTex.add(v);
    }
  });
  for (const m of mats) {
    for (const v of Object.values(m)) if (v instanceof THREE.Texture && !keepTex.has(v)) v.dispose();
    m.dispose();
  }
}

// ------------------------------------------------------------------ A3 ring

/** one module placement: asset + world matrix */
interface Placed {
  asset: KitAsset;
  m: THREE.Matrix4;
}

/**
 * A3: the shared trim material: the kit/stone_trim texture set's material, cloned with vertex colours on (the modules'
 * COLOR_0 = baked AO x wet base). Owned by the arena (its textures stay owned by the asset cache).
 */
export function trimMaterial(pack: ArenaPack, id: AssetId | undefined): THREE.MeshStandardMaterial | null {
  const t = id ? pack.assets.get(id) : undefined;
  if (!t) return null;
  let src: THREE.MeshStandardMaterial | null = null;
  t.root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (!src && m && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial) src = m;
  });
  if (!src) return null;
  const m = (src as THREE.MeshStandardMaterial).clone();
  m.vertexColors = true;
  m.name = 'kit_stone_trim';
  for (const tx of [m.map, m.normalMap, m.aoMap, m.roughnessMap, m.metalnessMap]) {
    if (!tx) continue;
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
    tx.anisotropy = 4;
    tx.needsUpdate = true;
  }
  return m;
}

function buildRing(a: Arena, pack: ArenaPack, D: Dressing) {
  const RA = pack.art.ring!;
  const trim = trimMaterial(pack, RA.trim);
  if (!trim) {
    console.warn('[arena] kit ring: no trim set, legacy ring kept');
    return;
  }
  const L = a.layout;
  const rnd = new R(L.seed * 7919 + 31);
  const placed: Placed[] = [];
  const asset = (ids: AssetId[] | undefined, pickN: number) => {
    const ok = (ids ?? []).filter((id) => pack.assets.has(id));
    return ok.length ? pack.assets.get(ok[pickN % ok.length])! : null;
  };
  const toRemove: THREE.Object3D[] = [];
  // podium wall -> wall modules
  const P = RA.podium;
  const podium = a.group.children.filter((o) => o.userData.ring === 'podium');
  if (P && podium.length && asset(P.intact, 0)) {
    const braziers = a.group.children.filter((o) => o.userData.wallBrazier).map((o) => o.position.clone());
    const depth = Number(asset(P.intact, 0)!.extras.depth) || 0.9;
    let n = 0;
    alongEllipse(
      L,
      P.offset + depth / 2,
      P.spacing,
      (p, yaw) => {
        const nearBrazier = braziers.some((b) => Math.hypot(b.x - p.x, b.z - p.z) < 2.6);
        const nearGate = inGate(L, p, P.gateHalf + 4.5);
        const broken = !nearBrazier && !nearGate && rnd.next() < (P.brokenShare ?? 0.5) ? asset(P.broken, n) : null;
        const A = broken ?? asset(P.intact, n)!;
        placed.push({ asset: A, m: new THREE.Matrix4().compose(new THREE.Vector3(p.x, 0, p.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1)) });
        n++;
      },
      P.gateHalf,
      0.5,
    );
    toRemove.push(...podium);
  }
  // gallery segments -> arcade bays in place (same position / yaw / base height); their caps go
  const G = RA.gallery;
  const gallery = a.group.children.filter((o) => o.userData.ring === 'gallery');
  if (G && gallery.length && asset(G.assets, 0)) {
    let n = 0;
    for (const seg of gallery) {
      const A = asset(G.assets, (rnd.next() * 997) | 0)!;
      seg.updateMatrix();
      placed.push({ asset: A, m: seg.matrix.clone() });
      n++;
    }
    toRemove.push(...gallery, ...a.group.children.filter((o) => o.userData.ring === 'galleryCap'));
    void n;
  }
  // rubble clusters at the wall foot (outside the fight ellipse, off the gate lanes)
  const RB = RA.rubble;
  if (RB && pack.assets.has(RB.asset)) {
    const A = pack.assets.get(RB.asset)!;
    alongEllipse(
      L,
      RB.offset,
      RB.spacing,
      (p, yaw) => {
        if (rnd.next() < 0.25) return;
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + rnd.range(-0.5, 0.5) + (rnd.next() < 0.5 ? Math.PI : 0));
        const sc = rnd.range(0.8, 1.15);
        placed.push({ asset: A, m: new THREE.Matrix4().compose(new THREE.Vector3(p.x, 0, p.z), q, new THREE.Vector3(sc, sc, sc)) });
      },
      3.5,
      0.3,
    );
  }
  if (!placed.length) return;
  removeLegacy(a, D, toRemove);
  // merge per material: trim modules -> one mesh with the trim material; textured decor -> one mesh per asset material
  const buckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[]; shadow: boolean }>();
  const iron = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.035, 0.032, 0.03), metalness: 0.85, roughness: 0.55, vertexColors: true });
  for (const pl of placed) {
    pl.asset.root.updateMatrixWorld(true);
    pl.asset.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || o.userData.col || o.userData.frac) return;
      const src = m.material as THREE.MeshStandardMaterial;
      const isTrim = src.name === 'stone_trim';
      const isIron = src.name === 'iron';
      const key = isTrim ? 'trim' : isIron ? 'iron' : `${pl.asset.id}|${src.uuid}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { mat: isTrim ? trim : isIron ? iron : src, geos: [], shadow: true }));
      const keep = isTrim || isIron ? ['position', 'normal', 'uv', 'color'] : ['position', 'normal', 'uv'];
      const g = floatGeo(m.geometry, keep);
      if (keep.includes('color') && !g.attributes.color) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 4).fill(1), 4));
      const c = g.attributes.color as THREE.BufferAttribute | undefined;
      if (c && c.itemSize === 3) {
        const c4 = new Float32Array(c.count * 4);
        for (let i = 0; i < c.count; i++) c4.set([c.getX(i), c.getY(i), c.getZ(i), 1], i * 4);
        g.setAttribute('color', new THREE.BufferAttribute(c4, 4));
      }
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(pl.m, m.matrixWorld));
      b.geos.push(g);
    });
  }
  for (const [key, b] of buckets) {
    const merged = mergeGeometries(b.geos, false);
    for (const g of b.geos) g.dispose();
    if (!merged) {
      console.warn('[arena] kit ring merge failed for', key);
      continue;
    }
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, b.mat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = `kitRing_${key.split('|')[0]}`;
    // decor meshes use the asset cache's material: the arena owns only the merged geometry
    if (key !== 'trim' && key !== 'iron') mesh.userData.sharedMat = true;
    a.group.add(mesh);
  }
  if (!buckets.has('iron')) iron.dispose();
  // legacy stone that stays (stands, curb, gate facades): toward the kit's dark blue-grey stone
  if (RA.retint) {
    const tint = new THREE.Color(...RA.retint);
    const clones = new Map<THREE.Material, THREE.Material>();
    a.group.traverse((o) => {
      if (!o.userData.legacyStone) return;
      const m = o as THREE.Mesh;
      const src = m.material as THREE.MeshStandardMaterial;
      if (!src?.isMeshStandardMaterial) return;
      let c = clones.get(src);
      if (!c) {
        const cm = src.clone();
        cm.color.multiply(tint);
        cm.roughness = Math.min(1, cm.roughness * 1.15);
        clones.set(src, (c = cm));
      }
      m.material = c;
    });
  }
}
