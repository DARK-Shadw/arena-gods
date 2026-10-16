/**
 * OFFLINE ASSET PIPELINE (runs in headless Chromium via tools/convert/run.cjs,
 * served by the Vite dev server; source FBX files are routed in from
 * ../Assets under /src-assets/).
 *
 * For every fighter in src/data/animsets.ts:
 *  1. load the Mixamo model FBX, convert Phong -> Standard materials, wait
 *     for embedded textures, mark opaque maps as JPEG
 *  2. load each animation FBX and RETARGET by bone name:
 *       - keep only quaternion tracks for bones the model has
 *       - drop all position tracks except the hips (prevents stretched limbs
 *         on differently proportioned skeletons) and all scale tracks
 *       - hips: lock X/Z to the rest pose (in-place / root motion stripped),
 *         scale Y by modelHipsHeight / animHipsHeight (prevents sinking into
 *         the floor or floating on big/small characters)
 *  3. measure metadata on the retargeted clip: duration, original root speed
 *     (for foot-sync of locomotion), strike time + multi-hit peaks (fastest
 *     hand/foot), so sim windup/active phases can be time-warped onto it
 *  4. locate the weapon tip (farthest weapon vertex from the hand) for trails
 *  5. export one GLB (mesh + skeleton + clips, textures <= 1024px) + JSON meta
 */
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { ANIMSETS } from '../../src/data/animsets';

const loader = new FBXLoader();
const load = (url: string) => new Promise<THREE.Group>((res, rej) => loader.load(url, res, undefined, rej));
const ANIM_HIPS_REF = 100; // Mixamo animation skeleton hips height (cm), measured: 99.8-100.5

export interface ClipMeta {
  dur: number;
  loop: boolean;
  speed: number; // m/s of the original root motion (before stripping), model scale
  dir: [number, number]; // normalized root motion direction (x=left, z=forward)
  strike: number;
  peaks: number[];
  eff: string;
  start: number;
  loopActive: boolean;
  /** strike-point samples [t, x, y, z] in metres, character space (+Z forward, +X left), around the strike */
  reach?: number[][];
}
export interface FighterMeta {
  id: string;
  height: number; // m, after scale
  hipsY: number; // cm
  scale: number;
  weaponTip?: { bone: string; pos: [number, number, number]; base: [number, number, number] };
  clips: Record<string, ClipMeta>;
}

const animCache = new Map<string, THREE.AnimationClip>();
async function loadClip(src: string): Promise<THREE.AnimationClip> {
  if (!animCache.has(src)) {
    const g = await load('/src-assets/' + src);
    const c = g.animations.find((a) => a.duration > 0.05) ?? g.animations[0];
    animCache.set(src, c);
  }
  return animCache.get(src)!;
}

async function waitTextures(root: THREE.Object3D) {
  const maps: THREE.Texture[] = [];
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined;
    if (!m) return;
    for (const x of Array.isArray(m) ? m : [m]) for (const t of [x.map, x.normalMap]) if (t) maps.push(t);
  });
  const t0 = performance.now();
  while (performance.now() - t0 < 15000) {
    if (maps.every((t) => t.image && (t.image.complete === undefined || t.image.complete) && t.image.width > 0)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return maps.filter((t) => !(t.image && t.image.width > 0)).length;
}

/** Downscale texture images in place (colour maps 1024px, normal maps 512px). */
function shrinkTextures(root: THREE.Object3D) {
  const done = new Set<THREE.Texture>();
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined;
    if (!m) return;
    for (const x of Array.isArray(m) ? m : [m])
      for (const [t, max] of [[x.map, 1024], [x.normalMap, 512]] as [THREE.Texture | null, number][]) {
        if (!t || done.has(t) || !t.image) continue;
        done.add(t);
        const img = t.image as HTMLImageElement;
        const k = Math.min(1, max / Math.max(img.width, img.height));
        if (k >= 1) continue;
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        t.image = c;
        t.needsUpdate = true;
      }
  });
}

