/**
 * Runtime side of the shared animation library (tools/anim/build-lib.ts):
 * loads public/anim/index.json + <lib>.bin on demand and builds THREE
 * AnimationClips retargeted onto a given fighter model (Mixamo bone names,
 * hips height scaled to the model, hips XZ = rest + residual sway; the travel
 * lives in a separate ROOT curve that the sim / entrance system consumes).
 */
import * as THREE from 'three';

export interface LibIndexClip {
  id: string;
  lib: string;
  role: string;
  tags: string[];
  src: string;
  mirrorOf?: string;
  fps: number;
  n: number;
  off: number;
  bones: number[]; // nameIdx*2 + static
  origin?: [number, number, number];
  meta: {
    dur: number;
    posture: [string, string];
    groundT: number;
    apexT: number;
    lift: number;
    startFace: string;
    endFace: string;
    travel: [number, number];
    from?: string;
    sev?: number;
    height?: string;
    impactT?: number;
    dir?: string;
    trim: [number, number, number];
  };
}
interface LibIndex {
  fps: number;
  boneNames: string[];
  clips: LibIndexClip[];
}

let indexP: Promise<LibIndex> | null = null;
const binP: Record<string, Promise<Int16Array>> = {};
const byId = new Map<string, LibIndexClip>();
const base = () => (typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.BASE_URL : '/');

export function loadLibIndex(): Promise<LibIndex> {
  if (!indexP)
    indexP = fetch(`${base()}anim/index.json`)
      .then((r) => r.json() as Promise<LibIndex>)
      .then((ix) => {
        for (const c of ix.clips) byId.set(c.id, c);
        return ix;
      });
  return indexP;
}
export function loadLib(lib: string): Promise<Int16Array> {
  if (!binP[lib])
    binP[lib] = fetch(`${base()}anim/${lib}.bin`)
      .then((r) => r.arrayBuffer())
      .then((b) => new Int16Array(b));
  return binP[lib];
}
export function libClip(id: string): LibIndexClip | undefined {
  return byId.get(id);
}
export function libReady(lib: string): boolean {
  return !!loaded[lib];
}
const loaded: Record<string, Int16Array> = {};
/** Preload index + the named bundles; resolves when they can be used synchronously. */
export async function preloadLibs(...libs: string[]): Promise<void> {
  const ix = await loadLibIndex();
  void ix;
  await Promise.all(libs.map(async (l) => (loaded[l] = await loadLib(l))));
}

/** decoded (model-independent) clip: per-bone float quats + hips/root curves in hips units */
export interface DecodedClip {
  id: string;
  dur: number;
  fps: number;
  n: number;
  times: Float32Array;
  bones: { name: string; q: Float32Array; static: boolean }[];
  hips: Float32Array; // n*3
  root: Float32Array; // n*3 (x, z, yaw)
  info: LibIndexClip;
}
const decodedCache = new Map<string, DecodedClip>();
let indexSync: LibIndex | null = null;

export function decodeClip(id: string): DecodedClip | null {
  const hit = decodedCache.get(id);
  if (hit) return hit;
  const c = byId.get(id);
  if (!c || !indexP) return null;
  const bin = loaded[c.lib];
  if (!bin) return null;
  const names = indexSync?.boneNames;
  if (!names) return null;
  let p = c.off;
  const n = c.n;
  const times = new Float32Array(n);
  for (let i = 0; i < n; i++) times[i] = i / c.fps;
  const bones: DecodedClip['bones'] = [];
  for (const b of c.bones) {
    const name = names[b >> 1];
    const st = (b & 1) === 1;
    const frames = st ? 1 : n;
    const q = new Float32Array(frames * 4);
    for (let i = 0; i < frames * 4; i += 4) {
      let x = bin[p++] / 32767,
        y = bin[p++] / 32767,
        z = bin[p++] / 32767,
        w = bin[p++] / 32767;
      const l = Math.hypot(x, y, z, w) || 1;
      x /= l;
      y /= l;
      z /= l;
      w /= l;
      q[i] = x;
      q[i + 1] = y;
      q[i + 2] = z;
      q[i + 3] = w;
    }
    bones.push({ name, q, static: st });
  }
  const hips = new Float32Array(n * 3),
    root = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    hips[i * 3] = bin[p++] / 1000;
    hips[i * 3 + 1] = bin[p++] / 1000;
    hips[i * 3 + 2] = bin[p++] / 1000;
    root[i * 3] = bin[p++] / 1000;
    root[i * 3 + 1] = bin[p++] / 1000;
    root[i * 3 + 2] = bin[p++] / 1000;
  }
  const d: DecodedClip = { id, dur: (n - 1) / c.fps, fps: c.fps, n, times, bones, hips, root, info: c };
  decodedCache.set(id, d);
  return d;
}
/** Load the index and the named bundles; afterwards clips decode synchronously. */
export async function initLib(...libs: string[]) {
  indexSync = await loadLibIndex();
  await preloadLibs(...libs);
}
export function libIndexSync() {
  return indexSync;
}

