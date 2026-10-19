/**
 * Builds Timelines from data-driven EntranceSpecs (data/entrances.ts) and the
 * pre-fight face-off. Owns the fx/sfx cue vocabulary used by the specs.
 */
import * as THREE from 'three';
import { groundY, type Arena, type GateAnchors } from '../render/arena/arenaView';
import type { VFX } from '../render/vfx';
import type { FighterView } from '../render/fighterView';
import type { CameraRig } from '../camera/cameraRig';
import type { AudioEngine } from '../audio/audio';
import type { UI } from '../ui/ui';
import type { FighterDef } from '../sim/types';
import { ARENA } from '../sim/arena';
import { ENTRANCES, type CamPose, type CamShot, type EntranceSpec, type V3 } from '../data/entrances';
import { hazardPenalty } from './framing';
import { ENTRANCE_VARIANTS } from '../data/entranceVariants';
import { Ease, Timeline } from './timeline';
import { resolveCamera } from '../camera/cameraRig';
import { beatTimes, type Beat, type CompiledEntrance, type EntranceVariant, type VariantCtx } from './beats';
import { decodeClip, libClip, rootAt } from '../render/animLib';
import { Rng, hashSeed } from '../sim/rng';

export interface CineCtx {
  scene: THREE.Scene;
  arena: Arena;
  vfx: VFX;
  rig: CameraRig;
  audio: AudioEngine;
  ui: UI;
  /** Announcer callback (prepare / fight). */
  onAnnounce?: (which: 'prepare' | 'fight') => void;
  /** cinematic slow-motion: play the cutscene clock at `scale` for `realDur` seconds */
  slowmo?: (scale: number, realDur: number) => void;
  /** match seed (entrance variant choice) */
  seed?: number;
}

/** what the entrance validator needs to know about a built entrance */
export interface EntranceMeta {
  variant: string;
  duration: number;
  /** physical barrier events and what causes them */
  events: { t: number; fx: string; cause?: string }[];
  /** airborne spans (no support check) */
  air: [number, number][];
  /** intentionally hidden spans (no framing checks) */
  hidden: [number, number][];
  /** camera shot spans */
  shots: [number, number][];
}

/**
 * Gate-local frame helper. A18: a gate up a stair (anchors.ground) makes every gate-frame y relative to the ground
 * under it (floor, stair, dais); without one the ground is the floor (y unchanged).
 */
class GateFrame {
  o: THREE.Vector3;
  f: THREE.Vector3;
  r: THREE.Vector3;
  yaw: number;
  ground: GateAnchors['ground'];
  constructor(arena: Arena, gate: number) {
    const g = arena.gates[gate];
    this.o = g.pos.clone();
    this.f = g.inward.clone();
    this.r = new THREE.Vector3(-this.f.z, 0, this.f.x);
    this.yaw = Math.atan2(this.f.x, this.f.z);
    this.ground = g.anchors.ground;
  }
  /** ground height under gate-frame z */
  gy(z: number) {
    return this.ground ? groundY(this.ground, z) : 0;
  }
  /** gate frame -> world; `base` overrides the ground height (an airborne arc between two ground heights) */
  w(v: V3, out = new THREE.Vector3(), base?: number) {
    return out
      .copy(this.o)
      .addScaledVector(this.r, v[0])
      .addScaledVector(this.f, v[2])
      .setY(v[1] + (base ?? this.gy(v[2])));
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
/** Pick an arena-valid variant for this fighter at this gate (seeded among the valid ones). */
/**
 * Anchors are declared by the dressing; snap them onto the geometry that was
 * actually built (ray cast down) and drop any that do not land on a surface.
 */
export function snapAnchors(arena: CineCtx['arena'], gate: number) {
  const g = arena.gates[gate];
  const A = g.anchors as typeof g.anchors & { snapped?: boolean };
  if (A.snapped) return A;
  A.snapped = true;
  arena.group.updateMatrixWorld(true);
  // A7: the arena's losGroup proxies (invisible, e.g. the kit wet floor) are plain meshes in the group: they are snapped onto too
  const meshes: THREE.Mesh[] = [];
  arena.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !(m as unknown as THREE.InstancedMesh).isInstancedMesh && o !== arena.sky && !o.userData.dyn) meshes.push(m);
  });
  const G = new GateFrame(arena, gate);
  const ray = new THREE.Raycaster();
  // (A18: y relative to the gate's ground; w.y is the world height)
  const snap = (p: V3, tol: number): V3 | null => {
    const w = G.w(p);
    ray.set(new THREE.Vector3(w.x, w.y + tol, w.z), new THREE.Vector3(0, -1, 0));
    ray.far = tol * 2;
    const hit = ray.intersectObjects(meshes, false).find((h) => !!h.face && h.face.normal.clone().transformDirection(h.object.matrixWorld).y > 0.6);
    return hit ? [p[0], +(hit.point.y - G.gy(p[2])).toFixed(3), p[2]] : null;
  };
  // head room above a spot (a crouching / standing fighter must fit under whatever overhangs it)
  const clear = (p: V3, h: number) => {
    const w = G.w(p);
    ray.set(new THREE.Vector3(w.x, w.y + 0.15, w.z), new THREE.Vector3(0, 1, 0));
    ray.far = h;
    return ray.intersectObjects(meshes, false).length === 0;
  };
  A.perches = A.perches.flatMap((p) => {
    const s = snap(p.pos, 0.6);
    return s && clear(s, 2.3) && clear([s[0], s[1], s[2] + 0.35], 2.3) ? [{ ...p, pos: s }] : [];
  });
  // a low wall to vault: slide along the wall until the whole vault path has head room
  if (A.lowWall) {
    const W = A.lowWall;
    const side = W.pos[0] >= 0 ? 1 : -1;
    let ok: V3 | null = null;
    for (let x = Math.abs(W.pos[0]); x <= 7.5 && !ok; x += 0.4) {
      const path = [-2.2, -1.4, -0.7, 0, 0.7, 1.4, 2.2].map((dz) => [side * x, 0, W.pos[2] + dz] as V3);
      // head room all along the vault, and real ground where the run-up starts and where it lands
      if (path.every((q) => clear([q[0], 1.2, q[2]], 1.2)) && snap([side * x, 0, W.pos[2] - 1.0], 0.5) && snap([side * x, 0, W.pos[2] - 2.0], 0.5) && snap([side * x, 0, W.pos[2] + 1.6], 0.5)) ok = [side * x, W.pos[1], W.pos[2]];
    }
    A.lowWall = ok ? { ...W, pos: ok } : undefined;
  }
  A.stands = A.stands.flatMap((p) => {
    const s = snap(p, 0.7);
    return s ? [s] : [];
  });
  return A;
}

