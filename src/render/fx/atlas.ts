/**
 * FX atlases (plan §3.1 `atlas.ts`; F2 pipeline: docs/fx-pipeline.md). Moved here from the F2 FX Lab
 * (tools/fxlab/fxAtlas.ts now re-exports this file).
 *
 * - Reads public/fx/atlas.json, loads KTX2 when the manifest says the set was encoded and the
 *   transcoder works, otherwise WebP, and reports which one was used.
 * - Quality tiers: the low tier (q0) loads the `.low` files (half the frame size); medium and high
 *   load the full files. `set: 'core'` atlases are what the game uses by default (the Unity Labs
 *   flipbooks for fire / explosion / fireball / smoke); `set: 'alt'` atlases (the agent-made Blender
 *   bakes) are loaded only when something asks for them (`texture(id)` is lazy for every atlas).
 * - `makeFlipbookMaterial` / `makeFlipbookCard` / `flipbookAge` are the single-card helpers the FX Lab
 *   uses for whole-atlas previews; the game's flipbook particles are `sprites.ts` (instanced).
 *
 * Textures are cached per (id, tier) for the session and never rebuilt per arena.
 */
import * as THREE from 'three';
import { LAYER } from './fxLayers';
import { SOFT_DEPTH_PARS, softDepthUniforms } from './softDepth';

export interface AtlasTier { file: string; w: number; h: number; frame?: number; frameW?: number; frameH?: number; bytes: number; ktx2?: string; ktx2Encoding?: string; scale?: number }
export interface AtlasEntry {
  type: 'flipbook' | 'sprites' | 'noise' | 'decals';
  /** 'core' = the game default; 'alt' = shipped, loaded on demand */
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
export type AtlasWhich = 'full' | 'low' | 'mv' | 'data';

/**
 * fx_sprites (Kenney Particle Pack masks, channel-packed): sprite index i lives in cell i % 16 of the
 * 4x4 grid, channel floor(i / 16) (R, G, B, A). The order is the manifest's; `FxAtlases.load` warns if
 * a re-ingest changed it. Particles store the index, so emission never needs the manifest (Node tests).
 */
export const SPRITES = [
  'spark_01', 'spark_02', 'spark_03', 'spark_04', 'spark_05', 'spark_06', 'spark_07', 'flare_01', 'light_01', 'light_02', 'light_03', 'star_01', 'star_02', 'star_03', 'star_04', 'star_05',
  'star_06', 'slash_01', 'slash_02', 'slash_03', 'slash_04', 'trace_01', 'trace_02', 'trace_03', 'trace_04', 'trace_05', 'trace_06', 'trace_07', 'scratch_01', 'scorch_01', 'scorch_02', 'scorch_03',
  'circle_01', 'circle_02', 'circle_03', 'circle_04', 'circle_05', 'magic_01', 'magic_02', 'magic_03', 'magic_04', 'magic_05', 'twirl_01', 'twirl_02', 'twirl_03', 'smoke_01', 'smoke_03', 'smoke_05',
  'smoke_07', 'flame_01', 'flame_02', 'flame_03', 'flame_04', 'flame_05', 'flame_06', 'fire_01', 'fire_02', 'muzzle_01', 'muzzle_02', 'muzzle_03', 'dirt_01', 'dirt_02', 'dirt_03', 'symbol_01',
] as const;
export type SpriteName = (typeof SPRITES)[number];

/** decals atlas cells (4x4), in manifest order: index = cell */
export const DECAL_CELLS = [
  'blood_splat_0', 'blood_splat_1', 'blood_splat_2', 'blood_splat_3', 'blood_pool', 'blood_drips', 'scorch_0', 'scorch_1',
  'scorch_2', 'crack_0', 'crack_1', 'crack_2', 'crack_3', 'frost', 'mud', 'footprint',
] as const;
export type DecalCell = (typeof DECAL_CELLS)[number];

export class FxAtlases {
  manifest: AtlasManifest | null = null;
  /** 'webp' | 'ktx2' | 'ktx2->webp (transcoder failed)': what was actually used. */
  formatUsed = 'webp';
  private cache = new Map<string, Promise<THREE.Texture>>();
  private done = new Map<string, THREE.Texture>();
  private ktx2: { load: (url: string) => Promise<THREE.Texture> } | null = null;
  private loading: Promise<AtlasManifest> | null = null;

