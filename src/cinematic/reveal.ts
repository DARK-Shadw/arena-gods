/**
 * Arena reveal: a pre-match establishing flythrough (crane over the arena,
 * sweep around the far side, glide down toward the first gate) with the
 * arena's name card. Camera poses are derived from the generated layout so it
 * works for every theme / layout.
 *
 * A18: a theme with the `landmark` reveal hint (ThemeArt.cine, the Moon Gate) gets its own move instead: it opens on the
 * storm sky with the moon, tilts down onto the ring arch, cranes down toward the hero stair (azimuth 0) and finishes in
 * a low three-quarter glide on the stair, the gate, the fire bowls and the guardians. The side, end distance and
 * lateral offset are chosen per layout so the hanging hazards stay out of the frame and the lens clears the cover.
 */
import * as THREE from 'three';
import { Ease, Timeline } from './timeline';
import type { CineCtx } from './entrance';
import { hazardPenalty } from './framing';

export function buildReveal(ctx: CineCtx, dur = 6.2): Timeline {
  if (ctx.arena.kit?.art.cine?.reveal === 'landmark') return buildLandmarkReveal(ctx);
  const A = ctx.arena;
  const L = A.layout;
  const T = A.theme;
  const tl = new Timeline();
  const R = Math.max(L.rx, L.rz);
  // start opposite the sun so the arena is front-lit, end looking at the west gate
  const sunAz = Math.atan2(T.sky.sunDir.z, T.sky.sunDir.x);
  const a0 = sunAz + Math.PI * 0.75,
    a1 = sunAz + Math.PI * 1.35;
  const p = new THREE.Vector3(),
    look = new THREE.Vector3();
  tl.cue('light', 0, () => {
    A.restoreLighting();
    ctx.rig.collide = false;
    ctx.ui.splashText(`${T.name}<small>${T.tagline}</small>`, 'arena');
  });
  tl.span('camera', 0, dur, (k, _lt, dt) => {
    const e = Ease.inOut(k);
    const ang = a0 + (a1 - a0) * e;
    // stay high over the backdrop (trees, stands) until inside the arena wall
    const rad = R * (1.9 - 1.1 * e);
    const h = 4.5 + 13.5 * (1 - e * e);
    p.set(Math.cos(ang) * rad, h, Math.sin(ang) * rad);
    look.set(Math.cos(ang + Math.PI) * R * 0.25 * (1 - e), 1.5 + 2 * (1 - e), 0);
    const fov = 52 - 8 * e;
    ctx.rig.cut(p, look, fov);
    ctx.rig.update(p, look, fov, dt);
  });
  tl.cue('text', dur - 0.6, () => ctx.ui.hideSplash());
  return tl;
}

interface Key {
  t: number;
  p: THREE.Vector3;
  l: THREE.Vector3;
  fov: number;
}

/** the landmark reveal's key poses for one choice of side (s = +-1 on z), end distance and lateral offset */
function landmarkKeys(rx: number, s: number, endD: number, lat: number): Key[] {
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // the moon / ring arch sit at azimuth 0 (+x), about 70 m out; the stair foot at rx + 0.9, the gate on the dais at rx + 8
  const sky = (p: THREE.Vector3, elev: number) => p.clone().add(V(Math.cos((elev * Math.PI) / 180) * 80, Math.sin((elev * Math.PI) / 180) * 80, 0));
  const p0 = V(-rx * 0.62, 10.5, s * 5.5);
  const p1 = V(-rx * 0.34, 6.8, s * 4.2);
  const p2 = V(rx * 0.12, 2.8, s * 2.6);
  const p3 = V(rx - endD, 1.35, -s * lat);
  return [
    { t: 0, p: p0, l: sky(p0, 33), fov: 54 },
    { t: 0.3, p: p1, l: V(70, 30, 0), fov: 50 },
    { t: 0.62, p: p2, l: V(rx + 10, 7.5, 0), fov: 47 },
    { t: 1, p: p3, l: V(rx + 9, 5.2, s * Math.min(1.2, lat * 0.25)), fov: 46 },
  ];
}

