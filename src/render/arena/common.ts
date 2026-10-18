/**
 * Shared dressing helpers: ellipse sweeps (walls, tiers, curbs), placement
 * along the arena boundary with gate gaps, floors with world-space UVs,
 * gates, instanced crowds and cloth banners.
 */
import * as THREE from 'three';
import type { ArenaLayout } from '../../sim/arenaGen';
import { boundR } from '../../sim/arenaGen';
import type { Arena, Gate, GateAnchors, V3 } from './arenaView';
import { canvasTexture } from './textures';
import { shaderTime } from './materials';
import { R } from './noise';

/** point on the boundary ellipse (scaled radius + offset) at angle a */
export function ellipseAt(L: ArenaLayout, a: number, off: number): THREE.Vector3 {
  const dx = Math.cos(a),
    dz = Math.sin(a);
  const r = boundR(L, dx, dz) + off;
  return new THREE.Vector3(dx * r, 0, dz * r);
}

/** is a boundary point inside a gate opening? */
export function inGate(L: ArenaLayout, p: THREE.Vector3, half = 2.0): boolean {
  return Math.abs(p.z) < half && Math.abs(p.x) > L.rx * 0.6;
}

/**
 * Sweep a 2D profile [offset from boundary (m), y] around the ellipse.
 * Returns a mesh geometry with uv.x = arc length (m), uv.y = profile length (m).
 * gateHalf > 0 leaves gaps at the two gates.
 */
