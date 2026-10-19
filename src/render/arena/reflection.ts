/**
 * WET-FLOOR REFLECTIONS (arena art plan 6.1, milestone A2).
 *
 * medium / high: a PLANAR reflection of the y = 0 floor. A mirrored camera renders only what is tagged for it:
 *   LAYER_REFLECT     sky, boundary walls / stands / gates, obstacles, big props, the ring of fire, arena flames
 *                     (Arena.tagReflect), plus the FX_ADD layer (sparks, explosions: the FX plan's requirement)
 *   LAYER_REFLECT_HI  fighters, high tier only
 * into a small HDR target (REFLECT_TIERS: 1/2 x 1/2 on medium, 0.7 x 0.7 on high) with a mip chain. The floor
 * shader (floor.ts) projects into it with `uReflMatrix`, picks the mip from its roughness, distorts it with its
 * normal, stretches it vertically (wet-floor streaks) and lets the standard IBL BRDF apply the Fresnel term.
 * The pass runs from Post's pre-scene hook (post.ts `preScene`, timer key 'reflect').
 *
 * low: no planar pass. The floor reflects the baked environment probe (scene.environment: the sky with the moon)
 * through the same BRDF, and every flame gets a STREAK CARD (StreakCards): an additive floor quad stretched from
 * the flame's reflection point toward the camera, broken up by the floor's water mask.
 *
 * The mirrored camera is Reflector's virtual camera rotated 180 degrees about its view axis (same frustum, world
 * up stays up), so camera-facing FX cards (flames) still rise in the reflection; an oblique near plane clips what
 * is below the floor. Shadow maps are not re-rendered for the reflection (the previous frame's are reused), the
 * soft-particle depth fade is off for it (the linear depth belongs to the main camera), and every scene light is
 * tagged too so the lights state (and thus the shader programs) stays the same as in the main pass.
 */
import * as THREE from 'three';
import { LAYER } from '../fx/fxLayers';
import { softDepthUniforms } from '../fx/softDepth';

export const LAYER_REFLECT = 24;
export const LAYER_REFLECT_HI = 25;

export interface ReflectTier {
  on: boolean;
  /** target width relative to the scene target */
  scale: number;
  /** target height relative to the scene target: the frustum is CROPPED to the rows the visible floor can
   *  reflect (usually under half of the full mirrored frustum), so this is scale x the expected crop */
  hScale: number;
  fighters: boolean;
  /** refresh the target every other frame (the floor samples the previous one with its own matrix); a camera
   *  cut or a fast move forces a refresh */
  halfRate: boolean;
}
/**
 * plan 6.6: probe + streak cards on low, planar on medium and high (plus fighters). Sizes measured against the
 * 0.8 / 1.5 ms budgets on the Arc iGPU (docs/milestones/A2/README.md): the pass costs about 6 ms per million
 * pixels here (walls with every light and shadow), so the target is small and cropped.
 */
export const REFLECT_TIERS: Record<0 | 1 | 2, ReflectTier> = {
  0: { on: false, scale: 0, hScale: 0, fighters: false, halfRate: false },
  1: { on: true, scale: 0.35, hScale: 0.35 * 0.42, fighters: false, halfRate: true },
  2: { on: true, scale: 0.45, hScale: 0.45 * 0.44, fighters: true, halfRate: true },
};

/** `?refl=0` turns the planar pass off (A/B timing; the floor falls back to the probe) */
export const reflOverride = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('refl') : null;

/** uniforms shared with the floor material */
export interface ReflectUniforms {
  tRefl: { value: THREE.Texture | null };
  uReflMatrix: { value: THREE.Matrix4 };
  uReflOn: { value: number };
  uReflLod: { value: number };
  uReflTexel: { value: THREE.Vector2 };
}

const _plane = new THREE.Plane();
const _normal = new THREE.Vector3(0, 1, 0);
const _camPos = new THREE.Vector3();
const _rot = new THREE.Matrix4();
const _look = new THREE.Vector3();
const _target = new THREE.Vector3();
const _view = new THREE.Vector3();
const _q = new THREE.Vector4();
const _clip = new THREE.Vector4();
const _crop = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _vp = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _w = new THREE.Vector3();
const _bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

