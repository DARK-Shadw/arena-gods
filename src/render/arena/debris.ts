/**
 * Visual-only destruction: pre-fractured chunk pools (instanced, simple
 * ballistic physics with bounce/friction, slow-mo aware because they're
 * stepped with sim-time dt) and an accumulating floor decal layer (scorch
 * marks, impact cracks, scuffs) painted into a canvas mapped over the arena.
 */
import * as THREE from 'three';
import { rockGeo } from './kit';
import { R } from './noise';

export type DebrisMat = 'stone' | 'marble' | 'wood' | 'ceramic' | 'ice' | 'crystal' | 'obsidian' | 'metal' | 'sandstone' | 'paper';

const MATS: Record<DebrisMat, { color: string; rough: number; metal?: number; emissive?: string }> = {
  stone: { color: '#8a837a', rough: 0.9 },
  marble: { color: '#e8e2d8', rough: 0.35 },
  sandstone: { color: '#c98a54', rough: 0.9 },
  wood: { color: '#7a5232', rough: 0.85 },
  ceramic: { color: '#b0603a', rough: 0.6 },
  ice: { color: '#bfe8ff', rough: 0.1 },
  crystal: { color: '#9ad8ff', rough: 0.15, emissive: '#2a7aa8' },
  obsidian: { color: '#2a2428', rough: 0.3, emissive: '#3a0a00' },
  metal: { color: '#6a625a', rough: 0.4, metal: 1 },
  paper: { color: '#ffd6a0', rough: 0.9, emissive: '#5a2a00' },
};

interface Piece {
  alive: boolean;
  p: THREE.Vector3;
  v: THREE.Vector3;
  q: THREE.Quaternion;
  w: THREE.Vector3;
  s: number;
  life: number;
  max: number;
  rest: boolean;
}

const MAX = 260;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

class Pool {
  mesh: THREE.InstancedMesh;
  pieces: Piece[] = [];
  next = 0;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material) {
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    for (let i = 0; i < MAX; i++) {
      this.pieces.push({ alive: false, p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), s: 0, life: 0, max: 1, rest: false });
      _m.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, _m);
    }
  }
}

export class Debris {
  group = new THREE.Group();
  private pools = new Map<DebrisMat, Pool>();
  private geo: THREE.BufferGeometry;
  private rnd = new R(99);
  floorY = 0;
  /** ground height function (y at x,z) – flat by default */
  constructor() {
    this.geo = rockGeo(0.5, 3, { detail: 0, squash: 0.8, rough: 0.6 });
    this.geo.center();
  }

  /** A5: per-theme chunk meshes (kit FRAC pieces, unit size) and, optionally, their textured kit material */
  private chunks = new Map<DebrisMat, { geo: THREE.BufferGeometry; mat?: THREE.Material }>();

