/**
 * Procedural modular kit: parametric geometry for architecture, cover,
 * props and nature (lathe / extrude / noise displacement / merged primitives).
 * All builders return BufferGeometry in metres with the base at y = 0.
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm3, R } from './noise';

const V2 = (x: number, y: number) => new THREE.Vector2(x, y);

/** merge (dropping attributes that aren't shared by all) */
export function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const prepared = geos.map((g) => {
    let x = g.index ? g.toNonIndexed() : g;
    if (!x.attributes.uv) {
      x = x.clone();
      x.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(x.attributes.position.count * 2), 2));
    }
    for (const k of Object.keys(x.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv' && k !== 'color') x.deleteAttribute(k);
    return x;
  });
  const hasColor = prepared.every((g) => g.attributes.color);
  if (!hasColor) for (const g of prepared) if (g.attributes.color) g.deleteAttribute('color');
  return mergeGeometries(prepared, false)!;
}

export function place(g: THREE.BufferGeometry, x = 0, y = 0, z = 0, ry = 0, s: number | [number, number, number] = 1, rx = 0, rz = 0): THREE.BufferGeometry {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), Array.isArray(s) ? new THREE.Vector3(...s) : new THREE.Vector3(s, s, s));
  return g.applyMatrix4(m);
}

// ------------------------------------------------------------------ architecture
/** Classical column: plinth + torus base, fluted shaft with entasis, capital. */
export function columnGeo(r: number, h: number, opts: { flutes?: number; capital?: 'doric' | 'ionic' | 'simple'; plinth?: boolean } = {}): THREE.BufferGeometry {
  const fl = opts.flutes ?? 20;
  const pts: THREE.Vector2[] = [];
  const pl = opts.plinth !== false;
  const y0 = pl ? 0.28 : 0;
  // base mouldings
  pts.push(V2(0, y0), V2(r * 1.32, y0), V2(r * 1.32, y0 + 0.06), V2(r * 1.24, y0 + 0.1));
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * Math.PI;
    pts.push(V2(r * 1.12 + Math.sin(a) * 0.09, y0 + 0.1 + (1 - Math.cos(a)) * 0.09));
  }
  pts.push(V2(r * 1.04, y0 + 0.3));
  // shaft with entasis
  const s0 = y0 + 0.32,
    s1 = h - 0.62;
  for (let i = 0; i <= 12; i++) {
    const k = i / 12;
    const ent = 1 - 0.14 * k * k + 0.04 * Math.sin(k * Math.PI);
    pts.push(V2(r * ent, s0 + (s1 - s0) * k));
  }
  // capital
  const rt = r * 0.86;
  pts.push(V2(rt * 1.04, s1 + 0.04), V2(rt * 1.04, s1 + 0.1));
  if (opts.capital === 'simple') pts.push(V2(r * 1.15, h - 0.25), V2(r * 1.25, h - 0.2), V2(r * 1.25, h), V2(0, h));
  else {
    for (let i = 0; i <= 6; i++) {
      const a = (i / 6) * Math.PI * 0.5;
      pts.push(V2(rt + Math.sin(a) * r * 0.5, s1 + 0.12 + (1 - Math.cos(a)) * 0.28));
    }
    pts.push(V2(r * 1.42, h - 0.2), V2(r * 1.42, h), V2(0, h));
  }
  const g = new THREE.LatheGeometry(pts, Math.max(24, fl * 2));
  // flutes: carve the shaft
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < s0 + 0.04 || y > s1 - 0.02) continue;
    const x = p.getX(i),
      z = p.getZ(i);
    const a = Math.atan2(z, x);
    const rr = Math.hypot(x, z);
    const f = Math.pow(Math.abs(Math.cos((a * fl) / 2)), 0.6);
    const nr = rr - f * r * 0.06;
    p.setX(i, Math.cos(a) * nr);
    p.setZ(i, Math.sin(a) * nr);
  }
  g.computeVertexNormals();
  const parts: THREE.BufferGeometry[] = [g];
  if (pl) parts.push(place(new THREE.BoxGeometry(r * 2.9, 0.28, r * 2.9), 0, 0.14, 0));
  if (opts.capital === 'ionic') {
    for (const s of [-1, 1]) {
      const vol = new THREE.TorusGeometry(r * 0.28, r * 0.11, 8, 16);
      parts.push(place(vol, s * r * 1.05, h - 0.32, 0, Math.PI / 2, 1));
    }
  }
  const out = merge(parts);
  out.computeVertexNormals();
  return out;
}

