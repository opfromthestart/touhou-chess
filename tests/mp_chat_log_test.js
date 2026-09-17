/* End-to-end two-peer test for PVP names, chat, and the fight/move log.
 *
 * Spawns ONE static server and TWO headless-Chromium instances (host + guest),
 * drives them over CDP: enter display names, connect, exchange chat messages,
 * and make a couple of pawn moves. Verifies:
 *   • each client shows its own + the opponent's chosen name (chips, cards,
 *     turn indicator);
 *   • chat messages arrive on both sides with the right sender;
 *   • the on-screen fight log (#move-log) records every move on BOTH clients.
 *
 * Relies on the public PeerJS cloud broker for signalling (same as
 * mp_p2p_test.js). Run: node mp_chat_log_test.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8128;
const URL = `http://127.0.0.1:${PORT}/index.html`;
const DBG_A = 9311; // host
const DBG_B = 9312; // guest
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

// Helpers run inside the page.
const PAGE = {
  logTexts: `Array.from(document.querySelectorAll('#move-log li')).map(li => li.textContent)`,
  chatTexts: `Array.from(document.querySelectorAll('#chat-log li')).map(li => li.textContent)`,
  chipYou: `document.getElementById('chip-you-name').textContent`,
  chipOpp: `document.getElementById('chip-opp-name').textContent`,
  pcardYou: `document.getElementById('pcard-you-name').textContent`,
  pcardOpp: `document.getElementById('pcard-boss-name').textContent`,
  turn: `document.getElementById('turn-indicator').textContent`,
  state: `JSON.stringify(window.__MP.state)`,
  // Click a board square (row, col) through the real BoardUI click handler.
  clickSq: (r, c) => `(() => { const el = document.querySelector('#board .square[data-row="${r}"][data-col="${c}"]'); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`,
  setChat: (text) => `(() => { document.getElementById('chat-input').value = ${JSON.stringify(text)}; return true; })()`,
  sendChat: `(() => { document.getElementById('chat-send-btn').click(); return true; })()`,
};

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await waitFor(async () => (await fetch(URL, { method: 'HEAD' })).ok, 8000, 'server');
  console.log('[chatlog] server up at ' + URL);

  const A = await launchChrome(DBG_A); // host (White)
  const B = await launchChrome(DBG_B); // guest (Black)
  await A.send('Page.navigate', { url: URL });
  await B.send('Page.navigate', { url: URL });
  await sleep(2500);

  // --- Host: name "Alice", host a room. ---
  await A.evalJs(`(() => { document.getElementById('mp-name-input').value = 'Alice'; return true; })()`);
  await A.evalJs(`document.getElementById('btn-multiplayer').click(); true`);
  await A.evalJs(`document.getElementById('mp-host-btn').click(); true`);
  const code = await waitFor(async () => {
    const v = await A.evalJs(`(() => { const el = document.getElementById('mp-code-value'); const t = el && el.textContent.trim(); return t && t.length >= 4 ? t : null; })()`);
    return v || null;
  }, 20000, 'room code (host)');
  console.log('[chatlog] host created room code = ' + code);

  // --- Guest: name "Bob", join. ---
  await B.evalJs(`(() => { document.getElementById('mp-name-input').value = 'Bob'; return true; })()`);
  await B.evalJs(`document.getElementById('btn-multiplayer').click(); true`);
  await B.evalJs(`(() => { document.getElementById('mp-code-input').value = ${JSON.stringify(code)}; return true; })()`);
  await B.evalJs(`document.getElementById('mp-join-btn').click(); true`);
  console.log('[chatlog] guest joining room ' + code + ' …');

  await waitFor(async () => {
    const sa = JSON.parse(await A.evalJs(PAGE.state));
    const sb = JSON.parse(await B.evalJs(PAGE.state));
    return sa.connected && sb.connected && sa.myColor && sb.myColor && sa.board && sb.board;
  }, 35000, 'both peers connected + game started');
  await sleep(500);

  const checks = [];
  const ck = (name, cond) => checks.push({ name, ok: !!cond });

  // --- Names on both clients. ---
  ck('host chip-you = Alice', (await A.evalJs(PAGE.chipYou)) === 'Alice');
  ck('host chip-opp = Bob', (await A.evalJs(PAGE.chipOpp)) === 'Bob');
  ck('guest chip-you = Bob', (await B.evalJs(PAGE.chipYou)) === 'Bob');
  ck('guest chip-opp = Alice', (await B.evalJs(PAGE.chipOpp)) === 'Alice');
  ck('host card-you = Alice', (await A.evalJs(PAGE.pcardYou)) === 'Alice');
  ck('host card-opp = Bob', (await A.evalJs(PAGE.pcardOpp)) === 'Bob');
  ck('guest card-you = Bob', (await B.evalJs(PAGE.pcardYou)) === 'Bob');
  ck('guest card-opp = Alice', (await B.evalJs(PAGE.pcardOpp)) === 'Alice');
  // White (Alice) moves first, so Bob's screen should say "Alice's move…".
  ck("guest turn indicator names Alice", /Alice’s move/.test(await B.evalJs(PAGE.turn)));

  // --- Chat: Alice -> Bob. ---
  await A.evalJs(PAGE.setChat('hello bob'));
  await A.evalJs(PAGE.sendChat);
  await waitFor(async () => ((await B.evalJs(PAGE.chatTexts)) || []).some((t) => /Alice:\s*hello bob/.test(t)), 10000, 'chat msg on guest');
  ck('guest received "Alice: hello bob"', (await B.evalJs(PAGE.chatTexts)).some((t) => /Alice:\s*hello bob/.test(t)));
  ck('host echoed its own message', (await A.evalJs(PAGE.chatTexts)).some((t) => /Alice:\s*hello bob/.test(t)));

  // --- Chat: Bob -> Alice. ---
  await B.evalJs(PAGE.setChat('hi alice'));
  await B.evalJs(PAGE.sendChat);
  await waitFor(async () => ((await A.evalJs(PAGE.chatTexts)) || []).some((t) => /Bob:\s*hi alice/.test(t)), 10000, 'chat reply on host');
  ck('host received "Bob: hi alice"', (await A.evalJs(PAGE.chatTexts)).some((t) => /Bob:\s*hi alice/.test(t)));

  // --- Move log: Alice (white) plays e2-e4, then Bob (black) d7-d5. ---
  await A.evalJs(PAGE.clickSq(6, 4)); // select e2 pawn
  await A.evalJs(PAGE.clickSq(4, 4)); // move to e4
  await waitFor(async () => ((await A.evalJs(PAGE.logTexts)) || []).length >= 1, 10000, 'host move logged');
  // Bob replies d7-d5.
  await B.evalJs(PAGE.clickSq(1, 3));
  await B.evalJs(PAGE.clickSq(3, 3));
  await waitFor(async () => ((await B.evalJs(PAGE.logTexts)) || []).length >= 2, 10000, 'guest sees both moves');
  await sleep(300);

  const aLog = await A.evalJs(PAGE.logTexts);
  const bLog = await B.evalJs(PAGE.logTexts);
  ck('host log has e2→e4 by Alice', aLog.some((t) => /e2→e4/.test(t) && /\(Alice\)/.test(t)));
  ck('host log has d7→d5 by Bob', aLog.some((t) => /d7→d5/.test(t) && /\(Bob\)/.test(t)));
  ck('guest log has e2→e4 by Alice', bLog.some((t) => /e2→e4/.test(t) && /\(Alice\)/.test(t)));
  ck('guest log has d7→d5 by Bob', bLog.some((t) => /d7→d5/.test(t) && /\(Bob\)/.test(t)));
  ck('both logs agree (2 lines each)', aLog.length === bLog.length && aLog.length === 2);

  console.log('\n=== MOVE LOG (host) ===');
  aLog.forEach((t) => console.log('  ' + t));
  console.log('=== CHAT (host) ===');
  (await A.evalJs(PAGE.chatTexts)).forEach((t) => console.log('  ' + t));

  const failed = checks.filter((c) => !c.ok);
  console.log('\n=== RESULTS (' + (checks.length - failed.length) + '/' + checks.length + ') ===');
  checks.forEach((c) => console.log('  ' + (c.ok ? 'PASS' : 'FAIL') + '  ' + c.name));

  const ok = failed.length === 0;
  console.log('\n========================================');
  console.log(ok ? 'CHAT+LOG TEST PASSED' : 'CHAT+LOG TEST FAILED');

  for (const x of [A, B]) { try { x.ws.close(); } catch (e) {} try { x.chrome.kill('SIGKILL'); } catch (e) {} try { fs.rmSync(x.prof, { recursive: true, force: true }); } catch (e) {} }
  try { srv.kill('SIGKILL'); } catch (e) {}
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('[chatlog] fatal: ' + (e && e.stack || e));
  process.exit(2);
});
