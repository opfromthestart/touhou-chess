/* End-to-end test for the board move animations (slide + capture fade) in
 * js/ui/board-ui.js, driven over real headless Chromium via CDP.
 *
 * Loads the actual page, makes a real move through the game's own UI path
 * (__TC.ui.onMove), and verifies the Web Animations API fired on the moved
 * piece; then stages a capture and verifies the fade-out overlay.
 *
 * Run: node tests/mp_board_anim_test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = 8125;
const DBG_PORT = 9224;
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

  // --- 3. CDP session ---
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');

  const exceptions = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      exceptions.push(((d.exception && (d.exception.description || d.exception.value)) || d.text) || '');
    }
  });

  // --- 4. Navigate & settle ---
  await send('Page.navigate', { url: URL });
  await waitFor(() => new Promise((res) => {
    const h = (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Page.loadEventFired') { ws.removeEventListener('message', h); res(true); } };
    ws.addEventListener('message', h);
    setTimeout(() => res(false), 10000);
  }), 12000, 'load event');
  await sleep(800); // let main.js init run (do NOT wait for the AI: it fires
  // 60ms after the first player move, and we want a clean white-to-move board)

  // --- 5. Drive the game and inspect the animations (one synchronous
  //        evaluate, so the 60ms AI timer cannot interleave) ---
  const expr = `(() => {
    const out = {};
    const ui = window.__TC.ui, b = window.__TC.board;

    // (a) Real move through the UI path: e2-e4.
    const e4 = b.getMoves('white').find(m => m.from.row === 6 && m.from.col === 4 && m.to.row === 4 && m.to.col === 4);
    ui.onMove(e4);
    const pieceEl = document.querySelector('.square[data-row="4"][data-col="4"] .piece');
    out.slide = {
      pieceOnE4: !!(b.grid[4][4] && b.grid[4][4].color === 'white' && b.grid[4][4].type === 'p'),
      elFound: !!pieceEl,
      anims: pieceEl ? pieceEl.getAnimations().length : 0,
      playState: pieceEl && pieceEl.getAnimations().length
        ? pieceEl.getAnimations()[0].playState : null,
    };

    // (b) Stage a capture: black pawn on d5, white pawn e4 takes it.
    // Render once with the pawn present so the previous-render snapshot
    // (which the fade diff reads from the DOM) actually contains it.
    b.grid[3][3] = { color: 'black', type: 'p', character: 'rumia', hasMoved: true };
    ui.clearLastMove();
    ui.render(b);
    const cap = b.getMoves('white').find(m => m.captured && m.from.row === 4 && m.from.col === 4 && m.to.row === 3 && m.to.col === 3);
    out.captureMoveFound = !!cap;
    b.applyMove(cap);
    ui.setLastMove(cap.from, cap.to);
    ui.render(b);
    const fadeEl = document.querySelector('.square[data-row="3"][data-col="3"] .piece-captured-fade');
    out.fade = {
      elFound: !!fadeEl,
      anims: fadeEl ? fadeEl.getAnimations().length : 0,
      onTop: fadeEl ? fadeEl.parentElement.lastElementChild === fadeEl : false,
      state: b.grid[3][3] && b.grid[3][3].color === 'white' && b.grid[4][4] === null,
    };
    out.totalAnims = document.getAnimations().length;
    return JSON.stringify(out);
  })()`;
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (res.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(res.exceptionDetails));
  const r = JSON.parse(res.result.value);

  // --- 6. Verdict ---
  let ok = true;
  const check = (cond, msg) => {
    console.log((cond ? '  PASS: ' : '  FAIL: ') + msg);
    if (!cond) ok = false;
  };
  check(exceptions.length === 0, 'no page exceptions' + (exceptions.length ? ' (' + exceptions[0] + ')' : ''));
  check(r.slide.pieceOnE4, 'e2-e4 applied (pawn on e4)');
  check(r.slide.elFound, 'piece element exists on e4');
  check(r.slide.anims >= 1, 'slide animation running on the moved piece (anims=' + r.slide.anims + ')');
  check(r.slide.playState === 'running', 'slide animation playState=running (got ' + r.slide.playState + ')');
  check(r.captureMoveFound, 'capture move found (e4xd5)');
  check(r.fade.elFound, 'capture fade overlay present on d5');
  check(r.fade.anims >= 1, 'fade animation running (anims=' + r.fade.anims + ')');
  check(r.fade.onTop, 'fade overlay drawn on top of the incoming piece');
  check(r.fade.state, 'board state correct after capture (white pawn on d5, e4 empty)');
  check(r.totalAnims >= 2, 'document has active animations (total=' + r.totalAnims + ')');

  // Give the animations time to finish; the fade element must be removed.
  await sleep(400);
  const res2 = await send('Runtime.evaluate', {
    expression: 'document.querySelectorAll(".piece-captured-fade").length',
    returnByValue: true,
  });
  const fadeLeft = res2.result.value;
  check(fadeLeft === 0, 'fade overlay cleaned up after animation (left=' + fadeLeft + ')');

  console.log(ok ? '\nRESULT: PASS (move animations work end-to-end)' : '\nRESULT: FAIL');
  ws.close();
  chrome.kill();
  srv.kill();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('ERROR: ' + (e && e.stack || e));
  process.exit(1);
});
