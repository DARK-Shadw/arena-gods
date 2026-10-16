# The Arena — spectator-first AI gladiator prototype

Two autonomous AI fighters fight in a procedurally generated 3D arena while an auto-director films it. The arena has seven high-fantasy themes, five layouts, destructible cover, throwable props, explosives and hazards. Each match opens with an arena reveal flythrough, then a Shadow-of-War-style entrance for each fighter. There is no player control yet: you pick the fighters, the arena and the seeds, then watch.

Built with Vite 6 + Three.js 0.170 + TypeScript. Characters and animations are the Mixamo assets in `../Assets` (models plus the ProMeleeAxe, ProSwordandShield, ProMagic, ProLongbow, Creature and ActionAdventure packs). They are converted offline to compact GLBs in `public/models/` (about 17 MB total). The pick-up/throw interaction uses one extra clip, `Mixamo_HF/grabs_throws/Throw_Object.fbx`, shared by all fighters. Arenas, VFX and audio mixing are procedural.

## Arenas (round B) — see `docs/arenas.md`

| Theme | Look | Signature interactions |
|---|---|---|
| **The Gilded Colosseum** | golden-hour travertine amphitheatre: marble ionic columns, 3,400 GPU-animated spectators, velarium sails, banners, bronze braziers | spike traps, a fire-cage chandelier hung from the velarium cable, powder kegs |
| **The Sky Sanctum** | white-and-gold marble ring floating over a sunlit sea of clouds, floating isles, a broken halo in the sky | wind vents, reflecting pools, a cliff-edge balustrade |
| **The Blossom Shrine** | mossy flagstones, vermilion fence and torii, cherry trees, wind-swept grass, stone lanterns, falling petals | koi ponds and water rivers, bonfires, toppling stone lanterns |
| **The Molten Forge** | basalt cathedral with glowing magma cracks, a lava moat, lava falls, obsidian rune obelisks, embers | lava pools and lava rivers, a hanging crucible, kegs |
| **The Aurora Glacier** | ice floor reflecting a live aurora, ice-shard walls, crystal spires, snowfall | ice-spike traps, cryo vents, shattering crystals |
| **The Moonlit Lake Temple** | stone platform in a reflective lake under a giant moon, drifting lanterns, pagoda isles, fireflies | shallow pools, braziers |
| **The Sunset Ruins** | sandstone ruins, seated colossi, pyramids and palms at sunset, blowing sand | fire pits, sand vents, toppling statues |

Layouts are `pit`, `oval`, `cross` (central pillar cluster), `split` (a hazard river with two bridges) and `gauntlet` (narrow corridor).
- **Generator:** `sim/arenaGen.ts` turns (theme, layout, seed) into an `ArenaLayout`. The sim collides and damages against it, and the renderer dresses it. The record stores the spec, so the same seed always gives the same arena and the same fight.
- **Simulated interactions:** cover blocks shots and line of sight and cracks progressively. Columns and statues topple in the direction of the blow and crush what's under them. Crates, barrels and urns break. Props can be picked up and thrown; throws are dodgeable, blockable and swattable, and the release is timed to the clip's release frame. Powder kegs explode in chains. Lava, spikes, geysers, water and chandeliers are hazards. The AI uses all of this.
- **Selecting an arena:** use the menu (theme cards, layout, arena seed with 🎲), or **A** / **⇧A** / **T** in game, or the `?theme=&layout=&aseed=` URL parameters.

## Roster (model → animation packs)

