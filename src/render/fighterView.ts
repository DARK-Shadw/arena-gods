/**
 * Visual fighter: a Mixamo character instance + AnimController, weapon
 * trails, attack telegraph decal and buff aura. Consumes sim FighterFrames
 * during the match, or manual inputs during cutscenes.
 */
import * as THREE from 'three';
import { APPEARANCE, type Appearance } from '../data/appearance';
import type { FighterDef, FighterFrame, MoveDef } from '../sim/types';
import { getFighter } from '../sim/fighters';
import { AnimController, buildSharedClip, instantiate, loadSharedClips, type CharAsset, type ClipMeta } from './character';
import { LIFT_DUR, THROW_CLIP, THROW_DUR } from '../sim/world';
import { Telegraph, Trail } from './vfx';

/** Cutscene / manual animation input. */
export interface AnimInput {
  /** idle | relaxed | run | crouch | kneel | airborne | land | roar | taunt | attack | getup | clip */
  state: string;
  /** clip name for state 'attack' (move id) or 'clip' */
  clip?: string;
  phase?: number;
  phaseT?: number;
  stateT?: number;
  fwd?: number;
  side?: number;
}

const angDiff = (a: number, b: number) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

export class FighterView {
  def: FighterDef;
  ap: Appearance;
  root = new THREE.Group();
  model: THREE.Object3D;
  anim: AnimController;
  /** Compatibility handles used by cutscenes / camera. */
  rig: { root: THREE.Group; joints: { haL: THREE.Object3D; haR: THREE.Object3D; head: THREE.Object3D; chest: THREE.Object3D } };
  trail: Trail;
  telegraph: Telegraph;
  aura: THREE.Mesh;
  private bones: Record<string, THREE.Object3D> = {};
  private tip?: THREE.Object3D;
  private base?: THREE.Object3D;
  private moves: Record<string, MoveDef> = {};
  private lastState = '';
  private lastAttackId = -1;
  private hitClip = 'hitFront';
  private dodgeClip = 'dodgeBack';
  private blockHitT = 99;
  private mats: THREE.MeshStandardMaterial[] = [];
  private last = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  weaponGlow = 0;
  /** Height in metres (for camera framing). */
  height: number;

