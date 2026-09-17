// tmp-aimtime-check.js — verify em.aimTime makes an emitter aim at the
// player's PAST position (Swallow's Cowrie Shell coordination fix).
//
// em.aimTime is a LOOKBACK DELAY: aim at the player's position that many
// seconds BEFORE THE FIRE INSTANT (not an absolute phase time). This keeps
// re-firing emitters coordinated: the Cowrie fan fires 1.0s after the laser
// wall on every volley, so aimTime:1.0 tracks the wall's LATEST aim across
// the whole card instead of pinning to the first volley's snapshot.
//
// Setup: boss at (240,90). Player sits at (240,560) until t=1.6s, then slides
// left to (140,560) by t=2.6s (and stays there).
//
// The real spell's fan uses angleOffset: PI, so it is centered on the
// anti-player direction and its 1/18-TAU GAP points at the player (the safe
// pocket). Key claims:
//   1. First fire (t=2.6, aimTime:1.0) anchors the gap at the player's
//      t=1.6 position (dead below the boss).
//   2. Without aimTime the gap anchors at the t=2.6 position (drifted left).
//   3. Second fire (t=5.8, aimTime:1.0) anchors at the player's t=4.8
//      position — i.e. it FOLLOWS the player, it does not reuse the first
//      fire's snapshot.
//
// Bullets are captured at the instant of firing (before any off-screen cull)
// so the angular distribution is intact.
global.window = { addEventListener() {}, removeEventListener() {} };
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => 0;

const { getPhases } = require('../js/danmaku/bosses.js');
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

