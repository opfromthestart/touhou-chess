/* Prove the resolver picks the TRUE first-death regardless of event order.
 *
 * Connects host (white=attacker) + guest (black=defender), starts a capture
 * race, then injects BOTH results synchronously (before any rAF frame fires)
 * in the "bad" order: the side that died LATER in game-clock time is injected
 * FIRST.
 *
 *   attacker loses at game-time 10  (injected first)
 *   defender loses at game-time 9   (injected second)  <-- actually died FIRST
 *
 * Correct outcome: defender ran out of lives first -> 'success' (capture goes
 * through). The OLD arrival-order logic would resolve 'fail' (it saw the
 * attacker's 'lose' first). We assert 'success' AND that both clients agree.
 *
 * Run: node mp_resolve_order_test.js
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
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-order-'));
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
    const g = (st.board && st.board.grid) ? st.board.grid : null;
    return JSON.stringify({ connected: st.connected, inRace: st.inRace, myColor: st.myColor,
      turn: st.board ? st.board.turn : null,
      resolved: r ? r.resolved : null, results: r ? r.results : null,
      e4cell: (g && g[4] && g[4][4]) ? (g[4][4].color[0]+g[4][4].type) : 'EMPTY',
      d5cell: (g && g[3] && g[3][3]) ? (g[3][3].color[0]+g[3][3].type) : 'EMPTY' });
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
  await sleep(300);

  // Inject BOTH results synchronously in the BAD order (later-death first).
  // Done in a SINGLE eval per client so both are recorded before any rAF frame.
  const injectExpr = `(() => {
    window.__MP.debugInject('attacker','lose',10); // injected FIRST, died LATER
    window.__MP.debugInject('defender','lose',9);  // injected SECOND, died FIRST
    return true;
  })()`;
  console.log('\n>>> Injecting attacker@t=10 (first) then defender@t=9 (second) on BOTH clients');
  await A.evalJs(injectExpr);
  await B.evalJs(injectExpr);
  await waitFor(async () => { const sa = await A.snap(); const sb = await B.snap(); return sa.resolved && sb.resolved; }, 8000, 'resolution');
  await sleep(300);
  const ha = await A.snap(); const hb = await B.snap();
  console.log('\n=== AFTER RESOLUTION ===');
  console.log('host :', JSON.stringify(ha));
  console.log('guest:', JSON.stringify(hb));

  // exd5 = white pawn from e4 captures black pawn on d5.
  //   success (defender lost): white pawn lands on d5 -> d5=Wp, e4=EMPTY
  //   fail    (attacker lost): white pawn removed from e4 -> d5=Bp, e4=EMPTY
  // Cell strings are color[0]+type (e.g. 'wp' = white pawn), so compare case-insensitively.
  const outcomeOf = (s) => (s.d5cell.toLowerCase() === 'wp' ? 'success (capture went through)' : s.d5cell.toLowerCase() === 'bp' ? 'fail (capturing piece removed)' : '? e4=' + s.e4cell + ' d5=' + s.d5cell);
  const hostOutcome = outcomeOf(ha);
  const guestOutcome = outcomeOf(hb);
  console.log('\n--- OUTCOME ---');
  console.log('Host : e4=' + ha.e4cell + ', d5=' + ha.d5cell + '  -> ' + hostOutcome);
  console.log('Guest: e4=' + hb.e4cell + ', d5=' + hb.d5cell + '  -> ' + guestOutcome);
  const expected = 'success'; // defender (t=9) died first -> capture succeeds
  const hostOk = /success/.test(hostOutcome);
  const guestOk = /success/.test(guestOutcome);
  const agree = ha.e4cell === hb.e4cell && ha.d5cell === hb.d5cell && ha.turn === hb.turn;
  console.log('\nExpected outcome: ' + expected + ' (defender ran out of lives first)');
  console.log('Host correct?  ' + (hostOk ? 'YES' : 'NO  <-- WRONG (would be the old arrival-order bug)'));
  console.log('Guest correct? ' + (guestOk ? 'YES' : 'NO'));
  console.log('Clients agree? ' + (agree ? 'YES' : 'NO  <-- DESYNC'));

  const pass = hostOk && guestOk && agree;
  console.log('\n========================================');
  console.log(pass ? 'RESOLVE-ORDER TEST PASSED — resolver picks true first-death, order-independent, no desync.' : 'RESOLVE-ORDER TEST FAILED');

  for (const x of [A, B]) { try { x.ws.close(); } catch (e) {} try { x.chrome.kill('SIGKILL'); } catch (e) {} try { fs.rmSync(x.prof, { recursive: true, force: true }); } catch (e) {} }
  try { srv.kill('SIGKILL'); } catch (e) {}
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('fatal: ' + (e && e.stack || e)); process.exit(2); });
