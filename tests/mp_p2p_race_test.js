/* End-to-end two-peer DANMAKU-RACE integration test.
 *
 * Builds on mp_p2p_test.js: connects a host (White) + guest (Black) over the
 * PeerJS cloud broker, then drives a real capturing move through the UI and
 * verifies the danmaku race starts on BOTH clients with the correct boss +
 * difficulty mapping (catcher = NORMAL, defender = LUNATIC).
 *
 * Move script (standard start): White e2-e4, Black d7-d5, then White exd5
 * (pawn capture) -> triggers the race.
 *
 * Run: node mp_p2p_race_test.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8127;
const URL = `http://127.0.0.1:${PORT}/index.html`;
const DBG_A = 9311; // host (white)
const DBG_B = 9312; // guest (black)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) {}
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for ' + what);
    await sleep(200);
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
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-race-'));
  const chrome = spawn('chromium', ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
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
  // Click a board square by (row, col). row 0 = rank 8 (top).
  const clickSq = (row, col) => evalJs(`(() => {
    const s = document.querySelector('#board .square[data-row="${row}"][data-col="${col}"]');
    if (!s) return false; s.click(); return true;
  })()`);
  const state = () => evalJs(`JSON.stringify(window.__MP.state)`).then((s) => JSON.parse(s));
  const txt = (id) => evalJs(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const overlayVisible = () => evalJs(`!document.getElementById('mp-fights-overlay').classList.contains('hidden')`);
  return { chrome, prof, ws, send, evalJs, clickSq, state, txt, overlayVisible };
}

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await waitFor(async () => (await fetch(URL, { method: 'HEAD' })).ok, 8000, 'server');
  console.log('[race] server up');

  const A = await launchChrome(DBG_A); // host (white)
  const B = await launchChrome(DBG_B); // guest (black)
  console.log('[race] two browsers up');

  await A.send('Page.navigate', { url: URL });
  await B.send('Page.navigate', { url: URL });
  await sleep(2500);

  // --- Connect (host white, guest black). ---
  await A.evalJs(`document.getElementById('btn-multiplayer').click(); true`);
  await A.evalJs(`document.getElementById('mp-host-btn').click(); true`);
  const code = await waitFor(async () => {
    const v = await A.txt('mp-code-value');
    return v && v.length >= 4 ? v : null;
  }, 20000, 'room code');
  console.log('[race] room code = ' + code);
  await B.evalJs(`document.getElementById('btn-multiplayer').click(); true`);
  await B.evalJs(`(() => { document.getElementById('mp-code-input').value = ${JSON.stringify(code)}; return true; })()`);
  await B.evalJs(`document.getElementById('mp-join-btn').click(); true`);
  await waitFor(async () => {
    const sa = await A.state(); const sb = await B.state();
    return sa.connected && sb.connected && sa.board && sb.board;
  }, 35000, 'both connected + board');
  console.log('[race] connected: host=' + (await A.state()).myColor + ', guest=' + (await B.state()).myColor);

  // --- Move 1: White e2 (6,4) -> e4 (4,4). Non-capture, synced. ---
  await A.clickSq(6, 4); await sleep(150); await A.clickSq(4, 4);
  await waitFor(async () => ((await B.state()).board && (await B.state()).board.turn === 'black'), 10000, 'white e4 to propagate (turn->black)');
  console.log('[race] White played e4');

  // --- Move 2: Black d7 (1,3) -> d5 (3,3). Non-capture, synced. ---
  await B.clickSq(1, 3); await sleep(150); await B.clickSq(3, 3);
  await waitFor(async () => ((await A.state()).board && (await A.state()).board.turn === 'white'), 10000, 'black d5 to propagate (turn->white)');
  console.log('[race] Black played d5');

  // --- Move 3: White e4 (4,4) captures d5 (3,3). Triggers the race. ---
  await A.clickSq(4, 4); await sleep(150); await A.clickSq(3, 3);
  await waitFor(async () => {
    const sa = await A.state(); const sb = await B.state();
    return sa.inRace && sb.inRace;
  }, 10000, 'race to start on both sides');
  // The fight window opens immediately on capture (with the pre-fight
  // countdown); wait for it to appear on both sides instead of a fixed sleep.
  await waitFor(async () => (await A.overlayVisible()) && (await B.overlayVisible()), 5000, 'race overlays visible');

  // --- Collect diagnostics. ---
  const diag = {
    host: { inRace: (await A.state()).inRace, overlay: await A.overlayVisible(),
      ownDiff: await A.txt('mp-panel-own-diff'), ownBoss: await A.txt('mp-panel-own-boss-name'),
      oppDiff: await A.txt('mp-panel-opp-diff'), ownShip: await A.txt('mp-panel-own-ship') },
    guest: { inRace: (await B.state()).inRace, overlay: await B.overlayVisible(),
      ownDiff: await B.txt('mp-panel-own-diff'), ownBoss: await B.txt('mp-panel-own-boss-name'),
      oppDiff: await B.txt('mp-panel-opp-diff'), ownShip: await B.txt('mp-panel-own-ship') },
  };
  console.log('\n=== RACE DIAGNOSTICS ===');
  console.log(JSON.stringify(diag, null, 2));

  const checks = [];
  const ck = (name, cond) => checks.push({ name, ok: !!cond });
  ck('host entered the race', diag.host.inRace === true);
  ck('guest entered the race', diag.guest.inRace === true);
  ck('host overlay visible', diag.host.overlay === true);
  ck('guest overlay visible', diag.guest.overlay === true);
  ck('host (catcher) own fight is NORMAL', /NORMAL/.test(diag.host.ownDiff));
  ck('guest (defender) own fight is LUNATIC', /LUNATIC/.test(diag.guest.ownDiff));
  ck('host sees opponent at LUNATIC', /LUNATIC/.test(diag.host.oppDiff));
  ck('guest sees opponent at NORMAL', /NORMAL/.test(diag.guest.oppDiff));
  ck('host boss is Rumia', /Rumia/i.test(diag.host.ownBoss));
  ck('guest boss is Rumia', /Rumia/i.test(diag.guest.ownBoss));

  const failed = checks.filter((c) => !c.ok);
  console.log('\n=== RESULTS (' + (checks.length - failed.length) + '/' + checks.length + ') ===');
  checks.forEach((c) => console.log('  ' + (c.ok ? 'PASS' : 'FAIL') + '  ' + c.name));

  const ok = failed.length === 0;
  console.log('\n========================================');
  console.log(ok ? 'RACE P2P TEST PASSED — capture propagated, race started on both sides with correct mapping.' : 'RACE P2P TEST FAILED');

  for (const x of [A, B]) { try { x.ws.close(); } catch (e) {} try { x.chrome.kill('SIGKILL'); } catch (e) {} try { fs.rmSync(x.prof, { recursive: true, force: true }); } catch (e) {} }
  try { srv.kill('SIGKILL'); } catch (e) {}
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('[race] fatal: ' + (e && e.stack || e));
  process.exit(2);
});
