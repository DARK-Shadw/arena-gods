/**
 * GPU ambient particles (petals, embers, snow, dust motes, fireflies, blowing
 * sand, light motes). Positions are computed entirely in the vertex shader
 * from a per-particle seed and time, wrapping inside a box around the arena,
 * so they cost no CPU per frame.
 */
import * as THREE from 'three';
import type { AmbientKind } from './themes';
import { petalSprite, softDot } from './textures';
import { shaderTime } from './materials';

interface Kind {
  color: string;
  color2: string;
  size: number;
  /** base velocity m/s */
  vel: [number, number, number];
  sway: number;
  additive: boolean;
  sprite: 'dot' | 'petal';
  box: [number, number, number];
  y0: number;
  blink: number;
  opacity: number;
  count: number;
}

const KINDS: Record<AmbientKind, Kind> = {
  dust: { color: '#ffe2a8', color2: '#fff4d8', size: 0.05, vel: [0.25, 0.05, 0.1], sway: 0.35, additive: true, sprite: 'dot', box: [34, 8, 34], y0: 0.2, blink: 0.4, opacity: 0.55, count: 1600 },
  motes: { color: '#fff6d0', color2: '#cfe8ff', size: 0.06, vel: [0.15, 0.25, 0.05], sway: 0.5, additive: true, sprite: 'dot', box: [34, 10, 34], y0: 0.0, blink: 0.6, opacity: 0.7, count: 1300 },
  petals: { color: '#ffd3e2', color2: '#ffb3cc', size: 0.16, vel: [0.7, -0.55, 0.25], sway: 0.9, additive: false, sprite: 'petal', box: [38, 12, 38], y0: 0.0, blink: 0, opacity: 0.95, count: 1800 },
  embers: { color: '#ff9a3a', color2: '#ffd070', size: 0.06, vel: [0.2, 1.1, 0.1], sway: 0.7, additive: true, sprite: 'dot', box: [36, 14, 36], y0: 0.0, blink: 0.8, opacity: 1, count: 1800 },
  snow: { color: '#f2f8ff', color2: '#d8ecff', size: 0.075, vel: [0.35, -0.9, 0.15], sway: 0.6, additive: false, sprite: 'dot', box: [40, 14, 40], y0: 0.0, blink: 0, opacity: 0.9, count: 2600 },
  fireflies: { color: '#e8ff8a', color2: '#ffd86a', size: 0.09, vel: [0.05, 0.03, 0.05], sway: 1.2, additive: true, sprite: 'dot', box: [40, 5, 40], y0: 0.3, blink: 1, opacity: 1, count: 700 },
  sand: { color: '#e6b07a', color2: '#f2c89a', size: 0.04, vel: [3.2, 0.05, 0.6], sway: 0.3, additive: false, sprite: 'dot', box: [40, 2.5, 40], y0: 0.0, blink: 0, opacity: 0.5, count: 2400 },
};

export class Ambient {
  group = new THREE.Group();
  private mats: THREE.ShaderMaterial[] = [];

  constructor(kinds: AmbientKind[], quality: number) {
    for (const k of kinds) this.add(KINDS[k], quality);
  }

  private add(K: Kind, quality: number) {
    const n = Math.round(K.count * (quality >= 2 ? 1 : quality === 1 ? 0.6 : 0.3));
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n * 4);
    let s = 1234567;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = rnd() * K.box[0];
      pos[i * 3 + 1] = rnd() * K.box[1];
      pos[i * 3 + 2] = rnd() * K.box[2];
      seed[i * 4] = rnd();
      seed[i * 4 + 1] = rnd();
      seed[i * 4 + 2] = rnd();
      seed[i * 4 + 3] = rnd();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    const m = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: K.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: false,
      uniforms: {
        uTime: shaderTime,
        uBox: { value: new THREE.Vector3(...K.box) },
        uVel: { value: new THREE.Vector3(...K.vel) },
        uSway: { value: K.sway },
        uSize: { value: K.size },
        uScale: { value: 800 },
        uY0: { value: K.y0 },
        uColor: { value: new THREE.Color(K.color) },
        uColor2: { value: new THREE.Color(K.color2) },
        uBlink: { value: K.blink },
        uOpacity: { value: K.opacity },
        uMap: { value: K.sprite === 'petal' ? petalSprite() : softDot() },
        uPetal: { value: K.sprite === 'petal' ? 1 : 0 },
        uFocus: { value: new THREE.Vector3() },
      },
      vertexShader: /* glsl */ `
        attribute vec4 seed;
        uniform float uTime; uniform vec3 uBox; uniform vec3 uVel; uniform float uSway; uniform float uSize; uniform float uScale; uniform float uY0; uniform float uBlink; uniform vec3 uFocus;
        varying float vA; varying float vRot; varying float vMix;
        void main(){
          float t = uTime;
          vec3 v = uVel * (0.6 + seed.x * 0.8);
          vec3 p = position + v * t;
          p.x += sin(t * (0.6 + seed.y) + seed.z * 6.28) * uSway;
          p.z += cos(t * (0.5 + seed.w) + seed.x * 6.28) * uSway;
          p.y += sin(t * (0.9 + seed.z) + seed.w * 6.28) * uSway * 0.3;
          // wrap inside a box centred on the arena (x/z) and above the floor (y)
          vec3 c = vec3(uFocus.x - uBox.x * 0.5, uY0, uFocus.z - uBox.z * 0.5);
          p = c + mod(p - c, uBox);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float sz = uSize * (0.6 + seed.y * 0.8);
          gl_PointSize = sz * uScale / max(0.5, -mv.z);
          // fade at the box edges + near the camera
          vec3 q = (p - c) / uBox;
          float edge = smoothstep(0.0, 0.08, q.y) * smoothstep(1.0, 0.85, q.y);
          float blink = mix(1.0, 0.5 + 0.5 * sin(t * (2.0 + seed.w * 4.0) + seed.x * 30.0), uBlink);
          vA = edge * blink * smoothstep(0.3, 1.2, -mv.z);
          vRot = t * (1.0 + seed.z * 2.0) + seed.w * 6.28;
          vMix = seed.y;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap; uniform vec3 uColor; uniform vec3 uColor2; uniform float uOpacity; uniform float uPetal;
        varying float vA; varying float vRot; varying float vMix;
        void main(){
          vec2 uv = gl_PointCoord - 0.5;
          if (uPetal > 0.5) { float c = cos(vRot), s = sin(vRot); uv = mat2(c, -s, s, c) * uv; uv.x *= 1.0 + 0.6 * sin(vRot * 1.7); }
          vec4 tx = texture2D(uMap, uv + 0.5);
          vec3 col = mix(uColor, uColor2, vMix);
          gl_FragColor = vec4(col * (uPetal > 0.5 ? tx.rgb : vec3(1.0)), tx.a * vA * uOpacity);
          if (gl_FragColor.a < 0.01) discard;
        }`,
    });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    this.group.add(pts);
    this.mats.push(m);
  }

  setViewport(h: number, fovDeg: number) {
    const s = h / (2 * Math.tan((fovDeg * Math.PI) / 360));
    for (const m of this.mats) m.uniforms.uScale.value = s;
  }

  dispose() {
    for (const c of this.group.children) {
      (c as THREE.Points).geometry.dispose();
      ((c as THREE.Points).material as THREE.Material).dispose();
    }
  }
}
