# Arena Gods: Backlog and Status

Living document. Everything built, in progress, planned or only an idea, so nothing gets forgotten.
Last updated: 2026-10-16. Repo: https://github.com/DARK-Shadw/arena-gods (private).

Status key: DONE | IN PROGRESS | PLANNED | IDEA | ISSUE (known problem)

---

## 0. Vision and decisions (don't lose these)
- **Concept:** spectator-first "gods watching AI gladiators". Players are gods: they bet on fighters and nudge fights with limited, risky powers (boost, heal, debuff). Browser game; players open the site and watch a live match with other gods. Win bets for EXP, god rank and currency that buys more influence. Inspired by Omniscient Reader. Fights must feel like a cinema; every match unique.
- **Big vision (read `docs/vision.md`):** a living world of persistent champions with memory, rivalries, lineage/revenge heirs and an evolutionary "Judgement"; matches are real sims with visuals. Staged: persistent roster in browser, offline evolution of founders, then server/live room, then dynasties and narrative layer.
- **Pillars:** the fight must be fun to watch (legibility, drama curve, personality); animation and characters must feel real; strong auto-director camera.
- **Betting:** play currency only, never real money (gambling law). Earned by winning, never bought.
- **Finishers/gore:** finishers are Mortal-Kombat-style. Gore setting off / standard / full, DEFAULT = standard (ON: Elden-Ring-like blood, severing finishers shown). Owner decision 2026-10-17; supersedes the earlier "default off". One constant: `GORE_DEFAULT` in `src/render/fx/fxSettings.ts`; storage key `arena.gore.v2`; `off` stays selectable in the menu.
- **Sim is authoritative and deterministic:** the same seed gives the same fight in Node and in the browser (custom `dmath`). Animation and cosmetics must never change sim results.
- **Test with real people early.** The user has made 10+ demos nobody played; a shareable build and friend playtests are part of the plan.
- **Tooling:** the user has Blender 5.0 installed (C:\Program Files\Blender Foundation\Blender 5.0), Piper and Chatterbox/OmniVoice/F5/Orpheus TTS in tts-lab, ffmpeg. The user prefers Opus for the heavy build work.

---

