/**
 * FX atlas loader + flipbook material (reference implementation, lives with the FX Lab).
 *
 * Reads public/fx/atlas.json (written by tools/fx/*), loads KTX2 when the manifest says the
 * set was encoded (manifest.format === 'ktx2') and the transcoder works, otherwise WebP, and
 * reports which one was used. `makeFlipbookMaterial` implements the plan §2.2 flipbook:
 * frame from normalised age, motion-vector sub-frame blend (or plain crossfade), premultiplied
 * "additive-alpha" blending, lit3 relighting for smoke/dust, tint + HDR scale.
 *
 * INTEGRATION TODO (F2 -> F3): move this file to src/render/fx/atlas.ts (plan §3.1) and let
 * particles.ts consume `FlipbookInfo` per instance. It is kept under tools/ because the F2
 * session may not edit src/.
 * Format spec: docs/fx-pipeline.md.
 */
import * as THREE from 'three';
import { LAYER } from '../../src/render/fx/fxLayers';
import { SOFT_DEPTH_PARS, softDepthUniforms } from '../../src/render/fx/softDepth';

export interface AtlasTier { file: string; w: number; h: number; frame?: number; frameW?: number; frameH?: number; bytes: number; ktx2?: string; ktx2Encoding?: string; scale?: number }
export interface AtlasEntry {
  type: 'flipbook' | 'sprites' | 'noise' | 'decals';
  /** 'core' = loaded at session start; 'alt' = shipped, loaded on demand */
  set?: 'core' | 'alt';
  role?: string;
  kind?: 'emissive' | 'emissive+smoke' | 'lit3' | 'lit-fixed';
  grid?: [number, number];
  frames?: number;
  fps?: number;
  loop?: boolean;
  blend?: 'premultiplied' | 'additive';
  tint?: boolean;
  colorSpace: 'srgb' | 'linear';
  premultiplied?: boolean;
  hdrScale?: number;
  pivot?: [number, number];
  worldSize?: [number, number];
  full: AtlasTier;
  low?: AtlasTier;
  mv?: AtlasTier & { scale: number };
  data?: AtlasTier;
  sprites?: Record<string, { cell: number; channel: 'R' | 'G' | 'B' | 'A'; rect: [number, number, number, number] }>;
  cells?: Record<string, { cell: number; rect: [number, number, number, number]; tint: boolean; source: string }>;
  channels?: Record<string, string>;
  notes?: string;
  source?: Record<string, unknown>;
}
export interface AtlasManifest { version: number; format: 'webp' | 'ktx2'; atlases: Record<string, AtlasEntry>; ktx2?: { available: boolean; reason?: string } }

export class FxAtlases {
  manifest: AtlasManifest | null = null;
  /** 'webp' | 'ktx2' | 'ktx2->webp (transcoder failed)': what was actually used. */
  formatUsed = 'webp';
  private cache = new Map<string, Promise<THREE.Texture>>();
  private ktx2: { load: (url: string) => Promise<THREE.Texture> } | null = null;

  constructor(private renderer: THREE.WebGLRenderer, private base = '/fx/') {}

  async load(): Promise<AtlasManifest> {
    const r = await fetch(this.base + 'atlas.json');
    this.manifest = (await r.json()) as AtlasManifest;
    if (this.manifest.format === 'ktx2') {
      try {
        const { KTX2Loader } = await import('three/examples/jsm/loaders/KTX2Loader.js');
        const l = new KTX2Loader().setTranscoderPath(this.base.replace(/fx\/$/, 'basis/')).detectSupport(this.renderer);
        this.ktx2 = { load: (url) => l.loadAsync(url) };
        this.formatUsed = 'ktx2';
      } catch (e) {
        console.warn('[fxAtlas] KTX2 unavailable, using WebP', e);
        this.formatUsed = 'ktx2->webp (transcoder failed)';
      }
    }
    return this.manifest;
  }

  entry(id: string): AtlasEntry {
    const e = this.manifest?.atlases[id];
    if (!e) throw new Error('unknown FX atlas ' + id);
    return e;
  }

