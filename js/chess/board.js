// board.js — board state, move generation, move application.
// King-capture rules: NO check, NO checkmate, NO stalemate. The game ends only
// when a king is captured. Two kings may be adjacent; a king may move onto an
// attacked square and may capture any enemy piece.
//
// Castle "en passant": when a king castles it passes through the middle square.
// If an enemy piece attacks that middle square, the enemy gains a one-turn
// special right to capture the king on the destination square (where the king
// is now), regardless of normal attack geometry.

const ROWS = 8;
const COLS = 8;

function makePiece(type, color, character) {
  return { type, color, character, hasMoved: false };
}

function cloneGrid(grid) {
  return grid.map(row => row.map(cell => (cell ? { ...cell } : null)));
}

class Board {
  constructor() {
    this.reset();
  }

  reset() {
    this.grid = [];
    for (let r = 0; r < ROWS; r++) this.grid.push(new Array(COLS).fill(null));
    this.turn = 'white';
    this.castling = {
      white: { k: true, q: true },
      black: { k: true, q: true },
    };
    this.enPassantTarget = null; // { row, col } square behind a double-stepped pawn
    this.castleEnPassant = null; // { color, destination, middle } special capture right
    this.halfmoveClock = 0;
    this.fullmoveNumber = 1;
    this.moveHistory = [];
    this.gameOver = false;
    this.winner = null;
    this.setup();
  }

  setup() {
    const g = this.grid;
    // White (protagonists), back rank = row 7.
    g[7][0] = makePiece('r', 'white', 'sakuya');
    g[7][1] = makePiece('n', 'white', 'aya');
    g[7][2] = makePiece('b', 'white', 'sanae');
    g[7][3] = makePiece('q', 'white', 'marisa');
    g[7][4] = makePiece('k', 'white', 'reimu');
    g[7][5] = makePiece('b', 'white', 'reisen');
    g[7][6] = makePiece('n', 'white', 'hatate');
    g[7][7] = makePiece('r', 'white', 'youmu');
    for (let c = 0; c < COLS; c++) g[6][c] = makePiece('p', 'white', 'cirno');
    // Black (bosses), back rank = row 0.
    g[0][0] = makePiece('r', 'black', 'remilia');
    g[0][1] = makePiece('n', 'black', 'nitori');
    g[0][2] = makePiece('b', 'black', 'patchouli');
    g[0][3] = makePiece('q', 'black', 'yukari');
    g[0][4] = makePiece('k', 'black', 'kaguya');
    g[0][5] = makePiece('b', 'black', 'alice');
    g[0][6] = makePiece('n', 'black', 'momiji');
    g[0][7] = makePiece('r', 'black', 'yuyuko');
    for (let c = 0; c < COLS; c++) g[1][c] = makePiece('p', 'black', 'rumia');
  }

  inBounds(r, c) {
    return r >= 0 && r < ROWS && c >= 0 && c < COLS;
  }

  // Does the piece at (r,c) attack square (tr,tc)? Ignores occupancy of the
  // target (assumes an enemy piece is there) but respects blocking pieces
  // between sliding pieces and the target.
  attacksSquare(r, c, tr, tc) {
    const piece = this.grid[r][c];
    if (!piece) return false;
    const dr = tr - r;
    const dc = tc - c;
    const adr = Math.abs(dr);
    const adc = Math.abs(dc);
    switch (piece.type) {
      case 'p': {
        // Pawns capture diagonally forward.
        const dir = piece.color === 'white' ? -1 : 1;
        return dr === dir && adc === 1;
      }
      case 'n':
        return (adr === 2 && adc === 1) || (adr === 1 && adc === 2);
      case 'k':
        return adr <= 1 && adc <= 1 && (adr + adc > 0);
      case 'b':
        if (adr !== adc) return false;
        return this.slideClear(r, c, tr, tc);
      case 'r':
        if (dr !== 0 && dc !== 0) return false;
        return this.slideClear(r, c, tr, tc);
      case 'q':
        if (dr !== 0 && dc !== 0 && adr !== adc) return false;
        return this.slideClear(r, c, tr, tc);
      default:
        return false;
    }
  }

