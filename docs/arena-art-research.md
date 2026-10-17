# Arena art redesign: raw research notes

Companion to `docs/arena-art-plan.md`. Written 2026-10-18 on branch `anim-plan` (read-only session: no source edits, no renders, no git). These are the raw notes; the plan holds the decisions.

## 1. Machine facts (measured this session)

| Item | Value | How |
|---|---|---|
| CPU | Intel Core Ultra 5 125H, 14 cores / 18 threads | `Get-CimInstance Win32_Processor` |
| GPU | Intel Arc Graphics (Meteor Lake iGPU, Xe-LPG, shares system RAM) | `Win32_VideoController` |
| RAM | 15.6 GB total, **6.1 GB free** at the time of the check (dev tools idle) | `Win32_OperatingSystem` |
| Blender | 5.0 (F2 used 5.0.1) at `C:\Program Files\Blender Foundation\Blender 5.0\blender.exe` | folder listing |
| Previous Blender peaks (F2 bakes) | EEVEE 256 px volume frames: about 1.4 GB peak. Cycles CPU 256 px volume frame: 11-17 s, about 0.45 GB | `docs/milestones/F2/README.md`, `docs/fx-pipeline.md` |
| Scene pass today | 6.8 ms GPU at 1920x1080 high, colosseum (timer query). Whole frame 17-22 ms GPU | `docs/milestones/F1/README.md` |
| GPU timer queries | `EXT_disjoint_timer_query_webgl2` works on the Arc driver | F1 README |
| MSAA 4x | +3.3 ms on the opaque pass: not affordable | F1 README |
| Arena build time | 3-6 s (CPU texture generation in `textures.ts`) | `docs/BACKLOG.md` known issues |
| Shipped page | `public/models` 18 MB, `public/anim` 8.6 MB, `public/audio` 7.1 MB, `public/fx` 4.4 MB, `dist` 40 MB | `du -sh` |
| Tooling already present | `@gltf-transform/cli` 4.1.1 (devDependency), three r170 `meshopt_decoder.module.js`, `libs/basis/basis_transcoder.*`, `ktx-parse` | `node_modules` listing |
| KTX encoder | `gltf-transform uastc/etc1s` need **KTX-Software** (`ktx` CLI). A0: KTX-Software 5.0.0-rc2 is now installed, but gltf-transform 4.x fails with it (`--assign-oetf` renamed); `ktx create` works directly | `npx gltf-transform uastc -h`, A0 `ktx_probe` |
| Assets already downloaded | `Assets/fx/*` (21 Unity Labs flipbook zips), `Assets/VFX/` (Kenney particle pack, SBS noise 128 + 512). No PBR surfaces, HDRIs or 3D kits yet | folder listing |

## 2. Concept art files

| File | Size | Aspect | Notes |
|---|---|---|---|
| `ref-3.png` | 1793x877 | 2.04:1 (wider than the rest) | only image without an opponent; one fighter crouched, low cam |
| `ref-4.png` | 1665x944 | 1.76 | has a fighting-game HUD (blue/red bars, round "4") baked in |
| `ref-5.png` .. `ref-10.png` | 1672x940/941 | 1.78 | over-the-shoulder duel framing |
| `title-bg-godsring.png` | 1672x941 | 1.78 | top-down arena view from the gods' balcony |
| `ui-select-screen.png` | 1672x941 | 1.78 | shows the 7 current theme cards (Gilded Colosseum ... Sunset Ruins) |

The concept images are painterly AI images: light is physically inconsistent (dozens of fires, every surface specular, moon and sun-like rim at the same time). "As close as possible" therefore means the same composition, palette, landmark silhouettes, material language and density of dressing, not a physically identical render.

## 3. Existing code: facts the plan depends on

