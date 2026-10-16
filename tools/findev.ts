/**
 * Find matches containing an event type (for screenshots / debugging).
 *   npx tsx tools/findev.ts <a> <b> <theme:layout:aseed> <eventType> [maxSeeds]
 * Prints fight seeds + event times.
 */
import { simulate } from '../src/sim/match';
import type { LayoutId, ThemeId } from '../src/sim/arenaGen';

const [a, b, spec, type, max = '200'] = process.argv.slice(2);
const [theme, layout, aseed] = spec.split(':');
let found = 0;
for (let s = 1; s <= Number(max) && found < 6; s++) {
  const seed = s * 101;
  const rec = simulate(a, b, seed, true, { theme: theme as ThemeId, layout: layout as LayoutId, seed: Number(aseed) });
  const evs = rec.events.filter((e) => e.type === type);
  if (evs.length) {
    found++;
    console.log(`seed ${seed}: ${evs.map((e) => `${e.t.toFixed(2)}(${JSON.stringify(e.data ?? {})})`).join(' ')}  [kill ${rec.events.find((e) => e.type === 'kill')?.t.toFixed(1)}]`);
  }
}
