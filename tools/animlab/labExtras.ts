/**
 * Extra Animation Lab modes:
 *  - PAIR / SCENE mode: plays both roles of a solved paired scene (src/sim/scenes.gen.ts)
 *    in the scene frame on two fighters, with contact markers and live effector -> body
 *    distances, so alignment can be judged by eye.  __lab.pairScene('vampire_kiss', 'vex', 'aldric')
 */
import * as THREE from 'three';
import { SCENES } from '../../src/sim/scenes.gen';
import { buildLibClip } from '../../src/render/animLib';
import { FinisherFx, headSplitStats, type FinFx, type GoreLevel } from '../../src/render/finisherFx';
import { VFX } from '../../src/render/vfx';
import { parseGore } from '../../src/render/fx/fxSettings';

interface LabApi {
  actors: ({ model: THREE.Object3D; root: THREE.Group; mixer: THREE.AnimationMixer; action: THREE.AnimationAction | null; dur: number; hipsCm: number; hipsM: number; base: THREE.Vector3; clipName: string; decoded: unknown; fid: string } | null)[];
  show: (a: string, clip: string, b?: string, clipB?: string) => Promise<void>;
  pairScene?: (id: string, a: string, b: string) => Promise<void>;
  sceneIds?: string[];
  contactNow?: () => { t: number; best: number; eff: string };
  scene3?: THREE.Scene;
  renderer?: THREE.WebGLRenderer;
  seek?: (t: number) => void;
  fxDemo?: (kind: FinFx, gore: GoreLevel, steps: number) => Promise<string>;
  fxReset?: () => void;
  splitStats?: () => ReturnType<typeof headSplitStats> | null;
}

const rot = (x: number, z: number, a: number): [number, number] => [x * Math.cos(a) + z * Math.sin(a), -x * Math.sin(a) + z * Math.cos(a)];

export function attachLab(api: LabApi & { scene: THREE.Scene; renderer: THREE.WebGLRenderer; seek: (t: number) => void }) {
  // ---- finisher FX on actor A (posed at the current time): __lab.fxDemo('behead', 'full', 30)
  const vfx = new VFX();
  api.scene.add(vfx.group);
  api.renderer.localClippingEnabled = true;
  let fx: FinisherFx | null = null;
  api.fxReset = () => {
    fx?.clear();
    fx = null;
  };
  api.fxDemo = async (kind, gore, steps) => {
    api.fxReset!();
    fx = new FinisherFx(api.scene, vfx);
    fx.gore = parseGore(gore) ?? gore; // 'stylised' is the old name of 'standard'
    const A = api.actors[0]!;
    A.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(A.model);
    const c = box.getCenter(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0.35, 1, 0.2).normalize(), c);
    const shown = fx.play(kind, A.model, { plane, at: c, dir: new THREE.Vector3(1, 0, 0) });
    for (let i = 0; i < steps; i++) {
      fx.update(1 / 30);
      vfx.update(1 / 30);
    }
    api.seek(A.action?.time ?? 0);
    return shown;
  };
  api.splitStats = () => (api.actors[0] ? headSplitStats(api.actors[0].model) : null);

  api.sceneIds = Object.keys(SCENES);
  api.pairScene = async (id: string, a: string, b: string) => {
    const S = SCENES[id];
    await api.show(a, 'lib:' + S.att, b, 'lib:' + S.vic);
    const [A, B] = api.actors;
    if (!A || !B) return;
    // both roles with their full hips path ('root' mode), placed in the scene frame
    for (const [act, clipId, alignYaw, off] of [
      [A, S.att, 0, [0, 0]],
      [B, S.vic, S.align.yaw, [S.align.dx, S.align.dz]],
    ] as [NonNullable<LabApi['actors'][0]>, string, number, [number, number]][]) {
      const clip = buildLibClip(clipId, act.model, act.hipsCm, 'root', 'scene:' + clipId);
      if (!clip) continue;
      act.mixer.stopAllAction();
      act.action = act.mixer.clipAction(clip);
      act.action.play();
      act.action.paused = true;
      act.dur = clip.duration;
      act.clipName = 'scene:' + clipId;
      act.decoded = null;
      const hm = A.hipsM; // the scene is sized by the attacker
      // model yaw: clip frame -> scene frame (attacker facing = +z)
      act.root.rotation.y = -S.attYaw0 + alignYaw;
      // victim offset (attacker clip frame) then attacker start to the origin
      const [ox, oz] = rot(off[0] * hm, off[1] * hm, -S.attYaw0);
      act.base.set(0, 0, 0);
      act.root.position.set(ox, 0, oz);
      act.root.userData.sceneFix = true;
    }
    // shift both so the attacker's hips start at the origin
    A.action!.time = 0;
    A.mixer.update(0);
    A.root.updateMatrixWorld(true);
    const hips = A.model.getObjectByName('mixamorigHips')!.getWorldPosition(new THREE.Vector3());
    for (const act of [A, B]) {
      act.root.position.x -= hips.x;
      act.root.position.z -= hips.z;
      act.base.copy(act.root.position);
    }
  };
  api.contactNow = () => {
    const [A, B] = api.actors;
    if (!A || !B) return { t: 0, best: 9, eff: '' };
    let best = 9,
      eff = '';
    const body = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head'].map((j) => B.model.getObjectByName('mixamorig' + j)!.getWorldPosition(new THREE.Vector3()));
    for (const e of ['RightHand', 'LeftHand', 'RightFoot', 'LeftFoot', 'Head']) {
      const p = A.model.getObjectByName('mixamorig' + e)!.getWorldPosition(new THREE.Vector3());
      for (let i = 0; i < body.length - 1; i++) {
        const d = new THREE.Line3(body[i], body[i + 1]).closestPointToPoint(p, true, new THREE.Vector3()).distanceTo(p);
        if (d < best) {
          best = d;
          eff = e;
        }
      }
    }
    return { t: A.action?.time ?? 0, best: +best.toFixed(3), eff };
  };
}