export function chooseVariant(fighterId: string, ctx: CineCtx, gate: number, force?: string): EntranceVariant | null {
  const list = ENTRANCE_VARIANTS[fighterId];
  if (!list) return null;
  const A = snapAnchors(ctx.arena, gate);
  const ok = list.filter((x) => (!force || x.v.id === force) && x.v.needs(A));
  if (!ok.length) return null;
  const r = new Rng(hashSeed(`entrance:${ctx.seed ?? 1}:${fighterId}:${gate}:${ctx.arena.layout.theme}`));
  return ok[r.weighted(ok.map((x) => x.w))]?.v ?? ok[0].v;
}

export function buildEntrance(ctx: CineCtx, view: FighterView, gate: 0 | 1, opp: FighterDef, monologue?: CineLine, opts: { variant?: string } = {}): Timeline & { meta?: EntranceMeta } {
  const variant = chooseVariant(view.def.id, ctx, gate, opts.variant);
  if (variant) return buildCompiled(ctx, view, gate, opp, monologue, variant);
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
  const meta: EntranceMeta = {
    variant: 'legacy',
    duration: spec.duration,
    events: spec.cues.filter((c) => c.fx && /gate_(shake|smash)/.test(c.fx)).map((c) => ({ t: c.t, fx: c.fx!, cause: 'hands' })),
    air: spec.actor.flatMap((k, i) => (k.state === 'airborne' || k.pos[1] !== 0 ? [[k.t, spec.actor[i + 1]?.t ?? k.t] as [number, number]] : [])),
    hidden: spec.actor.flatMap((k, i) => (k.pos[1] < -0.5 ? [[k.t, spec.actor[i + 1]?.t ?? k.t] as [number, number]] : [])),
    shots: spec.camera.map((c) => [c.t, c.t + c.dur] as [number, number]),
  };
  return Object.assign(tl, { meta });
}

