/**
 * Builds Timelines from data-driven EntranceSpecs (data/entrances.ts) and the
 * pre-fight face-off. Owns the fx/sfx cue vocabulary used by the specs.
 */
import * as THREE from 'three';
import type { Arena } from '../render/arena/arenaView';
import type { VFX } from '../render/vfx';
import type { FighterView } from '../render/fighterView';
import type { CameraRig } from '../camera/cameraRig';
import type { AudioEngine } from '../audio/audio';
import type { UI } from '../ui/ui';
import type { FighterDef } from '../sim/types';
import { ARENA } from '../sim/arena';
import { ENTRANCES, type CamPose, type EntranceSpec, type V3 } from '../data/entrances';
import { Ease, Timeline } from './timeline';

export interface CineCtx {
  scene: THREE.Scene;
  arena: Arena;
  vfx: VFX;
  rig: CameraRig;
  audio: AudioEngine;
  ui: UI;
  /** Announcer callback (prepare / fight). */
  onAnnounce?: (which: 'prepare' | 'fight') => void;
}

/** Gate-local frame helper. */
class GateFrame {
  o: THREE.Vector3;
  f: THREE.Vector3;
  r: THREE.Vector3;
  yaw: number;
  constructor(arena: Arena, gate: number) {
    const g = arena.gates[gate];
    this.o = g.pos.clone();
    this.f = g.inward.clone();
    this.r = new THREE.Vector3(-this.f.z, 0, this.f.x);
    this.yaw = Math.atan2(this.f.x, this.f.z);
  }
  w(v: V3, out = new THREE.Vector3()) {
    return out.copy(this.o).addScaledVector(this.r, v[0]).addScaledVector(this.f, v[2]).setY(v[1]);
  }
}

/** A voiced line to schedule inside a cutscene. */
export interface CineLine {
  dur: number;
  play: () => void;
}

/**
 * @param monologue optional voiced entrance monologue; it starts with the
 *   title card and the entrance is lengthened (holding the final shot and the
 *   taunt) so the line finishes before the cut.
 */
