/**
 * A21: "is anything in the way?" for the entrance camera's line-of-sight checks, with the same answer as
 * `raycaster.intersectObjects(meshes, false).length > 0` but without testing every triangle of the arena's big merged
 * meshes on every frame (the Moon Gate's merged ring / tier meshes made that 20-30 ms per intro frame).
 *
 * Exactness: per mesh the early-outs are three's own (layers, bounding sphere in world space, bounding box in local
 * space); the triangles are then fetched from a per-mesh bounding-volume tree built in the mesh's LOCAL space (boxes
 * padded so a triangle three would test is never skipped) and tested with three's own maths (Ray.intersectTriangle on
 * the local ray with the material side's culling, the hit transformed to world, distance against near / far). The
 * triangle set and the side per triangle follow Mesh._computeIntersections (groups, material arrays, draw range).
 * Meshes this does not model (morph targets, skinned meshes, non-Mesh objects) fall back to three's raycast.
 */
import * as THREE from 'three';

interface Accel {
  /** triangle vertex indices (a, b, c) and side code (0 front-cull, 1 double, 2 back-side) per triangle */
  tri: Uint32Array;
  side: Uint8Array;
  /** flattened tree: per node min xyz, max xyz; leaves list triangles [start, count) in `order` */
  bmin: Float32Array;
  bmax: Float32Array;
  left: Int32Array;
  right: Int32Array;
  start: Int32Array;
  count: Int32Array;
  order: Uint32Array;
}

const cache = new WeakMap<THREE.Mesh, Accel | null>();
const LEAF = 8;

function sideOf(m: THREE.Material | undefined): number {
  if (!m) return -1;
  return m.side === THREE.BackSide ? 2 : m.side === THREE.FrontSide ? 0 : 1;
}

function build(mesh: THREE.Mesh): Accel | null {
  const g = mesh.geometry as THREE.BufferGeometry;
  const mat = mesh.material as THREE.Material | THREE.Material[];
  if ((mesh as unknown as THREE.SkinnedMesh).isSkinnedMesh || (g.morphAttributes.position && mesh.morphTargetInfluences)) return null;
  const pos = g.attributes.position as THREE.BufferAttribute | undefined;
  if (!pos) return null;
  const index = g.index;
  const dr = g.drawRange;
  const tris: number[] = [];
  const sides: number[] = [];
  const push = (a: number, b: number, c: number, m: THREE.Material | undefined) => {
    const s = sideOf(m);
    if (s < 0) return; // three's checkIntersection would read material.side of undefined: never a hit we can model
    tris.push(a, b, c);
    sides.push(s);
  };
  if (index !== null) {
    if (Array.isArray(mat)) {
      for (const group of g.groups) {
        const gm = mat[group.materialIndex!];
        const start = Math.max(group.start, dr.start);
        const end = Math.min(index.count, Math.min(group.start + group.count, dr.start + dr.count));
        for (let j = start; j < end; j += 3) push(index.getX(j), index.getX(j + 1), index.getX(j + 2), gm);
      }
    } else {
      const start = Math.max(0, dr.start);
      const end = Math.min(index.count, dr.start + dr.count);
      for (let i = start; i < end; i += 3) push(index.getX(i), index.getX(i + 1), index.getX(i + 2), mat);
    }
  } else {
    if (Array.isArray(mat)) {
      for (const group of g.groups) {
        const gm = mat[group.materialIndex!];
        const start = Math.max(group.start, dr.start);
        const end = Math.min(pos.count, Math.min(group.start + group.count, dr.start + dr.count));
        for (let j = start; j < end; j += 3) push(j, j + 1, j + 2, gm);
      }
    } else {
      const start = Math.max(0, dr.start);
      const end = Math.min(pos.count, dr.start + dr.count);
      for (let i = start; i < end; i += 3) push(i, i + 1, i + 2, mat);
    }
  }
  const n = sides.length;
  const tri = new Uint32Array(tris);
  const side = new Uint8Array(sides);
  // per-triangle bounds (local space) and centroids
  const tmin = new Float32Array(n * 3),
    tmax = new Float32Array(n * 3),
    cen = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let t = 0; t < n; t++) {
    let x0 = Infinity,
      y0 = Infinity,
      z0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity,
      z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      v.fromBufferAttribute(pos, tri[t * 3 + k]);
      x0 = Math.min(x0, v.x);
      y0 = Math.min(y0, v.y);
      z0 = Math.min(z0, v.z);
      x1 = Math.max(x1, v.x);
      y1 = Math.max(y1, v.y);
      z1 = Math.max(z1, v.z);
    }
    tmin[t * 3] = x0;
    tmin[t * 3 + 1] = y0;
    tmin[t * 3 + 2] = z0;
    tmax[t * 3] = x1;
    tmax[t * 3 + 1] = y1;
    tmax[t * 3 + 2] = z1;
    cen[t * 3] = (x0 + x1) / 2;
    cen[t * 3 + 1] = (y0 + y1) / 2;
    cen[t * 3 + 2] = (z0 + z1) / 2;
  }
  const order = new Uint32Array(n);
  for (let t = 0; t < n; t++) order[t] = t;
  const bmin: number[] = [],
    bmax: number[] = [],
    left: number[] = [],
    right: number[] = [],
    start: number[] = [],
    count: number[] = [];
  const node = (s: number, c: number): number => {
    const id = left.length;
    left.push(-1), right.push(-1), start.push(s), count.push(c);
    let x0 = Infinity,
      y0 = Infinity,
      z0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity,
      z1 = -Infinity;
    for (let i = s; i < s + c; i++) {
      const t = order[i];
      x0 = Math.min(x0, tmin[t * 3]);
      y0 = Math.min(y0, tmin[t * 3 + 1]);
      z0 = Math.min(z0, tmin[t * 3 + 2]);
      x1 = Math.max(x1, tmax[t * 3]);
      y1 = Math.max(y1, tmax[t * 3 + 1]);
      z1 = Math.max(z1, tmax[t * 3 + 2]);
    }
    // pad: relative + absolute, so float rounding in the slab test can never drop a triangle three would test
    const pad = 1e-4 * Math.max(x1 - x0, y1 - y0, z1 - z0, 1) + 1e-5;
    bmin.push(x0 - pad, y0 - pad, z0 - pad);
    bmax.push(x1 + pad, y1 + pad, z1 + pad);
    if (c <= LEAF) return id;
    const ex = [x1 - x0, y1 - y0, z1 - z0];
    const ax = ex[0] >= ex[1] && ex[0] >= ex[2] ? 0 : ex[1] >= ex[2] ? 1 : 2;
    const sub = Array.from(order.subarray(s, s + c)).sort((p, q) => cen[p * 3 + ax] - cen[q * 3 + ax]);
    order.set(sub, s);
    const h = c >> 1;
    const l = node(s, h);
    const r = node(s + h, c - h);
    left[id] = l;
    right[id] = r;
    count[id] = 0;
    return id;
  };
  if (n) node(0, n);
  return { tri, side, bmin: new Float32Array(bmin), bmax: new Float32Array(bmax), left: new Int32Array(left), right: new Int32Array(right), start: new Int32Array(start), count: new Int32Array(count), order };
}

