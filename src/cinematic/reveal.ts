/**
 * Arena reveal: a pre-match establishing flythrough (crane over the arena,
 * sweep around the far side, glide down toward the first gate) with the
 * arena's name card. Camera poses are derived from the generated layout so it
 * works for every theme / layout.
 */
import * as THREE from 'three';
import { Ease, Timeline } from './timeline';
import type { CineCtx } from './entrance';

export function buildReveal(ctx: CineCtx, dur = 6.2): Timeline {
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
