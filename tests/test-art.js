// test-art.js — validates the character sprite registry (Node, no canvas).
// Checks: all 18 characters exist as draw functions, ids match CONFIG,
// roster coverage, and drawCharacter degrades gracefully for unknown ids.

const assert = require('assert');
const { CHAR_SPRITES } = require('../js/art/characters.js');
const { CONFIG } = require('../js/config.js');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error('FAIL:', name, '\n   ', e.message); }
}

const EXPECTED = [
  'reimu', 'marisa', 'sakuya', 'youmu', 'sanae', 'reisen', 'aya', 'hatate', 'cirno',
  'kaguya', 'yukari', 'remilia', 'yuyuko', 'patchouli', 'alice', 'nitori', 'momiji', 'rumia',
];

check('all 18 characters have a sprite entry', () => {
  for (const id of EXPECTED) {
    assert.ok(CHAR_SPRITES[id], 'missing sprite for ' + id);
    assert.strictEqual(typeof CHAR_SPRITES[id].draw, 'function', id + '.draw is not a function');
  }
});

check('no unexpected sprite ids', () => {
  const extra = Object.keys(CHAR_SPRITES).filter((id) => !EXPECTED.includes(id));
  assert.deepStrictEqual(extra, [], 'unexpected ids: ' + extra.join(','));
});

check('sprite ids match CONFIG.CHARACTERS', () => {
  for (const id of Object.keys(CHAR_SPRITES)) {
    assert.ok(CONFIG.CHARACTERS[id], id + ' not in CONFIG.CHARACTERS');
  }
  for (const id of Object.keys(CONFIG.CHARACTERS)) {
    assert.ok(CHAR_SPRITES[id], id + ' in CONFIG but has no sprite');
  }
});

check('roster fully covered by sprites', () => {
  for (const type of Object.keys(CONFIG.ROSTER)) {
    for (const id of CONFIG.ROSTER[type].you) {
      assert.ok(CHAR_SPRITES[id], 'player char missing: ' + id);
    }
    for (const id of CONFIG.ROSTER[type].ai) {
      assert.ok(CHAR_SPRITES[id], 'boss char missing: ' + id);
    }
  }
});

// drawCharacter must not throw for unknown ids (it returns false). We can't
// run a real canvas in Node, but the registry lookup happens before any
// canvas work, so a fake ctx proves the guard works.
check('drawCharacter guards unknown ids', () => {
  const fakeCtx = {};
  const fn = require('../js/art/characters.js').drawCharacter;
  assert.strictEqual(fn(fakeCtx, 'not-a-char', 0, 0, 1), false);
  // A known id should call draw on the ctx without throwing.
  let drew = false;
  const spy = {
    save() {}, restore() {}, translate() {}, scale() {},
    fillRect() { drew = true; }, beginPath() {}, arc() {}, fill() {},
    ellipse() {}, closePath() {}, moveTo() {}, lineTo() {}, stroke() {},
    set fillStyle(v) { this._f = v; }, get fillStyle() { return this._f; },
    set strokeStyle(v) { this._s = v; }, get strokeStyle() { return this._s; },
    set lineWidth(v) {}, get lineWidth() { return 1; },
    set lineCap(v) {}, get lineCap() { return 'round'; },
  };
  assert.strictEqual(fn(spy, 'reimu', 0, 0, 1), true);
  assert.ok(drew, 'reimu did not draw anything');
});

console.log(`test-art: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
