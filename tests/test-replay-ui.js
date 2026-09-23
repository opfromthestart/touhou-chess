// test-replay-ui.js — unit tests for the replay viewer's pure logic:
// extractTurnEvents (js/ui/replay-ui.js) and applyTurnEvent
// (js/debug/replay.js), which the on-screen ReplayViewer builds on.
//
// Run: node tests/test-replay-ui.js

global.CONFIG = require('../js/config.js').CONFIG;
const { Board } = require('../js/chess/board.js');
const { applyTurnEvent } = require('../js/debug/replay.js');
const {
  extractTurnEvents,
  formatReplayLine,
  fightBannerText,
} = require('../js/ui/replay-ui.js');

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

// A turn event shaped exactly like main.js logTurn records it.
function mkEvent(side, move, capture, opts = {}) {
  return Object.assign(
    {
      type: 'turn',
      side,
      move: serializeMove(move),
      capture: capture || null,
      failed: !!opts.failed,
      reason: opts.reason || null,
      state: null,
    },
    opts.ev || {}
  );
}

function findMove(board, side, from, to) {
  return board.getMoves(side).find(
    (m) => m.from.row === from[0] && m.from.col === from[1] &&
           m.to.row === to[0] && m.to.col === to[1]
  );
}

// ===========================================================================
console.log('--- extractTurnEvents ---');
{
  const turn = { type: 'turn', side: 'white' };
  const other = { type: 'ai-start', count: 1 };
  assert(extractTurnEvents([turn, other]).length === 1, 'bare array: keeps turn events only');
  assert(extractTurnEvents({ version: 1, events: [turn, other] }).length === 1,
    'envelope: reads .events');
  assert(extractTurnEvents(null) === null, 'null -> null');
  assert(extractTurnEvents({}) === null, 'object without events -> null');
  assert(extractTurnEvents('nope') === null, 'string -> null');
  assert(extractTurnEvents([]).length === 0, 'empty array -> []');
}

// ===========================================================================
console.log('--- applyTurnEvent: plain moves ---');
{
  const b = new Board();
  const m = findMove(b, 'white', [6, 4], [4, 4]); // e2-e4
  assert(!!m, 'e2-e4 exists');
  const ev = mkEvent('white', m);
  const res = applyTurnEvent(b, ev);
  assert(res.ok && res.kind === 'move', 'plain move applies');
  assert(b.grid[4][4] && b.grid[4][4].type === 'p', 'pawn now on e4');
  assert(b.grid[6][4] === null, 'e2 empty');
  assert(b.turn === 'black', 'turn flipped to black');
  assert(res.captured === null && res.removed === null, 'no pieces involved');
}
{
  const b = new Board();
  const m = findMove(b, 'white', [6, 4], [4, 4]);
  const res = applyTurnEvent(b, mkEvent('black', m));
  assert(!res.ok && res.error === 'wrong-side', 'wrong-side rejected');
  assert(b.turn === 'white', 'board untouched after rejection');
}
{
  const b = new Board();
  const res = applyTurnEvent(b, mkEvent('white', null));
  assert(!res.ok && res.error === 'no-move', 'missing move rejected');
}
{
  const b = new Board();
  const ev = { type: 'turn', side: 'white', failed: true, reason: 'pickMove returned no move' };
  const res = applyTurnEvent(b, ev);
  assert(!res.ok && res.error === 'ai-failed', 'recorded AI failure reported');
}
{
  const b = new Board();
  // A serialized move the board would never produce (pawn 6 squares in one
  // go) — models a log that diverged from the board state.
  const ev = {
    type: 'turn',
    side: 'white',
    move: {
      from: { r: 6, c: 4 },
      to: { r: 0, c: 4 },
      pieceType: 'p',
      pieceCharacter: 'cirno',
      capturedType: null,
      capturedCharacter: null,
      flags: {},
    },
    capture: null,
    failed: false,
    reason: null,
    state: null,
  };
  const res = applyTurnEvent(b, ev);
  assert(!res.ok && res.error === 'illegal', 'illegal move (diverged board) rejected');
}

