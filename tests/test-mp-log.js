// test-mp-log.js — verify the multiplayer debug log is replayable.
//
// Before this change, GameLog was only wired into the AI-mode game loop
// (main.js), so a PVP match exported an EMPTY log and a buggy PVP game (e.g.
// "neither player could make a move") could not be reproduced offline. This
// test drives a real Board the way multiplayer.js records turns — both players
// alternate, and captures are contested (one succeeds, one fails) — using the
// SAME serialization helpers as js/multiplayer.js (mpSerializeMove /
// mpCaptureInfo / mpLogTurn), then replays the log with replayGame and checks
// the result matches.
//
// Run: node test-mp-log.js

const { Board } = require('../js/chess/board.js');
const { GameLog } = require('../js/debug/log.js');
const { replayGame } = require('../js/debug/replay.js');

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

// ---- Verbatim copies of the multiplayer.js log helpers -------------------
// (They live inside the multiplayer IIFE, so we replicate them here to prove
//  the format they emit is what replay.js consumes.)

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

function mpCaptureInfo(move, attackerColor, applyCapture) {
  // youkaiOf is roster-based; for the log the bossId is informational only.
  const ROSTER = require('../js/config.js').CONFIG.ROSTER;
  const bossId = move.captured ? ROSTER[move.captured.type].ai[0] : null;
  return {
    bossId,
    difficulty: 'normal',
    initiator: attackerColor,
    playerPieceType: move.piece.type,
    result: applyCapture ? 'win' : 'lose',
    applyCapture,
  };
}

// Record a turn exactly as multiplayer.js mpLogTurn does.
function mpLogTurn(board, side, move, capture) {
  const ev = GameLog.push('turn', {
    side,
    move: mpSerializeMove(move),
    capture: capture || null,
    failed: false,
    reason: null,
    state: { turn: board.turn, gameOver: board.gameOver, winner: board.winner },
  });
  return ev;
}

// ---------------------------------------------------------------------------
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

// Apply a move the way multiplayer.js does, given the race outcome:
//   null      -> plain move (board.applyMove)
//   'success' -> capture goes through (board.applyMove)
//   'fail'    -> capturing piece removed, turn consumed (mirror resolveRace)
function applyOutcome(board, move, outcome) {
  if (outcome === 'fail') {
    board.removePiece(move.from.row, move.from.col);
    board.turn = board.turn === 'white' ? 'black' : 'white';
    if (board.turn === 'white') board.fullmoveNumber++;
    if (board.castleEnPassant && board.castleEnPassant.color === move.piece.color) {
      board.castleEnPassant = null;
    }
  } else {
    board.applyMove(move);
  }
}

// ---------------------------------------------------------------------------
console.log('test 1: PVP game with a successful capture replays cleanly');
{
  GameLog.clear();
  const board = new Board();
  const seq = [
    { side: 'white', from: [6, 4], to: [4, 4], outcome: null }, // e2e4
    { side: 'black', from: [1, 3], to: [3, 3], outcome: null }, // d7d5
    { side: 'white', from: [4, 4], to: [3, 3], outcome: 'success' }, // e4xd5 (capture)
    { side: 'black', from: [1, 4], to: [3, 4], outcome: null }, // e7e6
  ];
  for (const s of seq) {
    const move = findMove(board, s.side, s.from, s.to);
    assert(!!move, s.side + ' ' + s.from + '->' + s.to + ' is legal');
    if (!move) break;
    applyOutcome(board, move, s.outcome);
    mpLogTurn(
      board,
      s.side,
      move,
      s.outcome ? mpCaptureInfo(move, s.side, s.outcome === 'success') : null
    );
  }
  const report = replayGame(GameLog.events, Board);
  assert(report.ok, 'replay is ok: ' + JSON.stringify(report.errors));
  assert(report.steps === 4, 'replayed 4 turns (got ' + report.steps + ')');
  assert(report.finalTurn === 'white', 'final turn white (got ' + report.finalTurn + ')');
  assert(report.gameOver === false, 'game not over');
  // The capture turn carries the contested-fight record.
  const capEv = GameLog.events.find((e) => e.capture);
  assert(capEv && capEv.capture.applyCapture === true, 'capture recorded with applyCapture=true');
  assert(capEv && capEv.side === 'white', 'capture attributed to the attacker (white)');
}

// ---------------------------------------------------------------------------
console.log('test 2: PVP game with a FAILED capture (piece removed) replays cleanly');
{
  GameLog.clear();
  const board = new Board();
  const seq = [
    { side: 'white', from: [6, 4], to: [4, 4], outcome: null }, // e2e4
    { side: 'black', from: [1, 3], to: [3, 3], outcome: null }, // d7d5
    { side: 'white', from: [4, 4], to: [3, 3], outcome: 'fail' }, // e4xd5 (race lost)
    { side: 'black', from: [1, 4], to: [3, 4], outcome: null }, // e7e6
  ];
  for (const s of seq) {
    const move = findMove(board, s.side, s.from, s.to);
    assert(!!move, s.side + ' ' + s.from + '->' + s.to + ' is legal');
    if (!move) break;
    applyOutcome(board, move, s.outcome);
    mpLogTurn(
      board,
      s.side,
      move,
      s.outcome ? mpCaptureInfo(move, s.side, s.outcome === 'success') : null
    );
  }
  const report = replayGame(GameLog.events, Board);
  assert(report.ok, 'replay is ok: ' + JSON.stringify(report.errors));
  assert(report.steps === 4, 'replayed 4 turns (got ' + report.steps + ')');
  assert(report.finalTurn === 'white', 'final turn white (got ' + report.finalTurn + ')');
  const capEv = GameLog.events.find((e) => e.capture);
  assert(capEv && capEv.capture.applyCapture === false, 'failed capture recorded with applyCapture=false');
}

// ---------------------------------------------------------------------------
console.log('test 3: the exported log is valid JSON and round-trips');
{
  GameLog.clear();
  const board = new Board();
  const seq = [
    { side: 'white', from: [6, 4], to: [4, 4], outcome: null },
    { side: 'black', from: [1, 3], to: [3, 3], outcome: null },
    { side: 'white', from: [4, 4], to: [3, 3], outcome: 'success' },
  ];
  for (const s of seq) {
    const move = findMove(board, s.side, s.from, s.to);
    if (!move) break;
    applyOutcome(board, move, s.outcome);
    mpLogTurn(
      board,
      s.side,
      move,
      s.outcome ? mpCaptureInfo(move, s.side, s.outcome === 'success') : null
    );
  }
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
  assert(parsed && parsed.events.length === 3, 'three events in the log (got ' + (parsed && parsed.events.length) + ')');
  const report = replayGame(parsed.events, Board);
  assert(report.ok, 'dumped PVP log replays cleanly: ' + JSON.stringify(report.errors));
  // summaryLine should render the capture for on-screen debugging.
  const line = GameLog.summaryLine(parsed.events[2]);
  assert(/\[fight /.test(line), 'summaryLine shows the contested fight: ' + line);
}

// ---------------------------------------------------------------------------
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
