# AI v2 plan: fighters that read, bait and adapt

Status: plan only (2026-10-18, branch `anim-plan`). Nothing in `src/` has changed.

- Evidence and sources: `docs/ai-v2-research.md`.
- Diagnosis script: `tools/ai/_scratch/diag.ts`.
- v1 design notes: `docs/ai-design.md`.

**Owner goal:** the fighters should look like intelligent beings. They read the opponent, bait, condition, punish, space, manage resources, use the arena, adapt during a fight and have distinct personalities. They stay readable and dramatic for a spectator.

**Hard constraints (unchanged):**
- The sim is deterministic: same seed gives the same fight in Node and Chromium, using `dmath` and seeded RNGs only. No wall clock and no `Math.random` in decisions.
- `npm run sim:test -- 40` keeps:
  - per-fighter win rates of 45–55%
  - 0 timeouts
  - 0 kills without contact
  - determinism OK
- Fights stay about 60–70 s.
- The browser simulates the whole match before playback (`src/main.ts:270`), so AI cost is paid as load time.

---

## 1. Diagnosis: why v1 looks basic (ranked by impact on perceived intelligence)

Measured on 224 v1-vs-v1 matches plus 240 exploit-bot matches; full tables are in `ai-v2-research.md` §A.

| # | Weakness | Evidence | What the viewer sees |
|---|---|---|---|
| 1 | **They do not defend; fights are trade-fests** | **57%** of in-range incoming attacks get no response and 50% are simply eaten. **17 of 36 hits per match** land on a victim who was attacking. Only 7.8% of attacks are blocked. 15% of attacks start into the opponent's windup, a coin flip. | Two bodies swinging into each other; nobody looks like they saw anything coming |
| 2 | **Choices ignore the situation and form no sequences** | Order-2 n-gram prediction 20.2%, *below* plain frequency (22.9%). Context (gap × opponent state) explains only 25% of move entropy. After being blocked, a guard-breaker follows only 6% of the time. | Random, not intentional; no setups, no "he's figured her out" |
| 3 | **Exploitable by one-button bots** | Mirror matches, bot win rate: always-fastest-move **40%** (Vex bot 10/10), always-heaviest-move **47.5%** (Ozrel 8/10, Maw 7/10), turtle 27.5% (Vex 9/10) | Spam works, so the AI clearly is not reading |
| 4 | **The neutral game is broken by a spacing bug** | `threatRange()` (`ai.ts:133`) includes gap-closer lunges, so the "measure" is 5–6 m instead of 1–2.3 m for Aldric, Vex, Fenrik, Maw and Hollowjack. `footsies` 0–8% of time, `bait` ≤ 0.3%. 60% of free time is inside the opponent's poke range. | No footsies, no baiting, phone-booth brawling; "guard" holds at 5 m |
| 5 | **Bad resource play** | 22.7% of attacks start below 25% stamina. Exhausted **24%** of the fight, winded 2.2× per fighter per match. 47% of ultimates are started in neutral or into the opponent's windup or active window. | Gasping in front of the enemy; wasted ultimates |
| 6 | **Clumsy commitment** | 17% of attacks aim at a downed or rising opponent (85% of attacks on downed opponents miss or are superseded; 22% of attacks on rising ones whiff into i-frames). 3.5 heavy whiffs per match. | "Heavy whiff counts look clumsy" (BACKLOG known issue) |
| 7 | **No adaptation within a fight** | Blocked rate 9.1% → 6.7% and guard-breaker share 4.7% → 4.1% from the first 30 s to the rest. The EMA model has 3 rates and no conditional structure. | The fight at 60 s looks like the fight at 10 s |
| 8 | **Robotic tempo: superhuman reflexes, no hesitation** | Median punish latency **0.117 s (7 frames)**, while humans manage 15–20. Standing still 1% of free time. Goal switches every 2 s. | Twitchy and machine-like; never "sizing up" |
| 9 | **Known issues still open** | Kiters in band about 35%, cover 0.6–1 s per match, cornered escape 39–49% (M4 sim test) | Kiters walk into melee |

Things v1 already does well, worth keeping:
- Punishing a feasible window: **79%** taken, and 87% of those punishes land.
- Contact-true reach.
- The arena-tactics layer.
- Drama pacing: lulls only 11% of fight time.

---

## 2. Research verdict (what actually works here)

Full digest with URLs: `ai-v2-research.md` §B.

1. **Shallow, pruned lookahead against the opponent's top 3 predicted replies**, on a cheap forward model.
   - This is the TeraThunder / ReiwaThunder recipe that won FightingICE most years. Deep MCTS and deep RL did not beat it.
   - Fixed node counts keep it deterministic.
2. **A small online opponent model gives most of the gain.** A linear model took RHEA from 70% to 93% in one case.
   - Use hierarchical n-grams over abstracted actions, with context keys and decay.
   - Add Iocaine-style meta-levels 0/1/2, chosen by recent accuracy. Sirlin's yomi layers loop after about 3.
3. **A utility layer for tactics and personality** (Infinite Axis Utility System: multiplied considerations plus inertia), with search *inside* the chosen tactic.
4. **Human limits made explicit:**
   - 15-frame perception delay (FightingICE convention, about human reaction).
   - React only to animation onset.
   - Guess on moves too fast to react to.
   - Deliberate misreads. Imperfection is what won BotPrize.
5. **Bait as a lower-ranked deliberate choice** (Killer Instinct Shadow AI), and **conditioning**: repeat a pattern until the model sees the opponent adapt, then switch.
6. **Tilt and confidence as AI state** are in-fiction. Hidden damage rubber-banding gets noticed.
7. **Rival memory as match inputs** (Nemesis-lite). Avoid the patented hierarchy and vendetta structure (US 10,926,179).
8. **Offline tuning:** CMA-ES or a GA plus MAP-Elites, with an entertainment fitness function, not win rate alone (`docs/vision.md`).

---

## 3. What to keep from v1, what to replace

