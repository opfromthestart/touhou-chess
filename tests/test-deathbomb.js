// test-deathbomb.js — verify the deathbomb mechanic (node test-deathbomb.js)
// Mocks the minimal browser APIs needed by the danmaku engine.

// --- Mock browser globals ---
global.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
};
global.document = {
  createElement: () => ({
    getContext: () => ({}),
    style: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    querySelector: () => null,
    appendChild: () => {},
  }),
  getElementById: () => null,
  body: { appendChild: () => {} },
};
global.performance = { now: () => 0 };
global.requestAnimationFrame = (cb) => {};
global.cancelAnimationFrame = () => {};
global.KeyboardEvent = function() {};

// Make CONFIG a global so the engine can see it.
global.CONFIG = require('../js/config.js').CONFIG;

const { DanmakuEngine, makeBullet } = require('../js/danmaku/engine.js');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS:', msg); }
  else { failed++; console.log('  FAIL:', msg); }
}

// Helper: create a minimal engine with a player in a known state.
function makeTestEngine(lives, bombs) {
  const e = new DanmakuEngine({ width: 480, height: 640, getContext: () => ({}) });
  // Manually set up the engine state without calling start() (which needs
  // phases and a boss). We'll simulate the relevant parts directly.
  e.player = {
    x: 240, y: 580,
    speed: 4.2,
    lives,
    bombs,
    hitbox: 6,
    focusHitbox: 1.5,
    focus: false,
    invuln: 0,
    alive: true,
  };
  e.boss = { x: 240, y: 90 };
  e.bullets = [];
  e.playerShots = [];
  e.result = null;
  e.deathbombTimer = 0;
  e.bombGauge = 0;
  e.frame = 0;
  e.time = 0;
  e.phaseTime = 0;
  e.phaseIndex = 0;
  e.phaseHp = 100;
  e.phaseMaxHp = 100;
  e.phases = [{ name: 'Test', hp: 100, duration: 10, emits: [], beams: [] }];
  e.bombSeq = 0;
  e.shake = 0;
  e.score = 0;
  e.graze = 0;
  e.fieldFreeze = null;
  e._rnd = () => 0.5;
  e.shotPattern = CONFIG.SHOT_PATTERNS.k;
  e.phaseStats = [{ name: 'Test', moved: 0, distSum: 0, distSamples: 0, avgDist: 0 }];
  return e;
}

console.log('--- Deathbomb: 8-frame grace window ---');

// Case 1: player has 1 life + 1 bomb, gets hit → deathbomb window opens.
{
  const e = makeTestEngine(1, 1);
  // Place a bullet directly on the player to trigger a hit.
  e.bullets.push(makeBullet(e.player.x, e.player.y, 0, 0, { r: 4 }));
  e._checkCollisions();

  assert(e.deathbombTimer === CONFIG.DEATHBOMB_FRAMES,
    'hit with a bomb opens ' + CONFIG.DEATHBOMB_FRAMES + '-frame window (got ' + e.deathbombTimer + ')');
  assert(e.player.lives === 1,
    'lives NOT decremented during window (got ' + e.player.lives + ')');
  assert(e.player.alive === true,
    'player still alive during window');
  assert(e.result === null,
    'fight continues during window (result=' + e.result + ')');
}

// Case 2: bomb within the window → death cancelled, bomb consumed.
{
  const e = makeTestEngine(1, 1);
  e.bullets.push(makeBullet(e.player.x, e.player.y, 0, 0, { r: 4 }));
  e._checkCollisions();
  assert(e.deathbombTimer > 0, 'precondition: window is open');

  e.bomb();

  assert(e.deathbombTimer === 0,
    'bombing clears the window (got ' + e.deathbombTimer + ')');
  assert(e.player.bombs === 0,
    'bomb was consumed (got ' + e.player.bombs + ')');
  assert(e.player.lives === 1,
    'life preserved after successful deathbomb (got ' + e.player.lives + ')');
  assert(e.player.invuln > 0,
    'invulnerability granted after deathbomb (invuln=' + e.player.invuln + ')');
  assert(e.result === null,
    'fight continues after successful deathbomb (result=' + e.result + ')');
  assert(e.score >= 3000,
    'score bonus for deathbomb (score=' + e.score + ', expected >= 3000)');
}

// Case 3: no bombs → immediate death (no window).
{
  const e = makeTestEngine(1, 0);
  e.bullets.push(makeBullet(e.player.x, e.player.y, 0, 0, { r: 4 }));
  e._checkCollisions();

  assert(e.player.lives === 0,
    'no bombs → lives decremented to 0 (got ' + e.player.lives + ')');
  assert(e.player.alive === false,
    'no bombs → player dies immediately');
  assert(e.result === 'lose',
    'no bombs → fight ends in loss (result=' + e.result + ')');
}

