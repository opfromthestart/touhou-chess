// board-ui.js — renders the board, handles click-to-select/move, highlights,
// promotion picker, captured trays, and the move log.

const GLYPHS = {
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
};

const PIECE_NAMES = {
  k: 'King', q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight', p: 'Pawn',
};

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

// Pure diff between a previous render and the current grid (unit-tested in
// tests/test-board-ui.js). `prevPieces` maps "r,c" -> piece object (or ->
// { piece, el }); the grid is the current board.grid. Piece identity is by
// object reference: Board.applyMove moves the same piece object (promotion
// mutates it in place), so a piece now on a different square slid, and a
// piece that vanished was captured. This covers castling (king AND rook
// slide) and en passant (the captured pawn vanishes from its own square, not
// the landing square) automatically. Returns:
//   { kind: 'slide',   piece, from: {row,col}, to: {row,col} }
//   { kind: 'capture', piece, at: {row,col} }
function computeMoveAnim(prevPieces, grid) {
  const anims = [];
  const now = new Map(); // piece -> "r,c"
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (grid[r][c]) now.set(grid[r][c], r + ',' + c);
    }
  }
  for (const key of Object.keys(prevPieces)) {
    const entry = prevPieces[key];
    const piece = entry && typeof entry === 'object' && 'piece' in entry ? entry.piece : entry;
    const pos = now.get(piece);
    if (pos === undefined) {
      const [r, c] = key.split(',').map(Number);
      anims.push({ kind: 'capture', piece, at: { row: r, col: c } });
    } else if (pos !== key) {
      const [fr, fc] = key.split(',').map(Number);
      const [tr, tc] = pos.split(',').map(Number);
      anims.push({ kind: 'slide', piece, from: { row: fr, col: fc }, to: { row: tr, col: tc } });
    }
  }
  return anims;
}

class BoardUI {
  constructor(boardEl, opts = {}) {
    this.boardEl = boardEl;
    this.onMove = opts.onMove || (() => {}); // (move) => void
    this.onSelect = opts.onSelect || (() => {});
    this.selected = null; // { row, col }
    this.legalTargets = new Map(); // "r,c" -> move
    this.lastMove = null; // { from, to }
    this.promotionPending = null; // { move, choices }
    this.squares = []; // 2D array of square elements
    this._spriteCache = {}; // "charId:size" -> source canvas (drawn once)
    // Read-only boards (the replay viewer) ignore all clicks.
    this.readOnly = !!opts.readOnly;
    // Element ids for the surrounding chrome. The main game uses the defaults;
    // a second BoardUI (replay modal) passes its own so the two never clash.
    this.ids = Object.assign({
      moveLog: 'move-log',
      trayWhite: 'captured-tray-white',
      trayBlack: 'captured-tray-black',
      turnIndicator: 'turn-indicator',
      gameOverBanner: 'game-over-banner',
      promotionPicker: 'promotion-picker',
    }, opts.ids || {});
    this.flipped = false; // true = board rotated 180° (black's side at the bottom)
    this._build();
  }

  // A cached offscreen canvas with the character drawn once at `size`.
  _charSource(id, size) {
    const key = id + ':' + size;
    if (!this._spriteCache[key]) {
      this._spriteCache[key] = makeCharacterCanvas(id, size);
    }
    return this._spriteCache[key];
  }

  // A fresh copy of the character sprite (a canvas node can only live in one
  // place in the DOM, so each placement gets its own clone).
  _charSprite(id, size) {
    const src = this._charSource(id, size);
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    cv.className = 'piece-art';
    cv.getContext('2d').drawImage(src, 0, 0);
    return cv;
  }

  _build() {
    this.boardEl.innerHTML = '';
    this.squares = [];
    for (let r = 0; r < 8; r++) {
      const rowEls = [];
      for (let c = 0; c < 8; c++) {
        const sq = document.createElement('div');
        sq.className = 'square ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
        sq.dataset.row = r;
        sq.dataset.col = c;
        sq.addEventListener('click', () => this._onSquareClick(r, c));
        this.boardEl.appendChild(sq);
        rowEls.push(sq);
      }
      this.squares.push(rowEls);
    }
    this._applyOrientation();
  }

  // Lay the squares out from the current side's perspective and (re)draw the
  // coordinate labels. `this.squares` stays logically indexed (row 0 = black's
  // back rank, row 7 = white's), so click handlers, piece rendering, and the
  // last-move highlight are all unaffected — only the on-screen order changes.
  // When flipped, display cell (dr, dc) shows logical square (7-dr, 7-dc).
  _applyOrientation() {
    const frag = document.createDocumentFragment();
    for (let dr = 0; dr < 8; dr++) {
      for (let dc = 0; dc < 8; dc++) {
        const r = this.flipped ? 7 - dr : dr;
        const c = this.flipped ? 7 - dc : dc;
        frag.appendChild(this.squares[r][c]);
      }
    }
    this.boardEl.appendChild(frag);

    // Coordinate labels: ranks along the left edge, files along the bottom edge,
    // always read from the current viewer's perspective.
    for (const row of this.squares) {
      for (const sq of row) {
        const coord = sq.querySelector('.coord');
        if (coord) coord.remove();
      }
    }
    for (let dr = 0; dr < 8; dr++) {
      for (let dc = 0; dc < 8; dc++) {
        const r = this.flipped ? 7 - dr : dr;
        const c = this.flipped ? 7 - dc : dc;
        const sq = this.squares[r][c];
        if (dc === 0) {
          const rank = document.createElement('span');
          rank.className = 'coord rank';
          rank.textContent = 8 - r;
          sq.appendChild(rank);
        }
        if (dr === 7) {
          const file = document.createElement('span');
          file.className = 'coord file';
          file.textContent = FILES[c];
          sq.appendChild(file);
        }
      }
    }
  }

