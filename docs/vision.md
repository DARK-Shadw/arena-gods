# Vision: a living world of champions

Status: design idea, not built. Written 2026-10-16 from a brainstorm with the user. Working title: Arena Gods (the title art says "GODSRING"; rename undecided).

## One-line pitch
You are a minor god watching champions fight and survive in a world that keeps running. Fighters are persistent, remember their rivals, grow into legends, die, and leave descendants who come back for revenge. The fights you watch are real simulated matches with visuals on top. The goal is entertainment first, like watching an anime tournament arc, with betting as one way to care.

## Core loop
1. A persistent **population** of fighters exists. Each has a genome (personality parameters, stats, move preferences), a look (race, skin, palette, weapon), a record, memories, rivals and a lineage.
2. The server schedules matches and runs the deterministic sim. Players (gods) watch the same match, bet play-currency and use limited god powers.
3. After each match the world updates: wins, wounds, reputation, grudges, and what each fighter learned about the other.
4. Periodically **the Judgement** (the supreme god, an evolution step) culls the weak or boring and breeds new fighters from the good ones.
5. New fighters appear as **children, apprentices or heirs** of dead or retired champions, with a mutated genome, some inherited style, a matching look, and often a grudge against whoever killed their parent.
6. Repeat. Legends emerge, dynasties form, and every match has a story.

## What persists per fighter
- **Genome:** aggression, patience, risk, bait frequency, combo preference, doctrine and role, plus base stats.
- **Memory:** per-opponent tendencies (the existing opponent-model counts, stored per matchup). A veteran truly knows how you fight.
- **History:** wins, losses, kills, notable moments, injuries, age.
- **Relations:** rivals, grudges, mentors, parent and children, who killed whom.
- **Look:** race and skin, palette, armour parts, weapon, and heirloom items echoing the parent.

## Selection is for entertainment, not only winning
Fitness score mixes: close finishes, comebacks, variety of moves, crowd/drama peaks, rivalry heat, and no stalling. It penalises boring fighters and one-move spam. Keep diversity on purpose: fighting-style families, protected rare styles, culling "boring" as well as "weak". Plain win-optimisation (e.g. RL) tends to find efficient, uncinematic strategies, so it is not the driver here.

## Power growth must saturate
Veterans get skill, reputation and tactical memory, but raw power gains cap out, and age, fatigue and injuries push back. Otherwise the oldest champion always wins and fights become predictable. Legends should be dangerous because they are smart, not because of a huge stat sheet.

## Where an LLM helps (and where it does not)
- Helps: turning structured history into stories, announcer lines, chronicles, rivalry summaries, pre-fight taunts, "Fenrik's daughter enters the arena" style intros.
- Does not control moment-to-moment fighting. The sim stays authoritative and deterministic.

## Where RL / neural nets fit
- Not the foundation. Optional later: one self-play-trained "wild card" fighter that fights in a strange inhuman way, as a special attraction.
- Cheap and effective instead: evolving personality parameters offline in the fast sim, short lookahead (MCTS-lite) using the sim as a forward model, per-matchup memory.

## Staged plan
1. **Persistent roster, single browser, no server.** Fighters keep records, memories and rivalries across your own matches. Cheapest way to test whether the story hook works.
2. **Offline evolution run.** Simulate thousands of matches to produce a founding population of veterans with a pre-run history of grudges, so the world has legends on day one.
3. **Server and live room.** Shared world, scheduled matches, spectators, betting and god powers, replays of important fights.
4. **Dynasties, the Judgement event, narrative layer.**

Shares work with already-planned items: AI v2 (rivalry memory, lookahead), procedural character system (distinct looks for many fighters), game layer.

## Risks and answers
- **Cold start (few players):** pre-run history, replays, highlight clips.
- **Balance drift to one dominant strategy:** style families, protected diversity, boredom penalty.
- **Predictable betting:** injuries, age, matchups, drama engine.
- **Visual identity for many fighters:** procedural characters, heirlooms, race/skin variation.
- **Facts are not stories:** event log to narrative layer.
- **Persistence and determinism across versions:** store seeds, genome and a sim version number so old fights can be replayed or re-simulated.
- **Biggest risk:** building a rich world before anyone cares about the fights. Stage it and playtest with real people early.

## Open questions
- Name: Arena Gods or Godsring?
- Death: permanent for all, or only in the Judgement and in finishers?
- How often does the Judgement run, and is it visible to players?
- Do gods own or sponsor fighters, or only bet on them?
