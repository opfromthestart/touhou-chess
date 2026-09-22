// tmp-alice-cards-test.js — headless tests for the ported Alice (PCCB/TH07)
// spell cards in js/danmaku/bosses.js:
//   - Non-spell (Sub3)
//   - Puppeteer Sign "Maiden's Bunraku" (Sub27, simplified)
//   - Soufu "French Dolls" (Sub42)
//   - Soufu "Dutch Dolls" (Sub46)
//
// Checks:
//   1. Every Alice phase runs its FULL duration without crashing and produces
//      bullets (no empty fields).
//   2. Determinism: two identical Alice fights produce identical bullet fields.
//   3. Density: peak concurrent bullets per card (sanity: under the 2000 cap,
//      and not trivially low).
//   4. Orbit verification: the French/Dutch dolls are 'curve' movers that
//      circle the boss at a ~constant radius and actually rotate around it
//      (CopyMainBossMovement orbit), re-centering on the boss's live position.
//   5. Shed verification: the Bunraku bubbles shed dolls; the French dolls'
//      outward arrowheads shed the inward white split.
//
// Run with: node tests/tmp-alice-cards-test.js
global.window = { addEventListener() {}, removeEventListener() {} };
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => 0;

const { BOSSES, getPhases } = require('../js/danmaku/bosses.js'); // sets global.CONFIG
const { DanmakuEngine } = require('../js/danmaku/engine.js');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log('FAIL: ' + msg); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

// Fake canvas: a Proxy ctx where every method is a no-op and every property
// set/get works, so start() -> _loop() -> render() runs harmlessly in Node.
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

// A full Alice fight (driven manually via update(), like the regression test).
function aliceFight(diff, pieceType = 'p') {
  const e = new DanmakuEngine(fakeCanvas(480, 640), {});
  const phases = getPhases('alice', diff);
  const boss = { ...BOSSES.alice, charId: 'alice' };
  e.start(phases, boss, CONFIG.DANMAKU_STATS[pieceType], pieceType, 'alice');
  // No auto-fire (phases would otherwise be broken by shot damage) and an
  // unkillable player, so we can run each card for its full duration.
  e.shotPattern = { type: 'normal', count: 0, spread: 0, speed: 6, r: 3, color: '#fff', damage: 1, interval: 999999 };
  e.player.lives = 999; e.player.bombs = 99;
  return e;
}

// Run the engine for `frames` frames from the current state, returning a list
// of per-frame bullet-field snapshots (positions rounded to 1e-3).
function runFrames(e, frames) {
  const snaps = [];
  for (let i = 0; i < frames && !e.result; i++) {
    e.update();
    snaps.push(e.bullets.map(b => [b.x.toFixed(3), b.y.toFixed(3), b.vx.toFixed(3), b.vy.toFixed(3), b.color].join('|')).join(';'));
  }
  return snaps;
}

// ────────────────────────────────────────────────────────────────────────────
section('1. Every Alice phase runs full duration, no crash, produces bullets');
{
  for (const diff of ['normal', 'lunatic']) {
    const e = aliceFight(diff);
    let bad = 0;
    for (const ph of e.phases) {
      try {
        const limit = ph.duration * 60; // full duration
        let frames = 0, sawBullet = false, peak = 0;
        while (frames < limit && !e.result) {
          e.update(); frames++;
          if (e.bullets.length) sawBullet = true;
          if (e.bullets.length > peak) peak = e.bullets.length;
        }
        if (!sawBullet) throw new Error('no bullets in "' + ph.name + '"');
        if (peak === 0) throw new Error('no peak in "' + ph.name + '"');
        console.log('  ' + diff + '  ' + ph.name.padEnd(34) + ' peak=' + peak);
      } catch (err) {
        bad++;
        console.log('  FAIL ' + diff + ' ' + ph.name + ': ' + err.message);
      }
    }
    assert(bad === 0, diff + ': all Alice phases run full duration without crashing or empty fields');
  }
}

