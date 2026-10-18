/**
 * Mixamo character runtime: GLB loading (meshopt-compressed, produced by
 * tools/convert) and an AnimationMixer-based controller.
 *
 * The controller blends three kinds of layers, always normalised to a total
 * weight of 1 so the skeleton never drifts toward the bind/T-pose:
 *  - locomotion: idle / walk / walkBack / strafeL / strafeR / run, weighted
 *    by local velocity; playback rate = ground speed / clip root speed (no
 *    foot sliding)
 *  - "manual" one-shots whose clip time is computed every frame from the
 *    sim state (attacks are time-warped so the clip's strike moment lands on
 *    the sim's active window; knockdown/death/dodges/hits by state time).
 *    Because time comes from the sim clock, slow-mo and hit-stop just work.
 *  - "auto" loops (block, winded, crouch, fall).
 * Switching one-shots cross-fades (the old clip freezes and fades out).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { FootLock, Inertializer, PhaseMatcher, SpringFlinch } from './poseFx';

export interface ClipMeta {
  dur: number;
  loop: boolean;
  speed: number;
  dir: [number, number];
  strike: number;
  peaks: number[];
  eff: string;
  start: number;
  loopActive: boolean;
}
export interface FighterMeta {
  id: string;
  height: number;
  hipsY: number;
  scale: number;
  weaponTip?: { bone: string; pos: [number, number, number]; base: [number, number, number] };
  clips: Record<string, ClipMeta>;
}
export interface CharAsset {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
  meta: FighterMeta;
}

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const cache: Record<string, Promise<CharAsset>> = {};

export function loadCharacter(id: string): Promise<CharAsset> {
  if (!cache[id]) {
    const base = `${import.meta.env.BASE_URL}models/${id}`;
    cache[id] = Promise.all([loader.loadAsync(`${base}.glb`), fetch(`${base}.json`).then((r) => r.json() as Promise<FighterMeta>)]).then(([gltf, meta]) => ({
      scene: gltf.scene,
      clips: gltf.animations,
      meta,
    }));
  }
  return cache[id];
}

/** Create an independent instance (skinned meshes need SkeletonUtils.clone). */
export function instantiate(asset: CharAsset): THREE.Object3D {
  const obj = SkeletonUtils.clone(asset.scene);
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats as THREE.MeshStandardMaterial[]) {
        mat.envMapIntensity = 0.6;
        if (mat.map) mat.map.anisotropy = 4;
      }
    }
  });
  return obj;
}

interface Layer {
  action: THREE.AnimationAction;
  weight: number;
  target: number;
  manual: boolean;
  time: number;
  fade: number; // per-second blend speed (crossfade mode)
}

export const LOCO = ['idle', 'walk', 'walkBack', 'strafeL', 'strafeR', 'run'] as const;

/** Clip categories for the transition table. */
export type AnimCat = 'loco' | 'attack' | 'hit' | 'block' | 'dodge' | 'knockdown' | 'getup' | 'death' | 'launch' | 'taunt' | 'carry' | 'scene' | 'cine' | 'other';

/**
 * Transition table (inertialization blend time, seconds) - data, not code.
 * Hit reactions are snappy so the flinch starts on the contact frame; returns
 * to locomotion are longer and phase-matched.
 */
export const TRANSITIONS: Record<string, number> = {
  '*>hit': 0.09,
  '*>launch': 0.07,
  '*>death': 0.1,
  '*>knockdown': 0.1,
  'knockdown>getup': 0.16,
  'launch>getup': 0.16,
  'attack>attack': 0.1,
  'loco>attack': 0.12,
  'block>attack': 0.1,
  '*>attack': 0.14,
  '*>dodge': 0.1,
  'attack>loco': 0.26,
  'hit>loco': 0.24,
  'dodge>loco': 0.22,
  'getup>loco': 0.28,
  'block>loco': 0.18,
  'loco>block': 0.14,
  '*>scene': 0.2,
  'scene>*': 0.25,
  '*>loco': 0.24,
  '*>*': 0.18,
};
export function blendTime(from: AnimCat, to: AnimCat): number {
  return TRANSITIONS[`${from}>${to}`] ?? TRANSITIONS[`*>${to}`] ?? TRANSITIONS[`${from}>*`] ?? TRANSITIONS['*>*'];
}

/** 'inertial' (default) or the legacy normalised cross-fade ('xfade', for A/B comparisons: ?blend=xfade). */
export let BLEND_MODE: 'inertial' | 'xfade' = typeof location !== 'undefined' && new URLSearchParams(location.search).get('blend') === 'xfade' ? 'xfade' : 'inertial';
export function setBlendMode(m: 'inertial' | 'xfade') {
  BLEND_MODE = m;
}

