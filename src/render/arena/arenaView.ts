/**
 * ARENA VIEW: builds the visual arena from a generated ArenaLayout (the same
 * data the sim collides against) + a visual theme, and keeps it in sync with
 * recorded frames (props, cover damage, toppling columns, hazard states).
 *
 * Common systems live here (sky + IBL, sun/shadows, fog, floor, obstacles,
 * props, hazards, ring of fire, ambient particles, debris, decals); the
 * per-theme look (materials, boundary walls, gates, backdrop) comes from
 * dressing.ts.
 */
import * as THREE from 'three';
import type { ArenaLayout, HazardDef, Obstacle } from '../../sim/arenaGen';
import { boundR } from '../../sim/arenaGen';
import type { Frame, SimEvent } from '../../sim/types';
import { THEME_DEFS, type ThemeDef } from './themes';
import { bakeEnvironment, makeSky } from './sky';
import { ArenaFog, installHeightFog } from './fog';
import { Ambient } from './ambient';
import { Debris, Decals, type DebrisMat } from './debris';
import { glowMat, lavaMaterial, shaderTime, waterMaterial } from './materials';
import { merge as mergeAll, braziersGeo, chainGeo, crateGeo, drumGeo, paperLanternGeo, spikeGeo, urnGeo, barrelGeo, rockGeo } from './kit';
import { buildDressing, type Dressing } from './dressing';
import type { ArenaPack } from './assets';
import { canvasTexture, softDot } from './textures';
import { R } from './noise';

export interface Gate {
  angle: number;
  pos: THREE.Vector3;
  inward: THREE.Vector3;
  portcullis: THREE.Object3D;
  light: THREE.PointLight;
  group: THREE.Group;
  smashed: boolean;
  /** what the dressing actually built around this gate (gate frame: x right, y up, z into the arena from the boundary) */
  anchors: GateAnchors;
}

export type V3 = [number, number, number];
/**
 * STAGE ANCHORS: published by each theme's gate builder from the geometry it
 * created, so entrance choreography can only use surfaces that exist.
 */
export interface GateAnchors {
  barrier: 'portcullis' | 'veil' | 'rope' | 'icicles' | 'none';
  /** barrier plane z (gate frame), half width, height */
  barrierZ: number;
  barrierHalfW: number;
  barrierH: number;
  /** walk-out space behind the barrier: depth (m, from the barrier backwards) and clear height */
  tunnel?: { depth: number; height: number; floorY: number };
  /** standable surfaces above the gate / on the wall (top surface y), with the facing into the arena */
  perches: { id: string; pos: V3; depth: number }[];
  /** platform edges with a drop below (climb-up entrances): pos = top of the edge, dir = inward unit (x, z) */
  rims: { id: string; pos: V3; drop: number; dir: [number, number] }[];
  /** crowd tier spots (stands) */
  stands: V3[];
  /** low wall / fence next to the gate that can be vaulted (top y) */
  lowWall?: { pos: V3; height: number };
  /** boundary wall height next to the gate */
  wallH: number;
  /** the barrier's breakable pieces (restored on reset) */
  pieces: { obj: THREE.Object3D; pos: THREE.Vector3; rot: THREE.Euler; vis: boolean }[];
}

export interface Mood {
  moon: number;
  hemi: number;
  fog: number;
  spot: number;
  gateColor: string;
}

interface ObsView {
  def: Obstacle;
  pivot: THREE.Group;
  mesh: THREE.Object3D;
  crack: { value: number };
  fallen: boolean;
  landed: boolean;
  lastHp: number;
  axis?: THREE.Vector3;
}
interface PropView {
  obj: THREE.Object3D;
  kind: string;
  glow?: THREE.Mesh;
  fire?: THREE.Object3D;
  gone: boolean;
  /** A1: kit asset id when the prop is a baked asset (else the legacy procedural mesh) */
  kit?: string;
}
interface HazView {
  def: HazardDef;
  group: THREE.Group;
  update: (state: number, t: number, dt: number) => void;
}

/** quality: 0 low, 1 medium, 2 high */
export class Arena {
  group = new THREE.Group();
  layout: ArenaLayout;
  theme: ThemeDef;
  quality: number;
  gates: Gate[] = [];
  moon: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  centerSpot: THREE.SpotLight;
  fog: ArenaFog;
  excitement = 0.2;
  sky: THREE.Mesh;
  env: THREE.Texture;
  ambient: Ambient;
  debris = new Debris();
  decals: Decals;
  dressing: Dressing;
  obstacles: ObsView[] = [];
  props: PropView[] = [];
  hazards: HazView[] = [];
  fireRing: THREE.Mesh;
  private ringThrough = 0;
  private fireRingMat: THREE.MeshBasicMaterial;
  private base: { sun: number; hemi: number; fog: number; spot: number };
  private time = 0;
  private scene: THREE.Scene;
  private propMats: Record<string, THREE.Material> = {};
  private propGeos: Record<string, THREE.BufferGeometry> = {};
  private flames: { obj: THREE.Object3D; ph: number; base: number; light?: THREE.PointLight; li?: number }[] = [];
  private updaters: ((t: number, dt: number) => void)[] = [];
  private lastFrameT = -1;

