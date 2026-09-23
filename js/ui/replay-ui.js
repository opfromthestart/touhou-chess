// replay-ui.js — on-screen replay viewer.
//
// Plays a recorded game log (the JSON that "Export Log" downloads, or the
// live GameLog) back on a dedicated board inside the replay modal. It reuses
// the same Board + BoardUI as live play, so moves slide and captures fade
// exactly like in the real game (see computeMoveAnim in board-ui.js).
// Contested fights are summarized as a short banner between moves — the
// danmaku itself is not re-simulated.
//
// Purely additive: it never touches the live game state. Loaded as a plain
// <script> (after js/debug/replay.js); in the browser ReplayViewer is a
// global, in Node it is module.exports.

// Pull the turn events out of a log payload. Accepts the versioned envelope
// ({ version, events }) that GameLog.dump() produces, or a bare event array.
// Returns the array of `turn` events, or null if the payload is not a log.
function extractTurnEvents(data) {
  const events = Array.isArray(data) ? data : (data && data.events);
  if (!Array.isArray(events)) return null;
  return events.filter((e) => e && e.type === 'turn');
}

// Human name for a character id (falls back to the raw id).
function charName(id) {
  if (!id) return '?';
  if (typeof CONFIG !== 'undefined' && CONFIG.CHARACTERS && CONFIG.CHARACTERS[id]) {
    return CONFIG.CHARACTERS[id];
  }
  return id;
}

function sqName(s) {
  return s ? 'abcdefgh'[s.c] + (8 - s.r) : '?';
}

// One line of replay move-log text, matching main.js logMove's style.
function formatReplayLine(ev) {
  if (ev.failed) return 'AI failed to move: ' + (ev.reason || 'no move');
  const m = ev.move;
  if (!m) return '?';
  const f = m.flags || {};
  let text = charName(m.pieceCharacter) + ' ' + sqName(m.from) + '\u2192' + sqName(m.to);
  if (f.isCastle) text += ' (castle ' + (f.isCastle === 'k' ? 'K' : 'Q') + ')';
  if (f.isEnPassant) text += ' (en passant)';
  if (f.castleEnPassant) text += ' (castle en passant!)';
  if (f.isPromotion) text += ' \u2192 ' + String(f.promotionPiece || '?').toUpperCase();
  if (m.capturedCharacter) text += ' \u00d7 ' + charName(m.capturedCharacter);
  return text;
}

// The fight banner text for a capture event (or null if the event has no
// fight). Describes who won the contested fight and what happened to the
// pieces, from the player's (white's) perspective.
function fightBannerText(ev) {
  const cap = ev.capture;
  if (!cap) return null;
  const boss = charName(cap.bossId);
  const diff = cap.difficulty === 'lunatic' ? 'Lunatic' : 'Normal';
  const won = cap.result === 'win';
  const playerInitiated = cap.initiator === 'player';
  const moverName = charName(ev.move && ev.move.pieceCharacter);
  const targetName = charName(ev.move && ev.move.capturedCharacter);
  if (won) {
    return playerInitiated
      ? '\u2691 ' + boss + ' (' + diff + ') \u2014 Spell Card Break! ' + targetName + ' is removed.'
      : '\u2691 ' + boss + ' (' + diff + ') \u2014 you held the line! ' + moverName + ' survives.'
  }
  return playerInitiated
    ? '\u2691 ' + boss + ' (' + diff + ') \u2014 you lost the fight. ' + moverName + ' is removed.'
    : '\u2691 ' + boss + ' (' + diff + ') \u2014 it got through. ' + moverName + ' is removed.';
}

class ReplayViewer {
  constructor(modalEl, boardEl) {
    this.modalEl = modalEl;
    this.boardEl = boardEl;
    this.board = new Board();
    this.board.reset();
    this.ui = new BoardUI(boardEl, {
      onMove: () => {},
      readOnly: true,
      ids: {
        moveLog: 'replay-move-log',
        trayWhite: 'replay-tray-white',
        trayBlack: 'replay-tray-black',
        turnIndicator: 'replay-status',
        gameOverBanner: 'replay-banner',
        promotionPicker: 'replay-promotion-picker',
      },
    });
    this.events = []; // recorded turn events
    this.captured = []; // replay-local captured list ({ piece, byColor })
    this.index = 0; // number of events applied so far
    this.playing = false;
    this.timer = null;
    this.speed = 1; // 1 | 2 | 4
    this.onClose = null; // optional callback
    this._wireControls();
  }

  // --- controls -----------------------------------------------------------

  _wireControls() {
    const $ = (id) => document.getElementById(id);
    this.btnPlay = $('replay-btn-play');
    this.btnStep = $('replay-btn-step');
    this.btnStart = $('replay-btn-start');
    this.btnClose = $('replay-btn-close');
    this.speedSel = $('replay-speed');
    this.fileInput = $('replay-file-input');
    this.progressEl = $('replay-progress');
    this.bannerEl = $('replay-fight-banner');
    this.statusEl = $('replay-status');

    this.btnPlay.addEventListener('click', () => this.toggle());
    this.btnStep.addEventListener('click', () => this.stepOnce());
    this.btnStart.addEventListener('click', () => this.reset());
    this.btnClose.addEventListener('click', () => this.close());
    this.speedSel.addEventListener('change', () => {
      const v = Number(this.speedSel.value);
      this.speed = [1, 2, 4].includes(v) ? v : 1;
    });
    this.fileInput.addEventListener('change', () => this.loadFile(this.fileInput.files[0]));
    document.addEventListener('keydown', (e) => this._onKey(e));
  }

