// tmp-engine-test2.js — headless tests for the upgraded danmaku engine:
//   - determinism (seeded RNG)
//   - Taisei general physics mode (retention/accel/attraction/maxDist/osc)
//   - motion scripts (fly/hold/aim/tangent), per-bullet + field freeze
//   - new emitters (volley/ringFan/arc+center/wall/edge/column/gap/spawnBullet/doll)
//   - phase beams (hit/graze/bomb-clear), seeded jitter
//   - Rumia rewrite + full-fight smoke + regression of all 9 bosses x 2 difficulties
// Run with: node tmp-engine-test2.js
global.window = { addEventListener() {}, removeEventListener() {} };
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => 0;

const { BOSSES, getPhases } = require('../js/danmaku/bosses.js'); // sets global.CONFIG
const { DanmakuEngine, makeBullet } = require('../js/danmaku/engine.js');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log('FAIL: ' + msg); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

// Fake canvas: a Proxy ctx where every method is a no-op and every property
// set/get works, so start() -> _loop() -> render() runs harmlessly in Node.
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

// A bare engine with a controllable player and an inert shot pattern.
function mkEngine(W = 480, H = 640) {
  const e = new DanmakuEngine(fakeCanvas(W, H), {});
  e.boss = { x: W / 2, y: 90, move: 'still' };
  e.player = { x: W / 2, y: H - 80, speed: 4, lives: 99, bombs: 99, hitbox: 6, focusHitbox: 2, focus: false, invuln: 0, alive: true };
  e.shotPattern = { type: 'normal', count: 1, spread: 0, speed: 6, r: 3, color: '#fff', damage: 1, interval: 999999 };
  e.bullets = [];
  e.playerShots = [];
  e.frame = 0; e.time = 0; e.phaseTime = 0;
  e.phases = [{ name: 'test', duration: 9999, hp: 10000, emits: [] }];
  e.phaseIndex = 0;
  // Positive gauge: update() ends the fight when phaseHp <= 0, so an hp:0
  // test phase would win instantly on the first update().
  e.phaseHp = 10000; e.phaseMaxHp = 10000;
  return e;
}
function step(e, n) {
  for (let i = 0; i < n; i++) {
    e.frame++; e.time += 1 / 60; e.phaseTime += 1 / 60;
    e._updateBullets();
  }
}
function freshFight(bossId, diff, pieceType = 'p') {
  const e = new DanmakuEngine(fakeCanvas(480, 640), {});
  const phases = getPhases(bossId, diff);
  const boss = { ...BOSSES[bossId], charId: bossId };
  e.start(phases, boss, CONFIG.DANMAKU_STATS[pieceType], pieceType, bossId);
  return e;
}

// ────────────────────────────────────────────────────────────────────────────
section('Determinism (seeded RNG)');
{
  const a = freshFight('rumia', 'lunatic');
  const b = freshFight('rumia', 'lunatic');
  for (let i = 0; i < 600; i++) { a.update(); b.update(); }
  const snap = e => e.bullets.map(x => [x.x.toFixed(3), x.y.toFixed(3), x.vx.toFixed(3), x.vy.toFixed(3), x.color].join('|')).join(';');
  assert(snap(a) === snap(b), 'two identical fights produce identical bullet fields');
  assert(a.result === b.result, 'both fights end the same way (' + a.result + ')');
  // A different fight identity uses a different RNG stream / pattern data.
  const c = freshFight('cirno', 'normal');
  for (let i = 0; i < 300; i++) c.update();
  assert(snap(c) !== snap(a), 'different fight -> different field');
}

