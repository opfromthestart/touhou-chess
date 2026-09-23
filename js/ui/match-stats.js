// match-stats.js — pure helpers for the end-of-game "match report".
//
// Aggregates the per-fight summaries (DanmakuEngine.getSummary, see
// js/danmaku/engine.js) into a single match-level danmaku record, and formats
// numbers/times for display. No DOM, no CONFIG, no RNG — pure and unit-testable
// (tests/test-match-stats.js). The game-over modal (js/main.js showGameOver)
// renders this record as the "Danmaku record" section.

// Sum an array of fight summaries into a match-level record. Each summary has
// the shape of DanmakuEngine.getSummary(): { result, score, graze, lives,
// startLives, time, cardsBroken }. Missing/null entries are skipped defensively
// (so a partial or hand-built log can't crash the report).
function aggregateFights(summaries) {
  const agg = {
    fights: 0,      // number of fights played
    score: 0,       // total danmaku score across all fights
    graze: 0,       // total grazes
    cardsBroken: 0, // total spell cards broken by damage
    time: 0,        // total seconds spent in fights
    bestScore: 0,   // highest single-fight score
  };
  if (!Array.isArray(summaries)) return agg;
  for (const s of summaries) {
    if (!s) continue;
    agg.fights += 1;
    agg.score += s.score || 0;
    agg.graze += s.graze || 0;
    agg.cardsBroken += Array.isArray(s.cardsBroken) ? s.cardsBroken.length : 0;
    agg.time += s.time || 0;
    if ((s.score || 0) > agg.bestScore) agg.bestScore = s.score;
  }
  return agg;
}

// Group fight summaries by boss into per-boss records, sorted by total score
// (descending; ties broken by more fights, then boss id for determinism).
//
// Each summary is expected to carry a `bossId` (the boss character id, attached
// by js/main.js when the fight ends). Summaries without a bossId are grouped
// under 'unknown' so a partial/hand-built log still renders. Returns an array
// of { bossId, fights, wins, losses, score, bestScore, graze, cardsBroken }.
// `wins`/`losses` count the player's outcome (result 'win' / 'lose').
function groupFightsByBoss(summaries) {
  const byBoss = new Map();
  if (!Array.isArray(summaries)) return [];
  for (const s of summaries) {
    if (!s) continue;
    const bossId = s.bossId || 'unknown';
    let b = byBoss.get(bossId);
    if (!b) {
      b = {
        bossId,
        fights: 0,
        wins: 0,
        losses: 0,
        score: 0,
        bestScore: 0,
        graze: 0,
        cardsBroken: 0,
      };
      byBoss.set(bossId, b);
    }
    b.fights += 1;
    if (s.result === 'win') b.wins += 1;
    else if (s.result === 'lose') b.losses += 1;
    b.score += s.score || 0;
    b.graze += s.graze || 0;
    b.cardsBroken += Array.isArray(s.cardsBroken) ? s.cardsBroken.length : 0;
    if ((s.score || 0) > b.bestScore) b.bestScore = s.score;
  }
  const list = [...byBoss.values()];
  list.sort((a, b) =>
    b.score - a.score ||
    b.fights - a.fights ||
    (a.bossId < b.bossId ? -1 : a.bossId > b.bossId ? 1 : 0)
  );
  return list;
}

// Format seconds as m:ss (e.g. 45 -> "0:45", 75 -> "1:15", 3725 -> "62:05").
function formatFightTime(seconds) {
  const sec = Math.max(0, Math.floor(seconds));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { aggregateFights, groupFightsByBoss, formatFightTime };
}