| Fighter | Model | Clips | Style |
|---|---|---|---|
| Gorak the Skullsplitter | `brute.fbx` (own battle-axe) | ProMeleeAxe (+ SwordandShield death, Longbow dodges) | heavy axe bruiser |
| Aldric Ironwall | `Paladin-w-prop.fbx` (sword + shield) | ProSwordandShield | defensive knight, parries |
| Ozrel the Cinderlord | `Mage.fbx` | ProMagic | fire caster, ranged cone + nova |
| Erika the Thornshot | `Erika-archer-w-prop.fbx` (bow) | ProLongbow (+ ProMagic crouch/getup) | archer, keeps distance, arrows |
| Vex the Crimson Whisper | `vampire.fbx` | ProMagic + ProMeleeAxe kicks/combo + SwordandShield lunge | fast evasive duelist |
| Fenrik Bloodmaw | `Mutant.fbx` | Creature (+ axe-pack strafes/reacts) | relentless beast |
| Maw the Devourer | `Maw-J.fbx` | Creature + ProMeleeAxe 360 | huge, slow, armored |
| Hollowjack the Pumpkin Hulk | `Pumpkinhulk.fbx` | ProMeleeAxe unarmed + kicks, Creature roar | brawler |

`erika-archer.fbx` and `Paladin.fbx` (the variants without props) are not used. The exact clip-to-move mapping is in `src/data/animsets.ts`.

## Audio and voiced dialogue

- **SFX** come from the downloaded packs (licenses and credits: `public/audio/CREDITS.txt`).
  - `npm run audio:build` extracts what `src/data/sfx.ts` lists from `audio-src/` into `public/audio/sfx/*.ogg`. It trims silence, caps length, peak-normalises and outputs mono Vorbis.
  - It also writes `manifest.json` with each file's duration and transient-peak offset.
  - `npm run audio:check` verifies that every manifest entry exists.
  - The downloaded archives go in `audio-src/<pack>/`, one new directory per archive. Extract them with `bsdtar -xf <archive> -C audio-src/<pack>`. They are not shipped.
- **Sound director** (`src/audio/soundDirector.ts`) maps sim events and frames to pools. Effects pick a random variant (never the same one twice in a row) with slight pitch and volume variation, and are panned and attenuated by position relative to the camera.
  - Swing whooshes are scheduled so their transient lands on the animation's strike moment. Impacts start at their transient when the hit event fires.
  - Each fighter has its own hit family: blade, blunt, magic or arrow. Pain grunts are human or creature.
  - Kill blows layer several impacts with a sub boom. The killcam slow-mo low-passes and pitches down the SFX bus.
- **Mixing** (`src/audio/audio.ts`): buses for sfx, voice, ui, ambience and music, plus a compressor and limiter.
  - Music is the CC0 boss-battle loop. It plays quiet and filtered during entrances, opens up with drama tension, and ducks under voice lines.
  - The crowd bed is synthesised, since none of the packs contains crowd audio.
  - The volume panel (**V**, or the button in the menu) persists its settings in localStorage.
- **Dialogue** (`src/data/dialogue.ts` + `src/audio/dialogue.ts`): each fighter has a voice persona and lines for entrance, faceoff, rivalry (`vs_<opp>`), taunt, ultimate, hurt, nearDeath, comeback, kill, victory and defeat.
  - Lines are chosen with an RNG seeded by the match seed, in response to sim events only, so replays say the same things and the sim is untouched.
  - One voice plays at a time, with priority interrupts and cooldowns, and subtitles are shown.
  - Entrance monologues are timed to the title card; the entrance is held longer when needed. The face-off plays a two-line exchange with close-ups.
- **TTS (offline)**: `npm run tts:gen` (add `-- --subset first` for entrance and victory lines only).
  - It exports the jobs, then runs OmniVoice in voice-design mode once per character to create an anchor voice. Every other line clones that anchor, so each character keeps a consistent voice.
  - Each fighter runs in its own process on the Intel Arc iGPU (XPU). CPU int8 is the fallback; set `TTS_DEVICE=cpu`.
  - Lines are cached by text and persona hash in `audio-src/tts/raw/`.
  - Finally, `tools/tts/post.mjs` applies each character's ffmpeg effects chain (pitch, EQ, echo, flanger…) plus loudnorm, writing `public/audio/voice/<id>/*.ogg` and `manifest.json`.
  - The game ships the generated files and needs no TTS at runtime. `TTS_PYTHON` points at the OmniVoice venv python.
  - Generation takes about 10–55 s per line on the iGPU; all 188 lines took roughly an hour.
  - Voice design sometimes produces an unintelligible anchor. If you change a persona, run `python tools/tts/check_anchors.py` (any python with faster-whisper) after `TTS_ANCHOR_ONLY=1`.
  - `tools/tts/intelligibility.py` runs Whisper over the shipped files and reports per-fighter WER.

