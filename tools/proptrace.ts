/**
 * Debug trace of arena-prop interactions (pick-ups, drops, throws) for a few matches.
 *   npx tsx tools/proptrace.ts [matches]
 */
import { FIGHTERS } from '../src/sim/fighters';
import { simulate } from '../src/sim/match';

const N = Number(process.argv[2] ?? 30);
const ids = FIGHTERS.map((f) => f.id);
const why: Record<string, number> = {};
let shown = 0;
for (let k = 0; k < N; k++) {
  const a = ids[k % ids.length],
    b = ids[(k * 3 + 1) % ids.length];
  if (a === b) continue;
  const rec = simulate(a, b, 1000 + k * 37, true);
  const ev = rec.events;
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    if (e.type !== 'prop_pickup') continue;
    // what happened to the carrier next?
    const next = ev.slice(i + 1).find((x) => (x.type === 'prop_throw' || x.type === 'prop_drop') && x.a === e.a);
    let cause = next ? next.type : 'none';
    if (next?.type === 'prop_drop') {
      const fr = rec.frames[Math.min(rec.frames.length - 1, Math.round(next.t / rec.dt) - 1)];
      cause += ':' + fr.f[e.a].state;
      if (shown++ < 12) {
        const ctx = ev.filter((x) => x.t > next.t - 0.6 && x.t <= next.t + 0.02 && x.type !== 'cover_hit').map((x) => `${x.t.toFixed(2)} ${x.type} a${x.a} ${JSON.stringify(x.data ?? {})}`);
        console.log(`${rec.ids[e.a]} picked ${e.data?.kind} at ${e.t}, dropped at ${next.t}:\n   ` + ctx.join('\n   '));
      }
    }
    why[cause] = (why[cause] ?? 0) + 1;
  }
}
console.log(why);
