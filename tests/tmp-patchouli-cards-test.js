// tmp-patchouli-cards-test.js — headless tests for the ported Patchouli
// (EoSD/TH06 stage-4) elemental spell cards in js/danmaku/bosses.js:
//   - Non-spell (Sub39, simplified five-element barrage)
//   - Fire Sign "Agni Shine" (Sub42, EN) / "Agni Shine Advanced" (Sub43, H/L)
//   - Water Sign "Princess Undine" (Sub45, EN) / "Berry in Lake" (Sub46, H/L)
//   - Metal Sign "Metal Fatigue" (Sub53, EN) / "Silver Dragon" (Sub54, H/L)
//   - Fire Sign "Agni Radiance" (Sub44, H/L finale)
//
// Checks:
//   1. Every Patchouli phase runs its FULL duration without crashing and
//      produces bullets (no empty fields).
//   2. Determinism: two identical Patchouli fights produce identical fields.
//   3. Density: peak concurrent bullets per card (sanity: under the 2000 cap,
//      and not trivially low).
//   4. Rotating-ring verification: the ring emitters' base angle advances by
//      ~rotStep per firing (the ins_82 angle sweep), i.e. the rings actually
//      rotate shot over shot rather than firing a static pattern.
//   5. Spiral verification: the water spirals' arm angle advances by
//      ~rotSpeed per second (the ins_21 angle step).
//   6. Aimed-fan verification: the water/metal aimed fans point at the player.
//
// Run with: node tests/tmp-patchouli-cards-test.js
global.window = { addEventListener() {}, removeEventListener() {} };
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => 0;

const { BOSSES, getPhases } = require('../js/danmaku/bosses.js'); // sets global.CONFIG
const { DanmakuEngine } = require('../js/danmaku/engine.js');

const TAU = Math.PI * 2;

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log('FAIL: ' + msg); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

// Angular difference in [-π, π] (absolute).
function angDiff(a, b) {
  let d = (b - a) % TAU;
  if (d < 0) d += TAU;
  if (d > Math.PI) d -= TAU;
  return Math.abs(d);
}

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

// A full Patchouli fight (driven manually via update(), like the regression test).
function patchouliFight(diff, pieceType = 'p') {
  const e = new DanmakuEngine(fakeCanvas(480, 640), {});
  const phases = getPhases('patchouli', diff);
  const boss = { ...BOSSES.patchouli, charId: 'patchouli' };
  e.start(phases, boss, CONFIG.DANMAKU_STATS[pieceType], pieceType, 'patchouli');
  // No auto-fire (phases would otherwise be broken by shot damage) and an
  // unkillable player, so we can run each card for its full duration.
  e.shotPattern = { type: 'normal', count: 0, spread: 0, speed: 6, r: 3, color: '#fff', damage: 1, interval: 999999 };
  e.player.lives = 999; e.player.bombs = 99;
  return e;
}

// Skip the engine to the start of the phase named `phaseName`.
function skipToPhase(e, phaseName) {
  const idx = e.phases.findIndex(p => p.name === phaseName);
  for (let i = 0; i < idx && !e.result; i++) {
    const lim = e.phases[i].duration * 60;
    let f = 0; while (f < lim && !e.result) { e.update(); f++; }
  }
  return idx;
}

// ────────────────────────────────────────────────────────────────────────────
section('1. Every Patchouli phase runs full duration, no crash, produces bullets');
{
  for (const diff of ['normal', 'lunatic']) {
    const e = patchouliFight(diff);
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
    assert(bad === 0, diff + ': all Patchouli phases run full duration without crashing or empty fields');
  }
}

// ────────────────────────────────────────────────────────────────────────────
section('2. Determinism (two identical Patchouli fights -> identical fields)');
{
  for (const diff of ['normal', 'lunatic']) {
    const a = patchouliFight(diff);
    const b = patchouliFight(diff);
    const snaps = (e) => {
      const s = [];
      for (let i = 0; i < 480 && !e.result; i++) {
        e.update();
        s.push(e.bullets.map(b => [b.x.toFixed(3), b.y.toFixed(3), b.vx.toFixed(3), b.vy.toFixed(3), b.color].join('|')).join(';'));
      }
      return s;
    };
    const sa = snaps(a), sb = snaps(b);
    assert(sa.length === sb.length && sa.join('\n') === sb.join('\n'),
      diff + ': identical Patchouli fights produce identical bullet fields over 8s');
  }
  // A different difficulty is a different fight identity -> different field.
  const n = patchouliFight('normal');
  const l = patchouliFight('lunatic');
  const snap = (e) => {
    const s = [];
    for (let i = 0; i < 240 && !e.result; i++) {
      e.update();
      s.push(e.bullets.map(b => [b.x.toFixed(3), b.y.toFixed(3), b.color].join('|')).join(';'));
    }
    return s;
  };
  assert(snap(n).join('\n') !== snap(l).join('\n'), 'normal vs lunatic Patchouli fights differ');
}