- `src/sim/arenaGen.ts`: `ThemeId` = 7 ids; `THEME_RULES` (cover kind, size, props, hazards, river); `generateArena()` seeds its RNG with `hash(theme|layout|seed)`, so adding a theme does not change other themes' layouts. `arenaForSeed()` picks `THEMES[floor(r * THEMES.length)]`, so **changing the length of `THEMES` changes the default arena of every match seed**.
- Gates are always on the x axis (`makeGate` angle 0 / pi). Fighters start at x = +-5. The "face-off" camera therefore looks along +-x, which is where the concept-art landmark must sit.
- `src/sim/world.ts` `TOP` heights (crate 0.9, barrel 1.0, urn 0.7, rock 0.75, keg 1.0, brazier 1.2, lantern 1.6, chunk 0.6) and `FRAGILE`. Prop radii in `PROP_BASE` (crate 0.45, barrel 0.4, urn 0.32, rock 0.4, keg 0.4, brazier 0.45, lantern 0.35). `applyFrame()` carry offsets: urn 0.36, crate 0.41, others 0.45.
- `src/sim/match.ts:1348`: the finisher fx is `'shatter'` when `theme === 'glacier'` (ice). Keep the glacier id icy enough for that to read.
- Theme-keyed tables outside the arena folder: `src/render/fx/fxLook.ts` `THEME_LOOK`, `src/render/fx/fxSurfaces.ts` `THEME_FLOOR`, `tools/shots/postprobe.cjs`, `tools/shots/f1lab.cjs`, `docs/milestones/F3/moments.txt`, `src/ui/ui.ts` (theme cards). Renaming ids would touch all of them; renaming display names touches only `themes.ts`.
- `src/render/arena/arenaView.ts`: `Arena.flame()` with the `Arena.fxFlame` hook (F3 flipbook); `lightBudget = 7`; `mergeStatic()` merges direct children by material; `standing()` visual radius factors per kind; `hangingNow()` hard-codes chandelier y 6.2.
- `src/main.ts:183-219` `ensureArena`: builds `camWorld` (obstacles, hanging, boundR, wallH) and the LOS raycaster from `rayProxies(camSolids(arena.group, sky))`.
- `src/camera/cameraAudit.ts` `solids()`/`rayProxies()` and `src/cinematic/entrance.ts:97` `snapAnchors` **skip `InstancedMesh`** and `userData.dyn` objects. Anything the kit instances is invisible to camera line of sight and to entrance anchor snapping unless proxies are supplied.
- Entrances: `GateAnchors` (barrier kind, tunnel, perches, rims, stands, lowWall, pieces) published by each gate builder; validator `__arena.validateEntrances({})` = 638/638 clean today (7 themes x 5 layouts x 2 gates x variants).
- `src/cinematic/reveal.ts`: crane path from the generated layout, starts opposite the sun.
- FX interface promised to the arena session (`docs/fx-plan.md` 3.10): soft-particle material + shared depth (done, F1); `fx.flame(at, size, palette, {light})`; card helpers `glowPool`, `reflectionStreak`; decal batch + `surfaceAt(x,z)`; reflections must include `FX_ADD`; per-tier flame light budget 4/2/1.
- F1 layers: `0 WORLD`, `20 FX_ADD`, `21 FX_ALPHA`, `22 FX_DIST`, `23 FX_GHOST`. Post pipeline in `src/render/post.ts` (scene -> depth copy -> AO -> FX -> dist -> rays -> dof -> bloom -> final). No EffectComposer.
- F2 Blender helpers to reuse: `tools/fx/blender/fxbake.py` (args, dry run, peak RAM via `GetProcessMemoryInfo`, free-RAM guard `--min-free-mb`, EXR output), `tools/fx/bake_all.sh` (sequential, retry once).

## 4. Blender 5.0 changes that matter (release notes, developer.blender.org)

Sources: https://developer.blender.org/docs/release_notes/5.0/python_api/ , .../5.0/cycles/ , .../5.0/eevee/ , .../5.0/geometry_nodes/ , .../5.0/pipeline_io/ (fetched 2026-10-18).

