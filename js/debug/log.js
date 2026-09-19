// log.js — debug game log.
//
// Records a replayable event stream of a game: one `turn` event per move
// (the move, the contested boss fight if any, the capture resolution, and the
// resulting board state), plus `ai-start` / `ai-run` events at the AI decision
// points, and `net` events for multiplayer network telemetry (message
// send/receive timings, connection lifecycle, RTT samples, race lifecycle —
// see js/net/telemetry.js). A buggy game can be exported as JSON and replayed
// offline (see replay.js) to reproduce issues such as the post-fight AI
// softlock; `net` events are ignored by the replay and exist for diagnosis.
//
// No build step, no dependencies. Loaded as a plain <script>; in the browser
// GameLog is a global, in Node it is module.exports.

const GameLog = {
  events: [],
  seq: 0,
  enabled: true,

  // Append an event. `data` is spread onto { seq, type }.
  push(type, data) {
    if (!this.enabled) return null;
    const ev = Object.assign({ seq: this.seq++, type }, data || {});
    this.events.push(ev);
    return ev;
  },

  clear() {
    this.events = [];
    this.seq = 0;
  },

  // Keep only the first `n` events (used by undo).
  truncate(n) {
    this.events.length = n;
    this.seq = n;
  },

  get length() {
    return this.events.length;
  },

  // Full log as a JSON string (versioned envelope).
  dump() {
    return JSON.stringify({ version: 1, events: this.events }, null, 2);
  },

  // Trigger a download of the log as a .json file (browser only).
  download(filename) {
    if (typeof document === 'undefined' || typeof Blob === 'undefined') return;
    const name =
      filename ||
      'touhou-chess-log-' +
        new Date().toISOString().replace(/[:.]/g, '-') +
        '.json';
    const blob = new Blob([this.dump()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  // Compact one-line summary of an event, for the console / on-screen debug.
  summaryLine(ev) {
    const sq = (s) => (s ? 'abcdefgh'[s.c] + (8 - s.r) : '?');
    if (ev.type === 'turn') {
      let line = '#' + ev.seq + ' ' + ev.side;
      if (ev.failed) {
        line += ' FAILED: ' + (ev.reason || 'no move');
      } else if (ev.move) {
        line += ' ' + sq(ev.move.from) + '\u2192' + sq(ev.move.to);
        if (ev.move.capturedType) line += ' x' + ev.move.capturedType;
        if (ev.capture) {
          line +=
            ' [fight ' +
            ev.capture.bossId +
            '/' +
            ev.capture.difficulty +
            ' \u2192 ' +
            ev.capture.result +
            ', apply=' +
            ev.capture.applyCapture +
            ']';
        }
      }
      if (ev.state) line += ' | turn=' + ev.state.turn + ' over=' + ev.state.gameOver;
      return line;
    }
    if (ev.type === 'net') {
      // Compact one-line view of a net telemetry event (t = ms since session
      // start on THIS client; the rtt `offset` aligns the two clients' logs).
      let line = '#' + ev.seq + ' net +' + ev.t + 'ms ' + ev.kind;
      if (ev.what) line += ' ' + ev.what;
      if (ev.msg) line += ' ' + ev.msg + (ev.bytes != null ? '(' + ev.bytes + 'b)' : '');
      if (ev.ms != null) line += ' rtt=' + ev.ms + 'ms';
      if (ev.offset != null) line += ' off=' + ev.offset + 'ms';
      if (ev.side) line += ' side=' + ev.side;
      if (ev.result) line += ' result=' + ev.result;
      if (ev.outcome) line += ' outcome=' + ev.outcome;
      if (ev.path) line += ' path=' + ev.path;
      if (ev.reason) line += ' reason=' + ev.reason;
      if (ev.from) line += ' ' + ev.from + '\u2192' + ev.to;
      return line;
    }
    if (ev.type === 'ai-start') return '#' + ev.seq + ' startAiTurn (count=' + ev.count + ')';
    if (ev.type === 'ai-run') {
      const sq = (s) => (s ? 'abcdefgh'[s.c] + (8 - s.r) : '?');
      return (
        '#' +
        ev.seq +
        ' aiTurn ' +
        (ev.failed
          ? 'FAILED: ' + (ev.reason || '')
          : ev.move
          ? sq(ev.move.from) + '\u2192' + sq(ev.move.to)
          : 'no move')
      );
    }
    return '#' + ev.seq + ' ' + ev.type;
  },
};

// Export for Node (tests); in the browser GameLog is a global.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GameLog };
}