// ────────────────────────────────────────────────────────────────────────────
section('3. Density (peak concurrent bullets per card, under the 2000 cap)');
{
  for (const diff of ['normal', 'lunatic']) {
    const e = patchouliFight(diff);
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
// Find A rotation (rad, in [-π, π]) that maps angle-set S1 to angle-set S2
// (each the set of firing angles from one ring firing). A full ring of
// evenly-spaced bullets is rotationally symmetric, so the rotation is only
// determined modulo the step (TAU/count): there are `count` equivalent
// rotations. We return the one with the smallest absolute value. Returns null
// if no clean rotation is found. Robust to the small per-bullet seeded jitter.
function ringRotation(S1, S2) {
  if (S1.length < 2 || S2.length < 2) return null;
  const a0 = Math.min(...S1);
  let best = null, bestScore = -1, bestAbs = Infinity;
  for (const b of S2) {
    let r = ((b - a0) % TAU + TAU) % TAU;
    if (r > Math.PI) r -= TAU;
    let score = 0;
    for (const a of S1) {
      const target = a + r;
      if (S2.some(c => angDiff(target, c) < 0.06)) score++;
    }
    if (score > bestScore || (score === bestScore && Math.abs(r) < bestAbs)) {
      bestScore = score; best = r; bestAbs = Math.abs(r);
    }
  }
  if (bestScore < S1.length * 0.8) return null;
  return best;
}

// Detect two consecutive firings of a `color` ring and verify the base angle
// advances by ~expectedRotStep per firing. Because a full ring is symmetric
// under a rotation of the step (TAU/count), the measured rotation is only
// determined modulo the step — so we check that it is CONGRUENT to
// expectedRotStep modulo the step, not equal to it.
function ringProbe(diff, phaseName, color, expectedRotStep) {
  const e = patchouliFight(diff);
  skipToPhase(e, phaseName);
  let prevCount = e.bullets.filter(b => b.color === color).length;
  let firing1 = null, firing2 = null, count1 = 0;
  let frames = 0;
  const maxFrames = 600; // 10s
  while (frames < maxFrames && !e.result && (!firing1 || !firing2)) {
    e.update(); frames++;
    const cur = e.bullets.filter(b => b.color === color).length;
    const delta = cur - prevCount;
    if (delta > 0) {
      // A firing just happened; `delta` new bullets of `color`. Wait a few
      // frames so they move off the boss (angles become well-defined), then
      // capture the newest `delta` bullets' angles.
      for (let w = 0; w < 10 && !e.result; w++) e.update();
      const ofColor = e.bullets.filter(b => b.color === color);
      const last = ofColor.slice(-delta);
      if (last.length >= 2) {
        const angles = last.map(b => Math.atan2(b.y - e.boss.y, b.x - e.boss.x));
        if (!firing1) { firing1 = angles; count1 = last.length; }
        else if (!firing2) firing2 = angles;
      }
      prevCount = e.bullets.filter(b => b.color === color).length;
    } else {
      prevCount = cur;
    }
  }
  assert(firing1 && firing2, phaseName + ': detected two firings of ' + color);
  if (!firing1 || !firing2) return;
  const rot = ringRotation(firing1, firing2);
  assert(rot !== null, phaseName + ': ring rotation between firings is well-defined');
  if (rot !== null) {
    // The step is TAU/count; the rotation is determined modulo the step.
    const step = TAU / count1;
    const d = ((rot - expectedRotStep) % step + step) % step;
    const off = Math.min(d, step - d); // distance to the nearest multiple of step
    assert(off < 0.06,
      phaseName + ': ring rotation ≡ ' + expectedRotStep + ' (mod step ' + step.toFixed(3) + '); got ' + rot.toFixed(3) + ' (off by ' + off.toFixed(3) + ')');
    console.log('  ' + phaseName + '  ring rot/firing = ' + rot.toFixed(3) + ' ≡ ' + expectedRotStep + ' (mod ' + step.toFixed(3) + ')');
  }
}

section('4. Rotating-ring verification (base angle advances ~rotStep per firing)');
{
  // Fire rings (Agni Shine / Agni Shine Advanced) and metal rings
  // (Metal Fatigue / Silver Dragon) all use per-fire rotStep rotation.
  ringProbe('normal', 'Fire Sign "Agni Shine"', '#ff8844', 0.16);
  ringProbe('lunatic', 'Fire Sign "Agni Shine Advanced"', '#ff8844', 0.18);
  ringProbe('normal', 'Metal Sign "Metal Fatigue"', '#ccccdd', 0.7854);
  ringProbe('lunatic', 'Metal Sign "Silver Dragon"', '#ccccdd', 0.5);
}

// ────────────────────────────────────────────────────────────────────────────
// Verify the spiral's arm angle advances by ~expectedRotSpeed per second:
// capture the newest spiral bullet's angle (from the boss) now and 1s later;
// the arm angle = rotSpeed * phaseTime, so the difference ≈ rotSpeed * 1s.
function spiralProbe(diff, phaseName, color, expectedRotSpeed) {
  const e = patchouliFight(diff);
  skipToPhase(e, phaseName);
  // Sample during the W2 "Attack" wave (the signature spiral starts at t=3s),
  // not the low-density W1 setup. Skip to t=4s, then re-sample 1s later.
  let f = 0;
  while (f < 240 && !e.result) { e.update(); f++; }
  const newestAngle = () => {
    const ofColor = e.bullets.filter(b => b.color === color);
    if (!ofColor.length) return null;
    const b = ofColor[ofColor.length - 1];
    return Math.atan2(b.y - e.boss.y, b.x - e.boss.x);
  };
  const a1 = newestAngle();
  assert(a1 !== null, phaseName + ': spiral bullets exist');
  if (a1 === null) return;
  let g = 0;
  while (g < 60 && !e.result) { e.update(); g++; }
  const a2 = newestAngle();
  assert(a2 !== null, phaseName + ': spiral bullets persist after 1s');
  if (a2 === null) return;
  let d = ((a2 - a1) % TAU + TAU) % TAU;
  if (d > Math.PI) d -= TAU;
  assert(Math.abs(d - expectedRotSpeed) < 0.2,
    phaseName + ': spiral arm advanced ~rotSpeed*1s (d=' + d.toFixed(3) + ', expect ' + expectedRotSpeed + ')');
  console.log('  ' + phaseName + '  spiral arm advance = ' + d.toFixed(3) + ' rad/1s (expect ' + expectedRotSpeed + ')');
}

section('5. Spiral verification (arm angle advances ~rotSpeed per second)');
{
  spiralProbe('normal', 'Water Sign "Princess Undine"', '#66ccff', 0.35);
  spiralProbe('lunatic', 'Water Sign "Berry in Lake"', '#66ccff', 0.45);
}

// ────────────────────────────────────────────────────────────────────────────
// Verify the aimed fan points at the player: some bullets of `color` have a
// velocity direction within `spread` (+tolerance) of the boss->player aim line.
function aimedProbe(diff, phaseName, color, spread) {
  const e = patchouliFight(diff);
  skipToPhase(e, phaseName);
  let f = 0, sawAimed = false;
  while (f < 300 && !e.result && !sawAimed) {
    e.update(); f++;
    const aim = Math.atan2(e.player.y - e.boss.y, e.player.x - e.boss.x);
    const ofColor = e.bullets.filter(b => b.color === color);
    for (const b of ofColor) {
      const vdir = Math.atan2(b.vy, b.vx);
      if (angDiff(aim, vdir) < spread + 0.1) { sawAimed = true; break; }
    }
  }
  assert(sawAimed, phaseName + ': aimed bullets point at the player');
  console.log('  ' + phaseName + '  aimed=' + sawAimed);
}

section('6. Aimed-fan verification (fans point at the player)');
{
  // The water aimed fans (Princess Undine / Berry in Lake) have no angleStep,
  // so they aim straight at the player.
  aimedProbe('normal', 'Water Sign "Princess Undine"', '#44aaff', 0.35);
  aimedProbe('lunatic', 'Water Sign "Berry in Lake"', '#44aaff', 0.4);
}

// ────────────────────────────────────────────────────────────────────────────
// Wave structure: the user's core complaint was that cards were "the same
// thing all the way through." A wavy card spreads its emitters across the
// card (setup -> attack -> turn -> tail), so the emitter `t` values span a
// wide window rather than all firing from t=0.
section('7. Wave structure (cards are not flat — emitters span the duration)');
{
  for (const diff of ['normal', 'lunatic']) {
    for (const ph of getPhases('patchouli', diff)) {
      if (!ph.emits || !ph.emits.length) continue;
      const ts = ph.emits.map(e => e.t || 0);
      const span = Math.max(...ts) - Math.min(...ts);
      assert(span >= 6,
        diff + ' ' + ph.name + ': emitter t-span ' + span.toFixed(1) +
        's is >= 6s (distinct waves, not one flat pattern from t=0)');
      console.log('  ' + diff + '  ' + ph.name.padEnd(34) +
        ' t-span=' + span.toFixed(1) + 's, emitters=' + ts.length);
    }
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