| v1 piece (`src/sim/ai.ts`) | v2 |
|---|---|
| `reachOf`, `edgeReach`, `moveReach` (animation-true reach) | **Keep.** Precompute per (fighter, move) into a `MoveFacts` table |
| `threatRange` | **Replace** with `pokeThreat`, `lungeThreat` (only beyond `minRange`) and `rangedThreat` |
| `planReaction` dice roll (`ai.ts:329`) | **Replace** with perception buffer → anticipation → reaction decision (§4.2) |
| `OppModel` EMA rates | **Replace** with `OpponentModel` (§4.3). The rates survive as a coarse layer |
| `scoreGoals` 14 goals + `attackChance` + `chooseMove` | **Replace** with tactic selection (utility) + move choice by lookahead (§4.5, §4.4) |
| `steer()` primitives: retreat dir, cut-off, zig-zag, hazard and pillar avoidance, bridge routing | **Keep**, exposed as `Footwork` functions that tactics call |
| Arena tactics: `grab`, `smash`, barrel, cover, `carryTick`, `dodgeProjectiles`, `safeToLift` | **Keep.** Rewrap as tactics with the same internals. The arena-tactics switch stays |
| `wantsCombo` (called from `match.ts:660`) | **Keep the hook**; the decision moves to the tactic: confirm on hit, frame-trap or stop on block, using the model |
| Timing mix-up (`queued` delay) | **Keep the idea**, now model-driven (delay to beat a predicted mash or a predicted button) |
| Human mistakes: misjudged spacing, greed, panic | **Keep**, now driven by the Mind state (§4.7) |
| `m.rng` for AI randomness | **Replace** with a per-fighter AI `Rng` stream (§4.1) |
| Doctrine (`doctrine.ts`) + Personality (`types.ts`) | **Keep as data**, mapped into a `Genome` (§4.6) |

---

## 4. Architecture

```
  match.ts step()  ── for each fighter ──►  aiTick(m, f, o)   (src/sim/ai/index.ts; ai.ts becomes a re-export)
        │
  ①  PERCEPTION     Percept ring buffer: what o was doing D frames ago (D = reaction delay ± noise).
        │           Threat assessment from MoveFacts: what o CAN do next and when (frame data).
  ②  OPPONENT MODEL Abstracted action tokens → hierarchical n-gram + context tables + response tables,
        │           Iocaine meta-levels; seeded from RivalMemory (between matches).
  ③  MIND           confidence, tilt, fear, focus, read-streak (fast emotional state, decays).
  ④  TACTIC LAYER   utility over ~14 tactics × Genome × Mind × model; inertia; each tactic is a tiny
        │           state machine (bait, condition, frame-trap, footsies, okizeme, kite, cover, …).
  ⑤  ACTION CHOICE  candidate actions proposed by the tactic (≤ 8) → expectimax lookahead on the
        │           DuelModel vs the model's top-3 opponent replies → seeded softmax pick (temperature from Genome/Mind).
  ⑥  REACTION       every tick, gated by perception: block / parry / dodge / backstep / counter / guess,
        │           with anticipation (pre-block, whiff-bait) from the model.
  ⑦  FOOTWORK       v1 steer primitives, parameterised by the tactic's spacing band.
  ⑧  INTENT OUT     sim events: ai_intent / ai_read / ai_tell / ai_hesitate (camera, HUD, audio, voice).
```

