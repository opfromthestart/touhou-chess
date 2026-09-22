/* Scratch (tmp-*): simulate a single Hina card headlessly and dump the
 * bullet field (positions + radii + colors) to JSON for visual inspection.
 * Usage: node tmp-hina-bullets.js <normal|lunatic> <phaseName> <seconds> <outJson>
 */
'use strict';
global.window = { addEventListener() {}, removeEventListener() {} };
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => 0;
const fs = require('fs');
const { BOSSES, getPhases } = require('./js/danmaku/bosses.js');
const { DanmakuEngine } = require('./js/danmaku/engine.js');

function fakeCanvas(W, H) {
  const g = { addColorStop() {} };
  const c = new Proxy({}, {
    get(t, p) {
      if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createPattern') return () => g;
      if (p === 'measureText') return () => ({ width: 0 });
      return () => undefined;
    },
    set(t, p, v) { t[p] = v; return true; },
  });
  return { width: W, height: H, getContext: () => c };
}

const [diff, phaseName, secs, outJson] = process.argv.slice(2);
if (!diff || !phaseName || !secs || !outJson) {
  console.error('usage: node tmp-hina-bullets.js <diff> <phaseName> <seconds> <outJson>');
  process.exit(2);
}
const phases = getPhases('hina', diff);
const ph = phases.find((p) => p.name === phaseName);
if (!ph) { console.error('no phase named: ' + phaseName + ' (have: ' + phases.map((p) => p.name).join(', ') + ')'); process.exit(2); }

const W = 480, H = 640;
const e = new DanmakuEngine(fakeCanvas(W, H), {});
e.start([ph], { ...BOSSES.hina, charId: 'hina' }, CONFIG.DANMAKU_STATS['n'], 'n', 'hina');
e.shotPattern = { type: 'normal', count: 0, spread: 0, speed: 6, r: 3, color: '#fff', damage: 1, interval: 999999 };
e.player.lives = 999; e.player.bombs = 99;

const frames = Math.round(secs * 60);
for (let i = 0; i < frames && !e.result; i++) e.update();

const out = {
  W, H,
  phase: ph.name, diff,
  player: [e.player.x, e.player.y],
  bullets: e.bullets.map((b) => [Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10, b.r, b.color]),
};
fs.writeFileSync(outJson, JSON.stringify(out));
console.log('wrote ' + outJson + ' (' + out.bullets.length + ' bullets at t=' + secs + 's)');
