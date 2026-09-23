/* End-to-end test for the on-screen Replay Viewer (js/ui/replay-ui.js),
 * driven over real headless Chromium via CDP.
 *
 * Plays a few real moves through the game's own UI path (so the GameLog
 * records them), opens the replay modal, and verifies:
 *   - the modal shows a full read-only board in the starting position
 *   - stepping replays the recorded moves (board state matches the live board)
 *   - the move log + progress counter update
 *   - playing advances automatically
 *   - clicking replay squares does nothing (readOnly)
 *   - the live game is untouched by the replay
 *
 * Run: node tests/mp_replay_viewer_test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = 8126;
const DBG_PORT = 9225;
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

  const evalJs = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (res.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(res.exceptionDetails));
    return res.result.value;
  };

  // --- 4. Navigate & settle ---
  await send('Page.navigate', { url: URL });
  await waitFor(() => new Promise((res) => {
    const h = (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Page.loadEventFired') { ws.removeEventListener('message', h); res(true); } };
    ws.addEventListener('message', h);
    setTimeout(() => res(false), 10000);
  }), 12000, 'load event');
  await sleep(800);

  // --- 5. Play three moves the way the game's internal flow does
  //        (board.applyMove + GameLog.push('turn', …), exactly what main.js
  //        does after a fight resolves), so the GameLog has content and the
  //        live board holds the resulting position. All synchronous: no AI
  //        timer is scheduled because we bypass main.js's move wrapper.
  const setup = await evalJs(`(() => {
    const b = window.__TC.board, GL = GameLog;
    const ser = (move) => ({
      from: { r: move.from.row, c: move.from.col },
      to: { r: move.to.row, c: move.to.col },
      pieceType: move.piece.type,
      pieceCharacter: move.piece.character,
      capturedType: move.captured ? move.captured.type : null,
      capturedCharacter: move.captured ? move.captured.character : null,
      flags: {
        isCastle: move.isCastle || null,
        isEnPassant: !!move.isEnPassant,
        isPromotion: !!move.isPromotion,
        isDoublePawn: !!move.isDoublePawn,
        castleEnPassant: !!move.castleEnPassant,
        promotionPiece: move.promotionPiece || null,
      },
    });
    const play = (side, from, to) => {
      const m = b.getMoves(side).find(x =>
        x.from.row === from[0] && x.from.col === from[1] &&
        x.to.row === to[0] && x.to.col === to[1]);
      if (!m) throw new Error('move not found: ' + side + ' ' + from + '->' + to);
      b.applyMove(m);
      GL.push('turn', {
        side, move: ser(m), capture: null, failed: false, reason: null,
        state: { turn: b.turn, gameOver: b.gameOver, winner: b.winner },
      });
    };
    play('white', [6, 4], [4, 4]);   // e2-e4
    play('black', [1, 3], [3, 3]);   // d7-d5
    play('white', [6, 3], [4, 3]);   // d2-d4
    return JSON.stringify({
      ok: true,
      turns: GL.events.filter(e => e.type === 'turn').length,
      liveTurn: b.turn,
      pieces: [...document.querySelectorAll('#board .piece')].length,
    });
  })()`);
  const s = JSON.parse(setup);

  // --- 6. Open the replay modal and inspect the starting position.
  const open = await evalJs(`(() => {
    const rep = window.__TC.replay;
    if (!rep) return JSON.stringify({ ok: false, why: 'no __TC.replay' });
    rep.open(GameLog.events.slice());
    const modal = document.getElementById('replay-modal');
    const squares = document.querySelectorAll('#replay-board .square').length;
    const pieces = document.querySelectorAll('#replay-board .piece').length;
    const kings = [...document.querySelectorAll('#replay-board .piece')]
      .filter(el => el.title.includes('King')).length;
    return JSON.stringify({
      ok: true,
      modalVisible: !modal.classList.contains('hidden'),
      squares,
      pieces,
      kings,
      progress: document.getElementById('replay-progress').textContent,
      logLines: document.querySelectorAll('#replay-move-log li').length,
    });
  })()`);
  const o = JSON.parse(open);

  // --- 7. Step through all recorded moves; the replay board must match the
  //        live board exactly.
  const stepAll = await evalJs(`(() => {
    const rep = window.__TC.replay, b = window.__TC.board;
    let steps = 0, errors = [];
    while (rep.index < rep.events.length) {
      const r = rep.step();
      steps++;
      if (r.error) { errors.push(r.error); break; }
    }
    let same = true;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const a = b.grid[r][c], z = rep.board.grid[r][c];
      if (!!a !== !!z) { same = false; break; }
      if (a && (a.type !== z.type || a.color !== z.color)) { same = false; break; }
    }
    return JSON.stringify({
      steps,
      errors,
      gridMatchesLive: same,
      progress: document.getElementById('replay-progress').textContent,
      logLines: document.querySelectorAll('#replay-move-log li').length,
      firstLog: document.querySelector('#replay-move-log li') ? document.querySelector('#replay-move-log li').textContent : '',
    });
  })()`);
  const st = JSON.parse(stepAll);

  // --- 8. Play from the start: reset, then play and let it run a tick.
  const play = await evalJs(`(() => {
    const rep = window.__TC.replay;
    rep.reset();
    rep.play();
    return JSON.stringify({
      playing: rep.playing,
      btnLabel: document.getElementById('replay-btn-play').textContent,
    });
  })()`);
  const p = JSON.parse(play);
  await sleep(1200); // at 1x, a plain move takes ~750ms
  const played = await evalJs(`(() => {
    const rep = window.__TC.replay;
    return JSON.stringify({
      index: rep.index,
      playing: rep.playing,
    });
  })()`);
  const pl = JSON.parse(played);

  // --- 9. readOnly: clicking a replay square must not move anything.
  const ro = await evalJs(`(() => {
    const rep = window.__TC.replay, b = window.__TC.board;
    const before = rep.board.grid[6][4] ? 'has' : 'empty';
    const sq = document.querySelector('#replay-board .square[data-row="6"][data-col="4"]');
    if (!sq) return JSON.stringify({ ok: false, why: 'no square el' });
    sq.click();
    return JSON.stringify({
      ok: true,
      boardUnchanged: (rep.board.grid[6][4] ? 'has' : 'empty') === before,
      liveUnchanged: b.grid[6][4] === null, // live e2 pawn already moved
    });
  })()`);
  const r = JSON.parse(ro);

  // --- 10. Close the modal (Esc key path) and check the live game is intact.
  const close = await evalJs(`(() => {
    const rep = window.__TC.replay, b = window.__TC.board;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    const modal = document.getElementById('replay-modal');
    return JSON.stringify({
      closed: modal.classList.contains('hidden'),
      paused: !rep.playing,
      liveTurn: b.turn,
      livePieces: [...document.querySelectorAll('#board .piece')].length,
    });
  })()`);
  const c = JSON.parse(close);

  // --- 11. Verdict ---
  let ok = true;
  const check = (cond, msg) => {
    console.log((cond ? '  PASS: ' : '  FAIL: ') + msg);
    if (!cond) ok = false;
  };
  check(exceptions.length === 0, 'no page exceptions' + (exceptions.length ? ' (' + exceptions[0] + ')' : ''));
  check(s.ok && s.turns === 3, 'setup: 3 turns recorded in GameLog (got ' + s.turns + ')');
  check(o.ok, 'replay module loaded (__TC.replay)');
  check(o.modalVisible, 'replay modal is visible after open()');
  check(o.squares === 64, 'replay board has 64 squares (got ' + o.squares + ')');
  check(o.pieces === 32, 'starting position shows all 32 pieces (got ' + o.pieces + ')');
  check(o.kings === 2, 'starting position shows both kings (got ' + o.kings + ')');
  check(o.progress === '0 / 3', 'progress counter starts at 0 / 3 (got ' + o.progress + ')');
  check(o.logLines === 0, 'move log starts empty');
  check(st.steps === 3, 'stepping applied all 3 recorded moves (got ' + st.steps + ')');
  check(st.errors.length === 0, 'no replay errors (got ' + JSON.stringify(st.errors) + ')');
  check(st.gridMatchesLive, 'replay board grid matches the live board');
  check(st.progress === '3 / 3', 'progress counter reaches 3 / 3 (got ' + st.progress + ')');
  check(st.logLines === 3, 'move log has 3 lines (got ' + st.logLines + ')');
  check(/e2/.test(st.firstLog), 'first log line mentions e2 (got ' + st.firstLog + ')');
  check(p.playing && p.btnLabel.includes('Pause'), 'play() starts playback and updates the button');
  check(pl.index >= 1, 'playback advanced at least one move (index=' + pl.index + ')');
  check(r.ok && r.boardUnchanged, 'clicking a replay square does nothing (readOnly)');
  check(r.liveUnchanged, 'live board unaffected by replay');
  check(c.closed, 'Esc closes the replay modal');
  check(c.paused, 'closing pauses playback');
  check(c.liveTurn === s.liveTurn, 'live game turn unchanged after replay session');
  check(c.livePieces === 32, 'live board still has 32 pieces (no captures; got ' + c.livePieces + ')');

  console.log(ok ? '\nRESULT: PASS (replay viewer works end-to-end)' : '\nRESULT: FAIL');
  ws.close();
  chrome.kill();
  srv.kill();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('ERROR: ' + (e && e.stack || e));
  process.exit(1);
});
