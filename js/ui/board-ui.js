// board-ui.js — renders the board, handles click-to-select/move, highlights,
// promotion picker, captured trays, and the move log.

const GLYPHS = {
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
};

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

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
    this._build();
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
        // Coordinates.
        if (c === 0) {
          const rank = document.createElement('span');
          rank.className = 'coord rank';
          rank.textContent = 8 - r;
          sq.appendChild(rank);
        }
        if (r === 7) {
          const file = document.createElement('span');
          file.className = 'coord file';
          file.textContent = FILES[c];
          sq.appendChild(file);
        }
        sq.addEventListener('click', () => this._onSquareClick(r, c));
        this.boardEl.appendChild(sq);
        rowEls.push(sq);
      }
      this.squares.push(rowEls);
    }
  }

  _onSquareClick(r, c) {
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
    const picker = document.getElementById('promotion-picker');
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
      btn.innerHTML = `<span class="glyph">${GLYPHS[t]}</span>`;
      const label = document.createElement('span');
      label.className = 'char-label';
      label.textContent = CONFIG.CHARACTERS[roster[t].you[0]];
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
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const sq = this.squares[r][c];
        // Remove existing piece element.
        const old = sq.querySelector('.piece');
        if (old) old.remove();
        // Last-move highlight.
        sq.classList.remove('last-from', 'last-to');
        if (this.lastMove) {
          if (this.lastMove.from.row === r && this.lastMove.from.col === c) sq.classList.add('last-from');
          if (this.lastMove.to.row === r && this.lastMove.to.col === c) sq.classList.add('last-to');
        }
        const piece = board.grid[r][c];
        if (piece) {
          const el = document.createElement('div');
          el.className = 'piece ' + piece.color;
          const glyph = document.createElement('span');
          glyph.className = 'glyph';
          glyph.textContent = GLYPHS[piece.type];
          el.appendChild(glyph);
          const label = document.createElement('span');
          label.className = 'char-label';
          label.textContent = CONFIG.CHARACTERS[piece.character].split(' ')[0];
          el.appendChild(label);
          sq.appendChild(el);
        }
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
    const whiteTray = document.getElementById('captured-tray-white');
    const blackTray = document.getElementById('captured-tray-black');
    whiteTray.innerHTML = '';
    blackTray.innerHTML = '';
    for (const { piece } of captured) {
      const el = document.createElement('span');
      el.className = 'piece ' + piece.color;
      el.style.width = '26px';
      el.style.height = '26px';
      el.innerHTML = `<span class="glyph" style="font-size:18px">${GLYPHS[piece.type]}</span>`;
      // Pieces captured BY white are shown in the white tray.
      if (piece.color === 'black') whiteTray.appendChild(el);
      else blackTray.appendChild(el);
    }
  }

  // Append a line to the move log.
  logMove(num, text) {
    const ul = document.getElementById('move-log');
    const li = document.createElement('li');
    li.innerHTML = `<span class="num">${num}.</span>${text}`;
    ul.appendChild(li);
    ul.scrollTop = ul.scrollHeight;
  }

  clearLog() {
    document.getElementById('move-log').innerHTML = '';
  }

  setTurnIndicator(text) {
    document.getElementById('turn-indicator').textContent = text;
  }

  setGameOverBanner(text) {
    document.getElementById('game-over-banner').textContent = text;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BoardUI, GLYPHS, FILES };
}
