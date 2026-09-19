/* Reproduce the danmaku-race DESYNC seen in desynclog/*.json.
 *
 * The real-world failure (see the two exported game logs): during a capture
 * race, each client runs a *spectator copy* of the opponent's fight, driven by
 * the opponent's relayed input (33 ms ticks + network latency/jitter). Because
 * the relayed input is delayed, a spectator ship can die EARLIER than the real
 * ship on its owner's screen (missed dodges) — or linger longer (frozen input
 * after the owner's engine ended). So the two clients can observe DIFFERENT
 * first-deaths.
 *
 * The bug: `doResolveCheck` resolves the race as soon as ONE side's result is
 * recorded as 'lose' and the OTHER side's *local* engine is still running
 * (the "premature" paths). A side's result can come from the spectator copy
 * (NOT authoritative) — so when BOTH clients' spectator copies die while their
 * own engines are still alive, EACH client concludes "the opponent's ship died
 * first" and resolves in its OWN favor:
 *
 *   • Attacker's screen:  defender's spectator ship died  -> 'success' (I win)
 *   • Defender's screen:  attacker's spectator ship died  -> 'fail'    (I win)
 *
 * Both players think they won the race; each board keeps its own piece and
 * removes the other's -> the two boards desync and the game continues on two
 * different positions.
 *
 * This test reproduces it deterministically:
 *   1. Host (white=attacker) + guest (black=defender) start a capture race.
 *   2. Both clients' SPECTATOR copies are forced to die (forceHitDeath('opp'))
 *      while their OWN engines are still running — exactly the log scenario.
 *   3. Both clients' OWN engines are then forced to die (forceHitDeath('own'))
 *      so the authoritative fight-result messages are in flight.
 *   4. We assert the two clients AGREE on the resolved outcome (same board).
 *
 * Correct behavior: a client must only resolve from AUTHORITATIVE data — its
 * own engine's end (local) and the opponent's 'fight-result' message (the
 * opponent's own engine's end). The spectator observation must never decide the
 * race on its own. With that fix, both clients compare the same two
 * authoritative end-times and always agree.
 *
 * Run: node mp_danmaku_desync_test.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = 8131;
const URL = `http://127.0.0.1:${PORT}/index.html`;
const DBG_A = 9351; // host (white, attacker)
const DBG_B = 9352; // guest (black, defender)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) { try { const v = await fn(); if (v) return v; } catch (e) {} if (Date.now() - t0 > timeoutMs) throw new Error('timeout: ' + what); await sleep(150); }
}
function cdp(ws) {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  return (method, params) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
}
async function launchChrome(dbgPort) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ddsync-'));
  const chrome = spawn('chromium', ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--user-data-dir=${prof}`,`--remote-debugging-port=${dbgPort}`,'about:blank'], { stdio: 'ignore' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${dbgPort}/json/version`)).ok, 15000, 'devtools');
  const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
  const target = list.find((t) => t.type === 'page') || list[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = cdp(ws);
  await send('Page.enable'); await send('Runtime.enable');
  const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const clickSq = (row, col) => evalJs(`(() => { const s = document.querySelector('#board .square[data-row="${row}"][data-col="${col}"]'); if (!s) return false; s.click(); return true; })()`);
  // Snapshot the race state + the contested cell (d5 = row 3, col 3).
  const snap = () => evalJs(`(() => {
    const st = window.__MP.state; const r = window.__MP.race;
    const g = (st.board && st.board.grid) ? st.board.grid : null;
    return JSON.stringify({
      connected: st.connected, inRace: st.inRace, myColor: st.myColor,
      turn: st.board ? st.board.turn : null,
      resolved: r ? r.resolved : null,
      outcome: r && r.resolved ? r.outcome : null,
      path: r && r.resolved ? r.path : null,
      results: r ? r.results : null,
      d5cell: (g && g[3] && g[3][3]) ? (g[3][3].color[0] + g[3][3].type) : 'EMPTY',
      ownRunning: !!(window.__MP.engines && window.__MP.engines.own && window.__MP.engines.own.running),
      oppRunning: !!(window.__MP.engines && window.__MP.engines.opp && window.__MP.engines.opp.running),
    });
  })()`).then((s) => JSON.parse(s));
  return { chrome, prof, ws, send, evalJs, clickSq, snap };
}
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await waitFor(async () => (await fetch(URL, { method: 'HEAD' })).ok, 8000, 'server');
  const A = await launchChrome(DBG_A); // host = white = attacker
  const B = await launchChrome(DBG_B); // guest = black = defender
  await A.send('Page.navigate', { url: URL });
  await B.send('Page.navigate', { url: URL });
  await sleep(2500);
  await A.evalJs(`document.getElementById('btn-multiplayer').click(); true`);
  await A.evalJs(`document.getElementById('mp-host-btn').click(); true`);
  const code = await waitFor(async () => { const v = await A.evalJs(`document.getElementById('mp-code-value').textContent`); return v && v.length >= 4 ? v : null; }, 20000, 'code');
  console.log('code=' + code);
  await B.evalJs(`document.getElementById('btn-multiplayer').click(); true`);
  await B.evalJs(`(() => { document.getElementById('mp-code-input').value = ${JSON.stringify(code)}; return true; })()`);
  await B.evalJs(`document.getElementById('mp-join-btn').click(); true`);
  const t0 = Date.now(); let conn = false;
  while (!conn && Date.now() - t0 < 35000) { const sa = await A.snap(); const sb = await B.snap(); if (sa.connected && sb.connected && sa.turn && sb.turn) conn = true; await sleep(300); }
  if (!conn) { console.log('CONNECT FAILED'); process.exit(3); }
  console.log('connected');

  // Start the race: e4 / d5 / exd5  ->  white (host) attacks black (guest).
  await A.clickSq(6, 4); await sleep(120); await A.clickSq(4, 4);
  await waitFor(async () => (await B.snap()).turn === 'black', 8000, 'e4');
  await B.clickSq(1, 3); await sleep(120); await B.clickSq(3, 3);
  await waitFor(async () => (await A.snap()).turn === 'white', 8000, 'd5');
  await A.clickSq(4, 4); await sleep(120); await A.clickSq(3, 3);
  await waitFor(async () => { const sa = await A.snap(); const sb = await B.snap(); return sa.inRace && sb.inRace; }, 8000, 'race start');

  // Wait out the danmaku-start countdown so both engines (own + spectator) are
  // live on both clients before we force any deaths.
  await waitFor(async () => {
    const ea = await A.evalJs(`!!(window.__MP.engines && window.__MP.engines.own && window.__MP.engines.opp && window.__MP.engines.own.running && window.__MP.engines.opp.running)`);
    const eb = await B.evalJs(`!!(window.__MP.engines && window.__MP.engines.own && window.__MP.engines.opp && window.__MP.engines.own.running && window.__MP.engines.opp.running)`);
    return ea && eb;
  }, 10000, 'race engines live');
  await sleep(300);
  console.log('engines live on both clients');

  // >>> THE DESYNC TRIGGER (matches the logs): each client's SPECTATOR copy of
  // the opponent's fight dies while that client's OWN engine is still running.
  // We do this on BOTH clients before either own engine dies, so neither
  // client has the other's authoritative 'fight-result' message yet.
  console.log('\n>>> Forcing BOTH spectator copies to die (own engines still alive)');
  await A.evalJs(`window.__MP.forceHitDeath('opp'); true`);
  await B.evalJs(`window.__MP.forceHitDeath('opp'); true`);
  // Now force the own engines to die too, so the authoritative fight-result
  // messages are sent (the fixed resolver must wait for these).
  await A.evalJs(`window.__MP.forceHitDeath('own'); true`);
  await B.evalJs(`window.__MP.forceHitDeath('own'); true`);

  // Wait for both clients to resolve the race.
  await waitFor(async () => {
    const sa = await A.snap(); const sb = await B.snap();
    return sa.resolved && sb.resolved;
  }, 10000, 'race resolved on both clients');
  await sleep(300); // let the board render

  const ha = await A.snap(); const hb = await B.snap();
  console.log('\n=== AFTER SPECTATOR-DEATH DESYNC ===');
  console.log('host (white/attacker) :', JSON.stringify(ha));
  console.log('guest (black/defender):', JSON.stringify(hb));

  console.log('\n--- AGREEMENT CHECK ---');
  const cellOutcome = (c) => c === 'EMPTY' ? 'fail (capture failed)' : (c.toLowerCase() === 'wp' ? 'success (capture went through)' : (c.toLowerCase() === 'bp' ? 'fail (defender kept piece)' : '?'));
  console.log('Host  d5 cell: ' + ha.d5cell + '  -> ' + cellOutcome(ha.d5cell) + '  (outcome=' + ha.outcome + ' path=' + ha.path + ')');
  console.log('Guest d5 cell: ' + hb.d5cell + '  -> ' + cellOutcome(hb.d5cell) + '  (outcome=' + hb.outcome + ' path=' + hb.path + ')');
  const agree = ha.d5cell === hb.d5cell && ha.outcome === hb.outcome && ha.turn === hb.turn;
  console.log('\nDO THE TWO CLIENTS AGREE? ' + (agree ? 'YES' : 'NO  <-- DESYNC BUG REPRODUCED'));
  console.log('host outcome=' + ha.outcome + ', guest outcome=' + hb.outcome + '; host turn=' + ha.turn + ', guest turn=' + hb.turn);

  const pass = agree;
  for (const x of [A, B]) { try { x.ws.close(); } catch (e) {} try { x.chrome.kill('SIGKILL'); } catch (e) {} try { fs.rmSync(x.prof, { recursive: true, force: true }); } catch (e) {} }
  try { srv.kill('SIGKILL'); } catch (e) {}
  console.log(pass ? '\nRESULT: PASS (clients agree)' : '\nRESULT: FAIL (clients desynced)');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('fatal: ' + (e && e.stack || e)); process.exit(2); });