// ────────────────────────────────────────────────────────────────────────────
section('2. Determinism (two identical Alice fights -> identical fields)');
{
  for (const diff of ['normal', 'lunatic']) {
    const a = aliceFight(diff);
    const b = aliceFight(diff);
    const sa = runFrames(a, 480); // 8s
    const sb = runFrames(b, 480);
    assert(sa.length === sb.length && sa.join('\n') === sb.join('\n'),
      diff + ': identical Alice fights produce identical bullet fields over 8s');
  }
  // A different difficulty is a different fight identity -> different field.
  const n = aliceFight('normal');
  const l = aliceFight('lunatic');
  const sn = runFrames(n, 240);
  const sl = runFrames(l, 240);
  assert(sn.join('\n') !== sl.join('\n'), 'normal vs lunatic Alice fights differ');
}

// ────────────────────────────────────────────────────────────────────────────
section('3. Density (peak concurrent bullets per card, under the 2000 cap)');
{
  const expected = {
    normal: ['Non-spell', 'Puppeteer Sign "Maiden\'s Bunraku"', 'Soufu "French Dolls"'],
    lunatic: ['Non-spell', 'Puppeteer Sign "Maiden\'s Bunraku"', 'Soufu "French Dolls"', 'Soufu "Dutch Dolls"'],
  };
  for (const diff of ['normal', 'lunatic']) {
    const e = aliceFight(diff);
    for (const ph of e.phases) {
      const limit = ph.duration * 60;
      let frames = 0, peak = 0;
      while (frames < limit && !e.result) {
        e.update(); frames++;
        if (e.bullets.length > peak) peak = e.bullets.length;
      }
      assert(peak > 0 && peak < 2000,
        diff + ' ' + ph.name + ': peak ' + peak + ' is in (0, 2000)');
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
section('4. Orbit verification (French/Dutch dolls circle the boss)');
{
  // Hold a reference to one orbiting doll (curve + trackBoss) and verify that,
  // over a 1s window, its `sa` (orbit angle) advances by ~frames*orbitSpeed and
  // its distance from the boss stays ~constant (the orbit radius). The boss
  // slides, so the doll re-centers on it each frame (trackBoss) — the RADIUS
  // stays fixed even as the whole orbit translates with the boss.
  function orbitProbe(diff, phaseName, expectedRadius, orbitSpeed) {
    const e = aliceFight(diff);
    // Skip to the target phase.
    const idx = e.phases.findIndex(p => p.name === phaseName);
    for (let i = 0; i < idx && !e.result; i++) {
      const lim = e.phases[i].duration * 60;
      let f = 0; while (f < lim && !e.result) { e.update(); f++; }
    }
    // Run a bit so dolls spawn, then hold a reference to one.
    let f = 0;
    while (f < 90 && !e.result) { e.update(); f++; }
    const dolls = e.bullets.filter(b => b.type === 'curve' && b.trackBoss);
    assert(dolls.length > 0, phaseName + ': orbiting dolls exist (got ' + dolls.length + ')');
    if (!dolls.length) return;
    const d = dolls[0];
    const sa1 = d.sa;
    const r1 = Math.hypot(d.x - e.boss.x, d.y - e.boss.y);
    // Advance 1s (60 frames); the same bullet object persists (minLife 1e7,
    // unkillable in this test).
    let g = 0;
    while (g < 60 && !e.result) { e.update(); g++; }
    const sa2 = d.sa;
    const r2 = Math.hypot(d.x - e.boss.x, d.y - e.boss.y);
    // The orbit angle advanced by ~60 * orbitSpeed.
    const dSa = sa2 - sa1;
    assert(Math.abs(dSa - 60 * orbitSpeed) < 0.05,
      phaseName + ': orbit angle advanced ~60*orbitSpeed (dSa=' + dSa.toFixed(3) + ', expect ' + (60 * orbitSpeed).toFixed(3) + ')');
    // Radius stays ~constant and ~ the configured orbit radius.
    assert(Math.abs(r1 - expectedRadius) < 12, phaseName + ': orbit radius ~' + expectedRadius + ' (t1=' + r1.toFixed(1) + ')');
    assert(Math.abs(r2 - expectedRadius) < 12, phaseName + ': orbit radius ~' + expectedRadius + ' (t2=' + r2.toFixed(1) + ')');
    assert(Math.abs(r1 - r2) < 8, phaseName + ': orbit radius stable across 1s (' + r1.toFixed(1) + ' -> ' + r2.toFixed(1) + ')');
    console.log('  ' + phaseName + '  radius ' + r1.toFixed(1) + '->' + r2.toFixed(1) + ' (target ' + expectedRadius + '), dSa=' + dSa.toFixed(3) + ' rad over 1s');
  }
  orbitProbe('normal', 'Soufu "French Dolls"', 90, 0.02);
  orbitProbe('lunatic', 'Soufu "Dutch Dolls"', 70, 0.025);
}

// ────────────────────────────────────────────────────────────────────────────
section('5. Shed verification (bubbles -> dolls; arrowheads -> inward split)');
{
  // Bunraku: the big bubble (r18) bursts into straight-flying dolls (r10,
  // destructible, petal). Verify dolls appear and that those dolls fire blue
  // fan bullets (r4, #66aaff).
  {
    const e = aliceFight('normal');
    // Skip to Bunraku (phase index 1).
    let f = 0; const lim0 = e.phases[0].duration * 60;
    while (f < lim0 && !e.result) { e.update(); f++; }
    let g = 0, sawBubble = false, sawDoll = false, sawBlue = false;
    while (g < 900 && !e.result) {
      e.update(); g++;
      if (e.bullets.some(b => b.destructible && b.r === 18)) sawBubble = true;
      if (e.bullets.some(b => b.destructible && b.r === 10 && b.shape === 'petal')) sawDoll = true;
      if (e.bullets.some(b => b.color === '#66aaff' && b.r <= 6 && !b.destructible)) sawBlue = true;
    }
    assert(sawBubble, 'Bunraku: the big blue bubble appears');
    assert(sawDoll, 'Bunraku: the bubble bursts into dolls');
    assert(sawBlue, 'Bunraku: the dolls fire blue fan bullets');
    console.log('  Bunraku  bubble=' + sawBubble + ' dolls=' + sawDoll + ' blueFan=' + sawBlue);
  }
  // French: the doll's outward blue arrowhead (spawnBullet, star, r6) sheds the
  // inward white split. Verify arrowheads and white bullets appear.
  {
    const e = aliceFight('normal');
    // Skip to French Dolls (phase index 2).
    for (let i = 0; i < 2 && !e.result; i++) {
      const lim = e.phases[i].duration * 60;
      let f = 0; while (f < lim && !e.result) { e.update(); f++; }
    }
    let g = 0, sawWhite = false, sawArrow = false;
    while (g < 900 && !e.result) {
      e.update(); g++;
      // The outward arrowhead is a destructible star bullet (r6) with spawnEmits.
      if (e.bullets.some(b => b.destructible && b.shape === 'star' && b.r === 6 && b.spawnEmits)) sawArrow = true;
      if (e.bullets.some(b => b.color === '#ffffff')) sawWhite = true;
    }
    assert(sawArrow, 'French: outward blue arrowheads (spawnBullets) appear');
    assert(sawWhite, 'French: the inward white split bullets appear');
    console.log('  French  arrowheads=' + sawArrow + ' whiteSplit=' + sawWhite);
  }
}

// ────────────────────────────────────────────────────────────────────────────
section('6. Orbiting dolls are invulnerable emitters (field never runs dry)');
{
  // Regression: the French/Dutch orbiting dolls sit ON the shot line to the
  // boss, and player shots are CONSUMED by destructible bullets. When the
  // dolls were shootable (hp 3), the player's own fire — required to break the
  // card's HP — killed all the emitters (~14s into the 22s French card, ~12s
  // into Dutch) and the field ran dry for the last several seconds. The fix
  // makes the orbiting dolls invulnerable spell emitters (destructible: false),
  // so they persist for the full card and the field stays populated.
  //
  // We run each card with REAL player fire (Sanae/Reisen 'b' pattern) aimed at
  // the boss (the player tracks the boss's x and stands under it) and assert:
  //   (a) the orbiting doll count never drops (no doll is shot down), and
  //   (b) after the initial ramp-up the field never empties (stays above a
  //       small floor for the rest of the card).
  function fireCard(diff, phaseName, expectedDolls) {
    const e = aliceFight(diff);
    const idx = e.phases.findIndex(p => p.name === phaseName);
    for (let i = 0; i < idx && !e.result; i++) {
      const lim = e.phases[i].duration * 60;
      let f = 0; while (f < lim && !e.result) { e.update(); f++; }
    }
    const lim = e.phases[idx].duration * 60;
    let f = 0;
    let minDolls = Infinity, minFieldAfterRamp = Infinity;
    let allSpawned = false; // dolls spawn one-by-one (~0.12s stagger); only
                            // count "minDolls" once the full set is on screen
    const rampFrames = 3 * 60; // 3s ramp-up before the field is steady
    while (f < lim && !e.result) {
      e.player.x = e.boss.x; e.player.y = 560; // track + auto-fire at the boss
      e.update(); f++;
      const dolls = e.bullets.filter(b => b.type === 'curve' && b.trackBoss);
      if (dolls.length === expectedDolls) allSpawned = true;
      if (allSpawned && dolls.length < minDolls) minDolls = dolls.length;
      if (f > rampFrames && e.bullets.length < minFieldAfterRamp) {
        minFieldAfterRamp = e.bullets.length;
      }
    }
    return { minDolls, minFieldAfterRamp, allSpawned };
  }
  const french = fireCard('normal', 'Soufu "French Dolls"', 6);
  assert(french.allSpawned && french.minDolls === 6,
    'French: all 6 orbiting dolls survive the full card under fire (min=' + french.minDolls + ')');
  assert(french.minFieldAfterRamp > 20,
    'French: field never runs dry after ramp-up (min=' + french.minFieldAfterRamp + ')');
  const dutch = fireCard('lunatic', 'Soufu "Dutch Dolls"', 8);
  assert(dutch.allSpawned && dutch.minDolls === 8,
    'Dutch: all 8 orbiting dolls survive the full card under fire (min=' + dutch.minDolls + ')');
  assert(dutch.minFieldAfterRamp > 20,
    'Dutch: field never runs dry after ramp-up (min=' + dutch.minFieldAfterRamp + ')');
  console.log('  French  minDolls=' + french.minDolls + ' minFieldAfterRamp=' + french.minFieldAfterRamp);
  console.log('  Dutch   minDolls=' + dutch.minDolls + ' minFieldAfterRamp=' + dutch.minFieldAfterRamp);
  // Sanity: the dolls really ARE invulnerable (not just untargeted) — a doll
  // must report destructible:false so player shots pass through it.
  {
    const e = aliceFight('normal');
    const idx = e.phases.findIndex(p => p.name === 'Soufu "French Dolls"');
    for (let i = 0; i < idx && !e.result; i++) {
      const lim = e.phases[i].duration * 60;
      let f = 0; while (f < lim && !e.result) { e.update(); f++; }
    }
    let f = 0; while (f < 60 && !e.result) { e.update(); f++; }
    const dolls = e.bullets.filter(b => b.type === 'curve' && b.trackBoss);
    assert(dolls.length > 0 && dolls.every(b => !b.destructible),
      'French: orbiting dolls are marked non-destructible (invulnerable emitters)');
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
