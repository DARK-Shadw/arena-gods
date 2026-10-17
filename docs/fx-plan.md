# Arena Gods: visual effects (FX) overhaul plan

Status: PLAN. Nothing in it is implemented yet. It was written on 2026-10-17 on branch `anim-plan` while the animation overhaul is still running.

**Companion documents**
- `docs/fx-catalog.md` lists every effect with its trigger, duration, layers, technique, assets, light, cost, quality-tier behaviour, audio and priority.
- `docs/fx-research.md` holds the raw research, the licence table and the code facts with line references.

**Art target**
- The concept art in `docs/concept-art/ref-3..10.png`, read as realistic dark fantasy in the spirit of Elden Ring.
- Effects have hot, over-bright cores that bloom and fall off to dark edges, with strong warm-against-cool contrast.
- Magic should read as a physical phenomenon.
- Realism comes from the effect's surroundings rather than the effect alone: light thrown onto fighters and the floor, smoke, embers, debris, decals that persist, distortion, and shake and hit-stop.

**Hard rules this plan keeps**
- The sim stays authoritative and deterministic. FX are driven by sim events and recorded frames, and nothing in FX writes back into sim state.
- Replays and `?t=` jumps reproduce the same FX from (seed, sim time).
- FX use no wall-clock randomness.

---

## 0. Summary

1. **Today:** FX are a single CPU particle pool with one soft-dot texture, plus about 100 literal `vfx.sparks/flash/dust/fire` calls spread across `main.ts`. Every hit on every material looks the same. Fire is made of crossed canvas-gradient quads, trails are flat accent-coloured strips, and there is no blood outside finishers. Nothing is reproducible: `Math.random`, `setTimeout` and `performance.now()` all appear.
2. **Fix the foundation first (F0–F2):**
   - a central **FX director** fed by the event stream, with effects defined as data;
   - **stateless GPU particles**, i.e. analytic in (spawn time, seed), the pattern `ambient.ts` already uses, so a seek reproduces them;
   - one **shared depth texture** for soft particles and distortion;
   - an **FX Lab**;
   - a small **flipbook atlas set**, both baked in Blender and taken from CC0 packs.
3. **Then build in the owner's priority order:**
   - everyday combat (F3);
   - fire and environment, coordinated with the arena art upgrade (F4);
   - skills, including Thousand Cuts (F5);
   - status effects (F6);
   - cinematic beats and post (F7);
   - the spell-FX foundation for the later magic overhaul (F8).
4. **Blood** is planned at Elden Ring level and ON by default. It is controlled by one gore setting, `off / standard / full`. The finisher default changes from `off` to `standard`. **Confirmed by the owner on 2026-10-17 and implemented** (see §3.7).
5. **Budget on the Intel Arc iGPU:**
   - at most 2.0 ms GPU and 0.6 ms CPU for FX in typical combat on high;
   - peaks up to 3.5 ms during an explosion or ultimate;
   - medium and low scale this down (tier table in §2.6).

---

## 1. Audit: what exists today

### 1.1 File by file

| File | What it does | What looks weak or is wrong (evidence) |
|---|---|---|
| `src/render/vfx.ts` (431 lines) | `ParticlePool`: CPU-simulated `THREE.Points` (3000 additive + 1500 alpha), one 64-px radial canvas texture. Helpers `sparks, flash, dust, smoke, fire, embers, shockwave, arrow, debrisBurst`. `Trail` ribbon. `Telegraph` ground ring. One shared `flashLight`. | **Look:**<br>- Every particle is the same round soft dot. Sparks are dots rather than streaks; fire is coloured dots and smoke is grey dots.<br>- Nothing has texture, shape, flipbook animation, soft depth or lighting.<br>- `shockwave` is a flat additive ring, which reads cartoonish.<br>**Perf:**<br>- `update()` loops all 4500 slots and re-uploads 4 attributes (~144 KB) every frame, even when nothing is alive.<br>- `shockwave`, `arrow` and `debrisBurst` allocate a new geometry and material on every call.<br>- `debrisBurst` creates a material per burst and a box per piece and never disposes them, so memory leaks over a session.<br>**Determinism:**<br>- `Math.random` everywhere.<br>- `Telegraph` pulses with `performance.now()`.<br>**Trail:**<br>- 9 samples pushed per *render frame*, so the trail is 4.8× longer at 30 fps than at 144 fps.<br>- During hit-stop the samples collapse to a point.<br>- No UV or texture.<br>- Every weapon uses the fighter's accent colour (`fighterView.ts:109`), so the axe, sword, claws and fists all leave the same neon strip. |
| `src/render/finisherFx.ts` (597) | Finisher FX: bisect (clip planes), behead (bone-weight split), burn, shatter, drain, dissolve, crush/impale. `patchMaterial` injects `uDissolve/uBurn/uIce/uDrain/uCap` via `onBeforeCompile`. Owns the **gore setting** (`goreLevel()`, default `'off'`). | The geometry work is good and should be kept. Weak points:<br>- the particles are the same dots: blood is red dots, fire is dots;<br>- `Math.random` in its tasks;<br>- `Box3.setFromObject` every frame per task;<br>- blood appears only at gore `full`, and the default is `off`. |
| `src/render/poseFx.ts` (535) | Animation only: inertialization, spring flinch, phase matching, foot lock. | No FX. The useful hook is `FootLock`'s "planted" edge, which can trigger footstep dust (C01). This file belongs to the animation agent, so read it through a getter only. |
| `src/render/post.ts` (199) | RenderPass → GTAO (half-res) → Bokeh (optional) → god rays (+ NaN sanitise) → UnrealBloom (half-res) → grade (lift/gamma/gain, contrast, saturation, CA, desat, flash, vignette) → Output. Quality 0/1/2. | **Missing:** a shared depth texture, a distortion buffer, a grade preset stack and a vignette pulse.<br>**Depth renders:** GTAO and Bokeh each re-render scene depth/normals on their own.<br>**Bloom:** thresholds are 1.3–2.6 per theme (`themes.ts`), and FX colours are raw sRGB hex values multiplied by about 1.3. So fire bodies barely reach bloom while flashes blow out: there is no defined HDR scale. |
| `src/render/arena/ambient.ts` (140) | GPU-only ambient particles. Position = f(seed, time) in the vertex shader, wrapped in a box, with a seeded LCG. | **The right pattern.** Generalise it into the FX particle system. |
| `src/render/arena/debris.ts` (253) | Instanced, seeded (`R(99)`) chunk pools with bounce. `Decals` is a 1024-px canvas over the whole arena: scorch, crack, and scuff (scuff is unused). | Chunks are fine. Decals are low resolution (about 2.7 cm per pixel on a 13 m arena), colour only (no normal or roughness, so they do not catch the wet floor), and repaint the whole texture on each upload. |
| `src/render/arena/arenaView.ts` (902) | `flame()`: 2 crossed planes + a core using a canvas teardrop sprite, sine flicker, real `PointLight` while `lightBudget` (7) lasts. Ring of fire: an open cylinder with a canvas flame strip. Lava and water materials. `onEvent()` handles debris, cracks and scorch for destruction. | Flames read as paper cut-outs next to the concept art's licking brazier fires. They have no smoke, embers, heat haze or wet-floor streak. Up to 7 forward point lights is expensive on the iGPU. The ring of fire is a scrolling strip. |
| `src/render/fighterView.ts` (490) | Trail and telegraph per fighter, a canvas aura ring under the feet, emissive glow pulse (`performance.now()`), `castWorld()`, `strikePointsWorld()`, `bladePlane()`. | The aura is a flat ring sprite. There are no afterimages, wounds or status visuals. |
| `src/main.ts` (1250+) | **The FX hub today.** `handleEvents`, `arenaFx`, `continuousFx`, `updateProjectiles` and `onActiveStart` make about 100 direct `vfx.*` calls with literal colours and counts. | **Data:** effects are hard-coded, so they cannot be previewed, tuned or made tier-aware.<br>**Wall clock:**<br>- The knockdown dust uses `setTimeout(150)`.<br>- The ring of fire, projectile trails and buffs use `Math.random`.<br>- Projectile meshes allocate a new geometry each time.<br>**Look:**<br>- `kill` spawns a white ring plus 80 sparks, which is cartoonish.<br>- **Seek:** `debugSeekFight` neither clears nor rebuilds FX or decals. |
| `src/camera/director.ts` | Owns hit-stop, slow-mo, shake, FOV punch, letterbox and the finisher freeze. | Fine; FX must not duplicate it. Shake values are hard-coded per event here, so §3.6 proposes moving them into the FX definitions, with the camera owner's agreement. |
| `src/cinematic/entrance.ts` | Entrance cues call `ctx.vfx.dust` etc. Also uses `setTimeout` (portcullis). | Keep working through the facade (§3.2). |
| `tools/animlab/labExtras.ts` | `fxDemo(kind, gore, steps)` previews finisher FX on a posed fighter. | It is the seed of the FX Lab (§3.9). |

