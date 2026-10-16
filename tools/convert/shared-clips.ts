/**
 * Convert a handful of shared prop-interaction clips (pick-up / carry / throw)
 * from Assets/Animations/Mixamo_HF/grabs_throws into a compact JSON that the
 * runtime retargets onto every fighter (rotations only; hips height scaled by
 * the fighter's hips height, root motion locked in place).
 *
 *   npx tsx tools/convert/shared-clips.ts            # runs FBXLoader in Node
 *
 * Output: public/models/shared_clips.json  { clips: { name: {dur, release?, tracks} } }
 * plus a measured release frame (fastest right-hand moment) for throw clips,
 * which the sim uses to time the prop release.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const SRC = 'C:/Programming/GameDev/Research/Assets/Animations/Mixamo_HF/grabs_throws';
const OUT = path.resolve('public/models/shared_clips.json');
const CLIPS: Record<string, string> = {
  // one Mixamo clip covers the whole interaction: crouch+grab (~1.0s), chest hold (~1.9s), overhead throw (release ~2.38s)
  throw_object: 'Throw_Object.fbx',
};

// FBXLoader touches a couple of DOM globals when textures are present; animation FBXs have none
(globalThis as any).self ??= globalThis;
(globalThis as any).window ??= globalThis;

const q = (v: number) => Math.round(v * 1e4) / 1e4;

function load(file: string): THREE.Group {
  const buf = fs.readFileSync(path.join(SRC, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new FBXLoader().parse(ab, '');
}

function measureRelease(root: THREE.Group, clip: THREE.AnimationClip) {
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  const hand = root.getObjectByName('mixamorigRightHand');
  const hips = root.getObjectByName('mixamorigHips');
  if (!hand || !hips) return { release: 0, peakSpeed: 0, handY: [] as number[] };
  let prev: THREE.Vector3 | null = null;
  let best = { t: 0, v: 0 };
  const handY: number[] = [];
  const dt = 1 / 60;
  for (let t = 0; t <= clip.duration; t += dt) {
    mixer.setTime(t);
    root.updateMatrixWorld(true);
    const p = hand.getWorldPosition(new THREE.Vector3());
    handY.push(+(p.y / 100).toFixed(2));
    if (prev) {
      const v = p.distanceTo(prev) / dt;
      if (t > clip.duration * 0.15 && t < clip.duration * 0.9 && v > best.v) best = { t, v };
    }
    prev = p;
  }
  return { release: +best.t.toFixed(3), peakSpeed: +(best.v / 100).toFixed(2), handY };
}

const out: Record<string, unknown> = {};
for (const [name, file] of Object.entries(CLIPS)) {
  const g = load(file);
  const clip = g.animations.find((a) => a.duration > 0.05) ?? g.animations[0];
  const hips = g.getObjectByName('mixamorigHips')!;
  g.updateMatrixWorld(true);
  const hipsRestY = hips.getWorldPosition(new THREE.Vector3()).y;
  const meas = measureRelease(g, clip);
  const tracks: { n: string; t: number[]; v: number[] }[] = [];
  for (const t of clip.tracks) {
    const [node, prop] = t.name.split('.');
    if (prop === 'scale') continue;
    if (prop === 'position' && node !== 'mixamorigHips') continue;
    if (!node.startsWith('mixamorig')) continue;
    let v = Array.from(t.values);
    if (prop === 'position') {
      // keep only height, normalised to a 100cm hips skeleton; X/Z come from the fighter's rest pose
      const n = v.length;
      const y: number[] = [];
      for (let i = 0; i < n; i += 3) y.push(q((v[i + 1] / hipsRestY) * 100));
      tracks.push({ n: 'mixamorigHips.hipsY', t: Array.from(t.times).map(q), v: y });
      continue;
    }
    v = v.map(q);
    tracks.push({ n: t.name, t: Array.from(t.times).map(q), v });
  }
  out[name] = { file, dur: +clip.duration.toFixed(3), release: meas.release, peakSpeed: meas.peakSpeed, tracks };
  console.log(`${name}: ${file} dur ${clip.duration.toFixed(2)}s tracks ${tracks.length} release@${meas.release}s (${meas.peakSpeed} m/s) handY ${meas.handY.filter((_, i) => i % 6 === 0).join(' ')}`);
}
fs.writeFileSync(OUT, JSON.stringify({ src: 'Assets/Animations/Mixamo_HF/grabs_throws', clips: out }));
console.log('wrote', OUT, (fs.statSync(OUT).size / 1024).toFixed(0) + 'KB');
