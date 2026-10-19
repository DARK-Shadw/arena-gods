/**
 * A7 THE MOON GATE NEAR FIELD (arena art plan A7, ref-3): what stands around the fight floor of the kit colosseum.
 *
 *   ruined tiers   the legacy stands, crowd, velarium and gallery go; ruined stone tiers rise behind the podium wall in
 *                  `rings` steps (procedural blocks on the stone trim sheet, trimGeo.ts: one draw call with the ring), broken
 *                  by the render seed, much lower towards the hero gate so the Moon Gate vista (A6 backdrop) shows; arcade
 *                  bays on the top tier away from the vista; sparse hooded watchers and small fires on the tiers
 *   pillars        tall square kit pillars (uniformly scaled + 9-slice stretched to `height`) outside the boundary, long
 *                  tattered banners on their arena faces, heavy chains swagging between their tops with swag cloths
 *   east gate      ref-3's stair: two flights rising away from the arena either side of a central portal (the gate passage
 *                  runs under the landing, so every entrance still walks in at floor level through the portcullis), a dais
 *                  carrying the doorway arch with a dark doorway, hooded guardians on plinths beside the flights, big
 *                  pedestal braziers at the stair foot
 *   west gate      the kit arch frames the legacy portcullis / tunnel; tripod braziers beside it
 *   anchors        perches / stands of both gates re-declared on the new geometry (snapAnchors still verifies them)
 *   fire cage      the chandelier hazard as an iron fire cage (hung at CHANDELIER_H)
 * Everything here is render-only and deterministic (render seed); nothing reads or writes sim state.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Arena, V3 } from './arenaView';
import type { ArenaPack, KitAsset } from './assets';
import type { GateArt, RuinsArt } from './art';
import type { BannerKit, BannerShape } from './cloth';
import type { ChainKit } from './chains';
import { alongEllipse, ellipseAt } from './common';
import { R } from './noise';
import { TrimBuilder } from './trimGeo';
import { glowMat } from './materials';

/** one kit module placement: asset + world matrix (+ an optional 9-slice stretch in the asset frame before the matrix) */
export interface Placed {
  asset: KitAsset;
  m: THREE.Matrix4;
  stretch?: { y0: number; y1: number; d: number };
}

export interface BannerSpec {
  shape: BannerShape;
  cell: number;
  w: number;
  h: number;
  m: THREE.Matrix4;
  phase: number;
}

/** what the near field adds to the ring build (dressKit.buildRing merges it with the A3 / A4 ring) */
export interface NearFieldOut {
  placed: Placed[];
  trim: THREE.BufferGeometry[];
  banners: BannerSpec[];
  /** banner rods: matrix + cloth width */
  rods: { m: THREE.Matrix4; w: number }[];
  remove: THREE.Object3D[];
}

const D2R = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

