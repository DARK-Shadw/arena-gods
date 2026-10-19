/**
 * A4 CHAINS (arena art plan 5.2 / 6.5): kit/chain_link (LINK_big, LINK_small) laid along catenaries and drawn as ONE
 * InstancedMesh per link type. Swing runs in the vertex shader: every link carries (lateral swing vector, position t along
 * its chain, phase) in an instance attribute; the offset is sin(time + phase) x 4 t (1 - t), so the ends stay put and the
 * belly swings. Phases are derived from the chain endpoints (deterministic, no Math.random). CPU per frame: the shared
 * `swayTime` uniform (cloth.ts). Straight chains (the chain-weight hazard) use amp 0 and swing with their parent group.
 */
import * as THREE from 'three';
import type { KitAsset } from './assets';
import { nodeGeo, swayOn, swayTime } from './cloth';

export type LinkKind = 'big' | 'small';

interface LinkSpec {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  pitch: number;
}

const X = new THREE.Vector3(1, 0, 0);

/** A19: the wind's swing gain for chain kits built with `{ wind: true }` (the kit Moon Gate; others never read it) */
export const chainWind = { value: 1 };

/** a link material clone that adds the instance swing offset after the instance transform */
function swingMaterial(src: THREE.MeshStandardMaterial, wind = false): THREE.MeshStandardMaterial {
  const m = src.clone();
  m.name = `${src.name}_swing`;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uSwayTime = swayTime;
    sh.uniforms.uSwayOn = swayOn;
    if (wind) sh.uniforms.uSwayWind = chainWind;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uSwayTime; uniform float uSwayOn; attribute vec4 aSwing;' + (wind ? ' uniform float uSwayWind;' : ''))
      .replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
  float wSw = 4.0 * aSwing.z * (1.0 - aSwing.z) * uSwayOn${wind ? ' * uSwayWind' : ''};
  float sSw = sin(uSwayTime * 0.85 + aSwing.w) + 0.3 * sin(uSwayTime * 1.9 + aSwing.w * 2.3);
  mvPosition.xyz += vec3(aSwing.x, 0.0, aSwing.y) * sSw * wSw + vec3(0.0, -0.25 * abs(aSwing.x + aSwing.y) * (1.0 - cos(sSw * 0.6)) * wSw, 0.0);
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  m.customProgramCacheKey = () => `swing|${src.uuid}${wind ? '|wind' : ''}`;
  return m;
}

/** builder: collect chains, then build() one InstancedMesh per link kind */
export class ChainKit {
  private spec = new Map<LinkKind, LinkSpec>();
  private links: Record<LinkKind, { m: THREE.Matrix4; sw: [number, number, number, number] }[]> = { big: [], small: [] };
  private owned: THREE.Material[] = [];
  private geos: THREE.BufferGeometry[] = [];

  constructor(
    readonly asset: KitAsset,
    private opts: { wind?: boolean } = {},
  ) {
    const x = asset.extras;
    for (const [kind, node, pitch] of [
      ['big', 'LINK_big', Number(x.pitchBig) || 0.138],
      ['small', 'LINK_small', Number(x.pitchSmall) || 0.068],
    ] as const) {
      const n = nodeGeo(asset, node);
      if (!n) continue;
      // centre the link on its own bounding box (the bake laid the two links side by side)
      n.geo.computeBoundingBox();
      const c = n.geo.boundingBox!.getCenter(new THREE.Vector3());
      n.geo.translate(-c.x, -c.y, -c.z);
      n.geo.computeBoundingSphere();
      const mat = swingMaterial(n.mat as THREE.MeshStandardMaterial, !!this.opts.wind);
      this.owned.push(mat);
      this.geos.push(n.geo);
      this.spec.set(kind, { geo: n.geo, mat, pitch });
    }
  }

  get ok() {
    return this.spec.size > 0;
  }

  /**
   * a hanging chain from a to b with `sag` metres of droop at the middle (parabola ~ catenary for small sag); swing =
   * lateral swing amplitude at the middle (m), 0 = still. Returns the number of links.
   */
  hang(a: THREE.Vector3, b: THREE.Vector3, sag: number, kind: LinkKind = 'big', swing = 0.06, scale = 1): number {
    const S = this.spec.get(kind) ?? this.spec.values().next().value;
    if (!S) return 0;
    const pitch = S.pitch * scale;
    const N = 64;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      pts.push(new THREE.Vector3().lerpVectors(a, b, t).add(new THREE.Vector3(0, -sag * 4 * t * (1 - t), 0)));
    }
    const cum = [0];
    for (let i = 1; i <= N; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const L = cum[N];
    const n = Math.max(1, Math.floor(L / pitch));
    const horiz = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
    const lat = horiz.lengthSq() > 1e-6 ? new THREE.Vector3(-horiz.z, 0, horiz.x).normalize() : new THREE.Vector3(1, 0, 0);
    const phase = (a.x * 0.37 + a.z * 0.91 + b.x * 0.53 + b.z * 0.29) % (Math.PI * 2);
    const q = new THREE.Quaternion();
    const roll = new THREE.Quaternion();
    let j = 0;
    for (let k = 0; k < n; k++) {
      const s = (k + 0.5) * (L / n);
      while (j < N - 1 && cum[j + 1] < s) j++;
      const f = (s - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]);
      const p = new THREE.Vector3().lerpVectors(pts[j], pts[j + 1], f);
      const d = new THREE.Vector3().subVectors(pts[j + 1], pts[j]).normalize();
      q.setFromUnitVectors(X, d);
      roll.setFromAxisAngle(d, k % 2 ? Math.PI / 2 : 0);
      q.premultiply(roll);
      const m = new THREE.Matrix4().compose(p, q, new THREE.Vector3(scale, scale, scale));
      const t = s / L;
      this.links[kind === 'small' && this.spec.has('small') ? 'small' : this.spec.has('big') ? 'big' : 'small'].push({ m, sw: [lat.x * swing, lat.z * swing, t, phase] });
    }
    return n;
  }

  /** a straight vertical run of links from y0 down to y1 at (x, z) (no swing): hazard chains, rod hangers */
  straight(x: number, y0: number, y1: number, z: number, kind: LinkKind = 'big', scale = 1): number {
    return this.hang(new THREE.Vector3(x, y0, z), new THREE.Vector3(x, y1, z), 0, kind, 0, scale);
  }

  /** the instanced meshes (one per link kind used); call once */
  build(name = 'kitChains'): THREE.InstancedMesh[] {
    const out: THREE.InstancedMesh[] = [];
    for (const kind of ['big', 'small'] as LinkKind[]) {
      const L = this.links[kind];
      const S = this.spec.get(kind);
      if (!L.length || !S) continue;
      const geo = S.geo.clone();
      const sw = new Float32Array(L.length * 4);
      L.forEach((l, i) => sw.set(l.sw, i * 4));
      geo.setAttribute('aSwing', new THREE.InstancedBufferAttribute(sw, 4));
      const im = new THREE.InstancedMesh(geo, S.mat, L.length);
      L.forEach((l, i) => im.setMatrixAt(i, l.m));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = true;
      im.receiveShadow = true;
      im.name = `${name}_${kind}`;
      im.userData.dyn = true;
      im.frustumCulled = true;
      out.push(im);
      this.links[kind] = [];
    }
    return out;
  }

  /** materials / base geometries this builder created (instanced geometries belong to their meshes) */
  dispose() {
    for (const m of this.owned) m.dispose();
    for (const g of this.geos) g.dispose();
  }
}
