# Animation overhaul: handoff (checkpoint before shutdown)

Branch: `anim-plan`. Nothing is merged to main. `npm run build` passes (tsc + vite). `npm run sim:test` passes: in the 40-seed run below, win rates are 45.4-55.0%, there are 0 timeouts, 0 kills without contact, and the determinism check holds.

## Done and committed
- **M0 (a390f42): shared animation library and Animation Lab.**
  - Library: `tools/anim/build-lib.ts` → `public/anim/*` and `src/sim/anim.gen.ts`.
  - Lab: `tools/animlab/` at `http://localhost:5173/tools/animlab/`.
- **M1 (051f075): pose pipeline.** Inertialization, spring flinch (asymmetric hit-stop), locomotion sync groups, foot-lock IK. Code is in `src/render/poseFx.ts`; metrics are in `docs/milestones/M1/`.
- **M2 (a3e7a83): variety and launches.**
  - The sim picks reaction, fall, get-up, death and dodge clips (`src/sim/animSelect.ts`) and drives launches (`src/sim/launch.ts`).
  - Metrics are in `docs/milestones/M2/`.

## In the WIP snapshot (e8c8fc1 + this commit): M3/M4, working but not signed off

**M3: arena-aware entrances**
- Gate anchors live in each `dress*.ts` builder. `makeGate` in `common.ts` converts them, and `snapAnchors` in `cinematic/entrance.ts` snaps them to the built geometry.
- Beat entrances (`cinematic/beats.ts`, `data/entranceVariants.ts`) now cover all 8 fighters:
  - Gorak cage breaker: the barrier breaks on the axe's contact frame.
  - Vex: perch drop, rim climb or shadow rise.
  - Hollowjack: stands leap, fence vault or gate burst.
- Barrier shake/break, slow-mo and shadow-pool FX are in `entrance.ts`.
- Validator: `cinematic/validateEntrances.ts`, run with `__arena.validateEntrances({})`.
  - The last finished full run used older code: about 730 configs, many failing. Failures are listed in `tools/anim/_scratch/validate_all.json`, which is gitignored scratch.
  - Fixes applied after that run, which still need a re-run:
    - anchor snapping
    - camera line-of-sight orbit
    - the other 5 fighters converted to beat specs
  - A second run against a build snapshot was in progress at shutdown. Its result is lost.

**M4: finishers**
- Sim: `src/sim/finishers.ts` plus finisher logic in `match.ts` (`tryFinisher`, `startFinisher`, `tickFinisher`).
- Scene data: `tools/anim/scenes.ts` → `src/sim/scenes.gen.ts`.
- The finishers are:
  - shoulder throw + stomp
  - hell slammer
  - vampire's kiss
  - silent blade
  - executioner (finishes a downed victim)
  - curb stomp
  - into the fire (a launch into a hazard)
  - immolation (spell)
- Rockin' Shackle was dropped: the clip has no measurable body contact.
- They fire on about 26% of kills, and kills still land on contact frames.
- Render:
  - `contactWarp.ts` pulls the bodies into contact around each contact frame.
  - FighterView has a `scene` state.
  - The director has finisher, cut-in and launch shots, a 0.35 s freeze, speed lines, shot scoring, contact-aware re-picks and killcam side choice.
  - `cameraRig` avoids camera positions where one fighter stands directly behind the other.
- FX in `render/finisherFx.ts`: bisect, behead, burn, shatter, dissolve and drain. The gore menu option defaults to off, and the URL also accepts `?gore=`.
  - Clean behead: gorak, aldric, vex, fenrik, hollowjack.
  - Not clean: ozrel and erika (the hood stays on the body) and maw (head is fused to the shoulders). These fall back to bisect.
- Camera audit (`camera/cameraAudit.ts`, run with `__arena.cameraAudit([...])`) over 8 matches:
  - 94.6% of frames readable; 96.3% of contacts visible; 21.6 cuts/min.
  - Proposed targets: at least 93% readable, at least 95% of contacts visible, at most 25 cuts/min.
  - The cross layouts are the weakest: 88-91%.
- Paired-contact audit (`render/pairAudit.ts`, run with `__arena.pairAudit`), 40 matches:
  - Kill contacts: 39 of 40 within 0.12 m. The one miss is an executioner at 0.157 m.
  - Damage contacts during scenes: 57 of 76 within 0.12 m overall. Hits alone are only 18 of 36, with up to 0.31 m (shoulder throw, silent blade).
- Debug:
  - `?t=SECONDS` jumps to that moment.
  - The B key copies a URL that reproduces the current camera moment.

## Known failing / not verified
- **Entrance validator:** not re-run on the final code. Expect remaining issues:
  - Colosseum oval and gauntlet stands/perch support (snapping is meant to fix this).
  - Cameras in cross layouts.
- **Finisher visuals:** checked only in Vampire's Kiss captures and in the lab FX shots. The other finishers have not been looked at in game.
- **Into the fire:** rare, 5 in 560 kills.
- **Foot skating:** halved, not solved (ratio about 0.45).
- **Getting sim data out of the browser:** the Lab and audits all run against the dev server. `eval.cjs` has `--dist=<dir>` so a build can be used while editing.
- **Docs:** `docs/milestones/M3` and `M4` READMEs and contact sheets are not written yet. `docs/animation-plan.md` has not been updated with the deviations (shared-library approach instead of converter v2; Rockin' Shackle replaced by Immolation; contact warp).

## Next steps (commands)
1. `npm run dev` on :5173.
2. Re-validate entrances. This takes about 40 minutes; to avoid HMR reloads, run it against a build:
   ```
   npx vite build --outDir tools/anim/_scratch/dist_m3
   node tools/shots/eval.cjs "/index.html?manual=1" "__arena.validateEntrances({})" --dist=tools/anim/_scratch/dist_m3 --out=tools/anim/_scratch/validate.json
   ```
   Fix the failures, then write `docs/milestones/M3/` (sheets via `tools/shots/moments.cjs`).
3. Finisher captures, one per finisher. Example ids (a b seed theme layout aseed start-t) come from `npx tsx tools/anim/_scratch/finstats.ts 10`:
   ```
   node tools/shots/moments.cjs out "a=..&b=..&seed=..&theme=..&layout=..&aseed=.." <t> --step=11 --dt=0.3
   ```
   Lab FX sheet: `node tools/shots/fxshots.cjs out`.
4. Re-run the audits:
   - `node tools/shots/eval.cjs "/index.html?manual=1" "$(cat tools/anim/_scratch/camaudit.expr)"` (camera)
   - `__arena.pairAudit(...)` (contacts)
   - `__arena.animAudit(...)` (pops / feet)
   - `__arena.audit(...)` (phantom hits)
   - `npm run sim:test -- 40`
   - `npx tsx tools/anim/repetition.ts 4`
5. Write the M3/M4 milestone docs, update the plan with the deviations, commit and push.

## Scratch (gitignored, `tools/anim/_scratch/`)
- `finstats.ts`: finisher frequency and example seeds.
- `events.ts`, `findbg.ts`: event dumps.
- `camaudit.expr`: the 8-match camera audit expression.
- `finlist.txt`: pair-audit match list.
- `validate_all.json`: the old validator run.
- `patch_*.py`: patches already applied, kept for reference.
- `shotsS`, `fx`, `fin1`: captures.