function hash(...n: number[]): number {
  let h = 2166136261;
  for (const x of n) {
    h ^= Math.floor(x * 1000) | 0;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ------------------------------------------------------------------ gate frames and zones

/**
 * a gate's frame (i 0 = west, 1 = east): origin on the boundary, f = inward, l = lateral (the gate group's local x, so the
 * basis l / up / f is right-handed: geometry built in it keeps its winding)
 */
export function gateFrame(L: { rx: number }, i: number) {
  const sx = i === 0 ? -1 : 1;
  const o = new THREE.Vector3(sx * L.rx, 0, 0);
  const f = new THREE.Vector3(-sx, 0, 0);
  const l = new THREE.Vector3().crossVectors(UP, f);
  const m = new THREE.Matrix4().makeBasis(l, UP, f).setPosition(o);
  return { o, f, l, m };
}

/** lateral / inward coordinates of a world point in gate i's frame */
function toFrame(L: { rx: number }, i: number, p: THREE.Vector3): [number, number] {
  const G = gateFrame(L, i);
  const d = p.clone().sub(G.o);
  return [d.dot(G.l), d.dot(G.f)];
}

/** azimuth of a world point, degrees, 0 = east gate (+x), +-180 = west */
const azOf = (p: THREE.Vector3) => Math.atan2(p.z, p.x) / D2R;

/** pillar spots (world, on the ground) for a ruins art */
export function pillarSpots(L: Arena['layout'], N: RuinsArt | undefined): { p: THREE.Vector3; az: number }[] {
  const P = N?.pillars;
  if (!P) return [];
  const out: { p: THREE.Vector3; az: number }[] = [];
  for (const a of P.az)
    for (const s of a === 0 || a === 180 ? [1] : [-1, 1]) {
      const az = s * a;
      out.push({ p: ellipseAt(L, az * D2R, P.offset), az });
    }
  return out;
}

/** is a world point inside a kit gate's zone (frame |lateral| < half, z < zMax)? */
function inZone(L: Arena['layout'], G: GateArt | undefined, i: number, p: THREE.Vector3, half?: number, zMax = 2.5): boolean {
  if (!G) return false;
  const [x, z] = toFrame(L, i, p);
  return Math.abs(x) < (half ?? G.zoneHalf) && z < zMax;
}

/**
 * A7: a predicate for ring dressing that must stay clear of the kit gate structures and the pillars (ring braziers, wall
 * decor, wall banners, rubble). Always false without ruins art (legacy / other themes).
 */
export function gateZoneTest(a: Arena, pack: ArenaPack | null, withPillars = true): (p: THREE.Vector3) => boolean {
  const N = pack?.art.ring?.ruins;
  if (!N) return () => false;
  const L = a.layout;
  const pillars = withPillars ? pillarSpots(L, N) : [];
  const clear = 0.75 * (N.pillars?.scale ?? 1) + 1.0;
  return (p) => inZone(L, N.east, 1, p) || inZone(L, N.west, 0, p) || pillars.some((q) => Math.hypot(q.p.x - p.x, q.p.z - p.z) < clear);
}

// ------------------------------------------------------------------ builder

export function buildNearField(a: Arena, pack: ArenaPack, N: RuinsArt, banners: BannerKit | null, chains: ChainKit | null, trimMat: THREE.MeshStandardMaterial): NearFieldOut {
  const L = a.layout;
  const out: NearFieldOut = { placed: [], trim: [], banners: [], rods: [], remove: [] };
  const rnd = new R(L.seed * 104729 + 977);
  const get = (id?: string) => (id ? (pack.assets.get(id) ?? null) : null);

  // ---- legacy parts the near field replaces
  for (const o of a.group.children) {
    const r = o.userData.ring;
    if (r === 'stands' || r === 'velarium' || r === 'gallery' || r === 'galleryCap' || o.userData.crowd) out.remove.push(o);
  }

  const T = N.tiers;
  const wallBack = 1.8; // the podium wall modules span 0.9-1.8 m outside the boundary (A3)
  const tierTop = (k: number) => T.base + (k + 1) * T.rise;
  // tiers skip the hero gate's zone; at the west only the first ring behind the arch goes (the others bridge the tunnel)
  const zoneTier = (p: THREE.Vector3) => {
    if (inZone(L, N.east, 1, p)) return true;
    if (!N.west) return false;
    const [x, z] = toFrame(L, 0, p);
    return Math.abs(x) < 3.6 && z > -2.7 && z < 2.5;
  };
  // the west tunnel passes under the tiers: segments over it start at the tunnel roof
  const overWestTunnel = (p: THREE.Vector3) => {
    const [x, z] = toFrame(L, 0, p);
    return !!N.west && Math.abs(x) < 3.3 && z < 0;
  };

  // ---- arcade bays on the top tier (decided first: the tier segments under a bay stay intact)
  const topK = T.rings - 1;
  const topMid = wallBack + topK * T.depth + T.depth / 2;
  const bays: { p: THREE.Vector3; yaw: number }[] = [];
  const AR = N.arcade;
  const arcAssets = (AR?.assets ?? []).map(get).filter((x): x is KitAsset => !!x);
  if (AR && arcAssets.length) {
    let run = 0;
    alongEllipse(
      L,
      topMid,
      3.45,
      (p, yaw, _a, i) => {
        const az = Math.abs(azOf(p));
        if (az < AR.minAz || zoneTier(p) || overWestTunnel(p)) return void (run = 0);
        // runs of 1-4 bays with gaps: a broken skyline
        const keep = run > 0 ? rnd.next() < 0.72 : rnd.next() < AR.share;
        run = keep ? run + 1 : 0;
        if (!keep) return;
        bays.push({ p, yaw });
        const A = arcAssets[hash(L.seed, i, 41) % arcAssets.length];
        out.placed.push({ asset: A, m: new THREE.Matrix4().compose(new THREE.Vector3(p.x, tierTop(topK) - 0.05, p.z), new THREE.Quaternion().setFromAxisAngle(UP, yaw), new THREE.Vector3(1, 1, 1)) });
      },
      0,
      0.5,
    );
  }

  // ---- ruined tiers
  const tb = new TrimBuilder();
  const segs: { p: THREE.Vector3; yaw: number; top: number; k: number; w: number; intact: boolean }[] = [];
  const nearGate = (p: THREE.Vector3) => Math.abs(p.z) < 9 && Math.abs(p.x) > L.rx * 0.5;
  for (let k = 0; k < T.rings; k++) {
    const mid = wallBack + k * T.depth + T.depth / 2;
    alongEllipse(
      L,
      mid,
      T.seg,
      (p, yaw, _a, i) => {
        if (zoneTier(p)) return;
        const az = Math.abs(azOf(p));
        const east = az < 55;
        let top = tierTop(k);
        let y0 = 0;
        if (overWestTunnel(p)) y0 = 3.9;
        const underBay = k >= topK - 1 && bays.some((b) => Math.hypot(b.p.x - p.x, b.p.z - p.z) < 3.0);
        // the vista sector (ref-3: only low broken walls between the pillars and the stair): the first tier at most, broken
        if (east && k >= 1) {
          if (rnd.next() < 0.8) return;
          top = tierTop(0) - rnd.range(0, 1.2);
        }
        let intact = true;
        const pBreak = east ? T.eastBroken : T.broken;
        if (!underBay && !nearGate(p) && rnd.next() < pBreak) {
          intact = false;
          const drop = rnd.range(0.5, Math.max(0.8, (k + 1) * T.rise + 1.2));
          top = Math.max(y0 + 0.5, Math.max(0.7, top - drop));
          if (rnd.next() < 0.18) top = Math.max(y0 + 0.4, rnd.range(0.4, 1.1)); // collapsed to a stump
        }
        const w = T.seg + 0.08;
        const m = new THREE.Matrix4().compose(new THREE.Vector3(p.x, 0, p.z), new THREE.Quaternion().setFromAxisAngle(UP, yaw), new THREE.Vector3(1, 1, 1));
        tb.setMatrix(m);
        const tint = 0.78 + rnd.next() * 0.3;
        const u0 = (hash(L.seed, k, i) % 997) * 0.37;
        const d2 = T.depth / 2;
        if (!intact && rnd.next() < 0.55) {
          // a stepped break: two blocks of different height
          const cut = rnd.range(-0.6, 0.6);
          const top2 = Math.min(tierTop(k), top + rnd.range(0.4, 1.6));
          tb.box([-w / 2, y0, -d2], [cut, top, d2], { side: 'blocks', top: 'rough', tint, u0, noBack: k < topK });
          tb.box([cut, y0, -d2], [w / 2, top2, d2], { side: 'blocks', top: 'rough', tint: tint * 0.95, u0: u0 + 3.1, noBack: k < topK });
        } else {
          // intact seats: a slight per-segment height / setback jitter and a projecting lip (a lit edge per tier)
          const jit = intact ? rnd.range(-0.12, 0.08) : 0;
          const back = intact ? rnd.range(0, 0.22) : 0;
          top += jit;
          tb.box([-w / 2, y0, -d2], [w / 2, top, d2 - back], { side: 'blocks', top: intact ? 'plain' : 'rough', tint: tint * 0.82, topTint: tint * 1.1, u0, noBack: k < topK });
          if (intact) tb.box([-w / 2 + 0.03, top - 0.16, d2 - back - 0.35], [w / 2 - 0.03, top + 0.04, d2 - back + 0.16], { side: 'plain', top: 'plain', tint: tint * 1.05, topTint: tint * 1.2, u0: u0 + 1.3, noBack: true });
        }
        // fallen blocks at a break: on the tier below / at the foot
        if (!intact) {
          const nb = 1 + ((rnd.next() * 3) | 0);
          for (let b = 0; b < nb; b++) {
            const s = rnd.range(0.35, 0.8);
            const bx = rnd.range(-w / 2, w / 2),
              bz = rnd.range(-d2 * 0.6, d2 * 0.6);
            // lying on the broken stump itself (always supported, whatever is left of the tiers below)
            const by = top;
            const bm = m.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(bx, by, bz), new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd.range(-0.3, 0.3), rnd.range(0, 3), rnd.range(-0.3, 0.3))), new THREE.Vector3(1, 1, 1)));
            tb.setMatrix(bm);
            tb.box([-s, -0.1, -s * 0.6], [s, s * 0.9, s * 0.6], { side: 'rough', top: 'rough', tint: tint * 0.9, u0: u0 + b });
          }
        }
        segs.push({ p, yaw, top, k, w, intact });
      },
      0,
      (k * 0.37) % 1,
    );
  }

  // ---- pillars with banners and chains
  const P = N.pillars;
  const pillarA = get(P?.asset);
  if (P && pillarA) {
    const H = Number(pillarA.extras.height) || 5;
    const s = P.scale;
    const sh = pillarA.shaft;
    const spots = pillarSpots(L, N).sort((x, y) => x.az - y.az);
    const tops: { q: THREE.Vector3; az: number }[] = [];
    spots.forEach(({ p, az }, idx) => {
      const yaw = Math.atan2(-p.x, -p.z) + ((hash(L.seed, idx, 5) % 4) * Math.PI) / 2;
      const face = Math.atan2(-p.x, -p.z);
      const n = new THREE.Vector3(-p.x, 0, -p.z).normalize();
      out.placed.push({
        asset: pillarA,
        m: new THREE.Matrix4().compose(new THREE.Vector3(p.x, 0, p.z), new THREE.Quaternion().setFromAxisAngle(UP, yaw), new THREE.Vector3(s, s, s)),
        stretch: sh ? { y0: sh[0], y1: sh[1], d: P.height / s - H } : undefined,
      });
      tops.push({ q: p.clone().addScaledVector(n, 0.5 * s).setY(P.height - 0.35 * s), az });
      // the long banner on the arena face (not on every pillar: a third of them go bare)
      if (P.banner && banners && hash(L.seed, idx, 9) % 3 !== 1) {
        const pin = p.clone().addScaledVector(n, 0.62 * s + 0.1).setY(P.banner.pin);
        const m = new THREE.Matrix4().compose(pin, new THREE.Quaternion().setFromAxisAngle(UP, face), new THREE.Vector3(1, 1, 1));
        out.banners.push({ shape: 'vertical', cell: hash(L.seed, idx, 13) % banners.cells, w: P.banner.w, h: P.banner.h, m, phase: (hash(L.seed, idx, 17) % 628) / 100 });
        out.rods.push({ m, w: P.banner.w });
        if (chains)
          for (const sx of [-1, 1]) {
            const end = new THREE.Vector3(sx * (P.banner.w / 2 + 0.02), 0.03, 0).applyMatrix4(m);
            const up = end.clone().addScaledVector(n, -0.15).setY(end.y + 1.0);
            chains.hang(end, up, 0.02, 'big', 0, 1.6);
          }
      }
    });
    // heavy chains between neighbouring pillar tops on each side (not across the gates), swag cloths under them
    if (P.chains && chains) {
      for (let i = 0; i + 1 < tops.length; i++) {
        const A = tops[i],
          B = tops[i + 1];
        if (Math.sign(A.az) !== Math.sign(B.az) || Math.abs(B.az - A.az) > 40) continue;
        const span = A.q.distanceTo(B.q);
        const sag = P.chains.sag * (span / 9);
        chains.hang(A.q, B.q, sag, 'big', 0.12, P.chains.scale);
        if (P.chains.swags && banners)
          for (const t of [0.32, 0.68]) {
            const c = new THREE.Vector3().lerpVectors(A.q, B.q, t);
            c.y -= sag * 4 * t * (1 - t) + 0.05;
            const d = new THREE.Vector3().subVectors(B.q, A.q);
            let yaw = Math.atan2(-d.z, d.x);
            const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
            if (fwd.dot(new THREE.Vector3(-c.x, 0, -c.z)) < 0) yaw += Math.PI;
            const m = new THREE.Matrix4().compose(c, new THREE.Quaternion().setFromAxisAngle(UP, yaw), new THREE.Vector3(1, 1, 1));
            out.banners.push({ shape: 'swag', cell: hash(L.seed, i, t * 10) % 2, w: span * 0.3, h: 1.5, m, phase: (hash(L.seed, i, 23, t * 10) % 628) / 100 });
          }
      }
    }
  }

  // ---- gates
  if (N.east?.stair) eastGate(a, pack, N.east, tb, out, rnd);
  if (N.west) westGate(a, pack, N.west, tb, out);

  // ---- tier fires (small wall braziers on intact tier tops, not in the vista sector)
  const F = N.fires;
  const fireA = get(F?.asset);
  if (F && fireA) {
    const cand = segs.filter((s) => s.intact && Math.abs(azOf(s.p)) > 50 && !bays.some((b) => b.p.distanceTo(s.p) < 2.5));
    const sock = fireA.socket('SOCK_flame');
    for (let n = 0; n < F.count && cand.length; n++) {
      const s = cand.splice(hash(L.seed, n, 61) % cand.length, 1)[0];
      const base = s.p.clone().setY(s.top);
      const m = new THREE.Matrix4().compose(base, new THREE.Quaternion().setFromAxisAngle(UP, s.yaw), new THREE.Vector3(1, 1, 1));
      out.placed.push({ asset: fireA, m });
      const fp = new THREE.Vector3(...(sock?.pos ?? [0, 0.5, 0])).applyMatrix4(m);
      a.group.add(a.flame(fp, F.size, a.theme.fire, false));
    }
    // A8: fires on the broken low tiers of the vista sector (on the stump tops, any segment)
    const vc = segs.filter((s) => Math.abs(azOf(s.p)) <= 50 && Math.abs(azOf(s.p)) > 14);
    for (let n = 0; n < (F.vista ?? 0) && vc.length; n++) {
      const s = vc.splice(hash(L.seed, n, 63) % vc.length, 1)[0];
      const m = new THREE.Matrix4().compose(s.p.clone().setY(s.top), new THREE.Quaternion().setFromAxisAngle(UP, s.yaw), new THREE.Vector3(1, 1, 1));
      out.placed.push({ asset: fireA, m });
      const fp = new THREE.Vector3(...(sock?.pos ?? [0, 0.5, 0])).applyMatrix4(m);
      a.group.add(a.flame(fp, F.size * 0.9, a.theme.fire, false));
    }
    // A8: burning debris on the floor at the boundary foot (outside the fight ellipse, off the gate axes)
    const GA = F.ground ? get(F.ground.asset) : undefined;
    if (F.ground && GA) {
      for (let n = 0; n < F.ground.count; n++) {
        const t = ((hash(L.seed, n, 67) % 1000) / 1000) * Math.PI * 2;
        const p = new THREE.Vector3(Math.cos(t) * (L.rx + 0.3), 0, Math.sin(t) * (L.rz + 0.3));
        if (Math.abs(p.z) < 4.5 && Math.abs(p.x) > L.rx * 0.6) continue;
        const sc = 0.7 + (hash(L.seed, n, 69) % 100) / 200;
        out.placed.push({ asset: GA, m: new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromAxisAngle(UP, t * 3.1), new THREE.Vector3(sc, sc, sc)) });
        a.group.add(a.flame(p.clone().setY(0.28 * sc), F.ground.size * (0.8 + (hash(L.seed, n, 71) % 40) / 100), a.theme.fire, false));
      }
    }
  }

  // ---- A8: rubble on the floor (render only: no collision, small enough to read as debris under the fighters' feet)
  const FR = N.floorRubble;
  const rubA = FR ? get(FR.asset) : undefined;
  if (FR && rubA) {
    const q = Math.max(0, Math.min(2, a.quality));
    const blockers = [...L.obstacles.map((o) => ({ x: o.x, z: o.z, r: o.r + 0.6 })), ...L.props.map((o) => ({ x: o.x, z: o.z, r: o.r + 0.5 })), ...L.hazards.map((o) => ({ x: o.x, z: o.z, r: o.r + 0.8 }))];
    const free = (x: number, z: number) => !blockers.some((b) => Math.hypot(b.x - x, b.z - z) < b.r) && !(Math.abs(z) < 3.2 && Math.abs(x) > L.rx * 0.55);
    const put = (n: number, r0: number, r1: number, s0: number, s1: number, salt: number) => {
      for (let k = 0, tries = 0; k < n && tries < n * 6; tries++) {
        const t = rnd.next() * Math.PI * 2,
          rr = Math.sqrt(r0 * r0 + rnd.next() * (r1 * r1 - r0 * r0));
        const x = Math.cos(t) * L.rx * rr,
          z = Math.sin(t) * L.rz * rr;
        if (!free(x, z)) continue;
        k++;
        const sc = rnd.range(s0, s1);
        out.placed.push({ asset: rubA, m: new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(UP, rnd.next() * 6.28 + salt), new THREE.Vector3(sc, sc * rnd.range(0.7, 1.3), sc)) });
      }
    };
    put(FR.band[q], 0.86, 1.04, 0.6, 1.25, 0);
    put(FR.inner[q], 0.2, 0.86, 0.22, 0.42, 1);
  }

  // ---- hooded watchers on the tiers
  const W = N.watchers;
  if (W) {
    const n = W.count[Math.max(0, Math.min(2, a.quality))];
    const cand = segs.filter((s) => s.intact && !bays.some((b) => b.p.distanceTo(s.p) < 2.2));
    const geos: THREE.BufferGeometry[] = [];
    const proto = watcherGeo();
    for (let k = 0; k < n && cand.length; k++) {
      const s = cand.splice(hash(L.seed, k, 71) % cand.length, 1)[0];
      const lat = rnd.range(-0.35, 0.35) * s.w;
      const right = new THREE.Vector3(Math.cos(s.yaw), 0, -Math.sin(s.yaw));
      const pos = s.p.clone().addScaledVector(right, lat).setY(s.top);
      const sc = rnd.range(0.92, 1.12);
      const g = proto.clone();
      g.applyMatrix4(new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromAxisAngle(UP, s.yaw + rnd.range(-0.35, 0.35)), new THREE.Vector3(sc, sc, sc)));
      geos.push(g);
    }
    proto.dispose();
    if (geos.length) {
      const mg = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (mg) {
        const mesh = new THREE.Mesh(mg, new THREE.MeshStandardMaterial({ color: W.color, roughness: 0.93, metalness: 0 }));
        mesh.name = 'kitWatchers';
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        a.group.add(mesh);
      }
    }
  }

  const g = tb.build();
  if (g) out.trim.push(g);
  void trimMat;
  return out;
}

