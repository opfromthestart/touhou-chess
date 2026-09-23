// tmp-selfplay.js — headless self-play diagnostic.
//
// Plays full games with:
//   - White (the "player"): a simple greedy human-approximation (develop,
//     capture when safe, don't hang pieces).
//   - Black (the AI): the game's own pickMove at the given depth.
//
// It reports, per game and in aggregate:
//   - plies, captures by each side, final winner, material at end
//   - whether the AI left pieces en prise (blunders)
//   - any softlock (no legal move) or illegal move
//
// Usage: node tests/tmp-selfplay.js [games] [depth]   (default 8 games, depth 3)
'use strict';
global.CONFIG = require('../js/config.js').CONFIG;
const { Board } = require('../js/chess/board.js');
const ai = require('../js/chess/ai.js');

const VALUE = { p: 1, n: 3, b: 3.2, r: 5, q: 9, k: 200 };

function sqName(m) {
  const FILES = 'abcdefgh';
  return FILES[m.from.col] + (8 - m.from.row) + '-' + FILES[m.to.col] + (8 - m.to.row);
}

// Material on the board from `side`'s perspective (positive = side ahead).
function material(board, side) {
  let s = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = board.grid[r][c];
    if (!p) continue;
    const v = VALUE[p.type] || 0;
    if (p.color === side) s += v; else s -= v;
  }
  return s;
}

// Squares (row,col) that `side` attacks.
function attackedSquares(board, side) {
  const set = new Set();
  for (const m of board.getMoves(side)) set.add(m.to.row + ',' + m.to.col);
  return set;
}

// Pieces of `side` that are hanging: attacked by the opponent, not defended,
// and worth more than the cheapest attacker that reaches them.
function hangingPieces(board, side) {
  const opp = side === 'white' ? 'black' : 'white';
  const oppAtk = attackedSquares(board, opp);
  const sideAtk = attackedSquares(board, side);
  const hanging = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = board.grid[r][c];
    if (!p || p.color !== side || p.type === 'k') continue;
    const key = r + ',' + c;
    if (!oppAtk.has(key)) continue;
    if (sideAtk.has(key)) continue;
    let minAttacker = Infinity;
    for (const m of board.getMoves(opp)) {
      if (m.to.row === r && m.to.col === c) minAttacker = Math.min(minAttacker, VALUE[m.piece.type]);
    }
    if (minAttacker < VALUE[p.type]) hanging.push({ piece: p.type, at: r + ',' + c, value: VALUE[p.type] });
  }
  return hanging;
}

// Find the white king's square.
function findKing(board, color) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = board.grid[r][c];
    if (p && p.type === 'k' && p.color === color) return { row: r, col: c };
  }
  return null;
}

// Is the white king attacked right now?
function kingInDanger(board) {
  const k = findKing(board, 'white');
  if (!k) return false;
  return board.squareAttacked(k.row, k.col, 'black');
}