function toStandard(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isMesh) return;
    const conv = (m: THREE.MeshPhongMaterial) => {
      const s = new THREE.MeshStandardMaterial({
        name: m.name,
        map: m.map ?? null,
        normalMap: m.normalMap ?? null,
        color: m.map ? new THREE.Color(1, 1, 1) : m.color,
        roughness: 0.75,
        metalness: 0.05,
        transparent: false,
        alphaTest: m.transparent || m.alphaMap ? 0.5 : 0,
        side: m.transparent ? THREE.DoubleSide : THREE.FrontSide,
      });
      if (s.map) {
        s.map.colorSpace = THREE.SRGBColorSpace;
        s.map.userData.mimeType = s.alphaTest > 0 ? 'image/png' : 'image/jpeg';
      }
      if (s.normalMap) s.normalMap.userData.mimeType = 'image/jpeg';
      return s;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => conv(m as THREE.MeshPhongMaterial)) : conv(mesh.material as THREE.MeshPhongMaterial);
  });
}

function retarget(src: THREE.AnimationClip, name: string, bones: Set<string>, hipsRest: THREE.Vector3, ratio: number) {
  const tracks: THREE.KeyframeTrack[] = [];
  let speed = 0;
  let dir: [number, number] = [0, 0];
  for (const t of src.tracks) {
    const [node, prop] = t.name.split('.');
    if (!bones.has(node)) continue;
    if (prop === 'scale') continue;
    if (prop === 'position') {
      if (node !== 'mixamorigHips') continue;
      const v = t.values.slice();
      const n = v.length;
      const dx = v[n - 3] - v[0],
        dz = v[n - 1] - v[2];
      const d = Math.hypot(dx, dz);
      speed = ((d * ratio) / 100 / Math.max(0.01, src.duration));
      dir = d > 1 ? [dx / d, dz / d] : [0, 0];
      for (let i = 0; i < n; i += 3) {
        v[i] = hipsRest.x;
        v[i + 1] = v[i + 1] * ratio;
        v[i + 2] = hipsRest.z;
      }
      tracks.push(new THREE.VectorKeyframeTrack(t.name, t.times.slice() as unknown as number[], v as unknown as number[]));
      continue;
    }
    tracks.push(t.clone());
  }
  return { clip: new THREE.AnimationClip(name, src.duration, tracks), speed, dir };
}

/** Sample the striking point (weapon tip or effector) around the strike, in metres. */
function sampleReach(model: THREE.Object3D, clip: THREE.AnimationClip, from: number, to: number, eff: string, tipLocal: THREE.Vector3 | null, scale: number): number[][] {
  const mixer = new THREE.AnimationMixer(model);
  const act = mixer.clipAction(clip);
  act.play();
  const bone = model.getObjectByName('mixamorig' + eff)!;
  const hand = model.getObjectByName('mixamorigRightHand')!;
  const out: number[][] = [];
  const m = (v: number) => +((v / 100) * scale).toFixed(3);
  for (let t = from; t <= to + 1e-6; t += 1 / 30) {
    mixer.setTime(Math.min(t, clip.duration - 1e-3));
    model.updateMatrixWorld(true);
    // effector point, plus (for armed fighters) the weapon tip: [t, ex,ey,ez, wx,wy,wz]
    const p = bone.getWorldPosition(new THREE.Vector3());
    const row = [+t.toFixed(3), m(p.x), m(p.y), m(p.z)];
    if (tipLocal) {
      const w = tipLocal.clone().applyMatrix4(hand.matrixWorld);
      row.push(m(w.x), m(w.y), m(w.z));
    }
    out.push(row);
  }
  act.stop();
  mixer.uncacheRoot(model);
  return out;
}

