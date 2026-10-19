/**
 * HEADLESS ENTRANCE VALIDATOR (browser, real arena geometry + rigs, no render).
 *
 * For every fighter x theme x layout x gate x valid entrance variant, the
 * entrance timeline is stepped at 30 Hz and checked:
 *  - support: outside declared airborne beats the actor's feet are on a real
 *    surface (ray cast down into the built arena geometry, within 0.2 m)
 *  - head clearance: the head is not inside geometry (tunnel ceilings, arches)
 *  - visibility: at every shot's middle and at every physical event the actor
 *    (head or chest) projects inside the frame
 *  - occlusion: something solid (not the see-through barrier) between the
 *    camera and BOTH head and chest at those moments
 *  - causality: every barrier event (shake / break) happens while the causing
 *    part (hands / weapon tip / body) is within 0.35 m of the barrier plane
 */
import * as THREE from 'three';
import type { Arena } from '../render/arena/arenaView';
import type { FighterView } from '../render/fighterView';
import type { FighterDef } from '../sim/types';
import { buildEntrance, snapAnchors, type CineCtx, type EntranceMeta } from './entrance';
import { ENTRANCE_VARIANTS } from '../data/entranceVariants';

export interface EntranceIssue {
  t: number;
  kind: 'support' | 'head' | 'visibility' | 'occlusion' | 'causality' | 'error';
  detail: string;
}
export interface EntranceResult {
  fighter: string;
  theme: string;
  layout: string;
  gate: number;
  variant: string;
  ok: boolean;
  issues: EntranceIssue[];
}

function staticMeshes(arena: Arena, exclude: THREE.Object3D[]): THREE.Mesh[] {
  const ex = new Set<THREE.Object3D>();
  for (const e of exclude) e.traverse((o) => ex.add(o));
  const out: THREE.Mesh[] = [];
  arena.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || ex.has(o) || (m as unknown as THREE.InstancedMesh).isInstancedMesh || o === arena.sky || o.userData.dyn) return;
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material & { opacity?: number };
    // see-through things (veils, glows, fog cards, flames) never hide anyone
    if (mat.transparent && mat.side !== THREE.BackSide) return;
    if (!o.visible) return;
    out.push(m);
  });
  return out;
}

const fmt = (p: THREE.Vector3) => `(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`;
function describe(h: THREE.Intersection): string {
  const m = h.object as THREE.Mesh;
  const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material;
  const g = m.geometry as THREE.BufferGeometry;
  return `${m.name || g.type}/${mat.name || mat.type}${mat.side === THREE.BackSide ? '/back' : ''} @${fmt(h.point)}`;
}
let lastHit = '';