  slideClear(r, c, tr, tc) {
    const sr = Math.sign(tr - r);
    const sc = Math.sign(tc - c);
    let cr = r + sr;
    let cc = c + sc;
    while (cr !== tr || cc !== tc) {
      if (this.grid[cr][cc]) return false;
      cr += sr;
      cc += sc;
    }
    return true;
  }

  // Is square (r,c) attacked by any piece of color `byColor`?
  squareAttacked(r, c, byColor) {
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const p = this.grid[row][col];
        if (!p || p.color !== byColor) continue;
        if (this.attacksSquare(row, col, r, c)) return true;
      }
    }
    return false;
  }

  // All pseudo-legal (== legal here, no check) moves for a color.
  getMoves(color) {
    const moves = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = this.grid[r][c];
        if (!p || p.color !== color) continue;
        moves.push(...this.pieceMoves(r, c, p));
      }
    }
    // Castle "en passant" special capture right.
    if (this.castleEnPassant && this.castleEnPassant.color === color) {
      const { destination, middle } = this.castleEnPassant;
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const p = this.grid[r][c];
          if (!p || p.color !== color) continue;
          if (this.attacksSquare(r, c, middle.row, middle.col)) {
            moves.push({
              from: { row: r, col: c },
              to: { row: destination.row, col: destination.col },
              piece: p,
              captured: this.grid[destination.row][destination.col],
              castleEnPassant: true,
            });
          }
        }
      }
    }
    return moves;
  }

  pieceMoves(r, c, p) {
    const moves = [];
    const add = (tr, tc, extra) => {
      const target = this.grid[tr][tc];
      if (target && target.color === p.color) return; // can't capture own piece
      moves.push({
        from: { row: r, col: c },
        to: { row: tr, col: tc },
        piece: p,
        captured: target,
        ...extra,
      });
    };

    switch (p.type) {
      case 'p': {
        const dir = p.color === 'white' ? -1 : 1;
        const startRow = p.color === 'white' ? 6 : 1;
        const promoRow = p.color === 'white' ? 0 : 7;
        // Forward one.
        if (this.inBounds(r + dir, c) && !this.grid[r + dir][c]) {
          add(r + dir, c, { isPromotion: r + dir === promoRow });
          // Forward two from start.
          if (r === startRow && !this.grid[r + 2 * dir][c]) {
            add(r + 2 * dir, c, { isDoublePawn: true });
          }
        }
        // Diagonal captures.
        for (const dc of [-1, 1]) {
          const tr = r + dir;
          const tc = c + dc;
          if (!this.inBounds(tr, tc)) continue;
          const target = this.grid[tr][tc];
          if (target && target.color !== p.color) {
            add(tr, tc, { isPromotion: tr === promoRow });
          }
          // En passant: the double-stepped pawn sits on (tr,tc); the capture
          // lands on the square it passed through, (r + 2*dir, tc).
          const epRow = r + 2 * dir;
          const epCol = tc;
          if (
            this.enPassantTarget &&
            this.enPassantTarget.row === epRow &&
            this.enPassantTarget.col === epCol &&
            this.inBounds(epRow, epCol)
          ) {
            const epPawn = this.grid[tr][tc];
            if (epPawn && epPawn.color !== p.color && epPawn.type === 'p') {
              moves.push({
                from: { row: r, col: c },
                to: { row: epRow, col: epCol },
                piece: p,
                captured: epPawn,
                isEnPassant: true,
              });
            }
          }
        }
        break;
      }
      case 'n': {
        const deltas = [
          [-2, -1], [-2, 1], [-1, -2], [-1, 2],
          [1, -2], [1, 2], [2, -1], [2, 1],
        ];
        for (const [dr, dc] of deltas) {
          const tr = r + dr, tc = c + dc;
          if (this.inBounds(tr, tc)) add(tr, tc);
        }
        break;
      }
      case 'b':
      case 'r':
      case 'q': {
        const dirs = [];
        if (p.type === 'b' || p.type === 'q') dirs.push([-1, -1], [-1, 1], [1, -1], [1, 1]);
        if (p.type === 'r' || p.type === 'q') dirs.push([-1, 0], [1, 0], [0, -1], [0, 1]);
        for (const [dr, dc] of dirs) {
          let tr = r + dr, tc = c + dc;
          while (this.inBounds(tr, tc)) {
            const target = this.grid[tr][tc];
            if (!target) {
              add(tr, tc);
            } else {
              if (target.color !== p.color) add(tr, tc);
              break;
            }
            tr += dr;
            tc += dc;
          }
        }
        break;
      }
      case 'k': {
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const tr = r + dr, tc = c + dc;
            if (this.inBounds(tr, tc)) add(tr, tc);
          }
        }
        // Castling.
        moves.push(...this.castlingMoves(r, c, p));
        break;
      }
    }
    return moves;
  }

  castlingMoves(r, c, p) {
    const moves = [];
    const rights = this.castling[p.color];
    const homeRow = p.color === 'white' ? 7 : 0;
    if (r !== homeRow || c !== 4) return moves; // king must be on e1/e8
    const enemy = p.color === 'white' ? 'black' : 'white';
    // Kingside: rook on h-file (col 7), squares f1/g1 (col 5,6) empty.
    if (rights.k) {
      const rook = this.grid[homeRow][7];
      if (
        rook && rook.type === 'r' && rook.color === p.color && !rook.hasMoved &&
        !this.grid[homeRow][5] && !this.grid[homeRow][6]
      ) {
        moves.push({
          from: { row: homeRow, col: 4 },
          to: { row: homeRow, col: 6 },
          piece: p,
          captured: null,
          isCastle: 'k',
          middle: { row: homeRow, col: 5 },
        });
      }
    }
    // Queenside: rook on a-file (col 0), squares b1/c1/d1 (col 1,2,3) empty.
    if (rights.q) {
      const rook = this.grid[homeRow][0];
      if (
        rook && rook.type === 'r' && rook.color === p.color && !rook.hasMoved &&
        !this.grid[homeRow][1] && !this.grid[homeRow][2] && !this.grid[homeRow][3]
      ) {
        moves.push({
          from: { row: homeRow, col: 4 },
          to: { row: homeRow, col: 2 },
          piece: p,
          captured: null,
          isCastle: 'q',
          middle: { row: homeRow, col: 3 },
        });
      }
    }
    return moves;
  }

  // Apply a move to the board. Returns the move that was applied.
  applyMove(move) {
    const { from, to, piece } = move;
    const captured = move.captured;

    // Move the piece.
    this.grid[from.row][from.col] = null;
    piece.hasMoved = true;
    this.grid[to.row][to.col] = piece;

    // Castling: move the rook too.
    if (move.isCastle) {
      const homeRow = piece.color === 'white' ? 7 : 0;
      if (move.isCastle === 'k') {
        const rook = this.grid[homeRow][7];
        this.grid[homeRow][7] = null;
        rook.hasMoved = true;
        this.grid[homeRow][5] = rook;
      } else {
        const rook = this.grid[homeRow][0];
        this.grid[homeRow][0] = null;
        rook.hasMoved = true;
        this.grid[homeRow][3] = rook;
      }
    }

    // En passant: remove the captured pawn from its actual square (diagonally
    // adjacent to the capturing pawn, one step in the capturer's direction).
    if (move.isEnPassant) {
      const dir = piece.color === 'white' ? -1 : 1;
      this.grid[from.row + dir][to.col] = null;
    }

    // Promotion.
    if (move.isPromotion && move.promotionPiece) {
      piece.type = move.promotionPiece;
    }

    // Update castling rights.
    this.updateCastlingRights(piece, from, to, captured);

    // Set en passant target for double pawn moves.
    this.enPassantTarget = move.isDoublePawn
      ? { row: (from.row + to.row) / 2, col: from.col }
      : null;

    // Castle "en passant":
    //  1. If this move is a castle and the middle square is attacked by the
    //     enemy, grant the enemy a one-turn capture right.
    //  2. Consume any existing right if the entitled color just moved
    //     (expires if not used; consumed by the capture if used).
    let newRight = null;
    if (move.isCastle) {
      const enemy = piece.color === 'white' ? 'black' : 'white';
      const middle = move.middle;
      if (this.squareAttacked(middle.row, middle.col, enemy)) {
        newRight = {
          color: enemy,
          destination: { row: to.row, col: to.col },
          middle: { row: middle.row, col: middle.col },
        };
      }
    }
    if (this.castleEnPassant && this.castleEnPassant.color === piece.color) {
      this.castleEnPassant = null;
    }
    this.castleEnPassant = newRight;

    // Halfmove clock.
    if (captured || piece.type === 'p') {
      this.halfmoveClock = 0;
    } else {
      this.halfmoveClock++;
    }

    // Record.
    this.moveHistory.push({ move, piece, captured });

    // Switch turn.
    this.turn = this.turn === 'white' ? 'black' : 'white';
    if (this.turn === 'white') this.fullmoveNumber++;

    // Game over: a king was captured.
    if (captured && captured.type === 'k') {
      this.gameOver = true;
      this.winner = piece.color;
    }

    return move;
  }

  // Remove a piece from the board without a move (used when a capture fight
  // resolves by removing the capturing piece instead of the target). Updates
  // castling rights and game-over state if needed. Returns the removed piece.
  removePiece(row, col) {
    const piece = this.grid[row][col];
    if (!piece) return null;
    this.grid[row][col] = null;
    if (piece.type === 'r') {
      if (row === 7 && col === 0) this.castling.white.q = false;
      if (row === 7 && col === 7) this.castling.white.k = false;
      if (row === 0 && col === 0) this.castling.black.q = false;
      if (row === 0 && col === 7) this.castling.black.k = false;
    }
    if (piece.type === 'k') {
      this.gameOver = true;
      this.winner = piece.color === 'white' ? 'black' : 'white';
    }
    return piece;
  }

  updateCastlingRights(movedPiece, from, to, captured) {
    const color = movedPiece.color;
    if (movedPiece.type === 'k') {
      this.castling[color].k = false;
      this.castling[color].q = false;
    } else if (movedPiece.type === 'r') {
      // Rook moved from its home square.
      if (from.row === 7 && from.col === 0) this.castling.white.q = false;
      if (from.row === 7 && from.col === 7) this.castling.white.k = false;
      if (from.row === 0 && from.col === 0) this.castling.black.q = false;
      if (from.row === 0 && from.col === 7) this.castling.black.k = false;
    }
    // A rook captured on its home square also removes that right.
    if (captured && captured.type === 'r') {
      if (to.row === 7 && to.col === 0) this.castling.white.q = false;
      if (to.row === 7 && to.col === 7) this.castling.white.k = false;
      if (to.row === 0 && to.col === 0) this.castling.black.q = false;
      if (to.row === 0 && to.col === 7) this.castling.black.k = false;
    }
  }

  // Deep-ish copy for AI search.
  clone() {
    const b = new Board();
    b.grid = cloneGrid(this.grid);
    b.turn = this.turn;
    b.castling = {
      white: { ...this.castling.white },
      black: { ...this.castling.black },
    };
    b.enPassantTarget = this.enPassantTarget ? { ...this.enPassantTarget } : null;
    b.castleEnPassant = this.castleEnPassant
      ? {
          color: this.castleEnPassant.color,
          destination: { ...this.castleEnPassant.destination },
          middle: { ...this.castleEnPassant.middle },
        }
      : null;
    b.halfmoveClock = this.halfmoveClock;
    b.fullmoveNumber = this.fullmoveNumber;
    b.gameOver = this.gameOver;
    b.winner = this.winner;
    return b;
  }
}

// Export for browser (global) and Node (module).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Board, makePiece, cloneGrid, ROWS, COLS };
}