  /** A1: loaded kit art (assets.ts) or null = the legacy procedural dressing (always with ?arena=legacy) */
  readonly kit: ArenaPack | null;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, layout: ArenaLayout, quality = 2, kit: ArenaPack | null = null) {
    installHeightFog();
    this.scene = scene;
    this.layout = layout;
    this.quality = quality;
    this.kit = kit;
    const T = (this.theme = THEME_DEFS[layout.theme]);
    scene.add(this.group);

    // ---------------- sky, environment, fog
    this.sky = makeSky(T.sky);
    this.sky.userData.dyn = true;
    this.group.add(this.sky);
    this.dressing = buildDressing(this);
    this.drawCallsMerged = mergeStatic(this.group);
    this.env = bakeEnvironment(renderer, T.sky, this.dressing.envExtras);
    scene.environment = this.env;
    scene.background = null;
    this.fog = new ArenaFog(T.fog.color, T.fog.density, T.fog.height);
    scene.fog = this.fog;

    // ---------------- lights
    this.hemi = new THREE.HemisphereLight(T.hemi[0], T.hemi[1], T.hemi[2]);
    this.group.add(this.hemi);
    const sun = new THREE.DirectionalLight(T.sunColor, T.sunIntensity);
    const sd = T.sky.moonSize > 0 && T.sky.sunGlow === 0 ? T.sky.moonDir : T.sky.sunDir;
    sun.position.copy(sd).multiplyScalar(60);
    sun.castShadow = true;
    const sm = quality >= 1 ? 2048 : 1024;
    sun.shadow.mapSize.set(sm, sm);
    const ext = Math.max(layout.rx, layout.rz) + 6;
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -ext;
    sc.right = sc.top = ext;
    sc.near = 10;
    sc.far = 140;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 3;
    this.moon = sun;
    this.group.add(sun, sun.target);
    const spot = new THREE.SpotLight(T.key, 0, 45, 0.6, 0.7, 1.4);
    spot.position.set(0, 24, 0);
    spot.target.position.set(0, 0, 0);
    this.centerSpot = spot;
    this.group.add(spot, spot.target);
    this.base = { sun: T.sunIntensity, hemi: T.hemi[2], fog: T.fog.density, spot: this.dressing.spot ?? 0 };
    spot.intensity = this.base.spot;

    // ---------------- floor decals / debris / ambient
    this.decals = new Decals(layout.rx, layout.rz);
    this.group.add(this.decals.mesh);
    this.group.add(this.debris.group);
    this.ambient = new Ambient(T.ambient, quality);
    this.group.add(this.ambient.group);

    // ---------------- obstacles, props, hazards
    for (const o of layout.obstacles) this.addObstacle(o);
    for (const p of layout.props) this.addProp(p.kind);
    for (const h of layout.hazards) this.addHazard(h);

    // ---------------- ring of fire (ellipse)
    const flameTex = canvasTexture(256, (g, s) => {
      const rr = new R(21);
      g.clearRect(0, 0, s, s);
      for (let i = 0; i < 90; i++) {
        const x = rr.next() * s,
          w = rr.range(6, 22),
          h = rr.range(0.35, 1) * s;
        const grd = g.createLinearGradient(0, s, 0, s - h);
        grd.addColorStop(0, 'rgba(255,240,200,0.95)');
        grd.addColorStop(0.35, 'rgba(255,255,255,0.6)');
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grd;
        g.beginPath();
        g.ellipse(x, s, w, h, 0, Math.PI, 0);
        g.fill();
      }
    });
    flameTex.wrapS = THREE.RepeatWrapping;
    flameTex.repeat.set(26, 1);
    this.fireRingMat = glowMat(T.fire, 0, flameTex);
    this.fireRing = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1.5, 128, 1, true), this.fireRingMat);
    this.fireRing.position.y = 0.75;
    this.fireRing.visible = false;
    this.fireRing.userData.dyn = true;
    this.group.add(this.fireRing);
  }

  // ------------------------------------------------------------------ builders
  /** material lookups provided by the theme dressing */
  private mat(name: string): THREE.Material {
    return this.dressing.mats[name] ?? this.dressing.mats.stone;
  }

  private addObstacle(o: Obstacle) {
    const D = this.dressing;
    const crack = { value: 0 };
    const mesh = D.obstacle(o, crack);
    const pivot = new THREE.Group();
    pivot.position.set(o.x, 0, o.z);
    pivot.add(mesh);
    this.group.add(pivot);
    this.obstacles.push({ def: o, pivot, mesh, crack, fallen: false, landed: false, lastHp: 1 });
  }

  private propGeo(kind: string): THREE.BufferGeometry {
    if (!this.propGeos[kind]) {
      this.propGeos[kind] =
        kind === 'crate' ? crateGeo(0.82) : kind === 'barrel' || kind === 'explosive' ? barrelGeo(0.38, 0.98) : kind === 'urn' ? urnGeo(0.72) : kind === 'rock' ? rockGeo(0.42, 77, { squash: 0.75 }) : kind === 'chunk' ? drumGeo(0.36, 0.55, 5) : kind === 'brazier' ? braziersGeo() : paperLanternGeo().post;
    }
    return this.propGeos[kind];
  }

  addProp(kind: string) {
    const D = this.dressing;
    const g = new THREE.Group();
    // A1: a baked kit asset (authored to PROP_BASE radius / TOP height, origin at the base centre) when the
    // theme's art maps this kind to a loaded asset; otherwise the legacy procedural prop, unchanged
    const inst = D.propAsset?.(kind) ?? null;
    if (inst) g.add(inst.obj);
    else {
      const m = new THREE.Mesh(this.propGeo(kind), D.propMat(kind));
      m.castShadow = m.receiveShadow = true;
      g.add(m);
    }
    const pv: PropView = { obj: g, kind, gone: false, kit: inst?.asset.id };
    if (kind === 'explosive') {
      // glowing rune band + fuse spark
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.39, 0.035, 6, 24), glowMat('#ff6a20', 0.9));
      band.rotation.x = Math.PI / 2;
      band.position.y = 0.5;
      g.add(band);
      const spark = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), glowMat('#ffd080', 0, softDot()));
      spark.position.y = 1.08;
      g.add(spark);
      pv.glow = spark;
    }
    if (kind === 'brazier') {
      // kit: the asset's SOCK_flame {size, light}; legacy: the old fixed spot
      const s = inst?.sockets.find((x) => x.name === 'SOCK_flame');
      const at = s ? new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]) : new THREE.Vector3(0, 1.2, 0);
      const fl = this.flame(at, typeof s?.extras.size === 'number' ? s.extras.size : 0.9, this.theme.fire, s ? Number(s.extras.light ?? 1) > 0 : true);
      g.add(fl);
      pv.fire = fl;
    }
    if (kind === 'lantern') {
      const paper = new THREE.Mesh(paperLanternGeo().paper, new THREE.MeshStandardMaterial({ color: '#ffe0b0', emissive: '#ff9a40', emissiveIntensity: 2.2, roughness: 0.8 }));
      g.add(paper);
    }
    this.group.add(g);
    this.props.push(pv);
    return pv;
  }

  private _riverLava?: THREE.Material;
  private _riverWater?: THREE.Material;
  private riverLava() {
    return (this._riverLava ??= lavaMaterial());
  }
  private riverWater() {
    return (this._riverWater ??= waterMaterial(this.dressing.waterColor ?? '#1d4a5a', { opacity: 0.9, env: 1.3 }));
  }

  /** billboard-ish flame: two crossed additive quads + optional light */
  flame(at: THREE.Vector3, size: number, color: string, light = false): THREE.Object3D {
    const tex = flameSprite();
    const g = new THREE.Group();
    g.position.copy(at);
    // FX F3: a flipbook flame (Unity Labs) when the FX system provides one; the light and flicker stay here
    const fx = Arena.fxFlame?.(size, color, this.flames.length);
    if (fx) g.add(fx);
    else for (let i = 0; i < 2; i++) {
      const q = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.7, size), glowMat(color, 0.95, tex));
      q.position.y = size * 0.35;
      q.rotation.y = (i * Math.PI) / 2;
      g.add(q);
    }
    if (!fx) {
      const core = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.35, size * 0.55), glowMat('#fff2c0', 0.9, tex));
      core.position.y = size * 0.2;
      g.add(core);
    }
    const entry: (typeof this.flames)[number] = { obj: g, ph: Math.random() * 10, base: 1 };
    if (light && this.lightBudget > 0) {
      this.lightBudget--;
      const L = new THREE.PointLight(color, size * 6, size * 14, 1.6);
      L.position.y = size * 0.5;
      g.add(L);
      entry.light = L;
      entry.li = L.intensity;
    }
    this.flames.push(entry);
    return g;
  }
  lightBudget = 7;
  drawCallsMerged = 0;
  /** FX hook (F3, src/render/fx/flames.ts): builds the flame visual; null / unset = the old crossed quads */
  static fxFlame?: (size: number, color: string, n: number) => THREE.Object3D | null;

  private addHazard(h: HazardDef) {
    const g = new THREE.Group();
    g.position.set(h.x, 0, h.z);
    this.group.add(g);
    let update: HazView['update'] = () => {};
    const D = this.dressing;
    // the 'split' layout's river: contiguous square cells read as one channel
    const river = this.layout.layout === 'split' && Math.abs(h.x) < 1e-6 && Math.abs(h.r - 0.75) < 1e-6;
    if (river) {
      const cell = new THREE.PlaneGeometry(1.3, 1.12);
      cell.rotateX(-Math.PI / 2);
      if (h.kind === 'lava' || h.kind === 'water') {
        const m = new THREE.Mesh(cell, h.kind === 'lava' ? this.riverLava() : this.riverWater());
        m.position.y = h.kind === 'lava' ? 0.02 : 0.03;
        m.receiveShadow = true;
        g.add(m);
        for (const s of [-1, 1]) {
          const lip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 1.12), D.mats.rim ?? D.mats.stone);
          lip.position.set(s * 0.72, 0.04, 0);
          lip.castShadow = lip.receiveShadow = true;
          g.add(lip);
        }
        if (h.kind === 'lava' && h.id % 4 === 0 && this.lightBudget > 0) {
          this.lightBudget--;
          const L = new THREE.PointLight('#ff6a20', 10, 7, 1.6);
          L.position.y = 0.8;
          g.add(L);
        }
        this.hazards.push({ def: h, group: g, update });
        return;
      }
      if (h.kind === 'spikes') {
        const grate = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.08, 1.06), D.mats.metal);
        grate.position.y = 0.04;
        grate.receiveShadow = true;
        g.add(grate);
        const { spikes } = spikeGeo(0.72);
        const sp = new THREE.Mesh(spikes, D.mats.spike ?? D.mats.metal);
        sp.castShadow = true;
        sp.position.y = -0.7;
        g.add(sp);
        const warn = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.06).rotateX(-Math.PI / 2), glowMat('#ff5a2a', 0));
        warn.position.y = 0.09;
        g.add(warn);
        update = (s, _t, dt) => {
          const target = s === 2 ? 0 : s === 1 ? -0.55 : -0.72;
          sp.position.y += (target - sp.position.y) * Math.min(1, dt * (s === 2 ? 40 : 8));
          (warn.material as THREE.MeshBasicMaterial).opacity = s === 1 ? 0.35 + Math.sin(this.time * 30) * 0.2 : 0;
        };
        this.hazards.push({ def: h, group: g, update });
        return;
      }
    }
    switch (h.kind) {
      case 'lava': {
        const geo = blobDisc(h.r, h.id + 3, 64);
        const lava = new THREE.Mesh(geo, lavaMaterial());
        lava.position.y = 0.03;
        g.add(lava);
        // crust rim
        const rim = new THREE.Mesh(blobRing(h.r, h.r + 0.45, h.id + 3), D.mats.rim ?? D.mats.stone);
        rim.position.y = 0.0;
        rim.receiveShadow = true;
        g.add(rim);
        if (this.lightBudget > 0) {
          this.lightBudget--;
          const L = new THREE.PointLight('#ff6a20', 18, h.r * 6, 1.5);
          L.position.y = 1.0;
          g.add(L);
          update = (_s, t) => (L.intensity = 16 + Math.sin(t * 2.3 + h.id) * 3);
        }
        break;
      }
      case 'firepit': {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(h.r * 0.9, 0.2, 8, 24), D.mats.rim ?? D.mats.stone);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.12;
        ring.castShadow = ring.receiveShadow = true;
        g.add(ring);
        const coals = new THREE.Mesh(new THREE.CircleGeometry(h.r * 0.85, 24), lavaMaterial('#ff4a10', '#1a0c08'));
        coals.rotation.x = -Math.PI / 2;
        coals.position.y = 0.06;
        g.add(coals);
        g.add(this.flame(new THREE.Vector3(0, 0.05, 0), h.r * 1.5, this.layout.theme === 'glacier' || this.layout.theme === 'skytemple' ? this.theme.fire : '#ff8a30', true));
        break;
      }
      case 'water': {
        const geo = blobDisc(h.r, h.id + 9, 48);
        const w = new THREE.Mesh(geo, waterMaterial(this.dressing.waterColor ?? '#1d4a5a', { opacity: 0.88, env: 1.3 }));
        w.position.y = 0.025;
        w.receiveShadow = true;
        g.add(w);
        const rim = new THREE.Mesh(blobRing(h.r - 0.05, h.r + 0.35, h.id + 9), D.mats.rim ?? D.mats.stone);
        rim.receiveShadow = true;
        g.add(rim);
        D.decorateWater?.(g, h);
        break;
      }
      case 'spikes': {
        const { plate, spikes } = spikeGeo(h.r);
        const pm = new THREE.Mesh(plate, D.mats.metal);
        pm.receiveShadow = true;
        g.add(pm);
        const sp = new THREE.Mesh(spikes, D.mats.spike ?? D.mats.metal);
        sp.castShadow = true;
        sp.position.y = -0.7;
        g.add(sp);
        const warn = new THREE.Mesh(new THREE.RingGeometry(h.r * 0.95, h.r * 1.08, 32), glowMat('#ff5a2a', 0));
        warn.rotation.x = -Math.PI / 2;
        warn.position.y = 0.09;
        g.add(warn);
        update = (s, _t, dt) => {
          const target = s === 2 ? 0 : s === 1 ? -0.55 : -0.72;
          sp.position.y += (target - sp.position.y) * Math.min(1, dt * (s === 2 ? 40 : 8));
          (warn.material as THREE.MeshBasicMaterial).opacity = s === 1 ? 0.6 + Math.sin(this.time * 30) * 0.3 : 0;
        };
        break;
      }
      case 'geyser': {
        const vent = new THREE.Mesh(rockGeo(h.r * 0.9, h.id + 40, { squash: 0.25, rough: 0.5 }), D.mats.rim ?? D.mats.stone);
        vent.castShadow = vent.receiveShadow = true;
        g.add(vent);
        const hole = new THREE.Mesh(new THREE.CircleGeometry(h.r * 0.22, 16), new THREE.MeshBasicMaterial({ color: '#0c1820' }));
        hole.rotation.x = -Math.PI / 2;
        hole.position.y = h.r * 0.24;
        g.add(hole);
        const colCol = this.dressing.geyserColor ?? '#d8f0ff';
        const column = new THREE.Mesh(new THREE.CylinderGeometry(h.r * 0.35, h.r * 0.55, 1, 16, 1, true), glowMat(colCol, 0, plumeSprite()));
        column.position.y = 0.5;
        g.add(column);
        update = (s, t) => {
          const m = column.material as THREE.MeshBasicMaterial;
          if (s === 2) {
            column.scale.set(1 + Math.sin(t * 20) * 0.08, 7, 1 + Math.cos(t * 17) * 0.08);
            column.position.y = 3.5;
            m.opacity = 0.75;
          } else if (s === 1) {
            column.scale.set(0.7, 0.8 + Math.sin(t * 9) * 0.2, 0.7);
            column.position.y = 0.4;
            m.opacity = 0.3;
          } else m.opacity = 0;
          if (m.map) m.map.offset.y = -t * 1.5;
        };
        break;
      }
      case 'chandelier': {
        const ch = D.chandelier(h);
        g.add(ch);
        const chain = new THREE.Mesh(chainGeo(14), D.mats.metal);
        chain.position.y = 6.2 + 14;
        chain.castShadow = false;
        g.add(chain);
        const shadow = new THREE.Mesh(new THREE.CircleGeometry(h.r, 32), new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0, depthWrite: false }));
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = 0.03;
        g.add(shadow);
        let t0 = -1;
        update = (s, t, dt) => {
          if (s === 0) {
            ch.position.y = 6.2;
            ch.rotation.z = Math.sin(t * 0.7 + h.id) * 0.02;
            chain.visible = true;
            ch.visible = true;
            (shadow.material as THREE.MeshBasicMaterial).opacity = 0;
          } else if (s === 1) {
            ch.rotation.z = Math.sin(t * 9) * 0.08;
            ch.rotation.x = Math.cos(t * 7) * 0.06;
            (shadow.material as THREE.MeshBasicMaterial).opacity = 0.25 + Math.sin(t * 12) * 0.1;
          } else if (s === 2) {
            if (t0 < 0) t0 = t;
            const k = Math.min(1, (t - t0) / 0.55);
            ch.position.y = 6.2 * (1 - k * k);
            chain.visible = false;
            (shadow.material as THREE.MeshBasicMaterial).opacity = 0.35 + k * 0.3;
          } else {
            ch.visible = false;
            chain.visible = false;
            (shadow.material as THREE.MeshBasicMaterial).opacity = 0;
            t0 = -1;
          }
          void dt;
        };
        break;
      }
    }
    this.hazards.push({ def: h, group: g, update });
  }

  // ------------------------------------------------------------------ runtime
  /** shared shadow/occlusion data for the camera: standing obstacles */
  standing(): { x: number; z: number; r: number; h: number }[] {
    // visual radius for the camera: plinths, statues, crystal clusters and lantern roofs stick out past the sim radius
    const k = (kind: string) => (kind === 'statue' || kind === 'crystal' || kind === 'obelisk' ? 1.55 : kind === 'lantern_post' ? 1.4 : 1.2);
    return this.obstacles.filter((o) => !o.fallen).map((o) => ({ x: o.def.x, z: o.def.z, r: o.def.r * k(o.def.kind), h: o.def.h }));
  }
  /** chandeliers still hanging (for camera avoidance) */
  hangingNow(): { x: number; y: number; z: number; r: number }[] {
    const out: { x: number; y: number; z: number; r: number }[] = [];
    for (const h of this.hazards) if (h.def.kind === 'chandelier' && h.group.children[0]?.visible !== false) out.push({ x: h.def.x, y: 6.2, z: h.def.z, r: 1.3 });
    return out;
  }
  boundR(x: number, z: number) {
    return boundR(this.layout, x, z);
  }

  /** sync dynamic state to a playback frame (simDt for physics-like visuals) */
  applyFrame(fr: Frame, simDt: number, hands: (i: number) => THREE.Vector3 | null, facing: (i: number) => number) {
    const t = fr.t;
    // obstacles
    for (let i = 0; i < this.obstacles.length; i++) {
      const ov = this.obstacles[i];
      const v = fr.obs[i] ?? 1;
      if (v >= 0) {
        if (ov.fallen) this.unfall(ov);
        ov.crack.value = Math.max(0, Math.min(1, (1 - v) * 1.25));
        ov.lastHp = v;
        continue;
      }
      const fallT = -v - 1;
      const k = Math.max(0, Math.min(1, (t - fallT) / 0.9));
      if (!ov.fallen) this.startFall(ov, fallT);
      if (k < 1) {
        ov.mesh.visible = true;
        const ang = (Math.PI / 2 - 0.06) * k * k;
        ov.pivot.setRotationFromAxisAngle(ov.axis!, ang);
      } else if (!ov.landed) {
        ov.landed = true;
        ov.mesh.visible = false;
      }
    }
    // props
    const P = fr.props;
    const n = Math.floor(P.length / 6);
    while (this.props.length < n) this.addProp('chunk');
    for (let i = 0; i < n; i++) {
      const pv = this.props[i];
      const state = P[i * 6 + 3];
      const lit = state >= 10;
      const st = lit ? state - 10 : state;
      if (st === 3) {
        pv.obj.visible = false;
        pv.gone = true;
        continue;
      }
      pv.obj.visible = true;
      pv.gone = false;
      if (st === 1) {
        // carried: in the carrier's hands (closest fighter to the recorded position)
        const x = P[i * 6],
          z = P[i * 6 + 2];
        const c0 = fr.f[0],
          c1 = fr.f[1];
        const who = Math.hypot(c0.x - x, c0.z - z) <= Math.hypot(c1.x - x, c1.z - z) ? 0 : 1;
        const hp = hands(who);
        if (hp) {
          pv.obj.position.copy(hp);
          pv.obj.position.y -= pv.kind === 'urn' ? 0.36 : pv.kind === 'crate' ? 0.41 : 0.45;
          pv.obj.rotation.set(0, facing(who), 0);
        }
      } else {
        pv.obj.position.set(P[i * 6], P[i * 6 + 1], P[i * 6 + 2]);
        const rot = P[i * 6 + 5];
        if (st === 2) pv.obj.rotation.set(rot * 0.7, rot, rot * 0.4);
        else pv.obj.rotation.set(0, rot, 0);
      }
      if (pv.glow) {
        const m = pv.glow.material as THREE.MeshBasicMaterial;
        m.opacity = lit ? 0.6 + Math.sin(this.time * 40) * 0.4 : 0;
        pv.glow.quaternion.copy(this.camQuat);
      }
    }
    // hazards
    for (let i = 0; i < this.hazards.length; i++) this.hazards[i].update(fr.haz[i] ?? 0, t, simDt);
    this.lastFrameT = t;
  }
  camQuat = new THREE.Quaternion();

  private startFall(ov: ObsView, _fallT: number) {
    ov.fallen = true;
    ov.landed = false;
    const ev = this.toppleDir.get(this.obstacles.indexOf(ov)) ?? { dx: 1, dz: 0 };
    const o = ov.def;
    // pivot at the base edge on the fall side
    ov.pivot.position.set(o.x + ev.dx * o.r * 0.8, 0, o.z + ev.dz * o.r * 0.8);
    ov.mesh.position.set(-ev.dx * o.r * 0.8, 0, -ev.dz * o.r * 0.8);
    ov.axis = new THREE.Vector3(ev.dz, 0, -ev.dx).normalize();
  }
  private unfall(ov: ObsView) {
    ov.fallen = false;
    ov.landed = false;
    ov.mesh.visible = true;
    ov.pivot.position.set(ov.def.x, 0, ov.def.z);
    ov.pivot.rotation.set(0, 0, 0);
    ov.mesh.position.set(0, 0, 0);
  }
  /** topple directions come from the event stream (set by the app for seeks too) */
  toppleDir = new Map<number, { dx: number; dz: number }>();

  /** destruction visuals for sim events; returns camera shake amount */
  onEvent(e: SimEvent, pos: (i: number) => THREE.Vector3): number {
    const d = e.data ?? {};
    const L = this.layout;
    const D = this.dressing;
    switch (e.type) {
      case 'topple': {
        const i = Number(d.obs);
        this.toppleDir.set(i, { dx: Number(d.dx), dz: Number(d.dz) });
        const o = L.obstacles[i];
        this.debris.burst(D.debrisOf(o.kind), new THREE.Vector3(o.x, 0.5, o.z), 10, 0.18, 2.5);
        return 0.25;
      }
      case 'topple_impact': {
        const i = Number(d.obs);
        const o = L.obstacles[i];
        const dir = this.toppleDir.get(i) ?? { dx: 1, dz: 0 };
        const mat = D.debrisOf(o.kind);
        for (let k = 0.15; k <= 1.0; k += 0.17) {
          const p = new THREE.Vector3(o.x + dir.dx * o.h * k, 0.4, o.z + dir.dz * o.h * k);
          this.debris.burst(mat, p, 5, o.r * 0.5, 3.2, new THREE.Vector3(dir.dx, 0.3, dir.dz));
        }
        this.decals.crack(o.x + dir.dx * o.h * 0.6, o.z + dir.dz * o.h * 0.6, 2.2, 9, 0.6);
        return 0.9;
      }
      case 'cover_hit': {
        const o = L.obstacles[Number(d.obs)];
        if (!o) break;
        this.debris.burst(D.debrisOf(o.kind), new THREE.Vector3(o.x, 1.2 + Math.random() * 1.5, o.z), 4, 0.1, 2.2);
        break;
      }
      case 'prop_break': {
        const pv = this.props[Number(d.prop)];
        const at = new THREE.Vector3(Number(d.x ?? pv?.obj.position.x ?? 0), Number(d.y ?? 0) + 0.4, Number(d.z ?? pv?.obj.position.z ?? 0));
        const kind = String(d.kind);
        const mat: DebrisMat = kind === 'urn' ? D.urnDebris : kind === 'lantern' ? 'paper' : kind === 'brazier' ? 'metal' : 'wood';
        this.debris.burst(mat, at, kind === 'urn' ? 14 : 11, kind === 'urn' ? 0.09 : 0.16, 3.2);
        if (kind === 'brazier' || kind === 'lantern') this.decals.scorch(at.x, at.z, 0.9);
        return 0.12;
      }
      case 'explosion': {
        const at = new THREE.Vector3(Number(d.x), Number(d.y), Number(d.z));
        this.debris.burst('wood', at, 16, 0.15, 7);
        this.debris.burst('metal', at, 6, 0.08, 9);
        this.decals.scorch(at.x, at.z, 2.4);
        return 1.0;
      }
      case 'chandelier_impact': {
        const at = new THREE.Vector3(Number(d.x), 0.3, Number(d.z));
        this.debris.burst(D.chandelierDebris, at, 18, 0.14, 4.5);
        this.decals.crack(at.x, at.z, 1.8, 8);
        return 0.7;
      }
      case 'hazard_hit': {
        const h = L.hazards[Number(d.haz)];
        if (h?.kind === 'lava' || h?.kind === 'firepit') this.decals.scorch(pos(e.b ?? 0).x, pos(e.b ?? 0).z, 0.6);
        break;
      }
      case 'wall_slam':
      case 'pillar_slam': {
        const p = pos(e.a);
        this.decals.crack(p.x, p.z, 1.0, 5, 0.45);
        break;
      }
      case 'knockdown': {
        const p = pos(e.a);
        this.decals.crack(p.x, p.z, 0.8, 4, 0.3);
        break;
      }
    }
    return 0;
  }

  /** reset all dynamic visuals (new match on the same arena) */
  resetProps() {
    for (let i = 0; i < this.obstacles.length; i++) this.unfall(this.obstacles[i]);
    this.toppleDir.clear();
    for (const p of this.props) {
      p.obj.visible = true;
      p.gone = false;
    }
    this.debris.clear();
    this.decals.clear();
    for (const g of this.gates) {
      g.portcullis.visible = true;
      g.portcullis.position.set(0, 0, 0.2);
      g.portcullis.rotation.set(0, 0, 0);
      for (const pc of g.anchors.pieces) {
        pc.obj.position.copy(pc.pos);
        pc.obj.rotation.copy(pc.rot);
        pc.obj.visible = pc.vis;
        pc.obj.scale.setScalar(1);
        const mt = (pc.obj as THREE.Mesh).material as THREE.Material & { opacity?: number; userData: { op?: number } };
        if (mt && mt.userData && mt.userData.op !== undefined) mt.opacity = mt.userData.op;
      }
      g.smashed = false;
      g.light.intensity = 0;
    }
    this.lastFrameT = -1;
  }

  /** anti-stall ring scale (1 = off) */
  setRing(s: number) {
    const active = s < 0.995;
    this.fireRing.visible = active;
    if (active) {
      this.fireRing.scale.set(this.layout.rx * s + 0.4, 1 + Math.sin(this.time * 7) * 0.08, this.layout.rz * s + 0.4);
      this.fireRingMat.opacity = 0.85 + Math.sin(this.time * 9) * 0.1;
      if (this.fireRingMat.map) this.fireRingMat.map.offset.x = this.time * 0.05;
    }
  }

  applyMood(m: Mood) {
    this.moon.intensity = this.base.sun * Math.min(1.3, Math.max(0.35, m.moon / 1.1));
    this.hemi.intensity = this.base.hemi * Math.min(1.3, Math.max(0.5, m.hemi / 0.55));
    this.fog.density = this.base.fog * Math.min(2, Math.max(0.6, m.fog / 0.022));
    this.centerSpot.intensity = this.base.spot + m.spot * 20;
  }
  restoreLighting() {
    this.moon.intensity = this.base.sun;
    this.hemi.intensity = this.base.hemi;
    this.fog.density = this.base.fog;
    this.centerSpot.intensity = this.base.spot;
    for (const g of this.gates) g.light.intensity = 3;
  }

  onUpdate(fn: (t: number, dt: number) => void) {
    this.updaters.push(fn);
  }

  update(dt: number, cam?: THREE.Camera, viewportH?: number) {
    this.time += dt;
    shaderTime.value = this.time;
    const t = this.time;
    if (cam && this.fireRing.visible) {
      // a camera outside the closing ring of fire looks through its wall: thin it right down (render only)
      const sx = this.fireRing.scale.x,
        sz = this.fireRing.scale.z;
      const e = (cam.position.x / sx) ** 2 + (cam.position.z / sz) ** 2;
      const through = e > 0.92 && cam.position.y < 2.4 ? 1 : 0;
      this.ringThrough += (through - this.ringThrough) * Math.min(1, dt * 10);
      this.fireRingMat.opacity *= 1 - 0.8 * this.ringThrough;
    }
    if (cam) {
      this.sky.position.copy(cam.position);
      this.camQuat.copy(cam.quaternion);
      for (const f of this.flames) f.obj.quaternion.copy(cam.quaternion);
      if (viewportH) this.ambient.setViewport(viewportH, (cam as THREE.PerspectiveCamera).fov ?? 50);
    }
    for (const f of this.flames) {
      const k = 0.88 + Math.sin(t * 13 + f.ph) * 0.07 + Math.sin(t * 29 + f.ph * 2) * 0.05;
      f.obj.scale.set(1, k, 1);
      if (f.light && f.li) f.light.intensity = f.li * k;
    }
    for (const u of this.updaters) u(t, dt);
  }

  updateDebris(simDt: number) {
    this.debris.update(simDt);
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      // kit asset clones share geometry / materials with the ArenaAssets cache: it disposes them (release)
      if (o.userData.kit) return;
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) x.dispose();
    });
    this.env.dispose();
    if (this.scene.environment === this.env) this.scene.environment = null;
  }
}

