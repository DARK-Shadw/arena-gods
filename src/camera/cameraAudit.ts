/**
 * CAMERA READABILITY AUDIT (browser, headless: the real director + rig on the
 * real arena geometry, no rendering).
 *
 * Plays a match through the app at 30 Hz and scores every frame:
 *  - framing: both fighters' chests inside the safe frame (|ndc| <= 0.9)
 *  - size: projected height of each fighter (fraction of the frame height)
 *  - occlusion: arena geometry (cover, walls, props, dressing) or the other
 *    fighter between the camera and BOTH head and chest of a fighter
 *  - action focus: on every hit / finisher contact the contact point (victim's
 *    chest) is in the safe frame and visible
 *  - cuts: cuts per minute and shots shorter than 0.5 s
 * A frame is READABLE when both fighters are framed, neither is fully
 * occluded and the closer one is at least 9% of the frame tall.
 */
import * as THREE from 'three';
import type { Frame, MatchRecord, SimEvent } from '../sim/types';

export interface CamAuditApp {
  camera: THREE.PerspectiveCamera;
  views: { root: THREE.Object3D; headWorld: (o?: THREE.Vector3) => THREE.Vector3; chestWorld: (o?: THREE.Vector3) => THREE.Vector3; height: number; def: { stats: { radius: number } } }[];
  arena: { group: THREE.Object3D; sky: THREE.Object3D; props?: { obj: THREE.Object3D }[]; obstacles?: { pivot: THREE.Object3D }[] };
  rec: MatchRecord;
  playback: { t: number; duration: number; frameAt: (t: number) => Frame };
  director: { shotName: string; lastCut: number };
  realT: number;
  stepFrames: (n: number, dt?: number) => void;
}

export interface CamMatchScore {
  key: string;
  frames: number;
  readable: number;
  framedBoth: number;
  occluded: number;
  small: number;
  contactsSeen: number;
  contacts: number;
  cutsPerMin: number;
  shortShots: number;
  worst: { t: number; why: string; shot: string }[];
  byShot: Record<string, { n: number; bad: number; why?: Record<string, number> }>;
}

/**
 * Ray-cast solids of the arena. A7: this includes the arena's `losGroup` (a child of the arena group): invisible proxy meshes
 * (material.visible = false, never drawn) standing in for instanced / dyn art (the kit wet floor); they are plain visible
 * Object3Ds with an opaque material, so the filters below keep them.
 */
export function solids(group: THREE.Object3D, sky: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh || o === sky || o.userData.dyn || !o.visible) return;
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material & { opacity?: number };
    if (mat.transparent && (mat.opacity ?? 1) < 0.6) return;
    if ((m.geometry as THREE.BufferGeometry).type === 'PlaneGeometry' && mat.transparent) return;
    out.push(m);
  });
  return out;
}

