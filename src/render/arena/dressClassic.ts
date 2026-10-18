/**
 * Theme dressing: the Gilded Colosseum, the Sky Sanctum, the Sunset Ruins.
 */
import * as THREE from 'three';
import type { V3 } from './arenaView';
import type { HazardDef, Obstacle } from '../../sim/arenaGen';
import type { Arena } from './arenaView';
import type { Dressing } from './dressing';
import { TEX, canvasTexture } from './textures';
import { pbr, withCrack, glowMat, waterMaterial, GLSL_NOISE, shaderTime, bakeVertexShade } from './materials';
import { alongEllipse, banner, crowd, ellipseAt, floorDisc, groundPlane, inGate, makeGate, sweepEllipse } from './common';
import { arcadeGeo, balusterGeo, colossusGeo, columnGeo, merge, obeliskGeo, place, rockGeo, statueGeo, drumGeo, ruinBlock, palmGeo } from './kit';
import { R, fbm2 } from './noise';

const shadowed = <T extends THREE.Mesh>(m: T, cast = true, recv = true): T => {
  m.castShadow = cast;
  m.receiveShadow = recv;
  return m;
};

function columnObstacle(o: Obstacle, crack: { value: number }, shaft: THREE.MeshStandardMaterial, trim: THREE.Material | null, capital: 'ionic' | 'doric' | 'simple' = 'ionic'): THREE.Object3D {
  const g = new THREE.Group();
  const geo = columnGeo(o.r * 0.78, o.h, { capital, flutes: 20 });
  g.add(shadowed(new THREE.Mesh(geo, withCrack(shaft, { macro: [0.3, 0.06] }, crack))));
  if (trim) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(o.r * 0.72, 0.05, 6, 32), trim);
    band.rotation.x = Math.PI / 2;
    band.position.y = o.h - 0.66;
    g.add(band);
    const band2 = band.clone();
    band2.position.y = 0.62;
    band2.scale.setScalar(1.12);
    g.add(band2);
  }
  return g;
}

function rubbleObstacle(o: Obstacle, mat: THREE.Material, seed: number): THREE.Object3D {
  const g = new THREE.Group();
  const r = new R(seed);
  const main = shadowed(new THREE.Mesh(rockGeo(o.r * 1.05, seed, { squash: 0.75, flat: 0.5 }), mat));
  g.add(main);
  for (let i = 0; i < 3; i++) {
    const a = r.next() * Math.PI * 2;
    const m = shadowed(new THREE.Mesh(rockGeo(o.r * r.range(0.25, 0.45), seed + i + 1, { squash: 0.7 }), mat));
    m.position.set(Math.cos(a) * o.r * 0.95, 0, Math.sin(a) * o.r * 0.95);
    g.add(m);
  }
  return g;
}

/** broken column drums lying around a stump: low cover that reads as ruin, not a blob */
function fallenColumn(o: Obstacle, mat: THREE.Material, seed: number): THREE.Object3D {
  const g = new THREE.Group();
  const r = new R(seed);
  const stump = shadowed(new THREE.Mesh(drumGeo(o.r * 0.82, r.range(0.9, 1.4), seed), mat));
  g.add(stump);
  const base = shadowed(new THREE.Mesh(new THREE.BoxGeometry(o.r * 2.3, 0.28, o.r * 2.3), mat));
  base.position.y = 0.14;
  g.add(base);
  const an = r.next() * Math.PI * 2;
  for (let i = 0; i < 2; i++) {
    const d = shadowed(new THREE.Mesh(drumGeo(o.r * 0.72, r.range(0.6, 0.9), seed + i + 1), mat));
    d.rotation.z = Math.PI / 2;
    d.rotation.y = an + i * 0.5;
    d.position.set(Math.cos(an + i * 1.3) * o.r * 1.1, o.r * 0.72, Math.sin(an + i * 1.3) * o.r * 1.1);
    g.add(d);
  }
  return g;
}