// ------------------------------------------------------------------ the hero gate (east): stair + portal + dais + doorway

function eastGate(a: Arena, pack: ArenaPack, G: GateArt, tb: TrimBuilder, out: NearFieldOut, rnd: R) {
  const S = G.stair!;
  const L = a.layout;
  const gate = a.gates[1];
  if (!gate) return;
  const F = gateFrame(L, 1);
  tb.setMatrix(F.m);
  const H = S.steps * S.rise;
  const zTop = S.z0 - S.steps * S.run;
  const zBack = zTop - S.daisDepth;
  const ph = S.portalHalf,
    pw = 1.55,
    ceil = 3.75;
  // forecourt ground (under the wet floor; it carries the stair foot, the braziers and the passage)
  tb.aoMin = 1;
  tb.ground(-S.daisHalf - 6, S.daisHalf + 6, zBack - 2, 3.0, -0.04, 'plain', 0.62);
  tb.ground(-pw, pw, zBack, 0.4, -0.02, 'plain', 0.35);
  tb.aoMin = 0.5;
  // flights (full-height step blocks: the outer cheek reads as solid masonry)
  for (const sx of [-1, 1])
    for (let i = 0; i < S.steps; i++) {
      const x0 = sx < 0 ? -S.flightOuter : ph,
        x1 = sx < 0 ? -ph : S.flightOuter;
      tb.box([x0, 0, S.z0 - (i + 1) * S.run], [x1, (i + 1) * S.rise, S.z0 - i * S.run], { side: 'plain', top: 'plain', tint: 0.5 + ((i * 7 + (sx > 0 ? 3 : 0)) % 5) * 0.03, topTint: 1.15, u0: i * 1.7, noBack: true });
    }
  // portal block: two piers, the roof (landing) with a rune frieze over the opening, a dark passage
  for (const sx of [-1, 1]) {
    const x0 = sx < 0 ? -ph : pw,
      x1 = sx < 0 ? -pw : ph;
    // (the pier's inner face is replaced by the dark passage wall below)
    tb.box([x0, 0, zBack], [x1, H, S.z0], { side: 'ashlar', top: 'plain', tint: 0.95, noBack: true, noSides: true });
  }
  {
    // inner passage faces, built directly: walls at x = +-pw facing the passage, ceiling, back wall
    const inner = new TrimBuilder();
    inner.aoMin = 0.35;
    inner.setMatrix(F.m);
    inner.quad(new THREE.Vector3(-pw, 0, S.z0), new THREE.Vector3(0, 0, -1), S.z0 - zBack, new THREE.Vector3(0, 1, 0), ceil, 'ashlar', 0, 0, 0.32);
    inner.quad(new THREE.Vector3(pw, 0, zBack), new THREE.Vector3(0, 0, 1), S.z0 - zBack, new THREE.Vector3(0, 1, 0), ceil, 'ashlar', 0, 0, 0.32);
    inner.quad(new THREE.Vector3(-pw, ceil, zBack), new THREE.Vector3(1, 0, 0), 2 * pw, new THREE.Vector3(0, 0, 1), S.z0 - zBack, 'plain', 0, 0, 0.2);
    inner.quad(new THREE.Vector3(-pw, 0, zBack), new THREE.Vector3(1, 0, 0), 2 * pw, new THREE.Vector3(0, 1, 0), ceil, 'plain', 0, 0, 0.06);
    const ig = inner.build();
    if (ig) out.trim.push(ig);
  }
  tb.box([-pw, ceil, zBack], [pw, H, S.z0], { side: 'frieze', top: 'plain', tint: 1.0, noBack: true, noSides: true });
  // dais behind the flights (split by the passage)
  for (const sx of [-1, 1]) {
    const x0 = sx < 0 ? -S.daisHalf : ph,
      x1 = sx < 0 ? -ph : S.daisHalf;
    tb.box([x0, 0, zBack], [x1, H, zTop], { side: 'ashlar', top: 'plain', tint: 0.9 });
  }
  // the doorway on the dais: kit arch + a near-black plate in its opening
  const arch = S.doorway ? pack.assets.get(S.doorway) : undefined;
  const ds = S.doorwayScale ?? 1;
  const zDoor = zTop - Math.min(2.6, S.daisDepth * 0.45);
  if (arch) {
    out.placed.push({ asset: arch, m: F.m.clone().multiply(new THREE.Matrix4().makeTranslation(0, H, zDoor)).multiply(new THREE.Matrix4().makeScale(ds, ds, ds)) });
    tb.box([-1.75 * ds, H, zDoor - 0.95 * ds - 0.2], [1.75 * ds, H + 5.2 * ds, zDoor - 0.75 * ds], { side: 'plain', top: 'plain', tint: 0.03, topTint: 0.03 });
  }
  // guardians on plinths beside the flights, facing the arena centre
  const GU = S.guardians;
  const statue = GU ? pack.assets.get(GU.statue) : undefined;
  const plinth = GU ? pack.assets.get(GU.plinth) : undefined;
  if (GU)
    for (const sx of [-1, 1]) {
      const wp = new THREE.Vector3(sx * GU.lateral, 0, GU.z).applyMatrix4(F.m);
      const yaw = Math.atan2(-wp.x, -wp.z);
      const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
      const ph2 = plinth ? (Number(plinth.extras.height) || 1.2) * GU.plinthScale : 0;
      if (plinth) out.placed.push({ asset: plinth, m: new THREE.Matrix4().compose(wp, q, new THREE.Vector3(GU.plinthScale, GU.plinthScale, GU.plinthScale)) });
      if (statue) out.placed.push({ asset: statue, m: new THREE.Matrix4().compose(wp.clone().setY(ph2), q, new THREE.Vector3(GU.scale, GU.scale, GU.scale)) });
    }
  // big pedestal braziers at the stair foot
  gateBraziers(a, pack, F.m, S.braziers, true);
  // anchors (GateFrame coordinates: lateral mirrored vs the gate group, every pair is symmetric)
  const A = gate.anchors as typeof gate.anchors & { snapped?: boolean };
  const stepTop = (z: number) => Math.min(S.steps, Math.floor((S.z0 - z) / S.run) + 1) * S.rise;
  const standZ = S.z0 - 5.5 * S.run;
  A.perches = [-1, 1].map((s) => ({ id: s < 0 ? 'portal_l' : 'portal_r', pos: [s * 1.1, H, S.z0 - 0.55] as V3, depth: 1.6 }));
  A.stands = [-1, 1].map((s) => [s * ((ph + S.flightOuter) / 2), stepTop(standZ), standZ] as V3);
  A.tunnel = { depth: S.z0 - zBack, height: ceil, floorY: 0 };
  A.snapped = false;
  void rnd;
  // the legacy gate dressing and tunnel box go (portcullis, light and anchors stay)
  legacyGateParts(gate.group, out, true);
  if (G.portcullis) {
    const iron = new THREE.MeshStandardMaterial({ color: G.portcullis.color, roughness: G.portcullis.roughness, metalness: G.portcullis.metalness });
    iron.name = 'kit.portcullisIron';
    gate.portcullis.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = iron;
    });
  }
}