function mkEngine() {
  const e = new DanmakuEngine(fakeCanvas(480, 640), {});
  e.boss = { x: 240, y: 90, move: 'still' };
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

// Run until the fan's NTH fire (n=1 default), returning a snapshot of the
// fan bullets' (vx, vy) at that instant. moveFn scripts the player each
// frame. A "fire" is any frame in which _emitPattern added bullets.
function fanAnglesAtFire(e, emitDef, moveFn, n = 1) {
  e.phases[0].emits = [emitDef];
  let fires = 0;
  for (let f = 0; f < 60 * 8; f++) {
    e.frame++; e.time += 1 / 60; e.phaseTime += 1 / 60;
    moveFn(e, f);
    e._updatePlayer();
    const before = e.bullets.length;
    e._emitPattern();
    if (e.bullets.length > before) {
      fires++;
      if (fires === n) {
        // Fan just fired — snapshot the new bullets' directions.
        return e.bullets.slice(before).map(b => Math.atan2(b.vy, b.vx));
      }
    }
    e._updateBullets();
  }
  return null;
}

// Largest angular gap among a sorted list of angles, and its center.
function findGap(angles) {
  if (!angles) return { center: NaN, width: 0 }; // no fire captured -> NaN fails the assert
  const a = angles.slice().sort((x, y) => x - y);
  let maxGap = 0, gapStart = 0;
  for (let i = 0; i < a.length; i++) {
    const next = (i + 1) % a.length;
    let g = a[next] - a[i];
    if (i === a.length - 1) g += 2 * Math.PI; // wrap-around
    if (g > maxGap) { maxGap = g; gapStart = a[i]; }
  }
  let center = gapStart + maxGap / 2;
  while (center > Math.PI) center -= 2 * Math.PI;
  while (center <= -Math.PI) center += 2 * Math.PI;
  return { center, width: maxGap };
}

// Move the player left starting just after t=1.6s.
function moveLeft(e, f) {
  const t = f / 60;
  if (t > 1.6) e.player.x = Math.max(140, 240 - (t - 1.6) * 100);
}

const FAN_BASE = { t: 2.6, type: 'fan', count: 120, speed: 3, spread: (2 * Math.PI * 17) / 18, r: 10, interval: 99, angleOffset: Math.PI };

// NOTE on geometry: the fan is CENTERED on baseAngle = aim + angleOffset(=PI),
// so its 1/18-TAU GAP sits at baseAngle + PI = aim — i.e. the gap points at
// the player. The safe pocket is therefore anchored at the player's position.
// aimTime moves that anchor to the player's PAST position.

// ── 1. First fire: lookback 1.0s from t=2.6 -> gap anchored at t=1.6 ───────
{
  const e = mkEngine();
  const angles = fanAnglesAtFire(e, Object.assign({}, FAN_BASE, { aimTime: 1.0 }), moveLeft, 1);
  assert(angles && angles.length === 120, 'aimTime fan fired 120 bullets (' + (angles ? angles.length : 0) + ')');
  const gap = findGap(angles);
  // At t=1.6 the player is dead below the boss (240,560) -> aim = PI/2.
  assert(Math.abs(gap.center - Math.PI / 2) < 0.05,
    'first-fire gap anchored at t=1.6 player pos (center=' + gap.center.toFixed(3) + ', want ' + (Math.PI / 2).toFixed(3) + ')');
}

// ── 2. Control: no aimTime -> gap anchored at the player's t=2.6 position ──
{
  const e = mkEngine();
  const angles = fanAnglesAtFire(e, Object.assign({}, FAN_BASE), moveLeft);
  assert(angles && angles.length === 120, 'plain fan fired 120 bullets (' + (angles ? angles.length : 0) + ')');
  const gap = findGap(angles);
  // At t=2.6 the player is at (140,560) -> aim = atan2(470,-100) ≈ 1.782.
  const expect = Math.atan2(470, -100);
  assert(Math.abs(gap.center - expect) < 0.05,
    'no-aimTime fan gap anchored at t=2.6 player pos (center=' + gap.center.toFixed(3) + ', want ' + expect.toFixed(3) + ')');
}

// ── 3. The two gap centers actually differ (the bug is real & fixed) ───────
{
  const e1 = mkEngine();
  const e2 = mkEngine();
  const a1 = fanAnglesAtFire(e1, Object.assign({}, FAN_BASE, { aimTime: 1.0 }), moveLeft, 1);
  const a2 = fanAnglesAtFire(e2, Object.assign({}, FAN_BASE), moveLeft, 1);
  const d = Math.abs(findGap(a1).center - findGap(a2).center);
  assert(d > 0.1, 'aimTime vs no-aimTime gap centers differ by ' + d.toFixed(3) + ' rad (> 0.1)');
}

// ── 4. Refires FOLLOW the player (the re-aim regression) ───────────────────
// The fan refires at t=5.8. With lookback semantics it must aim at the
// player's t=4.8 position — NOT reuse the first fire's t=1.6 snapshot.
// (The old phase-absolute aimTime pinned every volley to t=1.6, so the gap
// stopped aligning with the re-aimed laser corridor after the first volley.)
{
  const e = mkEngine();
  // interval: 3.2 matches the real spell's refire cadence (FAN_BASE uses 99
  // so tests 1-3 see a single volley).
  const angles = fanAnglesAtFire(e, Object.assign({}, FAN_BASE, { aimTime: 1.0, interval: 3.2 }), moveLeft, 2);
  assert(angles && angles.length === 120, 'second fire produced 120 bullets (' + (angles ? angles.length : 0) + ')');
  const gap = findGap(angles);
  // At t=4.8 the player is clamped at (140,560) -> aim = atan2(470,-100).
  const expect = Math.atan2(470, -100);
  assert(Math.abs(gap.center - expect) < 0.05,
    'second-fire gap anchored at t=4.8 player pos (center=' + gap.center.toFixed(3) + ', want ' + expect.toFixed(3) + ')');
  // And it must NOT be the first fire's anchor (PI/2).
  assert(Math.abs(gap.center - Math.PI / 2) > 0.1,
    'second fire does not reuse the first fire\'s snapshot (center=' + gap.center.toFixed(3) + ')');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
