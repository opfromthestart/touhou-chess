// peer.js — a thin, dependency-light wrapper over PeerJS (WebRTC data
// channels) for the multiplayer mode. No build step: `window.Peer` comes from
// vendor/peerjs.min.js (loaded before this file).
//
// Two roles:
//   host  — creates a named Peer (a short room code) and waits for one guest.
//   guest — connects to the host's room code.
//
// The wrapper is deliberately small: it manages the connection lifecycle and
// relays JSON messages. All game logic lives in js/multiplayer.js.
//
// Status events (via handlers.onStatus): 'connecting' | 'waiting' |
// 'connected' | 'error' | 'closed'. The `detail` arg is a human-readable
// string for the UI.
//
// NETWORK TELEMETRY: every message send/receive and connection event is
// recorded via NetLog (js/net/telemetry.js) into the shared GameLog as `net`
// events — types, byte sizes, and timestamps only (no peer IDs, room codes,
// names, or IPs). A ping/pong exchange every 2 s measures the round-trip
// time AND the peer's clock offset relative to ours, so the two clients'
// exported logs can be aligned and true one-way delays computed.
//
// NETWORK SIMULATOR: `TCNet.setSim({ sendMs, recvMs, jitterMs, drop })`
// applies artificial one-way delay / ±jitter / drop probability to outgoing
// and incoming messages, so bad-network conditions can be reproduced in a
// normal browser (see __MP.netSim).