function measureStrike(model: THREE.Object3D, clip: THREE.AnimationClip, start: number, forceEff?: string) {
  const mixer = new THREE.AnimationMixer(model);
  const act = mixer.clipAction(clip);
  act.play();
  const effs = forceEff ? [forceEff] : ['RightHand', 'LeftHand', 'RightFoot', 'LeftFoot'];
  const objs = effs.map((e) => model.getObjectByName('mixamorig' + e));
  const prev: (THREE.Vector3 | null)[] = effs.map(() => null);
  const speeds: number[][] = effs.map(() => []);
  const dt = 1 / 60;
  const N = Math.floor(clip.duration / dt);
  for (let i = 0; i <= N; i++) {
    mixer.setTime(i * dt);
    model.updateMatrixWorld(true);
    objs.forEach((o, k) => {
      if (!o) return;
      const p = o.getWorldPosition(new THREE.Vector3());
      if (prev[k]) speeds[k].push(p.distanceTo(prev[k]!) / dt);
      prev[k] = p;
    });
  }
  act.stop();
  mixer.uncacheRoot(model);
  const lo = Math.max(Math.floor(start / dt), Math.floor(N * 0.1)),
    hi = Math.floor(N * 0.9);
  let best = { k: 0, i: lo, v: 0 };
  speeds.forEach((s, k) => {
    for (let i = lo; i < Math.min(hi, s.length); i++) if (s[i] > best.v) best = { k, i, v: s[i] };
  });
  const s = speeds[best.k];
  const peaks: number[] = [];
  for (let i = lo + 1; i < Math.min(hi, s.length - 1); i++) {
    const t = (i + 1) * dt;
    if (s[i] > best.v * 0.5 && s[i] >= s[i - 1] && s[i] >= s[i + 1] && (peaks.length === 0 || t - peaks[peaks.length - 1] > 0.18)) peaks.push(+t.toFixed(3));
  }
  return { strike: +((best.i + 1) * dt).toFixed(3), peaks, eff: effs[best.k] };
}

