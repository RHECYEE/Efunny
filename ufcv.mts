import { UfcBoardService } from './apps/server/src/ufc.js';
const board = await new UfcBoardService().board();
console.log('coverage:', JSON.stringify(board.coverage));
const scored = board.cards.filter(c => c.mismatch && !c.mismatch.no_grappler).sort((a,b)=>b.mismatch!.score-a.mismatch!.score);
for (const c of scored.slice(0,3)) {
  const m = c.mismatch!;
  console.log(`\n${m.score}/100  ${c.title}`);
  console.log(`  grappler=${m.grappler}`);
  if (m.physical) { console.log(`  physical: reach=${m.physical.reach_advantage_inches} age=${m.physical.age_gap_years} open=${m.physical.open_stance} stances=${JSON.stringify(m.physical.stances)}`);
    m.physical.notes.forEach(n=>console.log(`     · ${n.slice(0,92)}`)); }
  if (c.market) { console.log(`  market: ${c.sides[0].name} ${(c.market.fair[0]*100).toFixed(0)}% / ${c.sides[1].name} ${(c.market.fair[1]*100).toFixed(0)}% margin ${((c.market.overround-1)*100).toFixed(1)}%`);
    if (c.market.tension) console.log(`     TENSION: ${c.market.tension.slice(0,110)}`); }
}