// ===========================================================================
console.log('--- applyTurnEvent: contested captures ---');
{
  // White pawn e4 captures black pawn d5 (fight won by player).
  const b = new Board();
  b.grid[4][4] = { color: 'white', type: 'p', character: 'cirno', hasMoved: true };
  b.grid[3][3] = { color: 'black', type: 'p', character: 'rumia', hasMoved: true };
  b.turn = 'white';
  const m = findMove(b, 'white', [4, 4], [3, 3]);
  assert(!!m && m.captured, 'e4xd5 exists');
  const res = applyTurnEvent(b, mkEvent('white', m, {
    bossId: 'rumia', difficulty: 'normal', initiator: 'player',
    playerPieceType: 'p', result: 'win', applyCapture: true,
  }));
  assert(res.ok && res.kind === 'capture-ok', 'capture-ok applies the move');
  assert(b.grid[3][3] && b.grid[3][3].color === 'white', 'white pawn on d5');
  assert(res.captured && res.captured.character === 'rumia', 'captured piece is Rumia');
  assert(b.turn === 'black', 'turn flipped');
}
{
  // Player initiated but LOST the fight: the capturing piece is removed,
  // the target stays, the turn is consumed.
  const b = new Board();
  b.grid[4][4] = { color: 'white', type: 'p', character: 'cirno', hasMoved: true };
  b.grid[3][3] = { color: 'black', type: 'p', character: 'rumia', hasMoved: true };
  b.turn = 'white';
  const m = findMove(b, 'white', [4, 4], [3, 3]);
  const res = applyTurnEvent(b, mkEvent('white', m, {
    bossId: 'rumia', difficulty: 'normal', initiator: 'player',
    playerPieceType: 'p', result: 'lose', applyCapture: false,
  }));
  assert(res.ok && res.kind === 'capture-fail', 'capture-fail resolves');
  assert(b.grid[4][4] === null, 'capturing pawn removed from e4');
  assert(b.grid[3][3] && b.grid[3][3].color === 'black', 'target pawn survives on d5');
  assert(res.removed && res.removed.character === 'cirno', 'removed piece is the mover');
  assert(b.turn === 'black', 'turn consumed');
}
{
  // AI initiated and WON (player lost): the AI piece captures.
  const b = new Board();
  b.grid[4][4] = { color: 'white', type: 'p', character: 'cirno', hasMoved: true };
  b.grid[3][3] = { color: 'black', type: 'p', character: 'rumia', hasMoved: true };
  b.turn = 'black';
  const m = findMove(b, 'black', [3, 3], [4, 4]);
  const res = applyTurnEvent(b, mkEvent('black', m, {
    bossId: 'cirno', difficulty: 'lunatic', initiator: 'ai',
    playerPieceType: 'p', result: 'lose', applyCapture: true,
  }));
  assert(res.ok && res.kind === 'capture-ok', 'AI capture-ok applies');
  assert(b.grid[4][4] && b.grid[4][4].color === 'black', 'black pawn on e4');
  assert(res.captured && res.captured.color === 'white', 'white pawn captured');
  assert(b.turn === 'white', 'turn back to white');
}

// ===========================================================================
console.log('--- applyTurnEvent: special moves ---');
{
  // Castling kingside: king e1->g1 and rook h1->f1.
  const b = new Board();
  b.grid[7][1] = b.grid[7][2] = b.grid[7][3] = b.grid[7][5] = b.grid[7][6] = null;
  const m = b.getMoves('white').find((x) => x.isCastle === 'k');
  assert(!!m, 'castling move exists');
  const res = applyTurnEvent(b, mkEvent('white', m));
  assert(res.ok, 'castling applies');
  assert(b.grid[7][6] && b.grid[7][6].type === 'k', 'king on g1');
  assert(b.grid[7][5] && b.grid[7][5].type === 'r', 'rook on f1');
}
{
  // En passant: e2-e4, d7-d5, then exd6 e.p.
  const b = new Board();
  b.grid = Array.from({ length: 8 }, () => Array(8).fill(null));
  b.grid[6][4] = { color: 'white', type: 'p', character: 'cirno', hasMoved: false };
  b.grid[1][3] = { color: 'black', type: 'p', character: 'rumia', hasMoved: false };
  b.turn = 'white';
  const m1 = findMove(b, 'white', [6, 4], [4, 4]);
  applyTurnEvent(b, mkEvent('white', m1));
  b.turn = 'black';
  const m2 = findMove(b, 'black', [1, 3], [3, 3]);
  applyTurnEvent(b, mkEvent('black', m2));
  b.turn = 'white';
  const m3 = b.getMoves('white').find((x) => x.isEnPassant);
  assert(!!m3, 'en passant move exists');
  const res = applyTurnEvent(b, mkEvent('white', m3));
  assert(res.ok, 'en passant applies');
  assert(b.grid[2][3] && b.grid[2][3].type === 'p', 'white pawn on d6');
  assert(b.grid[3][3] === null, 'captured pawn removed from d5');
}
{
  // Promotion: the recorded flags carry the chosen piece.
  const b = new Board();
  b.grid = Array.from({ length: 8 }, () => Array(8).fill(null));
  b.grid[1][4] = { color: 'white', type: 'p', character: 'cirno', hasMoved: true };
  b.turn = 'white';
  const m = findMove(b, 'white', [1, 4], [0, 4]);
  assert(!!m && m.isPromotion, 'promoting move exists');
  const ev = mkEvent('white', m);
  ev.move.flags.promotionPiece = 'q';
  const res = applyTurnEvent(b, ev);
  assert(res.ok, 'promotion applies');
  assert(b.grid[0][4] && b.grid[0][4].type === 'q', 'pawn became a queen');
}
{
  // King capture ends the game.
  const b = new Board();
  b.grid = Array.from({ length: 8 }, () => Array(8).fill(null));
  b.grid[4][4] = { color: 'white', type: 'k', character: 'kaguya', hasMoved: true };
  b.grid[3][3] = { color: 'black', type: 'p', character: 'rumia', hasMoved: true };
  b.turn = 'black';
  const m = findMove(b, 'black', [3, 3], [4, 4]);
  const res = applyTurnEvent(b, mkEvent('black', m, {
    bossId: 'kaguya', difficulty: 'lunatic', initiator: 'ai',
    playerPieceType: 'k', result: 'lose', applyCapture: true,
  }));
  assert(res.ok, 'king capture applies');
  assert(b.gameOver && b.winner === 'black', 'game over, black wins');
  const res2 = applyTurnEvent(b, mkEvent('white', findMove(new Board(), 'white', [6, 4], [4, 4])));
  assert(!res2.ok && res2.error === 'game-over', 'no moves after game over');
}

