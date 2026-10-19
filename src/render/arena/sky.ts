/**
 * Procedural HDR sky dome: gradient + horizon glow toward the sun, sun disk
 * with mie halo, fbm clouds lit from the sun side, twinkling stars, aurora
 * curtains and a cratered moon. The same shader bakes the PMREM environment
 * map so every PBR surface is lit/reflects the theme's sky.
 */
import * as THREE from 'three';
import { GLSL_NOISE, shaderTime } from './materials';

export interface SkyParams {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color; // HDR
  sunSize: number; // angular radius (rad)
  sunGlow: number;
  zenith: THREE.Color;
  horizon: THREE.Color;
  ground: THREE.Color;
  horizonGlow: THREE.Color;
  cloudCover: number;
  cloudScale: number;
  cloudColor: THREE.Color;
  cloudShade: THREE.Color;
  cloudSpeed: number;
  stars: number;
  aurora: number;
  auroraA: THREE.Color;
  auroraB: THREE.Color;
  moonDir: THREE.Vector3;
  moonSize: number;
  moonColor: THREE.Color;
  /**
   * A6: moon halo scaled to the disc size (> 0 = on, the value scales the glow). 0 / undefined keeps the original fixed
   * halo (tuned for small moons; a 12 deg concept moon hid it under the disc), so every legacy theme renders identically.
   */
  moonHalo?: number;
  /**
   * A7b: storm-cloud deck down to the horizon (direction-space fbm, so it has texture where the plane-projected clouds
   * stretch flat), lit from behind by the moon: a bright glow round the moon, silver edges, dark storm cloud beyond.
   * 0 / undefined = off (every other theme renders identically).
   */
  storm?: number;
  stormLit?: THREE.Color;
  stormDark?: THREE.Color;
  /** A7b: storm cloud scale (higher = smaller billows) */
  stormScale?: number;
  /** A7b: the baked storm deck (bakeStormTexture), set by the arena before the sky is made */
  stormTex?: THREE.Texture;
  /**
   * A7c: the authored sky (tools/arena/sky_compose.py -> public/arena/sky/<id>/): a cloud DATA texture in the sky band
   * (u = 0.5 + az / 360, v = 1 - (dir.y + 0.1) / 1.1; R structure, G density, B rim potential, A moon shafts) lit here
   * by the moon, so the clouds can drift while the glow, the silver rims and the dark horizon banks stay put. Set by the
   * arena (kit mode, ThemeArt.sky) before the sky is made; replaces the storm deck and the procedural clouds.
   */
  skyTex?: THREE.Texture;
  /** A7c: the lighting of skyTex (sky.json `look`; ThemeArt.sky.look overrides single keys) */
  skyLook?: SkyLook;
  /** A7c: the gradient map of skyTex (6 linear RGB stops, dark -> bright; sky.json `palette`, from the concept image) */
  skyRamp?: number[][];
}

/**
 * A7c: how the authored sky texture is lit (angles in degrees from the moon; colours linear RGB). The same maths runs in
 * the preview of tools/arena/sky_compose.py (`shade`): keep them in step.
 */
export interface SkyLook {
  /** overall cloud brightness */
  gain: number;
  /** light far from the moon, + mid (half at midDeg) + wide (half at wideDeg) */
  amb: number;
  mid: number;
  midDeg: number;
  wide: number;
  wideDeg: number;
  /** HDR boost of the clouds right round the moon (bloom) */
  hot: number;
  hotDeg: number;
  /** silver lining on the rim-potential texels near the moon */
  rim: number[];
  rimGain: number;
  rimDeg: number;
  /** the thin gaps between clouds: dark night far from the moon, moon haze near it */
  gapFar: number[];
  gapNear: number[];
  /** dark far banks: below dir.y = bankH, darker (bankDark) and denser (bankDens), less so toward the moon (bankAway) */
  bankH: number;
  bankDark: number;
  bankDens: number;
  bankAway: number;
  /** the moon shafts channel */
  shaft: number[];
  shaftGain: number;
  /** cloud drift (texture u per second; the lighting stays) */
  drift: number;
  /** distant lightning: colour, mean seconds between flashes (0 = none), brightness, IBL pulse (share at the peak) */
  flash: number[];
  flashEvery: number;
  flashGain: number;
  flashEnv: number;
  /** how much thick cloud hides the moon disc */
  moonOcclude: number;
  /** saturation of the ramp colour (1 = as sampled) */
  sat?: number;
}