### 1.2 Pattern problems

1. **No material awareness.** A hit on Aldric's plate, Fenrik's fur, Hollowjack's pumpkin or a stone pillar uses the same `sparks + flash` (`main.ts:838`).
2. **No shape language.** Everything is round.
   - Real impacts need streaks (sparks), puffs with internal detail (dust), and turbulent motion (fire and smoke flipbooks).
3. **No depth interaction.**
   - Additive dots clip hard into the floor and bodies.
   - Large alpha dust cards show hard intersection lines.
4. **No light contribution.**
   - One shared `flashLight` serves every effect, and the last one to fire wins.
   - Fire never lights the fighters it surrounds.
5. **No persistence.** The only floor decals are cracks and scorch at about 2.7 cm per pixel. There is no blood, frost, mud or footprints.
6. **Not reproducible.**
   - About 30 `Math.random` calls sit on FX paths, plus `setTimeout` and `performance.now()`.
   - A `?t=` jump shows no in-flight effects and no decals from earlier in the fight.

---

## 2. Technique toolbox

### 2.1 Decision table

| Effect family | Technique | Why | Three.js implementation |
|---|---|---|---|
| Sparks, embers, droplets, debris dust motes | **GPU particles, stateless** (velocity-stretched billboards) | Many small, short-lived points. Analytic motion (ballistic + drag) means no CPU per frame and exact reproduction from (spawn time, seed). | One `InstancedBufferGeometry` quad, with per-instance attributes `spawnT, life, p0, v0, seed, size, colorHDR, flags`. The vertex shader computes `p(t) = p0 + v0·(1-e^{-kt})/k + g·(…)` (closed-form drag with gravity), stretches the quad along the screen-space velocity and handles a floor bounce analytically. Emission writes a ring of instances once per burst (a few hundred bytes upload) instead of re-uploading every frame. **Use `InstancedMesh`/`InstancedBufferGeometry` quads, not `THREE.Points`:** points cannot stretch or rotate and are size-capped by the driver. |
| Fire, smoke, explosions, dust bursts, splashes, steam, blood spray | **Flipbook particles** (baked atlas, soft depth, motion-vector sub-frame blend) | Turbulence and internal detail cannot be faked with dots. Baked fluid renders give realism at a fixed, low per-pixel cost. | The same instanced-quad system with `flipbook` flags. The atlas has 8×8 frames; a frame comes from the normalised age. Two samples (frame n and n+1) are each displaced by their motion-vector texel and blended by the fraction. Fire uses premultiplied-alpha "additive-alpha" blending (`ONE, ONE_MINUS_SRC_ALPHA`), so one material does both glow and occlusion. Smoke is lit: RGB = 3 baked directional light passes, combined in the shader with the key-light direction and the theme ambient. |
| Weapon trails, whip fire, arrow and projectile trails, speed trails | **Ribbons** | Continuous swept shapes that follow sub-frame motion. | A ring buffer of `(simT, base, tip)` sampled on the FX clock at a fixed 120 Hz (sub-stepped from bone positions interpolated between frames). Catmull-Rom resample to N segments into a preallocated `BufferGeometry` (positions + `uv.x = age/life`, `uv.y = 0 at base, 1 at tip`). The ribbon texture has a hot leading edge, a dark smoky body and streak noise, plus a per-weapon profile (§2.3). An optional second ribbon goes into the distortion layer. |
| Shock rings, heat haze, swing air-shear, roar rings | **Screen distortion** | Reads as physical displacement of air. | Distortion sprites/ribbons on layer `FX_DIST` render RG offsets into a half-res `RG16F` target (one extra `renderer.render` with only that layer visible: a handful of draw calls). The grade pass samples `tDiffuse` at `uv + offset * mask`. The mask uses soft depth so the fighter in front of a heat column is not smeared. |
| Blood splatter, pools, scorch, cracks, frost, mud, footprints | **Decals** | Persistence is what makes the world remember the fight. | **Floor decals:** an instanced batch of floor-aligned quads (max 256), atlas-textured, with colour + normal + roughness (blood is wet and glossy, scorch is matte and dark, cracks have normals). Rendered after the floor with `polygonOffset`; the oldest fade out. This replaces the canvas `Decals` (keep it as the low-tier fallback).<br>**Decals on uneven props:** three's `DecalGeometry` (verified in `node_modules`). |
| Wounds and status on fighters (burning, frost, blood, rim auras) | **Material patch** | Must deform with the skinned mesh; decals on skinned meshes are expensive. | Extend `finisherFx.ts`'s `patchMaterial` into ONE fighter FX patch (a shared `onBeforeCompile` + `customProgramCacheKey`). Uniforms:<br>- `uWounds[8]`: vec4 in the fighter's model-space bind position + radius. The vertex shader passes the skinned bind-space position; the fragment shader adds dark-red, wet-spec, noise-edged blood inside the spheres.<br>- `uRim` (colour, power) for auras and the hit pulse.<br>- `uBurn`, `uIce`, `uDissolve`, `uDrain`, which already exist. |
| Dodge, rush and Thousand Cuts afterimages | **Afterimage ghosts** | Must match the real pose silhouette. | 2–4 `SkeletonUtils.clone` ghosts per fighter, created lazily. A pose history ring buffer (bone quaternions every 1/30 s of sim time); a ghost copies the snapshot at age `a` and renders with an additive fresnel material that fades. Each ghost costs one skinned draw, so the count is capped per tier. |
| Big flashes, flares, torch glow, light pools, wet-floor streaks | **Cards** | Cheap, controllable HDR. | Camera-facing or axis-aligned quads with `toneMapped:false`, additive. The flare texture comes from the atlas (anamorphic streak + star). Floor "light pool" and "reflection streak" cards fake many lights (§2.5). |
| Rubble, splinters, pumpkin chunks, ice chips, arrows stuck in the ground | **Real geometry (instanced)** | Must cast shadows and read as solid. | Reuse `arena/debris.ts` pools (instanced, seeded). Add the materials `flesh-less`, `pumpkin`, `ice` and `splinter` (thin box geometry). |
| Large one-off deformations: floor upheaval for quakes, a pillar crumbling | **VAT (vertex animation texture)**, P2 | Rigid-body or cell-fracture motion baked in Blender plays back for the cost of one texture fetch per vertex. | A Blender cell-fracture plus rigid-body sim, encoded with OpenVAT or our own script (position delta RGB16F texture: vertex × frame). A small `vatMaterial` patch reads `texelFetch(vat, ivec2(gl_VertexID, frame))` (WebGL2 supports `gl_VertexID`). Only for 2–3 hero assets. |
| Fog layers, light shafts | **Soft cards + existing height fog** | True volumetrics are too expensive on this iGPU. | Large soft-depth cards with scrolling noise; `fog.ts` height fog stays. |
| Bloom, chromatic aberration, vignette, grade, DOF | **Post** | Already in place; it needs tuning and preset blending. | §2.4 |

