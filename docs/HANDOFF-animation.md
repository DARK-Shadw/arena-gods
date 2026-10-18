# Animation overhaul: status

Branch: `anim-plan`. M0 to M4 are **complete** and pushed. Nothing is merged to main; that waits for the owner to play the branch and judge the feel.

- `npm run build` passes.
- `npm run sim:test -- 40`: win rates 45.7 to 54.6%, 0 timeouts, 0/2240 kills without contact, determinism true.

## Where things are
- **M0: shared animation library and lab.** `tools/anim/build-lib.ts` builds `public/anim/*` and `src/sim/anim.gen.ts`. The lab runs at `http://localhost:5173/tools/animlab/`.
- **M1: pose pipeline** (`src/render/poseFx.ts`). Inertializer, spring flinch, phase matching and sync group, foot lock, `solveTwoBone`.
  - Each frame starts from the mixer's previous output (`character.ts`), because three.js only writes changed values.
- **M2: variety and launches.** `src/sim/animSelect.ts`, `src/sim/launch.ts`.
- **M3: entrances.** Anchors are declared in `src/render/arena/dress*.ts` and snapped by `snapAnchors` in `src/cinematic/entrance.ts`. Beat specs are in `src/data/entranceVariants.ts`. Validator: `src/cinematic/validateEntrances.ts`.
- **M4: finishers.**
  - Sim logic: `src/sim/finishers.ts` and `match.ts` (tryFinisher / tickFinisher).
  - Scene data: `tools/anim/scenes.ts` generates `src/sim/scenes.gen.ts`.
  - Render: contact warp and IK in `src/render/contactWarp.ts`; FX in `src/render/finisherFx.ts`.
  - Camera: `src/camera/director.ts`, with the audit in `cameraAudit.ts`.

## Audits (browser console or `node tools/shots/eval.cjs "/index.html?manual=1" "<expr>"`)
- `__arena.validateEntrances({})`: every fighter, theme, layout and gate, about 70 minutes. For long runs, use a build snapshot: `npx vite build --outDir tools/anim/_scratch/dist_v`, then `eval.cjs ... --dist=tools/anim/_scratch/dist_v`.
- `__arena.pairAudit([[a,b,seed,theme,layout,aseed],...])`: distance from the effector to the body at each finisher contact.
- `__arena.cameraAudit([...])`: readability. Randomness is seeded, so runs are repeatable.
- `__arena.animAudit(pairs, seeds, opts)`: pops and foot skate, with a skate breakdown.
- Captures:
  - `tools/shots/moments.cjs` (match moments, `--step --dt --cam=side`)
  - `shots.cjs --intro=` (entrances)
  - `fxshots.cjs` (FX in the lab)
  - `tile.py` (sheets)
  - `eval.cjs --shot=file.png` (screenshot after an expression)

## Next (see `docs/BACKLOG.md`, known issues)
- **Stride-matched locomotion**, for the remaining foot skate.
- Cross-layout camera readability, toward 95%.
- M5 and later in `docs/animation-plan.md`.

Run heavy jobs (browsers, audits) one at a time. This PC has hit low-memory kills.
