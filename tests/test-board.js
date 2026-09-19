// test-board.js — quick sanity tests for the chess core (run with: node test-board.js)
const { Board } = require('../js/chess/board.js');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS:', msg); }
  else { failed++; console.log('  FAIL:', msg); }
}

console.log('--- Initial position ---');
{
  const b = new Board();
  const whiteMoves = b.getMoves('white');
  assert(whiteMoves.length === 20, `white has 20 opening moves (got ${whiteMoves.length})`);
  const blackMoves = b.getMoves('black');
  assert(blackMoves.length === 20, `black has 20 opening moves (got ${blackMoves.length})`);
}

console.log('--- Pawn moves + double ---');
{
  const b = new Board();
  // e2 pawn (row 6, col 4) can move to e3 and e4.
  const moves = b.getMoves('white').filter(m => m.piece.character === 'reimu' ? false : (m.from.row === 6 && m.from.col === 4));
  assert(moves.length === 2, 'e-pawn has 2 moves (e3, e4)');
  assert(moves.some(m => m.isDoublePawn), 'e-pawn has a double move');
}

console.log('--- En passant ---');
{
  const b = new Board();
  // White pawn e2-e4 (double), black pawn d7-d5, white captures en passant.
  b.applyMove({ from: { row: 6, col: 4 }, to: { row: 4, col: 4 }, piece: b.grid[6][4], captured: null, isDoublePawn: true });
  b.applyMove({ from: { row: 1, col: 3 }, to: { row: 3, col: 3 }, piece: b.grid[1][3], captured: null, isDoublePawn: true });
  assert(b.enPassantTarget && b.enPassantTarget.row === 2 && b.enPassantTarget.col === 3, 'en passant target set to d6 (row2,col3)');
  const epMoves = b.getMoves('white').filter(m => m.isEnPassant);
  assert(epMoves.length === 1, `white has 1 en passant move (got ${epMoves.length})`);
  if (epMoves.length === 1) {
    b.applyMove(epMoves[0]);
    assert(b.grid[3][3] === null, 'captured pawn removed from d5 (row3,col3)');
    assert(b.grid[2][3] && b.grid[2][3].type === 'p', 'capturing pawn landed on d6 (row2,col3)');
    assert(b.grid[4][4] === null, 'capturing pawn left e4 (row4,col4)');
  }
}

console.log('--- Castling (kingside) ---');
{
  const b = new Board();
  // Clear the path: move f1 bishop, g1 knight, and the pawns in the way.
  // Simplest: manually clear squares f1, g1 (row7 col5, col6).
  b.grid[7][5] = null; // bishop f1
  b.grid[7][6] = null; // knight g1
  const castleMoves = b.getMoves('white').filter(m => m.isCastle);
  assert(castleMoves.some(m => m.isCastle === 'k'), 'kingside castle available');
  const kCastle = castleMoves.find(m => m.isCastle === 'k');
  b.applyMove(kCastle);
  assert(b.grid[7][6] && b.grid[7][6].type === 'k', 'king on g1');
  assert(b.grid[7][5] && b.grid[7][5].type === 'r', 'rook on f1');
  assert(b.castling.white.k === false, 'white kingside right lost');
}

console.log('--- Castle en passant ---');
{
  const b = new Board();
  // Set up: white castles kingside. Put a black knight on e3 (row 5, col 4)
  // so it attacks f1 (the middle square, row7 col5).
  b.grid[7][5] = null; // clear f1 bishop
  b.grid[7][6] = null; // clear g1 knight
  // Remove the white pawns that would block, and place a black knight attacking f1.
  // A knight on e3 (row5,col4) attacks f1 (row7,col5)? e3->f1: dr=2,dc=1 yes.
  b.grid[5][4] = makeKnightBlack(b);
  const kCastle = b.getMoves('white').find(m => m.isCastle === 'k');
  assert(!!kCastle, 'kingside castle available with knight on e3');
  b.applyMove(kCastle);
  assert(b.castleEnPassant !== null, 'castle en passant right granted');
  assert(b.castleEnPassant.color === 'black', 'right belongs to black');
  assert(b.castleEnPassant.destination.row === 7 && b.castleEnPassant.destination.col === 6, 'destination is g1');
  // Now black should have a special capture: knight e3 captures king on g1.
  const special = b.getMoves('black').filter(m => m.castleEnPassant);
  assert(special.length === 1, `black has 1 castle-en-passant capture (got ${special.length})`);
  if (special.length === 1) {
    b.applyMove(special[0]);
    assert(b.gameOver === true, 'game over after king captured');
    assert(b.winner === 'black', 'black wins');
  }
}

function makeKnightBlack(b) {
  return { type: 'n', color: 'black', character: 'nitori', hasMoved: true };
}

