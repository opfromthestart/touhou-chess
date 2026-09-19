/* Reproduce the near-simultaneous-death DESYNC.
 *
 * Connects host (white=attacker) + guest (black=defender), starts a capture
 * race, then forces BOTH players to die back-to-back (before either client has
 * received the other's fight-result message). We then check whether the two
 * clients AGREE on the resolved outcome.
 *
 * Correct behavior: both clients must agree on who died first (the true
 * first-death loses). Bug: each client resolves on its OWN locally-processed
 * death, so they can disagree (host says 'fail', guest says 'success').
 *
 * Run: node mp_desync_test.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = 8130;
const URL = `http://127.0.0.1:${PORT}/index.html`;
const DBG_A = 9341; // host (white, attacker)
const DBG_B = 9342; // guest (black, defender)
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
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-dsync-'));
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
  const snap = () => evalJs(`(() => {
    const st = window.__MP.state; const r = window.__MP.race;
    return JSON.stringify({ connected: st.connected, inRace: st.inRace, myColor: st.myColor,
      turn: st.board ? st.board.turn : null,
      resolved: r ? r.resolved : null, results: r ? r.results : null,
      e4cell: (st.board && st.board.grid && st.board.grid[4] && st.board.grid[4][4]) ? (st.board.grid[4][4].color[0]+st.board.grid[4][4].type) : 'EMPTY' });
  })()`).then((s) => JSON.parse(s));
  return { chrome, prof, ws, send, evalJs, clickSq, snap };
}
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await waitFor(async () => (await fetch(URL, { method: 'HEAD' })).ok, 8000, 'server');
  const A = await launchChrome(DBG_A);
  const B = await launchChrome(DBG_B);
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
  // Start the race: e4 / d5 / exd5
  await A.clickSq(6, 4); await sleep(120); await A.clickSq(4, 4);
  await waitFor(async () => (await B.snap()).turn === 'black', 8000, 'e4');
  await B.clickSq(1, 3); await sleep(120); await B.clickSq(3, 3);
  await waitFor(async () => (await A.snap()).turn === 'white', 8000, 'd5');
  await A.clickSq(4, 4); await sleep(120); await A.clickSq(3, 3);
  await waitFor(async () => { const sa = await A.snap(); const sb = await B.snap(); return sa.inRace && sb.inRace; }, 8000, 'race start');
  // Wait out the danmaku-start countdown so both race engines are live before
  // we force deaths (the countdown delays engine start after the capture;
  // DANMAKU_START_DELAY_MS is 3000).
  await waitFor(async () => {
    const ea = await A.evalJs(`!!(window.__MP.engines && window.__MP.engines.own && window.__MP.engines.opp)`);
    const eb = await B.evalJs(`!!(window.__MP.engines && window.__MP.engines.own && window.__MP.engines.opp)`);
    return ea && eb;
  }, 8000, 'race engines live');
  await sleep(400);
  console.log('\n>>> Forcing BOTH players to die back-to-back (near-simultaneous)');
  // Kill the attacker (host) and immediately the defender (guest), before messages propagate.
  await A.evalJs(`window.__MP.forceHitDeath('own'); true`);
  await B.evalJs(`window.__MP.forceHitDeath('own'); true`);
  await sleep(1500);
  const ha = await A.snap(); const hb = await B.snap();
  console.log('\n=== AFTER NEAR-SIMULTANEOUS DEATHS ===');
  console.log('host :', JSON.stringify(ha));
  console.log('guest:', JSON.stringify(hb));
  console.log('\n--- AGREEMENT CHECK ---');
  // Cell strings are color[0]+type (e.g. 'wp' = white pawn), so compare case-insensitively.
  const cellOutcome = (c) => c === 'EMPTY' ? 'fail (capture failed)' : (c.toLowerCase() === 'wp' ? 'success (capture went through)' : '?');
  const hostOutcome = cellOutcome(ha.e4cell);
  const guestOutcome = cellOutcome(hb.e4cell);
  console.log('Host board e4 cell : ' + ha.e4cell + '  -> ' + hostOutcome);
  console.log('Guest board e4 cell: ' + hb.e4cell + '  -> ' + guestOutcome);
  const agree = ha.e4cell === hb.e4cell && ha.turn === hb.turn;
  console.log('\nDO THE TWO CLIENTS AGREE? ' + (agree ? 'YES' : 'NO  <-- DESYNC BUG REPRODUCED'));
  console.log('host turn=' + ha.turn + ', guest turn=' + hb.turn);

  for (const x of [A, B]) { try { x.ws.close(); } catch (e) {} try { x.chrome.kill('SIGKILL'); } catch (e) {} try { fs.rmSync(x.prof, { recursive: true, force: true }); } catch (e) {} }
  try { srv.kill('SIGKILL'); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.error('fatal: ' + (e && e.stack || e)); process.exit(2); });
