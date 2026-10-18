/**
 * A7 TRIM GEOMETRY: procedural stone blocks mapped onto the shared stone trim sheet (kit/stone_trim, A3), so new ring
 * architecture of ANY size (ruined tiers, stair flights, the portal, the dais, forecourt ground) merges into the ring's one
 * trim draw call with the same texel density as the baked modules. Same conventions as tools/arena/blender/kit_ring.py:
 * UV = metres / 8 (TRIM_SIZE), u = horizontal distance along the face (periodic in U), v = the position inside the face's
 * row band (stonekit.TRIM_ROWS, metres from the bottom of the sheet); a face taller / deeper than its row (2 m for ashlar
 * and blocks, 1 m for the others) is cut into strips aligned to world multiples of the row height, so courses line up
 * across neighbouring blocks. Vertex colour (RGBA, linear) = a soft ground occlusion x a per-block tint, like the modules'
 * baked COLOR_0. Render only; deterministic (the caller passes the tints).
 */
import * as THREE from 'three';

export type TrimRow = 'ashlar' | 'blocks' | 'moulding' | 'frieze' | 'rough' | 'plain';
/** row bands of the trim sheet, metres from the bottom of the 8 m sheet (stonekit.TRIM_ROWS) */
const ROWS: Record<TrimRow, [number, number]> = { ashlar: [6, 8], blocks: [4, 6], moulding: [3, 4], frieze: [2, 3], rough: [1, 2], plain: [0, 1] };
const SHEET = 8;

export interface BoxOpts {
  /** row of the vertical faces / of the top */
  side?: TrimRow;
  top?: TrimRow;
  /** per-block tint (multiplies the vertex colour) */
  tint?: number;
  /** tint of the top face (default tint x 1.05) */
  topTint?: number;
  /** skip faces: 'back' (against something), 'sides' */
  noBack?: boolean;
  noSides?: boolean;
  /** u offset so neighbouring blocks do not repeat the same stretch of the sheet */
  u0?: number;
}

export class TrimBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  /** current transform (local -> world) and its normal matrix */
  private m = new THREE.Matrix4();
  private nm = new THREE.Matrix3();
  private v = new THREE.Vector3();
  /** world height where the ground occlusion fades out */
  aoH = 1.6;
  /** occlusion at the ground */
  aoMin = 0.5;

  setMatrix(m: THREE.Matrix4) {
    this.m.copy(m);
    this.nm.getNormalMatrix(m);
    return this;
  }

  get vertexCount() {
    return this.pos.length / 3;
  }

  /**
   * a rectangle o + s U + t V (s in [0, lu], t in [0, lv]); normal = U x V. The face is cut into strips along V where
   * (vref + t) crosses a multiple of the row height; uOff shifts u.
   */
  quad(o: THREE.Vector3, U: THREE.Vector3, lu: number, V: THREE.Vector3, lv: number, row: TrimRow, vref: number, uOff: number, tint: number) {
    if (lu <= 1e-4 || lv <= 1e-4) return;
    const [r0, r1] = ROWS[row];
    const rh = r1 - r0;
    const n = new THREE.Vector3().crossVectors(U, V).normalize();
    const wn = n.clone().applyMatrix3(this.nm).normalize();
    // strip cuts
    const cuts = [0];
    let k = Math.floor(vref / rh) + 1;
    while (k * rh - vref < lv - 1e-4) {
      const t = k * rh - vref;
      if (t > 1e-4) cuts.push(t);
      k++;
    }
    cuts.push(lv);
    for (let c = 0; c < cuts.length - 1; c++) {
      const t0 = cuts[c],
        t1 = cuts[c + 1];
      const band = ((((vref + t0) % rh) + rh) % rh) - (t0 === 0 ? 0 : 0);
      const v0 = r0 + Math.min(rh - 0.002, Math.max(0.002, band));
      const v1 = r0 + Math.min(rh - 0.002, Math.max(0.002, band + (t1 - t0)));
      const base = this.pos.length / 3;
      const corners: [number, number, number, number][] = [
        [0, t0, uOff, v0],
        [lu, t0, uOff + lu, v0],
        [lu, t1, uOff + lu, v1],
        [0, t1, uOff, v1],
      ];
      for (const [s, t, u, vv] of corners) {
        this.v.copy(o).addScaledVector(U, s).addScaledVector(V, t).applyMatrix4(this.m);
        this.pos.push(this.v.x, this.v.y, this.v.z);
        this.nor.push(wn.x, wn.y, wn.z);
        this.uv.push(u / SHEET, vv / SHEET);
        const ao = this.aoMin + (1 - this.aoMin) * Math.min(1, Math.max(0, this.v.y / this.aoH));
        const c2 = ao * tint;
        this.col.push(c2, c2, c2 * 1.02, 1);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  /** an axis-aligned block in the current frame: front = +z (towards the arena), no bottom face */
  box(min: [number, number, number], max: [number, number, number], o: BoxOpts = {}) {
    const [x0, y0, z0] = min,
      [x1, y1, z1] = max;
    const side = o.side ?? 'blocks',
      top = o.top ?? 'plain',
      tint = o.tint ?? 1,
      u0 = o.u0 ?? 0;
    const w = x1 - x0,
      h = y1 - y0,
      d = z1 - z0;
    const V3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    // front (+z)
    this.quad(V3(x0, y0, z1), V3(1, 0, 0), w, V3(0, 1, 0), h, side, y0, u0 + x0, tint);
    if (!o.noBack) this.quad(V3(x1, y0, z0), V3(-1, 0, 0), w, V3(0, 1, 0), h, side, y0, u0 - x1, tint);
    if (!o.noSides) {
      this.quad(V3(x1, y0, z1), V3(0, 0, -1), d, V3(0, 1, 0), h, side, y0, u0 - z1, tint);
      this.quad(V3(x0, y0, z0), V3(0, 0, 1), d, V3(0, 1, 0), h, side, y0, u0 + z0, tint);
    }
    // top (+y): V runs towards -z
    this.quad(V3(x0, y1, z1), V3(1, 0, 0), w, V3(0, 0, -1), d, top, -z1, u0 + x0, o.topTint ?? tint * 1.05);
  }

  /** a flat ground rectangle (top only) at height y */
  ground(x0: number, x1: number, z0: number, z1: number, y: number, row: TrimRow = 'plain', tint = 0.7) {
    this.quad(new THREE.Vector3(x0, y, z1), new THREE.Vector3(1, 0, 0), x1 - x0, new THREE.Vector3(0, 0, -1), z1 - z0, row, -z1, x0, tint);
  }

  /** a single vertical face (front = +z of the current frame) */
  wall(x0: number, x1: number, y0: number, y1: number, z: number, row: TrimRow, tint = 1) {
    this.quad(new THREE.Vector3(x0, y0, z), new THREE.Vector3(1, 0, 0), x1 - x0, new THREE.Vector3(0, 1, 0), y1 - y0, row, y0, x0, tint);
  }

  /** the geometry (position, normal, uv, colour RGBA), indexed; null when empty */
  build(): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}