const _sphere = new THREE.Sphere();
const _ray = new THREE.Ray();
const _inv = new THREE.Matrix4();
const _hitAt = new THREE.Vector3();
const _box = new THREE.Box3();
const _a = new THREE.Vector3(),
  _b = new THREE.Vector3(),
  _c = new THREE.Vector3(),
  _p = new THREE.Vector3(),
  _pw = new THREE.Vector3();
const _fallback: THREE.Intersection[] = [];

/** does the raycaster's ray hit any of these meshes within [near, far]? (same answer as intersectObjects(...).length > 0) */
export function anyHit(raycaster: THREE.Raycaster, meshes: THREE.Mesh[]): boolean {
  for (const mesh of meshes) {
    if (!mesh.layers.test(raycaster.layers)) continue;
    let acc = cache.get(mesh);
    if (acc === undefined) cache.set(mesh, (acc = (mesh as THREE.Mesh).isMesh ? build(mesh) : null));
    if (acc === null) {
      _fallback.length = 0;
      mesh.raycast(raycaster, _fallback);
      if (_fallback.length) return true;
      continue;
    }
    // three's early-outs (Mesh.raycast)
    const g = mesh.geometry as THREE.BufferGeometry;
    if (mesh.material === undefined) continue;
    if (g.boundingSphere === null) g.computeBoundingSphere();
    _sphere.copy(g.boundingSphere!).applyMatrix4(mesh.matrixWorld);
    _ray.copy(raycaster.ray).recast(raycaster.near);
    if (_sphere.containsPoint(_ray.origin) === false) {
      if (_ray.intersectSphere(_sphere, _hitAt) === null) continue;
      if (_ray.origin.distanceToSquared(_hitAt) > (raycaster.far - raycaster.near) ** 2) continue;
    }
    _inv.copy(mesh.matrixWorld).invert();
    _ray.copy(raycaster.ray).applyMatrix4(_inv);
    if (g.boundingBox !== null && _ray.intersectsBox(g.boundingBox) === false) continue;
    // tree walk on the local ray, three's triangle maths on every candidate
    const pos = g.attributes.position as THREE.BufferAttribute;
    const stack: number[] = acc.left.length ? [0] : [];
    while (stack.length) {
      const id = stack.pop()!;
      _box.min.set(acc.bmin[id * 3], acc.bmin[id * 3 + 1], acc.bmin[id * 3 + 2]);
      _box.max.set(acc.bmax[id * 3], acc.bmax[id * 3 + 1], acc.bmax[id * 3 + 2]);
      if (!_ray.intersectsBox(_box)) continue;
      if (acc.left[id] >= 0) {
        stack.push(acc.left[id], acc.right[id]);
        continue;
      }
      for (let i = acc.start[id], e = i + acc.count[id]; i < e; i++) {
        const t = acc.order[i];
        _a.fromBufferAttribute(pos, acc.tri[t * 3]);
        _b.fromBufferAttribute(pos, acc.tri[t * 3 + 1]);
        _c.fromBufferAttribute(pos, acc.tri[t * 3 + 2]);
        const s = acc.side[t];
        const hit = s === 2 ? _ray.intersectTriangle(_c, _b, _a, true, _p) : _ray.intersectTriangle(_a, _b, _c, s === 0, _p);
        if (hit === null) continue;
        _pw.copy(_p).applyMatrix4(mesh.matrixWorld);
        const d = raycaster.ray.origin.distanceTo(_pw);
        if (d < raycaster.near || d > raycaster.far) continue;
        return true;
      }
    }
  }
  return false;
}