export class PlanarReflection {
  readonly camera = new THREE.PerspectiveCamera();
  readonly uniforms: ReflectUniforms = {
    tRefl: { value: null },
    uReflMatrix: { value: new THREE.Matrix4() },
    uReflOn: { value: 0 },
    uReflLod: { value: 0 },
    uReflTexel: { value: new THREE.Vector2(1, 1) },
  };
  /** the floor height (always 0: the sim is 2D) */
  y = 0;
  private rt: THREE.WebGLRenderTarget | null = null;
  private lights: THREE.Light[] = [];
  private lightScan = 0;
  private scanned: THREE.Object3D | null = null;
  frames = 0;
  skipped = 0;
  private parity = 0;
  private rendered: THREE.WebGLRenderTarget | null = null;
  private lastPos = new THREE.Vector3(1e9, 0, 0);
  private lastQuat = new THREE.Quaternion();
  /** debug / measurement overrides of the tier (tools: perf experiments), e.g. { scale: 0.3, mask: 1 << 24 } */
  debug: Partial<ReflectTier> & { mask?: number } = {};

  private ensure(w: number, h: number) {
    if (this.rt && this.rt.width === w && this.rt.height === h) return this.rt;
    this.rt?.dispose();
    this.rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });
    this.rt.texture.name = 'arena.reflection';
    this.uniforms.tRefl.value = this.rt.texture;
    this.uniforms.uReflLod.value = Math.floor(Math.log2(Math.max(w, h)));
    this.uniforms.uReflTexel.value.set(1 / w, 1 / h);
    return this.rt;
  }

  /** every light gets the reflect layer (same lights state in both passes -> no program switches) */
  private syncLights(scene: THREE.Scene) {
    if (this.scanned === scene && this.lightScan-- > 0) return;
    this.scanned = scene;
    this.lightScan = 30;
    this.lights.length = 0;
    scene.traverse((o) => {
      if ((o as THREE.Light).isLight) this.lights.push(o as THREE.Light);
    });
    for (const l of this.lights) {
      l.layers.enable(LAYER_REFLECT);
      l.layers.enable(LAYER_REFLECT_HI);
    }
  }

  /** mirrored camera + the texture matrix (Reflector's maths, rotated 180 deg about the view axis) */
  /** NDC y range (in the mirrored camera) of the floor the main camera sees; null = no floor in view */
  crop: [number, number] | null = null;
  private floorRows(cam: THREE.PerspectiveCamera, vc: THREE.PerspectiveCamera): [number, number] | null {
    _vp.multiplyMatrices(vc.projectionMatrix, vc.matrixWorldInverse);
    let lo = 1e9,
      hi = -1e9;
    let any = false;
    for (const sx of [-1, 0, 1])
      for (const sy of [-1, -0.5, 0, 0.5, 1]) {
        _p.set(sx, sy, 0.5).unproject(cam).sub(_camPos).normalize();
        let d: number;
        if (_p.y < -1e-4) d = Math.min(150, (_camPos.y - this.y) / -_p.y);
        else if (sy === 1 || sy === 0.5) d = 150; // above the horizon: its far floor edge
        else continue;
        if (_p.y >= -1e-4) _p.y = 0;
        _w.copy(_camPos).addScaledVector(_p, d);
        _w.y = this.y;
        any = true;
        _w.applyMatrix4(_vp);
        lo = Math.min(lo, _w.y);
        hi = Math.max(hi, _w.y);
      }
    if (!any) return null;
    lo = Math.max(-1, lo - 0.06);
    hi = Math.min(1, hi + 0.06);
    return hi - lo > 0.02 ? [lo, hi] : null;
  }

  private place(cam: THREE.PerspectiveCamera): boolean {
    const vc = this.camera;
    _camPos.setFromMatrixPosition(cam.matrixWorld);
    _view.set(_camPos.x, 2 * this.y - _camPos.y, _camPos.z);
    _rot.extractRotation(cam.matrixWorld);
    _look.set(0, 0, -1).applyMatrix4(_rot).add(_camPos);
    _target.copy(_look);
    _target.y = 2 * this.y - _target.y;
    vc.position.copy(_view);
    // Reflector uses up = reflect(camera up); its negative gives the same (centrally symmetric) frustum with world up up
    vc.up.set(0, 1, 0).applyMatrix4(_rot);
    vc.up.y = -vc.up.y;
    vc.up.negate();
    vc.lookAt(_target);
    vc.near = cam.near;
    vc.far = cam.far;
    vc.fov = cam.fov;
    vc.aspect = cam.aspect;
    vc.zoom = cam.zoom;
    vc.updateMatrixWorld();
    vc.updateProjectionMatrix();
    vc.projectionMatrix.copy(cam.projectionMatrix);
    // crop the frustum to the rows the visible floor reflects (asymmetric frustum: no pixels spent on the
    // half of the mirrored view that looks under the floor)
    this.crop = this.floorRows(cam, vc);
    if (!this.crop) return false;
    const [y0, y1] = this.crop;
    const c = (y0 + y1) / 2,
      hh = (y1 - y0) / 2;
    _crop.set(1, 0, 0, 0, 0, 1 / hh, 0, -c / hh, 0, 0, 1, 0, 0, 0, 0, 1);
    vc.projectionMatrix.premultiply(_crop);
    // texture matrix: world -> reflection uv
    this.uniforms.uReflMatrix.value.copy(_bias).multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);
    // oblique near plane = the floor (clips everything below it)
    _plane.setFromNormalAndCoplanarPoint(_normal, _target.set(0, this.y, 0));
    _plane.applyMatrix4(vc.matrixWorldInverse);
    _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
    const P = vc.projectionMatrix;
    const e = P.elements;
    _q.x = (Math.sign(_clip.x) + e[8]) / e[0];
    _q.y = (Math.sign(_clip.y) + e[9]) / e[5];
    _q.z = -1.0;
    _q.w = (1.0 + e[10]) / e[14];
    _clip.multiplyScalar(2.0 / _clip.dot(_q));
    e[2] = _clip.x;
    e[6] = _clip.y;
    e[10] = _clip.z + 1.0 - 0.003; // small clip bias: no z-fighting seam at the contact line
    e[14] = _clip.w;
    return true;
  }

  /**
   * render the reflection (call before the main scene pass). `size` = the scene target's size (pixels),
   * `quality` = the post tier. Returns false when the tier has no planar pass.
   */
  render(r: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.PerspectiveCamera, size: THREE.Vector2, quality: number): boolean {
    const T = { ...REFLECT_TIERS[Math.max(0, Math.min(2, quality)) as 0 | 1 | 2], ...this.debug };
    const on = T.on && reflOverride !== '0';
    this.uniforms.uReflOn.value = on ? 1 : 0;
    if (!on) return false;
    const w = Math.max(16, Math.round(size.x * T.scale)),
      h = Math.max(16, Math.round(size.y * T.hScale));
    const rt = this.ensure(w, h);
    // half rate: skip every other frame unless the camera moved more than 0.3 m / 4 deg since the last render
    this.parity ^= 1;
    if (T.halfRate && this.parity && this.rendered === rt) {
      const moved = this.lastPos.distanceToSquared(_camPos.setFromMatrixPosition(cam.matrixWorld)) > 0.09;
      const turned = Math.abs(this.lastQuat.dot(_quat.setFromRotationMatrix(cam.matrixWorld))) < 0.99939;
      if (!moved && !turned) {
        this.skipped++;
        return true;
      }
    }
    this.syncLights(scene);
    if (!this.place(cam)) {
      this.uniforms.uReflOn.value = 0;
      return false;
    }
    const vc = this.camera;
    vc.layers.mask = this.debug.mask ?? (1 << LAYER_REFLECT) | (1 << LAYER.FX_ADD) | (T.fighters ? 1 << LAYER_REFLECT_HI : 0);
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevShadow = r.shadowMap.autoUpdate;
    const prevSoft = softDepthUniforms.uSoftOn.value;
    r.shadowMap.autoUpdate = false;
    softDepthUniforms.uSoftOn.value = 0;
    r.autoClear = false;
    r.setRenderTarget(rt);
    r.clear(true, true, true);
    r.render(scene, vc);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
    r.shadowMap.autoUpdate = prevShadow;
    softDepthUniforms.uSoftOn.value = prevSoft;
    this.frames++;
    this.rendered = rt;
    this.lastPos.setFromMatrixPosition(cam.matrixWorld);
    this.lastQuat.setFromRotationMatrix(cam.matrixWorld);
    return true;
  }

  dispose() {
    this.rt?.dispose();
    this.rt = null;
    this.uniforms.tRefl.value = null;
    this.uniforms.uReflOn.value = 0;
  }
}

