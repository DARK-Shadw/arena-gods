# Arena Gods: Backlog and Status

Living document. Everything built, in progress, planned or only an idea, so nothing gets forgotten.
Last updated: 2026-10-16. Repo: https://github.com/DARK-Shadw/arena-gods (private).

Status key: DONE | IN PROGRESS | PLANNED | IDEA | ISSUE (known problem)

---

## 0. Vision and decisions (don't lose these)
- **Concept:** spectator-first "gods watching AI gladiators". Players are gods: they bet on fighters and nudge fights with limited, risky powers (boost, heal, debuff). Browser game; players open the site and watch a live match with other gods. Win bets for EXP, god rank and currency that buys more influence. Inspired by Omniscient Reader. Fights must feel like a cinema; every match unique.
- **Pillars:** the fight must be fun to watch (legibility, drama curve, personality); animation and characters must feel real; strong auto-director camera.
- **Betting:** play currency only, never real money (gambling law). Earned by winning, never bought.
- **Finishers/gore:** finishers are Mortal-Kombat-style. Gore setting off / stylised / full, DEFAULT = off (clean: dissolve/flash versions). Revisit when the user says otherwise.
- **Sim is authoritative and deterministic:** the same seed gives the same fight in Node and in the browser (custom `dmath`). Animation and cosmetics must never change sim results.
- **Test with real people early.** The user has made 10+ demos nobody played; a shareable build and friend playtests are part of the plan.
- **Tooling:** the user has Blender 5.0 installed (C:\Program Files\Blender Foundation\Blender 5.0), Piper and Chatterbox/OmniVoice/F5/Orpheus TTS in tts-lab, ffmpeg. The user prefers Opus for the heavy build work.

---

## 1. DONE (as of 2026-10-16)
- Deterministic seeded fight sim with drama engine (momentum swings, comebacks, anti-stall). 8 fighters with personalities. Balance stats: ~67 s fights, win rates ~45-55%, no timeouts.
- AI v1 (Round A): doctrines/roles, goals, opponent modelling by counts, retreat/kite/bait/punish, feints, counters. 84 moves.
- Hit-contact fix and phantom-hit audit (reach data from real clips).
- Mixamo model and animation pipeline (FBX to GLB, AnimationMixer), 8 fighters on real models.
- Procedural arena generator (7 themes, 5 layouts), destructible/toppling cover, throwables, hazards, powder kegs, AI using the arena, arena reveal shot.
- Auto-director camera, entrance cinematics (to be reworked), killcam slow-mo.
- Real SFX/music from packs, mixing, volume menu; subtitled dialogue system (OLD synth-quality TTS, to be replaced).
- Determinism fix (engine math differences Node vs Chromium).
- GitHub repo + animation research/plan/catalog (branch `anim-plan`).

## 2. IN PROGRESS
- **Animation overhaul M0 to M4** (branch `anim-plan`): animation lab, inertialization pipeline and hit-stop/spring flinch, reaction/death/knockdown/get-up variety, launch/knockback system, arena-aware entrances (fix Gorak cage break, Vex/Hollowjack arrival), paired-animation system + first 8 finishers, camera readability audit + shot grammar, finisher FX (cuts, burn, freeze-shatter, gore setting).
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
4. **Arena art upgrade (TARGET LOOK = `docs/concept-art/ref-3..10.png`, the user's concept art; treat as the art bible):** one shared kit across themes: wet, cracked, reflective stone floor with an inlaid ritual circle; torch braziers and candles as warm light sources; tattered red/black banners with a sigil; hanging chains; hooded statues; a huge landmark at the back (moon + giant arch, horned skull gate, Buddha + floating islands, gothic castle, jungle tree-city); layered fog, waterfalls and floating rock islands in the distance; embers and fallen leaves; strong warm-vs-cool colour split; low hero-camera angle with a foreground fighter silhouette. Themes seen: ruined moonlit coliseum, lava castle, floating-temple/zen, orc war-pit with mud, knight cathedral, wizard floating-castle with candles, night statue/moon, jungle tree-city. Plan: build the shared kit (floor material with wet PBR + planar/SSR-lite reflection, brazier+banner+chain+statue modules, fog cards, backdrop billboards/skydome painted per theme) then per-theme landmark; keep destruction system. Original note: use real art, not only code-built geometry. Poly Haven / ambientCG CC0 PBR textures and HDRIs, CC0 modular fantasy kits (Quaternius, Kenney, Poly Haven), Blender (scripted, bpy) for hero pieces + baked AO. Keep the destruction system, use the new assets as destructible pieces. Weakest themes to polish: Moonlit Lake, Aurora Glacier (real planar reflections), Sunset Ruins.
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

## 4. IDEAS (not committed)
- Seed-VC / speech-to-speech voice conversion for hero lines (human performs, tool re-voices) for real Shadow-of-Mordor acting.
- Dia 1.6B / Higgs Audio v2 (probably too heavy for the iGPU).
- Mixamo bulk-download gist (krazyjakee) was considered; the HF dataset route was used instead.
- Multi-level arenas with ramps (sim is flat 2D now); more themes; seasonal arena modifiers.
- Arena unbuilt interactions: crumbling floor, ice-edge collapse, swinging chains, collapsible bridges, weapon racks.
- Grab/throw/stance-change moves for the original 8 (no stance changes yet).
- Facial expression through eye/head look-at, posture and glow (no blendshapes on the models).
- More announcers/commentators, crowd chants, adaptive music stems, real crowd samples.
- WebGPU, mobile support.

---

## 5. KNOWN ISSUES (from agent reports)
- AI: kiters (Erika, Ozrel) spend only ~1/3 of time in their range band; cover use is rare (~0.6 s/match); cornered escape ~50%; heavy whiff counts may look clumsy.
- Moves: several moves reuse the same clip (Snap Shot/Twin Shot/Heartseeker/Rain of Thorns; Skull Crack/Axe Feint); Ozrel staff not a hitbox; Erika kicks foot-only; reactions repeat visibly (until the animation overhaul).
- Animation: borrowed clips mix styles (longbow dodges on non-archers, etc.); get-up is a floaty blend; feet slide in knockback; two-handed weapon IK approximate; one clip fails to load (`ProMeleeAxe/standing melee attack horizontal.fbx`); Maw has a white patch at the waist (model/texture).
- Camera: fixed angles can put a backdrop object in the foreground; entrances designed for tall gates look odd at low-rim themes.
- Arenas: 3-6 s build time at load (CPU texture gen); some textures leak when switching themes; `window.__THREE` exposed for debugging; discrete-GPU frame rates unverified (iGPU 13.5-19.5 ms/frame at high).
- Audio: footsteps busy with fast fighters; Erika's pain grunts are pitched male grunts; Hove Base Metal/Wood files identical; synth fire/crowd/stingers still synthesized; nobody has listened to the new TTS yet; announcer lines failing ASR.
- Sim: ring of fire reaches fighters in ~77% of matches.
- Process: the machine has had low-memory kills (dev server killed 3x); keep heavy jobs sequential; Claude Code reaps background jobs under memory pressure (or start with `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1`).

---

## 6. LEGAL / LICENSE TO-DO (before anything public)
- Mixamo: terms allow use in projects; do not redistribute raw FBX. Repo is private; converted GLBs are in `public/models`.
- Soundrack Swords & Blades: CC BY 4.0 (credit required; in `public/audio/CREDITS.txt`).
- Hove Audio Sword Combat FREE: license not stated in the archive; confirm.
- Ogrebane monsters and Junkala boss music: credited as CC0 without a license file; verify.
- Kenney packs: CC0.
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
