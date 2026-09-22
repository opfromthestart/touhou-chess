/* Scratch (tmp-*): render a character sprite page in headless Chromium and
 * save a PNG via CDP Page.captureScreenshot.
 * Usage: node tmp-hina-screenshot.js <urlPath> <outPng> [settleMs]
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const PORT = 8131;
const DBG_PORT = 9231;
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
  const outPng = process.argv[3];
  const settle = parseInt(process.argv[4] || '1500', 10);
  if (!urlPath || !outPng) { console.error('usage: node tmp-hina-screenshot.js <urlPath> <outPng> [settleMs]'); process.exit(2); }
  const url = `http://127.0.0.1:${PORT}${urlPath}`;

  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await waitFor(async () => (await fetch(url, { method: 'HEAD' })).ok, 8000, 'server');

  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-shot-'));
  const chrome = spawn('chromium', ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--user-data-dir=${prof}`,`--remote-debugging-port=${DBG_PORT}`,'about:blank'], { stdio: 'ignore' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${DBG_PORT}/json/version`)).ok, 15000, 'devtools');
  const list = await (await fetch(`http://127.0.0.1:${DBG_PORT}/json/list`)).json();
  const target = list.find((t) => t.type === 'page') || list[0];

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');

  const loaded = new Promise((res) => {
    const h = (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Page.loadEventFired') { ws.removeEventListener('message', h); res(); } };
    ws.addEventListener('message', h);
  });
  await send('Page.navigate', { url });
  await Promise.race([loaded, sleep(12000)]);
  await sleep(settle);

  // Confirm the sprite rendered (no exception, __RENDERED__ true).
  const chk = await send('Runtime.evaluate', { expression: 'String(window.__RENDERED__ === true)', returnByValue: true });
  console.log('rendered: ' + (chk.result && chk.result.value));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
  console.log('saved: ' + outPng);

  try { ws.close(); } catch (e) {}
  try { chrome.kill('SIGKILL'); } catch (e) {}
  try { srv.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.error('[shot] fatal: ' + (e && e.stack || e)); process.exit(2); });