/** Ring of balusters + rail along a polyline (for balustrades). Returns geometry of one baluster. */
export function balusterGeo(h = 0.9): THREE.BufferGeometry {
  const pts = [V2(0, 0), V2(0.09, 0), V2(0.09, 0.06), V2(0.05, 0.1), V2(0.075, 0.28), V2(0.08, 0.38), V2(0.04, 0.6), V2(0.035, h - 0.12), V2(0.07, h - 0.08), V2(0.07, h), V2(0, h)];
  return new THREE.LatheGeometry(pts, 10);
}

/** Arch opening shape (for extruded facades / gates) */
export function archShape(w: number, h: number, archH: number): THREE.Path {
  const p = new THREE.Path();
  p.moveTo(-w / 2, 0);
  p.lineTo(-w / 2, h - archH);
  p.absarc(0, h - archH, w / 2, Math.PI, 0, true);
  p.lineTo(w / 2, 0);
  p.lineTo(-w / 2, 0);
  return p;
}

/** A wall panel with N arched openings (extruded), centred on x, base y = 0, depth along z. */
export function arcadeGeo(width: number, height: number, depth: number, n: number, archW: number, archH: number, archY = 0): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-width / 2, 0);
  s.lineTo(width / 2, 0);
  s.lineTo(width / 2, height);
  s.lineTo(-width / 2, height);
  s.lineTo(-width / 2, 0);
  for (let i = 0; i < n; i++) {
    const cx = -width / 2 + (width / n) * (i + 0.5);
    const hole = new THREE.Path();
    const w = archW,
      hh = archH;
    hole.moveTo(cx - w / 2, archY);
    hole.lineTo(cx + w / 2, archY);
    hole.lineTo(cx + w / 2, archY + hh - w / 2);
    hole.absarc(cx, archY + hh - w / 2, w / 2, 0, Math.PI, false);
    hole.lineTo(cx - w / 2, archY);
    s.holes.push(hole);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 1, curveSegments: 8 });
  g.translate(0, 0, -depth / 2);
  return g;
}

// ------------------------------------------------------------------ rocks / crystals / nature
export function rockGeo(r: number, seed: number, opts: { squash?: number; detail?: number; rough?: number; flat?: number } = {}): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, opts.detail ?? 3);
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.attributes.position;
  const rough = opts.rough ?? 0.35;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      y = p.getY(i),
      z = p.getZ(i);
    const n = fbm3(x * 1.3 + seed, y * 1.3, z * 1.3, 4, seed);
    const facet = Math.round(n * 5) / 5;
    const k = 1 + (n - 0.5) * rough * 2 + (facet - n) * rough * 0.8;
    p.setXYZ(i, x * k * r, y * k * r * (opts.squash ?? 0.7), z * k * r);
  }
  if (opts.flat) {
    for (let i = 0; i < p.count; i++) if (p.getY(i) < -r * opts.flat) p.setY(i, -r * opts.flat);
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox!.min.y - 0.05 * r, 0);
  return g;
}

/** Cluster of hexagonal crystal prisms */
export function crystalCluster(seed: number, scale = 1, count = 7): THREE.BufferGeometry {
  const r = new R(seed);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const h = (i === 0 ? 4 : r.range(1.2, 3.2)) * scale;
    const w = (i === 0 ? 0.45 : r.range(0.14, 0.32)) * scale;
    const shaft = new THREE.CylinderGeometry(w * 0.9, w, h * 0.8, 6, 1);
    shaft.translate(0, h * 0.4, 0);
    const tip = new THREE.ConeGeometry(w * 0.9, h * 0.25, 6);
    tip.translate(0, h * 0.8 + h * 0.125, 0);
    const c = merge([shaft, tip]);
    const a = r.next() * Math.PI * 2;
    const tilt = i === 0 ? r.range(0, 0.08) : r.range(0.25, 0.7);
    place(c, i === 0 ? 0 : Math.cos(a) * r.range(0.2, 0.5) * scale, 0, i === 0 ? 0 : Math.sin(a) * r.range(0.2, 0.5) * scale, r.next() * 3, 1, Math.cos(a) * tilt, -Math.sin(a) * tilt);
    parts.push(c);
  }
  const g = merge(parts);
  g.computeVertexNormals();
  return g;
}