// ────────────────────────────────────────────────────────────────────────────
section('Taisei general physics mode');
{
  // Asymptotic approach to a target velocity: v_terminal = accel/(1-retention).
  // move_asymptotic_simple(vel, k) is exactly this integrator in taisei.
  const e = mkEngine();
  const b = makeBullet(100, 100, 0, 0, { accelX: 0.1, retention: 0.9, life: 9999 });
  e.bullets.push(b);
  step(e, 300);
  const vT = 0.1 / 0.1; // = 1.0 px/frame
  assert(Math.abs(b.vx - vT) < 0.01, 'asymptotic velocity converges to accel/(1-ret) (got ' + b.vx.toFixed(3) + ')');
  assert(b.x > 100 && Math.abs(b.x - (100 + 300 * vT)) < 30, 'displacement approaches terminal-speed travel (x=' + b.x.toFixed(0) + ')');

  // Spring attraction to the player with damping (move_towards family).
  // Compact geometry so the spiral overshoot stays on screen (off-screen
  // bullets are culled, which would mask the convergence).
  const e2 = mkEngine();
  const b2 = makeBullet(240, 460, 0, 0, { attraction: 0.05, attractPoint: 'player', retention: 0.9, life: 9999 });
  e2.bullets.push(b2); // player sits at (240, 560): d0 = 100
  step(e2, 200);
  const dEnd = Math.hypot(b2.x - e2.player.x, b2.y - e2.player.y);
  assert(dEnd < 8, 'attraction bullet converges onto the player (d=' + dEnd.toFixed(2) + ')');

  // maxDist: removed once far enough from the SPAWN point.
  const e3 = mkEngine();
  const b3 = makeBullet(100, 100, 5, 0, { maxDist: 100, life: 9999 });
  e3.bullets.push(b3);
  let framesAlive = 0;
  for (let i = 0; i < 60 && b3.active; i++) { e3.frame++; e3._updateBullets(); framesAlive++; }
  assert(!b3.active && framesAlive >= 18 && framesAlive <= 22,
    'maxDist removes at ~100px from spawn (alive ' + framesAlive + ' frames, want ~20)');

  // Oscillating speed factor (Walachia-style modulated movers): net travel
  // over one full period equals base*period (the sine integrates to zero).
  const e4 = mkEngine();
  const b4 = makeBullet(100, 100, 1, 0, { speedOscAmp: 1, speedOscFreq: Math.PI / 10, life: 9999 });
  e4.bullets.push(b4);
  step(e4, 20); // one full period: 2*pi / (pi/10) = 20 frames
  assert(Math.abs(b4.x - 120) < 1.5, 'oscillating speed: net travel over one period = base*period (x=' + b4.x.toFixed(2) + ', want 120)');
}

// ────────────────────────────────────────────────────────────────────────────
section('Motion scripts (fly/hold/aim/tangent)');
{
  // Demarcation blue arc: fan out -> stop -> aim at the player (NOT homing).
  const e = mkEngine();
  e._fireEmitter({
    type: 'fan', count: 3, spread: 0.6, speed: 3, color: '#55f',
    script: [{ dur: 60, mode: 'fly' }, { dur: 30, mode: 'hold' }, { dur: 999999, mode: 'aim', speed: 2.5 }],
  });
  step(e, 60);
  const mid = e.bullets.map(b => ({ x: b.x, y: b.y }));
  step(e, 10);
  assert(e.bullets.every((b, i) => Math.hypot(b.x - mid[i].x, b.y - mid[i].y) < 0.01),
    'script hold stage: bullets stationary');
  // Step into the aim stage, then verify it aims at the player position
  // captured at entry and never re-aims (not homing).
  step(e, 31); // fly(60)+hold(30)+1: aim stage entered on frame 91
  const pos0 = e.bullets.map(b => ({ x: b.x, y: b.y }));
  const v0 = e.bullets.map(b => ({ vx: b.vx, vy: b.vy }));
  const pBefore = { x: e.player.x, y: e.player.y };
  let aimedOk = true;
  for (let i = 0; i < e.bullets.length; i++) {
    const dx = pBefore.x - pos0[i].x, dy = pBefore.y - pos0[i].y;
    if (Math.abs(dx * v0[i].vy - dy * v0[i].vx) > 1) aimedOk = false;
  }
  assert(aimedOk, 'aim stage flies toward the player position captured at entry');
  e.player.x += 60; // move the player AFTER the aim stage began
  step(e, 30);
  let nonHoming = true;
  for (let i = 0; i < e.bullets.length; i++) {
    if (Math.abs(e.bullets[i].vx - v0[i].vx) > 1e-9 || Math.abs(e.bullets[i].vy - v0[i].vy) > 1e-9) nonHoming = false;
  }
  assert(nonHoming, 'aim stage velocity is fixed afterwards (NOT homing)');

  // Tangent stage: perpendicular drift, alternating direction by parity.
  // Boss at screen center so no bullet leaves the viewport mid-flight.
  const e2 = mkEngine();
  e2.boss = { x: 240, y: 320, move: 'still' };
  e2._fireEmitter({
    type: 'ring', count: 8, releaseTangent: true, flyDur: 1, holdDur: 0.2,
    releaseSpeed: 1, speed: 3, color: '#55f', life: 9999,
  });
  step(e2, 78); // past fly(60)+hold(12); 6 frames of tangent drift
  let okEven = true, okOdd = true;
  for (let i = 0; i < e2.bullets.length; i++) {
    const b = e2.bullets[i];
    const rx = b.x - b.sx, ry = b.y - b.sy;
    const d = Math.hypot(rx, ry);
    const dot = (b.vx * rx + b.vy * ry) / d;
    const cross = (rx * b.vy - ry * b.vx) / d;
    if (Math.abs(dot) > 0.05) { okEven = false; okOdd = false; continue; }
    if (Math.sign(cross) !== (i % 2 === 0 ? 1 : -1)) (i % 2 === 0 ? (okEven = false) : (okOdd = false));
  }
  assert(okEven, 'even-index bullets drift tangent one way');
  assert(okOdd, 'odd-index bullets drift tangent the other way');
}

