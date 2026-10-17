# FX research notes (raw)

Supporting notes for `docs/fx-plan.md`. The research was done on 2026-10-17.

How sure each licence is:
- **[V]**: I read the licence on the asset's own page.
- **[S]**: the licence comes from search snippets or press coverage only.
- **[M]**: from memory, not verified.

I downloaded nothing.

## 1. What is already on the owner's PC

`C:\Programming\GameDev\Research\Assets` was checked. It contains:
- `Animations`, `Models`, `Models_HF`
- `sfx`: Kenney impact, RPG and voiceover audio zips; Sword Combat FREE; Swords & Blades; monster sounds; boss music; voice refs

It has **no VFX textures, flipbooks, decals or particle sprites**. Every FX texture today is generated on a canvas at runtime:
- `vfx.ts softTexture`
- `arenaView.ts flameSprite / plumeSprite`
- `textures.ts softDot / petalSprite`
- `fighterView.ts` aura ring

## 2. Free packs: licence table

| # | Pack | URL | Licence | Attribution | Content | Fit |
|---|---|---|---|---|---|---|
| 1 | Unity Labs VFX image sequences & flipbooks | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks | **CC0 1.0 [V]** (the page says "we release some of these sequences under CC0 license") | No | 28 Houdini-rendered packs. Each comes as a flipbook zip, a linear EXR sequence and a TGA sequence. Packs: CandleSmoke01, Cloud01-04, DiscSmoke01, Explosion00/01/01-light/01-light-nofire/01-nofire/02/02HD, FireBall01-04, Flame02/02-temperature/03/03-hollow, SmallFlame01 (3 variants), WispySmoke01/02/03/03b. URL pattern: `https://unity3d.com/files/labs/downloads/vfx/assets01/<Pack>/<Pack>-flipbooks.zip`. The Explosion00 zip answered HTTP 200 (application/zip) on 2026-10-17. | **Best realism for free.** Frame size and grid are not stated; inspect after download. Released in 2016. |
| 2 | Kenney Particle Pack | https://kenney.nl/assets/particle-pack | **CC0 [V]** | No | 80 PNG sprites at 512². From memory [M]: smoke, fire, flame, flare, light, magic, muzzle, scorch, scratch, slash, spark, star, trace, twirl, dirt, circle. | Medium. Grayscale sprites that tint well; good for spark, slash and trace masks and flares. |
| 3 | Screaming Brain Studios, 700+ Noise Textures | https://opengameart.org/content/noise-texture-pack | **CC0 [V]** ("credit is never required") | No | 768 tileable grayscale noises (Perlin, cracked, voronoi, swirl, streak, melt…) at 512/256/128. The 512 zip is 99 MB. | Shader inputs: dissolve, distortion, lava, energy, smoke breakup. |
| 4 | CGHEVEN free VFX (aerial explosions, lightning arcs, fire loops) | https://cgheven.com/assets/vfx/ , licence https://cgheven.com/licensing/ | **Custom [V]**, NOT CC0. Free for commercial use, credit "appreciated but never required". Forbids re-sharing, reselling or re-uploading the original files, bundling into packs, and AI training. | No | Realistic flipbooks, free at 1K/2K | High. Shipping the files inside a game build is the intended use, but keep a copy of the licence page. Possibly needs an account (unclear). |
| 5 | ambientCG decals and materials | https://ambientcg.com , licence https://docs.ambientcg.com/license/ | **CC0 [V]** | No | 127 decal sets (Leaking, Asphalt Damage, Scratches, Imperfections, Smear, Chip, Footsteps…), PBR colour, normal, roughness and opacity | High (photoscanned). No blood. Use for crack, grime and footprint decals. |
| 6 | Sinestesia "Animations – Blood Splatter 1" | https://opengameart.org/content/animations-blood-splatter-1 | **CC0 [V]** (mention requested, not required) | Optional | 8 frames in a 1024² sheet, red + green | Medium-low (painted). Small frames. Fallback only. |
| 7 | Sinestesia "Animations – Blood, Hit and Both" | https://opengameart.org/node/81933 | CC0 **[S]** | Optional | 16 × 512 px frames, hit flash + blood | Medium. Verify the licence on the page before use. |
| 8 | Texture Ninja (blood traces, burn, cracks) | https://texture.ninja | CC0 **[S]** | No | Photographs | High, but needs processing into decals. Verify the licence. |
| 9 | Kenney Smoke Particles | https://kenney.nl/assets/smoke-particles | **CC0 [V]** | No | 70 PNG puff sequences | Medium-low (cartoonish puffs). Fallback. |
| 10 | Poly Haven | https://polyhaven.com/license | **CC0 [V]** | No | PBR stone and ground, HDRIs | For the arena session; base for decal authoring. |
| 11 | JangaFX EmberGen free VDBs (2020) | the old page returns 404 | CC0 [S] | No | VDB volumes | Could be rendered to flipbooks in Blender. Availability unconfirmed. |

