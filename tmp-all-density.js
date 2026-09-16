// tmp-all-density.js — full-duration fights for ALL bosses; per-phase bullet peaks.
// Usage: node tmp-all-density.js [bossId]   (defaults to every boss)
global.window = { addEventListener() {}, removeEventListener() {} };
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => 0;
const { BOSSES, getPhases } = require('./js/danmaku/bosses.js'); // sets global.CONFIG
const { DanmakuEngine } = require('./js/danmaku/engine.js');

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

const only = process.argv[2] ? [process.argv[2]] : Object.keys(BOSSES);
for (const id of only) {
  for (const diff of ['normal', 'lunatic']) {
    const e = new DanmakuEngine(fakeCanvas(480, 640), {});
    const phases = getPhases(id, diff);
    const boss = { ...BOSSES[id], charId: id };
    e.start(phases, boss, CONFIG.DANMAKU_STATS['n'], 'n', id);
    e.player.lives = 999; e.player.bombs = 99;
    e.shotPattern = { type: 'normal', count: 0, spread: 0, speed: 6, r: 3, color: '#fff', damage: 1, interval: 999999 };
    let frames = 0, maxBullets = 0;
    const perPhase = [];
    while (!e.result && frames < 60 * 180) {
      e.update(); frames++;
      maxBullets = Math.max(maxBullets, e.bullets.length);
      const pi = e.phaseIndex;
      if (!e.phases[pi]) break; // fight ended
      if (!perPhase[pi]) perPhase[pi] = { name: e.phases[pi].name, max: 0 };
      perPhase[pi].max = Math.max(perPhase[pi].max, e.bullets.length);
    }
    console.log('\n=== ' + id + ' ' + diff + ': total ' + frames + ' frames (' + (frames / 60).toFixed(1) + 's), overall max ' + maxBullets + ' bullets, result=' + e.result + ' ===');
    for (const p of perPhase) console.log('  ' + p.name.padEnd(28) + ' max ' + String(p.max).padStart(4) + ' bullets');
  }
}