// ────────────────────────────────────────────────────────────────────────────
section('Freeze / release');
{
  // Per-bullet freeze with re-aim on release.
  const e = mkEngine();
  const b = makeBullet(100, 100, 5, 0, { freeze: 30, releaseAngle: Math.PI / 2, releaseSpeed: 3, life: 9999 });
  e.bullets.push(b);
  step(e, 30);
  assert(Math.hypot(b.x - 100, b.y - 100) < 0.01, 'frozen bullet stays put during freeze');
  step(e, 10);
  assert(Math.abs(b.y - 130) < 0.5 && Math.abs(b.x - 100) < 0.5,
    'released bullet moves in releaseAngle at releaseSpeed (x=' + b.x.toFixed(1) + ', y=' + b.y.toFixed(1) + ')');

  // Field freeze (Perfect Freeze style): halt all, recolor white, release.
  const e2 = mkEngine();
  e2.phases[0].freezes = [{ t: 1, hold: 1, release: { mode: 'random', speed: 2 } }];
  e2._fireEmitter({ type: 'ring', count: 12, speed: 3, color: '#ff0000' });
  for (let i = 0; i < 61; i++) e2.update(); // t≈1.02: freeze active
  assert(e2.fieldFreeze !== null && e2.fieldFreeze.until > 1, 'freeze window active at t=1');
  assert(e2.bullets.length > 0 && e2.bullets.every(b => b.color === '#ffffff'), 'field frozen: all bullets recolored white');
  for (let i = 0; i < 62; i++) e2.update(); // t≈2.05: released
  assert(e2.fieldFreeze === null, 'freeze released after hold');
  assert(e2.bullets.every(b => b.color !== '#ffffff'), 'colors restored after release');
  const sp = e2.bullets.map(b => Math.hypot(b.vx, b.vy));
  assert(sp.length > 0 && sp.every(s => Math.abs(s - 2) < 0.01), 'released bullets get the configured speed');
}

// ────────────────────────────────────────────────────────────────────────────
section('New emitter types');
{
  // Volley: same direction, distinct speeds.
  let e = mkEngine();
  e._fireEmitter({ type: 'volley', count: 8, speedMin: 1.5, speedMax: 4.5, color: '#f00' });
  assert(e.bullets.length === 8, 'volley fires 8 bullets');
  const angs = new Set(e.bullets.map(b => Math.atan2(b.vy, b.vx).toFixed(4)));
  assert(angs.size === 1, 'volley bullets share one direction');
  const spds = e.bullets.map(b => Math.hypot(b.vx, b.vy)).sort((a, b) => a - b);
  assert(Math.abs(spds[0] - 1.5) < 0.01 && Math.abs(spds[7] - 4.5) < 0.01, 'volley speeds span [speedMin, speedMax]');

  // RingFan: 16 clusters x 3-way fans, cycling cluster speeds.
  e = mkEngine();
  e._fireEmitter({ type: 'ringFan', count: 16, per: 3, cSpread: 0.3, speeds: [1.5, 2, 2.5, 3], color: '#f00' });
  assert(e.bullets.length === 48, 'ringFan fires 16x3=48 bullets');
  const c0 = e.bullets.slice(0, 3).map(b => Math.hypot(b.vx, b.vy));
  const c1 = e.bullets.slice(3, 6).map(b => Math.hypot(b.vx, b.vy));
  assert(c0.every(s => Math.abs(s - 1.5) < 0.01) && c1.every(s => Math.abs(s - 2) < 0.01),
    'ringFan cluster speeds cycle through em.speeds');

  // Arc with center: 15 winged + 1 dead-aimed = 16 total; wings bank outward.
  e = mkEngine();
  e._fireEmitter({ type: 'arc', count: 15, center: true, spread: 0.9, sideTurn: 0.02, colorLeft: '#55f', colorRight: '#5f5', colorCenter: '#f55' });
  assert(e.bullets.length === 16, 'arc with center fires 16 bullets');
  const left = e.bullets[0], right = e.bullets[14], center = e.bullets[15];
  assert(left.color === '#55f' && right.color === '#5f5' && center.color === '#f55', 'arc colors: left/right/center');
  assert(left.turn > 0 && right.turn < 0 && center.turn === 0, 'arc wings bank outward, center straight');

  // Wall / edge / column / gap.
  e = mkEngine();
  e._fireEmitter({ type: 'wall', side: 'top', spacing: 20, speed: 2, color: '#fff' });
  assert(e.bullets.length > 10 && e.bullets.every(b => b.y < 0 && Math.abs(b.vy - 2) < 0.01), 'wall enters from top moving down');
  e.bullets = [];
  e._fireEmitter({ type: 'edge', side: 'bottom', spacing: 20, speed: 2, color: '#fff' });
  assert(e.bullets.every(b => b.y > 640 && b.vy < 0), 'edge creeps in from bottom');
  e.bullets = [];
  e._fireEmitter({ type: 'column', xn: [0.38, 0.43, 0.57, 0.62], speed: 2.2, color: '#8f8' });
  assert(e.bullets.length === 4, 'column fires one bullet per x position');
  assert(Math.abs(e.bullets[0].x - 0.38 * 480) < 0.01 && Math.abs(e.bullets[3].x - 0.62 * 480) < 0.01, 'column x positions match xn');
  e.bullets = [];
  e._fireEmitter({ type: 'gap', xn: 0.5, yn: 0.5, inner: 'ring', count: 8, speed: 2, color: '#ff0' });
  assert(e.bullets.length === 8 && e.bullets.every(b => Math.hypot(b.x - 240, b.y - 320) < 0.01), 'gap burst fires from the given point');
}