| Area | Change | Impact on our scripts |
|---|---|---|
| Engine id | `BLENDER_EEVEE_NEXT` -> `BLENDER_EEVEE` | F2 scripts already use `BLENDER_EEVEE` |
| EEVEE AO | `scene.eevee.gtao_distance` -> `view_layer.eevee.ambient_occlusion_distance`; `use_gtao`, `gtao_quality` removed | do not set them |
| Image output | `ImageFormatSettings.media_type` must be set **before** `file_format` | every save helper |
| Render passes | pass names changed (`Z` -> `Depth`, `IndexMA` -> `Material Index`) | panorama depth pass lookup by new name |
| Compositor | `scene.node_tree` removed -> `scene.compositing_node_group` (create with `bpy.data.node_groups.new(..., "CompositorNodeTree")`); File Output node: `file_slots`/`base_path` removed -> `directory`, `file_name`, `file_output_items`; RGBA socket renamed `Color` | multilayer/AOV output code must use the new API |
| Shader nodes | Sky Texture inputs `sun_direction`, `turbidity`, `ground_albedo` removed; Point Density removed | build skies from our own gradient/HDRI, not the Sky node's old inputs |
| Animation | legacy Action API removed (`action.fcurves`, `action.groups`) -> channelbags (`bpy_extras.anim_utils.action_ensure_channelbag_for_slot`) | **posing statues from fighter clips** must read keys through channelbags, or just set pose bones from our own JSON clips |
| Properties | `scene['cycles']` dict access gone | use `scene.cycles.*` |
| Booleans | solver "FAST" renamed "FLOAT" | damage/boolean cuts |
| Cycles volumes | new unbiased null-scattering default (no step size); "Biased" option restores old behaviour; may be slower | fog layers in panoramas: test both |
| Cycles tiling | "Use Tiling" removed, always on; set a tile size | memory control via `scene.cycles.tile_size` |
| Cycles subdivision | adaptive subdivision no longer experimental; object-space edge length option | high-poly sculpt-like detail via adaptive displacement at render/bake time |
| Cycles normal map | with displacement, Normal Map node uses undisplaced normal/tangent | baking displaced high-polys: bake from real geometry, not render-time displacement |
| GPU | min CUDA sm_50; AMD driver bump; nothing for Intel listed | see oneAPI note below |
| EEVEE | light-probe volume back-face option fixed; curves `resolution` attribute now used (hair 15x heavier); HDR output unclamped | avoid curves for foliage cards; use meshes |
| Geometry nodes | Bundles, Closures, Volume Grid sockets (Mesh to SDF Grid, SDF Boolean, Grid to Mesh, fillet/offset filters), UV Tangent node, String to Value, Pack UV Islands "Shape Method", Random Value output changed | SDF grid booleans + fillet = cheap "sculpted erosion" for masonry; Random Value seeds give different results than 4.x (keep our own seeds) |
| glTF | only maintenance (`use_nodes` removal); no meshopt/KTX in the exporter | compress with gltf-transform after export |
| Images | WebP wide-gamut writing | not needed |
| Blend files | compression on save by default | we keep no .blend files anyway |

**A0 probe results (2026-10-18, `docs/milestones/A0/README.md`):** oneAPI works on the Meteor Lake Arc iGPU (no env var needed, 3-4x faster than the CPU, identical output); EEVEE has no panoramic camera; the selected-to-active bake API is unchanged; the Sky Texture node in 5.0.1 still has `sun_direction` / `turbidity` / `ground_albedo` (the row above is wrong for 5.0.1); GN `Grid to Mesh` needs Threshold 0 for SDF grids.

Not verified (must be probed in A0):
- **Cycles oneAPI on this iGPU.** The 5.2 manual lists only Arc A-series and B-series (Xe-HPG) as supported oneAPI devices. 2022 dev notes say integrated GPUs "could run it" behind `CYCLES_ONEAPI_ALL_DEVICES=1`. Meteor Lake (Xe-LPG) is not listed. Plan on **CPU Cycles**; treat GPU as a bonus if the probe shows it. Also the iGPU shares RAM, so GPU rendering would not relieve memory.
- **EEVEE panoramic cameras.** Not confirmed in any 4.2/5.0 note found. Plan uses Cycles for panoramas and an EEVEE fallback that renders perspective slices onto a cylinder.
- **Bake API unchanged in 5.0?** Not mentioned in the Python API notes excerpt. A0 runs a 256 px normal + AO bake as a probe.
- Built-in extensions availability offline (Cell Fracture, Sapling Tree Gen are extensions since 4.2, not bundled): plan does not rely on them; fracture and trees are scripted.

## 5. Free asset sources (licences checked on the source pages, 2026-10-18)