/** highest locomotion playback rate (stride keeps up with fast sim movement instead of skating); ?locorate= to compare */
/** speed (m/s) at which the locomotion cycle takes over fully from idle, and the slowest cycle rate (A/B: ?locofull= / ?locomin=) */
const _q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
export let LOCO_FULL_AT = Number(_q?.get('locofull') ?? 0.5);
export let LOCO_MIN_RATE = Number(_q?.get('locomin') ?? 0.5);
export function setLocoBlend(fullAt: number, minRate: number) {
  LOCO_FULL_AT = fullAt;
  LOCO_MIN_RATE = minRate;
}
export let LOCO_MAX_RATE = typeof location !== 'undefined' && new URLSearchParams(location.search).get('locorate') ? Number(new URLSearchParams(location.search).get('locorate')) : 2.2;
export function setLocoMaxRate(r: number) {
  LOCO_MAX_RATE = r;
}
/** foot locking on/off (?feet=0 to compare) */
export let FOOT_LOCK = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('feet') !== '0' : true;
export function setFootLock(on: boolean) {
  FOOT_LOCK = on;
}

export interface AnimRequest {
  name?: string;
  time?: number;
  auto?: boolean;
  /** legacy cross-fade speed (per second) */
  fadeIn?: number;
  /** category for the transition table */
  cat?: AnimCat;
  /** same clip restarted (new attack id) */
  restart?: boolean;
  fwd: number;
  side: number;
  speedScale?: number;
}

export class AnimController {
  mixer: THREE.AnimationMixer;
  meta: FighterMeta;
  private layers = new Map<string, Layer>();
  private clips = new Map<string, THREE.AnimationClip>();
  /** Name of the clip currently owning the one-shot slot ('' = locomotion). */
  current = '';
  private oneShotWeight = 0;
  private curCat: AnimCat = 'loco';
  private lastTime = 0;
  readonly root: THREE.Object3D;
  inert: Inertializer;
  flinch: SpringFlinch;
  phase: PhaseMatcher;
  feet: FootLock;
  /** metrics: transitions handled */
  transitions = 0;
  /** shared normalised locomotion phase (sync group) */
  private locoPhase = 0;
  /** true on frames where a transition started (metrics) */
  justTransitioned = false;
  private rest: [THREE.Object3D, THREE.Quaternion, THREE.Vector3 | null][] = [];

  constructor(root: THREE.Object3D, clips: THREE.AnimationClip[], meta: FighterMeta, rng?: () => number) {
    this.root = root;
    this.mixer = new THREE.AnimationMixer(root);
    this.meta = meta;
    for (const c of clips) this.clips.set(c.name, c);
    this.inert = new Inertializer(root);
    // the mixer only writes a bone when its sampled value CHANGED (three.js PropertyMixer), so a paused /
    // frozen clip would leave last frame's post-processing (inertial offsets, IK, springs) on the bones and
    // it would compound every frame. Each update therefore starts from the mixer's own previous output.
    for (const bn of this.inert.bones) this.rest.push([bn, bn.quaternion.clone(), /Hips$/.test(bn.name) ? bn.position.clone() : null]);
    this.flinch = new SpringFlinch(root, rng);
    this.phase = new PhaseMatcher(root);
    this.feet = new FootLock(root);
  }

  has(name: string) {
    return this.clips.has(name);
  }
  clip(name: string): THREE.AnimationClip | null {
    return this.clips.get(name) ?? null;
  }
  /** add a clip at runtime (shared prop-interaction clips, library clips) */
  addClip(clip: THREE.AnimationClip, dur?: number) {
    this.clips.set(clip.name, clip);
    if (dur !== undefined) this.meta.clips[clip.name] = { dur, loop: false, speed: 0, dir: [0, 0], strike: 0, peaks: [], eff: '', start: 0, loopActive: false };
  }

  /**
   * Masked pose overlay applied after the mixer (e.g. carrying a prop: arms and
   * spine take a hold pose while the legs keep their locomotion).
   */
  private overlayPose: Map<THREE.Object3D, THREE.Quaternion> | null = null;
  private overlayW = 0;
  overlayTarget = 0;
  setOverlayPose(root: THREE.Object3D, clip: THREE.AnimationClip, time: number, bones: RegExp) {
    const pose = new Map<THREE.Object3D, THREE.Quaternion>();
    for (const tr of clip.tracks) {
      const [node, prop] = tr.name.split('.');
      if (prop !== 'quaternion' || !bones.test(node)) continue;
      const obj = root.getObjectByName(node);
      if (!obj) continue;
      const v = tr.createInterpolant().evaluate(time);
      pose.set(obj, new THREE.Quaternion(v[0], v[1], v[2], v[3]));
    }
    this.overlayPose = pose;
  }
  dur(name: string) {
    return this.meta.clips[name]?.dur ?? this.clips.get(name)?.duration ?? 1;
  }

