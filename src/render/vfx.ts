/**
 * VFX: CPU particle pools (additive + alpha), expanding shockwave rings,
 * prop debris, weapon trails and attack telegraph decals.
 * Everything is blood-free: impacts are sparks, flashes and dust.
 */
import * as THREE from 'three';

function softTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.3, 'rgba(255,255,255,0.6)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

class ParticlePool {
  points: THREE.Points;
  private n: number;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private drag: Float32Array;
  private grav: Float32Array;
  private size0: Float32Array;
  private grow: Float32Array;
  private cursor = 0;

  private maxAlpha: number;
  constructor(n: number, additive: boolean, tex: THREE.Texture, maxAlpha = 1) {
    this.maxAlpha = maxAlpha;
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.size0 = new Float32Array(n);
    this.grow = new Float32Array(n);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, scale: { value: 600 } },
      vertexShader: `
        attribute float size; attribute float alpha; attribute vec3 color;
        varying vec3 vColor; varying float vAlpha;
        uniform float scale;
        void main(){
          vColor = color; vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = size * scale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D map; varying vec3 vColor; varying float vAlpha;
        void main(){
          vec4 t = texture2D(map, gl_PointCoord);
          gl_FragColor = vec4(vColor, t.a * vAlpha);
          if (gl_FragColor.a < 0.004) discard;
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  emit(p: THREE.Vector3, v: THREE.Vector3, color: THREE.Color, size: number, life: number, opts: { drag?: number; grav?: number; grow?: number } = {}) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    this.size0[i] = size;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.drag[i] = opts.drag ?? 1;
    this.grav[i] = opts.grav ?? 0;
    this.grow[i] = opts.grow ?? 0;
    this.alpha[i] = 1;
  }

  update(dt: number) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      const d = Math.exp(-this.drag[i] * dt);
      const j = i * 3;
      this.vel[j] *= d;
      this.vel[j + 2] *= d;
      this.vel[j + 1] = this.vel[j + 1] * d - this.grav[i] * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      if (this.pos[j + 1] < 0.02 && this.grav[i] > 0) {
        this.pos[j + 1] = 0.02;
        this.vel[j + 1] *= -0.3;
        this.vel[j] *= 0.6;
        this.vel[j + 2] *= 0.6;
      }
      this.alpha[i] = (k < 0.3 ? k / 0.3 : 1) * this.maxAlpha;
      this.size[i] = this.size0[i] * (1 + this.grow[i] * (1 - k));
    }
    const g = this.points.geometry;
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.alpha as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}

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
  show(x: number, z: number, facing: number, range: number, arcDeg: number, aoe: boolean, k: number, big: boolean) {
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
    this.mat.uniforms.strength.value = (big ? 0.75 : 0.45) * (0.85 + Math.sin(performance.now() * 0.03) * 0.15);
    this.mesh.visible = true;
  }
  hide() {
    this.mesh.visible = false;
  }
}

export class VFX {
  group = new THREE.Group();
  add: ParticlePool;
  alpha: ParticlePool;
  private rings: { mesh: THREE.Mesh; life: number; max: number; size: number }[] = [];
  private debris: { mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3; life: number }[] = [];
  private tmpV = new THREE.Vector3();
  private tmpP = new THREE.Vector3();
  private col = new THREE.Color();
  flashLight: THREE.PointLight;

  constructor() {
    const tex = softTexture();
    this.add = new ParticlePool(3000, true, tex);
    this.alpha = new ParticlePool(1500, false, tex, 0.45);
    this.group.add(this.alpha.points, this.add.points);
    this.flashLight = new THREE.PointLight('#ffd0a0', 0, 9, 2);
    this.group.add(this.flashLight);
  }

  private rnd(a: number, b: number) {
    return a + Math.random() * (b - a);
  }

  sparks(p: THREE.Vector3, n: number, color = '#ffc070', speed = 7, dir?: THREE.Vector3) {
    this.col.set(color);
    for (let i = 0; i < n; i++) {
      this.tmpV.set(this.rnd(-1, 1), this.rnd(-0.2, 1.2), this.rnd(-1, 1)).normalize().multiplyScalar(speed * this.rnd(0.3, 1));
      if (dir) this.tmpV.addScaledVector(dir, speed * 0.6);
      this.add.emit(p, this.tmpV, this.col, this.rnd(0.04, 0.09), this.rnd(0.25, 0.6), { drag: 2, grav: 9 });
    }
  }

  flash(p: THREE.Vector3, color = '#fff0d0', size = 1.2, light = 6) {
    this.col.set(color);
    this.add.emit(p, this.tmpV.set(0, 0, 0), this.col, size, 0.12, { grow: 1.5 });
    this.add.emit(p, this.tmpV.set(0, 0, 0), this.col, size * 0.5, 0.2, { grow: 0.5 });
    this.flashLight.position.copy(p);
    this.flashLight.color.set(color);
    this.flashLight.intensity = Math.max(this.flashLight.intensity, light);
  }

  dust(p: THREE.Vector3, n: number, spread = 1, color = '#9a8064') {
    this.col.set(color);
    for (let i = 0; i < n; i++) {
      this.tmpP.set(p.x + this.rnd(-0.3, 0.3) * spread, 0.1 + Math.random() * 0.2, p.z + this.rnd(-0.3, 0.3) * spread);
      this.tmpV.set(this.rnd(-1, 1) * 2 * spread, this.rnd(0.2, 1.2), this.rnd(-1, 1) * 2 * spread);
      this.alpha.emit(this.tmpP, this.tmpV, this.col, this.rnd(0.3, 0.6) * spread, this.rnd(0.6, 1.3), { drag: 2.5, grow: 1.4 });
    }
  }

  smoke(p: THREE.Vector3, n: number, color = '#2a2230', size = 1.2, rise = 0.8) {
    this.col.set(color);
    for (let i = 0; i < n; i++) {
      this.tmpP.set(p.x + this.rnd(-0.6, 0.6), p.y + this.rnd(0, 1.5), p.z + this.rnd(-0.6, 0.6));
      this.tmpV.set(this.rnd(-1, 1), this.rnd(0, rise), this.rnd(-1, 1));
      this.alpha.emit(this.tmpP, this.tmpV, this.col, size * this.rnd(0.7, 1.3), this.rnd(1.2, 2.5), { drag: 1.2, grow: 1.2 });
    }
  }

  fire(p: THREE.Vector3, v: THREE.Vector3, n: number, size = 0.35, spread = 0.6) {
    for (let i = 0; i < n; i++) {
      this.col.setHSL(this.rnd(0.02, 0.1), 1, this.rnd(0.45, 0.6));
      this.tmpV.copy(v).add(this.tmpP.set(this.rnd(-1, 1) * spread, this.rnd(0, 1) * spread, this.rnd(-1, 1) * spread));
      this.add.emit(p, this.tmpV, this.col, size * this.rnd(0.6, 1.2), this.rnd(0.3, 0.6), { drag: 1.5, grav: -2, grow: 0.8 });
    }
  }

  embers(p: THREE.Vector3, n: number, color = '#ff8a30', area = 1) {
    this.col.set(color);
    for (let i = 0; i < n; i++) {
      this.tmpP.set(p.x + this.rnd(-1, 1) * area, p.y + this.rnd(0, 0.5), p.z + this.rnd(-1, 1) * area);
      this.tmpV.set(this.rnd(-0.4, 0.4), this.rnd(0.8, 2.2), this.rnd(-0.4, 0.4));
      this.add.emit(this.tmpP, this.tmpV, this.col, this.rnd(0.03, 0.07), this.rnd(1, 2.5), { drag: 0.5, grav: -0.3 });
    }
  }

  shockwave(p: THREE.Vector3, color = '#ffd8a0', size = 4, life = 0.5) {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(p.x, 0.05, p.z);
    this.group.add(m);
    this.rings.push({ mesh: m, life, max: life, size });
  }

  /** Glowing arrow streak travelling from -> to. */
  arrow(from: THREE.Vector3, to: THREE.Vector3, color = '#c8ffe0') {
    const len = from.distanceTo(to);
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 0.9, 5),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    m.geometry.rotateX(Math.PI / 2);
    m.position.copy(from);
    m.lookAt(to);
    this.group.add(m);
    this.arrows.push({ mesh: m, from: from.clone(), to: to.clone(), t: 0, dur: Math.max(0.06, len / 45) });
  }
  private arrows: { mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number }[] = [];

  debrisBurst(p: THREE.Vector3, color = '#6b4a2c', n = 10) {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(this.rnd(0.1, 0.35), this.rnd(0.05, 0.12), this.rnd(0.1, 0.4)), mat);
      m.position.set(p.x + this.rnd(-0.3, 0.3), 0.5 + this.rnd(0, 0.5), p.z + this.rnd(-0.3, 0.3));
      m.castShadow = true;
      this.group.add(m);
      this.debris.push({ mesh: m, vel: new THREE.Vector3(this.rnd(-4, 4), this.rnd(2, 6), this.rnd(-4, 4)), spin: new THREE.Vector3(this.rnd(-9, 9), this.rnd(-9, 9), this.rnd(-9, 9)), life: 6 });
    }
    this.dust(p, 14, 1.2);
  }

  clear() {
    for (const a of this.arrows) this.group.remove(a.mesh);
    this.arrows = [];
    for (const r of this.rings) this.group.remove(r.mesh);
    for (const d of this.debris) this.group.remove(d.mesh);
    this.rings = [];
    this.debris = [];
  }

  update(dt: number) {
    this.add.update(dt);
    this.alpha.update(dt);
    this.flashLight.intensity *= Math.exp(-dt * 14);
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= dt;
      const k = 1 - r.life / r.max;
      const s = 0.3 + k * r.size;
      r.mesh.scale.set(s, s, s);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.8;
      if (r.life <= 0) {
        this.group.remove(r.mesh);
        r.mesh.geometry.dispose();
        this.rings.splice(i, 1);
      }
    }
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];
      a.t += dt;
      const k = Math.min(1, a.t / a.dur);
      a.mesh.position.lerpVectors(a.from, a.to, k);
      if (Math.random() < 0.6) this.add.emit(a.mesh.position, this.tmpV.set(0, 0, 0), this.col.set('#e8fff0'), 0.06, 0.25);
      if (k >= 1) {
        this.sparks(a.to, 8, '#e8fff0', 4);
        this.group.remove(a.mesh);
        a.mesh.geometry.dispose();
        this.arrows.splice(i, 1);
      }
    }
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      d.vel.y -= 14 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      if (d.mesh.position.y < 0.05) {
        d.mesh.position.y = 0.05;
        d.vel.multiplyScalar(0.4);
        d.vel.y = Math.abs(d.vel.y) * 0.3;
        d.spin.multiplyScalar(0.5);
      }
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
      if (d.life <= 0) {
        this.group.remove(d.mesh);
        this.debris.splice(i, 1);
      }
    }
  }
}
