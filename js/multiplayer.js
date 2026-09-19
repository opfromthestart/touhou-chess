// multiplayer.js — PVP controller for Touhou Chess.
//
// Two players (host = White, guest = Black) play a chess match over a PeerJS
// data channel (js/net/peer.js). Normal (non-capture) moves are synced 1:1.
// A capture triggers a simultaneous DANMAKU RACE on both sides:
//
//   • The CATCHER (the player who made the capturing move) flies a ship against
//     the youkai boss of the CAPTURED piece, at NORMAL difficulty.
//   • The DEFENDER (the other player) flies a ship against the youkai boss of
//     the CAPTURING piece's type, at LUNATIC difficulty.
//
//   Both players see BOTH fight screens: their own (controllable) and the
//   opponent's (a live spectator copy driven by the opponent's relayed input).
//   Whoever runs out of lives FIRST loses the race — that player's involved
//   piece is removed (catcher loses -> capturing piece removed; defender loses
//   -> captured piece removed). If the catcher wins the race the capture goes
//   through; if the catcher loses, the capture is undone.
//
// No build step: plain JS, loaded after board.js / ai.js / bosses.js /
// fight-ui.js / net/peer.js.

(function () {
  // =========================================================================
  // Roster helpers
  // =========================================================================
  const YOU = new Set();
  const AI = new Set();
  (function buildRosterSets() {
    for (const t in CONFIG.ROSTER) {
      CONFIG.ROSTER[t].you.forEach((c) => YOU.add(c));
      CONFIG.ROSTER[t].ai.forEach((c) => AI.add(c));
    }
  })();

  // The protagonist character that "flies the ship" for a piece. White pieces
  // already use protagonists; black pieces map to the same-type protagonist.
  function protagonistOf(piece) {
    return YOU.has(piece.character) ? piece.character : CONFIG.ROSTER[piece.type].you[0];
  }
  // The youkai boss that "runs the danmaku" for a piece. Black pieces already
  // use youkai; white pieces map to the same-type youkai (so every fight is a
  // protagonist-vs-youkai, matching the AI version's theme).
  function youkaiOf(piece) {
    return AI.has(piece.character) ? piece.character : CONFIG.ROSTER[piece.type].ai[0];
  }

  // =========================================================================
  // State
  // =========================================================================
  let board = null;
  let ui = null;
  let captured = [];
  let myColor = null;   // 'white' | 'black'
  let oppColor = null;
  let myName = '';      // player display name (entered in the connect modal)
  let oppName = '';     // opponent's display name (received in their hello)
  const NAME_KEY = 'tc-mp-player-name';
  const NAME_MAX = 16;
  let engines = {};     // { own: DanmakuEngine, opp: DanmakuEngine (spectator) }
  let race = null;      // { attackerColor, move, results:{attacker,defender}, resolved }
  let inRace = false;
  let raceStartLocal = 0; // performance.now() at race start (loss-time reference)
  let gameOver = false;
  let raceCount = 0;
  let logCounter = 0;   // running number for the on-screen fight/move log
  let connected = false;
  let helloReceived = false;
  let inputTimer = null;
  let raceStartTimer = null; // pending "danmaku incoming" beat before a race
  let raceCountdownTimer = null; // pre-fight countdown ticker (visual only)
  let els = {};

  // Network telemetry (js/net/telemetry.js) — semantic game-side events that
  // complement the per-message send/recv records peer.js writes. No-op when
  // telemetry.js isn't loaded.
  function nlog(kind, data) {
    if (typeof NetLog !== 'undefined') NetLog.push(kind, data);
  }
  const round2 = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x);

  // =========================================================================
  // DOM wiring
  // =========================================================================
  function init() {
    cacheEls();
    wireButtons();
  }

  function cacheEls() {
    const $ = (id) => document.getElementById(id);
    els.btnMp = $('btn-multiplayer');
    els.connectModal = $('mp-connect-modal');
    els.hostBtn = $('mp-host-btn');
    els.joinBtn = $('mp-join-btn');
    els.closeConnect = $('mp-close-connect');
    els.codeDisplay = $('mp-code-display');
    els.codeValue = $('mp-code-value');
    els.codeInput = $('mp-code-input');
    els.nameInput = $('mp-name-input');
    els.joinRow = $('mp-join-row');
    els.netStatus = $('mp-net-status');
    els.fightOverlay = $('mp-fights-overlay');
    els.countdown = $('mp-countdown');
    els.countdownNum = $('mp-countdown-num');
    // Topbar chips (updated for PVP).
    els.chipYouName = $('chip-you-name');
    els.chipYouSub = $('chip-you-sub');
    els.chipOppName = $('chip-opp-name');
    els.chipOppSub = $('chip-opp-sub');
    // Side-panel player cards (names swapped in when a PVP match starts).
    els.pcardYouName = $('pcard-you-name');
    els.pcardBossName = $('pcard-boss-name');
    // Side panel controls (AI-specific ones are hidden in PVP).
    els.aiStrength = $('ai-strength');
    els.aiStrengthLabel = $('ai-strength-label');
    els.leaveBtn = $('mp-leave-btn');
    // PVP result modal (separate from the AI game-over modal).
    els.resultModal = $('mp-result-modal');
    els.resultTitle = $('mp-result-title');
    els.resultSub = $('mp-result-sub');
    els.resultStats = $('mp-result-stats');
    els.resultBtn = $('mp-result-btn');
    // Multiplayer chat (PVP only).
    els.chatPanel = $('chat-panel');
    els.chatLog = $('chat-log');
    els.chatInput = $('chat-input');
    els.chatSendBtn = $('chat-send-btn');
  }

  function wireButtons() {
    if (els.btnMp) els.btnMp.addEventListener('click', openConnect);
    if (els.hostBtn) els.hostBtn.addEventListener('click', hostGame);
    if (els.joinBtn) els.joinBtn.addEventListener('click', () => joinGame(els.codeInput.value));
    if (els.closeConnect) els.closeConnect.addEventListener('click', closeConnect);
    if (els.leaveBtn) els.leaveBtn.addEventListener('click', leave);
    if (els.resultBtn) els.resultBtn.addEventListener('click', leave);
    // Enter-to-join.
    if (els.codeInput) els.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinGame(els.codeInput.value);
    });
    // Chat: send on click or Enter.
    if (els.chatSendBtn) els.chatSendBtn.addEventListener('click', sendChat);
    if (els.chatInput) els.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChat();
    });
  }

  function inMultiplayer() {
    return connected || !!myColor;
  }

  // =========================================================================
  // Connect flow
  // =========================================================================
  function openConnect() {
    if (!els.connectModal) return;
    setConnectMode('idle');
    // Prefill the display name from the last match (best-effort).
    if (els.nameInput && !els.nameInput.value) {
      try { els.nameInput.value = localStorage.getItem(NAME_KEY) || ''; } catch (e) {}
    }
    els.connectModal.classList.remove('hidden');
  }

  // Read and normalize the player's chosen display name. Falls back to a
  // role-based name if left blank, and remembers it for next time.
  function readMyName(fallback) {
    const raw = els.nameInput ? els.nameInput.value : '';
    const name = raw.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    myName = name || fallback;
    try { if (name) localStorage.setItem(NAME_KEY, name); } catch (e) {}
    return myName;
  }

  function closeConnect() {
    if (!els.connectModal) return;
    els.connectModal.classList.add('hidden');
    // Tear down any in-progress connection attempt.
    if (window.TCNet) window.TCNet.close();
    setNetStatus('');
  }

  function setConnectMode(mode) {
    // mode: 'idle' | 'hosting' | 'joining'. Once an action is taken the buttons
    // lock until the modal is closed (which also tears the connection down).
    const busy = mode !== 'idle';
    if (els.hostBtn) els.hostBtn.disabled = busy;
    if (els.joinBtn) els.joinBtn.disabled = busy;
    if (els.codeInput) els.codeInput.disabled = busy;
    if (els.codeDisplay) els.codeDisplay.style.display = mode === 'hosting' ? 'block' : 'none';
  }

  function setNetStatus(text, isError) {
    if (!els.netStatus) return;
    els.netStatus.textContent = text;
    els.netStatus.classList.toggle('error', !!isError);
  }

  function hostGame() {
    readMyName('Player 1');
    setConnectMode('hosting');
    setNetStatus('Creating room…');
    // Fresh debug log for this match — cleared HERE (not in beginGame) so the
    // exported log keeps the connection handshake + net telemetry from the
    // moment the session starts.
    if (typeof GameLog !== 'undefined') GameLog.clear();
    window.TCNet.name = myName;
    window.TCNet.host(netHandlers());
  }

  function joinGame(code) {
    if (!code || code.trim().length < 3) { setNetStatus('Enter a valid room code.', true); return; }
    readMyName('Player 2');
    setConnectMode('joining');
    setNetStatus('Connecting…');
    if (typeof GameLog !== 'undefined') GameLog.clear();
    window.TCNet.name = myName;
    window.TCNet.join(code, netHandlers());
  }

  function netHandlers() {
    return {
      onStatus: onNetStatus,
      onMessage: onNetMessage,
      onClose: onNetClose,
    };
  }

  function onNetStatus(status, detail) {
    setNetStatus(detail || status, status === 'error');
    if (status === 'connected') {
      connected = true;
      // The host's data channel only opens when the guest joins with the room
      // code, so chime a "ding-dong" to let them know someone is here.
      if (TCNet.role === 'host') sfxPlay('join');
      // Handshake: wait for the opponent's hello before starting.
      if (!helloReceived) { /* waiting */ }
    }
    if (status === 'waiting') {
      // Host is ready; show the code prominently so it can be shared.
      if (TCNet.code) {
        if (els.codeValue) els.codeValue.textContent = TCNet.code;
        if (els.codeDisplay) els.codeDisplay.style.display = 'block';
      }
    }
  }

  function onNetClose() {
    if (gameOver) return;
    nlog('session', { what: 'end', reason: 'disconnect' });
    if (inMultiplayer()) {
      // Tear down any in-flight race so engines/relay don't keep running.
      if (inputTimer) { clearInterval(inputTimer); inputTimer = null; }
      if (raceStartTimer) { clearTimeout(raceStartTimer); raceStartTimer = null; }
      stopEngines();
      closeFightOverlay();
      inRace = false;
      showDisconnectNotice();
    }
  }

  // Game messages from the opponent.
  function onNetMessage(data) {
    switch (data.type) {
      case 'hello':
        helloReceived = true;
        // Their display name arrives with the hello; show it immediately.
        if (data.name) {
          oppName = String(data.name).slice(0, NAME_MAX);
          updateTopbarChips();
          updatePcardNames();
        }
        // Both sides send hello on connect; start once we've got theirs.
        if (connected && !board) beginGame();
        break;
      case 'move':
        receiveMove(data.move);
        break;
      case 'fight-result':
        onOppFightResult(data.side, data.result, data.lossElapsed);
        break;
      case 'input':
        applyRemoteInput(data.state);
        break;
      case 'race-end':
        // Opponent resolved the race and is telling us the agreed outcome
        // (safety sync). We apply it immediately so we don't have to wait for
        // our own engine to end. This is safe: the opponent's outcome was
        // derived from authoritative data (its own engine + our fight-result),
        // and both clients compare the same authoritative end-times, so they
        // agree. If we already resolved (same outcome), this is a no-op.
        if (data.outcome === 'success' || data.outcome === 'fail') {
          resolveRace(data.outcome, 'remote-race-end', true);
        }
        break;
      case 'chat':
        appendChat(oppName || 'Opponent', data.text, false);
        break;
      default:
        break;
    }
  }

  // =========================================================================
  // Chat
  // =========================================================================
  const CHAT_MAX = 200;

  // Send a chat message to the opponent (and echo it locally). No-op when not
  // connected or the message is empty.
  function sendChat() {
    if (!els.chatInput) return;
    const text = els.chatInput.value.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
    if (!text) return;
    els.chatInput.value = '';
    appendChat(myName || 'You', text, true);
    TCNet.send({ type: 'chat', text });
  }

  // Append a line to the chat log. `mine` marks it as our own message so it can
  // be styled differently. Uses textContent (never innerHTML) so an opponent's
  // message can't inject markup.
  function appendChat(sender, text, mine) {
    if (!els.chatLog) return;
    const li = document.createElement('li');
    li.className = mine ? 'chat-mine' : 'chat-theirs';
    const who = document.createElement('span');
    who.className = 'chat-sender';
    who.textContent = sender + ':';
    const body = document.createElement('span');
    body.className = 'chat-text';
    body.textContent = text;
    li.appendChild(who);
    li.appendChild(body);
    els.chatLog.appendChild(li);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function clearChat() {
    if (els.chatLog) els.chatLog.innerHTML = '';
  }

  // =========================================================================
  // Game setup
  // =========================================================================
  function beginGame() {
    // Assign sides by role: host = white, guest = black.
    myColor = TCNet.role === 'host' ? 'white' : 'black';
    oppColor = myColor === 'white' ? 'black' : 'white';
    raceCount = 0;
    logCounter = 0;
    gameOver = false;
    inRace = false;
    captured = [];
    // (The debug log is cleared in hostGame/joinGame, before the session
    // starts, so the net telemetry from the handshake survives.)
    nlog('session', { what: 'game-start', myColor });

    board = new Board();
    board.reset();

    // Take over the board element with our own UI. Building a fresh BoardUI
    // clears #board and rebinds clicks to onMyMove, so the dormant AI-mode game
    // (which only advances on player moves) can no longer interfere.
    const boardEl = document.getElementById('board');
    ui = new BoardUI(boardEl, { onMove: onMyMove });
    ui.render(board);
    // Each player views the board from their own side: the guest (black) sees
    // their pieces at the bottom, the host (white) sees theirs at the bottom.
    ui.setFlipped(myColor === 'black');
    ui.renderTrays(captured);
    ui.clearLog();

    // Hide the connect modal and AI-specific controls; show PVP chrome.
    if (els.connectModal) els.connectModal.classList.add('hidden');
    if (els.aiStrength) els.aiStrength.style.display = 'none';
    if (els.aiStrengthLabel) els.aiStrengthLabel.style.display = 'none';
    if (els.leaveBtn) els.leaveBtn.classList.remove('hidden');
    // Reveal the PVP chat panel with a fresh log.
    clearChat();
    if (els.chatPanel) els.chatPanel.classList.remove('hidden');
    appendSystemChat('Match started — good luck!');
    updateTopbarChips();
    updatePcardNames();

    setTurnLabel();
  }

  // A non-player line in the chat log (system notices).
  function appendSystemChat(text) {
    if (!els.chatLog) return;
    const li = document.createElement('li');
    li.className = 'chat-system';
    li.textContent = text;
    els.chatLog.appendChild(li);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function updateTopbarChips() {
    const label = (c) => c === 'white' ? 'White · Protagonists' : 'Black · Bosses';
    if (els.chipYouName) els.chipYouName.textContent = myName || 'You';
    if (els.chipYouSub) els.chipYouSub.textContent = label(myColor);
    if (els.chipOppName) els.chipOppName.textContent = oppName || 'Opponent';
    if (els.chipOppSub) els.chipOppSub.textContent = label(oppColor);
  }

  // In PVP the side-panel player cards show the players' chosen names instead
  // of the placeholder characters (Reimu / Kaguya).
  function updatePcardNames() {
    if (els.pcardYouName) els.pcardYouName.textContent = myName || 'Reimu Hakurei';
    if (els.pcardBossName) els.pcardBossName.textContent = oppName || 'Kaguya Houraisan';
  }

  function setTurnLabel() {
    if (gameOver) return;
    if (inRace) {
      ui.setTurnIndicator('⚡ Danmaku race!');
      return;
    }
    if (board.turn === myColor) {
      ui.setTurnIndicator('Your move (' + myColor + ')');
    } else {
      ui.setTurnIndicator((oppName ? oppName + '’s' : 'Opponent’s') + ' move…');
    }
  }

  // =========================================================================
  // Chess moves
  // =========================================================================
  // Called by the local BoardUI when the player makes a move.
  function onMyMove(move) {
    if (gameOver || inRace) return;
    if (board.turn !== myColor) return; // only move on your turn
    sfxPlay('move');
    if (move.captured) {
      // Capture -> hold the move pending and run the danmaku race. Both sides
      // must start the race, so transmit the move too: the opponent's
      // receiveMove() also routes captures into startRace(). The board change
      // is applied later by resolveRace(), identically on both clients.
      nlog('move', { what: 'send', from: sqName(move.from), to: sqName(move.to), captured: true });
      startRace(move);
      TCNet.send({ type: 'move', move: serializeMove(move) });
    } else {
      nlog('move', { what: 'send', from: sqName(move.from), to: sqName(move.to), captured: false });
      applyMoveToBoard(move, myColor);
      TCNet.send({ type: 'move', move: serializeMove(move) });
      mpLogTurn(myColor, move, null);
    }
  }

  // A move from the opponent.
  function receiveMove(move) {
    // Rejections are logged: a move dropped here (wrong turn, mid-race, or
    // game over) is exactly how a one-move desync becomes a permanent
    // deadlock, and it was previously invisible.
    if (gameOver || inRace) {
      nlog('reject', { what: 'move', reason: gameOver ? 'game-over' : 'in-race' });
      return;
    }
    if (board.turn !== oppColor) {
      nlog('reject', { what: 'move', reason: 'turn-mismatch', turn: board.turn, expected: oppColor });
      return;
    }
    nlog('move', { what: 'recv', from: sqName(move.from), to: sqName(move.to), captured: !!move.captured });
    sfxPlay('move');
    if (move.captured) {
      startRace(move);
    } else {
      applyMoveToBoard(move, oppColor);
      mpLogTurn(oppColor, move, null);
    }
  }

  function applyMoveToBoard(move, byColor) {
    board.applyMove(move);
    if (move.captured) {
      captured.push({ piece: move.captured, byColor });
    }
    ui.setLastMove(move.from, move.to);
    ui.render(board);
    ui.renderTrays(captured);
    afterMoveSettled(byColor, move);
  }

  function afterMoveSettled(byColor, move) {
    logMoveEntry(move, byColor);
    if (board.gameOver) {
      endGame(board.winner);
      return;
    }
    setTurnLabel();
  }

  // Human-readable name for whoever made a move (falls back to You/Opponent).
  function moverName(byColor) {
    return byColor === myColor ? (myName || 'You') : (oppName || 'Opponent');
  }

  function sqName({ row, col }) {
    return FILES[col] + (8 - row);
  }

  // Append a move line to the on-screen fight log (mirrors main.js formatting).
  function logMoveEntry(move, byColor) {
    if (!move || !ui) return;
    const pieceName = CONFIG.CHARACTERS[move.piece.character];
    let text = `${pieceName} ${sqName(move.from)}→${sqName(move.to)}`;
    if (move.isCastle) text += ` (castle ${move.isCastle === 'k' ? 'K' : 'Q'})`;
    if (move.isEnPassant) text += ' (en passant)';
    if (move.castleEnPassant) text += ' (castle en passant!)';
    if (move.isPromotion) text += ` → ${move.promotionPiece.toUpperCase()}`;
    if (move.captured) {
      text += ` × ${CONFIG.CHARACTERS[move.captured.character]}`;
    }
    text += `  <em>(${moverName(byColor)})</em>`;
    logCounter++;
    ui.logMove(logCounter, text);
  }

  // Log a contested capture that FAILED: the attacker lost the danmaku race and
  // their own piece was removed instead (mirrors main.js logFightResult).
  function logFailedAttack(move) {
    if (!move || !ui) return;
    const moverName_ = CONFIG.CHARACTERS[move.piece.character];
    const targetName = CONFIG.CHARACTERS[move.captured.character];
    const text = `${moverName_} (${moverName(move.piece.color)}) attacked ${targetName} ` +
      `but lost the danmaku race — ${moverName_} was captured!`;
    logCounter++;
    ui.logMove(logCounter, text);
  }

  function serializeMove(move) {
    return {
      from: { row: move.from.row, col: move.from.col },
      to: { row: move.to.row, col: move.to.col },
      piece: { type: move.piece.type, color: move.piece.color, character: move.piece.character, hasMoved: move.piece.hasMoved },
      captured: move.captured
        ? { type: move.captured.type, color: move.captured.color, character: move.captured.character }
        : null,
      isCastle: move.isCastle || null,
      middle: move.middle || null,
      isPromotion: !!move.isPromotion,
      promotionPiece: move.promotionPiece || null,
      isDoublePawn: !!move.isDoublePawn,
      isEnPassant: !!move.isEnPassant,
    };
  }

  // =========================================================================
  // Debug logging (GameLog) — mirrors main.js so a PVP match exports a
  // replayable log (see js/debug/log.js + replay.js). Without this, a buggy
  // PVP game (e.g. "neither player could make a move") exports an empty log.
  // =========================================================================

  // Serialize a move into the replay format main.js's log uses (from/to as
  // { r, c }), which is what replay.js expects. (The network serializer above
  // uses { row, col }; this one is for the on-disk log only.)
  function mpSerializeMove(move) {
    if (!move) return null;
    return {
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
    };
  }

  // The contested-capture record for a race turn. `applyCapture` is the field
  // replay.js actually uses (apply the move vs. remove the capturing piece);
  // the rest is informational.
  function mpCaptureInfo(move, attackerColor, applyCapture) {
    return {
      bossId: move.captured ? youkaiOf(move.captured) : null,
      difficulty: 'normal',
      initiator: attackerColor,
      playerPieceType: move.piece.type,
      result: applyCapture ? 'win' : 'lose',
      applyCapture,
    };
  }

  // Record one turn (a move, plus its contested capture if any) to GameLog.
  function mpLogTurn(side, move, capture) {
    if (typeof GameLog === 'undefined') return;
    const ev = GameLog.push('turn', {
      side,
      move: mpSerializeMove(move),
      capture: capture || null,
      failed: false,
      reason: null,
      state: { turn: board.turn, gameOver: board.gameOver, winner: board.winner },
    });
    if (typeof console !== 'undefined') console.log('[GameLog]', GameLog.summaryLine(ev));
  }

  // =========================================================================
  // Danmaku race
  // =========================================================================
  function startRace(move) {
    inRace = true;
    raceStartLocal = performance.now();
    const attackerColor = move.piece.color; // the mover is the catcher
    race = {
      attackerColor,
      move,
      results: { attacker: null, defender: null },
      resolved: false,
    };
    setTurnLabel();

    // Build the two fights (identical on both clients).
    const fights = buildFights(move);

    // Race lifecycle telemetry: the full sequence (start → engines-start →
    // end-own/end-spect/result-recv → resolve) on both clients is what shows
    // whether a desync came from message timing or from divergent resolution.
    nlog('race', {
      what: 'start',
      from: sqName(move.from),
      to: sqName(move.to),
      attacker: attackerColor,
      boss: fights.attacker.bossId,
    });

    // Open the dual-screen window IMMEDIATELY and show a countdown; the
    // engines (and the game clock) start when the countdown finishes. This
    // keeps the DEFENDER from being blindsided — the window is up and counting
    // 3-2-1 before the first bullet fires. Both clients apply the same
    // countdown before the game clock starts, so it does not affect race
    // resolution or cross-client sync.
    ui.setTurnIndicator('\u26a1 Capture! Danmaku incoming\u2026');
    openFightOverlay(fights);
    startRaceCountdown(CONFIG.DANMAKU_START_DELAY_MS);
    if (raceStartTimer) clearTimeout(raceStartTimer);
    raceStartTimer = setTimeout(() => {
      raceStartTimer = null;
      stopRaceCountdown();
      if (!inRace || !race) return; // torn down (disconnect/leave) during the countdown
      startEngines(fights);
      nlog('race', { what: 'engines-start' });

      // Relay my input to the opponent while the race runs.
      if (inputTimer) clearInterval(inputTimer);
      inputTimer = setInterval(sendInputTick, CONFIG.MP_INPUT_INTERVAL_MS);
    }, CONFIG.DANMAKU_START_DELAY_MS);
  }

  // Show the 3-2-1 countdown over the fight window while the pre-fight
  // countdown runs. Purely visual — the engines start on the raceStartTimer.
  function startRaceCountdown(totalMs) {
    stopRaceCountdown();
    if (!els.countdown || !els.countdownNum) return;
    els.countdown.classList.remove('hidden');
    const endAt = performance.now() + totalMs;
    const tick = () => {
      const remain = Math.max(0, endAt - performance.now());
      els.countdownNum.textContent = String(Math.max(1, Math.ceil(remain / 1000)));
    };
    tick();
    raceCountdownTimer = setInterval(tick, 100);
  }

  function stopRaceCountdown() {
    if (raceCountdownTimer) { clearInterval(raceCountdownTimer); raceCountdownTimer = null; }
    if (els.countdown) els.countdown.classList.add('hidden');
  }

  // Compute the two fight parameter sets for a capture move.
  //   attacker (catcher):  ship = protagonistOf(attacking piece),
  //                        boss = youkaiOf(captured piece),       NORMAL
  //   defender:            ship = protagonistOf(captured piece),
  //                        boss = youkaiOf(attacking piece's type), LUNATIC
  function buildFights(move) {
    const attacking = move.piece;       // the moving (catcher's) piece
    const target = move.captured;       // the piece being captured
    return {
      attacker: {
        role: 'attacker',
        shipChar: protagonistOf(attacking),
        bossId: youkaiOf(target),
        difficulty: 'normal',
        playerPieceType: attacking.type,
        phases: getPhases(youkaiOf(target), 'normal'),
      },
      defender: {
        role: 'defender',
        shipChar: protagonistOf(target),
        bossId: youkaiOf(attacking),
        difficulty: 'lunatic',
        playerPieceType: target.type,
        phases: getPhases(youkaiOf(attacking), 'lunatic'),
      },
    };
  }

  function startEngines(fights) {
    stopEngines();
    const IamAttacker = myColor === race.attackerColor;
    // My OWN fight (controllable) is the side matching my color.
    const ownFight = IamAttacker ? fights.attacker : fights.defender;
    const oppFight = IamAttacker ? fights.defender : fights.attacker;

    // makeEngine() already starts each engine with its full fight params, so
    // we must NOT call start() again here (a no-arg start() would re-init with
    // undefined stats and throw).
    engines.own = makeEngine('own', ownFight, false, onOwnEnd);
    engines.opp = makeEngine('opp', oppFight, true, onSpectatorEnd);
  }

  // Create a DanmakuEngine bound to a canvas and a fight param set. `which`
  // is 'own' (locally controllable) or 'opp' (a spectator copy driven by the
  // opponent's relayed input). Both run the SAME phases/seed for a given side,
  // so the bullet field is identical — only the input differs.
  function makeEngine(which, fight, externalInput, onEnd) {
    const canvas = document.getElementById('mp-canvas-' + which);
    const boss = BOSSES[fight.bossId];
    const stats = CONFIG.DANMAKU_STATS[fight.playerPieceType] || CONFIG.DANMAKU_STATS.p;
    const engine = new DanmakuEngine(canvas, {
      onPhase: () => {},
      onHud: (hud) => updateFightHud(which, hud),
      onEnd: (result) => onEnd(result),
    });
    engine.externalInput = externalInput;
    engine.playerColor = shipColorForPiece(fight.playerPieceType);
    engine.start(fight.phases, {
      color: boss.color,
      bgTop: boss.bgTop,
      bgBottom: boss.bgBottom,
      move: boss.move,
      charId: fight.bossId,
    }, stats, fight.playerPieceType, fight.shipChar);
    return engine;
  }

  function stopEngines() {
    if (engines.own) { try { engines.own.stop(); } catch (e) {} }
    if (engines.opp) { try { engines.opp.stop(); } catch (e) {} }
    engines = {};
  }

  // =========================================================================
  // Race resolution
  //
  // The race is won by whoever does NOT run out of lives first. To make the
  // outcome DETERMINISTIC and IDENTICAL on both clients (no desync when both
  // players die within the network latency window), we resolve ONLY from
  // AUTHORITATIVE data:
  //
  //   • Each fight's end time is measured in the engine's fixed-step GAME clock
  //     (engine.time, seconds). A result is AUTHORITATIVE for a side only when
  //     it comes from that side's REAL engine: my own engine (local) or the
  //     opponent's 'fight-result' message (their own engine's end).
  //   • My spectator copy of the opponent's fight is NOT authoritative — it is
  //     driven by delayed relayed input, so it can die earlier or later than
  //     the real ship. It is recorded as an estimate but never decides the
  //     race on its own. (Relying on it is exactly what desynced the logs:
  //     each client's spectator copy died while its own engine was still alive,
  //     so each resolved in its own favor and both players thought they won.)
  //   • The race resolves when BOTH sides have authoritative results, by
  //     comparing the two game-clock end-times: the side that ran out of lives
  //     at the EARLIER time loses. Both clients compare the SAME two
  //     authoritative times, so they always agree regardless of the order
  //     events arrive. A single safe early-exit exists: if the opponent's
  //     authoritative result is 'lose' and my own engine is still running, the
  //     opponent necessarily died first, so I win now (the other client cannot
  //     take that path and reaches the same outcome via the full comparison).
  // =========================================================================

  // Game-clock (seconds) at which a given engine ended. Deterministic and
  // consistent across clients for the same fight.
  function engineTime(which) {
    const e = engines[which];
    return (e && typeof e.time === 'number') ? e.time : Infinity;
  }

  // Which engine ('own' | 'opp') corresponds to a logical side.
  function engineForSide(side) {
    const iAmAttacker = myColor === race.attackerColor;
    const iAmThisSide = (side === 'attacker') === iAmAttacker;
    return iAmThisSide ? 'own' : 'opp';
  }

  // Record a fight's outcome. `authoritative` marks whether this result comes
  // from that side's REAL engine (my own engine, or the opponent's
  // 'fight-result' message) or from my spectator copy of the opponent's fight
  // (driven by delayed relayed input, so it can die earlier or later than the
  // real ship). An authoritative result supersedes any prior spectator
  // estimate; for repeated 'lose' reports we keep the EARLIEST game-clock time
  // (the true moment the ship ran out of lives).
  function recordResult(side, result, gameTime, authoritative) {
    if (!race || race.resolved) return;
    const existing = race.results[side];
    if (!existing) {
      race.results[side] = { result, lossElapsed: gameTime, authoritative: !!authoritative };
    } else if (authoritative) {
      // Authoritative result supersedes any prior (spectator) estimate.
      existing.result = result;
      existing.lossElapsed = gameTime;
      existing.authoritative = true;
    } else if (!existing.authoritative && existing.result === 'lose' && result === 'lose' && gameTime < existing.lossElapsed) {
      existing.lossElapsed = gameTime;
    }
  }

  // Defer the resolution decision to the next animation frame so that if both
  // engines end in the same frame, both results are recorded before we decide.
  let resolveFrame = null;
  function scheduleResolve() {
    if (resolveFrame != null) return;
    const r = race; // guard against a stale frame from a previous race
    resolveFrame = requestAnimationFrame(() => {
      resolveFrame = null;
      if (r !== race) return; // a new race has since started
      doResolveCheck(r);
    });
  }

  function doResolveCheck(r) {
    if (!r || r !== race || r.resolved) return;
    const a = r.results.attacker;
    const d = r.results.defender;
    // A side's result is AUTHORITATIVE only when it comes from that side's real
    // engine: my own engine (local) or the opponent's 'fight-result' message.
    // My spectator copy of the opponent's fight is NOT authoritative — it is
    // driven by delayed relayed input, so it can die earlier or later than the
    // real ship. It must never decide the race on its own, or the two clients
    // can observe different first-deaths and each resolve in its own favor
    // (the desync in desynclog/*.json: both players think they won).
    const aAuth = !!(a && a.authoritative);
    const dAuth = !!(d && d.authoritative);
    // Both authoritative results present -> decide by earliest 'lose'. Both
    // clients compare the SAME two authoritative game-clock times, so they
    // always agree regardless of the order events arrive.
    if (aAuth && dAuth) return resolveByResults(a, d);
    // Safe premature: the OPPONENT's authoritative result is 'lose' (they
    // really died) and MY OWN engine is still running (I really am alive). The
    // opponent necessarily ran out of lives first -> I win the race. This is
    // the only early-exit that is safe: it relies solely on authoritative
    // signals (the opponent's message + my own engine), never on the spectator
    // copy. The other client cannot take this path in the same scenario (its
    // own engine is the one that died), so the two clients still agree: the
    // non-premature client waits for both authoritative results and reaches the
    // same outcome via resolveByResults.
    const iAmAttacker = myColor === r.attackerColor;
    const mySide = iAmAttacker ? 'attacker' : 'defender';
    const oppSide = iAmAttacker ? 'defender' : 'attacker';
    const opp = r.results[oppSide];
    if (opp && opp.authoritative && opp.result === 'lose' && engineRunning(mySide)) {
      return resolveRace(iAmAttacker ? 'success' : 'fail', 'premature-opp-dead');
    }
    // Otherwise: wait for the remaining authoritative result (it arrives when
    // that side's real engine ends and sends its 'fight-result' message).
  }

  function engineRunning(side) {
    const e = engines[engineForSide(side)];
    return !!(e && e.running);
  }

  function resolveByResults(a, d) {
    const aLose = a.result === 'lose', dLose = d.result === 'lose';
    if (aLose && dLose) {
      // Both ran out of lives: the earlier game-clock time died first.
      return resolveRace(a.lossElapsed <= d.lossElapsed ? 'fail' : 'success', 'both-died-earlier-loses');
    }
    if (aLose) return resolveRace('fail', 'attacker-lost');     // attacker lost, defender survived
    if (dLose) return resolveRace('success', 'defender-lost');  // defender lost, attacker survived
    return resolveRace('fail', 'stalemate');                    // both survived -> stalemate
  }

  // My own (controllable) fight ended. AUTHORITATIVE for my side.
  function onOwnEnd(result) {
    if (!race || race.resolved) return;
    const side = myColor === race.attackerColor ? 'attacker' : 'defender';
    const t = engineTime('own');
    recordResult(side, result, t, true);
    nlog('race', { what: 'end-own', side, result, gameTime: round2(t) });
    // Authoritative: tell the opponent my result (game-clock time).
    TCNet.send({ type: 'fight-result', side, result, lossElapsed: t });
    scheduleResolve();
  }

  // My spectator copy of the opponent's fight ended. This observes the
  // opponent's end time LOCALLY (in the shared game clock) without waiting for
  // their message, but it is NOT authoritative — relayed input is delayed, so
  // the spectator ship can die earlier or later than the real one. It is
  // recorded only as an estimate; the resolver never decides on it alone.
  function onSpectatorEnd(result) {
    if (!race || race.resolved) return;
    const side = myColor === race.attackerColor ? 'defender' : 'attacker';
    const t = engineTime('opp');
    recordResult(side, result, t, false);
    nlog('race', { what: 'end-spect', side, result, gameTime: round2(t) });
    scheduleResolve();
  }

  // The opponent's authoritative result (their real engine's end, relayed as a
  // 'fight-result' message). AUTHORITATIVE for their side — the fallback when
  // our spectator copy did not detect the end, e.g. due to input-relay lag.
  function onOppFightResult(side, result, lossElapsed) {
    if (!race || race.resolved) return;
    recordResult(side, result, lossElapsed, true);
    nlog('race', { what: 'result-recv', side, result, lossElapsed: round2(lossElapsed) });
    scheduleResolve();
  }

  // `fromRemote` is true when this resolution was triggered by the opponent's
  // 'race-end' safety-sync message (see onNetMessage). In that case we apply
  // the agreed outcome locally but do NOT echo another 'race-end' back (the
  // opponent already resolved; re-sending would just bounce the message).
  function resolveRace(outcome, path, fromRemote) {
    if (!race || race.resolved) return;
    race.resolved = true;
    inRace = false;
    // What this client decided, how, and with which results — compared against
    // the opponent's resolve event in the exported logs, this is the smoking
    // gun for a divergent-resolution desync.
    nlog('race', {
      what: 'resolve',
      outcome,
      path: path || null,
      results: {
        attacker: race.results.attacker,
        defender: race.results.defender,
      },
    });
    if (inputTimer) { clearInterval(inputTimer); inputTimer = null; }
    stopEngines();
    closeFightOverlay();

    const move = race.move;
    if (outcome === 'success') {
      // Capture goes through.
      sfxPlay('capture');
      applyMoveToBoard(move, race.attackerColor);
      mpLogTurn(race.attackerColor, move, mpCaptureInfo(move, race.attackerColor, true));
    } else {
      // Capture fails: the capturing piece is removed, turn is consumed.
      board.removePiece(move.from.row, move.from.col);
      captured.push({ piece: move.piece, byColor: oppColorOf(race.attackerColor) });
      logFailedAttack(move);
      flipTurnLocal();
      // Consume castle en passant right if the mover held it.
      if (board.castleEnPassant && board.castleEnPassant.color === move.piece.color) {
        board.castleEnPassant = null;
      }
      ui.render(board);
      ui.renderTrays(captured);
      mpLogTurn(race.attackerColor, move, mpCaptureInfo(move, race.attackerColor, false));
    }
    raceCount++;
    // Safety sync: tell the opponent the agreed outcome so it can apply it
    // immediately, even if its own engine is still running (it cannot resolve
    // on its own until its engine ends, which may be many seconds later).
    if (!fromRemote) TCNet.send({ type: 'race-end', outcome });

    if (board.gameOver) {
      endGame(board.winner);
      return;
    }
    setTurnLabel();
  }

  function oppColorOf(c) { return c === 'white' ? 'black' : 'white'; }

  function flipTurnLocal() {
    board.turn = board.turn === 'white' ? 'black' : 'white';
    if (board.turn === 'white') board.fullmoveNumber++;
  }

  // ---- Input relay ----
  function sendInputTick() {
    if (!inRace || !engines.own) return;
    TCNet.send({ type: 'input', state: engines.own.getInputState() });
  }

  function applyRemoteInput(state) {
    if (!inRace || !engines.opp) return;
    engines.opp.applyRemoteInput(state);
  }

  // ---- Dual-screen overlay ----
  function openFightOverlay(fights) {
    if (!els.fightOverlay) return;
    const IamAttacker = myColor === race.attackerColor;
    const own = IamAttacker ? fights.attacker : fights.defender;
    const opp = IamAttacker ? fights.defender : fights.attacker;
    fillFightPanel('own', own, true);
    fillFightPanel('opp', opp, false);
    els.fightOverlay.classList.remove('hidden');
  }

  function fillFightPanel(which, fight, isMine) {
    const prefix = which === 'own' ? 'mp-panel-own' : 'mp-panel-opp';
    const q = (s) => document.getElementById(prefix + '-' + s);
    if (q('tag')) {
      q('tag').textContent = isMine
        ? (myName || 'You') + '’s fight'
        : (oppName || 'Opponent') + '’s fight (spectate)';
    }
    if (q('boss-name')) q('boss-name').textContent = CONFIG.CHARACTERS[fight.bossId] || fight.bossId;
    if (q('diff')) {
      q('diff').textContent = fight.difficulty.toUpperCase();
      q('diff').className = 'mp-diff ' + (fight.difficulty === 'lunatic' ? 'lunatic' : 'normal');
    }
    if (q('ship')) {
      q('ship').textContent = '🚀 ' + (CONFIG.CHARACTERS[fight.shipChar] || fight.shipChar);
    }
    // Reset HUD to initial values.
    const stats = CONFIG.DANMAKU_STATS[fight.playerPieceType] || {};
    if (q('lives')) q('lives').textContent = 'Lives ' + (stats.lives || 3);
    if (q('bombs')) q('bombs').textContent = 'Bombs ' + (stats.bombs || 2);
    if (q('phase')) q('phase').textContent = 'Phase 1/' + (getPhases(fight.bossId, fight.difficulty).length);
    if (q('boss-hp')) {
      const hpFill = q('boss-hp');
      if (hpFill) hpFill.style.width = '100%';
    }
    // Per-frame HUD updates are wired in makeEngine via the engine's onHud.
  }

  function updateFightHud(which, hud) {
    const prefix = which === 'own' ? 'mp-panel-own' : 'mp-panel-opp';
    const q = (s) => document.getElementById(prefix + '-' + s);
    if (q('lives')) q('lives').textContent = 'Lives ' + hud.lives;
    if (q('bombs')) q('bombs').textContent = 'Bombs ' + hud.bombs;
    if (q('phase')) q('phase').textContent = 'Phase ' + (hud.phase + 1) + '/' + hud.phaseCount;
    if (q('spell-name')) q('spell-name').textContent = hud.phaseName || '';
    if (q('boss-hp')) {
      const pct = hud.phaseMaxHp > 0 ? (hud.phaseHp / hud.phaseMaxHp) * 100 : 0;
      q('boss-hp').style.width = pct.toFixed(1) + '%';
    }
  }

  function closeFightOverlay() {
    stopRaceCountdown();
    if (els.fightOverlay) els.fightOverlay.classList.add('hidden');
  }

  // =========================================================================
  // Game over
  // =========================================================================
  function endGame(winnerColor) {
    if (gameOver) return; // idempotent: reachable via two paths (applyMove / removePiece)
    gameOver = true;
    nlog('session', { what: 'end', reason: 'game-over', winner: winnerColor });
    if (inputTimer) { clearInterval(inputTimer); inputTimer = null; }
    stopEngines();
    closeFightOverlay();
    const iWon = winnerColor === myColor;
    ui.setGameOverBanner(iWon ? 'You win!' : 'You lose!');
    ui.setTurnIndicator('Game over');
    showGameOverModal(iWon, winnerColor);
  }

  // Show the dedicated PVP result modal (#mp-result-modal). Its button is bound
  // to leave() in wireButtons, so no re-binding is needed here.
  function showResultModal(title, sub, statsHtml) {
    if (!els.resultModal) return;
    if (els.resultTitle) els.resultTitle.textContent = title;
    if (els.resultSub) els.resultSub.textContent = sub;
    if (els.resultStats) els.resultStats.innerHTML = statsHtml || '';
    els.resultModal.classList.remove('hidden');
  }

  function showGameOverModal(iWon, winnerColor) {
    const opp = oppName || 'the opponent';
    showResultModal(
      iWon ? '🎉 You win!' : '💀 You lose!',
      (iWon ? 'You defeated ' + opp : opp + ' captured your king') +
        ' — the ' + winnerColor + ' side claimed the match.',
      '<div class="stats-row"><span>Captured pieces</span><span>' + captured.length + '</span></div>' +
      '<div class="stats-row"><span>Contested captures</span><span>' + raceCount + '</span></div>'
    );
  }

  function showDisconnectNotice() {
    showResultModal('Connection lost', 'Your opponent disconnected.', '');
  }

  // =========================================================================
  // Leave / cleanup
  // =========================================================================
  function leave() {
    if (inputTimer) { clearInterval(inputTimer); inputTimer = null; }
    stopEngines();
    if (window.TCNet) window.TCNet.close();
    // Return to the menu by reloading (resets to a fresh AI-mode game).
    location.reload();
  }

  // =========================================================================
  // Boot
  // =========================================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for debugging/tests.
  if (typeof window !== 'undefined') {
    window.__MP = {
      get state() {
        return {
          myColor, oppColor, myName, oppName, inRace, gameOver, raceCount, connected, board: board,
          // Captured-tray entries: { piece: {type,color,character}, byColor } —
          // exposed for tests (e.g. detecting the same piece "captured" twice).
          captured: captured.map((c) => ({
            piece: { type: c.piece.type, color: c.piece.color, character: c.piece.character },
            byColor: c.byColor,
          })),
          // Network telemetry summary (RTT stats + per-kind event counts).
          net: (typeof NetLog !== 'undefined') ? NetLog.summary() : null,
        };
      },
      // Network simulator handle (see TCNet.setSim / js/net/telemetry.js):
      // __MP.netSim.set({ sendMs, recvMs, jitterMs, drop }) reproduces bad
      // network conditions in-page; __MP.netSim.get() returns the current sim.
      get netSim() {
        return {
          set: (o) => TCNet.setSim(o),
          get: () => Object.assign({}, TCNet.sim),
        };
      },
      // Test/debug handles (read-only views + a way to simulate a fight ending,
      // which is exactly what the engine calls onEnd() with on death/victory).
      get engines() { return engines; },
      get race() { return race; },
      simulateEnd(which, result) {
        const e = engines[which];
        if (e && typeof e.onEnd === 'function') e.onEnd(result);
      },
      // Force a REAL death through the engine's actual hit code path
      // (_hitPlayer -> lives-- -> _end('lose') -> onEnd), not a synthetic onEnd.
      forceHitDeath(which) {
        const e = engines[which];
        if (e && e.player && e.player.alive) { e.player.lives = 1; e._hitPlayer(); }
      },
      // Test-only: directly record a side's result at a given game-clock time
      // and run the resolution decision. Lets us verify the resolver picks the
      // true first-death regardless of the order events are injected.
      debugInject(side, result, gameTime) {
        if (!race) return false;
        recordResult(side, result, gameTime, true);
        scheduleResolve();
        return true;
      },
      protagonistOf,
      youkaiOf,
      buildFights: (move) => buildFights(move),
    };
  }
})();
