/**
 * FX foundation checks (milestone F0), Node only (no browser, no GPU):
 *   npm run fx:check
 * - every def spawns standalone and has a duration;
 * - same id + seed + time => identical state hash in two independent directors;
 * - scrubbing (setTime) to t gives the same state as stepping to t;
 * - different seeds differ;
 * - particles expire (counts back to 0) and nothing leaks across clear().
 * - grep gate: no unseeded randomness / wall clock / timers in src/render/fx.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createFxDirector, DEFS, FxDirector, fxSettings, REPLAY_TAIL, THEME_FLOOR, type FxWorld } from '../src/render/fx';
import { simulate } from '../src/sim/match';
import { FIGHTERS } from '../src/sim/fighters';
import { generateArena, type ArenaSpec } from '../src/sim/arenaGen';
import { FIN_BY_ID } from '../src/sim/finishers';
import type { MoveDef } from '../src/sim/types';
import { Playback } from '../src/render/playback';

let fail = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    fail++;
    console.log('FAIL', msg);
  }
};

const P = { x: 0.3, y: 1.2, z: -0.4 };
const ids = Object.keys(DEFS);
console.log(`defs: ${ids.length}`);

// 1. every def spawns and reports a timing
for (const id of ids) {
  const fx = createFxDirector({ seed: 7 });
  ok(fx.spawn(id, P, { seed: 99, t: 0 }), `spawn ${id}`);
  const tm = fx.timing(id)!;
  ok(tm.duration >= 0, `timing ${id}`);
  fx.dispose();
}

// 2. reproducibility: same seed+time in two directors; stepping vs scrubbing
const probe = ['impact.default.heavy', 'explosion.keg', 'knockdown.dust', 'kill.plain', 'lastStand.burst', 'active.nova'];
for (const id of probe) {
  const A = createFxDirector({ seed: 3 });
  const B = createFxDirector({ seed: 3 });
  A.spawn(id, P, { seed: 1234, t: 0 });
  B.spawn(id, P, { seed: 1234, t: 0 });
  for (let i = 0; i < 18; i++) A.step(1 / 60); // t = 0.3 by stepping
  B.setTime(0.3); // ... and by scrubbing
  const ha = A.stateHash(),
    hb = B.stateHash();
  ok(ha === hb, `step vs scrub ${id}: ${ha} vs ${hb}`);
  ok(A.hash() === B.hash(), `effect list ${id}`);
  const C = createFxDirector({ seed: 3 });
  C.spawn(id, P, { seed: 1235, t: 0 });
  C.setTime(0.3);
  if (DEFS[id].layers.some((l) => 'n' in l.op && (l.op as { n: number }).n > 1)) ok(C.stateHash() !== ha, `different seed differs ${id}`);
  const s = A.stats();
  console.log(`${id.padEnd(22)} t=0.30 add ${String(s.particles.add).padStart(4)} alpha ${String(s.particles.alpha).padStart(3)} rings ${s.rings} debris ${s.debris} dur ${A.timing(id)!.duration.toFixed(2)}s hash ${ha}`);
  // expiry
  A.setTime(10);
  const e = A.stats();
  ok(e.particles.add === 0 && e.particles.alpha === 0 && e.dist === 0 && e.rings === 0 && e.debris === 0 && e.effects === 0, `${id} expires: ${JSON.stringify(e.particles)} dist ${e.dist}`);
  A.dispose(), B.dispose(), C.dispose();
}

// 3. legacy facade calls are seeded too (same match seed => same state)
{
  const run = () => {
    const fx = createFxDirector({ seed: 11 });
    fx.vfx.sparks(P, 30, '#ffc070', 7);
    fx.vfx.dust(P, 12, 1.2);
    fx.vfx.debrisBurst(P, '#6b4a2c', 8);
    fx.vfx.shockwave(P, '#ffd8a0', 4, 0.5);
    fx.step(0.2);
    const h = fx.stateHash();
    fx.dispose();
    return h;
  };
  ok(run() === run(), 'legacy facade reproducible');
}

// 4. clear() empties everything
{
  const fx = createFxDirector({ seed: 5 });
  for (const id of ids) fx.spawn(id, P, { seed: 1 });
  fx.step(0.05);
  const before = fx.stats();
  fx.clear();
  fx.step(0.01);
  const after = fx.stats();
  ok(before.particles.add > 0 && after.particles.add === 0 && after.debris === 0 && after.rings === 0, `clear: ${JSON.stringify(before.particles)} -> ${JSON.stringify(after.particles)}`);
  fx.dispose();
}

// 4b. F1 distortion tiers: low spawns none, medium only heavy (tier 1) ops, high all
{
  const counts: number[] = [];
  for (const q of [0, 1, 2]) {
    const fx = createFxDirector({ seed: 9, quality: q });
    fx.spawn('explosion.keg', P, { seed: 1, t: 0 });
    fx.spawn('hazard.burn', P, { seed: 2, t: 0 });
    fx.setTime(0.2);
    counts.push(fx.stats().dist);
    fx.dispose();
  }
  ok(counts[0] === 0 && counts[1] === 2 && counts[2] === 3, `distortion tiers q0/q1/q2 = ${counts.join('/')} (want 0/2/3)`);
  createFxDirector({ quality: 2 }).dispose();
}

// 6. F3: full replay on seek. A recorded match (Node, no bones: every anchor from recorded frames)
//    played through at fixed steps vs a fresh director that seeks to T - 1.5 s and warms up to T like
//    the game's debugSeekFight. Must match: the floor decals, the wounds / weapon blood, the live effect
//    list and the full particle state; long tails (debris, smoke, pools) started before the warm-up must
//    be alive after the seek; the seek must stay cheap.
{
  const fights: [string, string, number, ArenaSpec][] = [
    ['gorak', 'vex', 4242, { theme: 'colosseum', layout: 'oval', seed: 7 }],
    ['aldric', 'gorak', 11, { theme: 'forge', layout: 'oval', seed: 2 }],
    ['ozrel', 'maw', 77, { theme: 'forge', layout: 'pit', seed: 3 }],
  ];
  const moves: Record<string, MoveDef> = {};
  for (const f of FIGHTERS) for (const m of f.moves) moves[`${f.id}:${m.id}`] = m;
  const now = () => performance.now();
  for (const q of [2, 0]) {
    fxSettings.setQuality(q);
    for (const [a, b, seed, spec] of fights) {
      const rec = simulate(a, b, seed, true, spec);
      const L = generateArena(spec);
      const world: FxWorld = {
        accent: () => '#ffb060',
        move: (i, id) => moves[`${rec.ids[i]}:${id}`],
        obstacle: (i) => L.obstacles[i],
        hazard: (i) => L.hazards[i],
        ring: () => ({ rx: L.rx, rz: L.rz }),
        isFinisher: (m) => !!FIN_BY_ID[m],
        floorAt: (x, z) => (L.hazards.some((h) => h.kind === 'water' && (x - h.x) ** 2 + (z - h.z) ** 2 < h.r * h.r) ? 'water' : THEME_FLOOR[L.theme] ?? 'stone'),
      };
      const dt = 1 / 60;
      const run = (fx: FxDirector, pb: Playback, T: number) => {
        while (pb.t < T - 1e-9) {
          const evs = pb.advance(Math.min(dt, T - pb.t));
          fx.frame({ events: evs, frame: pb.frameAt(pb.t), simT: pb.t, simDt: dt });
          fx.update(dt, dt);
        }
      };
      const dur = rec.frames[rec.frames.length - 1].t;
      for (const T of [Math.min(14, dur - 0.5), Math.min(31, dur - 0.5)]) {
        const A = new FxDirector();
        A.setMatch(rec, seed, world, 0);
        run(A, new Playback(rec), T);
        const B = new FxDirector();
        B.setMatch(rec, seed, world, 0);
        const pb = new Playback(rec);
        const tw = Math.max(0, T - 1.5);
        pb.seek(tw);
        const c0 = now();
        B.seek(tw);
        const seekMs = now() - c0;
        run(B, pb, T);
        const sa = A.stats(),
          sb = B.stats();
        const tag = `${a}-${b}#${seed} q${q} T=${T.toFixed(1)}`;
        ok(A.decalHash(T) === B.decalHash(T), `seek floor decals ${tag}: ${A.decalHash(T)} vs ${B.decalHash(T)}`);
        ok(A.bloodHash() === B.bloodHash(), `seek wounds / weapon blood ${tag}: ${A.bloodHash()} vs ${B.bloodHash()}`);
        ok(A.hash() === B.hash(), `seek live effect list ${tag}: ${A.hash()} vs ${B.hash()}`);
        ok(A.stateHash() === B.stateHash(), `seek full FX state ${tag}`);
        const tails = B.liveEffects().filter((e) => e.t0 < tw - 0.05);
        const tailsA = A.liveEffects().filter((e) => e.t0 < tw - 0.05);
        ok(tails.length === tailsA.length, `seek long tails ${tag}: ${tails.length} vs ${tailsA.length}`);
        ok(sb.seek.steps <= Math.ceil(REPLAY_TAIL / rec.dt) + 2 && seekMs < 400, `seek cost ${tag}: ${sb.seek.steps} steps, ${seekMs.toFixed(1)} ms`);
        console.log(`seek ${tag.padEnd(34)} decals ${String(sa.decals).padStart(3)} wounds ${sa.wounds} live ${sa.effects} (tails before the warm-up: ${tails.length}) replay ${sb.seek.events} events / ${sb.seek.steps} steps ${seekMs.toFixed(1)} ms`);
        A.dispose(), B.dispose();
      }
    }
  }
  fxSettings.setQuality(2);
}

// 7. F3: every new def resolves for every gore level, and gore 'off' spawns no blood decals or wounds
{
  for (const g of ['off', 'standard', 'full'] as const) {
    const fx = createFxDirector({ seed: 3 });
    fx.gore = g;
    for (const id of ['blood.cut', 'blood.kill', 'blood.pierce', 'blood.blunt', 'blood.blade', 'blood.pool']) fx.spawn(id, P, { seed: 5, t: 0 });
    fx.setTime(2);
    const s = fx.stats();
    if (g === 'off') ok(s.decals === 0 && s.wounds[0] + s.wounds[1] === 0, `gore off: no blood (decals ${s.decals}, wounds ${s.wounds})`);
    else ok(s.decals > 0, `gore ${g}: blood decals ${s.decals}`);
    console.log(`gore ${g.padEnd(8)} decals ${s.decals} wounds ${s.wounds} sprites ${JSON.stringify(s.sprites)}`);
    fx.dispose();
  }
}

// 5. grep gate
{
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/render/fx');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = src.match(/Math\.random|performance\.now|setTimeout|Date\.now/);
    ok(!m, `grep gate: ${f} contains ${m?.[0]}`);
  }
}

console.log(fail ? `\n${fail} FAILED` : '\nall FX checks passed');
process.exit(fail ? 1 : 0);