/** pow(dot, k) = 0.5 at `deg` from the axis */
export const halfK = (deg: number) => 0.693 / Math.max(1e-5, 1 - Math.cos((deg * Math.PI) / 180));

/** A6: moon / sun angular RADIUS (rad) from the apparent DIAMETER in degrees (ref-3's moon is about 12 deg wide) */
export const discRadius = (diameterDeg: number) => (diameterDeg * Math.PI) / 360;

const vert = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const frag = /* glsl */ `
uniform vec3 uSunDir; uniform vec3 uSunColor; uniform float uSunSize; uniform float uSunGlow;
uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround; uniform vec3 uHorizonGlow;
uniform float uCloudCover; uniform float uCloudScale; uniform vec3 uCloudColor; uniform vec3 uCloudShade; uniform float uCloudSpeed;
uniform float uStars; uniform float uAurora; uniform vec3 uAuroraA; uniform vec3 uAuroraB;
uniform vec3 uMoonDir; uniform float uMoonSize; uniform vec3 uMoonColor; uniform float uMoonHalo;
uniform float uTime;
uniform float uStorm; uniform vec3 uStormLit; uniform sampler2D uStormTex;
uniform float uSky; uniform sampler2D uSkyTex; uniform vec3 uSkyRamp[6];
uniform vec4 uSkyA; uniform vec4 uSkyK; uniform vec4 uSkyB; uniform vec4 uSkyBank;
uniform vec3 uSkyRim; uniform vec3 uSkyGapFar; uniform vec3 uSkyGapNear; uniform vec3 uSkyShaft;
uniform vec4 uSkyFlash; uniform vec3 uSkyFlashDir;
varying vec3 vDir;
${GLSL_NOISE}
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
vec3 skyRamp(float t){ float x = clamp(t, 0.0, 1.0) * 5.0; int i = int(min(floor(x), 4.0)); return mix(uSkyRamp[i], uSkyRamp[i + 1], x - float(i)); }
float fbm2(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<5;i++){ s+=a*an_noise(vec3(p,0.5)); p=p*2.02+vec2(1.7,9.2); a*=0.5; } return s; }
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  float t = pow(clamp(h, 0.0, 1.0), 0.42);
  vec3 col = mix(uHorizon, uZenith, t);
  if (h < 0.0) col = mix(uHorizon, uGround, pow(clamp(-h * 4.0, 0.0, 1.0), 0.55));
  float sd = dot(d, uSunDir);
  // warm glow along the horizon toward the sun + mie halo
  col += uHorizonGlow * pow(max(sd, 0.0), 2.5) * (1.0 - t) * 1.3;
  col += uSunColor * (pow(max(sd, 0.0), 12.0) * 0.05 + pow(max(sd, 0.0), 220.0) * 0.4) * uSunGlow;
  // stars
  if (uStars > 0.0 && h > -0.02 && uSky == 0.0) { // (A7c: the authored sky has no clear sky for stars: skipped, cost)
    vec3 sp = d * 220.0;
    vec3 cell = floor(sp);
    float r = an_hash(cell);
    float sz = length(fract(sp) - 0.5);
    float star = step(0.992, r) * smoothstep(0.22, 0.0, sz) * (0.55 + 0.45 * sin(uTime * (2.0 + r * 5.0) + r * 60.0));
    vec3 sc = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.9, 0.75), fract(r * 37.0));
    col += sc * star * uStars * 2.5 * smoothstep(-0.02, 0.15, h);
    // milky band
    float band = exp(-pow(dot(d, normalize(vec3(0.4, 0.55, -0.73))) * 3.0, 2.0));
    col += vec3(0.35, 0.4, 0.55) * band * an_fbm(d * 9.0) * 0.18 * uStars;
  }
  // aurora curtains
  if (uAurora > 0.0 && h > 0.0) {
    float az = atan(d.z, d.x);
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float bc = 0.22 + 0.12 * fi + 0.09 * sin(az * (2.0 + fi) + uTime * 0.07 + fi * 2.0) + 0.06 * an_noise(vec3(az * 3.0, fi, uTime * 0.05));
      float dh = h - bc;
      float curtain = exp(-dh * dh / (dh > 0.0 ? 0.012 : 0.0016));
      float rays = 0.45 + 0.55 * an_noise(vec3(az * 40.0 + fi * 7.0, uTime * 0.25, fi));
      float wave = 0.5 + 0.5 * sin(az * (5.0 + fi * 2.0) - uTime * 0.12 + fi);
      vec3 ac = mix(uAuroraA, uAuroraB, clamp(dh * 6.0 + 0.4, 0.0, 1.0));
      acc += ac * curtain * rays * wave;
    }
    col += acc * uAurora;
  }
  // clouds
  if (uCloudCover > 0.0 && h > 0.0) {
    vec2 uv = d.xz / (h + 0.09) * uCloudScale + vec2(uTime * uCloudSpeed, uTime * uCloudSpeed * 0.35);
    float n = fbm2(uv);
    float c = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.32, n);
    float n2 = fbm2(uv + uSunDir.xz * 0.12);
    float lit = clamp((n - n2) * 4.0 + 0.55, 0.0, 1.0);
    vec3 cc = mix(uCloudShade, uCloudColor, lit);
    cc += uSunColor * 0.012 * pow(max(sd, 0.0), 5.0) * (1.0 - c) * 6.0; // silver lining
    c *= smoothstep(0.0, 0.12, h);
    col = mix(col, cc, c * 0.92);
  }
  // A7b storm deck (kit Moon Gate only): billowing cloud down to the horizon, backlit by the moon. The noise is baked
  // once per arena into uStormTex (bakeStormTexture: the per-pixel fbm cost about 2-3 ms on the iGPU); rgb = sqrt(colour / 2)
  float stDens = 0.0; vec3 stCol = vec3(0.0);
  if (uStorm > 0.0 && h > -0.08) {
    vec2 suv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5 + uTime * 0.00025, (h + 0.1) / 1.1);
    vec4 st = texture2D(uStormTex, suv);
    stCol = st.rgb * st.rgb * 2.0;
    float md = max(dot(d, uMoonDir), 0.0);
    float glow = pow(md, 28.0) * 1.0 + pow(md, 7.0) * 0.28 + pow(md, 2.5) * 0.05;
    // the gaps between clouds carry the moon's glow (haze), the cloud body covers it
    vec3 gap = col + uStormLit * glow * 0.5;
    stDens = st.a * uStorm * smoothstep(-0.08, 0.04, h);
    col = mix(gap, stCol, stDens);
  }
  // A7c authored sky (kit Moon Gate): structure / density / rims from the texture (drifting in u), lit here by the moon
  float skyD = 0.0;
  if (uSky > 0.0) {
    vec2 uv0 = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, 1.0 - (clamp(h, -0.1, 1.0) + 0.1) / 1.1);
    vec2 gx = dFdx(uv0), gy = dFdy(uv0);
    gx.x -= floor(gx.x + 0.5); gy.x -= floor(gy.x + 0.5); // no mip seam where atan wraps
    vec4 tx = textureGrad(uSkyTex, uv0 + vec2(uSkyB.z * uTime, 0.0), gx, gy);
    float sS = textureGrad(uSkyTex, uv0, gx, gy).a;
    float sL = tx.r, sD = tx.g, sE = tx.b;
    float under = smoothstep(-0.04, -0.09, h); // below the band: flat dark bank
    sL = mix(sL, 0.3, under); sD = mix(sD, 1.0, under); sE *= 1.0 - under; sS *= 1.0 - under;
    float md = max(dot(d, uMoonDir), 0.0);
    float gMid = pow(md, uSkyK.x), gWide = pow(md, uSkyK.y), gHot = pow(md, uSkyK.z), gRim = pow(md, uSkyK.w);
    float bank = (1.0 - smoothstep(-0.02, uSkyBank.x, h)) * (1.0 - uSkyBank.w * gMid);
    bank = max(bank, 1.0 - smoothstep(-0.1, -0.04, h));
    sD = max(sD, bank * uSkyBank.z);
    float light = (uSkyA.y + uSkyA.z * gMid + uSkyA.w * gWide) * (1.0 - uSkyBank.y * bank);
    vec3 cc = skyRamp(sL * light);
    cc = mix(vec3(dot(cc, vec3(0.2126, 0.7152, 0.0722))), cc, uSkyB.y) * uSkyA.x * (1.0 + uSkyB.x * gHot * (0.4 + 0.6 * sE));
    // gaps: night (the gradient + stars above) far from the moon, moon haze + halo near it
    float k1 = 0.693 / max(1e-5, 1.0 - cos(uMoonSize * 1.6)), k2 = 0.693 / max(1e-5, 1.0 - cos(uMoonSize * 6.0));
    vec3 gap = mix(uSkyGapFar, uSkyGapNear, gMid) + col * 0.5 + uMoonColor * uMoonHalo * (pow(md, k1) * 0.35 + pow(md, k2) * 0.07);
    vec3 c = mix(gap, cc, sD);
    c += uSkyRim * sE * gRim * (1.0 - 0.5 * sD);
    c += uSkyShaft * sS * (0.35 + 0.65 * (1.0 - sD));
    // distant lightning inside the cloud (cosmetic, driven from match time by the arena)
    if (uSkyFlash.w > 0.0) {
      float fd = max(dot(d, uSkyFlashDir), 0.0);
      c += uSkyFlash.rgb * uSkyFlash.w * (pow(fd, 24.0) * (0.3 + sL) * sD + pow(fd, 4.0) * 0.06);
    }
    col = c;
    skyD = sD;
  }
  // sun disk (after clouds; dimmed when covered would need more work - keep it bright)
  if (uSunSize > 0.0) {
    float disk = smoothstep(cos(uSunSize), cos(uSunSize * 0.85), sd);
    col += uSunColor * disk * 1.5;
  }
  // moon
  if (uMoonSize > 0.0) {
    float md = dot(d, uMoonDir);
    float m = smoothstep(cos(uMoonSize), cos(uMoonSize * 0.97), md);
    vec3 mt = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
    vec3 mb = cross(mt, uMoonDir);
    vec2 mp = vec2(dot(d - uMoonDir, mt), dot(d - uMoonDir, mb)) / max(1e-4, uMoonSize);
    if (uSky > 0.0) {
      // A7c: thick cloud crosses the disc; the halo is already in the gaps (crater noise only on the disc: cost)
      if (m > 0.0) col = mix(col, uMoonColor * (0.75 + an_fbm(vec3(mp * 3.0, 1.0)) * 0.5), m * (1.0 - uSkyB.w * smoothstep(0.72, 0.97, skyD)));
    } else {
    float crater = an_fbm(vec3(mp * 3.0, 1.0));
    col = mix(col, uMoonColor * (0.75 + crater * 0.5), m);
    if (uMoonHalo > 0.0) {
      // halo widths relative to the disc: a tight corona (about 1.6 radii) for bloom + a wide soft glow (about 6 radii)
      float k1 = 0.693 / max(1e-5, 1.0 - cos(uMoonSize * 1.6));
      float k2 = 0.693 / max(1e-5, 1.0 - cos(uMoonSize * 6.0));
      col += uMoonColor * uMoonHalo * (pow(max(md, 0.0), k1) * 0.35 + pow(max(md, 0.0), k2) * 0.07) * (1.0 - m);
    } else {
      col += uMoonColor * (pow(max(md, 0.0), 900.0) * 0.6 + pow(max(md, 0.0), 60.0) * 0.06);
    }
    // A7b: storm cloud wisps drift across the lower part of the disc (backlit: they stay bright-edged)
    if (uStorm > 0.0) col = mix(col, stCol * 1.4, stDens * m * 0.55 * (1.0 - smoothstep(-0.6, 0.3, mp.y)));
    }
  }
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}`;

