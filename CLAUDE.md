# Arena Gods (working title; title art says "GODSRING")

Spectator-first browser game. AI gladiators fight in a cinematic 3D arena; players are gods who bet (play currency only) and nudge fights with limited powers. Inspired by Omniscient Reader. Goal: something people actually play and share; fights must be fun to watch, animation and characters must feel real.

**Read first:** `docs/BACKLOG.md` (status of everything: done, in progress, planned, ideas, known issues, license to-dos), `docs/vision.md` (the big idea: a living world of persistent champions), `docs/HANDOFF-animation.md` (exactly where the animation overhaul stopped and how to resume).

## Stack and commands
Three.js + Vite + TypeScript. Run from this directory.
- `npm install`, `npm run dev` (http://localhost:5173)
- `npm run build` (typecheck + build), `npm run sim:test -- 40` (balance, determinism, contact checks), `npm run audio:check`
- Animation Lab: `/tools/animlab/` on the dev server.

## Hard rules
- The sim (`src/sim/*`) is authoritative and deterministic: same seed gives the same fight in Node and in the browser (custom `dmath`). Animation, camera, FX and audio must never change sim results. After touching `src/sim`, run `npm run sim:test -- 40` and check win rates 45-55%, 0 timeouts, 0 kills without contact, determinism OK.
- Betting is play currency only, never real money. Finishers: gore setting defaults to OFF (clean).
- Branches: `main` is the stable line; feature work goes on branches (current: `anim-plan`). Do not push to `main` without being asked.

## Layout
`src/sim` (match, ai, doctrine, reach, arenaGen, finishers, animSelect), `src/render` (character, arena, poseFx, post), `src/camera`, `src/cinematic` (entrances), `src/audio`, `src/data`, `tools/` (convert, anim, shots, audio, tts), `docs/` (plans, research, catalog, concept-art), `public/models` and `public/audio` (converted game assets, tracked).

## Art and UI targets
`docs/concept-art/ref-3..10.png` is the arena art bible (wet cracked stone floor, braziers, tattered banners, giant backdrop landmarks, fog, warm vs cool light). `ui-select-screen.png` is the UI mockup; `title-bg-godsring.png` is the title background. Match these.

## NOT in this repo (lives on the owner's PC)
`Assets/` (raw Mixamo FBX, `Models_HF` 19 extra characters, sfx packs, voice references), `tts-final/` (voice cloning, needs a local Chatterbox env; 159 of 227 lines still to generate), `audio-src/`. Anything needing those (converting new characters, generating voices, Blender) cannot be done from a cloud session; add it to `docs/BACKLOG.md` as a to-do instead. Headless browser and GPU may be unavailable in the cloud; say so rather than claiming verification.

## Working style (from the owner)
- Heavy build work goes to Opus agents; for big make-or-break features write a researched plan first, then implement in milestones.
- Be honest about what cannot be verified by ear or eye; the owner will judge feel by playing.
- Keep `docs/BACKLOG.md` current when something ships or a new idea appears.
- The owner's PC has hit low-memory kills: run heavy jobs (browsers, TTS) one at a time.
- Check `Assets/` (when available) before telling an agent "no external assets".
- Commit messages end with the Co-Authored-By line used in this repo's history.