export function sweepEllipse(L: ArenaLayout, profile: [number, number][], segs = 180, gateHalf = 0, uvScale = 1): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const plen: number[] = [0];
  for (let i = 1; i < profile.length; i++) plen.push(plen[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
  let arc = 0;
  let prev: THREE.Vector3 | null = null;
  let ringStart = -1;
  let prevOk = false;
  const np = profile.length;
  for (let s = 0; s <= segs; s++) {
    const a = (s / segs) * Math.PI * 2;
    const base = ellipseAt(L, a, 0);
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    if (prev) arc += base.distanceTo(prev);
    prev = base;
    const ok = gateHalf <= 0 || !inGate(L, base, gateHalf);
    const start = pos.length / 3;
    for (let j = 0; j < np; j++) {
      const [o, y] = profile[j];
      pos.push(base.x + dir.x * o, y, base.z + dir.z * o);
      uv.push(arc * uvScale, plen[j] * uvScale);
    }
    if (ok && prevOk && ringStart >= 0) {
      for (let j = 0; j < np - 1; j++) {
        const a0 = ringStart + j,
          a1 = ringStart + j + 1,
          b0 = start + j,
          b1 = start + j + 1;
        idx.push(a0, b0, a1, a1, b0, b1);
      }
    }
    ringStart = start;
    prevOk = ok;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** call cb at regular arc-length spacing around the ellipse (skipping gates) */
export function alongEllipse(L: ArenaLayout, off: number, spacing: number, cb: (p: THREE.Vector3, yaw: number, a: number, i: number) => void, gateHalf = 2.0, phase = 0) {
  const N = 720;
  let acc = spacing * phase;
  let prev = ellipseAt(L, 0, off);
  let i = 0;
  for (let s = 1; s <= N; s++) {
    const a = (s / N) * Math.PI * 2;
    const p = ellipseAt(L, a, off);
    acc += p.distanceTo(prev);
    prev = p;
    if (acc >= spacing) {
      acc -= spacing;
      if (gateHalf > 0 && inGate(L, p, gateHalf)) continue;
      const yaw = Math.atan2(-p.x, -p.z); // facing the centre
      cb(p, yaw, a, i++);
    }
  }
}

/** elliptical floor disc with world-space UVs (tile = metres per texture repeat) */
export function floorDisc(L: ArenaLayout, pad: number, tile: number, mat: THREE.Material, y = 0): THREE.Mesh {
  const g = new THREE.CircleGeometry(1, 160, 0, Math.PI * 2);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) * (L.rx + pad),
      z = p.getZ(i) * (L.rz + pad);
    p.setXYZ(i, x, y, z);
    uv.setXY(i, x / tile, z / tile);
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  // A2: the kit wet floor (dressKit.ts) replaces meshes flagged floor / floorDeco
  m.userData.floor = true;
  m.userData.floorPad = pad;
  return m;
}

/** big ground plane / ring for outside the arena, world-space UVs */
export function groundPlane(size: number, tile: number, mat: THREE.Material, y = -0.01, seg = 1, height?: (x: number, z: number) => number): THREE.Mesh {
  const g = new THREE.PlaneGeometry(size, size, seg, seg);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      z = p.getZ(i);
    p.setY(i, y + (height ? height(x, z) : 0));
    uv.setXY(i, x / tile, z / tile);
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  return m;
}

/**
 * Create a gate at side i (0 = -X, 1 = +X) on the boundary + off. The builder
 * receives the gate group (local +Z points into the arena, origin at the
 * opening) and returns the moving "portcullis" and the light position.
 */
/** anchors as returned by a theme's gate builder: positions in GROUP-local space (origin at the gate opening, +z inward) */
export type AnchorSpec = Partial<Omit<GateAnchors, 'pieces'>> & { barrier: GateAnchors['barrier'] };

export function makeGate(
  a: Arena,
  i: number,
  off: number,
  build: (g: THREE.Group) => { portcullis: THREE.Object3D; lightPos?: THREE.Vector3; lightColor?: string; anchors?: AnchorSpec },
): Gate {
  const L = a.layout;
  const ang = i === 0 ? Math.PI : 0;
  const x = Math.cos(ang) * (L.rx + off);
  const g = new THREE.Group();
  g.position.set(x, 0, 0);
  g.lookAt(0, 0, 0);
  a.group.add(g);
  const r = build(g);
  const light = new THREE.PointLight(r.lightColor ?? a.theme.accent, 0, 14, 1.6);
  light.position.copy(r.lightPos ?? new THREE.Vector3(0, 2.4, 1.6));
  g.add(light);
  // group-local -> gate frame (origin at the boundary, the group sits `off` further out)
  const A = r.anchors ?? { barrier: 'none' };
  const fz = (p: V3): V3 => [p[0], p[1], p[2] - off];
  const pieces: GateAnchors['pieces'] = [];
  r.portcullis.traverse((o) => {
    if (o !== r.portcullis) pieces.push({ obj: o, pos: o.position.clone(), rot: o.rotation.clone(), vis: o.visible });
    const mt = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (mt && (mt as THREE.Material).transparent) mt.userData.op = (mt as THREE.MeshBasicMaterial).opacity;
  });
  const anchors: GateAnchors = {
    barrier: A.barrier,
    barrierZ: 0.2 - off,
    barrierHalfW: A.barrierHalfW ?? 1.5,
    barrierH: A.barrierH ?? 3.6,
    tunnel: A.tunnel,
    perches: (A.perches ?? []).map((p) => ({ ...p, pos: fz(p.pos) })),
    rims: (A.rims ?? []).map((p) => ({ ...p, pos: fz(p.pos) })),
    stands: (A.stands ?? []).map(fz),
    lowWall: A.lowWall ? { ...A.lowWall, pos: fz(A.lowWall.pos) } : undefined,
    wallH: A.wallH ?? L.wallH,
    pieces,
  };
  const gate: Gate = { angle: ang, pos: new THREE.Vector3(Math.cos(ang) * L.rx, 0, 0), inward: new THREE.Vector3(-Math.cos(ang), 0, 0), portcullis: r.portcullis, light, group: g, smashed: false, anchors };
  a.gates.push(gate);
  return gate;
}

/** instanced spectators on stepped tiers */
export function crowd(a: Arena, rows: { off: number; y: number }[], count: number, palette: string[], gateHalf = 3.2): void {
  const L = a.layout;
  // seated spectator: tapered torso with shoulders, head, lap, arms at the sides
  const torso = new THREE.CylinderGeometry(0.2, 0.15, 0.55, 6, 1, true);
  torso.translate(0, 0.42, 0);
  const shoulders = new THREE.SphereGeometry(0.2, 6, 3);
  shoulders.scale(1.15, 0.45, 0.8);
  shoulders.translate(0, 0.68, 0);
  const head = new THREE.SphereGeometry(0.105, 6, 4);
  head.translate(0, 0.86, 0);
  const lap = new THREE.BoxGeometry(0.32, 0.12, 0.34);
  lap.translate(0, 0.16, 0.12);
  const armL = new THREE.CylinderGeometry(0.045, 0.04, 0.42, 4, 1, true);
  armL.translate(0.21, 0.48, 0.03);
  const armR = armL.clone().translate(-0.42, 0, 0);
  const geo = mergeSimple([torso, shoulders, lap, armL, armR]);
  // GPU crowd motion: each spectator bobs / jumps with the arena's excitement
  const excite = { value: 0.2 };
  const bob = (m: THREE.MeshStandardMaterial) => {
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = shaderTime;
      sh.uniforms.uEx = excite;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uEx;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          { vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
            float ph = fract(sin(dot(ip.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
            float b = max(0.0, sin(uTime * (3.0 + uEx * 6.0) + ph)) * (0.02 + uEx * 0.22);
            transformed.y += b / max(0.5, length(instanceMatrix[1].xyz)); }`,
        );
    };
    m.customProgramCacheKey = () => 'crowdbob';
  };
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
  bob(mat);
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  // heads: a second instanced mesh with skin / hair tones sharing the matrices
  const headGeo = mergeSimple([head]);
  const headMat = new THREE.MeshStandardMaterial({ roughness: 0.7 });
  bob(headMat);
  const heads = new THREE.InstancedMesh(headGeo, headMat, count);
  const skins = ['#e0b896', '#c99470', '#a8704c', '#7a4e34', '#f0c8a8', '#5a3a28'];
  const r = new R(11);
  const base: { m: THREE.Matrix4; ph: number; y: number }[] = [];
  const col = new THREE.Color();
  const m = new THREE.Matrix4();
  let n = 0;
  for (let k = 0; k < count * 3 && n < count; k++) {
    const row = rows[Math.floor(r.next() * rows.length)];
    const ang = r.next() * Math.PI * 2;
    const p = ellipseAt(L, ang, row.off + r.range(-0.15, 0.15));
    if (inGate(L, p, gateHalf)) continue;
    const s = r.range(0.85, 1.12);
    m.compose(new THREE.Vector3(p.x, row.y, p.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.atan2(-p.x, -p.z), 0)), new THREE.Vector3(s, s, s));
    mesh.setMatrixAt(n, m);
    col.set(palette[Math.floor(r.next() * palette.length)]).multiplyScalar(r.range(0.55, 0.95));
    mesh.setColorAt(n, col);
    col.set(skins[Math.floor(r.next() * skins.length)]);
    heads.setColorAt(n, col);
    heads.setMatrixAt(n, m);
    base.push({ m: m.clone(), ph: r.next() * 10, y: row.y });
    n++;
  }
  mesh.count = n;
  heads.count = n;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  heads.receiveShadow = true;
  mesh.userData.noAO = heads.userData.noAO = true;
  a.group.add(mesh, heads);
  a.onUpdate(() => (excite.value = a.excitement));
}

function mergeSimple(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // tiny local merge (avoid importing kit in common for cyclic safety)
  const parts = gs.map((g) => (g.index ? g.toNonIndexed() : g));
  const total = parts.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3),
    nor = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

/** cloth banner with an emblem; flutters in a.update */
export function banner(a: Arena, color: string, trim: string, w: number, h: number, emblem: 'diamond' | 'sun' | 'circle' | 'wave' = 'diamond'): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(w, h, 4, 10);
  geo.translate(0, -h / 2, 0);
  const tex = canvasTexture(256, (g, s) => {
    g.fillStyle = color;
    g.fillRect(0, 0, s, s);
    g.fillStyle = trim;
    g.fillRect(0, 0, s * 0.07, s);
    g.fillRect(s * 0.93, 0, s * 0.07, s);
    g.fillRect(0, s * 0.92, s, s * 0.08);
    g.fillStyle = trim;
    g.globalAlpha = 0.95;
    const cx = s / 2,
      cy = s * 0.42;
    g.beginPath();
    if (emblem === 'diamond') {
      g.moveTo(cx, cy - s * 0.2);
      g.lineTo(cx + s * 0.2, cy);
      g.lineTo(cx, cy + s * 0.2);
      g.lineTo(cx - s * 0.2, cy);
      g.closePath();
      g.fill();
    } else if (emblem === 'sun') {
      for (let i = 0; i < 12; i++) {
        const an = (i / 12) * Math.PI * 2;
        g.moveTo(cx, cy);
        g.lineTo(cx + Math.cos(an - 0.12) * s * 0.24, cy + Math.sin(an - 0.12) * s * 0.24);
        g.lineTo(cx + Math.cos(an + 0.12) * s * 0.24, cy + Math.sin(an + 0.12) * s * 0.24);
      }
      g.fill();
      g.fillStyle = color;
      g.beginPath();
      g.arc(cx, cy, s * 0.08, 0, Math.PI * 2);
      g.fill();
    } else if (emblem === 'circle') {
      g.arc(cx, cy, s * 0.16, 0, Math.PI * 2);
      g.lineWidth = s * 0.04;
      g.strokeStyle = trim;
      g.stroke();
    } else {
      g.lineWidth = s * 0.035;
      g.strokeStyle = trim;
      for (let k = 0; k < 3; k++) {
        g.beginPath();
        for (let x = 0; x <= s; x += 8) g.lineTo(x, cy + k * s * 0.09 + Math.sin(x * 0.05) * s * 0.03);
        g.stroke();
      }
    }
  });
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.9 }));
  mesh.castShadow = true;
  mesh.userData.dyn = true;
  const basePos = (geo.attributes.position.array as Float32Array).slice();
  // A4: the legacy phase stays Math.random() ONLY on the legacy path (?arena=legacy must stay pixel-identical: the concept
  // harness seeds Math.random); kit mode gets a deterministic phase (render seed + build order) and replaces these banners
  // with kit banners whose sway runs in the vertex shader (cloth.ts)
  const ph = a.kit ? (((a.layout.seed * 7919 + a.group.children.length * 104729) % 1000) / 1000) * 10 : Math.random() * 10;
  a.onUpdate((t) => {
    if (!mesh.parent) return; // A4: removed by the kit ring (dressKit wallBanners): no more CPU flutter
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      const y = basePos[i + 1],
        x = basePos[i];
      arr[i + 2] = basePos[i + 2] + Math.sin(t * 2.0 + ph + y * 2.0 + x * 1.5) * 0.07 * -y;
    }
    pos.needsUpdate = true;
  });
  return mesh;
}