export function makeSkyMaterial(p: SkyParams): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: true,
    uniforms: {
      uSunDir: { value: p.sunDir },
      uSunColor: { value: p.sunColor },
      uSunSize: { value: p.sunSize },
      uSunGlow: { value: p.sunGlow },
      uZenith: { value: p.zenith },
      uHorizon: { value: p.horizon },
      uGround: { value: p.ground },
      uHorizonGlow: { value: p.horizonGlow },
      uCloudCover: { value: p.cloudCover },
      uCloudScale: { value: p.cloudScale },
      uCloudColor: { value: p.cloudColor },
      uCloudShade: { value: p.cloudShade },
      uCloudSpeed: { value: p.cloudSpeed },
      uStars: { value: p.stars },
      uAurora: { value: p.aurora },
      uAuroraA: { value: p.auroraA },
      uAuroraB: { value: p.auroraB },
      uMoonDir: { value: p.moonDir },
      uMoonSize: { value: p.moonSize },
      uMoonColor: { value: p.moonColor },
      uMoonHalo: { value: p.moonHalo ?? 0 },
      uStorm: { value: p.storm ?? 0 },
      uStormLit: { value: p.stormLit ?? new THREE.Color(1, 1, 1) },
      uStormTex: { value: p.stormTex ?? null },
      uTime: shaderTime,
      ...skyUniforms(p),
    },
  });
}