| Source | Licence (verified) | What is useful here | Notes |
|---|---|---|---|
| Poly Haven (polyhaven.com/license) | CC0, no attribution, commercial OK, redistribution OK | scanned PBR textures (floor, walls, bark, mud, metal), HDRIs (night, moon, dusk, overcast, pure skies), scanned models (rocks, cliffs, roots, dead trunks, gothic statue, iron gate, castle door, fire pit, caged light, lantern chandelier, barrels) | **Public JSON API** `https://api.polyhaven.com/assets?t=textures|hdris|models`, files via `https://api.polyhaven.com/files/<id>` (direct `dl.polyhaven.org` URLs). Agents can fetch by script; no owner action needed. 869 textures, 521 models listed today |
| ambientCG (docs.ambientcg.com/license) | CC0 1.0, no attribution, commercial OK, raw files may ship in a game | surfaces: `PavingStones*`, `Ground*` (mud, leaves), `Rock*`, `Moss001-004`, `Bark001-015`, `Planks*`, `Metal*`, `Fabric*`; HDRIs | API `https://ambientcg.com/api/v2/full_json?type=Material&q=<q>`. Owner found its decals useless: surfaces and HDRIs only |
| Quaternius (quaternius.com, e.g. Ultimate Modular Ruins, 90 models) | CC0 (stated on the pack page) | blockout / layout proxies only | stylised low-poly: wrong look for the final art |
| Kenney (kenney.nl) | CC0 (verified in fx-research) | already used for FX sprites; no realistic environment kit | not useful for the arena look |
| Smithsonian 3D Open Access (3d.si.edu) | CC0 **only on items marked CC0**; others need permission | optional: scanned sculptures as statue bases (busts, figures) | per-item check needed |
| Unity Labs flipbooks (already in `Assets/fx`) | CC0 | fire, smoke, cloud cards for F4 | shipped by F2 |

Relevant Poly Haven ids found by the API query (polycount in brackets where it matters):
- Floors: `monastery_stone_floor`, `stone_tiles_02`, `slate_floor_02`, `rock_tile_floor`, `cobblestone_large_01`, `castle_brick_broken_06`, `volcanic_rock_tiles`, `mossy_cobblestone`, `grey_stone_path`, `snow_floor`.
- Walls / masonry: `castle_brick_01`, `castle_brick_07`, `castle_wall_slates`, `castle_wall_varriation`, `stone_block_wall`, `old_stone_wall`, `japanese_stone_wall`, `rustic_stone_wall`, `mossy_stone_wall`, `large_sandstone_blocks`.
- Ground: `brown_mud_rocks_01`, `brown_mud_leaves_01`, `muddy_tracks`, `forest_leaves_02/03/04`, `forest_floor`, `burned_ground_01`, `dark_rock`.
- Wood / metal: `medieval_wood`, `wooden_rough_planks`, `rough_wood`, `rusty_metal_02..05`, `metal_grate_rusty`, `japanese_cedar_bark`, `bark_brown_02`.
- Models: `gothic_statue` (27.7k), `large_iron_gate` (38k), `large_castle_door` (12.6k), `stone_fire_pit` (3.9k), `caged_hanging_light` (22.9k), `lantern_chandelier_01` (6k), `Lantern_01` (34k), `brass_candleholders` (42k), `Barrel_01` (2.7k), `wooden_barrel` texture, `treasure_chest` (103k), `bull_head` (17k), `root_cluster_01/02` (225k/340k), `single_root`, `dead_tree_trunk` (102k), `dead_tree_trunk_02`, `tree_stump_01/02`, `rock_moss_set_01/02` (60k), `boulder_01` (124k), `namaqualand_cliff_01/02`, `coastal_cliff_01..04` (0.9-2.9M), `mountainside`, `island_tree_01..03` (1.8-4.8M), `jacaranda_tree`, `fern_02`, `moss_01`, `kite_shield`, `ornate_medieval_mace`, `antique_katana_01`.
- HDRIs (night): `rogland_moonlit_night`, `qwantani_moonrise(_puresky)`, `qwantani_night(_puresky)`, `kloppenheim_02(_puresky)`, `moonlit_golf`, `narrow_moonlit_road`, `satara_night_no_lamps`; (dusk/storm/overcast) `kloppenheim_07_puresky`, `approaching_storm`, `wasteland_clouds_puresky`, `qwantani_sunset_puresky`, `belfast_sunset_puresky`, `snow_field_puresky`, `kloofendal_misty_morning_puresky`, `autumn_forest_04`.

Heavy scans (over 1M polys) are for **offline backdrop renders only** (Cycles instancing keeps memory sane); never ship them.

## 6. Texture compression and loaders