// ---------------------------------------------------------------------------- low tier: streak cards

/** a light source the floor reflects (flames, lava): world position (y = height of the hot part), size, colour */
export interface FloorLightSource {
  x: number;
  y: number;
  z: number;
  size: number;
  color: THREE.Color;
  /** relative brightness */
  power: number;
  /** streak length / width multipliers (default 1; the moon path uses a long one) */
  len?: number;
  wid?: number;
}

const STREAK_VERT = /* glsl */ `
attribute vec4 aSrc;   // x, y (height), z, size
attribute vec4 aCol;   // rgb, power
attribute vec2 aShape; // length, width multipliers
uniform float uStretch;
varying vec2 vQ;
varying vec4 vCol;
varying vec2 vWorld;
varying float vDist;
varying float vMoon;
void main() {
  vMoon = aShape.x > 2.5 ? 1.0 : 0.0;
  vec2 toCam = cameraPosition.xz - aSrc.xz;
  float d = max(length(toCam), 0.05);
  vec2 dir = toCam / d;
  float c = max(cameraPosition.y, 0.1);
  float h = max(aSrc.y, 0.05);
  // the mirror image of the source seen from the camera meets the floor d * h / (c + h) from the source
  float centre = d * h / (c + h);
  // streaks are long only at grazing views: a camera high above (c / d large) sees short glints
  float graze = mix(0.12, 1.0, smoothstep(0.55, 0.08, c / d));
  float len = clamp(0.45 * d, 0.8, 9.0) * uStretch * aShape.x * graze;
  float wid = aSrc.w * 0.32 * aShape.y;
  vec2 side = vec2(-dir.y, dir.x);
  vec2 p = aSrc.xz + dir * (centre + position.y * len) + side * (position.x * wid);
  vQ = position.xy * 2.0;
  vCol = aCol;
  vWorld = p;
  vDist = d;
  gl_Position = projectionMatrix * viewMatrix * vec4(p.x, 0.015, p.y, 1.0);
}`;

