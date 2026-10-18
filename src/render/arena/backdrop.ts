/**
 * BACKDROP: the baked landmark panoramas (arena art plan 5.6 / 6.4, milestone A6).
 *
 * Blender renders the theme's vista from the arena centre (1.6 m) as an equirectangular panorama with latitude
 * limits, split into depth LAYERS (near 40-150 m: the landmark and the ruin ring; mid 150-600 m; far: mountains and
 * clouds) with alpha, a Depth pass and an AOV mask (R emission, G water, B cloud). tools/arena/build_backdrop.mjs
 * ships per quality tier (q2 3 layers 8k + hero inset 4k; q1 near 4k + mid/far composite 3k + inset 2k; q0 one
 * composite 2k) the layer textures (KTX2 / WebP), a coarse depth grid per layer and backdrop.json.
 *
 *   geometry   each layer is a cylinder-like grid (512 x 96 nodes for the near layer) whose vertices sit at the RENDERED
 *              DEPTH along their panorama direction: moving the camera inside the arena gives real parallax between
 *              the layers and within the landmark (an arch at 74 m shifts against clouds at 1 km). Display radius is
 *              capped at 1200 m (camera far plane 1400); the fog uses the true depth.
 *   drawing    after the opaque scene (transparent queue, renderOrder far -> near, depth test on, depth write off):
 *              walls and fighters hide it for free; one draw call per layer (+ cards). Also drawn into the planar
 *              floor reflection (LAYER_REFLECT): the arch mirrors in the wet floor.
 *   fog match  the scene's height fog (fog.ts: exp2 distance + ground-hugging height term, same uniforms) evaluated
 *              with the true depth compressed by `fogRange` (dEff = R (1 - e^(-d/R)), so distant layers saturate at a
 *              haze instead of vanishing) and scaled by `fogMax`: the in-game mist runs on into the panorama.
 *   AOV        R: emission flicker per texel cell (fires, windows) with HDR gain for bloom; G: waterfall flow (noise
 *              scrolling down the mask, foam); B: clouds sway slowly (UV wobble inside the mask) and their light breathes.
 *   inset      the hero inset (the near layer rendered from the ref-3 concept camera at 2x the panorama's pixel
 *              density) is projected onto the near layer through that camera's view-projection, faded at its edges.
 *   cards      q1 / q2: EEVEE volumetric flipbooks (8 x 4 frames, looped): moon LIGHT SHAFTS slanting down through the
 *              arch, and FOG BANKS on a ring at the foot of the ruin ring (alpha-blended in the fog colour).
 * The moon / sun disc and the sky gradient stay in sky.ts, behind the far layer.
 */
import * as THREE from 'three';
import { GLSL_NOISE, shaderTime } from './materials';
import { LAYER_REFLECT } from './reflection';

export type TexFiles = { ktx2?: string; webp?: string };

export interface BackdropLayerJson {
  name: string;
  size: [number, number];
  tex: TexFiles;
  aov: TexFiles;
  aovSize: [number, number];
  aovUsed: [boolean, boolean, boolean];
  depth: string;
  /** per grid cell (row 0 = latMax) 1 = holds visible texels; empty cells are not built (no fragments for the band's
   * transparent part) */
  cover?: string;
  coverShare?: number;
  grid: [number, number];
  depthMin: number;
  depthMax: number;
}
export interface BackdropCamJson {
  pos: [number, number, number];
  yaw: number;
  pitch: number;
  vfov: number;
  aspect: number;
}
export interface BackdropJson {
  id: string;
  latMin: number;
  latMax: number;
  origin: [number, number, number];
  tiers: Record<string, { layers: BackdropLayerJson[]; inset?: { tex: TexFiles; size: [number, number]; camera: BackdropCamJson }; gpuMB: number; downloadMB: number }>;
  cards: Record<string, { tex: TexFiles; grid: [number, number]; frames: number; px: number }>;
}