## AI, hit contact and movesets (round 3)

- **AI**: a layered utility AI built on per-fighter doctrines (role, preferred range band, win condition, fears), with opponent modelling and human-like mistakes. See `docs/ai-design.md` for the design and the sources it draws on.
  - `sim:test` prints AI metrics: time in range band, retreats and kiting, whiff-punish rate, move variety, repeated patterns, dumb hits, cornered escapes, ranged fighters walking into melee, cover, and kills without contact.
  - Before/after numbers are in `docs/metrics-before.txt` and `docs/metrics-after.txt` (round A, old fixed arena).
  - Round B (generated arenas) numbers are in `docs/metrics-arena-after.txt`. `docs/metrics-arena-notactics.txt` has the same arenas with the AI's arena tactics layer disabled (`ARENA_AI=0`). The arena-play section covers pickups, throws, throw hit rate, cover hits, topples, crushes, explosions, hazard hits and environmental kills, with a per-theme and per-layout breakdown.
  - Analysis tools: `npx tsx tools/aitrace.ts a b [seeds]` (goal mix and per-move use/hit/whiff) and `npx tsx tools/whiffs.ts` (closest approach of whiffed attacks).
- **Hit contact**: the sim tests the animation's real strike points (effector bone and weapon tip, sampled from the clips into `src/sim/reach.gen.ts`) against the body capsule. It also has tracking lunges and magnetism.
  - Projectiles are real sim entities: they must arrive at the target, and cover blocks them.
  - Thrown props, falling columns, blasts, chandeliers and hazards damage on the tick they visibly reach the fighter.
  - Chip, fire-ring and knock-into-prop damage are non-lethal.
  - Browser audit: `await __arena.audit([[a,b],...], seeds)`.
  - Regenerate the reach data after changing clips: `node tools/convert/run.cjs tools/convert/task_convert.cjs` → `sh tools/convert/optimize.sh` → `node tools/convert/gen-reach.mjs`.
- **Movesets**: 10–12 moves per fighter, listed in `docs/movesets.md`. They cover openers, strings, launchers, sweeps, guard-breakers, gap-closers, counters, feints, ranged pokes and defensive specials.

## Asset pipeline (`tools/convert/`)

The shared prop-interaction clip comes from `npx tsx tools/convert/shared-clips.ts`. It runs FBXLoader in Node and writes `public/models/shared_clips.json`, including the measured release frame. The fighter GLBs are unchanged this round.

Run the following once, whenever `src/data/animsets.ts` changes. It needs the dev server on :5173 and playwright-core (a devDependency) with a Chromium.

```bash
node tools/convert/run.cjs tools/convert/task_convert.cjs   # IDS=gorak,maw to do a subset
sh tools/convert/optimize.sh                                # meshopt-compress the GLBs
```

`convert.ts` runs FBXLoader in headless Chromium. For each fighter it does the following:
- Converts Phong materials to Standard and resizes textures (colour 1024 px, normal 512 px).
- Retargets every clip by Mixamo bone name:
  - Keeps rotation tracks only.
  - Hips: X/Z are locked so clips play in place. Y is scaled by model hips height / 100 cm, so large or small models neither sink nor float.
  - Position tracks on every other bone are dropped, to avoid stretched limbs.
