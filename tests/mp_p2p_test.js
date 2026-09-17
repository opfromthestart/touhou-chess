/* End-to-end two-peer integration test for the multiplayer mode.
 *
 * Spawns ONE static server and TWO headless-Chromium instances (host + guest),
 * drives them over CDP: host a room, read the code, join it from the second
 * browser, and verify the PeerJS data channel connects, the hello handshake
 * completes, and both sides assign the correct colours + board.
 *
 * Relies on the public PeerJS cloud broker for signalling; the two local
 * instances should still connect via loopback host candidates.
 *
 * Run: node mp_p2p_test.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8126;
const URL = `http://127.0.0.1:${PORT}/index.html`;
const DBG_A = 9301; // host
const DBG_B = 9302; // guest
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
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-p2p-'));
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
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  return { chrome, prof, ws, send, evalJs };
}

(async () => {
  // Server.
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await waitFor(async () => (await fetch(URL, { method: 'HEAD' })).ok, 8000, 'server');
  console.log('[p2p] server up at ' + URL);

  // Two browsers.
  const A = await launchChrome(DBG_A); // host
  const B = await launchChrome(DBG_B); // guest
  console.log('[p2p] two browsers up (host=' + DBG_A + ', guest=' + DBG_B + ')');

  await A.send('Page.navigate', { url: URL });
  await B.send('Page.navigate', { url: URL });
  await sleep(2500); // let all scripts load + init

  // --- Host: open connect modal, host a room, read the code. ---
  await A.evalJs(`document.getElementById('btn-multiplayer').click(); true`);
  await A.evalJs(`document.getElementById('mp-host-btn').click(); true`);
  const code = await waitFor(async () => {
    const v = await A.evalJs(`(() => { const el = document.getElementById('mp-code-value'); const t = el && el.textContent.trim(); return t && t.length >= 4 ? t : null; })()`);
    return v || null;
  }, 20000, 'room code (host)');
  console.log('[p2p] host created room code = ' + code);

  // --- Guest: open connect modal, enter code, join. ---
  await B.evalJs(`document.getElementById('btn-multiplayer').click(); true`);
  await B.evalJs(`(() => { document.getElementById('mp-code-input').value = ${JSON.stringify(code)}; return true; })()`);
  await B.evalJs(`document.getElementById('mp-join-btn').click(); true`);
  console.log('[p2p] guest joining room ' + code + ' …');

  // --- Wait for both to connect + assign colours + build the board. ---
  let Astate, Bstate;
  await waitFor(async () => {
    Astate = JSON.parse(await A.evalJs(`JSON.stringify(window.__MP.state)`));
    Bstate = JSON.parse(await B.evalJs(`JSON.stringify(window.__MP.state)`));
    return Astate.connected && Bstate.connected && Astate.myColor && Bstate.myColor && Astate.board && Bstate.board;
  }, 35000, 'both peers connected + game started');
  await sleep(500); // let any trailing handshake messages settle

  // --- Collect diagnostics. ---
  const diag = {
    host: { myColor: Astate.myColor, oppColor: Astate.oppColor, connected: Astate.connected, board: !!Astate.board, raceCount: Astate.raceCount },
    guest: { myColor: Bstate.myColor, oppColor: Bstate.oppColor, connected: Bstate.connected, board: !!Bstate.board, raceCount: Bstate.raceCount },
    netStatus: {
      host: await A.evalJs(`document.getElementById('mp-net-status').textContent`),
      guest: await B.evalJs(`document.getElementById('mp-net-status').textContent`),
    },
    chips: {
      hostYou: await A.evalJs(`document.getElementById('chip-you-sub').textContent`),
      guestYou: await B.evalJs(`document.getElementById('chip-you-sub').textContent`),
    },
  };
  console.log('\n=== P2P DIAGNOSTICS ===');
  console.log(JSON.stringify(diag, null, 2));

  // --- Assertions. ---
  const checks = [];
  const ck = (name, cond) => checks.push({ name, ok: !!cond });
  ck('host connected', diag.host.connected === true);
  ck('guest connected', diag.guest.connected === true);
  ck('host is White', diag.host.myColor === 'white');
  ck('guest is Black', diag.guest.myColor === 'black');
  ck('host opponent is Black', diag.host.oppColor === 'black');
  ck('guest opponent is White', diag.guest.oppColor === 'white');
  ck('host built a board', diag.host.board === true);
  ck('guest built a board', diag.guest.board === true);
  ck('host chip says White·Protagonists', /White/.test(diag.chips.hostYou));
  ck('guest chip says Black·Bosses', /Black/.test(diag.chips.guestYou));

  const failed = checks.filter((c) => !c.ok);
  console.log('\n=== RESULTS (' + checks.length - failed.length + '/' + checks.length + ') ===');
  checks.forEach((c) => console.log('  ' + (c.ok ? 'PASS' : 'FAIL') + '  ' + c.name));

  const ok = failed.length === 0;
  console.log('\n========================================');
  console.log(ok ? 'P2P TEST PASSED — two peers connected, handshake + colours correct.' : 'P2P TEST FAILED');

  // Cleanup.
  for (const x of [A, B]) { try { x.ws.close(); } catch (e) {} try { x.chrome.kill('SIGKILL'); } catch (e) {} try { fs.rmSync(x.prof, { recursive: true, force: true }); } catch (e) {} }
  try { srv.kill('SIGKILL'); } catch (e) {}
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('[p2p] fatal: ' + (e && e.stack || e));
  process.exit(2);
});
