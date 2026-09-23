/* End-to-end test for the danmaku "Fight summary" on the result screen
 * (js/ui/fight-ui.js + DanmakuEngine.getSummary), driven over real headless
 * Chromium via CDP.
 *
 * Starts a real boss fight through the game's own FightUI, forces a known
 * engine state, ends the fight, and verifies the result screen shows a
 * "Fight summary" with the correct score / lives-left / graze / time and the
 * "Cards broken" row (only when a card was actually broken). Also confirms
 * Practice Mode still shows its per-card stats (not the new summary).
 *
 * Run: node tests/mp_fight_summary_test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = 8127;
const DBG_PORT = 9226;
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

  // Helper: start a fresh fight, set a known engine state, force the end, and
  // read back the result screen. All synchronous in one evaluate so the rAF
  // loop can't interleave.
  const runFight = (cfg) => evalJs(`(() => {
    const fight = window.__TC.fight;
    const e = fight.engine;
    fight.startFight(${JSON.stringify(cfg.boss)}, ${JSON.stringify(cfg.diff)},
      ${JSON.stringify(cfg.piece)}, ${JSON.stringify(cfg.char)}, () => {},
      ${JSON.stringify(!!cfg.practice)});
    e.score = ${cfg.score};
    e.graze = ${cfg.graze};
    e.player.lives = ${cfg.lives};
    e.time = ${cfg.time};
    ${cfg.breakCard ? 'e.phaseStats[0].broken = true;' : ''}
    e._end(${JSON.stringify(cfg.result)});
    const statsEl = document.getElementById('fight-stats');
    const rows = [...statsEl.querySelectorAll('.stats-row')]
      .map(r => ({ name: r.querySelector('.stats-name').textContent,
                   val: r.querySelector('.stats-vals').textContent }));
    return JSON.stringify({
      resultVisible: !document.getElementById('fight-result').classList.contains('hidden'),
      statsVisible: !statsEl.classList.contains('hidden'),
      title: document.getElementById('result-title').textContent,
      hasSummaryTitle: statsEl.textContent.includes('Fight summary'),
      rows,
    });
  })()`);

  // --- 5. Scenario A: lost fight, one card broken. ---
  const a = JSON.parse(await runFight({
    boss: 'rumia', diff: 'normal', piece: 'p', char: 'cirno',
    score: 12345, graze: 7, lives: 0, time: 42, breakCard: true, result: 'lose',
  }));

  // --- 6. Scenario B: won fight, no cards broken. ---
  const b = JSON.parse(await runFight({
    boss: 'patchouli', diff: 'normal', piece: 'k', char: 'reimu',
    score: 800, graze: 2, lives: 3, time: 75, breakCard: false, result: 'win',
  }));

  // --- 7. Scenario C: Practice Mode still shows per-card stats, not summary. ---
  const c = JSON.parse(await runFight({
    boss: 'rumia', diff: 'normal', piece: 'p', char: 'cirno',
    score: 100, graze: 1, lives: 1, time: 5, breakCard: false,
    result: 'win', practice: true,
  }));

  // --- 8. Verdict ---
  let ok = true;
  const check = (cond, msg) => {
    console.log((cond ? '  PASS: ' : '  FAIL: ') + msg);
    if (!cond) ok = false;
  };
  const rowVal = (rows, name) => {
    const r = rows.find((x) => x.name === name);
    return r ? r.val : null;
  };

  check(exceptions.length === 0, 'no page exceptions' + (exceptions.length ? ' (' + exceptions[0] + ')' : ''));

  // Scenario A: lost fight with a broken card.
  check(a.resultVisible, 'A: result screen is visible');
  check(a.title === 'FIGHT LOST', 'A: title is FIGHT LOST (got ' + a.title + ')');
  check(a.statsVisible, 'A: stats block is visible');
  check(a.hasSummaryTitle, 'A: shows "Fight summary" heading');
  check(rowVal(a.rows, 'Score') === '12,345', 'A: Score = 12,345 (got ' + rowVal(a.rows, 'Score') + ')');
  check(rowVal(a.rows, 'Lives left') === '0 / 1', 'A: Lives left = 0 / 1 (got ' + rowVal(a.rows, 'Lives left') + ')');
  check(rowVal(a.rows, 'Graze') === '7', 'A: Graze = 7 (got ' + rowVal(a.rows, 'Graze') + ')');
  check(rowVal(a.rows, 'Time') === '0:42', 'A: Time = 0:42 (got ' + rowVal(a.rows, 'Time') + ')');
  check(rowVal(a.rows, 'Cards broken') !== null, 'A: "Cards broken" row present');
  check(a.rows.some((r) => r.name === 'Cards broken' && r.val.length > 0),
    'A: "Cards broken" lists a card name (got ' + rowVal(a.rows, 'Cards broken') + ')');

  // Scenario B: won fight, no cards broken.
  check(b.title === 'FIGHT WON', 'B: title is FIGHT WON (got ' + b.title + ')');
  check(b.hasSummaryTitle, 'B: shows "Fight summary" heading');
  check(rowVal(b.rows, 'Score') === '800', 'B: Score = 800 (got ' + rowVal(b.rows, 'Score') + ')');
  check(rowVal(b.rows, 'Lives left') === '3 / 3', 'B: Lives left = 3 / 3 (got ' + rowVal(b.rows, 'Lives left') + ')');
  check(rowVal(b.rows, 'Time') === '1:15', 'B: Time = 1:15 (got ' + rowVal(b.rows, 'Time') + ')');
  check(rowVal(b.rows, 'Cards broken') === null, 'B: no "Cards broken" row when none broken');

  // Scenario C: Practice Mode keeps its per-card stats.
  check(c.statsVisible, 'C: practice stats block is visible');
  check(!c.hasSummaryTitle, 'C: practice mode does NOT show "Fight summary"');
  check(c.rows.length >= 1 && c.rows[0].name.length > 0, 'C: practice shows per-card rows (' + c.rows.length + ')');

  console.log(ok ? '\nRESULT: PASS (fight summary works end-to-end)' : '\nRESULT: FAIL');
  ws.close();
  chrome.kill();
  srv.kill();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('ERROR: ' + (e && e.stack || e));
  process.exit(1);
});