export function obeliskGeo(w: number, h: number): THREE.BufferGeometry {
  const base = new THREE.BoxGeometry(w * 1.7, 0.4, w * 1.7);
  base.translate(0, 0.2, 0);
  const shaft = new THREE.CylinderGeometry(w * 0.42, w * 0.7, h - 1.0, 4, 1);
  shaft.rotateY(Math.PI / 4);
  shaft.translate(0, 0.4 + (h - 1.0) / 2, 0);
  const tip = new THREE.ConeGeometry(w * 0.59, 0.6, 4);
  tip.rotateY(Math.PI / 4);
  tip.translate(0, h - 0.3, 0);
  const g = merge([base, shaft, tip]);
  g.computeVertexNormals();
  return g;
}

/** Japanese stone lantern (toro) */
export function toroGeo(h = 3.0): THREE.BufferGeometry {
  const k = h / 3;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(place(new THREE.CylinderGeometry(0.55, 0.62, 0.3, 6), 0, 0.15 * k, 0, 0, [k, k, k]));
  parts.push(place(new THREE.LatheGeometry([V2(0.18, 0), V2(0.2, 0.2), V2(0.16, 0.6), V2(0.16, 1.0), V2(0.22, 1.1), V2(0, 1.1)], 12), 0, 0.3 * k, 0, 0, [k, k, k]));
  parts.push(place(new THREE.CylinderGeometry(0.55, 0.42, 0.22, 6), 0, 1.5 * k, 0, 0, [k, k, k]));
  parts.push(place(new THREE.BoxGeometry(0.62, 0.55, 0.62), 0, 1.88 * k, 0, 0, [k, k, k]));
  // kasa roof with upturned corners
  const roof = new THREE.CylinderGeometry(0.18, 0.95, 0.42, 6, 2);
  const rp = roof.attributes.position;
  for (let i = 0; i < rp.count; i++) {
    const x = rp.getX(i),
      z = rp.getZ(i),
      y = rp.getY(i);
    const rr = Math.hypot(x, z);
    if (rr > 0.8 && y < 0) rp.setY(i, y + 0.12);
  }
  roof.computeVertexNormals();
  parts.push(place(roof, 0, 2.38 * k, 0, 0, [k, k, k]));
  parts.push(place(new THREE.SphereGeometry(0.16, 10, 8), 0, 2.7 * k, 0, 0, [k, k * 1.2, k]));
  return merge(parts);
}

/** Torii gate */
export function toriiGeo(w = 6, h = 6): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    parts.push(place(new THREE.CylinderGeometry(0.26, 0.32, h, 14), (s * w) / 2, h / 2, 0, 0, 1, 0, s * 0.04));
    parts.push(place(new THREE.CylinderGeometry(0.4, 0.4, 0.5, 14), (s * w) / 2, 0.25, 0));
  }
  parts.push(place(new THREE.BoxGeometry(w + 0.6, 0.32, 0.36), 0, h - 1.15, 0));
  // kasagi: curved top beam
  const kas = new THREE.BoxGeometry(w + 2.4, 0.42, 0.56, 16, 1, 1);
  const kp = kas.attributes.position;
  for (let i = 0; i < kp.count; i++) {
    const x = kp.getX(i);
    kp.setY(i, kp.getY(i) + Math.pow(Math.abs(x) / ((w + 2.4) / 2), 2.4) * 0.45);
  }
  kas.computeVertexNormals();
  parts.push(place(kas, 0, h - 0.1, 0));
  parts.push(place(new THREE.BoxGeometry(0.3, 0.9, 0.22), 0, h - 0.65, 0.05));
  return merge(parts);
}

