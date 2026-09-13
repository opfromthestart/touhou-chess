// fight-ui.js — the boss-fight modal panel.
// Shows the danmaku stage (canvas) over the frozen board, with a boss name,
// spell-card banner, and HUD (lives, bombs, score, graze, phase). On end, it
// shows a result and reports back to the caller.

class FightUI {
  constructor() {
    this._build();
    this.engine = new DanmakuEngine(this.canvas, {
      onEnd: (result) => this._onEnd(result),
      onPhase: (phase) => this._onPhase(phase),
      onHud: (hud) => this._onHud(hud),
    });
    this._onResult = null;
  }

  _build() {
    const modal = document.createElement('div');
    modal.id = 'fight-modal';
    modal.className = 'modal hidden';
    modal.innerHTML = `
      <div class="fight-panel">
        <div class="fight-header">
          <div class="boss-ident">
            <div class="boss-portrait" id="boss-portrait"></div>
            <div class="boss-name" id="boss-name"></div>
          </div>
          <div class="fight-diff" id="fight-diff"></div>
        </div>
        <div class="spell-banner" id="spell-banner"></div>
        <div class="boss-hp-wrap">
          <div class="boss-hp-label" id="boss-hp-label"></div>
          <div class="boss-hp-bar"><div class="boss-hp-fill" id="boss-hp-fill"></div></div>
        </div>
        <canvas id="danmaku-canvas" width="480" height="640"></canvas>
        <div class="fight-hud">
          <div class="hud-item">Lives <span id="hud-lives"></span></div>
          <div class="hud-item">Bombs <span id="hud-bombs"></span></div>
          <div class="hud-item">Score <span id="hud-score"></span></div>
          <div class="hud-item">Graze <span id="hud-graze"></span></div>
          <div class="hud-item">Phase <span id="hud-phase"></span></div>
          <div class="bomb-gauge"><div class="bomb-gauge-fill" id="bomb-gauge-fill"></div></div>
        </div>
        <div class="fight-hints">Arrows / WASD move &nbsp;·&nbsp; Space / Z bomb &nbsp;·&nbsp; hold X to focus (slower, smaller hitbox)</div>
        <div class="fight-result hidden" id="fight-result">
          <div class="result-title" id="result-title"></div>
          <div class="result-sub" id="result-sub"></div>
          <button id="btn-fight-continue">Continue</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    this.modal = modal;
    this.canvas = modal.querySelector('#danmaku-canvas');
    this.bannerEl = modal.querySelector('#spell-banner');
    this.resultEl = modal.querySelector('#fight-result');
    modal.querySelector('#btn-fight-continue').addEventListener('click', () => {
      this.modal.classList.add('hidden');
      if (this._onResult) this._onResult(this._result);
    });
  }

  // Start a fight. bossId: the AI boss character. difficulty: 'normal'|'lunatic'.
  // playerPieceType: the player piece involved (drives danmaku stats + ship color).
  // playerChar: the protagonist character actually fighting (drives the ship
  // sprite — e.g. 'sakuya' vs 'youmu' for rooks).
  startFight(bossId, difficulty, playerPieceType, playerChar, onResult) {
    this._onResult = onResult;
    this._result = null;
    const boss = BOSSES[bossId];
    const phases = getPhases(bossId, difficulty);
    const stats = CONFIG.DANMAKU_STATS[playerPieceType] || CONFIG.DANMAKU_STATS.p;

    // Header.
    this.modal.querySelector('#boss-name').textContent = boss.name;
    this.modal.querySelector('#fight-diff').textContent =
      difficulty === 'lunatic' ? 'LUNATIC' : 'NORMAL';
    this.modal.querySelector('#fight-diff').className =
      'fight-diff ' + (difficulty === 'lunatic' ? 'lunatic' : 'normal');
    // Portrait: the boss's character sprite (same art as the board piece).
    const portrait = this.modal.querySelector('#boss-portrait');
    portrait.style.background = `radial-gradient(circle at 35% 30%, ${boss.color}55, #111)`;
    portrait.innerHTML = '';
    const pcv = document.createElement('canvas');
    pcv.width = 88;
    pcv.height = 88;
    drawCharacter(pcv.getContext('2d'), bossId, 4, 4, 0.84);
    pcv.className = 'portrait-canvas';
    portrait.appendChild(pcv);

    // Ship color from the player's character.
    this.engine.playerColor = shipColorForPiece(playerPieceType);

    this.resultEl.classList.add('hidden');
    this.modal.classList.remove('hidden');
    this._banner(boss.phases[difficulty === 'lunatic' ? 'lunatic' : 'normal'][0].name, false);

    this.engine.start(phases, {
      color: boss.color,
      bgTop: boss.bgTop,
      bgBottom: boss.bgBottom,
      move: boss.move,
      charId: bossId,
    }, stats, playerPieceType, playerChar);
  }

  _banner(name, isSpell) {
    this.bannerEl.textContent = isSpell ? `Spell Card: ${name}` : name;
    this.bannerEl.className = 'spell-banner show ' + (isSpell ? 'spell' : 'nonspell');
    // Auto-hide after a moment.
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => {
      this.bannerEl.className = 'spell-banner';
    }, 2200);
  }

  _onPhase(phase) {
    const isSpell = phase.name !== 'Non-spell';
    this._banner(phase.name, isSpell);
  }

  _onHud(hud) {
    const m = this.modal;
    m.querySelector('#hud-lives').textContent = hud.lives;
    m.querySelector('#hud-bombs').textContent = hud.bombs;
    m.querySelector('#hud-score').textContent = hud.score;
    m.querySelector('#hud-graze').textContent = hud.graze;
    m.querySelector('#hud-phase').textContent = `${hud.phase + 1}/${hud.phaseCount}`;
    m.querySelector('#bomb-gauge-fill').style.width = `${Math.round(hud.bombGauge * 100)}%`;
    const hpPct = hud.phaseMaxHp > 0 ? (hud.phaseHp / hud.phaseMaxHp) * 100 : 0;
    m.querySelector('#boss-hp-fill').style.width = `${hpPct}%`;
    m.querySelector('#boss-hp-label').textContent = hud.phaseName || '';
  }

  _onEnd(result) {
    this._result = result;
    const won = result === 'win';
    this.resultEl.querySelector('#result-title').textContent = won ? 'FIGHT WON' : 'FIGHT LOST';
    this.resultEl.querySelector('#result-title').className = 'result-title ' + (won ? 'win' : 'lose');
    this.resultEl.querySelector('#result-sub').textContent = won
      ? 'You survived the boss. The capture goes through!'
      : 'You were overwhelmed. Your piece is captured.';
    this.resultEl.classList.remove('hidden');
  }
}

// Ship color per player piece type (the protagonist's signature color).
function shipColorForPiece(type) {
  const map = {
    k: '#ff5577', // Reimu (red/white)
    q: '#ffaa33', // Marisa (orange)
    r: '#66ccff', // Sakuya/Youmu (blue/white)
    b: '#ff88cc', // Sanae/Reisen (pink/blue)
    n: '#cc99ff', // Aya/Hatate (purple)
    p: '#66ddff', // Cirno (blue)
  };
  return map[type] || '#ff5577';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FightUI, shipColorForPiece };
}
