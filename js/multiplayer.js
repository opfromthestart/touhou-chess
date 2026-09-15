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
  let els = {};

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
    window.TCNet.name = myName;
    window.TCNet.host(netHandlers());
  }

  function joinGame(code) {
    if (!code || code.trim().length < 3) { setNetStatus('Enter a valid room code.', true); return; }
    readMyName('Player 2');
    setConnectMode('joining');
    setNetStatus('Connecting…');
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
    if (inMultiplayer()) {
      // Tear down any in-flight race so engines/relay don't keep running.
      if (inputTimer) { clearInterval(inputTimer); inputTimer = null; }
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
        // Opponent finished resolving the race (safety sync).
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

    board = new Board();
    board.reset();

    // Take over the board element with our own UI. Building a fresh BoardUI
    // clears #board and rebinds clicks to onMyMove, so the dormant AI-mode game
    // (which only advances on player moves) can no longer interfere.
    const boardEl = document.getElementById('board');
    ui = new BoardUI(boardEl, { onMove: onMyMove });
    ui.render(board);
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
      startRace(move);
      TCNet.send({ type: 'move', move: serializeMove(move) });
    } else {
      applyMoveToBoard(move, myColor);
      TCNet.send({ type: 'move', move: serializeMove(move) });
    }
  }

  // A move from the opponent.
  function receiveMove(move) {
    if (gameOver || inRace) return;
    if (board.turn !== oppColor) return; // sanity: should be their turn
    sfxPlay('move');
    if (move.captured) {
      startRace(move);
    } else {
      applyMoveToBoard(move, oppColor);
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
    startEngines(fights);

    // Relay my input to the opponent while the race runs.
    if (inputTimer) clearInterval(inputTimer);
    inputTimer = setInterval(sendInputTick, CONFIG.MP_INPUT_INTERVAL_MS);

    // Open the dual-screen overlay.
    openFightOverlay(fights);
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
  // players die within the network latency window), we:
  //
  //   • Measure each fight's end time in the engine's fixed-step GAME clock
  //     (engine.time, seconds). Both clients run the SAME two fights (their
  //     own controllable fight + a spectator copy of the opponent's), so the
  //     game-clock end time of each fight is consistent across clients.
  //   • Observe BOTH fights locally (own engine + spectator engine) AND accept
  //     the opponent's authoritative 'fight-result' message as a fallback.
  //   • Resolve by comparing the actual end times: the side that ran out of
  //     lives at the EARLIER game-clock time loses. This is independent of the
  //     order in which events arrive over the network.
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

  // Record a fight's outcome. For repeated 'lose' reports we keep the EARLIEST
  // game-clock time (the true moment the ship ran out of lives).
  function recordResult(side, result, gameTime) {
    if (!race || race.resolved) return;
    const existing = race.results[side];
    if (!existing) {
      race.results[side] = { result, lossElapsed: gameTime };
    } else if (existing.result === 'lose' && result === 'lose' && gameTime < existing.lossElapsed) {
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
    const aDone = !!a, dDone = !!d;
    // Both fights concluded -> decide by earliest 'lose' (game-clock time).
    if (aDone && dDone) return resolveByResults(a, d);
    // One side ran out of lives while the other engine is still running
    // (opponent's ship alive): the deceased side necessarily ran out first.
    if (aDone && a.result === 'lose' && !dDone && engineRunning('defender')) return resolveRace('fail');
    if (dDone && d.result === 'lose' && !aDone && engineRunning('attacker')) return resolveRace('success');
    // Otherwise (one finished with 'win' and the other is still fighting, or
    // only one result so far with the other engine already stopped): wait.
  }

  function engineRunning(side) {
    const e = engines[engineForSide(side)];
    return !!(e && e.running);
  }

  function resolveByResults(a, d) {
    const aLose = a.result === 'lose', dLose = d.result === 'lose';
    if (aLose && dLose) {
      // Both ran out of lives: the earlier game-clock time died first.
      return resolveRace(a.lossElapsed <= d.lossElapsed ? 'fail' : 'success');
    }
    if (aLose) return resolveRace('fail');     // attacker lost, defender survived
    if (dLose) return resolveRace('success');  // defender lost, attacker survived
    return resolveRace('fail');                // both survived -> stalemate
  }

  // My own (controllable) fight ended.
  function onOwnEnd(result) {
    if (!race || race.resolved) return;
    const side = myColor === race.attackerColor ? 'attacker' : 'defender';
    const t = engineTime('own');
    recordResult(side, result, t);
    // Authoritative: tell the opponent my result (game-clock time).
    TCNet.send({ type: 'fight-result', side, result, lossElapsed: t });
    scheduleResolve();
  }

  // My spectator copy of the opponent's fight ended. This lets us observe the
  // opponent's end time LOCALLY (in the shared game clock) without waiting for
  // their message — the primary signal for cross-client consistency.
  function onSpectatorEnd(result) {
    if (!race || race.resolved) return;
    const side = myColor === race.attackerColor ? 'defender' : 'attacker';
    const t = engineTime('opp');
    recordResult(side, result, t);
    scheduleResolve();
  }

  // The opponent's authoritative result (fallback in case our spectator copy
  // did not detect the end, e.g. due to input-relay lag).
  function onOppFightResult(side, result, lossElapsed) {
    if (!race || race.resolved) return;
    recordResult(side, result, lossElapsed);
    scheduleResolve();
  }

  function resolveRace(outcome) {
    if (!race || race.resolved) return;
    race.resolved = true;
    inRace = false;
    if (inputTimer) { clearInterval(inputTimer); inputTimer = null; }
    stopEngines();
    closeFightOverlay();

    const move = race.move;
    if (outcome === 'success') {
      // Capture goes through.
      sfxPlay('capture');
      applyMoveToBoard(move, race.attackerColor);
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
    }
    raceCount++;
    TCNet.send({ type: 'race-end', outcome });

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
    if (els.fightOverlay) els.fightOverlay.classList.add('hidden');
  }

  // =========================================================================
  // Game over
  // =========================================================================
  function endGame(winnerColor) {
    if (gameOver) return; // idempotent: reachable via two paths (applyMove / removePiece)
    gameOver = true;
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
        return { myColor, oppColor, myName, oppName, inRace, gameOver, raceCount, connected, board: board };
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
        recordResult(side, result, gameTime);
        scheduleResolve();
        return true;
      },
      protagonistOf,
      youkaiOf,
      buildFights: (move) => buildFights(move),
    };
  }
})();
