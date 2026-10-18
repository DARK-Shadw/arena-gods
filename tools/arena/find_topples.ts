// A5 helper: find fights that topple a kit obstacle (statue / column), so tools/arena/check_frac.cjs can seek straight to one.
//   npx tsx tools/arena/find_topples.ts desert:pit colosseum:pit [--n=60]
// Prints `theme:layout a b seed aseed obstacle kind t_topple t_impact` per hit (first 3 per theme / layout).
import { simulate } from '../../src/sim/match';
import type { LayoutId, ThemeId } from '../../src/sim/arenaGen';

const args = process.argv.slice(2);
const N = Number(args.find((x) => x.startsWith('--n='))?.slice(4) ?? 60);
const pairs: [string, string][] = [
  ['gorak', 'erika'],
  ['maw', 'ozrel'],
  ['aldric', 'erika'],
  ['hollowjack', 'ozrel'],
];
for (const tl of args.filter((x) => !x.startsWith('--'))) {
  const [theme, layout] = tl.split(':') as [ThemeId, LayoutId];
  let found = 0;
  for (let s = 1; s <= N && found < 3; s++) {
    const [a, b] = pairs[s % pairs.length];
    for (const aseed of [3, 7]) {
      const rec = simulate(a, b, s, true, { theme, layout, seed: aseed });
      const top = rec.events.find((e) => e.type === 'topple' && e.data && /statue|column|crystal|obelisk/.test(String(e.data.kind)));
      if (!top) continue;
      const imp = rec.events.find((e) => e.type === 'topple_impact' && Number(e.data?.obs) === Number(top.data!.obs));
      if (!imp) continue;
      console.log(`${theme}:${layout} ${a} ${b} ${s} ${aseed} obs ${top.data!.obs} ${top.data!.kind} ${top.t.toFixed(2)} ${imp.t.toFixed(2)}`);
      found++;
      break;
    }
  }
  if (!found) console.log(`${theme}:${layout}: none in ${N} seeds`);
}
