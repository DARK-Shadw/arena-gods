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
  fade: number; // per-second blend speed
}

export const LOCO = ['idle', 'walk', 'walkBack', 'strafeL', 'strafeR', 'run'] as const;

export class AnimController {
  mixer: THREE.AnimationMixer;
  meta: FighterMeta;
  private layers = new Map<string, Layer>();
  private clips = new Map<string, THREE.AnimationClip>();
  /** Name of the clip currently owning the one-shot slot ('' = locomotion). */
  current = '';
  private oneShotWeight = 0;

  constructor(root: THREE.Object3D, clips: THREE.AnimationClip[], meta: FighterMeta) {
    this.mixer = new THREE.AnimationMixer(root);
    this.meta = meta;
    for (const c of clips) this.clips.set(c.name, c);
  }

  has(name: string) {
    return this.clips.has(name);
  }
  /** add a clip at runtime (shared prop-interaction clips) */
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
   */
  update(
    dt: number,
    req: { name?: string; time?: number; auto?: boolean; fadeIn?: number; fwd: number; side: number; speedScale?: number },
  ) {
    const want = req.name && this.has(req.name) ? req.name : '';
    // --- one-shot slot
    if (want !== this.current) {
      if (this.current) {
        const old = this.layers.get(this.current);
        if (old) {
          old.target = 0;
          old.fade = 10;
        }
      }
      this.current = want;
      if (want) {
        const l = this.layer(want)!;
        l.fade = req.fadeIn ?? 12;
        if (!req.auto) l.weight = Math.min(l.weight, 0.001);
      }
    }
    if (want) {
      const l = this.layer(want)!;
      l.target = 1;
      l.manual = !req.auto;
      if (l.manual) l.time = Math.max(0, Math.min(req.time ?? 0, l.action.getClip().duration - 1e-3));
    }
    const oneTarget = want ? 1 : 0;
    this.oneShotWeight += (oneTarget - this.oneShotWeight) * (1 - Math.exp(-(want ? (req.fadeIn ?? 12) : 8) * dt));

    // --- locomotion weights
    const sc = this.meta.scale;
    const sp = Math.hypot(req.fwd, req.side);
    const loco: Record<string, number> = { idle: 0, walk: 0, walkBack: 0, strafeL: 0, strafeR: 0, run: 0 };
    const moving = Math.min(1, sp / 0.5);
    loco.idle = 1 - moving;
    if (sp > 0.01) {
      const af = Math.abs(req.fwd),
        as = Math.abs(req.side);
      const sum = af + as;
      const runSpeed = this.meta.clips.run?.speed ?? 3;
      const walkSpeed = this.meta.clips.walk?.speed ?? 1.3;
      // forward: walk -> run as speed rises
      const runK = Math.max(0, Math.min(1, (sp - walkSpeed * 1.1) / Math.max(0.3, runSpeed * 0.75 - walkSpeed * 1.1)));
      if (req.fwd >= 0) {
        loco.walk = (af / sum) * moving * (1 - runK);
        loco.run = (af / sum) * moving * runK;
      } else loco.walkBack = (af / sum) * moving;
      if (req.side >= 0) loco.strafeL = (as / sum) * moving;
      else loco.strafeR = (as / sum) * moving;
    }
    const locoScale = 1 - this.oneShotWeight;
    for (const n of LOCO) {
      const w = loco[n] * locoScale;
      const l = this.layer(n);
      if (!l) continue;
      l.manual = false;
      l.target = w;
      l.weight = w; // locomotion weights are already smooth (velocity is smooth)
      const clipSpeed = this.meta.clips[n]?.speed ?? 0;
      if (clipSpeed > 0.05 && n !== 'idle') l.action.timeScale = Math.max(0.5, Math.min(2.2, sp / clipSpeed)) * (req.speedScale ?? 1);
      else l.action.timeScale = req.speedScale ?? 1;
    }

    // --- blend one-shot layers
    let total = 0;
    for (const [n, l] of this.layers) {
      if ((LOCO as readonly string[]).includes(n)) {
        total += l.weight;
        continue;
      }
      if (n === this.current) l.weight = this.oneShotWeight;
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
    this.mixer.update(dt);
    if (this.overlayPose) {
      this.overlayW += (this.overlayTarget - this.overlayW) * Math.min(1, dt * 10);
      // the overlay yields to one-shots (hits, throws...) that own the whole body
      const w = this.overlayW * (1 - this.oneShotWeight);
      if (w > 0.002) for (const [o, q] of this.overlayPose) o.quaternion.slerp(q, w);
    }
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
