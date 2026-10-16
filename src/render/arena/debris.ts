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

  private pool(m: DebrisMat): Pool {
    let p = this.pools.get(m);
    if (!p) {
      const d = MATS[m];
      const mat = new THREE.MeshStandardMaterial({ color: d.color, roughness: d.rough, metalness: d.metal ?? 0, emissive: d.emissive ?? '#000000', emissiveIntensity: d.emissive ? 1.5 : 0 });
      p = new Pool(this.geo, mat);
      this.pools.set(m, p);
      this.group.add(p.mesh);
    }
    return p;
  }

  /** burst of chunks from a point; dir biases the throw */
  burst(mat: DebrisMat, at: THREE.Vector3, n: number, size: number, speed: number, dir?: THREE.Vector3, life = 4) {
    const pool = this.pool(mat);
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
