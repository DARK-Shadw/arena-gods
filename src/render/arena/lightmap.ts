/**
 * FLOOR LIGHT MAP (arena art plan 5.7 / 6.2, milestone A2): the warm pools of light that dozens of flames throw on
 * the floor, at zero per-frame cost. Every flame WITHOUT a real PointLight (the arena keeps a few real lights per
 * tier) and every lava pool adds the irradiance of a point source at its height into a top-down HDR texture over
 * the floor bounds:  E(d) = P * h / (d^2 + h^2)^1.5  (Lambert irradiance of a point at height h).
 * One fragment pass (up to MAX sources in a uniform array) renders it; the arena re-renders it only when a
 * source moves, appears or disappears (a carried or broken brazier), not every frame. The floor shader multiplies
 * it by a global flicker (floor.ts `uFLmGain`).
 */
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import type { FloorLightSource } from './reflection';

const MAX = 48;

const FRAG = /* glsl */ `
uniform vec4 uSrc[${MAX}];   // x, z, height, power
uniform vec3 uCol[${MAX}];
uniform int uN;
uniform vec4 uXf;            // x0, z0, width, depth (metres)
varying vec2 vUv;
void main() {
  vec2 p = uXf.xy + vUv * uXf.zw;
  vec3 e = vec3(0.0);
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= uN) break;
    vec4 s = uSrc[i];
    vec2 d = p - s.xy;
    float h = s.z;
    float r2 = dot(d, d) + h * h;
    e += uCol[i] * (s.w * h / (r2 * sqrt(r2)));
  }
  gl_FragColor = vec4(e, 1.0);
}`;

export class FloorLightMap {
  readonly rt: THREE.WebGLRenderTarget;
  /** world -> uv transform for the floor shader: (x0, z0, 1/width, 1/depth) */
  readonly xf = new THREE.Vector4();
  private mat: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private sig = '';
  renders = 0;
  lastMs = 0;

  constructor(halfW: number, halfD: number, size = 512) {
    this.rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.rt.texture.name = 'arena.floorLightMap';
    const src = Array.from({ length: MAX }, () => new THREE.Vector4());
    const col = Array.from({ length: MAX }, () => new THREE.Vector3());
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uSrc: { value: src }, uCol: { value: col }, uN: { value: 0 }, uXf: { value: new THREE.Vector4(-halfW, -halfD, 2 * halfW, 2 * halfD) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
    // render-target uv = ((x - x0) / width, (z - z0) / depth)
    this.xf.set(-halfW, -halfD, 1 / (2 * halfW), 1 / (2 * halfD));
  }

  /** re-render when the source list changed (positions rounded to 2 cm); returns true when it rendered */
  update(r: THREE.WebGLRenderer, list: FloorLightSource[]): boolean {
    const n = Math.min(MAX, list.length);
    let sig = String(n);
    for (let i = 0; i < n; i++) {
      const s = list[i];
      sig += `|${Math.round(s.x * 50)},${Math.round(s.z * 50)},${Math.round(s.y * 50)},${s.power.toFixed(2)}`;
    }
    if (sig === this.sig) return false;
    this.sig = sig;
    const t0 = performance.now();
    const U = this.mat.uniforms;
    for (let i = 0; i < n; i++) {
      const s = list[i];
      (U.uSrc.value as THREE.Vector4[])[i].set(s.x, s.z, Math.max(0.15, s.y), s.power);
      (U.uCol.value as THREE.Vector3[])[i].set(s.color.r, s.color.g, s.color.b);
    }
    U.uN.value = n;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.rt);
    this.quad.render(r);
    r.setRenderTarget(prev);
    this.renders++;
    this.lastMs = performance.now() - t0;
    return true;
  }

  dispose() {
    this.rt.dispose();
    this.mat.dispose();
    this.quad.dispose();
  }
}