/** stylised standing statue: robed figure with a spear on a plinth (reads at 5 m) */
export function statueGeo(h = 5, seed = 1): THREE.BufferGeometry {
  const r = new R(seed);
  const k = h / 5;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(place(new THREE.BoxGeometry(1.5, 0.8, 1.5), 0, 0.4, 0, 0, k));
  parts.push(place(new THREE.BoxGeometry(1.7, 0.15, 1.7), 0, 0.85, 0, 0, k));
  // robe
  parts.push(place(new THREE.LatheGeometry([V2(0.62, 0), V2(0.58, 0.4), V2(0.46, 1.4), V2(0.4, 1.9), V2(0, 1.9)], 14), 0, 0.92 * k, 0, 0, k));
  // torso + shoulders
  parts.push(place(new THREE.CapsuleGeometry(0.36, 0.55, 4, 12), 0, 3.2 * k, 0, 0, [k * 1.05, k, k * 0.8]));
  parts.push(place(new THREE.SphereGeometry(0.22, 12, 10), 0, 3.95 * k, 0.02, 0, k));
  // helmet crest
  parts.push(place(new THREE.BoxGeometry(0.06, 0.25, 0.42), 0, 4.2 * k, -0.02, 0, k));
  // arms
  const ra = r.range(-0.3, 0.2);
  parts.push(place(new THREE.CapsuleGeometry(0.1, 0.75, 4, 8), 0.46 * k, 3.15 * k, 0.12 * k, 0, k, ra - 0.3, 0.25));
  parts.push(place(new THREE.CapsuleGeometry(0.1, 0.75, 4, 8), -0.46 * k, 3.25 * k, 0.05 * k, 0, k, -0.6, -0.35));
  // spear + shield
  parts.push(place(new THREE.CylinderGeometry(0.035, 0.035, 4.2, 6), 0.62 * k, 2.6 * k, 0.32 * k, 0, k));
  parts.push(place(new THREE.ConeGeometry(0.09, 0.35, 6), 0.62 * k, 4.85 * k, 0.32 * k, 0, k));
  parts.push(place(new THREE.CylinderGeometry(0.45, 0.45, 0.07, 18), -0.62 * k, 2.6 * k, 0.15 * k, 0, k, Math.PI / 2, 0.2));
  const g = merge(parts);
  g.computeVertexNormals();
  return g;
}

/** colossal seated figure (desert backdrop, ~22 m) */
export function colossusGeo(h = 22): THREE.BufferGeometry {
  const k = h / 22;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(place(new THREE.BoxGeometry(9, 3, 9), 0, 1.5, 0, 0, k));
  // throne
  parts.push(place(new THREE.BoxGeometry(7.5, 10, 6), 0, 8, -1.6, 0, k));
  // legs (shins + thighs)
  for (const s of [-1, 1]) {
    parts.push(place(new THREE.BoxGeometry(1.8, 6.2, 2.0), s * 1.4, 6.1, 2.8, 0, k));
    parts.push(place(new THREE.BoxGeometry(1.9, 1.8, 4.6), s * 1.4, 9.6, 1.3, 0, k));
    parts.push(place(new THREE.BoxGeometry(2.0, 0.8, 2.8), s * 1.4, 3.4, 3.4, 0, k));
    // forearms on knees
    parts.push(place(new THREE.BoxGeometry(1.1, 1.0, 4.0), s * 2.4, 11.0, 1.4, 0, k));
    parts.push(place(new THREE.BoxGeometry(1.1, 4.0, 1.2), s * 2.6, 13.0, -0.3, 0, k));
  }
  // torso
  parts.push(place(new THREE.CylinderGeometry(2.0, 1.7, 6.5, 8), 0, 13.6, -0.4, 0, [k * 1.1, k, k * 0.75]));
  // shoulders
  parts.push(place(new THREE.BoxGeometry(6.2, 1.2, 2.2), 0, 16.6, -0.4, 0, k));
  // head + nemes headdress
  parts.push(place(new THREE.BoxGeometry(1.8, 2.2, 2.0), 0, 18.4, -0.2, 0, k));
  parts.push(place(new THREE.CylinderGeometry(1.15, 1.9, 3.0, 4, 1), 0, 18.5, -0.5, Math.PI / 4, [k, k, k * 0.8]));
  parts.push(place(new THREE.CylinderGeometry(0.9, 0.5, 1.6, 8), 0, 20.2, -0.4, 0, k));
  parts.push(place(new THREE.BoxGeometry(0.5, 1.3, 0.4), 0, 17.0, 0.7, 0, k));
  const g = merge(parts);
  g.computeVertexNormals();
  return g;
}

