/* Scratch check (tmp-*): serve the repo root, load a page in headless
 * Chromium, evaluate an expression, print its value + any page errors.
 *
 * Usage: node tmp-cdp-page-check.js <urlPath> <expression> [settleMs]
 * Example: node tmp-cdp-page-check.js /tests/test-practice.html \
 *   "document.getElementById('test-result').textContent" 8000
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..'); // serve the repo root (this script lives in tests/)
const PORT = 8127;
const DBG_PORT = 9226;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) {}
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout: ' + what);
    await sleep(120);
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

(async () => {
  const urlPath = process.argv[2];
  const expr = process.argv[3];
  const settle = parseInt(process.argv[4] || '3000', 10);
  if (!urlPath || !expr) { console.error('usage: node tmp-cdp-page-check.js <urlPath> <expression> [settleMs]'); process.exit(2); }
  const url = `http://127.0.0.1:${PORT}${urlPath}`;

  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await waitFor(async () => (await fetch(url, { method: 'HEAD' })).ok, 8000, 'server');

  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cdp-'));
  const chrome = spawn('chromium', ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--user-data-dir=${prof}`,`--remote-debugging-port=${DBG_PORT}`,'about:blank'], { stdio: 'ignore' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${DBG_PORT}/json/version`)).ok, 15000, 'devtools');
  const list = await (await fetch(`http://127.0.0.1:${DBG_PORT}/json/list`)).json();
  const target = list.find((t) => t.type === 'page') || list[0];

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = cdp(ws);
  const pageErrors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(JSON.stringify(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      pageErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '));
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');

  const loaded = new Promise((res) => {
    const h = (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Page.loadEventFired') { ws.removeEventListener('message', h); res(); } };
    ws.addEventListener('message', h);
  });
  await send('Page.navigate', { url });
  await Promise.race([loaded, sleep(12000)]);
  await sleep(settle);

  const out = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (out.exceptionDetails) {
    console.error('EVAL EXCEPTION: ' + JSON.stringify(out.exceptionDetails));
  } else {
    console.log(out.result.value !== undefined ? String(out.result.value) : '(undefined)');
  }
  console.log('PAGE_ERRORS:' + (pageErrors.length ? ' ' + pageErrors.join(' | ') : ' none'));

  try { ws.close(); } catch (e) {}
  try { chrome.kill('SIGKILL'); } catch (e) {}
  try { srv.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.error('[check] fatal: ' + (e && e.stack || e)); process.exit(2); });