// ------------------------------------------------------------------ compiled (beat) entrances
function buildCompiled(ctx: CineCtx, view: FighterView, gate: 0 | 1, opp: FighterDef, monologue: CineLine | undefined, variant: EntranceVariant): Timeline & { meta: EntranceMeta } {
  const A = ctx.arena.gates[gate].anchors;
  const ownImpacts = (clip: string): number[] => {
    if (clip.startsWith('lib:')) return ((libClip(clip.slice(4))?.meta as unknown as { impacts?: [number, string][] })?.impacts ?? []).map((x) => x[0]);
    const m = view.anim.meta.clips[clip];
    return m ? [m.strike, ...(m.peaks ?? []).filter((p) => p > m.strike + 0.05)] : [];
  };
  // cover / props / hazards in the gate frame (actor paths and low cameras steer around them)
  const G0 = new GateFrame(ctx.arena, gate);
  const avoid: [number, number, number][] = [];
  {
    const L = ctx.arena.layout;
    const toFrame = (x: number, z: number): [number, number] => {
      const dx = x - G0.o.x,
        dz = z - G0.o.z;
      return [dx * G0.r.x + dz * G0.r.z, dx * G0.f.x + dz * G0.f.z];
    };
    for (const o of L.obstacles) avoid.push([...toFrame(o.x, o.z), o.r + 0.75]);
    for (const p of L.props) avoid.push([...toFrame(p.x, p.z), p.r + 0.6]);
    for (const h of L.hazards) if (h.kind !== 'chandelier') avoid.push([...toFrame(h.x, h.z), h.r + 0.55]);
  }
  const pushOut = (p: V3, pad = 0): V3 => {
    let x = p[0],
      z = p[2];
    for (let it = 0; it < 3; it++)
      for (const [cx, cz, r0] of avoid) {
        const r = r0 + pad;
        const dx = x - cx,
          dz = z - cz;
        const d = Math.hypot(dx, dz);
        if (d < r) {
          const side = dx >= 0 ? 1 : -1;
          x = cx + side * Math.sqrt(Math.max(0, r * r - dz * dz)) + side * 0.02;
        }
      }
    return [x, p[1], z];
  };
  const vctx: VariantCtx = {
    free: (p) => pushOut(p, 0.4),
    A,
    probe: (clip, t, joints) => view.probe(clip, t, joints),
    hipsM: view.hipsM,
    impacts: ownImpacts,
    dur: (clip) => (clip.startsWith('lib:') ? (libClip(clip.slice(4))?.meta.dur ?? 1) : view.anim.dur(clip)),
    height: view.height,
  };
  let C: CompiledEntrance = variant.build(vctx);
  // A18: a gate up a stair: the choreography starts on the dais, the walk-outs come down the stair; beats that now cover
  // much more ground are slowed to their floor-level speed (+25 %), every time after them shifts with them, and an
  // establishing shot of the stair, the gate and the landmark opens the entrance
  if (A.ground && A.flat) {
    const C0 = variant.build({ ...vctx, A: { ...A, barrierZ: A.flat.barrierZ, tunnel: A.flat.tunnel, ground: undefined } });
    C = stairRetime(C, C0, A.ground, view.hipsM);
    C = stairEstablish(C, A, ctx, gate);
  }
  // monologue: hold the last beat / shot until the line has finished
  const speakAt = C.title - 0.2;
  const hold = monologue ? Math.max(0, speakAt + monologue.dur + 0.7 - C.duration) : 0;
  const beats: Beat[] = C.beats.map((b, i) => (i === C.beats.length - 1 ? { ...b, dur: b.dur + hold } : b));
  const camera = C.camera.map((c, i) => (i === C.camera.length - 1 ? { ...c, dur: c.dur + hold } : c));
  const duration = C.duration + hold;
  const T = beatTimes(beats);
  const G = new GateFrame(ctx.arena, gate);
  const tl = new Timeline();
  const gateObj = ctx.arena.gates[gate];
  const temp: THREE.Object3D[] = [];
  tl.cue('light', 0, () => {
    ctx.arena.applyMood(C.mood);
    gateObj.light.color.set(C.mood.gateColor);
    gateObj.light.intensity = 2;
    ctx.rig.collide = false;
    view.rig.root.visible = true;
  });

  // ---- actor: evaluate the beat at the local time
  // ground paths steer around cover / props / hazards standing in the way (pushed sideways, never backwards)
  const steer = (p: V3): V3 => (p[1] > 0.4 || p[1] < -0.3 ? p : pushOut(p));
  const startOf: V3[] = [];
  {
    // beat start positions (end of the previous beat's motion)
    let p: V3 = C.start;
    for (let i = 0; i < beats.length; i++) {
      startOf.push(p);
      p = beatPos(beats[i], p, beats[i].dur, view.hipsM);
      if (beats[i].exitY !== undefined) p = [p[0], beats[i].exitY!, p[2]];
    }
  }
  const pos = new THREE.Vector3();
  const prev = new THREE.Vector3();
  let first = true;
  let lastBeat = -1;
  tl.span('actor', 0, duration, (_k, lt, dt) => {
    let i = 0;
    while (i < beats.length - 1 && lt >= T[i + 1]) i++;
    const b = beats[i];
    const bt = lt - T[i];
    const raw = beatPos(b, startOf[i], bt, view.hipsM);
    const p = b.move.type === 'lerp' ? steer(raw) : raw;
    if (G.ground && b.air && b.move.type === 'lerp') {
      // A18: a leap over the stair is one arc between its take-off and landing heights (not a hop that follows the steps)
      const e = Ease[b.move.ease ?? 'inOut'](Math.max(0, Math.min(1, bt / Math.max(1e-3, b.dur))));
      const g0 = G.gy(startOf[i][2]),
        g1 = G.gy(b.move.to[2]);
      G.w(p, pos, g0 + (g1 - g0) * e);
    } else G.w(p, pos);
    const speed = first || dt <= 0 ? 0 : Math.hypot(pos.x - prev.x, pos.z - prev.z) / dt;
    first = false;
    prev.copy(pos);
    if (i !== lastBeat) {
      lastBeat = i;
    }
    // procedural pulses (pulling the bars): spring impulse backwards on the torso / arms
    for (const pt of b.pulses ?? []) if (bt - dt < pt && bt >= pt) view.anim.flinch.impulse(new THREE.Vector3(0, 0, 1), 1.1, 'body');
    view.updateManual(
      { state: b.state, clip: b.clip, phase: 0, phaseT: Math.min(1, bt / b.dur), stateT: (b.from ?? 0) + bt * (b.rate ?? 1), fwd: b.state === 'idle' || b.state === 'relaxed' || b.state === 'run' ? speed : 0 },
      pos,
      G.yaw + (b.yaw ?? 0),
      dt,
    );
  });

  // ---- camera
  const losPick = new Map<CamPose, number>();
  let solids: THREE.Mesh[] | null = null;
  const losRay = new THREE.Raycaster();
  const losClear = (from: THREE.Vector3, to: THREE.Vector3) => {
    if (!solids) {
      solids = [];
      const ex = new Set<THREE.Object3D>();
      gateObj.portcullis.traverse((o) => ex.add(o));
      ctx.arena.group.updateMatrixWorld(true);
      ctx.arena.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || ex.has(o) || (m as unknown as THREE.InstancedMesh).isInstancedMesh || o === ctx.arena.sky || o.userData.dyn) return;
        const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material;
        if (mat.transparent && mat.side !== THREE.BackSide) return;
        solids!.push(m);
      });
    }
    const d = to.clone().sub(from);
    const dist = d.length();
    losRay.set(from, d.normalize());
    losRay.far = Math.max(0.01, dist - 0.3);
    return losRay.intersectObjects(solids, false).length === 0;
  };
  const resolve = (cp: CamPose, outPos: THREE.Vector3, outLook: THREE.Vector3) => {
    // low cameras inside the arena step out of cover / props / hazard rims
    G.w(cp.pos[1] < 2.5 && cp.pos[2] > 0.3 ? pushOut(cp.pos, 0.35) : cp.pos, outPos);
    // ...and orbit around the subject if cover blocks the line of sight (camera inside the arena only)
    if (cp.pos[2] > 0.3) {
      const look = cp.look === 'actor' ? view.chestWorld(new THREE.Vector3()) : cp.look === 'head' ? view.headWorld(new THREE.Vector3()) : G.w(cp.look);
      resolveCamera(outPos, look, true, [view.chestWorld(new THREE.Vector3())]);
      if (outPos.y < 2.5) {
        const dx = outPos.x - G.o.x,
          dz = outPos.z - G.o.z;
        const fp = pushOut([dx * G.r.x + dz * G.r.z, outPos.y, dx * G.f.x + dz * G.f.z], 0.35);
        G.w(fp, outPos);
      }
    }
    if (cp.look === 'actor') view.chestWorld(outLook);
    else if (cp.look === 'head') view.headWorld(outLook);
    else G.w(cp.look, outLook);
  };
  const p0 = new THREE.Vector3(),
    p1 = new THREE.Vector3(),
    l0 = new THREE.Vector3(),
    l1 = new THREE.Vector3();
  for (const shot of camera)
    tl.span('camera', shot.t, shot.dur, (k, _lt, dt) => {
      const e = Ease[shot.ease ?? 'inOut'](k);
      resolve(shot.from, p0, l0);
      resolve(shot.to, p1, l1);
      p0.lerp(p1, e);
      l0.lerp(l1, e);
      // real line of sight on the INTERPOLATED camera against the built geometry (decor the layout data
      // does not know: props, brazier stands, lanterns, rubble). The chosen fallback sticks for the shot.
      if (shot.from.pos[2] > 0.3 || shot.to.pos[2] > 0.3) {
        const target = view.chestWorld(new THREE.Vector3());
        const tryAt = (i: number) => {
          const c = p0.clone();
          if (i === 1) c.y += 1.2;
          else if (i === 2) c.lerp(target, 0.35);
          else if (i === 3) c.y += 2.4;
          else if (i === 4) c.lerp(target, 0.55).setY(c.y + 0.8);
          else if (i === 5 || i === 6) {
            // onto the gate's axis (looking straight down the tunnel), same depth
            const dep = (c.x - G.o.x) * G.f.x + (c.z - G.o.z) * G.f.z;
            c.x = G.o.x + G.f.x * dep;
            c.z = G.o.z + G.f.z * dep;
            if (i === 6) c.y = Math.max(c.y, 1.6);
          }
          return c;
        };
        let pick = losPick.get(shot.from) ?? 0;
        if (!losClear(tryAt(pick), target)) {
          for (let i = 0; i < 7; i++)
            if (losClear(tryAt(i), target)) {
              pick = i;
              break;
            }
          losPick.set(shot.from, pick);
        }
        p0.copy(tryAt(pick));
        // a moved camera re-aims toward the actor so a fixed look point cannot leave them out of frame
        if (pick !== 0) l0.lerp(target, 0.6);
      }
      const fov = shot.from.fov + (shot.to.fov - shot.from.fov) * e;
      ctx.rig.cut(p0, l0, fov);
      ctx.rig.update(p0, l0, fov, dt);
    });

  tl.cue('text', C.title, () => ctx.ui.showTitle(view.def, opp, gate));
  if (monologue) tl.cue('audio', speakAt, () => monologue.play());
  tl.cue('text', duration - 0.3, () => ctx.ui.hideTitle());

  // ---- cues: beat cues (bound to measured impacts) + extra cues
  const events: EntranceMeta['events'] = [];
  const actorPos = () => view.rig.root.position.clone();
  const all: { t: number; fx?: string; sfx?: string; arg?: number; dur?: number; cause?: string }[] = [...C.cues];
  beats.forEach((b, i) => {
    for (const c of b.cues ?? []) {
      let t: number;
      if (typeof c.at === 'number') t = T[i] + c.at;
      else {
        const clip = b.clip ?? '';
        let imps = ownImpacts(clip);
        const eff = c.at.effector;
        if (eff && clip.startsWith('lib:')) {
          const raw = ((libClip(clip.slice(4))?.meta as unknown as { impacts?: [number, string][] })?.impacts ?? []).filter((x) => x[1] === eff);
          if (raw.length) imps = raw.map((x) => x[0]);
        }
        const it = imps.filter((x) => x >= (b.from ?? 0))[(c.at as { impact: number }).impact] ?? imps[0] ?? 0;
        t = T[i] + (it - (b.from ?? 0)) / Math.max(1e-3, b.rate ?? 1);
      }
      all.push({ t, fx: c.fx, sfx: c.sfx, arg: c.arg, dur: c.dur, cause: c.cause });
      if (c.cause && c.fx) events.push({ t, fx: c.fx, cause: c.cause });
    }
  });
  for (const c of all) {
    if (c.sfx) tl.cue('audio', c.t, () => playSfx(ctx.audio, c.sfx!));
    if (c.fx) addFx(tl, ctx, c.fx, c.t, c.dur ?? 1, c.arg ?? 0, G, view, gate, temp, actorPos, duration);
  }
  tl.cue('cleanup', duration, () => {
    for (const o of temp) ctx.scene.remove(o);
    gateObj.light.intensity = 3;
  });
  const air: [number, number][] = beats.flatMap((b, i) => (b.air ? [[T[i], T[i + 1]] as [number, number]] : []));
  const hidden: [number, number][] = beats.flatMap((b, i) => (b.hidden ? [[T[i], T[i + 1]] as [number, number]] : []));
  const meta: EntranceMeta = { variant: C.id, duration, events, air, hidden, shots: camera.map((c) => [c.t, c.t + c.dur]) };
  return Object.assign(tl, { meta });
}

