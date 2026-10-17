/** Print v1 threatRange (as computed in ai.ts) vs a poke-only threat per fighter. npx tsx tools/ai/_scratch/threat.ts */
import { FIGHTERS } from '../../../src/sim/fighters';
import { edgeReach } from '../../../src/sim/reach';
import type { FighterDef, MoveDef } from '../../../src/sim/types';
const reachOf = (d: FighterDef, m: MoveDef) => (m.ranged ? edgeReach(d.id, m, d.stats.radius) : edgeReach(d.id, m, d.stats.radius) + Math.max(0, m.lunge ?? 0) * 0.85 + 0.6 * 0.8);
for (const d of FIGHTERS) {
  let v1 = 0.4, v1Move = '', poke = 0.4, pokeMove = '';
  for (const m of d.moves) {
    if (m.ranged || m.feint || m.kind === 'ultimate' || m.windup > 0.65) continue;
    const r = reachOf(d, m);
    if (r > v1) ((v1 = r), (v1Move = m.id));
    if (m.kind !== 'gap' && r > poke) ((poke = r), (pokeMove = m.id));
  }
  const rows = d.moves.filter((m) => !m.ranged && !m.feint).map((m) => `${m.id}:${reachOf(d, m).toFixed(2)}/${m.windup}`);
  console.log(d.id.padEnd(11), 'v1 threat', v1.toFixed(2), v1Move.padEnd(16), '| poke threat', poke.toFixed(2), pokeMove.padEnd(16), '| band', d.stats.prefGap);
  console.log('   ', rows.join(' '));
}
