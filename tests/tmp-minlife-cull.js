// tmp-minlife-cull.js — engine-level regression test for the `minLife`
// off-screen culling grace and laser telegraph collision. No boss pattern
// data involved; every case builds its own bullet/emitter directly.
//
// Covers:
//   1. plain off-screen culling still works (no minLife),
//   2. an orbiting bullet that starts off-screen survives past its
//      off-screen stretch (minLife = life) and re-enters the field,
//   3. minLife shorter than life: culling resumes once minLife elapses,
//   4. `life` expiry always wins (minLife never extends a bullet's life),
//   5. the laser emitter stamps minLife = life onto every beam bullet,
//   6. telegraph collision: a laser-group bullet does not hit before
//      solidAt and does hit after.
// Run with: node tests/tmp-minlife-cull.js
'use strict';
global.window = { addEventListener() {}, removeEventListener() {} };
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => 0;

const { DanmakuEngine } = require('../js/danmaku/engine.js');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log('FAIL: ' + msg); }
}

const W = 480, H = 640, BX = 240, BY = 90;
const TAU = Math.PI * 2;

function freshEngine() {
  const e = new DanmakuEngine({ width: W, height: H, getContext: () => ({}) }, {});
  e.boss = { x: BX, y: BY, move: 'still' };
  e.player = { x: 240, y: 550, alive: true, invuln: 1e9, hitbox: 6, focusHitbox: 4,
    focus: false, speed: 4.2, bombs: 0, lives: 3 };
  e.phases = [];
  e.phaseIndex = 0;
  e.bullets = [];
  e.frame = 0; e.time = 0; e.phaseTime = 0;
  return e;
}

const EM = { color: '#ffffff', r: 4 }; // minimal emitter descriptor for _add

function step(e, n = 1) {
  for (let i = 0; i < n; i++) {
    e.frame++; e.time += 1 / 60; e.phaseTime += 1 / 60;
    e._updateBullets();
  }
}

function find(e, pred) {
  return e.bullets.find(b => b.active && pred(b)) || null;
}

// ── 1. Plain off-screen culling is unchanged ───────────────────────────────
{
  const e = freshEngine();
  e._add(240, 320, -Math.PI / 2, 10, EM, { life: 1000 }); // straight up, 10 px/f
  step(e, 20);
  assert(find(e, b => b.age > 0), 'bullet alive while on screen');
  step(e, 25); // ~35 frames total: y = 320 - 350 = -30, past the -20 margin
  assert(!find(e, b => b.age > 0), 'plain bullet culled once off screen (no minLife)');
}

// ── 2. Orbiting bullet that starts off-screen survives (minLife = life) ────
{
  const e = freshEngine();
  // Start pointing up from the boss at radius 150: (240, -60), off screen.
  // One full orbit in 300 frames; life 400 covers it.
  e._add(BX, BY - 150, -Math.PI / 2, 0, EM, {
    type: 'curve', curve: TAU / 300, cx: BX, cy: BY, sa: -Math.PI / 2, sr: 150, cspeed: 0,
    life: 400, minLife: 400,
  });
  step(e, 10); // still off screen (only 12° around)
  const b10 = find(e, b => b.type === 'curve');
  assert(b10 && b10.y < -20, 'orbiting bullet is off screen early on');
  assert(b10, 'NOT culled while off screen (minLife protects it)');
  step(e, 140); // ~150 frames: half orbit, now below the boss on screen
  const b150 = find(e, b => b.type === 'curve');
  assert(b150, 'still alive after orbiting back into view');
  assert(b150 && b150.x >= 0 && b150.x <= W && b150.y >= 0 && b150.y <= H,
    're-entered the field on screen (x=' + (b150 && b150.x | 0) + ', y=' + (b150 && b150.y | 0) + ')');
  step(e, 260); // 410 frames total: life 400 expired
  assert(!find(e, b => b.type === 'curve'), 'bullet still dies when its life expires');
}

// ── 3. minLife shorter than life: culling resumes after minLife ────────────
{
  const e = freshEngine();
  e._add(240, 320, -Math.PI / 2, 10, EM, { life: 1000, minLife: 60 });
  step(e, 50); // off screen since ~frame 35, but age 50 < 60
  assert(find(e, b => b.age > 0), 'protected while age < minLife (off screen at frame 50)');
  step(e, 30); // frame 80: off screen and age 80 >= 60
  assert(!find(e, b => b.age > 0), 'culled once off screen AND age >= minLife');
}

// ── 4. life expiry always wins over minLife ────────────────────────────────
{
  const e = freshEngine();
  e._add(240, 320, 0, 0, EM, { life: 50, minLife: 500 }); // stationary, on screen
  step(e, 49);
  assert(find(e, b => b.age > 0), 'alive at frame 49 (life 50)');
  step(e, 2);
  assert(!find(e, b => b.age > 0), 'dies at life expiry even though minLife is larger');
}

// ── 5. Laser emitter stamps minLife = life on every beam bullet ────────────
{
  const e = freshEngine();
  e.phases = [{
    name: 'laser-check', duration: 5, hp: 10,
    emits: [{
      t: 0, type: 'laser', count: 8, speed: 0, angle: -Math.PI / 2,
      laserLen: 300, spacing: 10, sweep: 0.2, warn: 0.5, life: 30,
      color: '#ffdd88', shape: 'diamond',
    }],
  }];
  e.phaseIndex = 0;
  e._emitPattern();
  const laserBullets = e.bullets.filter(b => b.laserGroup);
  assert(laserBullets.length > 0, 'laser emitter fired (' + laserBullets.length + ' bullets)');
  const expectedLife = Math.max(30, Math.ceil(0.5 * 60) + 30); // warn extension
  assert(laserBullets.every(b => b.life === expectedLife),
    'laser bullets carry the warn-extended life (' + expectedLife + ')');
  assert(laserBullets.every(b => b.minLife === b.life),
    'every laser bullet has minLife === life (never culled while alive)');
}

// ── 6. Telegraph collision: no hit before solidAt, hit after ───────────────
{
  const e = freshEngine();
  e.player.invuln = 0;
  e._add(240, 550, 0, 0, EM, {
    life: 1000, minLife: 1000, laserGroup: { solidAt: e.time + 0.5 },
  });
  for (let f = 0; f < 29; f++) {
    e.frame++; e.time += 1 / 60;
    e._updateBullets();
    e._checkCollisions();
  }
  assert(e.player.lives === 3, 'no hit while the beam is still a thin telegraph line');
  assert(find(e, b => b.laserGroup), 'telegraph bullet not consumed before solidAt');
  step(e, 3); // time crosses 0.5 s
  e._checkCollisions();
  assert(e.player.lives === 2, 'hits the player once the beam is solid');
  assert(!find(e, b => b.laserGroup), 'bullet consumed on hit');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
