// replay.js — replay a recorded game log (see log.js) offline.
//
// Reconstructs the board from the event stream and, for each recorded turn,
// verifies that the move is legal for the side to move and that the resulting
// board state (turn / game-over) matches what was recorded. This reproduces a
// buggy game — e.g. the post-fight AI softlock — without the danmaku, so the
// exact divergent move can be found.
//
// No build step, no dependencies. `replayGame` is a global in the browser and
// module.exports in Node. It takes the Board class as an optional second
// argument (defaults to the global `Board`) so it can be driven from Node.

function sq(s) {
  return s ? 'abcdefgh'[s.c] + (8 - s.r) : '?';
}

function replayGame(events, BoardClass) {
  const Board = BoardClass || (typeof Board !== 'undefined' ? Board : null);
  if (!Board) throw new Error('replayGame: no Board class available');

  const board = new Board();
  board.reset();

  const report = {
    ok: true,
    steps: 0,
    errors: [],
    finalTurn: board.turn,
    gameOver: board.gameOver,
    winner: board.winner,
  };

  for (const ev of events) {
    if (!ev || ev.type !== 'turn') continue;
    report.steps++;

    // A recorded AI failure is the softlock itself: stop and report it.
    if (ev.failed) {
      report.errors.push({
        seq: ev.seq,
        msg: 'AI failed to move: ' + (ev.reason || 'unknown'),
      });
      report.ok = false;
      break;
    }
    if (!ev.move) {
      report.errors.push({ seq: ev.seq, msg: 'turn has no move recorded' });
      report.ok = false;
      break;
    }

    const side = ev.side;
    if (board.turn !== side) {
      report.errors.push({
        seq: ev.seq,
        msg:
          'expected ' + side + ' to move, but it is ' + board.turn + "'s turn",
      });
      report.ok = false;
      break;
    }

    // Find the recorded move on the current board (match by from/to).
    const moves = board.getMoves(side);
    const move = moves.find(
      (m) =>
        m.from.row === ev.move.from.r &&
        m.from.col === ev.move.from.c &&
        m.to.row === ev.move.to.r &&
        m.to.col === ev.move.to.c
    );
    if (!move) {
      report.errors.push({
        seq: ev.seq,
        msg:
          'no legal ' +
          side +
          ' move ' +
          sq(ev.move.from) +
          '\u2192' +
          sq(ev.move.to) +
          ' (board state diverged)',
      });
      report.ok = false;
      break;
    }

    if (ev.capture) {
      if (ev.capture.applyCapture) {
        // The capture went through: apply the move as recorded.
        board.applyMove(move);
      } else {
        // The capturing piece was removed and the turn consumed (the target
        // piece stays). Mirror main.js resolveCapture's else branch.
        board.removePiece(move.from.row, move.from.col);
        board.turn = board.turn === 'white' ? 'black' : 'white';
        if (board.turn === 'white') board.fullmoveNumber++;
        if (
          board.castleEnPassant &&
          board.castleEnPassant.color === move.piece.color
        ) {
          board.castleEnPassant = null;
        }
      }
    } else {
      board.applyMove(move);
    }

    // Verify the resulting state matches the recording.
    if (ev.state) {
      const turnOk = ev.state.turn === board.turn;
      const overOk = !!ev.state.gameOver === !!board.gameOver;
      if (!turnOk || !overOk) {
        report.errors.push({
          seq: ev.seq,
          msg:
            'state mismatch after ' +
            side +
            ' move: expected turn=' +
            ev.state.turn +
            ' gameOver=' +
            ev.state.gameOver +
            ', got turn=' +
            board.turn +
            ' gameOver=' +
            board.gameOver,
        });
        report.ok = false;
      }
    }
  }

  report.finalTurn = board.turn;
  report.gameOver = board.gameOver;
  report.winner = board.winner;
  return report;
}

// Apply ONE recorded 'turn' event to a Board, mirroring exactly what the
// live game does (main.js applyMove / resolveCapture, multiplayer
// applyMoveToBoard / race-failure branch). No verification, no DOM — this is
// the shared core that both replayGame (verification) and the on-screen
// ReplayViewer (js/ui/replay-ui.js) build on.
//
// Returns:
//   { ok: true,  kind: 'move' | 'capture-ok' | 'capture-fail',
//     move, byColor, captured: piece|null, removed: piece|null }
//   { ok: false, error: 'ai-failed' | 'no-move' | 'wrong-side' | 'illegal' }
function applyTurnEvent(board, ev) {
  if (!ev || ev.type !== 'turn') return { ok: false, error: 'no-move' };
  if (ev.failed) return { ok: false, error: 'ai-failed' };
  if (!ev.move) return { ok: false, error: 'no-move' };
  if (board.gameOver) return { ok: false, error: 'game-over' };
  if (board.turn !== ev.side) return { ok: false, error: 'wrong-side' };

  const m = ev.move;
  const moves = board.getMoves(ev.side);
  const move = moves.find(
    (x) =>
      x.from.row === m.from.r && x.from.col === m.from.c &&
      x.to.row === m.to.r && x.to.col === m.to.c
  );
  if (!move) return { ok: false, error: 'illegal' };

  // Promotion: the recorded flags carry the chosen piece; the live move
  // object only gets it when the player picks it in the promotion UI.
  const flags = m.flags || {};
  if (flags.isPromotion && flags.promotionPiece) {
    move.promotionPiece = flags.promotionPiece;
  }

  const byColor = ev.side;
  if (ev.capture) {
    if (ev.capture.applyCapture) {
      // The capture went through (same as main.js resolveCapture).
      board.applyMove(move);
      return {
        ok: true, kind: 'capture-ok', move, byColor,
        captured: move.captured, removed: null,
      };
    }
    // The capturing piece lost its fight and was removed; the target stays
    // and the turn is consumed (main.js resolveCapture else branch).
    const removed = board.grid[m.from.r][m.from.c];
    board.removePiece(m.from.r, m.from.c);
    board.turn = board.turn === 'white' ? 'black' : 'white';
    if (board.turn === 'white') board.fullmoveNumber++;
    if (board.castleEnPassant && board.castleEnPassant.color === move.piece.color) {
      board.castleEnPassant = null;
    }
    return {
      ok: true, kind: 'capture-fail', move, byColor,
      captured: null, removed,
    };
  }
  board.applyMove(move);
  return { ok: true, kind: 'move', move, byColor, captured: null, removed: null };
}

// Export for Node (tests); in the browser these are globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { replayGame, applyTurnEvent };
}