/** what ArenaAssets.loadBackdrop resolves: the json + loaded textures and depth grids for one tier */
export interface BackdropData {
  id: string;
  tier: string;
  json: BackdropJson;
  layers: { def: BackdropLayerJson; map: THREE.Texture; aov: THREE.Texture; depth: Uint16Array; cover: Uint8Array | null }[];
  inset?: { map: THREE.Texture; camera: BackdropCamJson };
  cards: Record<string, { map: THREE.Texture; grid: [number, number]; frames: number }>;
  textures: THREE.Texture[];
  ms: number;
}

/** ThemeArt.backdrop tuning (A6; A8 tunes the Moon Gate) */
export interface BackdropTuning {
  /** colour multiplier on the baked layers (linear; > 1 lifts moonlit rims into bloom) */
  gain?: number;
  /** HDR gain of AOV emission (fires / windows) */
  emitGain?: number;
  /** fog: true depth compressed to R (1 - e^(-d/R)) before the scene's fog formula; fogMax caps the result */
  fogRange?: number;
  fogMax?: number;
  /** light shafts: count, colour, opacity; fog banks: count per tier [q1, q2], colour lift over the fog colour, opacity */
  shafts?: { count: number; color: string; opacity: number; az: number; dist: number };
  fogBanks?: { count: [number, number]; radius: number; opacity: number; lift: number };
}

const DEG = Math.PI / 180;
const MAX_R = 1200;

const vert = /* glsl */ `
attribute float aDepth;
uniform vec3 uOrigin;
varying vec2 vUv;
varying float vDist;
varying float vY;
varying vec3 vWorld;
void main(){
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec3 dir = normalize(wp.xyz - uOrigin);
  vDist = aDepth;
  vY = uOrigin.y + dir.y * aDepth;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const frag = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uAov;
uniform sampler2D uInset;
uniform mat4 uInsetVP;
uniform float uTime;
uniform float uGain;
uniform float uEmitGain;
uniform float uFogRange;
uniform float uFogMax;
uniform vec2 uAovGrid;
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
varying vec2 vUv;
varying float vDist;
varying float vY;
varying vec3 vWorld;
${GLSL_NOISE}
void main(){
  vec4 c = texture2D(uMap, vUv);
#ifdef USE_INSET
  vec4 p = uInsetVP * vec4(vWorld, 1.0);
  if (p.w > 0.0) {
    vec2 q = p.xy / p.w;
    vec2 e = 1.0 - smoothstep(0.86, 0.99, abs(q));
    float w = e.x * e.y;
    if (w > 0.0) {
      // image row 0 = the camera's top (flipY false textures): v = 0.5 - q.y / 2
      vec4 ic = texture2D(uInset, vec2(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5));
      c = mix(c, ic, w);
    }
  }
#endif
  if (c.a < 0.004) discard;
#ifdef USE_AOV
  vec3 m = texture2D(uAov, vUv).rgb;
  if (m.b > 0.05) {
    // clouds: a slow sway of the texture inside the cloud mask (no drift out of it); second fetch only there
    vec2 uv2 = vUv + vec2(m.b * 0.0012 * sin(uTime * 0.05 + vUv.y * 9.0 + vUv.x * 40.0), 0.0);
    c = texture2D(uMap, uv2);
  }
#endif
  // fade the top rows of the band (clouds touching the latitude limit)
  c.a *= smoothstep(0.0, 0.035, vUv.y);
  if (c.a < 0.004) discard;
  vec3 col = c.rgb * uGain;
#ifdef USE_AOV
  if (m.g > 0.02) {
    // waterfall: streaks scrolling down, foam where the noise peaks
    float n = an_noise(vec3(vUv.x * 1400.0, vUv.y * 90.0 - uTime * 2.6, 0.0));
    float n2 = an_noise(vec3(vUv.x * 3100.0, vUv.y * 240.0 - uTime * 5.3, 3.0));
    float f = n * 0.65 + n2 * 0.35;
    col *= mix(1.0, 0.55 + 0.9 * f, m.g);
    col += m.g * smoothstep(0.62, 0.9, f) * vec3(0.5, 0.55, 0.7) * 0.35;
  }
  if (m.r > 0.02) {
    // emission flicker per texel cell (each fire / window its own phase), HDR gain for bloom
    vec2 cell = floor(vUv * uAovGrid);
    float h = an_hash(vec3(cell, 7.0));
    float fl = 0.62 + 0.55 * an_noise(vec3(h * 37.0, uTime * (2.2 + h * 2.5), h * 11.0)) + 0.12 * sin(uTime * (9.0 + h * 6.0) + h * 40.0);
    col *= mix(1.0, uEmitGain * fl, m.r);
  }
  if (m.b > 0.05) {
    // storm light breathing inside the clouds (cheap: two slow sines across the band, no noise per fragment)
    float b = 0.5 + 0.25 * sin(vUv.x * 41.0 + uTime * 0.11) + 0.25 * sin(vUv.x * 17.0 - vUv.y * 9.0 + uTime * 0.07);
    col *= mix(1.0, 0.85 + 0.3 * b, m.b);
  }
#endif
  // fog match (fog.ts formula, true depth compressed)
  float dEff = uFogRange * (1.0 - exp(-vDist / uFogRange));
  float distF = 1.0 - exp(-fogNear * fogNear * dEff * dEff);
  float hD = fogFar * exp(-max(vY + 1.0, 0.0) / 4.5);
  float heightF = 1.0 - exp(-hD * dEff);
  float fogF = clamp(max(distF, heightF), 0.0, 1.0) * uFogMax;
  col = mix(col, fogColor, fogF);
  gl_FragColor = vec4(col, c.a);
}`;