/** pagoda tower with curved roofs */
export function pagodaGeo(tiers = 4, base = 4): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  let y = 0;
  parts.push(place(new THREE.BoxGeometry(base * 1.3, 0.8, base * 1.3), 0, 0.4, 0));
  y = 0.8;
  for (let i = 0; i < tiers; i++) {
    const w = base * (1 - i * 0.14);
    const bh = 2.2 - i * 0.15;
    parts.push(place(new THREE.BoxGeometry(w, bh, w), 0, y + bh / 2, 0));
    y += bh;
    const roof = new THREE.CylinderGeometry(w * 0.35, w * 0.95, 0.9, 4, 3, false);
    roof.rotateY(Math.PI / 4);
    const rp = roof.attributes.position;
    for (let j = 0; j < rp.count; j++) {
      const x = rp.getX(j),
        z = rp.getZ(j);
      const rr = Math.max(Math.abs(x), Math.abs(z)) / (w * 0.67);
      rp.setY(j, rp.getY(j) + Math.pow(Math.max(0, rr - 0.55), 2) * 1.8);
    }
    roof.computeVertexNormals();
    parts.push(place(roof, 0, y + 0.35, 0));
    y += 0.8;
  }
  parts.push(place(new THREE.CylinderGeometry(0.08, 0.12, 3, 8), 0, y + 1.5, 0));
  for (let i = 0; i < 6; i++) parts.push(place(new THREE.TorusGeometry(0.28, 0.05, 6, 12), 0, y + 0.6 + i * 0.35, 0, 0, 1, Math.PI / 2));
  return merge(parts);
}

/** gnarled tree trunk + branches as tubes; returns trunk geo and canopy anchor points */
export function treeGeo(seed: number, h = 6, spread = 3, opts: { droop?: number } = {}): { geo: THREE.BufferGeometry; tips: THREE.Vector3[] } {
  const r = new R(seed);
  const parts: THREE.BufferGeometry[] = [];
  const tips: THREE.Vector3[] = [];
  const grow = (from: THREE.Vector3, dir: THREE.Vector3, len: number, rad: number, depth: number) => {
    const pts: THREE.Vector3[] = [from.clone()];
    const p = from.clone();
    const d = dir.clone();
    for (let i = 0; i < 4; i++) {
      d.x += r.range(-0.25, 0.25);
      d.z += r.range(-0.25, 0.25);
      d.y += -(opts.droop ?? 0) * 0.15 * depth;
      d.normalize();
      p.addScaledVector(d, len / 4);
      pts.push(p.clone());
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.TubeGeometry(curve, 6, rad, 6, false);
    // taper
    const tp = tube.attributes.position;
    const cp = new THREE.Vector3();
    for (let i = 0; i < tp.count; i++) {
      const ring = Math.floor(i / 7);
      const t = ring / 6;
      curve.getPoint(t, cp);
      const k = 1 - t * 0.6;
      tp.setXYZ(i, cp.x + (tp.getX(i) - cp.x) * k, cp.y + (tp.getY(i) - cp.y) * k, cp.z + (tp.getZ(i) - cp.z) * k);
    }
    tube.computeVertexNormals();
    parts.push(tube);
    if (depth >= 3) {
      tips.push(p.clone());
      return;
    }
    const n = depth === 0 ? 3 : 2 + (r.next() < 0.5 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const a = r.next() * Math.PI * 2;
      const nd = new THREE.Vector3(Math.cos(a) * spread * 0.3, depth === 0 ? 0.9 : 0.5, Math.sin(a) * spread * 0.3).normalize().lerp(d, 0.3).normalize();
      grow(p, nd, len * r.range(0.55, 0.75), rad * 0.6, depth + 1);
    }
  };
  grow(new THREE.Vector3(0, -0.2, 0), new THREE.Vector3(r.range(-0.1, 0.1), 1, r.range(-0.1, 0.1)).normalize(), h * 0.45, h * 0.045, 0);
  return { geo: merge(parts), tips };
}

/** weathered masonry block: subdivided box, chipped top edge, eroded faces */
export function ruinBlock(w: number, h: number, d: number, seed: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d, Math.max(2, Math.round(w * 3)), Math.max(2, Math.round(h * 3)), 2);
  g.translate(0, h / 2, 0);
  const p = g.attributes.position;
  const r = new R(seed);
  const notch = r.range(0.2, 0.8);
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i),
      y = p.getY(i),
      z = p.getZ(i);
    const n = fbm3(x * 1.7 + seed, y * 1.7, z * 1.7, 3, seed);
    // erosion pushes faces in a little, more near the top
    const k = (n - 0.5) * 0.12 * (0.5 + y / h);
    x *= 1 + k;
    z *= 1 + k * 0.6;
    // ragged, broken top
    if (y > h - 1e-3) {
      const u = x / w + 0.5;
      y -= Math.max(0, Math.sin((u - notch) * Math.PI * 1.3)) * h * 0.18 + n * h * 0.12;
    }
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

