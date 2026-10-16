/**
 * Theme dressing: the Molten Forge - a basalt cathedral over rivers of fire.
 */
import * as THREE from 'three';
import type { Arena } from './arenaView';
import type { Dressing } from './dressing';
import { TEX, canvasTexture } from './textures';
import { pbr, withCrack, glowMat, lavaMaterial, shaderTime } from './materials';
import { alongEllipse, ellipseAt, floorDisc, inGate, makeGate, sweepEllipse } from './common';
import { chainGeo, obeliskGeo, rockGeo, columnGeo } from './kit';
import { R, fbm2 } from './noise';

const shadowed = <T extends THREE.Mesh>(m: T, cast = true, recv = true): T => {
  m.castShadow = cast;
  m.receiveShadow = recv;
  return m;
};

let _runes: THREE.Texture | null = null;
function runeTex() {
  if (_runes) return _runes;
  _runes = canvasTexture(256, (g, s) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, s, s);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 5;
    let r = 9;
    const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    for (let row = 0; row < 8; row++) {
      const y = (row + 0.5) * (s / 8);
      for (let k = 0; k < 3; k++) {
        const x = s * (0.2 + k * 0.3);
        g.beginPath();
        g.moveTo(x - 8, y - 10);
        g.lineTo(x + (rnd() - 0.5) * 16, y);
        g.lineTo(x + 8, y + 10);
        if (rnd() < 0.5) {
          g.moveTo(x - 9, y + 8);
          g.lineTo(x + 9, y - 8);
        }
        g.stroke();
      }
    }
  });
  return _runes;
}