const cardVert = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const cardFrag = /* glsl */ `
uniform sampler2D uMap;
uniform vec2 uGrid;
uniform float uFrames;
uniform float uTime;
uniform float uRate;
uniform float uPhase;
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
vec4 frameAt(float f){
  float i = mod(f, uFrames);
  vec2 cell = vec2(mod(i, uGrid.x), floor(i / uGrid.x));
  // atlas rows top to bottom (flipY false): row r covers v in [r, r + 1] / rows
  return texture2D(uMap, (cell + vUv * vec2(1.0, -1.0) + vec2(0.0, 1.0)) / uGrid);
}
void main(){
  float t = uTime * uRate + uPhase;
  float f0 = floor(t);
  vec4 a = mix(frameAt(f0), frameAt(f0 + 1.0), t - f0);
  float k = a.a * max(a.r, max(a.g, a.b));
  // soft edges of the quad (the volumes already fade; this hides any hard frame border)
  vec2 e = smoothstep(vec2(0.0), vec2(0.06), vUv) * smoothstep(vec2(0.0), vec2(0.06), 1.0 - vUv);
  k *= e.x * e.y * uOpacity;
  if (k < 0.002) discard;
  gl_FragColor = vec4(uColor, k);
}`;

function dirOf(u: number, v: number, latMin: number, latMax: number, out: THREE.Vector3) {
  const az = (u - 0.5) * 360 * DEG;
  const lat = (latMax - v * (latMax - latMin)) * DEG;
  return out.set(Math.cos(lat) * Math.cos(az), Math.sin(lat), Math.cos(lat) * Math.sin(az));
}

/** the depth-displaced grid of one layer (world space; the origin is the panorama camera) */
function layerGeometry(J: BackdropJson, def: BackdropLayerJson, depth: Uint16Array, cover: Uint8Array | null): THREE.BufferGeometry {
  const [gw, gh] = def.grid;
  const n = (gw + 1) * (gh + 1);
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const dep = new Float32Array(n);
  const d = new THREE.Vector3();
  const [ox, oy, oz] = J.origin;
  for (let j = 0; j <= gh; j++) {
    for (let i = 0; i <= gw; i++) {
      const k = j * (gw + 1) + i;
      const u = i / gw,
        v = j / gh;
      dirOf(u, v, J.latMin, J.latMax, d);
      const dm = Math.max(1, depth[k] / 10);
      const r = Math.min(dm, MAX_R);
      pos[k * 3] = ox + d.x * r;
      pos[k * 3 + 1] = oy + d.y * r;
      pos[k * 3 + 2] = oz + d.z * r;
      uv[k * 2] = u;
      uv[k * 2 + 1] = v;
      dep[k] = dm;
    }
  }
  const idx = new Uint32Array(gw * gh * 6);
  let p = 0;
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      if (cover && !cover[j * gw + i]) continue;
      const a = j * (gw + 1) + i,
        b = a + 1,
        c = a + gw + 1,
        e = c + 1;
      idx[p++] = a;
      idx[p++] = c;
      idx[p++] = b;
      idx[p++] = b;
      idx[p++] = c;
      idx[p++] = e;
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aDepth', new THREE.BufferAttribute(dep, 1));
  g.setIndex(new THREE.BufferAttribute(idx.slice(0, p), 1));
  g.computeBoundingSphere();
  return g;
}