// ------------------------------------------------------------------ the west gate: kit arch around the legacy portcullis / tunnel

function westGate(a: Arena, pack: ArenaPack, G: GateArt, tb: TrimBuilder, out: NearFieldOut) {
  const gate = a.gates[0];
  if (!gate) return;
  const L = a.layout;
  const F = gateFrame(L, 0);
  // forecourt ground under the arch and the braziers
  tb.setMatrix(F.m);
  tb.aoMin = 1;
  tb.ground(-7, 7, -3.5, 2.5, -0.04, 'plain', 0.62);
  tb.aoMin = 0.5;
  const arch = G.arch ? pack.assets.get(G.arch) : undefined;
  // the legacy facade sat 0.85 m behind the gate group origin (0.9 m outside the boundary): front face at frame z -0.9
  const depth = arch ? Number((arch.extras.depth as number) ?? 1.6) || 1.6 : 1.6;
  if (arch) out.placed.push({ asset: arch, m: F.m.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -0.9 - depth / 2)) });
  gateBraziers(a, pack, F.m, G.braziers, false);
  const A = gate.anchors as typeof gate.anchors & { snapped?: boolean };
  const top = arch ? Number(arch.extras.height) || 7.49 : 0;
  const wallTop = 3.44;
  A.perches = [
    ...(arch ? [-1, 1].map((s) => ({ id: s < 0 ? 'arch_l' : 'arch_r', pos: [s * 1.2, top, -0.9 - depth / 2] as V3, depth })) : []),
    ...[-1, 1].map((s) => ({ id: s < 0 ? 'wall_l' : 'wall_r', pos: [s * 5.4, wallTop, -1.35] as V3, depth: 0.5 })),
  ];
  A.stands = [-1, 1].map((s) => [s * 6.2, 3.45 + 0.85, -2.6] as V3);
  A.snapped = false;
  legacyGateParts(gate.group, out, false);
}

