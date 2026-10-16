/**
 * Theme dressing: the Blossom Shrine, the Moonlit Lake Temple, the Aurora Glacier.
 */
import * as THREE from 'three';
import type { V3 } from './arenaView';
import type { Obstacle } from '../../sim/arenaGen';
import type { Arena } from './arenaView';
import type { Dressing } from './dressing';
import { TEX, canvasTexture, foliageCard, genSet } from './textures';
import { pbr, withCrack, glowMat, waterMaterial, shaderTime } from './materials';
import { alongEllipse, ellipseAt, floorDisc, groundPlane, inGate, makeGate, sweepEllipse } from './common';
import { columnGeo, crystalCluster, pagodaGeo, rockGeo, toriiGeo, toroGeo, treeGeo } from './kit';
import { R, fbm2, hash2 } from './noise';

const shadowed = <T extends THREE.Mesh>(m: T, cast = true, recv = true): T => {
  m.castShadow = cast;
  m.receiveShadow = recv;
  return m;
};

function grassSet(c1: string, c2: string, seed: number) {
  const A = new THREE.Color(c1),
    B = new THREE.Color(c2);
  return genSet(`grass:${c1}:${c2}:${seed}`, 512, 1.0, (u, v, p) => {
    const n = fbm2(u * 8, v * 8, 4, seed, 8);
    const blade = hash2(Math.floor(u * 256), Math.floor(v * 96), seed);
    const k = n * 0.7 + blade * 0.3;
    p.r = A.r + (B.r - A.r) * k;
    p.g = A.g + (B.g - A.g) * k;
    p.b = A.b + (B.b - A.b) * k;
    p.h = k;
    p.ro = 0.95;
  });
}

/** instanced swaying grass tufts on a ring outside the arena */
function grassTufts(a: Arena, off0: number, off1: number, count: number, color: string, height = 0.38) {
  const L = a.layout;
  const tex = canvasTexture(128, (g, s) => {
    g.clearRect(0, 0, s, s);
    let r = 3;
    const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 40; i++) {
      const x = s * (0.15 + rnd() * 0.7);
      const lean = (rnd() - 0.5) * s * 0.35;
      g.strokeStyle = `rgba(${150 + rnd() * 60},${190 + rnd() * 50},${90 + rnd() * 50},1)`;
      g.lineWidth = 2 + rnd() * 3;
      g.beginPath();
      g.moveTo(x, s);
      g.quadraticCurveTo(x + lean * 0.3, s * 0.5, x + lean, s * (0.05 + rnd() * 0.35));
      g.stroke();
    }
  });
  const quad = new THREE.PlaneGeometry(0.7, height);
  quad.translate(0, height / 2, 0);
  const q2 = quad.clone().rotateY(Math.PI / 2);
  const geo = new THREE.BufferGeometry();
  const merged = [quad, q2].map((g) => g.toNonIndexed());
  const pos = new Float32Array(merged.reduce((s, g) => s + g.attributes.position.array.length, 0));
  const uv = new Float32Array(merged.reduce((s, g) => s + g.attributes.uv.array.length, 0));
  let o = 0,
    ou = 0;
  for (const g of merged) {
    pos.set(g.attributes.position.array as Float32Array, o);
    uv.set(g.attributes.uv.array as Float32Array, ou);
    o += g.attributes.position.array.length;
    ou += g.attributes.uv.array.length;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide, color, roughness: 0.9 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = shaderTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        { vec4 ip = instanceMatrix * vec4(0.0,0.0,0.0,1.0);
          float k = max(0.0, position.y);
          transformed.x += sin(uTime*1.7 + ip.x*0.4 + ip.z*0.3) * 0.12 * k;
          transformed.z += cos(uTime*1.3 + ip.x*0.3) * 0.08 * k; }`,
      );
    // grass normals point up for soft lighting
    sh.vertexShader = sh.vertexShader.replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0,1.0,0.0);');
  };
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const r = new R(L.seed + 91);
  const m = new THREE.Matrix4();
  let n = 0;
  for (let i = 0; i < count * 2 && n < count; i++) {
    const p = ellipseAt(L, r.next() * Math.PI * 2, r.range(off0, off1));
    if (inGate(L, p, 2.4)) continue;
    const s = r.range(0.6, 1.3);
    m.compose(p, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.next() * 6), new THREE.Vector3(s, s, s));
    mesh.setMatrixAt(n++, m);
  }
  mesh.count = n;
  mesh.receiveShadow = true;
  a.group.add(mesh);
}

/** trees with alpha-card canopies (cherry blossom / pine-ish) */
function trees(a: Arena, spots: THREE.Vector3[], c1: string, c2: string, barkCol: string, h = 6.5, cardSize = 2.0, emissive = '#000000') {
  const bark = pbr(TEX.bark(barkCol, 11), {});
  const cardTex = foliageCard(c1, c2, 3);
  const cardMat = new THREE.MeshStandardMaterial({ map: cardTex, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.85, emissive, emissiveIntensity: 0.25 });
  cardMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = shaderTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n{ vec4 ip = instanceMatrix*vec4(0.,0.,0.,1.); transformed.x += sin(uTime*1.1+ip.x*0.7+ip.y)*0.06; transformed.y += cos(uTime*1.4+ip.z*0.5)*0.04; }`);
  };
  const cards: THREE.Matrix4[] = [];
  const r = new R(a.layout.seed + 17);
  spots.forEach((sp, ti) => {
    const { geo, tips } = treeGeo(ti * 31 + 7, h * r.range(0.8, 1.2), 3.2, { droop: 0.4 });
    const trunk = shadowed(new THREE.Mesh(geo, bark));
    trunk.position.copy(sp);
    a.group.add(trunk);
    for (const tp of tips) {
      for (let k = 0; k < 7; k++) {
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r.range(-0.6, 0.6), r.next() * 6, r.range(-0.6, 0.6)));
        const s = cardSize * r.range(0.7, 1.25);
        const p = tp.clone().add(new THREE.Vector3(r.range(-0.9, 0.9), r.range(-0.4, 0.6), r.range(-0.9, 0.9))).add(sp);
        cards.push(new THREE.Matrix4().compose(p, q, new THREE.Vector3(s, s, s)));
      }
    }
  });
  const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), cardMat, cards.length);
  cards.forEach((m, i) => im.setMatrixAt(i, m));
  im.castShadow = true;
  im.receiveShadow = true;
  a.group.add(im);
}

