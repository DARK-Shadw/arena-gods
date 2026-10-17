# AI v2: research notes and raw diagnosis data

These are the working notes behind `docs/ai-v2-plan.md`. Part A is the measured diagnosis of AI v1. Part B is the literature and industry digest. Anything not confirmed from a primary source is marked UNVERIFIED.

---

## A. Diagnosis of AI v1 (measured 2026-10-18, branch `anim-plan`)

### How it was measured
- **Script:** `tools/ai/_scratch/diag.ts` (scratch, read-only with respect to `src/`). Run it with `npx tsx tools/ai/_scratch/diag.ts <seedsPerPair> <botSeeds>`.
  - It steps `Match` tick by tick with `record:false`.
  - Before each step it snapshots what each fighter can see. After the step it attributes each event to the decision that caused it.
- **Raw outputs:**
  - `tools/ai/_scratch/diag-out-v1threat.json`: the 224-match run plus the bots. Spacing in this file is measured against v1's own `threatRange`.
  - `tools/ai/_scratch/diag-out.json`: the same 224 matches, with spacing measured against the poke-only threat.
  - `tools/ai/_scratch/trace-sample.txt`: a 25-second tick trace of Gorak vs Vex.
- **Sample:** 224 matches (8×7 ordered pairs × 4 seeds), using the same seed formula as `tools/simtest.ts` and a generated arena per seed. That took 24.5 s.
- **Exploit bots:** 240 more mirror matches (3 bots × 8 fighters × 10 seeds), with the bot side alternating between 0 and 1.
- **How the bots work:** a bot drives a fighter between `step()` calls.
  - Before each step it disables that fighter's v1 think and reaction (`ai.nextThink = 1e9`, `pending = queued = null`, `reactedTo = opponent.attackId`).
  - After each step it calls `m.startAttack` / `m.startBlock`.
  - v1 `steer()` still walks the bot, using the goal the bot sets.
- The current balance baseline is `docs/milestones/M4/simtest-40.txt` (2240 matches): mean 69.7 s, 0 timeouts, per-fighter win rates 45.7 to 54.6%, ≥2 swings 54%.