/** actor position (gate frame) at bt seconds into a beat that started at p0 */
function beatPos(b: Beat, p0: V3, bt: number, hipsM: number): V3 {
  const k = Math.max(0, Math.min(1, bt / Math.max(1e-3, b.dur)));
  const m = b.move;
  if (m.type === 'hold') return p0;
  if (m.type === 'lerp') {
    const e = Ease[m.ease ?? 'inOut'](k);
    const y = p0[1] + (m.to[1] - p0[1]) * e + (m.arc ? Math.sin(k * Math.PI) * m.arc : 0);
    return [p0[0] + (m.to[0] - p0[0]) * e, y, p0[2] + (m.to[2] - p0[2]) * e];
  }
  // root motion from the library clip's root curve (clip frame: +z forward, +x left)
  const id = b.clip?.startsWith('lib:') ? b.clip.slice(4) : '';
  const d = id ? decodeClip(id) : null;
  let x = p0[0],
    z = p0[2],
    y = p0[1];
  const from = b.from ?? 0,
    rate = b.rate ?? 1;
  const ct = from + bt * rate;
  if (d) {
    const a = rootAt(d, from),
      c = rootAt(d, Math.min(d.dur, ct));
    const s = (m.scale ?? 1) * hipsM;
    const dx = (c.x - a.x) * s,
      dz = (c.z - a.z) * s;
    // rotate the clip's frame by the beat yaw (gate frame: x right, z inward; clip +x = character's left)
    const yaw = b.yaw ?? 0;
    const cs = Math.cos(yaw),
      sn = Math.sin(yaw);
    // gate frame: forward = (-sin yaw, cos yaw), character left (clip +x) = (-cos yaw, -sin yaw)
    x += -dx * cs - dz * sn;
    z += -dx * sn + dz * cs;
  }
  if (m.y) {
    const t0 = m.y.t0,
      t1 = m.y.t1;
    const kk = t1 > t0 ? Math.max(0, Math.min(1, (k - t0) / (t1 - t0))) : 1;
    const curve = m.y.curve === 'fall' ? kk * kk : m.y.curve === 'rise' ? 1 - (1 - kk) * (1 - kk) : kk * kk * (3 - 2 * kk);
    y = m.y.from + (m.y.to - m.y.from) * curve;
  }
  return [x, y, z];
}

