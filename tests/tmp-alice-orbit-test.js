// tmp-alice-orbit-test.js — verify the new 'doll' orbit feature: a destructible
// shooter that circles the boss at a fixed radius, tracking the boss's live
// position (trackBoss). Prints a trajectory sample.
global.window = { addEventListener() {}, removeEventListener() {} };
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => 0;

const { DanmakuEngine } = require('../js/danmaku/engine.js');

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

function mkEngine() {
  const e = new DanmakuEngine(fakeCanvas(480, 640), {});
  e.boss = { x: 240, y: 90, move: 'still' };
  e.player = { x: 240, y: 560, speed: 4, lives: 99, bombs: 99, hitbox: 6, focusHitbox: 2, focus: false, invuln: 0, alive: true };
  e.shotPattern = { type: 'normal', count: 1, spread: 0, speed: 6, r: 3, color: '#fff', damage: 1, interval: 999999 };
  e.bullets = []; e.playerShots = [];
  e.frame = 0; e.time = 0; e.phaseTime = 0;
  e.phases = [{ name: 't', duration: 9999, hp: 10000, emits: [] }];
  e.phaseIndex = 0; e.phaseHp = 10000; e.phaseMaxHp = 10000;
  return e;
}
function step(e, n) { for (let i = 0; i < n; i++) { e.frame++; e.time += 1/60; e.phaseTime += 1/60; e._updateBullets(); } }

function probe(label, em, moveBoss) {
  const e = mkEngine();
  e._emitAt(240, 90, Object.assign({ t: 0 }, em));
  const pts = [];
  for (let f = 0; f < 360; f++) {
    if (moveBoss && f % 30 === 0) { e.boss.x = 240 + Math.sin(f / 30) * 60; } // boss drifts horizontally
    step(e, 1);
    if (f % 30 === 0) {
      const d = e.bullets.find(b => b.destructible && b.hp >= 0 && b.r === 12);
      if (d) pts.push(`f${f}(${d.x.toFixed(0)},${d.y.toFixed(0)})`);
      else pts.push(`f${f}(gone)`);
    }
  }
  console.log(label + ':\n  ' + pts.join('  '));
}

// Static boss: doll should circle at radius 120, constant.
probe('static boss, orbitRadius 120, speed 0.02', {
  type: 'doll', count: 1, speed: 0, interval: 999, hp: 99, r: 12,
  orbitRadius: 120, orbitSpeed: 0.02,
  shoot: { type: 'point', count: 1, speed: 1 },
});

// Moving boss: doll should track the boss's live x as it drifts.
probe('moving boss (drifts ±60), orbitRadius 120, speed 0.02', {
  type: 'doll', count: 1, speed: 0, interval: 999, hp: 99, r: 12,
  orbitRadius: 120, orbitSpeed: 0.02,
  shoot: { type: 'point', count: 1, speed: 1 },
}, true);
