// test-replay.js — verify the debug log + offline replay.
//
// Drives a real Board, records turns the same way main.js does (move, optional
// contested fight, resolution, resulting state), then replays the log with
// replayGame and checks the result matches. Also checks that a recorded AI
// failure (the softlock) is detected by the replay, and that GameLog produces
// valid, JSON-safe output.
//
// Run: node test-replay.js

const { Board } = require('./js/chess/board.js');
const { GameLog } = require('./js/debug/log.js');
const { replayGame } = require('./js/debug/replay.js');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log('  ok - ' + msg);
  } else {
    failed++;
    console.log('  FAIL - ' + msg);
  }
}

// A minimal log container (mirrors GameLog.push) so each test is isolated.
function makeLog() {
  const events = [];
  let seq = 0;
  return {
    events,
    push(type, data) {
      const ev = Object.assign({ seq: seq++, type }, data || {});
      events.push(ev);
      return ev;
    },
  };
}

// Serialize a move the same way main.js serializeMove does.
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

// Find a move on the board by from/to.
function findMove(board, side, from, to) {
  return board
    .getMoves(side)
    .find(
      (m) =>
        m.from.row === from[0] &&
        m.from.col === from[1] &&
        m.to.row === to[0] &&
        m.to.col === to[1]
    );
}

// Record a turn event the way main.js does (state captured after the move).
function recordTurn(log, board, side, move, capture, failed, reason) {
  log.push('turn', {
    side,
    move: serializeMove(move),
    capture: capture || null,
    failed: !!failed,
    reason: reason || null,
    state: { turn: board.turn, gameOver: board.gameOver, winner: board.winner },
  });
}

// ---------------------------------------------------------------------------
console.log('test 1: simple non-capture game replays cleanly');
{
  const board = new Board();
  const log = makeLog();
  const seq = [
    { side: 'white', from: [6, 4], to: [4, 4] }, // e2e4
    { side: 'black', from: [1, 3], to: [3, 3] }, // d7d5
    { side: 'white', from: [6, 3], to: [4, 3] }, // d2d4
    { side: 'black', from: [1, 4], to: [3, 4] }, // e7e6
  ];
  for (const s of seq) {
    const move = findMove(board, s.side, s.from, s.to);
    assert(!!move, s.side + ' ' + s.from + '->' + s.to + ' is legal');
    if (!move) break;
    board.applyMove(move);
    recordTurn(log, board, s.side, move, null, false, null);
  }
  const report = replayGame(log.events, Board);
  assert(report.ok, 'replay is ok');
  assert(report.steps === 4, 'replayed 4 turns (got ' + report.steps + ')');
  assert(report.errors.length === 0, 'no errors: ' + JSON.stringify(report.errors));
  assert(report.finalTurn === 'white', 'final turn white (got ' + report.finalTurn + ')');
  assert(report.gameOver === false, 'game not over');
}

// ---------------------------------------------------------------------------
console.log('test 2: capture that succeeds (applyCapture=true)');
{
  const board = new Board();
  const log = makeLog();
  // white e2e4, black d7d5, white e4xd5 (capture goes through).
  const seq = [
    { side: 'white', from: [6, 4], to: [4, 4], cap: null },
    { side: 'black', from: [1, 3], to: [3, 3], cap: null },
    {
      side: 'white',
      from: [4, 4],
      to: [3, 3],
      cap: {
        bossId: 'rumia',
        difficulty: 'normal',
        initiator: 'player',
        playerPieceType: 'p',
        result: 'win',
        applyCapture: true,
      },
    },
  ];
  for (const s of seq) {
    const move = findMove(board, s.side, s.from, s.to);
    assert(!!move, s.side + ' ' + s.from + '->' + s.to + ' is legal');
    if (!move) break;
    board.applyMove(move);
    recordTurn(log, board, s.side, move, s.cap, false, null);
  }
  const report = replayGame(log.events, Board);
  assert(report.ok, 'replay is ok');
  assert(report.steps === 3, 'replayed 3 turns (got ' + report.steps + ')');
  assert(report.errors.length === 0, 'no errors: ' + JSON.stringify(report.errors));
  assert(report.finalTurn === 'black', 'final turn black (got ' + report.finalTurn + ')');
}