  // Rotate the board 180° so `flipped ? 'black' : 'white'` sits at the bottom.
  // No-op when the orientation is already correct, so it is safe to call on
  // every render.
  setFlipped(flipped) {
    flipped = !!flipped;
    if (flipped === this.flipped) return;
    this.flipped = flipped;
    this._applyOrientation();
  }

  _onSquareClick(r, c) {
    if (this.readOnly) return; // replay viewer: display only
    if (this.promotionPending) return; // picker is open
    const board = this._board;
    const piece = board.grid[r][c];

    // If a piece is selected and this is a legal target, make the move.
    if (this.selected) {
      const key = r + ',' + c;
      const move = this.legalTargets.get(key);
      if (move) {
        this._clearSelection();
        if (move.isPromotion) {
          this._openPromotionPicker(move);
        } else {
          this.onMove(move);
        }
        return;
      }
    }

    // Select a piece of the side to move.
    if (piece && piece.color === board.turn) {
      this._select(r, c);
    } else {
      this._clearSelection();
    }
  }

  _select(r, c) {
    this._clearSelection();
    this.selected = { row: r, col: c };
    this.legalTargets = new Map();
    const board = this._board;
    const moves = board.getMoves(board.turn).filter(
      m => m.from.row === r && m.from.col === c
    );
    for (const m of moves) {
      this.legalTargets.set(m.to.row + ',' + m.to.col, m);
    }
    this.squares[r][c].classList.add('selected');
    for (const m of moves) {
      const sq = this.squares[m.to.row][m.to.col];
      const hint = document.createElement('div');
      hint.className = m.captured ? 'hint-capture' : 'hint-move';
      sq.appendChild(hint);
    }
    this.onSelect(r, c);
  }

  _clearSelection() {
    this.selected = null;
    this.legalTargets = new Map();
    for (const row of this.squares) {
      for (const sq of row) {
        sq.classList.remove('selected');
        const hint = sq.querySelector('.hint-move, .hint-capture');
        if (hint) hint.remove();
      }
    }
  }

  _openPromotionPicker(move) {
    const picker = document.getElementById(this.ids.promotionPicker);
    const choicesEl = picker.querySelector('.promo-choices');
    choicesEl.innerHTML = '';
    const board = this._board;
    const piece = move.piece;
    const roster = CONFIG.ROSTER;
    // The promoting pawn's character determines which protagonist the new
    // piece becomes. For pawns, all are the same character per side.
    const youChars = roster[piece.type].you;
    const choices = ['q', 'r', 'b', 'n'];
    for (const t of choices) {
      const btn = document.createElement('div');
      btn.className = 'promo-choice';
      btn.title = PIECE_NAMES[t] + ' — ' + CONFIG.CHARACTERS[roster[t].you[0]];
      btn.appendChild(this._charSprite(roster[t].you[0], 64));
      const label = document.createElement('span');
      label.className = 'char-label';
      label.textContent = CONFIG.CHARACTERS[roster[t].you[0]].split(' ')[0];
      btn.appendChild(label);
      btn.addEventListener('click', () => {
        picker.classList.add('hidden');
        this.promotionPending = null;
        this.onMove({ ...move, promotionPiece: t });
      });
      choicesEl.appendChild(btn);
    }
    picker.classList.remove('hidden');
    this.promotionPending = move;
  }