/** layered distant mountain silhouettes */
function mountains(a: Arena, color: string, dist: number, height: number, count = 9, seed = 1) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true });
  const r = new R(seed);
  for (let i = 0; i < count; i++) {
    const an = (i / count) * Math.PI * 2 + r.range(-0.2, 0.2);
    const d = dist * r.range(0.85, 1.25);
    const g = rockGeo(height * r.range(0.6, 1.2), seed * 13 + i, { squash: 1.0, detail: 3, rough: 0.55 });
    const m = new THREE.Mesh(g, mat);
    m.scale.set(r.range(1.6, 2.6), r.range(0.6, 1.1), r.range(1.2, 1.8));
    m.position.set(Math.cos(an) * d, -height * 0.25, Math.sin(an) * d);
    m.rotation.y = r.next() * 6;
    a.group.add(m);
  }
}

// =====================================================================================
// THE BLOSSOM SHRINE
// =====================================================================================
export function dressSakura(a: Arena): Dressing {
  const L = a.layout;
  const G = a.group;
  const flags = TEX.flagstones('#a19c90', '#6c6a58', 41, 0.75, 6);
  const floorMat = pbr(flags, { macro: [0.06, 0.12] });
  const grass = pbr(grassSet('#5f8a36', '#9cbc58', 5), { macro: [0.03, 0.2] });
  const stone = pbr(TEX.blocks('#a6a196', '#77736a', 3, 2, 42, 0.4), { triplanar: 0.4, macro: [0.1, 0.1] });
  const stoneUV = pbr(TEX.blocks('#a6a196', '#77736a', 3, 2, 42, 0.4), { macro: [0.1, 0.1] });
  const lacquer = new THREE.MeshStandardMaterial({ color: '#c8361f', roughness: 0.42, metalness: 0.0 });
  const blackLacquer = new THREE.MeshStandardMaterial({ color: '#25201e', roughness: 0.5 });
  const roofMat = new THREE.MeshStandardMaterial({ color: '#3a4a52', roughness: 0.6, metalness: 0.2 });
  const woodMat = pbr(TEX.wood('#a07850', 43), {});
  const porcelain = new THREE.MeshStandardMaterial({ color: '#eef2fa', roughness: 0.22, map: blueWhiteTex() });
  const iron = pbr(TEX.metal('#3a3a3c', 44, 0.5), { metal: 1, rough: 1 });

  G.add(floorDisc(L, 1.2, 7, floorMat));
  // gravel band + grass outside
  G.add(shadowed(new THREE.Mesh(sweepEllipse(L, [[0.3, 0.0], [0.3, 0.12], [0.7, 0.14], [1.4, 0.04]], 200, 2.2, 0.6), stoneUV), false, true));
  G.add(groundPlane(700, 5, grass, -0.02, 120, (x, z) => {
    const d = Math.hypot(x / (L.rx + 2), z / (L.rz + 2));
    return d < 1.1 ? 0 : Math.min(1, (d - 1.1) * 0.3) * fbm2(x * 0.02, z * 0.02, 3, 9, 0) * 6;
  }));
  grassTufts(a, 1.3, 11, a.quality >= 2 ? 6000 : a.quality === 1 ? 3000 : 1000, '#cfe0b0');
  // vermilion fence
  alongEllipse(L, 0.95, 1.9, (p, yaw) => {
    const post = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.05, 0.14), lacquer));
    post.position.set(p.x, 0.52, p.z);
    post.rotation.y = yaw;
    G.add(post);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.2), blackLacquer);
    cap.position.set(p.x, 1.07, p.z);
    G.add(cap);
  }, 2.2);
  for (const y of [0.45, 0.88]) G.add(shadowed(new THREE.Mesh(sweepEllipse(L, [[0.92, y], [0.92, y + 0.08], [0.98, y + 0.08], [0.98, y]], 220, 2.2, 1), lacquer)));
  // cherry trees
  const spots: THREE.Vector3[] = [];
  const r = new R(L.seed + 5);
  for (let i = 0; i < 16; i++) {
    const an = (i / 16) * Math.PI * 2 + r.range(-0.12, 0.12);
    const p = ellipseAt(L, an, r.range(3.2, 9));
    if (inGate(L, p, 4.5)) continue;
    spots.push(p);
  }
  trees(a, spots, '#ffc6d9', '#ff9fc0', '#4a3530', 7, 2.3, '#ff7aa0');
  // stone lanterns along the outside
  alongEllipse(L, 2.2, 7.5, (p) => {
    const t = shadowed(new THREE.Mesh(toroGeo(2.2), stone));
    t.position.copy(p);
    G.add(t);
    const glow = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.3, 0.34), new THREE.MeshStandardMaterial({ color: '#ffd090', emissive: '#ffa040', emissiveIntensity: 2.5 }));
    glow.position.set(p.x, 1.38, p.z);
    G.add(glow);
  }, 4.0, 0.5);
  // shrine buildings in the backdrop
  for (const s of [-1, 1]) {
    const pg = shadowed(new THREE.Mesh(pagodaGeo(5, 4.2), lacquer));
    pg.position.set(s * 6, 0, s * (L.rz + 16));
    G.add(pg);
    const roofs = new THREE.Mesh(pagodaGeo(5, 4.2), roofMat);
    roofs.scale.set(1.02, 1.0, 1.02);
    roofs.position.copy(pg.position);
    void roofs;
  }
  const hall = new THREE.Group();
  const hb = shadowed(new THREE.Mesh(new THREE.BoxGeometry(14, 4, 7), lacquer));
  hb.position.y = 2.6;
  hall.add(hb);
  const hroof = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(3, 10, 3.2, 4, 1), roofMat));
  hroof.rotation.y = Math.PI / 4;
  hroof.scale.set(1.15, 1, 0.65);
  hroof.position.y = 6.2;
  hall.add(hroof);
  const hbase = shadowed(new THREE.Mesh(new THREE.BoxGeometry(16, 0.6, 9), stoneUV));
  hbase.position.y = 0.3;
  hall.add(hbase);
  hall.position.set(-(L.rx + 4), 0, -(L.rz + 14));
  hall.rotation.y = 0.5;
  G.add(hall);
  mountains(a, '#8a9ab8', 260, 120, 10, 3);
  // gates: torii + rope
  for (let i = 0; i < 2; i++) {
    makeGate(a, i, 0.95, (g) => {
      const t = shadowed(new THREE.Mesh(toriiGeo(4.6, 5.6), lacquer));
      g.add(t);
      for (const s of [-1, 1]) {
        const lt = shadowed(new THREE.Mesh(toroGeo(2.0), stone));
        lt.position.set(s * 3.4, 0, 1.2);
        g.add(lt);
      }
      const port = new THREE.Group();
      const rope = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.09, 6, 32, Math.PI), new THREE.MeshStandardMaterial({ color: '#d8c79a', roughness: 0.9 }));
      rope.rotation.z = Math.PI;
      rope.position.y = 4.1;
      rope.scale.set(0.85, 0.25, 1);
      port.add(rope);
      for (let k = -2; k <= 2; k++) {
        const sh = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.55), new THREE.MeshStandardMaterial({ color: '#ffffff', side: THREE.DoubleSide, roughness: 0.8 }));
        sh.position.set(k * 0.8, 3.55 + Math.abs(k) * 0.08, 0);
        port.add(sh);
      }
      port.position.z = 0.2;
      g.add(port);
      return {
        portcullis: port,
        lightPos: new THREE.Vector3(0, 2.2, 1.4),
        lightColor: '#ffb07a',
        anchors: {
          barrier: 'rope',
          barrierHalfW: 2.2,
          barrierH: 4.1,
          tunnel: { depth: 5, height: 99, floorY: 0 },
          // the torii's top beam (kasagi)
          perches: [{ id: 'torii', pos: [0, 5.71, 0.05], depth: 0.56 }],
          lowWall: { pos: [5.4, 1.07, 0.95 - 0.95], height: 1.07 },
          wallH: 1.07,
        },
      };
    });
  }

  return {
    mats: { stone, metal: iron, rim: stone, spike: iron },
    obstacle: (o, crack) => {
      if (o.kind === 'rock') return rock(o, stone);
      const g = new THREE.Group();
      g.add(shadowed(new THREE.Mesh(toroGeo(o.h), withCrack(stone as THREE.MeshStandardMaterial, { triplanar: 0.4, macro: [0.1, 0.1] }, crack))));
      const glow = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.34, 0.42).scale(o.h / 3, o.h / 3, o.h / 3), new THREE.MeshStandardMaterial({ color: '#ffd59a', emissive: '#ffa040', emissiveIntensity: 2.4 }));
      glow.position.y = 1.88 * (o.h / 3);
      g.add(glow);
      return g;
    },
    propMat: (k) => (k === 'urn' ? porcelain : k === 'rock' || k === 'chunk' ? stone : k === 'explosive' ? pbr(TEX.wood('#6a1a14', 45), {}) : woodMat),
    debrisOf: () => 'stone',
    urnDebris: 'ceramic',
    chandelier: () => new THREE.Group(),
    chandelierDebris: 'stone',
    waterColor: '#1f5a5a',
    decorateWater: (g, h) => {
      const rr = new R(h.id + 3);
      const pad = new THREE.MeshStandardMaterial({ color: '#4f8a3a', roughness: 0.7, side: THREE.DoubleSide });
      for (let k = 0; k < 7; k++) {
        const lp = new THREE.Mesh(new THREE.CircleGeometry(rr.range(0.18, 0.32), 14, 0.3, Math.PI * 1.8), pad);
        lp.rotation.x = -Math.PI / 2;
        const an = rr.next() * 6,
          d = rr.range(0.2, h.r * 0.8);
        lp.position.set(Math.cos(an) * d, 0.04, Math.sin(an) * d);
        g.add(lp);
      }
      const koiMat = new THREE.MeshStandardMaterial({ color: '#ff7a2a', roughness: 0.4 });
      const kois: THREE.Mesh[] = [];
      for (let k = 0; k < 3; k++) {
        const koi = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), koiMat);
        koi.scale.set(1, 0.5, 2.4);
        g.add(koi);
        kois.push(koi);
      }
      a.onUpdate((t) => {
        kois.forEach((k, i) => {
          const an = t * (0.3 + i * 0.1) + i * 2;
          const d = h.r * (0.35 + i * 0.15);
          k.position.set(Math.cos(an) * d, -0.06, Math.sin(an) * d);
          k.rotation.y = -an;
        });
      });
    },
    envExtras: [],
    spot: 0,
  };
}