**Decision points** (replacing v1's random 0.14–0.3 s think timer):
- the fighter becomes actionable
- a perceived opponent phase change: attack start seen, recovery seen, whiff, block, stagger, get-up
- a tactic's own timer
- a neutral cadence of every 6–10 frames, set by the Genome's `tempo`

Between decision points only the cheap per-tick work runs: perception push, reaction check and footwork.

### 4.1 Determinism and RNG

- **AI streams:** each fighter gets `aiRng = new Rng(hashSeed(seed) ^ 0xA1A1 ^ (idx * 0x9E37))`. This follows the `AnimSelector` precedent in `animSelect.ts:73`.
  - `createAIState` and every AI roll move off `m.rng`.
  - From then on, AI changes no longer reshuffle sim randomness (combo rolls, launches), so A/B tests compare like with like.
- **`wantsCombo`** still uses `m.rng` until AI3. After that the decision is made by the tactic using `aiRng`.
- **Search rules:**
  - Fixed node counts per decision, never time.
  - Search the candidates in a fixed order.
  - Break ties by candidate index.
  - Only `dmath` functions (`sin`, `cos`, `atan2`, `hypot`, `exp`, `pow`).
  - No `Map` iteration over insertion-order-dependent keys built from floats.
- **Symmetric perception:** both fighters read `Percept` snapshots pushed at the **end** of the previous tick. This removes the f0/f1 asymmetry (§A in the research notes).
- **Rival memory** is an *input* to `new Match(…, { memory })`. It is serialised with the `MatchRecord` (version field), so replays reproduce.

### 4.2 Perception and threat assessment (`src/sim/ai/perception.ts`)

```ts
interface Percept {            // pushed once per tick per fighter, ring buffer of 32
  t: number; x: number; z: number; facing: number;
  state: FState; moveId: string | null; phase: -1|0|1|2; phaseT: number; // what the body shows
  hp: number; stam: number; fury: number; exhausted: boolean; carry: boolean;
}
interface MoveFacts {          // precomputed once per (fighter, move) from fighters.ts + reach.ts
  reach: number; lungeReach: number; minRange: number; windup: number; active: number; recovery: number;
  ranged: boolean; projSpeed: number; armor: boolean; unblockable: boolean; knockdown: boolean;
  safeOnBlock: number;   // recovery − fastest punisher windup of the typical opponent (+ = safe)
  tags: Set<string>; damage: number; stamina: number;
}
interface Threat {             // what the opponent can do to me in the next ~0.8 s
  canHitNowBy: number;         // earliest contact time over their usable moves at the current gap
  worstMove: string;           // move with the best (damage × reach fit) for them
  pokeThreat: number; lungeThreat: number; rangedThreat: number;
  actionableIn: number;        // seconds until they can act (recovery / stagger / get-up / i-frames)
  vulnerableIn: number;        // e.g. get-up i-frames end (match.ts:554: 55% of stateDur)
}
```

- **Reaction delay** `D` (frames):
  - Base: `genome.reactionFrames`, 12–22. For the current 8 it is derived from `stats.reaction` (0.2–0.32 s), so 12–19.
  - Gaussian jitter (σ = 2 frames).
  - Plus 0 to +6 frames from Mind stress (tilt, exhaustion, multiple threats).
  - The AI sees `buffer[now − D]`.
  - **The move identity is visible only after `D`.** Before that the AI knows only that it is still idle, as far as it can see. This removes v1's frame-0 input reading.
- **Tells (perception side):**
  - Heavy, ultimate and windup ≥ 0.6 moves are "big telegraphs": D − 3 frames.
  - The same move seen 4+ times this fight: D − 2 frames (familiarity).
  - A feint looks like its real counterpart: same clip (see `movesets.md`, e.g. Axe Feint ← downward).
- **Threat** is recomputed only at decision points, from the perceived state and `MoveFacts`. Cost is O(moves) ≈ 12, with no allocation.

### 4.3 Opponent model (`src/sim/ai/oppModel.ts`)

**Abstracted action alphabet** (~14 tokens, so counts stay dense): `POKE`, `HEAVY`, `GAP`, `RANGED`, `FEINT`, `COUNTER`, `GRAB_PROP`, `BLOCK`, `PARRY`, `DODGE`, `BACKSTEP`, `ADVANCE`, `RETREAT`, `WAIT` (no action in 0.6 s).

**Context key** (≈ 4 × 5 × 3 = 60 cells):
- gap band relative to *their* poke threat: inside / edge / mid / far
- previous event: after-their-block, after-their-whiff, after-being-hit, after-hitting, neutral
- their HP band

```ts
interface OpponentModel {
  // decayed counts (Float32Array, no allocation): next token given context
  ctx: Float32Array;        // [ctxKey × 14]
  ngram1: Float32Array;     // [14 × 14]       last token → next
  ngram2: Float32Array;     // [14×14 × 14]    last two → next (sparse use, decays)
  // what they DO when I do X (defensive habits): response tables
  resp: Float32Array;       // [myToken(8) × theirResponse(6: block, parry, dodge, backstep, mash, nothing)]
  // per-move punished rate for MY moves vs this opponent (Killer Instinct shadow-style)
  myMovePunished: Float32Array; myMoveUsed: Float32Array;
  meta: { acc: [number, number, number]; }  // Iocaine: decayed accuracy of level 0/1/2 predictions
  decay: number;            // 0.92–0.98 per observation (Genome.adaptability)
}
predictNext(ctx): { probs: Float32Array(14), confidence }   // longest context with ≥ k samples, Laplace α = 0.5
```

- **Updates:** on each perceived opponent action (after the perception delay), multiply by decay, then add the new count.
- **Meta-levels (Iocaine):**
  - Level 0 predicts their next token.
  - Level 1 assumes they predict *my* habit (from a mirror model of myself that the fighter keeps on its own stream) and pick its counter.
  - Level 2 is the counter to that.
  - Each level tracks decayed accuracy. `Genome.yomi` (0–2) caps the deepest level a personality may use. Brutes use 0, Vex and Aldric up to 2.
- **Per-matchup memory:** `RivalMemory` = the `ctx` and `resp` tables plus `myMovePunished` and a few scalars (wins, losses, last result, grudge). They are loaded into the model at match start with a trust weight of 0.3–0.6, so a veteran starts the fight already leaning on what it knows. This is the hook for `vision.md` "A veteran truly knows how you fight".
- **Size and cost:** about 3 KB per rival; a predict call is about 14 multiplies per level. Negligible.

### 4.4 DuelModel: the forward model for lookahead (`src/sim/ai/duel.ts`)

Full `Match` rollouts are too expensive: `structuredClone` of the dynamic state measured 95–190 µs, and a step costs 7–13 µs, so 24 rollouts × 45 ticks is about 8 ms per decision.

v2 instead uses a **dedicated 2-fighter model** built from the same data:

```ts
// state as a flat Float64Array(32): copy = 32 numbers, no allocation (preallocated pool of 64 states)
// per fighter: pos along the line (1D gap) + lateral offset, state code, stateT, stateDur, move index,
//              hp, stamina, fury-ready flag, blockUntil, invuln window
// events out: firstContactT, damageTo[0/1], blocked, whiffed, staggerTo, knockdown, endGap
step(s, dt=1/30)          // 30 Hz inside the model: half the work, timings rounded to 2 frames
apply(s, side, action)     // start move / block(until) / dodge(dir) / step(dx) / wait
```

**What it models:**
- Gap kinematics: walk speed, backpedal at 0.8× (as `match.ts:739`), lunge travel during windup (as `match.ts:782`), knockback.
- Windup, active and recovery; armor; feint cancel at 62%.
- Block with chip, parry window, dodge i-frames 0.03–0.34 s.
- Stagger durations from `MoveFacts`.
- Contact: gap ≤ move reach at an active tick. No capsule sweep; the full sim keeps exact geometry.

**What it ignores:** arena geometry, props and projectile flight. Projectiles are approximated as `gap / speed` arrival.

**Validation (part of milestone AI4):**
- Predict first contact and its outcome for 5,000 sampled decision points from real matches.
- Compare with what the full sim produced.
- Acceptance: outcome class (hit, blocked, whiff, traded) agrees ≥ 85%, contact time error ≤ 2 frames median.

Projected cost per model tick (UNMEASURED): about 0.2–0.4 µs.

### 4.5 Tactic layer and action choice

**Tactics** (each a small state machine with `enter`, `tick`, `propose` and `done`), in `src/sim/ai/tactics/*.ts`:

| Tactic | What it does (mind-game content) | Exits when |
|---|---|---|
| `footsies` | Hold the edge of *their* poke range (fixed threat), dip in and out. Poke when the model says they will step in; otherwise whiff-punish their pokes | 3–6 s, or a hit, or a model shift |
| `whiffBait` | Step into their range on purpose and backstep or dodge on the predicted poke, then punish the recovery | The bait is taken (punish) or ignored twice |
| `pressure` | Plus-frame strings. On block, continue only with moves that are safe on block or are guard-breakers. Insert a **frame trap** (delayed second hit) if the model predicts "mash after block" | Their counter-hit, low stamina, or the planned length is reached |
| `condition` | Repeat pattern A (e.g. jab → stop) 2–4 times while the response table shows them answering it the same way, then switch to B, which beats that answer (jab → pause → guard-breaker, or a feint → punish) | After the switch, win or lose |
| `feintPunish` | Feint into the predicted reaction: they block → guard-break; they dodge → wait out the i-frames → punish; they mash → punish the recovery | One attempt |
| `disengage` | Reset to mid range; regenerate stamina; cover the retreat with an anti-rush move | Stamina ≥ the Genome threshold, or they chase (→ `antiRush`) |
| `antiRush` | Expect their gap-closer at its `minRange`; space for its whiff, then punish (Vex's `bat_dive` 0.4 s windup) | |
| `okizeme` | Opponent down: walk to the getup spot, time a **meaty** attack to land as `isInvulnerable` ends (`match.ts:554`), or bait the get-up reversal | Get-up resolved |
| `cornerTrap` | Cut off the ring (v1 `pressure` steer), deny escape lanes, punish their escape attempts (model: dodge vs block when cornered) | They escape or are hit |
| `escape` | Cornered: v1 wall slide + an escape tool chosen by the model (dodge if they press with heavies, block if pokes) | |
| `kite` / `zone` | Ranged roles hold the band. Shoot when the line is clear and their predicted approach is a walk-in. **Retreat before** the band is breached (anticipate by their `lungeThreat`) | |
| `cover` / `arena` | v1 cover, grab, smash, barrel and hazard-bait rewrapped. Hazard bait = position so the opponent's knockback line ends in a hazard (`backHazard`) | |
| `finish` | Low HP: prefer kill blows that make good endings (a knockdown move when a downed finisher fits; `finishers.ts`, `match.ts:1321`). Keep ultimates for a landing window | |
| `showboat` | Taunt or hesitate only when safe (their `actionableIn` > 1.2 s or gap > lungeThreat + 1) | |

**Tactic selection (utility, Infinite Axis Utility System style):**

`U(tactic) = Π considerations(curve(x)) × genomeWeight × mindMod + inertia (+0.3 while committed) + aiRng·ε`

Considerations include:
- gap vs band
- my and their stamina
- HP lead
- model confidence (e.g. `condition` needs an established response pattern)
- their predicted aggression
- cornered state
- whether they are ranged
- fury ready
- tension (drama)
- time remaining

Pick the top tactic. With probability `genome.baitFreq × mind.confidence` take the 2nd-ranked one as a bait (Killer Instinct style).

**Action choice inside a tactic (expectimax-lite):**

```
cands  = tactic.propose(state)                 // ≤ 8: concrete moves, wait(k), step-in/out, block(t), dodge(dir), feint
replies= model.top3(ctx, level=meta.best)      // each with probability p_j; plus 'nothing' (≥ 0.1 mass)
for c in cands:                                 // fixed order
  for (r, p) in replies:
     s = duel.copy(now); duel.apply(s, me, c); duel.apply(s, opp, r at predicted delay)
     roll 0.6–0.8 s at 30 Hz (18–24 model ticks), then a 1-ply "best follow-up" for me (≤ 3 options)
     v += p * score(s)                           // damage diff, stamina, position (corner, hazard), safety
  value[c] = v − risk(c) * genome.riskAversion   // risk = variance across replies (fear of the bad branch)
pick = softmax(value / T) with aiRng            // T from Genome.discipline (low T) and Mind.tilt (high T)
```

**Budget:**
- 8 candidates × 4 replies × (24 + 3 × 12) model ticks ≈ 1,900 model ticks ≈ **0.4–0.8 ms per decision** (UNMEASURED).
- Only about 30% of decision points need search: neutral, a pressure branch, or a reaction with ≥ 2 viable options. The rest are rule-decided: hard punishes and okizeme timing.
- Target: **≤ 0.3 ms mean, ≤ 2 ms p99 per decision, ≤ 250 ms AI time per match in Node.**
- A hard cap of 2,500 model ticks per decision, enforced by a counter, keeps it deterministic.

**Reaction layer** (every tick, on perceived information only):
- An incoming attack becomes visible at D. Compute `timeToContact`, then decide among block, parry, dodge, backstep, counter, or eat it:
  - by the expected value from `MoveFacts` (safe-on-block, armor, unblockable),
  - with the model's feint probability (`resp`/`ctx`) discounting commitment,
  - with Mind.
- **Anticipation:** if `predictNext` puts ≥ 0.45 on `HEAVY` or `GAP` and its contact would arrive before D allows a reaction, the fighter may **guess**: pre-block or pre-backstep with probability ∝ `genome.yomi × confidence`.
  - A correct guess becomes a visible "read" (`ai_read` event).
  - A wrong guess is a natural, human-looking mistake.
- **Punish speed:** a punish fires at D, not at frame 7. Median punish latency should become about 0.25–0.33 s. Same punish rate, now human.

### 4.6 Personality: one engine, many genomes (`src/sim/ai/genome.ts`)

```ts
interface Genome {             // all 0..1 unless noted; evolvable; serialisable (vision.md "genome")
  aggression: number; patience: number; risk: number;        // risk = 1 - riskAversion
  baitFreq: number; discipline: number;                       // discipline: low softmax T, respects stamina rules
  arrogance: number;          // complacency when ahead, taunts, saves ultimate (was pride)
  adaptability: number;       // model decay + trust in model
  yomi: 0 | 1 | 2;            // max meta-level
  reactionFrames: number;     // 12..22
  composure: number;          // tilt resistance (was desperation/caution mix)
  comboGreed: number; staminaFloor: number;                   // resource style
  bandBias: number;           // shifts doctrine band (m, ±0.6)
  envCunning: number; propLove: number; coverLove: number;    // from doctrine.ts
  showmanship: number;        // taunts, hesitation beats, finisher preference
  tempo: number;              // neutral cadence 6..10 frames
}
genomeFromLegacy(def: FighterDef, doc: Doctrine): Genome     // current 8 fighters map 1:1, no data edits needed
```

- `Doctrine.role` and `band` remain the **style family**: which tactics are available and their base weights. The genome tunes inside the family.
- `docs/vision.md`'s genome (aggression, patience, risk, bait frequency, combo preference, doctrine) is a subset, so evolved fighters plug in by supplying a `Genome` instead of the legacy mapping.
- Seed personalities for the current 8 (by intent, before tuning):
  - **Gorak:** arrogant, yomi 0, low discipline, comboGreed high.
  - **Aldric:** patient, yomi 2, discipline high, conditions with blocks and parries.
  - **Vex:** baitFreq high, yomi 2, showmanship.
  - **Fenrik:** aggression 0.95, yomi 0, composure low.
  - **Maw:** risk high, armor-trusting, patience low.
  - **Erika:** discipline high, kite-first, yomi 1.
  - **Ozrel:** zone-and-punish, yomi 1, arrogance mid.
  - **Hollowjack:** frame-trap pressure, yomi 1.

### 4.7 Mind: imperfection, tilt and confidence (`src/sim/ai/mind.ts`)

```ts
interface Mind { confidence: number; tilt: number; fear: number; focus: number; readStreak: number; }
```

**Event-driven updates** (decaying with a half-life of about 6 s):

| Event | Effect |
|---|---|
| got punished, got baited, lost the HP lead | tilt ↑ |
| landed a read, won an exchange, read streak | confidence ↑ |
| low HP vs high threat, cornered | fear ↑ (cowards, `desperation < 0`, scale fear up) |
| a successful block streak | focus ↑ |

**Effects:**
- **tilt ↑:** perception delay +0–4 frames, softmax T ↑, aggression ↑, discipline ↓, more greed and more mashing after block. Tilt is visible and exploitable: the other model sees more `mash`.
- **confidence ↑:** baitFreq ↑, taunts and hesitation beats ↑, riskier reads. **Arrogance × confidence ↑ when far ahead** gives *complacency*: lower block rate and more showboating. This is the in-fiction comeback window.
- **fear ↑:** disengage and escape preference, more blocking, dodge-panic.
- **Misreads:** with probability `0.04 + 0.1·(1−focus)`, the perceived move is replaced by a same-clip or same-family move. For example a feint is perceived as real, or a heavy is perceived as its poke. This is rare, human and visible.

### 4.8 Readable intent and drama coupling

**New sim events** (`types.ts` `EventType`). The record is consumed by camera, HUD, audio and voice.

| Event | Data | When it fires | Who uses it |
|---|---|---|---|
| `ai_intent` | `{tactic, conf}` | On tactic change, at most 1 per 1.5 s | Director: pick a two-shot for `condition` / `bait`; debug overlay replaces the `goal` field |
| `ai_tell` | `{kind: 'glance'\|'shift'\|'settle', dur}` | 0.2–0.5 s before a feint, bait or heavy commit (an honest tell, consistent per fighter) | Render: look-at / weight shift (needs animation M6 look-at; until then a subtle head turn via the existing pose layer) |
| `ai_read` | `{predicted, actual, level}` | A guess or counter that matched the prediction and landed | Announcer and voice: "He saw it coming!"; slow-mo candidate; HUD "READ" flash |
| `ai_hesitate` | `{dur}` | A deliberate 0.2–0.6 s stillness while sizing up (patience × uncertainty) | Camera holds; breathing additive |
| `ai_tilt` | `{level}` | Tilt crosses a threshold | Voice lines, posture additive (anger) |

- **Hesitation is real sim behaviour:** the fighter stays idle and stops footwork. The others are flags and do not change results. The target for still time while free is 5–12%, up from 1%.
- **Drama coupling (not rigging):**
  - The AI reads `m.drama.tension` and time.
  - When tension > 0.7 and both HP < 0.3, tactics weight decisive reads: `feintPunish`, `condition` payoffs, ultimates with landing windows, finishers.
  - Pokes get rarer, so climaxes are decided by readable reads, not chip damage.
- **Comebacks come from minds, not numbers:** the leader's arrogance-driven complacency and the trailer's fear→fury (the existing second wind) create natural swings.
  - **Owner decision:** once AI5 ships, consider lowering `Drama.incomingMul` underdog grit (`drama.ts:70`, up to −50% damage taken) to −30%. Hidden damage scaling makes the smarter fighter's advantage invisible, and it masks AI quality.
- **Stalemate:** the existing `boostUntil` stays. v2 also raises `pressure`/`condition` utility when `lastHitT` is old.

### 4.9 Arena use

Arena use stays v1's proven layer, with model-aware additions:
- **Hazard-line positioning:** approach so their knockback line (`backHazard`) ends in fire or spikes.
- **Kiters and cover:** kiters plan cover by `rangedThreat` LOS before the band is breached. This targets the BACKLOG issues "kiters 1/3 in band" and "cover 0.6 s per match".
- **Throwing:** throw props when the model predicts `ADVANCE` into the line.
- **Smash cover** when the model shows a ranged opponent sitting behind it more than 2 s.

---

## 5. Measuring intelligence: `tools/ai/eval.ts` (`npm run ai:eval`)

### 5.1 Harness
- **Bot hook:** a sim-side controller hook, `Match.controllers: [Controller|null, Controller|null]` (default null).
  - `step()` calls the controller instead of `aiTick` when one is set.
  - No result change when null; verified by an unchanged determinism hash.
- **Bots** (`tools/ai/bots.ts`):
  - `spam` (fastest move)
  - `heavy` (biggest move)
  - `turtle` (block + punish only)
  - `mash` (attack immediately after any block)
  - `jumpy` (dodge every incoming attack)
  - `baitPunish` (whiff-bait at the poke edge, punish recovery)
  - `pattern` (fixed 3-move loop)
  - `v1`: the frozen v1 AI, kept as `src/sim/ai/legacy/v1.ts` behind the controller hook for evaluation only.
- **Metrics** (the `diag.ts` set made permanent): per fighter and global, as JSON + text.
- **Modes:** drama levers on (production) and `--no-drama` (eval-only switch `DRAMA_TUNING.levers=false`), so AI quality is not masked by grit or fury rubber-banding.
- **Ablations:** `--ablate perception|model|meta|lookahead|tactics|mind|intent`, each replacing a layer with a v1-like fallback.
- **CPU:** counters for decisions, model ticks and search nodes, reported per match. A Node `performance.now` total is used **only in the harness**, never inside sim logic.
- **Memory-safe:** sequential matches, `record:false` unless clips are requested. One process.

### 5.2 Targets (v2 final, drama ON unless noted)

| Group | Metric | v1 now | Target |
|---|---|---|---|
| **Must stay** | Per-fighter win rate, timeouts, no-contact kills, determinism | 45.7–54.6%, 0, 0, OK | 45–55%, 0, 0, OK |
| | Mean fight duration | 69.7 s | 60–72 s |
| | ≥2 momentum swings | 54% | ≥ 45% |
| | One-sided fights | 1.1% | ≤ 3% |
| **Intelligence** | v2 vs v1 (mirror, `--no-drama`) | — | ≥ 70% |
| | v2 vs v1 (mirror, drama ON) | — | ≥ 60% |
| | Bot win rate vs v2: spam / heavy / turtle / pattern | 40 / 47.5 / 27.5 / ? | ≤ 15 / 12 / 15 / 10% |
| | In-range incoming attacks with no response | 56.6% | 25–40% (humans eat some) |
| | Hits on an attacking victim (trades) per match | 17.0 | ≤ 8 |
| | Attacks ending blocked or parried | 11% | 18–30% |
| | Context share of move entropy (MI/H) | 0.25 | ≥ 0.45 |
| | Own-stream order-2 n-gram accuracy | 20% (< order 0) | 28–40%, and > order 0 (visible habits) |
| | Guard-breaker / feint / throw after being blocked | 15% | ≥ 35% |
| | Adaptation vs `turtle`: guard-breaker share, first 30 s → rest | 4.7 → 4.1% | ≥ 2× increase |
| | Feint conversion (hit within 1.2 s) | 29% | ≥ 45% |
| **Resources** | Attacks started below 25% stamina | 22.7% | ≤ 10% |
| | Exhausted time | 24% | ≤ 12% |
| | Ultimates started in neutral or into a windup | 39% | ≤ 12% |
| | Ultimate landed | 60% | ≥ 75% |
| **Clumsiness** | Heavy whiffs per match | 3.5 | ≤ 1.5 |
| | Attacks on downed or i-frame opponents that whiff | ~20% of 17% | ≤ 5% |
| | Kiters in band | 35% | ≥ 55% |
| | Cover time vs ranged | ~1 s/match | ≥ 3 s/match |
| | Cornered escape within 4 s | 39% | ≥ 60% |
| **Human tempo** | Median punish latency | 0.117 s | 0.22–0.33 s, with feasible-punish rate ≥ 70% |
| | Still time while free | 1% | 5–12% |
| | Tactic switches | (goal 29/min) | 8–15 per minute |
| **Readability** | `ai_read` per match | — | 2–6 |
| | Tells before feints and baits | — | ≥ 80% |
| | Lull share (> 4 s without contact) | 10.8% | ≤ 15% |
| | Attack cadence coefficient of variation | 0.64 | 0.6–1.0 |
| | Simultaneous attack starts per match | 1.5 | ≤ 1 |
| **CPU** | AI per decision | — | ≤ 0.3 ms mean, ≤ 2 ms p99 |
| | Whole match in Node | ~50 ms | ≤ 250 ms (`record:true`) |
| | Whole match in Chromium | — | ≤ 600 ms, checked by the owner via the console log |

### 5.3 Exploitability and pattern tests
- Each bot vs each fighter, 10 seeds per side.
- The `pattern` bot must be beaten harder in the second half than in the first: model learning, measured as damage-taken ratio.
- An "exploit probe": a bot that repeats whatever won its last exchange. v2 should drive its success rate down over time. This is a conditioning test of v2's own defence.

### 5.4 Human-review clips (`tools/ai/clips.ts`)
- The tool searches eval matches for event patterns and prints repro URLs: `?a=&b=&seed=&theme=&layout=&aseed=&t=` (`main.ts:142-155`; theme, layout and aseed come from `arenaForSeed(seed)`).
- It also writes `docs/milestones/AIn/clips.md`.
- **The owner watches these 8 at each review:**
  1. **Conditioning payoff:** Aldric vs Hollowjack. Repeated jab-stop, then a guard-break after the switch (`ai_intent condition` → `ai_read`).
  2. **Whiff bait:** Vex steps in, backsteps the poke and punishes the recovery.
  3. **Feint into a read:** a feint, then the opponent blocks, then a guard-breaker; and the counter-case where the opponent reads the feint.
  4. **Okizeme:** Fenrik vs Maw. A meaty timed to the get-up, then a get-up reversal bait.
  5. **Kiter discipline:** Erika vs Gorak. Retreats before the breach, uses cover, punishes Brute Rush at `minRange`.
  6. **Tilt comeback:** the leader gets complacent (taunts) and the trailer's read streak flips the fight.
  7. **Spam punished:** the `spam` bot vs v2 Vex (v1 lost 10/10 here).
  8. **Rival rematch** (after AI9): the same pair, match 1 vs match 3, showing faster adaptation from memory.

### 5.5 Offline evolution (`tools/ai/evolve.ts`, AI8)
- **Search:** (μ, λ) CMA-ES on genome vectors, plus a MAP-Elites archive for diversity.
  - Behaviour axes: aggression × range preference, and baitFreq × yomi.
  - One elite per cell per style family.
- **Scoring:** matches vs a reference pool (the current 8 seed genomes + v1 + 2 bots), 20 seeds, in Node, sequential, `record:false`.
- **Entertainment fitness:**

  `F = 0.25·closeness (1−|finalHpDiff|) + 0.15·leadChanges(capped 3) + 0.10·comeback + 0.15·moveVariety(entropy, no move > 35%) + 0.10·reads/match(capped) + 0.10·durationFit(60–70 s) − 0.3·stallPenalty(lulls>4 s share >15%) − 0.3·timeouts − 0.2·botExploitability + 0.15·winRateFit(40–60% vs pool)`

  Win rate is a *constraint band*, not the objective (`vision.md`).
- **Cost:** about 0.25 s per match in Node at the target AI cost. 20 genomes × 40 matches per generation = 800 matches ≈ 3.5 min per generation. An overnight run of 100 generations is possible. Keep it to one process for the low-memory PC.
- **Output:** `tools/ai/out/genomes-*.json`. The **owner chooses** which genomes become the shipped personalities. This is the "Judgement" in miniature.

---

## 6. Milestones

Each milestone fits one agent session (≤ about 1 agent-day). Each ships with:
- `docs/milestones/AIn/README.md`
- `simtest-40.txt`
- `ai-eval.json`
- `clips.md` (from AI3 on)

Order is chosen for **visible improvement first**. Lookahead comes after the rule, model and tactic layers. The FightingICE winners show rules + model carry most of the strength, and lookahead then refines move choice.

| ID | Name | Effort | Depends on | Changes sim results? |
|---|---|---|---|---|
| AI0 | Harness, bot hook, v1 freeze | 0.75 d | — | No (hash-identical) |
| AI1 | Senses: AI RNG, perception buffer, threat fix, reaction rework, stamina discipline, okizeme timing | 1 d | AI0 | **Yes** |
| AI2 | Opponent model + response tables + meta-levels; anticipation in reactions | 1 d | AI1 | Yes |
| AI3 | Tactic framework + core tactics (footsies, pressure / frame-trap, disengage, okizeme, escape, kite, arena wrap) | 1 d | AI2 | Yes |
| AI4 | Mind games: whiffBait, condition, feintPunish, antiRush, cornerTrap + Mind (tilt, confidence, misreads) | 1 d | AI3 | Yes |
| AI5 | Genome + personality mapping + drama coupling + intent events | 0.75 d | AI4 | Yes (events + behaviour) |
| AI6 | DuelModel forward model + validation | 1 d | AI3 | No (not wired in yet) |
| AI7 | Expectimax lookahead wired into action choice and reactions; CPU budget | 1 d | AI5, AI6 | Yes |
| AI8 | Offline evolution (CMA-ES + MAP-Elites), owner picks genomes | 1 d (+ overnight runs) | AI7 | Yes, if adopted |
| AI9 | Rival memory (Nemesis-lite) + persistence format | 0.75 d | AI2, AI5 | Only when memory is passed in |
| AI10 | Calibration, final baselines, docs, BACKLOG, clips | 0.5 d | all | Final re-baseline |

Total about 9.5 agent-days. AI6 can run in parallel with AI4/AI5 (separate files).

### AI0: harness and v1 freeze (no behaviour change)
- **Files:**
  - new `tools/ai/eval.ts`, `tools/ai/bots.ts`, `tools/ai/metrics.ts` (promoted from `_scratch/diag.ts`), `tools/ai/clips.ts`
  - `src/sim/match.ts`: `controllers` hook (one line in `step()`)
  - `src/sim/ai/legacy/v1.ts` (verbatim copy of `ai.ts` for eval only)
  - `package.json` script `ai:eval`
- **Accept:**
  - `npm run sim:test -- 40` byte-identical to `docs/milestones/M4/simtest-40.txt`, apart from the timing line.
  - The eval reproduces the §1 numbers within noise.
  - The bot hook works on both sides.
  - The JSON is committed as `docs/milestones/AI0/ai-eval.json` (the v1 baseline).
- **Owner notices:** nothing in game. Gets a report card.

### AI1: senses (first visible change)
- **Changes:**
  - Per-fighter AI `Rng`.
  - `Percept` ring buffer with symmetric end-of-tick snapshots.
  - Reaction delay D. Move identity revealed at D.
  - `pokeThreat`/`lungeThreat` split (fixes footsies, guard, bait distances).
  - Reaction decision by expected value instead of a dice roll: block when safe, parry by skill, dodge against unblockables and heavies, counter only if it beats their contact time.
  - Stamina floor: no non-punish attacks below `staminaFloor` unless desperate; disengage instead.
  - Down and get-up handling: no attacks into i-frames; time meaties.
  - Punish latency humanised.
  - Ultimate gating to landing windows.
- **Files:** `src/sim/ai.ts` → `src/sim/ai/{index,perception,facts,reaction}.ts` (`ai.ts` re-exports `aiTick`, `createAIState`, `wantsCombo`, `AI_TUNING`).
- **Accept:**
  - sim test invariants hold.
  - No-response share ≤ 45%.
  - Trades ≤ 12 per match.
  - Exhausted time ≤ 15%.
  - Heavy whiffs ≤ 2.5 per match.
  - Down and i-frame whiffs ≤ 8%.
  - Punish latency 0.2–0.33 s with feasible punishes ≥ 70%.
  - Spam bot ≤ 30%.
- **Owner notices:** fighters block and step back from big swings, stop gasping for air mid-exchange, stop swinging at bodies on the floor, and wait for the opponent to rise.
- **Watch out:** more defence means longer fights. If the mean goes above 72 s, raise guard damage in AI-side choices (choose guard-breakers) before touching sim numbers.

### AI2: opponent model
- **Changes:**
  - `oppModel.ts` (token abstraction, decayed context, n-gram and response tables, Iocaine meta-levels, `myMovePunished`).
  - Reactions use it: feint discounting, **anticipation guesses** (`ai_read` emitted internally, surfaced in AI5).
  - Move choice gets a model term: avoid moves the model says get punished.
- **Accept:**
  - Prediction accuracy of the model on the opponent's next token, measured by eval: ≥ 1.5× order-0 vs the `pattern` bot, and above order-0 vs v1.
  - `pattern` bot ≤ 15%.
  - Guard-breaker share vs `turtle` doubles after 30 s.
  - Model memory ≤ 8 KB per fighter.
  - Decision cost recorded.
- **Owner notices:** in longer fights the second half looks different from the first: fighters stop falling for the same thing twice and start guessing right on big moves.

### AI3: tactic framework and core tactics
- **Changes:**
  - Tactic interface, utility selection with inertia, bait-as-2nd-choice.
  - Tactics: `footsies`, `pressure` (safe-on-block strings, frame trap), `disengage`, `okizeme`, `escape`, `kite`/`zone`, `arena` (v1 grab, smash, barrel and cover rewrapped), `finish`.
  - Footwork reuses v1 `steer` primitives.
  - `wantsCombo` decided by the tactic (on block: continue only with a safe move, a guard-breaker, or a frame trap).
- **Files:** `src/sim/ai/tactics/*.ts`, `src/sim/ai/footwork.ts`.
- **Accept:**
  - Context MI share ≥ 0.40.
  - Kiters in band ≥ 50%.
  - Cornered escape ≥ 55%.
  - Simultaneous starts ≤ 1 per match.
  - The first `clips.md`.
- **Owner notices:** a neutral game. Fighters dance at the edge of each other's reach, back off to breathe, pressure in strings that stop when blocked, and kiters keep their distance.

### AI4: mind games and the Mind
- **Changes:**
  - Tactics: `whiffBait`, `condition`, `feintPunish`, `antiRush`, `cornerTrap`.
  - `mind.ts` (tilt, confidence, fear, focus, readStreak), misreads, hesitation beats (real sim idles).
- **Accept:**
  - Feint conversion ≥ 40%.
  - `ai_read` 2–6 per match (counted internally).
  - Still time 5–12%.
  - Bots: spam ≤ 20%, heavy ≤ 15%.
  - Tilt measurably changes behaviour: block rate and softmax entropy differ between tilted and calm states in the eval.
- **Owner notices:** visible baiting, feints that set something up, a fighter "figuring out" a habit and punishing it, and fighters who get rattled after being read.

### AI5: genome, personality, drama coupling, intent events
- **Changes:**
  - `genome.ts` with `genomeFromLegacy` for the 8.
  - Per-fighter seed genomes (§4.6).
  - Drama coupling (tension and climax weights, complacency).
  - Events `ai_intent`, `ai_tell`, `ai_read`, `ai_hesitate`, `ai_tilt` in `types.ts`. `FighterFrame.goal` carries the tactic name.
  - **Render consumption is out of scope.** The fallbacks are a debug overlay and HUD text, unless the director and animation M6 hooks exist.
- **Accept:**
  - Per-fighter style fingerprints differ: the action-distribution KL between any two fighters with the same role is > 0.2.
  - ≥ 80% of feints and baits are preceded by an `ai_tell`.
  - sim test invariants hold.
- **Owner notices:** Aldric fights like a patient duelist, Vex like a trickster and Fenrik like an animal, with the same engine. A debug overlay shows what each fighter is trying.

### AI6: DuelModel (parallel track)
- **Changes:** `src/sim/ai/duel.ts` plus `tools/ai/duelcheck.ts` validation against 5,000 real decision points.
- **Accept:**
  - Outcome agreement ≥ 85%.
  - Contact time error ≤ 2 frames median.
  - ≤ 0.5 µs per model tick in Node.
  - Zero allocation in the steady state (checked with `--expose-gc` heap deltas).
- **Owner notices:** nothing yet.

### AI7: lookahead
- **Changes:**
  - Expectimax-lite (§4.5) in pressure, neutral and multi-option reactions.
  - Node caps.
  - Ablation switch.
- **Accept:**
  - v2 vs v1 mirror ≥ 60% (drama ON) and ≥ 70% (`--no-drama`).
  - The ablation without lookahead is at least 5 points lower.
  - AI ≤ 0.3 ms mean and ≤ 2 ms p99 per decision.
  - Match ≤ 250 ms in Node.
  - Determinism OK on all themes.
  - The owner checks the `[arena] simulated … ms` console line in Chromium; target ≤ 600 ms.
- **Owner notices:** sharper choices in scrambles, fewer silly trades, and better use of safe-on-block moves.

### AI8: evolution
- **Changes:** `tools/ai/evolve.ts` (CMA-ES + MAP-Elites, entertainment fitness §5.5), runner notes for overnight runs, an archive viewer (text).
- **Accept:**
  - The archive holds ≥ 12 distinct elites.
  - The proposed genomes for the 8 keep sim test invariants.
  - **Owner picks.**
- **Owner notices:** distinct personalities tuned for drama; this is the first taste of the vision's population.

### AI9: rival memory (Nemesis-lite)
- **Changes:**
  - `RivalMemory` (model tables + record + grudge) as an input to `Match` (`opts.memory`).
  - Stored in the record with a version number.
  - Browser persistence in `localStorage` is a later stage of the vision; deliver a JSON format plus a Node script that runs a 5-match series.
- **Accept:**
  - Within a series, the damage-taken ratio vs a habitual opponent improves from match 1 to match 3.
  - Replaying a record with its memory reproduces it exactly.
  - Memory ≤ 4 KB per rival.
- **Owner notices:** rematches feel personal: "he remembered".

### AI10: calibration and handover
- Final `sim:test` / `ai:eval` baselines.
- Update `docs/ai-design.md` (v2) and `BACKLOG.md`.
- 8 review clips.
- The owner's feel review.

### How baselines move and what must stay true
- From AI1 on, results change, so seed-by-seed comparison with M4 is meaningless.
- Each milestone commits a fresh `docs/milestones/AIn/simtest-40.txt` and `ai-eval.json`. The *distributions* are compared to the previous milestone and to the AI0 v1 baseline (`docs/metrics-*.txt` stay as history).
- **Always true:**
  - per-fighter win rate 45–55%
  - 0 timeouts
  - 0 kills without contact
  - determinism same / differs = true / true
  - mean duration 60–72 s
  - ≥2 swings ≥ 45%
  - `npm run build` passes
  - `fx:check` unaffected
- If win rates leave the band because the smarter AI favours some kits (likely Aldric's parries, Vex's speed), fix it in the **genome / tactic weights first**. Only change `fighters.ts` numbers with an explicit note, since moves are fitted to clips (`fighters.ts:8`).

---

## 7. Animation and contact constraints the AI must respect

- **Fixed timings:** windups are fitted to clip strike frames (`fighters.ts:8`). The AI cannot speed up or cancel attacks except feints (cancel at 62%, `match.ts:648`). Combos only chain at recovery start through `next` (`match.ts:656`).
  - Frame traps and delays are therefore built from *wait* + *new attack*, or from choosing whether to chain.
- **Defence has no startup:** block starts on the frame it is chosen and ends at `blockUntil`; attacking from block is allowed (`canAct`).
  - v2 must not exploit this beyond human limits. The perception delay D is the fairness gate. A small "guard drop" cost (2 frames before attacking out of block) could be added in AI1 if the eval shows block→attack becoming oppressive. That is a sim change, so it needs a decision.
- **Dodge:** 0.5 s, i-frames 0.03–0.34 s (`match.ts:552`), 18 stamina. **Parry:** window 0.16 s (+0.08 with a shield), single-hit moves only (`match.ts:1225`).
- **Get-up:** i-frames for the first 55% of the get-up (`match.ts:554`), and get-up durations vary by clip (`anim.getup`). The AI must read `stateDur` from the perceived state, not assume it.
- **Feint clips:** feints share clips with real moves (`movesets.md`), so feints are honest at the animation level. The `ai_tell` must not give the feint away: tells are per personality, not per feint.
- **Finishers** are chosen in the sim at the lethal blow (`match.ts:1321`, animation RNG). The AI can raise the *chance of a good ending* by choosing knockdown kill blows. It must never stall a kill.
- **Hesitation and tells** need render support for full effect: look-at and weight shift come with animation M6 (`animation-plan.md` §j/§k). Until then hesitation reads as idle breathing and stillness, and tells are invisible except on the debug overlay. **This needs the owner's eye**; it cannot be verified headless.
- **M5 attack variants** may change windups. v2 reads all timings from `MoveFacts` built from data at load, so it adapts automatically. Re-run `duelcheck` after M5.

---

## 8. Risks and open points

| Risk | Mitigation |
|---|---|
| **Smarter defence lengthens fights** (more blocks, fewer trades) | Tactic weights favour guard-breakers and conditioning when blocking rises. Keep sudden death as is. Watch the 60–72 s band every milestone |
| **The drama engine masks AI quality** (up to −50% damage for the trailer, fury rubber band) | Evaluate with `--no-drama` too. Owner decision on reducing grit after AI5 |
| **Balance drift between fighters** | Fix with genome and tactic weights first; the evolution stage includes a win-rate band |
| **Over-cleverness reads as rigged or robotic** (perfect reads) | Perception delay, misreads, meta-level caps per genome, softmax temperature. The eval keeps `ai_read` at 2–6 per match |
| **CPU in the browser** (whole match simulated before playback) | Node caps; owner checks the Chromium console line. If over budget, move `simulate` to a Web Worker (a render-side change, separate task) |
| **Determinism across Node and Chromium** in new math (search scores, softmax `exp`) | `dmath` only; existing determinism checks cover all themes. Add a cross-run hash test for the eval |
| **Nemesis patent** (US 10,926,179) | Per-fighter memory only; no captain hierarchy, rank promotion or vendetta mechanics as claimed. Owner may want legal advice before the vision's dynasty stage |
| **Low-memory PC** | Eval and evolution run as one sequential Node process with `record:false`; no browsers |
| **Concurrent FX work** (F3 in `src/render/fx`) | AI touches only `src/sim/*`, `tools/ai/*` and docs. New event types are additive. The FX director ignores unknown events (to confirm in AI5) |

**Could not verify in this planning session:**
- **Feel:** whether hesitations, tells and reads *look* intelligent. That needs the owner watching clips.
- **DuelModel and search cost:** the per-tick and per-decision costs (0.2–0.4 µs, 0.4–0.8 ms) are estimates; only the full-step and clone-proxy costs were measured.
- **Chromium cost:** the browser's simulate time with v2.
- **Whether render consumers safely ignore new event types:** the FX director, director and audio. The F3 agent is editing `src/render/fx` now; not checked.
- **Several literature details** marked UNVERIFIED in `ai-v2-research.md` (e.g. FightingICE sample MCTS constants, the IAUS formula).
- **Bot win rates:** 10 seeds per fighter. They give a direction, not precise rates.

**Owner decisions needed:**
1. Approve the order: model and tactics before lookahead (recommended), or lookahead earlier.
2. Underdog grit: reduce from −50% to about −30% after AI5 so intelligence shows? (It changes the sim.)
3. Whether to add a 2-frame "guard drop" before attacking out of block. This is a fairness sim change, decided only if the AI1 eval shows it is needed.
4. Whether `ai_read` should be surfaced to viewers (HUD "READ!" and an announcer line), or kept subtle.
5. Which evolved genomes to adopt (AI8). Whether to keep the hand-authored personalities as canon.
