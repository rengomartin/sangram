import {
  getCharacter, charStyle, escapeHTML, clamp, storageGet, storageSet,
} from './data.js';

const $ = (id) => document.getElementById(id);
const SCREENS = ['home', 'lobby', 'game'];

export class UI {
  constructor({ config, renderer, sound }) {
    this.config = config;
    this.renderer = renderer;
    this.sound = sound;

    this.handlers = {
      entry: () => {},
      select: () => {},
      confirm: () => {},
      ready: () => {},
      copyCode: () => {},
      leave: () => {},
      rematch: () => {},
      returnLobby: () => {},
      toggleSound: () => {},
      countdownTick: () => {},
    };

    this.screen = 'home';
    this.entryMode = 'create';
    this.selected = '';
    this.confirmed = false;
    this.ready = false;
    this.localSlot = 0;
    this.room = null;
    this.countdownValue = null;
    this.countdownTimer = 0;
    this.healthValues = [100, 100];
    this.characterButtons = new Map();
    this.gridSignature = '';
    this.muted = false;
    this.toastTimers = new Set();

    this.cacheElements();
    this.bindStaticEvents();
    this.setEntryMode('create');
  }

  cacheElements() {
    this.el = {
      boot: $('boot-screen'),
      home: $('screen-home'),
      lobby: $('screen-lobby'),
      game: $('screen-game'),

      nickname: $('nickname'),
      roomCode: $('room-code'),
      createForm: $('create-form'),
      joinForm: $('join-form'),
      createBtn: $('create-btn'),
      joinBtn: $('join-btn'),
      tabCreate: $('tab-create'),
      tabJoin: $('tab-join'),
      homeError: $('home-error'),
      homeConnection: $('home-connection'),
      homeRoster: $('home-roster'),

      lobbyCode: $('lobby-code'),
      copyBtn: $('copy-code-btn'),
      warbandCount: $('warband-count'),
      lobbyPlayers: $('lobby-players'),
      characterGrid: $('character-grid'),
      selectionHint: $('selection-hint'),
      roomState: $('room-state'),
      readyState: $('ready-state'),
      readyBtn: $('ready-btn'),
      readyBtnLabel: $('ready-btn-label'),
      confirmBtn: $('confirm-btn'),
      confirmBtnLabel: $('confirm-btn-label'),
      lobbyDisconnect: $('lobby-disconnect'),
      lobbyLeave: $('lobby-leave-btn'),

      gameCanvas: $('game-canvas'),
      gameConnection: $('game-connection'),
      pingLabel: $('ping-label'),
      countdown: $('countdown-overlay'),
      countdownNumber: $('countdown-number'),
      countdownKicker: $('countdown-kicker'),
      countdownSub: $('countdown-sub'),
      pause: $('pause-overlay'),
      graceFill: $('grace-fill'),
      graceLabel: $('grace-label'),
      connectionOverlay: $('connection-overlay'),

      result: $('result-overlay'),
      resultCard: document.querySelector('#result-overlay .result-card'),
      resultCrest: $('result-crest'),
      resultKicker: $('result-kicker'),
      resultTitle: $('result-title'),
      resultSubtitle: $('result-subtitle'),
      resultFighters: $('result-fighters'),
      rematchStatus: $('rematch-status-text'),
      rematchBtn: $('rematch-btn'),
      rematchBtnLabel: document.querySelector('#rematch-btn span:last-child'),
      returnLobbyBtn: $('return-lobby-btn'),
      resultLeaveBtn: $('result-leave-btn'),

      gameMenu: $('game-menu'),
      gameMenuBtn: $('game-menu-btn'),
      gameLeaveBtn: $('game-leave-btn'),

      help: $('help-modal'),
      toastStack: $('toast-stack'),

      hud: [0, 1].map((slot) => ({
        name: $(`hud-name-${slot}`),
        character: $(`hud-char-${slot}`),
        conn: $(`hud-conn-${slot}`),
        you: $(`hud-you-${slot}`),
        fill: $(`hud-fill-${slot}`),
        trail: $(`hud-trail-${slot}`),
        hp: $(`hud-hp-${slot}`),
        frame: $(`hud-fill-${slot}`)?.closest('.health-frame'),
      })),
      cdAttack: $('cd-attack'),
      cdDodge: $('cd-dodge'),
      touchAttack: $('touch-attack'),
      touchDodge: $('touch-dodge'),
      touchBlock: $('touch-block'),
    };
  }