export async function validateEntrances(opts: {
  ctx: () => CineCtx;
  buildArena: (theme: string, layout: string) => Promise<Arena>;
  views: Record<string, FighterView>;
  defs: Record<string, FighterDef>;
  fighters: string[];
  themes: string[];
  layouts: string[];
  gates?: number[];
}): Promise<{ results: EntranceResult[]; configs: number; failed: number }> {
  const results: EntranceResult[] = [];
  const ray = new THREE.Raycaster();
  const v = new THREE.Vector3(),
    w = new THREE.Vector3();
  for (const theme of opts.themes)
    for (const layout of opts.layouts) {
      const arena = await opts.buildArena(theme, layout);
      // no frame has been rendered: bring every world matrix up to date before ray casting
      arena.group.updateMatrixWorld(true);
      for (const gate of opts.gates ?? [0, 1]) {
        const g = arena.gates[gate];
        // A18: list the variants on the SNAPPED anchors (what chooseVariant sees in the game): a perch / stand that does not
        // land on real geometry is dropped first, so its variant is not validated as a legacy fallback the game never plays
        snapAnchors(arena, gate);
        const solids = staticMeshes(arena, [g.portcullis]);
        for (const fid of opts.fighters) {
          const view = opts.views[fid];
          const variants = ENTRANCE_VARIANTS[fid]?.filter((x) => x.v.needs(g.anchors)).map((x) => x.v.id) ?? [undefined];
          for (const variant of variants) {
            arena.resetProps();
            arena.group.updateMatrixWorld(true);
            const ctx = opts.ctx();
            const issues: EntranceIssue[] = [];
            let meta: EntranceMeta | undefined;
            try {
              for (const o of Object.values(opts.views)) o.rig.root.visible = o === view;
              const tl = buildEntrance(ctx, view, gate as 0 | 1, opts.defs[fid === 'gorak' ? 'vex' : 'gorak'], undefined, { variant });
              meta = tl.meta;
              const air = meta?.air ?? [];
              const checkT = new Set<number>();
              for (const s of meta?.shots ?? []) checkT.add(Math.round(((s[0] + s[1]) / 2) * 30));
              for (const e of meta?.events ?? []) checkT.add(Math.round(e.t * 30));
              const ev = [...(meta?.events ?? [])];
              let unsupported = 0,
                unsupportedT = -1;
              const dt = 1 / 30;
              const n = Math.ceil(((meta?.duration ?? tl.duration) + 0.1) / dt);
              for (let i = 0; i < n && !tl.done; i++) {
                tl.update(dt);
                const t = tl.t;
                const root = view.root.position;
                const inAir = air.some(([a, b]) => t >= a - 0.05 && t <= b + 0.12);
                const hidden = (meta?.hidden ?? []).some(([a, b]) => t >= a - 0.05 && t <= b + 0.05);
                // support: the lower foot must stand on something real
                if (!inAir && !hidden) {
                  // either foot (or the root) on something real is enough: perched on a narrow beam is fine
                  const toes = [view.model.getObjectByName('mixamorigLeftToeBase'), view.model.getObjectByName('mixamorigRightToeBase')].filter(Boolean) as THREE.Object3D[];
                  const probes = [...toes.map((o) => o.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, -0.04, 0))), root.clone()];
                  let gap = 9,
                    hit: THREE.Intersection | undefined;
                  for (const f of probes) {
                    ray.set(v.set(f.x, f.y + 0.7, f.z), w.set(0, -1, 0));
                    ray.far = 2.5;
                    const h = ray.intersectObjects(solids, false)[0];
                    const gp = h ? Math.abs(f.y - h.point.y) : 9;
                    if (gp < gap) {
                      gap = gp;
                      hit = h;
                    }
                  }
                  if (gap > 0.25) {
                    if (unsupported === 0) unsupportedT = t;
                    unsupported++;
                    if (unsupported === 5) issues.push({ t: +unsupportedT.toFixed(2), kind: 'support', detail: (hit ? `feet ${root.y.toFixed(2)} vs ground ${hit.point.y.toFixed(2)} (${describe(hit)})` : `nothing under the feet at y ${root.y.toFixed(2)}`) + ` at ${fmt(root)}` });
                  } else unsupported = 0;
                }
                // head clearance
                const head = view.headWorld(new THREE.Vector3());
                const chest = view.chestWorld(new THREE.Vector3());
                {
                  const d = head.clone().sub(chest);
                  const len = d.length() + 0.12;
                  ray.set(chest, d.normalize());
                  ray.far = len;
                  // only ceiling-like surfaces count (walls crossed edge-on are not "inside")
                  const hit = ray.intersectObjects(solids, false).find((h) => !!h.face && Math.abs(h.face.normal.clone().transformDirection(h.object.matrixWorld).y) > 0.5);
                  if (hit && !hidden && !issues.some((x) => x.kind === 'head' && t - x.t < 1)) issues.push({ t: +t.toFixed(2), kind: 'head', detail: `head inside geometry (${describe(hit)}) chest ${fmt(chest)} head ${fmt(head)}` });
                }
                // camera checks at shot middles / events
                if (checkT.has(i) && !hidden) {
                  const cam = ctx.rig.cam;
                  cam.updateMatrixWorld(true);
                  const inFrame = (p: THREE.Vector3) => {
                    const q = p.clone().project(cam);
                    return q.z < 1 && Math.abs(q.x) <= 0.95 && Math.abs(q.y) <= 0.95;
                  };
                  if (!inFrame(head) && !inFrame(chest)) issues.push({ t: +t.toFixed(2), kind: 'visibility', detail: 'actor outside the frame' });
                  else {
                    const blocked = (p: THREE.Vector3) => {
                      const d = p.clone().sub(cam.position);
                      const dist = d.length();
                      ray.set(cam.position, d.normalize());
                      ray.far = dist;
                      const hit = ray.intersectObjects(solids, false)[0];
                      if (hit) lastHit = describe(hit);
                      return !!hit && hit.distance < dist - 0.3;
                    };
                    if (blocked(head) && blocked(chest)) issues.push({ t: +t.toFixed(2), kind: 'occlusion', detail: `geometry between the camera ${fmt(cam.position)} and the actor (${lastHit})` });
                  }
                }
                // causality: barrier events need the cause at the barrier
                while (ev.length && ev[0].t <= t + 1e-6) {
                  const e = ev.shift()!;
                  g.group.updateWorldMatrix(true, false);
                  const inv = g.group.matrixWorld.clone().invert();
                  const pts: THREE.Vector3[] =
                    e.cause === 'tip'
                      ? [view.tipWorld(new THREE.Vector3())]
                      : e.cause === 'hands'
                        ? [view.rig.joints.haL.getWorldPosition(new THREE.Vector3()), view.rig.joints.haR.getWorldPosition(new THREE.Vector3())]
                        : e.cause === 'feet'
                          ? [view.root.position.clone()]
                          : [chest.clone()];
                  // gate-group local z of the barrier plane is 0.2 (portcullis position)
                  const best = Math.min(
                    ...pts.map((p) => {
                      const l = p.clone().applyMatrix4(inv);
                      const lateral = Math.max(0, Math.abs(l.x) - g.anchors.barrierHalfW);
                      return Math.hypot(Math.abs(l.z - 0.2), lateral);
                    }),
                  );
                  if (best > 0.35) issues.push({ t: +e.t.toFixed(2), kind: 'causality', detail: `${e.fx}: ${e.cause} ${best.toFixed(2)} m from the barrier` });
                }
              }
              tl.finish();
            } catch (err) {
              issues.push({ t: 0, kind: 'error', detail: String((err as Error).message ?? err) });
            }
            results.push({ fighter: fid, theme, layout, gate, variant: meta?.variant ?? variant ?? 'legacy', ok: issues.length === 0, issues });
          }
        }
      }
    }
  return { results, configs: results.length, failed: results.filter((r) => !r.ok).length };
}