function gateBraziers(a: Arena, pack: ArenaPack, frame: THREE.Matrix4, B: GateArt['braziers'], light: boolean) {
  if (!B) return;
  const A = pack.assets.get(B.asset);
  if (!A) return;
  const sock = A.socket('SOCK_flame');
  for (const sx of [-1, 1]) {
    const wp = new THREE.Vector3(sx * B.lateral, 0, B.z).applyMatrix4(frame);
    const inst = A.instantiate();
    const g = new THREE.Group();
    g.position.copy(wp);
    g.rotation.y = Math.atan2(-wp.x, -wp.z);
    inst.obj.scale.setScalar(B.scale);
    g.add(inst.obj);
    g.add(a.flame(new THREE.Vector3(0, (sock?.pos[1] ?? 1.2) * B.scale, 0), B.flame, a.theme.fire, light && sx > 0));
    g.userData.gateBrazier = true;
    a.group.add(g);
  }
}

/** the legacy gate's decorative parts go; its flames are hidden (they stay in the arena's flame list, invisible) */
function legacyGateParts(g: THREE.Object3D, out: NearFieldOut, tunnel: boolean) {
  for (const c of [...g.children]) {
    if (c.userData.gateDeco || (tunnel && c.userData.gateTunnel)) {
      g.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    } else if (c.userData.gateFlame) c.visible = false;
  }
  void out;
}