- Measures metadata into `public/models/<id>.json`:
  - each clip's root speed (to sync locomotion with the feet)
  - the strike time and multi-hit peaks (the fastest hand or foot)
  - the weapon tip (the farthest vertex of the hand-skinned weapon mesh)

`optimize.sh` runs gltf-transform with meshopt (`MeshoptDecoder` at runtime). WebP texture compression failed with sharp on this machine, so textures stay JPEG/PNG.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build to dist/
npm run sim:test   # headless balance/drama report (default 40 seeds per ordered pair)
npm run sim:test -- 100            # more seeds
npm run sim:test -- 20 gorak vex   # one matchup, verbose per-seed lines
DIAG=1 npm run sim:test            # + per-fighter attack/hit/block/dodge stats
npx tsx tools/trace.ts gorak vex 42 [-v]   # timeline of one fight (HP every 2.5s + drama events)
```

URL parameters:
- `?a=gorak&b=vex&seed=42&auto=1` starts a match straight away.
- `&theme=forge&layout=split&aseed=7` picks the arena. Omit any of them for random.
- `&q=0|1|2` forces the quality level. Without it, quality auto-tunes.
- `&skip=1` skips the entrances.
- `&manual=1` turns off the real-time clock so automated tests can step frames through `window.__arena.stepFrames(n, dt)`.
  `window.__arena.debugView(pos, look, fov)` and `window.__arena.bench(n)` support screenshots and GPU-synced frame timing.

Headless screenshots and benchmarks run without a dev server, because `dist/` is served through Playwright routing:
- `npm run build && node tools/shots/shots.cjs <outDir> colosseum:pit:7 forge:split:3 --bench --fight=20`
- Add `--seq=t0,n,dt --follow=0 --pair=maw:erika --fseed=3434` to capture a sequence.
- Add `--intro=1,3,6` to capture intro frames.
- `npx tsx tools/findev.ts maw erika colosseum:pit:7 prop_throw` finds seeds where an event happens.
- `ARENA_AI=0 npm run sim:test` runs the metrics with the AI's arena tactics turned off.

## Controls

| Key | Action |
|---|---|
| Space | skip the current cutscene (entrance / face-off) |
| Enter | skip all intros and go straight to the fight |
| R / N | rerun the same seed / run a new random seed |
| Esc | open the match-select menu |
| L | toggle cinematic letterbox (always on in cutscenes and the killcam) |
| C | free camera (orbit controls) on/off; the director keeps controlling time |
| ` or F3 | debug overlay (shot, tension, momentum, timescale, fighter states, event and cut log) |
| A / ⇧A / T | new random arena / new layout+seed in the same theme / next theme (same layout+seed) |
| Q | cycle render quality (high → medium → low) |
| P | pause · M mute · O toggle depth of field |

Audio starts on the first click or key press, because browsers block autoplay.

## Architecture

