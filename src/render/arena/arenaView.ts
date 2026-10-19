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
import type { ArenaLayout, HazardDef, Obstacle, ObstacleKind } from '../../sim/arenaGen';
import { boundR, chainSwing, CHAIN_LEN, CHAIN_PIVOT_H } from '../../sim/arenaGen';
import type { Frame, SimEvent } from '../../sim/types';
import { THEME_DEFS, type ThemeDef } from './themes';
import { bakeEnvironment, bakeStormTexture, lightningAt, makeSky, type SkyLook } from './sky';
import { Backdrop } from './backdrop';
import { ArenaFog, installHeightFog } from './fog';
import { Ambient } from './ambient';
import { Debris, Decals, FracSet, type DebrisMat } from './debris';
import { glowMat, lavaMaterial, shaderTime, waterMaterial } from './materials';
import { merge as mergeAll, braziersGeo, chainGeo, crateGeo, drumGeo, paperLanternGeo, spikeGeo, urnGeo, barrelGeo, rockGeo } from './kit';
import { buildDressing, type Dressing } from './dressing';
import type { ArenaPack } from './assets';
import { canvasTexture, softDot } from './textures';
import { R } from './noise';
import { alongEllipse } from './common';
import { withLook } from './art';
import { StageLight } from './stageLight';
import type { WetFloor } from './floor';
import { FloorLightMap } from './lightmap';
import { LAYER_REFLECT, PlanarReflection, StreakCards, type FloorLightSource } from './reflection';
import { LAYER } from '../fx/fxLayers';
import { THEME_FLOOR, type FloorSurface } from '../fx/fxSurfaces';
import { swayOn, swayTime } from './cloth';
import type { KitInstance } from './assets';
import { gateZoneTest } from './nearField';

/**
 * A7: the hang height of every chandelier hazard (the cage's top ring), shared by the hazard builder, the camera's
 * avoidance list (hangingNow, main.ts camWorld) and the kit chandelier assets (authored to hang from this height)
 */