## 1. DONE (as of 2026-10-17)
- Deterministic seeded fight sim with drama engine (momentum swings, comebacks, anti-stall). 8 fighters with personalities. Balance stats: ~67 s fights, win rates ~45-55%, no timeouts.
- AI v1 (Round A): doctrines/roles, goals, opponent modelling by counts, retreat/kite/bait/punish, feints, counters. 84 moves.
- Hit-contact fix and phantom-hit audit (reach data from real clips).
- Mixamo model and animation pipeline (FBX to GLB, AnimationMixer), 8 fighters on real models.
- Procedural arena generator (7 themes, 5 layouts), destructible/toppling cover, throwables, hazards, powder kegs, AI using the arena, arena reveal shot.
- Auto-director camera, entrance cinematics (to be reworked), killcam slow-mo.
- Real SFX/music from packs, mixing, volume menu; subtitled dialogue system (OLD synth-quality TTS, to be replaced).
- Determinism fix (engine math differences Node vs Chromium).
- GitHub repo + animation research/plan/catalog (branch `anim-plan`).
- **Animation overhaul M0 to M4** (branch `anim-plan`, not merged to main yet). Milestone docs are in `docs/milestones/M0..M4`; deviations from the plan are in `docs/animation-plan.md` §K.
  - Shared animation library and Animation Lab.
  - Pose pipeline: inertialization, spring flinch with hit-stop, locomotion sync groups, foot-lock IK.
  - Sim-chosen reaction, fall, get-up, death and dodge variety; launches and knockback.
  - Arena-aware entrances for all 8 fighters. The validator reports 638/638 clean on every theme × layout × gate.
  - 8 finishers (Rock'n Shackle replaced by Immolation). Paired contacts all within 0.12 m, using the contact warp and limb IK.
  - Finisher FX: bisect, behead, burn, shatter, dissolve, drain. Gore setting off/standard/full (standard was called stylised), default standard since 2026-10-17.
  - Camera: shot scoring with real line of sight, contact-aware re-picks, finisher track and cut-in, launch follow, killcam side choice, headless readability audit, `?t=` / B-key repro URLs.

- **FX overhaul F0 (foundation)**, on branch `anim-plan`; details in `docs/milestones/F0/README.md`, API in `docs/fx-api.md`.
  - FX director fed by the sim event stream, with effects as data (`src/render/fx/fxDefs.ts`, 57 defs).
  - Stateless GPU particles: reproducible from (seed, time), scrubbable, and a `?t=` load gives an identical FX state.
  - Seeded randomness, with no `Math.random`, `setTimeout` or `performance.now` on FX paths.
  - The old `vfx` API is kept as a facade.
  - Shockwave, debris, arrow and projectile leaks fixed.
  - `npm run fx:check`; `tools/shots/fxprobe.cjs` measures before/after.
  - Gore default switched ON (`standard`) right after F0, on the owner's decision. Severing finishers now show by default; combat blood comes with F3.

- **Arena art redesign A0 (harness and Blender probes)**, on branch `anim-plan`; details, real numbers and plan corrections in `docs/milestones/A0/README.md`, plan `docs/arena-art-plan.md`.
  - Concept-match harness: calibrated camera presets per concept image (`src/render/arena/conceptCams.ts`, `?concept=ref-3`), `npm run arena:concept` (headless renders at the concept size + side-by-side, blend, sky masks, metrics C1-C5/C8, contact sheet), annotations + solver (`tools/arena/concept_targets.json`, `calibrate.py`). Baseline of the current 7 themes in `docs/milestones/A0/concept/` (nothing passes yet, as expected).
  - Blender job runner `npm run arena:bake -- <job|group>` (one Blender per job, resumable, RAM watchdog that suspends / resumes / kills, `ram.csv`), shared bpy module `tools/arena/blender/abake.py`, probes.
  - Measured: Cycles **oneAPI works on the Arc iGPU** (3-4x faster, up to 5.7 GB RAM); the 8192x1365 panorama layer takes 13.6 min CPU / about 3.5 min GPU; 1024 bakes take seconds; EEVEE has no panoramic camera; whole arena plan about 10-15 h of CPU Blender time (was guessed 30-40 h).

- **Arena art redesign A1 (asset pipeline, loader, data-driven dressing skeleton)**, on branch `anim-plan`; details in `docs/milestones/A1/README.md`.
  - Pipeline: `npm run arena:fetch` (CC0 from Poly Haven / ambientCG into `Assets/arena-src`, ledger `public/arena/credits.json`) -> Blender kit job (`npm run arena:bake -- kit`) -> `npm run arena:assets` (meshopt, KTX2 via `ktx create` with the log checked, WebP via Pillow, `.low` tier files, `public/arena/manifest.json`) -> `npm run arena:budget` (measures the GLBs against the sim's `PROP_BASE` / `TOP` and the plan budgets).
  - Runtime: `src/render/arena/assets.ts` (loader, cache, KTX2 -> WebP fallback, prefetch, dispose), `art/` (`ThemeArt`), `dressKit.ts` skeleton, async `ensureArena`; `?arena=legacy` keeps the old procedural path (pixel-identical to before), `?arenatex=webp` forces the fallback files.
  - First kit asset: the tripod brazier (forge braziers), exactly r 0.45 / top 1.2, LOD1 on low; checked in game on all tiers and both formats (`tools/arena/check_load.cjs`).

- **Arena art redesign A2 (wet floor system)**, on branch `anim-plan`; details in `docs/milestones/A2/README.md`.
  - Blender (Cycles on the Arc iGPU): two floor texture sets from CC0 scans (blue-grey flagstone from Poly Haven `large_grey_tiles`, slate slabs from `stone_tiles`) with graded albedo, added cracks, 3x3-tile AO bake and a water-rank mask; the Moon Gate engraved ring inlay (4 rings + 40-rune band + spokes + crescents, 16 m, baked normal + AO). Texture sets ship as carrier GLBs (role `texset`, checked by `arena:budget`).
  - Runtime: `floor.ts` (wet floor shader on MeshStandardMaterial: world tiling, seeded macro puddle mask, puddles fill the scan's hollows, inlay grooves hold water, wet darkening / gloss), `reflection.ts` (planar reflection on medium / high with a cropped frustum, roughness mips, normal distortion, vertical streak taps, half-rate refresh; streak cards for fires and the moon path), `lightmap.ts` (warm pools of flames without real lights), `post.ts` `preScene` hook (timer `reflect`), `Arena.surfaceAt(x, z)`.
  - Colosseum in kit mode gets the floor + a Moon Gate night preview look + 10 decorative braziers (`?moongate=0` drops the preview, `?floorset=slate_slabs` swaps the set, `?refl=0` turns the planar pass off). `?arena=legacy` is pixel-identical to before.

- **FX overhaul F3 (everyday combat, blood, full replay)**, on branch `anim-plan`; details, measurements and filmstrips in `docs/milestones/F3/README.md`.
  - The atlases load in the game (tier-aware); flipbook and Kenney-sprite particles are part of the director; arena braziers / torches use the Unity flame flipbooks; the keg explosion uses the Unity explosion flipbooks.
  - Impacts by weapon class and body surface (sparks on Aldric's plate, mist and fibres on flesh, hair on Fenrik, pulp on Hollowjack), heavy-hit shockwave (dust ring, chips, crack decal), block sparks, Aldric's shield ring, parry flare, guard break, dodge dust + afterimages, knockdown / landing dust, footsteps by floor surface.
  - Weapon trails v2 per weapon (FX-owned ribbons on sim time, frame-rate independent, air distortion on heavies); FX light pool (3 / 2 / 1 slots).
  - Blood at gore standard (default): sprays, floor splats and drops, pools under the dead, wounds on bodies, blood on blades; off / full work. Persistent lit floor decals, seeded, capped 64 / 128 / 256.
  - `?t=` / `debugSeekFight` now replays the whole fight's decals and wounds and the last 6 s of effects: identical to a play-through (`npm run fx:check`).
  - Measured: FX pass 0.06-0.10 ms GPU, FX CPU 0.13-0.16 ms per fight frame (budget 2.0 / 0.6).

- **FX overhaul F2 (asset pipeline, atlases, FX Lab)**, on branch `anim-plan`; details in `docs/milestones/F2/README.md`, formats in `docs/fx-pipeline.md`.
  - Headless Blender 5.0 bake scripts (`tools/fx/blender/`): fire loop, fire burst, explosion, smoke wisp (relightable), dust puff and ring (relightable), splash, blood spray, embers, energy swirl. Each one dry-runs first and logs its peak RAM.
  - Atlas pipeline (`tools/fx/`): packer with motion vectors, pack ingestion, procedural decals, optional KTX2 encode, budget check and licence ledger (`public/fx/CREDITS.md`).
  - Ingested: Unity Labs flipbooks (9 of 22 packs shipped), Kenney Particle Pack (64 sprite masks) and Screaming Brain noise.
  - FX Lab at `/tools/fxlab/`: every F0 def, every atlas, a brazier composite and every catalog row.

- **FX overhaul F1 (shared depth, soft particles, distortion, bloom / grade, tiers)**, on branch `anim-plan`; details and measurements in `docs/milestones/F1/README.md`.
  - `src/render/post.ts` rewritten without EffectComposer: one scene target with a shared `DepthTexture`, used by GTAO (no second scene render), Bokeh, soft particles and distortion; dual-filter bloom; one final pass for grade + tone map.
  - Soft particles (per-primitive fade distance, overridable per def); heat shimmer and shock ripples as data (`heat` / `ripple` ops) on explosions, fire hits, heavy hits, kills, ultimates and the ring of fire.
  - Per-theme F1 look (`src/render/fx/fxLook.ts`): soft-knee bloom, split toning, black crush; grade presets (`post.setPreset` / `kickPreset`) and a vignette kick for F7.
  - Measured with GPU timer queries on the Arc iGPU: post cost minus the scene pass 7.7 -> 4.2 ms on high, 3.6 -> 2.0 on medium; the low tier renders at 0.75 scale and its whole frame went 16.5 -> 11.1 ms GPU. MSAA measured at +3.3 ms and left off.
  - FX Lab: post on by default, 'F1 tests' items (soft vs hard, brazier heat shimmer, ripples, bloom and grade presets) and A/B switches.

- **Arena A3 shared stone kit**, on branch `anim-plan`; details in `docs/milestones/A3/README.md`. Stone trim sheet (2048, 6 rows: ashlar, blocks, moulding, rune frieze, rough, plain; seamless), hero obstacles with weathered high -> low bakes (square masonry pillar with 9-slice SHAFT + FRAC slices, fluted ruin column, rubble pile), 11 trim-sheet modules (walls intact / broken, arcade bays intact / ruined, gate arch, stairs, plinth, dais, balustrade, spear fence) with vertex AO, scan rocks from Poly Haven (rock prop fitted to the sim contract, rubble scatter). Kit-mode colosseum now uses kit pillars / columns / rubble piles for its obstacles, kit walls for the podium, ruined arcade bays for the gallery (one merged draw call), rubble at the wall feet, re-tinted legacy stands / gate; `?kitstone=0` = A2b look; `?arena=legacy` pixel-identical. Kit gallery page `tools/arena/gallery/` (+ `check_gallery.cjs`). Sim untouched.
- **Arena A4 shared dressing kit**, on branch `anim-plan`; details in `docs/milestones/A4/README.md`. Generic Blender pipeline `dresskit.py` + 23 pieces (pedestal / wall / pillar-top braziers, toro / cage / paper lanterns, candles, bell, skull, bone pile, stakes, spike grate, chain weight, fire-jet vent, crumbling floor, chain links, banner pole, barricade, crate / barrel / urn / keg / chunk with FRAC pieces fitted to `PROP_BASE` / `TOP`) and banners (cloth-sim drapes + 8-sigil tattered atlas with tear masks in alpha). Runtime: vertex-shader banner sway (`cloth.ts`) and instanced swinging chains (`chains.ts`), 0.0004 ms CPU per frame; kit mode replaces the A2b placeholders (banner pole, barricade, chain weight, vent, crumble, spike grate) and the colosseum's wall banners / wall braziers, adds wall-foot candles / skulls / bones and pedestal braziers. `?arena=legacy` pixel-identical; sim untouched.
- **Sim milestone A2b (bigger arenas + more interactables)**, on branch `anim-plan`; details in `docs/milestones/A2b/README.md`. Arenas +35 % (`ARENA_SCALE`), ring of fire closes to the old absolute size; 12-16 props per arena nearer the fight; new features (toppling banner poles, shattering barricades), braziers that tip and spill burning oil, hanging chain weights that swing, fire-jet vents, collapsing floor / edges that leave pits, per-theme hazard rows (`THEME_RULES.extras` / `features`); AI grabs props about 3x as often (`ENV_AI` knobs) and tips braziers / swings chains at the opponent; per-fight counters in `sim:test` (finishers, pickups, throws, hazard kills, interactable triggers). New sim baseline in the README. Visuals are placeholders until the A3-A5 kit.

## 2. IN PROGRESS
- **Animation overhaul review:** the owner plays `anim-plan` and judges the feel, then it is merged to main. Repro URLs are in `docs/milestones/M4/README.md`.
- **Voice cloning** (`tts-final/`): 68 of 227 lines generated. Resume (run in a normal terminal, ~2.5-3.5 h):
  `C:\Programming\FunBuilds\FunnyGuyInPc\tts-lab\envs\chatterbox\Scripts\python.exe -I C:\Programming\GameDev\Research\tts-final\scripts\run.py`

---

## 3. PLANNED (decided, not started)
### Animation plan remainder (docs/animation-plan.md)
- M5 attack variants and travelling moves; M6 talking/look-at/face-off/outros (gestures synced to voice lines); M7 personality profiles + first 6 new characters (Knight, Warrok, Nightshade, Uriel, Skeletonzombie, Kachujin); M8 spells + environment animations; M9 polish.
- 19 new characters downloaded in `Assets/Models_HF` (Knight_D_Pelegrini, Castle_Guard_01/02, Warrok, Demon_T_Wiezzorek, Goblin_D_Shareyko, Skeletonzombie, Uriel, Nightshade, Ganfaul, Akai_E_Espiritu, Kachujin, Heraklios, Parasite, Whiteclown, Medea, Eve, Pirate, Prisoner); each needs a weapon attached in code, moveset, entrance, finisher.
- Remaining 12 finisher concepts of the 20 (the plan lists all 20), more death/greatsword variants.
- Freeze-frame "anime" cinematic beats (parry, rage, near-death, finisher start), dialogue during them.

### Visual and content upgrades the user asked for
1. **FX session (dedicated):** better flame, sparks, hit effects, slash arcs, shockwaves, ribbon trails, soft particles, distortion, decals; Blender can bake fire/smoke/explosion flipbooks. Must precede magic.
2. **Magic system overhaul:** the ProMagic pack (56 clips) is underused. Schools: fire, ice, lightning, arcane, shadow/necro, nature, holy, blood, wind, gravity, summons; handcrafted shader VFX per school matching the character art style; spell VFX synced to cast/charge/release frames and the correct hand; different skins/schools per run.
3. **Procedural/modular character system:** not just 8 fixed characters. Per-run personality + combat style + visuals (palette/outfit tints, modular armor/weapon parts), random mage powers each run, more humanoids (user's favourite: knights). Any humanoid mesh can be uploaded to Mixamo auto-rigger for the same skeleton and all ~2,300 animations.
4. **Arena art upgrade** (now planned in `docs/arena-art-plan.md`, milestones A0-A22; A0, A1, A2, the sim milestone A2b (bigger arenas + interactables), A3 (shared stone kit) and A4 (shared dressing kit) done; next A5 statues and fracture) **(TARGET LOOK = `docs/concept-art/ref-3..10.png`, the user's concept art; treat as the art bible):** one shared kit across themes: wet, cracked, reflective stone floor with an inlaid ritual circle; torch braziers and candles as warm light sources; tattered red/black banners with a sigil; hanging chains; hooded statues; a huge landmark at the back (moon + giant arch, horned skull gate, Buddha + floating islands, gothic castle, jungle tree-city); layered fog, waterfalls and floating rock islands in the distance; embers and fallen leaves; strong warm-vs-cool colour split; low hero-camera angle with a foreground fighter silhouette. Themes seen: ruined moonlit coliseum, lava castle, floating-temple/zen, orc war-pit with mud, knight cathedral, wizard floating-castle with candles, night statue/moon, jungle tree-city. Plan: build the shared kit (floor material with wet PBR + planar/SSR-lite reflection, brazier+banner+chain+statue modules, fog cards, backdrop billboards/skydome painted per theme) then per-theme landmark; keep destruction system. Original note: use real art, not only code-built geometry. Poly Haven / ambientCG CC0 PBR textures and HDRIs, CC0 modular fantasy kits (Quaternius, Kenney, Poly Haven), Blender (scripted, bpy) for hero pieces + baked AO. Keep the destruction system, use the new assets as destructible pieces. Weakest themes to polish: Moonlit Lake, Aurora Glacier (real planar reflections), Sunset Ruins.
5. **Props and weapons pass:** visible arrow nock/draw/release for Erika (+ quiver); readable thrown objects (knight's throw); proper weapon models for all fighters (currently simple code shapes); Ozrel has no staff.
6. **AI v2:** pattern prediction of the opponent's next action (what they do after block/whiff/low HP) and baiting; short-horizon lookahead using the fast sim as forward model (MCTS-lite); rivalry memory across matches (Nemesis-style, also feeds dialogue); offline self-play tuning of doctrine params.
7. **TTS finish and integrate:** finish generation, integrate `tts-final/out/voice` into `arena/public/audio/voice` + subtitles, recast announcer (Computer voice fails ASR; use Keeper(Neutral) or Hero), female reference voice for Erika and female characters (needs a clean 10-20 s calm + shouted recording), real growls/roars/pain grunts for creatures, voices for the 19 new characters (spares: knight=Keeper(Neutral), goblin=Toady+2st, undead=Snake-3st).

### The actual game layer (NOT BUILT; this is the original pitch)
- Betting on fighters (play currency), god powers (boost, heal, debuff; scarce/risky; counters from other gods; who-did-what reveals), EXP, god rank, economy, god personalities.
- Live room: scheduled matches on a server, shared viewing with other gods, spectator sync, replays for cold start, seasons/modifiers.
- Backend: server runs the sim once and streams events; clients play back.
- Replay/highlights: "play of the match", slow-mo replay, commentary.
- UI/HUD polish, menus, announcer graphics, tutorial/onboarding. **UI TARGET LOOK:** `docs/concept-art/ui-select-screen.png` (dark-fantasy "THE ARENA" select screen: West/East gate fighter panels with portrait + name + epithet + move name, P1 red / P2 blue selection frames, Random buttons, arena theme cards with thumbnails and flavour lines, layout / arena seed / fight seed / skip entrances / gore controls, big "ENTER THE ARENA" button, gold serif title, ornate dark-metal frames, background = blurred arena art). Restyle the whole UI (select screen, HUD health bars, announcer, menus) to match. **TITLE / MENU BACKGROUND:** `docs/concept-art/title-bg-godsring.png` (gods in crowns watching the arena from a balcony: this is the game's core fantasy). The image shows the title "GODSRING" with tagline "Champions fight. Gods decide." (name not decided; ask the user whether to rename from Arena Gods). Needs: portraits for each fighter (render from models or use art), arena thumbnails, fonts (Cinzel-like serif display + readable body), frame/panel CSS or 9-slice art.
- **Shareable demo** (hosted build) to get friends' feedback ASAP.

---
- **Owner feedback 2026-10-18 (watched 10+ live fights): finishers, kill variety, environment use.** Seen: only 2 finishers in 10+ fights, both Shoulder Throw; never a cut-through-mesh kill; environment interaction rare (one prop pickup and throw).
  - Cause (code, not measured): `tryFinisher` in `src/sim/match.ts` fires on a lethal blow with p = 0.16 + pride*0.22 (+0.08 tense, -0.12 lopsided), clamped 0.05..0.6; then only finishers whose user/weight/space/hazard/knockdown conditions fit are candidates. Shoulder Throw has the loosest conditions (4 users). Only 8 finishers exist. Prop grabbing is one of ~14 AI goals with a small weight that decays x0.8 per pickup (`src/sim/ai.ts`).
  - TODO: (a) raise the finisher rate and widen conditions so every fighter has at least 2 usable finishers (the 12 missing finishers, anim leftovers); measure finishers per fight with a sim counter (A2b added it: 0.26 finishers per fight). (b) Killing-blow rule: sharp weapon = severing cut (gore setting respected), blunt = ragdoll launch, finisher = the special case; the owner's mental model. (c) Raise prop pick-up/throw and environment use: DONE in A2b for AI v1 (pickups 0.33 -> 1.06 per fight, throws 0.25 -> 0.81, matches with environment use 53 % -> 80 %, counters in `sim:test`); AI v2 should own real environment tactics (luring onto cracked floor, fighting near braziers on purpose, kicking props). Suggested targets for AI v2: >= 1 pickup and >= 1.5 interactable triggers per fight, hazard kills >= 3 % of kills.
- **Owner feedback 2026-10-18 on A2 floor (compared game screenshot with ref-3): floor material is wrong for the concept.** A2 only did the floor system; rest of the colosseum is still the old one until A3-A8. Concept floor = big thick hard broken slabs, deep dark joints, chipped edges, heavy cracks, rubble/debris on it, blood and soot stains, rough dull stone with wet glints only in puddles/cracks, deeply carved ring grooves. Ours = small regular clean tiles with an overall mirror polish (reads as modern tile). TODO (fold into A7-A8 and the review pass): much larger irregular slabs, heavier crack/chip normal detail, higher base roughness with puddle masks carrying the wetness, scatter rubble and stains, carve the inlay deeper; compare ref-3 floor crops side by side.

## 4. IDEAS (not committed)
- Seed-VC / speech-to-speech voice conversion for hero lines (human performs, tool re-voices) for real Shadow-of-Mordor acting.
- Dia 1.6B / Higgs Audio v2 (probably too heavy for the iGPU).
- Mixamo bulk-download gist (krazyjakee) was considered; the HF dataset route was used instead.
- Multi-level arenas with ramps (sim is flat 2D now); more themes; seasonal arena modifiers.
- Arena unbuilt interactions: collapsible bridges, weapon racks, kicking props, climbing out of a pit as an animation, fighters knocked through barricades on purpose (crumbling floor, edge collapse and swinging chains shipped in A2b).
- Grab/throw/stance-change moves for the original 8 (no stance changes yet).
- Facial expression through eye/head look-at, posture and glow (no blendshapes on the models).
- More announcers/commentators, crowd chants, adaptive music stems, real crowd samples.
- WebGPU, mobile support.

---

## 5. KNOWN ISSUES (from agent reports)
- AI: kiters (Erika, Ozrel) spend only ~1/3 of time in their range band; cover use is rare (~0.6 s/match); cornered escape ~50%; heavy whiff counts may look clumsy.
- Moves: several moves reuse the same clip (Snap Shot/Twin Shot/Heartseeker/Rain of Thorns; Skull Crack/Axe Feint); Ozrel staff not a hitbox; Erika kicks foot-only. (Reaction repetition fixed in M2.)
- Animation: borrowed clips mix styles (longbow dodges on non-archers, etc.); two-handed weapon IK approximate; one clip fails to load (`ProMeleeAxe/standing melee attack horizontal.fbx`); Maw has a white patch at the waist (model/texture).
- Animation (after M4):
  - **Foot skate** is 0.54 of planted frames. 97% of it is during walk/strafe cycles while the sim moves the fighter; rate-cap and blend-threshold A/Bs did not help. Needs stride-matched locomotion (M5/M9).
  - Executioner is Gorak/Maw only: Aldric's and Hollowjack's executions were cut because they miss a lying body by 0.14 to 0.16 m.
  - Behead falls back to the cut on Ozrel, Erika and Maw (rig weights).
  - The contact warp can slide the attacker up to 0.7 m around a contact. Not judged at play speed.
- Finishers: the Immolation over-the-shoulder camera is sometimes dominated by Ozrel's back. The Into the Fire landing in the hazard has not been looked at by eye. Real-time feel of the freeze beat, slow motion and cut-ins is unjudged.
- Camera: readability audit 94.3% of frames, with contacts on screen 96.0%. Cross layouts are below the 95% target (forge/cross 88%, Erika's kiting gives tiny over-the-shoulder and crane shots); sakura/gauntlet is about 90% (low two-shots behind trees). Low-rim entrances are fixed (M3).
- Arenas: 3-6 s build time at load (CPU texture gen); some textures leak when switching themes; `window.__THREE` exposed for debugging; discrete-GPU frame rates unverified (iGPU 13.5-19.5 ms/frame at high).
- Audio: footsteps busy with fast fighters; Erika's pain grunts are pitched male grunts; Hove Base Metal/Wood files identical; synth fire/crowd/stingers still synthesized; nobody has listened to the new TTS yet; announcer lines failing ASR.
- Sim: ring of fire reaches fighters in ~77% of matches. Sudden death now escalates (×1.5, +0.25/s after 100 s) to remove the last two time-outs (grindy Vex/Aldric).
- FX (after F0):
  - Falling particles rest on the floor instead of bouncing.
  - (Fixed in F3: seek rebuilds long tails; trails are frame-rate independent; the new sprite ops scale with the tier.)
- FX / post (after F1):
  - Distortion, the brighter FX (`HDR_SCALE`) and the per-theme bloom / grade were judged on stills only, not at play speed or on a real monitor.
  - GTAO now also darkens under alpha-tested foliage; FX are no longer darkened by AO.
  - Arena braziers have no heat shimmer in the game until F4 (they are arena-owned flames).
  - Nothing holds a grade preset yet; F7 wires the beats.
  - Owner decision pending: low tier at 0.75 render scale (default now) or 1.0.
- FX assets (after F2):
  - Shipped as WebP only (`toktx` is not installed), so atlases use 128-px frames, not the plan's 256-px frames. With KTX2, `pack_atlas.py --hires` can produce the 256-px frames.
  - Unity fps and loop flags are guesses (loops come from a wrap test).
  - The own bakes for splash and blood read as beady metaballs and are no longer used (F3 builds blood and splashes from sprites); they still ship. The dust ring is regular.
- FX (after F3):
  - Blood amount, wound build-up (up to 8 per fighter), spark brightness, trail width, ghost strength and footstep frequency were judged on stills only. Owner: play at gore standard and full.
  - Footsteps come from recorded motion (a stride every 1.15 m above 2.5 m/s), not from the visible foot plant.
  - Not built yet: footprints through blood, bleeding drips, hit pulse (C18), Ward Pulse ripple, arrow ribbons / stuck arrows, claw-hand blood.
  - Wounds sit on seeded bones (seek-exact), not at the exact hit point. Bisect finisher halves drop the wound patch.
  - Afterimages and the arena's canvas crack shapes are not reproduced exactly after a seek (positions are).
  - Owner decisions: is gore standard the right amount; keep 3 FX light slots on high (cost under ~0.5 ms, not resolved in the noise); drop the unused blood / splash bakes.
- Arena pipeline (after A0 / A1):
  - KTX-Software 5.0.0-rc2 is installed (`ktx.exe` only). gltf-transform 4.x `uastc` / `etc1s` fail with it silently (they pass the 4.x flag `--assign-oetf`); the arena pipeline (A1, `tools/arena/build_assets.mjs`) calls `ktx create` directly and checks its log. `tools/fx/encode_ktx2.mjs` (FX) still looks for `toktx`, which v5 no longer ships, so FX atlases stay WebP-only until it is ported to `ktx create` (copy `ktxEncode()` from `build_assets.mjs`; `public/basis/` now exists, which `FxAtlases` expects).
  - A1 brazier is a test asset: up-close the low-tier LOD1 bowl is faceted (12 sides) and the hammered dents are subtle; A4 builds the four brazier types. Not tested: ASTC / ETC2 transcode targets (phones, Macs), a real (non-headless) browser, frame-time cost with timer queries.
  - A1 decisions to confirm (README): encoders (ETC1S colour + ORM, UASTC + RDO normal), WebP fallback files shipped next to KTX2, kit mode rebuilds the arena at the next match after an auto-tune tier change, no loading veil yet (kit under 1 MB).
  - gltf-transform `webp` fails in this `node_modules` (sharp / libvips "colourspace: parameter space not set"): use Pillow or Blender's WebP export.
  - Concept presets: foreground fighter is upright (the concepts draw it hunched), roll and hFOV are eye estimates, ref-10 uses the sakura stand-in until `rootwood` exists. Re-run `tools/arena/calibrate.py --write` after the arena size changes.
  - C4 (wet floor) and C5 (detail) are crude on today's bright floors; meaningful after A2.
  - A2 (wet floor): the planar pass costs more per render than the plan's budget on this iGPU (see the README perf table); it meets the budget only amortised by the half-rate refresh. The low tier's scene pass got about 3 ms slower on the colosseum (floor shader + 10 braziers + streaks): A21 perf pass. Fire streaks on medium / high come mostly from streak cards (the planar reflection of a flame card is dim after Fresnel); the moon path is a painted streak (a real mirror image of a moon 27 deg up falls under a low camera's frame). The low half of the mirrored frustum was wasted before the crop; the crop is computed from 15 floor rays per frame.
  - A2b (bigger arenas + interactables): all new interactables use placeholder visuals (procedural banner / barricade / chain weight / vent / pit, existing FX ops and sounds) until A3-A5; the pit is a black disc (floor not cut); chain weights do not block movement; at most 4 burning-oil patches are drawn per arena; the entrance validator ran on a 2-fighter subset (0 new failures); mean fight 70.4 s; ref-3 frame draw calls 270 -> 381 (more props / features / flames, A21 perf pass) (top of the 60-70 s band). Decisions to confirm are in `docs/milestones/A2b/README.md`.
  - A4 (dressing kit): colosseum kit-mode download about 27 MB full (A3 17 MB; plan 14-22 MB first visit): props use 1024 sets, cut in A21 or per-theme packs; legacy `banner()` keeps `Math.random` only on `?arena=legacy` (pixel-identical gate; decision 2 in the A4 README); FRAC pieces shipped but not spawned (A5); big pillar banners / chain swags across the arena, lanterns, bell, stakes not placed yet (A7+); sway amplitude not judged in motion; skulls / bones blobby up close; chunk props look like stone rubble even when they come from banner shafts / barricade planks. Decisions to confirm in `docs/milestones/A4/README.md`.
  - A3 (stone kit): in the night preview the backlit kit stone is very dark (detail barely visible at gameplay distance): lighting / grade for A8; trim modules are still straight-edged (damage mostly in textures): more silhouette damage in A7 / review; rubble pile drawn ~0.9 m high while the sim's `rock` obstacle is 5 m (as the legacy visual); the colosseum kit-mode download is 17 MB full / 5 MB low (plan 14 / 8 MB first visit; pillar 2048 set is 3.8 MB); arch, stairs, plinth, dais, balustrade, spear fence built but not placed (A7); no GPU timer run this milestone; FRAC pieces are plain slices (A5). Decisions to confirm in `docs/milestones/A3/README.md`.
  - Kit colosseum entrances (pre-existing since A1/A2, found during A2b): `validateEntrances` reports 20 `support` failures (nothing under the feet at the gate threshold, every layout, both gates) on the kit colosseum; the same 20 fail on `307a9fa`. Likely the kit wet floor does not reach the gate apron that the legacy floor disc covered. Fix with A7 (Moon Gate near field / gates).
  - A2 decisions to confirm (README): Moon Gate night preview on the kit colosseum before A7, decorative boundary braziers, streak cards on all tiers, half-rate reflection, moon god rays off, slate set shipped but used by no theme yet, runtime (not Blender) macro mask, `surfaceAt` not yet wired into footstep FX (A20).
- Process: the machine has had low-memory kills (dev server killed 3x); keep heavy jobs sequential; Claude Code reaps background jobs under memory pressure (or start with `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1`).

---

## 6. LEGAL / LICENSE TO-DO (before anything public)
- Mixamo: terms allow use in projects; do not redistribute raw FBX. Repo is private; converted GLBs are in `public/models`.
- Soundrack Swords & Blades: CC BY 4.0 (credit required; in `public/audio/CREDITS.txt`).
- Hove Audio Sword Combat FREE: license not stated in the archive; confirm.
- Ogrebane monsters and Junkala boss music: credited as CC0 without a license file; verify.
- Kenney packs: CC0.
- Arena art (`public/arena/`): every source scan has a row in `public/arena/credits.json` (written by `tools/arena/fetch_cc0.mjs`, `usedBy` filled by `build_assets.mjs`); `npm run arena:budget` fails on a missing or non-CC0 row. So far: Poly Haven `metal_plate_02` and `large_grey_tiles` (Rob Tuytel, CC0), `stone_tiles` (Christopher Melani, CC0), A3: `lichen_rock` (Rico Cilliers, CC0) and the model `rock_moss_set_02` (Kless Gyzen, CC0); A4: `weathered_planks` and `rusty_metal_02` (Poly Haven, CC0). Everything else is generated in our Blender jobs.
- FX textures (`public/fx/`): every file has a row in `public/fx/credits.json` / `CREDITS.md`, and `node tools/fx/check_budget.mjs` fails on a missing row. Sources:
  - Unity Labs flipbooks: CC0, per the Unity blog page; the zips have no licence file.
  - Kenney Particle Pack: CC0, checked in `License.txt`.
  - Screaming Brain noise: CC0, checked in `License.txt`.
  - Own Blender bakes and procedural decals: CC0.
  - CGHEVEN (custom licence) is not used until the owner agrees.
- Open Dungeons voice pack (used as clone references): license unknown, probably CC-BY/CC-BY-SA; also a consent question for cloning a real actor's voice. See `tts-final/LICENSES_NOTES.md`.
- Chatterbox AI watermark (Perth) was stubbed out because it was broken in the local build; output has no AI watermark.
- OmniVoice model license unverified.
- HF Mixamo dataset license is "Adobe Mixamo terms".

---

## 7. Where things live
- Game: `C:\Programming\GameDev\Research\arena` (git repo root). Docs: `arena/docs/` (animation-plan, animation-research, animation-catalog, arenas, ai-design, movesets, metrics-*).
- Source assets (not in git): `C:\Programming\GameDev\Research\Assets` (Models, Models_HF, Animations incl. Mixamo_HF and Mixamo_HF2, sfx, sfx\VoiceRef).
- Voice work: `...\Research\tts-final` (cloning), `...\Research\tts-bakeoff` (engine comparison), `...\Research\hf-scan` (dataset indexes and previews).
- Run: `cd arena && npm install && npm run dev` (http://localhost:5173). Tests: `npm run sim:test`, `npm run build`, `npm run audio:check`.