// ────────────────────────────────────────────────────────────────────────────
section('Spawn bullets / dolls / destructibles');
{
  // spawnBullet: sheds children on a timer; shooting it fires deathBurst.
  const e = mkEngine();
  e._fireEmitter({
    type: 'spawnBullet', count: 1, speed: 1, r: 12, hp: 2, color: '#f0f',
    spawnEvery: 30, spawnEmits: { type: 'ring', count: 4, speed: 2, color: '#0ff' },
    deathBurst: { type: 'ring', count: 6, speed: 3, color: '#ff0' },
  });
  const big = e.bullets[0];
  assert(big.destructible && big.hp === 2, 'spawnBullet is destructible with hp');
  step(e, 60); // two shed ticks (frames 30 and 60) x 4 children
  assert(e.bullets.length === 9, 'spawnBullet shed 2x4 children (total 9, got ' + e.bullets.length + ')');
  // Shoot it down: 2 shots x damage 1 = 2 hp.
  for (let i = 0; i < 2; i++) {
    e.playerShots.push({ x: big.x, y: big.y, vx: 0, vy: 0, r: 4, active: true });
    e._updateShots();
  }
  assert(!big.active, 'destructible bullet destroyed at 0 hp');
  assert(e.bullets.filter(b => b.color === '#ff0').length === 6, 'deathBurst fired on destruction');

  // Doll: a destructible shooter that fires its own pattern on an interval.
  const e2 = mkEngine();
  e2._fireEmitter({
    type: 'doll', count: 1, speed: 1, hp: 3, r: 12, color: '#f80',
    shoot: { type: 'aimed', count: 3, spread: 0.5, speed: 2.5 }, interval: 0.5,
  });
  step(e2, 90); // 1.5s => 3 shots x 3 bullets
  assert(e2.bullets.length === 1 + 9, 'doll fired its pattern 3 times (10 bullets total, got ' + e2.bullets.length + ')');
}

// ────────────────────────────────────────────────────────────────────────────
section('Phase beams (Moonlight Ray)');
{
  const e = mkEngine();
  // bombs: 0 — these assertions test beam collision geometry. With bombs in
  // stock the first hit would be held by the deathbomb window (no life lost
  // yet) instead of landing immediately; see the "Deathbomb window" section.
  e.player.bombs = 0;
  e.phases[0].beams = [
    { xn: 0.5, width: 56, color: '#fff3b0', coreColor: '#fff' },                    // bombable
    { x: 100, width: 40, t: 2, dur: 2, warn: 0.5, unclearable: true, color: '#f00' }, // timed + opt-in telegraph
  ];
  // Beams are solid immediately by default (no telegraph).
  e.player.x = 240; e.player.y = 400;
  e._updateBeams();
  assert(e.player.lives === 98, 'beam hit damages the player');
  assert(e.player.invuln > 0, 'beam hit grants invulnerability');
  e._updateBeams();
  assert(e.player.lives === 98, 'invulnerability prevents double-dip');
  // Graze: near the beam but outside the hitbox (halfW 28 + hb 3 < d < +10).
  e.player.invuln = 0;
  e.player.x = 240 + 36;
  e._updateBeams();
  assert(e.graze === 1, 'grazing the beam counts a graze (graze=' + e.graze + ')');
  // The beam is a one-way ray from its pivot (field center, y=320): a
  // player ABOVE the pivot (behind the ray) takes nothing even while the
  // beam is solid.
  e.player.x = 240; e.player.y = 200; e.player.invuln = 0;
  e.phaseTime = 3;
  e._updateBeams();
  assert(e.player.lives === 98, 'nothing behind the ray (beam is a ray, not a line)');
  // Timed beam with an opt-in telegraph: inactive before t=2, then a thin
  // harmless ray for 0.5s, then solid — player BELOW the pivot (in front).
  e.player.x = 100; e.player.y = 400; e.player.invuln = 0;
  e.phaseTime = 1.5;
  e._updateBeams();
  assert(e.player.lives === 98, 'timed beam inactive before its window');
  e.phaseTime = 2.2; // inside the window, still in the 0.5s telegraph
  e._updateBeams();
  assert(e.player.lives === 98, 'beam telegraph ray does no damage');
  e.phaseTime = 3; // past the telegraph
  e._updateBeams();
  assert(e.player.lives === 97, 'beam hits after its telegraph');
  // Bomb clears the bombable beam but not the unclearable one.
  e.player.bombs = 1;
  e.bomb();
  assert(e._activeBeams().length === 1 && e._activeBeams()[0].unclearable, 'bomb clears bombable beam only');
}