export const CHANDELIER_H = 6.2;

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
  /** A5: the FRAC_* pieces of a broken / landed kit obstacle (built on first need, seek-safe) */
  frac?: FracSet | null;
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
  private flames: { obj: THREE.Object3D; ph: number; base: number; light?: THREE.PointLight; li?: number; size: number; k: number }[] = [];
  /** A2b: pre-built burning-oil patches (tipped braziers), driven by Frame.fires */
  private oilFires: { g: THREE.Group; disc: THREE.Mesh }[] = [];
  private updaters: ((t: number, dt: number) => void)[] = [];
  private lastFrameT = -1;

  /** A1: loaded kit art (assets.ts) or null = the legacy procedural dressing (always with ?arena=legacy) */
  readonly kit: ArenaPack | null;
  /**
   * A7: plain merged proxy meshes that are never drawn (material.visible = false) but that ray casts hit: the camera's
   * solids() / rayProxies, the entrance validator and snapAnchors. Kit art that is drawn as an InstancedMesh or flagged
   * userData.dyn (the wet floor, banners) puts its COL / support proxy here (plan 4.3).
   */
  losGroup!: THREE.Group;
  /** A7: the invisible material of the losGroup proxies (owned by the arena) */
  losMat!: THREE.MeshBasicMaterial;
  /** A2: the kit wet floor + its planar reflection (medium / high), light map and low-tier streak cards */
  wetFloor: WetFloor | null = null;
  reflection: PlanarReflection | null = null;
  lightMap: FloorLightMap | null = null;
  streaks: StreakCards | null = null;
  /** A6: the baked landmark panorama (depth-displaced layers, AOV animation, fog match, hero inset, shaft / fog cards) */
  backdrop: Backdrop | null = null;
  private floorSrc: FloorLightSource[] = [];
  private streakSrc: FloorLightSource[] = [];

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, layout: ArenaLayout, quality = 2, kit: ArenaPack | null = null) {
    installHeightFog();
    this.scene = scene;
    this.layout = layout;
    this.quality = quality;
    this.kit = kit;
    // A2: kit art may override the theme's display data (the Moon Gate night preview on the colosseum)
    const T = (this.theme = withLook(THEME_DEFS[layout.theme], kit?.art.look));
    scene.add(this.group);
    // A7: hidden line-of-sight / support proxies (instanced or dyn art that the camera and the entrances must still see)
    // (kit mode only: every Object3D / material takes a uuid from Math.random and ?arena=legacy must keep its random
    // sequence for the pixel-identical gate). Front side only, like the floor it stands in for.
    if (kit) {
      this.losGroup = new THREE.Group();
      this.losGroup.name = 'losGroup';
      this.losMat = new THREE.MeshBasicMaterial({ visible: false });
      this.group.add(this.losGroup);
    }

    // ---------------- sky, environment, fog
    // A7c: the authored sky (kit mode, ThemeArt.sky + its loaded texture): replaces the storm deck; lit in sky.ts by the
    // moon, drifting, with distant lightning (update()); the probe below bakes it (T.sky is withLook's own copy here)
    if (kit?.sky && kit.art.sky && kit.art.look) {
      const J = kit.sky.json;
      T.sky = { ...T.sky, storm: 0, skyTex: kit.sky.tex, skyLook: { ...J.look, ...(kit.art.sky.look ?? {}) }, skyRamp: J.palette };
      this.skyLook = T.sky.skyLook!;
      const md = T.sky.moonSize > 0 ? T.sky.moonDir : T.sky.sunDir;
      this.moonAz = Math.atan2(md.z, md.x);
      // `?skyflash=<t>` (debug): hold the lightning clock at t (e.g. 40.02, the first strike) for stills of a flash
      const sf = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('skyflash') : null;
      if (sf !== null && Number.isFinite(Number(sf))) this.skyFlashAt = Number(sf);
    }
    // A7b: the kit Moon Gate's storm deck is baked once (sky.ts bakeStormTexture) and sampled by the sky and the probe
    if (kit && T.sky.storm) T.sky.stormTex = bakeStormTexture(renderer, T.sky, quality >= 1 ? 2048 : 1024, quality >= 2 ? 512 : 256);
    this.sky = makeSky(T.sky);
    this.sky.userData.dyn = true;
    this.group.add(this.sky);
    this.dressing = buildDressing(this);
    this.drawCallsMerged = mergeStatic(this.group);
    // A6: baked panorama layers (kit mode, when the theme art has one and it loaded); not merged (userData.dyn)
    if (kit?.backdrop && kit.art.backdrop) {
      // (A7c: the baked clouds fade out only when the authored sky that replaces them is drawn)
      const tune = kit.art.backdrop.tune;
      this.backdrop = new Backdrop(kit.backdrop, quality, this.skyLook || !tune ? tune : { ...tune, cloudHide: 0 });
      this.backdrop.setMoon(T.sky.moonSize > 0 ? T.sky.moonDir : T.sky.sunDir);
      this.group.add(this.backdrop.group);
    }
    this.fog = new ArenaFog(T.fog.color, T.fog.density, T.fog.height);
    // A7b: kit Moon Gate stage light; its IBL probe also sees the backdrop (sky, storm, arch, ruins light the stone and
    // the fighters), with the scene fog so the layers' fog match is right in the probe
    const stageArt = kit?.art.look?.stage;
    const envExtras = [...(this.dressing.envExtras ?? [])];
    if (stageArt?.envBackdrop && this.backdrop)
      this.backdrop.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.userData.backdrop) {
          const c = new THREE.Mesh(m.geometry, m.material);
          c.renderOrder = m.renderOrder;
          c.frustumCulled = false;
          envExtras.push(c);
        }
      });
    this.env = stageArt ? bakeEnvironment(renderer, T.sky, envExtras, { fog: this.fog, far: 1400 }) : bakeEnvironment(renderer, T.sky, this.dressing.envExtras);
    scene.environment = this.env;
    scene.environmentIntensity = this.envBase = stageArt?.envIntensity ?? 1;
    scene.background = null;
    scene.fog = this.fog;

    // ---------------- lights
    this.hemi = new THREE.HemisphereLight(T.hemi[0], T.hemi[1], T.hemi[2]);
    this.group.add(this.hemi);
    // A7: `?lit=1` (kit mode, debug only): flat bright fill so the dark near field can be judged by shape (A8 owns the light)
    if (kit && typeof location !== 'undefined' && new URLSearchParams(location.search).get('lit') === '1') {
      this.hemi.intensity *= 4;
      this.group.add(new THREE.AmbientLight('#ffffff', 1.6));
    }
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
    if (kit) this.kitDebris(kit);
    this.ambient = new Ambient(T.ambient, quality);
    this.group.add(this.ambient.group);

    // ---------------- obstacles, props, hazards
    for (const o of layout.obstacles) this.addObstacle(o);
    for (const p of layout.props) this.addProp(p.kind);
    for (const h of layout.hazards) this.addHazard(h);
    // A2b: burning-oil patches for tipped braziers (built now so the reflection tagging below sees them; hidden)
    const nBraziers = layout.props.filter((p) => p.kind === 'brazier').length;
    for (let k = 0; k < Math.min(4, nBraziers); k++) this.addOilFire();

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

    // ---------------- A2: decorative boundary braziers, wet floor (reflection, light map, streaks)
    if (kit?.art.ringFlames) this.addRingFlames(kit);
    this.wetFloor = this.dressing.wetFloor ?? null;
    if (this.wetFloor) {
      const F = this.wetFloor;
      this.reflection = new PlanarReflection();
      F.attachReflection(this.reflection.uniforms);
      this.lightMap = new FloorLightMap(F.halfW, F.halfD);
      F.attachLightMap(this.lightMap);
      // streak cards: the low tier's only fire reflections, and an accent over the planar reflection on medium /
      // high (plan 6.1 table: "low tier + accents everywhere"); the planar pass alone leaves fires dim after Fresnel
      {
        this.streaks = new StreakCards();
        const U = this.streaks.uniforms;
        U.uGain.value = quality <= 0 ? (F.streakGainLow ?? 1) : (F.streakGain ?? STREAK_ACCENT);
        U.uOrm.value = F.uniforms.uFOrm.value as THREE.Texture;
        U.uTile.value = F.tileM;
        U.uWater.value = Math.min(0.9, (F.uniforms.uFPuddle.value as number) * 1.6);
        this.group.add(this.streaks.mesh);
      }
      this.tagReflect();
      F.readWater(renderer);
    }
    // A7b: moon rim + fire pools on every standard material of the arena (not the wet floor), ground mist cards
    if (stageArt) {
      this.stage = new StageLight(stageArt, quality, T.sky.moonSize > 0 ? T.sky.moonDir : T.sky.sunDir);
      const skip = new Set<THREE.Object3D>();
      if (this.wetFloor) skip.add(this.wetFloor.mesh);
      this.stage.patch(this.group, skip);
      this.stage.buildMist(this.group, layout.rx, layout.rz, shaderTime);
    }
  }
  /** A7b: the kit Moon Gate stage light (moon rim, fire pools, sky fog, mist), null elsewhere */
  stage: StageLight | null = null;
  /** A7c: the authored sky's lighting (null: no authored sky) + the lightning state (cosmetic, from match time) */
  skyLook: SkyLook | null = null;
  private moonAz = 0;
  private envBase = 1;
  private matchT = -1;
  private matchSeen = -1e9;
  private flashDir = new THREE.Vector3(1, 0.2, 0);
  private skyFlashAt: number | null = null;
  /** A7c: current lightning level 0..1 (read-only, for checks) */
  flash = 0;

  /** A2: render-only braziers along the boundary (ThemeArt.ringFlames), skipping the gates */
  private addRingFlames(kit: ArenaPack) {
    const RF = kit.art.ringFlames!;
    // A4: variants alternate along the ring (the pedestal bowls of ref-3 between tripods); their flame size is the socket's
    const variants = (RF.assets ?? []).map((id) => kit.assets.get(id)).filter((x) => !!x);
    const asset = kit.assets.get(RF.asset);
    if (!asset && !variants.length) return;
    const L = this.layout;
    // A7: no ring brazier inside a kit gate structure (the hero stair, the gate portals) or on a pillar
    const blocked = gateZoneTest(this, kit);
    const circ = 2 * Math.PI * Math.sqrt((L.rx * L.rx + L.rz * L.rz) / 2);
    const spacing = circ / RF.count;
    alongEllipse(
      L,
      RF.offset,
      spacing,
      (p, yaw, _a, i) => {
        if (blocked(p)) return;
        const A = variants.length ? variants[i % variants.length]! : asset!;
        const inst = A.instantiate();
        const g = new THREE.Group();
        g.position.set(p.x, 0, p.z);
        g.rotation.y = yaw;
        g.add(inst.obj);
        const s = inst.sockets.find((x) => x.name === 'SOCK_flame');
        const size = variants.length && typeof s?.extras.size === 'number' ? s.extras.size * (RF.size / 0.9) : RF.size;
        g.add(this.flame(new THREE.Vector3(0, s ? s.pos[1] : 1.2, 0), size, this.theme.fire, false));
        g.userData.ringFlame = true;
        this.group.add(g);
      },
      2.7,
      0.5,
    );
  }

  /**
   * A2: what the planar reflection renders (reflection.ts LAYER_REFLECT): the sky, every tall mesh of the
   * dressing (walls, stands, gates, obstacles, props: world bounding box above 0.7 m), the ring of fire and the
   * arena's flame cards. Instanced meshes (crowds: many triangles, small in the reflection) stay out. Floor, decals, debris, streak cards and particles stay out.
   */
  private tagReflect() {
    const box = new THREE.Box3();
    const skip = new Set<THREE.Object3D>([this.decals.mesh, this.debris.group, this.ambient.group]);
    if (this.wetFloor) skip.add(this.wetFloor.mesh);
    if (this.streaks) skip.add(this.streaks.mesh);
    this.group.updateMatrixWorld(true);
    const visit = (o: THREE.Object3D) => {
      if (skip.has(o) || o.userData.floor || o.userData.noReflect) return;
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        if (o.layers.isEnabled(LAYER.FX_ALPHA) || o.layers.isEnabled(LAYER.FX_ADD)) o.layers.enable(LAYER_REFLECT);
        else if (!(m as unknown as THREE.InstancedMesh).isInstancedMesh) {
          if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
          box.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld);
          if (box.max.y > 0.7) o.layers.enable(LAYER_REFLECT);
        }
      }
      for (const c of o.children) visit(c);
    };
    visit(this.group);
    this.sky.layers.enable(LAYER_REFLECT);
    this.fireRing.layers.enable(LAYER_REFLECT);
  }

  // ------------------------------------------------------------------ builders
  /** material lookups provided by the theme dressing */
  private mat(name: string): THREE.Material {
    return this.dressing.mats[name] ?? this.dressing.mats.stone;
  }

  /** debris material of an obstacle kind (A2b features are wood / cloth) */
  private debrisOf(kind: ObstacleKind): DebrisMat {
    return kind === 'banner' || kind === 'barricade' ? 'wood' : this.dressing.debrisOf(kind);
  }

  /** A2b placeholder features until the art kit (A3-A5): a banner pole with a hanging cloth, a plank barricade */
  private featureMesh(o: Obstacle): THREE.Object3D {
    const D = this.dressing;
    const g = new THREE.Group();
    const wood = D.propMat('crate');
    const r = new R(o.id * 31 + 7);
    if (o.kind === 'banner') {
      const metal = D.mats.metal ?? wood;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.32, 0.3, 8), D.mats.rim ?? D.mats.stone);
      base.position.y = 0.15;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, o.h, 8), metal);
      pole.position.y = o.h / 2;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.07, 0.07), metal);
      bar.position.y = o.h - 0.25;
      const clothMat = new THREE.MeshStandardMaterial({ color: BANNER_COLOR[this.layout.theme] ?? '#7a1a1a', roughness: 0.85, side: THREE.DoubleSide });
      const cg = new THREE.PlaneGeometry(1.05, 2.5, 4, 8);
      cg.translate(0, -1.25, 0);
      // ragged bottom edge
      const pos = cg.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) if (pos.getY(i) < -2.45) pos.setY(i, pos.getY(i) + r.range(0, 0.45));
      cg.computeVertexNormals();
      const cloth = new THREE.Mesh(cg, clothMat);
      cloth.position.set(0, o.h - 0.28, 0.06);
      const ph = r.range(0, 6);
      this.onUpdate((t) => {
        cloth.rotation.x = Math.sin(t * 1.3 + ph) * 0.06 + 0.04;
        cloth.rotation.y = Math.sin(t * 0.7 + ph) * 0.08;
      });
      for (const m of [base, pole, bar, cloth]) {
        m.castShadow = m.receiveShadow = true;
        g.add(m);
      }
      // cloth faces the arena centre
      g.rotation.y = Math.atan2(-o.x, -o.z);
    } else {
      // barricade / gate: posts, planks, cross braces, facing the centre
      const W = 1.3; // planks span about +-0.78 m, close to the sim radius 0.7
      for (const x of [-W / 2, 0, W / 2]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, o.h + 0.15, 0.16), wood);
        post.position.set(x, (o.h + 0.15) / 2, 0);
        g.add(post);
      }
      for (let k = 0; k < 4; k++) {
        const plank = new THREE.Mesh(new THREE.BoxGeometry(W + 0.25, 0.22, 0.07), wood);
        plank.position.set(r.range(-0.05, 0.05), 0.25 + k * 0.33, 0.1);
        plank.rotation.z = r.range(-0.05, 0.05);
        g.add(plank);
      }
      for (const s of [-1, 1]) {
        const brace = new THREE.Mesh(new THREE.BoxGeometry(Math.hypot(W, o.h) * 0.95, 0.14, 0.06), wood);
        brace.position.set(0, o.h / 2, -0.1);
        brace.rotation.z = s * Math.atan2(o.h, W);
        g.add(brace);
      }
      g.traverse((m) => {
        if ((m as THREE.Mesh).isMesh) m.castShadow = m.receiveShadow = true;
      });
      g.rotation.y = Math.atan2(-o.x, -o.z);
    }
    return g;
  }

  private addObstacle(o: Obstacle) {
    const D = this.dressing;
    const crack = { value: 0 };
    // A4: kit feature (banner pole + kit banner, barricade) when the theme's art has one loaded, else the A2b placeholder
    const mesh = o.kind === 'banner' || o.kind === 'barricade' ? (D.feature?.(o) ?? this.featureMesh(o)) : D.obstacle(o, crack);
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
      // glowing rune band + fuse spark (A4: the kit keg has a red-painted band and a fuse: only the spark, at its SOCK_glow)
      const sg = inst?.sockets.find((x) => x.name === 'SOCK_glow');
      if (!sg) {
        const band = new THREE.Mesh(new THREE.TorusGeometry(0.39, 0.035, 6, 24), glowMat('#ff6a20', 0.9));
        band.rotation.x = Math.PI / 2;
        band.position.y = 0.5;
        g.add(band);
      }
      const spark = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), glowMat('#ffd080', 0, softDot()));
      spark.position.set(sg ? sg.pos[0] : 0, sg ? sg.pos[1] + 0.05 : 1.08, sg ? sg.pos[2] : 0);
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
    if (kind === 'lantern' && inst) {
      // A4: the kit stone toro: its fire box glows (emissive); a small flame at SOCK_glow (no light: budget)
      const sg = inst.sockets.find((x) => x.name === 'SOCK_glow');
      if (sg) g.add(this.flame(new THREE.Vector3(sg.pos[0], sg.pos[1] - 0.08, sg.pos[2]), 0.32, '#ffb060', false));
    } else if (kind === 'lantern') {
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
    // A7: kit mode takes a deterministic flicker phase (render seed); legacy keeps Math.random (pixel-identical gate)
    const entry: (typeof this.flames)[number] = { obj: g, ph: this.kit ? ((this.flames.length * 7.31 + at.x * 1.7 + at.z * 2.3) % 10 + 10) % 10 : Math.random() * 10, base: 1, size, k: 1 };
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
        // (river cells keep the legacy grate: square cells)
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
        // A4: the kit spike grate (frame + bars; the SPIKES node rises through the bars)
        const ki = D.hazardKit?.(h);
        const kSp = ki ? kitNode(ki, 'SPIKES') : null;
        if (ki && kSp) {
          g.add(ki.obj);
          const drop = Number(ki.asset.extras.spikeDrop) || 0.72;
          kSp.position.y = -drop;
          const warnK = new THREE.Mesh(new THREE.RingGeometry(h.r * 0.95, h.r * 1.08, 32), glowMat('#ff5a2a', 0));
          warnK.rotation.x = -Math.PI / 2;
          warnK.position.y = 0.09;
          g.add(warnK);
          update = (s, _t, dt) => {
            const target = s === 2 ? 0 : s === 1 ? -drop * 0.76 : -drop;
            kSp.position.y += (target - kSp.position.y) * Math.min(1, dt * (s === 2 ? 40 : 8));
            (warnK.material as THREE.MeshBasicMaterial).opacity = s === 1 ? 0.6 + Math.sin(this.time * 30) * 0.3 : 0;
          };
          break;
        }
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
        ch.position.y = CHANDELIER_H; // hanging from the start (before the first frame: the entrance validator / reveal saw it on the floor)
        g.add(ch);
        const chain = new THREE.Mesh(chainGeo(14), D.mats.metal);
        chain.position.y = CHANDELIER_H + 14;
        chain.castShadow = false;
        g.add(chain);
        const shadow = new THREE.Mesh(new THREE.CircleGeometry(h.r, 32), new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0, depthWrite: false }));
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = 0.03;
        g.add(shadow);
        let t0 = -1;
        update = (s, t, dt) => {
          if (s === 0) {
            ch.position.y = CHANDELIER_H;
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
            ch.position.y = CHANDELIER_H * (1 - k * k);
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
      case 'chains': {
        // A2b: an iron weight on a chain hanging from the dark above; swings along the sim's axis (chainSwing)
        // A4: the kit spiked weight on instanced kit links (the pendulum chain swings with its pivot group)
        const ki = D.hazardKit?.(h);
        const ck = ki ? D.chainKit?.() : null;
        if (ki && ck?.ok) {
          const sock = ki.sockets.find((x) => x.name === 'SOCK_chain');
          const top = sock ? sock.pos[1] : 0.42;
          ck.straight(0, CHAIN_PIVOT_H + 14, CHAIN_PIVOT_H, 0, 'big', 1.25);
          for (const im of ck.build('hazChainUp')) g.add(im);
          const pivotK = new THREE.Group();
          pivotK.position.y = CHAIN_PIVOT_H;
          g.add(pivotK);
          ck.straight(0, 0, -CHAIN_LEN + top, 0, 'big', 1.25);
          for (const im of ck.build('hazChain')) pivotK.add(im);
          ki.obj.position.y = -CHAIN_LEN;
          pivotK.add(ki.obj);
          const axisK = new THREE.Vector3(-Math.cos(h.phase), 0, Math.sin(h.phase));
          update = (s, t) => {
            const neg = s > 127;
            const tau = s === 0 ? -1 : ((neg ? s - 127 : s) - 0.5) / 40;
            const th = tau < 0 ? Math.sin(t * 0.9 + h.id) * 0.015 : chainSwing(tau).theta * (neg ? -1 : 1);
            pivotK.setRotationFromAxisAngle(axisK, th);
          };
          break;
        }
        const metal = D.mats.metal ?? D.mats.stone;
        const up = new THREE.Mesh(chainGeo(14), metal);
        up.position.y = CHAIN_PIVOT_H + 14;
        g.add(up);
        const pivot = new THREE.Group();
        pivot.position.y = CHAIN_PIVOT_H;
        g.add(pivot);
        const chain = new THREE.Mesh(chainGeo(CHAIN_LEN - 0.3), metal);
        chain.castShadow = true;
        pivot.add(chain);
        const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.36, 1), metal);
        ball.position.y = -CHAIN_LEN;
        ball.castShadow = true;
        pivot.add(ball);
        const { spikes } = spikeGeo(0.3);
        const sp = new THREE.Mesh(spikes, D.mats.spike ?? metal);
        sp.position.y = -CHAIN_LEN - 0.2;
        sp.scale.setScalar(0.6);
        pivot.add(sp);
        // swing axis: weight offset along (sin phase, cos phase) -> rotate about (-cos, 0, sin)
        const axis = new THREE.Vector3(-Math.cos(h.phase), 0, Math.sin(h.phase));
        update = (s, t) => {
          const neg = s > 127;
          const tau = s === 0 ? -1 : ((neg ? s - 127 : s) - 0.5) / 40; // mid-bin: within 12.5 ms of the sim
          const th = tau < 0 ? Math.sin(t * 0.9 + h.id) * 0.015 : chainSwing(tau).theta * (neg ? -1 : 1);
          pivot.setRotationFromAxisAngle(axis, th);
        };
        break;
      }
      case 'flamejet': {
        // A2b: a floor vent (grate) that glows, then shoots a column of fire (geyser timing)
        // A4: the kit vent (scorched stone ring + iron grate); the glow disc sits under its bars
        const ki = D.hazardKit?.(h);
        if (ki) g.add(ki.obj);
        else {
          const grate = new THREE.Mesh(new THREE.CylinderGeometry(h.r * 0.9, h.r, 0.08, 20), D.mats.metal ?? D.mats.stone);
          grate.position.y = 0.04;
          grate.receiveShadow = true;
          g.add(grate);
        }
        const glow = new THREE.Mesh(new THREE.CircleGeometry(h.r * 0.75, 20), glowMat('#ff6a20', 0));
        glow.rotation.x = -Math.PI / 2;
        glow.position.y = ki ? 0.035 : 0.09;
        g.add(glow);
        const column = new THREE.Mesh(new THREE.CylinderGeometry(h.r * 0.3, h.r * 0.65, 1, 16, 1, true), glowMat('#ff8a30', 0, plumeSprite()));
        column.position.y = 0.5;
        g.add(column);
        const holder = new THREE.Group();
        holder.add(this.flame(new THREE.Vector3(0, 0.05, 0), h.r * 1.8, '#ff8a30', true));
        holder.visible = false;
        g.add(holder);
        update = (s, t) => {
          const m = column.material as THREE.MeshBasicMaterial;
          (glow.material as THREE.MeshBasicMaterial).opacity = s === 1 ? 0.45 + Math.sin(t * 24) * 0.25 : s === 2 ? 0.9 : 0;
          holder.visible = s === 2;
          if (s === 2) {
            column.scale.set(1 + Math.sin(t * 23) * 0.1, 4.2, 1 + Math.cos(t * 19) * 0.1);
            column.position.y = 2.1;
            m.opacity = 0.8;
            holder.scale.set(1, 2.2, 1);
          } else m.opacity = 0;
          if (m.map) m.map.offset.y = -t * 2.5;
        };
        break;
      }
      case 'crumble': {
        // A2b: cracked floor -> shakes -> drops into a dark pit with a broken rim
        const crackTex = canvasTexture(256, (c, s) => {
          const rr = new R(h.id * 13 + 5);
          c.clearRect(0, 0, s, s);
          c.strokeStyle = 'rgba(10,8,6,0.9)';
          c.lineCap = 'round';
          for (let k = 0; k < 9; k++) {
            let x = s / 2,
              y = s / 2;
            let a = (k / 9) * Math.PI * 2 + rr.range(-0.3, 0.3);
            c.lineWidth = rr.range(2, 5);
            c.beginPath();
            c.moveTo(x, y);
            for (let j = 0; j < 7; j++) {
              a += rr.range(-0.5, 0.5);
              x += Math.cos(a) * s * 0.07;
              y += Math.sin(a) * s * 0.07;
              c.lineTo(x, y);
            }
            c.stroke();
          }
          c.beginPath();
          c.arc(s / 2, s / 2, s * 0.46, 0, Math.PI * 2);
          c.lineWidth = 3;
          c.stroke();
        });
        const cracks = new THREE.Mesh(new THREE.CircleGeometry(h.r, 32), new THREE.MeshBasicMaterial({ map: crackTex, transparent: true, opacity: 0.55, depthWrite: false }));
        cracks.rotation.x = -Math.PI / 2;
        cracks.position.y = 0.035;
        cracks.userData.floor = true;
        g.add(cracks);
        // A4: the kit crumble: heaved, cracked slabs (SLAB_*) that tilt and drop, then the broken RIM around the pit
        const ki = D.hazardKit?.(h);
        const kSlabs: THREE.Object3D[] = [];
        let kRim: THREE.Object3D | null = null;
        if (ki) {
          g.add(ki.obj);
          ki.obj.traverse((n) => {
            if (/^LOD\d_SLAB_/.test(n.name)) kSlabs.push(n);
            else if (/^LOD\d_RIM/.test(n.name)) kRim = n;
          });
        }
        const hole = new THREE.Mesh(blobDisc(h.r * 0.95, h.id + 21, 40), new THREE.MeshBasicMaterial({ color: '#030202' }));
        hole.position.y = 0.03;
        hole.visible = false;
        hole.userData.floor = true;
        g.add(hole);
        const rim = new THREE.Mesh(blobRing(h.r * 0.9, h.r + 0.3, h.id + 21), D.mats.rim ?? D.mats.stone);
        rim.position.y = 0.02;
        rim.receiveShadow = true;
        rim.visible = false;
        g.add(rim);
        // slabs that drop into the hole
        const slabs: THREE.Mesh[] = [];
        const rr = new R(h.id * 7 + 1);
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + rr.range(-0.3, 0.3),
            d = h.r * rr.range(0.25, 0.65);
          const sl = new THREE.Mesh(new THREE.BoxGeometry(h.r * 0.55, 0.16, h.r * 0.45), D.mats.rim ?? D.mats.stone);
          sl.position.set(Math.cos(a) * d, -0.05, Math.sin(a) * d);
          sl.rotation.y = a;
          sl.visible = false;
          g.add(sl);
          slabs.push(sl);
        }
        if (ki && kSlabs.length) {
          // the kit slabs replace the crack decal, the legacy rim and slabs
          cracks.visible = false;
          const rim0 = kRim as THREE.Object3D | null;
          const rest = kSlabs.map((n) => ({ n, p: n.position.clone(), r: n.rotation.clone(), c: slabCentre(n) }));
          let tk = -1;
          update = (s, t) => {
            if (s === 0) {
              hole.visible = false;
              if (rim0) rim0.visible = false;
              for (const r of rest) {
                r.n.visible = true;
                r.n.position.copy(r.p);
                r.n.rotation.copy(r.r);
              }
              tk = -1;
            } else if (s === 1) {
              for (const r of rest) {
                r.n.visible = true;
                r.n.position.set(r.p.x + Math.sin(t * 47 + r.c.x * 9) * 0.012, r.p.y + Math.abs(Math.sin(t * 31 + r.c.z * 7)) * 0.015, r.p.z + Math.cos(t * 41 + r.c.z * 5) * 0.012);
              }
            } else {
              if (tk < 0) tk = t;
              const k = s === 2 ? Math.min(1, (t - tk) / 0.45) : 1;
              hole.visible = true;
              if (rim0) rim0.visible = true;
              for (const r of rest) {
                r.n.visible = k < 1;
                r.n.position.set(r.p.x - r.c.x * k * 0.25, r.p.y - k * k * 1.5, r.p.z - r.c.z * k * 0.25);
                r.n.rotation.set(r.r.x + k * r.c.z * 0.9, r.r.y, r.r.z - k * r.c.x * 0.9);
              }
            }
          };
          break;
        }
        let t0 = -1;
        update = (s, t) => {
          const cm = cracks.material as THREE.MeshBasicMaterial;
          if (s === 0) {
            cracks.visible = true;
            cm.opacity = 0.55;
            cracks.position.set(0, 0.035, 0);
            hole.visible = rim.visible = false;
            for (const sl of slabs) sl.visible = false;
            t0 = -1;
          } else if (s === 1) {
            cracks.visible = true;
            cm.opacity = 0.75 + Math.sin(t * 30) * 0.2;
            cracks.position.set(Math.sin(t * 47) * 0.03, 0.035, Math.cos(t * 41) * 0.03);
          } else {
            if (t0 < 0) t0 = t;
            const k = s === 2 ? Math.min(1, (t - t0) / 0.45) : 1;
            cracks.visible = false;
            hole.visible = rim.visible = true;
            for (const sl of slabs) {
              sl.visible = k < 1;
              sl.position.y = -0.05 - k * k * 1.5;
              sl.rotation.x = k * 0.8;
            }
          }
        };
        break;
      }
    }
    this.hazards.push({ def: h, group: g, update });
  }

  /** A2b: one burning-oil patch (glowing pool + three flames), hidden until Frame.fires uses it */
  private addOilFire() {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(blobDisc(1.0, 77 + this.oilFires.length, 32), glowMat('#ff5a10', 0.55));
    disc.position.y = 0.04;
    g.add(disc);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      g.add(this.flame(new THREE.Vector3(Math.cos(a) * 0.45, 0.02, Math.sin(a) * 0.45), 0.85 - k * 0.12, this.theme.fire, k === 0));
    }
    g.visible = false;
    this.group.add(g);
    this.oilFires.push({ g, disc });
  }

  // ------------------------------------------------------------------ runtime
  /** shared shadow/occlusion data for the camera: standing obstacles */
  standing(): { x: number; z: number; r: number; h: number }[] {
    // visual radius for the camera: plinths, statues, crystal clusters and lantern roofs stick out past the sim radius
    const k = (kind: string) => (kind === 'statue' || kind === 'crystal' || kind === 'obelisk' ? 1.55 : kind === 'lantern_post' ? 1.4 : kind === 'banner' ? 2.0 : 1.2);
    // A3: a kit obstacle carries its measured footprint factor (footprintR / r0, <= 1.55 by the budget gate)
    return this.obstacles.filter((o) => !o.fallen).map((o) => ({ x: o.def.x, z: o.def.z, r: o.def.r * (Number(o.mesh.userData.footK) || k(o.def.kind)), h: o.def.h }));
  }
  /** chandeliers still hanging (for camera avoidance) */
  hangingNow(): { x: number; y: number; z: number; r: number }[] {
    const out: { x: number; y: number; z: number; r: number }[] = [];
    for (const h of this.hazards) if (h.def.kind === 'chandelier' && h.group.children[0]?.visible !== false) out.push({ x: h.def.x, y: CHANDELIER_H, z: h.def.z, r: 1.3 });
    // A2b: chain weights (the chain and the weight's swing zone)
    for (const h of this.hazards) if (h.def.kind === 'chains') out.push({ x: h.def.x, y: CHAIN_PIVOT_H - CHAIN_LEN * 0.5, z: h.def.z, r: 1.0 });
    return out;
  }
  boundR(x: number, z: number) {
    return boundR(this.layout, x, z);
  }

  /**
   * A2: what the floor is at (x, z) for footstep / splash FX (A20): water hazards, then the kit wet floor's water /
   * wet test (the shader's own maths on the CPU), else the theme's default surface (fxSurfaces THEME_FLOOR).
   */
  surfaceAt(x: number, z: number): FloorSurface {
    for (const h of this.layout.hazards) {
      if ((h.kind === 'water' || h.kind === 'lava') && Math.hypot(x - h.x, z - h.z) < h.r) return h.kind === 'water' ? 'water' : 'ash';
    }
    if (this.wetFloor) return this.wetFloor.surfaceAt(x, z);
    return THEME_FLOOR[this.layout.theme] ?? 'stone';
  }

  /**
   * A2: per-frame floor work that needs the renderer, called from Post's pre-scene hook (post.ts `preScene`,
   * timer 'reflect'): the light map (only when a source moved), the streak cards (low) and the planar reflection
   * (medium / high). `size` = the scene target in pixels, `quality` = the post tier.
   */
  preRender(r: THREE.WebGLRenderer, cam: THREE.PerspectiveCamera, size: THREE.Vector2, quality: number) {
    if (!this.wetFloor) return;
    this.collectFloorSources();
    this.lightMap?.update(r, this.floorSrc);
    this.streaks?.set(this.streakSrc);
    this.reflection?.render(r, this.scene, cam, size, quality);
  }

  private _wp = new THREE.Vector3();
  private _fireCol = new THREE.Color();
  private _moonCol = new THREE.Color();
  /** flames (light map: only those without a real light) and lava pools as floor light sources */
  private collectFloorSources() {
    const lm = this.floorSrc,
      st = this.streakSrc;
    lm.length = 0;
    st.length = 0;
    const live = (o: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
      return true;
    };
    this._fireCol.set(this.theme.fire);
    for (const f of this.flames) {
      if (!live(f.obj)) continue;
      f.obj.getWorldPosition(this._wp);
      const s: FloorLightSource = { x: this._wp.x, y: this._wp.y + f.size * 0.35, z: this._wp.z, size: f.size, color: this._fireCol, power: 1.9 * f.size };
      st.push(s);
      if (!f.light) lm.push(s);
    }
    // night themes: a long broken moon path toward the moon's azimuth (the concepts' moonlit streak; the real
    // mirror image of a moon 27 deg up falls below a low camera's frame, the concepts paint it as a glossy path)
    const S = this.theme.sky;
    if (this.streaks && S.moonSize > 0 && S.sunGlow === 0 && S.moonDir.y > 0.05) {
      const hz = Math.hypot(S.moonDir.x, S.moonDir.z) || 1;
      const cp = this.sky.position; // = the camera (update())
      st.push({ x: cp.x + (S.moonDir.x / hz) * 40, y: 3, z: cp.z + (S.moonDir.z / hz) * 40, size: 4, color: this._moonCol.copy(S.moonColor).multiplyScalar(1 / Math.max(1e-3, S.moonColor.r)), power: MOON_PATH, len: 3, wid: 1 });
    }
    for (const h of this.hazards) {
      if (h.def.kind !== 'lava') continue;
      lm.push({ x: h.def.x, y: 0.5, z: h.def.z, size: h.def.r * 1.5, color: LAVA_COL, power: 0.6 * h.def.r * h.def.r });
    }
  }

  /** sync dynamic state to a playback frame (simDt for physics-like visuals) */
  applyFrame(fr: Frame, simDt: number, hands: (i: number) => THREE.Vector3 | null, facing: (i: number) => number) {
    const t = fr.t;
    // A7c: the sky's lightning follows match time (same flashes on a replay / seek); read only, never written back
    this.matchT = t;
    this.matchSeen = this.time;
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
      if (!ov.def.toppleable) {
        // A2b barricades shatter in place (debris comes from the obstacle_break event); A5: their kit FRAC pieces burst
        if (ov.frac === undefined) ov.frac = this.spawnFrac(ov.mesh, 'burst', ov.def.id * 13 + 5, { speed: 0.8 });
        ov.fallen = ov.landed = true;
        ov.mesh.visible = false;
        ov.frac?.update(t - fallT);
        continue;
      }
      const k = Math.max(0, Math.min(1, (t - fallT) / TOPPLE_VIS));
      if (!ov.fallen) this.startFall(ov, fallT);
      if (k < 1) {
        ov.mesh.visible = true;
        if (ov.frac) this.dropFrac(ov);
        ov.landed = false;
        const ang = (Math.PI / 2 - 0.06) * k * k;
        ov.pivot.setRotationFromAxisAngle(ov.axis!, ang);
      } else {
        if (!ov.landed) {
          ov.landed = true;
          ov.mesh.visible = false;
          // A5: the obstacle breaks on landing: its FRAC pieces start from the fallen pose and settle along the fall line
          if (ov.frac === undefined) {
            ov.pivot.setRotationFromAxisAngle(ov.axis!, Math.PI / 2 - 0.06);
            const ev = this.toppleDir.get(i) ?? { dx: 1, dz: 0 };
            ov.frac = this.spawnFrac(ov.mesh, 'lie', ov.def.id * 31 + 7, { dir: new THREE.Vector3(ev.dx, 0, ev.dz), speed: 1 });
          }
        }
        ov.frac?.update(t - fallT - TOPPLE_VIS);
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
    // A5: broken props' FRAC pieces (spawned by prop_break / explosion events; dropped when a seek goes back before them)
    for (let k = this.propFracs.length - 1; k >= 0; k--) {
      const pf = this.propFracs[k];
      if (t < pf.t0 - 1e-3 || pf.set.finished) {
        pf.set.dispose();
        this.propFracs.splice(k, 1);
        continue;
      }
      pf.set.update(t - pf.t0);
    }
    // hazards
    for (let i = 0; i < this.hazards.length; i++) this.hazards[i].update(fr.haz[i] ?? 0, t, simDt);
    // A2b: burning oil from tipped braziers
    const F = fr.fires;
    const nf = F ? Math.floor(F.length / 4) : 0;
    for (let k = 0; k < this.oilFires.length; k++) {
      const of = this.oilFires[k];
      if (k >= nf) {
        of.g.visible = false;
        continue;
      }
      const life = F[k * 4 + 3];
      const s = F[k * 4 + 2] * Math.min(1, life * 4);
      of.g.visible = true;
      of.g.position.set(F[k * 4], 0, F[k * 4 + 1]);
      of.g.scale.set(s, Math.max(0.2, Math.min(1, life * 4)), s);
      (of.disc.material as THREE.MeshBasicMaterial).opacity = 0.55 * Math.min(1, life * 3);
    }
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
    this.dropFrac(ov);
    ov.fallen = false;
    ov.landed = false;
    ov.mesh.visible = true;
    ov.pivot.position.set(ov.def.x, 0, ov.def.z);
    ov.pivot.rotation.set(0, 0, 0);
    ov.mesh.position.set(0, 0, 0);
  }
  /** topple directions come from the event stream (set by the app for seeks too) */
  toppleDir = new Map<number, { dx: number; dz: number }>();

  // ------------------------------------------------------------------ A5: fracture sets + per-theme debris chunks
  private propFracs: { set: FracSet; t0: number; i: number }[] = [];

  /** a FracSet from an object's hidden FRAC_* meshes (kit assets), added to the arena; null when it has none (legacy) */
  private spawnFrac(owner: THREE.Object3D, mode: 'lie' | 'burst', seed: number, opts: { dir?: THREE.Vector3; speed?: number } = {}): FracSet | null {
    let any = false;
    owner.traverse((o) => {
      if (o.userData.frac && (o as THREE.Mesh).isMesh) any = true;
    });
    if (!any) return null;
    const set = new FracSet(owner, mode, seed, opts);
    for (const m of set.meshes) this.group.add(m);
    return set;
  }

  private dropFrac(ov: ObsView) {
    ov.frac?.dispose();
    ov.frac = undefined;
  }

  /** A5: a breaking prop's FRAC pieces burst from where it stood (once per prop and break time) */
  private propFrac(pv: PropView, i: number, t0: number, speed: number) {
    if (this.propFracs.some((p) => Math.abs(p.t0 - t0) < 1e-6 && p.set.meshes.length && p.i === i)) return;
    const set = this.spawnFrac(pv.obj, 'burst', i * 53 + 11, { speed });
    if (set) this.propFracs.push({ set, t0, i });
  }

  /**
   * A5: the debris pools draw kit chunk meshes in kit mode (ThemeArt.debris: debris kind -> kit asset; the most block-like
   * FRAC piece of a LOADED asset, with the asset's baked material): stone rubble from kit/chunk, splinters from the crate,
   * shards from the urn. Assets the layout did not load are not fetched for this (download stays as it was). One pool per
   * debris kind as before, so the debris draw calls are unchanged.
   */
  private kitDebris(pack: ArenaPack) {
    const map = pack.art.debris ?? {};
    for (const [kind, id] of Object.entries(map) as [DebrisMat, string][]) {
      const asset = pack.assets.get(id);
      if (!asset) continue;
      let best: THREE.Mesh | null = null,
        score = -1;
      asset.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !o.userData.frac) return;
        m.geometry.computeBoundingBox();
        const b = m.geometry.boundingBox!;
        const e = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].sort((p, q) => p - q);
        const sc = e[0] / Math.max(1e-4, e[2]);
        if (sc > score) (score = sc), (best = m);
      });
      const bm = best as THREE.Mesh | null;
      // the baked material only where it is the same stuff (marble / sandstone keep their colour, take the chunk's shape)
      const own = kind === 'stone' || kind === 'wood' || kind === 'ceramic';
      if (bm) this.debris.setChunk(kind, bm.geometry, own ? (bm.material as THREE.Material) : undefined);
    }
  }

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
        this.debris.burst(this.debrisOf(o.kind), new THREE.Vector3(o.x, 0.5, o.z), 10, 0.18, 2.5);
        return 0.25;
      }
      case 'topple_impact': {
        const i = Number(d.obs);
        const o = L.obstacles[i];
        const dir = this.toppleDir.get(i) ?? { dx: 1, dz: 0 };
        const mat = this.debrisOf(o.kind);
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
        this.debris.burst(this.debrisOf(o.kind), new THREE.Vector3(o.x, 1.2 + Math.random() * 1.5, o.z), 4, 0.1, 2.2);
        break;
      }
      case 'prop_break': {
        const pv = this.props[Number(d.prop)];
        if (pv) this.propFrac(pv, Number(d.prop), e.t, 1);
        const at = new THREE.Vector3(Number(d.x ?? pv?.obj.position.x ?? 0), Number(d.y ?? 0) + 0.4, Number(d.z ?? pv?.obj.position.z ?? 0));
        const kind = String(d.kind);
        const mat: DebrisMat = kind === 'urn' ? D.urnDebris : kind === 'lantern' ? 'paper' : kind === 'brazier' ? 'metal' : 'wood';
        this.debris.burst(mat, at, kind === 'urn' ? 14 : 11, kind === 'urn' ? 0.09 : 0.16, 3.2);
        if (kind === 'brazier' || kind === 'lantern') this.decals.scorch(at.x, at.z, 0.9);
        return 0.12;
      }
      case 'explosion': {
        const at = new THREE.Vector3(Number(d.x), Number(d.y), Number(d.z));
        const pv = this.props[Number(d.prop)];
        if (pv) this.propFrac(pv, Number(d.prop), e.t, 2.2);
        this.debris.burst('wood', at, 16, 0.15, 7);
        this.debris.burst('metal', at, 6, 0.08, 9);
        this.decals.scorch(at.x, at.z, 2.4);
        return 1.0;
      }
      case 'obstacle_break': {
        const o = L.obstacles[Number(d.obs)];
        if (!o) break;
        this.debris.burst('wood', new THREE.Vector3(o.x, 0.7, o.z), 22, 0.16, 4.5);
        return 0.35;
      }
      case 'brazier_tip': {
        this.decals.scorch(Number(d.x), Number(d.z), Number(d.r ?? 1.2) * 1.3);
        return 0.2;
      }
      case 'floor_collapse': {
        const at = new THREE.Vector3(Number(d.x), 0.2, Number(d.z));
        this.debris.burst(this.debrisOf(L.obstacles[0]?.kind ?? 'rock'), at, 20, Number(d.r ?? 1.5) * 0.5, 3.5);
        this.decals.crack(at.x, at.z, Number(d.r ?? 1.5) * 1.5, 9, 0.6);
        return 0.8;
      }
      case 'chandelier_impact': {
        const at = new THREE.Vector3(Number(d.x), 0.3, Number(d.z));
        this.debris.burst(D.chandelierDebris, at, 18, 0.14, 4.5);
        this.decals.crack(at.x, at.z, 1.8, 8);
        return 0.7;
      }
      case 'hazard_hit': {
        const h = L.hazards[Number(d.haz)];
        if (h?.kind === 'lava' || h?.kind === 'firepit' || h?.kind === 'flamejet' || d.kind === 'oil') this.decals.scorch(pos(e.b ?? 0).x, pos(e.b ?? 0).z, 0.6);
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
    for (const pf of this.propFracs) pf.set.dispose();
    this.propFracs.length = 0;
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
    this.backdrop?.update(this.fog);
    // A7c: distant lightning (match time in a fight, the arena clock otherwise): the sky flashes, the probe pulses lightly
    if (this.skyLook) {
      const L = this.skyLook;
      const lt = this.skyFlashAt ?? (this.time - this.matchSeen < 0.5 ? this.matchT : this.time);
      const f = (this.flash = lightningAt(lt, L.flashEvery, this.flashDir, this.moonAz));
      const U = (this.sky.material as THREE.ShaderMaterial).uniforms;
      (U.uSkyFlash.value as THREE.Vector4).w = f * L.flashGain;
      (U.uSkyFlashDir.value as THREE.Vector3).copy(this.flashDir);
      this.scene.environmentIntensity = this.envBase * (1 + L.flashEnv * f);
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
      f.k = k;
    }
    this.stage?.update(cam, this.flames, this.fog);
    // A2: one global flicker for the floor light map and the streak cards (plan 6.2)
    if (this.wetFloor) {
      const fl = 0.9 + Math.sin(t * 11.3) * 0.06 + Math.sin(t * 23.7 + 1.3) * 0.04;
      this.wetFloor.setLightGain(fl);
      if (this.streaks) this.streaks.uniforms.uFlicker.value = fl;
    }
    for (const u of this.updaters) u(t, dt);
    // A4: banner sway / chain swing (vertex shaders): the whole CPU side is this shared clock, timed for the A4 budget
    const s0 = performance.now();
    swayTime.value = t;
    swayOn.value = this.quality >= 1 ? 1 : 0;
    this.swayStats.ms += performance.now() - s0;
    this.swayStats.frames++;
  }
  /** A4: CPU time spent driving the kit banner sway / chain swing (ms total, frames) */
  swayStats = { ms: 0, frames: 0 };

  updateDebris(simDt: number) {
    this.debris.update(simDt);
  }

  dispose() {
    // A7b: undo the stage-light patch on the shared kit materials before anything else builds with them
    this.stage?.dispose();
    this.stage = null;
    (this.theme.sky.stormTex?.userData.rt as THREE.WebGLRenderTarget | undefined)?.dispose();
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      // kit asset clones share geometry / materials with the ArenaAssets cache: it disposes them (release); A3 obstacles own
      // their stretched geometry (ownGeo) and their crack material (ownMat)
      if (o.userData.kit) {
        const km = o as THREE.Mesh;
        if (o.userData.ownGeo) km.geometry?.dispose();
        if (o.userData.ownMat) (km.material as THREE.Material)?.dispose();
        return;
      }
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (o.userData.sharedMat) return; // A3: merged kit decor drawn with the asset cache's material
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) x.dispose();
    });
    this.env.dispose();
    if (this.scene.environment === this.env) this.scene.environment = null;
    this.wetFloor?.dispose();
    this.reflection?.dispose();
    this.lightMap?.dispose();
  }
}

