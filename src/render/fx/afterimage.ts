/**
 * Afterimage ghosts (catalog C10 dodge afterimage; plan §2.1 "Afterimage ghosts"). A small pool of
 * skinned clones per fighter (created lazily on the first dodge, never per effect) that copy the
 * fighter's pose at a snapshot time and fade out as an additive fresnel silhouette on FX_GHOST.
 *
 * Tier caps: 0 (low: dust only) / 1 / 3 ghosts per fighter (TIER_CAPS.ghosts).
 * Not reproducible across a `?t=` seek (it copies the animated pose, which carries history); the seek
 * replay skips ghosts. Each ghost costs one skinned draw while visible.
 */
import * as THREE from 'three';
import { clone as skClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { LAYER } from './fxLayers';

interface Ghost {
  root: THREE.Group;
  model: THREE.Object3D;
  pairs: [THREE.Object3D, THREE.Object3D][];
  mat: THREE.MeshBasicMaterial;
  u: { uOpacity: { value: number }; uColor: { value: THREE.Color } };
  t0: number;
  life: number;
  on: boolean;
}

const VIS_EPS = 0.01;

function ghostMaterial(u: Ghost['u']) {
  const m = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor });
  m.name = 'fx.ghost';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGN;\nvarying vec3 vGV;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGV = -mvPosition.xyz;\n#ifdef USE_SKINNING\nvGN = normalize(normalMatrix * objectNormal);\n#else\nvGN = vec3(0.0, 0.0, 1.0);\n#endif');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGN;\nvarying vec3 vGV;\nuniform float uOpacity;\nuniform vec3 uColor;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\nfloat fr = 1.0 - abs(dot(normalize(vGN), normalize(vGV)));\nfr = 0.12 + 0.88 * pow(fr, 2.2);\ngl_FragColor = vec4(uColor * fr * uOpacity, 1.0);');
  };
  m.customProgramCacheKey = () => 'fx.ghost';
  return m;
}

export class Afterimages {
  readonly group = new THREE.Group();
  private pools: Ghost[][] = [[], []];
  private sources: (THREE.Object3D | null)[] = [null, null];
  private cursor = [0, 0];
  limit = 3;

  constructor() {
    this.group.name = 'fx.ghosts';
  }

  setSource(i: number, model: THREE.Object3D | null) {
    if (this.sources[i] === model) return;
    this.sources[i] = model;
    for (const g of this.pools[i]) this.group.remove(g.root), g.mat.dispose();
    this.pools[i] = [];
    this.cursor[i] = 0;
  }

  setLimit(n: number) {
    this.limit = Math.max(0, Math.min(3, n));
  }

  /** A21: build each fighter's first ghost now (hidden), so its program compiles behind the loading screen; the pool
   * order and the cursor are the same as when snap() builds it later */
  prewarm() {
    for (let i = 0; i < 2; i++) if (this.sources[i] && this.limit > 0 && this.pools[i].length === 0) this.make(i);
  }

  private ghost(i: number): Ghost | null {
    const src = this.sources[i];
    if (!src || this.limit <= 0) return null;
    const pool = this.pools[i];
    if (pool.length < this.limit) this.make(i);
    const g = pool[this.cursor[i] % Math.min(pool.length, this.limit)];
    this.cursor[i]++;
    return g;
  }

  private make(i: number) {
    const src = this.sources[i]!;
    const pool = this.pools[i];
    {
      const model = skClone(src);
      const u = { uOpacity: { value: 0 }, uColor: { value: new THREE.Color() } };
      const mat = ghostMaterial(u);
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        o.layers.set(LAYER.FX_GHOST);
        if (m.isMesh) {
          m.material = mat;
          m.castShadow = m.receiveShadow = false;
          m.frustumCulled = false;
        }
      });
      const root = new THREE.Group();
      root.matrixAutoUpdate = false;
      root.add(model);
      root.visible = false;
      this.group.add(root);
      const a: THREE.Object3D[] = [],
        b: THREE.Object3D[] = [];
      src.traverse((o) => a.push(o));
      model.traverse((o) => b.push(o));
      const pairs: [THREE.Object3D, THREE.Object3D][] = [];
      for (let k = 0; k < Math.min(a.length, b.length); k++) if ((a[k] as THREE.Bone).isBone) pairs.push([a[k], b[k]]);
      pool.push({ root, model, pairs, mat, u, t0: 0, life: 0, on: false });
    }
  }

  /** copy fighter i's current pose into a ghost that shows from t0 for `life` seconds */
  snap(i: number, t0: number, life: number, color: THREE.ColorRepresentation, strength = 1) {
    const g = this.ghost(i);
    const src = this.sources[i];
    if (!g || !src) return;
    src.updateMatrixWorld(true);
    g.root.matrix.copy(src.parent ? src.parent.matrixWorld : new THREE.Matrix4());
    g.root.matrixWorldNeedsUpdate = true;
    g.model.position.copy(src.position);
    g.model.quaternion.copy(src.quaternion);
    g.model.scale.copy(src.scale);
    for (const [s, d] of g.pairs) {
      d.position.copy(s.position);
      d.quaternion.copy(s.quaternion);
      d.scale.copy(s.scale);
    }
    g.u.uColor.value.set(color).multiplyScalar(strength);
    g.t0 = t0;
    g.life = life;
    g.on = true;
  }

  update(t: number) {
    for (const pool of this.pools)
      for (const g of pool) {
        if (!g.on) continue;
        const k = (t - g.t0) / g.life;
        if (k >= 1) {
          g.on = false;
          g.root.visible = false;
          continue;
        }
        const op = k < 0 ? 0 : (1 - k) * (1 - k);
        g.u.uOpacity.value = op;
        g.root.visible = op > VIS_EPS;
      }
  }

  /** visible ghosts (stats) */
  get live(): number {
    let n = 0;
    for (const pool of this.pools) for (const g of pool) if (g.root.visible) n++;
    return n;
  }

  clear() {
    for (const pool of this.pools) for (const g of pool) (g.on = false), (g.root.visible = false);
  }

  dispose() {
    for (const pool of this.pools) for (const g of pool) g.mat.dispose();
    this.pools = [[], []];
    this.group.removeFromParent();
  }
}
