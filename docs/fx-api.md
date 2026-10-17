# FX API (milestone F0)

The FX foundation lives in `src/render/fx/`. Import everything from `src/render/fx` (the `index.ts`), not from the individual files. This page is the contract for the FX Lab (F2) and for later milestones.

## Files

| File | What it is |
|---|---|
| `fxDirector.ts` | `FxDirector`: resolves sim events and frame observations to effect ids, spawns them with seeds, owns pending (delayed) layers, post kicks, seek, stats and hashes. `createFxDirector()` for standalone use. |
| `fxDefs.ts` | **Data.** `DEFS` (every effect), `RESOLVE` (sim event → effect ids), `ON_ACTIVE` (attack active-phase observations), `CONTINUOUS` (state-driven emitters with a rate). Add effects here; the director does not change. |
| `legacyVfx.ts` | `VFX`: the FX core *and* the old API (`sparks / flash / dust / smoke / fire / embers / shockwave / arrow / debrisBurst / update / clear / group / flashLight`). `src/render/vfx.ts` re-exports it, so old imports work. |
| `particles.ts` | `GpuParticles`: stateless instanced-quad particles (closed-form drag + gravity in the vertex shader). |
| `fxRng.ts` | `FxRng` (seeded stream), `hash1 / hashN / hashStr`, `spawnSeed`. |
| `fxClock.ts` | `FxClock`: FX time `t` and the impact-light clock `light`. |
| `fxSettings.ts` | Quality tier (`fxSettings.setQuality`, `TIER_CAPS`) and the gore level (`goreLevel`, `setGoreLevel`, `parseGore`; default `GORE_DEFAULT = 'standard'`, key `arena.gore.v2`, `?gore=off|standard|full`, `stylised` = alias of `standard`). |
| `profiler.ts` | `fxProfiler`: CPU ms of `frame()` and `update()` (EMA + max). The time source is injected by the game. |

## Standalone director (FX Lab, tests)

```ts
import { createFxDirector } from '../../src/render/fx';

const fx = createFxDirector({ scene, seed: 1, quality: 2 }); // adds fx.vfx.group to scene, FX time 0
fx.list();                          // every effect id (57 in F0)
fx.def('impact.default.heavy');     // the FxDef (layers, anchor, post, priority, desc)
fx.timing('explosion.keg');         // { duration: 2.5, layers: [{ kind: 'flash', delay: 0 }, ...] }

fx.spawn('explosion.keg', { x: 0, y: 1, z: 0 }, { seed: 42, t: 0 });
// options: seed (default: from match seed + id + time), t (spawn time on the FX clock, default now),
//          accent ('$accent' colour, default '#ffb060'), facing (rad, for fire streams), data (event data)

fx.step(1 / 60);       // advance by dt (fixed steps are exactly reproducible)
fx.setTime(0.35);      // scrub: show the exact state at FX time t (forwards or backwards)
fx.time;               // current FX time

fx.stats();            // counts and timings, see below
fx.hash();             // hash of the live effect list (id, spawn time, seed)
fx.stateHash();        // hash of the full live state (every particle's spawn data, rings, debris, light)
fx.liveEffects();      // [{ id, t0, seed, end }]
fx.clear();            // remove everything (keeps the clock)
fx.reset(seed, t);     // new seed, clear, FX time := t
fx.dispose();          // free GPU resources (the director's own VFX)
```

Without a world (lab), every anchor resolves to the spawn position: feet anchors use `y = 0`, `ringEdge` is a 3 m circle around it, and the def's `y` / `minY` still apply.

**Scrubbing caveat.** Particles, rings, arrows, debris and the impact light are pure functions of time, so `setTime` is exact in both directions. Delayed layers (`delay > 0`, e.g. the knockdown dust) are spawned when time first passes them; scrubbing back before their delay leaves them spawned but invisible (their spawn time is in the future), which renders correctly.

`fx.stats()`:

```ts
{
  t, particles: { add, alpha, addCap, alphaCap }, rings, arrows, debris,
  effects,   // live effect instances (in the live list)
  pending,   // delayed layers waiting
  spawns,    // spawns since the last clear
  light,     // impact light intensity
  quality, gore,
  cpu: { frameMs, updateMs, frameMax, updateMax }   // 0 unless fxProfiler.now is set
}
```

To get CPU timings in the lab, set `fxProfiler.now = () => performance.now()` (the FX folder itself never reads the clock).

## In the game (`src/main.ts`)

```ts
fx = new FxDirector();  vfx = fx.vfx;                  // vfx: the legacy facade (entrances, finisher FX)
fx.setMatch(rec, seed, world);                          // start(): index rec.events, attach the FxWorld, clear, reseed
fx.frame({ events, frame, simT, simDt });               // tickFight(), before handleEvents
fx.update(fxDt, realDt);                                // tick(); the impact light decays on realDt
const { aberration, flash } = fx.takePost();            // post kicks from defs (maxed into the grade)
fx.seek(t);                                             // debugSeekFight(): clear + reseed at the warm-up start
```

Browser console: `__arena.fxStats()`, `__arena.fxHash()`, `__arena.fxStateHash()`, `__arena.fx` (the director). The debug overlay (backquote) shows an `fx` line.

## Adding an effect

1. Add a row to `DEFS` in `fxDefs.ts`:
   ```ts
   def({ id: 'impact.blade.metal', desc: '...', at: 'contact', priority: 60, post: { aberration: 0.6 },
         layers: [{ op: { k: 'sparks', n: 30, color: '#fff0d0', speed: 9 } }, { op: { k: 'dust', n: 6 }, at: 'bFeet', delay: 0.05 }] });
   ```
