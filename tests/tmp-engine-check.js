// tmp-engine-check.js — sanity-check the curve (expanding spiral) and laser
// (line along the beam) emitter fixes. Run with: node tmp-engine-check.js
global.window = { addEventListener() {}, removeEventListener() {} };
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => 0;

const { DanmakuEngine } = require('../js/danmaku/engine.js');

const W = 2000, H = 2000, BX = 1000, BY = 1000;
const e = new DanmakuEngine({ width: W, height: H, getContext: () => ({}) }, {});

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log('FAIL: ' + msg); }
}
function norm(a) { a %= Math.PI * 2; if (a < 0) a += Math.PI * 2; return a; }

// --- curve: expanding spiral (radius grows, bearing rotates), not an orbit.
e.boss = { x: BX, y: BY, move: 'still' };
e.player = { x: BX, y: BY + 900, alive: true, invuln: 0 };
e.bullets = [];
e.frame = 0; e.time = 0; e.phaseTime = 0;
e._fireEmitter({ type: 'curve', count: 3, speed: 2.4, curve: 0.04, color: '#fff' });
assert(e.bullets.length === 3, 'curve spawned 3 bullets');
let rMid = 0;
for (let f = 0; f < 120; f++) {
  e.frame++; e.time += 1 / 60; e.phaseTime += 1 / 60;
  e._updateBullets();
  if (f === 59) rMid = Math.hypot(e.bullets[0].x - BX, e.bullets[0].y - BY);
}
const b0 = e.bullets[0];
const rEnd = Math.hypot(b0.x - BX, b0.y - BY);
assert(rEnd > 200, 'curve bullet expanded well away from the boss (r=' + rEnd.toFixed(0) + ')');
assert(rEnd > rMid * 1.5, 'curve radius keeps growing (mid=' + rMid.toFixed(0) + ', end=' + rEnd.toFixed(0) + ')');
assert(Math.abs(rEnd - 120 * 2.4) < 2, 'curve radius grows at bullet speed (got ' + rEnd.toFixed(1) + ', want ~288)');
const startAng = norm(Math.PI / 2 - 0.3);
const gotAng = norm(Math.atan2(b0.y - BY, b0.x - BX));
const wantAng = norm(startAng + 120 * 0.04);
assert(Math.min(Math.abs(gotAng - wantAng), Math.PI * 2 - Math.abs(gotAng - wantAng)) < 0.01,
  'curve bearing rotated as expected (got ' + gotAng.toFixed(2) + ', want ' + wantAng.toFixed(2) + ')');

// --- laser: a line of bullets laid out along the beam, not one stacked dot.
e.bullets = [];
e._fireEmitter({ type: 'laser', count: 1, speed: 3, laserLen: 120, spacing: 8, color: '#f00', r: 5, angle: Math.PI / 2 });
assert(e.bullets.length === 15, 'laser made 15 bullets (got ' + e.bullets.length + ')');
assert(new Set(e.bullets.map(b => b.x.toFixed(1))).size === 1, 'laser bullets share one x');
const ys = e.bullets.map(b => b.y).sort((a, b) => a - b);
assert(Math.abs(ys[0] - BY) < 0.01 && Math.abs(ys[14] - (BY + 112)) < 0.01,
  'laser spans from the boss along the beam (y ' + ys[0].toFixed(0) + '..' + ys[14].toFixed(0) + ')');
assert(new Set(ys.map(y => y.toFixed(1))).size === 15, 'laser bullets sit at distinct points');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