/** palm tree: curved segmented trunk + drooping frond strips (frond geometry separate) */
export function palmGeo(seed: number, h = 7): { trunk: THREE.BufferGeometry; fronds: THREE.BufferGeometry } {
  const r = new R(seed);
  const lean = r.range(-0.35, 0.35),
    lean2 = r.range(-0.35, 0.35);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 8; i++) {
    const k = i / 8;
    pts.push(new THREE.Vector3(Math.sin(k * 1.4) * lean * h * 0.3, k * h, Math.sin(k * 1.4) * lean2 * h * 0.3));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const trunk = new THREE.TubeGeometry(curve, 16, h * 0.028, 7, false);
  const top = pts[pts.length - 1];
  const parts: THREE.BufferGeometry[] = [];
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r.range(-0.2, 0.2);
    const len = h * r.range(0.38, 0.5);
    const seg = 8;
    const pos: number[] = [];
    const idx: number[] = [];
    for (let s = 0; s <= seg; s++) {
      const k = s / seg;
      const droop = Math.sin(k * Math.PI * 0.85) * len * 0.25 - k * k * len * 0.55;
      const wdt = Math.sin(k * Math.PI) * len * 0.16 + 0.02;
      const cx = Math.cos(a) * k * len,
        cz = Math.sin(a) * k * len;
      const px = -Math.sin(a) * wdt,
        pz = Math.cos(a) * wdt;
      pos.push(top.x + cx + px, top.y + droop, top.z + cz + pz, top.x + cx - px, top.y + droop, top.z + cz - pz);
      if (s > 0) {
        const b = (s - 1) * 2;
        idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    fg.setIndex(idx);
    fg.computeVertexNormals();
    parts.push(fg);
  }
  return { trunk, fronds: merge(parts) };
}

// ------------------------------------------------------------------ props
export function crateGeo(s = 0.9): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [new THREE.BoxGeometry(s, s, s)];
  const b = 0.07;
  for (const y of [-1, 1])
    for (const z of [-1, 1]) {
      parts.push(place(new THREE.BoxGeometry(s + 0.02, b, b), 0, (y * (s - b)) / 2, (z * (s - b)) / 2));
      parts.push(place(new THREE.BoxGeometry(b, b, s + 0.02), (y * (s - b)) / 2, (z * (s - b)) / 2, 0));
      parts.push(place(new THREE.BoxGeometry(b, s + 0.02, b), (y * (s - b)) / 2, 0, (z * (s - b)) / 2));
    }
  parts.push(place(new THREE.BoxGeometry(b * 0.9, s * 1.3, s * 0.02 + 0.03), 0, 0, s / 2 + 0.01, 0, 1, 0, Math.PI / 4));
  const g = merge(parts);
  g.translate(0, s / 2, 0);
  return g;
}

export function barrelGeo(r = 0.38, h = 1.0): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 10; i++) {
    const k = i / 10;
    pts.push(V2(r * (0.86 + 0.14 * Math.sin(k * Math.PI)), k * h));
  }
  const body = new THREE.LatheGeometry([V2(0, 0), ...pts, V2(0, h)], 16);
  const parts: THREE.BufferGeometry[] = [body];
  for (const y of [0.12, 0.35, 0.65, 0.88]) {
    const rr = r * (0.86 + 0.14 * Math.sin(y * Math.PI)) + 0.012;
    parts.push(place(new THREE.TorusGeometry(rr, 0.022, 4, 20), 0, y * h, 0, 0, 1, Math.PI / 2));
  }
  return merge(parts);
}