### 2.2 Concrete Three.js r170 notes

- **Stay on `WebGLRenderer` + `ShaderMaterial` / `onBeforeCompile`.** Do not move to node materials (TSL).
  - TSL in r170 targets `WebGPURenderer`, but this whole game uses `WebGLRenderer` + `EffectComposer` with custom GLSL passes.
  - Mixing the two would mean a renderer migration, which is out of scope.
  - Keep a thin `fxMaterials.ts` so a future WebGPU port only rewrites one module.
- **Shared depth texture (F1).**
  - Replace `RenderPass` with a `ScenePass` that renders the opaque scene (layer `WORLD`) into a target with a `DepthTexture` (`UnsignedIntType`), then runs a fullscreen **depth-copy pass** into a half-res `R16F` linear-depth target. The copy costs about 0.1 ms and avoids the WebGL2 feedback loop of sampling the depth texture that is bound as the depth attachment.
  - Then render FX layers (`FX_ADD`, `FX_ALPHA`) into the same colour target. They keep the hardware depth test against the attached depth (`depthWrite:false`) and sample the linear-depth copy for soft fades.
  - Pass the same depth to Bokeh, so it stops rendering its own. `BokehPass` samples `uniforms.tDepth`, but its `render()` always draws a `MeshDepthMaterial` pass first, so this needs a small subclass that skips that pass. Its shader expects packed RGBA depth unless the `DEPTH_PACKING` define is changed: verify.
  - Pass it to GTAO through its `parameters.depthTexture` if that path works in r170; verify, otherwise leave GTAO as it is.
  - This also removes the hard intersection lines on large dust and smoke cards.
- **MSAA.** `EffectComposer`'s targets have no MSAA samples, so `antialias:true` on the renderer has no effect on the composed image. Thin trails and sparks will alias.
  - Give the `ScenePass` target `samples: 4` on high (WebGL2 multisampled render target, resolved automatically), 0 on low.
  - Measure the cost.
  - This is a render-wide decision: flag it to the arena session.
- **Layers.**
  - `0 WORLD` (opaque + existing transparent arena)
  - `20 FX_ADD`
  - `21 FX_ALPHA`
  - `22 FX_DIST`
  - `23 FX_GHOST`

  GTAO's `overrideVisibility` already skips points, transparent and shader materials; FX on their own layers are excluded for free.
- **Blending.**
  - Fire, sparks and flares use premultiplied "additive-alpha" (`blending: CustomBlending, ONE, ONE_MINUS_SRC_ALPHA`). Alpha = 0 is pure additive glow, alpha = 1 occludes, so a fireball can have a dark smoky edge and a glowing core in one draw.
  - Smoke and dust use `ONE, ONE_MINUS_SRC_ALPHA` with lit RGB.
  - All FX: `depthWrite:false`.
  - Sort within a layer only for the alpha layer (back-to-front, per emitter, not per particle).
- **Flipbook UV.**
  - `frame = age01 * (frames-1)`, `f0 = floor(frame)`, `f1 = min(f0+1, frames-1)`, `k = fract(frame)`.
  - `uv0 = (vec2(f0 % cols, f0 / cols) + uv) / grid`.
  - Motion vectors are stored in a half-res RG atlas aligned with the colour atlas: `mv = (tex(mvAtlas, uvN).rg*2-1) * strength`.
  - `c0 = tex(atlas, uv0 - mv0*k)`, `c1 = tex(atlas, uv1 + mv1*(1-k))`, `mix(c0,c1,k)`.
  - On low, plain crossfade (one atlas, two taps).
- **Soft particles.**
  - `fade = clamp((sceneLinDepth - fragLinDepth) / softness, 0, 1)`, with softness per effect (0.05 m sparks, 0.6 m smoke, 1.5 m fog cards).
  - Plus a camera-near fade, which `vfx.ts` already does in the vertex shader.
- **Overdraw control.**
  - Every emitter declares `maxScreenArea` (a fraction of the screen, estimated from size and distance).
  - The director keeps a per-frame overdraw estimate and culls or shrinks low-priority alpha particles when it exceeds the tier cap (§2.6).
  - On low, render `FX_ALPHA` into a **half-res target** composited with a depth-aware upsample. This is the "low-res particles" technique; it is optional and only if low needs it.
- **Ribbon geometry.** A preallocated `BufferGeometry` with `DynamicDrawUsage`, `setDrawRange` to the live segment count, and an `updateRange` limited to the live part. No per-frame allocation.
- **VAT.** A `RGBA16F` `DataTexture`, `NearestFilter`, read with `texelFetch(gl_VertexID, frame)`, with linear interpolation between two frames in the shader.
- **Texture formats.** KTX2 (Basis UASTC for fire/smoke colour and normals, ETC1S for masks and decals) through the r170 `KTX2Loader` (the transcoder is in `node_modules/three/examples/jsm/libs/basis`; copy it to `public/basis/`). WebP is the fallback if transcoding fails.

### 2.3 Per-weapon trail profiles

| Weapon class | Fighters / moves | Ribbon | Colour |
|---|---|---|---|
| Heavy blade (axe) | gorak (`weaponTip`) | wide (full blade length), short life (0.12 s), dark smoky body, hot thin leading edge, DIST on heavies | steel-white core 6–10, warm edge; accent only on the ultimate |
| Sword | aldric (`weaponTip`) | narrow, longer (0.18 s), crisp edge, faint glint at the apex | cool white core; holy moves turn it gold |
| Claw | vex, fenrik (hand bones; finger bones if present) | three thin parallel ribbons 3–4 cm apart | vex crimson-black, fenrik pale |
| Blunt / fist / kick | maw, hollowjack, kicks of all fighters (effector from `clips[move].eff`) | very short air-smear (0.08 s), mostly a DIST ribbon with a faint dust tint | no colour on lights; dust tint on heavies |
| Magic hand | ozrel, vex shadow moves | fire or shadow ribbon textured with a scrolling flipbook strip | school colour (§5 magic) |

### 2.4 Post plan

- **FX HDR scale** (a convention written into `fxDefs.ts`):
  - core 8–30 (always blooms);
  - body 1.5–4;
  - smoke and dust lit at scene level (≤ 1);
  - sparks 6–12.
- **Bloom.**
  - Lower the theme thresholds towards about 1.0–1.2, with strength lowered so the scene does not glow overall. That gives fire bodies soft halos while the cores stay hot.
  - P2 option: replace `UnrealBloomPass` (10 blur passes + composite) with a dual-filter bloom (13-tap downsample, tent upsample; about 6 cheaper passes). Measure first.
- **Grade preset stack.** `post.update` gets `presets: {finisher, ultimate, lastStand, killcam, victory}` weights, each preset a small `Grade` delta, blended in on top of the theme grade. The existing `desat`, `flash` and `aberration` become presets fed from FX defs.
- **Distortion.** The grade pass reads `tDistort` (half-res RG) before its CA fetches, so it costs one extra fetch.
- **Vignette pulse** for last stand and near death.
- **DOF** stays where it is used today, now fed by the shared depth.

### 2.5 Faking many torch lights

- **Real lights.** Keep a fixed-size FX light pool of exactly 3 `PointLight`s, created once and never added or removed, so shader permutations never change.
  - It sits on top of the arena's fixed flame lights.
  - Priority = `intensity × (1 / (1 + dist(camera target)))`, re-evaluated every frame.
  - Impacts, explosions, parries and fireballs request a slot for their duration.