// ---------------------------------------------------------------------------
console.log('test 3: capture that fails (piece removed, turn consumed)');
{
  const board = new Board();
  const log = makeLog();
  // Same setup, but the white capture fails: white pawn removed from e4, black
  // pawn stays on d5, turn passes to black.
  const seq = [
    { side: 'white', from: [6, 4], to: [4, 4], cap: null },
    { side: 'black', from: [1, 3], to: [3, 3], cap: null },
    {
      side: 'white',
      from: [4, 4],
      to: [3, 3],
      cap: {
        bossId: 'rumia',
        difficulty: 'normal',
        initiator: 'player',
        playerPieceType: 'p',
        result: 'lose',
        applyCapture: false,
      },
    },
  ];
  for (const s of seq) {
    const move = findMove(board, s.side, s.from, s.to);
    assert(!!move, s.side + ' ' + s.from + '->' + s.to + ' is legal');
    if (!move) break;
    if (s.cap && s.cap.applyCapture === false) {
      // Mirror main.js resolveCapture else-branch.
      board.removePiece(move.from.row, move.from.col);
      board.turn = board.turn === 'white' ? 'black' : 'white';
      if (board.turn === 'white') board.fullmoveNumber++;
    } else {
      board.applyMove(move);
    }
    recordTurn(log, board, s.side, move, s.cap, false, null);
  }
  const report = replayGame(log.events, Board);
  assert(report.ok, 'replay is ok');
  assert(report.steps === 3, 'replayed 3 turns (got ' + report.steps + ')');
  assert(report.errors.length === 0, 'no errors: ' + JSON.stringify(report.errors));
  assert(report.finalTurn === 'black', 'final turn black (got ' + report.finalTurn + ')');
}

// ---------------------------------------------------------------------------
console.log('test 4: a recorded AI failure (softlock) is detected');
{
  const log = makeLog();
  log.push('turn', {
    side: 'black',
    move: null,
    capture: null,
    failed: true,
    reason: 'pickMove returned no move',
    state: { turn: 'black', gameOver: false, winner: null },
  });
  const report = replayGame(log.events, Board);
  assert(!report.ok, 'replay reports a failure');
  assert(report.errors.length === 1, 'one error recorded');
  assert(
    /failed to move/.test(report.errors[0].msg),
    'error mentions the AI failure: ' + report.errors[0].msg
  );
}

// ---------------------------------------------------------------------------
console.log('test 5: a divergent (illegal) move is detected');
{
  const log = makeLog();
  // Record a white move that is not legal from the start position (a3->b5 by a
  // pawn is illegal).
  log.push('turn', {
    side: 'white',
    move: { from: { r: 6, c: 0 }, to: { r: 4, c: 1 }, pieceType: 'p', capturedType: null, flags: {} },
    capture: null,
    failed: false,
    reason: null,
    state: { turn: 'black', gameOver: false, winner: null },
  });
  const report = replayGame(log.events, Board);
  assert(!report.ok, 'replay reports a divergence');
  assert(
    /no legal white move|diverged/.test(report.errors[0].msg),
    'error mentions the illegal move: ' + report.errors[0].msg
  );
}

// ---------------------------------------------------------------------------
console.log('test 6: GameLog produces valid, JSON-safe output');
{
  GameLog.clear();
  GameLog.push('turn', {
    side: 'white',
    move: { from: { r: 6, c: 4 }, to: { r: 4, c: 4 }, pieceType: 'p', capturedType: null, flags: {} },
    capture: null,
    failed: false,
    reason: null,
    state: { turn: 'black', gameOver: false, winner: null },
  });
  const json = GameLog.dump();
  let parsed = null;
  let parseOk = true;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    parseOk = false;
  }
  assert(parseOk, 'dump() is valid JSON');
  assert(parsed && parsed.version === 1, 'envelope has version 1');
  assert(parsed && parsed.events.length === 1, 'one event in the log');
  const line = GameLog.summaryLine(parsed.events[0]);
  assert(/white e2\u2192e4/.test(line), 'summaryLine renders the move: ' + line);
  // Round-trip: replay the dumped log.
  const report = replayGame(parsed.events, Board);
  assert(report.ok, 'dumped log replays cleanly');
}

// ---------------------------------------------------------------------------
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
