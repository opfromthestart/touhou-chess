/* Headless-Chromium smoke test for the multiplayer UI.
 *
 * Spawns its own static server + Chromium (remote debugging), drives the page
 * over CDP, collects real console/exception events, and verifies the key
 * globals + DOM elements exist. Exits 0 only if the page loads clean.
 *
 * Run: node mp_smoke.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = 8124;
const DBG_PORT = 9223;
const URL = `http://127.0.0.1:${PORT}/index.html`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) {}
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for ' + what);
    await sleep(150);
  }
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  return (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
}

(async () => {
  // --- 1. Static server ---
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: ROOT, stdio: 'ignore',
  });
  await waitFor(async () => {
    const r = await fetch(URL, { method: 'HEAD' });
    return r.ok;
  }, 8000, 'http server');
  console.log('[smoke] server up at ' + URL);

  // --- 2. Chromium ---
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-chrome-'));
  const chrome = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--user-data-dir=${prof}`, `--remote-debugging-port=${DBG_PORT}`, 'about:blank',
  ], { stdio: 'ignore' });
  await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${DBG_PORT}/json/version`);
    return r.ok;
  }, 15000, 'chromium devtools');
  const list = await (await fetch(`http://127.0.0.1:${DBG_PORT}/json/list`)).json();
  const target = list.find((t) => t.type === 'page') || list[0];
  console.log('[smoke] chromium up, target ' + target.url);

  // --- 3. CDP session ---
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');

  const exceptions = [];
  const consoleErrors = [];
  const consoleWarnings = [];
  const failedRequests = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      const txt = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      exceptions.push(String(txt));
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const args = (m.params.args || []).map((a) => a.value !== undefined ? a.value : (a.description || a.unserializableValue || '')).join(' ');
      if (m.params.type === 'error') consoleErrors.push(args);
      else if (m.params.type === 'warning') consoleWarnings.push(args);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error') consoleErrors.push(e.url ? (e.text + ' [' + e.url + ']') : e.text);
    } else if (m.method === 'Network.loadingFailed') {
      failedRequests.push(m.params.requestId + ' ' + (m.params.errorText || ''));
    }
  });
  // Track request URLs so we can name the resource behind a loading failure.
  const reqUrls = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.requestWillBeSent') reqUrls.set(m.params.requestId, m.params.request.url);
  });

  // --- 4. Navigate & settle ---
  await send('Page.navigate', { url: URL });
  await waitFor(() => new Promise((res) => {
    const h = (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Page.loadEventFired') { ws.removeEventListener('message', h); res(true); } };
    ws.addEventListener('message', h);
    setTimeout(() => res(false), 10000);
  }), 12000, 'load event');
  await sleep(1500); // let main.js AI game + any async init run

  // --- 5. Diagnostics ---
  // Bare top-level class/const/let live in the global lexical scope (NOT on
  // window), so probe them with indirect eval rather than window[name].
  const diagExpr = `(() => {
    const g = (n) => { try { return String(typeof (0, eval)(n)); } catch (e) { return 'undeclared'; } };
    const has = (id) => !!document.getElementById(id);
    return JSON.stringify({
      globals: {
        Peer: g('Peer'), TCNet: g('TCNet'), MP: g('__MP'),
        DanmakuEngine: g('DanmakuEngine'), BoardUI: g('BoardUI'), CONFIG: g('CONFIG'),
        BOSSES: g('BOSSES'), getPhases: g('getPhases'),
      },
      els: {
        connectModal: has('mp-connect-modal'), fightOverlay: has('mp-fights-overlay'),
        resultModal: has('mp-result-modal'), canvasOwn: has('mp-canvas-own'),
        canvasOpp: has('mp-canvas-opp'), btnMp: has('btn-multiplayer'),
        codeValue: has('mp-code-value'), codeInput: has('mp-code-input'),
        hostBtn: has('mp-host-btn'), joinBtn: has('mp-join-btn'),
        leaveBtn: has('mp-leave-btn'), nameInput: has('mp-name-input'),
        chatPanel: has('chat-panel'), chatLog: has('chat-log'),
        chatInput: has('chat-input'), chatSendBtn: has('chat-send-btn'),
        pcardYouName: has('pcard-you-name'), pcardBossName: has('pcard-boss-name'),
      },
      mpState: (window.__MP && window.__MP.state) || null,
    });
  })()`;
  const diagRes = await send('Runtime.evaluate', { expression: diagExpr, returnByValue: true });
  const diag = JSON.parse(diagRes.result.value);

  // --- 6. Report ---
  console.log('\n=== GLOBALS ===');
  console.log(JSON.stringify(diag.globals, null, 2));
  console.log('\n=== ELEMENTS ===');
  console.log(JSON.stringify(diag.els, null, 2));
  console.log('\n=== MP STATE ===');
  console.log(JSON.stringify(diag.mpState, null, 2));
  console.log('\n=== EXCEPTIONS (' + exceptions.length + ') ===');
  exceptions.forEach((e) => console.log('  ✗ ' + e));
  console.log('\n=== CONSOLE ERRORS (' + consoleErrors.length + ') ===');
  consoleErrors.forEach((e) => console.log('  ✗ ' + e));
  console.log('\n=== CONSOLE WARNINGS (' + consoleWarnings.length + ') ===');
  consoleWarnings.slice(0, 10).forEach((e) => console.log('  ! ' + e));

  // Name the resources behind any network loading failures.
  const failedNamed = failedRequests.map((r) => {
    const id = r.split(' ')[0];
    return (reqUrls.get(id) || '?') + '  (' + r + ')';
  });
  console.log('\n=== NETWORK FAILURES (' + failedNamed.length + ') ===');
  failedNamed.forEach((e) => console.log('  ✗ ' + e));

  const missingGlobs = Object.entries(diag.globals).filter(([, v]) => v === 'undefined' || v === 'undeclared').map(([k]) => k);
  const missingEls = Object.entries(diag.els).filter(([, v]) => !v).map(([k]) => k);
  // A favicon.ico 404 is expected (no favicon declared) — ignore it everywhere.
  const realFailures = failedNamed.filter((e) => !/favicon\.ico/i.test(e));
  const realConsoleErrors = consoleErrors.filter((e) => !/favicon\.ico|404 \(File not found\)/i.test(e));
  const ok = exceptions.length === 0 && missingGlobs.length === 0 && missingEls.length === 0
    && realFailures.length === 0 && realConsoleErrors.length === 0;
  console.log('\n========================================');
  if (ok) {
    console.log('SMOKE TEST PASSED — page loads clean, all globals + elements present.');
  } else {
    console.log('SMOKE TEST FAILED');
    if (missingGlobs.length) console.log('  missing globals: ' + missingGlobs.join(', '));
    if (missingEls.length) console.log('  missing elements: ' + missingEls.join(', '));
    if (exceptions.length) console.log('  ' + exceptions.length + ' exception(s)');
    if (realFailures.length) console.log('  ' + realFailures.length + ' real network failure(s)');
    if (realConsoleErrors.length) console.log('  ' + realConsoleErrors.length + ' real console error(s)');
  }

  // --- 7. Cleanup ---
  try { ws.close(); } catch (e) {}
  try { chrome.kill('SIGKILL'); } catch (e) {}
  try { srv.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('[smoke] fatal: ' + (e && e.stack || e));
  process.exit(2);
});