// ────────────────────────────────────────────────────────────────────────────
section('Laser emitter (telegraph + screen-edge length)');
{
  // mkEngine: boss at (240, 90), player at (240, 560) -> the laser aims
  // straight down at the player.
  const e = mkEngine();
  // bombs: 0 — collision assertions below; a stocked bomb would hold the
  // first hit in the deathbomb window (see the "Deathbomb window" section).
  e.player.bombs = 0;
  e._fireEmitter({ type: 'laser', spacing: 14, speed: 0.4, life: 40, r: 8, color: '#9966ff' });
  // No laserLen -> the beam stretches to the screen edge (and just past it).
  const far = Math.max(...e.bullets.map(b => b.y));
  assert(far > e.H, 'laser without laserLen reaches the screen edge (far y=' + far.toFixed(0) + ')');
  // Telegraph: standing on the beam takes nothing while it is a thin line.
  e.player.invuln = 0;
  e._checkCollisions();
  assert(e.player.lives === 99, 'thin warning laser does no damage');
  assert(e.graze === 0, 'thin warning laser grants no graze');
  // After the default 1.5s telegraph the same beam hits.
  e.time += 1.6;
  e._checkCollisions();
  assert(e.player.lives === 98, 'laser hits once it grows to full width');
  // warn: 0 opts out of the telegraph entirely.
  const e2 = mkEngine();
  e2.player.bombs = 0; // same reason as above
  e2._fireEmitter({ type: 'laser', spacing: 14, speed: 0.4, life: 40, r: 8, warn: 0 });
  e2.player.invuln = 0;
  e2._checkCollisions();
  assert(e2.player.lives === 98, 'warn: 0 laser is solid immediately');
  // Per-firing telegraph: each firing gets its own countdown — a segment
  // fired later must telegraph for a full `warn` from ITS spawn, not share
  // the first firing's clock.
  const e3 = mkEngine();
  e3._fireEmitter({ type: 'laser', spacing: 14, speed: 0.4, life: 40, r: 8 });
  e3.time = 0.5;
  e3._fireEmitter({ type: 'laser', spacing: 14, speed: 0.4, life: 40, r: 8 });
  const g1 = e3.bullets[0].laserGroup.solidAt;
  const g2 = e3.bullets[e3.bullets.length / 2].laserGroup.solidAt;
  assert(Math.abs(g1 - 1.5) < 1e-9, 'first firing solid 1.5s after its spawn');
  assert(Math.abs(g2 - 2.0) < 1e-9, 'later firing solid 1.5s after ITS spawn (got ' + g2.toFixed(2) + ')');
  // At t=1.6 the first group is solid while the second is still warning.
  e3.time = 1.6;
  const stillWarn = e3.bullets.filter(b => b.laserGroup && e3.time < b.laserGroup.solidAt);
  assert(stillWarn.length > 0 && stillWarn.every(b => b.laserGroup.solidAt === g2),
    'later segment keeps its own telegraph while the first is already solid');
}