const STREAK_FRAG = /* glsl */ `
uniform float uFlicker;
uniform float uGain;
uniform sampler2D uOrm;
uniform float uTile;
uniform float uWater;
uniform float uDry;
uniform float uMoonDry;
varying float vMoon;
varying vec2 vQ;
varying vec4 vCol;
varying vec2 vWorld;
varying float vDist;
void main() {
  float across = exp(-vQ.x * vQ.x * 5.0);
  float along = exp(-vQ.y * vQ.y * 2.2) * smoothstep(-1.0, -0.75, vQ.y);
  // the floor's water rank: streaks are bright on wet stone and puddles, broken on the dry tops
  float wr = uTile > 0.0 ? texture2D(uOrm, vWorld / uTile).b : 0.7;
  float wet = mix(uMoonDry >= 0.0 && vMoon > 0.5 ? uMoonDry : uDry, 1.0, smoothstep(1.0 - uWater - 0.3, 1.0 - uWater + 0.05, wr));
  float a = across * along * wet * uFlicker * uGain * vCol.a * exp(-vDist * 0.015);
  gl_FragColor = vec4(vCol.rgb * a, 1.0);
}`;

/** low tier: one additive floor streak per light source (one instanced draw) */
export class StreakCards {
  readonly mesh: THREE.InstancedMesh;
  readonly uniforms = {
    uFlicker: { value: 1 },
    uGain: { value: 1 },
    uStretch: { value: 1 },
    uOrm: { value: null as THREE.Texture | null },
    uTile: { value: 0 },
    uWater: { value: 0.35 },
    /** A8b: streak brightness left on the dry slab tops (FloorArt.streakDry) */
    uDry: { value: 0.12 },
    /** A8b: the moon path's own dry-stone brightness (-1 = uDry) */
    uMoonDry: { value: -1 },
  };
  private src: THREE.InstancedBufferAttribute;
  private col: THREE.InstancedBufferAttribute;
  private shape: THREE.InstancedBufferAttribute;
  constructor(max = 48) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.src = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    geo.setAttribute('aSrc', this.src);
    geo.setAttribute('aCol', this.col);
    this.shape = new THREE.InstancedBufferAttribute(new Float32Array(max * 2).fill(1), 2);
    geo.setAttribute('aShape', this.shape);
    const mat = new THREE.ShaderMaterial({
      name: 'arena.streaks',
      uniforms: this.uniforms,
      vertexShader: STREAK_VERT,
      fragmentShader: STREAK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.userData.dyn = true;
  }
  set(list: FloorLightSource[]) {
    const n = Math.min(list.length, this.src.count);
    for (let i = 0; i < n; i++) {
      const s = list[i];
      this.src.setXYZW(i, s.x, s.y, s.z, s.size);
      this.col.setXYZW(i, s.color.r, s.color.g, s.color.b, s.power);
      this.shape.setXY(i, s.len ?? 1, s.wid ?? 1);
    }
    this.src.needsUpdate = this.col.needsUpdate = this.shape.needsUpdate = true;
    this.mesh.count = n;
  }
}
