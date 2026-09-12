// ai.js — the youkai-boss AI (plays black).
// Minimax with alpha-beta pruning + a capture-risk model: because captures are
// contested by danmaku fights, the AI weights captures by the probability the
// fight goes its way. It avoids leaving pieces en prise (you usually win Normal)
// and pounces when a Lunatic capture is on (you usually lose).
// Uses the same no-check rules: it may sit adjacent to your king and capture
// into "check"; it only cares about the fight odds.

const INFINITY = 1e9;

// Survival prior: P(you win the fight) for a given boss + difficulty.
// Adapted at runtime (see adaptSurvival).
const survivalState = {};

function survivalPrior(character, difficulty) {
  const base = (CONFIG.SURVIVAL_PRIORS[character] || {})[difficulty];
  if (base === undefined) return 0.5;
  const adapt = survivalState[character + ':' + difficulty];
  if (adapt === undefined) return base;
  // Blend the base prior with the runtime adaptation (moving average).
  return 0.5 * base + 0.5 * adapt;
}

// Record the outcome of a fight to adapt the survival prior.
// `youWon` is true if the player survived the fight.
function adaptSurvival(character, difficulty, youWon) {
  const key = character + ':' + difficulty;
  const prev = survivalState[key];
  const observed = youWon ? 1 : 0;
  if (prev === undefined) {
    survivalState[key] = observed;
  } else {
    // Exponential moving average, slow adaptation.
    survivalState[key] = 0.8 * prev + 0.2 * observed;
  }
}

// Reset runtime adaptation (on new game).
function resetSurvival() {
  for (const k in survivalState) delete survivalState[k];
}

// Static evaluation from the AI's (black's) perspective.
// Positive = good for the AI.
function evaluate(board) {
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board.grid[r][c];
      if (!piece) continue;
      const value = CONFIG.PIECE_VALUES[piece.type];
      if (piece.type === 'k') {
        // Kings are worth a lot; capturing one ends the game.
        score += piece.color === 'black' ? 100 : -100;
        continue;
      }
      if (piece.color === 'black') {
        // AI piece. The player might capture it (Normal fight). The AI keeps it
        // with P(player loses Normal).
        const pPlayerWins = survivalPrior(piece.character, 'normal');
        score += value * (1 - pPlayerWins);
      } else {
        // Player piece. A threat to the AI. The AI can capture it (Lunatic fight)
        // and wins with P(player loses Lunatic). Use the piece's own boss tier as
        // a proxy for the capturing AI piece's boss.
        const bossChar = bossForPieceType(piece.type);
        const pPlayerLosesLunatic = 1 - survivalPrior(bossChar, 'lunatic');
        // The piece is a full threat, but the AI has a chance to remove it.
        score -= value * (1 - 0.5 * pPlayerLosesLunatic);
      }
    }
  }
  score += positionalBonus(board);
  return score;
}

// A representative boss for a piece type (for the capture-risk proxy).
function bossForPieceType(type) {
  const map = { p: 'rumia', n: 'nitori', b: 'patchouli', r: 'remilia', q: 'yukari', k: 'kaguya' };
  return map[type] || 'rumia';
}

function positionalBonus(board) {
  let bonus = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board.grid[r][c];
      if (!piece || piece.type === 'k') continue;
      // Center control: closer to center is better.
      const centerDist = Math.abs(r - 3.5) + Math.abs(c - 3.5);
      const centerBonus = (3.5 - centerDist) * 0.08;
      if (piece.color === 'black') bonus += centerBonus;
      else bonus -= centerBonus;
      // Pawn advancement: pawns further up the board are better.
      if (piece.type === 'p') {
        const adv = piece.color === 'black' ? (6 - r) / 6 : (r - 1) / 6;
        const pawnBonus = adv * 0.3;
        if (piece.color === 'black') bonus += pawnBonus;
        else bonus -= pawnBonus;
      }
    }
  }
  return bonus;
}

// Minimax with alpha-beta. Returns score from the AI's perspective.
function search(board, depth, alpha, beta) {
  if (board.gameOver) {
    // A king was captured.
    return board.winner === 'black' ? INFINITY : -INFINITY;
  }
  if (depth === 0) {
    return evaluate(board);
  }
  const moves = board.getMoves(board.turn);
  if (moves.length === 0) {
    // No legal moves (shouldn't happen with no check, but guard anyway).
    return board.turn === 'black' ? -INFINITY + 1 : INFINITY - 1;
  }
  // Order moves: captures first (better pruning).
  moves.sort((a, b) => (b.captured ? 1 : 0) - (a.captured ? 1 : 0));

  if (board.turn === 'black') {
    let best = -Infinity;
    for (const move of moves) {
      const nb = board.clone();
      nb.applyMove(move);
      const score = search(nb, depth - 1, alpha, beta);
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const move of moves) {
      const nb = board.clone();
      nb.applyMove(move);
      const score = search(nb, depth - 1, alpha, beta);
      if (score < best) best = score;
      if (best < beta) beta = best;
      if (beta <= alpha) break;
    }
    return best;
  }
}

// Small opening book: sane first moves for black to avoid blundering.
const OPENING_BOOK = [
  // Responds to common white first moves with sensible black replies.
  // Each entry: { whiteMove: "e2e4", blackMoves: ["d7d5", "e7e6", ...] }
];

// Pick the AI's move. `board` is the current position (it's black's turn).
// `depthOverride` (optional) lets the UI select an AI strength; defaults to
// CONFIG.AI_DEPTH.
function pickMove(board, depthOverride) {
  if (board.gameOver) return null;
  if (board.turn !== 'black') return null;

  // Opening book: for the first few moves, play a sane randomized opening.
  if (board.moveHistory.length < 6) {
    const opening = pickOpeningMove(board);
    if (opening) return opening;
  }

  const depth = depthOverride || CONFIG.AI_DEPTH;
  const moves = board.getMoves('black');
  moves.sort((a, b) => (b.captured ? 1 : 0) - (a.captured ? 1 : 0));

  let bestMove = moves[0];
  let bestScore = -Infinity;
  let alpha = -INFINITY;
  const beta = INFINITY;
  // Add a little randomness among near-equal moves to vary games.
  const scored = [];
  for (const move of moves) {
    const nb = board.clone();
    nb.applyMove(move);
    const score = search(nb, depth - 1, alpha, beta) + (Math.random() - 0.5) * 0.3;
    scored.push({ move, score });
    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
    if (bestScore > alpha) alpha = bestScore;
  }
  // Occasionally pick a near-best move for variety.
  if (scored.length > 1) {
    scored.sort((a, b) => b.score - a.score);
    const top = scored.filter(s => s.score >= bestScore - 0.5);
    if (top.length > 1 && Math.random() < 0.3) {
      bestMove = top[Math.floor(Math.random() * top.length)].move;
    }
  }
  return bestMove;
}

// A sane randomized opening move for black (first few moves).
function pickOpeningMove(board) {
  const moves = board.getMoves('black');
  if (moves.length === 0) return null;
  // Prefer central pawn moves and knight development.
  const scored = moves.map(m => {
    let s = 0;
    if (m.piece.type === 'p' && (m.piece.character === 'rumia')) {
      // Central pawns (d, e) preferred.
      if (m.from.col === 3 || m.from.col === 4) s += 2;
      if (m.isDoublePawn) s += 1;
    }
    if (m.piece.type === 'n') s += 1.5; // develop knights
    if (m.captured) s += 3; // take material if available
    s += Math.random() * 0.5;
    return { m, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored[0].m;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    pickMove, evaluate, search, survivalPrior, adaptSurvival, resetSurvival,
  };
}
