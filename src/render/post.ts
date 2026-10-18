/**
 * Post-processing (F1 rewrite of the EffectComposer chain; plan §2.2, §2.4, §2.6).
 *
 *   0 reflect   (A2) pre-scene hook `preScene`: the arena's planar floor reflection + light map    [med, high]
 *   1 scene     WORLD layer -> sceneRT (HDR, DepthTexture = THE shared scene depth, optional MSAA)
 *   2 depth     shared depth -> half-res RGBA16F: A = linear depth (soft particles, distortion),
 *               RGB = normals rebuilt from depth for GTAO                            [med, high]
 *   3 ao        GTAO reads the shared depth + those normals (no second scene render) and
 *               multiplies into sceneRT                                              [high]
 *   4 fx        FX_ADD / FX_ALPHA / FX_GHOST layers -> sceneRT, hardware depth test against the
 *               shared depth + soft fade from the linear copy
 *   5 dist      FX_DIST layer -> half-res RG16F screen offsets (only while sprites live) [med: heavy, high]
 *   6 rays      god rays + NaN sanitise, only while the sun is on screen             [high]
 *   7 dof       Bokeh reading the shared depth (no own depth render)                  [med, high]
 *   8 bloom     dual-filter bloom: soft-knee prefilter, 4-5 downsamples, tent upsamples
 *   9 final     distortion offset + chromatic aberration + bloom add + grade (theme + F1 look +
 *               presets) + vignette + flash + tone mapping + sRGB, straight to the canvas
 *
 * Verified in r170 (docs/milestones/F1/README.md, "shared depth"): GTAOPass accepts an external
 * DepthTexture but its stock setGBuffer() throws (reads normalRenderTarget, which only exists
 * when GTAO renders its own G-buffer), hence AOPass below; a DepthTexture on a multisampled
 * target is resolved by three and samples correctly; R16F / RG16F targets render on the Arc
 * (ANGLE D3D11) driver.
 *
 * Quality tiers: POST_TIERS (0 low, 1 medium, 2 high). GPU cost per pass: setProfiling(true),
 * gpuTimes() (EXT_disjoint_timer_query_webgl2; tools/shots/postprobe.cjs).
 */
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { BokehShader } from 'three/examples/jsm/shaders/BokehShader.js';
import type { Grade } from './arena/themes';
import { MASK_DIST, MASK_FX, MASK_WORLD } from './fx/fxLayers';
import { softDepthUniforms } from './fx/softDepth';
import { GRADE_PRESETS, THEME_LOOK, fallbackLook, type GradeDelta, type RGB, type ThemeLook } from './fx/fxLook';

// ------------------------------------------------------------------ tiers
export interface PostTier {
  /** render scale of the scene target (the final pass upsamples) */
  scale: number;
  ao: boolean;
  rays: boolean;
  dof: boolean;
  /** linear-depth copy for soft particles */
  soft: boolean;
  /** distortion pass: 0 off, 1/2 on (which sprites exist is decided at spawn by fxSettings) */
  dist: 0 | 1 | 2;
  bloomLevels: number;
  /** bloom base resolution divisor (2 = half res) */
  bloomDiv: number;
  /** MSAA samples on the scene target (0 = off) */
  msaa: number;
}

/**
 * Budgets: plan §2.6. Measured on the Arc iGPU (docs/milestones/F1/README.md): MSAA 4x adds ~3.3 ms
 * to the opaque pass alone, so it stays 0 (?msaa=4 forces it on high); the low tier renders the scene
 * at 0.75 scale (-2.2 ms) and the final pass upsamples it.
 */
export const POST_TIERS: Record<0 | 1 | 2, PostTier> = {
  0: { scale: 0.75, ao: false, rays: false, dof: false, soft: false, dist: 0, bloomLevels: 4, bloomDiv: 4, msaa: 0 },
  1: { scale: 1, ao: false, rays: false, dof: true, soft: true, dist: 1, bloomLevels: 5, bloomDiv: 2, msaa: 0 },
  2: { scale: 1, ao: true, rays: true, dof: true, soft: true, dist: 2, bloomLevels: 5, bloomDiv: 2, msaa: 0 },
};

// ------------------------------------------------------------------ GTAO on the shared depth
/** r170 GTAOPass with an external depth texture: setGBuffer() reads normalRenderTarget.depthTexture,
 *  which only exists when GTAO renders its own G-buffer, so give it a stand-in. */
class AOPass extends GTAOPass {
  setGBuffer(depthTexture?: THREE.DepthTexture, normalTexture?: THREE.Texture) {
    const self = this as unknown as { normalRenderTarget?: { depthTexture: THREE.Texture; dispose(): void; setSize(): void } };
    if (depthTexture && !self.normalRenderTarget) self.normalRenderTarget = { depthTexture, dispose() {}, setSize() {} };
    super.setGBuffer(depthTexture, normalTexture);
  }
}

