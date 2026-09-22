// tmp-bunraku-cap-test.js — verify the Bunraku dolls' shoot-budget cap.
// Each doll should fire its 3-way fan exactly 3 times (spawnCount: 3), then
// stop shooting and drift off — instead of firing for the whole card.
global.window = { addEventListener() {}, removeEventListener() {} };
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => 0;

const { BOSSES, getPhases } = require('../js/danmaku/bosses.js');
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

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log('FAIL: ' + msg); }
}

function bunrakuFight(diff) {
  const e = new DanmakuEngine(fakeCanvas(480, 640), {});
  const phases = getPhases('alice', diff);
  // Isolate the Bunraku card: drop the other phases so it runs from t=0.
  const bunraku = phases.filter(p => p.name.includes('Bunraku'));
  const boss = { ...BOSSES.alice, charId: 'alice' };
  e.start(bunraku, boss, CONFIG.DANMAKU_STATS['p'], 'p', 'alice');
  e.shotPattern = { type: 'normal', count: 0, spread: 0, speed: 6, r: 3, color: '#fff', damage: 1, interval: 999999 };
  e.player.lives = 999; e.player.bombs = 99;
  return e;
}

// The dolls are bullets with spawnCount === 3 (the cap) and a shoot pattern.
function dolls(e) {
  return e.bullets.filter(b => b.active && b.spawnCount === 3 && b.spawnEmits);
}

for (const diff of ['normal', 'lunatic']) {
  const e = bunrakuFight(diff);
  let maxSpawnN = 0, sawDolls = false;
  // Run the full 20s card (1200 frames).
  for (let i = 0; i < 1200 && !e.result; i++) {
    e.update();
    for (const d of dolls(e)) {
      sawDolls = true;
      if (d.spawnN > maxSpawnN) maxSpawnN = d.spawnN;
    }
  }
  console.log(`\n== Bunraku (${diff}) ==`);
  console.log(`  sawDolls=${sawDolls}  maxSpawnN=${maxSpawnN} (cap is 3)`);
  assert(sawDolls, `${diff}: dolls were created`);
  assert(maxSpawnN === 3, `${diff}: every doll fired exactly 3 fans (maxSpawnN=${maxSpawnN})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
