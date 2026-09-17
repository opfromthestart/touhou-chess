// tmp-slide-check.js — verify the Touhou-style 'slide' boss movement mode:
//   1. boss holds still for holdDur, slides over slideDur, holds again
//   2. deterministic (same fight -> same trajectory)
//   3. cycle re-arms at each phase change (card opens with boss static)
global.window = { addEventListener() {}, removeEventListener() {} };
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => 0;

const { DanmakuEngine } = require('../js/danmaku/engine.js');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log('FAIL: ' + msg); }
}

function fakeCanvas(w, h) {
  const grad = { addColorStop() {} };
  const target = {};
  const ctx = new Proxy(target, {
    get(t, p) {
      if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createPattern') return () => grad;
      if (p in t) return t[p];
      return () => {};
    },
    set(t, p, v) { t[p] = v; return true; },
  });
  return { width: w, height: h, getContext: () => ctx };
}

function mkEngine(bossMove) {
  const e = new DanmakuEngine(fakeCanvas(480, 640), {});
  e.boss = Object.assign({ x: 240, y: 90, move: 'still' }, bossMove);
  e.player = { x: 240, y: 560, speed: 4, lives: 99, bombs: 99, hitbox: 6, focusHitbox: 2, focus: false, invuln: 0, alive: true };
  e.shotPattern = { type: 'normal', count: 1, spread: 0, speed: 6, r: 3, color: '#fff', damage: 1, interval: 999999 };
  e.bullets = [];
  e.playerShots = [];
  e.frame = 0; e.time = 0; e.phaseTime = 0;
  e.phases = [{ name: 'test', duration: 9999, hp: 10000, emits: [] }];
  e.phaseIndex = 0;
  e.phaseHp = 10000; e.phaseMaxHp = 10000;
  return e;
}

function step(e, n) {
  for (let i = 0; i < n; i++) {
    e.frame++; e.time += 1 / 60; e.phaseTime += 1 / 60;
    e._updatePlayer();
    e._updateBoss();
    e._emitPattern();
    e._updateBullets();
  }
}

const SLIDE = { move: 'slide', holdDur: 3, slideDur: 0.6, slideDist: 140 };

// ── 1. Hold -> slide -> hold rhythm (exact frame counts, 60 fps) ───────────
{
  const e = mkEngine(SLIDE);
  step(e, 174); // t=2.9
  assert(Math.abs(e.boss.x - 240) < 0.01 && Math.abs(e.boss.y - 90) < 0.01,
    'boss still at start pos at t=2.9s (x=' + e.boss.x.toFixed(1) + ')');
  step(e, 30); // t=3.5: mid-slide (slide starts at frame 180, ends 217)
  assert(Math.abs(e.boss.x - 240) > 5, 'boss has started moving by t=3.5s (x=' + e.boss.x.toFixed(1) + ')');
  step(e, 20); // t=3.83: slide long done
  const endX = e.boss.x, endY = e.boss.y;
  assert(e.boss._sl.holding === true, 'slide complete, back to holding');
  assert(Math.abs(endX - 240) > 20, 'boss reached a new position after slide (x=' + endX.toFixed(1) + ')');
  assert(endX >= 20 && endX <= 460 && endY >= 20 && endY <= 320,
    'slide target within top region (' + endX.toFixed(1) + ',' + endY.toFixed(1) + ')');
  step(e, 120); // t=5.83: still in the second hold (ends at frame 397)
  assert(Math.abs(e.boss.x - endX) < 0.01 && Math.abs(e.boss.y - endY) < 0.01,
    'boss holds still after sliding (x=' + e.boss.x.toFixed(1) + ', was ' + endX.toFixed(1) + ')');
  step(e, 75); // t=7.08: second slide should be underway (hold ends frame 397)
  assert(e.boss._sl.holding === false, 'second slide is underway after the next hold');
}

// ── 2. Determinism: identical fights -> identical trajectories ──────────────
{
  const traj = () => {
    const e = mkEngine(SLIDE);
    const pts = [];
    for (let f = 0; f < 60 * 12; f++) {
      e.frame++; e.time += 1 / 60; e.phaseTime += 1 / 60;
      e._updatePlayer(); e._updateBoss(); e._emitPattern(); e._updateBullets();
      if (f % 60 === 0) pts.push(e.boss.x.toFixed(2) + ',' + e.boss.y.toFixed(2));
    }
    return pts.join('|');
  };
  assert(traj() === traj(), 'two identical slide fights produce identical trajectories');
}

// ── 3. Phase change re-arms the cycle (boss holds at card start) ────────────
{
  const e = mkEngine(SLIDE);
  step(e, 60 * 4.5); // mid/after first slide of phase 0
  const px = e.boss.x, py = e.boss.y;
  // Simulate advancing to the next card.
  e.phaseIndex = 1; e.phaseTime = 0;
  e.phases[1] = { name: 'p2', duration: 9999, hp: 10000, emits: [] };
  step(e, 60 * 1); // t=1s into the new card
  assert(Math.abs(e.boss.x - px) < 0.01 && Math.abs(e.boss.y - py) < 0.01,
    'new card opens with boss holding at its current position (x=' + e.boss.x.toFixed(1) + ')');
}

// ── 4. Kaguya uses slide; no boss uses sine anymore ─────────────────────────
{
  const { BOSSES } = require('../js/danmaku/bosses.js');
  const moves = Object.values(BOSSES).map(b => b.move);
  assert(!moves.includes('sine'), 'no boss uses sine anymore (moves: ' + [...new Set(moves)].join(', ') + ')');
  assert(BOSSES.kaguya.move === 'slide', 'kaguya uses slide');
  assert(BOSSES.patchouli.move === 'still' && BOSSES.yuyuko.move === 'still',
    'patchouli + yuyuko are still');
}

// ── 5. Per-card (per-phase) holdDur override ────────────────────────────────
{
  // Boss default holdDur 3, but the card overrides to 1 -> the slide starts
  // at t=1s (frame 60), not t=3s (frame 180).
  const e = mkEngine({ move: 'slide', holdDur: 3, slideDur: 0.6, slideDist: 140 });
  e.phases[0].holdDur = 1; // per-card override
  step(e, 59); // t=0.983: still within the 1s card hold
  assert(Math.abs(e.boss.x - 240) < 0.01,
    'per-card: still holding at t~1s (x=' + e.boss.x.toFixed(1) + ')');
  step(e, 3); // frame 62: past the 1s card hold -> sliding
  assert(e.boss._sl.holding === false,
    'per-card: slide started at the card holdDur (1s), not the boss 3s');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
