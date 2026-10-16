/**
 * Visual fighter: a Mixamo character instance + AnimController, weapon
 * trails, attack telegraph decal and buff aura. Consumes sim FighterFrames
 * during the match, or manual inputs during cutscenes.
 */
import * as THREE from 'three';
import { APPEARANCE, type Appearance } from '../data/appearance';
import type { FighterDef, FighterFrame, MoveDef } from '../sim/types';
import { getFighter } from '../sim/fighters';
import { AnimController, buildSharedClip, instantiate, loadSharedClips, type AnimCat, type AnimRequest, type CharAsset, type ClipMeta } from './character';
import { LIFT_DUR, THROW_CLIP, THROW_DUR } from '../sim/world';
import { Telegraph, Trail } from './vfx';
import { buildLibClip } from './animLib';

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
  /** resolves when runtime-loaded clips (shared props, animation library) are attached */
  ready: Promise<void>;
  /** variant picks per pool (metrics: repetition / entropy) */
  usage: Record<string, string[]> = {};
  /** optional per-event hook (audits replay events through it) */
  onEvent?: (e: import('../sim/types').SimEvent, rec: import('../sim/types').MatchRecord) => void;
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
    this.ready = loadSharedClips()
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

  /**
   * Procedural flinch (spring additive, real-time): from = world position the
   * blow comes from; strength ~0.5 light .. 2.5 huge.
   */
  onHit(from: THREE.Vector3, strength: number, height: 'head' | 'body' = 'body') {
    const push = this.root.position.clone().sub(from).setY(0);
    // world -> character space (+Z forward, +X left)
    push.applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.root.rotation.y);
    this.anim.flinch.impulse(push, strength, height);
  }

  /** Make sure a shared-library clip is attached to this fighter's controller; returns its name or '' */
  libName(id: string): string {
    if (!id) return '';
    const name = 'lib:' + id;
    if (this.anim.has(name)) return name;
    const [base, shift] = id.split('@');
    const clip = buildLibClip(base, this.model, this.anim.meta.hipsY, 'inplace', name, shift ? Number(shift) : 0);
    if (!clip) return '';
    this.anim.addClip(clip, clip.duration);
    return name;
  }
  private lastClip = '';
  /** world velocity of the weapon tip / striking hand (m/s) */
  tipVel = new THREE.Vector3();
  private lastTip = new THREE.Vector3();
  /** the blade plane right now: contains the blade (hand -> tip) and its motion */
  bladePlane(at: THREE.Vector3): THREE.Plane {
    const tip = this.tipWorld(new THREE.Vector3());
    const hand = this.rig.joints.haR.getWorldPosition(new THREE.Vector3());
    const blade = tip.clone().sub(hand);
    const n = blade.clone().cross(this.tipVel.lengthSq() > 0.01 ? this.tipVel : new THREE.Vector3(0, -1, 0));
    if (n.lengthSq() < 1e-6) n.set(0, 1, 0);
    return new THREE.Plane().setFromNormalAndCoplanarPoint(n.normalize(), at);
  }
  private flightTilt = 0;

  /**
   * Pose probe: where joints are (character space, metres: +Z forward, +X left,
   * +Y up from the feet) at a clip time, sampled on this rig without disturbing
   * the current pose. Used to place actors so hands / weapon reach a target.
   */
  probe(clipName: string, time: number, joints: string[]): Record<string, THREE.Vector3> {
    const name = clipName.startsWith('lib:') ? this.libName(clipName.slice(4)) : clipName;
    const out: Record<string, THREE.Vector3> = {};
    const clip = name ? this.anim.clip(name) : null;
    if (!clip) return out;
    const saved: [THREE.Object3D, THREE.Quaternion, THREE.Vector3][] = [];
    this.model.traverse((o) => {
      if ((o as THREE.Bone).isBone) saved.push([o, o.quaternion.clone(), o.position.clone()]);
    });
    const rp = this.root.position.clone(),
      rr = this.root.rotation.y;
    this.root.position.set(0, 0, 0);
    this.root.rotation.y = 0;
    const mixer = new THREE.AnimationMixer(this.model);
    const act = mixer.clipAction(clip);
    act.play();
    act.time = Math.min(time, clip.duration - 1e-3);
    mixer.update(0);
    this.root.updateMatrixWorld(true);
    for (const j of joints) {
      const o = j === 'tip' ? (this.tip ?? this.bones.RightHand) : this.bones[j];
      if (o) out[j] = o.getWorldPosition(new THREE.Vector3());
    }
    act.stop();
    mixer.uncacheRoot(this.model);
    for (const [o, q, p] of saved) {
      o.quaternion.copy(q);
      o.position.copy(p);
    }
    this.root.position.copy(rp);
    this.root.rotation.y = rr;
    this.root.updateMatrixWorld(true);
    return out;
  }
  /** hips height in metres (scale of root-motion curves) */
  get hipsM() {
    return this.anim.meta.hipsY * 0.01 * this.anim.meta.scale;
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
  updateFromFrame(fr: FighterFrame, dt: number, opp?: FighterFrame, realDt = dt) {
    this.root.position.set(fr.x, fr.state === 'launched' || fr.state === 'dead' ? fr.y : 0, fr.z);
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
    // sim-chosen library variant for this state (hit reaction, fall, get-up, death, dodge, launch)
    const lib = fr.clip ? this.libName(fr.clip) : '';
    if (fr.clip && fr.clip !== this.lastClip) {
      const pool = fr.state === 'stagger' ? 'hit' : fr.state === 'launched' ? 'launch' : fr.state === 'dead' ? 'death' : fr.state;
      (this.usage[pool] ??= []).push(fr.clip);
    }
    this.lastClip = fr.clip;
    // launched: the sim owns the arc; the body flails a little mid-air (cosmetic springs) and settles before landing
    const air = fr.state === 'launched' || (fr.state === 'dead' && fr.y > 0.02);
    this.anim.flinch.flail = air ? Math.max(0, Math.min(1, fr.y / 0.6)) : 0;

    let req: Omit<AnimRequest, 'fwd' | 'side'> = {};
    const A = this.anim;
    switch (fr.state) {
      case 'attack': {
        const meta = move ? A.meta.clips[move.id] : undefined;
        if (move && meta) {
          const w = this.warpAttack(meta, move, fr.phase, fr.phaseT);
          req = w.fadeOut ? {} : { name: move.id, time: w.time, fadeIn: fr.attackId !== this.lastAttackId ? 14 : 30, cat: 'attack', restart: fr.attackId !== this.lastAttackId };
        }
        break;
      }
      case 'block':
        req = this.blockHitT < 0.45 ? { name: 'blockHit', time: this.blockHitT * 1.2, cat: 'hit' } : { name: 'block', auto: true, fadeIn: 14, cat: 'block' };
        break;
      case 'dodge':
        req = lib
          ? { name: lib, time: Math.min(A.dur(lib) - 0.02, fr.clipT), cat: 'dodge', restart: entering }
          : { name: this.dodgeClip, time: Math.min(1, fr.stateT / 0.5) * A.dur(this.dodgeClip) * 0.85, fadeIn: 20, cat: 'dodge' };
        break;
      case 'stagger':
        req = lib ? { name: lib, time: Math.min(A.dur(lib) - 0.02, fr.clipT), cat: 'hit', restart: entering } : { name: this.hitClip, time: 0.05 + fr.stateT * 1.15, fadeIn: 20, cat: 'hit', restart: entering };
        break;
      case 'launched':
        req = lib ? { name: lib, time: Math.min(A.dur(lib) - 0.02, fr.clipT), cat: 'launch' } : { name: 'fall', auto: true, cat: 'launch' };
        break;
      case 'scene': {
        // finisher role: shared-library clip, or the fighter's own move clip ('own:<move>'); no clip = walking up
        const name = fr.clip.startsWith('own:') ? fr.clip.slice(4) : lib;
        req = name && A.has(name) ? { name, time: Math.min(A.dur(name) - 0.02, fr.clipT), cat: 'scene' } : {};
        break;
      }
      case 'winded':
        req = { name: 'winded', auto: true, fadeIn: 6, cat: 'other' };
        break;
      case 'knockdown':
        req = lib
          ? { name: lib, time: Math.min(A.dur(lib) - 0.02, fr.clipT), cat: 'knockdown' }
          : { name: 'death', time: Math.min(1, fr.stateT / 0.65) * A.dur('death') * 0.55, fadeIn: 18, cat: 'knockdown' };
        break;
      case 'getup':
        req = lib ? { name: lib, time: Math.min(A.dur(lib) - 0.02, fr.clipT), cat: 'getup' } : { name: 'getup', time: fr.phaseT * A.dur('getup'), fadeIn: 7, cat: 'getup' };
        break;
      case 'dead':
        req = lib
          ? { name: lib, time: Math.min(A.dur(lib) - 0.02, fr.clipT), cat: air ? 'launch' : 'death' }
          : { name: 'death', time: Math.min(A.dur('death') - 0.05, A.dur('death') * 0.4 + fr.stateT * 0.9), fadeIn: 18, cat: 'death' };
        break;
      case 'taunt':
        req = { name: 'taunt', time: Math.min(A.dur('taunt') - 0.05, fr.stateT * 1.3), fadeIn: 8, cat: 'taunt' };
        break;
      case 'roar':
        req = { name: 'roar', time: Math.min(A.dur('roar') - 0.05, 0.2 + fr.stateT * 1.2), fadeIn: 10, cat: 'taunt' };
        break;
      case 'lift':
        req = { name: 'throw_object', time: THROW_CLIP.liftFrom + Math.min(1, fr.stateT / LIFT_DUR) * (THROW_CLIP.liftTo - THROW_CLIP.liftFrom), fadeIn: 14, cat: 'carry' };
        break;
      case 'throw':
        req = { name: 'throw_object', time: THROW_CLIP.throwFrom + Math.min(1, fr.stateT / THROW_DUR) * (THROW_CLIP.throwTo - THROW_CLIP.throwFrom), fadeIn: 30, cat: 'carry' };
        break;
      case 'victory': {
        const d = A.dur('taunt');
        req = { name: 'taunt', time: fr.stateT % d, fadeIn: 5, cat: 'taunt' };
        break;
      }
    }
    this.lastAttackId = fr.attackId;
    A.overlayTarget = fr.carry >= 0 && (fr.state === 'idle' || fr.state === 'block') ? 1 : 0;
    // airborne: tip the whole body back along the flight (cosmetic; peaks mid-air, level again at landing)
    if (air && fr.y > 0.01) {
      const hv = Math.hypot(this.vel.x, this.vel.z);
      if (hv > 0.5) {
        const travel = new THREE.Vector3(this.vel.x, 0, this.vel.z).normalize();
        const fwdW = new THREE.Vector3(Math.sin(fr.facing), 0, Math.cos(fr.facing));
        const back = travel.dot(fwdW) < 0 ? 1 : -1; // flying backwards -> tip back
        const k = Math.min(1, fr.y / 1.2);
        this.flightTilt += (back * 0.75 * k - this.flightTilt) * Math.min(1, realDt * 8);
      }
    } else this.flightTilt *= Math.exp(-realDt * 10);
    this.model.rotation.x = -this.flightTilt;
    const loco = fr.state === 'idle' || fr.state === 'block' || (fr.state === 'scene' && !req.name);
    A.update(dt, { ...req, fwd: loco ? fwd : 0, side: loco ? side : 0 }, realDt);
    this.root.updateMatrixWorld(true);
    // weapon tip velocity (finisher cut plane = blade direction x swing direction)
    const tipNow = this.tipWorld(new THREE.Vector3());
    if (dt > 0) this.tipVel.copy(tipNow).sub(this.lastTip).divideScalar(dt);
    this.lastTip.copy(tipNow);

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
    let req: Omit<AnimRequest, 'fwd' | 'side'> = {};
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
      case 'clip': {
        const name = inp.clip?.startsWith('lib:') ? this.libName(inp.clip.slice(4)) : inp.clip;
        if (name) req = { name, time: Math.min(A.dur(name) - 0.02, t), fadeIn: 8, cat: 'cine' };
        break;
      }
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