// =====================================================================================
// THE GILDED COLOSSEUM - golden hour marble amphitheatre with a roaring crowd
// =====================================================================================
export function dressColosseum(a: Arena): Dressing {
  const L = a.layout;
  const G = a.group;
  const q = a.quality;
  const sandMat = pbr(TEX.sand('#d6ad7c', 3), { macro: [0.07, 0.14] });
  const trav = TEX.blocks('#dccfb2', '#a6977c', 4, 3, 21, 0.6);
  const travMat = pbr(trav, { macro: [0.05, 0.1] });
  const travTri = pbr(trav, { triplanar: 0.45, macro: [0.08, 0.1] });
  const marbleSet = TEX.marble('#ece4d6', '#b09a80', 5, 0.32);
  const marbleMat = pbr(marbleSet, {});
  const columnMat = pbr(marbleSet, { repeat: [2, 3] });
  const goldMat = pbr(TEX.metal('#e0b050', 3, 0.28), { metal: 1, rough: 1 });
  const bronzeMat = pbr(TEX.metal('#9a6a3a', 4, 0.42), { metal: 1, rough: 1 });
  const woodMat = pbr(TEX.wood('#80583a', 9), {});
  const woodDark = pbr(TEX.wood('#5e3e26', 14), {});
  const terracotta = new THREE.MeshStandardMaterial({ color: '#b8653c', roughness: 0.62 });
  const keg = pbr(TEX.wood('#8e2a1c', 13), {});
  const stepsMat = pbr(TEX.blocks('#e2d7c2', '#b0a38c', 2, 4, 22, 0.4), { macro: [0.04, 0.12] });

  // ---------------- floor: raked sand + marble medallion + curb
  G.add(floorDisc(L, 1.6, 5, sandMat));
  const med = new THREE.Mesh(new THREE.CircleGeometry(2.6, 64), pbr(TEX.marbleTiles('#e6dccb', '#d6c8b2', '#a88e70', '#7c6a52', 3, true, 7), { rough: 1.8, envIntensity: 0.5 }));
  med.rotation.x = -Math.PI / 2;
  med.position.y = 0.012;
  med.receiveShadow = true;
  med.userData.floorDeco = true; // A2: replaced by the kit wet floor's inlay
  G.add(med);
  for (const [r0, w] of [[2.6, 0.12], [1.15, 0.06]] as [number, number][]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(r0, r0 + w, 96), goldMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.016;
    ring.userData.floorDeco = true;
    G.add(ring);
  }
  // curb
  G.add(shadowed(new THREE.Mesh(sweepEllipse(L, [[0.35, 0], [0.35, 0.16], [0.42, 0.22], [0.9, 0.22]], 220, 2.4, 0.5), marbleMat)));

  // ---------------- podium wall + stands
  const podium = sweepEllipse(L, [[0.9, 0.22], [0.9, 3.15], [0.78, 3.22], [0.78, 3.42], [1.3, 3.45]], 220, 2.4, 0.33);
  G.add(shadowed(new THREE.Mesh(podium, travMat)));
  const steps: [number, number][] = [[1.3, 3.45]];
  const rows: { off: number; y: number }[] = [];
  let o = 1.3,
    y = 3.45;
  for (let k = 0; k < 8; k++) {
    y += 0.56;
    steps.push([o, y]);
    o += 0.95;
    steps.push([o, y]);
    rows.push({ off: o - 0.5, y });
  }
  steps.push([o + 0.4, y], [o + 0.4, y + 1.2]);
  G.add(shadowed(new THREE.Mesh(sweepEllipse(L, steps, 200, 0, 0.5), stepsMat), false, true));
  // upper gallery: arcade facade (sky shows through the arches)
  const galleryOff = o + 0.8;
  alongEllipse(
    L,
    galleryOff,
    3.4,
    (p, yaw) => {
      const seg = new THREE.Mesh(arcadeGeo(3.5, 6.4, 0.9, 1, 1.9, 4.2, 0.6), travMat);
      seg.position.set(p.x, y, p.z);
      seg.rotation.y = yaw;
      shadowed(seg, true, true);
      G.add(seg);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(3.55, 0.35, 1.2), marbleMat);
      cap.position.set(p.x, y + 6.55, p.z);
      cap.rotation.y = yaw;
      G.add(shadowed(cap));
    },
    0,
  );
  const galleryTop = y + 6.7;
  // velarium masts + sails
  const sailTex = canvasTexture(256, (g, s) => {
    for (let i = 0; i < 8; i++) {
      g.fillStyle = i % 2 ? '#efe2c6' : '#b0322a';
      g.fillRect((i * s) / 8, 0, s / 8, s);
    }
  });
  sailTex.wrapS = sailTex.wrapT = THREE.RepeatWrapping;
  const sailMat = new THREE.MeshStandardMaterial({ map: sailTex, side: THREE.DoubleSide, roughness: 0.9, transparent: true, opacity: 0.97 });
  let si = 0;
  alongEllipse(
    L,
    galleryOff,
    4.2,
    (p, yaw, ang) => {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 4.2, 6), woodDark);
      mast.position.set(p.x, galleryTop + 2.0, p.z);
      G.add(mast);
      if (si++ % 2 === 0) return;
      // sail: quad from the mast top inward and down over the stands
      const inner = ellipseAt(L, ang, galleryOff - 6.2);
      const a0 = ellipseAt(L, ang - 0.09, galleryOff),
        a1 = ellipseAt(L, ang + 0.09, galleryOff);
      const i0 = ellipseAt(L, ang - 0.07, galleryOff - 6.2),
        i1 = ellipseAt(L, ang + 0.07, galleryOff - 6.2);
      void inner;
      const geo = new THREE.BufferGeometry();
      const top = galleryTop + 3.6,
        low = galleryTop + 0.8;
      const pts = [a0.x, top, a0.z, a1.x, top, a1.z, i0.x, low, i0.z, i1.x, low, i1.z];
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
      geo.setIndex([0, 2, 1, 1, 2, 3]);
      geo.computeVertexNormals();
      const sail = new THREE.Mesh(geo, sailMat);
      sail.castShadow = true;
      G.add(sail);
    },
    2.8,
  );
  // crowd
  crowd(a, rows.map((r) => ({ off: r.off, y: r.y })), q >= 2 ? 3400 : q === 1 ? 2200 : 1000, ['#8a3a2a', '#c9b48a', '#3f5470', '#9a7038', '#6a6a4a', '#d8ccb0', '#5a3a2a', '#7a4a3a', '#4a5a3a', '#b04a30', '#a89a80']);

  // ---------------- banners + wall braziers
  alongEllipse(L, 0.76, 6.5, (p, yaw, _a, i) => {
    const b = banner(a, i % 2 ? '#9a1f1c' : '#1f3466', '#e8c066', 1.2, 2.3, i % 2 ? 'diamond' : 'sun');
    b.position.set(p.x, 3.2, p.z);
    b.rotation.y = yaw;
    G.add(b);
  }, 3.6, 0.5);
  alongEllipse(L, 1.05, 9.5, (p) => {
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.9, 6), bronzeMat);
    stand.position.set(p.x, 3.9, p.z);
    G.add(stand);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.22, 0.3, 12), bronzeMat);
    bowl.position.set(p.x, 4.4, p.z);
    G.add(bowl);
    G.add(a.flame(new THREE.Vector3(p.x, 4.5, p.z), 1.0, '#ffa040', false));
  }, 4, 0.3);

  // ---------------- gates
  for (let i = 0; i < 2; i++) {
    makeGate(a, i, 0.9, (g) => {
      const fac = shadowed(new THREE.Mesh(arcadeGeo(6.6, 5.6, 1.7, 1, 3.1, 3.7), travMat));
      fac.position.z = -0.85;
      g.add(fac);
      const ent = shadowed(new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.6, 2.0), marbleMat));
      ent.position.set(0, 5.9, -0.8);
      g.add(ent);
      const tri = new THREE.Shape();
      tri.moveTo(-3.7, 0);
      tri.lineTo(3.7, 0);
      tri.lineTo(0, 1.25);
      tri.lineTo(-3.7, 0);
      const ped = shadowed(new THREE.Mesh(new THREE.ExtrudeGeometry(tri, { depth: 1.8, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 1 }), marbleMat));
      ped.position.set(0, 6.2, -1.7);
      g.add(ped);
      const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.08, 24), goldMat);
      shield.rotation.x = Math.PI / 2;
      shield.position.set(0, 4.55, 0.1);
      g.add(shield);
      for (const s of [-1, 1]) {
        const col = shadowed(new THREE.Mesh(columnGeo(0.32, 5.6, { capital: 'ionic', plinth: true }), marbleMat));
        col.position.set(s * 2.75, 0, 0.25);
        g.add(col);
        const st = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 1.5, 6), bronzeMat);
        st.position.set(s * 1.95, 0.75, 1.2);
        g.add(st);
        const bw = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.2, 0.3, 12), bronzeMat);
        bw.position.set(s * 1.95, 1.55, 1.2);
        g.add(bw);
        g.add(a.flame(new THREE.Vector3(s * 1.95, 1.62, 1.2), 0.9, '#ff9a40', s > 0));
      }
      const tunnel = new THREE.Mesh(new THREE.BoxGeometry(3.1, 3.7, 7), new THREE.MeshStandardMaterial({ color: '#1a120c', roughness: 1, side: THREE.BackSide }));
      tunnel.position.set(0, 1.85, -4.2);
      g.add(tunnel);
      const port = new THREE.Group();
      for (let k = -5; k <= 5; k++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 3.6, 0.07), bronzeMat);
        bar.position.set(k * 0.27, 1.8, 0);
        port.add(bar);
      }
      for (let j = 0; j < 4; j++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.07, 0.07), bronzeMat);
        bar.position.set(0, 0.5 + j * 0.95, 0);
        port.add(bar);
      }
      port.position.z = 0.2;
      g.add(port);
      return {
        portcullis: port,
        lightPos: new THREE.Vector3(0, 2.4, 1.6),
        lightColor: '#ffb060',
        anchors: {
          barrier: 'portcullis',
          barrierHalfW: 1.45,
          barrierH: 3.6,
          tunnel: { depth: 7, height: 3.7, floorY: 0 },
          // podium wall top (3.45 m, 0.78-1.3 m behind the boundary), beside the gate gap
          // the entablature's corners over the gate (in front of the low end of the pediment), then the podium wall
          perches: [
            ...[-1, 1].map((s) => ({ id: s < 0 ? 'entablature_l' : 'entablature_r', pos: [s * 3.45, 6.2, -0.8] as V3, depth: 2.0 })),
            ...[-1, 1].map((s) => ({ id: s < 0 ? 'wall_l' : 'wall_r', pos: [s * 3.0, 3.45, 0.9 - 0.92] as V3, depth: 0.5 })),
          ],
          // crowd tiers (second row), clear of the gate's entablature (half width 3.7)
          stands: [[5.2, 4.57, 0.9 - 2.7], [-5.2, 4.57, 0.9 - 2.7]],
          wallH: 3.45,
        },
      };
    });
  }

  return {
    mats: { stone: travTri, metal: bronzeMat, rim: travTri, spike: bronzeMat },
    obstacle: (o, crack) => (o.kind === 'rock' ? fallenColumn(o, columnMat, o.id * 13 + 5) : columnObstacle(o, crack, columnMat, goldMat, 'ionic')),
    propMat: (k) => (k === 'crate' ? woodMat : k === 'barrel' ? woodDark : k === 'urn' ? terracotta : k === 'explosive' ? keg : k === 'rock' ? travTri : k === 'chunk' ? marbleMat : bronzeMat),
    debrisOf: (k) => (k === 'rock' ? 'stone' : 'marble'),
    urnDebris: 'ceramic',
    chandelier: (h) => {
      const ch = bronzeChandelier(a, bronzeMat);
      // hung from a velarium cable spanning the arena
      const top = new THREE.Vector3(h.x, galleryTop + 2.5, h.z);
      const ang = Math.atan2(h.z, h.x) + Math.PI / 2;
      for (const s of [-1, 1]) {
        const end = ellipseAt(L, ang + (s > 0 ? 0 : Math.PI), galleryOff);
        end.y = galleryTop + 3.8;
        const len = end.distanceTo(top);
        const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, len, 5), woodDark);
        cable.position.copy(top).lerp(end, 0.5);
        cable.lookAt(end);
        cable.rotateX(Math.PI / 2);
        G.add(cable);
      }
      return ch;
    },
    chandelierDebris: 'metal',
    envExtras: [],
    spot: 0,
  };
}