/** A7c: the authored-sky uniforms (uSky 0 = off: every other sky renders as before) */
function skyUniforms(p: SkyParams): Record<string, THREE.IUniform> {
  const L = p.skyLook;
  const on = !!(p.skyTex && L);
  const v3 = (a: number[] | undefined, k = 1) => new THREE.Vector3((a?.[0] ?? 0) * k, (a?.[1] ?? 0) * k, (a?.[2] ?? 0) * k);
  const ramp = (p.skyRamp ?? []).map((c) => new THREE.Vector3(c[0], c[1], c[2]));
  while (ramp.length < 6) ramp.push(ramp[ramp.length - 1]?.clone() ?? new THREE.Vector3());
  return {
    uSky: { value: on ? 1 : 0 },
    uSkyTex: { value: on ? p.skyTex! : null },
    uSkyRamp: { value: ramp.slice(0, 6) },
    uSkyA: { value: new THREE.Vector4(L?.gain ?? 1, L?.amb ?? 0, L?.mid ?? 0, L?.wide ?? 0) },
    uSkyK: { value: new THREE.Vector4(halfK(L?.midDeg ?? 20), halfK(L?.wideDeg ?? 60), halfK(L?.hotDeg ?? 8), halfK(L?.rimDeg ?? 14)) },
    uSkyB: { value: new THREE.Vector4(L?.hot ?? 0, L?.sat ?? 1, L?.drift ?? 0, L?.moonOcclude ?? 0) },
    uSkyBank: { value: new THREE.Vector4(L?.bankH ?? 0.2, L?.bankDark ?? 0, L?.bankDens ?? 0, L?.bankAway ?? 0) },
    uSkyRim: { value: v3(L?.rim, L?.rimGain ?? 0) },
    uSkyGapFar: { value: v3(L?.gapFar) },
    uSkyGapNear: { value: v3(L?.gapNear) },
    uSkyShaft: { value: v3(L?.shaft, L?.shaftGain ?? 0) },
    uSkyFlash: { value: new THREE.Vector4(L?.flash?.[0] ?? 1, L?.flash?.[1] ?? 1, L?.flash?.[2] ?? 1, 0) },
    uSkyFlashDir: { value: new THREE.Vector3(1, 0.2, 0).normalize() },
  };
}

