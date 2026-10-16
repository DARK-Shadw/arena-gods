/** Print a compact timeline of one match: npm exec tsx tools/trace.ts gorak vex 123 */
import { simulate } from '../src/sim/match';
const [a = 'gorak', b = 'vex', seed = '1'] = process.argv.slice(2);
const rec = simulate(a, b, Number(seed));
const max = [rec.frames[0].f[0].hp, rec.frames[0].f[1].hp];
for (let i = 0; i < rec.frames.length; i += 150) {
  const fr = rec.frames[i];
  console.log(`t=${fr.t.toFixed(1).padStart(5)} ${a}:${((fr.f[0].hp / max[0]) * 100).toFixed(0).padStart(3)}% ${fr.f[0].state.padEnd(9)} ${b}:${((fr.f[1].hp / max[1]) * 100).toFixed(0).padStart(3)}% ${fr.f[1].state.padEnd(9)} mom=${fr.momentum.toFixed(2)} ten=${fr.tension.toFixed(2)}`);
}
const skip = new Set(['attack_start', 'whiff', 'getup', 'hazard_burn']);
if (process.argv.includes('-v')) for (const e of rec.events) if (!skip.has(e.type)) console.log(e.t.toFixed(2), e.type, e.a, e.data ? JSON.stringify(e.data) : '');
else for (const e of rec.events) if (['momentum_swing', 'lead_change', 'comeback', 'second_wind', 'last_stand', 'ability_used', 'kill', 'stalemate_break', 'arena_shrink', 'near_death', 'rage'].includes(e.type)) console.log(e.t.toFixed(2), e.type, rec.ids[e.a] ?? '', e.data ? JSON.stringify(e.data) : '');
console.log(rec.result);
