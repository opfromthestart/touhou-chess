// test-fight-summary.js — unit tests for the danmaku engine's fight summary
// (DanmakuEngine.getSummary, js/danmaku/engine.js) and the per-card `broken`
// tracking that powers the "Fight summary" on the result screen.
//
// The summary is read-only and purely presentational: it reports how a fight
// went (score, lives left, graze, time, which spell cards were broken) without
// touching bullet behavior, the RNG, or win/lose logic. These tests confirm
// the fields are correct and that breaking a card (vs. timing out) is tracked.
//
// Run: node tests/test-fight-summary.js

global.window = { addEventListener() {}, removeEventListener() {} };
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => 0;

const { BOSSES, getPhases } = require('../js/danmaku/bosses.js'); // sets global.CONFIG
const { DanmakuEngine } = require('../js/danmaku/engine.js');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ok - ' + msg); }
  else { fail++; console.log('  FAIL - ' + msg); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

// Fake canvas: a Proxy ctx where every method is a no-op and every property
// set/get works, so start() -> _loop() -> render() runs harmlessly in Node.
// (Same harness as tests/tmp-engine-test2.js.)
function fakeCanvas(w, h) {
  const grad = { addColorStop() {} };
  const target = {};
  const ctx = new Proxy(target, {
    get(t, p) {
      if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createPattern') return () => grad;
      if (p === 'measureText') return () => ({ width: 0 });
      if (p in t) return t[p];
      return () => undefined;
    },
    set(t, p, v) { t[p] = v; return true; },
  });
  return { width: w, height: h, getContext: () => ctx };
}

// A real boss fight on a controllable engine.
function freshFight(bossId, diff, pieceType = 'p') {
  const e = new DanmakuEngine(fakeCanvas(480, 640), {});
  const phases = getPhases(bossId, diff);
  const boss = { ...BOSSES[bossId], charId: bossId };
  e.start(phases, boss, CONFIG.DANMAKU_STATS[pieceType], pieceType, bossId);
  return e;
}

const INERT_SHOTS = { type: 'normal', count: 0, spread: 0, speed: 6, r: 3, color: '#fff', damage: 1, interval: 999999 };

// ===========================================================================
section('Fresh fight (not yet ended)');
{
  const e = freshFight('rumia', 'normal');
  const s = e.getSummary();
  const startLives = CONFIG.DANMAKU_STATS.p.lives;
  assert(s.result === null, 'result is null before the fight ends');
  assert(s.score === 0, 'score starts at 0');
  assert(s.graze === 0, 'graze starts at 0');
  assert(s.lives === startLives, 'lives = starting lives (' + startLives + ')');
  assert(s.startLives === startLives, 'startLives = configured lives for the piece');
  assert(Array.isArray(s.cardsBroken) && s.cardsBroken.length === 0, 'no cards broken yet');
  assert(s.time === 0, 'time starts at 0');
}

// ===========================================================================
section('startLives follows the piece type');
{
  const eK = freshFight('rumia', 'normal', 'k');
  const eP = freshFight('rumia', 'normal', 'p');
  assert(eK.startLives === CONFIG.DANMAKU_STATS.k.lives, 'king startLives (' + eK.startLives + ')');
  assert(eP.startLives === CONFIG.DANMAKU_STATS.p.lives, 'pawn startLives (' + eP.startLives + ')');
  assert(eK.getSummary().startLives === eK.startLives, 'summary startLives matches the engine');
}

// ===========================================================================
section('Lost fight reports the final stats');
{
  const e = freshFight('rumia', 'normal');
  const startLives = CONFIG.DANMAKU_STATS.p.lives;
  e.player.lives = 0; // overwhelmed
  e.score = 12345;
  e.graze = 7;
  e.time = 42.5;
  e._end('lose');
  const s = e.getSummary();
  assert(s.result === 'lose', 'result is lose');
  assert(s.lives === 0, 'lives left is 0');
  assert(s.startLives === startLives, 'startLives preserved after the fight');
  assert(s.score === 12345, 'score reported (' + s.score + ')');
  assert(s.graze === 7, 'graze reported (' + s.graze + ')');
  assert(s.time >= 42.5 && s.time < 43, 'time reported (~42.5s, got ' + s.time + ')');
}

// ===========================================================================
section('Won fight keeps lives remaining');
{
  const e = freshFight('rumia', 'normal');
  e.player.lives = 2; // survived with 2 lives left
  e.score = 500;
  e._end('win');
  const s = e.getSummary();
  assert(s.result === 'win', 'result is win');
  assert(s.lives === 2, 'lives left is 2 (a narrow-ish win)');
  assert(s.startLives === CONFIG.DANMAKU_STATS.p.lives, 'startLives intact');
}

// ===========================================================================
section('Breaking a card records it in cardsBroken');
{
  const e = freshFight('rumia', 'normal');
  e.shotPattern = INERT_SHOTS;
  const cardName = e.phases[0].name;
  for (let i = 0; i < 30; i++) e.update(); // let the card run
  e.phaseHp = 0; // destroy the HP gauge
  e.update();
  assert(e.phaseStats[0].broken === true, 'the broken card is flagged broken');
  assert(e.phaseIndex === 1, 'the fight advanced past the broken card');
  const s = e.getSummary();
  assert(s.cardsBroken.includes(cardName), 'cardsBroken lists the broken card: "' + s.cardsBroken.join(', ') + '"');
  assert(s.cardsBroken.length === 1, 'exactly one card broken so far');
}

// ===========================================================================
section('A card that times out is NOT marked broken');
{
  const e = freshFight('rumia', 'normal');
  e.shotPattern = INERT_SHOTS;
  const cardName = e.phases[0].name;
  // Let the first card elapse on its clock (not by HP) so it ends by timeout.
  e.phaseTime = e.phases[0].duration + 1;
  e.phaseHp = e.phaseMaxHp; // full HP -> not broken
  e.update();
  assert(e.phaseStats[0].broken === false, 'timed-out card is not flagged broken');
  assert(e.phaseIndex === 1, 'the fight advanced past the timed-out card');
  assert(!e.getSummary().cardsBroken.includes(cardName), 'timed-out card is not in cardsBroken');
}

// ===========================================================================
section('getSummary is read-only / idempotent');
{
  const e = freshFight('rumia', 'normal');
  e.shotPattern = INERT_SHOTS;
  for (let i = 0; i < 60; i++) e.update();
  e.player.lives = 1; e.score = 900; e.graze = 3;
  const a = JSON.stringify(e.getSummary());
  const b = JSON.stringify(e.getSummary());
  const c = JSON.stringify(e.getSummary());
  assert(a === b && b === c, 'repeated calls return the same summary');
  // Calling it must not disturb the live fight state.
  assert(e.player.lives === 1 && e.score === 900 && e.graze === 3, 'engine state unchanged by getSummary');
  assert(e.running === true, 'fight still running after getSummary');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