/**
 * A7c: distant lightning, a pure function of time (match time in a fight; no Math.random, never touches the sim): one
 * possible strike per `every` seconds (about 60 % of slots fire), a double / triple flicker at a hashed offset and azimuth
 * (away from the moon, low in the sky). Returns the flash level 0..1 and writes the direction.
 */
export function lightningAt(t: number, every: number, dir: THREE.Vector3, moonAz: number): number {
  if (!(every > 0) || !(t >= 0)) return 0;
  const hash = (n: number) => {
    let x = (n * 374761393 + 668265263) | 0;
    x = Math.imul(x ^ (x >>> 13), 1274126177);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  };
  const slot = Math.floor(t / every);
  let level = 0;
  // the previous slot too: a strike near the end of a slot can still be fading at the start of the next
  for (const n of [slot - 1, slot]) {
    if (n < 1 || hash(n * 4 + 1) > 0.6) continue; // none in the first slot (intro, concept shots)
    const t0 = n * every + every * (0.1 + 0.8 * hash(n * 4 + 2));
    const dt = t - t0;
    if (dt < 0 || dt > 1.6) continue;
    const pulse = (a: number, at: number, k: number) => (dt >= at ? a * Math.exp(-(dt - at) * k) : 0);
    const amp = 0.55 + 0.45 * hash(n * 4 + 3);
    const l = amp * Math.max(pulse(1, 0, 14), pulse(0.7, 0.13, 10), hash(n * 4 + 4) > 0.5 ? pulse(0.85, 0.34, 6) : 0);
    if (l > level) {
      level = l;
      const az = moonAz + (hash(n * 4 + 5) > 0.5 ? 1 : -1) * (40 + 120 * hash(n * 4 + 6)) * (Math.PI / 180);
      const el = (6 + 16 * hash(n * 4 + 7)) * (Math.PI / 180);
      dir.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
    }
  }
  return level;
}

