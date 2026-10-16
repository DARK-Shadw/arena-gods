/** Whiff analysis: npx tsx tools/whiffs.ts [seeds] */
import { FIGHTERS } from '../src/sim/fighters';
import { Match } from '../src/sim/match';
const N = Number(process.argv[2] ?? 3);
const ids = FIGHTERS.map((f) => f.id);
const all: { move: string; fid: string; closest: number; startGap: number }[] = [];
const contact: number[] = [];
for (const a of ids) for (const b of ids) if (a !== b) for (let s = 1; s <= N; s++) {
  const m = new Match(a, b, s * 101, { record: false });
  m.run();
  all.push(...m.whiffLog);
  contact.push(...m.contactLog);
}
const bucket = (x: number) => (x < 0.25 ? '<0.25' : x < 0.6 ? '0.25-0.6' : x < 1.2 ? '0.6-1.2' : '>1.2');
const by: Record<string, number> = {};
for (const w of all) by[bucket(w.closest)] = (by[bucket(w.closest)] ?? 0) + 1;
console.log('whiffs', all.length, 'closest-approach buckets', by);
const perMove: Record<string, { n: number; close: number; sg: number }> = {};
for (const w of all) {
  const k = `${w.fid}.${w.move}`;
  const e = (perMove[k] ??= { n: 0, close: 0, sg: 0 });
  e.n++;
  e.close += w.closest;
  e.sg += w.startGap;
}
Object.entries(perMove).sort((x, y) => y[1].n - x[1].n).slice(0, 25).forEach(([k, e]) => console.log(k.padEnd(28), e.n, 'avgClosest', (e.close / e.n).toFixed(2), 'avgStartGap', (e.sg / e.n).toFixed(2)));
