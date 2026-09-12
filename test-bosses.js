// test-bosses.js — validate all 9 boss fight scripts.
const CONFIG = require('./js/config.js');
const { BOSSES, getPhases } = require('./js/danmaku/bosses.js');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL: ' + msg); }
}

const EXPECTED = ['rumia','nitori','momiji','patchouli','alice','remilia','yuyuko','yukari','kaguya'];

for (const id of EXPECTED) {
  const boss = BOSSES[id];
  assert(boss, id + ' exists');
  if (!boss) continue;
  assert(boss.name, id + ' has name');
  assert(boss.color, id + ' has color');
  assert(boss.bgTop && boss.bgBottom, id + ' has bg colors');
  assert(boss.move === 'still' || boss.move === 'sine', id + ' has valid move');
  assert(boss.phases && boss.phases.normal && boss.phases.lunatic, id + ' has normal+lunatic phases');

  // Normal: 3+ phases, Lunatic: 4+ phases
  const n = boss.phases.normal.length;
  const l = boss.phases.lunatic.length;
  assert(n >= 3, id + ' normal has 3+ phases (got ' + n + ')');
  assert(l >= 4, id + ' lunatic has 4+ phases (got ' + l + ')');

  // Every phase has name, duration, hp, non-empty emits
  for (const diff of ['normal', 'lunatic']) {
    for (const p of boss.phases[diff]) {
      assert(p.name, id + ' ' + diff + ' phase has name');
      assert(p.duration > 0, id + ' ' + diff + ' phase has duration');
      assert(p.hp > 0, id + ' ' + diff + ' phase has hp');
      assert(Array.isArray(p.emits) && p.emits.length > 0, id + ' ' + diff + ' ' + p.name + ' has emits');
    }
  }

  // getPhases works
  const phases = getPhases(id, 'normal');
  assert(phases.length === n, id + ' getPhases(normal) returns ' + n);
  const lphases = getPhases(id, 'lunatic');
  assert(lphases.length === l, id + ' getPhases(lunatic) returns ' + l);

  // Lunatic scaling applied
  const firstEm = lphases[0].emits[0];
  assert(firstEm.speedMul >= 1, id + ' lunatic speedMul >= 1');
}

// Kaguya Last Spell has noBombs
assert(BOSSES.kaguya.phases.lunatic[5].noBombs === true, 'kaguya Last Spell has noBombs');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