function rock(o: Obstacle, mat: THREE.Material) {
  const g = new THREE.Group();
  g.add(shadowed(new THREE.Mesh(rockGeo(o.r * 1.05, o.id * 19 + 4, { squash: 0.8, flat: 0.5 }), mat)));
  return g;
}

let _bw: THREE.Texture | null = null;
function blueWhiteTex() {
  if (_bw) return _bw;
  _bw = canvasTexture(256, (g, s) => {
    g.fillStyle = '#f4f7fc';
    g.fillRect(0, 0, s, s);
    g.strokeStyle = '#2a4a9a';
    g.lineWidth = 3;
    for (let y = 0.2; y < 0.9; y += 0.18) {
      g.beginPath();
      for (let x = 0; x <= s; x += 6) g.lineTo(x, y * s + Math.sin(x * 0.08 + y * 20) * 8);
      g.stroke();
    }
    g.fillStyle = '#2a4a9a';
    g.fillRect(0, s * 0.06, s, 6);
    g.fillRect(0, s * 0.92, s, 6);
  });
  return _bw;
}

// =====================================================================================
// THE MOONLIT LAKE TEMPLE
// =====================================================================================
export function dressMoonlake(a: Arena): Dressing {
  const L = a.layout;
  const G = a.group;
  const flags = TEX.flagstones('#9aa6b8', '#5d6577', 51, 0, 5, 0.9);
  const floorMat = pbr(flags, { macro: [0.06, 0.1] });
  const moonstone = TEX.marble('#cfd6e2', '#7e8cab', 53, 0.25);
  const msMat = pbr(moonstone, {});
  const msTri = pbr(moonstone, { triplanar: 0.35 });
  const stone = pbr(TEX.blocks('#7d8698', '#4a5060', 3, 2, 54, 0.3), { triplanar: 0.35, macro: [0.08, 0.12] });
  const stoneUV = pbr(TEX.blocks('#7d8698', '#4a5060', 3, 2, 54, 0.3), { macro: [0.08, 0.12] });
  const silver = pbr(TEX.metal('#c8d2e0', 55, 0.25), { metal: 1, rough: 1 });
  const lacquer = new THREE.MeshStandardMaterial({ color: '#7a1e1a', roughness: 0.5 });
  const roofMat = new THREE.MeshStandardMaterial({ color: '#1e2630', roughness: 0.55, metalness: 0.2 });
  const woodMat = pbr(TEX.wood('#6a5040', 56), {});
  const porcelain = new THREE.MeshStandardMaterial({ color: '#e8eef8', roughness: 0.2, map: blueWhiteTex() });

  G.add(floorDisc(L, 1.0, 6, floorMat));
  // steps down into the lake
  G.add(shadowed(new THREE.Mesh(sweepEllipse(L, [[1.0, 0], [1.0, -0.22], [1.55, -0.22], [1.55, -0.44], [2.1, -0.44], [2.1, -0.66], [2.6, -0.66], [2.6, -1.6]], 220, 0, 0.6), stoneUV), false, true));
  // lake
  const lake = new THREE.Mesh(new THREE.CircleGeometry(900, 64), waterMaterial('#0b1a30', { rough: 0.02, scale: 0.09, speed: 0.012, env: 1.7 }));
  lake.rotation.x = -Math.PI / 2;
  lake.position.y = -0.55;
  lake.receiveShadow = true;
  G.add(lake);
  // low rim posts with lantern caps
  alongEllipse(L, 0.8, 3.2, (p) => {
    const post = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.9, 0.3), stone));
    post.position.set(p.x, 0.45, p.z);
    G.add(post);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), new THREE.MeshStandardMaterial({ color: '#ffd8a0', emissive: '#ffa850', emissiveIntensity: 2.6 }));
    lamp.position.set(p.x, 1.05, p.z);
    G.add(lamp);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.2, 4), roofMat);
    roof.position.set(p.x, 1.28, p.z);
    roof.rotation.y = Math.PI / 4;
    G.add(roof);
  }, 2.2);
  // floating lanterns on the lake
  {
    const n = a.quality >= 2 ? 260 : a.quality === 1 ? 160 : 70;
    const geo = new THREE.CylinderGeometry(0.16, 0.18, 0.32, 6);
    const mat = new THREE.MeshStandardMaterial({ color: '#ffd8a0', emissive: '#ff9a40', emissiveIntensity: 3.2, roughness: 0.8 });
    const im = new THREE.InstancedMesh(geo, mat, n);
    const r = new R(L.seed + 3);
    const base: { x: number; z: number; ph: number; sp: number }[] = [];
    for (let i = 0; i < n; i++) {
      const an = r.next() * Math.PI * 2;
      const p = ellipseAt(L, an, r.range(4, 60) * (r.next() < 0.7 ? 1 : 2.4));
      base.push({ x: p.x, z: p.z, ph: r.next() * 6, sp: r.range(0.02, 0.06) });
    }
    const m = new THREE.Matrix4();
    a.onUpdate((t) => {
      for (let i = 0; i < n; i++) {
        const b = base[i];
        m.makeTranslation(b.x + Math.sin(t * b.sp + b.ph) * 1.5, -0.42 + Math.sin(t * 1.3 + b.ph) * 0.03, b.z + Math.cos(t * b.sp * 0.8 + b.ph) * 1.5);
        im.setMatrixAt(i, m);
      }
      im.instanceMatrix.needsUpdate = true;
    });
    G.add(im);
  }
  // pagoda islands + far torii in the water
  const r = new R(L.seed + 11);
  for (let k = 0; k < 4; k++) {
    const an = 0.9 + k * 1.45 + r.range(-0.2, 0.2);
    const d = r.range(45, 85);
    const isle = new THREE.Group();
    const rockI = new THREE.Mesh(rockGeo(7, 300 + k, { squash: 0.35 }), stone);
    rockI.position.y = -1.6;
    isle.add(rockI);
    const pg = new THREE.Mesh(pagodaGeo(4 + (k % 2), 3.6), lacquer);
    pg.position.y = 0.6;
    isle.add(pg);
    isle.position.set(Math.cos(an) * d, 0, Math.sin(an) * d);
    G.add(isle);
    const lampLight = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), glowMat('#ffb060', 0.9));
    lampLight.position.set(isle.position.x, 3.5, isle.position.z);
    G.add(lampLight);
  }
  const bigTorii = new THREE.Mesh(toriiGeo(9, 10), lacquer);
  bigTorii.position.set(-60, -0.6, 70);
  bigTorii.lookAt(0, -0.6, 0);
  G.add(bigTorii);
  mountains(a, '#1c2a46', 300, 140, 11, 7);
  // gates: circular moon gates on short bridges
  for (let i = 0; i < 2; i++) {
    makeGate(a, i, 0.8, (g) => {
      const ring = shadowed(new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.45, 12, 48), msTri));
      ring.position.y = 2.2;
      g.add(ring);
      for (const s of [-1, 1]) {
        const b = shadowed(new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 1.1), stone));
        b.position.set(s * 2.0, 0.25, 0);
        g.add(b);
      }
      const roof = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.6, 3.6, 0.9, 4, 1), roofMat));
      roof.rotation.y = Math.PI / 4;
      roof.scale.set(1, 1, 0.4);
      roof.position.y = 5.0;
      g.add(roof);
      const bridge = shadowed(new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.4, 9), stoneUV));
      bridge.position.set(0, -0.2, -4.8);
      g.add(bridge);
      const veilTex = canvasTexture(128, (cg, s) => {
        const grd = cg.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        grd.addColorStop(0, 'rgba(220,235,255,0.5)');
        grd.addColorStop(0.9, 'rgba(160,200,255,0.25)');
        grd.addColorStop(1, 'rgba(160,200,255,0)');
        cg.fillStyle = grd;
        cg.fillRect(0, 0, s, s);
      });
      const veil = new THREE.Mesh(new THREE.CircleGeometry(2.0, 48), glowMat('#ffffff', 0.5, veilTex));
      veil.position.y = 2.2;
      const port = new THREE.Group();
      port.add(veil);
      port.position.z = 0.2;
      g.add(port);
      return {
        portcullis: port,
        lightPos: new THREE.Vector3(0, 2.4, 1.4),
        lightColor: '#a8c8ff',
        anchors: {
          barrier: 'veil',
          barrierHalfW: 1.9,
          barrierH: 4.2,
          // the bridge behind the moon gate
          tunnel: { depth: 9, height: 99, floorY: 0 },
          // the little roof on top of the moon gate
          // the eave at the front of the moon-gate roof (jumping off the ridge would cut through the roof)
          perches: [{ id: 'roof_eave', pos: [0, 4.62, 1.3], depth: 0.3 }],
          // bridge sides over the lake
          rims: [-1, 1].map((s) => ({ id: s < 0 ? 'bridge_l' : 'bridge_r', pos: [s * 1.5, 0, -4.0] as V3, drop: 0.55, dir: [-s, 0] as [number, number] })),
          wallH: 0,
        },
      };
    });
  }

  return {
    mats: { stone, metal: silver, rim: stone, spike: silver },
    obstacle: (o, crack) => (o.kind === 'rock' ? rock(o, stone) : (() => {
      const g = new THREE.Group();
      g.add(shadowed(new THREE.Mesh(columnGeo(o.r * 0.75, o.h, { capital: 'doric', flutes: 16 }), withCrack(msMat, { macro: [0.3, 0.05] }, crack))));
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), new THREE.MeshStandardMaterial({ color: '#ffe6c0', emissive: '#ffb060', emissiveIntensity: 1.3 }));
      lamp.position.y = o.h + 0.25;
      g.add(lamp);
      return g;
    })()),
    propMat: (k) => (k === 'urn' ? porcelain : k === 'rock' || k === 'chunk' ? msTri : k === 'explosive' ? pbr(TEX.wood('#5a1a3a', 57), {}) : woodMat),
    debrisOf: (k) => (k === 'rock' ? 'stone' : 'marble'),
    urnDebris: 'ceramic',
    chandelier: () => new THREE.Group(),
    chandelierDebris: 'stone',
    waterColor: '#14304a',
    envExtras: [],
    spot: 14,
  };
}