  /** which: 'full' (high/medium tier), 'low' (low tier), 'mv', 'data'. */
  texture(id: string, which: 'full' | 'low' | 'mv' | 'data' = 'full'): Promise<THREE.Texture> {
    const key = id + ':' + which;
    let p = this.cache.get(key);
    if (!p) {
      const e = this.entry(id);
      const t = e[which] ?? e.full;
      const linear = which === 'mv' || which === 'data' || e.colorSpace === 'linear';
      p = this.fetchTex(t, linear, e.type === 'noise');
      this.cache.set(key, p);
    }
    return p;
  }

  private async fetchTex(t: AtlasTier, linear: boolean, repeat: boolean): Promise<THREE.Texture> {
    let tex: THREE.Texture | null = null;
    if (this.ktx2 && t.ktx2) {
      try {
        tex = await this.ktx2.load(this.base + t.ktx2);
      } catch (e) {
        console.warn('[fxAtlas] KTX2 decode failed, WebP fallback for', t.file, e);
        this.formatUsed = 'ktx2->webp (decode failed)';
      }
    }
    if (!tex) {
      tex = await new THREE.TextureLoader().loadAsync(this.base + t.file);
      tex.flipY = true;
    }
    tex.colorSpace = linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    tex.premultiplyAlpha = false;            // data is ALREADY premultiplied in the file
    tex.anisotropy = 1;
    if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  /** Estimated GPU bytes of what has been loaded (RGBA8 for WebP, 1 B/px UASTC), with mips. */
  gpuBytes(): number {
    let b = 0;
    if (!this.manifest) return 0;
    for (const key of this.cache.keys()) {
      const [id, which] = key.split(':') as [string, 'full' | 'low' | 'mv' | 'data'];
      const t = this.manifest.atlases[id]?.[which];
      if (t) b += t.w * t.h * (this.formatUsed === 'ktx2' && t.ktx2 ? (t.ktx2Encoding === 'etc1s' ? 0.5 : 1) : 4) * 4 / 3;
    }
    return b;
  }
}

// --------------------------------------------------------------------------------- flipbook
export interface FlipbookOpts {
  tint?: THREE.ColorRepresentation;
  intensity?: number;          // HDR multiplier for emissive kinds (plan §2.4: cores 8-30)
  motionVectors?: boolean;     // false = plain crossfade (low tier)
  /** soft-particle fade distance (m); default 0.25 emissive, 0.6 smoke / dust (F1, softDepth.ts) */
  soft?: number;
}

const VERT = /* glsl */ `
varying vec2 vUv;
varying float vDepth;
void main() {
  vUv = uv;
  // camera-facing card: take the object's world position, offset in view space
  vec4 mvPos = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
  mvPos.xy += position.xy * scale;
  vDepth = -mvPos.z;
  gl_Position = projectionMatrix * mvPos;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform sampler2D uMv;
uniform vec2 uGrid;
uniform float uFrames;
uniform float uAge;          // 0..1 (one-shot) or loop phase 0..1
uniform float uMvScale;
uniform float uMvOn;
uniform float uKind;         // 0 emissive, 1 lit3, 2 lit-fixed
uniform vec3 uTint;
uniform float uIntensity;
uniform vec3 uKeyDir;        // light direction in VIEW space (towards the light)
uniform vec3 uKeyColor;
uniform vec3 uAmbient;
uniform float uFade;
uniform float uSoft;
varying vec2 vUv;
varying float vDepth;
${SOFT_DEPTH_PARS}

vec2 cellUv(float f, vec2 uv) {
  float col = mod(f, uGrid.x);
  float row = floor(f / uGrid.x);
  return (vec2(col, uGrid.y - 1.0 - row) + uv) / uGrid;   // frame 0 top-left, texture flipY
}
void main() {
  float fr = clamp(uAge, 0.0, 1.0) * (uFrames - 1.0);
  float f0 = floor(fr);
  float f1 = min(f0 + 1.0, uFrames - 1.0);
  float k = fr - f0;
  vec2 uv = clamp(vUv, 0.002, 0.998);
  vec2 off0 = vec2(0.0), off1 = vec2(0.0);
  if (uMvOn > 0.5) {
    // RG = flow n -> n+1 in UV units of one cell; texture is flipY so v flips sign
    vec2 m0 = (texture2D(uMv, cellUv(f0, uv)).rg * 2.0 - 1.0) * uMvScale;
    vec2 m1 = (texture2D(uMv, cellUv(f1, uv)).rg * 2.0 - 1.0) * uMvScale;
    m0.y = -m0.y; m1.y = -m1.y;
    off0 = -m0 * k;
    off1 = m1 * (1.0 - k);
  }
  vec4 c0 = texture2D(uTex, cellUv(f0, clamp(uv + off0, 0.002, 0.998)));
  vec4 c1 = texture2D(uTex, cellUv(f1, clamp(uv + off1, 0.002, 0.998)));
  vec4 c = mix(c0, c1, k);
  vec3 rgb;
  float a = c.a;
  if (uKind > 0.5 && uKind < 1.5) {
    // lit3: R = lit from screen right, G = top, B = left (each 35 deg toward the camera)
    vec3 L = normalize(uKeyDir);
    vec3 w = vec3(max(L.x, 0.0), max(L.y, 0.0), max(-L.x, 0.0));
    float front = max(L.z, 0.0) * 0.45;
    w += front;
    float lum = dot(c.rgb, w) / max(0.6, w.x + w.y + w.z) * 1.6;
    rgb = (lum * uKeyColor + uAmbient * a) * uTint;
  } else if (uKind > 1.5) {
    rgb = c.rgb * uTint * uIntensity;
  } else {
    rgb = c.rgb * uTint * uIntensity;
  }
  // premultiplied "additive-alpha" output (blend ONE, ONE_MINUS_SRC_ALPHA); soft fade against the shared depth (F1)
  float f = uFade * fxSoftFade(vDepth, uSoft);
  gl_FragColor = vec4(rgb * f, a * f);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function makeFlipbookMaterial(e: AtlasEntry, tex: THREE.Texture, mv: THREE.Texture | null, o: FlipbookOpts = {}): THREE.ShaderMaterial {
  const kind = e.kind === 'lit3' ? 1 : e.kind === 'lit-fixed' ? 2 : 0;
  return new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: tex },
      uMv: { value: mv ?? tex },
      uGrid: { value: new THREE.Vector2(e.grid![0], e.grid![1]) },
      uFrames: { value: e.frames! },
      uAge: { value: 0 },
      uMvScale: { value: e.mv?.scale ?? 0 },
      uMvOn: { value: mv && o.motionVectors !== false ? 1 : 0 },
      uKind: { value: kind },
      uTint: { value: new THREE.Color(o.tint ?? '#ffffff') },
      uIntensity: { value: o.intensity ?? (kind === 0 ? 4 : 1) },
      uKeyDir: { value: new THREE.Vector3(-0.5, 0.7, 0.5) },
      uKeyColor: { value: new THREE.Color('#ffe2c0') },
      uAmbient: { value: new THREE.Color('#2a2f3a') },
      uFade: { value: 1 },
      uSoft: { value: o.soft ?? (kind === 0 ? 0.25 : 0.6) },
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
    toneMapped: true,
  });
}

/** A camera-facing flipbook card sized from the manifest's worldSize, pivot at the bake origin. */
export function makeFlipbookCard(e: AtlasEntry, mat: THREE.ShaderMaterial, worldScale = 1): THREE.Mesh {
  const [w, h] = e.worldSize ?? [1, 1];
  const [px, py] = e.pivot ?? [0.5, 0.5];
  const g = new THREE.PlaneGeometry(1, 1);
  g.translate(0.5 - px, 0.5 - py, 0);
  const m = new THREE.Mesh(g, mat);
  m.scale.set(w * worldScale, h * worldScale, 1);
  m.frustumCulled = false;
  // FX alpha layer: drawn after Post's depth copy, so the soft fade has a depth to read (F1)
  m.layers.set(LAYER.FX_ALPHA);
  return m;
}

/** age01 for an atlas at time t since spawn (one-shots clamp, loops wrap). */
export function flipbookAge(e: AtlasEntry, t: number): number {
  const dur = (e.frames ?? 1) / (e.fps ?? 30);
  return e.loop ? (((t / dur) % 1) + 1) % 1 : Math.min(1, Math.max(0, t / dur));
}