(function () {
  // Non-confusing alphabet for room codes (no 0/O, 1/I/L).
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const CODE_LEN = 4;
  // Namespace our Peer IDs so they don't collide with other PeerJS apps on the
  // shared cloud broker.
  const ID_PREFIX = 'touhou-chess-v1-';

  function makeCode() {
    let s = '';
    for (let i = 0; i < CODE_LEN; i++) {
      s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return s;
  }

  function normalizeCode(c) {
    return (c || '').toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // Telemetry helpers — no-op when telemetry.js isn't loaded (bare Node use).
  // Only types/sizes/timestamps are recorded, never identifying info.
  function nlog(kind, data) {
    if (typeof NetLog !== 'undefined') NetLog.push(kind, data);
  }
  function nrtt(ms, offset) {
    if (typeof NetLog !== 'undefined') NetLog.rttSample(ms, offset);
  }
  function nsess(fn, ...args) {
    if (typeof NetLog !== 'undefined') NetLog[fn](...args);
  }
  function jsonSize(data) {
    try { return JSON.stringify(data).length; } catch (e) { return 0; }
  }

  const TCNet = {
    peer: null,
    conn: null,
    role: null, // 'host' | 'guest'
    code: null,
    name: null, // player display name (set by the controller); sent in hello
    _handlers: null,
    _started: false,
    _pingTimer: null,

    // In-page network simulator (see file header). All fields optional;
    // sendMs/recvMs are one-way delays in ms, jitterMs adds ±random, drop is
    // a 0..1 probability applied independently to sends and receives.
    sim: { sendMs: 0, recvMs: 0, jitterMs: 0, drop: 0 },
    setSim(opts) {
      if (!opts) return this.sim;
      if (opts.sendMs != null) this.sim.sendMs = Math.max(0, Number(opts.sendMs) || 0);
      if (opts.recvMs != null) this.sim.recvMs = Math.max(0, Number(opts.recvMs) || 0);
      if (opts.jitterMs != null) this.sim.jitterMs = Math.max(0, Number(opts.jitterMs) || 0);
      if (opts.drop != null) this.sim.drop = Math.min(1, Math.max(0, Number(opts.drop) || 0));
      nlog('sim', { what: 'set', sendMs: this.sim.sendMs, recvMs: this.sim.recvMs, jitterMs: this.sim.jitterMs, drop: this.sim.drop });
      return this.sim;
    },
    _simDelay(baseMs) {
      const s = this.sim;
      let d = baseMs;
      if (s.jitterMs > 0) d += (Math.random() * 2 - 1) * s.jitterMs;
      return Math.max(0, Math.round(d));
    },

    get connected() {
      return !!(this.conn && this.conn.open);
    },

    _status(status, detail) {
      if (this._handlers && this._handlers.onStatus) this._handlers.onStatus(status, detail || '');
    },

    _message(data) {
      if (this._handlers && this._handlers.onMessage) this._handlers.onMessage(data);
    },

    // Wire up the shared connection behaviour once the data channel exists.
    _bindConn(conn) {
      this.conn = conn;
      conn.on('data', (data) => {
        const bytes = jsonSize(data);
        nlog('recv', { msg: data.type, bytes });
        // RTT/clock-sync exchange (kept out of the game layer). The pong
        // echoes the pinger's t1 plus the receiver's t2/t3 so the PINGER can
        // measure the RTT on its own clock and derive the clock offset.
        if (data.type === 'ping') {
          this.send({ type: 'pong', t1: data.t1, t2: performance.now() });
          return;
        }
        if (data.type === 'pong') {
          if (data.t1 != null && data.t2 != null) {
            const t4 = performance.now();
            const rtt = t4 - data.t1; // measured on OUR clock: exact
            // Peer clock minus our clock (NTP-style; assumes symmetric
            // one-way delays — fine for log alignment on the order of ms).
            const offset = (data.t2 - data.t1) - rtt / 2;
            nrtt(rtt, offset);
          }
          return;
        }
        // Simulator: drop or delay the incoming message before the game sees it.
        const s = this.sim;
        if (s.drop > 0 && Math.random() < s.drop) {
          nlog('sim', { what: 'drop-recv', msg: data.type });
          return;
        }
        const delay = this._simDelay(s.recvMs);
        if (delay > 0) { setTimeout(() => this._message(data), delay); return; }
        this._message(data);
      });
      conn.on('close', () => {
        nlog('conn', { what: 'close' });
        this._stopPing();
        this.conn = null;
        this._status('closed', 'Opponent disconnected.');
        if (this._handlers && this._handlers.onClose) this._handlers.onClose();
      });
      conn.on('error', (e) => {
        // Log the error TYPE only — message text can carry connection details.
        nlog('conn', { what: 'error', type: (e && e.type) || 'unknown' });
        this._status('error', 'Connection error: ' + (e && e.message ? e.message : e));
      });
      conn.on('open', () => {
        nlog('conn', { what: 'open' });
        this._startPing();
        this._status('connected', 'Connected!');
        // Handshake: confirm readiness. Both sides send hello; each starts the
        // game once it has both sent and received one.
        this.send({ type: 'hello', role: this.role, name: this.name || null });
        if (!this._started) this._maybeStart();
      });
    },

    // RTT measurement: a small ping every 2 s while connected (see _bindConn
    // for the pong handling). Both sides ping, so each log carries its own
    // RTT samples and its own view of the clock offset.
    _startPing() {
      this._stopPing();
      this._pingTimer = setInterval(() => {
        if (this.connected) this.send({ type: 'ping', t1: performance.now() });
      }, 2000);
    },
    _stopPing() {
      if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    },

    _maybeStart() {
      // Started once we've exchanged hellos (tracked by the controller via
      // onMessage; the wrapper only fires onStatus('connected') here).
    },

    // Host a game with a generated (or supplied) room code.
    host(handlers, givenCode) {
      this._reset();
      nsess('sessionStart', 'host');
      this._handlers = handlers;
      this.role = 'host';
      this.code = normalizeCode(givenCode) || makeCode();
      this._status('connecting', 'Creating room ' + this.code + '…');
      try {
        this.peer = new window.Peer(ID_PREFIX + this.code);
      } catch (e) {
        this._status('error', 'Could not start PeerJS: ' + e.message);
        return;
      }
      this.peer.on('open', () => {
        nlog('conn', { what: 'peer-open' });
        this._status('waiting', 'Room ' + this.code + ' is open — share the code.');
      });
      this.peer.on('connection', (conn) => {
        nlog('conn', { what: 'inbound' });
        // Only accept the first connection.
        if (this.conn) { conn.close(); return; }
        this._bindConn(conn);
      });
      this.peer.on('error', (e) => {
        // 'unavailable-id' means our room code is already taken. Log the type
        // only — error messages can carry broker/connection details.
        nlog('conn', { what: 'peer-error', type: (e && e.type) || 'unknown' });
        if (e && e.type === 'unavailable-id') {
          this._status('error', 'Room ' + this.code + ' is already in use — pick another.');
        } else {
          this._status('error', (e && e.message) ? e.message : String(e));
        }
      });
      this.peer.on('disconnected', () => {
        nlog('conn', { what: 'signaling-lost' });
        this._status('error', 'Lost the signalling server. Reconnect?');
      });
    },

    // Join an existing room by code.
    join(code, handlers) {
      this._reset();
      nsess('sessionStart', 'guest');
      this._handlers = handlers;
      this.role = 'guest';
      this.code = normalizeCode(code);
      if (this.code.length < 3) {
        this._status('error', 'Enter a valid room code.');
        return;
      }
      this._status('connecting', 'Joining room ' + this.code + '…');
      try {
        this.peer = new window.Peer();
      } catch (e) {
        this._status('error', 'Could not start PeerJS: ' + e.message);
        return;
      }
      this.peer.on('open', () => {
        nlog('conn', { what: 'peer-open' });
        const conn = this.peer.connect(ID_PREFIX + this.code, { reliable: true });
        this._bindConn(conn);
      });
      this.peer.on('error', (e) => {
        nlog('conn', { what: 'peer-error', type: (e && e.type) || 'unknown' });
        if (e && e.type === 'peer-unavailable') {
          this._status('error', 'Room ' + this.code + ' not found. Check the code.');
        } else {
          this._status('error', (e && e.message) ? e.message : String(e));
        }
      });
    },

    // Send a JSON message to the opponent (no-op if not connected). The send
    // is recorded in the net log (type + size + timestamp), then optionally
    // delayed/dropped by the simulator before hitting the data channel.
    send(data) {
      if (!this.connected) return false;
      nlog('send', { msg: data.type, bytes: jsonSize(data) });
      const doSend = () => {
        try { this.conn.send(data); return true; }
        catch (e) { this._status('error', 'Send failed: ' + e.message); return false; }
      };
      const s = this.sim;
      if (s.drop > 0 && Math.random() < s.drop) {
        nlog('sim', { what: 'drop-send', msg: data.type });
        return true; // dropped by the simulator, not by the network
      }
      const delay = this._simDelay(s.sendMs);
      if (delay > 0) { setTimeout(doSend, delay); return true; }
      return doSend();
    },

    _reset() {
      this._stopPing();
      this._teardown();
      this.peer = null;
      this.conn = null;
      this.role = null;
      this.code = null;
      this._started = false;
    },

    _teardown() {
      if (this.conn) { try { this.conn.close(); } catch (e) {} this.conn = null; }
      if (this.peer) { try { this.peer.destroy(); } catch (e) {} this.peer = null; }
    },

    // Disconnect and clean up.
    close() {
      this._stopPing();
      this._teardown();
      this.role = null;
      nsess('end', 'closed');
      this._status('closed', 'Disconnected.');
      if (this._handlers && this._handlers.onClose) this._handlers.onClose();
    },
  };

  // Expose globally (browser) and as a module (Node tests).
  if (typeof window !== 'undefined') window.TCNet = TCNet;
  if (typeof module !== 'undefined' && module.exports) module.exports = { TCNet, makeCode, normalizeCode };
})();