  _onKey(e) {
    if (this.modalEl.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    } else if (e.key === ' ') {
      e.preventDefault();
      this.toggle();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.stepOnce();
    }
  }

  // --- loading ------------------------------------------------------------

  // Load a log payload (envelope or array). Throws on invalid input.
  load(data) {
    const events = extractTurnEvents(data);
    if (!events) throw new Error('Not a Touhou Chess log (no events array).');
    if (events.length === 0) throw new Error('Log has no turn events.');
    this.events = events;
    this.reset();
    return events.length;
  }

  // Load an exported .json file (File object).
  loadFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        this.load(JSON.parse(reader.result));
        this._setStatus('Loaded ' + this.events.length + ' moves from ' + file.name);
      } catch (err) {
        this._setStatus('Could not load ' + file.name + ': ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  // Open the modal (optionally with a log payload).
  open(data) {
    this.modalEl.classList.remove('hidden');
    if (data !== undefined) {
      try {
        this.load(data);
      } catch (err) {
        // Still show the starting position; explain the problem in the status.
        this.reset();
        this._setStatus(err.message);
      }
    } else {
      this.reset();
    }
  }

  close() {
    this.pause();
    this.modalEl.classList.add('hidden');
    if (typeof this.onClose === 'function') this.onClose();
  }

  // --- playback -----------------------------------------------------------

  reset() {
    this.pause();
    this.board.reset();
    this.captured = [];
    this.index = 0;
    this.ui.clearLastMove();
    this.ui.clearLog();
    this.ui.render(this.board);
    this.ui.renderTrays(this.captured);
    this.ui.setGameOverBanner('');
    this._hideBanner();
    this._updateHud();
  }

  // Apply the next recorded event. Returns { done, error }.
  step() {
    if (this.index >= this.events.length) return { done: true };
    const ev = this.events[this.index];
    const res = applyTurnEvent(this.board, ev);
    if (!res.ok) {
      this._setStatus(
        'Replay stopped at move ' + (this.index + 1) + ': ' +
        (res.error === 'ai-failed'
          ? 'AI failed to move (' + (ev.reason || 'unknown') + ')'
          : res.error)
      );
      this.pause();
      return { done: true, error: res.error };
    }
    this.index++;

    if (res.kind === 'capture-fail') {
      // The capturing piece was removed from its origin; the render diff
      // fades it out automatically. Highlight only the origin square.
      this.captured.push({
        piece: res.removed,
        byColor: res.byColor === 'white' ? 'black' : 'white',
      });
      this.ui.setLastMove(res.move.from, res.move.from);
    } else {
      if (res.kind === 'capture-ok') {
        this.captured.push({ piece: res.captured, byColor: res.byColor });
      }
      this.ui.setLastMove(res.move.from, res.move.to);
    }
    this.ui.render(this.board);
    this.ui.renderTrays(this.captured);
    this.ui.logMove(this.index, formatReplayLine(ev));

    if (ev.capture) this._showBanner(fightBannerText(ev));
    else this._hideBanner();

    if (this.board.gameOver) {
      this.ui.setGameOverBanner(
        this.board.winner === 'white'
          ? 'The Protagonists (White) win!'
          : 'The Bosses (Black) win!'
      );
    }
    this._updateHud();
    return { done: this.index >= this.events.length };
  }

  stepOnce() {
    if (this.playing) this.pause();
    this.step();
  }

  play() {
    if (this.playing) return;
    if (this.index >= this.events.length) this.reset();
    this.playing = true;
    this._updateHud();
    this._tick();
  }

  pause() {
    this.playing = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this._updateHud();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  // One move, then schedule the next (longer pause after a contested fight).
  _tick() {
    if (!this.playing) return;
    const ev = this.events[this.index];
    const res = this.step();
    if (res.done || !this.playing) return;
    const delay = (ev && ev.capture ? 1700 : 750) / this.speed;
    this.timer = setTimeout(() => this._tick(), delay);
  }

  // --- HUD ------------------------------------------------------------------

  _updateHud() {
    const total = this.events.length;
    if (this.progressEl) {
      this.progressEl.textContent =
        total === 0 ? 'No moves recorded yet' : this.index + ' / ' + total;
    }
    if (this.btnPlay) {
      this.btnPlay.textContent = this.playing ? '\u23f8 Pause' : '\u25b6 Play';
      this.btnPlay.disabled = total === 0;
    }
    if (this.btnStep) this.btnStep.disabled = this.index >= total;
    if (this.btnStart) this.btnStart.disabled = this.index === 0;
  }

  _showBanner(text) {
    if (!this.bannerEl) return;
    this.bannerEl.textContent = text;
    this.bannerEl.classList.remove('hidden');
  }

  _hideBanner() {
    if (this.bannerEl) this.bannerEl.classList.add('hidden');
  }

  _setStatus(text) {
    if (this.statusEl) this.statusEl.textContent = text;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ReplayViewer,
    extractTurnEvents,
    formatReplayLine,
    fightBannerText,
  };
}