export function auditMatch(app: CamAuditApp, key: string, fps = 30): CamMatchScore {
  const cam = app.camera;
  // headless (no render): world matrices of the static arena must be brought up to date once
  app.arena.group.updateMatrixWorld(true);
  const S = solids(app.arena.group, app.arena.sky);
  const ray = new THREE.Raycaster();
  const score: CamMatchScore = { key, frames: 0, readable: 0, framedBoth: 0, occluded: 0, small: 0, contactsSeen: 0, contacts: 0, cutsPerMin: 0, shortShots: 0, worst: [], byShot: {} };
  const events = app.rec.events;
  let evIdx = 0;
  let lastCut = app.director.lastCut;
  let cuts = 0;
  let shotStart = app.realT;
  let badRun = 0;
  const kill = events.find((e) => e.type === 'kill');
  const end = Math.min(app.playback.duration, (kill?.t ?? app.playback.duration) + 3);
  const ndc = (p: THREE.Vector3) => p.clone().project(cam);
  const inSafe = (q: THREE.Vector3) => q.z < 1 && Math.abs(q.x) <= 0.9 && Math.abs(q.y) <= 0.9;
  const blocked = (p: THREE.Vector3, ignore: number) => {
    const d = p.clone().sub(cam.position);
    const dist = d.length();
    ray.set(cam.position, d.normalize());
    ray.far = dist - 0.25;
    const hits = ray.intersectObjects(S, false);
    if (hits.length) {
      const h = hits[0];
      const g = (h.object as THREE.Mesh).geometry as THREE.BufferGeometry;
      return `arena:${h.object.name || g.type}@${h.point.toArray().map((x) => x.toFixed(1)).join(',')}`;
    }
    // the other fighter's body (capsule) in the way
    for (let k = 0; k < app.views.length; k++) {
      if (k === ignore) continue;
      const v = app.views[k];
      const a = v.root.position.clone().setY(0.4),
        b = v.root.position.clone().setY(v.height * 0.85);
      const seg = new THREE.Line3(a, b);
      // closest approach of the camera ray to the capsule axis
      let best = 9;
      for (let s = 0; s <= 10; s++) {
        const q = cam.position.clone().addScaledVector(ray.ray.direction, (dist - 0.4) * (s / 10));
        best = Math.min(best, seg.closestPointToPoint(q, true, new THREE.Vector3()).distanceTo(q));
      }
      if (best < v.def.stats.radius * 0.75) return 'fighter';
    }
    return '';
  };
  const dt = 1 / fps;
  while (app.playback.t < end - dt) {
    app.stepFrames(1, dt);
    for (const v of app.views) v.root.updateMatrixWorld(true);
    // props and toppling cover move every frame (headless: nothing renders, so bring them up to date)
    for (const p of app.arena.props ?? []) p.obj.updateMatrixWorld(true);
    for (const o of app.arena.obstacles ?? []) o.pivot.updateMatrixWorld(true);
    cam.updateMatrixWorld(true);
    score.frames++;
    const shot = app.director.shotName;
    const bs = (score.byShot[shot] ??= { n: 0, bad: 0 });
    bs.n++;
    if (app.director.lastCut !== lastCut) {
      cuts++;
      if (app.realT - shotStart < 0.5) score.shortShots++;
      shotStart = app.realT;
      lastCut = app.director.lastCut;
    }
    const fr = app.playback.frameAt(app.playback.t);
    // close-ups are about ONE fighter by design (reaction close-ups, finisher cut-ins): only that one must read
    // shots about ONE fighter by grammar: reaction close-ups, over-the-shoulder (the far one), crane over the
    // downed fighter, launch follow, finisher cut-in (the victim)
    const m1 = /^(react|launch)_(\d)$/.exec(shot),
      m2 = /^ots_(\d)$/.exec(shot),
      m3 = /^crane_(\d)$/.exec(shot);
    const soloIdx = m1 ? Number(m1[2]) : m2 ? 1 - Number(m2[1]) : m3 ? 1 - Number(m3[1]) : shot === 'cutin' ? -2 : -1;
    let framed = 0,
      occ = 0;
    let maxSize = 0;
    const why: string[] = [];
    app.views.forEach((v, i) => {
      const victim = app.rec.events.find((e) => e.type === 'finisher_start')?.b;
      if ((soloIdx >= 0 && i !== soloIdx) || (soloIdx === -2 && i !== victim) || (fr.f[i].state === 'dead' && app.playback.t > (kill?.t ?? 1e9) + 1.5)) {
        framed++;
        return;
      }
      const chest = v.chestWorld(new THREE.Vector3()),
        head = v.headWorld(new THREE.Vector3());
      const qc = ndc(chest),
        qh = ndc(head),
        qf = ndc(v.root.position.clone());
      if (inSafe(qc)) framed++;
      else why.push(`f${i} out of frame`);
      const size = Math.abs(qh.y - qf.y) / 2;
      maxSize = Math.max(maxSize, size);
      const bh = blocked(head, i),
        bc = blocked(chest, i);
      if (bh && bc) {
        occ++;
        why.push(`f${i} hidden by ${bc}`);
      }
    });
    const small = maxSize < 0.09;
    if (small) why.push('fighters tiny');
    if (framed === 2) score.framedBoth++;
    if (occ) score.occluded++;
    if (small) score.small++;
    const ok = framed === 2 && occ === 0 && !small;
    if (ok) {
      score.readable++;
      badRun = 0;
    } else {
      bs.bad++;
      const wk = why.map((w) => w.replace(/@.*$/, '').replace(/:.*$/, '')).join('+') || 'unknown';
      (bs.why ??= {})[wk] = (bs.why[wk] ?? 0) + 1;
      badRun++;
      if (badRun === Math.round(0.4 * fps) && score.worst.length < 12) score.worst.push({ t: +app.playback.t.toFixed(2), why: why.join(', '), shot });
    }
    // action focus: contact moments
    while (evIdx < events.length && events[evIdx].t <= app.playback.t) {
      const e: SimEvent = events[evIdx++];
      const contact = e.type === 'hit' || (e.type === 'finisher_contact' && e.data?.kind === 'kill') || e.type === 'kill';
      if (!contact || e.b === undefined || e.b < 0) continue;
      score.contacts++;
      const p = app.views[e.b].chestWorld(new THREE.Vector3());
      if (inSafe(ndc(p)) && !blocked(p, e.b)) score.contactsSeen++;
      else if (score.worst.length < 12) score.worst.push({ t: +e.t.toFixed(2), why: `contact (${e.type}) not visible`, shot });
    }
  }
  score.cutsPerMin = +((cuts / Math.max(1, score.frames / fps)) * 60).toFixed(1);
  return score;
}

/**
 * Fast line-of-sight proxies for the live director: huge ground/backdrop meshes are dropped (they cannot sit
 * between a camera above the floor and a fighter), and big merged static meshes (walls, stands) are split
 * into 4 m world-space tiles so the ray's bounding-sphere test culls most triangles.
 */
export function rayProxies(meshes: THREE.Mesh[]): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const v = new THREE.Vector3();
  const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  for (const m of meshes) {
    box.setFromObject(m).getSize(size);
    if (Math.max(size.x, size.z) > 200) continue;
    const g = m.geometry as THREE.BufferGeometry;
    const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
    if (tris < 1500) {
      out.push(m);
      continue;
    }
    const pos = g.attributes.position;
    const idx = g.index;
    const cells = new Map<string, number[]>();
    const tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let t = 0; t < tris; t++) {
      for (let k = 0; k < 3; k++) {
        const i = idx ? idx.getX(t * 3 + k) : t * 3 + k;
        tri[k].fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      }
      v.copy(tri[0]).add(tri[1]).add(tri[2]).multiplyScalar(1 / 3);
      const key = Math.floor(v.x / 4) + ',' + Math.floor(v.y / 4) + ',' + Math.floor(v.z / 4);
      let arr = cells.get(key);
      if (!arr) cells.set(key, (arr = []));
      for (const p of tri) arr.push(p.x, p.y, p.z);
    }
    for (const arr of cells.values()) {
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      cg.computeBoundingSphere();
      const cm = new THREE.Mesh(cg, mat);
      cm.updateMatrixWorld(true);
      out.push(cm);
    }
  }
  return out;
}