function insetMatrix(c: BackdropCamJson): THREE.Matrix4 {
  const cam = new THREE.PerspectiveCamera(c.vfov, c.aspect, 1, 5000);
  cam.position.set(c.pos[0], c.pos[1], c.pos[2]);
  const y = c.yaw * DEG,
    p = c.pitch * DEG;
  cam.up.set(0, 1, 0);
  cam.lookAt(c.pos[0] + Math.cos(p) * Math.cos(y), c.pos[1] + Math.sin(p), c.pos[2] + Math.cos(p) * Math.sin(y));
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
}

export class Backdrop {
  readonly group = new THREE.Group();
  readonly materials: THREE.ShaderMaterial[] = [];
  private cards: THREE.Mesh[] = [];
  private shafts: THREE.Mesh[] = [];

  constructor(
    readonly data: BackdropData,
    quality: number,
    tune: BackdropTuning = {},
  ) {
    const J = data.json;
    this.group.name = 'backdrop';
    this.group.userData.dyn = true;
    const origin = new THREE.Vector3(...J.origin);
    const insetVP = data.inset ? insetMatrix(data.inset.camera) : null;
    data.layers.forEach((L, i) => {
      const nearest = i === data.layers.length - 1;
      const defines: Record<string, string> = {};
      if (L.def.aovUsed.some((x) => x)) defines.USE_AOV = '';
      if (nearest && insetVP && data.inset) defines.USE_INSET = '';
      const mat = new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        defines,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        fog: true,
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          {
            uMap: { value: null },
            uAov: { value: null },
            uInset: { value: null },
            uInsetVP: { value: new THREE.Matrix4() },
            uOrigin: { value: origin },
            uGain: { value: tune.gain ?? 1.0 },
            uEmitGain: { value: tune.emitGain ?? 3.0 },
            uFogRange: { value: tune.fogRange ?? 140 },
            uFogMax: { value: tune.fogMax ?? 0.85 },
            uAovGrid: { value: new THREE.Vector2(L.def.aovSize[0] / 3, L.def.aovSize[1] / 3) },
          },
        ]),
      });
      // shared objects must not be cloned by UniformsUtils.merge
      mat.uniforms.uMap.value = L.map;
      mat.uniforms.uAov.value = L.aov;
      mat.uniforms.uTime = shaderTime;
      if ('USE_INSET' in defines) {
        mat.uniforms.uInset.value = data.inset!.map;
        mat.uniforms.uInsetVP.value = insetVP;
      }
      const mesh = new THREE.Mesh(layerGeometry(J, L.def, L.depth, L.cover), mat);
      mesh.name = `backdrop_${L.def.name}`;
      mesh.frustumCulled = false;
      mesh.renderOrder = -6 + i; // after the sky (-10), far -> near, before default transparents
      mesh.matrixAutoUpdate = false;
      mesh.userData = { dyn: true, kit: true, ownGeo: true, ownMat: true, backdrop: L.def.name };
      // the wet floor mirrors the landmark (near layer); the far layers add reflection cost for little (A6 measurement)
      if (nearest) mesh.layers.enable(LAYER_REFLECT);
      mesh.userData.noReflect = !nearest;
      this.materials.push(mat);
      this.group.add(mesh);
    });
    if (quality >= 1) this.buildCards(J, tune, quality);
  }

  /** moon light shafts through the arch + fog banks on a ring at the foot of the ruins (q1 / q2) */
  private buildCards(J: BackdropJson, tune: BackdropTuning, quality: number) {
    const mk = (kind: string, color: THREE.Color, opacity: number, rate: number, phase: number, blending: THREE.Blending) => {
      const c = this.data.cards[kind];
      if (!c) return null;
      return new THREE.ShaderMaterial({
        vertexShader: cardVert,
        fragmentShader: cardFrag,
        transparent: true,
        depthWrite: false,
        blending,
        uniforms: {
          uMap: { value: c.map },
          uGrid: { value: new THREE.Vector2(c.grid[0], c.grid[1]) },
          uFrames: { value: c.frames },
          uTime: shaderTime,
          uRate: { value: rate },
          uPhase: { value: phase },
          uColor: { value: color },
          uOpacity: { value: opacity },
        },
      });
    };
    const S = tune.shafts ?? { count: 3, color: '#b9b4ff', opacity: 0.35, az: 0, dist: 64 };
    for (let k = 0; k < S.count; k++) {
      const mat = mk('shaft', new THREE.Color(S.color), S.opacity * (k === 1 ? 1 : 0.7), 6, k * 9.7, THREE.AdditiveBlending);
      if (!mat) break;
      const az = (S.az + (k - (S.count - 1) / 2) * 7) * DEG;
      const r = S.dist - k * 3;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(16, 52), mat);
      m.position.set(Math.cos(az) * r, 22, Math.sin(az) * r);
      // face the arena centre, lean away from the moon (light falls toward the camera side)
      m.lookAt(0, 22, 0);
      m.rotateZ((k - 1) * 0.12);
      m.rotateX(-0.42);
      m.renderOrder = -2;
      m.frustumCulled = false;
      m.userData = { dyn: true, kit: true, ownGeo: true, ownMat: true };
      this.shafts.push(m);
      this.group.add(m);
    }
    const F = tune.fogBanks ?? { count: [8, 16], radius: 50, opacity: 0.55, lift: 1.35 };
    const n = F.count[quality >= 2 ? 1 : 0];
    for (let k = 0; k < n; k++) {
      const col = new THREE.Color();
      const mat = mk('fogbank', col, F.opacity, 3.5, k * 5.3, THREE.NormalBlending);
      if (!mat) break;
      mat.fog = false;
      mat.userData.fogLift = F.lift;
      const a = ((k + 0.5) / n) * Math.PI * 2;
      const r = F.radius * (0.92 + 0.16 * (((k * 7919) % 13) / 13));
      const w = ((2 * Math.PI * r) / n) * 1.8;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.32), mat);
      m.position.set(Math.cos(a) * r, w * 0.32 * 0.38, Math.sin(a) * r);
      m.lookAt(0, m.position.y, 0);
      m.renderOrder = -2;
      m.frustumCulled = false;
      m.userData = { dyn: true, kit: true, ownGeo: true, ownMat: true, fogBank: true };
      this.cards.push(m);
      this.group.add(m);
    }
  }

  /** per frame: fog-bank colour follows the scene fog colour (so the theme / power fog changes carry over) */
  update(fog: THREE.Fog | null) {
    if (!fog) return;
    for (const m of this.cards) {
      const mat = m.material as THREE.ShaderMaterial;
      (mat.uniforms.uColor.value as THREE.Color).copy(fog.color).multiplyScalar(mat.userData.fogLift ?? 1);
    }
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }
  get visible() {
    return this.group.visible;
  }

  stats() {
    let tris = 0;
    this.group.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (g?.index) tris += g.index.count / 3;
    });
    return { layers: this.data.layers.length, cards: this.cards.length, shafts: this.shafts.length, tris, tier: this.data.tier, inset: !!this.data.inset };
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
  }
}

/** tier key of a quality level */
export const backdropTier = (quality: number) => (quality >= 2 ? 'q2' : quality === 1 ? 'q1' : 'q0');