  bindStaticEvents() {
    document.querySelectorAll('[data-action="toggle-sound"]').forEach((button) => {
      button.addEventListener('click', () => this.handlers.toggleSound());
    });
    document.querySelectorAll('[data-modal]').forEach((button) => {
      button.addEventListener('click', () => this.openModal(`${button.dataset.modal}-modal`));
    });
    document.querySelectorAll('[data-close-modal]').forEach((button) => {
      button.addEventListener('click', () => this.closeModal(button.dataset.closeModal));
    });
    document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('pointerdown', (event) => {
        if (event.target === backdrop) this.closeModal(backdrop.id);
      });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.closeAllModals();
        if (!this.el.gameMenu.classList.contains('hidden')) {
          this.el.gameMenu.classList.add('hidden');
        }
      }
    });

    this.el.tabCreate.addEventListener('click', () => this.setEntryMode('create'));
    this.el.tabJoin.addEventListener('click', () => this.setEntryMode('join'));

    this.el.createForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submitEntry('create');
    });
    this.el.joinForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submitEntry('join');
    });

    this.el.createForm.addEventListener('input', () => this.clearHomeError());
    this.el.joinForm.addEventListener('input', () => this.clearHomeError());
    this.el.nickname.addEventListener('input', () => this.clearHomeError());

    this.el.roomCode.addEventListener('input', () => {
      this.el.roomCode.value = this.el.roomCode.value
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 6);
    });
    this.el.roomCode.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.submitEntry('join');
      }
    });
    this.el.nickname.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.submitEntry(this.entryMode);
      }
    });

    this.el.copyBtn.addEventListener('click', () => {
      const code = this.room?.code || this.el.lobbyCode.textContent || '';
      this.handlers.copyCode(code);
    });

    this.el.lobbyLeave.addEventListener('click', () => this.handlers.leave());
    this.el.gameLeaveBtn.addEventListener('click', () => {
      this.closeModal('game-menu');
      this.handlers.leave();
    });
    this.el.gameMenuBtn.addEventListener('click', () => this.openModal('game-menu'));

    this.el.confirmBtn.addEventListener('click', () => this.handlers.confirm(!this.confirmed));
    this.el.readyBtn.addEventListener('click', () => this.handlers.ready(!this.ready));

    this.el.characterGrid.addEventListener('click', (event) => {
      const button = event.target.closest('[data-character]');
      if (!button || button.disabled) return;
      this.handlers.select(button.dataset.character);
    });

    this.el.rematchBtn.addEventListener('click', () => this.handlers.rematch());
    this.el.returnLobbyBtn.addEventListener('click', () => this.handlers.returnLobby());
    this.el.resultLeaveBtn.addEventListener('click', () => this.handlers.leave());

    window.addEventListener('resize', () => {
      if (this.screen !== 'home') this.refreshPortraits();
    });
  }

  setSound(sound) {
    this.sound = sound;
    if (this.renderer) this.renderer.setSound(sound);
  }

  setConfig(config) {
    const first = !this.config;
    this.config = config;
    if (first || !this.characterButtons.size) {
      this.buildHomeRoster();
      this.buildCharacterGrid();
    } else {
      const signature = config.characters.map((c) => c.key).join(',');
      if (signature !== this.gridSignature) this.buildCharacterGrid();
    }
    this.setMuted(config.muted ?? this.muted);
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    document.body.classList.toggle('is-muted', this.muted);
  }

  setNickname(value) {
    if (value) this.el.nickname.value = value;
  }

  // ---------------------------------------------------------------- screens

  hideBoot() {
    this.el.boot.classList.add('is-gone');
    setTimeout(() => this.el.boot.remove(), 500);
    this.refreshPortraits();
  }

  showScreen(name) {
    if (!SCREENS.includes(name)) return;
    this.screen = name;
    for (const key of SCREENS) {
      this.el[key].classList.toggle('hidden', key !== name);
    }
    document.body.classList.toggle('in-game', name === 'game');
    if (name === 'game') {
      this.closeAllModals();
    }
    if (name !== 'game') {
      this.setReconnecting(false);
    }
    if (name === 'lobby') this.refreshPortraits();
    if (name === 'home') this.refreshPortraits();
  }

  transitionTo(name) {
    if (this.screen === name) return;
    this.showScreen(name);
  }

  // ---------------------------------------------------------------- entry

  setEntryMode(mode) {
    const next = mode === 'join' ? 'join' : 'create';
    this.entryMode = next;
    this.el.tabCreate.classList.toggle('is-active', next === 'create');
    this.el.tabJoin.classList.toggle('is-active', next === 'join');
    this.el.tabCreate.setAttribute('aria-selected', next === 'create' ? 'true' : 'false');
    this.el.tabJoin.setAttribute('aria-selected', next === 'join' ? 'true' : 'false');
    this.el.createForm.classList.toggle('hidden', next !== 'create');
    this.el.joinForm.classList.toggle('hidden', next !== 'join');
    this.clearHomeError();
  }

  submitEntry(mode) {
    const nickname = this.el.nickname.value.trim();
    if (!nickname) {
      this.showHomeError('Enter a warrior name before entering the arena.');
      this.el.nickname.focus();
      return;
    }
    let code = '';
    if (mode === 'join') {
      code = this.el.roomCode.value.trim().toUpperCase();
      if (code.length !== 6) {
        this.showHomeError('Arena codes are exactly six characters.');
        this.el.roomCode.focus();
        return;
      }
    }
    this.clearHomeError();
    this.setEntryBusy(true);
    this.sound?.ui();
    this.handlers.entry({ mode, nickname, code });
  }

  setEntryBusy(busy) {
    this.el.createBtn.disabled = busy;
    this.el.joinBtn.disabled = busy;
    this.el.nickname.disabled = busy;
    this.el.roomCode.disabled = busy;
    const createLabel = this.el.createBtn.querySelector('span:last-child');
    const joinLabel = this.el.joinBtn.querySelector('span:last-child');
    if (busy) {
      if (createLabel) createLabel.textContent = 'Forging the arena…';
      if (joinLabel) joinLabel.textContent = 'Seeking the arena…';
    } else {
      if (createLabel) createLabel.textContent = 'Create private arena';
      if (joinLabel) joinLabel.textContent = 'Enter the arena';
    }
  }

  showHomeError(message) {
    if (!message) return this.clearHomeError();
    const span = this.el.homeError.querySelector('span');
    if (span) span.textContent = message;
    this.el.homeError.classList.remove('hidden');
  }

  clearHomeError() {
    this.el.homeError.classList.add('hidden');
  }

  setConnection(state, label) {
    const classes = ['is-connecting', 'is-offline', 'is-online'];
    const isOnline = state === 'online';
    const isOffline = state === 'offline';
    const isConnecting = !isOnline && !isOffline;
    const setPill = (pill, text) => {
      if (!pill) return;
      pill.classList.remove(...classes);
      pill.classList.add(isOnline ? 'is-online' : isOffline ? 'is-offline' : 'is-connecting');
      const labelEl = pill.querySelector('.conn-label');
      if (labelEl) labelEl.textContent = text;
    };
    const friendly = label || (isOnline ? 'Arena online' : isOffline ? 'Offline' : 'Connecting');
    setPill(this.el.homeConnection, friendly);
    setPill(this.el.gameConnection, isOnline ? 'Live' : isOffline ? 'Offline' : 'Reconnecting');
    if (!isOnline && this.screen === 'home') this.setEntryBusy(false);
    if (isOnline) {
      this.setEntryBusy(false);
      this.setReconnecting(false);
    } else if (this.screen === 'game') {
      this.setReconnecting(state !== 'online' && this.gameActive);
    }
  }

  setPing(ms) {
    if (!this.el.pingLabel) return;
    this.el.pingLabel.textContent = Number.isFinite(ms) ? `${Math.round(ms)}ms` : '—';
  }

  setReconnecting(active) {
    if (!this.el.connectionOverlay) return;
    this.el.connectionOverlay.classList.toggle('hidden', !active);
  }

  // ---------------------------------------------------------------- home art

  buildHomeRoster() {
    if (!this.el.homeRoster) return;
    const keys = this.config.characters.map((c) => c.key);
    this.el.homeRoster.innerHTML = keys.map((key) => {
      const style = charStyle(key);
      const character = getCharacter(this.config, key);
      return `
        <div class="home-warrior" data-character="${escapeHTML(key)}" title="${escapeHTML(character?.name || key)}">
          <canvas width="92" height="92"></canvas>
          <span>${escapeHTML(character?.name || key)}</span>
        </div>`;
    }).join('');
    for (const holder of this.el.homeRoster.querySelectorAll('.home-warrior')) {
      const canvas = holder.querySelector('canvas');
      if (canvas) this.renderer.paintPortrait(canvas, holder.dataset.character);
    }
  }

  // ---------------------------------------------------------------- lobby

  buildCharacterGrid() {
    if (!this.el.characterGrid) return;
    const characters = this.config.characters;
    this.gridSignature = characters.map((c) => c.key).join(',');
    const maxRange = Math.max(...characters.map((c) => c.range || 1), 1);
    const numerals = ['I', 'II', 'III', 'IV'];
    this.el.characterGrid.innerHTML = characters.map((character, index) => {
      const key = character.key;
      const style = charStyle(key);
      const healthPct = clamp((character.health / 100) * 100, 6, 100);
      const speedPct = clamp(character.speedPercent, 15, 130);
      const damagePct = clamp((character.damage / 25) * 100, 8, 100);
      const rangePct = clamp((character.range / maxRange) * 100, 8, 100);
      return `
        <button class="character-card" type="button" data-character="${escapeHTML(key)}" aria-pressed="false">
          <div class="char-art">
            <canvas width="300" height="132"></canvas>
            <span class="char-index">${numerals[index] || ''}</span>
          </div>
          <div class="char-body">
            <div class="char-name-row">
              <span class="char-name">${escapeHTML(character.name)}</span>
              <span class="char-weapon">${escapeHTML(character.weapon || style.title)}</span>
            </div>
            <p class="char-blurb">${escapeHTML(character.blurb || '')}</p>
            <div class="char-stats">
              <div class="stat-row"><span class="stat-label">Health</span><div class="stat-track"><div class="stat-fill" style="width:${healthPct}%"></div></div><span class="stat-value">${Math.round(character.health)}</span></div>
              <div class="stat-row"><span class="stat-label">Speed</span><div class="stat-track"><div class="stat-fill" style="width:${speedPct}%"></div></div><span class="stat-value">${Math.round(character.speedPercent)}%</span></div>
              <div class="stat-row"><span class="stat-label">Damage</span><div class="stat-track"><div class="stat-fill" style="width:${damagePct}%"></div></div><span class="stat-value">${Math.round(character.damage)}</span></div>
              <div class="stat-row"><span class="stat-label">Reach</span><div class="stat-track"><div class="stat-fill" style="width:${rangePct}%"></div></div><span class="stat-value">${escapeHTML(character.rangeLabel || '')}</span></div>
            </div>
          </div>
        </button>`;
    }).join('');
    this.characterButtons.clear();
    for (const button of this.el.characterGrid.querySelectorAll('.character-card')) {
      this.characterButtons.set(button.dataset.character, button);
      const canvas = button.querySelector('.char-art canvas');
      if (canvas) this.renderer.paintCharacterArt(canvas, button.dataset.character);
    }
  }

  setSelection(selected, confirmed) {
    this.selected = selected || '';
    this.confirmed = Boolean(confirmed);
    for (const [key, button] of this.characterButtons) {
      const isSelected = key === this.selected;
      button.classList.toggle('is-selected', isSelected);
      button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    }
    const hint = this.el.selectionHint;
    if (hint) {
      const p = hint.querySelector('p');
      const character = getCharacter(this.config, this.selected);
      if (p) {
        if (!character) {
          p.textContent = 'Select a warrior to inspect their oath. Confirm your choice, then ready for battle.';
        } else if (this.confirmed) {
          p.textContent = `${character.name} is confirmed. You may still change your oath until you are ready.`;
        } else {
          p.textContent = `${character.name} — ${character.weapon}. Confirm this oath when you are certain.`;
        }
      }
    }
    this.updateLobbyControls();
  }

  renderLobby(room, localSlot) {
    if (!room) return;
    this.room = room;
    this.localSlot = localSlot ?? room.yourSlot ?? 0;
    this.selected = room.players?.[this.localSlot]?.character || this.selected;
    this.confirmed = Boolean(room.players?.[this.localSlot]?.confirmed);
    this.ready = Boolean(room.players?.[this.localSlot]?.ready);

    this.el.lobbyCode.textContent = room.code || '------';
    this.el.copyBtn.title = `Copy arena code ${room.code || ''}`;
    const count = room.players?.length || 0;
    this.el.warbandCount.textContent = `${count} / 2`;

    const players = [...(room.players || [])].sort((a, b) => a.slot - b.slot);
    const opponent = players.find((p) => p.slot !== this.localSlot);
    const opponentKey = opponent?.character || '';
    for (const [key, button] of this.characterButtons) {
      button.classList.toggle('is-opponent-pick', key === opponentKey);
      button.disabled = room.phase !== 'lobby';
    }

    this.renderWarband(players, opponent);
    this.setSelection(this.selected, this.confirmed);
    this.updateRoomState(room, players, opponent);
    this.updateLobbyControls(players, opponent);
    this.refreshPortraits();
  }

  renderWarband(players, opponent) {
    const cards = [];
    for (const player of players) {
      const slot = player.slot;
      const isYou = slot === this.localSlot;
      const character = player.character ? getCharacter(this.config, player.character) : null;
      const connected = player.connected !== false;
      let status = '<span class="status-pill">Choosing</span>';
      if (!connected) status = '<span class="status-pill is-off">Offline</span>';
      else if (player.ready) status = '<span class="status-pill is-ready">Ready</span>';
      else if (player.confirmed) status = '<span class="status-pill is-confirmed">Confirmed</span>';
      cards.push(`
        <div class="warband-card ${isYou ? 'is-you' : ''} ${connected ? '' : 'is-disconnected'}" data-slot="${slot}">
          <div class="warband-portrait">
            ${character ? '<canvas width="51" height="51"></canvas>' : '<svg class="portrait-silhouette"><use href="#i-shield"></use></svg>'}
          </div>
          <div class="warband-info">
            <div class="warband-name">${escapeHTML(player.nickname || 'Warrior')}${isYou ? '<span class="you-tag">YOU</span>' : ''}</div>
            <div class="warband-sub">
              <span>${escapeHTML(character?.name || 'No oath chosen')}</span>
              ${character ? '<span class="char-dot"></span>' : ''}
              ${character ? `<span>${escapeHTML(character.weapon || '')}</span>` : ''}
            </div>
          </div>
          <div class="warband-status">${status}</div>
        </div>`);
    }
    if (players.length < 2) {
      cards.push(`
        <div class="warband-card is-empty">
          <div class="warband-portrait"><svg class="portrait-silhouette"><use href="#i-shield"></use></svg></div>
          <div class="warband-info">
            <div class="warband-name">Awaiting a rival…</div>
            <div class="warband-sub">Share the arena code</div>
          </div>
        </div>`);
    }
    this.el.lobbyPlayers.innerHTML = cards.join('');
    for (const card of this.el.lobbyPlayers.querySelectorAll('.warband-card')) {
      const slot = Number(card.dataset.slot);
      const player = players.find((p) => p.slot === slot);
      const canvas = card.querySelector('canvas');
      if (canvas && player?.character) this.renderer.paintPortrait(canvas, player.character);
    }
    this.el.lobbyDisconnect.classList.toggle('hidden', !(opponent && opponent.connected === false));
  }

  updateRoomState(room, players, opponent) {
    const label = this.el.roomState.querySelector('span:last-child');
    if (!label) return;
    if (room.phase === 'countdown') label.textContent = 'The countdown begins';
    else if (room.phase === 'playing') label.textContent = 'Steel is drawn';
    else if (room.phase === 'ended') label.textContent = 'The duel has ended';
    else if (players.length < 2) label.textContent = 'Waiting for a rival';
    else if (opponent && opponent.connected === false) label.textContent = 'Rival reconnecting';
    else if (players.every((p) => p.ready)) label.textContent = 'Both warriors ready';
    else label.textContent = 'Both warriors present';
  }

  updateLobbyControls(players = null, opponent = null) {
    const list = players || (this.room?.players || []);
    const me = list.find((p) => p.slot === this.localSlot);
    const other = opponent || list.find((p) => p.slot !== this.localSlot);
    const inLobby = (this.room?.phase || 'lobby') === 'lobby';
    const hasOpponent = Boolean(other && other.connected !== false);
    const character = getCharacter(this.config, this.selected);
    // Only offer ready once the server has recorded the confirmation. The label
    // flips immediately, but the ready gate waits for the room broadcast so a
    // rapid confirm → ready can never be rejected.
    const isConfirmed = me ? Boolean(me.confirmed) : this.confirmed;

    this.el.confirmBtn.disabled = !inLobby || !character;
    this.el.confirmBtn.classList.toggle('is-confirmed', this.confirmed);
    this.el.confirmBtnLabel.textContent = this.confirmed ? 'Warrior confirmed' : 'Confirm warrior';

    const canReady = inLobby && Boolean(character) && isConfirmed && hasOpponent && !this.ready;
    this.el.readyBtn.disabled = !(canReady || (inLobby && this.ready));
    this.el.readyBtnLabel.textContent = this.ready ? 'Stand down' : 'Ready for battle';

    let text;
    if (!character) text = 'Choose a warrior from the four oaths.';
    else if (!this.confirmed) text = 'Confirm your warrior, then ready for battle.';
    else if (!hasOpponent) text = 'Waiting for a second warrior to join.';
    else if (this.ready) text = 'Your oath is given — waiting for your rival.';
    else if (other?.ready) text = 'Your rival is ready. Ready when you are.';
    else text = 'Both warriors must confirm and ready.';
    this.el.readyState.querySelector('span:last-child').textContent = text;

    // Keep the local roster card in sync without waiting for a room packet.
    if (me) {
      this.ready = Boolean(me.ready);
      this.confirmed = Boolean(me.confirmed);
    }
  }

  refreshPortraits() {
    if (!this.renderer) return;
    for (const holder of document.querySelectorAll('#home-roster .home-warrior')) {
      const canvas = holder.querySelector('canvas');
      if (canvas) this.renderer.paintPortrait(canvas, holder.dataset.character);
    }
    for (const card of document.querySelectorAll('#lobby-players .warband-card')) {
      const slot = Number(card.dataset.slot);
      const player = this.room?.players?.find((p) => p.slot === slot);
      const canvas = card.querySelector('canvas');
      if (canvas && player?.character) this.renderer.paintPortrait(canvas, player.character);
    }
    for (const button of document.querySelectorAll('#character-grid .character-card')) {
      const canvas = button.querySelector('.char-art canvas');
      if (canvas) this.renderer.paintCharacterArt(canvas, button.dataset.character);
    }
    for (const avatar of document.querySelectorAll('#result-fighters .result-avatar canvas')) {
      if (avatar.dataset.character) this.renderer.paintPortrait(avatar, avatar.dataset.character);
    }
  }

  // ---------------------------------------------------------------- HUD

  updateHud(state) {
    if (!state) return;
    this.localSlot = state.yourSlot ?? this.localSlot;
    this.gameActive = state.phase === 'playing' || state.phase === 'countdown' || state.phase === 'ended';
    const players = state.players || [];
    const fighters = [...(state.match?.fighters || [])].sort((a, b) => a.slot - b.slot);

    for (const slot of [0, 1]) {
      const hud = this.el.hud[slot];
      const player = players.find((p) => p.slot === slot);
      const fighter = fighters.find((f) => f.slot === slot);
      const character = fighter ? getCharacter(this.config, fighter.character) : null;
      if (player) {
        hud.name.textContent = player.nickname || 'Warrior';
        hud.conn.classList.toggle('is-off', player.connected === false);
        hud.conn.title = player.connected === false ? 'Connection lost' : 'Connected';
      }
      hud.you.classList.toggle('is-visible', slot === this.localSlot);
      if (character) hud.character.textContent = character.name;
      if (fighter) {
        const pct = clamp((fighter.health / (fighter.maxHealth || 100)) * 100, 0, 100);
        const previous = this.healthValues[slot];
        hud.fill.style.width = `${pct}%`;
        hud.trail.style.width = `${pct}%`;
        hud.hp.textContent = String(Math.max(0, Math.ceil(fighter.health)));
        hud.frame?.classList.toggle('is-low', pct <= 30);
        if (previous !== undefined && pct < previous - 0.2) {
          hud.frame?.classList.remove('hit');
          void hud.frame?.offsetWidth;
          hud.frame?.classList.add('hit');
        }
        this.healthValues[slot] = pct;
      }
    }
  }

  setCooldowns(attackRemaining, attackTotal, dodgeRemaining, dodgeTotal) {
    const attackFrac = attackTotal > 0 ? clamp(attackRemaining / attackTotal, 0, 1) : 0;
    const dodgeFrac = dodgeTotal > 0 ? clamp(dodgeRemaining / dodgeTotal, 0, 1) : 0;
    if (this.el.cdAttack) this.el.cdAttack.style.width = `${attackFrac * 100}%`;
    if (this.el.cdDodge) this.el.cdDodge.style.width = `${dodgeFrac * 100}%`;
    if (this.el.touchAttack) {
      this.el.touchAttack.classList.toggle('is-cooling', attackFrac > 0.001);
      this.el.touchAttack.style.setProperty('--cd', `${attackFrac * 100}%`);
    }
    if (this.el.touchDodge) {
      this.el.touchDodge.classList.toggle('is-cooling', dodgeFrac > 0.001);
      this.el.touchDodge.style.setProperty('--cd', `${dodgeFrac * 100}%`);
    }
  }

  setBlocking(active) {
    this.el.touchBlock?.classList.toggle('is-active', Boolean(active));
  }

  // ---------------------------------------------------------------- countdown

  updateCountdown(state) {
    if (!state) return;
    if (state.phase === 'countdown') {
      this.showCountdown(state.countdownMs);
    } else if (state.phase === 'playing') {
      if (this.countdownValue !== null && this.countdownValue !== 'fight') {
        this.showFight();
      }
    } else {
      this.hideCountdown();
    }
  }

  showCountdown(ms) {
    this.el.countdown.classList.remove('hidden');
    const value = Math.max(1, Math.ceil((ms || 0) / 1000));
    if (this.countdownValue === value) return;
    this.countdownValue = value;
    this.el.countdownNumber.classList.remove('is-word');
    this.el.countdownNumber.textContent = String(value);
    this.el.countdownKicker.textContent = 'STEEL READY';
    this.el.countdownSub.textContent = 'The duel begins';
    this.popCountdown();
    this.handlers.countdownTick(value);
  }

  showFight() {
    this.el.countdown.classList.remove('hidden');
    this.countdownValue = 'fight';
    this.el.countdownNumber.textContent = 'FIGHT';
    this.el.countdownNumber.classList.add('is-word');
    this.el.countdownKicker.textContent = 'THE OATH IS SEALED';
    this.el.countdownSub.textContent = 'First to fall loses';
    this.popCountdown();
    this.handlers.countdownTick(0);
    clearTimeout(this.countdownTimer);
    this.countdownTimer = setTimeout(() => this.hideCountdown(), 900);
  }

  popCountdown() {
    const number = this.el.countdownNumber;
    number.classList.remove('is-pop');
    void number.offsetWidth;
    number.classList.add('is-pop');
  }

  hideCountdown() {
    clearTimeout(this.countdownTimer);
    this.countdownTimer = 0;
    this.countdownValue = null;
    this.el.countdownNumber.classList.remove('is-word');
    this.el.countdown.classList.add('hidden');
  }

  setPaused(paused, graceMs, graceTotal) {
    this.el.pause.classList.toggle('hidden', !paused);
    if (!paused) return;
    const total = Math.max(1, graceTotal || 12000);
    const pct = clamp((graceMs || 0) / total, 0, 1);
    this.el.graceFill.style.width = `${pct * 100}%`;
    this.el.graceLabel.textContent = `Holding their seat for ${Math.ceil((graceMs || 0) / 1000)}s`;
  }

  // ---------------------------------------------------------------- result

  showResult(state) {
    if (!state) return;
    this.gameActive = false;
    this.hideCountdown();
    this.setPaused(false, 0, 0);
    this.setReconnecting(false);
    this.el.result.classList.remove('hidden');

    const winner = state.winner;
    const localWon = winner === this.localSlot;
    const draw = winner < 0;
    const players = state.players || [];
    const me = players.find((p) => p.slot === this.localSlot);
    const opponent = players.find((p) => p.slot !== this.localSlot);
    const opponentName = opponent?.nickname || 'Your rival';

    this.el.resultCard.classList.toggle('is-defeat', !localWon && !draw);
    this.el.resultCard.classList.toggle('is-draw', draw);
    this.el.resultTitle.textContent = draw ? 'DRAW' : localWon ? 'VICTORY' : 'DEFEAT';
    this.el.resultKicker.textContent = draw ? 'THE OATH STANDS EVEN'
      : localWon ? 'THE OATH IS KEPT' : 'THE OATH IS BROKEN';
    const crestUse = this.el.resultCrest.querySelector('use');
    if (crestUse) {
      crestUse.setAttribute('href', draw ? '#i-swords' : localWon ? '#i-crown' : '#i-shield');
    }

    let subtitle;
    if (draw) subtitle = 'Neither warrior yielded the field.';
    else if (localWon) {
      subtitle = state.endReason === 'opponent_left' ? `${opponentName} abandoned the arena.`
        : state.endReason === 'opponent_disconnected' ? `${opponentName} could not return in time.`
          : `You struck down ${opponentName}.`;
    } else {
      subtitle = `${opponentName} struck you down. The arena remembers.`;
    }
    this.el.resultSubtitle.textContent = subtitle;

    const fighters = [...(state.match?.fighters || [])].sort((a, b) => a.slot - b.slot);
    const cards = [];
    for (const slot of [0, 1]) {
      const player = players.find((p) => p.slot === slot);
      const fighter = fighters.find((f) => f.slot === slot) || fighters[slot];
      const character = fighter ? getCharacter(this.config, fighter.character) : null;
      const isWinner = winner === slot;
      const isLocal = slot === this.localSlot;
      if (slot === 1) cards.push('<div class="result-vs">VS</div>');
      cards.push(`
        <div class="result-fighter ${isWinner ? 'is-winner' : ''} ${isLocal ? 'is-local' : ''}">
          <div class="result-avatar">${fighter ? `<canvas width="42" height="42" data-character="${escapeHTML(fighter.character)}"></canvas>` : ''}</div>
          <div class="result-fighter-info">
            <div class="result-fighter-name">${escapeHTML(player?.nickname || (isLocal ? 'You' : 'Rival'))}${isLocal ? ' · YOU' : ''}</div>
            <div class="result-fighter-char">${escapeHTML(character?.name || 'Warrior')} · ${Math.max(0, Math.ceil(fighter?.health ?? 0))} HP</div>
          </div>
        </div>`);
    }
    this.el.resultFighters.innerHTML = cards.join('');
    for (const canvas of this.el.resultFighters.querySelectorAll('canvas[data-character]')) {
      this.renderer.paintPortrait(canvas, canvas.dataset.character);
    }

    this.el.result.removeAttribute('aria-hidden');
    this.updateRematch(state);
    if (localWon && !draw) this.sound?.victory();
    else if (!draw) this.sound?.defeat();
  }

  hideResult() {
    this.el.result.classList.add('hidden');
    this.el.result.removeAttribute('aria-hidden');
  }

  updateRematch(state) {
    if (!state) return;
    const players = state.players || [];
    const me = players.find((p) => p.slot === this.localSlot);
    const opponent = players.find((p) => p.slot !== this.localSlot);
    const localAccepted = Boolean(me?.rematch);
    const opponentAccepted = Boolean(opponent?.rematch);
    const opponentConnected = opponent?.connected !== false;

    const status = this.el.rematchStatus;
    const button = this.el.rematchBtn;

    if (!opponentConnected) {
      status.innerHTML = '<span class="accepted">Your rival has left the arena.</span>';
      button.disabled = true;
      button.querySelector('span:last-child').textContent = 'Rival departed';
      return;
    }
    if (localAccepted && opponentAccepted) {
      status.innerHTML = '<span class="accepted">Both warriors agree. Prepare yourselves…</span>';
      button.disabled = true;
      button.querySelector('span:last-child').textContent = 'Rematch agreed';
      return;
    }
    if (localAccepted) {
      status.textContent = 'Awaiting your rival’s answer…';
      button.disabled = true;
      button.querySelector('span:last-child').textContent = 'Awaiting rival…';
      return;
    }
    if (opponentAccepted) {
      status.innerHTML = `<span class="accepted">${escapeHTML(opponent?.nickname || 'Your rival')} asks for a rematch.</span>`;
      button.disabled = false;
      button.querySelector('span:last-child').textContent = 'Accept rematch';
      return;
    }
    status.textContent = 'Both warriors must agree to a rematch.';
    button.disabled = false;
    button.querySelector('span:last-child').textContent = 'Rematch';
  }

  setResultBusy(busy) {
    this.el.rematchBtn.disabled = Boolean(busy);
    this.el.returnLobbyBtn.disabled = Boolean(busy);
  }

  // ---------------------------------------------------------------- misc

  toast(message, kind = 'info', timeout = 3800) {
    if (!message) return;
    while (this.el.toastStack.children.length >= 3) {
      this.el.toastStack.firstElementChild?.remove();
    }
    const icon = kind === 'warning' ? 'warning' : kind === 'success' ? 'check' : 'shield';
    const node = document.createElement('div');
    node.className = `toast is-${kind}`;
    node.innerHTML = `<svg><use href="#i-${icon}"></use></svg><span>${escapeHTML(message)}</span>`;
    this.el.toastStack.appendChild(node);
    const timer = setTimeout(() => {
      node.classList.add('is-out');
      setTimeout(() => node.remove(), 240);
      this.toastTimers.delete(timer);
    }, timeout);
    this.toastTimers.add(timer);
  }

  openModal(id) {
    const modal = $(id);
    if (!modal) return;
    modal.classList.remove('hidden');
    this.sound?.ui();
  }

  closeModal(id) {
    const modal = $(id);
    if (modal) modal.classList.add('hidden');
  }

  closeAllModals() {
    document.querySelectorAll('.modal-backdrop').forEach((modal) => {
      if (modal.id === 'help-modal' || modal.id === 'game-menu') {
        modal.classList.add('hidden');
      }
    });
  }

  isModalOpen(id) {
    const modal = $(id);
    return Boolean(modal && !modal.classList.contains('hidden'));
  }

  goHome() {
    this.gameActive = false;
    this.room = null;
    this.hideCountdown();
    this.hideResult();
    this.setPaused(false, 0, 0);
    this.setReconnecting(false);
    this.showScreen('home');
    this.setEntryBusy(false);
    this.setSelection('', false);
    this.ready = false;
    this.confirmed = false;
    for (const [key, button] of this.characterButtons) {
      button.disabled = false;
      button.classList.remove('is-opponent-pick');
      button.classList.toggle('is-selected', key === this.selected);
    }
    const readyText = this.el.readyState?.querySelector('span:last-child');
    if (readyText) readyText.textContent = 'Ready when both warriors have chosen.';
    this.el.lobbyPlayers.innerHTML = '';
    this.healthValues = [100, 100];
    for (const hud of this.el.hud) {
      hud.fill.style.width = '100%';
      hud.trail.style.width = '100%';
      hud.hp.textContent = '100';
      hud.frame?.classList.remove('is-low', 'hit');
    }
  }

  resetForMatch() {
    this.hideResult();
    this.setPaused(false, 0, 0);
    this.setReconnecting(false);
    this.healthValues = [100, 100];
    this.gameActive = true;
  }

  setTouchDevice(isTouch) {
    document.body.classList.toggle('touch-device', Boolean(isTouch));
  }

  startGameScreen() {
    this.showScreen('game');
    this.gameActive = true;
  }
}