// ------------------------------------------------------------------ GPU timer queries
class GpuTimer {
  enabled = false;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private pending: { q: WebGLQuery; k: string }[] = [];
  private open: { q: WebGLQuery; k: string } | null = null;
  samples: Record<string, number[]> = {};
  constructor(private gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }
  get available() {
    return !!this.ext;
  }
  begin(k: string) {
    if (!this.enabled || !this.ext || this.open) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.open = { q, k };
  }
  end() {
    if (!this.open || !this.ext) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.open);
    this.open = null;
  }
  poll() {
    const gl = this.gl;
    if (!this.ext || !this.pending.length) return;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    for (let i = 0; i < this.pending.length; ) {
      const p = this.pending[i];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) {
        i++;
        continue;
      }
      if (!disjoint) (this.samples[p.k] ??= []).push(gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(p.q);
      this.pending.splice(i, 1);
    }
  }
  reset() {
    this.samples = {};
  }
}

// ------------------------------------------------------------------ shaders
const FS_VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/**
 * shared depth -> half-res RGBA16F: A = linear view depth (m) for soft particles / distortion;
 * with WITH_NORMAL, RGB = view normal rebuilt from depth (GTAO's own reconstruction, done ONCE
 * here: GTAO's normal-less path rebuilds it 13x per pixel inside its denoiser, which measured
 * slower than the old G-buffer render).
 */
const DepthCopyShader = {
  uniforms: { tDepth: { value: null as THREE.Texture | null }, uNear: { value: 0.1 }, uFar: { value: 1000 }, uProjInv: { value: new THREE.Matrix4() } },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform highp sampler2D tDepth; uniform float uNear; uniform float uFar; uniform mat4 uProjInv; varying vec2 vUv;
    #ifdef WITH_NORMAL
    vec3 viewPos(vec2 uv, float d) { vec4 p = uProjInv * vec4(vec3(uv, d) * 2.0 - 1.0, 1.0); return p.xyz / p.w; }
    float fd(ivec2 p) { return texelFetch(tDepth, p, 0).x; }
    vec3 normalFromDepth(vec2 uv) {
      vec2 size = vec2(textureSize(tDepth, 0));
      ivec2 p = ivec2(uv * size);
      float c0 = fd(p), l2 = fd(p - ivec2(2, 0)), l1 = fd(p - ivec2(1, 0)), r1 = fd(p + ivec2(1, 0)), r2 = fd(p + ivec2(2, 0));
      float b2 = fd(p - ivec2(0, 2)), b1 = fd(p - ivec2(0, 1)), t1 = fd(p + ivec2(0, 1)), t2 = fd(p + ivec2(0, 2));
      float dl = abs((2.0 * l1 - l2) - c0), dr = abs((2.0 * r1 - r2) - c0), db = abs((2.0 * b1 - b2) - c0), dt = abs((2.0 * t1 - t2) - c0);
      vec3 ce = viewPos(uv, c0);
      vec3 dpdx = (dl < dr) ? ce - viewPos(uv - vec2(1.0 / size.x, 0.0), l1) : -ce + viewPos(uv + vec2(1.0 / size.x, 0.0), r1);
      vec3 dpdy = (db < dt) ? ce - viewPos(uv - vec2(0.0, 1.0 / size.y), b1) : -ce + viewPos(uv + vec2(0.0, 1.0 / size.y), t1);
      return normalize(cross(dpdx, dpdy));
    }
    #endif
    void main() {
      float d = texture2D(tDepth, vUv).x;
      float lin = d >= 1.0 ? 1e4 : -perspectiveDepthToViewZ(d, uNear, uFar);
      #ifdef WITH_NORMAL
      gl_FragColor = vec4(packNormalToRGB(normalFromDepth(vUv)), lin);
      #else
      gl_FragColor = vec4(0.5, 0.5, 1.0, lin);
      #endif
    }`,
};

/** screen-space radial light scattering from the sun's bright pixels (+ NaN / Inf sanitise) */
const GodRayShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    sun: { value: new THREE.Vector2(0.5, 0.5) },
    strength: { value: 0 },
    threshold: { value: 6.0 },
    color: { value: new THREE.Color(1, 0.9, 0.75) },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform vec2 sun; uniform float strength; uniform float threshold; uniform vec3 color;
    varying vec2 vUv;
    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      base.rgb = min(max(base.rgb, vec3(0.0)), vec3(500.0));
      if (strength <= 0.0) { gl_FragColor = base; return; }
      vec2 d = (vUv - sun) / 24.0 * 0.85;
      vec2 uv = vUv;
      float decay = 1.0, acc = 0.0;
      for (int i = 0; i < 24; i++) {
        uv -= d;
        vec3 s = texture2D(tDiffuse, uv).rgb;
        float b = max(0.0, max(s.r, max(s.g, s.b)) - threshold);
        acc += min(b, 8.0) * decay;
        decay *= 0.93;
      }
      float fall = smoothstep(1.2, 0.0, length((vUv - sun) * vec2(1.6, 1.0)));
      gl_FragColor = vec4(base.rgb + color * acc * strength * 0.011 * fall, base.a);
    }`,
};