```
src/sim/          PURE deterministic simulation (no three.js; runs in Node)
  rng.ts            seeded mulberry32 PRNG
  types.ts          moves, personalities, frames, event stream types
  fighters.ts       the 8 fighters: stats, personality, movesets (data)
  arena.ts          match-wide arena constants (timings, start marks, ring-of-fire shrink)
  arenaGen.ts       SEEDED ARENA GENERATOR: theme + layout + seed -> boundary ellipse, cover,
                    props, hazards, waypoints (shared by sim, renderer, camera, metrics)
  world.ts          destructible/interactive runtime: cover HP + topple/crush, prop physics,
                    lift/carry/throw, powder kegs, hazard cycles; per-frame snapshot
  dmath.ts          cross-engine deterministic sin/cos/atan2/exp/pow/log/hypot
  match.ts          60 Hz fixed-step fight: movement, attacks (windup/active/recovery), hit
                    resolution, block/parry/dodge i-frames, stagger/knockdown/getup,
                    stamina + "winded", fury, environment slams, props, fire ring.
                    Records per-tick Frames + timestamped SimEvents
  ai.ts             personality-weighted utility AI + reaction layer (block/parry/dodge/counter)
  drama.ts          the hidden DRAMA ENGINE (see below) + result metrics
src/render/       consumes the record
  playback.ts       interpolated playback clock that supports slow-mo and hit-stop
  character.ts      GLB loading (meshopt) + AnimController: AnimationMixer layers,
                    weights always normalised (no T-pose drift), velocity-blended
                    locomotion with speed-matched playback, manual-time one-shots
  fighterView.ts    maps sim state -> clips: attacks are time-warped so the clip's
                    strike moment lands on the sim's active window (works with
                    slow-mo/hit-stop); directional hit reactions and dodges;
                    knockdown = held death fall + getup; trails, telegraphs, aura
  arena/            procedural arenas (docs/arenas.md): arenaView (sync with frames,
                    destruction), themes, sky + IBL, height fog, PBR texture recipes,
                    materials (lava, water, cracks, triplanar), modular kit, per-theme
                    dressing, GPU ambient particles, debris + floor decals
  vfx.ts            particle pools (sparks, dust, smoke, fire, embers), shockwaves, debris
  post.ts           GTAO, depth of field, god rays, half-res bloom, per-theme grade
src/camera/
  cameraRig.ts      critically damped springs, trauma shake, FOV punch, wall/pillar
                    collision and pillar occlusion avoidance (keeps both fighters visible)
  director.ts       event- and tension-driven shot state machine + time control
src/cinematic/
  timeline.ts       reusable track/clip timeline (enter/update/exit, cues, finish-on-skip)
  entrance.ts       turns data entrance specs into timelines; fx/sfx cue vocabulary; face-off
  reveal.ts         pre-match arena reveal flythrough + name card
src/data/
  animsets.ts       model + clip mapping per fighter (shared with the converter)
  appearance.ts     accent colour per fighter
  entrances.ts      per-fighter entrance choreography (actor/camera/cue tracks, mood lighting)
src/audio/audio.ts  WebAudio synthesis: hits, clangs, whooshes, roars, drums, stingers,
                    crowd bed and cheers, and tension music (drone + drums)
src/ui/ui.ts        HUD, drama toasts, title cards, splash text, debug overlay, menu, results
tools/simtest.ts    headless balance and drama analysis + determinism check
```

**Data flow:** `simulate(a, b, seed, true, arenaSpec)` runs the whole fight in about 60–140 ms. It returns a `MatchRecord` with roughly 4,000 frames, a list of events and the arena spec. The browser never runs the sim live. It plays the record back. Because the record already holds the whole fight, the director knows when the killing blow lands and can start the slow-motion killcam during that attack's windup.

A given seed and arena produce the same fight in Node and in the browser, bit for bit, as checked with event and frame hashes. Before this round that was not actually true: engine `Math.sin`/`exp`/… differ in the last bits between V8 builds. The sim now uses `sim/dmath.ts`.

### Combat model (sim)
- The arena is a generated ellipse with cover, props and hazards (see above and `docs/arenas.md`). Getting knocked into the wall or cover fast enough causes a slam: extra damage, a stagger, damage to the cover, and it can shake loose a chandelier. Getting knocked into a prop smashes it.
- Every move has a windup, an active window and a recovery, plus range, arc, lunge, knockback, stagger, knockdown, armor, unblockable, multi-hit and combo `next`. Windups track the target only partially, so sidestepping a committed attack works.
- **Defense:**
  - Blocking takes chip damage and stamina damage. A block that runs out of stamina becomes a guard break.
  - A deliberately timed block is a parry, which staggers the attacker.
  - A dodge roll has i-frames from 0.03 to 0.34 s.
  - Attacking into an opponent's windup scores a counter-hit.