  constructor(private renderer: THREE.WebGLRenderer | null, private base = '/fx/') {}

  /** fetch the manifest once (later calls share the promise) */
  load(): Promise<AtlasManifest> {
    return (this.loading ??= this.fetchManifest());
  }

  private async fetchManifest(): Promise<AtlasManifest> {
    const r = await fetch(this.base + 'atlas.json');
    this.manifest = (await r.json()) as AtlasManifest;
    const sp = this.manifest.atlases.fx_sprites?.sprites;
    if (sp) for (const [name, s] of Object.entries(sp)) {
      const i = SPRITES.indexOf(name as SpriteName);
      if (i < 0 || i % 16 !== s.cell || 'RGBA'[Math.floor(i / 16)] !== s.channel) console.warn('[fx atlas] fx_sprites order changed:', name, s);
    }
    if (this.manifest.format === 'ktx2' && this.renderer) {
      try {
        const { KTX2Loader } = await import('three/examples/jsm/loaders/KTX2Loader.js');
        const l = new KTX2Loader().setTranscoderPath(this.base.replace(/fx\/$/, 'basis/')).detectSupport(this.renderer);
        this.ktx2 = { load: (url) => l.loadAsync(url) };
        this.formatUsed = 'ktx2';
      } catch (e) {
        console.warn('[fx atlas] KTX2 unavailable, using WebP', e);
        this.formatUsed = 'ktx2->webp (transcoder failed)';
      }
    }
    return this.manifest;
  }

  has(id: string): boolean {
    return !!this.manifest?.atlases[id];
  }
  entry(id: string): AtlasEntry {
    const e = this.manifest?.atlases[id];
    if (!e) throw new Error('unknown FX atlas ' + id);
    return e;
  }

  /** which: 'full' (high/medium tier), 'low' (low tier), 'mv', 'data'. Lazy: nothing loads until asked. */
  texture(id: string, which: AtlasWhich = 'full'): Promise<THREE.Texture> {
    const key = id + ':' + which;
    let p = this.cache.get(key);
    if (!p) {
      const e = this.entry(id);
      const t = e[which] ?? e.full;
      const linear = which === 'mv' || which === 'data' || e.colorSpace === 'linear';
      p = this.fetchTex(t, linear, e.type === 'noise').then((tex) => {
        this.done.set(key, tex);
        return tex;
      });
      this.cache.set(key, p);
    }
    return p;
  }

  /** the texture for a quality tier (q0 = 'low' when the atlas has one) */
  tierTexture(id: string, q: number): Promise<THREE.Texture> {
    const e = this.entry(id);
    return this.texture(id, q === 0 && e.low ? 'low' : 'full');
  }

  /** already-loaded texture (no fetch), or null */
  loaded(id: string, which: AtlasWhich = 'full'): THREE.Texture | null {
    return this.done.get(id + ':' + which) ?? null;
  }