export function urnGeo(h = 0.75): THREE.BufferGeometry {
  const k = h / 0.75;
  const pts = [V2(0, 0), V2(0.13, 0), V2(0.12, 0.03), V2(0.16, 0.1), V2(0.27, 0.3), V2(0.28, 0.42), V2(0.22, 0.56), V2(0.11, 0.64), V2(0.1, 0.7), V2(0.15, 0.75), V2(0.13, 0.76), V2(0.08, 0.72), V2(0.0, 0.72)].map((v) => V2(v.x * k, v.y * k));
  const body = new THREE.LatheGeometry(pts, 18);
  const parts: THREE.BufferGeometry[] = [body];
  for (const s of [-1, 1]) parts.push(place(new THREE.TorusGeometry(0.09 * k, 0.018 * k, 5, 10, Math.PI), s * 0.17 * k, 0.6 * k, 0, 0, 1, 0, s * 0.6 + Math.PI / 2));
  return merge(parts);
}

export function braziersGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    parts.push(place(new THREE.CylinderGeometry(0.025, 0.03, 1.05, 6), Math.cos(a) * 0.22, 0.5, Math.sin(a) * 0.22, 0, 1, Math.sin(a) * 0.25, -Math.cos(a) * 0.25));
  }
  parts.push(place(new THREE.LatheGeometry([V2(0.08, 0), V2(0.45, 0.12), V2(0.5, 0.26), V2(0.46, 0.26), V2(0.42, 0.15), V2(0, 0.06)], 16), 0, 0.95, 0));
  return merge(parts);
}

/** paper lantern on a short wooden post */
export function paperLanternGeo(): { post: THREE.BufferGeometry; paper: THREE.BufferGeometry } {
  const post = merge([place(new THREE.BoxGeometry(0.12, 1.1, 0.12), 0, 0.55, 0), place(new THREE.BoxGeometry(0.5, 0.06, 0.5), 0, 1.12, 0), place(new THREE.BoxGeometry(0.42, 0.06, 0.42), 0, 1.62, 0)]);
  const paper = new THREE.CylinderGeometry(0.2, 0.2, 0.48, 12);
  paper.translate(0, 1.38, 0);
  return { post, paper };
}

/** a broken column drum (rubble) */
export function drumGeo(r: number, h: number, seed: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, h, 20, 2);
  const p = g.attributes.position;
  const rr = new R(seed);
  const tilt = rr.range(-0.12, 0.12);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y > h / 2 - 1e-3 || y < -h / 2 + 1e-3) p.setY(i, y + (p.getX(i) * tilt + fbm3(p.getX(i) * 4, 0, p.getZ(i) * 4, 2, seed) * 0.15) * Math.sign(y));
    const a = Math.atan2(p.getZ(i), p.getX(i));
    const f = Math.pow(Math.abs(Math.cos(a * 10)), 0.6);
    const k = 1 - f * 0.05;
    p.setX(i, p.getX(i) * k);
    p.setZ(i, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  g.translate(0, h / 2, 0);
  return g;
}

/** spike trap: plate + spikes (spikes geometry separate so they can rise) */
export function spikeGeo(r: number): { plate: THREE.BufferGeometry; spikes: THREE.BufferGeometry } {
  const plate = new THREE.CylinderGeometry(r, r * 1.05, 0.08, 24);
  plate.translate(0, 0.04, 0);
  const parts: THREE.BufferGeometry[] = [];
  const n = Math.round(r * 9);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const x = (i / (n - 1) - 0.5) * r * 1.5,
        z = (j / (n - 1) - 0.5) * r * 1.5;
      if (Math.hypot(x, z) > r * 0.85) continue;
      parts.push(place(new THREE.ConeGeometry(0.045, 0.75, 5), x, 0.375, z));
    }
  return { plate, spikes: merge(parts) };
}

/** chain of N links along -Y from the origin */
export function chainGeo(len: number, link = 0.16): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const n = Math.ceil(len / (link * 1.6));
  for (let i = 0; i < n; i++) parts.push(place(new THREE.TorusGeometry(link * 0.5, link * 0.12, 4, 10), 0, -i * link * 1.6, 0, (i % 2) * (Math.PI / 2), [1, 1.5, 1]));
  return merge(parts);
}