/** beat start positions (gate frame) of a compiled entrance */
function beatStarts(C: CompiledEntrance, hipsM: number): V3[] {
  const out: V3[] = [];
  let p: V3 = C.start;
  for (const b of C.beats) {
    out.push(p);
    p = beatPos(b, p, b.dur, hipsM);
    if (b.exitY !== undefined) p = [p[0], b.exitY, p[2]];
  }
  return out;
}

/**
 * A18: re-time an entrance at a gate up a stair. `C` is built on the real anchors (dais, stair), `C0` the same variant at
 * the gate's floor-level equivalent; a moving (lerp) beat that has to cover more ground than its floor-level twin is
 * slowed so it is at most 25 % faster than authored. Cues inside a slowed beat keep their place along the path; camera
 * shots, extra cues and the title card follow the piecewise-linear time warp.
 */
function stairRetime(C: CompiledEntrance, C0: CompiledEntrance, gr: NonNullable<GateAnchors['ground']>, hipsM: number): CompiledEntrance {
  if (C.beats.length !== C0.beats.length) return C;
  const len = (b: Beat, p0: V3, g?: GateAnchors['ground']) => {
    let L = 0;
    let prev: THREE.Vector3 | null = null;
    for (let s = 0; s <= 16; s++) {
      const q = beatPos(b, p0, (s / 16) * b.dur, hipsM);
      const v = new THREE.Vector3(q[0], q[1] + groundY(g, q[2]), q[2]);
      if (prev) L += v.distanceTo(prev);
      prev = v;
    }
    return L;
  };
  const s1 = beatStarts(C, hipsM),
    s0 = beatStarts(C0, hipsM);
  const f = C.beats.map((b, i) => {
    if (b.move.type !== 'lerp' || b.dur <= 0) return 1;
    const L1 = len(b, s1[i], gr),
      L0 = len(C0.beats[i], s0[i]);
    if (L0 < 0.05) return L1 > 0.5 ? Math.max(1, L1 / b.dur / 2.2) : 1;
    return Math.max(1, L1 / L0 / 1.25);
  });
  const beats: Beat[] = C.beats.map((b, i) =>
    f[i] === 1
      ? b
      : {
          ...b,
          dur: b.dur * f[i],
          pulses: b.pulses?.map((t) => t * f[i]),
          cues: b.cues?.map((c) => (typeof c.at === 'number' ? { ...c, at: c.at * f[i] } : c)),
        },
  );
  const T0 = beatTimes(C.beats),
    T1 = beatTimes(beats);
  const n = C.beats.length;
  const warp = (t: number) => {
    for (let i = 0; i < n; i++) if (t < T0[i + 1]) return T1[i] + Math.max(0, t - T0[i]) * f[i];
    return T1[n] + (t - T0[n]);
  };
  const camera = C.camera.map((s) => {
    const a = warp(s.t),
      b = warp(s.t + s.dur);
    return { ...s, t: a, dur: b - a };
  });
  return { ...C, beats, camera, cues: C.cues.map((c) => ({ ...c, t: warp(c.t) })), title: warp(C.title), duration: T1[n] };
}