export function buildEntrance(ctx: CineCtx, view: FighterView, gate: 0 | 1, opp: FighterDef, monologue?: CineLine): Timeline {
  const base: EntranceSpec = ENTRANCES[view.def.id];
  const speakAt = base.title - 0.2;
  const hold = monologue ? Math.max(0, speakAt + monologue.dur + 0.7 - base.duration) : 0;
  // lengthen: final camera shot + final actor key + overall duration
  const spec: EntranceSpec = {
    ...base,
    duration: base.duration + hold,
    camera: base.camera.map((c, i) => (i === base.camera.length - 1 ? { ...c, dur: c.dur + hold } : c)),
    actor: base.actor.map((k, i) => (i === base.actor.length - 1 ? { ...k, t: k.t + hold } : k)),
  };
  const G = new GateFrame(ctx.arena, gate);
  const tl = new Timeline();
  const gateObj = ctx.arena.gates[gate];
  const temp: THREE.Object3D[] = [];

  // ---- mood (lighting) for the whole entrance
  tl.cue('light', 0, () => {
    ctx.arena.applyMood(spec.mood);
    gateObj.light.color.set(spec.mood.gateColor);
    gateObj.light.intensity = 2;
    ctx.rig.collide = false;
    view.rig.root.visible = true;
  });

  // ---- actor track
  const keys = spec.actor;
  const pos = new THREE.Vector3();
  const prev = new THREE.Vector3();
  let first = true;
  tl.span('actor', 0, spec.duration, (_k, lt, dt) => {
    let i = 0;
    while (i < keys.length - 2 && lt >= keys[i + 1].t) i++;
    const a = keys[i],
      b = keys[Math.min(keys.length - 1, i + 1)];
    const span = Math.max(1e-3, b.t - a.t);
    const raw = Math.max(0, Math.min(1, (lt - a.t) / span));
    const k = Ease[a.ease ?? 'inOut'](raw);
    const p: V3 = [a.pos[0] + (b.pos[0] - a.pos[0]) * k, a.pos[1] + (b.pos[1] - a.pos[1]) * k, a.pos[2] + (b.pos[2] - a.pos[2]) * k];
    if (a.arc) p[1] += Math.sin(raw * Math.PI) * a.arc;
    G.w(p, pos);
    const speed = first || dt <= 0 ? 0 : Math.hypot(pos.x - prev.x, pos.z - prev.z) / dt;
    first = false;
    prev.copy(pos);
    view.updateManual(
      { state: a.state, clip: a.clip, phase: a.phase ?? 0, phaseT: raw, stateT: lt - a.t, fwd: a.state === 'idle' || a.state === 'relaxed' || a.state === 'run' ? speed : 0 },
      pos,
      G.yaw,
      dt,
    );
  });

  // ---- camera track
  const resolve = (cp: CamPose, outPos: THREE.Vector3, outLook: THREE.Vector3) => {
    G.w(cp.pos, outPos);
    if (cp.look === 'actor') view.chestWorld(outLook);
    else if (cp.look === 'head') view.headWorld(outLook);
    else G.w(cp.look, outLook);
  };
  const p0 = new THREE.Vector3(),
    p1 = new THREE.Vector3(),
    l0 = new THREE.Vector3(),
    l1 = new THREE.Vector3();
  for (const shot of spec.camera) {
    tl.span(
      'camera',
      shot.t,
      shot.dur,
      (k, _lt, dt) => {
        const e = Ease[shot.ease ?? 'inOut'](k);
        resolve(shot.from, p0, l0);
        resolve(shot.to, p1, l1);
        p0.lerp(p1, e);
        l0.lerp(l1, e);
        const fov = shot.from.fov + (shot.to.fov - shot.from.fov) * e;
        ctx.rig.cut(p0, l0, fov);
        ctx.rig.update(p0, l0, fov, dt);
      },
    );
  }

  // ---- title card
  tl.cue('text', spec.title, () => ctx.ui.showTitle(view.def, opp, gate));
  if (monologue) tl.cue('audio', speakAt, () => monologue.play());
  tl.cue('text', spec.duration - 0.3, () => ctx.ui.hideTitle());

  // ---- cues
  const actorPos = () => view.rig.root.position.clone();
  for (const c of spec.cues) {
    if (c.sfx) tl.cue('audio', c.t, () => playSfx(ctx.audio, c.sfx!));
    if (c.fx) addFx(tl, ctx, c.fx, c.t, c.dur ?? 1, c.arg ?? 0, G, view, gate, temp, actorPos, spec.duration);
  }
  tl.cue('cleanup', spec.duration, () => {
    for (const o of temp) ctx.scene.remove(o);
    gateObj.light.intensity = 3;
  });
  return tl;
}

function playSfx(a: AudioEngine, s: string) {
  switch (s) {
    case 'drum': return a.drum(1);
    case 'crash': return a.crash();
    case 'thud': return a.thud();
    case 'roar': return a.roar(1, 1.6);
    case 'roar_short': return a.roar(1.3, 0.6);
    case 'growl': return a.roar(0.55, 1.4);
    case 'howl': return a.roar(2.2, 1.8);
    case 'whoosh': return a.whoosh(true);
    case 'whisper': return a.whoosh(false);
    case 'clang': return a.clang();
    case 'fire': return a.fire(false);
    case 'fire_big': return a.fire(true);
    case 'chain': return a.whoosh(true);
    case 'gasp': return a.gasp();
    case 'cheer': return a.cheer(1);
    case 'stinger_intro': return a.stinger('intro');
    case 'stinger_dread': return a.stinger('dread');
  }
}

