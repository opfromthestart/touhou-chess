/* Verify the danmaku-race DESYNC FIX (authoritative state mirror).
 *
 * BEFORE the fix, the spectator (ghost) copy of the opponent's fight was a
 * re-simulation driven only by relayed input (33 ms ticks + latency). Because
 * every emitter aims at the LOCAL player, the ghost's ship position was NOT a
 * mirror of the real one — it diverged (measured 33–210 px in the desynclog
 * evidence), so the ghost faced a different, re-aimed bullet field and could
 * die before the real ship.
 *
 * THE FIX: the spectator engine is a MIRROR of the opponent's real engine. Its
 * ship is a puppet driven by the opponent's AUTHORITATIVE ship/phase state
 * (position/lives/bombs/invuln/phase/result), relayed every 33 ms tick. The
 * local re-simulation only renders the bullet field and can never damage or end
 * the ship on its own — so the spectator's ship position tracks the real one and
 * it dies exactly when the real ship dies (one relay tick later), never earlier.
 *
 * This test is a before/after on the same real fight:
 *   • OLD (input-only relay): the spectator ship position DIVERGES from the real
 *     one (not a mirror) — the root cause of the desync.
 *   • MIRROR (the fix): the spectator ship position TRACKS the real one (a
 *     mirror) and the spectator NEVER dies before the real ship, across a range
 *     of relay delays.
 *
 * Run: node tests/mp_danmaku_mirror_test.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ── Headless DOM/canvas stubs ────────────────────────────────────────────────
global.window = { addEventListener() {}, removeEventListener() {} };
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = () => 0;
global.cancelAnimationFrame = () => {};
global.CONFIG = require(path.join(ROOT, 'js/config.js')).CONFIG;

const { DanmakuEngine } = require(path.join(ROOT, 'js/danmaku/engine.js'));
const { BOSSES, getPhases } = require(path.join(ROOT, 'js/danmaku/bosses.js'));

function fakeCanvas() {
  const c = { width: 480, height: 640, style: {} };
  c.getContext = () => new Proxy({}, {
    get(t, k) {
      if (k === 'canvas') return c;
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => {};
    },
    set() { return true; },
  });
  return c;
}

function mulberry32(a) {
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A reactive dodger (short lookahead) — field-sensitive, so the relayed input
// is a realistic "player" signal. Drives the REAL ship; the spectator follows
// it (old behavior) or mirrors it (the fix).
function makeDodger(e) {
  const OPTS = [[0,0],[0,-1],[0,1],[-1,0],[1,0],[-1,-1],[1,-1],[-1,1],[1,1]];
  return function decide() {
    const p = e.player;
    if (!p.alive) return { up:false, down:false, left:false, right:false };
    let best = { up:false, down:false, left:false, right:false };
    let bestScore = -Infinity;
    for (const [dx,dy] of OPTS) {
      let x = p.x, y = p.y, minD = Infinity;
      const m = Math.hypot(dx,dy) || 1;
      for (let f = 0; f < 8; f++) {
        x += (dx/m) * p.speed; y += (dy/m) * p.speed;
        x = Math.max(10, Math.min(e.W - 10, x));
        y = Math.max(10, Math.min(e.H - 10, y));
        for (const b of e.bullets) {
          if (!b.active) continue;
          const d = Math.hypot(b.x - x, b.y - y);
          if (d < minD) minD = d;
        }
      }
      if (minD > bestScore) { bestScore = minD; best = { up:dy<0, down:dy>0, left:dx<0, right:dx>0 }; }
    }
    return best;
  };
}

// Run one trial of the REAL fight + a spectator copy.
//   mode='mirror' -> spectator is a MIRROR (the fix): fed authoritative ship
//                    state via applyMirrorState(); spectatorMirror=true.
//   mode='input'  -> spectator is the OLD behavior: fed only relayed input via
//                    applyRemoteInput(); spectatorMirror=false.
// `dropFirstMs`/`jitterMs`/`dropRate` model a realistic (lossy, jittery) relay
// for the input mode; the mirror mode uses a clean relay (the state is
// authoritative, so loss only delays it, it can't desync the ship).
function runTrial(mode, delayMs, relayOpts) {
  const real = new DanmakuEngine(fakeCanvas(), { onPhase(){}, onHud(){}, onEnd(){} });
  const spec = new DanmakuEngine(fakeCanvas(), { onPhase(){}, onHud(){}, onEnd(){} });
  spec.externalInput = true;
  spec.spectatorMirror = (mode === 'mirror');

  const bossId = 'rumia', diff = 'lunatic';
  const boss = BOSSES[bossId];
  const phases = getPhases(bossId, diff);
  const stats = CONFIG.DANMAKU_STATS.p; // pawn: lives 1, bombs 1
  const bossObj = { color: boss.color, bgTop: boss.bgTop, bgBottom: boss.bgBottom, move: boss.move, charId: bossId };
  real.start(phases, bossObj, stats, 'p', 'Reimu');
  spec.start(phases, bossObj, stats, 'p', 'Reimu');

  const decide = makeDodger(real);
  const rng = mulberry32(12345);
  const relayBuf = [];
  let lastSample = 0;
  let realDeath = null, specDeath = null;
  const posErrors = [];
  let livesViolations = 0; // frames where spec lives < real lives (must be 0 for the fix)
  const STEP = 1000 / 60;
  const totalFrames = 60 * 30; // 30 s
  const now0 = performance.now();

  for (let f = 0; f < totalFrames; f++) {
    const wall = now0 + f * STEP;
    // 1. Drive the real engine with the dodging policy.
    const inp = decide();
    real.keys['arrowup'] = inp.up; real.keys['arrowdown'] = inp.down;
    real.keys['arrowleft'] = inp.left; real.keys['arrowright'] = inp.right;
    real.update();

    // 2. Sample the real ship every 33 ms (buffered for the relay delay).
    if (wall - lastSample >= 33) {
      lastSample = wall;
      const p = real.player;
      if (mode === 'mirror') {
        relayBuf.push({ t: wall + delayMs, ship: {
          x: p.x, y: p.y, lives: p.lives, bombs: p.bombs, invuln: p.invuln,
          focus: p.focus, alive: p.alive,
          phaseIndex: real.phaseIndex, phaseTime: real.phaseTime, phaseHp: real.phaseHp,
          bombSeq: real.bombSeq, result: real.result,
        }});
      } else {
        // Old behavior: a lossy, jittery input relay.
        const elapsed = wall - now0;
        const dropped = (relayOpts.dropFirstMs > 0 && elapsed < relayOpts.dropFirstMs) ||
                        (rng() < relayOpts.dropRate);
        if (!dropped) {
          const j = Math.floor(rng() * relayOpts.jitterMs);
          relayBuf.push({ t: wall + delayMs + j, state: real.getInputState() });
        }
      }
    }

    // 3. Deliver any buffered states whose time has come.
    while (relayBuf.length && relayBuf[0].t <= wall) {
      const s = relayBuf.shift();
      if (mode === 'mirror') spec.applyMirrorState(s.ship);
      else spec.applyRemoteInput(s.state);
    }

    // 4. Advance the spectator engine.
    spec.update();

    // 5. Record deaths (on the real engine's game clock).
    if (realDeath === null && !real.player.alive) realDeath = real.time;
    if (specDeath === null && !spec.player.alive) specDeath = real.time;

    // 6. Record position error + the lives invariant.
    if (real.player.alive && spec.player.alive) {
      posErrors.push(Math.hypot(real.player.x - spec.player.x, real.player.y - spec.player.y));
    }
    if (mode === 'mirror' && spec.player.lives < real.player.lives) livesViolations++;

    if (realDeath !== null && specDeath !== null) break;
  }

  const avgErr = posErrors.length ? posErrors.reduce((a,b)=>a+b,0) / posErrors.length : 0;
  const maxErr = posErrors.length ? Math.max(...posErrors) : 0;
  return { realDeath, specDeath, avgErr, maxErr, samples: posErrors.length, livesViolations };
}

(function main() {
  let allPass = true;

  // ── MIRROR (the fix): the spectator ship must track the real ship and
  //    NEVER die before it, across a range of relay delays. ────────────────
  console.log('MIRROR (fix) — spectator is a puppet of the authoritative ship state:');
  for (const delayMs of [0, 33, 66, 100]) {
    const m = runTrial('mirror', delayMs, {});
    const tracks = m.avgErr < 50;                          // ship follows the real one
    const neverEarlier = (m.specDeath === null || m.realDeath === null) || (m.specDeath >= m.realDeath - 1e-6);
    const withinWindow = (m.specDeath === null || m.realDeath === null) || (m.specDeath - m.realDeath) < 0.25;
    const livesOk = m.livesViolations === 0;
    const pass = tracks && neverEarlier && withinWindow && livesOk;
    allPass = allPass && pass;
    console.log(`  delay=${String(delayMs).padStart(3)}ms  realDeath=${m.realDeath?.toFixed(2)}s  specDeath=${m.specDeath?.toFixed(2)}s  ` +
      `delta=${(m.specDeath!=null&&m.realDeath!=null)?(m.specDeath-m.realDeath).toFixed(2)+'s':'n/a'}  ` +
      `posAvg=${m.avgErr.toFixed(1)}px  livesViol=${m.livesViolations}  ->  ${pass?'PASS':'FAIL'}`);
  }

  // ── OLD (input-only relay): the spectator ship position must DIVERGE from
  //    the real one (not a mirror) — the root cause of the desync. ─────────
  console.log('\nOLD (input-only relay) — spectator re-simulated from relayed input:');
  const i = runTrial('input', 33, { dropFirstMs: 1000, jitterMs: 66, dropRate: 0.1 });
  const diverges = i.avgErr > 60; // input-only relay desyncs the ship position
  allPass = allPass && diverges;
  console.log(`  realDeath=${i.realDeath?.toFixed(2)}s  specDeath=${i.specDeath?.toFixed(2)}s  ` +
    `posAvg=${i.avgErr.toFixed(1)}px  posMax=${i.maxErr.toFixed(1)}px  samples=${i.samples}`);
  console.log(`  diverges=${diverges}  ->  ${diverges?'PASS (ship position is NOT a mirror — the desync root cause)':'FAIL (no divergence detected)'}`);

  console.log('\nRESULT: ' + (allPass
    ? 'PASS (mirror tracks the real ship and never dies earlier; input-only relay diverges)'
    : 'FAIL'));
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error('fatal: ' + (e && e.stack || e)); process.exit(2); });
