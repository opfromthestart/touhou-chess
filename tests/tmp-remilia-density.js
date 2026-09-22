// Density probe for the ported Remilia phases: peak concurrent bullets per
// card, full-duration sim (no auto-fire, unkillable player).
global.window = { addEventListener() {}, removeEventListener() {} };
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => 0;
const { BOSSES, getPhases } = require('./js/danmaku/bosses.js'); // sets global.CONFIG
const { DanmakuEngine } = require('./js/danmaku/engine.js');

function fakeCanvas(W, H) {
  const grad = { addColorStop() {} };
  const ctx = new Proxy({}, {
    get(t, p) {
      if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createPattern') return () => grad;
      if (p === 'canvas') return { width: W, height: H };
      return () => {};
    },
    set() { return true; },
  });
  return { width: W, height: H, getContext: () => ctx };
}

function mkEngine(W = 480, H = 640) {
  const e = new DanmakuEngine(fakeCanvas(W, H), {});
  e.frame = 0; e.time = 0; e.phaseTime = 0;
  e.phases = [{ name: 'test', duration: 9999, hp: 10000, emits: [] }];
  e.phaseIndex = 0; e.phaseHp = 10000; e.phaseMaxHp = 10000;
  return e;
}

function freshFight(id, diff) {
  const boss = BOSSES[id];
  const phases = getPhases(id, diff);
  const e = mkEngine();
  e.start(phases, boss, CONFIG.DANMAKU_STATS['p'], 'p', id);
  e.shotPattern = { type: 'normal', count: 0, spread: 0, speed: 6, r: 3, color: '#fff', damage: 1, interval: 999999 };
  e.player.lives = 999; e.player.bombs = 99;
  return e;
}

const ONLY = process.argv[2] ? [process.argv[2]] : Object.keys(BOSSES);
for (const id of ONLY) {
  for (const diff of ['normal', 'lunatic']) {
    const e = freshFight(id, diff);
    console.log('\n=== ' + BOSSES[id].name + ' ' + diff + ' (' + e.phases.length + ' cards) ===');
    for (const ph of e.phases) {
      const limit = ph.duration * 60;
      let frames = 0, peak = 0, total = 0, samples = 0;
      while (frames < limit && !e.result) {
        e.update(); frames++;
        peak = Math.max(peak, e.bullets.length);
        total += e.bullets.length; samples++;
      }
      const avg = (total / Math.max(1, samples)).toFixed(1);
      console.log('  ' + ph.name.padEnd(34) + ' dur=' + ph.duration + 's  peak=' + peak + '  avg=' + avg);
    }
  }
}
