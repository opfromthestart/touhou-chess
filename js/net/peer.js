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

  const TCNet = {
    peer: null,
    conn: null,
    role: null, // 'host' | 'guest'
    code: null,
    name: null, // player display name (set by the controller); sent in hello
    _handlers: null,
    _started: false,

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
      conn.on('data', (data) => this._message(data));
      conn.on('close', () => {
        this.conn = null;
        this._status('closed', 'Opponent disconnected.');
        if (this._handlers && this._handlers.onClose) this._handlers.onClose();
      });
      conn.on('error', (e) => {
        this._status('error', 'Connection error: ' + (e && e.message ? e.message : e));
      });
      conn.on('open', () => {
        this._status('connected', 'Connected!');
        // Handshake: confirm readiness. Both sides send hello; each starts the
        // game once it has both sent and received one.
        this.send({ type: 'hello', role: this.role, name: this.name || null });
        if (!this._started) this._maybeStart();
      });
    },

    _maybeStart() {
      // Started once we've exchanged hellos (tracked by the controller via
      // onMessage; the wrapper only fires onStatus('connected') here).
    },

    // Host a game with a generated (or supplied) room code.
    host(handlers, givenCode) {
      this._reset();
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
        this._status('waiting', 'Room ' + this.code + ' is open — share the code.');
      });
      this.peer.on('connection', (conn) => {
        // Only accept the first connection.
        if (this.conn) { conn.close(); return; }
        this._bindConn(conn);
      });
      this.peer.on('error', (e) => {
        // 'unavailable-id' means our room code is already taken.
        if (e && e.type === 'unavailable-id') {
          this._status('error', 'Room ' + this.code + ' is already in use — pick another.');
        } else {
          this._status('error', (e && e.message) ? e.message : String(e));
        }
      });
      this.peer.on('disconnected', () => {
        this._status('error', 'Lost the signalling server. Reconnect?');
      });
    },

    // Join an existing room by code.
    join(code, handlers) {
      this._reset();
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
        const conn = this.peer.connect(ID_PREFIX + this.code, { reliable: true });
        this._bindConn(conn);
      });
      this.peer.on('error', (e) => {
        if (e && e.type === 'peer-unavailable') {
          this._status('error', 'Room ' + this.code + ' not found. Check the code.');
        } else {
          this._status('error', (e && e.message) ? e.message : String(e));
        }
      });
    },

    // Send a JSON message to the opponent (no-op if not connected).
    send(data) {
      if (this.connected) {
        try { this.conn.send(data); return true; }
        catch (e) { this._status('error', 'Send failed: ' + e.message); }
      }
      return false;
    },

    _reset() {
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
      this._teardown();
      this.role = null;
      this._status('closed', 'Disconnected.');
      if (this._handlers && this._handlers.onClose) this._handlers.onClose();
    },
  };

  // Expose globally (browser) and as a module (Node tests).
  if (typeof window !== 'undefined') window.TCNet = TCNet;
  if (typeof module !== 'undefined' && module.exports) module.exports = { TCNet, makeCode, normalizeCode };
})();
