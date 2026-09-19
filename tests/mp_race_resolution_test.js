/* Reproduce the "first death ignored" bug.
 *
 * Connects host (white=attacker) + guest (black=defender), starts a capture
 * race, then FORCES the attacker's own fight to end ('lose') FIRST via
 * __MP.simulateEnd. We then watch whether the race resolves on BOTH clients
 * and with which outcome.
 *
 * Expected (correct): the moment the attacker dies, BOTH sides resolve the
 * race as 'fail' (catcher lost -> capture fails). The overlay closes.
 *
 * Bug symptom (user report): the first death is ignored (overlay stays open,
 * race keeps running); only when the SECOND player dies does it resolve, and
 * it resolves as if the second-to-die lost (inverted outcome).
 *
 * Run: node mp_race_resolution_test.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = 8129;
const URL = `http://127.0.0.1:${PORT}/index.html`;
const DBG_A = 9331; // host (white, attacker)
const DBG_B = 9332; // guest (black, defender)
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
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-res-'));
  const chrome = spawn('chromium', ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--user-data-dir=${prof}`,`--remote-debugging-port=${dbgPort}`,'about:blank'], { stdio: 'ignore' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${dbgPort}/json/version`)).ok, 15000, 'devtools');
  const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
  const target = list.find((t) => t.type === 'page') || list[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = cdp(ws);
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  const exceptions = [];
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; exceptions.push((d.exception && (d.exception.description || d.exception.value)) || d.text); }
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') { exceptions.push('[log] ' + m.params.entry.text); }
  });
  const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const clickSq = (row, col) => evalJs(`(() => { const s = document.querySelector('#board .square[data-row="${row}"][data-col="${col}"]'); if (!s) return false; s.click(); return true; })()`);
  const snap = () => evalJs(`(() => {
    const st = window.__MP.state; const r = window.__MP.race;
    return JSON.stringify({ connected: st.connected, inRace: st.inRace, myColor: st.myColor,
      turn: st.board ? st.board.turn : null,
      resolved: r ? r.resolved : null, results: r ? r.results : null,
      overlayHidden: document.getElementById('mp-fights-overlay').classList.contains('hidden') });
  })()`).then((s) => JSON.parse(s));
  return { chrome, prof, ws, send, evalJs, clickSq, snap, exceptions };
}
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await waitFor(async () => (await fetch(URL, { method: 'HEAD' })).ok, 8000, 'server');
  const A = await launchChrome(DBG_A); // host (white, attacker/catcher)
  const B = await launchChrome(DBG_B); // guest (black, defender)
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
  let connected = false;
  const t0 = Date.now();
  while (!connected && Date.now() - t0 < 35000) {
    try {
      const sa = await A.snap(); const sb = await B.snap();
      if (sa.connected && sb.connected && sa.turn && sb.turn) connected = true;
      else if (Date.now() - t0 > 8000) { /* log once past 8s */ }
    } catch (e) {}
    await sleep(300);
  }
  if (!connected) {
    console.log('CONNECT FAILED. States:');
    try { console.log('  host :', JSON.stringify(await A.evalJs(`JSON.stringify(window.__MP.state)`))); } catch (e) { console.log('  host eval err ' + e); }
    try { console.log('  guest:', JSON.stringify(await B.evalJs(`JSON.stringify(window.__MP.state)`))); } catch (e) { console.log('  guest eval err ' + e); }
    console.log('  host exceptions:'); A.exceptions.forEach((e) => console.log('   ' + e));
    console.log('  guest exceptions:'); B.exceptions.forEach((e) => console.log('   ' + e));
    process.exit(3);
  }
  console.log('connected: host=' + (await A.snap()).myColor + ', guest=' + (await B.snap()).myColor);
  console.log('connected, starting capture sequence e4 / d5 / exd5');

  await A.clickSq(6, 4); await sleep(120); await A.clickSq(4, 4);
  await waitFor(async () => (await B.snap()).turn === 'black', 8000, 'e4 sync');
  await B.clickSq(1, 3); await sleep(120); await B.clickSq(3, 3);
  await waitFor(async () => (await A.snap()).turn === 'white', 8000, 'd5 sync');
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
  await sleep(300);
  console.log('\n=== BEFORE: race started on both sides ===');
  console.log('host:', JSON.stringify(await A.snap()));
  console.log('guest:', JSON.stringify(await B.snap()));

  // --- FORCE the ATTACKER (host, white) to die FIRST via the REAL hit path. ---
  console.log('\n>>> Forcing ATTACKER (host) to die FIRST (real _hitPlayer path)');
  await A.evalJs(`window.__MP.forceHitDeath('own'); true`);

  // Give time for the fight-result message to propagate + resolution.
  await sleep(1500);
  const afterFirst = { host: await A.snap(), guest: await B.snap() };
  console.log('\n=== AFTER FIRST DEATH (attacker) ===');
  console.log('host :', JSON.stringify(afterFirst.host));
  console.log('guest:', JSON.stringify(afterFirst.guest));

  const hostResolvedAfterFirst = afterFirst.host.resolved === true;
  const guestResolvedAfterFirst = afterFirst.guest.resolved === true;
  const hostOverlayClosed = afterFirst.host.overlayHidden === true;
  const guestOverlayClosed = afterFirst.guest.overlayHidden === true;

  console.log('\n--- DIAGNOSIS ---');
  console.log('Host resolved right after its own death?   ' + (hostResolvedAfterFirst ? 'YES' : 'NO  <-- BUG (race kept going)'));
  console.log('Guest resolved after opponent died?        ' + (guestResolvedAfterFirst ? 'YES' : 'NO  <-- BUG (race kept going)'));
  console.log('Host overlay closed?                       ' + (hostOverlayClosed ? 'YES' : 'NO  <-- BUG'));
  console.log('Guest overlay closed?                      ' + (guestOverlayClosed ? 'YES' : 'NO  <-- BUG'));

  // If the first death did NOT resolve (the reported bug), now force the
  // defender to die and observe the (wrong) inverted outcome.
  if (!(hostResolvedAfterFirst && guestResolvedAfterFirst)) {
    console.log('\n>>> First death did not resolve. Now forcing DEFENDER (guest) to die...');
    await B.evalJs(`window.__MP.forceHitDeath('own'); true`);
    await sleep(1500);
    const afterSecond = { host: await A.snap(), guest: await B.snap() };
    console.log('\n=== AFTER SECOND DEATH (defender) ===');
    console.log('host :', JSON.stringify(afterSecond.host));
    console.log('guest:', JSON.stringify(afterSecond.guest));
    // Correct outcome (attacker died first) should be 'fail'. What outcome was applied?
    // Infer from board: if the white pawn (attacker) at e4 was removed -> 'fail'.
    const grid = await A.evalJs(`(() => { const g = window.__MP.state.board.grid; return g[4][4] ? (g[4][4].color+g[4][4].type) : 'EMPTY'; })()`);
    console.log('Cell e4 (4,4) after resolution: ' + grid + '  (EMPTY => capture failed = \'fail\'; Wp => capture succeeded = \'success\')');
  }

  console.log('\n=== EXCEPTIONS ===');
  console.log('host (' + A.exceptions.length + '):'); A.exceptions.forEach((e) => console.log('  ' + e));
  console.log('guest (' + B.exceptions.length + '):'); B.exceptions.forEach((e) => console.log('  ' + e));

  for (const x of [A, B]) { try { x.ws.close(); } catch (e) {} try { x.chrome.kill('SIGKILL'); } catch (e) {} try { fs.rmSync(x.prof, { recursive: true, force: true }); } catch (e) {} }
  try { srv.kill('SIGKILL'); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.error('fatal: ' + (e && e.stack || e)); process.exit(2); });