export function makeSky(p: SkyParams): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), makeSkyMaterial(p));
  m.frustumCulled = false;
  m.renderOrder = -10;
  return m;
}

/** Bake an environment map (IBL) from the sky (plus optional extra objects, e.g. a sea of clouds). */
export function bakeEnvironment(renderer: THREE.WebGLRenderer, p: SkyParams, extra: THREE.Object3D[] = [], opts: { fog?: THREE.Fog; far?: number } = {}): THREE.Texture {
  const scene = new THREE.Scene();
  scene.add(makeSky(p));
  for (const e of extra) scene.add(e);
  // A7b: the backdrop layers in the probe need the scene fog (their fog match reads its uniforms)
  if (opts.fog) scene.fog = opts.fog;
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(scene, 0.02, 0.1, opts.far ?? 1200);
  pm.dispose();
  return rt.texture;
}

const STORM_BAKE_FRAG = /* glsl */ `
uniform vec3 uMoonDir; uniform vec3 uStormLit; uniform vec3 uStormDark; uniform float uStormScale;
varying vec2 vUv;
${GLSL_NOISE}
void main(){
  float az = (vUv.x - 0.5) * 6.2831853;
  float y = vUv.y * 1.1 - 0.1;
  float r = sqrt(max(0.0, 1.0 - y * y));
  vec3 d = vec3(r * cos(az), y, r * sin(az));
  vec3 q = d * uStormScale;
  q.y *= 2.2; // flattened billows
  float n1 = an_fbm(q);
  float n2 = an_fbm(q * 2.7 + vec3(4.1, 1.3, 7.7));
  float n = n1 * 0.72 + n2 * 0.28;
  float md = max(dot(d, uMoonDir), 0.0);
  float glow = pow(md, 28.0) * 1.0 + pow(md, 7.0) * 0.28 + pow(md, 2.5) * 0.05;
  float dens = smoothstep(0.36, 0.62, n);
  // light from behind: thin cloud and cloud edges near the moon glow, thick cloud stays dark
  float thin = 1.0 - smoothstep(0.42, 0.75, n);
  float edge = smoothstep(0.36, 0.48, n) * thin;
  float lit = clamp(glow * (0.35 + 1.4 * thin) + edge * glow * 2.5, 0.0, 3.0);
  vec3 c = mix(uStormDark, uStormLit, clamp(lit, 0.0, 1.0)) + uStormLit * max(lit - 1.0, 0.0) * 0.6;
  c *= 0.8 + 0.4 * an_noise(q * 6.0); // grain inside the billows
  gl_FragColor = vec4(sqrt(clamp(c * 0.5, 0.0, 1.0)), dens);
}`;

/**
 * A7b: bake the storm deck (SkyParams.storm) into an equirectangular texture (u = azimuth, v = (dir.y + 0.1) / 1.1), once
 * per arena build: the fbm per sky pixel cost 2-3 ms per frame on the Arc iGPU (same-page timer A/B). The sky samples it.
 */
export function bakeStormTexture(renderer: THREE.WebGLRenderer, p: SkyParams, w = 2048, h = 512): THREE.Texture {
  const rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
  rt.texture.wrapS = THREE.RepeatWrapping;
  rt.texture.name = 'sky.storm';
  rt.texture.userData.rt = rt; // the owner disposes the target through its texture
  const mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: STORM_BAKE_FRAG,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uMoonDir: { value: p.moonDir },
      uStormLit: { value: p.stormLit ?? new THREE.Color(1, 1, 1) },
      uStormDark: { value: p.stormDark ?? new THREE.Color(0, 0, 0) },
      uStormScale: { value: p.stormScale ?? 3 },
    },
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.Camera();
  const prev = renderer.getRenderTarget();
  const tm = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prev);
  renderer.toneMapping = tm;
  quad.geometry.dispose();
  mat.dispose();
  return rt.texture;
}