  constructor(id: string, asset: CharAsset, scene: THREE.Scene) {
    this.def = getFighter(id);
    this.ap = APPEARANCE[id];
    const meta = asset.meta;
    this.height = meta.height;
    this.model = instantiate(asset);
    this.model.scale.setScalar(0.01 * meta.scale);
    this.root.add(this.model);
    this.model.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.bones[o.name.replace('mixamorig', '')] = o;
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        // per-instance materials so glow/tints don't leak to a mirror-match twin
        m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : (m.material as THREE.Material).clone();
        for (const x of Array.isArray(m.material) ? m.material : [m.material]) this.mats.push(x as THREE.MeshStandardMaterial);
      }
    });
    const b = (n: string) => this.bones[n] ?? this.model;
    this.rig = { root: this.root, joints: { haL: b('LeftHand'), haR: b('RightHand'), head: b('Head'), chest: b('Spine2') } };
    if (meta.weaponTip) {
      const hand = b('RightHand');
      this.tip = new THREE.Object3D();
      this.tip.position.fromArray(meta.weaponTip.pos);
      this.base = new THREE.Object3D();
      this.base.position.fromArray(meta.weaponTip.base);
      hand.add(this.tip, this.base);
    }
    this.anim = new AnimController(this.model, asset.clips, meta);
    // shared prop clip (Throw_Object): pick-up, carry hold pose, throw
    loadSharedClips()
      .then((d) => {
        const clip = buildSharedClip(d, 'throw_object', this.model, meta);
        if (!clip) return;
        this.anim.addClip(clip, clip.duration);
        this.anim.setOverlayPose(this.model, clip, THROW_CLIP.liftTo - 0.05, /Spine|Neck|Head|Shoulder|Arm|Hand/);
      })
      .catch(() => {});
    for (const mv of this.def.moves) this.moves[mv.id] = mv;
    const accent = new THREE.Color(this.ap.accent);
    this.trail = new Trail(accent);
    this.telegraph = new Telegraph(new THREE.Color(this.def.color));
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(64, 64, 10, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.6, 'rgba(255,255,255,0.35)');
    grd.addColorStop(0.85, 'rgba(255,255,255,1)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    this.aura = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 2.6),
      new THREE.MeshBasicMaterial({ color: accent, map: new THREE.CanvasTexture(c), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.aura.rotation.x = -Math.PI / 2;
    this.aura.position.y = 0.04;
    this.root.add(this.aura);
    scene.add(this.root, this.trail.mesh, this.telegraph.mesh);
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.root, this.trail.mesh, this.telegraph.mesh);
    this.anim.mixer.stopAllAction();
  }

  get position() {
    return this.root.position;
  }
  chestWorld(out = new THREE.Vector3()) {
    return this.rig.joints.chest.getWorldPosition(out);
  }
  headWorld(out = new THREE.Vector3()) {
    return this.rig.joints.head.getWorldPosition(out).add(new THREE.Vector3(0, 0.08, 0));
  }
  /** between the two hands, a little in front (where a carried prop sits) */
  handsWorld(out = new THREE.Vector3()) {
    const l = this.rig.joints.haL.getWorldPosition(this.tmpA);
    const r = this.rig.joints.haR.getWorldPosition(out);
    out.copy(r).add(l).multiplyScalar(0.5);
    out.x += Math.sin(this.root.rotation.y) * 0.12;
    out.z += Math.cos(this.root.rotation.y) * 0.12;
    return out;
  }
  tipWorld(out = new THREE.Vector3()) {
    return (this.tip ?? this.rig.joints.haR).getWorldPosition(out);
  }
  /** Where spells / arrows / sparks originate. */
  castWorld(out = new THREE.Vector3()) {
    if (this.def.id === 'erika') return this.rig.joints.haL.getWorldPosition(out);
    return (this.tip ?? this.rig.joints.haR).getWorldPosition(out);
  }

  /** World positions of a move's striking points as RENDERED now (effector bone + weapon tip). */
  strikePointsWorld(moveId: string): THREE.Vector3[] {
    const eff = this.anim.meta.clips[moveId]?.eff || 'RightHand';
    const pts = [(this.bones[eff] ?? this.rig.joints.haR).getWorldPosition(new THREE.Vector3())];
    if (this.tip) pts.push(this.tip.getWorldPosition(new THREE.Vector3()));
    return pts;
  }

  /** Called by the app for block events (plays a block-impact reaction). */
  onBlocked() {
    this.blockHitT = 0;
  }

  private warpAttack(c: ClipMeta, mv: MoveDef | undefined, phase: number, k: number): { time: number; fadeOut: boolean } {
    const s = c.strike,
      st = Math.min(c.start, s - 0.05),
      d = c.dur;
    const hits = mv?.hits ?? 1;
    let activeEnd = s + 0.12;
    if (!c.loopActive && hits > 1 && c.peaks.length > 1) activeEnd = Math.max(activeEnd, c.peaks[c.peaks.length - 1] + 0.1);
    activeEnd = Math.min(d - 0.05, activeEnd);
    if (phase === 0) return { time: st + (s - st) * k, fadeOut: false };
    if (phase === 1) {
      if (c.loopActive) {
        const seg = (k * hits) % 1;
        return { time: Math.max(0, s - 0.2) + seg * 0.32, fadeOut: false };
      }
      return { time: s + (activeEnd - s) * k, fadeOut: false };
    }
    const tail = Math.min(d - activeEnd, (mv?.recovery ?? 0.5) * 1.6 + 0.2);
    return { time: activeEnd + tail * k, fadeOut: k > 0.7 };
  }

  /** Drive from a sim frame. dt is sim-time elapsed (slow-mo aware). */
  updateFromFrame(fr: FighterFrame, dt: number, opp?: FighterFrame) {
    this.root.position.set(fr.x, 0, fr.z);
    this.root.rotation.y = fr.facing;
    if (dt > 0) this.vel.set(fr.x - this.last.x, 0, fr.z - this.last.z).divideScalar(dt);
    this.last.set(fr.x, 0, fr.z);
    const s = Math.sin(fr.facing),
      c = Math.cos(fr.facing);
    // local velocity: fwd along facing, side positive toward the character's left (+X local)
    const fwd = fr.vx * s + fr.vz * c;
    const side = fr.vx * c - fr.vz * s;
    const move = fr.moveId ? this.moves[fr.moveId] : undefined;
    const entering = fr.state !== this.lastState;
    if (entering && fr.state === 'stagger' && opp) {
      const d = angDiff(fr.facing, Math.atan2(opp.x - fr.x, opp.z - fr.z));
      this.hitClip = Math.abs(d) < Math.PI / 4 ? 'hitFront' : Math.abs(d) > (Math.PI * 3) / 4 ? 'hitBack' : d > 0 ? 'hitLeft' : 'hitRight';
    }
    if (entering && fr.state === 'dodge') {
      const vl = this.vel.length() || 1;
      const lf = (this.vel.x * s + this.vel.z * c) / vl;
      const ls = (this.vel.x * c - this.vel.z * s) / vl;
      this.dodgeClip = lf < -0.5 || Math.abs(ls) < 0.4 ? 'dodgeBack' : ls > 0 ? 'dodgeLeft' : 'dodgeRight';
    }
    this.lastState = fr.state;
    this.blockHitT += dt;

    let req: { name?: string; time?: number; auto?: boolean; fadeIn?: number } = {};
    const A = this.anim;
    switch (fr.state) {
      case 'attack': {
        const meta = move ? A.meta.clips[move.id] : undefined;
        if (move && meta) {
          const w = this.warpAttack(meta, move, fr.phase, fr.phaseT);
          req = w.fadeOut ? {} : { name: move.id, time: w.time, fadeIn: fr.attackId !== this.lastAttackId ? 14 : 30 };
        }
        break;
      }
      case 'block':
        req = this.blockHitT < 0.45 ? { name: 'blockHit', time: this.blockHitT * 1.2 } : { name: 'block', auto: true, fadeIn: 14 };
        break;
      case 'dodge':
        req = { name: this.dodgeClip, time: Math.min(1, fr.stateT / 0.5) * A.dur(this.dodgeClip) * 0.85, fadeIn: 20 };
        break;
      case 'stagger':
        req = { name: this.hitClip, time: 0.05 + fr.stateT * 1.15, fadeIn: 20 };
        break;
      case 'winded':
        req = { name: 'winded', auto: true, fadeIn: 6 };
        break;
      case 'knockdown':
        req = { name: 'death', time: Math.min(1, fr.stateT / 0.65) * A.dur('death') * 0.55, fadeIn: 18 };
        break;
      case 'getup':
        req = { name: 'getup', time: fr.phaseT * A.dur('getup'), fadeIn: 7 };
        break;
      case 'dead':
        req = { name: 'death', time: Math.min(A.dur('death') - 0.05, A.dur('death') * 0.4 + fr.stateT * 0.9), fadeIn: 18 };
        break;
      case 'taunt':
        req = { name: 'taunt', time: Math.min(A.dur('taunt') - 0.05, fr.stateT * 1.3), fadeIn: 8 };
        break;
      case 'roar':
        req = { name: 'roar', time: Math.min(A.dur('roar') - 0.05, 0.2 + fr.stateT * 1.2), fadeIn: 10 };
        break;
      case 'lift':
        req = { name: 'throw_object', time: THROW_CLIP.liftFrom + Math.min(1, fr.stateT / LIFT_DUR) * (THROW_CLIP.liftTo - THROW_CLIP.liftFrom), fadeIn: 14 };
        break;
      case 'throw':
        req = { name: 'throw_object', time: THROW_CLIP.throwFrom + Math.min(1, fr.stateT / THROW_DUR) * (THROW_CLIP.throwTo - THROW_CLIP.throwFrom), fadeIn: 30 };
        break;
      case 'victory': {
        const d = A.dur('taunt');
        req = { name: 'taunt', time: fr.stateT % d, fadeIn: 5 };
        break;
      }
    }
    this.lastAttackId = fr.attackId;
    A.overlayTarget = fr.carry >= 0 && (fr.state === 'idle' || fr.state === 'block') ? 1 : 0;
    A.update(dt, { ...req, fwd: fr.state === 'idle' || fr.state === 'block' ? fwd : 0, side: fr.state === 'idle' || fr.state === 'block' ? side : 0 });
    this.root.updateMatrixWorld(true);

    // weapon/limb trail during active frames
    const attacking = fr.state === 'attack' && (fr.phase === 1 || (fr.phase === 0 && fr.phaseT > 0.85) || (fr.phase === 2 && fr.phaseT < 0.12));
    this.pushTrail(move, attacking);

    // telegraph decal during windup of big / slow moves
    if (fr.state === 'attack' && move && fr.phase === 0 && (move.kind === 'heavy' || move.kind === 'ultimate' || move.kind === 'gap' || move.windup >= 0.6)) {
      const reach = move.range + this.def.stats.radius * 0.5 + Math.max(0, move.lunge ?? 0) * 0.6;
      this.telegraph.show(fr.x, fr.z, fr.facing, reach, move.arc, !!move.aoe, fr.phaseT, move.kind === 'ultimate');
    } else this.telegraph.hide();

    const ult = fr.state === 'attack' && move?.kind === 'ultimate';
    const targetGlow = ult ? 1 : fr.lastStand ? 0.6 : fr.buff > 0 ? 0.35 : 0;
    this.weaponGlow += (targetGlow - this.weaponGlow) * Math.min(1, dt * 6);
    this.applyGlow((fr.lastStand || fr.buff > 0 || ult) && fr.state !== 'dead');
  }

  private pushTrail(move: MoveDef | undefined, active: boolean) {
    let base: THREE.Vector3, tip: THREE.Vector3;
    const eff = move ? this.anim.meta.clips[move.id]?.eff : '';
    if (this.tip && this.base && (!eff || eff === 'RightHand')) {
      base = this.base.getWorldPosition(this.tmpA);
      tip = this.tip.getWorldPosition(this.tmpB);
    } else {
      // unarmed: trail from the forearm/shin to just past the striking hand/foot
      const e = this.bones[eff || 'RightHand'] ?? this.rig.joints.haR;
      tip = e.getWorldPosition(this.tmpB);
      base = (e.parent ?? e).getWorldPosition(this.tmpA).lerp(tip, 0.45);
      tip.add(this.tmpA.clone().sub(tip).multiplyScalar(-0.25));
    }
    this.trail.push(base, tip, active ? 1 : 0);
  }

  private applyGlow(aura: boolean) {
    const pulse = 0.75 + Math.sin(performance.now() * 0.008) * 0.25;
    const col = new THREE.Color(this.ap.accent).multiplyScalar(this.weaponGlow * 0.18 * pulse);
    for (const m of this.mats) if (m.emissive) m.emissive.copy(col);
    (this.aura.material as THREE.MeshBasicMaterial).opacity = aura ? 0.5 * pulse + this.weaponGlow * 0.05 : 0;
  }

  /** Drive manually (cutscenes). */
  updateManual(inp: AnimInput, pos: THREE.Vector3, facing: number, dt: number) {
    this.root.position.copy(pos);
    this.root.rotation.y = facing;
    this.last.copy(pos);
    const A = this.anim;
    const t = inp.stateT ?? 0;
    let req: { name?: string; time?: number; auto?: boolean; fadeIn?: number } = {};
    let fwd = 0;
    switch (inp.state) {
      case 'idle':
      case 'relaxed':
      case 'run':
        fwd = inp.fwd ?? 0;
        break;
      case 'crouch':
      case 'kneel':
        req = { name: 'crouch', auto: true, fadeIn: 8 };
        break;
      case 'airborne':
        req = { name: 'fall', auto: true, fadeIn: 10 };
        break;
      case 'land':
        req = { name: 'land', time: Math.min(A.dur('land') - 0.05, t + 0.15), fadeIn: 20 };
        break;
      case 'getup':
        req = { name: 'getup', time: Math.min(A.dur('getup') - 0.05, t), fadeIn: 8 };
        break;
      case 'roar':
      case 'taunt':
        req = { name: inp.state, time: Math.min(A.dur(inp.state) - 0.05, t), fadeIn: 7 };
        break;
      case 'attack': {
        const meta = inp.clip ? A.meta.clips[inp.clip] : undefined;
        if (meta) req = { name: inp.clip, time: this.warpAttack(meta, this.moves[inp.clip!], inp.phase ?? 0, inp.phaseT ?? 0).time };
        break;
      }
      case 'clip':
        if (inp.clip) req = { name: inp.clip, time: Math.min(A.dur(inp.clip) - 0.05, t), fadeIn: 8 };
        break;
    }
    A.overlayTarget = 0;
    A.update(dt, { ...req, fwd, side: 0 });
    this.root.updateMatrixWorld(true);
    this.pushTrail(undefined, false);
    this.telegraph.hide();
    this.weaponGlow += (0 - this.weaponGlow) * Math.min(1, dt * 4);
    this.applyGlow(false);
  }
}
