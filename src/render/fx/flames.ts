/**
 * Arena flames on flipbooks (catalog E01, the part F3 does; the full brazier with smoke, embers, heat,
 * light pools and reflection streaks is F4 with the arena session).
 *
 * `Arena.flame()` (arenaView.ts) asks `Arena.fxFlame` for the visual when it is set; the arena keeps its
 * own light and flicker. The card is a camera-facing Unity Labs flame (Flame02 for braziers and
 * firepits, Flame03 for small candles), looped with a per-flame phase from its index (deterministic),
 * premultiplied additive-alpha with a soft fade on FX_ALPHA. Theme colours far from orange (glacier
 * and skytemple fires) recolour the flame from its luminance. Textures arrive asynchronously: the card
 * stays hidden until its atlas is loaded (about a second after the page opens).
 */
import * as THREE from 'three';
import { FLIPBOOK_PARS, type FxAtlases } from './atlas';
import { LAYER } from './fxLayers';
import { SOFT_DEPTH_PARS, softDepthUniforms } from './softDepth';

const VERT = /* glsl */ `
varying vec2 vUv;
varying float vDepth;
uniform vec2 uSize;
uniform vec2 uPivot;
void main() {
  vUv = uv;
  vec4 mvPos = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 s = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
  mvPos.xy += (position.xy + uPivot) * uSize * s;
  vDepth = -mvPos.z;
  gl_Position = projectionMatrix * mvPos;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uGrid;
uniform float uFrames;
uniform float uFps;
uniform float uTime;
uniform float uPhase;
uniform vec3 uTint;
uniform float uRecolor;
uniform float uIntensity;
varying vec2 vUv;
varying float vDepth;
${SOFT_DEPTH_PARS}
${FLIPBOOK_PARS}
void main() {
  float fr = mod(uTime * uFps + uPhase * uFrames, uFrames);
  // crossfade between the last and first frame keeps the loop seamless enough (the Unity flames are not perfect loops)
  vec4 c = fbSample(uTex, uTex, 0.0, 0.0, uGrid, uFrames, fr, vUv);
  vec3 rgb = mix(c.rgb, vec3(dot(c.rgb, vec3(0.3, 0.55, 0.15))) * uTint * 1.7, uRecolor) * uIntensity;
  float f = fxSoftFade(vDepth, 0.25);
  gl_FragColor = vec4(rgb * f, c.a * f);
}`;

export class FxFlames {
  /** shared time (FX light clock: keeps burning through hit-stop) */
  readonly time = { value: 0 };
  private mats: { mat: THREE.ShaderMaterial; id: string }[] = [];
  private meshes: THREE.Mesh[] = [];
  private geo = new THREE.PlaneGeometry(1, 1);
  private quality = 2;

  constructor(private atlases: FxAtlases | null) {}

  /** a flame of `size` (the old crossed-quad height) in `color`; n = a stable index for the phase */
  make(size: number, color: string, n: number): THREE.Object3D {
    const id = size >= 0.6 ? 'unity_flame02' : 'unity_flame03';
    const c = new THREE.Color(color);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    const orange = hsl.h < 0.14 || hsl.h > 0.97;
    const mat = new THREE.ShaderMaterial({
      name: 'fx.flame',
      uniforms: {
        uTex: { value: null },
        uGrid: { value: new THREE.Vector2(16, 4) },
        uFrames: { value: 64 },
        uFps: { value: 30 },
        uTime: this.time,
        uPhase: { value: ((n * 0.6180339) % 1) },
        uTint: { value: c },
        uRecolor: { value: orange ? 0.15 : 0.85 },
        uIntensity: { value: 2.4 },
        uSize: { value: new THREE.Vector2(size * 0.85, size * 1.7) },
        uPivot: { value: new THREE.Vector2(0, 0.42) },
        ...softDepthUniforms,
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const m = new THREE.Mesh(this.geo, mat);
    m.name = 'fx.flame';
    m.frustumCulled = false;
    m.layers.set(LAYER.FX_ALPHA);
    m.visible = false;
    m.position.y = -size * 0.12;
    m.userData.dyn = true;
    this.mats.push({ mat, id });
    this.meshes.push(m);
    this.bind(mat, id, m);
    return m;
  }

  private bind(mat: THREE.ShaderMaterial, id: string, mesh?: THREE.Mesh) {
    const A = this.atlases;
    if (!A) return;
    void A.load()
      .then(() => {
        const e = A.entry(id);
        if (e.grid) mat.uniforms.uGrid.value.set(e.grid[0], e.grid[1]);
        mat.uniforms.uFrames.value = e.frames ?? 64;
        mat.uniforms.uFps.value = e.fps ?? 30;
        return A.tierTexture(id, this.quality);
      })
      .then((tex) => {
        mat.uniforms.uTex.value = tex;
        if (mesh) mesh.visible = true;
        else for (const m of this.meshes) if (m.material === mat) m.visible = true;
      })
      .catch((e) => console.warn('[fx flames]', e));
  }

  setQuality(q: number) {
    if (q === this.quality) return;
    this.quality = q;
    for (const { mat, id } of this.mats) this.bind(mat, id);
  }

  /** forget flames of a disposed arena (the arena disposes their materials with its group) */
  reset() {
    this.mats = [];
    this.meshes = [];
  }
}