/** Root curve sample (hips units, clip frame: +Z forward, +X left) at time t. */
export function rootAt(d: DecodedClip, t: number, out = { x: 0, z: 0, yaw: 0 }) {
  const f = Math.max(0, Math.min(d.n - 1, t * d.fps));
  const i = Math.floor(f),
    j = Math.min(d.n - 1, i + 1),
    k = f - i;
  out.x = d.root[i * 3] + (d.root[j * 3] - d.root[i * 3]) * k;
  out.z = d.root[i * 3 + 1] + (d.root[j * 3 + 1] - d.root[i * 3 + 1]) * k;
  out.yaw = d.root[i * 3 + 2] + (d.root[j * 3 + 2] - d.root[i * 3 + 2]) * k;
  return out;
}
/** hips height (hips units) at time t */
export function hipsYAt(d: DecodedClip, t: number) {
  const f = Math.max(0, Math.min(d.n - 1, t * d.fps));
  const i = Math.floor(f),
    j = Math.min(d.n - 1, i + 1),
    k = f - i;
  return d.hips[i * 3 + 1] + (d.hips[j * 3 + 1] - d.hips[i * 3 + 1]) * k;
}

/**
 * Retarget a library clip onto a model.
 * mode 'inplace' (default): hips XZ = rest + residual sway (travel removed);
 * mode 'root': hips XZ follow the full path (lab / root-motion preview).
 */
const modelCache = new WeakMap<THREE.Object3D, Map<string, THREE.AnimationClip>>();
export function buildLibClip(id: string, model: THREE.Object3D, hipsCm: number, mode: 'inplace' | 'root' = 'inplace', name = 'lib:' + id): THREE.AnimationClip | null {
  let cache = modelCache.get(model);
  if (!cache) modelCache.set(model, (cache = new Map()));
  const key = id + '|' + mode;
  const hit = cache.get(key);
  if (hit) return hit;
  const d = decodeClip(id);
  if (!d) return null;
  let prefix = 'mixamorig';
  let hipsBone: THREE.Object3D | undefined;
  model.traverse((o) => {
    if (!hipsBone && (o as THREE.Bone).isBone && /Hips$/.test(o.name)) {
      hipsBone = o;
      prefix = o.name.slice(0, -4);
    }
  });
  const tracks: THREE.KeyframeTrack[] = [];
  const t2 = new Float32Array([0, d.dur]);
  for (const b of d.bones) {
    const node = prefix + b.name;
    if (!model.getObjectByName(node)) continue;
    if (b.static) {
      const v = new Float32Array(8);
      v.set(b.q, 0);
      v.set(b.q, 4);
      tracks.push(new THREE.QuaternionKeyframeTrack(node + '.quaternion', t2 as unknown as number[], v as unknown as number[]));
    } else tracks.push(new THREE.QuaternionKeyframeTrack(node + '.quaternion', d.times as unknown as number[], b.q as unknown as number[]));
  }
  if (hipsBone) {
    const rest = hipsBone.userData.restPos ?? (hipsBone.userData.restPos = hipsBone.position.clone());
    const v = new Float32Array(d.n * 3);
    for (let i = 0; i < d.n; i++) {
      const hx = d.hips[i * 3],
        hy = d.hips[i * 3 + 1],
        hz = d.hips[i * 3 + 2];
      const ox = mode === 'root' ? hx : hx - d.root[i * 3];
      const oz = mode === 'root' ? hz : hz - d.root[i * 3 + 1];
      v[i * 3] = rest.x + ox * hipsCm;
      v[i * 3 + 1] = hy * hipsCm;
      v[i * 3 + 2] = rest.z + oz * hipsCm;
    }
    tracks.push(new THREE.VectorKeyframeTrack(hipsBone.name + '.position', d.times as unknown as number[], v as unknown as number[]));
  }
  const clip = new THREE.AnimationClip(name, d.dur, tracks);
  cache.set(key, clip);
  return clip;
}

/** All library clip ids with a given role (after initLib). */
export function libIds(role?: string): string[] {
  return (indexSync?.clips ?? []).filter((c) => !role || c.role === role).map((c) => c.id);
}