function bronzeChandelier(a: Arena, mat: THREE.Material): THREE.Object3D {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.08, 8, 32), mat);
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  const inner = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.06, 6, 24), mat);
  inner.rotation.x = Math.PI / 2;
  inner.position.y = -0.25;
  g.add(inner);
  const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), mat);
  bowl.position.y = -0.3;
  g.add(bowl);
  for (let i = 0; i < 8; i++) {
    const an = (i / 8) * Math.PI * 2;
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 6), new THREE.MeshStandardMaterial({ color: '#f2e6c8', roughness: 0.8 }));
    c.position.set(Math.cos(an) * 1.1, 0.18, Math.sin(an) * 1.1);
    g.add(c);
    g.add(a.flame(new THREE.Vector3(Math.cos(an) * 1.1, 0.32, Math.sin(an) * 1.1), 0.35, '#ffb050', false));
  }
  for (let i = 0; i < 3; i++) {
    const an = (i / 3) * Math.PI * 2;
    const ch = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.6, 4), mat);
    ch.position.set(Math.cos(an) * 0.55, 0.75, Math.sin(an) * 0.55);
    ch.lookAt(0, 1.55, 0);
    ch.rotateX(Math.PI / 2);
    g.add(ch);
  }
  g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  return g;
}

// =====================================================================================
// THE SKY SANCTUM - floating marble ring above a sea of clouds
// =====================================================================================
export function dressSkytemple(a: Arena): Dressing {
  const L = a.layout;
  const G = a.group;
  const tiles = TEX.marbleTiles('#e6ddcd', '#d6cdbd', '#8597b8', '#a8946a', 4, true, 11);
  const floorMat = pbr(tiles, { macro: [0.05, 0.06], rough: 1.5 });
  const marble = TEX.marble('#e8e0d2', '#8f9fbe', 17, 0.34);
  const marbleMat = pbr(marble, {});
  const marbleTri = pbr(marble, { triplanar: 0.35 });
  const colMat = pbr(marble, { repeat: [2, 3] });
  const goldMat = pbr(TEX.metal('#e8bd5c', 5, 0.22), { metal: 1, rough: 1 });
  const rockSet = TEX.blocks('#9a8676', '#6a5a4e', 3, 2, 23, 0.3, 0.9);
  const rockMat = pbr(rockSet, { triplanar: 0.12, macro: [0.03, 0.25] });
  const grassMat = new THREE.MeshStandardMaterial({ color: '#7aa452', roughness: 0.95 });
  const porcelain = new THREE.MeshStandardMaterial({ color: '#f4f6fa', roughness: 0.25, metalness: 0 });
  const paleWood = pbr(TEX.wood('#b39470', 31), {});

  // ---------------- floating platform
  G.add(floorDisc(L, 2.3, 8.8, floorMat));
  // sun mosaic at the centre
  const mosaic = canvasTexture(1024, (g, s) => {
    g.clearRect(0, 0, s, s);
    g.translate(s / 2, s / 2);
    g.strokeStyle = 'rgba(214,170,80,0.95)';
    g.lineWidth = 10;
    for (const r of [0.47, 0.43, 0.2]) {
      g.beginPath();
      g.arc(0, 0, s * r, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = 'rgba(214,170,80,0.9)';
    for (let i = 0; i < 16; i++) {
      g.save();
      g.rotate((i / 16) * Math.PI * 2);
      g.beginPath();
      g.moveTo(0, -s * 0.21);
      g.lineTo(s * 0.035, -s * 0.24);
      g.lineTo(0, i % 2 ? -s * 0.36 : -s * 0.42);
      g.lineTo(-s * 0.035, -s * 0.24);
      g.fill();
      g.restore();
    }
    g.fillStyle = 'rgba(70,110,170,0.55)';
    g.beginPath();
    g.arc(0, 0, s * 0.19, 0, Math.PI * 2);
    g.fill();
  });
  const mos = new THREE.Mesh(new THREE.CircleGeometry(3.3, 96), new THREE.MeshStandardMaterial({ map: mosaic, transparent: true, roughness: 0.55, metalness: 0.25, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
  mos.rotation.x = -Math.PI / 2;
  mos.position.y = 0.01;
  mos.receiveShadow = true;
  G.add(mos);
  // fascia + gold band + underside rock
  G.add(shadowed(new THREE.Mesh(sweepEllipse(L, [[2.3, 0.0], [2.45, -0.08], [2.45, -0.9], [2.2, -1.2]], 200, 0, 0.6), marbleMat)));
  G.add(new THREE.Mesh(sweepEllipse(L, [[2.47, -0.32], [2.47, -0.44]], 200, 0, 1), goldMat));
  {
    // inverted rocky cone beneath the platform
    const g = new THREE.CylinderGeometry(1, 0.08, 1, 72, 10, true);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i),
        yv = p.getY(i),
        z = p.getZ(i);
      const an = Math.atan2(z, x);
      const k = yv + 0.5; // 1 top .. 0 bottom
      const n = fbm2(an * 3, yv * 4, 4, 5, 0);
      const rr = (0.55 + 0.45 * Math.pow(k, 0.6)) * (0.85 + n * 0.35);
      p.setXYZ(i, Math.cos(an) * rr * (L.rx + 2.2), -1.1 - (1 - k) * 16, Math.sin(an) * rr * (L.rz + 2.2));
    }
    g.computeVertexNormals();
    G.add(new THREE.Mesh(g, rockMat));
  }
  // ---------------- balustrade
  const balGeo = balusterGeo(0.95);
  const bal: THREE.Matrix4[] = [];
  alongEllipse(L, 0.95, 0.34, (p) => bal.push(new THREE.Matrix4().makeTranslation(p.x, 0, p.z)), 2.0);
  const balMesh = new THREE.InstancedMesh(balGeo, marbleMat, bal.length);
  bal.forEach((m, i) => balMesh.setMatrixAt(i, m));
  balMesh.castShadow = true;
  balMesh.receiveShadow = true;
  G.add(balMesh);
  G.add(shadowed(new THREE.Mesh(sweepEllipse(L, [[0.78, 0.95], [0.78, 1.08], [1.12, 1.08], [1.12, 0.95]], 220, 2.0, 1), marbleMat)));
  G.add(shadowed(new THREE.Mesh(sweepEllipse(L, [[0.8, 0], [0.8, 0.12], [1.1, 0.12], [1.1, 0]], 220, 2.0, 1), marbleMat)));
  alongEllipse(L, 0.95, 4.2, (p, yaw) => {
    const post = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.25, 0.42), marbleMat));
    post.position.set(p.x, 0.62, p.z);
    post.rotation.y = yaw;
    G.add(post);
    const fin = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), goldMat);
    fin.position.set(p.x, 1.42, p.z);
    G.add(fin);
  }, 2.6, 0.5);

  // ---------------- gates: twin pylons, floating halo, glowing veil, causeway out into the sky
  for (let i = 0; i < 2; i++) {
    makeGate(a, i, 1.0, (g) => {
      for (const s of [-1, 1]) {
        const py = shadowed(new THREE.Mesh(columnGeo(0.42, 6.2, { capital: 'simple', flutes: 16 }), marbleMat));
        py.position.set(s * 2.1, 0, 0);
        g.add(py);
        const cap = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.9, 4), goldMat);
        cap.position.set(s * 2.1, 6.65, 0);
        cap.rotation.y = Math.PI / 4;
        g.add(cap);
      }
      const halo = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.07, 10, 64), goldMat);
      halo.position.set(0, 5.6, 0);
      g.add(halo);
      const haloGlow = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.2, 8, 64), glowMat('#ffe7a0', 0.35));
      haloGlow.position.copy(halo.position);
      g.add(haloGlow);
      a.onUpdate((t) => {
        halo.rotation.y = t * 0.4;
        haloGlow.rotation.y = t * 0.4;
        halo.position.y = haloGlow.position.y = 5.6 + Math.sin(t * 1.1) * 0.12;
      });
      // causeway floating outward
      for (let k = 0; k < 5; k++) {
        const slab = shadowed(new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.5, 2.3), marbleMat));
        slab.position.set(0, -0.25 - k * 0.04, -1.6 - k * 2.45);
        g.add(slab);
        const under = new THREE.Mesh(rockGeo(1.1, 50 + k, { squash: 0.6 }), rockMat);
        under.rotation.x = Math.PI;
        under.position.set(0, -0.5, -1.6 - k * 2.45);
        under.scale.set(1.3, 1.4, 0.9);
        g.add(under);
      }
      const veilTex = canvasTexture(128, (cg, s) => {
        const grd = cg.createLinearGradient(0, s, 0, 0);
        grd.addColorStop(0, 'rgba(255,240,200,0.9)');
        grd.addColorStop(1, 'rgba(160,210,255,0)');
        cg.fillStyle = grd;
        cg.fillRect(0, 0, s, s);
      });
      const veil = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 4.6), glowMat('#ffffff', 0.55, veilTex));
      veil.position.set(0, 2.3, 0);
      const port = new THREE.Group();
      port.add(veil);
      port.position.z = 0.2;
      g.add(port);
      return {
        portcullis: port,
        lightPos: new THREE.Vector3(0, 3, 1.4),
        lightColor: '#ffe6b0',
        anchors: {
          barrier: 'veil',
          barrierHalfW: 1.8,
          barrierH: 4.6,
          // the causeway out into the sky is the walk-in space (no roof)
          tunnel: { depth: 11, height: 99, floorY: 0 },
          perches: [],
          // causeway side edges over the void: climb up from below
          rims: [-1, 1].map((s) => ({ id: s < 0 ? 'causeway_l' : 'causeway_r', pos: [s * 1.6, 0, -3.0] as V3, drop: 30, dir: [-s, 0] as [number, number] })),
          lowWall: { pos: [5.2, 1.08, 1.0 - 0.95], height: 1.08 },
          wallH: 1.08,
        },
      };
    });
  }

  // ---------------- sea of clouds + floating isles
  const cloud = cloudSea(a);
  G.add(cloud);
  const r = new R(L.seed + 7);
  const isleMats = { rock: rockMat, grass: grassMat };
  for (let k = 0; k < 11; k++) {
    const ang = (k / 11) * Math.PI * 2 + r.range(-0.2, 0.2);
    const dist = r.range(90, 230);
    const size = r.range(5, 12) * (dist / 110);
    const isle = floatingIsle(size, k * 17 + 3, isleMats, marbleMat, r.next() < 0.6);
    isle.position.set(Math.cos(ang) * dist, r.range(-14, 8), Math.sin(ang) * dist);
    isle.rotation.y = r.next() * 6;
    G.add(isle);
    const ph = r.next() * 6;
    const y0 = isle.position.y;
    a.onUpdate((t) => (isle.position.y = y0 + Math.sin(t * 0.25 + ph) * 0.6));
  }
  // a colossal broken halo far out in the sky
  {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(70, 2.2, 12, 160, Math.PI * 1.25), marbleMat);
    ring.userData.dyn = true;
    ring.position.set(-40, 30, -170);
    ring.rotation.set(0.15, 0.4, 0.5);
    G.add(ring);
    const ringGold = new THREE.Mesh(new THREE.TorusGeometry(70, 0.5, 6, 160, Math.PI * 1.25), goldMat);
    ringGold.position.copy(ring.position);
    ringGold.rotation.copy(ring.rotation);
    ringGold.scale.setScalar(1.035);
    G.add(ringGold);
  }

  return {
    mats: { stone: marbleTri, metal: goldMat, rim: marbleTri, spike: goldMat },
    obstacle: (o, crack) => (o.kind === 'rock' ? fallenColumn(o, colMat, o.id * 7 + 1) : columnObstacle(o, crack, colMat, goldMat, 'doric')),
    propMat: (k) => (k === 'urn' ? porcelain : k === 'crate' ? paleWood : k === 'rock' || k === 'chunk' ? marbleTri : k === 'explosive' ? pbr(TEX.wood('#7a2a6a', 41), {}) : paleWood),
    debrisOf: () => 'marble',
    urnDebris: 'marble',
    chandelier: () => bronzeChandelier(a, goldMat),
    chandelierDebris: 'metal',
    waterColor: '#2a6aa0',
    geyserColor: '#e8f6ff',
    decorateWater: (g, h) => {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(h.r + 0.1, 0.06, 6, 48), goldMat);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 0.06;
      g.add(rim);
    },
    envExtras: [cloudSea(a)],
    spot: 0,
  };
}