- **Arena flames.** Cut `lightBudget` from 7 to **4 high / 2 medium / 1 low**. This is the arena session's file (`arenaView.ts`), so it is listed as an interface need in §3.10.
  - Pick the braziers nearest the arena centre for real lights.
  - Every other flame gets a glow card, a floor light-pool card (an additive radial gradient decal, 2–4 m, warm) and a reflection streak card. The streak is a vertical camera-facing quad below the floor plane, mirrored, elongated and noise-broken, fading with view angle: the long orange streaks in ref-3, ref-4 and ref-7.
- **Flicker.** `noise1(arenaTime * f + seed)` replaces the sin-sum flicker; it is deterministic and cheap. All cards and the light share the same value.

### 2.6 Quality tiers and budgets

Typical combat on high, Arc iGPU at 1080p: **2.0 ms GPU and 0.6 ms CPU** for FX. Peaks during an explosion or ultimate reach 3.5 ms.

| Item | Low (q0) | Medium (q1) | High (q2) |
|---|---|---|---|
| GPU particles alive (cap) | 1 500 | 3 500 | 6 000 |
| Flipbook particles alive | 60 | 150 | 300 |
| Overdraw cap (screen-equivalents of alpha FX) | 0.75 | 1.5 | 3.0 |
| Soft particles | depth fade off except fog | on | on |
| Motion-vector flipbook blend | off (crossfade) | on | on |
| Distortion buffer | off | heavy events only | on |
| Afterimage ghosts per fighter | 0 (dust only) | 1 | 3 |
| FX light pool slots | 1 | 2 | 3 |
| Arena real flame lights | 1 | 2 | 4 |
| Floor decals | 64 (canvas fallback allowed) | 128 | 256 |
| Fog cards | 0 | 8 | 20 |
| Wound spheres per fighter | 4 | 6 | 8 |
| Atlas resolution | half (1024²) | full (2048²) | full |
| MSAA on the scene pass | 0 | 0 (measure) | 4 (measure) |

`App.setQuality` / `KeyQ` / `autoTune` already exist in `main.ts`. FX read `quality` through one `fxSettings.quality` value with a change listener, and never rebuild materials on a tier change (they toggle uniforms and caps instead).

---

## 3. Architecture

### 3.1 Modules (all new, under `src/render/fx/`, owned by the FX sessions)

```
src/render/fx/
  fxDirector.ts    event -> effect resolution, scheduling on the FX clock, seek/replay, light pool, overdraw budget
  fxDefs.ts        DATA: effect definitions keyed by event / move / fx tag / weapon class / surface (TS table, typed)
  fxSurfaces.ts    DATA: fighter surface (metal, flesh, fur, cloth, pumpkin...), weapon class, per-theme floor surface
  fxSettings.ts    quality tier + GORE LEVEL (single source of truth) + listeners
  fxRng.ts         seeded hash RNG: rng(matchSeed, eventIndex, emitterId, i)
  fxClock.ts       FX time: follows sim time, with hit-stop "breathing" rules
  particles.ts     stateless instanced GPU particle system (spark / ember / droplet / flipbook)
  ribbons.ts       time-sampled ribbon trails
  decals.ts        instanced floor decal batch (colour + normal + roughness atlas), canvas fallback
  cards.ts         flares, glow cards, light pools, reflection streaks
  distortion.ts    FX_DIST layer + half-res RG target
  afterimage.ts    ghost pool + pose history
  fighterFx.ts     fighter material patch: wounds, rim, status (absorbs finisherFx patchMaterial)
  lights.ts        3-slot FX light pool
  atlas.ts         KTX2/WebP atlas loader + frame metadata (public/fx/atlas.json)
  profiler.ts      per-layer CPU timers + GPU timer queries + counters
  legacyVfx.ts     facade with the old VFX API (sparks/flash/dust/smoke/fire/embers/shockwave/arrow/debrisBurst)
tools/fxlab/       FX Lab (index.html + lab.ts)
tools/fx/          blender/*.py bake scripts, pack_atlas.py, encode_ktx2.mjs, check_budget.mjs
public/fx/         *.ktx2 (+ .webp fallbacks), atlas.json
```

### 3.2 The minimal clean hook (how events reach the renderer)

Today `tickFight` (`main.ts:588`) calls these, in order:
1. `pb.advance(simDt)` → `evs`
2. `handleEvents(evs, fr)`
3. `continuousFx(fr, simDt)`
4. `updateProjectiles(fr, simDt)`

Steps 2–4 make roughly 100 direct `this.vfx.*` calls.

