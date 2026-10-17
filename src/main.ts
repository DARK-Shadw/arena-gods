/**
 * App orchestrator: menu -> entrance A -> entrance B -> face-off -> fight
 * playback (auto-director) -> victory/results. Wires sim records into the
 * renderer, camera director, VFX, audio and HUD.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './style.css';
import { simulate } from './sim/match';
import { getFighter, FIGHTERS } from './sim/fighters';
import { generateArena, LAYOUTS, THEMES, type ArenaSpec, type LayoutId, type ThemeId } from './sim/arenaGen';
import type { FighterDef, Frame, MatchRecord, MoveDef, SimEvent } from './sim/types';
import { Arena } from './render/arena/arenaView';
import { THEME_DEFS } from './render/arena/themes';
import { camWorld } from './camera/cameraRig';
import { solids as camSolids, rayProxies } from './camera/cameraAudit';
import { buildReveal } from './cinematic/reveal';
import { FighterView } from './render/fighterView';
import { loadCharacter } from './render/character';
import type { VFX } from './render/vfx';
import { FxDirector, fxProfiler, fxSettings, type FxWorld } from './render/fx';
import { Post } from './render/post';
import { Playback } from './render/playback';
import { CameraRig } from './camera/cameraRig';
import { Director } from './camera/director';
import { audio } from './audio/audio';
import { SoundDirector } from './audio/soundDirector';
import { DialogueManager, type PickedLine } from './audio/dialogue';
import { UI, type MenuChoice } from './ui/ui';
import { buildEntrance, buildFaceoff, type CineCtx, type CineLine } from './cinematic/entrance';
import type { Timeline } from './cinematic/timeline';
import { runAudit } from './render/audit';
import { runAnimAudit } from './render/animAudit';
import { runPairAudit } from './render/pairAudit';
import { initLib } from './render/animLib';
import { validateEntrances } from './cinematic/validateEntrances';
import { FinisherFx } from './render/finisherFx';
import { ContactWarp } from './render/contactWarp';
import { BEHEAD_CLEAN, FIN_BY_ID, fxOf } from './sim/finishers';
import { auditMatch, type CamMatchScore } from './camera/cameraAudit';

type AppState = 'menu' | 'loading' | 'intro' | 'faceoff' | 'fight' | 'post';

class App {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  rig: CameraRig;
  arena!: Arena;
  arenaSpec!: ArenaSpec;
  /** render quality 0 low / 1 medium / 2 high */
  quality = 2;
  autoQuality = false;
  private qSamples: number[] = [];
  /** FX director (event-driven effects, seeded, on the FX clock); `vfx` is its legacy facade */
  fx = new FxDirector();
  vfx: VFX = this.fx.vfx;
  finFx!: FinisherFx;
  warp?: ContactWarp;
  /** headless audits: skip the GPU render */
  headless = false;
  post: Post;
  ui: UI;
  controls: OrbitControls;
  freeCam = false;
  state: AppState = 'menu';
  choice: MenuChoice;
  rec!: MatchRecord;
  defs!: [FighterDef, FighterDef];
  views: FighterView[] = [];
  playback!: Playback;
  director!: Director;
  timelines: Timeline[] = [];
  realT = 0;
  paused = false;
  userLetterbox = false;
  timeScale = 1;
  private clock = new THREE.Clock();
  private lastPhase = [-1, -1];
  private lastAttackId = [0, 0];
  private aberration = 0;
  private flash = 0;
  /** F1: vignette kick from FX defs (decays like the flash) */
  private vignetteKick = 0;
  private fps = 60;
  private moveCache: Record<string, MoveDef> = {};
  private victoryShown = false;
  private startToken = 0;
  sound!: SoundDirector;
  dialogue!: DialogueManager;
  /** cutscene clock scale (entrance slow-motion beats) */
  private cineScale = 1;
  private cineScaleUntil = 0;
  /** pending ?t= jump (sim seconds), consumed when the fight starts */
  private jumpT = 0;
  /** true while skipping cutscenes: suppresses their voice cues */
  private skipping = false;
  private lastToastT = -99;
  /** Camera-relative cinematic key + rim lights so fighters always read. */
  keyLight = new THREE.SpotLight('#ffe2c4', 30, 40, 0.55, 0.9, 1.2);
  rimLight = new THREE.SpotLight('#a8c4ff', 70, 40, 0.5, 0.9, 1.2);

  constructor() {
    const canvas = document.getElementById('c') as HTMLCanvasElement;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    const q0 = new URLSearchParams(location.search).get('q');
    // no ?q= -> auto: start high, step down while the measured frame time is too slow
    this.autoQuality = q0 === null;
    this.quality = q0 === null ? 2 : Math.max(0, Math.min(2, Number(q0)));
    this.renderer.setPixelRatio(Math.min(this.quality >= 2 ? 2 : this.quality === 1 ? 1.5 : 1, window.devicePixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = this.quality >= 1 ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.localClippingEnabled = true; // finisher plane cuts
    this.renderer.toneMappingExposure = 1.3;
    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1400);
    this.camera.position.set(10, 7, 10);
    this.rig = new CameraRig(this.camera);
    this.scene.add(this.vfx.group);
    fxProfiler.now = () => performance.now();
    fxSettings.setQuality(this.quality);
    this.finFx = new FinisherFx(this.scene, this.vfx);
    this.scene.add(this.keyLight, this.keyLight.target, this.rimLight, this.rimLight.target);
    this.post = new Post(this.renderer, this.scene, this.camera);
    this.post.quality = this.quality;
    this.post.distActive = () => this.vfx.dist.active;
    this.ui = new UI(document.getElementById('ui')!);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enabled = false;
    this.controls.target.set(0, 1, 0);
    for (const f of FIGHTERS) for (const m of f.moves) this.moveCache[`${f.id}:${m.id}`] = m;

    const q = new URLSearchParams(location.search);
    this.choice = {
      a: q.get('a') ?? 'gorak',
      b: q.get('b') ?? 'vex',
      seed: Number(q.get('seed') ?? Math.floor(Math.random() * 1e6)),
      skipIntro: q.get('skip') === '1' || Number(q.get('t') ?? 0) > 0,
      arena: {
        theme: (q.get('theme') as ThemeId | 'random' | null) ?? 'random',
        layout: (q.get('layout') as LayoutId | 'random' | null) ?? 'random',
        seed: Number(q.get('aseed') ?? Math.floor(Math.random() * 1e6)),
      },
    };
    // ?t=SECONDS jumps straight to that fight time (bug reports: ?a=&b=&seed=&theme=&layout=&aseed=&t=)
    this.jumpT = Number(q.get('t') ?? 0);
    this.ensureArena(this.resolveArena(this.choice));
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => this.key(e));
    window.addEventListener('pointerdown', () => audio.init(), { once: false });

    if (q.get('auto') === '1') this.start(this.choice);
    else this.openMenu();
    this.loop();
  }

  resize() {
    const w = window.innerWidth,
      h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.post.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** concrete arena spec for a menu choice ('random' picks a theme / layout) */
  resolveArena(c: MenuChoice): ArenaSpec {
    const t = c.arena.theme === 'random' ? THEMES[Math.floor(Math.random() * THEMES.length)] : c.arena.theme;
    const l = c.arena.layout === 'random' ? LAYOUTS[Math.floor(Math.random() * LAYOUTS.length)] : c.arena.layout;
    return { theme: t, layout: l, seed: c.arena.seed };
  }

  /** (re)build the arena visuals when the spec changes; same spec -> reset dynamic state */
  ensureArena(spec: ArenaSpec) {
    const same = this.arena && this.arenaSpec && spec.theme === this.arenaSpec.theme && spec.layout === this.arenaSpec.layout && spec.seed === this.arenaSpec.seed;
    if (same) {
      this.arena.resetProps();
      return;
    }
    const t0 = performance.now();
    if (this.arena) this.arena.dispose();
    this.arenaSpec = { ...spec };
    this.arena = new Arena(this.scene, this.renderer, generateArena(spec), this.quality);
    const T = THEME_DEFS[spec.theme];
    this.renderer.toneMappingExposure = T.exposure;
    this.post.setLook({ id: T.id, bloom: T.bloom, grade: T.grade, godrays: T.godrays, sunDir: T.sky.sunDir, rayColor: T.sunColor });
    this.keyLight.color.set(T.key);
    this.rimLight.color.set(T.rim);
    const L = this.arena.layout;
    camWorld.obstacles = this.arena.standing();
    camWorld.hanging = this.arena.hangingNow();
    camWorld.boundR = (x, z) => this.arena.boundR(x, z);
    camWorld.wallH = L.wallH;
    {
      this.arena.group.updateMatrixWorld(true);
      const S = rayProxies(camSolids(this.arena.group, this.arena.sky));
      const ray = new THREE.Raycaster();
      const d = new THREE.Vector3();
      camWorld.occluded = (from, to) => {
        d.subVectors(to, from);
        const len = d.length();
        ray.set(from, d.multiplyScalar(1 / Math.max(1e-6, len)));
        ray.far = Math.max(0.01, len - 0.25);
        return ray.intersectObjects(S, false).length > 0;
      };
    }
    camWorld.hanging = L.hazards.filter((h) => h.kind === 'chandelier').map((h) => ({ x: h.x, y: 6.2, z: h.z, r: 1.3 }));
    this.ui.setArenaLabel?.(`${T.name} · ${L.layout} · #${L.seed}`);
    console.info(`[arena] built ${spec.theme}/${spec.layout}#${spec.seed} in ${(performance.now() - t0).toFixed(0)}ms`);
  }

  openMenu() {
    this.state = 'menu';
    this.ui.hideResults();
    this.ui.showHud(false);
    this.ui.setLetterbox(false);
    this.ui.hideTitle();
    this.ui.hideSplash();
    audio.setMusic(false);
    this.dialogue?.stopAll();
    this.ui.onAudioSettings = () => this.openAudioSettings();
    this.ui.openMenu(this.choice, (c) => {
      audio.init();
      this.start(c);
    });
  }

  // ---------------------------------------------------------------- setup
  /** Loads both fighters' GLBs (cached), simulates the fight, then starts the intro. */
  async start(c: MenuChoice) {
    this.choice = c;
    this.ui.closeMenu();
    this.ui.hideResults();
    this.ui.showHud(false);
    this.victoryShown = false;
    const token = ++this.startToken;
    this.state = 'loading';
    this.ui.splashText('<small>THE GATES OPEN…</small>', 'victory');
    let assets;
    try {
      [assets] = await Promise.all([Promise.all([loadCharacter(c.a), loadCharacter(c.b)]), initLib('core', 'entrance', 'finisher')]);
    } catch (e) {
      console.error(e);
      this.ui.splashText('<small>failed to load fighter models (see console)</small>', 'victory');
      return;
    }
    if (token !== this.startToken) return; // a newer start() superseded this one
    this.dialogue?.stopAll();
    this.dialogue = new DialogueManager([c.a, c.b], [getFighter(c.a).name, getFighter(c.b).name], c.seed, this.ui);
    this.dialogue.posOf = (i) => this.views[i]?.position ?? { x: 0, z: 0 };
    // voice files are small; wait briefly for them so the intro monologue is ready
    await Promise.race([this.dialogue.preload(), new Promise((r) => setTimeout(r, 2500))]);
    if (token !== this.startToken) return;
    this.sound = new SoundDirector([c.a, c.b]);
    this.sound.voiceBusy = () => this.dialogue.busy;
    this.ui.hideSplash();
    const spec = this.resolveArena(c);
    this.ensureArena(spec);
    const t0 = performance.now();
    this.rec = simulate(c.a, c.b, c.seed, true, spec);
    console.info(`[arena] simulated ${c.a} vs ${c.b} seed=${c.seed} in ${(performance.now() - t0).toFixed(0)}ms`, this.rec.result);
    this.defs = [getFighter(c.a), getFighter(c.b)];
    for (const v of this.views) v.dispose(this.scene);
    this.views = [new FighterView(c.a, assets[0], this.scene), new FighterView(c.b, assets[1], this.scene)];
    this.playback = new Playback(this.rec);
    this.warp = new ContactWarp(this.rec);
    this.director = new Director(this.rig, this.rec);
    this.fx.setMatch(this.rec, c.seed, this.fxWorld());
    this.finFx.clear();
    for (const e of this.projMeshes.values()) this.scene.remove(e.mesh);
    this.projMeshes.clear();
    this.arena.resetProps();
    for (const e of this.rec.events) if (e.type === 'topple') this.arena.toppleDir.set(Number(e.data?.obs), { dx: Number(e.data?.dx), dz: Number(e.data?.dz) });
    this.arena.setRing(1);
    this.ui.setFighters(this.defs[0], this.defs[1]);
    this.lastPhase = [-1, -1];
    this.lastAttackId = [0, 0];
    // place both at their marks
    const f0 = this.rec.frames[0];
    for (let i = 0; i < 2; i++) this.views[i].updateFromFrame(f0.f[i], 0.016, f0.f[1 - i]);
    if (c.skipIntro) this.beginFight();
    else this.beginIntro();
  }

  private ctx(): CineCtx {
    return {
      scene: this.scene,
      arena: this.arena,
      vfx: this.vfx,
      rig: this.rig,
      audio,
      ui: this.ui,
      onAnnounce: (w) => !this.skipping && this.sound?.announce(w),
      slowmo: (scale, realDur) => {
        this.cineScale = scale;
        this.cineScaleUntil = this.realT + realDur;
      },
      seed: this.choice.seed,
    };
  }

  /** Wrap a picked dialogue line for a cutscene timeline. */
  private cineLine(line: PickedLine | null): CineLine | undefined {
    if (!line) return undefined;
    return { dur: line.dur, play: () => !this.skipping && this.dialogue.play(line) };
  }

  beginIntro() {
    this.state = 'intro';
    this.ui.showHud(false);
    this.ui.setLetterbox(true);
    audio.setMusic(true, 'intro');
    const ctx = this.ctx();
    // seeded line choice: entrance monologues, then the face-off exchange
    const tR = buildReveal(ctx);
    tR.cue('actor', 0, () => {
      this.views[0].rig.root.visible = false;
      this.views[1].rig.root.visible = false;
    });
    const tA = buildEntrance(ctx, this.views[0], 0, this.defs[1], this.cineLine(this.dialogue.pick(0, 'entrance')));
    const tB = buildEntrance(ctx, this.views[1], 1, this.defs[0], this.cineLine(this.dialogue.pick(1, 'entrance')));
    const [ba, bb] = this.dialogue.banter();
    const tF = buildFaceoff(ctx, this.views as [FighterView, FighterView], this.defs, [this.cineLine(ba) ?? null, this.cineLine(bb) ?? null]);
    // the fighter not on stage waits out of sight / at its mark
    tA.cue('actor', 0, () => (this.views[1].rig.root.visible = false));
    tB.cue('actor', 0, () => {
      this.views[1].rig.root.visible = true;
      this.views[0].rig.root.visible = true;
    });
    this.timelines = [tR, tA, tB, tF];
  }

  /** Skip the current cutscene segment (Space) or all of them (Enter). */
  skip(all: boolean) {
    if (this.state !== 'intro' && this.state !== 'faceoff') return;
    this.skipping = true;
    this.dialogue?.stopAll();
    if (all) {
      for (const t of this.timelines) t.finish();
      this.skipping = false;
      this.timelines = [];
      this.beginFight();
      return;
    }
    const cur = this.timelines[0];
    if (cur) cur.finish();
    this.skipping = false;
  }

  beginFight() {
    this.state = 'fight';
    this.timelines = [];
    this.restoreLighting();
    this.rig.collide = true;
    this.ui.hideTitle();
    this.ui.hideSplash();
    this.ui.showHud(true);
    this.ui.setLetterbox(this.userLetterbox);
    for (const v of this.views) v.rig.root.visible = true;
    this.playback.seek(0);
    this.realT = 0;
    this.director = new Director(this.rig, this.rec);
    this.sound = new SoundDirector([this.choice.a, this.choice.b]);
    this.sound.voiceBusy = () => this.dialogue.busy;
    audio.setMusic(true, 'fight');
    if (this.jumpT > 0) {
      const t = this.jumpT;
      this.jumpT = 0;
      this.debugSeekFight(t);
      this.paused = new URLSearchParams(location.search).get('pause') === '1';
    }
  }

  restoreLighting() {
    this.arena.restoreLighting();
  }

  // ---------------------------------------------------------------- input
  key(e: KeyboardEvent) {
    if (e.code === 'KeyV') {
      this.openAudioSettings();
      return;
    }
    if (this.ui.menuOpen) return;
    audio.init();
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        this.skip(false);
        break;
      case 'Enter':
        this.skip(true);
        break;
      case 'KeyR':
        this.start(this.choice);
        break;
      case 'KeyN':
        this.start({ ...this.choice, seed: Math.floor(Math.random() * 1e6) });
        break;
      case 'KeyA':
        // reroll the arena: Shift keeps the theme, otherwise a fresh theme + layout + seed
        this.start({
          ...this.choice,
          arena: e.shiftKey ? { theme: this.arenaSpec.theme, layout: 'random', seed: Math.floor(Math.random() * 1e6) } : { theme: 'random', layout: 'random', seed: Math.floor(Math.random() * 1e6) },
        });
        break;
      case 'KeyT': {
        // next theme, same layout + seed
        const i = THEMES.indexOf(this.arenaSpec.theme);
        this.start({ ...this.choice, arena: { theme: THEMES[(i + 1) % THEMES.length], layout: this.arenaSpec.layout, seed: this.arenaSpec.seed } });
        break;
      }
      case 'KeyQ': {
        this.autoQuality = false;
        this.quality = (this.quality + 2) % 3;
        this.post.quality = this.quality;
        fxSettings.setQuality(this.quality);
        this.renderer.setPixelRatio(Math.min(this.quality >= 2 ? 2 : this.quality === 1 ? 1.5 : 1, window.devicePixelRatio));
        this.resize();
        const spec = this.arenaSpec;
        this.arena.dispose();
        (this as { arena?: Arena }).arena = undefined;
        this.ensureArena(spec);
        this.ui.toast(`QUALITY ${['LOW', 'MEDIUM', 'HIGH'][this.quality]}`, '', '#d0c0a0', 1.2);
        break;
      }
      case 'Escape':
        this.openMenu();
        break;
      case 'KeyL':
        this.userLetterbox = !this.userLetterbox;
        if (this.state === 'fight') this.ui.setLetterbox(this.userLetterbox);
        break;
      case 'KeyC':
        this.freeCam = !this.freeCam;
        this.controls.enabled = this.freeCam;
        if (this.freeCam) this.controls.target.copy(this.rig.target);
        break;
      case 'Backquote':
      case 'F3':
        e.preventDefault();
        this.ui.toggleDebug();
        break;
      case 'KeyP':
        this.paused = !this.paused;
        break;
      case 'KeyM':
        audio.setMuted(!audio.muted);
        break;
      case 'KeyV':
        this.openAudioSettings();
        break;
      case 'KeyO':
        this.post.dofEnabled = !this.post.dofEnabled;
        break;
      case 'KeyB': {
        // "bad camera here": a URL that reproduces this exact moment
        const url = this.reportUrl();
        console.info('[camera report]', url, this.director?.shotName, this.director?.lastScores.join(' '));
        navigator.clipboard?.writeText(url).catch(() => {});
        this.ui.toast('CAMERA REPORT', 'URL copied (see console)', '#d0c0a0', 1.6);
        break;
      }
    }
  }

  openAudioSettings() {
    audio.init();
    this.ui.toggleSettings(audio.settings as unknown as Record<string, number>, (k, v) => audio.setSetting(k as 'master', v));
  }

  // ---------------------------------------------------------------- loop
  /** ?manual=1 disables the RAF clock so tests can step deterministically. */
  manual = new URLSearchParams(location.search).get('manual') === '1';
  loop = () => {
    requestAnimationFrame(this.loop);
    const realDt = Math.min(0.05, this.clock.getDelta());
    if (!this.manual) this.tick(realDt);
  };
  /** Test hook: advance n frames of dt seconds. */
  stepFrames(n: number, dt = 1 / 30) {
    for (let i = 0; i < n; i++) {
      this.noRender = i < n - 1;
      this.tick(dt);
    }
    this.noRender = false;
  }
  private noRender = false;

  /** apply a quality level without rebuilding the arena (post passes, pixel ratio, shadow map) */
  setQuality(q: number) {
    this.quality = q;
    this.post.quality = q;
    fxSettings.setQuality(q);
    this.renderer.setPixelRatio(Math.min(q >= 2 ? 2 : q === 1 ? 1.5 : 1, window.devicePixelRatio));
    this.renderer.shadowMap.type = q >= 1 ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    const sm = q >= 1 ? 2048 : 1024;
    const sh = this.arena.moon.shadow;
    if (sh.mapSize.x !== sm) {
      sh.mapSize.set(sm, sm);
      sh.map?.dispose();
      (sh as unknown as { map: THREE.WebGLRenderTarget | null }).map = null;
    }
    this.resize();
    console.info(`[arena] quality -> ${['low', 'medium', 'high'][q]}`);
  }

  private autoTune(realDt: number) {
    if (!this.autoQuality || this.manual || this.quality === 0 || document.hidden) return;
    this.qSamples.push(realDt);
    if (this.qSamples.length < 150) return;
    const s = [...this.qSamples].sort((a, b) => a - b);
    const median = s[Math.floor(s.length / 2)];
    this.qSamples = [];
    if (median > 1 / 48) {
      this.setQuality(this.quality - 1);
      this.ui.toast(`QUALITY ${['LOW', 'MEDIUM', 'HIGH'][this.quality]}`, 'auto-tuned for frame rate (Q to change)', '#d0c0a0', 1.6);
    } else if (median < 1 / 58) this.autoQuality = false; // fast enough: stop measuring
  }

  tick(realDt: number) {
    this.fps += (1 / Math.max(1e-3, realDt) - this.fps) * 0.05;
    this.autoTune(realDt);
    let fxDt = realDt;
    let dof = 0;
    let focus = 8;
    let desat = 0;
    if (this.state === 'intro' || this.state === 'faceoff') {
      this.realT += realDt;
      const tl = this.timelines[0];
      if (tl) {
        if (this.realT > this.cineScaleUntil) this.cineScale = 1;
        tl.update(realDt * this.cineScale);
        if (tl.done) {
          this.timelines.shift();
          if (this.timelines.length === 1) this.state = 'faceoff';
          if (this.timelines.length === 0) this.beginFight();
        }
      }
      dof = 1;
      focus = this.camera.position.distanceTo(this.rig.target);
    } else if (this.state === 'fight' || this.state === 'post') {
      fxDt = this.tickFight(realDt);
      const sn = this.director.shotName;
      if (sn === 'killcam' || sn.startsWith('react') || sn === 'victory') dof = 1;
      focus = this.camera.position.distanceTo(this.rig.target);
      if (sn === 'killcam') desat = 0.35;
      // finisher freeze beat: drained colour while time holds
      if (sn === 'finisher' && this.realT < this.director.freezeUntil) desat = 0.45;
      if (sn === 'cutin') desat = 0.2;
    } else {
      // menu: slow establishing orbit
      this.realT += realDt;
      const a = this.realT * 0.06;
      const R = Math.max(this.arena.layout.rx, this.arena.layout.rz);
      const p = new THREE.Vector3(Math.cos(a) * R * 1.05, 5.5 + R * 0.12, Math.sin(a) * R * 1.05);
      this.rig.collide = false;
      this.rig.cut(p, new THREE.Vector3(0, 1.5, 0), 55);
      this.rig.update(p, new THREE.Vector3(0, 1.5, 0), 55, realDt);
    }
    if (this.freeCam) this.controls.update();
    this.updateCineLights();
    this.dialogue?.update(realDt);
    {
      const fwd = this.rig.target.clone().sub(this.camera.position);
      audio.setListener(this.camera.position.x, this.camera.position.z, -fwd.z, fwd.x);
    }
    // the impact light runs on real dt (keeps fading while the action is frozen / slowed, else it blooms the frame white)
    this.fx.update(fxDt, realDt);
    {
      const pp = this.fx.takePost();
      this.aberration = Math.max(this.aberration, pp.aberration);
      this.flash = Math.max(this.flash, pp.flash);
      this.vignetteKick = Math.max(this.vignetteKick, pp.vignette);
      for (const g of pp.grades) this.post.kickPreset(g.id, g.weight, g.dur);
    }
    this.finFx.update(fxDt);
    this.arena.update(realDt, this.camera, this.renderer.domElement.height);
    audio.update(this.state === 'fight' ? this.playback.frameAt(this.playback.t).tension : 0.15);
    audio.setCrowd(this.arena.excitement);
    this.aberration *= Math.exp(-realDt * 8);
    this.flash *= Math.exp(-realDt * 10);
    this.vignetteKick *= Math.exp(-realDt * 5);
    this.post.update(realDt, { dof, focus, aberration: this.aberration, desat, flash: this.flash, vignette: this.vignetteKick });
    if (!this.noRender && !this.headless) this.post.render();
  }

  private updateCineLights() {
    const cam = this.camera.position;
    const tgt = this.freeCam ? this.controls.target : this.rig.target;
    const fwd = tgt.clone().sub(cam).setY(0);
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, 1);
    fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    this.keyLight.position.copy(cam).addScaledVector(right, -2.5).add(new THREE.Vector3(0, 3, 0));
    this.keyLight.target.position.copy(tgt);
    this.rimLight.position.copy(tgt).addScaledVector(fwd, 4.5).addScaledVector(right, 1.5).add(new THREE.Vector3(0, 3.2, 0));
    this.rimLight.target.position.copy(tgt);
    const cine = this.state === 'intro' || this.state === 'faceoff';
    this.keyLight.intensity = cine ? 22 : 16;
    this.rimLight.intensity = cine ? 55 : 35;
  }

  private tickFight(realDt: number): number {
    const pb = this.playback;
    this.realT += realDt;
    let scale = this.director.timeScale(this.realT, pb.t);
    if (this.paused) scale = 0;
    this.timeScale = scale;
    const simDt = realDt * scale;
    const evs = pb.advance(simDt);
    const fr = pb.frameAt(pb.t);
    for (let i = 0; i < 2; i++) this.views[i].updateFromFrame(fr.f[i], Math.max(simDt, 1e-4), fr.f[1 - i], realDt);
    this.warp?.apply(this.views, pb.t);
    this.arena.applyFrame(
      fr,
      simDt,
      (i) => this.views[i].handsWorld(),
      (i) => this.views[i].root.rotation.y,
    );
    this.arena.updateDebris(simDt);
    camWorld.obstacles = this.arena.standing();
    camWorld.hanging = this.arena.hangingNow();
    for (const v of this.views) v.fxTime = pb.t;
    this.fx.frame({ events: evs, frame: fr, simT: pb.t, simDt });
    this.handleEvents(evs, fr);
    this.continuousFx(fr);
    this.updateProjectiles(fr);
    this.dialogueEvents(evs); // first, so spoken hurt lines suppress generic grunts
    this.sound.frame(fr, simDt, realDt, scale);
    this.sound.events(evs, fr);
    // slow-mo filtering only for the killcam / parry slow-mo, not hit-stop freezes
    audio.setSlowmo(scale < 0.05 ? 1 : scale);
    const chest: [THREE.Vector3, THREE.Vector3] = [this.views[0].chestWorld(), this.views[1].chestWorld()];
    const heads: [THREE.Vector3, THREE.Vector3] = [this.views[0].headWorld(), this.views[1].headWorld()];
    this.director.enabled = !this.freeCam;
    this.director.update({ realT: this.realT, simT: pb.t, frame: fr, chest, heads, newEvents: evs }, realDt);
    this.ui.setLetterbox(this.userLetterbox || this.director.letterbox);
    this.ui.updateHud(fr, [this.defs[0].stats.hp, this.defs[1].stats.hp], [this.defs[0].stats.stamina, this.defs[1].stats.stamina], realDt);
    this.arena.setRing(fr.ringS);
    this.arena.excitement += (Math.min(1, fr.tension * 0.9 + 0.1) - this.arena.excitement) * Math.min(1, realDt * 2);

    if (this.ui.debugVisible) {
      const ff = (i: number) => {
        const f = fr.f[i];
        return `${this.defs[i].id.padEnd(7)} ${f.state.padEnd(9)} goal:${f.goal.padEnd(8)} ${(f.moveId || '-').padEnd(14)} hp ${f.hp.toFixed(0).padStart(5)} st ${f.stamina.toFixed(0).padStart(3)} fury ${f.fury.toFixed(0).padStart(3)}${f.buff > 0 ? ' BUFF' : ''}${f.lastStand ? ' LAST' : ''}`;
      };
      this.ui.setDebug(
        [
          `seed ${this.choice.seed}  sim t ${pb.t.toFixed(2)} / ${pb.duration.toFixed(1)}  timescale ${scale.toFixed(2)}  fps ${this.fps.toFixed(0)}`,
          `shot ${this.director.shotName}${this.freeCam ? ' (FREE CAM)' : ''}  side ${this.director.side}  tension ${fr.tension.toFixed(2)}  momentum ${fr.momentum.toFixed(2)}  ring ${fr.ringS.toFixed(2)}  arena ${this.arenaSpec.theme}/${this.arenaSpec.layout}#${this.arenaSpec.seed}`,
          ff(0),
          ff(1),
          (() => {
            const x = this.fx.stats();
            return `fx t ${x.t.toFixed(2)}  particles ${x.particles.add}+${x.particles.alpha}  rings ${x.rings}  debris ${x.debris}  effects ${x.effects}  cpu ${x.cpu.frameMs.toFixed(3)}+${x.cpu.updateMs.toFixed(3)} ms  q${x.quality} gore ${x.gore}`;
          })(),
          `result: winner ${this.rec.result.winner >= 0 ? this.defs[this.rec.result.winner].id : 'draw'}  swings ${this.rec.result.swings}  comeback ${this.rec.result.comeback}`,
          '--- events / cuts',
          ...this.director.log.slice(0, 12),
        ].join('\n'),
      );
    }

    const kill = this.rec.events.find((e) => e.type === 'kill' || e.type === 'timeout');
    if (kill && pb.t > kill.t + 1.7 && !this.victoryShown) {
      this.victoryShown = true;
      const w = this.rec.result.winner;
      if (w >= 0) {
        this.ui.splashText(`<small>${this.rec.result.timeout ? 'BY DECISION' : 'VICTORY'}</small><span style="color:${this.defs[w].color}">${this.defs[w].name}</span>`, 'victory');
      }
      audio.stinger('victory');
      audio.cheer(2);
      audio.setMusic(true, 'victory');
      if (w >= 0) {
        const hp = this.rec.result.finalHp[w];
        this.sound.announce(hp > 0.9 ? 'flawless' : 'winner');
        this.dialogue.say(w, 'victory', 1, true);
      }
      this.ui.showHud(false);
    }
    if (pb.done && this.state === 'fight') {
      this.state = 'post';
      this.ui.hideSplash();
      this.ui.showResults(this.rec.result, this.defs, this.choice.seed, {
        rerun: () => this.start(this.choice),
        reseed: () => this.start({ ...this.choice, seed: Math.floor(Math.random() * 1e6) }),
        menu: () => this.openMenu(),
      });
    }
    return Math.max(simDt, realDt * 0.08);
  }

  /** Voiced barks driven by sim events (seeded picks; render-side only). */
  private dialogueEvents(evs: SimEvent[]) {
    const D = this.dialogue;
    for (const e of evs) {
      switch (e.type) {
        case 'ability_used':
          D.say(e.a, 'ultimate', 1);
          break;
        case 'taunt':
          D.say(e.a, 'taunt', 0.8);
          break;
        case 'hit':
          if (e.b !== undefined && e.data?.heavy) D.say(e.b, 'hurt', 0.3);
          break;
        case 'near_death':
          D.say(e.a, 'nearDeath', 0.9);
          break;
        case 'second_wind':
        case 'last_stand':
          D.say(e.a, 'comeback', 0.9);
          break;
        case 'comeback':
          D.say(e.a, 'comeback', 0.6);
          break;
        case 'kill':
          if (e.b !== undefined) D.say(e.b, 'defeat', 1);
          D.say(e.a, 'kill', 1, true);
          break;
      }
    }
  }

  private moveOf(i: number, id: string): MoveDef | undefined {
    return this.moveCache[`${this.defs[i].id}:${id}`];
  }

  /** Attack-phase observations for audio (the visuals of these and of the continuous emitters live in fx/fxDefs.ts). */
  private continuousFx(fr: Frame) {
    for (let i = 0; i < 2; i++) {
      const f = fr.f[i];
      const mv = f.moveId ? this.moveOf(i, f.moveId) : undefined;
      const newAttack = f.attackId !== this.lastAttackId[i];
      if (f.state === 'attack' && mv && (f.phase !== this.lastPhase[i] || newAttack) && f.phase === 1) {
        if (mv.fx === 'fire' || mv.fx === 'pyre') audio.fire(mv.fx === 'pyre');
        if (mv.fx === 'nova') audio.fire(true);
      }
      this.lastPhase[i] = f.state === 'attack' ? f.phase : -1;
      this.lastAttackId[i] = f.attackId;
    }
  }

  /**
   * Projectile meshes (the sim's projectiles must physically reach the target before damage).
   * Trails and impact sparks are FX defs (proj.*); meshes share one geometry + material per kind.
   */
  private projMeshes = new Map<number, { mesh: THREE.Object3D; last: THREE.Vector3; fx: string }>();
  private projAssets = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material }>();
  private projAsset(fx: string) {
    let a = this.projAssets.get(fx);
    if (!a) {
      const color = fx === 'arrow' ? '#e8fff0' : fx === 'shadow' ? '#c070ff' : fx === 'seed' ? '#c8ff60' : '#ffa040';
      let geo: THREE.BufferGeometry;
      if (fx === 'arrow') {
        geo = new THREE.CylinderGeometry(0.018, 0.018, 0.85, 5);
        geo.rotateX(Math.PI / 2);
      } else geo = new THREE.SphereGeometry(fx === 'pyre' ? 0.32 : fx === 'seed' ? 0.09 : 0.18, 10, 8);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: fx === 'arrow' ? 0.95 : 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
      a = { geo, mat };
      this.projAssets.set(fx, a);
    }
    return a;
  }
  private updateProjectiles(fr: Frame) {
    const seen = new Set<number>();
    for (const p of fr.proj) {
      seen.add(p.id);
      let e = this.projMeshes.get(p.id);
      if (!e) {
        const A = this.projAsset(p.fx);
        const mesh = new THREE.Mesh(A.geo, A.mat);
        this.scene.add(mesh);
        e = { mesh, last: new THREE.Vector3(p.x, p.y, p.z), fx: p.fx };
        this.projMeshes.set(p.id, e);
        if (p.fx === 'arrow') audio.play('whoosh_light', { pos: { x: p.x, z: p.z }, rate: 1.6, vol: 0.5 });
      }
      const pos = new THREE.Vector3(p.x, p.y, p.z);
      if (pos.distanceToSquared(e.last) > 1e-6) e.mesh.lookAt(pos.clone().add(pos.clone().sub(e.last)));
      e.mesh.position.copy(pos);
      e.last.copy(pos);
    }
    for (const [id, e] of this.projMeshes) {
      if (seen.has(id)) continue;
      this.scene.remove(e.mesh);
      this.projMeshes.delete(id);
    }
  }

  /** Read-only view of the match for the FX director (anchors, colours, layout). */
  private fxWorld(): FxWorld {
    const L = () => this.arena.layout;
    return {
      chest: (i) => this.views[i].chestWorld(),
      head: (i) => this.views[i].headWorld(),
      cast: (i) => this.views[i].castWorld(),
      feet: (i) => this.views[i].position,
      accent: (i) => this.views[i].ap.accent,
      move: (i, id) => this.moveOf(i, id),
      obstacle: (i) => L().obstacles[i],
      hazard: (i) => L().hazards[i],
      ring: () => ({ rx: L().rx, rz: L().rz }),
      isFinisher: (m) => !!FIN_BY_ID[m],
    };
  }

  private handleEvents(evs: SimEvent[], fr: Frame) {
    // no drama banners over a kill sequence or a finisher (WINDED / LAST STAND would cover the scene)
    const quiet = this.director.inKillSequence(this.playback.t) || /^(finisher|cutin)$/.test(this.director.shotName);
    const realToast = this.ui.toast.bind(this.ui);
    const toast = (m: string, s?: string, c?: string, d?: number) => {
      if (quiet) return;
      this.lastToastT = this.realT;
      realToast(m, s, c, d);
    };
    // minor callouts are rate-limited so the big drama beats keep their punch
    const minorToast = (m: string, s?: string, c?: string, d?: number) => {
      if (this.realT - this.lastToastT > 5) toast(m, s, c, d);
    };
    for (const e of evs) {
      const a = e.a >= 0 ? this.views[e.a] : undefined;
      const b = e.b !== undefined && e.b >= 0 ? this.views[e.b] : undefined;
      const aDef = e.a >= 0 ? this.defs[e.a] : undefined;
      const shake = this.arena.onEvent(e, (i) => this.views[Math.max(0, i)].position);
      if (shake > 0) this.rig.addShake(shake);
      this.arenaFx(e, a, b, toast, minorToast);
      switch (e.type) {
        case 'hit': {
          if (!b || !a) break;
          const heavy = !!e.data?.heavy;
          {
            // procedural flinch on the victim (real-time springs: keeps moving through hit-stop)
            const sp = a.strikePointsWorld(String(e.data?.move ?? ''));
            const high = sp.length > 0 && sp[0].y > b.chestWorld().y + 0.22;
            const ult = e.data?.kind === 'ultimate';
            b.onHit(a.position, (ult ? 2.2 : heavy ? 1.6 : 0.85) * Math.min(1.3, 0.8 + a.def.stats.weight * 0.2), high ? 'head' : 'body');
          }
          // impact visuals: fx defs impact.* (fx/fxDefs.ts RESOLVE.hit)
          break;
        }
        case 'block': {
          if (!a || !b) break;
          a.onBlocked();
          a.onHit(b.position, 0.45, 'body');
          break;
        }
        case 'parry': {
          if (!a || !b) break;
          b.onHit(a.position, 1.0, 'body');
          minorToast('PARRY', aDef!.name, '#bfe0ff', 1.0);
          break;
        }
        case 'guard_break':
          minorToast('GUARD BROKEN', aDef?.name ?? '', '#ffb070', 1.2);
          break;
        case 'wall_slam':
        case 'pillar_slam':
          toast(e.type === 'wall_slam' ? 'INTO THE SPIKES' : 'PILLAR SLAM', aDef?.name ?? '', '#ffb070', 1.2);
          break;
        case 'ability_used':
          if (a && aDef) {
            toast(String(e.data?.name ?? 'ULTIMATE'), aDef.name, aDef.color, 1.6);
          }
          break;
        case 'exhausted':
          if (aDef) minorToast('WINDED', aDef.name, '#9fb4c8', 1.0);
          break;
        case 'taunt':
          break;
        case 'rage':
          if (aDef) minorToast('ENRAGED', aDef.name, '#ff5a3a', 1.0);
          break;
        case 'second_wind':
          if (a && aDef) {
            const cornered = e.data?.kind === 'cornered';
            toast(cornered ? 'CORNERED' : 'SECOND WIND', aDef.name, aDef.color, 2);
          }
          break;
        case 'last_stand':
          if (a && aDef) {
            // no banner over a finisher (the victim's last stand would cover the kill)
            if (!/^(finisher|cutin)$/.test(this.director.shotName)) toast('LAST STAND', aDef.name, '#ff4a3a', 2.2);
          }
          break;
        case 'near_death':
          break;
        case 'momentum_swing':
          if (aDef) toast(fr.t > 5 ? 'MOMENTUM SHIFT' : 'FIRST BLOOD', `${aDef.name} takes the lead`, aDef.color, 1.6);
          break;
        case 'comeback':
          if (aDef) toast('COMEBACK!', aDef.name, aDef.color, 2.2);
          break;
        case 'stalemate_break':
          toast('THE CROWD GROWS RESTLESS', 'they want blood', '#d0c0a0', 1.8);
          break;
        case 'arena_shrink':
          toast('THE RING OF FIRE CLOSES', '', '#ff7a20', 2.2);
          break;
        case 'sudden_death':
          toast('SUDDEN DEATH', 'all blows strike harder', '#ff3a2a', 2.2);
          break;
        case 'finisher_start': {
          const def = FIN_BY_ID[String(e.data?.id)];
          if (def && aDef) realToast(def.name, aDef.name, aDef.color, 2.4);
          this.ui.speedLines?.(0.45);
          audio.stinger('dread');
          break;
        }
        case 'finisher_contact': {
          if (!a || !b) break;
          const p = b.chestWorld();
          if (e.data?.kind === 'kill') {
            const def = FIN_BY_ID[String(e.data?.id)];
            let fx = (String(e.data?.fx ?? '') || (def ? fxOf(def, a.def.id) : 'crush')) as Parameters<FinisherFx['play']>[0];
            if (fx === 'behead' && !BEHEAD_CLEAN.has(b.def.id)) fx = 'bisect';
            const dir = b.position.clone().sub(a.position).setY(0).normalize();
            const at = fx === 'behead' ? b.headWorld().setY(b.headWorld().y - 0.2) : p;
            this.finFx.play(fx, b.model, { attacker: a.model, plane: a.bladePlane(p), at, dir });
            b.onHit(a.position, 2.4, fx === 'behead' ? 'head' : 'body');
            audio.boom(0.8);
          } else {
            b.onHit(a.position, 1.3, 'body');
          }
          break;
        }
        case 'launch_land':
          if (a) {
            // into the fire / spikes: the landing is the finisher
            const fs = this.rec.events.find((x) => x.type === 'finisher_start' && x.data?.kind === 'launch' && x.b === e.a && Math.abs(x.t - e.t) < 2);
            if (fs) this.finFx.play(String(fs.data?.fx ?? 'burn') as Parameters<FinisherFx['play']>[0], a.model, { at: a.chestWorld() });
          }
          break;
      }
    }
  }

  /** VFX / toasts for arena & destruction events */
  private arenaFx(e: SimEvent, a: FighterView | undefined, b: FighterView | undefined, toast: (m: string, s?: string, c?: string, d?: number) => void, minorToast: (m: string, s?: string, c?: string, d?: number) => void) {
    const d = e.data ?? {};
    const L = this.arena.layout;
    const name = (i: number | undefined) => (i !== undefined && i >= 0 ? this.defs[i].name : '');
    switch (e.type) {
      case 'explosion': {
        toast('KABOOM!', e.a >= 0 ? `${name(e.a)} lit the powder` : '', '#ff9a40', 1.4);
        break;
      }
      case 'fuse': {
        const pr = Number(d.prop);
        void pr;
        break;
      }
      case 'prop_throw':
        if (a) audio.play('whoosh_heavy', { pos: { x: a.position.x, z: a.position.z }, rate: 0.85 });
        break;
      case 'prop_pickup':
        if (a) audio.play('cloth', { pos: { x: a.position.x, z: a.position.z } });
        break;
      case 'prop_hit': {
        if (!b) break;
        minorToast(`${String(d.kind).toUpperCase()} TO THE FACE`, name(e.a), this.defs[e.a].color, 1.2);
        break;
      }
      case 'prop_batted':
        if (a) {
          minorToast('SWATTED ASIDE', name(e.a), this.defs[e.a].color, 1.0);
        }
        break;
      case 'topple':
        toast('IT\'S COMING DOWN', '', '#e8d8b0', 1.3);
        break;
      case 'crush':
        if (b) {
          toast('CRUSHED!', name(e.b), '#ffcf8a', 1.6);
        }
        break;
      case 'hazard_trigger': {
        const h = L.hazards[Number(d.haz)];
        if (!h) break;
        if (h.kind === 'chandelier') {
          audio.play('clang', { pos: { x: h.x, z: h.z }, rate: 0.6, vol: 0.5 });
        }
        break;
      }
      case 'chandelier_impact': {
        const p = { x: Number(d.x), z: Number(d.z) };
        audio.play('wall_slam', { pos: { x: p.x, z: p.z }, hitNow: true, rate: 0.7 });
        audio.boom(0.7);
        toast('FROM ABOVE!', '', '#ffcf8a', 1.4);
        break;
      }
      case 'hazard_hit': {
        const h = L.hazards[Number(d.haz)];
        if (!h || !b) break;
        const p = b.position;
        if (h.kind === 'lava' || h.kind === 'firepit') {
          audio.fire(true);
          minorToast(h.kind === 'lava' ? 'INTO THE LAVA' : 'INTO THE FIRE', name(e.b), '#ff7a30', 1.3);
        } else if (h.kind === 'spikes') {
          audio.play('hit_blade', { pos: { x: p.x, z: p.z }, hitNow: true, rate: 0.8 });
          minorToast('SPIKE TRAP', name(e.b), '#ffb070', 1.2);
        } else if (h.kind === 'geyser') {
          minorToast('LAUNCHED', name(e.b), '#bfe8ff', 1.2);
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------------- test hooks
  /** Jump straight into the fight at sim time t (used by screenshot tests). */
  debugSeekFight(t: number) {
    if (this.state !== 'fight') this.beginFight();
    this.arena.resetProps();
    for (const e of this.rec.events) if (e.type === 'topple') this.arena.toppleDir.set(Number(e.data?.obs), { dx: Number(e.data?.dx), dz: Number(e.data?.dz) });
    this.playback.seek(Math.max(0, t - 1.5));
    // FX: clear + reseed at the warm-up start; the warm-up below re-spawns the window's effects with their original seeds
    this.fx.seek(this.playback.t);
    this.finFx.clear();
    for (const e of this.projMeshes.values()) this.scene.remove(e.mesh);
    this.projMeshes.clear();
    this.director = new Director(this.rig, this.rec);
    // warm up the views/director for 1.5s of sim at fixed steps
    this.stepFrames(90, 1 / 60);
  }
  /** FX counters: live particles per layer, rings, debris, effects, CPU ms (see docs/fx-api.md). */
  fxStats() {
    return this.fx.stats();
  }
  /** Hash of the live effect list (id, spawn time, seed): same seed + time => same hash. */
  fxHash() {
    return this.fx.hash();
  }
  /** Hash of the full live FX state (every particle's spawn data, rings, debris, light). */
  fxStateHash() {
    return this.fx.stateHash();
  }
  /** Phantom-hit audit (see render/audit.ts). */
  audit(pairs: [string, string][], seeds = 2) {
    return runAudit(this.scene, pairs, seeds);
  }
  /** URL reproducing the current fight moment (fighters, seeds, arena, time) */
  reportUrl(): string {
    const t = this.playback ? Math.max(0, this.playback.t - 1.0) : 0;
    const a = this.arenaSpec;
    return `${location.origin}${location.pathname}?auto=1&a=${this.choice.a}&b=${this.choice.b}&seed=${this.choice.seed}&theme=${a.theme}&layout=${a.layout}&aseed=${a.seed}&t=${t.toFixed(2)}&pause=1`;
  }
  /**
   * Camera readability audit over many matches (see camera/cameraAudit.ts).
   * list: [a, b, seed, theme, layout, aseed]
   */
  async cameraAudit(list: [string, string, number, string, string, number][]): Promise<CamMatchScore[]> {
    const out: CamMatchScore[] = [];
    this.headless = true;
    this.manual = true;
    // the director's cosmetic choices use Math.random: seed it per match so audits are repeatable A/B tests
    const realRandom = Math.random;
    try {
      for (const [a, b, seed, theme, layout, aseed] of list) {
        let st = (seed * 2654435761) >>> 0 || 1;
        Math.random = () => {
          st = (st + 0x6d2b79f5) >>> 0;
          let z = st;
          z = Math.imul(z ^ (z >>> 15), z | 1);
          z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
          return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
        };
        await this.start({ ...this.choice, a, b, seed, skipIntro: true, arena: { theme: theme as ThemeId, layout: layout as LayoutId, seed: aseed } });
        if (this.state !== 'fight') this.beginFight();
        this.realT = 0;
        out.push(auditMatch(this as unknown as Parameters<typeof auditMatch>[0], `${a}-${b}#${seed} ${theme}/${layout}#${aseed}`));
      }
    } finally {
      this.headless = false;
      Math.random = realRandom;
    }
    return out;
  }
  /** Paired-contact audit for finishers (see render/pairAudit.ts). */
  pairAudit(list: [string, string, number, string, string, number][]) {
    return runPairAudit(this.scene, list);
  }
  /** Animation quality audit (see render/animAudit.ts). */
  animAudit(pairs: [string, string][], seeds = 2, opts: { blend?: "inertial" | "xfade"; feet?: boolean; locoRate?: number; locoFull?: number; locoMin?: number } = {}) {
    return runAnimAudit(this.scene, pairs, seeds, opts);
  }
  /** Headless entrance validator (see cinematic/validateEntrances.ts). */
  async validateEntrances(o: { fighters?: string[]; themes?: string[]; layouts?: string[]; gates?: number[] } = {}) {
    await initLib('core', 'entrance');
    const fighters = o.fighters ?? FIGHTERS.map((f) => f.id);
    const assets = await Promise.all(fighters.map((f) => loadCharacter(f)));
    const views: Record<string, FighterView> = {};
    fighters.forEach((f, i) => (views[f] = new FighterView(f, assets[i], this.scene)));
    await Promise.all(Object.values(views).map((v) => v.ready));
    for (const v of this.views) v.rig.root.visible = false;
    const defs = Object.fromEntries(FIGHTERS.map((f) => [f.id, f]));
    const prevState = this.state;
    this.state = 'intro';
    try {
      return await validateEntrances({
        ctx: () => this.ctx(),
        buildArena: async (theme, layout) => {
          this.ensureArena({ theme: theme as ThemeId, layout: layout as LayoutId, seed: 7 });
          return this.arena;
        },
        views,
        defs,
        fighters,
        themes: o.themes ?? THEMES,
        layouts: o.layouts ?? LAYOUTS,
        gates: o.gates,
      });
    } finally {
      for (const v of Object.values(views)) v.dispose(this.scene);
      this.state = prevState;
    }
  }
  /** Test hook: free camera at a pose (renders one frame). */
  debugView(p: [number, number, number], look: [number, number, number], fov = 50) {
    this.freeCam = true;
    this.controls.enabled = false;
    this.camera.position.set(...p);
    this.controls.target.set(...look);
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(...look);
    this.rig.target.set(...look);
    this.stepFrames(1, 1 / 60);
  }
  /** Test hook: average GPU-synced frame time (ms) over n rendered frames. */
  bench(n = 60): { avg: number; p95: number; calls: number; tris: number } {
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    const times: number[] = [];
    this.renderer.info.autoReset = false;
    let calls = 0,
      tris = 0;
    for (let i = 0; i < n; i++) {
      this.renderer.info.reset();
      const t0 = performance.now();
      this.tick(1 / 60);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      times.push(performance.now() - t0);
      calls = this.renderer.info.render.calls;
      tris = this.renderer.info.render.triangles;
    }
    this.renderer.info.autoReset = true;
    times.sort((x, y) => x - y);
    return { avg: +(times.reduce((s, x) => s + x, 0) / n).toFixed(2), p95: +times[Math.floor(n * 0.95)].toFixed(2), calls, tris };
  }
  debugKillTime(): number {
    return this.rec.events.find((e) => e.type === 'kill')?.t ?? this.rec.result.duration;
  }
}

const app = new App();
(window as unknown as { __arena: App }).__arena = app;
(window as unknown as { __audio: typeof audio }).__audio = audio;
(window as unknown as { __THREE: typeof THREE }).__THREE = THREE;