/** seconds a toppling obstacle takes to reach the floor in the render (the sim lands it at TOPPLE_FALL) */
const TOPPLE_VIS = 0.9;
const LAVA_COL = new THREE.Color('#ff5a1a');
/** A2b placeholder banner cloth per theme (until the art kit) */
const BANNER_COLOR: Record<string, string> = { colosseum: '#7a1414', skytemple: '#d8c48a', sakura: '#b8202e', forge: '#3a2418', glacier: '#24426e', moonlake: '#3a2e62', desert: '#9a4818' };
/** A2: streak-card gain on medium / high, where the planar reflection carries most of the image */
const STREAK_ACCENT = 0.6;
/** A2: moon-path streak brightness (before the streak gain) */
const MOON_PATH = 0.6;

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

/** A4: a named node of a kit instance (e.g. SPIKES), whatever its LOD prefix */
function kitNode(ki: KitInstance, name: string): THREE.Object3D | null {
  let out: THREE.Object3D | null = null;
  ki.obj.traverse((n) => {
    if (!out && (n.name === name || n.name.endsWith(`_${name}`) || n.userData.node === name)) out = n;
  });
  return out;
}

/** A4: the horizontal centre of a crumble slab (unit-ish direction it falls towards the pit centre) */
function slabCentre(n: THREE.Object3D): THREE.Vector3 {
  const m = n as THREE.Mesh;
  if (!m.geometry) return new THREE.Vector3();
  if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
  const c = m.geometry.boundingBox!.getCenter(new THREE.Vector3());
  const v = new THREE.Vector3(c.x, 0, c.z);
  return v.lengthSq() > 0.04 ? v.normalize() : v.multiplyScalar(0);
}