// ===========================================================================
console.log('--- full game round-trip ---');
{
  // Play a scripted game on a live board, record events exactly like
  // main.js does, then replay them on a FRESH board and compare the final
  // position.
  const live = new Board();
  const events = [];
  const script = [
    // [side, from, to, capture?, fight?]
    ['white', [6, 4], [4, 4]],                       // e2-e4
    ['black', [1, 3], [3, 3]],                       // d7-d5
    ['white', [4, 4], [3, 3], true, { result: 'win', applyCapture: true }], // e4xd5
    ['black', [0, 6], [2, 5]],                       // Ng8-f6
    ['white', [7, 1], [5, 2]],                       // Nb1-c3
    ['black', [0, 1], [2, 2]],                       // Nb8-c6
    ['white', [7, 6], [5, 5]],                       // Ng1-f3
    ['black', [1, 6], [2, 6]],                       // g7-g6
  ];
  for (const [side, from, to, cap, fight] of script) {
    const m = findMove(live, side, from, to);
    if (!m) throw new Error('script move not found: ' + side + ' ' + from + '->' + to);
    const capture = cap
      ? {
          bossId: m.captured.character,
          difficulty: side === 'white' ? 'normal' : 'lunatic',
          initiator: side === 'white' ? 'player' : 'ai',
          playerPieceType: m.piece.type,
          result: fight.result,
          applyCapture: fight.applyCapture,
        }
      : null;
    events.push(mkEvent(side, m, capture));
    // Apply to the live board the way the game would.
    if (capture) {
      if (capture.applyCapture) {
        live.applyMove(m);
      } else {
        live.removePiece(from[0], from[1]);
        live.turn = live.turn === 'white' ? 'black' : 'white';
        if (live.turn === 'white') live.fullmoveNumber++;
      }
    } else {
      live.applyMove(m);
    }
  }

  const replay = new Board();
  let ok = true;
  for (const ev of events) {
    const res = applyTurnEvent(replay, ev);
    if (!res.ok) { ok = false; break; }
  }
  assert(ok, 'all ' + events.length + ' recorded events replay');
  let same = true;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const a = live.grid[r][c], z = replay.grid[r][c];
      if (!!a !== !!z) same = false;
      else if (a && (a.type !== z.type || a.color !== z.color || a.character !== z.character)) same = false;
    }
  }
  assert(same, 'final grid matches the live board');
  assert(replay.turn === live.turn, 'final turn matches');
  assert(replay.gameOver === live.gameOver, 'game-over state matches');
}

// ===========================================================================
console.log('--- formatReplayLine / fightBannerText ---');
{
  const ev = mkEvent('white', findMove(new Board(), 'white', [6, 4], [4, 4]));
  const line = formatReplayLine(ev);
  assert(line.includes('e2') && line.includes('e4'), 'line has squares: ' + line);
  assert(line.startsWith(CONFIG.CHARACTERS.cirno), 'line starts with the mover name');

  const capEv = mkEvent('white',
    (() => {
      const b = new Board();
      b.grid[4][4] = { color: 'white', type: 'p', character: 'cirno', hasMoved: true };
      b.grid[3][3] = { color: 'black', type: 'p', character: 'rumia', hasMoved: true };
      b.turn = 'white';
      return findMove(b, 'white', [4, 4], [3, 3]);
    })(),
    { bossId: 'rumia', difficulty: 'normal', initiator: 'player',
      playerPieceType: 'p', result: 'win', applyCapture: true });
  const banner = fightBannerText(capEv);
  assert(banner && banner.includes('Rumia') && banner.includes('Spell Card Break'),
    'win banner names boss + break: ' + banner);
  assert(formatReplayLine(capEv).includes('×'), 'line marks the capture');

  const loseEv = JSON.parse(JSON.stringify(capEv));
  loseEv.capture.result = 'lose';
  loseEv.capture.applyCapture = false;
  const loseBanner = fightBannerText(loseEv);
  assert(loseBanner && loseBanner.includes('you lost'), 'loss banner: ' + loseBanner);
  assert(fightBannerText(mkEvent('white', findMove(new Board(), 'white', [6, 4], [4, 4]))) === null,
    'no banner for a plain move');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
