/**
 * Weapon trails and attack telegraph decals (per FighterView), plus the old
 * `VFX` import path. Particles, rings, debris and the impact light now live in
 * `fx/` (FX director + stateless GPU particles, milestone F0); `VFX` is
 * re-exported from there so existing imports keep working.
 * Trails move into fx/ribbons.ts in F3.
 */
import * as THREE from 'three';

/** Ribbon trail following two markers (weapon base & tip). */
export class Trail {
  mesh: THREE.Mesh;
  private n = 9;
  private pts: THREE.Vector3[] = [];
  private geo: THREE.BufferGeometry;
  private posArr: Float32Array;
  private alphaArr: Float32Array;
  private mat: THREE.ShaderMaterial;
  intensity = 0;

  constructor(color: THREE.Color) {
    this.geo = new THREE.BufferGeometry();
    this.posArr = new Float32Array(this.n * 2 * 3);
    this.alphaArr = new Float32Array(this.n * 2);
    const idx: number[] = [];
    for (let i = 0; i < this.n - 1; i++) {
      const a = i * 2,
        b = a + 1,
        c = a + 2,
        d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.posArr, 3));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alphaArr, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { color: { value: color }, intensity: { value: 0 } },
      vertexShader: `attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
      fragmentShader: `uniform vec3 color; uniform float intensity; varying float vA; void main(){ gl_FragColor = vec4(color*1.3, vA*intensity*0.75); }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < this.n * 2; i++) this.pts.push(new THREE.Vector3());
  }

  push(base: THREE.Vector3, tip: THREE.Vector3, active: number) {
    // shift
    for (let i = this.n - 1; i > 0; i--) {
      this.pts[i * 2].copy(this.pts[(i - 1) * 2]);
      this.pts[i * 2 + 1].copy(this.pts[(i - 1) * 2 + 1]);
    }
    this.pts[0].copy(base);
    this.pts[1].copy(tip);
    for (let i = 0; i < this.n; i++) {
      const a = 1 - i / (this.n - 1);
      this.posArr.set([this.pts[i * 2].x, this.pts[i * 2].y, this.pts[i * 2].z], i * 6);
      this.posArr.set([this.pts[i * 2 + 1].x, this.pts[i * 2 + 1].y, this.pts[i * 2 + 1].z], i * 6 + 3);
      this.alphaArr[i * 2] = 0;
      this.alphaArr[i * 2 + 1] = a * a * 0.8;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
    this.intensity += (active - this.intensity) * 0.35;
    this.mat.uniforms.intensity.value = this.intensity;
    this.mesh.visible = this.intensity > 0.01;
  }
}

/**
 * Ground decal showing an attack's reach during its windup: a bright rim at
 * max range plus a fill that sweeps outward as the windup charges, so
 * viewers can read "big hit incoming, and this is where it lands".
 */
export class Telegraph {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  private arc = -1;
  private range = -1;
  constructor(color: THREE.Color) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { color: { value: color }, k: { value: 0 }, strength: { value: 1 }, inner: { value: 0.2 } },
      vertexShader: `varying vec2 vUv; varying vec3 vP; void main(){ vUv = uv; vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
      fragmentShader: `
        uniform vec3 color; uniform float k; uniform float strength; uniform float inner;
        varying vec3 vP;
        void main(){
          float r = length(vP.xy);
          float rim = smoothstep(0.93, 0.985, r) * (1.0 - smoothstep(0.985, 1.0, r));
          float fill = step(r, k) * 0.35 * (0.6 + 0.4 * r);
          float front = smoothstep(k - 0.06, k, r) * (1.0 - step(k, r)) * 0.8;
          float a = (rim * 0.9 + fill + front) * strength;
          gl_FragColor = vec4(color * 1.4, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.RingGeometry(0.15, 1, 48, 1, 0, 1), this.mat);
    this.mesh.position.y = 0.03;
    this.mesh.visible = false;
    this.mesh.renderOrder = 2;
  }
  /** t: a sim-time clock for the pulse (was performance.now: not reproducible, kept pulsing through hit-stop) */
  show(x: number, z: number, facing: number, range: number, arcDeg: number, aoe: boolean, k: number, big: boolean, t = 0) {
    const arc = aoe ? Math.PI * 2 : Math.min(Math.PI * 2, (arcDeg * Math.PI) / 90);
    if (arc !== this.arc) {
      this.mesh.geometry.dispose();
      // unit radius; scaled by range below so the shader can work in 0..1
      this.mesh.geometry = new THREE.RingGeometry(0.12, 1, 48, 1, 0, arc);
      this.arc = arc;
    }
    this.range = range;
    this.mesh.scale.set(range, range, range);
    this.mesh.position.set(x, 0.03, z);
    // Ring theta θ maps (after the -90° X tilt) to world dir (cos θ, 0, -sin θ);
    // facing f is world dir (sin f, 0, cos f) => centre θ = f - π/2.
    this.mesh.rotation.set(-Math.PI / 2, 0, facing - Math.PI / 2 - arc / 2);
    this.mat.uniforms.k.value = 0.15 + 0.85 * k;
    this.mat.uniforms.strength.value = (big ? 0.75 : 0.45) * (0.85 + Math.sin(t * 30) * 0.15);
    this.mesh.visible = true;
  }
  hide() {
    this.mesh.visible = false;
  }
}

/** The VFX class moved to fx/legacyVfx.ts (stateless GPU particles behind the same API). */
export { VFX } from './fx/legacyVfx';
