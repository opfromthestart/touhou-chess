// telemetry.js — multiplayer network telemetry.
//
// Records network events and timings for a multiplayer session into the
// shared GameLog (as `net` events), so an exported log shows what the network
// was doing when a desync/glitch happened: per-message send/receive
// timestamps, connection lifecycle events, RTT samples, race-lifecycle
// timings, rejected messages, and browser-level conditions (offline, tab
// hidden — both of which can distort a danmaku race).
//
// PRIVACY: no identifying information is recorded — no peer IDs, room codes,
// display names, or IPs (the app never sees any). Only message TYPES, byte
// sizes, and timestamps relative to session start. Error events carry the
// error TYPE, not the message text.
//
// CLOCK ALIGNMENT: each client's `t` is ms since ITS OWN session start. The
// ping/pong exchange (see peer.js) measures the peer's clock offset relative
// to ours (`offset` on rtt events / summary). To align the two exported logs:
//   t_peer_clock = t_our_log + offset_our_log
// which lets you compute true one-way send→receive times across the two logs.
//
// No build step, no dependencies. Loaded as a plain <script>; in the browser
// NetLog is a global, in Node it is module.exports.

const NetLog = {
  enabled: true,
  t0: null, // performance.now() at session start (null = no session)
  events: [], // this session's net events (capped ring; GameLog is the full copy)
  counts: {}, // per-kind event counts (incremental, survives the ring cap)
  rtt: null, // { count, min, max, total, last, jitter, offset, samples }
  MAX_EVENTS: 100000,

  // Start (or restart) a session. `role` is 'host' | 'guest' — a game role,
  // not an identity.
  sessionStart(role) {
    this.t0 = performance.now();
    this.events = [];
    this.counts = {};
    this.rtt = { count: 0, min: Infinity, max: 0, total: 0, last: null, jitter: null, offset: null, samples: [] };
    this.push('session', { what: 'start', role: role || null });
  },

  // Milliseconds since session start (0 when no session is active).
  t() {
    return this.t0 == null ? 0 : Math.round(performance.now() - this.t0);
  },

  // Append a net event. `kind` is a short category ('session' | 'conn' |
  // 'send' | 'recv' | 'rtt' | 'race' | 'move' | 'reject' | 'sim' | 'browser');
  // `data` is spread onto { t, kind }. No-op outside a session.
  push(kind, data) {
    if (!this.enabled || this.t0 == null) return null;
    const ev = { t: this.t(), kind: kind };
    if (data) for (const k in data) ev[k] = data[k];
    this.events.push(ev);
    if (this.events.length > this.MAX_EVENTS) this.events.splice(0, this.events.length - this.MAX_EVENTS);
    this.counts[kind] = (this.counts[kind] || 0) + 1;
    if (typeof GameLog !== 'undefined') GameLog.push('net', ev);
    return ev;
  },

  // One round-trip measurement. `ms` is the RTT (measured on ONE clock, so
  // it is exact); `offset` is the peer's clock minus ours (ms) — the value
  // needed to align the two clients' logs.
  rttSample(ms, offset) {
    const r = this.rtt;
    if (!r) return;
    r.count++;
    r.total += ms;
    if (ms < r.min) r.min = ms;
    if (ms > r.max) r.max = ms;
    if (r.last != null) r.jitter = Math.abs(ms - r.last);
    r.last = ms;
    if (offset != null) r.offset = offset;
    if (r.samples.length < 500) r.samples.push(Math.round(ms));
    this.push('rtt', {
      ms: Math.round(ms),
      offset: offset != null ? Math.round(offset) : undefined,
    });
  },

  // Compact stats for the end-of-session event and __MP.state.
  summary() {
    const r = this.rtt || { count: 0 };
    return {
      elapsedMs: this.t(),
      counts: Object.assign({}, this.counts),
      rtt: r.count
        ? {
            count: r.count,
            min: Math.round(r.min),
            avg: Math.round(r.total / r.count),
            max: Math.round(r.max),
            jitter: r.jitter != null ? Math.round(r.jitter) : null,
            offset: r.offset != null ? Math.round(r.offset) : null,
          }
        : null,
    };
  },

  // Mark the session as over (game finished, disconnect, teardown).
  end(reason) {
    this.push('session', { what: 'end', reason: reason || 'closed', summary: this.summary() });
  },
};

// Browser-level conditions that can distort a race: the network going away,
// and the tab being hidden (rAF/timers throttle, which stalls the local
// engine's game clock). Only logged while a session is active (push() is a
// no-op otherwise).
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('online', () => NetLog.push('browser', { what: 'online' }));
  window.addEventListener('offline', () => NetLog.push('browser', { what: 'offline' }));
  document.addEventListener('visibilitychange', () => {
    NetLog.push('browser', { what: document.hidden ? 'tab-hidden' : 'tab-visible' });
  });
}

// Export for Node (tests); in the browser NetLog is a global.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NetLog };
}