// ────────────────────────────────────────────────────────────────────────────
section('Deathbomb window (hit-grace + noBombs)');
{
  // A helper engine standing in a solid beam, so a single _updateBeams() is a
  // guaranteed hit.
  function mkBeamHit() {
    const e = mkEngine();
    e.player.x = 240; e.player.y = 400;
    e.phases[0].beams = [{ xn: 0.5, width: 56 }];
    return e;
  }
  // With bombs in stock, a hit is HELD for DEATHBOMB_FRAMES: no life is lost
  // yet, and bombing inside the window cancels it.
  const e = mkBeamHit();
  e._updateBeams();
  assert(e.player.lives === 99, 'hit is held while the deathbomb window is open');
  assert(e.deathbombTimer === CONFIG.DEATHBOMB_FRAMES, 'window opens for DEATHBOMB_FRAMES');
  e.bomb();
  assert(e.player.lives === 99, 'deathbomb cancels the held hit');
  assert(e.deathbombTimer === 0, 'deathbomb closes the window');
  // Window expired without a bomb: the held hit lands.
  const e2 = mkBeamHit();
  e2._updateBeams();
  for (let i = 0; i < CONFIG.DEATHBOMB_FRAMES; i++) e2._updateDeathbomb();
  assert(e2.player.lives === 98, 'held hit lands when the window expires');
  // noBombs phases (Kaguya's End of Imperishable Night): the bomb can't be
  // used there, so no window opens — the hit lands immediately.
  const e3 = mkBeamHit();
  e3.phases[0].noBombs = true;
  e3._updateBeams();
  assert(e3.player.lives === 98, 'noBombs phase: hit lands immediately (no unusable window)');
  assert(e3.deathbombTimer === 0, 'noBombs phase: no deathbomb window opens');
}

