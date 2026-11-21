const SESSION_KEY = 'iron-oath.session.v1';
const MUTE_KEY = 'iron-oath.muted';

function readSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.roomCode || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeSession(session) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* ignore */ }
}

function clearStoredSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

function defaultNickname() {
  try { return localStorage.getItem('iron-oath.nickname') || ''; } catch { return ''; }
}

function saveNickname(nickname) {
  try { localStorage.setItem('iron-oath.nickname', nickname); } catch { /* ignore */ }
}

export class GameNet {
  constructor({ onStatus, onMessage, onLatency } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onMessage = onMessage || (() => {});
    this.onLatency = onLatency || (() => {});

    this.socket = null;
    this.status = 'offline';
    this.credentials = readSession();
    this.nickname = this.credentials?.nickname || defaultNickname();
    this.welcomed = false;
    this.awaitingWelcome = Boolean(this.credentials);
    this.pendingNickname = '';
    this.queued = [];
    this.buffered = [];
    this.reconnectTimer = 0;
    this.reconnectAttempt = 0;
    this.heartbeatTimer = 0;
    this.watchdogTimer = 0;
    this.lastMessageAt = 0;
    this.manualClose = false;
    this.connectPromise = null;
    this.connectResolve = null;
    this.inputSeq = 0;
    this.attackSeq = 0;
    this.dodgeSeq = 0;
    this.muted = false;

    try { this.muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* ignore */ }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        if (!this.isOpen()) this.connect();
        else this.sendHeartbeat();
      }
    });
    window.addEventListener('online', () => {
      if (!this.isOpen()) {
        this.reconnectAttempt = 0;
        this.connect();
      }
    });
  }

  get roomCode() { return this.credentials?.roomCode || ''; }
  get playerId() { return this.credentials?.playerId || ''; }
  get hasSession() { return Boolean(this.credentials?.roomCode && this.credentials?.token); }

  isOpen() {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN);
  }

  setStatus(state, label) {
    this.status = state;
    this.onStatus({ state, label });
  }

  connect() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    this.clearReconnectTimer();
    this.manualClose = false;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws`;
    let socket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.awaitingWelcome = this.hasSession;
    this.setStatus(this.hasSession ? 'reconnecting' : 'connecting', this.hasSession ? 'Restoring your seat' : 'Connecting');

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.lastMessageAt = performance.now();
      this.startHeartbeat();
      this.setStatus(this.hasSession ? 'reconnecting' : 'online', this.hasSession ? 'Reconnecting' : 'Arena online');
      if (this.hasSession) {
        this.sendRaw({
          type: 'reconnect',
          roomCode: this.credentials.roomCode,
          token: this.credentials.token,
        });
      }
      const queued = this.queued.splice(0);
      for (const message of queued) this.sendRaw(message);
      if (this.connectResolve) {
        this.connectResolve();
        this.connectResolve = null;
        this.connectPromise = null;
      }
    });

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      this.lastMessageAt = performance.now();
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.handleMessage(message);
    });

    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopHeartbeat();
      this.welcomed = false;
      this.awaitingWelcome = this.hasSession;
      if (this.connectPromise) {
        // Entry actions wait for a working socket; close means retry.
        this.connectResolve = null;
        this.connectPromise = null;
      }
      if (this.manualClose) {
        this.setStatus('offline', 'Offline');
        return;
      }
      if (this.hasSession) {
        this.setStatus('reconnecting', 'Reconnecting');
        this.scheduleReconnect();
      } else {
        this.setStatus('offline', 'Offline');
        this.scheduleReconnect();
      }
    });

    socket.addEventListener('error', () => {
      // The close event owns retry behavior.
    });
  }

  ensureConnected() {
    if (this.isOpen()) return Promise.resolve();
    this.connect();
    if (!this.connectPromise) {
      this.connectPromise = new Promise((resolve) => { this.connectResolve = resolve; });
      setTimeout(() => {
        if (this.connectResolve === resolve) {
          this.connectResolve = null;
          this.connectPromise = null;
          resolve();
        }
      }, 5000);
    }
    return this.connectPromise;
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delays = [350, 700, 1200, 1900, 3000, 4500];
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = 0;
      this.connect();
    }, delay);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 2000);
    this.watchdogTimer = setInterval(() => {
      if (document.hidden || !this.isOpen()) return;
      if (performance.now() - this.lastMessageAt > 22000) {
        this.socket?.close();
      }
    }, 1500);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.heartbeatTimer = 0;
    this.watchdogTimer = 0;
  }

  sendHeartbeat() {
    if (!this.isOpen()) return;
    this.sendRaw({ type: 'heartbeat', t: Date.now() });
  }

  sendRaw(message) {
    if (!this.isOpen()) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  send(message) {
    if (this.isOpen()) return this.sendRaw(message);
    this.queued.push(message);
    if (this.queued.length > 12) this.queued.shift();
    return false;
  }

  createRoom(nickname) {
    this.pendingNickname = nickname.trim();
    saveNickname(this.pendingNickname);
    return this.ensureConnected().then(() => {
      if (!this.isOpen()) throw new Error('The arena server is unreachable.');
      this.sendRaw({ type: 'create', nickname: this.pendingNickname });
    });
  }

  joinRoom(nickname, roomCode) {
    this.pendingNickname = nickname.trim();
    saveNickname(this.pendingNickname);
    return this.ensureConnected().then(() => {
      if (!this.isOpen()) throw new Error('The arena server is unreachable.');
      this.sendRaw({ type: 'join', nickname: this.pendingNickname, roomCode: roomCode.trim().toUpperCase() });
    });
  }

  sendInput(move, block, attack = false, dodge = false) {
    if (!this.isOpen()) return;
    if (attack) this.attackSeq += 1;
    if (dodge) this.dodgeSeq += 1;
    this.inputSeq += 1;
    const mx = Number.isFinite(move?.x) ? Math.max(-1, Math.min(1, move.x)) : 0;
    const my = Number.isFinite(move?.y) ? Math.max(-1, Math.min(1, move.y)) : 0;
    this.sendRaw({
      type: 'input',
      seq: this.inputSeq,
      mx, my,
      block: Boolean(block),
      attackSeq: this.attackSeq,
      dodgeSeq: this.dodgeSeq,
    });
  }

  selectCharacter(character) { this.sendRaw({ type: 'select', character }); }
  confirmCharacter(confirmed) { this.sendRaw({ type: 'confirm', confirmed }); }
  setReady(ready) { this.sendRaw({ type: 'ready', ready }); }
  rematch(accept) { this.sendRaw({ type: 'rematch', accept }); }
  returnToLobby() { this.sendRaw({ type: 'lobby' }); }
  leave() { this.sendRaw({ type: 'leave' }); }

  clearSession() {
    this.credentials = null;
    this.welcomed = false;
    this.awaitingWelcome = false;
    clearStoredSession();
  }

  handleMessage(message) {
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'hello') {
      this.onMessage(message);
      return;
    }

    if (message.type === 'welcome') {
      this.welcomed = true;
      this.awaitingWelcome = false;
      this.reconnectAttempt = 0;
      const slot = message.room?.yourSlot ?? 0;
      const me = message.room?.players?.find((p) => p.slot === slot);
      const nickname = me?.nickname || this.pendingNickname || this.nickname;
      this.nickname = nickname;
      saveNickname(nickname);
      this.credentials = {
        roomCode: message.room?.code || this.credentials?.roomCode || '',
        token: message.token || '',
        playerId: message.playerId || '',
        nickname,
        savedAt: Date.now(),
      };
      writeSession(this.credentials);
      this.inputSeq = 0;
      this.attackSeq = 0;
      this.dodgeSeq = 0;
      this.setStatus('online', 'Arena online');
      this.onMessage(message);
      const buffered = this.buffered.splice(0);
      for (const bufferedMessage of buffered) this.onMessage(bufferedMessage);
      return;
    }

    if (message.type === 'error') {
      if (!this.welcomed && this.hasSession && ['bad_resume', 'room_not_found', 'room_closed', 'not_member'].includes(message.code)) {
        this.clearSession();
        this.setStatus('online', 'Arena online');
        this.onMessage({ type: 'session_lost', code: message.code, message: message.message });
        return;
      }
      this.onMessage(message);
      return;
    }

    if (message.type === 'left') {
      this.clearSession();
      this.setStatus('online', 'Arena online');
      this.onMessage(message);
      return;
    }

    if (message.type === 'pong') {
      if (message.t) this.onLatency(Math.max(0, Date.now() - message.t));
      return;
    }

    if (this.awaitingWelcome && !this.welcomed) {
      if (message.type === 'room' || message.type === 'state' || message.type === 'notice') {
        this.buffered.push(message);
        if (this.buffered.length > 20) this.buffered.shift();
        return;
      }
    }

    this.onMessage(message);
  }

  toggleMute() {
    this.muted = !this.muted;
    try { localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0'); } catch { /* ignore */ }
    return this.muted;
  }

  disconnect() {
    this.manualClose = true;
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.socket?.close();
    this.socket = null;
  }
}

export { defaultNickname };
