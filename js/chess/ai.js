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

// King-danger terms for the static evaluation.
//
// This game has no check rule: a king may legally sit on an attacked square,
// so the search gets no "check" signal to react to. The only way a doomed
// king shows up in the search is when the actual capture move is inside the
// horizon — a threat two moves away (e.g. "the queen sneaks to h5 and traps
// the king") is invisible at depth 3. Model king danger directly:
//   - King attacked but answerable (safe escape square, or a friendly piece
//     can capture an attacker): moderate penalty — the side must spend a
//     tempo responding.
//   - King attacked with no safe escape and no way to take the attacker:
//     the king is doomed within a move; heavy penalty. It stays below
//     INFINITY so a real game-over loss still ranks worse (and a delayed
//     doom ranks worse than a saved king).
//
// Both penalties are tunable via CONFIG.AI_KING_PENALTIES (see config.js).
// They are read at call time (not module load) so tests can override them.
function kingAttackPenalty() { return CONFIG.AI_KING_PENALTIES.attacked; }
function kingDoomedPenalty() { return CONFIG.AI_KING_PENALTIES.doomed; }

function findKing(board, color) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board.grid[r][c];
      if (p && p.type === 'k' && p.color === color) return { row: r, col: c };
    }
  }
  return null;
}

// Is (r,c) attacked by any `byColor` piece other than the one at (skipR,skipC)?
// (Used for escape squares the king would capture the attacker on: the
// captured piece no longer guards its own square.)
function attackedExcept(board, r, c, byColor, skipR, skipC) {
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if (row === skipR && col === skipC) continue;
      const p = board.grid[row][col];
      if (!p || p.color !== byColor) continue;
      if (board.attacksSquare(row, col, r, c)) return true;
    }
  }
  return false;
}

// Score from black's perspective: negative when the black king is in danger,
// positive when the white king is.
function kingDangerScore(board) {
  const attackedPenalty = kingAttackPenalty();
  const doomedPenalty = kingDoomedPenalty();
  let score = 0;
  for (const color of ['white', 'black']) {
    const enemy = color === 'white' ? 'black' : 'white';
    const king = findKing(board, color);
    if (!king) continue; // captured; gameOver is handled by the search
    if (!board.squareAttacked(king.row, king.col, enemy)) continue;
    // 1. Safe escape: an adjacent square the king can move to (empty, or an
    //    enemy piece it could capture) that no other enemy piece attacks.
    let hasEscape = false;
    for (let dr = -1; dr <= 1 && !hasEscape; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const ar = king.row + dr, ac = king.col + dc;
        if (!board.inBounds(ar, ac)) continue;
        const occ = board.grid[ar][ac];
        if (occ && occ.color === color) continue; // own piece blocks
        const safe = occ
          ? !attackedExcept(board, ar, ac, enemy, ar, ac)
          : !board.squareAttacked(ar, ac, enemy);
        if (safe) { hasEscape = true; break; }
      }
    }
    if (hasEscape) {
      score += color === 'black' ? -attackedPenalty : attackedPenalty;
      continue;
    }
    // 2. Answerable: some friendly piece (other than the king, whose captures
    //    are covered by the escape check above) can take one of the attackers.
    let answerable = false;
    for (let r = 0; r < 8 && !answerable; r++) {
      for (let c = 0; c < 8 && !answerable; c++) {
        const p = board.grid[r][c];
        if (!p || p.color !== enemy) continue;
        if (!board.attacksSquare(r, c, king.row, king.col)) continue;
        for (let r2 = 0; r2 < 8 && !answerable; r2++) {
          for (let c2 = 0; c2 < 8 && !answerable; c2++) {
            const d = board.grid[r2][c2];
            if (d && d.color === color && d.type !== 'k' &&
                board.attacksSquare(r2, c2, r, c)) answerable = true;
          }
        }
      }
    }
    const penalty = answerable ? attackedPenalty : doomedPenalty;
    score += color === 'black' ? -penalty : penalty;
  }
  return score;
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
  score += kingDangerScore(board);
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
      // Development: reward knights/bishops/rooks that have moved off the
      // back rank. This nudges the AI to develop before launching a king
      // attack, keeping games longer and more balanced (see config.js
      // AI_DEV_BONUS).
      if (piece.type === 'n' || piece.type === 'b' || piece.type === 'r') {
        const backRank = piece.color === 'black' ? 7 : 0;
        if (r !== backRank) {
          const devBonus = CONFIG.AI_DEV_BONUS;
          if (piece.color === 'black') bonus += devBonus;
          else bonus -= devBonus;
        }
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
  // Add a little randomness among near-equal moves to vary games.
  // Each root move is searched with a FULL window (-INFINITY, INFINITY) so
  // its score is EXACT. An incremental/narrow window can return a fail-low or
  // fail-high BOUND that is not the true value; treating those bounds as exact
  // scores let the near-best filter below randomly pick a losing move (e.g. a
  // move that loses the king in one reply but only looks "about as good" as
  // the true best under a narrowed window). Full windows are cheap at this
  // depth and make the root selection correct.
  const scored = [];
  for (const move of moves) {
    const nb = board.clone();
    nb.applyMove(move);
    const raw = search(nb, depth - 1, -INFINITY, INFINITY);
    const score = raw + (Math.random() - 0.5) * 0.3;
    scored.push({ move, score });
    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
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
  // The book is purely heuristic (no search), so never offer a move that
  // lets the enemy capture our king in one reply — e.g. a "sensible" bishop
  // capture that opens a queen diagonal to the king. If nothing is safe,
  // return null and let the real search (which handles king danger) choose.
  const safe = moves.filter(m => {
    const nb = board.clone();
    nb.applyMove(m);
    return !nb.getMoves('white').some(mv => mv.captured && mv.captured.type === 'k');
  });
  if (safe.length === 0) return null;
  // Prefer central pawn moves and knight development.
  const scored = safe.map(m => {
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
    kingDangerScore,
  };
}