// ------------------------------------------------------------------ props

/** a hooded robed watcher (about 1.85 m), front = +z: lathe robe + hood + a dark face recess, about 150 triangles */
function watcherGeo(): THREE.BufferGeometry {
  const prof = [
    [0.0, 0.0],
    [0.33, 0.0],
    [0.31, 0.35],
    [0.27, 0.85],
    [0.24, 1.25],
    [0.28, 1.4],
    [0.22, 1.5],
    [0.19, 1.62],
    [0.17, 1.74],
    [0.09, 1.84],
    [0.0, 1.88],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const body = new THREE.LatheGeometry(prof, 8);
  body.scale(1, 1, 0.78);
  // the hood pulled forward
  const p = body.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y > 1.45) p.setZ(i, p.getZ(i) + (y - 1.45) * 0.25);
  }
  body.computeVertexNormals();
  const g = body.toNonIndexed();
  body.dispose();
  g.deleteAttribute('uv');
  return g;
}

/**
 * A7: the fire cage (the chandelier hazard in kit mode): a hanging iron cage of hoops and curved bars with a coal bowl and
 * flames inside, hung from three chains converging above. Origin = the hang point (CHANDELIER_H), the cage below it.
 */
export function fireCage(a: Arena): THREE.Object3D {
  const g = new THREE.Group();
  const parts: THREE.BufferGeometry[] = [];
  const hoop = (r: number, y: number, t = 0.045) => {
    const h = new THREE.TorusGeometry(r, t, 5, 28);
    h.rotateX(Math.PI / 2);
    h.translate(0, y, 0);
    parts.push(h);
  };
  hoop(0.55, -0.05, 0.05);
  hoop(0.95, -0.55);
  hoop(0.85, -1.05);
  hoop(0.35, -1.45, 0.05);
  for (let i = 0; i < 10; i++) {
    const an = (i / 10) * Math.PI * 2;
    const pts = [
      [0.55, -0.05],
      [0.95, -0.55],
      [0.85, -1.05],
      [0.35, -1.45],
      [0.08, -1.75],
    ].map(([r, y]) => new THREE.Vector3(Math.cos(an) * r, y, Math.sin(an) * r));
    parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 8, 0.035, 4, false));
    // a spike at the bottom of every other bar
    if (i % 2 === 0) {
      const sp = new THREE.ConeGeometry(0.05, 0.3, 4);
      sp.rotateX(Math.PI);
      sp.translate(Math.cos(an) * 0.85, -1.22, Math.sin(an) * 0.85);
      parts.push(sp);
    }
  }
  const tip = new THREE.ConeGeometry(0.1, 0.45, 5);
  tip.rotateX(Math.PI);
  tip.translate(0, -1.95, 0);
  parts.push(tip);
  // coal bowl
  const bowl = new THREE.CylinderGeometry(0.62, 0.38, 0.28, 12, 1, true);
  bowl.translate(0, -1.0, 0);
  parts.push(bowl);
  // hangers up to the chain
  for (let i = 0; i < 3; i++) {
    const an = (i / 3) * Math.PI * 2;
    const a0 = new THREE.Vector3(Math.cos(an) * 0.55, -0.05, Math.sin(an) * 0.55),
      a1 = new THREE.Vector3(0, 1.4, 0);
    parts.push(new THREE.TubeGeometry(new THREE.LineCurve3(a0, a1), 1, 0.022, 4, false));
  }
  const geo = mergeGeometries(
    parts.map((p) => {
      const q = p.index ? p.toNonIndexed() : p;
      q.deleteAttribute('uv');
      return q;
    }),
    false,
  );
  for (const p of parts) p.dispose();
  const iron = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.05, 0.045, 0.042), metalness: 0.55, roughness: 0.55 });
  const cage = new THREE.Mesh(geo ?? new THREE.BufferGeometry(), iron);
  cage.castShadow = true;
  cage.name = 'kitFireCage';
  g.add(cage);
  const coals = new THREE.Mesh(new THREE.CircleGeometry(0.58, 14), glowMat('#ff5a1a', 0.85));
  coals.rotation.x = -Math.PI / 2;
  coals.position.y = -0.92;
  coals.userData.dyn = true; // a glow card: never a camera / entrance solid
  g.add(coals);
  g.add(a.flame(new THREE.Vector3(0, -0.95, 0), 1.05, a.theme.fire, false));
  g.add(a.flame(new THREE.Vector3(0.25, -0.95, 0.1), 0.6, a.theme.fire, false));
  return g;
}