// Case 4: window expires without bomb → death.
{
  const e = makeTestEngine(1, 1);
  e.bullets.push(makeBullet(e.player.x, e.player.y, 0, 0, { r: 4 }));
  e._checkCollisions();
  assert(e.deathbombTimer === CONFIG.DEATHBOMB_FRAMES, 'precondition: window is open');

  // Advance frames without bombing → window expires.
  for (let i = 0; i < CONFIG.DEATHBOMB_FRAMES; i++) {
    e.bullets = []; // clear bullets so no re-hit
    e._updateDeathbomb();
  }

  assert(e.player.lives === 0,
    'expired window → lives decremented to 0 (got ' + e.player.lives + ')');
  assert(e.player.alive === false,
    'expired window → player dies');
  assert(e.result === 'lose',
    'expired window → fight ends in loss (result=' + e.result + ')');
}

// Case 5: 2+ lives + a bomb → the window opens on ANY hit (hit held, no life lost yet).
{
  const e = makeTestEngine(3, 1);
  e.bullets.push(makeBullet(e.player.x, e.player.y, 0, 0, { r: 4 }));
  e._checkCollisions();

  assert(e.deathbombTimer === CONFIG.DEATHBOMB_FRAMES,
    'hit on 2+ lives opens the window (got ' + e.deathbombTimer + ')');
  assert(e.player.lives === 3,
    'hit is held: life NOT decremented yet (got ' + e.player.lives + ')');
  assert(e.player.alive === true,
    'player alive during window');
}

// Case 5b: 2+ lives + no bombs → normal hit (no window).
{
  const e = makeTestEngine(3, 0);
  e.bullets.push(makeBullet(e.player.x, e.player.y, 0, 0, { r: 4 }));
  e._checkCollisions();

  assert(e.player.lives === 2,
    'no bombs → normal hit, lives decremented (got ' + e.player.lives + ')');
  assert(e.deathbombTimer === 0,
    'no bombs → no deathbomb window (got ' + e.deathbombTimer + ')');
  assert(e.player.alive === true,
    'player survives');
}

// Case 5c: window expires with 2+ lives → the held hit lands, player survives
// with normal invulnerability.
{
  const e = makeTestEngine(3, 1);
  e.bullets.push(makeBullet(e.player.x, e.player.y, 0, 0, { r: 4 }));
  e._checkCollisions();
  assert(e.deathbombTimer > 0, 'precondition: window is open');

  for (let i = 0; i < CONFIG.DEATHBOMB_FRAMES; i++) {
    e.bullets = []; // clear bullets so no re-hit
    e._updateDeathbomb();
  }

  assert(e.player.lives === 2,
    'expired window → held hit lands, lives decremented (got ' + e.player.lives + ')');
  assert(e.player.alive === true,
    'expired window → player survives with 2+ lives');
  assert(e.player.invuln > 0,
    'expired window → normal invulnerability granted (invuln=' + e.player.invuln + ')');
  assert(e.result === null,
    'expired window → fight continues (result=' + e.result + ')');
}

// Case 6: bombs are never gated by the gauge — a normal bomb works with an
// empty gauge and multiple bombs in stock.
{
  const e = makeTestEngine(3, 2); // 3 lives, 2 bombs, gauge not full
  e.bombGauge = 0; // gauge empty

  e.bomb();

  assert(e.player.bombs === 1,
    'normal bomb works with empty gauge (got ' + e.player.bombs + ')');
  assert(e.player.lives === 3,
    'normal bomb does not cost a life (got ' + e.player.lives + ')');
}

// Case 6b: a full gauge earns an extra bomb and resets.
{
  const e = makeTestEngine(3, 2);
  e.bombGauge = 1; // gauge full
  e._updateBombGauge();

  assert(e.player.bombs === 3,
    'full gauge grants an extra bomb (got ' + e.player.bombs + ')');
  assert(e.bombGauge === 0,
    'gauge resets after granting (got ' + e.bombGauge + ')');
}

// Case 7: deathbomb respects noBombs phase.
{
  const e = makeTestEngine(1, 1);
  e.phases[0].noBombs = true; // bombs disabled this phase
  e.bullets.push(makeBullet(e.player.x, e.player.y, 0, 0, { r: 4 }));
  e._checkCollisions();
  assert(e.deathbombTimer > 0, 'precondition: window is open');

  e.bomb(); // should be rejected (noBombs phase)

  assert(e.player.bombs === 1,
    'noBombs phase: bomb not consumed (got ' + e.player.bombs + ')');
  assert(e.deathbombTimer > 0,
    'noBombs phase: window still open (got ' + e.deathbombTimer + ')');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
