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

  const ui = new BoardUI(document.getElementById('board'), {
    onMove: (move) => handlePlayerMove(move),
  });
  const fight = new FightUI();

  function handlePlayerMove(move) {
    if (board.gameOver || aiThinking || inFight) return;
    if (board.turn !== 'white') return; // only the player moves for white
    if (move.captured) {
      // Player-initiated capture -> Normal fight against the AI boss.
      openFight({
        bossId: move.captured.character,
        difficulty: 'normal',
        playerPieceType: move.piece.type,
        move,
        initiator: 'player',
      });
      return;
    }
    applyMove(move, 'player');
    if (board.gameOver) return;
    startAiTurn();
  }

  function startAiTurn() {
    aiThinking = true;
    ui.setTurnIndicator('Bosses (Black) are thinking…');
    // Let the UI paint before the (synchronous) AI search.
    setTimeout(aiTurn, 60);
  }

  function aiTurn() {
    const move = pickMove(board);
    aiThinking = false;
    if (!move) return;
    if (move.captured) {
      // AI-initiated capture -> Lunatic fight against the AI boss.
      openFight({
        bossId: move.piece.character,
        difficulty: 'lunatic',
        playerPieceType: move.captured.type,
        move,
        initiator: 'ai',
      });
      return;
    }
    applyMove(move, 'ai');
  }

  // Open the boss-fight modal; resolve the capture when the fight ends.
  function openFight({ bossId, difficulty, playerPieceType, move, initiator }) {
    inFight = true;
    ui.setTurnIndicator('Boss fight!');
    fight.startFight(bossId, difficulty, playerPieceType, (result) => {
      inFight = false;
      const playerWon = result === 'win';
      // Adapt the AI's survival model from the actual outcome.
      adaptSurvival(bossId, difficulty, playerWon);
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
    if (board.gameOver) {
      const winnerName = board.winner === 'white'
        ? 'The Protagonists (White) win!'
        : 'The Bosses (Black) win!';
      ui.setGameOverBanner(winnerName);
      ui.setTurnIndicator('Game over');
      return;
    }
    if (board.turn === 'black') {
      startAiTurn();
    } else {
      ui.setTurnIndicator('Your move (Protagonists)');
    }
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

  // New game.
  document.getElementById('btn-new-game').addEventListener('click', () => {
    if (inFight) {
      fight.engine.stop();
      fight.modal.classList.add('hidden');
      inFight = false;
    }
    board.reset();
    resetSurvival();
    captured.length = 0;
    aiThinking = false;
    logCounter = 0;
    ui.clearLastMove();
    ui.clearLog();
    ui.setGameOverBanner('');
    ui.render(board);
    ui.renderTrays(captured);
    ui.setTurnIndicator('Your move (Protagonists)');
  });

  // How to play.
  const howTo = document.getElementById('how-to-modal');
  document.getElementById('btn-how-to').addEventListener('click', () => {
    howTo.classList.remove('hidden');
  });
  document.getElementById('btn-close-how-to').addEventListener('click', () => {
    howTo.classList.add('hidden');
  });

  // Initial render.
  ui.render(board);
  ui.renderTrays(captured);
  ui.setTurnIndicator('Your move (Protagonists)');
})();
