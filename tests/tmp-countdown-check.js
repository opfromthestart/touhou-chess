/* Scratch check (tmp-*): verify the danmaku pre-fight countdown.
 *
 * Part 1 (single-player): drive window.__TC.fight.prepareFight() directly and
 *   verify the modal opens immediately with a visible 3-2-1 countdown while
 *   the engine is NOT running, then the engine starts and the countdown hides
 *   after DANMAKU_START_DELAY_MS.
 *
 * Part 2 (multiplayer): connect host+guest, play e4/d5/exd5, and verify on
 *   BOTH clients that the fight window opens immediately on capture with the
 *   countdown visible (engines not yet running), then the engines start and
 *   the countdown hides after the delay.
 *
 * Usage: node tmp-countdown-check.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..'); // serve the repo root (this script lives in tests/)
const PORT = 8140;
const URL = `http://127.0.0.1:${PORT}/index.html`;
const DBG_SP = 9371; // single-player page
const DBG_A = 9372;  // host (white)
const DBG_B = 9373;  // guest (black)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) {}
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for ' + what);
    await sleep(100);
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
async function launchChrome(dbgPort, tag) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cd-'));
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
    if (r.exceptionDetails) throw new Error('eval error (' + tag + '): ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  return { chrome, prof, ws, send, evalJs };
}

const results = [];
const ck = (name, cond) => { results.push({ name, ok: !!cond }); console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name); };

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await waitFor(async () => (await fetch(URL, { method: 'HEAD' })).ok, 8000, 'server');
  console.log('[cd] server up');

  // ================= Part 1: single-player =================
  console.log('\n=== Part 1: single-player countdown ===');
  const S = await launchChrome(DBG_SP, 'sp');
  await S.send('Page.navigate', { url: URL });
  await sleep(2500);

  const sp = () => S.evalJs(`(() => {
    const f = window.__TC.fight;
    return JSON.stringify({
      delay: CONFIG.DANMAKU_START_DELAY_MS,
      modalVisible: !f.modal.classList.contains('hidden'),
      cdVisible: !f.modal.querySelector('#fight-countdown').classList.contains('hidden'),
      cdNum: f.modal.querySelector('#fight-countdown-num').textContent,
      engineRunning: f.engine.running,
    });
  })()`).then((s) => JSON.parse(s));

  const d0 = await S.evalJs(`CONFIG.DANMAKU_START_DELAY_MS`);
  ck('DANMAKU_START_DELAY_MS is 3000', d0 === 3000);

  // Mirror main.js openFight(): prepare immediately, begin after the delay.
  await S.evalJs(`window.__TC.fight.prepareFight('rumia', 'normal', 'p', 'cirno', () => {});
    setTimeout(() => { if (window.__TC.fight._pending) window.__TC.fight.beginFight(); }, CONFIG.DANMAKU_START_DELAY_MS);
    true`);
  await sleep(120);
  let s1 = await sp();
  ck('modal opens immediately on prepareFight', s1.modalVisible === true);
  ck('countdown visible immediately', s1.cdVisible === true);
  ck('countdown shows 3 at start', s1.cdNum === '3');
  ck('engine NOT running during countdown', s1.engineRunning === false);

  await sleep(1100);
  let s2 = await sp();
  ck('countdown shows 2 after ~1.1s', s2.cdNum === '2');
  ck('engine still NOT running at ~1.2s', s2.engineRunning === false);

  await sleep(2100); // total ~3.3s
  let s3 = await sp();
  ck('engine running after countdown', s3.engineRunning === true);
  ck('countdown hidden after countdown', s3.cdVisible === false);

  await S.evalJs(`window.__TC.fight.cancelFight(); true`);
  await sleep(100);
  let s4 = await sp();
  ck('cancelFight hides modal + stops engine', s4.modalVisible === false && s4.engineRunning === false);

  // ================= Part 2: multiplayer =================
  console.log('\n=== Part 2: multiplayer countdown ===');
  const A = await launchChrome(DBG_A, 'host');
  const B = await launchChrome(DBG_B, 'guest');
  await A.send('Page.navigate', { url: URL });
  await B.send('Page.navigate', { url: URL });
  await sleep(2500);

  const mpState = (P) => P.evalJs(`JSON.stringify({
    inRace: window.__MP.state.inRace,
    overlayVisible: !document.getElementById('mp-fights-overlay').classList.contains('hidden'),
    cdVisible: !document.getElementById('mp-countdown').classList.contains('hidden'),
    cdNum: document.getElementById('mp-countdown-num').textContent,
    ownRunning: !!(window.__MP.engines.own && window.__MP.engines.own.running),
    oppRunning: !!(window.__MP.engines.opp && window.__MP.engines.opp.running),
  })`).then((s) => JSON.parse(s));
  const clickSq = (P, row, col) => P.evalJs(`(() => {
    const s = document.querySelector('#board .square[data-row="${row}"][data-col="${col}"]');
    if (!s) return false; s.click(); return true;
  })()`);

  // Connect.
  await A.evalJs(`document.getElementById('btn-multiplayer').click(); true`);
  await A.evalJs(`document.getElementById('mp-host-btn').click(); true`);
  const code = await waitFor(async () => {
    const v = await A.evalJs(`document.getElementById('mp-code-value').textContent`);
    return v && v.length >= 4 ? v : null;
  }, 20000, 'room code');
  console.log('[cd] room code = ' + code);
  await B.evalJs(`document.getElementById('btn-multiplayer').click(); true`);
  await B.evalJs(`(() => { document.getElementById('mp-code-input').value = ${JSON.stringify(code)}; return true; })()`);
  await B.evalJs(`document.getElementById('mp-join-btn').click(); true`);
  await waitFor(async () => {
    const sa = await A.evalJs(`!!(window.__MP.state.connected && window.__MP.state.board)`);
    const sb = await B.evalJs(`!!(window.__MP.state.connected && window.__MP.state.board)`);
    return sa && sb;
  }, 35000, 'both connected + board');
  console.log('[cd] connected');

  // e4 / d5 / exd5.
  await clickSq(A, 6, 4); await sleep(150); await clickSq(A, 4, 4);
  await waitFor(async () => (await A.evalJs(`window.__MP.state.board.turn`)) === 'black', 10000, 'e4 propagate');
  await clickSq(B, 1, 3); await sleep(150); await clickSq(B, 3, 3);
  await waitFor(async () => (await A.evalJs(`window.__MP.state.board.turn`)) === 'white', 10000, 'd5 propagate');
  await clickSq(A, 4, 4); await sleep(150); await clickSq(A, 3, 3);

  // Catch the moment the race starts on the host.
  await waitFor(async () => (await mpState(A)).inRace, 5000, 'race start (host)');
  const t0 = Date.now();
  const a1 = await mpState(A);
  const b1 = await mpState(B);
  console.log('[cd] host at race start: ' + JSON.stringify(a1));
  console.log('[cd] guest at race start: ' + JSON.stringify(b1));
  ck('host: window opens immediately on capture', a1.overlayVisible === true);
  ck('host: countdown visible at race start', a1.cdVisible === true);
  ck('host: countdown shows 3 (or 2 if detected late)', a1.cdNum === '3' || a1.cdNum === '2');
  ck('host: engines NOT running during countdown', a1.ownRunning === false && a1.oppRunning === false);
  ck('guest: window opens immediately on capture', b1.overlayVisible === true);
  ck('guest: countdown visible at race start', b1.cdVisible === true);
  ck('guest: engines NOT running during countdown', b1.ownRunning === false && b1.oppRunning === false);

  // Mid-countdown (~1.5s in): number should be 2, engines still off.
  await sleep(Math.max(0, 1500 - (Date.now() - t0)));
  const a2 = await mpState(A);
  const b2 = await mpState(B);
  ck('host: countdown shows 2 mid-way', a2.cdNum === '2');
  ck('host: engines still NOT running mid-countdown', a2.ownRunning === false && a2.oppRunning === false);
  ck('guest: engines still NOT running mid-countdown', b2.ownRunning === false && b2.oppRunning === false);

  // After the countdown: engines running, countdown hidden.
  await waitFor(async () => {
    const sa = await mpState(A);
    return sa.ownRunning && sa.oppRunning;
  }, 6000, 'host engines live after countdown');
  const a3 = await mpState(A);
  const b3 = await mpState(B);
  ck('host: engines running after countdown', a3.ownRunning === true && a3.oppRunning === true);
  ck('host: countdown hidden after countdown', a3.cdVisible === false);
  ck('guest: engines running after countdown', b3.ownRunning === true && b3.oppRunning === true);
  ck('guest: countdown hidden after countdown', b3.cdVisible === false);

  // ================= Results =================
  const failed = results.filter((r) => !r.ok);
  console.log('\n========================================');
  console.log('COUNTDOWN CHECK: ' + (results.length - failed.length) + '/' + results.length + ' passed');
  for (const x of [S, A, B]) { try { x.ws.close(); } catch (e) {} try { x.chrome.kill('SIGKILL'); } catch (e) {} try { fs.rmSync(x.prof, { recursive: true, force: true }); } catch (e) {} }
  try { srv.kill('SIGKILL'); } catch (e) {}
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('[cd] fatal: ' + (e && e.stack || e));
  process.exit(2);
});