console.log('--- King in check detection ---');
{
  const b = new Board();
  assert(b.kingInCheck('white') === false, 'white king not in check at start');
  assert(b.kingInCheck('black') === false, 'black king not in check at start');
  // A black rook on e2 (row6,col4), with the white e2 pawn removed, attacks
  // the white king on e1 (row7,col4).
  b.grid[6][4] = null;
  b.grid[6][4] = { type: 'r', color: 'black', character: 'remilia', hasMoved: true };
  assert(b.kingInCheck('white') === true, 'white king in check from rook on e2');
  assert(b.kingInCheck('black') === false, 'black king still not in check');
}

console.log('--- Castle en passant: king starts in check ---');
{
  const b = new Board();
  // White castles kingside while the king is in check: black rook on e2
  // (row6,col4) attacks e1 (row7,col4). The middle square f1 (row7,col5) is
  // NOT attacked, so the right must come from the starting check alone.
  b.grid[6][4] = null; // white e2 pawn
  b.grid[7][5] = null; // f1 bishop
  b.grid[7][6] = null; // g1 knight
  b.grid[6][4] = { type: 'r', color: 'black', character: 'remilia', hasMoved: true };
  assert(b.kingInCheck('white') === true, 'white king starts in check');
  assert(b.squareAttacked(7, 5, 'black') === false, 'middle square f1 not attacked');
  const kCastle = b.getMoves('white').find(m => m.isCastle === 'k');
  assert(!!kCastle, 'kingside castle available while in check');
  b.applyMove(kCastle);
  assert(b.castleEnPassant !== null, 'castle en passant right granted from starting check');
  assert(b.castleEnPassant.color === 'black', 'right belongs to black');
  assert(b.castleEnPassant.destination.row === 7 && b.castleEnPassant.destination.col === 6, 'destination is g1');
  // No black piece attacks the middle square f1, so the right is granted but
  // not yet usable (usage requires attacking the middle square).
  const special = b.getMoves('black').filter(m => m.castleEnPassant);
  assert(special.length === 0, `no usable special capture yet (got ${special.length})`);
}

console.log('--- Castle en passant: checked king, checking piece uses the right ---');
{
  const b = new Board();
  // Black queen on e2 (row6,col4) checks the white king on e1 AND attacks the
  // middle square f1 (row7,col5) diagonally. After white castles kingside,
  // the queen can capture the king on g1 via the special right.
  b.grid[6][4] = null; // white e2 pawn
  b.grid[7][5] = null; // f1 bishop
  b.grid[7][6] = null; // g1 knight
  b.grid[6][4] = { type: 'q', color: 'black', character: 'yukari', hasMoved: true };
  assert(b.kingInCheck('white') === true, 'white king starts in check');
  const kCastle = b.getMoves('white').find(m => m.isCastle === 'k');
  assert(!!kCastle, 'kingside castle available');
  b.applyMove(kCastle);
  assert(b.castleEnPassant !== null, 'castle en passant right granted');
  const special = b.getMoves('black').filter(m => m.castleEnPassant);
  assert(special.length === 1, `black has 1 castle-en-passant capture (got ${special.length})`);
  if (special.length === 1) {
    b.applyMove(special[0]);
    assert(b.gameOver === true, 'game over after king captured');
    assert(b.winner === 'black', 'black wins');
  }
}

console.log('--- King capture ends game ---');
{
  const b = new Board();
  // Clear e2 pawn and put a black rook there, adjacent to the white king on e1.
  b.grid[6][4] = null;
  b.grid[6][4] = { type: 'r', color: 'black', character: 'remilia', hasMoved: true };
  const capMoves = b.getMoves('black').filter(m => m.captured && m.captured.type === 'k');
  assert(capMoves.length >= 1, 'black can capture white king');
  b.applyMove(capMoves[0]);
  assert(b.gameOver === true, 'game over');
  assert(b.winner === 'black', 'black wins');
}

console.log('--- No check: king can move onto attacked square ---');
{
  const b = new Board();
  // White king e1, black rook on e8 (row0,col4) attacks e-file.
  // King e1 (row7,col4) can move to e2 (row6,col4)? e2 is occupied by pawn.
  // Move king to d1 (row7,col3) which is attacked by... let's just verify the king
  // has moves onto squares attacked by the enemy rook on e8.
  b.grid[0][4] = { type: 'r', color: 'black', character: 'remilia', hasMoved: true };
  // Clear e2 pawn so king can go up the e-file (attacked by rook).
  b.grid[6][4] = null;
  const kingMoves = b.getMoves('white').filter(m => m.piece.type === 'k');
  // King e1 can move to e2 (row6,col4) which is attacked by the rook on e8.
  assert(kingMoves.some(m => m.to.row === 6 && m.to.col === 4), 'king can move onto attacked e2');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
