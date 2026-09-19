/* Multiplayer LATENCY test — exercises the desync class of glitches reported
 * in touhou-chess-log-2026-09-18T16-49-48-217Z.json:
 *   • captures desync between clients (one applies the capture, the other
 *     undoes it)
 *   • both players thinking they had won (gameOver/winner divergence)
 *   • the same piece "captured" multiple times (piece present in the captured
 *     tray while still on the board)
 *   • endgame deadlock: a made move is invisible to the opponent, so neither
 *     side can move (the turn guard in receiveMove drops every later move)
 *
 * How it works
 * ------------
 * Spawns ONE static server and TWO headless-Chromium instances (host = white,
 * guest = black). Before connecting, each page gets a latency shim that delays
 * every message crossing the link by LAT_MS milliseconds (default 250, one-way;
 * override with the LAT_MS env var):
 *   • outbound: TCNet.send is wrapped so conn.send() fires after LAT_MS
 *   • inbound:  TCNet._message is wrapped so the handler runs after LAT_MS
 *     (the PeerJS 'data' listener calls this._message dynamically, so wrapping
 *     the method is enough — no vendor code is touched)
 *
 * Then it plays a scripted game:
 *
 *   Scenario A — forced DIVERGENT death (reliable bug reproduction):
 *     e4 / d5 / exd5 starts a capture race. Once both race engines are live,
 *     the test forces a DIVERGENT death through the real _hitPlayer code path:
 *       • host (white = attacker) kills its OWN ship (the attacker)
 *       • guest (black = defender) kills its OWN ship (the defender)
 *     Each client's premature-resolution check (doResolveCheck,
 *     multiplayer.js:743-744) then fires on a DIFFERENT side: the host sees the
 *     attacker die while its spectator copy of the defender is still running and
 *     resolves 'fail' (capture failed); the guest sees the defender die while its
 *     spectator copy of the attacker is still running and resolves 'success'
 *     (capture succeeded). The authoritative 'fight-result' messages arrive
 *     LAT_MS later but are ignored because race.resolved is already true. The
 *     d5 cell and the captured trays therefore DIVERGE — the "captures desynced
 *     / both players think they won" glitch from the log. When the bug is fixed
 *     the two clients resolve consistently and the invariants hold.
 *
 *   Scenario B — natural races under latency (the stress):
 *     If Scenario A is clean (bug fixed), the game continues with two more
 *     capture races (d5xe6, Qxd4) that resolve naturally. While a race runs, a
 *     "player bot" oscillates each client's OWN ship, so the relayed input
 *     genuinely lags the real copy — the exact condition under which a spectator
 *     copy diverges from the real fight and the game-clock end times stop being
 *     "consistent across clients".
 *
 *   After EVERY move the test asserts invariants on both clients:
 *     1. grid agreement (piece colour+type on all 64 squares)
 *     2. turn agreement
 *     3. gameOver / winner agreement
 *     4. captured-tray agreement (same entries, same order)
 *     5. piece conservation: for every (type,colour,character),
 *        count-on-board + count-in-tray == initial count.
 *        Catches the "same piece captured twice" glitch (a piece that exists
 *        in the tray while still on the board) and silently-vanishing pieces
 *        (applyMove overwrites grid[to] without validation).
 *
 *   Finally a DEADLOCK PROBE: it checks whether at least one client's LOCAL
 *   player can move (host = white, guest = black). If NEITHER can move, that's
 *   the log's final "neither player could move" state (turn parity desynced so
 *   each client thinks it's the other's turn) and the probe fails. If at least
 *   one can move, it plays a quiet legal move for that player's own colour and
 *   verifies the move actually reaches the other client — if the opponent's
 *   receiveMove turn-guard drops it, the probe fails.
 *
 * Run:
 *   node tests/mp_latency_test.js              # 250 ms one-way latency
 *   LAT_MS=600 node tests/mp_latency_test.js   # heavier link
 *
 * Exit codes: 0 = all invariants held, 1 = desync/glitch detected, 2 = fatal
 * (could not connect, etc.).
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8132;
const URL = `http://127.0.0.1:${PORT}/index.html`;
const DBG_A = 9361; // host (white)
const DBG_B = 9362; // guest (black)
const LAT_MS = parseInt(process.env.LAT_MS || '250', 10); // one-way latency, ms
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) {}
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for: ' + what);
    await sleep(150);
  }
}

function cdp(ws) {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  });
  return (method, params) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
}

async function launchChrome(dbgPort) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lat-'));
  const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--user-data-dir=${prof}`, `--remote-debugging-port=${dbgPort}`, 'about:blank'], { stdio: 'ignore' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${dbgPort}/json/version`)).ok, 15000, 'devtools ' + dbgPort);
  const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
  const target = list.find((t) => t.type === 'page') || list[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const clickSq = (row, col) => evalJs(`(() => { const s = document.querySelector('#board .square[data-row="${row}"][data-col="${col}"]'); if (!s) return false; s.click(); return true; })()`);
  // Compact, comparable snapshot of everything the invariants need.
  const snap = () => evalJs(`(() => {
    const st = window.__MP.state;
    const b = st.board;
    const grid = b.grid.map((r) => r.map((c) => c ? c.color[0] + c.type : '.')).join('|');
    const counts = {};
    for (const r of b.grid) for (const c of r) if (c) {
      const k = c.type + '/' + c.color + '/' + c.character;
      counts[k] = (counts[k] || 0) + 1;
    }
    for (const cap of st.captured) {
      const k = cap.piece.type + '/' + cap.piece.color + '/' + cap.piece.character;
      counts[k] = (counts[k] || 0) + 1;
    }
    const r = window.__MP.race;
    return JSON.stringify({
      grid, board: !!b, turn: b.turn, gameOver: b.gameOver, winner: b.winner,
      inRace: st.inRace, connected: st.connected,
      captured: st.captured, counts,
      race: r ? { resolved: r.resolved, results: r.results } : null,
    });
  })()`).then((s) => JSON.parse(s));
  return { chrome, prof, ws, send, evalJs, clickSq, snap };
}

// ── Latency shim ─────────────────────────────────────────────────────────────
// Delays every message in both directions by LAT_MS. Injected before the
// connection is made; wraps TCNet (our wrapper), not the vendored PeerJS.
async function injectLatency(page, ms) {
  const r = await page.evalJs(`(() => {
    if (window.__LAT_SHIM) return 'already';
    const LAT = ${ms};
    const origSend = TCNet.send;
    TCNet.send = function (data) {
      if (!TCNet.connected) return false;
      const conn = TCNet.conn;
      setTimeout(() => { try { conn.send(data); } catch (e) {} }, LAT);
      return true;
    };
    const origMsg = TCNet._message;
    TCNet._message = function (data) {
      setTimeout(() => origMsg.call(TCNet, data), LAT);
    };
    window.__LAT_SHIM = LAT;
    return 'ok';
  })()`);
  if (r !== 'ok') throw new Error('latency shim failed: ' + r);
}

// ── Player bot ───────────────────────────────────────────────────────────────
// Oscillates the client's OWN ship during a race. With no input the real and
// spectator copies of a fight are identical (same seed, no inputs) and can
// never diverge — so the bot is what makes the latency test meaningful: the
// relayed input lags the real copy by LAT_MS and the trajectories separate.
async function startBot(page) {
  await page.evalJs(`(() => {
    if (window.__BOT) clearInterval(window.__BOT);
    window.__BOT = setInterval(() => {
      const e = window.__MP && window.__MP.engines && window.__MP.engines.own;
      if (!e || !e.running || !e.player || !e.player.alive) return;
      const t = performance.now() / 1000;
      const k = e.keys;
      k['arrowleft']  = Math.sin(t * 1.7) >  0.15;
      k['arrowright'] = Math.sin(t * 1.7) < -0.15;
      k['arrowup']    = Math.sin(t * 0.9) >  0.55;
      k['arrowdown']  = Math.sin(t * 0.6) < -0.75;
    }, 40);
    return true;
  })()`);
}
async function stopBot(page) {
  await page.evalJs(`(() => { if (window.__BOT) { clearInterval(window.__BOT); window.__BOT = null; } return true; })()`);
}

// ── Result bookkeeping ───────────────────────────────────────────────────────
const CHECKS = [];
const ck = (name, ok, problems) => CHECKS.push({ name, ok: !!ok, problems: problems || [] });
// Initial piece multiset (type/colour/character -> count), recorded once both
// clients are connected and before any move is played.
let INITIAL_COUNTS = null;

async function checkInvariants(label, A, B) {
  const sa = await A.snap();
  const sb = await B.snap();
  const problems = [];
  if (sa.grid !== sb.grid) problems.push('GRID MISMATCH — the two boards differ');
  if (sa.turn !== sb.turn) problems.push(`TURN MISMATCH — host=${sa.turn} guest=${sb.turn}`);
  if (sa.gameOver !== sb.gameOver) problems.push(`gameOver MISMATCH — host=${sa.gameOver} guest=${sb.gameOver}`);
  if (sa.winner !== sb.winner) problems.push(`winner MISMATCH — host=${sa.winner} guest=${sb.winner} ("both think they won" class)`);
  if (JSON.stringify(sa.captured) !== JSON.stringify(sb.captured)) {
    problems.push('CAPTURED-TRAY MISMATCH — ' +
      'host=' + JSON.stringify(sa.captured) + ' guest=' + JSON.stringify(sb.captured));
  }
  for (const k of Object.keys(INITIAL_COUNTS)) {
    const init = INITIAL_COUNTS[k];
    if ((sa.counts[k] || 0) !== init) problems.push(`host piece conservation broken: ${k} board+tray=${sa.counts[k] || 0} initial=${init} (same piece "captured" while still on the board, or a piece vanished)`);
    if ((sb.counts[k] || 0) !== init) problems.push(`guest piece conservation broken: ${k} board+tray=${sb.counts[k] || 0} initial=${init} (same piece "captured" while still on the board, or a piece vanished)`);
  }
  const ok = problems.length === 0;
  ck('invariants after ' + label, ok, problems);
  if (!ok) {
    console.log('\n--- INVARIANT FAILURE after ' + label + ' ---');
    problems.forEach((p) => console.log('  ✗ ' + p));
    console.log('  host grid : ' + sa.grid);
    console.log('  guest grid: ' + sb.grid);
    console.log('  host turn=' + sa.turn + '  guest turn=' + sb.turn);
    console.log('  host tray : ' + JSON.stringify(sa.captured));
    console.log('  guest tray: ' + JSON.stringify(sb.captured));
    console.log('  host race : ' + JSON.stringify(sa.race));
    console.log('  guest race: ' + JSON.stringify(sb.race));
  } else {
    console.log('  [ok] invariants hold after ' + label);
  }
  return ok;
}

// ── Race helpers ─────────────────────────────────────────────────────────────
async function waitRaceStart(A, B, label) {
  await waitFor(async () => {
    const sa = await A.snap(); const sb = await B.snap();
    return sa.inRace && sb.inRace;
  }, 15000, 'race start (' + label + ')');
  await waitFor(async () => {
    const live = (page) => page.evalJs(`!!(window.__MP.engines && window.__MP.engines.own && window.__MP.engines.opp && window.__MP.engines.own.running && window.__MP.engines.opp.running)`);
    return (await live(A)) && (await live(B));
  }, 8000, 'race engines live (' + label + ')');
}

async function waitRaceSettled(A, B, label, timeoutMs) {
  await waitFor(async () => {
    const sa = await A.snap(); const sb = await B.snap();
    return !sa.inRace && !sb.inRace && sa.race && sa.race.resolved && sb.race && sb.race.resolved;
  }, timeoutMs, 'race settle (' + label + ')');
}

// Play a move (from-square then to-square click) on one client.
async function doMove(page, from, to, label) {
  const ok1 = await page.clickSq(from[0], from[1]);
  await sleep(150);
  const ok2 = await page.clickSq(to[0], to[1]);
  if (!ok1 || !ok2) throw new Error('click failed for ' + label + ` (${from} -> ${to})`);
}

// Wait until `page`'s board says it is `color`'s turn (move propagated).
async function waitTurn(page, color, label) {
  await waitFor(async () => (await page.snap()).turn === color, 10000, 'turn=' + color + ' after ' + label);
}

(async () => {
  console.log('=== MP LATENCY TEST (one-way latency = ' + LAT_MS + ' ms) ===');

  // Server + two browsers.
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await waitFor(async () => (await fetch(URL, { method: 'HEAD' })).ok, 8000, 'server');
  console.log('[lat] server up at ' + URL);
  const A = await launchChrome(DBG_A); // host = white
  const B = await launchChrome(DBG_B); // guest = black
  console.log('[lat] two browsers up (host=' + DBG_A + ', guest=' + DBG_B + ')');
  await A.send('Page.navigate', { url: URL });
  await B.send('Page.navigate', { url: URL });
  await sleep(2500);

  // Latency shim on BOTH pages, before the connection exists.
  await injectLatency(A, LAT_MS);
  await injectLatency(B, LAT_MS);
  console.log('[lat] latency shim active on both pages (' + LAT_MS + ' ms one-way)');

  // Connect: host a room, join it.
  await A.evalJs(`document.getElementById('btn-multiplayer').click(); true`);
  await A.evalJs(`document.getElementById('mp-host-btn').click(); true`);
  const code = await waitFor(async () => {
    const v = await A.evalJs(`(() => { const el = document.getElementById('mp-code-value'); const t = el && el.textContent.trim(); return t && t.length >= 4 ? t : null; })()`);
    return v || null;
  }, 20000, 'room code (host)');
  console.log('[lat] host created room ' + code);
  await B.evalJs(`document.getElementById('btn-multiplayer').click(); true`);
  await B.evalJs(`(() => { document.getElementById('mp-code-input').value = ${JSON.stringify(code)}; return true; })()`);
  await B.evalJs(`document.getElementById('mp-join-btn').click(); true`);
  try {
    await waitFor(async () => {
      const sa = await A.snap(); const sb = await B.snap();
      return sa.connected && sb.connected && sa.board && sb.board && sa.turn && sb.turn;
    }, 60000, 'both peers connected + game started');
  } catch (e) {
    // Where is the handshake stuck? Dump per-page net state.
    for (const [name, page] of [['host', A], ['guest', B]]) {
      const d = await page.evalJs(`(() => {
        const st = window.__MP.state;
        return JSON.stringify({
          netStatus: (document.getElementById('mp-net-status') || {}).textContent || '?',
          role: TCNet.role, code: TCNet.code,
          hasConn: !!TCNet.conn, connOpen: !!(TCNet.conn && TCNet.conn.open),
          peerExists: !!TCNet.peer, shim: window.__LAT_SHIM,
          connected: st.connected, board: !!st.board, turn: st.board ? st.board.turn : null,
        });
      })()`);
      console.log('[lat] DIAG ' + name + ': ' + d);
    }
    throw e;
  }
  await sleep(500);
  console.log('[lat] connected: host=white, guest=black');

  // Initial state must already agree; record the piece multiset for the
  // conservation invariant. (No promotions are played in this script, so the
  // multiset is stable for the whole game.)
  const s0a = await A.snap();
  const s0b = await B.snap();
  if (s0a.grid !== s0b.grid || s0a.turn !== s0b.turn) {
    console.log('FATAL: initial boards disagree before any move was played.');
    process.exit(2);
  }
  INITIAL_COUNTS = s0a.counts;
  ck('initial state agrees (grid + turn)', true);
  console.log('[lat] initial board agreed; piece multiset recorded (' + Object.keys(INITIAL_COUNTS).length + ' distinct pieces)');

  let desyncedAt = null; // label of the first invariant failure
  // Run a script step; if invariants break, remember where and stop scripting.
  async function step(label, fn) {
    if (desyncedAt) return false;
    try {
      await fn();
    } catch (e) {
      desyncedAt = label;
      ck('step completed: ' + label, false, [String(e && e.message || e)]);
      console.log('\n--- STEP FAILED: ' + label + ' — ' + (e && e.message || e) + ' ---');
      return false;
    }
    const ok = await checkInvariants(label, A, B);
    if (!ok) desyncedAt = label;
    return ok;
  }

  // ═══ Scenario A — forced DIVERGENT death (reliable bug reproduction) ═════
  // This is the deterministic reproduction of the "both players think they won"
  // + "captures desynced" glitch from the 2026-09-18 log. It forces each client
  // to observe a DIFFERENT ship die first, which trips the premature-resolution
  // path in doResolveCheck (multiplayer.js:743-744) on both sides. When that bug
  // is present the d5 cell diverges and checkInvariants() fails; when it is
  // fixed the cells agree and the test proceeds to the natural Scenario B.
  console.log('\n--- Scenario A: forced divergent-death capture race (bug reproduction) ---');
  await step('e2-e4', async () => {
    await doMove(A, [6, 4], [4, 4], 'e2-e4');
    await waitTurn(B, 'black', 'e2-e4');
  });
  await step('d7-d5', async () => {
    await doMove(B, [1, 3], [3, 3], 'd7-d5');
    await waitTurn(A, 'white', 'd7-d5');
  });
  await step('exd5 (forced DIVERGENT death)', async () => {
    await doMove(A, [4, 4], [3, 3], 'exd5');
    await waitRaceStart(A, B, 'exd5');
    await startBot(A); await startBot(B);
    await sleep(400); // let the danmaku ramp a beat before forcing the deaths
    // Force a DIVERGENT death through the real hit code path, so that each
    // client's premature-resolution check (doResolveCheck, multiplayer.js:743-744)
    // fires on a DIFFERENT side:
    //   host (white = attacker)  -> kill its OWN ship ('own' = attacker).
    //       Host sees the ATTACKER die while its spectator copy of the defender
    //       is still running -> resolves 'fail' (attacker loses) prematurely.
    //   guest (black = defender) -> kill its OWN ship ('own' = defender).
    //       Guest sees the DEFENDER die while its spectator copy of the attacker
    //       is still running -> resolves 'success' (attacker wins) prematurely.
    // Both clients therefore believe THEY won, and the d5 cell diverges
    // (host: black pawn stays / white pawn removed; guest: white pawn placed /
    // black pawn removed). The authoritative 'fight-result' messages arrive 250ms
    // later but are ignored because race.resolved is already true.
    await A.evalJs(`window.__MP.forceHitDeath('own'); true`);
    await B.evalJs(`window.__MP.forceHitDeath('own'); true`);
    await waitRaceSettled(A, B, 'exd5', 30000);
    await stopBot(A); await stopBot(B);
    // Diagnostic only — checkInvariants() below is the real assertion (grid
    // agreement). When the premature-resolution bug is present the cells diverge
    // (host != guest); when it is fixed they agree.
    const cell = (page) => page.evalJs(`(() => { const c = window.__MP.state.board.grid[3][3]; return c ? c.color[0] + c.type : 'EMPTY'; })()`);
    const ca = await cell(A); const cb = await cell(B);
    console.log('  race A outcome: d5 cell host=' + ca + ' guest=' + cb + (ca === cb ? ' (agrees)' : '  <-- DIVERGED: premature-resolution desync reproduced'));
  });

  // ═══ Scenario B — natural races under latency (the stress) ═══════════════
  // Two natural capture races, each independent of the other's outcome:
  //   Race B: white d5 pawn captures the black e6 pawn (d5xe6)
  //   Race C: black queen captures the white d4 pawn (Qxd4)
  // While each race runs, the bot oscillates both clients' own ships so the
  // relayed input genuinely lags the real copy — the condition under which a
  // spectator copy diverges from the real fight and the game-clock end times
  // stop being "consistent across clients".
  console.log('\n--- Scenario B: natural capture races under latency (bot-driven input) ---');
  await step('Nf6', async () => {
    await doMove(B, [0, 6], [2, 5], 'Nf6');
    await waitTurn(A, 'white', 'Nf6');
  });
  await step('d2-d4', async () => {
    await doMove(A, [6, 3], [4, 3], 'd2-d4');
    await waitTurn(B, 'black', 'd2-d4');
  });
  await step('e7-e6', async () => {
    await doMove(B, [1, 4], [2, 4], 'e7-e6');
    await waitTurn(A, 'white', 'e7-e6');
  });
  await step('d5xe6 (natural race B)', async () => {
    await doMove(A, [3, 3], [2, 4], 'd5xe6');
    await waitRaceStart(A, B, 'd5xe6');
    await startBot(A); await startBot(B);
    await waitRaceSettled(A, B, 'd5xe6', 180000);
    await stopBot(A); await stopBot(B);
  });
  await step('Nc6', async () => {
    await doMove(B, [0, 1], [2, 2], 'Nc6');
    await waitTurn(A, 'white', 'Nc6');
  });
  await step('g2-g4', async () => {
    await doMove(A, [6, 6], [4, 6], 'g2-g4');
    await waitTurn(B, 'black', 'g2-g4');
  });
  await step('Qd6', async () => {
    await doMove(B, [0, 3], [2, 3], 'Qd6');
    await waitTurn(A, 'white', 'Qd6');
  });
  await step('f2-f4', async () => {
    await doMove(A, [6, 5], [4, 5], 'f2-f4');
    await waitTurn(B, 'black', 'f2-f4');
  });
  await step('Qxd4 (natural race C)', async () => {
    await doMove(B, [2, 3], [4, 3], 'Qxd4');
    await waitRaceStart(A, B, 'Qxd4');
    await startBot(A); await startBot(B);
    await waitRaceSettled(A, B, 'Qxd4', 180000);
    await stopBot(A); await stopBot(B);
  });

  if (desyncedAt) {
    console.log('\n[lat] invariants broke at "' + desyncedAt + '" — skipping the rest of the script; jumping to the deadlock probe.');
  }

  // ═══ Deadlock probe ═══════════════════════════════════════════════════════
  // The log's final state: a move was made but the opponent never saw it, so
  // neither player could move. A real deadlock is when NEITHER client's LOCAL
  // player can move — i.e. the host (white) has board.turn !== 'white' AND the
  // guest (black) has board.turn !== 'black' (each client thinks it is the
  // other's turn, or one side's game is over while the other's turn is that
  // side's colour). We check that condition directly; if at least one local
  // player CAN move, we play a quiet move for that player's own colour and
  // verify the other client's board actually changes (the move propagates).
  console.log('\n--- Deadlock probe ---');
  async function deadlockProbe() {
    const sa = await A.snap();
    const sb = await B.snap();
    // Host is always white, guest always black (fixed by the handshake).
    const hostCanMove = !sa.gameOver && sa.turn === 'white';
    const guestCanMove = !sb.gameOver && sb.turn === 'black';
    console.log('  [probe] host (white) can move: ' + hostCanMove + ' (turn=' + sa.turn + ', over=' + sa.gameOver + '); guest (black) can move: ' + guestCanMove + ' (turn=' + sb.turn + ', over=' + sb.gameOver + ')');

    if (!hostCanMove && !guestCanMove) {
      // Full deadlock: neither local player can move — the log-end glitch.
      ck('deadlock probe: at least one player can move', false, [
        'DEADLOCK: neither player can move — host.turn=' + sa.turn + ' (host is white, over=' + sa.gameOver + '), guest.turn=' + sb.turn + ' (guest is black, over=' + sb.gameOver + '). Each client is stuck on the other\'s turn.'
      ]);
      return;
    }

    // At least one local player can move. Play a quiet legal move for that
    // player's own colour and verify the other client's board changes.
    const mover = hostCanMove ? A : B;
    const other = hostCanMove ? B : A;
    const moverName = hostCanMove ? 'host' : 'guest';
    const color = hostCanMove ? 'white' : 'black';
    const mv = await mover.evalJs(`(() => {
      const b = window.__MP.state.board;
      if (b.gameOver) return null;
      const moves = b.getMoves(${JSON.stringify(color)});
      if (!moves || !moves.length) return null;
      const quiet = moves.find((m) => !m.captured && !m.isCastle) || moves[0];
      return { from: [quiet.from.row, quiet.from.col], to: [quiet.to.row, quiet.to.col], isCapture: !!quiet.captured };
    })()`);
    if (!mv) {
      console.log('  [probe] no quiet legal move for ' + moverName + ' (game over or no moves) — probe skipped');
      ck('deadlock probe: at least one player can move', true);
      return;
    }
    const gridOtherBefore = (await other.snap()).grid;
    console.log('  [probe] ' + moverName + ' plays ' + color + ' (' + mv.from + ') -> (' + mv.to + ')' + (mv.isCapture ? ' [capture — waiting out the race]' : '') + '; waiting for the other board to change…');
    await doMove(mover, mv.from, mv.to, 'probe');
    if (mv.isCapture) {
      try { await waitRaceSettled(A, B, 'probe capture', 120000); } catch (e) { /* fall through to the grid check */ }
    }
    let propagated = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      const so = await other.snap();
      if (so.grid !== gridOtherBefore) { propagated = true; break; }
      await sleep(200);
    }
    ck('deadlock probe: move propagates to opponent', propagated);
    if (propagated) {
      console.log('  [ok] probe move propagated to the other client — no full deadlock (desync, if any, was caught by the invariant checks)');
    } else {
      const so = await other.snap();
      console.log('  ✗ DEADLOCK: the move never reached the other client — the log-end glitch');
      console.log('    ' + moverName + ' grid : ' + (await mover.snap()).grid);
      console.log('    other grid: ' + so.grid);
      console.log('    ' + moverName + ' turn=' + (await mover.snap()).turn + '  other turn=' + so.turn);
    }
  }
  await deadlockProbe();

  // ── Results ────────────────────────────────────────────────────────────────
  const failed = CHECKS.filter((c) => !c.ok);
  console.log('\n=== RESULTS (' + (CHECKS.length - failed.length) + '/' + CHECKS.length + ') ===');
  CHECKS.forEach((c) => {
    console.log('  ' + (c.ok ? 'PASS' : 'FAIL') + '  ' + c.name);
    (c.problems || []).forEach((p) => console.log('        ' + p));
  });

  const ok = failed.length === 0;
  console.log('\n========================================');
  if (ok) {
    console.log('LATENCY TEST PASSED — no desync detected at ' + LAT_MS + ' ms one-way latency.');
  } else {
    console.log('LATENCY TEST FAILED — desync/glitch detected at ' + LAT_MS + ' ms one-way latency.');
    console.log('First break: ' + (desyncedAt || 'deadlock probe'));
  }

  // Cleanup.
  for (const x of [A, B]) {
    try { x.ws.close(); } catch (e) {}
    try { x.chrome.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(x.prof, { recursive: true, force: true }); } catch (e) {}
  }
  try { srv.kill('SIGKILL'); } catch (e) {}
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('[lat] fatal: ' + (e && e.stack || e));
  process.exit(2);
});
