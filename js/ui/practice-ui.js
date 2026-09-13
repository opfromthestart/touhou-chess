// practice-ui.js — Practice Mode: fight ANY boss as ANY piece, at either
// difficulty. Pure training: no board state changes, no capture resolution,
// no fight stats, no AI survival-model adaptation.
//
// The menu is a modal with two character grids (protagonists / bosses), a
// Normal/Lunatic toggle, and a Start button. Selecting a protagonist also
// selects their piece type (stats + shot pattern come from the piece).

class PracticeUI {
  constructor() {
    // Defaults: the king vs the easiest boss, on Normal. Must be set before
    // _build(), which calls _refresh() and reads them.
    this.playerChar = 'reimu';
    this.bossId = 'rumia';
    this.difficulty = 'normal';
    this._build();
    // main.js sets this: ({bossId, difficulty, playerPieceType, playerChar}) => void
    this.onSelect = null;
  }

  _build() {
    const modal = document.createElement('div');
    modal.id = 'practice-modal';
    modal.className = 'modal hidden';
    modal.innerHTML = `
      <div class="modal-content practice-content">
        <h2>Practice Mode</h2>
        <p class="practice-sub">Fight any boss as any piece, at either difficulty.
          No board, no stakes — just danmaku.</p>
        <div class="practice-section">
          <div class="practice-label">You (protagonist)</div>
          <div class="practice-grid" id="practice-player-grid"></div>
        </div>
        <div class="practice-section">
          <div class="practice-label">Boss</div>
          <div class="practice-grid" id="practice-boss-grid"></div>
        </div>
        <div class="practice-section">
          <div class="practice-label">Difficulty</div>
          <div class="practice-diff">
            <button type="button" class="practice-diff-btn" id="practice-diff-normal">Normal</button>
            <button type="button" class="practice-diff-btn" id="practice-diff-lunatic">Lunatic</button>
          </div>
        </div>
        <div class="practice-loadout" id="practice-loadout"></div>
        <div class="practice-actions">
          <button type="button" id="btn-practice-close">Close</button>
          <button type="button" id="btn-practice-start">Start Fight</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    this.modal = modal;
    this.playerGrid = modal.querySelector('#practice-player-grid');
    this.bossGrid = modal.querySelector('#practice-boss-grid');
    this.loadoutEl = modal.querySelector('#practice-loadout');
    this.diffBtns = {
      normal: modal.querySelector('#practice-diff-normal'),
      lunatic: modal.querySelector('#practice-diff-lunatic'),
    };

    for (const type of ['k', 'q', 'r', 'b', 'n', 'p']) {
      for (const char of CONFIG.ROSTER[type].you) {
        this.playerGrid.appendChild(this._charButton(char, type, 'player'));
      }
      for (const char of CONFIG.ROSTER[type].ai) {
        this.bossGrid.appendChild(this._charButton(char, type, 'boss'));
      }
    }

    this.diffBtns.normal.addEventListener('click', () => {
      this.difficulty = 'normal';
      this._refresh();
    });
    this.diffBtns.lunatic.addEventListener('click', () => {
      this.difficulty = 'lunatic';
      this._refresh();
    });
    modal.querySelector('#btn-practice-start').addEventListener('click', () => {
      if (this.onSelect) this.onSelect(this.selection());
    });
    modal.querySelector('#btn-practice-close').addEventListener('click', () => {
      this.close();
    });
    this._refresh();
  }

  // One selectable character tile: sprite, name, piece type.
  _charButton(char, type, role) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'practice-char';
    btn.dataset.char = char;
    btn.dataset.type = type;
    btn.title = CONFIG.CHARACTERS[char] + ' (' + PRACTICE_PIECE_NAMES[type] + ')';
    const cv = makeCharacterCanvas(char, 56);
    const name = document.createElement('div');
    name.className = 'char-name';
    name.textContent = CONFIG.CHARACTERS[char];
    const typeEl = document.createElement('div');
    typeEl.className = 'char-type';
    typeEl.textContent = PRACTICE_PIECE_NAMES[type];
    btn.appendChild(cv);
    btn.appendChild(name);
    btn.appendChild(typeEl);
    btn.addEventListener('click', () => {
      if (role === 'player') this.playerChar = char;
      else this.bossId = char;
      this._refresh();
    });
    return btn;
  }

  // Current selection, resolved to what startFight needs.
  selection() {
    return {
      bossId: this.bossId,
      difficulty: this.difficulty,
      playerPieceType: charToPieceType(this.playerChar),
      playerChar: this.playerChar,
    };
  }

  _refresh() {
    for (const b of this.playerGrid.children) {
      b.classList.toggle('selected', b.dataset.char === this.playerChar);
    }
    for (const b of this.bossGrid.children) {
      b.classList.toggle('selected', b.dataset.char === this.bossId);
    }
    for (const d of ['normal', 'lunatic']) {
      this.diffBtns[d].classList.toggle('selected', d === this.difficulty);
    }
    const type = charToPieceType(this.playerChar);
    const stats = CONFIG.DANMAKU_STATS[type];
    this.loadoutEl.textContent =
      `${CONFIG.CHARACTERS[this.playerChar]} (${PRACTICE_PIECE_NAMES[type]}) — ` +
      `${stats.lives} life${stats.lives > 1 ? 's' : ''} · ${stats.bombs} bomb${stats.bombs > 1 ? 's' : ''} · ` +
      `hitbox ${stats.hitbox} · vs ${CONFIG.CHARACTERS[this.bossId]} on ${this.difficulty.toUpperCase()}`;
  }

  open() {
    this.modal.classList.remove('hidden');
  }

  close() {
    this.modal.classList.add('hidden');
  }
}

// Display names for piece types (used by the practice menu tiles).
// NOTE: named PRACTICE_PIECE_NAMES because board-ui.js already declares a
// top-level `const PIECE_NAMES` — a second top-level const with the same name
// is a parse-time SyntaxError that silently kills this whole file.
const PRACTICE_PIECE_NAMES = { k: 'King', q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight', p: 'Pawn' };

// Which piece type does a character belong to? (searches both sides of the
// roster; each character appears exactly once).
function charToPieceType(char) {
  for (const t of Object.keys(CONFIG.ROSTER)) {
    if (CONFIG.ROSTER[t].you.includes(char) || CONFIG.ROSTER[t].ai.includes(char)) return t;
  }
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PracticeUI, PRACTICE_PIECE_NAMES, charToPieceType };
}