- three r170 ships `KTX2Loader` (Basis transcoder in `examples/jsm/libs/basis`, workers) and `MeshoptDecoder` (`examples/jsm/libs/meshopt_decoder.module.js`).
- `gltf-transform` 4.1.1 CLI: `meshopt`, `simplify`, `resize`, `webp`, `etc1s`, `uastc`, `optimize`. `etc1s`/`uastc` depend on KTX-Software (its help text says so). Version requirement not verified; install the current KTX-Software release.
- Arc iGPU through ANGLE D3D11 exposes BC formats (S3TC/BPTC); Basis transcodes UASTC to BC7 and ETC1S to BC1/BC3/BC7. GPU memory: BC7 1 B/px, BC1 0.5 B/px vs 4 B/px for WebP/PNG (+33% mips in every case).

## 7. Real-time technique notes (Three.js r170, WebGL2, Arc iGPU)

- The arena floor is **one plane at y = 0** (the sim is flat 2D). A planar reflection is exact for it and cheaper than SSR (no ray marching, no missing off-screen data: the moon and landmark are often above the frame top in the low hero camera). three's `Reflector` re-renders the whole scene; a custom variant that renders only a `REFLECT` layer (backdrop, sky, big silhouettes, flame cards, fighters on high) into a quarter/half-res target with mips is the cheap version. Roughness blur = `textureLod` on the mip chain, distorted by the floor normal map.
- SSR-lite on top of the F1 shared depth would add contact reflections of fighters' feet; not worth the cost on the iGPU (each ray march about 16 taps at half res).
- Baked cube probe + box projection is the low-tier fallback; reflection streak cards (FX plan 2.5) fake the long fire streaks.
- Many lights: the forward renderer recompiles shaders when the light count changes, so the number of real `PointLight`s per tier must stay fixed (FX plan: 4/2/1 arena + 3/2/1 FX pool). Everything else: emissive + bloom, glow cards, floor light-pool cards, and a load-time GPU-accumulated **floor light map** (sum of all brazier falloffs rendered once into a top-down texture).
- `renderer.compileAsync(scene, camera)` exists in r170 (uses `KHR_parallel_shader_compile` when present) to pre-warm shaders behind the reveal.
- Vertex-shader cloth sway (banners) and catenary chains are CPU-free; `InstancedMesh` for chain links, candles, rubble, palisade stakes.

## 8. Concept image measurements (by eye on the PNGs, normalised 0..1 from the top-left)

| Image | Horizon y | Est. camera height | Est. horizontal FOV | Key light direction (screen) | Landmark centre x | Fires visible |
|---|---|---|---|---|---|---|
| ref-3 | 0.64 | 0.9-1.1 m | ~80 deg (2.04:1) | moon behind the arch, top-right of centre (x 0.68, y 0.05) | 0.70 | 9-11 braziers + floor fires |
| ref-4 | 0.50 | 1.7 m | ~68 deg | sky overcast, lava glow from the back right | 0.62 (castle) | 7 braziers + lava falls |
| ref-5 | 0.55 | 1.9 m (looks down onto the ring) | ~70 deg | low sun right of centre (x 0.72, y 0.16), backlight | 0.25 (Buddha) / 0.55 (floating peaks) | 0 fires; 4 glowing lanterns |
| ref-6 | 0.58 | 1.4 m | ~70 deg | overcast sky, warm braziers everywhere | 0.63 (skull gate) | 12+ braziers |
| ref-7 | 0.58 | 1.6 m | ~70 deg | sun behind clouds top-right, cool fill | 0.55 (castle) | 8 braziers |
| ref-8 | 0.57 | 1.2 m, slight dutch tilt | ~75 deg | violet sky glow + rune portal top-right; candles everywhere | 0.70 (cathedral) | 4 braziers + 40+ candles |
| ref-9 | 0.62 | 1.3 m | ~75 deg | huge moon right (x 0.78, y 0.15) | 0.38 (goddess) / 0.85 (castle) | 5 braziers + candles |
| ref-10 | 0.62 | 1.5 m | ~70 deg | sun shafts top-right through canopy | 0.50 (tree-city) | 8 braziers + 15 candles + 6 hanging lanterns |

Fighters in the duel images: the foreground fighter (back to camera) fills the right 25-35% of the frame, cropped at the hips; the opponent stands 6-9 m away near the centre, about 30-40% of frame height tall.