### Headline numbers (224 matches, both fighters v1)
| Metric | Value | What it means on screen |
|---|---|---|
| In-range incoming attacks with **no defensive response** before they land | **56.6%** (6427 / 11347) | They stand there and take it |
| Incoming in-range attacks simply **eaten** | **49.9%** | Slugfest |
| Hits that land on a victim who was **attacking** (windup, active or recovery) | **17.0 per match**, about 47% of the 36 hits per match | Constant trades, no "I saw that coming" |
| Attacks started into the opponent's **windup** | 15.1% of attacks; 53% of those were interrupted, 41% hit | Coin-flip trades, not counters |
| Attacks that end **blocked** | 7.8% | Defence barely exists |
| Order-2 n-gram prediction of a fighter's next move | **20.2%**, vs 22.9% for plain frequency (order 0) | Move choice is i.i.d. noise: no habits, no setups, no sequences |
| Share of move entropy explained by context (gap band × opponent state) | **0.25** (MI / H) | Choice is three-quarters independent of the situation |
| Next attack within 1.5 s after one of my attacks was blocked | plain poke 43%, heavy 25%, ranged 17%, feint 9%, guard-breaker **6%** | No reaction to being blocked |
| Blocked rate, first 30 s vs after | 9.1% → 6.7%; guard-breaker share 4.7% → 4.1% | No visible adaptation (v1's EMA learning has nothing to bite on) |
| Feint followed by a landed hit within 1.2 s | 29% | Feints rarely set anything up |
| `bait` goal share of time | 0.0 to 0.3% for every fighter | Baiting essentially never happens |
| `footsies` goal share of time | 0 to 8% | No neutral game |
| Attacks started on a **knocked-down** opponent | 8.4%; they whiff or are superseded 85% of the time | "Heavy whiff counts look clumsy" |
| Attacks started on a **getting-up** opponent | 8.9%; 22% whiff (into get-up i-frames) | No timed okizeme |
| Heavy whiffs | 19.1% of heavies, **3.5 per match** | Clumsy |
| Attacks started below 25% stamina | **22.7%** | Bad resource play |
| Time spent `exhausted` | **24.4%** of fight time; `winded` 2.2× per fighter per match | Repeatedly gasping for air in front of the opponent |
| Ultimates started in neutral or into a windup or active window | 47% (neutral 26%, windup 13%, active 8%) | Ultimates thrown away |
| Ultimate landed | 60% | |
| Punishable windows (opponent in recovery or stagger, a fast enough move reaches): reaction-feasible ones (≥ 0.3 s spare) taken | **79%** | Punishing works |
| Median punish latency | **0.117 s (7 frames)** | Superhuman: humans need about 15 to 20 frames |
| Median latency of a defensive response | 0.333 s | |
| Time standing still while free (idle or block) | **1%** | Never hesitates, never "reads"; constant shuffling |
| Goal switches | 29 per minute (one every 2 s) | |
| Lulls with no hit, block, parry or dodge for over 4 s | 1.5 per match, 10.8% of fight time | Acceptable |
| Exchanges (hit, block, parry or dodge events) | 40 per minute | |
| Free time inside the opponent's **poke** range | 60% (deep inside 42%) | Phone-booth brawling |

**Per fighter, share of incoming in-range attacks with no response:**

| gorak | aldric | ozrel | erika | vex | fenrik | maw | hollowjack |
|---|---|---|---|---|---|---|---|
| 71% | 45% | 55% | 45% | 42% | 65% | 70% | 63% |

### Exploit bots vs v1 (mirror matches, drama engine ON)
| Bot | Bot win % | Worst cases |
|---|---|---|
| **spam**: always the fastest move in reach, otherwise walk in | **40%** | Vex 10/10, Ozrel 7/10, Erika 6/10 |
| **heavy**: always the biggest-damage move in reach | **47.5%** | Ozrel 8/10, Maw 7/10, Fenrik / Erika / Hollowjack 6/10 |
| **turtle**: block anything incoming, punish recovery, never start an attack | 27.5% | Vex 9/10 |

A one-button bot reaching near-parity is the strongest single sign that v1 does not read its opponent. The drama engine helps the loser, which shrinks every gap, so these numbers flatter v1 if anything.

### Root causes found in `src/sim/ai.ts`
1. **`threatRange()` counts gap-closer lunges.**
   - `ai.ts:133`. It skips only ranged, feint, ultimate and windup > 0.65 moves, so the 'gap' moves set the "measure".
   - Result (`tools/ai/_scratch/threat.ts`):

     | Fighter | v1 threat (m) | Set by | Poke threat (m) |
     |---|---|---|---|
     | Aldric | 5.77 | bulwark_rush | 2.28 |
     | Vex | 5.38 | bat_dive | 1.15 |
     | Fenrik | 5.83 | pounce | 1.93 |
     | Maw | 4.89 | shoulder_barge | 1.68 |
     | Hollowjack | 5.04 | rolling_charge | 1.03 |

   - Every system keyed on `threat` aims at the wrong distance against those five opponents: `footsies`, `bait`, `guard`, `oppPressing`, `steer` (footsies, bait, guard) and the taunt gate.
   - That is why the neutral game and baiting are almost never selected, and why "guard" walks to 5 to 6 m.
   - These gap moves also carry `minRange` 2.4–3.2 m, so they are not a close-range threat at all.
2. **Reaction is a dice roll.**
   - `planReaction` (`ai.ts:329`) notices with probability 0.4 + 0.42 × skill.
   - It then picks from a weighted list that always includes `none` (0.12 + pride × 0.1) and `counter`.
   - The defender knows the exact move at frame 0 of the windup (input reading), yet often does nothing.
   - The result is both unfair and dumb.
3. **The attack decision ignores the opponent's state.**
   - `attackChance` (`ai.ts:743`) is a goal-based probability.
   - `chooseMove` then picks by weighted random over tags, with ±15% noise and a repetition penalty (`pow(0.42.., rep)`). That penalty actively destroys sequences.
   - The only state terms are `q.open`, `o.state === 'block'` (attack chance × 0.5–1) and knockdown.
   - Nothing models "they are winding up, so a trade is bad for me" or "they are about to get up".
4. **No stamina discipline.**
   - Attack gating is `stamina >= move.stamina × 0.6`. `regroup` only wins once stamina is below 30% or the fighter is already exhausted.
5. **Opponent model too coarse.**
   - `OppModel` holds 3 EMA rates (block, dodge, parry) plus heavy, ranged and feint counts.
   - No conditional structure: what they do after a block, after a whiff, at range X, at low HP.
   - No sequences, no per-matchup memory.
6. **The `m.rng` stream is shared with the sim.**
   - Used by `wantsCombo`, `createAIState`, think noise, reactions and so on.
   - Any AI change reshuffles every random number in the match, which makes A/B comparison per seed impossible.
7. **Tick-order asymmetry.**
   - `step()` runs `aiTick(f0)` then `aiTick(f1)` (`match.ts:577`), so f1 sees an attack f0 started in the same tick one tick earlier than f0 would.
   - It is small, but v2's perception buffer should read the previous tick's snapshot for both fighters.

### Cost measurements
- **Plain `Match.step()`** (both AIs, world, projectiles): **6.8–13.5 µs per tick** in Node 22 (two runs on a loaded machine).
- **Whole match:** about 50 ms with `record:true`; the M4 sim test is 2240 matches in 121.7 s.
- **Copy proxy:** a `structuredClone` of the dynamic state (both fighters minus defs, props, obstacles, hazards, projectiles) costs **95–190 µs**.
  - A hand-written field copy should cost a few µs, but that is UNMEASURED.
  - Either way, full-`Match` rollouts at 8 candidates × 3 replies × 45 ticks would cost about 2–4 ms per decision. That is too slow for about 600 decisions per match.
  - So lookahead needs a dedicated light duel model (see the plan, §4.4).
- **The browser simulates the whole match synchronously before playback** (`src/main.ts:270`, logged as `[arena] simulated … in N ms`). The AI budget is therefore a per-match budget: today about 50 ms. The plan's ceiling is 250 ms in Node and must stay well under 1 s in Chromium.

---

## B. Literature and industry digest
(Compiled by a research sub-agent with WebSearch and WebFetch, then condensed. URLs as reported.)

### B1. FightingICE / Fighting Game AI Competition
- **The platform:**
  - 60 FPS, 16.67 ms per frame, about 40 actions.
  - The state is delivered with a **15-frame delay to simulate human reaction time**.
  - Source: 2019 FTGAIC slides, https://www.slideshare.net/ftgaic/2019-fighting-game-ai-competition
- **Sample MCTS budget:** 16.5 ms per decision; strength drops at 11.5 and 6.5 ms. Source: DareFightingICE, https://arxiv.org/pdf/2203.01556
  - UNVERIFIED: UCB C = 3, depth 2, expansion threshold 10, about 60-frame rollouts.
- **Winners:**
  - Thunder line (Eita Aoki): Thunder01 2016, GigaThunder 2017, Thunder 2018, ReiwaThunder 2019 (minimax plus per-character rules), TeraThunder 2020 second, PyThunder 2023/2025.
  - 2020 winner: ERHEA_PI (rolling-horizon evolution plus an opponent model).
  - Deep-RL entries (6 of 14 in 2020) did not win.
  - **Takeaway: hand-tuned shallow search + rules + a good forward simulator wins.**
- **TeraThunder:**
  - Prunes weak moves.
  - **Predicts the opponent's 3 most likely actions and picks the reply with the best probability-weighted outcome.**
  - Source: https://www.slideshare.net/ftgaic/2020-fighting-game-ai-competition
- **RHEA with an opponent model** (Tang et al. 2020, https://arxiv.org/abs/2003.13949):
  - Horizon of **4 actions**, population 7.
  - The opponent model is a one-layer softmax over 18 features (HP, energy, positions, state, distance), trained online between rounds.
  - Win rate with the model vs without: 84.5→89.6%, 69.6→93.1%, 73.4→87.3%.
  - Assuming a random opponent dropped one character to 50.6%.
  - MLP and LSTM models did worse than linear.
  - **Even a tiny opponent model gives a large gain.**
- **Other opponent-model work:**
  - MCTS + action-table opponent model: Kim et al., GIST 2017. Numbers UNVERIFIED.
  - kNN next-action prediction, on the idea that every action has a counter: Ritsumeikan, CIG 2014.
- **Dynamic difficulty and entertainment:**
  - Demediuk et al. CIG 2017: MCTS whose action selection and playout target a zero HP difference. https://opus.lib.uts.edu.au/handle/10453/127485
  - Ishihara et al. CIG 2018: DDA with "believable" behaviour. Internals UNVERIFIED.
  - Ishii et al. CoG 2019: highlight cues for entertaining play.

### B2. Online opponent modelling
- **Killer Instinct Shadow AI** (Iron Galaxy, case-based), https://gamedeveloper.com/programming/the-killer-groove-the-shadow-ai-of-killer-instinct
  - A parser lifts raw inputs to **patterns** (setups, zoning, traps, combos): 400–700 patterns per match, competent after about 3 matches.
  - Retrieval is nearest-neighbour over 40+ **relative** metrics (distance, HP difference) plus the preceding action sequence.
  - It **occasionally picks a lower-ranked action as bait**, and tracks per-action "got punished" rates mid-match.
- **Forza Drivatar:**
  - Per track-segment statistics, with recency weighting.
  - A designer layer damps copied aggression.
  - Rubber-banding is applied to physics, not to the AI.
  - https://www.gamedeveloper.com/design/how-forza-s-drivatar-actually-works
- **Adaptive ghost AI** (Lueangrueangroj & Kotrajaras 2009): online re-weighting of copied moves by contextual success made the AI read as more human and more satisfying.
- **N-gram predictors** (Laramée, *AI Game Programming Wisdom* 2002): cheap and updatable online.
  - Hierarchical n-gram (use the longest context with enough samples) per Millington: UNVERIFIED online.
- **Iocaine Powder** (RoShamBo 1999):
  - History matching plus frequency plus a random fallback.
  - Each predictor is applied at **meta-levels 0/1/2** (guess, second-guess, triple-guess); the one with the best recent score wins.
  - This maps onto Sirlin's observation that yomi needs only about 3 layers.

### B3. Architectures
- **Utility AI / Infinite Axis Utility System** (Dave Mark, GDC 2013/2015, https://gameai.com/iaus.php):
  - Multiplied considerations through response curves, with inertia on the current choice.
  - The exact compensation formula is UNVERIFIED.
- **GOAP** (F.E.A.R.): suited to multi-step goals, not frame-level melee.
- **Halo 3:** moved from FSMs to declarative behaviour, because explicit transitions grow n².
- **For Honor:**
  - Scripted bots took about 4 weeks per hero.
  - Later bots were RL hybrids with **designer action masks** inside behaviour trees.
  - The simulation is deterministic.
  - https://gdcvault.com/play/1035522/Streamlining-Bot-Development-in-For
- **Souls "input reading":** bosses react on animation start. Players still call frame-1 reactions unfair. Forum sources only.
- **Rain World personalities:** Aggression, Bravery, Dominance, Energy, Nervousness, Sympathy, interacting with relationship trackers. Fan wiki.

### B4. Mind games, believability
- **Sirlin yomi:** layer n beats layer n−1, and after about 3 layers it loops.
- **Deceptive Games** (Anderson, Togelius et al. 2018): every tested search agent could be fooled by deception. https://arxiv.org/pdf/1802.00048
- **BotPrize 2012:** the winning bots (about 52% judged human, against 41% for real humans) used **deliberate imperfection**: worse long-range aim and illogical target picks.
- No academic paper found on feints and baits in fighting-game AI. KI's bait-by-lower-ranked-choice is the shipped example.

### B5. Human-like imperfection
- **Reaction times** (community sources):
  - Simple reaction about 16 frames, about 15 when a specific move is expected, 30–40 frames in real mixed situations.
  - Moves faster than about 15 frames cannot be reacted to; they must be predicted.
  - Pros: about 12–19 frames.
- **Dynamic difficulty adjustment (DDA):** players detect it and feel patronised. Hunicke warns that DDA removes designer control.
- **Left 4 Dead director:** "low probability + high drama = memorable" (Booth, GDC). Pacing curves come from fan sources only.

### B6. Nemesis system
- Captains remember encounters, return with new tactics and taunts, become vengeful after a defeat and arrogant after a win.
- **Patent:** US 10,926,179 (issued 2021-02-23, in force to about 2035) and continuation US 11,660,540. The claims cover an NPC hierarchy, ranks and event correspondences.
- **Per-fighter memory alone is less likely to be covered, but a rank-hierarchy-plus-vendetta structure is a legal risk.** This is not legal advice.

### B7. Offline tuning, entertainment fitness
- **MAP-Elites** (Mouret & Clune 2015): one champion per behaviour-grid cell.
  - Used on MCTS agent parameters for diverse play styles in Tribes (Perez-Liebana et al. 2021).
- **Browne's Ludi:** 57 aesthetic measures from self-play, including drama (the trailing player can still win) and lead changes (neither too few nor too many).
- **Iida's game refinement:** comfortable outcome uncertainty is around GR 0.07–0.08.
- Plain win-optimisation finds efficient, uncinematic play, which `docs/vision.md` already rejects.

### B8. Spectator readability
- **Saltybet / MUGEN AI-vs-AI betting** (Summerley & McDonald 2024): viewers bet on known AI personalities and enjoy their blunders.
- **Design consensus** (no authoritative single source):
  - Distinct windups for lethal attacks.
  - Consistent tells.
  - Fake-outs that punish panic.

### B9. What this means for a deterministic, frame-based browser sim (summary)
1. Use shallow, pruned, deterministic lookahead against the **top-3 predicted opponent replies**, on a **cheap dedicated forward model**. Use fixed node counts, never wall-clock budgets.
2. Use a small online opponent model, hierarchical n-gram over **abstracted** actions with context keys, plus Iocaine-style meta-levels (0–2) chosen by recent accuracy.
3. Put a utility layer on top for personality and tactic choice (multiplied considerations, inertia). Search only chooses the concrete move inside the chosen tactic.
4. Use explicit human limits: perception delay of 12–25 frames, reacting only to animation onset, a misread rate, and anticipation (guessing) for fast moves.
5. Make bait, feint and conditioning first-class tactics. Use a deliberate lower-ranked bait in the KI style.
6. Model tilt and confidence as AI state. Prefer in-fiction behavioural comebacks to hidden damage scaling.
7. Keep per-rival memory between matches, as inputs to the deterministic sim. Avoid the patented hierarchy and vendetta structure.
8. Tune offline by CMA-ES or GA plus MAP-Elites, against an entertainment fitness function.