function addFx(
  tl: Timeline,
  ctx: CineCtx,
  fx: string,
  t: number,
  dur: number,
  arg: number,
  G: GateFrame,
  view: FighterView,
  gate: number,
  temp: THREE.Object3D[],
  actorPos: () => THREE.Vector3,
  end: number,
) {
  const gateObj = ctx.arena.gates[gate];
  const V = ctx.vfx;
  switch (fx) {
    case 'gate_shake':
      tl.cue('vfx', t, () => {
        ctx.rig.addShake(0.35);
        V.dust(G.w([0, 3.5, 0.5]), 8, 1.5);
        gateObj.portcullis.position.z = 0.35;
        setTimeout(() => (gateObj.portcullis.position.z = 0.2), 90);
      });
      break;
    case 'gate_smash': {
      const vel = new THREE.Vector3();
      tl.span(
        'vfx',
        t,
        1.6,
        (_k, _lt, dt) => {
          vel.y -= 14 * dt;
          gateObj.portcullis.position.addScaledVector(vel, dt);
          gateObj.portcullis.rotation.x -= dt * 2.2;
          if (gateObj.portcullis.position.y < -0.5) gateObj.portcullis.visible = false;
        },
        () => {
          // portcullis flies into the arena (gate group's local +z is inward)
          vel.set(0, 5, 9);
          gateObj.smashed = true;
          ctx.rig.addShake(0.9);
          ctx.rig.punchFov(8);
          const p = G.w([0, 1.8, 0.4]);
          V.debrisBurst(p, '#3b3632', 14);
          V.sparks(p, 60, '#ffb060', 10);
          V.flash(p, '#ff9a50', 3, 25);
          V.dust(G.w([0, 0.2, 1.5]), 30, 2.2);
        },
      );
      break;
    }
    case 'gate_open':
      tl.span('vfx', t, dur, (k) => {
        gateObj.portcullis.position.y = Ease.inOut(k) * 3.7;
      });
      break;
    case 'gate_light':
      tl.span('light', t, 0.6, (k) => {
        gateObj.light.intensity = 2 + k * 12;
      });
      break;
    case 'step_dust':
      tl.cue('vfx', t, () => {
        V.dust(actorPos(), 6, 0.8);
        ctx.rig.addShake(0.15);
      });
      break;
    case 'embers_burst':
      tl.cue('vfx', t, () => {
        const p = actorPos();
        V.embers(p.setY(1), 80, '#ff6a20', 1.5);
        V.shockwave(actorPos(), '#ff7a30', 5, 0.7);
        ctx.rig.addShake(0.5);
      });
      break;
    case 'eyes_glint':
      tl.cue('vfx', t, () => {
        const h = view.headWorld();
        V.flash(h, view.ap.accent, 0.35, 3);
      });
      break;
    case 'smoke_burst':
      tl.cue('vfx', t, () => {
        const p = actorPos();
        V.smoke(p, 40, '#1d1626', 1.6, 1.4);
        V.dust(p, 16, 1.4);
        V.shockwave(p, '#b67bff', 4, 0.5);
        ctx.rig.addShake(0.3);
      });
      break;
    case 'shadow_trail':
      tl.span('vfx', t, dur, () => {
        const p = actorPos();
        V.smoke(p.setY(0.2), 2, '#201a2c', 0.8, 0.4);
      });
      break;
    case 'shield_spark':
      tl.cue('vfx', t, () => {
        const p = view.castWorld();
        V.sparks(p, 20, '#cfe6ff', 6);
        V.flash(p, '#bfe0ff', 0.6, 6);
        ctx.rig.addShake(0.2);
      });
      break;
    case 'torch_path': {
      // six braziers along the walk path ignite one after another
      const side = arg % 2 === 0 ? 1 : -1;
      const z = 0.8 + Math.floor(arg / 2) * 2.4;
      const p = G.w([side * 1.9, 0, z]);
      const g = new THREE.Group();
      g.position.copy(p);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 1.3, 6), new THREE.MeshStandardMaterial({ color: '#2a2018' }));
      post.position.y = 0.65;
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.12, 0.18, 8), new THREE.MeshStandardMaterial({ color: '#3a3028', metalness: 0.6 }));
      bowl.position.y = 1.35;
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.5, 7), new THREE.MeshBasicMaterial({ color: '#ffc060', transparent: true, opacity: 0.95 }));
      flame.position.y = 1.65;
      flame.visible = false;
      g.add(post, bowl, flame);
      let light: THREE.PointLight | null = null;
      if (arg % 2 === 0) {
        light = new THREE.PointLight('#ffb050', 0, 7, 1.8);
        light.position.y = 1.8;
        g.add(light);
      }
      tl.cue('vfx', 0, () => {
        ctx.scene.add(g);
        temp.push(g);
      });
      tl.span(
        'vfx',
        t,
        Math.max(0.1, end - t),
        (_k, lt) => {
          flame.scale.y = 0.9 + Math.sin(lt * 17 + arg) * 0.12;
          if (light) light.intensity = Math.min(9, lt * 20) * (0.9 + Math.sin(lt * 23) * 0.1);
          if (Math.random() < 0.15) V.embers(new THREE.Vector3(p.x, 1.7, p.z), 1, '#ffb060', 0.1);
        },
        () => {
          flame.visible = true;
          V.flash(new THREE.Vector3(p.x, 1.7, p.z), '#ffb060', 0.8, 4);
          V.fire(new THREE.Vector3(p.x, 1.6, p.z), new THREE.Vector3(0, 2, 0), 12, 0.3, 0.4);
        },
      );
      break;
    }
    case 'holy_burst':
      tl.cue('vfx', t, () => {
        const p = view.tipWorld();
        V.sparks(p, 50, '#ffe08a', 6);
        V.flash(p, '#ffe7a0', 1.2, 10);
        V.shockwave(actorPos(), '#ffd66b', 5, 0.8);
        V.embers(actorPos().setY(0.5), 40, '#ffd66b', 1.2);
      });
      break;
    case 'ground_embers':
      tl.span('vfx', t, dur, () => {
        const p = G.w([0, 0.05, 6.6]);
        V.embers(p, 2, '#ff7a20', 0.6);
      });
      break;
    case 'fire_pillar': {
      const p = G.w([0, 0, 6.6]);
      const light = new THREE.PointLight('#ff7a20', 0, 14, 1.5);
      light.position.copy(p).setY(2);
      tl.span(
        'vfx',
        t,
        dur,
        (k) => {
          const strength = k < 0.75 ? 1 : 1 - (k - 0.75) / 0.25;
          light.intensity = 40 * strength;
          for (let i = 0; i < 6; i++) V.fire(new THREE.Vector3(p.x + (Math.random() - 0.5) * 0.9, Math.random() * 1.5, p.z + (Math.random() - 0.5) * 0.9), new THREE.Vector3(0, 6 + Math.random() * 4, 0), 1, 0.7 * strength + 0.2, 0.5);
          if (Math.random() < 0.5) V.embers(p.clone().setY(1), 2, '#ffaa40', 1);
        },
        () => {
          ctx.scene.add(light);
          temp.push(light);
          V.flash(p.clone().setY(1), '#ffa040', 3.5, 30);
          V.shockwave(p, '#ff7a20', 6, 0.8);
          ctx.rig.addShake(0.6);
        },
        () => (light.intensity = 0),
      );
      break;
    }
    case 'palm_fire':
      tl.span('vfx', t, dur, () => {
        const h = view.rig.joints.haL.getWorldPosition(new THREE.Vector3());
        h.y += 0.15;
        V.fire(h, new THREE.Vector3(0, 1.4, 0), 2, 0.22, 0.15);
      });
      break;
    case 'dust_land':
      tl.cue('vfx', t, () => {
        const p = actorPos();
        V.dust(p, 24, 1.6);
        V.shockwave(p, '#c8b090', 4, 0.5);
        ctx.rig.addShake(0.45);
      });
      break;
  }
}

