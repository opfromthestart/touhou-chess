// test-board-ui.js — unit tests for the move-animation diff (computeMoveAnim)
// in js/ui/board-ui.js. The diff is pure (prev render + current grid ->
// animation descriptors), so it is tested headless against REAL Board moves:
//   - simple move, capture, en passant, castling, promotion, king capture
// Run with: node tests/test-board-ui.js
const { Board } = require('../js/chess/board.js');
const { computeMoveAnim } = require('../js/ui/board-ui.js');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log('FAIL: ' + msg); }
}

// Snapshot a grid the way BoardUI.render() does: "r,c" -> piece object.
function snapshot(grid) {
  const prev = {};
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (grid[r][c]) prev[r + ',' + c] = grid[r][c];
    }
  }
  return prev;
}

function slides(anims) { return anims.filter(a => a.kind === 'slide'); }
function captures(anims) { return anims.filter(a => a.kind === 'capture'); }
function slideTo(anims, toRow, toCol) {
  return slides(anims).find(a => a.to.row === toRow && a.to.col === toCol);
}

console.log('--- Simple move ---');
{
  const b = new Board();
  const prev = snapshot(b.grid);
  const m = b.getMoves('white').find(m => m.from.row === 6 && m.from.col === 4 && m.to.row === 4); // e2-e4
  b.applyMove(m);
  const anims = computeMoveAnim(prev, b.grid);
  assert(anims.length === 1, 'exactly one animation (got ' + anims.length + ')');
  const s = slideTo(anims, 4, 4);
  assert(!!s, 'slide to e4');
  if (s) {
    assert(s.from.row === 6 && s.from.col === 4, 'slide from e2');
    assert(s.piece === b.grid[4][4], 'slide carries the piece object');
  }
  assert(captures(anims).length === 0, 'no capture animation');
}

console.log('--- Capture ---');
{
  const b = new Board();
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) b.grid[r][c] = null;
  b.grid[4][4] = { color: 'white', type: 'p', character: 'rumia', hasMoved: true };  // e4
  b.grid[3][3] = { color: 'black', type: 'p', character: 'rumia', hasMoved: true };  // d5
  b.turn = 'white';
  const prev = snapshot(b.grid);
  const m = b.getMoves('white').find(m => m.captured);
  assert(!!m, 'a capture move exists');
  b.applyMove(m);
  const anims = computeMoveAnim(prev, b.grid);
  assert(!!slideTo(anims, 3, 3), 'capturing pawn slides to d5');
  const cap = captures(anims).find(a => a.at.row === 3 && a.at.col === 3);
  assert(!!cap, 'captured piece fades on d5');
  if (cap) assert(cap.piece.type === 'p' && cap.piece.color === 'black', 'faded piece is the black pawn');
  assert(anims.length === 2, 'exactly two animations (got ' + anims.length + ')');
}

console.log('--- En passant ---');
{
  const b = new Board();
  b.applyMove({ from: { row: 6, col: 4 }, to: { row: 4, col: 4 }, piece: b.grid[6][4], captured: null, isDoublePawn: true }); // e2-e4
  b.applyMove({ from: { row: 1, col: 3 }, to: { row: 3, col: 3 }, piece: b.grid[1][3], captured: null, isDoublePawn: true }); // d7-d5
  const prev = snapshot(b.grid);
  const m = b.getMoves('white').find(m => m.isEnPassant);
  assert(!!m, 'an en passant move exists');
  b.applyMove(m);
  const anims = computeMoveAnim(prev, b.grid);
  assert(!!slideTo(anims, 2, 3), 'capturing pawn slides to d6');
  // The captured pawn fades on its OWN square (d5 = row 3, col 3), not the
  // landing square — the whole point of identity-based diffing.
  const cap = captures(anims).find(a => a.at.row === 3 && a.at.col === 3);
  assert(!!cap, 'captured pawn fades on d5 (its own square)');
  assert(!captures(anims).some(a => a.at.row === 2 && a.at.col === 3), 'no fade on the landing square');
}