export function dressForge(a: Arena): Dressing {
  const L = a.layout;
  const G = a.group;
  const basalt = TEX.basalt(6, 1);
  const floorMat = pbr(basalt, { macro: [0.05, 0.1], emissive: '#ffffff', emissiveIntensity: 1.0 });
  a.onUpdate((t) => ((floorMat as THREE.MeshStandardMaterial).emissiveIntensity = 0.85 + Math.sin(t * 1.3) * 0.25));
  const wallSet = TEX.blocks('#5a4e4a', '#1e1614', 4, 2, 71, 0.2, 0.3);
  const wallMat = pbr(wallSet, { macro: [0.05, 0.1] });
  const rockMat = pbr(TEX.blocks('#4a403c', '#241c1a', 3, 2, 72, 0.3, 0.8), { triplanar: 0.12, macro: [0.03, 0.25] });
  const iron = pbr(TEX.metal('#4a4446', 73, 0.45), { metal: 1, rough: 1 });
  const ironDark = pbr(TEX.metal('#2a2628', 74, 0.55), { metal: 1, rough: 1 });
  const obsidian = new THREE.MeshStandardMaterial({ color: '#1c171a', roughness: 0.18, metalness: 0.2, emissive: '#ff5a10', emissiveMap: runeTex(), emissiveIntensity: 2.2 });
  const woodMat = pbr(TEX.wood('#5a3a26', 75), {});
  const keg = pbr(TEX.wood('#3a1410', 76), {});
  const lava = lavaMaterial();

  G.add(floorDisc(L, 1.2, 6, floorMat));
  // basalt wall with glowing rune seam + iron cap
  G.add(shadowed(new THREE.Mesh(sweepEllipse(L, [[1.0, 0], [1.0, 3.0], [1.4, 3.1], [1.4, 3.3], [0.85, 3.3]], 220, 2.4, 0.33), wallMat)));
  G.add(new THREE.Mesh(sweepEllipse(L, [[0.98, 1.55], [0.98, 1.75]], 220, 2.4, 1), glowMat('#ff6a1a', 0.85)));
  G.add(shadowed(new THREE.Mesh(sweepEllipse(L, [[0.9, 3.3], [0.9, 3.42], [1.5, 3.42], [1.5, 3.3]], 220, 2.4, 1), ironDark)));
  alongEllipse(L, 0.9, 3.0, (p, yaw) => {
    const sp = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.7, 5), iron);
    sp.position.set(p.x, 3.75, p.z);
    G.add(sp);
    const rib = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.35, 3.3, 0.25), ironDark));
    rib.position.set(p.x, 1.65, p.z);
    rib.rotation.y = yaw;
    G.add(rib);
  }, 2.6);
  // lava moat outside the wall (big under-light)
  const moat = new THREE.Mesh(sweepEllipse(L, [[1.5, -1.2], [9.5, -1.2]], 160, 0, 0.25), lava);
  G.add(moat);
  G.add(shadowed(new THREE.Mesh(sweepEllipse(L, [[1.5, 3.0], [1.5, -1.3]], 200, 0, 0.33), wallMat)));
  // cavern walls
  {
    const g = new THREE.CylinderGeometry(1, 1, 1, 96, 24, true);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const an = Math.atan2(p.getZ(i), p.getX(i));
      const yv = p.getY(i) + 0.5;
      const n = fbm2(an * 4, yv * 6, 5, 3, 0);
      const rr = 1 + (n - 0.5) * 0.35 - Math.pow(yv, 2) * 0.25;
      p.setXYZ(i, Math.cos(an) * rr * (L.rx + 22), -2 + yv * 48, Math.sin(an) * rr * (L.rz + 22));
    }
    g.computeVertexNormals();
    const cavMat = rockMat.clone();
    cavMat.side = THREE.BackSide;
    const cav = new THREE.Mesh(g, cavMat);
    cav.receiveShadow = true;
    G.add(cav);
  }
  // lava falls on the cavern walls
  const fallTex = canvasTexture(128, (g, s) => {
    for (let x = 0; x < s; x += 4) {
      const k = 0.5 + 0.5 * Math.sin(x * 0.4);
      g.fillStyle = `rgba(255,${120 + k * 80},${30 + k * 30},${0.6 + k * 0.4})`;
      g.fillRect(x, 0, 3, s);
    }
  });
  fallTex.wrapS = fallTex.wrapT = THREE.RepeatWrapping;
  const r = new R(L.seed + 13);
  for (let k = 0; k < 5; k++) {
    const an = (k / 5) * Math.PI * 2 + 0.4 + r.range(-0.2, 0.2);
    const p = ellipseAt(L, an, 19.5);
    if (inGate(L, p, 6)) continue;
    const fm = glowMat('#ff6a1a', 0.7, fallTex);
    const fall = new THREE.Mesh(new THREE.PlaneGeometry(r.range(1.2, 2.2), 36), fm);
    fall.position.set(p.x, 16, p.z);
    fall.lookAt(0, 16, 0);
    fall.userData.dyn = true;
    G.add(fall);
    a.onUpdate((t) => (fm.map!.offset.y = t * 0.6));
    const pool = new THREE.Mesh(new THREE.CircleGeometry(4, 24), lava);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(p.x * 0.97, -1.15, p.z * 0.97);
    G.add(pool);
  }
  // gothic pillars rising into smoke + hanging chains
  alongEllipse(L, 10.5, 9.5, (p, _y, _a, i) => {
    const col = shadowed(new THREE.Mesh(columnGeo(1.3, 34, { capital: 'simple', flutes: 8 }), wallMat), true, false);
    col.position.set(p.x, -1.2, p.z);
    G.add(col);
    if (i % 2 === 0) {
      const ch = new THREE.Mesh(chainGeo(16, 0.3), ironDark);
      ch.position.set(p.x * 0.85, 30, p.z * 0.85);
      G.add(ch);
    }
  }, 6, 0.5);
  // giant anvils & cauldron silhouettes on the moat edge
  for (const s of [-1, 1]) {
    const anvil = shadowed(new THREE.Mesh(new THREE.BoxGeometry(5, 2.2, 2.2), ironDark));
    anvil.position.set(s * 5, 4.6, s * (L.rz + 8.5));
    G.add(anvil);
    const base = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2.4, 3.6, 8), ironDark));
    base.position.set(s * 5, 1.8, s * (L.rz + 8.5));
    G.add(base);
    const caul = shadowed(new THREE.Mesh(new THREE.SphereGeometry(2.6, 18, 12, 0, Math.PI * 2, Math.PI / 2.4, Math.PI / 1.8), iron));
    caul.position.set(-s * 9, 3.5, s * (L.rz + 9));
    G.add(caul);
    const melt = new THREE.Mesh(new THREE.CircleGeometry(2.1, 24), lava);
    melt.rotation.x = -Math.PI / 2;
    melt.position.set(-s * 9, 4.4, s * (L.rz + 9));
    G.add(melt);
  }
  // gates: iron doors in a pointed arch
  for (let i = 0; i < 2; i++) {
    makeGate(a, i, 1.0, (g) => {
      const sh = new THREE.Shape();
      sh.moveTo(-3.6, 0);
      sh.lineTo(3.6, 0);
      sh.lineTo(3.6, 6.4);
      sh.lineTo(0, 8.2);
      sh.lineTo(-3.6, 6.4);
      sh.lineTo(-3.6, 0);
      const hole = new THREE.Path();
      hole.moveTo(-1.6, 0);
      hole.lineTo(1.6, 0);
      hole.lineTo(1.6, 3.0);
      hole.quadraticCurveTo(1.4, 4.4, 0, 5.0);
      hole.quadraticCurveTo(-1.4, 4.4, -1.6, 3.0);
      hole.lineTo(-1.6, 0);
      sh.holes.push(hole);
      const fac = shadowed(new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: 1.6, bevelEnabled: false }), wallMat));
      fac.position.z = -1.4;
      g.add(fac);
      const rune = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.06, 6, 24), glowMat('#ff7a2a', 0.9));
      rune.position.set(0, 6.3, 0.22);
      g.add(rune);
      const tunnel = new THREE.Mesh(new THREE.BoxGeometry(3.2, 5, 6), new THREE.MeshStandardMaterial({ color: '#120a08', roughness: 1, side: THREE.BackSide }));
      tunnel.position.set(0, 2.5, -4.4);
      g.add(tunnel);
      const port = new THREE.Group();
      for (let k = -5; k <= 5; k++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 4.6, 0.1), iron);
        bar.position.set(k * 0.29, 2.3, 0);
        port.add(bar);
      }
      for (let j = 0; j < 4; j++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.1, 0.1), iron);
        bar.position.set(0, 0.6 + j * 1.1, 0);
        port.add(bar);
      }
      port.position.z = 0.2;
      g.add(port);
      for (const s of [-1, 1]) g.add(a.flame(new THREE.Vector3(s * 2.5, 3.6, 0.6), 1.0, '#ff7a2a', s > 0));
      return { portcullis: port, lightPos: new THREE.Vector3(0, 2.4, 1.6), lightColor: '#ff7a30' };
    });
  }

  return {
    mats: { stone: rockMat, metal: iron, rim: rockMat, spike: iron },
    obstacle: (o, crack) => {
      const g = new THREE.Group();
      if (o.kind === 'rock') {
        g.add(shadowed(new THREE.Mesh(rockGeo(o.r * 1.05, o.id * 5 + 9, { squash: 0.8, flat: 0.5 }), rockMat)));
        return g;
      }
      g.add(shadowed(new THREE.Mesh(obeliskGeo(o.r * 1.05, o.h), withCrack(obsidian, {}, crack))));
      return g;
    },
    propMat: (k) => (k === 'explosive' ? keg : k === 'rock' || k === 'chunk' ? rockMat : k === 'brazier' ? iron : k === 'urn' ? iron : woodMat),
    debrisOf: (k) => (k === 'rock' ? 'stone' : 'obsidian'),
    urnDebris: 'metal',
    chandelier: () => {
      const g = new THREE.Group();
      const bucket = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.6, 1.0, 16, 1, true), iron));
      g.add(bucket);
      const melt = new THREE.Mesh(new THREE.CircleGeometry(0.85, 20), lava);
      melt.rotation.x = -Math.PI / 2;
      melt.position.y = 0.35;
      g.add(melt);
      g.add(a.flame(new THREE.Vector3(0, 0.4, 0), 0.55, '#ff8a30', false));
      return g;
    },
    chandelierDebris: 'metal',
    envExtras: [],
    spot: 25,
  };
}

export const _f = shaderTime;