async function convertFighter(id: string) {
  const set = ANIMSETS[id];
  const model = await load('/src-assets/' + set.model);
  model.animations = [];
  toStandard(model);
  const missingTex = await waitTextures(model);
  shrinkTextures(model);
  const bones = new Set<string>();
  model.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.add(o.name);
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
    }
  });
  const hips = model.getObjectByName('mixamorigHips')!;
  const hipsRest = hips.position.clone();
  // world-space hips height in bind pose
  model.updateMatrixWorld(true);
  const hipsY = hips.getWorldPosition(new THREE.Vector3()).y;
  const ratio = hipsY / ANIM_HIPS_REF;

  // Weapon tip: find the mesh skinned (mostly) to the right hand / weapon bone,
  // then take its farthest vertex from the hand, expressed in hand-local space.
  // (Mesh names in the "-w-prop" FBX files are scrambled, so names can't be trusted.)
  let weaponTip: FighterMeta['weaponTip'];
  if (set.weapon) {
    const hand = model.getObjectByName('mixamorigRightHand')!;
    const handW = hand.getWorldPosition(new THREE.Vector3());
    const inv = hand.matrixWorld.clone().invert();
    let best: { mesh: THREE.SkinnedMesh; frac: number } | null = null;
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
      const targets = new Set(m.skeleton.bones.map((b, i) => (/RightHand$|Weapon$|Sword_joint$/.test(b.name) ? i : -1)).filter((i) => i >= 0));
      let hit = 0;
      for (let i = 0; i < si.count; i++) {
        let bi = 0, bw = -1;
        for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > bw) { bw = sw.getComponent(i, k); bi = si.getComponent(i, k); }
        if (targets.has(bi)) hit++;
      }
      const frac = hit / si.count;
      if (frac > 0.7 && (!best || frac > best.frac)) best = { mesh: m, frac };
    });
    if (best) {
      const m = (best as { mesh: THREE.SkinnedMesh }).mesh;
      const pos = m.geometry.attributes.position;
      const v = new THREE.Vector3(), far = new THREE.Vector3();
      let farD = -1;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        const d = v.distanceTo(handW);
        if (d > farD) { farD = d; far.copy(v); }
      }
      const baseW = handW.clone().lerp(far, 0.55);
      weaponTip = { bone: 'mixamorigRightHand', pos: far.applyMatrix4(inv).toArray().map((x) => +x.toFixed(2)) as [number, number, number], base: baseW.applyMatrix4(inv).toArray().map((x) => +x.toFixed(2)) as [number, number, number] };
      console.log(`[convert] ${id}: weapon mesh "${m.name}" (${(((best as { frac: number }).frac) * 100).toFixed(0)}% hand-skinned), length ${(farD / 100).toFixed(2)}m`);
    }
  }

  const clips: THREE.AnimationClip[] = [];
  const meta: FighterMeta = { id, height: 0, hipsY: +hipsY.toFixed(1), scale: set.scale, weaponTip, clips: {} };
  for (const [name, spec] of Object.entries(set.clips)) {
    try {
      const src = await loadClip(spec.src);
      const { clip, speed, dir } = retarget(src, name, bones, hipsRest, ratio);
      clips.push(clip);
      const isMove = !(name in BASE);
      const st = isMove ? measureStrike(model, clip, spec.start ?? 0, spec.eff) : { strike: 0, peaks: [], eff: '' };
      meta.clips[name] = { dur: +clip.duration.toFixed(3), loop: !!spec.loop, speed: +(speed * set.scale).toFixed(3), dir, strike: st.strike, peaks: st.peaks, eff: st.eff, start: spec.start ?? 0, loopActive: !!spec.loopActive };
      if (isMove) {
        const tip = weaponTip ? new THREE.Vector3(...weaponTip.pos) : null;
        const last = st.peaks.length ? Math.max(st.strike, st.peaks[st.peaks.length - 1]) : st.strike;
        meta.clips[name].reach = sampleReach(model, clip, Math.max(spec.start ?? 0, st.strike - 0.2), Math.min(clip.duration - 0.02, last + 0.3), st.eff, tip, set.scale);
      }
    } catch (e) {
      console.log(`[convert] ${id}: clip ${name} (${spec.src}) FAILED: ${(e as Error).message}`);
    }
  }
  // bind-pose height (feet to head top)
  const box = new THREE.Box3().setFromObject(model);
  meta.height = +(((box.max.y - Math.min(0, box.min.y)) / 100) * set.scale).toFixed(2);

  const exporter = new GLTFExporter();
  const glb = (await exporter.parseAsync(model, { binary: true, animations: clips, maxTextureSize: 1024, onlyVisible: false })) as ArrayBuffer;
  const b64 = arrayBufferToBase64(glb);
  const base = `C:/Programming/GameDev/Research/arena/public/models/${id}`;
  await (window as unknown as { saveFile: (n: string, b: string) => Promise<boolean> }).saveFile(`${base}.glb`, b64);
  await (window as unknown as { saveFile: (n: string, b: string) => Promise<boolean> }).saveFile(`${base}.json`, btoa(unescape(encodeURIComponent(JSON.stringify(meta, null, 1)))));
  return { id, bytes: glb.byteLength, clips: clips.length, missingTex, hipsY: meta.hipsY, height: meta.height, weaponTip };
}

const BASE: Record<string, true> = Object.fromEntries(
  ['idle', 'walk', 'walkBack', 'strafeL', 'strafeR', 'run', 'block', 'blockHit', 'hitFront', 'hitLeft', 'hitRight', 'hitBack', 'death', 'getup', 'crouch', 'winded', 'taunt', 'roar', 'dodgeBack', 'dodgeLeft', 'dodgeRight', 'fall', 'land'].map((k) => [k, true]),
);

function arrayBufferToBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Survey a raw clip (used to build the clip table in the README). */
async function survey(file: string) {
  const c = await loadClip(file);
  return { file, dur: c.duration };
}

(window as any).convertFighter = convertFighter;
(window as any).survey = survey;
(window as any).THREE = THREE;
(window as any).loadFBX = load;
(window as any).ready = true;