console.log('--- Castling (king AND rook slide) ---');
{
  const b = new Board();
  b.grid[7][5] = null; // bishop f1
  b.grid[7][6] = null; // knight g1
  const prev = snapshot(b.grid);
  const m = b.getMoves('white').find(m => m.isCastle === 'k');
  assert(!!m, 'a kingside castle exists');
  b.applyMove(m);
  const anims = computeMoveAnim(prev, b.grid);
  assert(!!slideTo(anims, 7, 6), 'king slides e1->g1');
  const rook = slideTo(anims, 7, 5);
  assert(!!rook, 'rook slides h1->f1');
  if (rook) {
    assert(rook.from.row === 7 && rook.from.col === 7, 'rook slides from h1');
    assert(rook.piece === b.grid[7][5] && b.grid[7][5].type === 'r', 'rook slide carries the rook object');
  }
  assert(slides(anims).length === 2, 'exactly two slides (got ' + slides(anims).length + ')');
  assert(captures(anims).length === 0, 'no capture animation');
}

console.log('--- Promotion (same piece object slides) ---');
{
  const b = new Board();
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) b.grid[r][c] = null;
  b.grid[1][4] = { color: 'white', type: 'p', character: 'rumia', hasMoved: true }; // e7
  b.turn = 'white';
  const prev = snapshot(b.grid);
  const m = b.getMoves('white').find(m => m.isPromotion);
  assert(!!m, 'a promotion move exists');
  m.promotionPiece = 'q';
  b.applyMove(m);
  const anims = computeMoveAnim(prev, b.grid);
  const s = slideTo(anims, 0, 4);
  assert(!!s, 'pawn slides to e8');
  if (s) {
    assert(s.piece === b.grid[0][4], 'promotion keeps the same piece object (slides, no fade)');
    assert(b.grid[0][4].type === 'q', 'piece is now a queen');
  }
  assert(captures(anims).length === 0, 'no capture animation');
}

console.log('--- King capture (game over) ---');
{
  const b = new Board();
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) b.grid[r][c] = null;
  b.grid[4][4] = { color: 'white', type: 'k', character: 'kaguya', hasMoved: true };  // e4
  b.grid[3][3] = { color: 'black', type: 'p', character: 'rumia', hasMoved: true };   // d5 (captures toward row 7)
  b.turn = 'black';
  const prev = snapshot(b.grid);
  const m = b.getMoves('black').find(m => m.captured && m.captured.type === 'k');
  assert(!!m, 'a king-capture move exists');
  b.applyMove(m);
  const anims = computeMoveAnim(prev, b.grid);
  const cap = captures(anims).find(a => a.at.row === 4 && a.at.col === 4);
  assert(!!cap, 'king fades on e4');
  if (cap) assert(cap.piece.type === 'k', 'faded piece is the king');
  assert(!!slideTo(anims, 4, 4), 'capturing pawn slides to e4');
  assert(b.gameOver === true, 'game over');
}

console.log('--- No change (re-render without a move) ---');
{
  const b = new Board();
  const prev = snapshot(b.grid);
  const anims = computeMoveAnim(prev, b.grid);
  assert(anims.length === 0, 'no animations for an unchanged grid');
}

console.log('--- {piece, el} entry format (as stored by render()) ---');
{
  const b = new Board();
  const prev = {};
  for (const key of Object.keys(snapshot(b.grid))) {
    prev[key] = { piece: b.grid[key.split(',')[0]][key.split(',')[1]], el: null };
  }
  const m = b.getMoves('white').find(m => m.from.row === 6 && m.from.col === 4 && m.to.row === 4);
  b.applyMove(m);
  const anims = computeMoveAnim(prev, b.grid);
  assert(!!slideTo(anims, 4, 4), 'object-format entries diff the same way');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