  private async fetchTex(t: AtlasTier, linear: boolean, repeat: boolean): Promise<THREE.Texture> {
    let tex: THREE.Texture | null = null;
    if (this.ktx2 && t.ktx2) {
      try {
        tex = await this.ktx2.load(this.base + t.ktx2);
      } catch (e) {
        console.warn('[fx atlas] KTX2 decode failed, WebP fallback for', t.file, e);
        this.formatUsed = 'ktx2->webp (decode failed)';
      }
    }
    if (!tex) {
      tex = await new THREE.TextureLoader().loadAsync(this.base + t.file);
      tex.flipY = true;
    }
    tex.colorSpace = linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    tex.premultiplyAlpha = false; // data is ALREADY premultiplied in the file
    tex.anisotropy = 1;
    if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  /** Estimated GPU bytes of what has been loaded (RGBA8 for WebP, 1 B/px UASTC), with mips. */
  gpuBytes(): number {
    let b = 0;
    if (!this.manifest) return 0;
    for (const key of this.done.keys()) {
      const [id, which] = key.split(':') as [string, AtlasWhich];
      const t = this.manifest.atlases[id]?.[which];
      if (t) b += ((t.w * t.h * (this.formatUsed === 'ktx2' && t.ktx2 ? (t.ktx2Encoding === 'etc1s' ? 0.5 : 1) : 4)) * 4) / 3;
    }
    return b;
  }

  /** ids of every texture loaded so far (budget checks / lab readout) */
  loadedKeys(): string[] {
    return [...this.done.keys()];
  }
}

// --------------------------------------------------------------------------------- single flipbook card (FX Lab previews)
export interface FlipbookOpts {
  tint?: THREE.ColorRepresentation;
  intensity?: number; // HDR multiplier for emissive kinds (plan §2.4: cores 8-30)
  motionVectors?: boolean; // false = plain crossfade (low tier)
  /** soft-particle fade distance (m); default 0.25 emissive, 0.6 smoke / dust (F1, softDepth.ts) */
  soft?: number;
}

const VERT = /* glsl */ `
varying vec2 vUv;
varying float vDepth;
void main() {
  vUv = uv;
  vec4 mvPos = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
  mvPos.xy += position.xy * scale;
  vDepth = -mvPos.z;
  gl_Position = projectionMatrix * mvPos;
}`;

/** shared flipbook sampling GLSL (frame 0 top-left, texture flipY; MV blend per docs/fx-pipeline.md) */
export const FLIPBOOK_PARS = /* glsl */ `
vec2 fbCellUv(float f, vec2 uv, vec2 grid) {
  float col = mod(f, grid.x);
  float row = floor(f / grid.x);
  return (vec2(col, grid.y - 1.0 - row) + uv) / grid;
}
vec4 fbSample(sampler2D tex, sampler2D mvTex, float mvOn, float mvScale, vec2 grid, float frames, float fr, vec2 uv) {
  fr = clamp(fr, 0.0, frames - 1.0);
  float f0 = floor(fr);
  float f1 = min(f0 + 1.0, frames - 1.0);
  float k = fr - f0;
  uv = clamp(uv, 0.002, 0.998);
  vec2 off0 = vec2(0.0), off1 = vec2(0.0);
  if (mvOn > 0.5) {
    vec2 m0 = (texture2D(mvTex, fbCellUv(f0, uv, grid)).rg * 2.0 - 1.0) * mvScale;
    vec2 m1 = (texture2D(mvTex, fbCellUv(f1, uv, grid)).rg * 2.0 - 1.0) * mvScale;
    m0.y = -m0.y; m1.y = -m1.y;
    off0 = -m0 * k;
    off1 = m1 * (1.0 - k);
  }
  vec4 c0 = texture2D(tex, fbCellUv(f0, clamp(uv + off0, 0.002, 0.998), grid));
  vec4 c1 = texture2D(tex, fbCellUv(f1, clamp(uv + off1, 0.002, 0.998), grid));
  return mix(c0, c1, k);
}
/** lit3 relighting: R/G/B = lit from screen right / top / left (each 35 deg toward the camera) */
vec3 fbLit3(vec4 c, vec3 keyDirView, vec3 keyColor, vec3 ambient) {
  vec3 L = normalize(keyDirView);
  vec3 w = vec3(max(L.x, 0.0), max(L.y, 0.0), max(-L.x, 0.0));
  w += max(L.z, 0.0) * 0.45;
  float lum = dot(c.rgb, w) / max(0.6, w.x + w.y + w.z) * 1.6;
  return lum * keyColor + ambient * c.a;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform sampler2D uMv;
uniform vec2 uGrid;
uniform float uFrames;
uniform float uAge;
uniform float uMvScale;
uniform float uMvOn;
uniform float uKind;
uniform vec3 uTint;
uniform float uIntensity;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uAmbient;
uniform float uFade;
uniform float uSoft;
varying vec2 vUv;
varying float vDepth;
${SOFT_DEPTH_PARS}
${FLIPBOOK_PARS}
void main() {
  vec4 c = fbSample(uTex, uMv, uMvOn, uMvScale, uGrid, uFrames, clamp(uAge, 0.0, 1.0) * (uFrames - 1.0), vUv);
  vec3 rgb;
  float a = c.a;
  if (uKind > 0.5 && uKind < 1.5) rgb = fbLit3(c, uKeyDir, uKeyColor, uAmbient) * uTint;
  else rgb = c.rgb * uTint * uIntensity;
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
  m.layers.set(LAYER.FX_ALPHA);
  return m;
}

/** age01 for an atlas at time t since spawn (one-shots clamp, loops wrap). */
export function flipbookAge(e: AtlasEntry, t: number): number {
  const dur = (e.frames ?? 1) / (e.fps ?? 30);
  return e.loop ? (((t / dur) % 1) + 1) % 1 : Math.min(1, Math.max(0, t / dur));
}
