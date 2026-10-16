/**
 * Post-processing chain: render -> (optional DOF) -> god rays -> bloom ->
 * grade (per-theme lift/gamma/gain, contrast, saturation, tint, vignette,
 * hit chromatic aberration, kill desaturation) -> output (tone map + sRGB).
 *
 * Quality: 0 low (no god rays, half-res bloom), 1 medium, 2 high.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';

/** GTAO that ignores alpha-tested / transparent / glow geometry (foliage cards, flames, sky) */
class ArenaAOPass extends GTAOPass {
  overrideVisibility() {
    const self = this as unknown as { scene: THREE.Scene; _visibilityCache: Map<THREE.Object3D, boolean> };
    self._visibilityCache.clear();
    self.scene.traverse((o) => {
      self._visibilityCache.set(o, o.visible);
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      const skip = (o as THREE.Points).isPoints || (o as THREE.Line).isLine || (m && !Array.isArray(m) && (m.transparent || m.alphaTest > 0 || !m.depthWrite || (m as THREE.ShaderMaterial).isShaderMaterial)) || o.userData.noAO;
      if (skip) o.visible = false;
    });
  }
}
import type { Grade } from './arena/themes';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    vignette: { value: 0.9 },
    aberration: { value: 0 },
    desat: { value: 0 },
    tint: { value: new THREE.Vector3(1, 1, 1) },
    lift: { value: new THREE.Vector3(0, 0, 0) },
    gain: { value: new THREE.Vector3(1, 1, 1) },
    contrast: { value: 1 },
    saturation: { value: 1 },
    flash: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float vignette; uniform float aberration; uniform float desat; uniform vec3 tint; uniform float flash;
    uniform vec3 lift; uniform vec3 gain; uniform float contrast; uniform float saturation;
    varying vec2 vUv;
    void main(){
      vec2 c = vUv - 0.5;
      vec2 off = c * aberration * 0.012;
      vec4 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      col.a = 1.0;
      // grade in linear HDR: gain / lift, contrast around mid-grey (log-ish), saturation
      col.rgb = col.rgb * gain + lift * (1.0 / (1.0 + col.rgb));
      vec3 lg = log2(max(col.rgb, vec3(1e-4)) / 0.18);
      col.rgb = 0.18 * exp2(lg * contrast);
      float l = dot(col.rgb, vec3(0.2126, 0.7152, 0.0722));
      col.rgb = max(vec3(0.0), mix(vec3(l), col.rgb, saturation));
      col.rgb = mix(col.rgb, vec3(l) * vec3(1.08, 0.98, 0.9), desat);
      col.rgb *= tint;
      float v = smoothstep(0.85, 0.2, length(c) * vignette);
      col.rgb *= mix(0.45, 1.0, v);
      col.rgb += flash;
      gl_FragColor = col;
    }`,
};

/** screen-space radial light scattering from the sun's bright pixels */
const GodRayShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    sun: { value: new THREE.Vector2(0.5, 0.5) },
    strength: { value: 0 },
    threshold: { value: 6.0 },
    color: { value: new THREE.Color(1, 0.9, 0.75) },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec2 sun; uniform float strength; uniform float threshold; uniform vec3 color;
    varying vec2 vUv;
    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      // sanitize: a single NaN/Inf pixel would be smeared over the whole frame by the bloom blur
      // (min/max also flush NaN on D3D, where isnan() may be compiled away)
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

export class Post {
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  bokeh: BokehPass;
  grade: ShaderPass;
  rays: ShaderPass;
  ao: ArenaAOPass;
  dofEnabled = true;
  quality = 2;
  private dofTarget = 0;
  private sunDir = new THREE.Vector3(0, 1, 0);
  private raysStrength = 0;
  private camera: THREE.PerspectiveCamera;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    const size = renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.ao = new ArenaAOPass(scene, camera, Math.round(size.x / 2), Math.round(size.y / 2));
    this.ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 12 });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    this.ao.blendIntensity = 0.85;
    this.composer.addPass(this.ao);
    this.bokeh = new BokehPass(scene, camera, { focus: 8, aperture: 0.0015, maxblur: 0.008 });
    this.bokeh.enabled = false;
    this.composer.addPass(this.bokeh);
    this.rays = new ShaderPass(GodRayShader);
    this.composer.addPass(this.rays);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.6, 0.5, 0.9);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
    this.setSize(size.x, size.y);
  }

  setSize(w: number, h: number) {
    this.composer.setSize(w, h);
    this.ao.setSize(Math.round(w / 2), Math.round(h / 2));
    // bloom is a soft effect: half resolution (quarter on low) is visually identical and much cheaper
    const k = this.quality === 0 ? 4 : 2;
    this.bloom.setSize(Math.round(w / k), Math.round(h / k));
  }

  /** per-theme look */
  setLook(o: { bloom: { strength: number; radius: number; threshold: number }; grade: Grade; godrays: number; sunDir: THREE.Vector3; rayColor?: THREE.ColorRepresentation }) {
    this.bloom.strength = o.bloom.strength;
    this.bloom.radius = o.bloom.radius;
    this.bloom.threshold = o.bloom.threshold;
    const g = this.grade.uniforms;
    g.tint.value.set(...o.grade.tint);
    g.lift.value.set(...o.grade.lift);
    g.gain.value.set(...o.grade.gain);
    g.contrast.value = o.grade.contrast;
    g.saturation.value = o.grade.saturation;
    g.vignette.value = o.grade.vignette;
    this.raysStrength = o.godrays;
    this.sunDir.copy(o.sunDir);
    if (o.rayColor) (this.rays.uniforms.color.value as THREE.Color).set(o.rayColor);
  }

  /** dof: 0..1 strength; focus: distance in meters */
  update(dt: number, opts: { dof: number; focus: number; aberration: number; desat: number; flash: number }) {
    this.dofTarget += (opts.dof - this.dofTarget) * Math.min(1, dt * 4);
    const on = this.dofEnabled && this.quality >= 1 && this.dofTarget > 0.02;
    this.bokeh.enabled = on;
    this.ao.enabled = this.quality >= 2;
    if (on) {
      const u = this.bokeh.uniforms as Record<string, THREE.IUniform>;
      u.focus.value = opts.focus;
      u.aperture.value = 0.0025 * this.dofTarget;
      u.maxblur.value = 0.01 * this.dofTarget;
    }
    const g = this.grade.uniforms;
    g.aberration.value = opts.aberration;
    g.desat.value = opts.desat;
    g.flash.value = opts.flash;
    // god rays: project the sun; fade when it's behind the camera or far off-screen
    const p = this.camera.position.clone().addScaledVector(this.sunDir, 400).project(this.camera);
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const facing = fwd.dot(this.sunDir);
    const vis = this.quality >= 2 && facing > 0.05 ? Math.min(1, facing * 2) * (1 - Math.min(1, Math.max(0, Math.hypot(p.x, p.y) - 1.1))) : 0;
    this.rays.enabled = true; // also sanitizes the HDR buffer before bloom
    this.rays.uniforms.sun.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    this.rays.uniforms.strength.value = vis * this.raysStrength;
  }

  render() {
    this.composer.render();
  }
}