const BloomPrefilter = {
  uniforms: { tSrc: { value: null as THREE.Texture | null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1 }, uKnee: { value: 0.5 } },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold; uniform float uKnee; varying vec2 vUv;
    vec3 tap(vec2 o) { return min(max(texture2D(tSrc, vUv + o * uTexel).rgb, vec3(0.0)), vec3(256.0)); }
    float w(vec3 c) { return 1.0 / (1.0 + max(c.r, max(c.g, c.b))); }
    void main() {
      // 4 bilinear taps (4x4 texels) with Karis weights: single hot sparks do not flicker the bloom
      vec3 a = tap(vec2(-1.0, -1.0)), b = tap(vec2(1.0, -1.0)), c = tap(vec2(-1.0, 1.0)), d = tap(vec2(1.0, 1.0));
      float wa = w(a), wb = w(b), wc = w(c), wd = w(d);
      vec3 col = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
      float br = max(col.r, max(col.g, col.b));
      float k = max(uKnee, 1e-4);
      float rq = clamp(br - uThreshold + k, 0.0, 2.0 * k);
      rq = rq * rq / (4.0 * k);
      gl_FragColor = vec4(col * (max(rq, br - uThreshold) / max(br, 1e-4)), 1.0);
    }`,
};

const BloomDown = {
  uniforms: { tSrc: { value: null as THREE.Texture | null }, uTexel: { value: new THREE.Vector2() } },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
    void main() {
      vec3 s = texture2D(tSrc, vUv).rgb * 4.0;
      s += texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
      s += texture2D(tSrc, vUv + vec2(1.0, -1.0) * uTexel).rgb;
      s += texture2D(tSrc, vUv + vec2(-1.0, 1.0) * uTexel).rgb;
      s += texture2D(tSrc, vUv + vec2(1.0, 1.0) * uTexel).rgb;
      gl_FragColor = vec4(s * 0.125, 1.0);
    }`,
};