  // Render the board from a Board instance.
  render(board) {
    this._board = board;
    // Snapshot the previous render (piece object + element) so the move that
    // just happened can be animated. The snapshot must come from the DOM, NOT
    // the grid: board.applyMove() runs before this render, so the grid already
    // reflects the move while the DOM still shows the previous position.
    // Piece identity is by object reference (kept on the element as
    // `_pieceRef`) — Board.applyMove moves the same piece object (promotion
    // mutates it in place) — see computeMoveAnim.
    const prev = {};
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const el = this.squares[r][c].querySelector('.piece:not(.piece-captured-fade)');
        if (el && el._pieceRef) prev[r + ',' + c] = { piece: el._pieceRef, el };
      }
    }
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const sq = this.squares[r][c];
        // Remove existing piece elements (all of them: a leftover
        // capture-fade element from the previous render may still be here).
        for (const old of sq.querySelectorAll('.piece')) old.remove();
        // Last-move highlight.
        sq.classList.remove('last-from', 'last-to');
        if (this.lastMove) {
          if (this.lastMove.from.row === r && this.lastMove.from.col === c) sq.classList.add('last-from');
          if (this.lastMove.to.row === r && this.lastMove.to.col === c) sq.classList.add('last-to');
        }
        const piece = board.grid[r][c];
        // King in check: tint the square under the king red so the danger is
        // visible at a glance (even though the game has no check rule).
        sq.classList.toggle(
          'king-check',
          !!(piece && piece.type === 'k' &&
            board.squareAttacked(r, c, piece.color === 'white' ? 'black' : 'white'))
        );
        if (piece) {
          const el = document.createElement('div');
          el.className = 'piece ' + piece.color;
          el.title = CONFIG.CHARACTERS[piece.character] + ' — ' + PIECE_NAMES[piece.type];
          // Tinted backdrop reads "which side" at a glance (warm = protagonists,
          // dark = youkai bosses). The hand-drawn bust is the real identity.
          const backdrop = document.createElement('div');
          backdrop.className = 'piece-backdrop';
          el.appendChild(backdrop);
          el.appendChild(this._charSprite(piece.character, 64));
          const badge = document.createElement('span');
          badge.className = 'type-badge';
          badge.textContent = GLYPHS[piece.type];
          el.appendChild(badge);
          // Identity tag for the next render's move-anim snapshot (see render).
          el._pieceRef = piece;
          sq.appendChild(el);
        }
      }
    }
    // Animate the move that just happened (slide the mover, fade the
    // captured). No-op on re-renders without a move (undo / new game / flip
    // all clear lastMove first).
    if (this.lastMove) this._animateMove(board, prev);
  }



  // Apply the move animation to the DOM just rebuilt. Purely cosmetic — it
  // reads the grid + lastMove and never touches board state, so it is safe in
  // multiplayer (each client animates its own local render; the relayed state
  // is authoritative). Skipped entirely where Web Animations is unavailable.
  _animateMove(board, prev) {
    if (typeof document === 'undefined') return; // Node
    const anims = computeMoveAnim(prev, board.grid);
    if (anims.length === 0) return;
    for (const a of anims) {
      if (a.kind === 'slide') {
        const toSq = this.squares[a.to.row][a.to.col];
        const el = toSq.querySelector('.piece');
        if (!el || typeof el.animate !== 'function') continue;
        const fromSq = this.squares[a.from.row][a.from.col];
        const dx = fromSq.offsetLeft - toSq.offsetLeft;
        const dy = fromSq.offsetTop - toSq.offsetTop;
        if (dx === 0 && dy === 0) continue;
        el.style.zIndex = '10'; // slide over neighboring pieces
        const anim = el.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0px, 0px)' }],
          { duration: 150, easing: 'ease-out' }
        );
        anim.onfinish = () => { el.style.zIndex = ''; };
      } else {
        // Captured piece: its element was removed during the rebuild. Re-add
        // it on top of whatever landed on that square and fade it out.
        const prevEntry = prev[a.at.row + ',' + a.at.col];
        if (!prevEntry || !prevEntry.el || typeof prevEntry.el.animate !== 'function') continue;
        const sq = this.squares[a.at.row][a.at.col];
        const oldEl = prevEntry.el;
        oldEl.classList.add('piece-captured-fade');
        sq.appendChild(oldEl);
        const anim = oldEl.animate(
          [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.4)' }],
          { duration: 220, easing: 'ease-in', fill: 'forwards' }
        );
        anim.onfinish = () => oldEl.remove();
      }
    }
  }

  setLastMove(from, to) {
    this.lastMove = { from, to };
  }

  clearLastMove() {
    this.lastMove = null;
  }

  // Update the captured trays. `captured` is a list of { piece, byColor }.
  renderTrays(captured) {
    const whiteTray = document.getElementById(this.ids.trayWhite);
    const blackTray = document.getElementById(this.ids.trayBlack);
    whiteTray.innerHTML = '';
    blackTray.innerHTML = '';
    for (const { piece } of captured) {
      const el = document.createElement('span');
      el.className = 'tray-piece ' + piece.color;
      el.title = CONFIG.CHARACTERS[piece.character] + ' — ' + PIECE_NAMES[piece.type];
      el.appendChild(this._charSprite(piece.character, 32));
      // Pieces captured BY white are shown in the white tray.
      if (piece.color === 'black') whiteTray.appendChild(el);
      else blackTray.appendChild(el);
    }
  }

  // Append a line to the move log.
  logMove(num, text) {
    const ul = document.getElementById(this.ids.moveLog);
    const li = document.createElement('li');
    li.innerHTML = `<span class="num">${num}.</span>${text}`;
    ul.appendChild(li);
    ul.scrollTop = ul.scrollHeight;
  }

  clearLog() {
    document.getElementById(this.ids.moveLog).innerHTML = '';
  }

  setTurnIndicator(text) {
    document.getElementById(this.ids.turnIndicator).textContent = text;
  }

  setGameOverBanner(text) {
    document.getElementById(this.ids.gameOverBanner).textContent = text;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BoardUI, GLYPHS, FILES, computeMoveAnim };
}