// ------------------------------------------------------------------ small helpers
/**
 * Merge static dressing meshes that are direct children of the arena group
 * (same material + shadow flags) into single meshes: hundreds of wall
 * segments / posts / arches become a handful of draw calls.
 * Objects flagged userData.dyn, InstancedMeshes and nested groups are left alone.
 */
function mergeStatic(group: THREE.Group): number {
  const buckets = new Map<string, THREE.Mesh[]>();
  for (const o of group.children) {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh || o.userData.dyn || Array.isArray(m.material)) continue;
    const key = `${(m.material as THREE.Material).uuid}|${m.castShadow}|${m.receiveShadow}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = []));
    b.push(m);
  }
  let saved = 0;
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const geos: THREE.BufferGeometry[] = [];
    for (const m of list) {
      m.updateMatrix();
      const g = m.geometry.clone().applyMatrix4(m.matrix);
      geos.push(g);
    }
    const merged = mergeAll(geos);
    const mesh = new THREE.Mesh(merged, list[0].material);
    mesh.castShadow = list[0].castShadow;
    mesh.receiveShadow = list[0].receiveShadow;
    for (const m of list) {
      group.remove(m);
      m.geometry.dispose();
    }
    group.add(mesh);
    saved += list.length - 1;
  }
  return saved;
}

/** irregular disc (pool / lava) */
export function blobDisc(r: number, seed: number, seg = 48): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const rr = new R(seed);
  const ph = [rr.next() * 6, rr.next() * 6, rr.next() * 6];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const k = 1 + 0.08 * Math.sin(a * 3 + ph[0]) + 0.05 * Math.sin(a * 5 + ph[1]) + 0.03 * Math.sin(a * 9 + ph[2]);
    const x = Math.cos(a) * r * k,
      y = Math.sin(a) * r * k;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  const g = new THREE.ShapeGeometry(s, 1);
  g.rotateX(-Math.PI / 2);
  // world-ish uv
  const p = g.attributes.position;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = p.getX(i) * 0.5;
    uv[i * 2 + 1] = p.getZ(i) * 0.5;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}
/** rough stone rim around a blob */
export function blobRing(r0: number, r1: number, seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const rr = new R(seed + 100);
  const n = Math.max(8, Math.round(r1 * 7));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rr.range(-0.1, 0.1);
    const rad = (r0 + r1) / 2 + rr.range(-0.05, 0.05);
    const g = rockGeo(((r1 - r0) / 2) * rr.range(0.9, 1.4), seed * 7 + i, { squash: 0.45, detail: 1, rough: 0.5 });
    g.translate(Math.cos(a) * rad, -0.03, Math.sin(a) * rad);
    parts.push(g);
  }
  const out = parts.length ? (mergeAll(parts) as THREE.BufferGeometry) : new THREE.BufferGeometry();
  return out;
}

let _flame: THREE.Texture | null = null;
function flameSprite(): THREE.Texture {
  if (_flame) return _flame;
  _flame = canvasTexture(128, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s * 0.72, 2, s / 2, s * 0.6, s * 0.5);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.3, 'rgba(255,255,255,0.75)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(s / 2, 0);
    g.bezierCurveTo(s * 0.85, s * 0.45, s * 0.85, s * 0.95, s / 2, s);
    g.bezierCurveTo(s * 0.15, s * 0.95, s * 0.15, s * 0.45, s / 2, 0);
    g.fill();
  });
  return _flame;
}
let _plume: THREE.Texture | null = null;
function plumeSprite(): THREE.Texture {
  if (_plume) return _plume;
  _plume = canvasTexture(128, (g, s) => {
    g.fillStyle = 'rgba(0,0,0,0)';
    g.fillRect(0, 0, s, s);
    const rr = new R(4);
    for (let i = 0; i < 160; i++) {
      const x = rr.next() * s,
        y = rr.next() * s,
        r = rr.range(4, 16);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(255,255,255,0.5)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
  _plume.wrapS = _plume.wrapT = THREE.RepeatWrapping;
  return _plume;
}