- **Stamina:** emptying it leaves the fighter winded, hands on knees and punishable. This is the "stamina crunch" beat.
- **Fury:** comes from damage taken (more when behind), damage dealt and taunting. At 100 the fighter can use its ultimate.

### AI and personality
There are 7 traits: aggression, caution, pride, desperation (-1 = coward … +1 = desperate), patience, rage and adaptability. They change behaviour like this:
- Aggression and patience set attack frequency, footwork plans and combo chaining.
- Pride makes a leading fighter taunt and save its ultimate for a dramatic moment.
- Desperation makes a hurt fighter more dangerous, or more defensive for cowards.
- Rage builds a damage buff from damage taken.
- Adaptability tracks how often the fighter's attacks get blocked or dodged and which enemy moves it has seen. It then shifts toward guard-breakers and heavies, and reads repeated moves better.

### Drama engine (`sim/drama.ts`)
These are hidden levers, each with an in-fiction explanation:
- **Bloodlust:** damage ramps from ×0.6 to ×1.8 over time.
- **Underdog grit:** a fighter far behind takes up to 50% less damage.
- **Fury rubber band.**
- **Second wind** (desperate personalities): a roar plus 8–17% HP, stamina and a buff.
- **Cornered** (cowards): a buff with no heal.
- **Last stand** below 13% HP: full fury plus a buff.
- **Stalemate break:** both fighters get an aggression boost.
- **Ring of fire:** starts closing at 62 s. **Sudden death** at 100 s.

It emits `momentum_swing`, `comeback`, `near_death`, `low_hp_state`, `second_wind`, `last_stand`, `stalemate_break`, `rage`, `arena_shrink` and `sudden_death`. The camera, VFX, HUD toasts and audio all react to these.

### Camera director
- **Coverage shots:** `two_shot`, `two_shot_low`, `ots_0/1` and `wide`. They rotate on a timer that gets shorter as tension rises. At low tension they sometimes blend instead of cutting.
- **Event shots** interrupt coverage by priority:
  - `hero_*`: low angle on heavy hits and ultimates
  - `crane_*`: knockdowns
  - `track_*`: dodges
  - `react_*`: close-ups for last stand, second wind and momentum swings
  - `killcam`: slow-mo punch-in with a narrowing FOV, desaturation and letterbox
  - `victory`: orbit around the winner
- **Rules:** a cut cooldown of 1.3 s (except high-priority shots), a 180-degree side kept across cuts, hit-stop, slow-mo on parries and ultimates, trauma shake and FOV kicks.
- **Arena awareness (round B):**
  - The rig knows the current boundary ellipse, the standing cover (with heights) and the hanging chandeliers. It wall-clamps, orbits to a clear angle when something hides the fighters, and pushes out of columns.
  - `destruct` shots cover toppling columns, explosions and falling chandeliers, with a short slow-mo. `throw_*` is an over-the-shoulder shot on throws. The establishing crane is sized to the arena.
  - Before the entrances, a `reveal` flythrough with the arena's name card runs.

## Adding a fighter
1. **`src/data/animsets.ts`:** choose a Mixamo model and map the base clips (idle, walk, walkBack, strafeL, strafeR, run, block, blockHit, hitFront, hitLeft, hitRight, hitBack, death, getup, crouch, winded, taunt, roar, dodges, fall, land) and one clip per move id. `start` skips a long lead-in; `loopActive` replays the strike for multi-hit moves.
2. **Convert:** run the converter for that id (`IDS=newid …`), then `optimize.sh`. Check `public/models/newid.json` for each move's `strike` time.
3. **`src/sim/fighters.ts`:** add a `FighterDef` (stats, personality, moves). Set each move's `windup` to roughly (strike − start) / 1–1.8 so the time-warp looks natural.
4. **`src/data/appearance.ts`** (accent colour) and **`src/data/entrances.ts`** (choreography).
5. **Check balance:** `npm run sim:test -- 100`, aiming for a 45–55% overall win rate.