// ────────────────────────────────────────────────────────────────────────────
section('Seeded jitter');
{
  // Local re-export of the PRNG for the determinism sub-check (the engine
  // keeps its own copy; we just need identical streams).
  function mulberryReexport(seedStr) {
    let h = 0x811C9DC5;
    for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    let a = h >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const e = mkEngine();
  e._fireEmitter({ type: 'ring', count: 24, speed: 2, speedJitter: 0.5, angleJitter: 0.1, colorJitter: 40, color: '#ff0000' });
  const spds = e.bullets.map(b => Math.hypot(b.vx, b.vy));
  assert(new Set(spds.map(s => s.toFixed(2))).size > 1, 'speedJitter varies bullet speeds');
  assert(spds.every(s => s > 1 && s < 3), 'speedJitter stays within ±50%');
  assert(new Set(e.bullets.map(b => b.color)).size > 1, 'colorJitter varies bullet colors');
  // Same seed -> identical jittered field.
  const e2 = mkEngine();
  e._rng = mulberryReexport('same-fight');
  e2._rng = mulberryReexport('same-fight');
  e.bullets = []; e2.bullets = [];
  const em = { type: 'ring', count: 24, speed: 2, speedJitter: 0.5, colorJitter: 40, color: '#ff0000' };
  e._fireEmitter(em);
  e2._fireEmitter(em);
  assert(JSON.stringify(e.bullets.map(b => [b.vx, b.vy, b.color])) === JSON.stringify(e2.bullets.map(b => [b.vx, b.vy, b.color])),
    'same seed -> identical jittered field');
}

// ────────────────────────────────────────────────────────────────────────────
// (Rumia rewrite and Full-fight smoke sections removed — spell-card-specific
// tests do not belong here; generic beam/phase coverage lives in the
// "Phase beams" section above and "Regression: all 9 bosses" below.)

// ────────────────────────────────────────────────────────────────────────────
section('Regression: all 9 bosses x 2 difficulties (12s per phase)');
{
  const ids = Object.keys(BOSSES);
  assert(ids.length === 9, '9 bosses defined (got ' + ids.length + ')');
  let bad = 0;
  for (const id of ids) {
    for (const diff of ['normal', 'lunatic']) {
      try {
        const e = freshFight(id, diff);
        // No auto-fire (phases would otherwise be broken by shot damage and
        // end early, desyncing the per-phase loop) and unkillable player.
        e.shotPattern = { type: 'normal', count: 0, spread: 0, speed: 6, r: 3, color: '#fff', damage: 1, interval: 999999 };
        e.player.lives = 999; e.player.bombs = 99;
        for (const ph of e.phases) {
          const limit = Math.min(ph.duration, 12) * 60;
          let frames = 0, sawBullet = false;
          while (frames < limit && !e.result) {
            e.update(); frames++;
            if (e.bullets.length) sawBullet = true;
          }
          if (!sawBullet) throw new Error('no bullets in "' + ph.name + '"');
        }
      } catch (err) {
        bad++;
        console.log('  FAIL ' + id + '/' + diff + ': ' + err.message);
      }
    }
  }
  assert(bad === 0, 'all boss/difficulty combos run 12s per phase without crashing or empty fields');
}

// ────────────────────────────────────────────────────────────────────────────
section('Practice mode per-card stats (moved + closest bullet)');
{
  const e = freshFight('rumia', 'normal');
  e.player.lives = 999; e.player.bombs = 99;
  e.shotPattern = { type: 'normal', count: 0, spread: 0, speed: 6, r: 3, color: '#fff', damage: 1, interval: 999999 };
  assert(e.phaseStats.length === e.phases.length, 'one stats entry per spell card');
  assert(e.phaseStats[0].name === e.phases[0].name, 'stats entries carry the card name');

  // 120 frames of holding right: the ship starts at x=240 and clamps at
  // x=470, so exactly 230px of real displacement must be recorded (pressing
  // into the wall afterwards counts as zero motion).
  e.keys['arrowright'] = true;
  for (let i = 0; i < 120; i++) e.update();
  e.keys['arrowright'] = false;
  const st0 = e.phaseStats[0];
  assert(Math.abs(st0.moved - 230) < 1, 'moved = actual displacement, edge clamp excluded (got ' + st0.moved.toFixed(1) + ')');

  // Night Bird fires its first flock at t=1.5s, so by frame 120 bullets are
  // on screen and proximity is being sampled.
  assert(st0.distSamples > 0, 'closest-bullet distance sampled while bullets are on screen');
  const live = e._hud();
  assert(live.phaseAvgDist !== null && live.phaseAvgDist > 0, 'live HUD exposes the running average (' + live.phaseAvgDist + ')');
  assert(live.phaseMoved === st0.moved, 'live HUD moved matches the accumulator');

  // No bullets on screen -> no sample (the average stays over frames where
  // a bullet existed).
  const nBefore = st0.distSamples;
  e.bullets = [];
  e._sampleProximity();
  assert(st0.distSamples === nBefore, 'frames without bullets are not sampled');

  // Breaking the HP gauge ends the card and finalizes its average.
  e.phaseHp = 0;
  e.update();
  assert(e.phaseIndex === 1, 'card advanced after HP break');
  assert(typeof st0.avgDist === 'number' && st0.avgDist > 0, 'finalized avgDist is a positive number (' + st0.avgDist.toFixed(1) + ')');
  assert(st0.avgDist === st0.distSum / st0.distSamples, 'avgDist = distSum / distSamples');

  // Ending the fight finalizes the active card too.
  const f = freshFight('rumia', 'normal');
  f._end('lose');
  assert(typeof f.phaseStats[f.phaseIndex].avgDist === 'number', '_end finalizes the active card');
}

// ────────────────────────────────────────────────────────────────────────────
section('Rice orientation (grains point along direction of travel)');
{
  // Canvas whose ctx records every method call, so we can inspect the
  // rotation _drawBullet applied to a bullet.
  function recordingCtx() {
    const calls = [];
    const grad = { addColorStop() {} };
    const target = {};
    const ctx = new Proxy(target, {
      get(t, p) {
        if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createPattern') return () => grad;
        if (p in t) return t[p];
        if (typeof p === 'string') {
          t[p] = (...args) => { calls.push([p, ...args]); return undefined; };
          return t[p];
        }
        return undefined;
      },
      set(t, p, v) { t[p] = v; return true; },
    });
    return { ctx, calls };
  }
  const lastRotate = calls => {
    for (let i = calls.length - 1; i >= 0; i--) if (calls[i][0] === 'rotate') return calls[i][1];
    return null;
  };
  const e = mkEngine();

  // Rice grain flying along +x: ellipse is elongated along local +Y, so the
  // draw rotation must be atan2(0, 5) - PI/2 = -PI/2.
  {
    const b = makeBullet(100, 100, 5, 0, { r: 6, shape: 'rice', color: '#fff' });
    const { ctx, calls } = recordingCtx();
    e._drawBullet(ctx, b);
    assert(Math.abs(lastRotate(calls) - (-Math.PI / 2)) < 1e-9, 'rice facing +x rotates by -PI/2 (got ' + lastRotate(calls) + ')');
  }
  // Arbitrary direction (4,3).
  {
    const b = makeBullet(100, 100, 4, 3, { r: 6, shape: 'rice', color: '#fff' });
    const { ctx, calls } = recordingCtx();
    e._drawBullet(ctx, b);
    const want = Math.atan2(3, 4) - Math.PI / 2;
    assert(Math.abs(lastRotate(calls) - want) < 1e-9, 'rice facing (4,3) rotates by atan2(3,4)-PI/2 (got ' + lastRotate(calls) + ', want ' + want + ')');
  }
  // Stationary rice falls back to b.rot.
  {
    const b = makeBullet(100, 100, 0, 0, { r: 6, shape: 'rice', color: '#fff', rot: 0.7 });
    const { ctx, calls } = recordingCtx();
    e._drawBullet(ctx, b);
    assert(Math.abs(lastRotate(calls) - 0.7) < 1e-9, 'stationary rice uses b.rot');
  }
  // Regression: non-rice shapes keep their in-place spin untouched.
  {
    const b = makeBullet(100, 100, 4, 3, { r: 6, shape: 'diamond', color: '#fff', rot: 0.5 });
    const { ctx, calls } = recordingCtx();
    e._drawBullet(ctx, b);
    assert(Math.abs(lastRotate(calls) - 0.5) < 1e-9, 'non-rice bullets still rotate by b.rot');
  }
  // Regression: plain unrotated circles take the fast path (no rotate call).
  {
    const b = makeBullet(100, 100, 4, 3, { r: 6, shape: 'circle', color: '#fff' });
    const { ctx, calls } = recordingCtx();
    e._drawBullet(ctx, b);
    assert(lastRotate(calls) === null, 'plain circle fast path issues no rotate');
  }
}

section('Curve movers track their orbit (velocity follows the turn)');
{
  // Direct curve bullet: each frame vx/vy must equal the actual displacement,
  // and the heading must stop pointing radially outward (pre-fix it was the
  // frozen spawn direction, i.e. 100% radial).
  {
    const e = mkEngine();
    const b = makeBullet(240, 320, 0, 0, { type: 'curve', cx: 240, cy: 320, sa: 0, sr: 0, cspeed: 2, curve: 0.05, r: 6, shape: 'rice' });
    e.bullets = [b];
    let dispBad = 0, radialBad = 0;
    for (let i = 0; i < 60; i++) {
      const px = b.x, py = b.y;
      e._updateBullets();
      if (!b.active) break;
      if (Math.abs(b.vx - (b.x - px)) > 1e-9 || Math.abs(b.vy - (b.y - py)) > 1e-9) dispBad++;
      if (b.sr > 30) {
        const rx = b.x - b.cx, ry = b.y - b.cy;
        const d = Math.hypot(rx, ry), sp = Math.hypot(b.vx, b.vy);
        const radialFrac = (b.vx * rx + b.vy * ry) / (d * sp);
        if (radialFrac > 0.99) radialBad++;
      }
    }
    assert(dispBad === 0, 'curve bullet vx/vy equals its per-frame displacement every frame');
    assert(radialBad === 0, 'curve bullet heading is not radially outward once the orbit has room');
  }
  // End-to-end: a spinning ring (the Cowrie-shell mechanic, synthetic params).
  // Each bullet's HEADING must rotate with its orbit — before the fix vx/vy
  // was the frozen spawn direction, so the heading never changed at all.
  {
    const e = mkEngine();
    e.phases[0].emits = [{ t: 0, type: 'ring', count: 8, speed: 2, spin: 0.25, shape: 'rice', interval: 99 }];
    e._emitPattern();
    assert(e.bullets.length === 8, 'spin ring fired 8 bullets');
    for (let i = 0; i < 40 && e.bullets[0] && e.bullets[0].sr <= 20; i++) e._updateBullets();
    const bearings = e.bullets.map(b => Math.atan2(b.vy, b.vx));
    for (let i = 0; i < 60; i++) e._updateBullets(); // 1s of orbiting
    let bad = 0;
    e.bullets.forEach((b, i) => {
      if (!b.active) return;
      const d = Math.abs(Math.atan2(b.vy, b.vx) - bearings[i]);
      if (d < 0.1) bad++; // spin 0.25 rad/s -> ~0.25 rad of heading change in 1s
    });
    assert(bad === 0, 'spin-ring bullet headings rotate with the orbit (not frozen at spawn direction)');
  }
}

section('Spiral arm-sweep rate does not leak onto bullets');
{
  // em.rotSpeed on a spiral is the ARM SWEEP rate; it must not be copied as
  // an in-place visual spin onto the bullets (it used to be, making rice
  // grains spin in place instead of pointing along the spiral).
  {
    const e = mkEngine();
    e.phases[0].emits = [{ t: 0, type: 'spiral', arms: 3, rotSpeed: 0.3, speed: 2, shape: 'rice', interval: 0.5 }];
    e._emitPattern();
    assert(e.bullets.length === 3, 'spiral fired one bullet per arm');
    assert(e.bullets.every(b => !b.rotSpeed), 'no in-place spin leaked onto spiral bullets');
  }
  // Regression: other emitters (rings) DO use em.rotSpeed as genuine spin.
  {
    const e = mkEngine();
    e.phases[0].emits = [{ t: 0, type: 'ring', count: 4, speed: 2, shape: 'diamond', rotSpeed: 0.1, interval: 5 }];
    e._emitPattern();
    assert(e.bullets.every(b => b.rotSpeed === 0.1), 'ring emitters keep genuine in-place spin');
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