  private layer(name: string): Layer | null {
    let l = this.layers.get(name);
    if (!l) {
      const clip = this.clips.get(name);
      if (!clip) return null;
      const action = this.mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
      action.setEffectiveWeight(0);
      l = { action, weight: 0, target: 0, manual: false, time: 0, fade: 8 };
      this.layers.set(name, l);
    }
    return l;
  }

  /**
   * Set this frame's pose request.
   * one-shot: { name, time } with manual time, or { name, auto: true } for a loop.
   * locomotion: local velocity (m/s) fwd/side (side > 0 = moving left).
   * dt = animation (sim) time; realDt = wall time (springs keep moving during hit-stop).
   */
  update(dt: number, req: AnimRequest, realDt = dt) {
    const want = req.name && this.has(req.name) ? req.name : '';
    const cat: AnimCat = want ? (req.cat ?? 'other') : 'loco';
    const inertial = BLEND_MODE === 'inertial';
    // ---- transition detection (new clip, restart of the same clip, time jump back)
    let transition = want !== this.current;
    if (!transition && want && !req.auto && req.time !== undefined && (req.restart || req.time < this.lastTime - 0.2)) transition = true;
    const fromCat = this.curCat;
    // --- one-shot slot
    if (want !== this.current) {
      if (this.current) {
        const old = this.layers.get(this.current);
        if (old) {
          old.target = 0;
          old.fade = 10;
          if (inertial) old.weight = 0;
        }
      }
      // entering locomotion: enter the shared cycle at the phase matching the current stance
      if (!want && inertial) {
        const l = this.layer('walk');
        if (l) {
          const c = l.action.getClip();
          this.locoPhase = (((this.phase.match(c) - this.phase.offset(c)) / c.duration) % 1 + 1) % 1;
        }
      }
      this.current = want;
      if (want) {
        const l = this.layer(want)!;
        l.fade = req.fadeIn ?? 12;
        if (!req.auto) l.weight = Math.min(l.weight, 0.001);
        if (inertial) l.weight = 1;
      }
    }
    if (want) {
      const l = this.layer(want)!;
      l.target = 1;
      l.manual = !req.auto;
      if (l.manual) l.time = Math.max(0, Math.min(req.time ?? 0, l.action.getClip().duration - 1e-3));
      this.lastTime = req.time ?? 0;
    }
    this.curCat = cat;
    const oneTarget = want ? 1 : 0;
    if (inertial) this.oneShotWeight = oneTarget;
    else this.oneShotWeight += (oneTarget - this.oneShotWeight) * (1 - Math.exp(-(want ? (req.fadeIn ?? 12) : 8) * dt));

    // --- locomotion weights
    const sp = Math.hypot(req.fwd, req.side);
    const loco: Record<string, number> = { idle: 0, walk: 0, walkBack: 0, strafeL: 0, strafeR: 0, run: 0 };
    const moving = Math.min(1, sp / LOCO_FULL_AT);
    loco.idle = 1 - moving;
    if (sp > 0.01) {
      const af = Math.abs(req.fwd),
        as = Math.abs(req.side);
      const sum = af + as;
      const runSpeed = this.meta.clips.run?.speed ?? 3;
      const walkSpeed = this.meta.clips.walk?.speed ?? 1.3;
      const runK = Math.max(0, Math.min(1, (sp - walkSpeed * 1.1) / Math.max(0.3, runSpeed * 0.75 - walkSpeed * 1.1)));
      if (req.fwd >= 0) {
        loco.walk = (af / sum) * moving * (1 - runK);
        loco.run = (af / sum) * moving * runK;
      } else loco.walkBack = (af / sum) * moving;
      if (req.side >= 0) loco.strafeL = (as / sum) * moving;
      else loco.strafeR = (as / sum) * moving;
    }
    const locoScale = 1 - this.oneShotWeight;
    // SYNC GROUP: all moving cycles share one normalised phase (left foot forward = 0),
    // so blended walk / strafe / run feet stay in step instead of mushing.
    let rate = 0,
      wsum = 0;
    for (const n of LOCO) {
      const w = loco[n] * locoScale;
      const l = this.layer(n);
      if (!l) continue;
      l.target = w;
      l.weight = w;
      const clipSpeed = this.meta.clips[n]?.speed ?? 0;
      const ts = (clipSpeed > 0.05 && n !== 'idle' ? Math.max(LOCO_MIN_RATE, Math.min(LOCO_MAX_RATE, sp / clipSpeed)) : 1) * (req.speedScale ?? 1);
      l.action.timeScale = ts;
      if (n === 'idle' || BLEND_MODE !== 'inertial') {
        l.manual = false;
        continue;
      }
      l.manual = true;
      if (w > 0) {
        rate += (w * ts) / l.action.getClip().duration;
        wsum += w;
      }
    }
    if (wsum > 0) this.locoPhase = (this.locoPhase + (rate / wsum) * dt) % 1;
    if (BLEND_MODE === 'inertial')
      for (const n of LOCO) {
        if (n === 'idle') continue;
        const l = this.layers.get(n);
        if (!l) continue;
        const c = l.action.getClip();
        l.time = (this.phase.offset(c) + this.locoPhase * c.duration) % c.duration;
      }

    // --- blend one-shot layers
    let total = 0;
    for (const [n, l] of this.layers) {
      if ((LOCO as readonly string[]).includes(n)) {
        total += l.weight;
        continue;
      }
      if (n === this.current) l.weight = this.oneShotWeight;
      else if (inertial) l.weight = 0;
      else l.weight += (0 - l.weight) * (1 - Math.exp(-l.fade * dt));
      if (l.weight < 0.002 && n !== this.current) l.weight = 0;
      total += l.weight;
    }
    const norm = total > 1e-4 ? 1 / total : 1;
    for (const [n, l] of this.layers) {
      const w = total > 1e-4 ? l.weight * norm : n === 'idle' ? 1 : 0;
      l.action.setEffectiveWeight(w);
      l.action.enabled = w > 0;
      if (l.manual) {
        l.action.paused = true;
        l.action.time = l.time;
      } else l.action.paused = false;
    }
    for (const [bn, q, p] of this.rest) {
      bn.quaternion.copy(q);
      if (p) bn.position.copy(p);
    }
    this.mixer.update(dt);
    for (const [bn, q, p] of this.rest) {
      q.copy(bn.quaternion);
      if (p) p.copy(bn.position);
    }
    if (this.overlayPose) {
      this.overlayW += (this.overlayTarget - this.overlayW) * Math.min(1, dt * 10);
      // the overlay yields to one-shots (hits, throws...) that own the whole body
      const w = this.overlayW * (1 - this.oneShotWeight);
      if (w > 0.002) for (const [o, q] of this.overlayPose) o.quaternion.slerp(q, w);
    }
    // --- inertialization (post-process) + spring additives
    this.justTransitioned = transition;
    if (transition) {
      this.transitions++;
      if (inertial) this.inert.begin(blendTime(fromCat, cat));
    }
    this.inert.apply(dt);
    // foot locking only where feet are meant to stand: locomotion / guard / idle-like states
    this.feet.update(dt, this.root, FOOT_LOCK && !want ? true : FOOT_LOCK && (cat === 'block' || cat === 'attack' || cat === 'taunt' || cat === 'carry'));
    this.flinch.update(realDt, this.root);
    this.phase.track();
  }
}