/**
 * Face-off: both fighters at their marks, VS splash, FIGHT! beat.
 * The real match starts when this ends.
 */
export function buildFaceoff(ctx: CineCtx, views: [FighterView, FighterView], defs: [FighterDef, FighterDef], banter: [CineLine | null, CineLine | null] = [null, null]): Timeline {
  const tl = new Timeline();
  const start = [0, 1].map((i) => {
    const a = ARENA.gateAngle[i];
    return new THREE.Vector3(Math.cos(a) * ARENA.startR, 0, Math.sin(a) * ARENA.startR);
  });
  const yaw = start.map((p) => Math.atan2(-p.x, -p.z));
  // timing: VS splash, then A speaks, B replies, then FIGHT!
  const aAt = 1.5;
  const aEnd = aAt + (banter[0]?.dur ?? 0);
  const bAt = banter[0] ? aEnd + 0.25 : aAt;
  const bEnd = bAt + (banter[1]?.dur ?? 0);
  const fightAt = Math.max(2.3, (banter[0] || banter[1] ? bEnd : 0) + 0.35);
  const total = fightAt + 1.3;
  tl.cue('light', 0, () => {
    ctx.rig.collide = true;
    ctx.ui.splashText(`<span style="color:${defs[0].color}">${defs[0].name}</span><em>VS</em><span style="color:${defs[1].color}">${defs[1].name}</span>`, 'vs');
    ctx.audio.drum(1.2);
  });
  tl.span('actor', 0, total, (_k, lt, dt) => {
    for (let i = 0; i < 2; i++) {
      const talking = (i === 0 && banter[0] && lt >= aAt && lt < aEnd) || (i === 1 && banter[1] && lt >= bAt && lt < bEnd);
      views[i].updateManual({ state: lt > fightAt - 0.2 ? 'idle' : talking ? 'taunt' : 'idle', stateT: talking ? lt - (i === 0 ? aAt : bAt) : lt }, start[i], yaw[i], dt);
    }
  });
  const p0 = new THREE.Vector3(),
    l0 = new THREE.Vector3();
  const shot = (from: number, dur: number, f: (k: number) => [THREE.Vector3, THREE.Vector3, number]) =>
    tl.span('camera', from, dur, (k, _lt, dt) => {
      const [p, l, fov] = f(k);
      ctx.rig.cut(p, l, fov);
      ctx.rig.update(p, l, fov, dt);
    });
  // 1. low between them pushing in (under the VS splash)
  shot(0, aAt, (k) => {
    const e = Ease.inOut(k);
    return [p0.set(0, 0.5 + e * 0.2, 5.5 - e * 1.5), l0.set(0, 1.4, 0), 52 - e * 6];
  });
  // 2/3. over-the-shoulder close-ups on whoever is talking
  const closeOn = (i: number) => (k: number): [THREE.Vector3, THREE.Vector3, number] => {
    const me = start[i],
      them = start[1 - i];
    const dir = me.clone().sub(them).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(i === 0 ? 1 : -1);
    const head = views[i].headWorld();
    p0.copy(them).addScaledVector(dir, -1.2).addScaledVector(side, 1.3 + k * 0.2);
    p0.y = head.y - 0.1;
    return [p0, l0.copy(head).setY(head.y - 0.1), 34 - k * 3];
  };
  if (banter[0]) shot(aAt, aEnd - aAt + 0.25, closeOn(0));
  if (banter[1]) shot(bAt, bEnd - bAt, closeOn(1));
  // 4. rising two-shot into FIGHT!
  const riseAt = banter[0] || banter[1] ? bEnd : aAt;
  shot(riseAt, total - riseAt, (k) => {
    const e = Ease.out(k);
    return [p0.set(Math.sin(e * 0.5) * 2, 1.7 + e * 0.8, 6.4 + e * 0.6), l0.set(0, 1.1, 0), 50];
  });
  if (banter[0]) tl.cue('audio', aAt, () => banter[0]!.play());
  if (banter[1]) tl.cue('audio', bAt, () => banter[1]!.play());
  tl.cue('audio', 0.8, () => ctx.audio.drum(1));
  tl.cue('text', 1.4, () => ctx.ui.hideSplash());
  tl.cue('audio', 0.3, () => ctx.onAnnounce?.('prepare'));
  tl.cue('text', fightAt, () => {
    ctx.ui.splashText('FIGHT!', 'fight');
    ctx.onAnnounce?.('fight');
    ctx.audio.stinger('fight');
    ctx.audio.cheer(1.4);
    ctx.rig.addShake(0.4);
  });
  tl.cue('text', total - 0.1, () => ctx.ui.hideSplash());
  return tl;
}