**Hook (one line per site, so it does not collide with the animation agent's edits):**

```ts
// main.ts, after views are updated and before handleEvents:
this.fx.frame({ events: evs, frame: fr, simT: pb.t, simDt, realDt, views: this.views, arena: this.arena, rec: this.rec, director: this.director });
```

**`FxDirector.frame` does:**
- For each event: `resolve(event)` → zero or more effect ids, built from the defs (`hit` → `impact.<weaponClass>.<surface>` + `blood.*` by gore + `shockwave.*` if heavy). Then `spawn(id, ctx)`.
  - Positions come from FighterView getters (`chestWorld`, `strikePointsWorld`, `castWorld`, `headWorld`, `position`), and `fr` for props, projectiles and hazards.
- Continuous emitters (trails, buff auras, ring of fire, burning, projectile trails) are evaluated from `fr` (state, phase, buff, lastStand, ringS, proj), the same data `continuousFx` uses today.
- Its update runs on the FX clock (§3.4).

**Migration.**
- The `VFX` class becomes `legacyVfx.ts`, a facade with the same method names whose bodies emit through the new system.
- `finisherFx.ts`, `cinematic/entrance.ts` and `tools/animlab/labExtras.ts` keep compiling and working with no edits in F0.
- Then, block by block, the literal calls in `main.ts handleEvents/arenaFx/continuousFx/updateProjectiles` are deleted and replaced by defs. Each block is one small commit, coordinated with whoever holds `main.ts` at the time.

**FighterView** needs a few read-only getters, owned by the animation agent; request them, do not edit the file in parallel:
- `footPlanted(): [boolean, boolean]` from FootLock;
- `trailSample(out)`, i.e. the base/tip already computed in `pushTrail`;
- `weaponClass`;
- `poseSnapshot(buf)` for afterimages;
- `materials` (already `mats`, make it public).

FX then owns the trail ribbon; the old `Trail` in `fighterView.ts` is removed in the same change that adds the getter.

### 3.3 Effect definitions as data

```ts
// fxDefs.ts (excerpt, shape only)
export interface FxDef {
  id: string;                         // 'impact.blade.metal'
  layers: FxLayer[];                  // particles / flipbook / ribbon / decal / card / dist / light / post / shake
  at: 'contact' | 'victimChest' | 'attackerFeet' | 'event.xyz' | 'cast' | 'head';
  dir?: 'hitDir' | 'up' | 'blade' | 'none';
  gore?: { off?: string | null; standard?: string; full?: string };   // id substitution by gore level
  tier?: { low?: Partial<FxDef>; med?: Partial<FxDef> };              // overrides
  stop?: 'freeze' | 'slow' | 'real';  // behaviour during hit-stop (CI1)
  light?: { color: string; intensity: number; dur: number; radius: number };
  post?: { aberration?: number; flash?: number; grade?: string; gradeDur?: number };
  shake?: number;                     // read by the director once §3.6 is agreed; ignored until then
  sfx?: string;                       // ONLY new FX-owned sounds (fire loops, splats); event sounds stay in SoundDirector
  priority: number;                   // budget culling order
}
export const RESOLVE = {
  hit:   (e, ctx) => [`impact.${ctx.weaponClass(e.a, e.data.move)}.${ctx.surface(e.b)}`, e.data.heavy && 'shock.heavy', bloodFor(e, ctx)],
  block: () => ['block.sparks'],
  parry: () => ['parry.flash'],
  // ... one line per EventType that has visuals
  move:  { thousand_cuts: 'ult.thousandCuts', pyre: 'ult.pyre', /* ... */ },
  tag:   { slam: 'class.slam', quake: 'class.quake', fire: 'class.fireRanged', /* ... */ },
};
```

The lookup order is `(fighter,move)` → `move` → `fx tag` → `kind` + `weapon class`. The catalog (`docs/fx-catalog.md`) is the spec for these entries. The FX Lab lists every `FxDef.id`.

### 3.4 Determinism, replay and `?t=` jumps

- **No randomness outside `fxRng`.**
  - `rng = hash(matchSeed, eventIndex, defHash, emitterIndex, particleIndex)`.
  - The `eventIndex` is the event's index in `rec.events`. It is stable because the record is deterministic.
  - Continuous emitters use `hash(matchSeed, fighter, emitterHash, floor(fxT * rate))`.
  - Ambient arena FX use `hash(arenaSeed, ...)`.
  - The hash lives in `render/arena/noise.ts` (`hash3`), or a new `fxRng.ts` with the same style. **Never import from `src/sim`.**
  - Code review gate: `rg "Math.random|performance.now|setTimeout|Date.now" src/render/fx` must return nothing.
- **Stateless particles.** A particle's state is a pure function of `(spawnFxT, seed, def, fxT)`, so rendering at fxT does not depend on frame history.
- **FX clock.**
  - `fxT` advances with sim time; during director hit-stop it advances at `stopRate` per def (freeze 0, slow 0.15).
  - On seek, `fxT := simT`.
  - The only non-reproducible part is the few-millisecond drift accumulated during hit-stops in live play. This is cosmetic, and the audit tools (`stepFrames`, `debugSeekFight`) step fixed dt, so they are reproducible.
- **Seek and replay (`debugSeekFight`, `?t=`).** `fx.seek(t)` will:
  1. clear all live effects;
  2. **replay decal-producing events** in `[0, t]` (cheap: decals only, no particles), so the floor shows the fight's history;
  3. **re-spawn effects whose lifetime overlaps t**: events in `[t - maxLife, t]` (maxLife ≈ 4 s), spawned with their original `spawnFxT = e.t`. In-flight sparks, smoke and fires appear mid-life, exactly as in a continuous play;
  4. rebuild persistent fighter state (wound spheres, weapon blood) from all `hit` events before t.
- **Sim isolation.** FX code may read `MatchRecord`, `Frame` and `SimEvent` but never writes them.
  - Dev-mode guard: `Object.freeze` on `rec.events` entries when `?fxdebug=1`.
  - `npm run sim:test -- 40` must stay byte-identical in its determinism line and win rates (FX touches nothing in `src/sim`).

### 3.5 Pooling and allocation rules

- **Zero allocation per frame in FX.** Scratch vectors are module-level, and the ring buffers are preallocated: particles (instanced attributes, ring cursor), ribbons, decals, ghosts, light slots, card pool.
- **Bursts** write a contiguous range of instances and set `addUpdateRange` on that range only.
- **Dead particles** cost nothing on the CPU. The vertex shader collapses expired instances (age > life → `gl_Position = vec4(2.0)`), so no CPU compaction is needed. The draw count is the ring capacity, kept small per tier; optionally track a high-water mark to shrink `instanceCount`.
- **Textures** are loaded once per session (atlases), never per arena.

### 3.6 Hit-stop and camera shake coordination

- **Hit-stop:** the director stays the owner (`hitStopUntil`, `freezeUntil`). FX read `director.timeScale(...)` and expose `stop` behaviour per def.
- **Shake:** today it is set in two places, `director.ts` per event and `arena.onEvent` return values. Proposal, agreed with the camera owner after the animation overhaul lands: the director keeps its logic but takes amplitudes from `fxDefs` (`def.shake`) so tuning happens in one table. Until then FX add no shake.
- **New hold for Thousand Cuts** (0.25 s on the last hit): a small director API, `director.requestHold(realDur, reason)`. This is an animation/camera file, so it goes in as a requested change (§5).

### 3.7 The gore setting (one place)

**Current state:**
- `finisherFx.ts` exports `GoreLevel = 'off'|'stylised'|'full'` and `goreLevel()`, which defaults to `'off'` and reads `?gore=` or localStorage `arena.gore`.
- `ui.ts:251` renders the select. `ui.ts:298` **writes the select value to localStorage on every menu submit**, so every tester who has opened the menu has `'off'` stored. Changing the code default alone would not reach them.
- `CLAUDE.md` and `docs/BACKLOG.md` §0 both say "defaults to OFF".

**Decision (owner, 2026-10-17): gore defaults ON at `standard`.** This supersedes the earlier "off by default" decision. Implemented after F0: `GORE_DEFAULT` in `fxSettings.ts`, new key `arena.gore.v2`, `?gore=stylised` alias, menu writes on change only. Combat blood (sprays, decals, wounds) arrives with F3; until then `standard` changes the finishers only.

| Level | Combat blood (sprays, floor splatter, pools, weapon blood, wounds) | Finishers |
|---|---|---|
| `off` | none: dust, fibre and dark mist instead | dissolve versions (as today) |
| `standard` (**default**) | Elden-Ring-like: sprays on cuts, splatter decals, pooling under the downed and dead, blood on blades and claws, wounds on bodies | severing finishers show, with dark-red caps and a short spray. This is today's `stylised`, recoloured from ink to blood. |
| `full` | as standard, with more volume (more droplets, larger pools, longer drips) | today's `full` (red caps, heavy blood) |

**Where to change it:**
1. Create `src/render/fx/fxSettings.ts`, which owns `GoreLevel` and `goreLevel()` (moved out of finisherFx and re-exported there for compatibility).
2. Map `'stylised'` to `'standard'`, keeping `?gore=stylised` as an alias.
3. Use a **new storage key** `arena.gore.v2`, so old forced-`off` values do not mask the new default. The old key is ignored.
4. `ui.ts` changes the option labels (`Off (clean) / Standard / Full`) and writes only when the user changes the select, not on every submit.
5. Update the doc lines: `CLAUDE.md` and `docs/BACKLOG.md` §0 (done).

Every FX def that shows blood declares `gore: {off: <substitute id>}`. Hollowjack never bleeds (pumpkin pulp at every level).

### 3.8 Profiling FX cost

- `profiler.ts` gives:
  - CPU `performance.now()` around `fx.frame` and around each layer update (dev only);
  - GPU time per FX layer via the `EXT_disjoint_timer_query_webgl2` queries that three exposes (if the Arc driver supports them; otherwise A/B toggling);
  - counters for live particles, flipbooks, ribbons, decals, ghosts, light slots, and the overdraw estimate.
- Add `__arena.fxStats()` and an FX line in the debug overlay (backquote key).
- Extend `tools/shots/perfprobe.cjs` with rows `- FX all` and `- FX distortion`, `- FX soft`, `- FX ghosts`.
- Add an `?fxstress=1` scenario: an explosion + an ultimate + both fighters burning + the ring of fire.

### 3.9 FX Lab (`tools/fxlab/`)

This mirrors `tools/animlab` and is served by the dev server at `/tools/fxlab/`.

- **Scene:** a neutral wet-stone floor patch, a brazier, two posed dummy fighters (loads `gorak` and `aldric` GLBs through `loadCharacter`), and a theme selector for lighting and grade.
- **Effect list:** every `FxDef.id`, with search.
  - Click to spawn at the dummies.
  - Loop mode.
  - Seed field.
  - Gore and quality toggles.
  - A slow-mo slider, and "hit-stop now".
- **Timeline scrub:** because particles are stateless, `t` is a slider. A frame-exact still at any time is available for review sheets.
- **Stats panel:** live counts, CPU/GPU ms, overdraw heat-map toggle (render FX with additive constant colour to visualise layered coverage).
- **Automation API** (`window.__fxlab`):
  - `list()`, `play(id, {seed, gore, q})`, `at(t)`, `stats()`;
  - `sheet(id, times[])`: renders a contact strip at fixed times;
  - `tools/shots/fxsheet.cjs` makes PNG sheets per effect (one browser, sequential).

### 3.10 What the arena art session needs from this plan (interfaces)

The arena art upgrade (shared kit, wet reflective floor) runs in its own session. FX provide, and the arena consumes:

1. **Soft-particle material + shared depth** (F1) for its fog cards and steam.
2. **`fx.flame(at, size, palette, {light?: boolean})`** returning an FX-owned brazier fire (E01). The arena keeps the brazier geometry and calls this instead of `Arena.flame()`.
3. **Card helpers:** `glowPool(at, color, radius)` and `reflectionStreak(at, color, height)` for every light source the arena places (braziers, candles, lanterns, lava).
4. **Decal batch** that the wet floor material receives, plus a floor-surface query `surfaceAt(x,z)` (stone, wet, mud, water, sand, snow) provided BY the arena for footstep FX.

What FX needs from the arena session:
- **Wet floor reflections must include the FX layers** (`FX_ADD`, at least) if a planar reflection or SSR-lite is used. If the reflection is a `Reflector` at half-res, render `FX_ADD` into it but not `FX_ALPHA`/`FX_DIST`.
- The flame light budget becomes per tier (§2.5).
- `Arena.flame()` and the ring of fire are rewired to FX (F4 touches `arenaView.ts` only at these call sites).

### 3.11 God powers (hook only)

Reserve `fx.godPower(kind: string, target: number | {x:number,z:number}, intensity: number)` in `FxDirector`, and a future sim event type `god_power` (not added now). Visual direction for later: light from above that breaks the cloud cover (shaft cards + flare + grade shift), distinct from fighter magic.

---

## 4. Asset pipeline

### 4.1 What to bake in Blender (scripted bpy, one job at a time)

Blender 5.0 is at `C:\Program Files\Blender Foundation\Blender 5.0`.
- Scripts go in `tools/fx/blender/` and run headless: `blender -b -P tools/fx/blender/bake_fire.py -- --out tools/fx/_bake/fire`.
- **Memory safety on the owner's PC:** one Blender process at a time; never in parallel with the dev server plus a headless browser. EEVEE renders volumes cheaply; Cycles is only for the final hero sets. Caches go to `tools/fx/_bake/` (gitignored), deleted after packing.
- Every script starts with a **1-frame dry run** and prints the peak RAM it measured.
- **Two methods per volume effect:**
  - **(A) Mantaflow** (Quick Smoke). If the 5.0 API changed, the dry run fails fast.
  - **(B) Procedural volume** (animated noise-driven Principled Volume on a domain cube or sphere: no simulation cache, deterministic, low memory). Use (B) by default for loops and dust, and (A) for explosions if it works.

| Atlas | Content | Grid × frame px | Passes | Loop | Method |
|---|---|---|---|---|---|
| `fire_loop` | brazier and torch flame | 8×8 × 256 | emission (temperature → R), alpha (G), motion vectors (separate RG atlas) | seamless (bake 96 f, crossfade the last 32 into the first) | B (A for a hero version) |
| `fire_burst` | short flare-up / fireball | 8×8 × 256 | same | one-shot | A or B |
| `explosion` | keg explosion fireball + dark smoke | 8×8 × 256 | emission + 3 directional light passes for the smoke (RGB) + alpha | one-shot | A |
| `smoke_wisp` / `smoke_column` | rising lit smoke | 8×8 × 256 | 3-light RGB + alpha + MV | wisp loop, column one-shot | B |
| `dust_puff` / `dust_ring` / `dust_plume` | ground dust (brown-grey, tintable) | 6×6 × 256 | 3-light RGB + alpha | one-shot | B |
| `blood_spray` | arterial spray, side view, plus droplets | 4×4 × 256 (16 f, fast) | colour (dark red, wet highlight) + alpha | one-shot | metaball particles (no fluid sim) |
| `splash_small` / `splash_big` | water crown + droplets | 6×6 × 256 | colour + alpha + MV | one-shot | metaball particles |
| `steam` | geyser / breath | 6×6 × 256 | 3-light RGB + alpha | loop | B |
| `energy_swirl` | magic gather/aura (for F8) | 8×8 × 256 | emission + alpha | loop | B (emission noise) |
| static `fx_sprites` | spark streak, ember, flare star, anamorphic flare, slash line, ring (DIST normal), rune circle, shockwave ring, claw streak, trail textures | 2048² packed | per-sprite | — | compositor and procedural shader bakes |
| static `decals` | blood splats ×8, blood pool, footprints, scorch ×3, cracks ×4, ice crack, frost, mud | 2048² colour + 1024² normal/rough | colour, normal, roughness | — | procedural (dynamic paint / noise) + ambientCG crack sources |

**Packing and encoding:**
- `tools/fx/pack_atlas.py` (Pillow, run with `python -I`) builds the grids and writes `public/fx/atlas.json`: `{id: {file, grid, frames, fps, loop, mv?, lit?}}`.
- `tools/fx/encode_ktx2.mjs` calls `toktx` (KTX-Software; the owner installs it):
  - UASTC + zstd for fire, smoke and normals;
  - ETC1S for masks and decals;
  - a WebP copy as fallback.
- `tools/fx/check_budget.mjs` fails if the download total exceeds the budget.

**File and memory budget (shipping in a browser):**

| Budget | Value |
|---|---|
| FX download, compressed | ≤ **6 MB** (now: 0) |
| FX GPU memory, high | ≤ **48 MB** |
| FX GPU memory, low | ≤ **24 MB** (load half-res variants) |

The page already ships `public/models` 18 MB, `public/anim` 8.6 MB and `public/audio` 7.1 MB.

**VAT (P2):** a quake floor upheaval and a pillar crumble, via a cell-fracture + rigid-body bake. Encode with the OpenVAT extension, or a 60-line custom bpy exporter writing `RGBA16F` EXR and min/max JSON. Runtime is the `vatMaterial` patch (§2.2).

### 4.2 Please download these (ranked, with a Blender fallback for each)

The owner downloads; the files go to `C:\Programming\GameDev\Research\Assets\vfx\<pack>\` (outside git, like the other raw assets). Licences were verified on the page unless marked **[S]**.

| # | What | Link | Licence / attribution | Use | Blender fallback |
|---|---|---|---|---|---|
| 1 | **Unity Labs VFX flipbooks**: Explosion00, Explosion01-light, FireBall01, FireBall02, Flame02, Flame03, SmallFlame01-temperature, WispySmoke01, WispySmoke03, CandleSmoke01, DiscSmoke01 | Page: https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks . Direct pattern: `https://unity3d.com/files/labs/downloads/vfx/assets01/<Pack>/<Pack>-flipbooks.zip`. Example (checked HTTP 200): https://unity3d.com/files/labs/downloads/vfx/assets01/Explosion00/Explosion00-flipbooks.zip | **CC0 1.0**, no attribution | explosion, fireballs, flames, wispy smoke: the most realistic free source found | `fire_loop`/`explosion`/`smoke_*` bakes (methods A/B) |
| 2 | **Kenney Particle Pack** | https://kenney.nl/assets/particle-pack | **CC0**, no attribution | spark, trace, slash, flare, scorch, magic masks | procedural sprite bakes (`fx_sprites`) |
| 3 | **Screaming Brain Studios noise pack** (the 512 zip is 99 MB; the 256 version is enough) | https://opengameart.org/content/noise-texture-pack | **CC0**, "credit is never required" | dissolve, distortion, lava, energy, ribbon streak noise | Blender noise/voronoi bakes |
| 4 | **ambientCG decals**: Asphalt Damage set, Leaking, Scratches, Footsteps | https://ambientcg.com (licence https://docs.ambientcg.com/license/) | **CC0**, no attribution | crack, grime and footprint decal sources (PBR) | procedural crack decals |
| 5 | **CGHEVEN free flipbooks**: lightning energy arcs + aerial explosions (2K) | https://cgheven.com/assets/vfx/ (licence https://cgheven.com/licensing/) | **Custom, not CC0**: commercial use OK, credit not required, no re-sharing of the raw files, no AI training. Keep a PDF of the licence page in `Assets/vfx/cgheven/`. | lightning (F8 magic), a big-explosion alternative | procedural branching lightning (code); method A explosion |
| 6 (optional) | Sinestesia blood sheets | https://opengameart.org/content/animations-blood-splatter-1 (CC0, credit requested) and https://opengameart.org/node/81933 (CC0 **[S]**) | CC0 | placeholder blood until `blood_spray` is baked | `blood_spray` metaball bake (preferred: matches the realistic style) |

Not usable:
- the Unity Legacy Particle Pack (Unity Companion License);
- legacy Unreal Marketplace content (Unreal-only);
- Textures.com;
- pixel-art OpenGameArt explosions (wrong style).

The full table is in `docs/fx-research.md`. Gaps no free pack fills realistically (water splash, ground dust, blood spray, scorch) are covered by the Blender bakes.

**Licence hygiene:** add `public/fx/CREDITS.txt` (CC0 sources listed even though not required) and a line in `docs/BACKLOG.md` §6.

---

## 5. Milestones

Effort is in agent-days. **"Seq"** marks a milestone that must run after the previous one; **"Par"** marks one that can run in parallel.

| ID | Milestone | Deliverables | Acceptance checks | Effort | Depends on | Touches (collision notes) |
|---|---|---|---|---|---|---|
| **F0** | Foundation (no visible change, or slightly better dots) | `src/render/fx/*` skeleton: `fxRng`, `fxClock`, `fxSettings` (quality; gore *code* ready but the default unchanged until the owner confirms), stateless `particles.ts`, `legacyVfx.ts` facade replacing `vfx.ts` internals (same API), `profiler.ts`, `fx.frame()` hook, `fx.seek()`. Remove `setTimeout`, `Math.random` and `performance.now` from FX paths in `main.ts`, `vfx.ts` and `fighterView` telegraph/glow (the last via a request to the anim owner). Fix the allocation leaks (shockwave, arrow, debrisBurst, projectile meshes). | sim:test unchanged. Grep gate clean. `__arena.fxStats()` works. Seek test: `debugSeekFight(t)` twice from a fresh load gives an identical `fxHash()` (hash of the live effect list: id, spawnT, seed). CPU FX time idle ≤ 0.05 ms (was a 4500-slot loop). | 2.5 d | — | new `src/render/fx/`; `vfx.ts` (internals); `main.ts` (hook lines + random/timeout removal). `main.ts` is being edited by the animation agent: **coordinate**, small commits. |
| **F1** | Depth + post plumbing | `ScenePass` with a `DepthTexture` + linear-depth copy; FX layers; soft particles; distortion buffer + grade fetch; Bokeh fed the shared depth; MSAA option measured; bloom HDR-scale convention + threshold retune per theme; grade preset stack. | `perfprobe` before/after: total frame time not worse on high (the Bokeh depth removal should pay for the depth copy). Screenshots: dust cards show no hard floor lines (lab sheet). | 2 d | F0 (Seq) | `post.ts` (**render-wide**: tell the arena and UI sessions), `themes.ts` bloom numbers (arena session's file: agree first) |
| **F2** | FX Lab + asset pipeline + first atlases | `tools/fxlab/`; `tools/fx/` bake, pack and encode scripts; atlases `fire_loop`, `smoke_wisp`, `dust_puff`, `dust_ring`, `blood_spray`, `fx_sprites`, `decals` (Unity/Kenney sources where downloaded, bakes otherwise); `atlas.ts` KTX2 loader; flipbook + motion-vector shader. | The lab lists all defs; `fxsheet.cjs` makes per-effect sheets; `check_budget` passes (≤ 6 MB); Blender scripts log peak RAM; KTX2 decodes on the Arc driver (WebP fallback tested). | 3 d + bake time | F0. **Par with F1**: the lab can start on the F0 particles | new `tools/fxlab`, `tools/fx`, `public/fx` only. Blender runs **alone** (memory). |
| **F3** | Everyday combat (P0) | Catalog §1 P0 rows: material impacts (C06a–f), block, parry, heavy shockwave, landing dust, trails v2 per weapon (FX owns ribbons; `fighterView.Trail` removed in the same change), floor decals v2 (blood, cracks, scorch), blood at the standard level (spray, splatter, pools), CA and flash from defs, the FX light pool. `main.ts handleEvents` hit/block/parry/knockdown/kill blocks moved into defs. | Filmstrip sheets for 6 fixed seeds (`moments.cjs`) at hit and parry moments; perf within budget on high, plus a low-tier run; sim:test unchanged; seek reproducibility for decals (floor identical after `?t=40` vs play-through, compared by decal-list hash). **Human:** does it read as realistic and not cartoony; is blood at standard the right amount. | 4.5 d | F1, F2 (Seq) | `fx/*`, `main.ts` (event blocks), `fighterView.ts` (getters + trail removal: **anim owner**), `finisherFx.ts` only if gore is confirmed |
| **F4** | Fire + environment (P1) | E01 brazier fire (flipbook, smoke, embers, DIST, light-pool and reflection-streak cards, per-tier real lights), ring of fire v2, explosion v2, destruction dust, lava heat haze, fog cards, water splashes, persistent decals (mud, frost, footprints). | Side-by-side with ref-3, ref-4 and ref-7 at matching camera angles (human judgement); perf ≤ budget with all braziers lit; light count per tier honoured (renderer.info). | 3.5 d | F3 for the patterns. **Par with F5.** Needs the arena session's agreement. | `arenaView.ts` call sites (`flame()`, `fireRing`, `lightBudget`) are **the arena session's file**: do this jointly, or after its floor work lands. |
| **F5** | Skill FX (P1) | Catalog §2: move-class treatments + 8 ultimates; afterimage system; Thousand Cuts (deferred-impact batching, slash lines, the hold via a `director.requestHold` API); rush speed trails; slams and quakes (emissive cracks, rubble ring); ranged fire and arrow trails; buff and rage auras via `fighterFx` rim. | Lab sheet per ultimate; in-game filmstrip for each ultimate (`findev.ts`/`finstats` style search for seeds where it lands); Thousand Cuts: 6 slash lines visible, the freeze happens, damage timing unchanged (sim:test). Perf peak ≤ 3.5 ms. | 5 d | F3. **Par with F4.** | `fx/*`; `director.ts` (`requestHold`): **camera owner**; `fighterView.ts` (pose snapshot getter): **anim owner** |
| **F6** | Status effects (P2) | `fighterFx` status layer: burning, bleeding, enraged, last stand, winded, low health, second wind. Frozen, poisoned, slowed and stunned built and testable in the lab, hooked when the sim gains statuses (magic). | Lab toggles per status on both dummies; in-game: rage and last stand readable at the coverage camera distance (human). | 2.5 d | F5 (fighterFx rim) | `fx/fighterFx.ts`; `finisherFx.ts` patch merge (one `onBeforeCompile`): **coordinate with the anim owner** |
| **F7** | Cinematic + post polish (P2) | Grade presets wired to beats, freeze-frame FX behaviour (CI1), death effects (CI7), finisher FX integration (CI6: swap the dot calls for defs, blood flipbooks, ice chips), victory embers, vignette pulse, optional dual-filter bloom. | The finisher capture set (HANDOFF step 3) re-shot; no change in the pair/camera audits; sim:test unchanged. | 3 d | F3, after the animation overhaul's finisher work has landed (Seq) | `finisherFx.ts` (anim owner's): do it after they sign off M4. `post.ts`. |
| **F8** | Spell FX foundation (before the magic overhaul) | The `SpellFx` architecture (below), school palettes and atlases (`energy_swirl`, lightning strip), hand attach from cast clips (`release` frame per the animation plan §f), beams (swept ribbon), god-power hook stub. Ozrel's fire moves ported onto it as the first school. | Lab: each stage (charge, release, travel, impact, linger) per school; release-frame error ≤ 1 frame vs the clip's release event. | 3 d | F5 | `fx/spell/*`; projectile visuals in `main.ts` (`updateProjectiles`) move to FX |

**Total:** about 29 agent-days plus bake time.

**Critical path:** F0 → F1 → F3 → F5 → F8.
- F2 runs alongside F1.
- F4 runs alongside F5.
- F6 and F7 fill in after.

**Sequencing with the other sessions:**
- **Animation overhaul (now):** owns `src/render/{fighterView,poseFx,finisherFx,contactWarp}.ts`, `src/camera/*`, `src/sim/*`. FX request getters and APIs; they do not edit these files in parallel. F7 waits for M4 sign-off.
- **Arena art upgrade:** owns `src/render/arena/*`. F4 is done jointly, or after its floor and kit pass. F1's `post.ts` change and MSAA decision must be agreed, because the arena's reflection pass depends on the scene pass.
- **UI redo:** owns `src/ui/*`. Only the gore select labels and the write-on-change fix touch `ui.ts`; the UI session can do it from §3.7.
- **Magic overhaul:** starts after F8.
- **New characters:** surface and weapon class are data rows in `fxSurfaces.ts`; each new character needs one row.

### 5.1 Verification strategy (agents run these themselves)

1. **Determinism:**
   - `npm run sim:test -- 40` before and after each milestone. Win rates 45–55%, 0 timeouts, 0 kills without contact, determinism OK, and the per-fighter rates identical to the pre-FX run (FX never touch `src/sim`).
   - Grep gate on `src/render/fx`.
   - `fxHash()` seek test.
2. **Perf:**
   - `npm run build`, then `node tools/shots/perfprobe.cjs colosseum:oval:7` (one browser only; the dev server must not be running at the same time on this PC) with the new FX rows.
   - Plus `?fxstress=1` via `__arena.bench(60)`.
   - Record ms in `docs/milestones/F*/perf.txt`.
   - Budgets from §2.6.
   - Also record `renderer.info.render.calls` and the triangle count before and after.
3. **Look:**
   - FX Lab sheets (`fxsheet.cjs`) per effect at fixed times and seed.
   - In-game filmstrips via `tools/shots/moments.cjs` on fixed `a,b,seed,theme,layout,aseed,t` tuples, stored in `docs/milestones/F*/`.
   - The tuple list lives in `docs/milestones/F3/moments.txt`, so later milestones re-shoot the same moments.
4. **Memory:** watch Chrome's `performance.memory` and the GPU texture count (`renderer.info.memory`) across 5 rematch cycles (R key); there must be no growth (the leak fix in F0).
5. **What cannot be judged without human eyes:**
   - realism versus cartoonishness;
   - bloom balance on a real monitor;
   - whether the blood level is acceptable;
   - hit "feel" (stop, shake and flash timing);
   - motion quality of the flipbooks at real frame rates;
   - readability at gameplay camera distance.

   Headless Chrome GPU timings on the Arc driver are indicative only, and thermal state changes them by about 15%. Agents must say so in their reports, not claim it.

### 5.2 Spell FX foundation (F8): architecture and school outline

- **Stages** (each an `FxDef` list): `charge` (hand / ground), `release` (at the clip's release frame, at the correct hand), `travel` (projectile or beam or ground wave), `impact` (by surface), `linger` (persistent area, decal), `status` (applied FX on the victim).
- **A `SpellFxDef` = school + shape** (bolt, beam, nova, wall, rain, summon-circle) + scale, so new spells are data.
- **Palette per school:** a core HDR colour, a body colour, smoke tint, light colour and distortion amount.
- **School outline** (full plan later):

  | School | Look |
  |---|---|
  | fire | flipbook flame, embers, scorch, heat haze |
  | ice | crystal meshes (instanced), frost decals, cold mist, refraction-like DIST, shatter chips |
  | lightning | procedural branching bolt ribbons regenerated per frame from a seeded L-system, a hard flash with LITE, scorch star |
  | water | splash flipbooks, droplet GP, wet decals that darken the floor |
  | dark/shadow | alpha-blended black smoke with crimson or violet rims, dissolve, light-absorbing (negative grade locally) |
  | nature | vine meshes growing (VAT or shader-grown), leaves GP, pollen motes |
  | holy | god-ray cards, gold runes, white cores, warm grade |
  | blood | crimson liquid ribbons, droplets, a drain toward the caster; respects gore (`off` → crimson mist) |
  | wind | DIST-heavy, dust and leaves carried, almost no colour |
  | gravity | DIST lensing sphere, debris pulled inward, floor cracks radial-inward |

---

## 6. Risks and open questions

**Questions for the owner (only these need an answer):**

1. **Gore default.** ANSWERED (2026-10-17): yes, ON at `standard` with severing shown; implemented. The original proposal:
   - blood at the "standard" (Elden-Ring-like) level is ON by default;
   - finisher severing is shown at standard, with dark-red caps;
   - the stored setting resets once (new storage key), so everyone sees the new default;
   - `CLAUDE.md` and `BACKLOG.md` change from "defaults to OFF".

   **Is that right?** Or should severing stay dissolve-by-default while combat blood is on?
2. **Downloads.** Please fetch packs 1–4 in §4.2 (and 5 if lightning matters soon) into `Assets/vfx/`. Also install KTX-Software `toktx` (https://github.com/KhronosGroup/KTX-Software/releases), or accept WebP only (about 3× the VRAM, simpler).
3. **CGHEVEN's custom licence:** OK to ship? It is free and commercial use is allowed, but the files must not be re-shared raw. If not, skip it and bake lightning and explosions ourselves.

**Risks:**

| Risk | Mitigation |
|---|---|
| iGPU frame time is already 13–19 ms | Strict tier caps; stateless particles move work off the CPU; measure every milestone; low tier halves the atlases and disables DIST. |
| `post.ts` scene-pass change collides with the arena session's wet-floor reflection | Do F1 first and announce the API, or co-design it. |
| Blender 5.0 Mantaflow API change or high RAM | Dry-run first; the procedural-volume fallback is the default. |
| Afterimage cost (skinned redraws) | Capped per tier; 0 on low. |
| Thousand Cuts "cuts land together" needs a director hold | Small API request; without it, the slash lines still work and the hold is skipped. |
| Over-bright FX wash out the scene ("cartoon neon") | The HDR-scale convention plus human review in F3 before scaling up. |
| Main.ts merge conflicts with the animation agent | Hook-first (one call), then move blocks in small commits on agreement. |