/** cloud sea: big shaded fbm plane below the platform */
function cloudSea(a: Arena): THREE.Mesh {
  const T = a.theme;
  const m = new THREE.ShaderMaterial({
    fog: false,
    transparent: false,
    uniforms: {
      uTime: shaderTime,
      uSun: { value: T.sky.sunDir },
      uTop: { value: new THREE.Color('#fff3e2') },
      uShade: { value: new THREE.Color('#8a8fc4') },
      uGap: { value: new THREE.Color('#3e4a8c') },
      uHorizon: { value: T.sky.horizon },
    },
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `uniform float uTime; uniform vec3 uSun; uniform vec3 uTop; uniform vec3 uShade; uniform vec3 uGap; uniform vec3 uHorizon; varying vec3 vW;
      ${GLSL_NOISE}
      void main(){
        vec2 p = vW.xz*0.012 + vec2(uTime*0.004, uTime*0.0025);
        float n = an_fbm(vec3(p, 0.0)) ;
        float n2 = an_fbm(vec3(p*2.7 + 3.1, 1.0));
        float h = n*0.75 + n2*0.25;
        float hs = an_fbm(vec3(p + uSun.xz*0.02, 0.0))*0.75 + an_fbm(vec3((p + uSun.xz*0.02)*2.7 + 3.1, 1.0))*0.25;
        float lit = clamp(0.5 + (h - hs)*12.0, 0.0, 1.0);
        vec3 c = mix(uShade, uTop, lit) * (0.75 + h*0.4);
        c = mix(uGap, c, smoothstep(0.33, 0.55, h));
        float d = length(vW.xz - cameraPosition.xz);
        c = mix(c, uHorizon * 0.95, smoothstep(160.0, 560.0, d));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400, 1, 1), m);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -22;
  return mesh;
}

function floatingIsle(size: number, seed: number, mats: { rock: THREE.Material; grass: THREE.Material }, marble: THREE.Material, temple: boolean): THREE.Group {
  const g = new THREE.Group();
  const top = new THREE.Mesh(rockGeo(size * 1.02, seed + 1, { squash: 0.12, rough: 0.25, detail: 3 }), mats.grass);
  top.position.y = -size * 0.06;
  g.add(top);
  const body = new THREE.Mesh(rockGeo(size, seed, { squash: 1.5, rough: 0.55, detail: 3 }), mats.rock);
  body.rotation.x = Math.PI;
  body.position.y = 0.05 * size;
  g.add(body);
  // a few trees on top
  const rr = new R(seed + 9);
  for (let i = 0; i < 4; i++) {
    const tr = new THREE.Mesh(new THREE.ConeGeometry(size * 0.08, size * 0.35, 6), mats.grass);
    const an = rr.next() * Math.PI * 2,
      d = rr.range(0.2, 0.7) * size;
    tr.position.set(Math.cos(an) * d, size * 0.17, Math.sin(an) * d);
    g.add(tr);
  }
  if (temple) {
    const r = new R(seed);
    const n = 6;
    for (let i = 0; i < n; i++) {
      const an = (i / n) * Math.PI * 2;
      const c = new THREE.Mesh(columnGeo(size * 0.06, size * 0.55, { capital: 'simple', flutes: 8, plinth: false }), marble);
      c.position.set(Math.cos(an) * size * 0.35, size * 0.12, Math.sin(an) * size * 0.35);
      g.add(c);
    }
    const roof = new THREE.Mesh(new THREE.ConeGeometry(size * 0.48, size * 0.25, 6), marble);
    roof.position.y = size * 0.12 + size * 0.55 + size * 0.12;
    g.add(roof);
    void r;
  }
  // waterfall strip
  const wf = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.15, size * 2.2), glowMat('#e8f6ff', 0.35));
  wf.position.set(size * 0.92, -size * 1.1, 0);
  wf.rotation.y = Math.PI / 2;
  g.add(wf);
  return g;
}

// =====================================================================================
// THE SUNSET RUINS - sandstone ruins under seated colossi at sunset
// =====================================================================================
export function dressDesert(a: Arena): Dressing {
  const L = a.layout;
  const G = a.group;
  const flags = TEX.flagstones('#d7a066', '#d9ad78', 31, 0, 5);
  const floorMat = pbr(flags, { macro: [0.06, 0.14] });
  const sandSet = TEX.sand('#e0aa72', 33, true);
  const sandMat = pbr(sandSet, { macro: [0.02, 0.12] });
  const ss = TEX.sandstone(12);
  const ssMat = pbr(ss, { macro: [0.05, 0.12], groundAO: 1.0 });
  const ssTri = pbr(ss, { triplanar: 0.3, macro: [0.03, 0.14] });
  const goldMat = pbr(TEX.metal('#d9a040', 7, 0.3), { metal: 1, rough: 1 });
  const bronzeMat = pbr(TEX.metal('#7a5232', 8, 0.5), { metal: 1, rough: 1 });
  const woodMat = pbr(TEX.wood('#8a6440', 15), {});
  const clay = new THREE.MeshStandardMaterial({ color: '#c0703e', roughness: 0.7 });
  const keg = pbr(TEX.wood('#7a2414', 16), {});

  // ---------------- floor + sand drifts
  G.add(floorDisc(L, 1.4, 6, floorMat));
  G.add(shadowed(new THREE.Mesh(sweepEllipse(L, [[-1.4, 0.0], [-0.6, 0.12], [0.3, 0.32], [0.95, 0.5]], 200, 2.2, 0.25), sandMat), false, true));
  // ---------------- ruined wall: block segments of varying height
  const r = new R(L.seed * 3 + 1);
  alongEllipse(L, 1.15, 2.05, (p, yaw) => {
    if (r.next() < 0.1) return; // collapsed gap
    const h = r.range(1.1, 3.0);
    const seg = shadowed(new THREE.Mesh(ruinBlock(2.15, h, 0.95, Math.floor(r.next() * 9999)), ssTri));
    seg.position.set(p.x, -0.05, p.z);
    seg.rotation.y = yaw;
    seg.rotation.z = r.range(-0.03, 0.03);
    G.add(seg);
    if (r.next() < 0.35) {
      const blk = shadowed(new THREE.Mesh(rockGeo(r.range(0.3, 0.55), Math.floor(r.next() * 999), { squash: 0.8, detail: 1 }), ssTri));
      blk.position.set(p.x + r.range(-0.5, 0.5), 0, p.z + r.range(-0.5, 0.5));
      G.add(blk);
    }
  }, 2.5);
  // outer dunes terrain
  const dunes = groundPlane(900, 7, sandMat, -0.05, 160, (x, z) => {
    const d = Math.hypot(x / (L.rx + 3), z / (L.rz + 3));
    if (d < 1.05) return -0.05;
    const k = Math.min(1, (d - 1.05) * 0.6);
    return k * (fbm2(x * 0.012, z * 0.012, 4, 3, 0) * 16 - 3 + Math.sin(x * 0.03 + z * 0.012) * 1.5);
  });
  G.add(dunes);
  // ---------------- colossi flanking the arena
  for (const s of [-1, 1]) {
    const col = shadowed(new THREE.Mesh(colossusGeo(24), ssTri));
    col.position.set(s * 9, -0.5, s * (L.rz + 17));
    col.rotation.y = s > 0 ? Math.PI : 0;
    G.add(col);
    const ob = shadowed(new THREE.Mesh(obeliskGeo(1.2, 13), ssTri));
    ob.position.set(-s * 10, 0, s * (L.rz + 9));
    G.add(ob);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.6, 0.62, 4), goldMat);
    tip.position.set(-s * 10, 12.7, s * (L.rz + 9));
    tip.rotation.y = Math.PI / 4;
    G.add(tip);
  }
  // broken colonnade arc
  alongEllipse(L, 7.5, 4.0, (p, _y, _a, i) => {
    if (i % 3 === 2) return;
    const h = i % 4 === 0 ? r.range(2.5, 4.5) : 7.5;
    const c = shadowed(new THREE.Mesh(columnGeo(0.55, h, { capital: h > 7 ? 'doric' : 'simple', flutes: 16 }), ssMat));
    c.position.set(p.x, 0, p.z);
    G.add(c);
    if (h < 7) {
      const d = shadowed(new THREE.Mesh(drumGeo(0.5, 0.8, i), ssMat));
      d.position.set(p.x + 1.2, 0.5, p.z + 0.4);
      d.rotation.z = Math.PI / 2;
      G.add(d);
    }
  }, 6.0, 0.3);
  // palms for a splash of green against the stone
  {
    const trunkMat = pbr(TEX.bark('#7a5a3a', 81), {});
    const frondMat = new THREE.MeshStandardMaterial({ color: '#5f8a3a', roughness: 0.8, side: THREE.DoubleSide });
    alongEllipse(L, 3.2, 7.5, (p, _y, _a, i) => {
      if (i % 3 === 1) return;
      const pg = palmGeo(400 + i, r.range(6, 9));
      const t = shadowed(new THREE.Mesh(pg.trunk, trunkMat));
      t.position.copy(p);
      G.add(t);
      const f = shadowed(new THREE.Mesh(pg.fronds, frondMat));
      f.position.copy(p);
      G.add(f);
    }, 4.5, 0.2);
  }
  // distant pyramids
  for (let k = 0; k < 4; k++) {
    const pyr = new THREE.Mesh(new THREE.ConeGeometry(40 + k * 12, 50 + k * 10, 4), ssTri);
    const an = 2.2 + k * 0.45;
    pyr.position.set(Math.cos(an) * (240 + k * 60), 20 + k * 3, Math.sin(an) * (240 + k * 60));
    pyr.rotation.y = 0.4 + k;
    G.add(pyr);
  }
  // ---------------- gates: pylons with a winged sun
  for (let i = 0; i < 2; i++) {
    makeGate(a, i, 1.15, (g) => {
      for (const s of [-1, 1]) {
        const py = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.7, 7.5, 4, 1), ssMat));
        py.rotation.y = Math.PI / 4;
        py.scale.set(1.25, 1, 0.75);
        py.position.set(s * 3.0, 3.75, -0.4);
        g.add(py);
      }
      const lintel = shadowed(new THREE.Mesh(new THREE.BoxGeometry(5.4, 1.2, 1.6), ssMat));
      lintel.position.set(0, 4.6, -0.4);
      g.add(lintel);
      // turquoise faience bands (complementary accent against the orange stone)
      const faience = new THREE.MeshStandardMaterial({ color: '#2a9a9a', roughness: 0.3, metalness: 0.1 });
      for (const yy of [4.05, 5.15]) {
        const band = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.14, 1.65), faience);
        band.position.set(0, yy, -0.4);
        g.add(band);
      }
      const sun = new THREE.Mesh(new THREE.CircleGeometry(0.42, 24), goldMat);
      sun.position.set(0, 4.62, 0.42);
      g.add(sun);
      for (const s of [-1, 1]) {
        const wing = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.28), goldMat);
        wing.position.set(s * 1.05, 4.66, 0.41);
        g.add(wing);
      }
      const tunnel = new THREE.Mesh(new THREE.BoxGeometry(3.2, 4.0, 6), new THREE.MeshStandardMaterial({ color: '#1c120c', roughness: 1, side: THREE.BackSide }));
      tunnel.position.set(0, 2.0, -3.6);
      g.add(tunnel);
      const port = new THREE.Group();
      for (let k = -4; k <= 4; k++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 3.9, 0.1), bronzeMat);
        bar.position.set(k * 0.34, 1.95, 0);
        port.add(bar);
      }
      port.position.z = 0.2;
      g.add(port);
      for (const s of [-1, 1]) g.add(a.flame(new THREE.Vector3(s * 2.2, 3.3, 0.6), 0.8, '#ff9a40', s > 0));
      return {
        portcullis: port,
        lightPos: new THREE.Vector3(0, 2.4, 1.6),
        lightColor: '#ffa050',
        anchors: {
          barrier: 'portcullis',
          barrierHalfW: 1.5,
          barrierH: 3.9,
          tunnel: { depth: 6, height: 4.0, floorY: 0 },
          // the lintel between the pylons (top 5.2 m, 1.6 m deep)
          perches: [{ id: 'lintel', pos: [0, 5.2, 0.15], depth: 1.6 }],
          wallH: 2.2,
        },
      };
    });
  }

  return {
    mats: { stone: ssTri, metal: bronzeMat, rim: ssTri, spike: bronzeMat },
    obstacle: (o, crack) => {
      if (o.kind === 'rock') return rubbleObstacle(o, ssTri, o.id * 11 + 2);
      const g = new THREE.Group();
      g.add(shadowed(new THREE.Mesh(statueGeo(o.h, o.id + 1), withCrack(ssMat, { macro: [0.2, 0.08] }, crack))));
      return g;
    },
    propMat: (k) => (k === 'urn' ? clay : k === 'explosive' ? keg : k === 'rock' || k === 'chunk' ? ssTri : k === 'brazier' ? bronzeMat : woodMat),
    debrisOf: () => 'sandstone',
    urnDebris: 'ceramic',
    chandelier: () => bronzeChandelier(a, bronzeMat),
    chandelierDebris: 'metal',
    geyserColor: '#e8c090',
    envExtras: [],
    spot: 0,
  };
}

// keep tree-shakers honest about helpers used only by other theme files
export const _unused = { merge, place, inGate, bakeVertexShade, waterMaterial };
export type { HazardDef };
