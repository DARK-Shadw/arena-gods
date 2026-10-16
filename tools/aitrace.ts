/** npx tsx tools/aitrace.ts a b [seeds]: goal mix, move usage and hit/whiff per move for one matchup */
import { Match } from '../src/sim/match';
const [a, b, n = '10'] = process.argv.slice(2);
const goals: Record<string, number>[] = [{}, {}];
const moves: Record<string, [number, number, number]>[] = [{}, {}];
let wins = [0, 0];
for (let s = 1; s <= Number(n); s++) {
  const m = new Match(a, b, s * 977, { record: false });
  const rec = m.run();
  if (rec.result.winner >= 0) wins[rec.result.winner]++;
  m.f.forEach((f, i) => { for (const [g, c] of Object.entries(f.ai.goalTicks)) goals[i][g] = (goals[i][g] ?? 0) + (c ?? 0); });
  for (const e of rec.events) {
    if (e.type === 'attack_start') (moves[e.a][String(e.data?.move)] ??= [0, 0, 0])[0]++;
    if (e.type === 'hit') (moves[e.a][String(e.data?.move)] ??= [0, 0, 0])[1]++;
    if (e.type === 'whiff') (moves[e.a][String(e.data?.move)] ??= [0, 0, 0])[2]++;
  }
}
console.log('wins', wins);
for (let i = 0; i < 2; i++) {
  const tot = Object.values(goals[i]).reduce((x, y) => x + y, 0);
  console.log([a, b][i], 'goals:', Object.entries(goals[i]).sort((x, y) => y[1] - x[1]).map(([g, c]) => `${g} ${((c / tot) * 100).toFixed(0)}%`).join(', '));
  console.log('   moves (use/hit/whiff):', Object.entries(moves[i]).sort((x, y) => y[1][0] - x[1][0]).map(([k, v]) => `${k} ${v.join('/')}`).join(', '));
}
