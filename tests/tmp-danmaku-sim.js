// tmp-danmaku-sim.js — headless danmaku fairness measurement.
//
// Plays boss fights with a "competent human" bot (safety-map: predicts where
// bullets are heading, seeks the safest reachable cell, focus + deathbomb,
// small per-trial noise) and reports win rates per boss / difficulty / piece.
//
// This is the tool behind docs/danmaku-engine.md rule 8 (update
// CONFIG.SURVIVAL_PRIORS when a card's difficulty changes meaningfully) and
// the per-boss `tune` calibration in js/danmaku/bosses.js. Re-run it after any
// balance change and compare against the targets: Normal ~75% win, Lunatic
// <25% win, with the difficulty ladder Kaguya/Yukari (hardest) -> Rumia/Hina/
// Nitori (easiest).
//
// The engine's bullet field is deterministic per (boss, piece, char), so the
// bot's per-trial seed is the only source of variation — it models different
// human play on the same card.
//
// Usage (run from the repo root):
//   node tests/tmp-danmaku-sim.js                 # full sweep (9 bosses x 2 diffs x 6 pieces x 10 trials, ~11 min)
//   node tests/tmp-danmaku-sim.js rumia normal p  # single fight type, 5 trials
//   node tests/tmp-danmaku-sim.js --trials 20     # override trial count
//   node tests/tmp-danmaku-sim.js kaguya lunatic --trials 20  # one boss+diff, all pieces

'use strict';
global.window = { addEventListener() {}, removeEventListener() {} };
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => 0;
const CONFIG = require('../js/config.js').CONFIG;
const { BOSSES, getPhases } = require('../js/danmaku/bosses.js');
const { DanmakuEngine } = require('../js/danmaku/engine.js');

function fakeCanvas(w, h) {
  const ctxStub = new Proxy(function () {}, {
    get(t, k) { if (k === Symbol.toPrimitive) return () => 0; return ctxStub; },
    set() { return true; },
    apply() { return ctxStub; },
  });
  return { width: w, height: h, getContext: () => ctxStub };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── The "competent human" bot (safety map) ──────────────────────────────────
// A human danmaku player scans the field, works out where the bullets are
// heading, and moves to the safest reachable spot. This bot models that:
//  - every 3 frames it builds a danger map over a grid of the field:
//      * each bullet contributes danger along its predicted path (~0.6 s
//        lookahead, straight-line — humans read the stream, not the physics)
//      * active beams contribute danger along their ray
//      * walls carry a penalty (a human never hugs the edge)
//  - it picks the lowest-cost cell = danger + distance-from-current-position
//    (the distance term keeps movement smooth and prevents crossing a dense
//    stream for a marginally safer far corner), then moves toward it.
//  - focus (small hitbox) when its own cell is hot.
//  - deathbomb reflex + a hesitant preemptive bomb when cornered.
//  - small per-trial seed noise so no two runs play identically.
function makeBot(rng) {
  const CW = 480, CH = 640, CELL = 24;
  const GW = Math.ceil(CW / CELL), GH = Math.ceil(CH / CELL);
  const danger = new Float32Array(GW * GH);
  const LOOK = 36;                 // ~0.6 s of bullet prediction
  let targetX = 240, targetY = 560;

  function addDanger(cx, cy, radius, amount) {
    const rCells = Math.max(1, Math.ceil(radius / CELL));
    for (let dy = -rCells; dy <= rCells; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= GH) continue;
      for (let dx = -rCells; dx <= rCells; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= GW) continue;
        const d = Math.hypot(dx, dy) * CELL;
        if (d > radius) continue;
        const fall = 1 - d / radius;
        danger[y * GW + x] += amount * fall * fall;
      }
    }
  }

  return function (e) {
    const p = e.player;
    if (!p.alive || e.result) return;

    if (e.frame % 3 === 0) {
      danger.fill(0);
      // Bullets: trace each one's path and mark the cells it will cross.
      for (const b of e.bullets) {
        if (!b.active) continue;
        if (b.laserGroup && e.time < b.laserGroup.solidAt) continue;
        const radius = b.r + 16;
        const w0 = 1 + b.r / 10;
        for (let t = 0; t <= LOOK; t += 3) {
          const bx = b.x + b.vx * t, by = b.y + b.vy * t;
          if (bx < -30 || bx > CW + 30 || by < -30 || by > CH + 30) break;
          const w = w0 * (1 - t / (LOOK + 30));
          addDanger(Math.floor(bx / CELL), Math.floor(by / CELL), radius, w);
        }
      }
      // Beams: mark cells along the ray.
      for (const bm of e._activeBeams()) {
        if (e._beamInWarn(bm)) continue;
        const g = e._beamGeom(bm);
        const ang = e._beamAngle(bm);
        const dir = g.dir;
        const wx = -dir * Math.sin(ang), wy = dir * Math.cos(ang); // ray dir
        const halfW = (bm.width || 40) / 2;
        for (let d = 0; d < 760; d += 12) {
          const px = g.px + wx * d, py = g.py + wy * d;
          if (px < -40 || px > CW + 40 || py < -40 || py > CH + 40) break;
          addDanger(Math.floor(px / CELL), Math.floor(py / CELL), halfW + 14, 1.4);
        }
      }
      // Wall penalty.
      const M = 50;
      for (let y = 0; y < GH; y++) {
        const cy = (y + 0.5) * CELL;
        for (let x = 0; x < GW; x++) {
          const cx = (x + 0.5) * CELL;
          let wp = 0;
          if (cx < M) wp += (M - cx) / M;
          if (cx > CW - M) wp += (cx - (CW - M)) / M;
          if (cy < M) wp += (M - cy) / M;
          if (cy > CH - M) wp += (cy - (CH - M)) / M;
          danger[y * GW + x] += wp * 3;
        }
      }
      // Pick the best cell: min(danger + distance cost).
      let bestI = -1, bestCost = Infinity;
      for (let y = 0; y < GH; y++) {
        for (let x = 0; x < GW; x++) {
          const i = y * GW + x;
          const dx = (x + 0.5) * CELL - p.x, dy = (y + 0.5) * CELL - p.y;
          const cost = danger[i] + Math.hypot(dx, dy) * 0.06;
          if (cost < bestCost) { bestCost = cost; bestI = i; }
        }
      }
      targetX = ((bestI % GW) + 0.5) * CELL;
      targetY = (Math.floor(bestI / GW) + 0.5) * CELL;
    }

    // Move toward the target.
    const dx = targetX - p.x, dy = targetY - p.y;
    e.keys = {};
    if (dx < -3) e.keys['arrowleft'] = true;
    else if (dx > 3) e.keys['arrowright'] = true;
    if (dy < -3) e.keys['arrowup'] = true;
    else if (dy > 3) e.keys['arrowdown'] = true;

    // Focus when the cell we're standing in is hot.
    const cx = Math.max(0, Math.min(GW - 1, Math.floor(p.x / CELL)));
    const cy = Math.max(0, Math.min(GH - 1, Math.floor(p.y / CELL)));
    const here = danger[cy * GW + cx];
    p.focus = here > 0.8;

    // Bombing.
    const phase = e.phases[e.phaseIndex];
    const bombsOk = p.bombs > 0 && !(phase && phase.noBombs);
    if (bombsOk && e.deathbombTimer > 0) e.bomb();
    else if (bombsOk && here > 3 && rng() < 0.1) e.bomb();
  };
}

