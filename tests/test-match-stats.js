// test-match-stats.js — unit tests for the end-of-game "match report" helpers
// (js/ui/match-stats.js): aggregateFights + groupFightsByBoss + formatFightTime.
//
// These are pure functions (no DOM/CONFIG/RNG) that turn the per-fight
// summaries (DanmakuEngine.getSummary) into a match-level "Danmaku record"
// shown in the game-over modal. The game-over rendering itself is covered by
// the CDP e2e test (tests/mp_match_report_test.js).
//
// Run: node tests/test-match-stats.js

'use strict';
const { aggregateFights, groupFightsByBoss, formatFightTime } = require('../js/ui/match-stats.js');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ok - ' + msg); }
  else { fail++; console.log('  FAIL - ' + msg); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

// A realistic getSummary() shape (see DanmakuEngine.getSummary).
function summary(over) {
  return Object.assign({
    result: 'win',
    score: 0,
    graze: 0,
    lives: 1,
    startLives: 1,
    time: 0,
    cardsBroken: [],
  }, over);
}

// ===========================================================================
section('aggregateFights — empty / defensive inputs');
{
  const empty = aggregateFights([]);
  assert(empty.fights === 0 && empty.score === 0 && empty.graze === 0,
    'empty array -> all zeros');
  assert(empty.cardsBroken === 0 && empty.time === 0 && empty.bestScore === 0,
    'empty array -> cardsBroken/time/bestScore zero');
  for (const bad of [null, undefined, 'x', 42]) {
    const r = aggregateFights(bad);
    assert(r.fights === 0 && r.score === 0, 'non-array input (' + String(bad) + ') -> all zeros, no throw');
  }
  // Null entries inside the array are skipped without throwing.
  const withNulls = aggregateFights([null, undefined, summary({ score: 100 })]);
  assert(withNulls.fights === 1 && withNulls.score === 100,
    'null/undefined entries are skipped, valid ones counted');
}

// ===========================================================================
section('aggregateFights — single fight');
{
  const s = summary({ score: 5000, graze: 12, time: 45.4, cardsBroken: ['Nocturnal Danmaku (non-spell)'] });
  const r = aggregateFights([s]);
  assert(r.fights === 1, 'one fight counted');
  assert(r.score === 5000, 'score = 5000');
  assert(r.graze === 12, 'graze = 12');
  assert(r.cardsBroken === 1, 'cardsBroken = 1 (one card broken)');
  assert(r.time === 45.4, 'time = 45.4');
  assert(r.bestScore === 5000, 'bestScore = the single fight score');
}

// ===========================================================================
section('aggregateFights — multiple fights (sums + best)');
{
  const a = summary({ score: 1000, graze: 3, time: 30, cardsBroken: [] });
  const b = summary({ score: 2500, graze: 5, time: 40, cardsBroken: ['A', 'B'] });
  const c = summary({ score: 4000, graze: 2, time: 50, cardsBroken: ['C'] });
  const r = aggregateFights([a, b, c]);
  assert(r.fights === 3, 'three fights counted');
  assert(r.score === 7500, 'total score = 1000+2500+4000 = 7500');
  assert(r.graze === 10, 'total graze = 3+5+2 = 10');
  assert(r.cardsBroken === 3, 'total cards broken = 0+2+1 = 3');
  assert(r.time === 120, 'total time = 30+40+50 = 120');
  assert(r.bestScore === 4000, 'bestScore = max(1000,2500,4000) = 4000');
}

// ===========================================================================
section('aggregateFights — missing/defensive fields');
{
  // A summary missing some fields (or with nulls) must not crash and must
  // treat missing values as zero.
  const partial = { score: 100 }; // no graze/time/cardsBroken/result
  const r = aggregateFights([partial]);
  assert(r.fights === 1 && r.score === 100, 'partial summary counted with score');
  assert(r.graze === 0 && r.time === 0 && r.cardsBroken === 0, 'missing fields treated as 0');
  assert(r.bestScore === 100, 'bestScore from partial summary');

  // cardsBroken not an array (defensive) -> contributes 0.
  const weirdCards = summary({ cardsBroken: 'not-an-array' });
  const r2 = aggregateFights([weirdCards]);
  assert(r2.cardsBroken === 0, 'non-array cardsBroken contributes 0');
}

// ===========================================================================
section('groupFightsByBoss — empty / defensive inputs');
{
  assert(groupFightsByBoss([]).length === 0, 'empty array -> no bosses');
  for (const bad of [null, undefined, 'x', 42]) {
    assert(groupFightsByBoss(bad).length === 0, 'non-array input (' + String(bad) + ') -> [], no throw');
  }
  // Null entries are skipped without throwing.
  const withNulls = groupFightsByBoss([null, undefined, summary({ bossId: 'rumia', score: 100 })]);
  assert(withNulls.length === 1 && withNulls[0].bossId === 'rumia' && withNulls[0].fights === 1,
    'null/undefined entries skipped, valid boss grouped');
}

// ===========================================================================
section('groupFightsByBoss — single boss');
{
  const s = summary({ bossId: 'kaguya', result: 'win', score: 5000, graze: 12, time: 45, cardsBroken: ['Moon Sign "Moonlight Ray"'] });
  const r = groupFightsByBoss([s]);
  assert(r.length === 1, 'one boss');
  const b = r[0];
  assert(b.bossId === 'kaguya', 'bossId = kaguya');
  assert(b.fights === 1, 'fights = 1');
  assert(b.wins === 1 && b.losses === 0, 'record 1W-0L');
  assert(b.score === 5000, 'score = 5000');
  assert(b.bestScore === 5000, 'bestScore = 5000');
  assert(b.graze === 12, 'graze = 12');
  assert(b.cardsBroken === 1, 'cardsBroken = 1');
}

// ===========================================================================
section('groupFightsByBoss — multiple bosses (grouping + sorting)');
{
  // remilia: two fights (1 win, 1 loss), total 3000, best 2000, 2 cards.
  // kaguya:  one fight (win),          total 5000, best 5000, 1 card.
  // alice:    one fight (loss),        total 1000, best 1000, 0 cards.
  const r = groupFightsByBoss([
    summary({ bossId: 'remilia', result: 'win',  score: 2000, graze: 4, cardsBroken: ['A', 'B'] }),
    summary({ bossId: 'kaguya',  result: 'win',  score: 5000, graze: 12, cardsBroken: ['C'] }),
    summary({ bossId: 'remilia', result: 'lose', score: 1000, graze: 2, cardsBroken: [] }),
    summary({ bossId: 'alice',   result: 'lose', score: 1000, graze: 1, cardsBroken: [] }),
  ]);
  assert(r.length === 3, 'three distinct bosses');
  // Sorted by total score desc: kaguya(5000) > remilia(3000) > alice(1000).
  assert(r[0].bossId === 'kaguya', 'highest-score boss first (kaguya)');
  assert(r[1].bossId === 'remilia', 'second (remilia)');
  assert(r[2].bossId === 'alice', 'third (alice)');
  const rem = r[1];
  assert(rem.fights === 2, 'remilia faced twice');
  assert(rem.wins === 1 && rem.losses === 1, 'remilia record 1W-1L');
  assert(rem.score === 3000, 'remilia total score 3000');
  assert(rem.bestScore === 2000, 'remilia best 2000');
  assert(rem.cardsBroken === 2, 'remilia 2 cards broken');
}

// ===========================================================================
section('groupFightsByBoss — tie-break + missing bossId');
{
  // Two bosses with the SAME total score -> tie broken by more fights first,
  // then boss id ascending (deterministic).
  const r = groupFightsByBoss([
    summary({ bossId: 'yukari',  result: 'win', score: 1000 }),
    summary({ bossId: 'patchouli', result: 'win', score: 500 }),
    summary({ bossId: 'patchouli', result: 'win', score: 500 }),
  ]);
  // patchouli total 1000 (2 fights) ties yukari total 1000 (1 fight).
  // patchouli has more fights -> comes first.
  assert(r[0].bossId === 'patchouli', 'tie: more fights first (patchouli 2 fights)');
  assert(r[1].bossId === 'yukari', 'tie: fewer fights second (yukari 1 fight)');

  // Missing/empty bossId -> grouped under 'unknown'.
  const r2 = groupFightsByBoss([summary({ score: 100 }), summary({ bossId: '', score: 200 })]);
  assert(r2.length === 1 && r2[0].bossId === 'unknown', 'missing/empty bossId grouped as unknown');
  assert(r2[0].fights === 2 && r2[0].score === 300, 'unknown accumulates both fights');
}

// ===========================================================================
section('groupFightsByBoss — defensive fields');
{
  // A summary missing result/score/cardsBroken must not crash and must treat
  // missing values as 0 / not-a-win-or-loss.
  const partial = { bossId: 'hina' };
  const r = groupFightsByBoss([partial]);
  assert(r.length === 1 && r[0].fights === 1, 'partial summary counted as one fight');
  assert(r[0].wins === 0 && r[0].losses === 0, 'no result -> neither win nor loss');
  assert(r[0].score === 0 && r[0].cardsBroken === 0, 'missing score/cards treated as 0');

  // Non-array cardsBroken contributes 0.
  const r2 = groupFightsByBoss([summary({ bossId: 'nitori', cardsBroken: 'oops' })]);
  assert(r2[0].cardsBroken === 0, 'non-array cardsBroken contributes 0');
}

// ===========================================================================
section('formatFightTime');
{
  assert(formatFightTime(0) === '0:00', '0 -> 0:00');
  assert(formatFightTime(45) === '0:45', '45 -> 0:45');
  assert(formatFightTime(59) === '0:59', '59 -> 0:59');
  assert(formatFightTime(60) === '1:00', '60 -> 1:00');
  assert(formatFightTime(75) === '1:15', '75 -> 1:15');
  assert(formatFightTime(3725) === '62:05', '3725 -> 62:05');
  assert(formatFightTime(45.9) === '0:45', 'fractional seconds floor (45.9 -> 0:45)');
  assert(formatFightTime(-5) === '0:00', 'negative clamps to 0:00');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