// ------------------------------------------------------------------ shared clips (props)
interface SharedClipJSON {
  clips: Record<string, { dur: number; release: number; tracks: { n: string; t: number[]; v: number[] }[] }>;
}
let shared: Promise<SharedClipJSON> | null = null;
export function loadSharedClips(): Promise<SharedClipJSON> {
  if (!shared) shared = fetch(`${import.meta.env.BASE_URL}models/shared_clips.json`).then((r) => r.json() as Promise<SharedClipJSON>);
  return shared;
}
/**
 * Retarget a shared clip onto a fighter: rotations as-is (Mixamo bone names),
 * hips height scaled to the fighter's hips height, hips X/Z locked to its rest pose.
 */
export function buildSharedClip(data: SharedClipJSON, name: string, model: THREE.Object3D, meta: FighterMeta): THREE.AnimationClip | null {
  const c = data.clips[name];
  if (!c) return null;
  const hips = model.getObjectByName('mixamorigHips');
  const tracks: THREE.KeyframeTrack[] = [];
  for (const tr of c.tracks) {
    if (tr.n === 'mixamorigHips.hipsY') {
      if (!hips) continue;
      const v: number[] = [];
      for (const y of tr.v) v.push(hips.position.x, (y / 100) * meta.hipsY, hips.position.z);
      tracks.push(new THREE.VectorKeyframeTrack('mixamorigHips.position', tr.t, v));
      continue;
    }
    const node = tr.n.split('.')[0];
    if (!model.getObjectByName(node)) continue;
    tracks.push(new THREE.QuaternionKeyframeTrack(tr.n, tr.t, tr.v));
  }
  return new THREE.AnimationClip(name, c.dur, tracks);
}
