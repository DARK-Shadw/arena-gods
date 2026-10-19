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
 * A4: the shared DRESSING kit. Props (crate, barrel, urn, keg, chunk, toro lantern), the A2b features (banner pole with a
 *   kit banner on its crossbar, barricade), hazard visuals (spike grate, chain weight on instanced links, fire-jet vent,
 *   crumbling floor: `hazardKit`, consumed by arenaView's hazard builders), and on the ring: wall-top braziers (merged),
 *   the legacy wall banners replaced by kit banners on rods and short chains (ONE merged swaying mesh, cells by the render
 *   seed: no Math.random), and wall-foot decor (candles with glow cards, skulls, bone piles).
 * A7: the Moon Gate NEAR FIELD (nearField.ts, RingArt.ruins): ruined tiers / pillars / banners / chains / gates / watchers /
 *   tier fires are added to the same merged ring (trim draw call, one banner mesh, one chain builder); the ring dressing keeps
 *   out of the kit gate zones and off the pillars (gateZoneTest); the wet floor gets an invisible support proxy in the
 *   arena's losGroup; the chandelier becomes the iron fire cage.
 * Each later milestone moves one slot here (A5-A7 gates, A6 backdrop, A19 lights / sockets), keeping the
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
import { BannerKit } from './cloth';
import { ChainKit } from './chains';
import type { HazardDef } from '../../sim/arenaGen';
import { softDot } from './textures';
import { buildNearField, fireCage, gateZoneTest, type BannerSpec, type Placed } from './nearField';

export function dressKit(a: Arena, pack: ArenaPack, legacy: (a: Arena) => Dressing): Dressing {
  // TODO(A4-A7): gates, hazards; TODO(A6): backdrop
  const D = legacy(a);
  const art = pack.art;
  const wetFloor = art.floor ? buildFloor(a, pack, D) : undefined;
  // A4: banner cloth + chain builders shared by the ring, the banner poles and the chain-weight hazards
  const bannerAsset = art.banners ? pack.assets.get(art.banners) : undefined;
  const banners = bannerAsset ? new BannerKit(bannerAsset, a.quality >= 1 ? 0.05 : 0) : null;
  const chainAsset = art.chains ? pack.assets.get(art.chains) : undefined;
  if (art.ring) buildRing(a, pack, D, banners, chainAsset ?? null);
  const legacyObstacle = D.obstacle;
  const seed = a.layout.seed;
  return {
    ...D,
    wetFloor,
    feature(o) {
      try {
        return kitFeature(pack, o, banners, seed);
      } catch (e) {
        console.warn('[arena] kit feature failed, placeholder used', o.kind, e);
        return null;
      }
    },
    hazardKit(h: HazardDef): KitInstance | null {
      const id = art.hazards?.[h.kind];
      const asset = id ? pack.assets.get(id) : undefined;
      if (!asset) return null;
      const inst = asset.instantiate();
      // flat hazards scale in x / z by the sim radius over the asset's nominal r0; the chain weight keeps its size
      const r0 = Number(asset.extras.r0) || h.r;
      if (h.kind !== 'chains') inst.obj.scale.set(h.r / r0, 1, h.r / r0);
      return inst;
    },
    chainKit(): ChainKit | null {
      return chainAsset ? new ChainKit(chainAsset) : null;
    },
    // A7: the Moon Gate's iron fire cage for the chandelier hazard (legacy: the bronze ring on velarium cables)
    chandelier: art.ring?.ruins?.fireCage ? () => fireCage(a) : D.chandelier,
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
  // A5 statues: the plinth (below plinthTop) takes the sim radius in x / z, the figure scales uniformly to the sim height
  // (exact top, never squashed); they face the arena centre (the asset's front is +z)
  const statue = x.fit === 'statue';
  const su = o.h / H;
  const pTop = Number(x.plinthTop) || 0;
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
  const rot = new THREE.Matrix4().makeRotationY(statue ? Math.atan2(-o.x, -o.z) : (yaw * Math.PI) / 2 + (sh ? 0 : o.id * 1.3));
  const mats = new Map<THREE.Material, THREE.Material>();
  for (const m of meshes) {
    const g = floatGeo(m.geometry);
    g.applyMatrix4(m.matrixWorld);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i);
      if (statue) {
        const k = y < pTop ? s : su;
        p.setXYZ(i, p.getX(i) * k, y * su, p.getZ(i) * k);
        continue;
      }
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

/**
 * A5: the two render-only guardian statues flanking the east gate (RingArt.guardians), as Placed entries merged with the
 * ring: at azimuth 0 just outside the boundary (on the podium wall's coping with onWall), `side` m either side of the gate
 * axis, facing the arena centre
 */
function guardians(a: Arena, pack: ArenaPack, placed: Placed[]) {
  const GA = a.kit?.art.ring?.guardians ?? pack.art.ring?.guardians;
  if (!GA || !pack.assets.has(GA.asset)) return;
  const A = pack.assets.get(GA.asset)!;
  const L = a.layout;
  for (const side of [-1, 1]) {
    const z = side * GA.side;
    // the boundary x at this z (ellipse), then `offset` m further out
    const x = L.rx * Math.sqrt(Math.max(0, 1 - (z / L.rz) ** 2)) + GA.offset;
    const yaw = Math.atan2(-x, -z);
    placed.push({ asset: A, m: new THREE.Matrix4().compose(new THREE.Vector3(x, GA.onWall ? L.wallH : 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(GA.scale, GA.scale, GA.scale)) });
  }
}

// ------------------------------------------------------------------ A4 features

/** a deterministic integer from a few numbers (render seed: atlas cells, decor picks) */
export function hashInt(...n: number[]): number {
  let h = 2166136261;
  for (const x of n) {
    h ^= Math.floor(x * 1000) | 0;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A4: kit visual for an A2b feature obstacle (banner pole + cloth, barricade), facing the arena centre; null = placeholder */
function kitFeature(pack: ArenaPack, o: Obstacle, banners: BannerKit | null, seed: number): THREE.Object3D | null {
  const id = pack.art.features?.[o.kind];
  const asset = id ? pack.assets.get(id) : undefined;
  if (!asset) return null;
  const inst = asset.instantiate();
  const g = new THREE.Group();
  g.add(inst.obj);
  if (o.kind === 'banner') {
    const s = inst.sockets.find((x) => x.name === 'SOCK_banner');
    if (!banners || !s) return null; // the placeholder carries its own cloth: no bare poles
    const cell = hashInt(seed, o.id, 7) % banners.cells;
    const b = banners.banner('vertical', cell, Number(s.extras.w) || 1.1, Number(s.extras.h) || 2.6);
    if (!b) return null;
    b.position.set(s.pos[0], s.pos[1], s.pos[2] + 0.04);
    g.add(b);
  }
  g.rotation.y = Math.atan2(-o.x, -o.z);
  g.traverse((n) => {
    if ((n as THREE.Mesh).isMesh && !n.userData.col) n.castShadow = n.receiveShadow = true;
  });
  return g;
}

/** A4: glow cards for candle wicks (two crossed additive quads per wick, merged into one static mesh) */
function candleCards(points: { p: THREE.Vector3; size: number }[], color: string): THREE.Mesh | null {
  if (!points.length) return null;
  const pos: number[] = [],
    uv: number[] = [],
    idx: number[] = [];
  for (const { p, size } of points) {
    const w = size * 0.35,
      h = size * 1.1;
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
    ]) {
      const b = pos.length / 3;
      pos.push(p.x - dx * w, p.y - h * 0.15, p.z - dz * w, p.x + dx * w, p.y - h * 0.15, p.z + dz * w, p.x + dx * w, p.y + h * 0.85, p.z + dz * w, p.x - dx * w, p.y + h * 0.85, p.z - dz * w);
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.2), map: softDot(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  m.name = 'kitCandleGlow';
  m.userData.dyn = true;
  m.renderOrder = 2;
  return m;
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
  // A7: the wet floor is drawn as a dyn mesh (no merge, own passes), so the ray casts that need a floor (entrance support,
  // anchor snapping) get an invisible proxy of it in the losGroup (the legacy floor disc was a plain solid mesh)
  const proxy = new THREE.Mesh(wf.mesh.geometry.clone(), a.losMat);
  proxy.position.copy(wf.mesh.position);
  proxy.quaternion.copy(wf.mesh.quaternion);
  proxy.scale.copy(wf.mesh.scale);
  proxy.name = 'losFloor';
  a.losGroup.add(proxy);
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

function buildRing(a: Arena, pack: ArenaPack, D: Dressing, banners: BannerKit | null, chainAsset: KitAsset | null) {
  const RA = pack.art.ring!;
  const trim = trimMaterial(pack, RA.trim);
  if (!trim) {
    console.warn('[arena] kit ring: no trim set, legacy ring kept');
    return;
  }
  const L = a.layout;
  const rnd = new R(L.seed * 7919 + 31);
  const placed: Placed[] = [];
  const trimGeos: THREE.BufferGeometry[] = [];
  const bannerList: BannerSpec[] = [];
  const rodList: { m: THREE.Matrix4; w: number }[] = [];
  // A7: one chain builder for the whole ring (banner hangers, the pillar chains)
  const chains = chainAsset ? new ChainKit(chainAsset) : null;
  // A7: ring dressing stays out of the kit gate structures (and decor off the pillars)
  const inZone = gateZoneTest(a, pack, false);
  const blocked = gateZoneTest(a, pack, true);
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
        if (inZone(p)) return;
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
  // gallery segments -> arcade bays in place (same position / yaw / base height); their caps go. A7: with ruins the
  // near field removes the gallery (it stood on the stands) and puts arcade bays on the ruined tiers instead
  const G = RA.gallery;
  const gallery = a.group.children.filter((o) => o.userData.ring === 'gallery');
  if (G && !RA.ruins && gallery.length && asset(G.assets, 0)) {
    for (const seg of gallery) {
      const A = asset(G.assets, (rnd.next() * 997) | 0)!;
      seg.updateMatrix();
      placed.push({ asset: A, m: seg.matrix.clone() });
    }
    toRemove.push(...gallery, ...a.group.children.filter((o) => o.userData.ring === 'galleryCap'));
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
        if (blocked(p)) return;
        placed.push({ asset: A, m: new THREE.Matrix4().compose(new THREE.Vector3(p.x, 0, p.z), q, new THREE.Vector3(sc, sc, sc)) });
      },
      3.5,
      0.3,
    );
  }
  // A4: wall-top braziers: the legacy bronze stand + bowl become the kit wall brazier (the legacy flame stays at its spot).
  // A7: none inside a gate structure or on a pillar (their legacy flames are hidden there)
  const WB = RA.wallBraziers;
  if (WB && pack.assets.has(WB.asset)) {
    const A = pack.assets.get(WB.asset)!;
    const stands = a.group.children.filter((o) => o.userData.wallBrazier);
    for (const st of stands) {
      const base = new THREE.Vector3(st.position.x, st.position.y - 0.45, st.position.z);
      if (blocked(base)) continue;
      const yaw = Math.atan2(-base.x, -base.z) + (hashInt(base.x, base.z) % 7) * 0.3;
      placed.push({ asset: A, m: new THREE.Matrix4().compose(base, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1)) });
    }
    toRemove.push(...stands, ...a.group.children.filter((o) => o.userData.wallBrazierBowl));
    for (const fl of a.group.children) if (fl.userData.wallFlame && blocked(fl.position)) fl.visible = false;
  }
  // A4: wall banners (legacy: canvas-textured planes with a CPU flutter and a Math.random phase) -> kit banners on rods
  const WBn = RA.wallBanners;
  const legacyBanners = a.group.children.filter((o) => o.userData.ring === 'banner');
  if (WBn && banners && legacyBanners.length) {
    legacyBanners.forEach((b, i) => {
      if (blocked(b.position)) return;
      b.updateMatrix();
      const top = b.position.clone();
      const m = new THREE.Matrix4().compose(top, b.quaternion, new THREE.Vector3(1, 1, 1));
      bannerList.push({ shape: 'vertical', cell: hashInt(L.seed, i, 3) % banners.cells, w: WBn.w, h: WBn.h, m, phase: (hashInt(L.seed, i, 5) % 628) / 100 });
      if (WBn.rod) rodList.push({ m, w: WBn.w });
      if (WBn.chains && chains) {
        // two short chains from the rod ends up to the wall coping
        for (const sx of [-1, 1]) {
          const end = new THREE.Vector3(sx * (WBn.w / 2 + 0.02), 0.03, 0).applyMatrix4(m);
          chains.hang(end, new THREE.Vector3(end.x, Math.max(end.y + 0.25, a.layout.wallH + 0.05), end.z), 0, 'small', 0);
        }
      }
    });
    toRemove.push(...legacyBanners);
  }
  // A4: wall-foot decor (candles, skulls, bone piles), merged with the rubble; candle wicks -> one glow-card mesh
  const DC = RA.decor;
  const wicks: { p: THREE.Vector3; size: number }[] = [];
  if (DC) {
    const ok = DC.assets.filter((id) => pack.assets.has(id));
    if (ok.length)
      alongEllipse(
        L,
        DC.offset,
        DC.spacing,
        (p, yaw, _a, i) => {
          if (rnd.next() < (DC.skip ?? 0.3)) return;
          const A = pack.assets.get(ok[hashInt(L.seed, i, 11) % ok.length])!;
          const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + rnd.range(-0.8, 0.8));
          if (blocked(p)) return;
          const m = new THREE.Matrix4().compose(new THREE.Vector3(p.x, 0, p.z), q, new THREE.Vector3(1, 1, 1));
          placed.push({ asset: A, m });
          for (const s of A.sockets) if (s.name.startsWith('SOCK_candle')) wicks.push({ p: new THREE.Vector3(...s.pos).applyMatrix4(m), size: Number(s.extras.size) || 0.08 });
        },
        4.0,
        0.62,
      );
  }
  guardians(a, pack, placed);
  // A7: the Moon Gate near field (ruined tiers, pillars, banners, chains, gates, watchers, tier fires)
  if (RA.ruins) {
    const nf = buildNearField(a, pack, RA.ruins, banners, chains, trim);
    placed.push(...nf.placed);
    trimGeos.push(...nf.trim);
    bannerList.push(...nf.banners);
    rodList.push(...nf.rods);
    toRemove.push(...nf.remove);
  }
  if (!placed.length && !trimGeos.length) {
    chains?.dispose();
    return;
  }
  removeLegacy(a, D, toRemove);
  // banners (wall + pillar + swags): ONE merged swaying mesh; rods merged; chains instanced
  if (banners && bannerList.length) {
    // A8b: shredded swags (their own material) go in a second merged mesh
    const torn = bannerList.filter((b) => b.shred);
    const mesh = banners.merged(torn.length ? bannerList.filter((b) => !b.shred) : bannerList);
    if (mesh) a.group.add(mesh);
    const sm = torn.length ? banners.shredMaterial(torn[0].shred!) : null;
    const tm = sm ? banners.merged(torn, sm) : null;
    if (tm) a.group.add(tm);
  }
  const rod = rodList.length && banners ? banners.rod() : null;
  if (rod) {
    const rods: THREE.BufferGeometry[] = [];
    for (const r of rodList) {
      const g = rod.geo.clone();
      g.applyMatrix4(new THREE.Matrix4().makeScale(r.w / 1.0 + 0.1, 1, 1));
      g.applyMatrix4(r.m);
      rods.push(g);
    }
    const mg = mergeGeometries(rods, false);
    for (const g of rods) g.dispose();
    if (mg) {
      const rm = new THREE.Mesh(mg, rod.mat);
      rm.castShadow = rm.receiveShadow = true;
      rm.name = 'kitBannerRods';
      rm.userData.sharedMat = true;
      rm.userData.dyn = true;
      a.group.add(rm);
    }
  }
  if (chains) for (const im of chains.build('kitRingChains')) a.group.add(im);
  const glow = candleCards(wicks, a.theme.fire);
  if (glow) a.group.add(glow);
  // merge per material: trim modules -> one mesh with the trim material; textured decor -> one mesh per asset material
  const buckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[]; shadow: boolean }>();
  const iron = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.035, 0.032, 0.03), metalness: 0.85, roughness: 0.55, vertexColors: true });
  if (trimGeos.length) buckets.set('trim', { mat: trim, geos: [...trimGeos], shadow: true });
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
      g.applyMatrix4(m.matrixWorld);
      // A7: 9-slice stretch in the asset frame (the tall ring pillars): above y1 moves up by d, the band stretches
      if (pl.stretch) {
        const { y0, y1, d } = pl.stretch;
        const k = (y1 - y0 + d) / (y1 - y0);
        const p = g.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < p.count; i++) {
          const y = p.getY(i);
          if (y > y1) p.setY(i, y + d);
          else if (y > y0) p.setY(i, y0 + (y - y0) * k);
        }
      }
      g.applyMatrix4(pl.m);
      b.geos.push(g);
    });
  }
  for (const [key, b] of buckets) {
    // non-indexed and indexed pieces cannot merge together: index the odd ones out
    const anyIdx = b.geos.some((g) => !!g.index);
    if (anyIdx)
      for (let i = 0; i < b.geos.length; i++)
        if (!b.geos[i].index) {
          const n = b.geos[i].attributes.position.count;
          b.geos[i].setIndex(Array.from({ length: n }, (_, j) => j));
        }
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