  /**
   * A5: the pool of `m` draws this chunk mesh (normalised to the procedural rock's size: largest half extent 0.5, centred)
   * instead of the procedural rock; with `mat` (a kit material, owned by the asset cache) instead of the flat colour.
   * Still one InstancedMesh per material kind, so the debris draw calls are unchanged. Call before the first burst.
   */
  setChunk(m: DebrisMat, src: THREE.BufferGeometry, mat?: THREE.Material) {
    if (this.pools.has(m)) return;
    const g = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) {
      const at = src.attributes[name] as THREE.BufferAttribute | undefined;
      if (!at) continue;
      const arr = new Float32Array(at.count * at.itemSize);
      for (let i = 0; i < at.count; i++) for (let c = 0; c < at.itemSize; c++) arr[i * at.itemSize + c] = at.getComponent(i, c);
      g.setAttribute(name, new THREE.BufferAttribute(arr, at.itemSize));
    }
    if (src.index) g.setIndex(Array.from(src.index.array as ArrayLike<number>));
    g.computeBoundingBox();
    const b = g.boundingBox!;
    const c = b.getCenter(new THREE.Vector3());
    const s = 0.5 / Math.max(1e-4, Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) / 2);
    g.translate(-c.x, -c.y, -c.z);
    g.scale(s, s, s);
    if (!g.attributes.normal) g.computeVertexNormals();
    g.computeBoundingSphere();
    this.chunks.set(m, { geo: g, mat });
  }

  private pool(m: DebrisMat): Pool {
    let p = this.pools.get(m);
    if (!p) {
      const d = MATS[m];
      const ch = this.chunks.get(m);
      const mat = ch?.mat ?? new THREE.MeshStandardMaterial({ color: d.color, roughness: d.rough, metalness: d.metal ?? 0, emissive: d.emissive ?? '#000000', emissiveIntensity: d.emissive ? 1.5 : 0 });
      p = new Pool(ch?.geo ?? this.geo, mat);
      // a kit material belongs to the asset cache (Arena.dispose must not dispose it)
      if (ch?.mat) p.mesh.userData.sharedMat = true;
      this.pools.set(m, p);
      this.group.add(p.mesh);
    }
    return p;
  }

  /** burst of chunks from a point; dir biases the throw */
  /**
   * A21: create the pools of these kinds up front, HIDDEN (no draw until their first burst), so their instanced
   * programs compile during the loading screen (renderer.compile walks hidden objects too) instead of on the first
   * break in a fight (a 0.4-0.8 s hitch on the Arc iGPU for a kit material's instanced variant).
   */
  prewarm(kinds: Iterable<DebrisMat>) {
    for (const k of kinds) {
      if (this.pools.has(k)) continue;
      this.pool(k).mesh.visible = false;
    }
  }

  burst(mat: DebrisMat, at: THREE.Vector3, n: number, size: number, speed: number, dir?: THREE.Vector3, life = 4) {
    const pool = this.pool(mat);
    pool.mesh.visible = true;
    const r = this.rnd;
    for (let i = 0; i < n; i++) {
      const pc = pool.pieces[pool.next];
      pool.next = (pool.next + 1) % MAX;
      pc.alive = true;
      pc.rest = false;
      pc.p.copy(at).add(new THREE.Vector3(r.range(-0.3, 0.3), r.range(-0.1, 0.4), r.range(-0.3, 0.3)).multiplyScalar(size * 2));
      const a = r.next() * Math.PI * 2;
      pc.v.set(Math.cos(a) * r.range(0.3, 1), r.range(0.6, 1.4), Math.sin(a) * r.range(0.3, 1)).multiplyScalar(speed);
      if (dir) pc.v.addScaledVector(dir, speed * r.range(0.4, 1.0));
      pc.q.setFromEuler(_e.set(r.next() * 6, r.next() * 6, r.next() * 6));
      pc.w.set(r.range(-12, 12), r.range(-12, 12), r.range(-12, 12));
      pc.s = size * r.range(0.4, 1.2);
      pc.max = pc.life = life * r.range(0.7, 1.2);
    }
  }

  update(dt: number) {
    if (dt <= 0) return;
    for (const pool of this.pools.values()) {
      let any = false;
      for (let i = 0; i < MAX; i++) {
        const pc = pool.pieces[i];
        if (!pc.alive) continue;
        any = true;
        pc.life -= dt;
        if (pc.life <= 0) {
          pc.alive = false;
          _m.makeScale(0, 0, 0);
          pool.mesh.setMatrixAt(i, _m);
          continue;
        }
        if (!pc.rest) {
          pc.v.y -= 9.8 * dt;
          pc.p.addScaledVector(pc.v, dt);
          const ground = this.floorY + pc.s * 0.35;
          if (pc.p.y < ground) {
            pc.p.y = ground;
            if (Math.abs(pc.v.y) < 1.2) {
              pc.v.set(0, 0, 0);
              pc.w.set(0, 0, 0);
              pc.rest = true;
            } else {
              pc.v.y *= -0.32;
              pc.v.x *= 0.6;
              pc.v.z *= 0.6;
              pc.w.multiplyScalar(0.6);
            }
          }
          _q.setFromEuler(_e.set(pc.w.x * dt, pc.w.y * dt, pc.w.z * dt));
          pc.q.multiply(_q);
        }
        const k = Math.min(1, pc.life / 0.6);
        _s.setScalar(pc.s * k);
        _m.compose(pc.p, pc.q, _s);
        pool.mesh.setMatrixAt(i, _m);
      }
      if (any) pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  clear() {
    for (const pool of this.pools.values()) {
      for (let i = 0; i < MAX; i++) {
        pool.pieces[i].alive = false;
        _m.makeScale(0, 0, 0);
        pool.mesh.setMatrixAt(i, _m);
      }
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

// ------------------------------------------------------------------ A5: pre-fractured pieces (FRAC_*) spawned in place

/** how a fracture set moves: 'lie' = pieces of a toppled obstacle settling along its fall line, 'burst' = a prop or
 * barricade breaking apart where it stood */
export type FracMode = 'lie' | 'burst';

interface FracPiece {
  start: number;
  count: number;
  /** centroid at spawn (world) */
  c0: THREE.Vector3;
  v: THREE.Vector3;
  axis: THREE.Vector3;
  spin: number;
  /** time of ground contact, centroid height at rest */
  tg: number;
  restY: number;
}

const _fq = new THREE.Quaternion();
const _fv = new THREE.Vector3();
const _fn = new THREE.Vector3();

/**
 * A5: the hidden FRAC_* pieces of a kit asset instance (props, features, obstacles), merged into ONE mesh per material
 * (normally one: every piece uses the LOD's baked material) and animated on the CPU as rigid bodies: a hop / burst, a spin,
 * gravity, a rest on the floor, then (after `linger` s) a slow sink out of sight. The motion is an analytic function of the
 * time since spawn (seeded per object), so a seek lands on the same picture. The intact mesh is hidden by the caller, so a
 * breaking object costs the same draw calls as the intact one. Vertex positions are rewritten only while pieces move.
 */
export class FracSet {
  readonly meshes: THREE.Mesh[] = [];
  private pieces: { mesh: THREE.Mesh; base: Float32Array; baseN: Float32Array | null; list: FracPiece[] }[] = [];
  private lastT = -1;
  private linger: number;
  private sinkT: number;
  /** seconds until every piece rests; after linger + sink the set is finished */
  readonly settle: number;
  constructor(
    owner: THREE.Object3D,
    mode: FracMode,
    seed: number,
    opts: { dir?: THREE.Vector3; speed?: number; linger?: number; sink?: number } = {},
  ) {
    this.linger = opts.linger ?? (mode === 'lie' ? 10 : 6);
    this.sinkT = opts.sink ?? 1.6;
    owner.updateMatrixWorld(true);
    const byMat = new Map<THREE.Material, THREE.Mesh[]>();
    owner.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !o.userData.frac) return;
      const k = m.material as THREE.Material;
      if (!byMat.has(k)) byMat.set(k, []);
      byMat.get(k)!.push(m);
    });
    const rnd = new R(seed * 7919 + 17);
    const dir = opts.dir ?? new THREE.Vector3(1, 0, 0);
    const speed = opts.speed ?? 1;
    // centre of the whole set (burst direction)
    const all = new THREE.Box3();
    for (const list of byMat.values()) for (const m of list) all.expandByObject(m);
    const center = all.getCenter(new THREE.Vector3());
    let settle = 0;
    for (const [mat, list] of byMat) {
      const pos: number[] = [],
        nor: number[] = [],
        uv: number[] = [];
      const idx: number[] = [];
      const pcs: FracPiece[] = [];
      for (const m of list) {
        const g = m.geometry;
        const P = g.attributes.position as THREE.BufferAttribute;
        const N = g.attributes.normal as THREE.BufferAttribute | undefined;
        const U = g.attributes.uv as THREE.BufferAttribute | undefined;
        const nm = new THREE.Matrix3().getNormalMatrix(m.matrixWorld);
        const base = pos.length / 3;
        const c0 = new THREE.Vector3();
        for (let i = 0; i < P.count; i++) {
          _fv.fromBufferAttribute(P, i).applyMatrix4(m.matrixWorld);
          pos.push(_fv.x, _fv.y, _fv.z);
          c0.add(_fv);
          if (N) {
            _fn.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
            nor.push(_fn.x, _fn.y, _fn.z);
          }
          uv.push(U ? U.getX(i) : 0, U ? U.getY(i) : 0);
        }
        c0.multiplyScalar(1 / Math.max(1, P.count));
        if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i));
        else for (let i = 0; i < P.count; i++) idx.push(base + i);
        // motion: 'lie' = a short hop away from the impact along the fall line, rolling about the line; 'burst' = outward
        const out = _fv.copy(c0).sub(center).setY(0);
        if (out.lengthSq() < 1e-6) out.set(rnd.range(-1, 1), 0, rnd.range(-1, 1));
        out.normalize();
        const v = new THREE.Vector3();
        let axis: THREE.Vector3, spin: number;
        if (mode === 'lie') {
          const along = Math.max(0, c0.clone().sub(owner.getWorldPosition(new THREE.Vector3())).dot(dir));
          v.copy(dir).multiplyScalar(speed * (0.25 + 0.18 * along) * rnd.range(0.6, 1.2)).addScaledVector(out, rnd.range(0.2, 0.9)).setY(rnd.range(0.6, 2.2));
          axis = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
          if (rnd.next() < 0.5) axis.negate();
          axis.add(new THREE.Vector3(rnd.range(-0.3, 0.3), rnd.range(-0.3, 0.3), rnd.range(-0.3, 0.3))).normalize();
          spin = rnd.range(0.6, 2.4);
        } else {
          v.copy(out).multiplyScalar(speed * rnd.range(1.2, 3.2)).setY(speed * rnd.range(1.6, 3.6));
          axis = new THREE.Vector3(rnd.range(-1, 1), rnd.range(-1, 1), rnd.range(-1, 1)).normalize();
          spin = rnd.range(3, 9);
        }
        pcs.push({ start: base, count: P.count, c0, v, axis, spin, tg: 0, restY: 0 });
      }
      // rest height and contact time per piece (lowest vertex on the floor at its final rotation, embedded 2 cm)
      const posArr = new Float32Array(pos);
      for (const pc of pcs) {
        let tg = 0.25;
        for (let it = 0; it < 3; it++) {
          _fq.setFromAxisAngle(pc.axis, pc.spin * tg);
          let lo = Infinity;
          for (let i = pc.start; i < pc.start + pc.count; i++) {
            _fv.set(posArr[i * 3] - pc.c0.x, posArr[i * 3 + 1] - pc.c0.y, posArr[i * 3 + 2] - pc.c0.z).applyQuaternion(_fq);
            lo = Math.min(lo, _fv.y);
          }
          pc.restY = -lo - 0.02;
          // y(t) = c0y + vy t - 4.9 t^2 = restY  ->  the later root
          const a = -4.9,
            b = pc.v.y,
            c = pc.c0.y - pc.restY;
          const disc = b * b - 4 * a * c;
          tg = disc > 0 ? Math.max(0.12, (-b - Math.sqrt(disc)) / (2 * a)) : 0.3;
        }
        pc.tg = tg;
        settle = Math.max(settle, tg);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(posArr.slice(), 3));
      if (nor.length === pos.length) g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
      else g.computeVertexNormals();
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
      g.setIndex(idx);
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.name = 'fracSet';
      // the material is the asset's (or the obstacle's crack clone, owned by the obstacle): the arena must not dispose it here
      mesh.userData.sharedMat = true;
      mesh.userData.dyn = true;
      this.meshes.push(mesh);
      this.pieces.push({ mesh, base: posArr, baseN: nor.length === pos.length ? new Float32Array(nor) : null, list: pcs });
    }
    this.settle = settle;
  }

  /** true once every piece has sunk out of sight */
  get finished() {
    return this.lastT >= this.settle + this.linger + this.sinkT;
  }

  /** pose at `t` seconds after the spawn (analytic: seeks land on the same picture) */
  update(t: number) {
    t = Math.max(0, t);
    const end = this.settle + this.linger + this.sinkT;
    if (this.lastT >= 0 && ((t >= end && this.lastT >= end) || (t > this.settle && this.lastT > this.settle && t < this.settle + this.linger && this.lastT < this.settle + this.linger))) {
      this.lastT = t;
      return;
    }
    this.lastT = t;
    const sink = Math.max(0, Math.min(1, (t - this.settle - this.linger) / this.sinkT));
    for (const s of this.pieces) {
      const P = s.mesh.geometry.attributes.position as THREE.BufferAttribute;
      const N = s.mesh.geometry.attributes.normal as THREE.BufferAttribute | undefined;
      const pa = P.array as Float32Array;
      const na = N?.array as Float32Array | undefined;
      for (const pc of s.list) {
        const tt = Math.min(t, pc.tg);
        // after contact: a little slide along the throw, decaying
        const slide = t > pc.tg ? 0.12 * (1 - Math.exp(-(t - pc.tg) * 5)) : 0;
        const cx = pc.c0.x + pc.v.x * (tt + slide),
          cz = pc.c0.z + pc.v.z * (tt + slide);
        let cy = t >= pc.tg ? pc.restY : pc.c0.y + pc.v.y * tt - 4.9 * tt * tt;
        cy -= sink * 0.9;
        _fq.setFromAxisAngle(pc.axis, pc.spin * tt);
        const b = s.base;
        for (let i = pc.start; i < pc.start + pc.count; i++) {
          _fv.set(b[i * 3] - pc.c0.x, b[i * 3 + 1] - pc.c0.y, b[i * 3 + 2] - pc.c0.z).applyQuaternion(_fq);
          pa[i * 3] = cx + _fv.x;
          pa[i * 3 + 1] = cy + _fv.y;
          pa[i * 3 + 2] = cz + _fv.z;
          if (na && s.baseN) {
            _fn.set(s.baseN[i * 3], s.baseN[i * 3 + 1], s.baseN[i * 3 + 2]).applyQuaternion(_fq);
            na[i * 3] = _fn.x;
            na[i * 3 + 1] = _fn.y;
            na[i * 3 + 2] = _fn.z;
          }
        }
      }
      P.needsUpdate = true;
      if (N) N.needsUpdate = true;
      s.mesh.visible = sink < 1;
    }
  }

  dispose() {
    for (const m of this.meshes) {
      m.removeFromParent();
      m.geometry.dispose();
    }
  }
}

