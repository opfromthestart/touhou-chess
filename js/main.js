// main.js — bootstrap + top-level state machine.
// Player (white / protagonists) vs AI (black / youkai bosses).
// State machine: player-turn -> ai-turn -> (boss-fight) -> game-over.
//
// Every capture is contested by a danmaku boss fight:
//   - Player-initiated capture -> Normal fight.
//   - AI-initiated capture     -> Lunatic fight.
//   - Player wins  -> the AI piece is removed (capture succeeds / attack blocked).
//   - Player loses -> the player's piece involved is removed.

(function () {
  const board = new Board();
  const captured = []; // { piece, byColor }
  let aiThinking = false;
  let inFight = false;
  let logCounter = 0;
  // Fight stats for the game-over summary.
  let fightsWon = 0;
  let fightsLost = 0;
  // Undo: one snapshot per player move (covers the move, any fight, and the
  // AI's reply), so "Undo" always rewinds to your own last decision point.
  const undoStack = [];
  // AI strength (plan §8 menu): search depth for pickMove.
  let aiDepth = CONFIG.AI_DEPTH;

  // Debug logging (see js/debug/log.js + replay.js): records a replayable
  // event stream so a buggy game can be exported and reproduced offline.
  let aiStartCount = 0; // counts startAiTurn calls (2 in a row = the softlock bug)
  let currentTurn = null; // { side, move, capture, failed, reason } for the turn in progress

  const ui = new BoardUI(document.getElementById('board'), {
    onMove: (move) => handlePlayerMove(move),
  });
  const fight = new FightUI();

  // Sound effects (no-op when the SFX module is absent or disabled).
  function sfxPlay(name) {
    if (typeof SFX !== 'undefined' && SFX) SFX.play(name);
  }

  // ---- Undo support ----

  // Snapshot everything the game can rewind: board state, captured trays,
  // fight stats, log counter, and the exported debug-log length.
  function takeSnapshot() {
    return {
      board: board.clone(),
      moveHistory: board.moveHistory.slice(),
      captured: captured.slice(),
      fightsWon,
      fightsLost,
      logCounter,
      logLen: typeof GameLog !== 'undefined' ? GameLog.length : 0,
    };
  }

  function restoreSnapshot(snap) {
    const b = snap.board;
    board.grid = b.grid;
    board.turn = b.turn;
    board.castling = b.castling;
    board.enPassantTarget = b.enPassantTarget;
    board.castleEnPassant = b.castleEnPassant;
    board.halfmoveClock = b.halfmoveClock;
    board.fullmoveNumber = b.fullmoveNumber;
    board.gameOver = b.gameOver;
    board.winner = b.winner;
    board.moveHistory = snap.moveHistory;
    captured.length = 0;
    for (const c of snap.captured) captured.push(c);
    fightsWon = snap.fightsWon;
    fightsLost = snap.fightsLost;
    if (typeof GameLog !== 'undefined') GameLog.truncate(snap.logLen);
  }

  // Rebuild the on-screen fight log from the (restored) move history so it
  // stays consistent with the board after an undo.
  function rebuildFightLog() {
    ui.clearLog();
    logCounter = 0;
    for (const entry of board.moveHistory) {
      logMove(entry.move, entry.move.piece.color === 'white' ? 'player' : 'ai');
    }
  }

  function undo() {
    if (inFight || aiThinking) return; // can't rewind a live fight or AI turn
    const snap = undoStack.pop();
    if (!snap) return;
    restoreSnapshot(snap);
    const goModal = document.getElementById('game-over-modal');
    if (goModal) goModal.classList.add('hidden');
    ui.clearLastMove();
    rebuildFightLog();
    ui.render(board);
    ui.renderTrays(captured);
    ui.setGameOverBanner('');
    ui.setTurnIndicator('Your move (Protagonists)');
    sfxPlay('move');
  }

  function handlePlayerMove(move) {
    if (board.gameOver || aiThinking || inFight) return;
    if (board.turn !== 'white') return; // only the player moves for white
    undoStack.push(takeSnapshot());
    sfxPlay('move');
    beginTurn('white', move);
    if (move.captured) {
      // Player-initiated capture -> Normal fight against the AI boss.
      openFight({
        bossId: move.captured.character,
        difficulty: 'normal',
        playerPieceType: move.piece.type,
        // The protagonist doing the capturing flies the ship.
        playerChar: move.piece.character,
        move,
        initiator: 'player',
      });
      return;
    }
    // applyMove -> afterMove handles game-over AND starting the AI turn.
    // (Do NOT call startAiTurn here: afterMove already does, and calling it
    // twice scheduled two aiTurn callbacks, which corrupted the board mid-fight
    // and softlocked the game.)
    applyMove(move, 'player');
  }

  function startAiTurn() {
    aiThinking = true;
    aiStartCount++;
    GameLog.push('ai-start', { count: aiStartCount });
    ui.setTurnIndicator('Bosses (Black) are thinking…');
    // Let the UI paint before the (synchronous) AI search.
    setTimeout(aiTurn, 60);
  }

  function aiTurn() {
    const move = pickMove(board, aiDepth);
    aiThinking = false;

    if (!move) {
      // Defensive: with no check the AI should always have a legal move. If
      // it doesn't (corrupted board / fully blocked), log it and pass the turn
      // instead of softlocking. The turn is recorded as a failure so the bug
      // is reproducible from the export.
      beginTurn('black', null, true, 'pickMove returned no move');
      GameLog.push('ai-run', { failed: true, reason: 'pickMove returned no move' });
      if (typeof console !== 'undefined') {
        console.warn(
          '[AI] No legal move found; passing the turn.',
          { turn: board.turn, gameOver: board.gameOver }
        );
      }
      flipTurn();
      ui.render(board);
      afterMove();
      return;
    }

    beginTurn('black', move);
    GameLog.push('ai-run', { move: serializeMove(move) });
    if (move.captured) {
      // AI-initiated capture -> Lunatic fight against the AI boss.
      openFight({
        bossId: move.piece.character,
        difficulty: 'lunatic',
        playerPieceType: move.captured.type,
        // The protagonist being attacked flies the ship.
        playerChar: move.captured.character,
        move,
        initiator: 'ai',
      });
      return;
    }
    applyMove(move, 'ai');
  }

  // Open the boss-fight modal; resolve the capture when the fight ends.
  function openFight({ bossId, difficulty, playerPieceType, playerChar, move, initiator }) {
    inFight = true;
    // Record the contested fight on the in-progress turn (if any).
    if (currentTurn) {
      currentTurn.capture = {
        bossId,
        difficulty,
        initiator,
        playerPieceType,
        result: null,
        applyCapture: null,
      };
    }
    ui.setTurnIndicator('Boss fight!');
    fight.startFight(bossId, difficulty, playerPieceType, playerChar, (result) => {
      inFight = false;
      const playerWon = result === 'win';
      // Track the fight outcome for the game-over summary.
      if (playerWon) fightsWon++; else fightsLost++;
      // Adapt the AI's survival model from the actual outcome.
      adaptSurvival(bossId, difficulty, playerWon);
      // Record the outcome + resolution on the in-progress turn.
      if (currentTurn && currentTurn.capture) {
        currentTurn.capture.result = result;
        currentTurn.capture.applyCapture =
          (initiator === 'player') === playerWon;
      }
      resolveCapture(move, initiator, playerWon);
    });
  }

  // Resolve a capture after its fight.
  //   applyCapture = (player initiated) === (player won):
  //     - Player captured, player won -> capture succeeds (apply the move).
  //     - AI captured,   player lost  -> capture succeeds (apply the move).
  //   Otherwise the capturing piece is removed from its origin and the turn
  //   is consumed (the target piece stays).
  function resolveCapture(move, initiator, playerWon) {
    const applyCapture = (initiator === 'player') === playerWon;
    if (applyCapture) {
      sfxPlay('capture');
      applyMove(move, initiator === 'player' ? 'player' : 'ai');
      return;
    }
    board.removePiece(move.from.row, move.from.col);
    captured.push({
      piece: move.piece,
      byColor: move.piece.color === 'white' ? 'black' : 'white',
    });
    flipTurn();
    // Consume the castle en passant right if the mover held it (turn passed).
    if (board.castleEnPassant && board.castleEnPassant.color === move.piece.color) {
      board.castleEnPassant = null;
    }
    ui.render(board);
    ui.renderTrays(captured);
    logFightResult(move);
    afterMove();
  }

  function flipTurn() {
    board.turn = board.turn === 'white' ? 'black' : 'white';
    if (board.turn === 'white') board.fullmoveNumber++;
  }

  function applyMove(move, by) {
    const mover = move.piece.color;
    board.applyMove(move);

    if (move.captured) {
      captured.push({ piece: move.captured, byColor: mover });
    }

    ui.setLastMove(move.from, move.to);
    ui.render(board);
    ui.renderTrays(captured);
    logMove(move, by);
    afterMove();
  }

  function afterMove() {
    // Finalize the in-progress turn in the debug log (board state has settled).
    logTurn();
    if (board.gameOver) {
      const playerWon = board.winner === 'white';
      ui.setGameOverBanner(playerWon
        ? 'The Protagonists (White) win!'
        : 'The Bosses (Black) win!');
      ui.setTurnIndicator('Game over');
      showGameOver(playerWon);
      return;
    }
    if (board.turn === 'black') {
      startAiTurn();
    } else {
      ui.setTurnIndicator('Your move (Protagonists)');
    }
  }

  // Show the end-of-game modal with a summary of the match.
  function showGameOver(playerWon) {
    const modal = document.getElementById('game-over-modal');
    if (!modal) return;
    const title = document.getElementById('game-over-title');
    const sub = document.getElementById('game-over-sub');
    const stats = document.getElementById('game-over-stats');
    title.textContent = playerWon ? 'Victory!' : 'Defeat';
    title.className = 'game-over-title ' + (playerWon ? 'win' : 'lose');
    sub.textContent = playerWon
      ? 'You captured Kaguya and the youkai bosses retreat. Gensokyo is safe… for now.'
      : 'Kaguya captured your king. The youkai bosses claim victory.';
    const moves = board.moveHistory.length;
    const totalFights = fightsWon + fightsLost;
    stats.innerHTML =
      `<div class="stat"><span>Moves</span><b>${moves}</b></div>` +
      `<div class="stat"><span>Fights won</span><b>${fightsWon}</b></div>` +
      `<div class="stat"><span>Fights lost</span><b>${fightsLost}</b></div>` +
      `<div class="stat"><span>Pieces captured</span><b>${captured.length}</b></div>` +
      (totalFights > 0
        ? `<div class="stat"><span>Fight record</span><b>${Math.round((fightsWon / totalFights) * 100)}%</b></div>`
        : '');
    modal.classList.remove('hidden');
  }

  function logMove(move, by) {
    const pieceName = CONFIG.CHARACTERS[move.piece.character];
    const fromSq = sqName(move.from);
    const toSq = sqName(move.to);
    let text = `${pieceName} ${fromSq}→${toSq}`;
    if (move.isCastle) text += ` (castle ${move.isCastle === 'k' ? 'K' : 'Q'})`;
    if (move.isEnPassant) text += ' (en passant)';
    if (move.castleEnPassant) text += ' (castle en passant!)';
    if (move.isPromotion) text += ` → ${move.promotionPiece.toUpperCase()}`;
    if (move.captured) {
      const capName = CONFIG.CHARACTERS[move.captured.character];
      text += ` × ${capName}`;
    }
    if (by === 'ai') text += '  <em>(AI)</em>';
    logCounter++;
    ui.logMove(logCounter, text);
  }

  function logFightResult(move) {
    const moverName = CONFIG.CHARACTERS[move.piece.character];
    const targetName = CONFIG.CHARACTERS[move.captured.character];
    const text = move.piece.color === 'white'
      ? `${moverName} attacked ${targetName} but lost the fight — ${moverName} was captured!`
      : `${moverName} attacked ${targetName} but you won the fight — ${moverName} was captured!`;
    logCounter++;
    ui.logMove(logCounter, text);
  }

  function sqName({ row, col }) {
    return FILES[col] + (8 - row);
  }

  // ---- Debug logging helpers (see js/debug/log.js) ----

  // Serialize a move into a plain, JSON-safe object (no piece references).
  function serializeMove(move) {
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

  // Begin recording a turn. `move` may be null (an AI that fails to move).
  function beginTurn(side, move, failed, reason) {
    currentTurn = {
      side,
      move: serializeMove(move),
      capture: null,
      failed: !!failed,
      reason: reason || null,
    };
    return currentTurn;
  }

  // Finish recording the in-progress turn (called once the board state has
  // settled). Safe to call when no turn is in progress.
  function logTurn() {
    if (!currentTurn) return;
    const ev = GameLog.push('turn', {
      side: currentTurn.side,
      move: currentTurn.move,
      capture: currentTurn.capture,
      failed: currentTurn.failed,
      reason: currentTurn.reason,
      state: {
        turn: board.turn,
        gameOver: board.gameOver,
        winner: board.winner,
      },
    });
    if (typeof console !== 'undefined') {
      console.log('[GameLog]', GameLog.summaryLine(ev));
    }
    currentTurn = null;
  }

  // Unlock WebAudio on the first user gesture (browsers gate AudioContext
  // behind a gesture). A single document-level listener covers every control.
  if (typeof SFX !== 'undefined' && SFX) {
    const unlock = () => { SFX.init(); document.removeEventListener('pointerdown', unlock); };
    document.addEventListener('pointerdown', unlock);
  }

  // Start a fresh game. Shared by the top-bar "New Game" button and the
  // game-over "Play Again" button.
  function newGame() {
    if (inFight) {
      fight.engine.stop();
      fight.modal.classList.add('hidden');
      inFight = false;
    }
    const goModal = document.getElementById('game-over-modal');
    if (goModal) goModal.classList.add('hidden');
    board.reset();
    resetSurvival();
    captured.length = 0;
    aiThinking = false;
    logCounter = 0;
    aiStartCount = 0;
    fightsWon = 0;
    fightsLost = 0;
    undoStack.length = 0;
    currentTurn = null;
    if (typeof GameLog !== 'undefined') GameLog.clear();
    ui.clearLastMove();
    ui.clearLog();
    ui.setGameOverBanner('');
    ui.render(board);
    ui.renderTrays(captured);
    ui.setTurnIndicator('Your move (Protagonists)');
  }

  document.getElementById('btn-new-game').addEventListener('click', newGame);
  const btnPlayAgain = document.getElementById('btn-game-over-new');
  if (btnPlayAgain) btnPlayAgain.addEventListener('click', newGame);

  // Undo: rewinds to the player's last decision point (see takeSnapshot).
  const btnUndo = document.getElementById('btn-undo');
  if (btnUndo) btnUndo.addEventListener('click', undo);

  // AI strength selector (plan §8 menu).
  const aiStrength = document.getElementById('ai-strength');
  if (aiStrength && CONFIG.AI_STRENGTHS) {
    aiStrength.addEventListener('change', () => {
      const s = CONFIG.AI_STRENGTHS[aiStrength.value];
      if (s) aiDepth = s.depth;
    });
  }

  // Sound toggle.
  const btnSound = document.getElementById('btn-sound');
  if (btnSound && typeof SFX !== 'undefined' && SFX) {
    const renderSound = () => {
      btnSound.textContent = SFX.enabled ? '🔊 Sound' : '🔇 Muted';
      btnSound.setAttribute('aria-pressed', String(SFX.enabled));
    };
    btnSound.addEventListener('click', () => {
      SFX.enabled = !SFX.enabled;
      renderSound();
      if (SFX.enabled) sfxPlay('move'); // confirm the toggle with a blip
    });
    renderSound();
  }

  // How to play.
  const howTo = document.getElementById('how-to-modal');
  document.getElementById('btn-how-to').addEventListener('click', () => {
    howTo.classList.remove('hidden');
  });
  document.getElementById('btn-close-how-to').addEventListener('click', () => {
    howTo.classList.add('hidden');
  });

  // Export the debug game log (for replaying a buggy game offline).
  const btnExportLog = document.getElementById('btn-export-log');
  if (btnExportLog && typeof GameLog !== 'undefined') {
    btnExportLog.addEventListener('click', () => {
      GameLog.download();
      if (typeof console !== 'undefined') {
        console.log(
          '[GameLog] Exported ' + GameLog.length + ' events.'
        );
      }
    });
  }

  // Debug/test hook: exposes the live game state so test pages (see
  // test-fight-resolution.html) and the browser console can inspect or drive
  // the game.
  if (typeof window !== 'undefined') {
    window.__TC = {
      board,
      get captured() { return captured; },
      ui,
      fight,
      undo,
    };
  }

  // Initial render.
  ui.render(board);
  ui.renderTrays(captured);
  ui.setTurnIndicator('Your move (Protagonists)');
})();