/**
 * A18: open an entrance at a stair gate with an establishing shot: low in the arena, looking up the stair at the gate on
 * the dais with the landmark and the moon behind it, slowly pushing in while the actor waits in their first pose. The
 * side (left / right of the gate axis) that keeps the hanging hazards out of the frame wins.
 */
function stairEstablish(C: CompiledEntrance, A: GateAnchors, ctx: CineCtx, gate: number, pre = 2.8): CompiledEntrance {
  const b0 = C.beats[0];
  const lead: Beat = { dur: pre, state: b0.state, clip: b0.clip, from: b0.from, rate: b0.state === 'clip' ? 0 : 1, move: { type: 'hold' }, yaw: b0.yaw, air: b0.air, hidden: b0.hidden };
  const bz = A.barrierZ;
  const G = new GateFrame(ctx.arena, gate);
  const look: V3 = [0, 2.8, bz - 0.8];
  // candidates: side of the axis, distance into the arena (closer = past hazards hanging between the centre and the stair)
  type Cand = { sx: number; d: number };
  const pose = (c: Cand, k: number): [V3, V3, number] => [[c.sx * (2.6 - 0.8 * k), 0.9 + 0.5 * k, c.d - 2.8 * k], look, (c.d > 9 ? 50 : 54) - 6 * k];
  const cands: Cand[] = [12.6, 9.4, 6.6].flatMap((d) => [1, -1].map((sx) => ({ sx, d })));
  const L = ctx.arena.layout;
  const aspect = ctx.rig.cam.aspect || 16 / 9;
  let best = cands[0],
    bestP = Infinity;
  for (const c of cands) {
    let pen = c.d === 12.6 ? 0 : 0.08;
    for (const k of [0, 0.5, 1]) {
      const [p, l, fov] = pose(c, k);
      const wp = G.w(p);
      pen += hazardPenalty(L, wp, G.w(l), fov, aspect);
      for (const o of L.obstacles) if (Math.hypot(wp.x - o.x, wp.z - o.z) < o.r + 1.1) pen += 2;
      for (const o of L.props) if (Math.hypot(wp.x - o.x, wp.z - o.z) < o.r + 0.9) pen += 1;
    }
    if (pen < bestP - 1e-3) {
      bestP = pen;
      best = c;
    }
  }
  const [p0, l0, f0] = pose(best, 0),
    [p1, l1, f1] = pose(best, 1);
  const shot: CamShot = { t: 0, dur: pre, from: { pos: p0, look: l0, fov: f0 }, to: { pos: p1, look: l1, fov: f1 }, ease: 'inOut' };
  return {
    ...C,
    beats: [lead, ...C.beats],
    camera: [shot, ...C.camera.map((s) => ({ ...s, t: s.t + pre }))],
    cues: [{ t: 0.3, fx: 'gate_light' }, ...C.cues.map((c) => ({ ...c, t: c.t + pre }))],
    title: C.title + pre,
    duration: C.duration + pre,
  };
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
      });
      // the rattle settles 90 ms later on the cutscene clock (was a wall-clock setTimeout)
      tl.cue('vfx', t + 0.09, () => (gateObj.portcullis.position.z = 0.2));
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
    case 'gate_open': {
      // A18: a gate on a dais (no gatehouse over it) lowers its bars into the dais instead of lifting them into the sky
      const dir = gateObj.anchors.ground ? -1 : 1;
      tl.span('vfx', t, dur, (k) => {
        gateObj.portcullis.position.y = dir * Ease.inOut(k) * 3.7;
      });
      break;
    }
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
          if (V.rand() < 0.15) V.embers(new THREE.Vector3(p.x, 1.7, p.z), 1, '#ffb060', 0.1);
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
          for (let i = 0; i < 6; i++) V.fire(new THREE.Vector3(p.x + (V.rand() - 0.5) * 0.9, V.rand() * 1.5, p.z + (V.rand() - 0.5) * 0.9), new THREE.Vector3(0, 6 + V.rand() * 4, 0), 1, 0.7 * strength + 0.2, 0.5);
          if (V.rand() < 0.5) V.embers(p.clone().setY(1), 2, '#ffaa40', 1);
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
    case 'slowmo':
      tl.cue('vfx', t, () => ctx.slowmo?.(arg || 0.3, dur));
      break;
    case 'barrier_shake': {
      // the bars move with his pull: bend in, spring back (per piece, slightly different)
      const A = gateObj.anchors;
      tl.span(
        'vfx',
        t,
        0.55,
        (k) => {
          const amp = Math.sin(k * Math.PI * 3) * Math.exp(-k * 3) * (0.07 + arg * 0.02);
          A.pieces.forEach((pc, i) => {
            pc.obj.position.z = pc.pos.z - amp * (0.7 + ((i * 37) % 10) / 15);
            pc.obj.rotation.x = pc.rot.x + amp * 0.25 * (i % 2 ? 1 : -1);
          });
        },
        () => {
          ctx.rig.addShake(0.22 + arg * 0.06);
          V.dust(G.w([0, A.barrierH * 0.95, A.barrierZ + 0.1]), 10, 1.4);
          V.sparks(G.w([0, 1.6, A.barrierZ + 0.1]), 6, '#ffb060', 3);
        },
        () => A.pieces.forEach((pc) => (pc.obj.position.copy(pc.pos), pc.obj.rotation.copy(pc.rot))),
      );
      break;
    }
    case 'barrier_break': {
      // pre-fractured pieces fly along the strike direction (into the arena), tumble, bounce, settle
      const A = gateObj.anchors;
      const vel: THREE.Vector3[] = [];
      const spin: THREE.Vector3[] = [];
      const rng = (i: number, k: number) => ((Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
      tl.span(
        'vfx',
        t,
        2.4,
        (_k, _lt, dt) => {
          A.pieces.forEach((pc, i) => {
            const v = vel[i];
            if (!v) return;
            if (A.barrier === 'veil') {
              const mt = (pc.obj as THREE.Mesh).material as THREE.MeshBasicMaterial;
              if (mt) mt.opacity = Math.max(0, mt.opacity - dt * 3.5);
              return;
            }
            v.y -= 13 * dt;
            pc.obj.position.addScaledVector(v, dt);
            pc.obj.rotation.x += spin[i].x * dt;
            pc.obj.rotation.y += spin[i].y * dt;
            pc.obj.rotation.z += spin[i].z * dt;
            // ground in the portcullis group's local frame (group origin is on the floor)
            if (pc.obj.position.y < 0.05) {
              pc.obj.position.y = 0.05;
              v.y = Math.abs(v.y) * 0.25;
              v.x *= 0.6;
              v.z *= 0.6;
              spin[i].multiplyScalar(0.5);
            }
          });
        },
        () => {
          gateObj.smashed = true;
          A.pieces.forEach((pc, i) => {
            const up = A.barrier === 'rope' ? 0 : 2 + rng(i, 1) * 3;
            const fwd = A.barrier === 'rope' ? 0.5 : 4 + rng(i, 2) * 6 * (arg ? 1 : 0.6);
            vel[i] = new THREE.Vector3((rng(i, 3) - 0.5) * 3, up, fwd);
            spin[i] = new THREE.Vector3((rng(i, 4) - 0.5) * 9, (rng(i, 5) - 0.5) * 6, (rng(i, 6) - 0.5) * 9);
          });
          const p = G.w([0, 1.8, A.barrierZ + 0.2]);
          ctx.rig.addShake(0.9);
          ctx.rig.punchFov(8);
          if (A.barrier === 'veil') {
            V.sparks(p, 90, '#fff2c0', 9);
            V.embers(p, 70, '#ffe6a0', 1.6);
            V.flash(p, '#fff6d8', 3.5, 30);
          } else if (A.barrier === 'icicles') {
            V.sparks(p, 70, '#bfefff', 10);
            V.debrisBurst(p, '#cfefff', 18);
            V.flash(p, '#bfe8ff', 2.5, 20);
          } else {
            V.debrisBurst(p, '#3b3632', 16);
            V.sparks(p, 70, '#ffb060', 11);
            V.flash(p, '#ff9a50', 3, 25);
          }
          V.dust(G.w([0, 0.2, A.barrierZ + 1.2]), 34, 2.4);
        },
      );
      break;
    }
    case 'shadow_pool': {
      const p = actorPos().setY(0.03);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(1.3, 40), new THREE.MeshBasicMaterial({ color: '#07040c', transparent: true, opacity: 0, depthWrite: false }));
      disc.rotation.x = -Math.PI / 2;
      disc.position.copy(p);
      tl.span(
        'vfx',
        t,
        dur,
        (k) => {
          (disc.material as THREE.MeshBasicMaterial).opacity = Math.min(0.92, k * 6) * (k > 0.8 ? (1 - k) * 5 : 1);
          if (V.rand() < 0.6) V.smoke(p.clone().setY(0.2), 1, '#1a1024', 0.9, 0.5);
        },
        () => {
          ctx.scene.add(disc);
          temp.push(disc);
        },
      );
      break;
    }
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
  if (ctx.arena.kit?.art.cine?.faceoff === 'landmark') {
    // A18 (ref-3): low over the west fighter's shoulder, the east fighter in front of the stair, the gate, the ring arch
    // and the moon, slowly pushing in; the fight camera then blends in from here (Director handover: ots_0 on this side)
    const aspect = ctx.rig.cam.aspect || 16 / 9;
    // camera behind and beside the west fighter, tilted up so the ring arch and the moon are in (ref-3: pitch about 7 deg,
    // the stair right of centre); candidates by side / offset / height, scored on the hanging hazards and on columns in
    // the way of the east fighter or the stair
    const L = ctx.arena.layout;
    const pose = (c: { s: number; lat: number; h: number }, k: number): [THREE.Vector3, THREE.Vector3, number] => {
      const me = start[0],
        them = start[1];
      const fwd = them.clone().sub(me).normalize();
      const side = new THREE.Vector3(-fwd.z, 0, fwd.x).multiplyScalar(c.s);
      const p = me.clone().addScaledVector(fwd, -3.4 + 0.6 * k).addScaledVector(side, c.lat);
      p.y = c.h + 0.12 * k;
      const l = them.clone().addScaledVector(fwd, 5.0).addScaledVector(side, -1.0 * c.lat).setY(4.3 - 0.2 * k);
      return [p, l, 50 - 3 * k];
    };
    const through = (a: THREE.Vector3, b: THREE.Vector3) =>
      L.obstacles.some((o) => {
        const dx = b.x - a.x,
          dz = b.z - a.z;
        const u = Math.max(0, Math.min(1, ((o.x - a.x) * dx + (o.z - a.z) * dz) / (dx * dx + dz * dz || 1e-6)));
        return Math.hypot(a.x + dx * u - o.x, a.z + dz * u - o.z) < o.r + 0.35;
      });
    const cands = [1, -1].flatMap((s) => [2.2, 3.2, 1.4].flatMap((lat) => [1.25, 0.9].map((h) => ({ s, lat, h }))));
    let best = cands[0],
      bp = Infinity;
    for (const c of cands) {
      let pen = (c.lat !== 2.2 ? 0.05 : 0) + (c.h !== 1.25 ? 0.05 : 0);
      for (const k of [0, 1]) {
        const [p, l, f] = pose(c, k);
        pen += hazardPenalty(L, p, l, f, aspect);
        if (through(p, start[1])) pen += 3;
        if (through(p, new THREE.Vector3(L.rx + 4, 0, 0))) pen += 1.5;
        for (const o of L.obstacles) if (Math.hypot(p.x - o.x, p.z - o.z) < o.r + 1.2) pen += 3;
        for (const o of L.props) if (Math.hypot(p.x - o.x, p.z - o.z) < o.r + 0.8) pen += 2;
      }
      if (pen < bp - 1e-3) {
        bp = pen;
        best = c;
      }
    }
    // a composed shot in the open arena: no collision orbit (beginFight turns collision back on)
    tl.cue('camera', riseAt, () => (ctx.rig.collide = false));
    // the over-the-shoulder framing is deliberate: no stale "fighters lined up" orbit from the last fight's subjects
    tl.cue('camera', riseAt, () => (ctx.rig.subjects = []));
    shot(riseAt, total - riseAt, (k) => {
      const [p, l, f] = pose(best, Ease.inOut(k));
      return [p0.copy(p), l0.copy(l), f];
    });
  } else
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