/** Catmull-Rom through the keys (clamped ends), u in 0..1 over the key times */
function sample(keys: Key[], u: number, outP: THREE.Vector3, outL: THREE.Vector3): number {
  let i = 0;
  while (i < keys.length - 2 && u > keys[i + 1].t) i++;
  const a = keys[Math.max(0, i - 1)],
    b = keys[i],
    c = keys[i + 1],
    d = keys[Math.min(keys.length - 1, i + 2)];
  const k = Math.max(0, Math.min(1, (u - b.t) / Math.max(1e-4, c.t - b.t)));
  const cr = (o: THREE.Vector3, A: THREE.Vector3, B: THREE.Vector3, C: THREE.Vector3, D: THREE.Vector3) => {
    const k2 = k * k,
      k3 = k2 * k;
    return o.set(0, 0, 0)
      .addScaledVector(A, -0.5 * k3 + k2 - 0.5 * k)
      .addScaledVector(B, 1.5 * k3 - 2.5 * k2 + 1)
      .addScaledVector(C, -1.5 * k3 + 2 * k2 + 0.5 * k)
      .addScaledVector(D, 0.5 * k3 - 0.5 * k2);
  };
  cr(outP, a.p, b.p, c.p, d.p);
  cr(outL, a.l, b.l, c.l, d.l);
  const e = k * k * (3 - 2 * k);
  return b.fov + (c.fov - b.fov) * e;
}

function buildLandmarkReveal(ctx: CineCtx, dur = 9.0): Timeline {
  const A = ctx.arena;
  const L = A.layout;
  const T = A.theme;
  const tl = new Timeline();
  const aspect = ctx.rig.cam.aspect || 16 / 9;
  // choose the path: hazards out of the frame, the lens clear of columns / props / hanging hazards
  let best: Key[] = landmarkKeys(L.rx, 1, 8, 3.2),
    bestPen = Infinity;
  const P = new THREE.Vector3(),
    Lk = new THREE.Vector3();
  for (const s of [1, -1])
    for (const endD of [8, 5.5, 10.5])
      for (const lat of [3.2, 1.6, 5]) {
        const keys = landmarkKeys(L.rx, s, endD, lat);
        let pen = (endD !== 8 ? 0.05 : 0) + (lat !== 3.2 ? 0.05 : 0);
        for (let u = 0.45; u <= 1.001; u += 0.11) {
          const fov = sample(keys, u, P, Lk);
          // the second half carries the hero frames (the arch, the stair); the end pose counts double
          pen += hazardPenalty(L, P, Lk, fov, aspect) * (u > 0.95 ? 2 : 1);
          for (const o of L.obstacles) if (Math.hypot(P.x - o.x, P.z - o.z) < o.r + 1.0 && P.y < o.h + 0.5) pen += 3;
          for (const o of L.props) if (Math.hypot(P.x - o.x, P.z - o.z) < o.r + 0.8 && P.y < 1.6) pen += 2;
        }
        if (pen < bestPen - 1e-3) {
          bestPen = pen;
          best = keys;
        }
      }
  const keys = best;
  tl.cue('light', 0, () => {
    A.restoreLighting();
    ctx.rig.collide = false;
    ctx.ui.splashText(`${T.name}<small>${T.tagline}</small>`, 'arena');
  });
  const p = new THREE.Vector3(),
    look = new THREE.Vector3();
  tl.span('camera', 0, dur, (k, _lt, dt) => {
    // eased overall (slow start on the sky, slow settle on the stair), the spline keeps the speed continuous
    const u = Ease.inOut(k);
    const fov = sample(keys, u, p, look);
    ctx.rig.cut(p, look, fov);
    ctx.rig.update(p, look, fov, dt);
  });
  tl.cue('text', dur - 0.8, () => ctx.ui.hideSplash());
  return tl;
}
