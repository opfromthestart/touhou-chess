/* Scratch verification for the multiplayer network telemetry (js/net/telemetry.js
 * + the peer.js/multiplayer.js instrumentation).
 *
 * What it checks (two headless Chromiums, real PeerJS cloud link):
 *   1. Both clients' GameLogs contain the expected `net` events:
 *        session-start (role), conn open, hello send+recv, move send/recv
 *        (e4, d5, exd5 with from/to), race start + engines-start,
 *        end-own / end-spect / result-recv, resolve (outcome + path).
 *   2. RTT: at least one ping/pong sample on each side, with a clock offset.
 *   3. Privacy: the exported dump contains NO room code, NO peer-ID prefix,
 *      NO display name.
 *   4. __MP.state.net summary + __MP.netSim handle exist.
 *   5. Simulator: drop=1 on the guest drops the host's chat (and logs a
 *      sim drop-recv); sendMs=1000 on the host delays the chat by >= 800 ms
 *      of TRUE one-way time (computed with the measured clock offset).
 *
 * Run: node tmp-netlog-check.js   (ports 8150, dbg 9381/9382)
 * Exit: 0 = all pass, 1 = check failure, 2 = fatal.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname; // this script lives at the repo root
const PORT = 8150;
const URL = `http://127.0.0.1:${PORT}/index.html`;
const DBG_A = 9381; // host (white)
const DBG_B = 9382; // guest (black)
const HOST_NAME = 'ZQAlphaName';
const GUEST_NAME = 'ZQBetaName';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) {}
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for: ' + what);
    await sleep(150);
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
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-netlog-'));
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
    if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const clickSq = (row, col) => evalJs(`(() => { const s = document.querySelector('#board .square[data-row="${row}"][data-col="${col}"]'); if (!s) return false; s.click(); return true; })()`);
  const snap = () => evalJs(`(() => {
    const st = window.__MP.state;
    const b = st.board;
    const r = window.__MP.race;
    return JSON.stringify({
      board: !!b, turn: b ? b.turn : null, connected: st.connected,
      inRace: st.inRace,
      race: r ? { resolved: r.resolved, results: r.results } : null,
      net: st.net,
    });
  })()`).then((s) => JSON.parse(s));
  // All `net` events from this client's GameLog (bare global — top-level
  // const, so NOT a window property).
  const netEvents = () => evalJs(`JSON.stringify(GameLog.events.filter((e) => e.type === 'net'))`).then((s) => JSON.parse(s));
  return { chrome, prof, ws, send, evalJs, clickSq, snap, netEvents };
}

const CHECKS = [];
const ck = (name, ok, problems) => CHECKS.push({ name, ok: !!ok, problems: problems || [] });
const hasEv = (evs, kind, pred) => evs.some((e) => e.kind === kind && (!pred || pred(e)));
const problems = (p) => [p];

(async () => {
  console.log('=== NET TELEMETRY CHECK ===');
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await waitFor(async () => (await fetch(URL, { method: 'HEAD' })).ok, 8000, 'server');
  console.log('[net] server up at ' + URL);
  const A = await launchChrome(DBG_A); // host = white
  const B = await launchChrome(DBG_B); // guest = black
  await A.send('Page.navigate', { url: URL });
  await B.send('Page.navigate', { url: URL });
  await sleep(2500);

  // Connect with distinctive display names (to prove they never leak into the log).
  await A.evalJs(`document.getElementById('btn-multiplayer').click(); true`);
  await A.evalJs(`(() => { document.getElementById('mp-name-input').value = ${JSON.stringify(HOST_NAME)}; return true; })()`);
  await A.evalJs(`document.getElementById('mp-host-btn').click(); true`);
  let code;
  try {
    code = await waitFor(async () => {
      const v = await A.evalJs(`(() => { const el = document.getElementById('mp-code-value'); const t = el && el.textContent.trim(); return t && t.length >= 4 ? t : null; })()`);
      return v || null;
    }, 20000, 'room code (host)');
  } catch (e) {
    const d = await A.evalJs(`JSON.stringify({ role: TCNet.role, code: TCNet.code, peer: !!TCNet.peer, conn: !!TCNet.conn, netStatus: document.getElementById('mp-net-status').textContent, netEvents: NetLog.events.map((e) => e.kind + ':' + (e.what || e.msg || '')) })`).catch(() => 'eval failed');
    console.log('[net] DIAG host: ' + d);
    throw e;
  }
  console.log('[net] host created room (code withheld from this report: ' + code.length + ' chars)');
  await B.evalJs(`document.getElementById('btn-multiplayer').click(); true`);
  await B.evalJs(`(() => { document.getElementById('mp-name-input').value = ${JSON.stringify(GUEST_NAME)}; return true; })()`);
  await B.evalJs(`(() => { document.getElementById('mp-code-input').value = ${JSON.stringify(code)}; return true; })()`);
  await B.evalJs(`document.getElementById('mp-join-btn').click(); true`);
  try {
    await waitFor(async () => {
      const sa = await A.snap(); const sb = await B.snap();
      return sa.connected && sb.connected && sa.board && sb.board && sa.turn && sb.turn;
    }, 60000, 'both peers connected + game started');
  } catch (e) {
    for (const [name, page] of [['host', A], ['guest', B]]) {
      const d = await page.evalJs(`(() => {
        const st = window.__MP.state;
        return JSON.stringify({
          netStatus: (document.getElementById('mp-net-status') || {}).textContent || '?',
          role: TCNet.role, connOpen: !!(TCNet.conn && TCNet.conn.open),
          connected: st.connected, board: !!st.board,
        });
      })()`);
      console.log('[net] DIAG ' + name + ': ' + d);
    }
    throw e;
  }
  console.log('[net] connected: host=white, guest=black');

  // Play e4 / d5 / exd5 (capture -> race), force the ATTACKER (host's own
  // ship) to die so both clients resolve consistently via the premature path.
  const doMove = async (page, from, to, label) => {
    const ok1 = await page.clickSq(from[0], from[1]);
    await sleep(150);
    const ok2 = await page.clickSq(to[0], to[1]);
    if (!ok1 || !ok2) throw new Error('click failed for ' + label);
  };
  await doMove(A, [6, 4], [4, 4], 'e2-e4');
  await waitFor(async () => (await B.snap()).turn === 'black', 10000, 'turn=black after e4');
  await doMove(B, [1, 3], [3, 3], 'd7-d5');
  await waitFor(async () => (await A.snap()).turn === 'white', 10000, 'turn=white after d5');
  await doMove(A, [4, 4], [3, 3], 'exd5');
  await waitFor(async () => {
    const sa = await A.snap(); const sb = await B.snap();
    return sa.inRace && sb.inRace;
  }, 15000, 'race start');
  await waitFor(async () => {
    const live = (p) => p.evalJs(`!!(window.__MP.engines && window.__MP.engines.own && window.__MP.engines.opp && window.__MP.engines.own.running && window.__MP.engines.opp.running)`);
    return (await live(A)) && (await live(B));
  }, 8000, 'race engines live');
  await A.evalJs(`window.__MP.forceHitDeath('own'); true`); // host = attacker
  await waitFor(async () => {
    const sa = await A.snap(); const sb = await B.snap();
    return !sa.inRace && !sb.inRace && sa.race && sa.race.resolved && sb.race && sb.race.resolved;
  }, 15000, 'race settle');
  console.log('[net] race resolved: host=' + JSON.stringify((await A.snap()).race.results) + ' guest=' + JSON.stringify((await B.snap()).race.results));

  // Wait for at least 2 RTT samples on each side (ping every 2 s).
  await waitFor(async () => {
    const na = await A.netEvents(); const nb = await B.netEvents();
    return na.filter((e) => e.kind === 'rtt').length >= 2 && nb.filter((e) => e.kind === 'rtt').length >= 2;
  }, 15000, 'rtt samples on both sides');

  const evA = await A.netEvents();
  const evB = await B.netEvents();

  // 1. Session + connection + hello
  ck('host: session-start role=host', hasEv(evA, 'session', (e) => e.what === 'start' && e.role === 'host'));
  ck('guest: session-start role=guest', hasEv(evB, 'session', (e) => e.what === 'start' && e.role === 'guest'));
  ck('host: conn open logged', hasEv(evA, 'conn', (e) => e.what === 'open'));
  ck('guest: conn open logged', hasEv(evB, 'conn', (e) => e.what === 'open'));
  ck('host: hello sent+recv', hasEv(evA, 'send', (e) => e.msg === 'hello') && hasEv(evA, 'recv', (e) => e.msg === 'hello'));
  ck('guest: hello sent+recv', hasEv(evB, 'send', (e) => e.msg === 'hello') && hasEv(evB, 'recv', (e) => e.msg === 'hello'));
  ck('host: game-start logged', hasEv(evA, 'session', (e) => e.what === 'game-start' && e.myColor === 'white'));

  // 2. Moves (from/to + captured flag)
  ck('host: move send e2->e4', hasEv(evA, 'move', (e) => e.what === 'send' && e.from === 'e2' && e.to === 'e4' && e.captured === false));
  ck('guest: move recv e2->e4', hasEv(evB, 'move', (e) => e.what === 'recv' && e.from === 'e2' && e.to === 'e4'));
  ck('guest: move send d7->d5', hasEv(evB, 'move', (e) => e.what === 'send' && e.from === 'd7' && e.to === 'd5'));
  ck('host: move recv d7->d5', hasEv(evA, 'move', (e) => e.what === 'recv' && e.from === 'd7' && e.to === 'd5'));
  ck('host: move send e4->d5 (capture)', hasEv(evA, 'move', (e) => e.what === 'send' && e.from === 'e4' && e.to === 'd5' && e.captured === true));
  ck('guest: move recv e4->d5 (capture)', hasEv(evB, 'move', (e) => e.what === 'recv' && e.from === 'e4' && e.to === 'd5' && e.captured === true));

  // 3. Race lifecycle
  ck('host: race start e4->d5', hasEv(evA, 'race', (e) => e.what === 'start' && e.from === 'e4' && e.to === 'd5' && e.attacker === 'white'));
  ck('guest: race start e4->d5', hasEv(evB, 'race', (e) => e.what === 'start' && e.from === 'e4' && e.to === 'd5' && e.attacker === 'white'));
  ck('host: engines-start', hasEv(evA, 'race', (e) => e.what === 'engines-start'));
  ck('guest: engines-start', hasEv(evB, 'race', (e) => e.what === 'engines-start'));
  ck('host: end-own attacker lose', hasEv(evA, 'race', (e) => e.what === 'end-own' && e.side === 'attacker' && e.result === 'lose' && typeof e.gameTime === 'number'));
  // With a FORCED death the guest's spectator copy never sees the hit (it is
  // driven by relayed input), so the guest observes the attacker's end via the
  // authoritative result-recv instead of end-spect. Either observation path is
  // valid — what matters is that the guest saw it BEFORE resolving.
  ck('guest: observed attacker end (end-spect or result-recv)', hasEv(evB, 'race', (e) => (e.what === 'end-spect' || e.what === 'result-recv') && e.side === 'attacker' && e.result === 'lose'));
  ck('host: resolve fail (premature-attacker-dead)', hasEv(evA, 'race', (e) => e.what === 'resolve' && e.outcome === 'fail' && e.path === 'premature-attacker-dead' && e.results && e.results.attacker));
  ck('guest: resolve fail (premature-attacker-dead)', hasEv(evB, 'race', (e) => e.what === 'resolve' && e.outcome === 'fail' && e.path === 'premature-attacker-dead'));

  // 4. RTT + offset
  const rttA = evA.filter((e) => e.kind === 'rtt');
  const rttB = evB.filter((e) => e.kind === 'rtt');
  ck('host: rtt samples with offset', rttA.length >= 2 && rttA.every((e) => typeof e.ms === 'number' && e.offset != null), problems('rttA=' + JSON.stringify(rttA.slice(0, 3))));
  ck('guest: rtt samples with offset', rttB.length >= 2 && rttB.every((e) => typeof e.ms === 'number' && e.offset != null), problems('rttB=' + JSON.stringify(rttB.slice(0, 3))));
  const sa0 = await A.snap();
  ck('host: __MP.state.net summary', !!(sa0.net && sa0.net.rtt && sa0.net.rtt.count >= 2 && sa0.net.counts && sa0.net.counts.send > 0), problems('net=' + JSON.stringify(sa0.net)));

  // 5. Privacy: no identifying info anywhere in the exported dump.
  const dumpA = await A.evalJs(`GameLog.dump()`);
  const dumpB = await B.evalJs(`GameLog.dump()`);
  const leak = (dump, tag) => {
    const bad = [];
    if (dump.includes('"' + code + '"')) bad.push('room code');
    if (dump.includes('touhou-chess-v1-')) bad.push('peer id prefix');
    if (dump.includes(HOST_NAME) || dump.includes(GUEST_NAME)) bad.push('display name');
    if (bad.length) console.log('  [leak] ' + tag + ': ' + bad.join(', '));
    return bad;
  };
  const leaks = leak(dumpA, 'host').concat(leak(dumpB, 'guest'));
  ck('privacy: no room code / peer id / name in dump', leaks.length === 0, problems(leaks));

  // 6. Simulator: drop. Note: the 'recv' net event is logged when the message
  // PHYSICALLY arrives (before the sim drop), so the drop is proven by the
  // 'sim drop-recv' event + the chat never reaching the game layer (#chat-log).
  await B.evalJs(`window.__MP.netSim.set({ drop: 1 }); true`);
  await sleep(100);
  const dropBefore = (await B.netEvents()).filter((e) => e.kind === 'sim' && e.what === 'drop-recv' && e.msg === 'chat').length;
  const lisBefore = await B.evalJs(`document.querySelectorAll('#chat-log li').length`);
  await A.evalJs(`TCNet.send({ type: 'chat', text: 'ZQX-drop-test' }); true`);
  await sleep(1200);
  const evB2 = await B.netEvents();
  const dropAfter = evB2.filter((e) => e.kind === 'sim' && e.what === 'drop-recv' && e.msg === 'chat').length;
  const lisAfter = await B.evalJs(`document.querySelectorAll('#chat-log li').length`);
  ck('sim: guest drop=1 drops incoming chat', dropAfter === dropBefore + 1 && lisAfter === lisBefore, problems('drop-recv ' + dropBefore + '->' + dropAfter + ', chat li ' + lisBefore + '->' + lisAfter));
  ck('sim: set logged on guest', hasEv(evB2, 'sim', (e) => e.what === 'set' && e.drop === 1));
  await B.evalJs(`window.__MP.netSim.set({ drop: 0 }); true`);

  // 7. Simulator: send delay. The host 'send' event is logged when
  // TCNet.send() is called (BEFORE the sim delay); the guest 'recv' event when
  // the message physically arrives. The two logs are on different clocks AND
  // different session-start times, so the raw (recv.t - send.t) is not a
  // one-way time by itself — but the DIFFERENCE between a no-sim chat and a
  // sim chat cancels the alignment term entirely, leaving the added delay.
  const chatRaw = async (label) => {
    const nSend = (await A.netEvents()).filter((e) => e.kind === 'send' && e.msg === 'chat').length;
    const lisBefore = await B.evalJs(`document.querySelectorAll('#chat-log li').length`);
    await A.evalJs(`TCNet.send({ type: 'chat', text: ${JSON.stringify(label)} }); true`);
    await waitFor(async () => (await B.evalJs(`document.querySelectorAll('#chat-log li').length`)) > lisBefore, 8000, 'chat received: ' + label);
    const s = (await A.netEvents()).filter((e) => e.kind === 'send' && e.msg === 'chat')[nSend];
    const r = (await B.netEvents()).filter((e) => e.kind === 'recv' && e.msg === 'chat').slice(-1)[0];
    return { s: s.t, r: r.t, raw: r.t - s.t };
  };
  const noSim = await chatRaw('ZQX-nosim');
  await A.evalJs(`window.__MP.netSim.set({ sendMs: 1000 }); true`);
  await sleep(100);
  const sim = await chatRaw('ZQX-delay');
  const added = sim.raw - noSim.raw; // ≈ the sim delay (alignment cancels)
  ck('sim: sendMs=1000 adds >= 900ms one-way delay', added >= 900,
    problems('noSim.raw=' + noSim.raw + 'ms sim.raw=' + sim.raw + 'ms added=' + added + 'ms'));
  await A.evalJs(`window.__MP.netSim.set({ sendMs: 0 }); true`);

  // Report
  console.log('\n=== RESULTS (' + CHECKS.filter((c) => c.ok).length + '/' + CHECKS.length + ') ===');
  for (const c of CHECKS) {
    console.log('  ' + (c.ok ? 'PASS' : 'FAIL') + '  ' + c.name);
    if (!c.ok && c.problems && c.problems.length) c.problems.forEach((p) => console.log('        ' + p));
  }
  const pass = CHECKS.every((c) => c.ok);
  console.log('\n' + (pass ? 'NET TELEMETRY CHECK PASSED' : 'NET TELEMETRY CHECK FAILED'));
  A.chrome.kill(); B.chrome.kill(); srv.kill();
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error('FATAL: ' + (e && e.stack || e));
  process.exit(2);
});