// Competent "player" move for white: defend the king, castle when safe,
// develop, capture when safe, avoid hanging. This approximates a reasonable
// human so the self-play read on the AI is fair.
function playerMove(board) {
  const moves = board.getMoves('white');
  if (!moves.length) return null;
  const danger = kingInDanger(board);
  let best = null, bestScore = -Infinity;
  for (const m of moves) {
    const b2 = board.clone();
    b2.applyMove(m);
    let score = 0;

    // 1. King safety: if the king was in danger, strongly reward moves that
    //    get it out of danger (move to a safe square, capture an attacker, or
    //    block). Penalize moves that leave it in danger.
    if (danger) {
      const stillDanger = kingInDanger(b2);
      if (!stillDanger) score += 12;
      else score -= 10;
    }

    // 2. Castling: big bonus when safe (gets the king to safety + connects
    //    rooks). Only take it if the king isn't currently in danger.
    if (m.isCastle && !danger) score += 6;

    // 3. Development: move knights/bishops out of the back rank.
    if ((m.piece.type === 'n' || m.piece.type === 'b') && m.from.row === 0) score += 1.2;

    // 4. Material: capture when it's a net gain.
    if (m.captured) score += VALUE[m.captured.type];

    // 5. Hanging: penalize leaving a piece en prise after the move.
    for (const h of hangingPieces(b2, 'white')) score -= h.value * 1.5;

    // 6. Center preference.
    const cc = Math.abs(3.5 - m.to.col) + Math.abs(3.5 - m.to.row);
    score += (7 - cc) * 0.05;

    // 7. Slight randomness to vary games.
    score += Math.random() * 0.1;

    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}

// Strong white player: the SAME AI logic as black, but from white's
// perspective (negated evaluation). This is the strongest possible test
// opponent, so if black still wins fast against it, the AI is genuinely too
// strong (not just beating a weak bot).
function pickMoveWhite(board, depth) {
  const moves = board.getMoves('white');
  if (!moves.length) return null;
  moves.sort((a, b) => (b.captured ? 1 : 0) - (a.captured ? 1 : 0));
  let bestMove = moves[0];
  let bestScore = -Infinity;
  const scored = [];
  for (const move of moves) {
    const nb = board.clone();
    nb.applyMove(move);
    const raw = ai.search(nb, depth - 1, -1e9, 1e9);
    const score = -raw + (Math.random() - 0.5) * 0.3; // negate: white's perspective
    scored.push({ move, score });
    if (score > bestScore) { bestScore = score; bestMove = move; }
  }
  if (scored.length > 1) {
    scored.sort((a, b) => b.score - a.score);
    const top = scored.filter(s => s.score >= bestScore - 0.5);
    if (top.length > 1 && Math.random() < 0.3) {
      bestMove = top[Math.floor(Math.random() * top.length)].move;
    }
  }
  return bestMove;
}

function playGame(depth, useAiWhite) {
  const board = new Board();
  ai.resetSurvival();
  const log = [];
  let capturesWhite = 0, capturesBlack = 0;
  let aiBlunders = 0, playerBlunders = 0;
  let softlock = false, illegal = false;
  let plies = 0;

  while (!board.gameOver && plies < 400) {
    const side = board.turn;
    const moves = board.getMoves(side);
    if (!moves.length) { softlock = true; break; }

    let move;
    if (side === 'black') move = ai.pickMove(board, depth);
    else move = useAiWhite ? pickMoveWhite(board, depth) : playerMove(board);

    if (!move) { softlock = true; break; }
    const legal = moves.some(m => m.from.row === move.from.row && m.from.col === move.from.col && m.to.row === move.to.row && m.to.col === move.to.col);
    if (!legal) { illegal = true; break; }

    board.applyMove(move);
    plies++;

    if (move.captured) {
      if (side === 'white') capturesWhite++; else capturesBlack++;
      log.push(`${side === 'white' ? 'W' : 'B'} CAP ${move.piece.character} x ${move.captured.character} (${sqName(move)})`);
    } else {
      log.push(`${side === 'white' ? 'W' : 'B'} ${move.piece.character} ${sqName(move)}`);
    }

    const hang = hangingPieces(board, side);
    if (side === 'black') aiBlunders += hang.length;
    else playerBlunders += hang.length;
  }

  return {
    plies,
    winner: board.winner || (softlock ? 'softlock' : 'incomplete'),
    capturesWhite, capturesBlack,
    aiBlunders, playerBlunders,
    softlock, illegal,
    matEnd: material(board, 'white'),
    log,
  };
}

const games = parseInt(process.argv[2] || '8', 10);
const depth = parseInt(process.argv[3] || '3', 10);
// --ai-white: make white also use the AI (self-play). Without it, white is a
// competent human approximation.
const useAiWhite = process.argv.includes('--ai-white');
// Env overrides for A/B testing the AI tuning (ai.js reads CONFIG at call time):
//   SELFPLAY_DOOMED=<n>  override CONFIG.AI_KING_PENALTIES.doomed
//   SELFPLAY_DEV=<n>     override CONFIG.AI_DEV_BONUS
if (process.env.SELFPLAY_DOOMED) CONFIG.AI_KING_PENALTIES.doomed = parseFloat(process.env.SELFPLAY_DOOMED);
if (process.env.SELFPLAY_DEV) CONFIG.AI_DEV_BONUS = parseFloat(process.env.SELFPLAY_DEV);

let winsWhite = 0, winsBlack = 0, softlocks = 0, illegals = 0;
let totalPlies = 0, totalAiBlunders = 0, totalPlayerBlunders = 0, totalCapW = 0, totalCapB = 0;

for (let g = 0; g < games; g++) {
  const r = playGame(depth, useAiWhite);
  totalPlies += r.plies;
  totalAiBlunders += r.aiBlunders;
  totalPlayerBlunders += r.playerBlunders;
  totalCapW += r.capturesWhite;
  totalCapB += r.capturesBlack;
  if (r.winner === 'white') winsWhite++;
  else if (r.winner === 'black') winsBlack++;
  if (r.softlock) softlocks++;
  if (r.illegal) illegals++;
  console.log(`game ${g + 1}: ${r.plies} plies, winner=${r.winner}, caps W=${r.capturesWhite}/B=${r.capturesBlack}, ` +
    `AI-hangs=${r.aiBlunders} player-hangs=${r.playerBlunders}, matEnd(W+)=${r.matEnd}` +
    (r.softlock ? ' [SOFTLOCK]' : '') + (r.illegal ? ' [ILLEGAL]' : ''));
}

console.log('\n=== aggregate ===');
console.log(`games: ${games}  white-wins: ${winsWhite}  black-wins: ${winsBlack}  softlocks: ${softlocks}  illegal: ${illegals}`);
console.log(`avg plies: ${(totalPlies / games).toFixed(1)}`);
console.log(`captures/game: W=${(totalCapW / games).toFixed(1)}  B=${(totalCapB / games).toFixed(1)}`);
console.log(`hanging pieces left/game: AI=${(totalAiBlunders / games).toFixed(1)}  player=${(totalPlayerBlunders / games).toFixed(1)}`);