const BloomUp = {
  uniforms: { tLow: { value: null as THREE.Texture | null }, tCur: { value: null as THREE.Texture | null }, uTexel: { value: new THREE.Vector2() }, uScatter: { value: 0.7 } },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tLow; uniform sampler2D tCur; uniform vec2 uTexel; uniform float uScatter; varying vec2 vUv;
    void main() {
      vec2 t = uTexel;
      vec3 s = texture2D(tLow, vUv).rgb * 4.0;
      s += (texture2D(tLow, vUv + vec2(-t.x, 0.0)).rgb + texture2D(tLow, vUv + vec2(t.x, 0.0)).rgb + texture2D(tLow, vUv + vec2(0.0, -t.y)).rgb + texture2D(tLow, vUv + vec2(0.0, t.y)).rgb) * 2.0;
      s += texture2D(tLow, vUv - t).rgb + texture2D(tLow, vUv + t).rgb + texture2D(tLow, vUv + vec2(-t.x, t.y)).rgb + texture2D(tLow, vUv + vec2(t.x, -t.y)).rgb;
      gl_FragColor = vec4(texture2D(tCur, vUv).rgb + s * (uScatter / 16.0), 1.0);
    }`,
};

/** final: distortion + CA + bloom + grade + vignette + flash + tone map + sRGB (RawShaderMaterial like OutputPass) */
const FINAL_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tScene; uniform sampler2D tBloom; uniform sampler2D tDist;
  uniform float uDistOn; uniform float uBloom; uniform float aberration; uniform float desat; uniform float flash;
  uniform float vignette; uniform float vignetteKick; uniform vec3 tint; uniform vec3 lift; uniform vec3 gain;
  uniform float contrast; uniform float saturation; uniform vec3 shadowTint; uniform vec3 highlightTint; uniform float crush;
  #include <tonemapping_pars_fragment>
  #include <colorspace_pars_fragment>
  varying vec2 vUv;
  void main() {
    vec2 uv = vUv;
    if (uDistOn > 0.5) uv = clamp(uv + texture2D(tDist, vUv).rg, vec2(0.001), vec2(0.999));
    vec2 c = vUv - 0.5;
    vec2 off = c * aberration * 0.012;
    vec3 col;
    col.r = texture2D(tScene, uv + off).r;
    col.g = texture2D(tScene, uv).g;
    col.b = texture2D(tScene, uv - off).b;
    col = min(max(col, vec3(0.0)), vec3(500.0));                 // NaN / Inf sanitise (rays pass is optional now)
    col += texture2D(tBloom, uv).rgb * uBloom;
    // grade in linear HDR: gain / lift, black toe, contrast around mid-grey (log), split toning, saturation
    col = col * gain + lift * (1.0 / (1.0 + col));
    col = col * col / (col + vec3(max(crush, 0.0)) + 1e-6) - vec3(min(crush, 0.0));
    vec3 lg = log2(max(col, vec3(1e-4)) / 0.18);
    col = 0.18 * exp2(lg * contrast);
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float tone = smoothstep(0.0, 1.0, clamp((log2(max(l, 1e-4) / 0.18) + 3.0) / 5.0, 0.0, 1.0));
    col *= mix(shadowTint, highlightTint, tone);
    l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = max(vec3(0.0), mix(vec3(l), col, saturation));
    col = mix(col, vec3(l) * vec3(1.08, 0.98, 0.9), desat);
    col *= tint;
    float v = smoothstep(0.85, 0.2, length(c) * vignette * (1.0 + 0.5 * vignetteKick));
    col *= mix(0.45 * (1.0 - 0.6 * vignetteKick), 1.0, v);
    col += flash;
    gl_FragColor = vec4(col, 1.0);
    #ifdef ACES_FILMIC_TONE_MAPPING
      gl_FragColor.rgb = ACESFilmicToneMapping(gl_FragColor.rgb);
    #elif defined(NEUTRAL_TONE_MAPPING)
      gl_FragColor.rgb = NeutralToneMapping(gl_FragColor.rgb);
    #elif defined(AGX_TONE_MAPPING)
      gl_FragColor.rgb = AgXToneMapping(gl_FragColor.rgb);
    #elif defined(REINHARD_TONE_MAPPING)
      gl_FragColor.rgb = ReinhardToneMapping(gl_FragColor.rgb);
    #elif defined(LINEAR_TONE_MAPPING)
      gl_FragColor.rgb = LinearToneMapping(gl_FragColor.rgb);
    #endif
    #ifdef SRGB_TRANSFER
      gl_FragColor = sRGBTransferOETF(gl_FragColor);
    #endif
  }`;
const FINAL_VERT = /* glsl */ `
  precision highp float;
  attribute vec3 position; attribute vec2 uv; varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// ------------------------------------------------------------------ dual-filter bloom
class DualBloom {
  enabled = true;
  strength = 0.4;
  radius = 0.6;
  threshold = 1.5;
  knee = 0.6;
  private down: THREE.WebGLRenderTarget[] = [];
  private up: THREE.WebGLRenderTarget[] = [];
  private pre = new THREE.ShaderMaterial({ ...BloomPrefilter, uniforms: THREE.UniformsUtils.clone(BloomPrefilter.uniforms), depthTest: false, depthWrite: false });
  private dn = new THREE.ShaderMaterial({ ...BloomDown, uniforms: THREE.UniformsUtils.clone(BloomDown.uniforms), depthTest: false, depthWrite: false });
  private upM = new THREE.ShaderMaterial({ ...BloomUp, uniforms: THREE.UniformsUtils.clone(BloomUp.uniforms), depthTest: false, depthWrite: false });
  private levels = 5;
  private w = 1;
  private h = 1;
  constructor(private quad: FullScreenQuad) {}

  private rt(w: number, h: number) {
    return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  }

  /** w, h: full scene target size; div: base divisor; levels: mip count */
  setSize(w: number, h: number, div: number, levels: number) {
    const bw = Math.max(1, Math.round(w / div)),
      bh = Math.max(1, Math.round(h / div));
    if (bw === this.w && bh === this.h && levels === this.levels && this.down.length) return;
    this.dispose();
    this.w = bw;
    this.h = bh;
    this.levels = levels;
    for (let i = 0; i < levels; i++) this.down.push(this.rt(bw >> i, bh >> i));
    for (let i = 0; i < levels - 1; i++) this.up.push(this.rt(bw >> i, bh >> i));
  }

  /** returns the bloom texture (base level) */
  render(r: THREE.WebGLRenderer, src: THREE.Texture, srcW: number, srcH: number): THREE.Texture {
    const q = this.quad;
    const P = this.pre.uniforms;
    P.tSrc.value = src;
    P.uTexel.value.set(1 / srcW, 1 / srcH);
    P.uThreshold.value = this.threshold;
    P.uKnee.value = this.knee;
    q.material = this.pre;
    r.setRenderTarget(this.down[0]);
    q.render(r);
    q.material = this.dn;
    for (let i = 1; i < this.levels; i++) {
      const s = this.down[i - 1];
      this.dn.uniforms.tSrc.value = s.texture;
      this.dn.uniforms.uTexel.value.set(1 / s.width, 1 / s.height);
      r.setRenderTarget(this.down[i]);
      q.render(r);
    }
    q.material = this.upM;
    const U = this.upM.uniforms;
    U.uScatter.value = 0.45 + 0.5 * this.radius;
    let low = this.down[this.levels - 1];
    for (let i = this.levels - 2; i >= 0; i--) {
      U.tLow.value = low.texture;
      U.tCur.value = this.down[i].texture;
      U.uTexel.value.set(1 / low.width, 1 / low.height);
      r.setRenderTarget(this.up[i]);
      q.render(r);
      low = this.up[i];
    }
    return low.texture;
  }

  dispose() {
    for (const t of [...this.down, ...this.up]) t.dispose();
    this.down.length = 0;
    this.up.length = 0;
  }
}

// ------------------------------------------------------------------ Post
type PresetState = { target: number; w: number; kick: number; kickDur: number };

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _clear = new THREE.Color();
const _lumNorm = (c: RGB): RGB => {
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] || 1;
  return [c[0] / l, c[1] / l, c[2] / l];
};

export class Post {
  /** god-ray material (uniforms: sun, strength, threshold, color) */
  rays: THREE.ShaderMaterial;
  bloom: DualBloom;
  ao: AOPass;
  /** Bokeh DOF material (uniforms: focus, aperture, maxblur, ...) */
  bokeh: { uniforms: Record<string, THREE.IUniform>; material: THREE.ShaderMaterial };
  /** final pass material (grade uniforms) */
  grade: THREE.RawShaderMaterial;
  dofEnabled = true;
  /** soft-particle depth fade / distortion on-off switches (ANDed with the tier; FX Lab A/B toggles) */
  softEnabled = true;
  distEnabled = true;
  /** set by the game / lab: is any distortion sprite alive? (skips the distortion pass when not) */
  distActive: () => boolean = () => true;
  /** the scene colour + shared depth target (read-only for other systems) */
  readonly sceneRT: THREE.WebGLRenderTarget;
  /**
   * A2 (arena art plan 6.1): called at the start of render(), before the scene pass, with the scene target size
   * and the tier (the arena renders its planar floor reflection here). GPU time under the 'reflect' timer key.
   */
  preScene: ((r: THREE.WebGLRenderer, cam: THREE.PerspectiveCamera, size: THREE.Vector2, quality: number) => void) | null = null;
  private _preSize = new THREE.Vector2();

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private q = 2 as 0 | 1 | 2;
  private tier: PostTier = POST_TIERS[2];
  private msaaOverride: number | null;
  private quad = new FullScreenQuad();
  private depthMat = new THREE.ShaderMaterial({ ...DepthCopyShader, uniforms: THREE.UniformsUtils.clone(DepthCopyShader.uniforms), depthTest: false, depthWrite: false });
  private depthNormalMat = new THREE.ShaderMaterial({ ...DepthCopyShader, defines: { WITH_NORMAL: '' }, uniforms: THREE.UniformsUtils.clone(DepthCopyShader.uniforms), depthTest: false, depthWrite: false });
  private linRT: THREE.WebGLRenderTarget;
  private distRT: THREE.WebGLRenderTarget;
  private rtA: THREE.WebGLRenderTarget | null = null;
  private rtB: THREE.WebGLRenderTarget | null = null;
  private black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  private timer: GpuTimer;
  private cssW = 1;
  private cssH = 1;
  private dofTarget = 0;
  private sunDir = new THREE.Vector3(0, 1, 0);
  private raysStrength = 0;
  private raysVis = 0;
  private dofOn = false;
  // look
  private base = { tint: [1, 1, 1] as RGB, lift: [0, 0, 0] as RGB, gain: [1, 1, 1] as RGB, contrast: 1, saturation: 1, vignette: 0.9 };
  private look: ThemeLook = fallbackLook({ strength: 0.6, radius: 0.5, threshold: 0.9 });
  private presets = new Map<string, PresetState>();
  private kicks = { aberration: 0, desat: 0, flash: 0, vignette: 0 };
  /** extra bloom multiplier (lab slider; 1 in game) */
  bloomScale = 1;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, o: { msaa?: number } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.black.needsUpdate = true;
    const qs = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('msaa') : null;
    this.msaaOverride = o.msaa ?? (qs !== null ? Math.max(0, Math.min(8, Number(qs) || 0)) : null);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const depth = new THREE.DepthTexture(size.x, size.y);
    depth.type = THREE.UnsignedIntType;
    this.sceneRT = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, depthTexture: depth, samples: 0 });
    this.sceneRT.texture.name = 'post.scene';
    this.linRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.linRT.texture.name = 'post.linearDepth';
    this.distRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, format: THREE.RGFormat, depthBuffer: false });
    this.distRT.texture.name = 'post.distortion';
    this.timer = new GpuTimer(renderer.getContext() as WebGL2RenderingContext);

    this.ao = new AOPass(scene, camera, Math.round(size.x / 2), Math.round(size.y / 2), { depthTexture: depth, normalTexture: this.linRT.texture });
    this.ao.output = GTAOPass.OUTPUT.Off;
    this.ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 12 });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    this.ao.blendIntensity = 0.85;

    const bu = THREE.UniformsUtils.clone(BokehShader.uniforms);
    bu.tDepth.value = depth;
    const bm = new THREE.ShaderMaterial({ defines: { ...BokehShader.defines, DEPTH_PACKING: 0 }, uniforms: bu, vertexShader: BokehShader.vertexShader, fragmentShader: BokehShader.fragmentShader, depthTest: false, depthWrite: false });
    bu.focus.value = 8;
    bu.aperture.value = 0.0015;
    bu.maxblur.value = 0.008;
    this.bokeh = { uniforms: bu, material: bm };

    this.rays = new THREE.ShaderMaterial({ ...GodRayShader, uniforms: THREE.UniformsUtils.clone(GodRayShader.uniforms), depthTest: false, depthWrite: false });
    this.bloom = new DualBloom(this.quad);
    this.grade = new THREE.RawShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        tDist: { value: null },
        uDistOn: { value: 0 },
        uBloom: { value: 0.4 },
        aberration: { value: 0 },
        desat: { value: 0 },
        flash: { value: 0 },
        vignette: { value: 0.9 },
        vignetteKick: { value: 0 },
        tint: { value: new THREE.Vector3(1, 1, 1) },
        lift: { value: new THREE.Vector3() },
        gain: { value: new THREE.Vector3(1, 1, 1) },
        contrast: { value: 1 },
        saturation: { value: 1 },
        shadowTint: { value: new THREE.Vector3(1, 1, 1) },
        highlightTint: { value: new THREE.Vector3(1, 1, 1) },
        crush: { value: 0 },
        toneMappingExposure: { value: 1 },
      },
      vertexShader: FINAL_VERT,
      fragmentShader: FINAL_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.applyToneMappingDefines();
    const css = renderer.getSize(new THREE.Vector2());
    this.setSize(css.x, css.y);
  }

  // ---------------------------------------------------------------- quality / size
  get quality(): number {
    return this.q;
  }
  set quality(v: number) {
    const q = Math.max(0, Math.min(2, Math.round(v))) as 0 | 1 | 2;
    this.q = q;
    this.tier = POST_TIERS[q];
    this.setSize(this.cssW, this.cssH);
  }
  get tierInfo(): PostTier & { msaaUsed: number } {
    return { ...this.tier, msaaUsed: this.sceneRT.samples };
  }

  setSize(w: number, h: number) {
    this.cssW = w;
    this.cssH = h;
    const pr = this.renderer.getPixelRatio();
    const T = this.tier;
    const W = Math.max(1, Math.floor(w * pr * T.scale)),
      H = Math.max(1, Math.floor(h * pr * T.scale));
    const samples = this.q === 2 && this.msaaOverride !== null ? this.msaaOverride : T.msaa;
    if (this.sceneRT.samples !== samples) {
      this.sceneRT.samples = samples;
      this.sceneRT.dispose();
    }
    this.sceneRT.setSize(W, H);
    this.linRT.setSize(Math.max(1, W >> 1), Math.max(1, H >> 1));
    this.distRT.setSize(Math.max(1, W >> 1), Math.max(1, H >> 1));
    this.rtA?.setSize(W, H);
    this.rtB?.setSize(W, H);
    this.ao.setSize(Math.max(1, Math.round(W / 2)), Math.max(1, Math.round(H / 2)));
    this.bloom.setSize(W, H, T.bloomDiv, T.bloomLevels);
    this.bokeh.uniforms.aspect.value = W / H;
  }

  private applyToneMappingDefines() {
    const r = this.renderer;
    const d: Record<string, string> = {};
    if (THREE.ColorManagement.getTransfer(r.outputColorSpace) === THREE.SRGBTransfer) d.SRGB_TRANSFER = '';
    const tm = r.toneMapping;
    if (tm === THREE.ACESFilmicToneMapping) d.ACES_FILMIC_TONE_MAPPING = '';
    else if (tm === THREE.NeutralToneMapping) d.NEUTRAL_TONE_MAPPING = '';
    else if (tm === THREE.AgXToneMapping) d.AGX_TONE_MAPPING = '';
    else if (tm === THREE.ReinhardToneMapping) d.REINHARD_TONE_MAPPING = '';
    else if (tm === THREE.LinearToneMapping) d.LINEAR_TONE_MAPPING = '';
    const key = JSON.stringify(d);
    if (key !== this.tmKey) {
      this.tmKey = key;
      this.grade.defines = d;
      this.grade.needsUpdate = true;
    }
  }
  private tmKey = '';

  // ---------------------------------------------------------------- look
  /** per-theme look; `id` (ThemeId) selects the F1 bloom / grade-extras row in fxLook.ts */
  setLook(o: { id?: string; bloom: { strength: number; radius: number; threshold: number }; grade: Grade; godrays: number; sunDir: THREE.Vector3; rayColor?: THREE.ColorRepresentation }) {
    this.look = (o.id && THEME_LOOK[o.id]) || fallbackLook(o.bloom);
    const g = o.grade;
    this.base = { tint: [...g.tint], lift: [...g.lift], gain: [...g.gain], contrast: g.contrast, saturation: g.saturation, vignette: g.vignette };
    this.raysStrength = o.godrays;
    this.sunDir.copy(o.sunDir);
    if (o.rayColor) (this.rays.uniforms.color.value as THREE.Color).set(o.rayColor);
  }
  /** override the bloom look (FX Lab sliders) */
  setBloom(b: Partial<ThemeLook['bloom']>) {
    this.look = { ...this.look, bloom: { ...this.look.bloom, ...b } };
  }
  setExtras(x: Partial<ThemeLook['extras']>) {
    this.look = { ...this.look, extras: { ...this.look.extras, ...x } };
  }
  get currentLook(): ThemeLook {
    return this.look;
  }

  /** hold a grade preset (GRADE_PRESETS id) at weight w (eased in / out over ~0.25 s); 0 releases it */
  setPreset(id: string, w: number) {
    if (!GRADE_PRESETS[id]) return;
    const s = this.presets.get(id) ?? { target: 0, w: 0, kick: 0, kickDur: 0.6 };
    s.target = Math.max(0, Math.min(1, w));
    this.presets.set(id, s);
  }
  /** a short preset pulse: weight w, decaying linearly to 0 over dur seconds (FxDef.post.grade) */
  kickPreset(id: string, w = 1, dur = 0.6) {
    if (!GRADE_PRESETS[id]) return;
    const s = this.presets.get(id) ?? { target: 0, w: 0, kick: 0, kickDur: dur };
    s.kick = Math.max(s.kick, Math.min(1, w));
    s.kickDur = Math.max(0.05, dur);
    this.presets.set(id, s);
  }
  /** current effective preset weights (debug / lab) */
  presetWeights(): Record<string, number> {
    const o: Record<string, number> = {};
    for (const [k, s] of this.presets) o[k] = +Math.max(s.w, s.kick).toFixed(3);
    return o;
  }

  /** dof: 0..1 strength; focus: distance in metres; aberration / desat / flash / vignette: kicks (already decayed by the caller) */
  update(dt: number, opts: { dof: number; focus: number; aberration: number; desat: number; flash: number; vignette?: number }) {
    this.dofTarget += (opts.dof - this.dofTarget) * Math.min(1, dt * 4);
    this.dofOn = this.dofEnabled && this.tier.dof && this.dofTarget > 0.02;
    if (this.dofOn) {
      const u = this.bokeh.uniforms;
      u.focus.value = opts.focus;
      u.aperture.value = 0.0025 * this.dofTarget;
      u.maxblur.value = 0.01 * this.dofTarget;
    }
    this.kicks.aberration = opts.aberration;
    this.kicks.desat = opts.desat;
    this.kicks.flash = opts.flash;
    this.kicks.vignette = opts.vignette ?? 0;
    for (const s of this.presets.values()) {
      s.w += (s.target - s.w) * Math.min(1, dt * 8);
      if (s.kick > 0) s.kick = Math.max(0, s.kick - dt / s.kickDur);
    }
    // god rays: project the sun; fade when it is behind the camera or far off-screen
    const cam = this.camera;
    _v.copy(cam.position).addScaledVector(this.sunDir, 400).project(cam);
    cam.getWorldDirection(_fwd);
    const facing = _fwd.dot(this.sunDir);
    this.raysVis = this.tier.rays && facing > 0.05 ? Math.min(1, facing * 2) * (1 - Math.min(1, Math.max(0, Math.hypot(_v.x, _v.y) - 1.1))) : 0;
    this.rays.uniforms.sun.value.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5);
    this.rays.uniforms.strength.value = this.raysVis * this.raysStrength;
  }

  /** theme grade + F1 extras + presets -> final-pass uniforms */
  private applyGrade() {
    const U = this.grade.uniforms;
    const b = this.base;
    const X = this.look.extras;
    let exposure = 1,
      contrast = b.contrast,
      saturation = b.saturation,
      vignette = b.vignette,
      desat = this.kicks.desat,
      crush = X.crush,
      bloomMul = 1;
    const tint: RGB = [...b.tint];
    const lift: RGB = [...b.lift];
    for (const [id, s] of this.presets) {
      const w = Math.max(s.w, s.kick);
      if (w <= 1e-3) continue;
      const d: GradeDelta = GRADE_PRESETS[id];
      if (d.exposure !== undefined) exposure *= 1 + (d.exposure - 1) * w;
      if (d.contrast !== undefined) contrast += d.contrast * w;
      if (d.saturation !== undefined) saturation *= 1 + (d.saturation - 1) * w;
      if (d.vignette !== undefined) vignette += d.vignette * w;
      if (d.desat !== undefined) desat = Math.max(desat, d.desat * w);
      if (d.crush !== undefined) crush += d.crush * w;
      if (d.bloom !== undefined) bloomMul *= 1 + (d.bloom - 1) * w;
      if (d.tint) for (let i = 0; i < 3; i++) tint[i] *= 1 + (d.tint[i] - 1) * w;
      if (d.lift) for (let i = 0; i < 3; i++) lift[i] += d.lift[i] * w;
    }
    U.tint.value.set(...tint);
    U.lift.value.set(...lift);
    U.gain.value.set(...b.gain);
    U.contrast.value = contrast;
    U.saturation.value = saturation;
    U.vignette.value = vignette;
    U.vignetteKick.value = Math.min(1, this.kicks.vignette);
    U.desat.value = Math.min(1, desat);
    U.aberration.value = this.kicks.aberration;
    U.flash.value = this.kicks.flash;
    U.crush.value = crush;
    U.shadowTint.value.set(..._lumNorm(X.shadowTint));
    U.highlightTint.value.set(..._lumNorm(X.highlightTint));
    U.toneMappingExposure.value = this.renderer.toneMappingExposure * exposure;
    const B = this.look.bloom;
    this.bloom.strength = B.strength;
    this.bloom.radius = B.radius;
    this.bloom.threshold = B.threshold;
    this.bloom.knee = B.knee;
    U.uBloom.value = this.bloom.enabled ? B.strength * bloomMul * this.bloomScale : 0;
  }

  // ---------------------------------------------------------------- profiling
  setProfiling(on: boolean) {
    this.timer.enabled = on && this.timer.available;
    this.timer.reset();
  }
  /** GPU ms per pass since setProfiling(true): avg / p50 / p95 / n */
  gpuTimes(): Record<string, { avg: number; p50: number; p95: number; n: number }> {
    this.timer.poll();
    const out: Record<string, { avg: number; p50: number; p95: number; n: number }> = {};
    for (const [k, xs] of Object.entries(this.timer.samples)) {
      if (!xs.length) continue;
      const s = [...xs].sort((a, b) => a - b);
      out[k] = { avg: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3), p50: +s[s.length >> 1].toFixed(3), p95: +s[Math.floor(s.length * 0.95)].toFixed(3), n: s.length };
    }
    return out;
  }
  get gpuTimerAvailable() {
    return this.timer.available;
  }

  // ---------------------------------------------------------------- render
  private full(mat: THREE.Material, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  private fullRT(): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(this.sceneRT.width, this.sceneRT.height, { type: THREE.HalfFloatType, depthBuffer: false });
  }

  render() {
    const r = this.renderer;
    const T = this.tier;
    const tm = this.timer;
    const cam = this.camera;
    const scene = this.scene;
    tm.poll();
    this.applyToneMappingDefines();
    this.applyGrade();
    const autoClear = r.autoClear;
    const mask = cam.layers.mask;
    const S = this.sceneRT;
    r.autoClear = false;

    // 0 pre-scene work (A2: planar floor reflection), before the shared depth / scene pass
    if (this.preScene) {
      tm.begin('reflect');
      this.preScene(r, cam, this._preSize.set(S.width, S.height), this.q);
      tm.end();
      cam.layers.mask = mask;
    }

    // 1 opaque world -> scene target (+ shared depth)
    tm.begin('scene');
    r.setRenderTarget(S);
    r.clear(true, true, true);
    cam.layers.mask = MASK_WORLD;
    r.render(scene, cam);
    tm.end();

    // 2 half-res linear depth (soft particles, distortion occlusion) + normals for AO
    const ao = T.ao && this.ao.enabled;
    const dist = T.dist > 0 && this.distEnabled && this.distActive();
    const soft = T.soft && this.softEnabled;
    const SD = softDepthUniforms;
    if (soft || dist || ao) {
      tm.begin('depth');
      const m = ao ? this.depthNormalMat : this.depthMat;
      const u = m.uniforms;
      u.tDepth.value = S.depthTexture;
      u.uNear.value = cam.near;
      u.uFar.value = cam.far;
      u.uProjInv.value.copy(cam.projectionMatrixInverse);
      this.full(m, this.linRT);
      tm.end();
      SD.uSceneDepth.value = this.linRT.texture;
      SD.uSoftOn.value = soft ? 1 : 0;
    } else SD.uSoftOn.value = 0;

    // 3 AO from the shared depth, multiplied into the scene colour
    if (ao) {
      tm.begin('ao');
      this.ao.render(r, null as unknown as THREE.WebGLRenderTarget, S, 0, false);
      const bm = this.ao.blendMaterial;
      bm.uniforms.tDiffuse.value = this.ao.pdRenderTarget.texture;
      bm.uniforms.intensity.value = this.ao.blendIntensity;
      this.full(bm, S);
      tm.end();
    }

    // 4 FX layers into the scene target (depth-tested against the shared depth)
    tm.begin('fx');
    SD.uDepthInvRes.value.set(1 / S.width, 1 / S.height);
    r.setRenderTarget(S);
    cam.layers.mask = MASK_FX;
    const bg = scene.background;
    scene.background = null;
    r.render(scene, cam);
    tm.end();

    // 5 distortion offsets (half res)
    if (dist) {
      tm.begin('dist');
      r.getClearColor(_clear);
      const ca = r.getClearAlpha();
      r.setClearColor(0x000000, 0);
      r.setRenderTarget(this.distRT);
      r.clear(true, false, false);
      SD.uDepthInvRes.value.set(1 / this.distRT.width, 1 / this.distRT.height);
      SD.uSoftOn.value = 1; // distortion always fades against the depth (occlusion), even with soft particles off
      cam.layers.mask = MASK_DIST;
      r.render(scene, cam);
      r.setClearColor(_clear, ca);
      tm.end();
    }
    scene.background = bg;
    cam.layers.mask = mask;

    // 6 god rays (also the NaN sanitise when it runs)
    let src: THREE.Texture = S.texture;
    if (this.raysVis > 0 && this.raysStrength > 0) {
      tm.begin('rays');
      this.rtA ??= this.fullRT();
      this.rays.uniforms.tDiffuse.value = src;
      this.full(this.rays, this.rtA);
      src = this.rtA.texture;
      tm.end();
    }

    // 7 depth of field on the shared depth
    if (this.dofOn) {
      tm.begin('dof');
      this.rtB ??= this.fullRT();
      const u = this.bokeh.uniforms;
      u.tColor.value = src;
      u.tDepth.value = S.depthTexture;
      u.nearClip.value = cam.near;
      u.farClip.value = cam.far;
      this.full(this.bokeh.material, this.rtB);
      src = this.rtB.texture;
      tm.end();
    }

    // 8 bloom
    let bloomTex: THREE.Texture = this.black;
    if (this.bloom.enabled) {
      tm.begin('bloom');
      bloomTex = this.bloom.render(r, src, S.width, S.height);
      tm.end();
    }

    // 9 final -> canvas
    tm.begin('final');
    const U = this.grade.uniforms;
    U.tScene.value = src;
    U.tBloom.value = bloomTex;
    U.tDist.value = dist ? this.distRT.texture : this.black;
    U.uDistOn.value = dist ? 1 : 0;
    this.full(this.grade, null);
    tm.end();

    r.autoClear = autoClear;
  }

  dispose() {
    for (const t of [this.sceneRT, this.linRT, this.distRT, this.rtA, this.rtB]) t?.dispose();
    this.bloom.dispose();
    this.ao.dispose();
    this.quad.dispose();
    this.grade.dispose();
    this.rays.dispose();
    this.bokeh.material.dispose();
    this.depthMat.dispose();
    this.depthNormalMat.dispose();
    this.black.dispose();
  }
}
