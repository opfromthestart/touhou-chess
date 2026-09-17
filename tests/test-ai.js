// test-ai.js — verify the AI makes valid moves and a game can progress (node test-ai.js)
// Make CONFIG a global so ai.js (which uses it as a free variable) can see it.
global.CONFIG = require('../js/config.js').CONFIG;

const { Board } = require('../js/chess/board.js');
const ai = require('../js/chess/ai.js');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS:', msg); }
  else { failed++; console.log('  FAIL:', msg); }
}

console.log('--- AI (black) makes valid moves over 30 plies ---');
{
  const b = new Board();
  ai.resetSurvival();
  let valid = true;
  let plies = 0;
  for (let i = 0; i < 30 && !b.gameOver; i++) {
    const moves = b.getMoves(b.turn);
    if (moves.length === 0) { valid = false; break; }
    // White: simple move (first available). Black: the AI.
    const move = b.turn === 'black' ? ai.pickMove(b) : moves[0];
    if (!move) { valid = false; console.log('  no move at ply', i); break; }
    const isLegal = moves.some(m =>
      m.from.row === move.from.row && m.from.col === move.from.col &&
      m.to.row === move.to.row && m.to.col === move.to.col
    );
    if (!isLegal) { valid = false; console.log('  illegal move at ply', i); break; }
    b.applyMove(move);
    plies++;
  }
  assert(valid, 'AI made valid moves over 30 plies (no illegal moves)');
  console.log('  plies played:', plies, 'gameOver:', b.gameOver);
}

console.log('--- AI responds on move 1 ---');
{
  const b = new Board();
  ai.resetSurvival();
  b.applyMove(b.getMoves('white').find(m => m.from.col === 4 && m.isDoublePawn));
  const aiMove = ai.pickMove(b);
  assert(aiMove !== null, 'AI responded');
  console.log('  AI move:', aiMove.piece.character, 'from', aiMove.from.col, aiMove.from.row, '->', aiMove.to.col, aiMove.to.row);
}

console.log('--- AI can capture a loose pawn ---');
{
  const b = new Board();
  ai.resetSurvival();
  b.applyMove(b.getMoves('white').find(m => m.from.col === 4 && m.isDoublePawn)); // e2-e4
  const d5 = b.getMoves('black').find(m => m.from.col === 3 && m.isDoublePawn); // d7-d5
  b.applyMove(d5);
  const cap = b.getMoves('black').find(m => m.captured && m.captured.type === 'p' && m.to.col === 4 && m.to.row === 4);
  assert(!!cap, 'black pawn d5 can capture e4');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