2. If a sim event should trigger it, return its id from the event's line in `RESOLVE`. If a fighter state should emit it continuously, add a `CONTINUOUS` row (rate = spawns per second of sim time).
3. `npm run fx:check` spawns every def standalone and checks reproducibility.

Layer fields: `op` (what to emit), `at` (anchor override), `y` (replace the anchor's height), `minY`, `delay` (seconds on FX time). Def fields: `id, desc, at, y, layers, post, gore, priority, shake, stop` (`shake` and `stop` are carried but not used until the plan's §3.6 / CI1 are agreed).

Anchors: `origin, contact, blockContact, parryContact, aChest, bChest, aFeet, bFeet, aHead, aCast, event, obstacle, hazard, ringEdge`. Colours: `'#rrggbb'`, `'$accent'` (actor), `'$accentB'` (target).

F0 op kinds map 1:1 to the old primitives: `sparks, flash, dust, smoke, fire, fireBurst (sphere | ring | box), embers, shock, debris`. F1+ add flipbook, ribbon, decal, card, distortion and light kinds; the director's `runLayer` switch is the one place a new kind is wired.

## Determinism rules

- Seeds: `hashN(matchSeed, key, hashStr(id))`, per layer `hashN(seed, layerIndex)`. `key` = the event's index in `rec.events`; `hashN(0xac, fighter, attackId)` for active-phase observations; `hashN(hashStr(emitter), fighter, tick)` for continuous emitters (ticks at fixed sim times); `hashN(0x9e, projectileId, tick)` for projectile trails.
- Legacy facade calls (entrances, finisher FX) draw their seed from a per-match stream reseeded on `setMatch` / `seek`; `vfx.rand()` replaces `Math.random` in those callers.
- Grep gate (also run by `npm run fx:check`): `rg "Math.random|performance.now|setTimeout|Date.now" src/render/fx` returns nothing.
- FX read `MatchRecord`, `Frame` and `SimEvent` and never write them. `src/sim` never imports render code.

## Quality tiers

`fxSettings.setQuality(0|1|2)` (main.ts calls it from `setQuality` / `KeyQ`). Pools are allocated once at the high cap and only the ring length changes (`TIER_CAPS`: additive 1500 / 3000 / 4096, alpha 800 / 1500 / 2048); materials are never rebuilt. `countScale` is 1 on every tier in F0 (no visual change).

## F1 additions (post, depth, distortion)

| File | What it is |
|---|---|
| `fxLayers.ts` | `LAYER` (`WORLD 0`, `FX_ADD 20`, `FX_ALPHA 21`, `FX_DIST 22`, `FX_GHOST 23`) and the masks Post renders with. Particles, rings and arrows are on FX layers; debris stays on WORLD (it casts shadows). |
| `softDepth.ts` | `softDepthUniforms` (shared uniform objects: `uSceneDepth`, `uDepthInvRes`, `uSoftOn`), `SOFT_DEPTH_PARS` (GLSL `fxSoftFade(viewDepth, softness)`), `SOFTNESS` (per-primitive default fade distance in metres). |
| `distortion.ts` | `DistortionSprites`: stateless heat columns (kind 0) and pressure ripples (kind 1) on `FX_DIST`. |
| `fxLook.ts` | `THEME_LOOK` (F1 bloom + split-tone + black-crush row per theme), `GRADE_PRESETS` (per-moment grade deltas). |
| `../post.ts` | `Post`: the pipeline (scene + shared depth, linear depth / normals, GTAO, FX pass, distortion, rays, DOF, dual bloom, final grade). `POST_TIERS`. |

**Defs.**
- New op kinds: `{ k: 'heat', size, height, life, strength?, rise?, tier? }` and `{ k: 'ripple', size, life, strength?, tier? }`. `tier` is the lowest distortion tier that shows it (`TIER_CAPS.dist`: 0 low = none, 1 medium = ops with tier 1, 2 high = all). Defaults: heat 2, ripple 1.
- `soft` (metres) on a def or a layer overrides the primitive's soft-particle distance; 0 = hard.
- `hdr` on sparks / flash / fire / fireBurst / embers overrides the HDR multiplier (`HDR_SCALE` in `fxDefs.ts`).
- `post.vignette` (0..1 kick) and `post.grade` / `gradeWeight` / `gradeDur` (a `GRADE_PRESETS` pulse). `fx.takePost()` now returns `{ aberration, flash, vignette, grades[] }`; `main.ts` maxes the vignette and forwards grade kicks to `post.kickPreset`.

**Post (game and lab).**
```ts
const post = new Post(renderer, scene, camera);      // ?msaa=N forces MSAA on the high tier
post.quality = 0 | 1 | 2;                             // POST_TIERS
post.distActive = () => fx.vfx.dist.active;           // skip the distortion pass while nothing lives
post.setLook({ id: theme.id, bloom, grade, godrays, sunDir, rayColor });
post.setPreset('killcam', 1);                         // hold a grade preset (eased); 0 releases (F7 hook)
post.kickPreset('impact', 0.8, 0.4);                  // decaying pulse
post.update(dt, { dof, focus, aberration, desat, flash, vignette });
post.render();
post.setProfiling(true); post.gpuTimes();             // GPU ms per pass (timer queries)
post.softEnabled / post.distEnabled                   // A/B switches (FX Lab)
```
A soft card for another system: spread `softDepthUniforms` into the material's uniforms, include `SOFT_DEPTH_PARS`, pass `-mvPosition.z` in a varying, multiply alpha by `fxSoftFade(depth, softness)` and put the mesh on `LAYER.FX_ALPHA`. A plain `renderer.render` (Animation Lab) must enable the FX layers on its camera to see particles.