**Not usable or not worth it:**
- **Unity Legacy Particle Pack**: Unity Companion License, tied to Unity use. Not safe for a three.js game.
- **Unreal Marketplace legacy content**: Unreal-only.
- **Textures.com**: commercial credit system.
- **GameGland blood decals**: $1 minimum.
- **three.js example sprites**: provenance undocumented.
- **OpenGameArt pixel-art explosions**: wrong style.
- **Gabriel Aguiar**: no free licence found.
- **realtimevfx.com**: tutorials, no asset library.

**Gaps that no free pack covers well:**
- realistic water splash
- realistic ground dust burst
- blood spray flipbook (realistic)
- scorch decal (realistic)

Bake these in Blender (plan §4).

## 3. Technique references

- **Soft particles:** fade alpha by `saturate((sceneDepth - particleDepth) / softness)`. This needs the opaque depth as a texture that the particle shader samples. Sampling a depth texture that is also the bound depth attachment is a feedback loop in WebGL2. So copy the depth to a separate texture (half-res linear depth), or render particles into a target that does not have that depth attached.
- **Flipbook sub-frame blending:** plain crossfade between frames N and N+1 ghosts. Motion-vector (flow) blending removes that: each frame stores a 2D motion vector (RG). Frame N is sampled at `uv - mv*t` and frame N+1 at `uv + mv*(1-t)`, then the two are mixed. Blender can output the motion as a Vector pass or as an optical-flow bake. Common in UE/Unity realtime VFX (e.g. Klemen Lozar's motion-vector flipbook articles on realtimevfx). Cost: two extra texture fetches.
- **Vertex animation textures (VAT):**
  - **OpenVAT**, a Blender extension (https://extensions.blender.org/add-ons/openvat/ , https://github.com/sharpen3d/openvat). It encodes animated geometry, simulations and geometry nodes into a position/normal texture, plus an extra UV set and min/max JSON. Official integrations cover Unity, Unreal and Godot, not three.js.
  - **three-vat** (https://github.com/manthrax/three-vat) is a three.js runtime. It patches standard materials through `onBeforeCompile`, supports per-instance time offsets, and has an OpenVAT sample. Its OpenVAT compatibility is unverified.
  - The "VAT Blender Addon" (https://extensions.blender.org/add-ons/vat/) targets three.js directly.
  - A shader for our own use is ~40 lines: per vertex, read the texel at (vertexIndex, frame) and add it to the rest position.
- **KTX2 / Basis:**
  - three r170 ships `KTX2Loader` and `examples/jsm/libs/basis/basis_transcoder.{js,wasm}`; both were checked in `node_modules`.
  - The encoder is KTX-Software `toktx` (or `basisu`). Example from the three.js forum: `toktx --2d --genmipmap --target_type RGBA --t2 --encode etc1s --clevel 5 --qlevel 255 out.ktx2 in.png`.
  - Use UASTC (+ zstd) for HDR-ish fire and smoke cores and normals, and ETC1S for masks and decals.
  - KTX-Software 4.3 notes that Basis output is not bit-identical across platforms or threads. That is fine for assets, but do not hash compressed files in tests.
  - `@gltf-transform/cli` is already a devDependency, but it drives `toktx` for glTF textures only. Standalone atlases still need `toktx` installed.
- **Blender 5.0:**
  - A 2025 news write-up says smoke/fire simulations now use NanoVDB (lower memory). I could not confirm whether the Mantaflow "Quick Smoke" operator is unchanged.
  - The bake scripts must start with a 1-frame dry run (`bpy.ops.object.quick_smoke(style='BOTH')`), and fall back to the **procedural volume** method if Mantaflow is missing or too slow.
  - The procedural volume method: an animated noise-driven Principled Volume on a cube, rendered with EEVEE. It needs no simulation cache, uses little memory and is deterministic.
- **Fake many lights:**
  - Forward-rendered MeshStandardMaterial pays per light per fragment, and changing the light count recompiles every material.
  - So: a fixed small pool of real PointLights, plus emissive glow cards, plus additive "light pool" decals on the floor, plus a vertical "reflection streak" card under each flame for the wet floor. The concept art (ref-3/4/7) shows exactly these long streaks.
- **Distortion (heat haze, shock rings):**
  - Render distortion sprites (normal-map style RG offsets) on their own layer into a half-res RG16F target.
  - The grade (or a dedicated) pass offsets its `tDiffuse` lookup by that buffer.
  - Mask by soft depth so near objects are not smeared.
- **Ribbon trails:**
  - Store (time, base, tip) samples on the sim clock and rebuild the strip each frame.
  - Subdivide with Catmull-Rom to N segments and set UV.x = age / lifetime.
  - The texture gives a hot leading edge and a fading smoky body.
  - Frame-rate independence comes from sampling by time, not by frame.
- **Afterimages:**
  - Keep 2–4 `SkeletonUtils.clone` ghosts per fighter. Copy the bone quaternions from a pose history ring buffer recorded at fixed sim-time intervals.
  - Render them with one additive fresnel material.
  - Cost is a skinned redraw per ghost, so cap them on low.

## 4. Codebase facts used by the plan (with line refs at the time of reading)

- `src/main.ts` is the FX hub today.
  - `handleEvents` (~l.804–1005), `arenaFx` (~l.1008–1120), `continuousFx` (~l.709–747), `updateProjectiles` (~l.751–788) and `onActiveStart` (~l.790) all call `this.vfx.*` with literal colours and counts.
  - FX time: `this.vfx.update(fxDt)`, where `fxDt = max(simDt, realDt*0.08)` (l.669).
  - The impact light fades on real time (l.561).
- `src/render/vfx.ts`:
  - A CPU `ParticlePool` (3000 additive + 1500 alpha `THREE.Points`, one soft radial canvas texture).
  - Every frame it loops all 4500 slots and re-uploads 4 attributes, even when nothing is alive.
  - `Math.random` is used everywhere.
  - `shockwave`, `arrow` and `debrisBurst` allocate a new geometry and material per call. Ring materials are never disposed; `debrisBurst` creates a material and a box geometry per piece and never disposes them.
  - One shared `flashLight`.
  - `Trail` holds 9 samples pushed per *render frame*, so its length depends on the frame rate. It has no UV or texture and uses one accent colour for every weapon.
  - `Telegraph` pulses with `performance.now()`.
- `src/render/finisherFx.ts`:
  - The gore setting lives here (`goreLevel()` defaults to `'off'`; localStorage `arena.gore`; `?gore=`).
  - `patchMaterial` adds `uDissolve/uBurn/uIce/uDrain/uCap` via `onBeforeCompile` with `customProgramCacheKey 'finfx'`.
  - It uses `Math.random` for spin and spawn chance.
- `src/ui/ui.ts:251,298`: the gore `<select>`. On every menu submit it calls `setGoreLevel(value)`, so anyone who opened the menu has `'off'` saved.
- `src/render/arena/debris.ts`:
  - Instanced, seeded (`R(99)`) chunk pools: good, keep.
  - `Decals` is a 1024-px canvas over the arena with scorch, crack and scuff (scuff is unused). Low resolution: about 2.7 cm per pixel on a 13 m arena. No normal or roughness response.
- `src/render/arena/ambient.ts`: GPU stateless particles from seed + time. This is already the right pattern; generalise it for FX.
- `src/render/arena/arenaView.ts`:
  - `flame()` is 2 crossed planes + a core using a canvas gradient sprite, with sine flicker.
  - Real point lights are capped by `lightBudget = 7`.
  - `fireRing` is a cylinder with a canvas flame strip.
- `src/render/post.ts`:
  - The chain is RenderPass → GTAO (half-res, renders its own normal/depth) → Bokeh (renders its own depth when on) → god rays (also sanitises NaN) → UnrealBloom (half-res) → grade (CA, desat, flash, vignette) → Output.
  - No shared depth texture.
- `src/camera/director.ts`: owns hit-stop (`hitStopUntil`, 0.035–0.35 s), slow-mo, shake (`rig.addShake`), FOV punch and letterbox. It also uses `Math.random` (camera only).
- `src/render/fighterView.ts`:
  - `Trail`, `Telegraph` and the aura (canvas ring). Emissive glow pulses with `performance.now()`.
  - `castWorld()` and `strikePointsWorld()` exist.
  - `weaponTip` exists only for gorak and aldric (`public/models/*.json`).
- Sim events (`src/sim/types.ts EventType`) cover hits, blocks, parries, dodges, knockdowns, launches, finishers, props, destruction, hazards and drama.
  - `hit.data` = {dmg, move, kind, counter, heavy, fx, k}; it has no contact position. The renderer derives the position from chest / strike points.
- `tools/shots/perfprobe.cjs` + `__arena.bench(60)`: a frame-time breakdown harness that already exists. `tools/shots/fxshots.cjs`: finisher FX captures in the Animation Lab.
- `docs/arenas.md`: measured 13–19 ms per frame on the iGPU at high. Medium and low are within ~1 ms of each other, so the iGPU is **CPU/sync bound**. CPU work per frame in FX matters as much as GPU fill.

## 5. Sources

- [Unity Labs free VFX flipbooks](https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks)
- [Kenney Particle Pack](https://kenney.nl/assets/particle-pack), [Kenney Smoke Particles](https://kenney.nl/assets/smoke-particles)
- [Screaming Brain noise pack](https://opengameart.org/content/noise-texture-pack)
- [CGHEVEN licensing](https://cgheven.com/licensing/), [CGHEVEN VFX](https://cgheven.com/assets/vfx/)
- [ambientCG licence](https://docs.ambientcg.com/license/), [Poly Haven licence](https://polyhaven.com/license)
- [Sinestesia blood splatter 1](https://opengameart.org/content/animations-blood-splatter-1), [Blood, Hit and Both](https://opengameart.org/node/81933)
- [Texture Ninja (CG Channel)](https://www.cgchannel.com/2018/12/download-5000-free-texture-images-from-texture-ninja/)
- [Unity: Asset Store assets in other engines](https://support.unity.com/hc/en-us/articles/34387186019988-Can-I-use-assets-from-the-Asset-Store-with-other-engines)
- [OpenVAT](https://extensions.blender.org/add-ons/openvat/), [three-vat](https://github.com/manthrax/three-vat), [VAT Blender addon](https://extensions.blender.org/add-ons/vat/)
- [three.js forum: creating KTX2](https://discourse.threejs.org/t/how-to-create-ktx2-correctly/40963), [KTX-Software 4.3 notes](https://github.com/KhronosGroup/KTX-Software/releases/tag/v4.3.2)
- [Blender 5.0 news (NanoVDB smoke/fire)](https://alternativeto.net/news/2025/11/blender-5-0-launches-with-aces-color-enhanced-rendering-and-tighter-vfx-integration/)