// =====================================================================================
// THE AURORA GLACIER
// =====================================================================================
export function dressGlacier(a: Arena): Dressing {
  const L = a.layout;
  const G = a.group;
  const iceSet = TEX.ice(7);
  const iceFloor = pbr(iceSet, { macro: [0.05, 0.18], color: '#9ab8d2', rough: 0.55, envIntensity: 1.6 });
  const snowSet = TEX.snow(8);
  const snow = pbr(snowSet, { macro: [0.03, 0.08] });
  const iceRock = pbr(iceSet, { triplanar: 0.22, macro: [0.04, 0.15] });
  (iceRock as THREE.MeshStandardMaterial).emissive = new THREE.Color('#0a3a5a');
  (iceRock as THREE.MeshStandardMaterial).emissiveIntensity = 0.6;
  const crystalMat = new THREE.MeshStandardMaterial({ color: '#a6e4ff', roughness: 0.2, metalness: 0.1, emissive: '#1a7ab0', emissiveIntensity: 0.8, envMapIntensity: 1.3 });
  const darkRock = pbr(TEX.blocks('#4a5a6a', '#2a323c', 3, 2, 61, 0.2, 0.6), { triplanar: 0.15, macro: [0.03, 0.2] });
  const woodMat = pbr(TEX.wood('#6a5444', 62), {});
  const iron = pbr(TEX.metal('#5a6470', 63, 0.4), { metal: 1, rough: 1 });

  G.add(floorDisc(L, 1.4, 7, iceFloor));
  G.add(shadowed(new THREE.Mesh(sweepEllipse(L, [[-1.0, 0.0], [-0.3, 0.1], [0.5, 0.35], [1.6, 0.9], [2.4, 1.0]], 220, 2.2, 0.3), snow), false, true));
  // ice wall: jagged blocks
  const r = new R(L.seed + 21);
  alongEllipse(L, 1.45, 0.75, (p) => {
    const h = r.range(1.0, 2.9);
    const shard = new THREE.CylinderGeometry(r.range(0.08, 0.2), r.range(0.4, 0.62), h, 5, 1);
    shard.translate(0, h / 2, 0);
    const m = shadowed(new THREE.Mesh(shard, iceRock));
    m.position.copy(p);
    m.rotation.set(r.range(-0.18, 0.18), r.next() * 6, r.range(-0.18, 0.18));
    G.add(m);
  }, 2.4);
  // terrain + cliffs
  G.add(groundPlane(900, 8, snow, 0.0, 140, (x, z) => {
    const d = Math.hypot(x / (L.rx + 3), z / (L.rz + 3));
    return d < 1.12 ? 0.02 : Math.min(1, (d - 1.12) * 0.5) * (fbm2(x * 0.015, z * 0.015, 4, 4, 0) * 12);
  }));
  for (let k = 0; k < 16; k++) {
    const an = (k / 16) * Math.PI * 2 + r.range(-0.1, 0.1);
    const p = ellipseAt(L, an, r.range(22, 38));
    if (inGate(L, p, 6)) continue;
    const h = r.range(14, 34);
    const cl = shadowed(new THREE.Mesh(rockGeo(r.range(6, 10), 700 + k, { squash: h / 8, detail: 2, rough: 0.6 }), k % 3 ? iceRock : darkRock), true, false);
    cl.position.copy(p);
    cl.rotation.y = r.next() * 6;
    G.add(cl);
  }
  for (let k = 0; k < 10; k++) {
    const an = r.next() * Math.PI * 2;
    const p = ellipseAt(L, an, r.range(5, 16));
    if (inGate(L, p, 4)) continue;
    const c = shadowed(new THREE.Mesh(crystalCluster(900 + k, r.range(0.8, 2.2), 6), crystalMat));
    c.position.copy(p);
    G.add(c);
  }
  mountains(a, '#1d3a58', 320, 150, 12, 9);
  // gates: leaning crystal arch + icicle curtain
  for (let i = 0; i < 2; i++) {
    makeGate(a, i, 1.4, (g) => {
      for (const s of [-1, 1]) {
        const c = shadowed(new THREE.Mesh(crystalCluster(40 + s + i * 3, 1.8, 5), crystalMat));
        c.position.set(s * 2.4, 0, -0.3);
        c.rotation.z = -s * 0.32;
        g.add(c);
      }
      const port = new THREE.Group();
      for (let k = -6; k <= 6; k++) {
        const ic = new THREE.Mesh(new THREE.ConeGeometry(0.12, 1.2 + (k % 3) * 0.6, 6), crystalMat);
        ic.rotation.x = Math.PI;
        ic.position.set(k * 0.28, 3.6 - (k % 3) * 0.3, 0);
        port.add(ic);
      }
      port.position.z = 0.2;
      g.add(port);
      return {
        portcullis: port,
        lightPos: new THREE.Vector3(0, 2.2, 1.2),
        lightColor: '#7ae0ff',
        anchors: {
          barrier: 'icicles',
          barrierHalfW: 1.8,
          barrierH: 3.6,
          tunnel: { depth: 4, height: 99, floorY: 0 },
          perches: [],
          wallH: 1.6,
        },
      };
    });
  }

  return {
    mats: { stone: iceRock, metal: iron, rim: iceRock, spike: crystalMat },
    obstacle: (o, crack) => {
      const g = new THREE.Group();
      if (o.kind === 'rock') {
        g.add(shadowed(new THREE.Mesh(rockGeo(o.r * 1.05, o.id * 7 + 3, { squash: 0.85 }), darkRock)));
        const cap = new THREE.Mesh(rockGeo(o.r * 0.9, o.id * 7 + 4, { squash: 0.3, rough: 0.2 }), snow);
        cap.position.y = o.r * 0.82;
        g.add(cap);
        return g;
      }
      const m = crystalMat.clone();
      const cm = withCrack(m, {}, crack);
      g.add(shadowed(new THREE.Mesh(crystalCluster(o.id * 13 + 1, o.h / 4.2, 7), cm)));
      return g;
    },
    propMat: (k) => (k === 'rock' ? darkRock : k === 'chunk' ? iceRock : k === 'urn' ? crystalMat : woodMat),
    debrisOf: (k) => (k === 'rock' ? 'ice' : 'crystal'),
    urnDebris: 'ice',
    chandelier: () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(crystalCluster(5, 0.9, 6).rotateX(Math.PI), crystalMat));
      return g;
    },
    chandelierDebris: 'ice',
    geyserColor: '#bff4ff',
    envExtras: [],
    spot: 10,
  };
}
