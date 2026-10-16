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
}

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
uniform vec3 uMoonDir; uniform float uMoonSize; uniform vec3 uMoonColor;
uniform float uTime;
varying vec3 vDir;
${GLSL_NOISE}
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
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
  if (uStars > 0.0 && h > -0.02) {
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
    float crater = an_fbm(vec3(mp * 3.0, 1.0));
    col = mix(col, uMoonColor * (0.75 + crater * 0.5), m);
    col += uMoonColor * (pow(max(md, 0.0), 900.0) * 0.6 + pow(max(md, 0.0), 60.0) * 0.06);
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
      uTime: shaderTime,
    },
  });
}

export function makeSky(p: SkyParams): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), makeSkyMaterial(p));
  m.frustumCulled = false;
  m.renderOrder = -10;
  return m;
}

/** Bake an environment map (IBL) from the sky (plus optional extra objects, e.g. a sea of clouds). */
export function bakeEnvironment(renderer: THREE.WebGLRenderer, p: SkyParams, extra: THREE.Object3D[] = []): THREE.Texture {
  const scene = new THREE.Scene();
  scene.add(makeSky(p));
  for (const e of extra) scene.add(e);
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(scene, 0.02, 0.1, 1200);
  pm.dispose();
  return rt.texture;
}