function runFight(bossId, diff, pieceType, trialSeed) {
  if (!BOSSES[bossId]) throw new Error('unknown boss: ' + bossId);
  const e = new DanmakuEngine(fakeCanvas(480, 640), {
    onEnd() {}, onPhase() {}, onHud() {},
  });
  const phases = getPhases(bossId, diff);
  const boss = { ...BOSSES[bossId], charId: bossId };
  const char = CONFIG.ROSTER[pieceType].you[0];
  e.start(phases, boss, CONFIG.DANMAKU_STATS[pieceType], pieceType, char);
  const bot = makeBot(mulberry32(trialSeed));
  let frames = 0;
  while (!e.result && frames < 60 * 150) {
    bot(e);
    e.update();
    frames++;
  }
  return {
    result: e.result || 'timeout',
    frames,
    time: e.time,
    phaseReached: e.phaseIndex,
    phaseName: e.phases[e.phaseIndex] ? e.phases[e.phaseIndex].name : '',
    livesLeft: e.player.lives,
    bombsLeft: e.player.bombs,
  };
}

// ── Sweep ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let trials = 10;
const tIdx = args.indexOf('--trials');
if (tIdx !== -1) trials = parseInt(args[tIdx + 1], 10);
let filter = tIdx === -1 ? args : args.filter((a, i) => i !== tIdx && i !== tIdx + 1);
if (filter.includes('--verbose')) { global.__VERBOSE = true; filter = filter.filter(a => a !== '--verbose'); }

const bosses = filter[0] ? [filter[0]] : Object.keys(BOSSES);
const diffs = filter[1] ? [filter[1]] : ['normal', 'lunatic'];
const pieces = filter[2] ? [filter[2]] : ['k', 'q', 'r', 'b', 'n', 'p'];
if (filter[0] && trials === 10) trials = 5; // single-fight smoke runs default to 5

const t0 = Date.now();
const rows = [];
for (const bossId of bosses) {
  for (const diff of diffs) {
    for (const piece of pieces) {
      let wins = 0, timeouts = 0;
      const detail = [];
      const fights = [];
      for (let t = 0; t < trials; t++) {
        const r = runFight(bossId, diff, piece, 0x9e3779b9 ^ (t * 0x85ebca6b) ^ (bossId.length * 0x1000193) ^ (piece.charCodeAt(0)));
        if (r.result === 'win') wins++;
        if (r.result === 'timeout') timeouts++;
        detail.push(r.result);
        fights.push(r);
      }
      rows.push({ bossId, diff, piece, wins, n: trials, timeouts, detail, fights });
      const pct = (100 * wins / trials).toFixed(0);
      console.log(`${bossId.padEnd(9)} ${diff.padEnd(7)} ${piece}  ${wins}/${trials} (${pct}%)  ${detail.join('')}`);
      if (global.__VERBOSE) {
        for (const f of fights) {
          console.log(`    t${f.result} @ ${f.time.toFixed(1)}s phase=${f.phaseReached} "${f.phaseName}" lives=${f.livesLeft} bombs=${f.bombsLeft}`);
        }
      }
    }
  }
}

// Aggregates.
console.log('\n── per boss (avg over pieces) ──');
for (const bossId of bosses) {
  for (const diff of diffs) {
    const rs = rows.filter(r => r.bossId === bossId && r.diff === diff);
    const w = rs.reduce((s, r) => s + r.wins, 0);
    const n = rs.reduce((s, r) => s + r.n, 0);
    console.log(`${bossId.padEnd(9)} ${diff.padEnd(7)} ${w}/${n} (${(100 * w / n).toFixed(1)}%)`);
  }
}
console.log('── overall ──');
for (const diff of diffs) {
  const rs = rows.filter(r => r.diff === diff);
  const w = rs.reduce((s, r) => s + r.wins, 0);
  const n = rs.reduce((s, r) => s + r.n, 0);
  console.log(`${diff.padEnd(7)} ${w}/${n} (${(100 * w / n).toFixed(1)}%)`);
}
console.log(`\n${rows.length * trials} fights in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