/** Floor decal layer over the arena (rx, rz extents). */
export class Decals {
  mesh: THREE.Mesh;
  private c: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private W: number;
  private H: number;
  private rnd = new R(5);
  constructor(rx: number, rz: number, opts: { tint?: string } = {}) {
    this.W = rx + 2;
    this.H = rz + 2;
    this.c = document.createElement('canvas');
    this.c.width = 1024;
    this.c.height = Math.round((1024 * this.H) / this.W);
    this.g = this.c.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.c);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshStandardMaterial({ map: this.tex, transparent: true, depthWrite: false, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, color: opts.tint ?? '#ffffff' });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(this.W * 2, this.H * 2), mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0.012;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
  }
  private px(x: number, z: number): [number, number] {
    return [((x + this.W) / (this.W * 2)) * this.c.width, ((z + this.H) / (this.H * 2)) * this.c.height];
  }
  private k() {
    return this.c.width / (this.W * 2);
  }
  scorch(x: number, z: number, r: number) {
    const [u, v] = this.px(x, z);
    const R0 = r * this.k();
    const grd = this.g.createRadialGradient(u, v, 0, u, v, R0);
    grd.addColorStop(0, 'rgba(10,6,4,0.85)');
    grd.addColorStop(0.5, 'rgba(25,14,8,0.55)');
    grd.addColorStop(1, 'rgba(30,20,10,0)');
    this.g.fillStyle = grd;
    this.g.beginPath();
    this.g.arc(u, v, R0, 0, Math.PI * 2);
    this.g.fill();
    this.crack(x, z, r * 0.8, 7, 0.5);
    this.tex.needsUpdate = true;
  }
  crack(x: number, z: number, r: number, branches = 6, alpha = 0.7) {
    const [u, v] = this.px(x, z);
    const k = this.k();
    const g = this.g;
    g.strokeStyle = `rgba(20,14,10,${alpha})`;
    g.lineCap = 'round';
    const rnd = this.rnd;
    for (let b = 0; b < branches; b++) {
      let a = rnd.next() * Math.PI * 2;
      let px = u,
        py = v;
      let w = 3.2;
      const steps = 5 + Math.floor(rnd.next() * 4);
      for (let i = 0; i < steps; i++) {
        a += rnd.range(-0.6, 0.6);
        const len = ((r * k) / steps) * rnd.range(0.7, 1.3);
        const nx = px + Math.cos(a) * len,
          ny = py + Math.sin(a) * len;
        g.lineWidth = w;
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(nx, ny);
        g.stroke();
        px = nx;
        py = ny;
        w *= 0.78;
      }
    }
    this.tex.needsUpdate = true;
  }
  scuff(x: number, z: number, dx: number, dz: number, len = 0.8) {
    const [u, v] = this.px(x, z);
    const k = this.k();
    const g = this.g;
    g.strokeStyle = 'rgba(40,28,18,0.18)';
    g.lineWidth = 0.18 * k;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(u, v);
    g.lineTo(u + dx * len * k, v + dz * len * k);
    g.stroke();
    this.tex.needsUpdate = true;
  }
  clear() {
    this.g.clearRect(0, 0, this.c.width, this.c.height);
    this.tex.needsUpdate = true;
  }
}
