import { GameNet, defaultNickname } from './net.js';
import { InputManager } from './input.js';
import { Renderer } from './renderer.js';
import { Camera } from './camera.js';
import { SoundManager } from './audio.js';
import { UI } from './ui.js';
import {
  FALLBACK_CONFIG, normalizeConfig, getCharacter, isTouchDevice,
} from './data.js';

const canvas = document.getElementById('game-canvas');
const app = {
  config: normalizeConfig(FALLBACK_CONFIG),
  screen: 'home',
  phase: 'home',
  room: null,
  lastState: null,
  localSlot: 0,
  inputEnabled: false,
  resultShown: false,
  cameraReady: false,
  attackRemaining: 0,
  attackTotal: 500,
  dodgeRemaining: 0,
  dodgeTotal: 1150,
  pendingAttack: false,
  pendingDodge: false,
};

const net = new GameNet({
  onStatus: (status) => {
    ui.setConnection(status.state, status.label);
    if (status.state === 'online') ui.setReconnecting(false);
    if (status.state !== 'online' && app.screen === 'game') ui.setReconnecting(true);
    if (status.state === 'offline') {
      app.inputEnabled = false;
      input.setEnabled(false);
    }
  },
  onMessage: (message) => handleMessage(message),
  onLatency: (ms) => ui.setPing(ms),
});

const sound = new SoundManager(net.muted);
const renderer = new Renderer(canvas, app.config, sound);
const camera = new Camera();
const ui = new UI({ config: app.config, renderer, sound });

const input = new InputManager({
  onAction: (action) => {
    if (!app.inputEnabled) return;
    if (action === 'attack') app.pendingAttack = true;
    if (action === 'dodge') app.pendingDodge = true;
    flushInput();
  },
  onBlockChange: () => {
    ui.setBlocking(input.getBlocking());
    if (app.inputEnabled) flushInput();
  },
  onMoveChange: () => {},
});

ui.handlers = {
  entry: ({ mode, nickname, code }) => {
    if (mode === 'join') {
      net.joinRoom(nickname, code).catch((error) => {
        ui.setEntryBusy(false);
        ui.showHomeError(error?.message || 'The arena server is unreachable.');
      });
    } else {
      net.createRoom(nickname).catch((error) => {
        ui.setEntryBusy(false);
        ui.showHomeError(error?.message || 'The arena server is unreachable.');
      });
    }
  },
  select: (character) => {
    if (!getCharacter(app.config, character)) return;
    sound.ui();
    ui.setSelection(character, false);
    net.selectCharacter(character);
  },
  confirm: (confirmed) => {
    sound.ready();
    ui.setSelection(ui.selected, confirmed);
    net.confirmCharacter(confirmed);
  },
  ready: (ready) => {
    sound.ready();
    net.setReady(ready);
  },
  copyCode: async (code) => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      ui.toast('Arena code copied. Share it with your rival.', 'success');
    } catch {
      const field = document.createElement('textarea');
      field.value = code;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      try {
        document.execCommand('copy');
        ui.toast('Arena code copied. Share it with your rival.', 'success');
      } catch {
        ui.toast(`Arena code: ${code}`, 'info');
      }
      field.remove();
    }
  },
  leave: () => leaveArena(),
  rematch: () => {
    net.rematch(true);
    ui.el.rematchBtn.disabled = true;
    if (ui.el.rematchBtnLabel) ui.el.rematchBtnLabel.textContent = 'Awaiting rival…';
    if (ui.el.rematchStatus) ui.el.rematchStatus.textContent = 'Your challenge has been sent…';
  },
  returnLobby: () => {
    net.returnToLobby();
    ui.setResultBusy(true);
  },
  toggleSound: () => {
    const muted = net.toggleMute();
    sound.setMuted(muted);
    ui.setMuted(muted);
    if (!muted) sound.unlock();
    sound.toggle();
  },
  countdownTick: (value) => sound.countdownTick(value === 0),
};

// ------------------------------------------------------------------ config

function applyConfig(raw) {
  if (!raw) return;
  const next = normalizeConfig(raw);
  const first = !app.config;
  app.config = next;
  renderer.setConfig(next);
  ui.setConfig(next);
  camera.setArena(next.arenaWidth, next.arenaHeight);
  updateCooldownTotals();
  if (first) resizeCanvas();
}

function updateCooldownTotals() {
  const key = app.lastState?.match?.fighters?.find((f) => f.slot === app.localSlot)?.character
    || app.room?.players?.find((p) => p.slot === app.localSlot)?.character
    || 'knight';
  const character = getCharacter(app.config, key);
  app.attackTotal = character?.attackCooldownMs || 500;
  app.dodgeTotal = app.config.dodgeCooldownMs || 1150;
}

async function loadConfig() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('/api/config', { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error('bad status');
    const data = await response.json();
    applyConfig(data);
  } catch {
    applyConfig(FALLBACK_CONFIG);
  }
}

// ------------------------------------------------------------------ messages

function handleMessage(message) {
  if (!message || typeof message.type !== 'string') return;
  switch (message.type) {
    case 'hello':
      applyConfig(message.config);
      break;
    case 'welcome':
      handleWelcome(message);
      break;
    case 'room':
      handleRoom(message.room);
      break;
    case 'state':
      handleState(message.state);
      break;
    case 'notice':
      if (message.message) ui.toast(message.message, message.kind === 'warning' ? 'warning' : message.kind === 'success' ? 'success' : 'info');
      break;
    case 'error':
      handleError(message);
      break;
    case 'session_lost':
      resetToHome(message.message || 'Your arena seat has expired.');
      ui.toast(message.message || 'Your arena seat has expired. Enter a new arena.', 'warning');
      break;
    case 'left':
      resetToHome('You left the arena.');
      break;
    default:
      break;
  }
}

function handleWelcome(message) {
  applyConfig(message.config);
  ui.setEntryBusy(false);
  ui.clearHomeError();
  ui.setNickname(message.room?.players?.find((p) => p.slot === message.room?.yourSlot)?.nickname || net.nickname);
  app.localSlot = message.room?.yourSlot === 1 ? 1 : 0;
  renderer.setLocalSlot(app.localSlot);
  app.room = message.room;
  updateCooldownTotals();
  ui.toast('Welcome to the arena.', 'success', 2200);
  sound.join();

  const phase = message.room?.phase || 'lobby';
  app.phase = phase;
  if (phase === 'lobby') {
    enterLobby(message.room);
  } else {
    enterGame();
    ui.showScreen('game');
    if (phase === 'countdown') {
      ui.updateCountdown({ phase: 'countdown', countdownMs: message.room?.countdownMs || app.config.countdownMs });
    }
  }
}

function handleRoom(room) {
  if (!room) return;
  app.room = room;
  app.localSlot = room.yourSlot === 1 ? 1 : 0;
  renderer.setLocalSlot(app.localSlot);
  updateCooldownTotals();

  const players = [...(room.players || [])];
  const characters = ['knight', 'berserker'];
  const names = ['Warrior', 'Rival'];
  const connected = [true, true];
  for (const player of players) {
    if (player.slot !== 0 && player.slot !== 1) continue;
    if (player.character) characters[player.slot] = player.character;
    names[player.slot] = player.nickname || names[player.slot];
    connected[player.slot] = player.connected !== false;
  }
  renderer.setRoster(characters, names, connected);

  const previousPhase = app.phase;
  app.phase = room.phase;

  if (room.phase === 'lobby') {
    enterLobby(room);
    return;
  }

  if (app.screen !== 'game') enterGame();
  ui.startGameScreen();

  if (room.phase === 'countdown') {
    ui.hideResult();
    ui.resetForMatch();
    app.resultShown = false;
    if (previousPhase === 'ended' || previousPhase === 'lobby' || previousPhase === 'home') {
      renderer.resetPrediction();
      app.cameraReady = false;
    }
    ui.updateCountdown({ phase: 'countdown', countdownMs: room.countdownMs || app.config.countdownMs });
    setInputEnabled(false);
  } else if (room.phase === 'playing') {
    ui.hideResult();
    setInputEnabled(true);
  } else if (room.phase === 'ended') {
    setInputEnabled(false);
  }
}

function handleState(state) {
  if (!state) return;
  app.lastState = state;
  const previous = app.phase;
  app.phase = state.phase;
  app.localSlot = state.yourSlot === 1 ? 1 : 0;
  renderer.setLocalSlot(app.localSlot);

  const players = [...(state.players || [])];
  const fighters = [...(state.match?.fighters || [])].sort((a, b) => a.slot - b.slot);
  const characters = ['knight', 'berserker'];
  const names = ['Warrior', 'Rival'];
  const connected = [true, true];
  for (const player of players) {
    if (player.slot !== 0 && player.slot !== 1) continue;
    if (player.character) characters[player.slot] = player.character;
    names[player.slot] = player.nickname || names[player.slot];
    connected[player.slot] = player.connected !== false;
  }
  for (const fighter of fighters) {
    if (fighter.slot === 0 || fighter.slot === 1) characters[fighter.slot] = fighter.character;
  }
  renderer.setRoster(characters, names, connected);

  if (app.screen !== 'game') {
    enterGame();
    ui.startGameScreen();
  }

  renderer.applyState(state);

  if (!app.cameraReady) {
    const view = renderer.fighterView(app.localSlot, performance.now());
    if (view) {
      camera.snapTo(view.displayX, view.displayY - 16);
      app.cameraReady = true;
    }
  }

  if (state.match) {
    renderer.handleEvents(state.events);
  }

  ui.updateHud(state);
  ui.updateCountdown(state);
  ui.setPaused(Boolean(state.paused), state.graceMs || 0, app.config.disconnectGraceMs);
  if (net.status === 'online') ui.setReconnecting(false);

  const local = fighters.find((f) => f.slot === app.localSlot);
  if (local) {
    app.attackRemaining = Math.max(0, (local.attackCooldown || 0) * 1000);
    app.dodgeRemaining = Math.max(0, (local.dodgeCooldown || 0) * 1000);
    updateCooldownTotals();
  }

  if (state.phase === 'countdown') {
    setInputEnabled(false);
    ui.hideResult();
    app.resultShown = false;
    if (previous === 'ended' || previous === 'lobby' || previous === 'home') {
      app.cameraReady = false;
      const view = renderer.fighterView(app.localSlot, performance.now());
      if (view) {
        camera.snapTo(view.displayX, view.displayY - 16);
        app.cameraReady = true;
      }
    }
  } else if (state.phase === 'playing') {
    setInputEnabled(!state.paused && net.status === 'online');
    ui.hideResult();
    app.resultShown = false;
  } else if (state.phase === 'ended') {
    setInputEnabled(false);
    if (!app.resultShown) {
      app.resultShown = true;
      ui.showResult(state);
    } else {
      ui.updateRematch(state);
    }
  } else if (state.phase === 'lobby') {
    setInputEnabled(false);
  }
}

function handleError(message) {
  ui.setEntryBusy(false);
  const text = message.message || 'The arena could not complete that action.';
  if (app.screen === 'home') {
    ui.showHomeError(text);
  } else {
    ui.toast(text, 'warning');
    ui.setResultBusy(false);
  }
}

// ------------------------------------------------------------------ screens

function enterLobby(room) {
  ui.hideResult();
  ui.setPaused(false, 0, 0);
  ui.setReconnecting(false);
  app.screen = 'lobby';
  ui.showScreen('lobby');
  ui.renderLobby(room, room.yourSlot);
  setInputEnabled(false);
  app.cameraReady = false;
  app.resultShown = false;
  if (room.phase === 'lobby') ui.hideCountdown();
}

function enterGame() {
  ui.startGameScreen();
  app.screen = 'game';
  resizeCanvas();
  ui.setReconnecting(net.status !== 'online');
  setInputEnabled(app.phase === 'playing' && net.status === 'online');
}

function setInputEnabled(enabled) {
  const next = Boolean(enabled) && app.screen === 'game';
  if (app.inputEnabled === next) return;
  app.inputEnabled = next;
  input.setEnabled(next);
  if (!next) {
    app.pendingAttack = false;
    app.pendingDodge = false;
    ui.setBlocking(false);
  }
}

function resetToHome(message) {
  app.phase = 'home';
  app.screen = 'home';
  app.room = null;
  app.lastState = null;
  app.resultShown = false;
  app.cameraReady = false;
  app.attackRemaining = 0;
  app.dodgeRemaining = 0;
  setInputEnabled(false);
  renderer.resetPrediction();
  ui.goHome();
  ui.hideBoot();
  if (message) ui.toast(message, 'info');
  net.clearSession?.();
}

function leaveArena() {
  if (app.screen === 'home') return;
  sound.ui();
  setInputEnabled(false);
  app.phase = 'home';
  if (net.isOpen() && net.welcomed) {
    net.leave();
  }
  const fallback = setTimeout(() => {
    if (app.screen !== 'home') {
      net.clearSession?.();
      resetToHome('You left the arena.');
      if (!net.isOpen()) net.connect();
    }
  }, 1400);
  // `left` normally arrives almost immediately and resets the screen first.
  const check = setInterval(() => {
    if (app.screen === 'home') {
      clearTimeout(fallback);
      clearInterval(check);
    }
  }, 120);
  setTimeout(() => clearInterval(check), 2500);
}

// ------------------------------------------------------------------ input

function flushInput() {
  if (!app.inputEnabled || !net.isOpen() || !net.welcomed) return;
  const move = input.getMove();
  const block = input.getBlocking();
  const attack = app.pendingAttack;
  const dodge = app.pendingDodge;
  app.pendingAttack = false;
  app.pendingDodge = false;
  net.sendInput(move, block, attack, dodge);
  ui.setBlocking(block);
}

setInterval(() => {
  if (!app.inputEnabled) return;
  flushInput();
}, 33);

// ------------------------------------------------------------------ loop

function resizeCanvas() {
  renderer.resize(window.innerWidth, window.innerHeight);
  camera.resize(window.innerWidth, window.innerHeight);
}

window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 160));

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;

  if (app.screen === 'game') {
    const move = app.inputEnabled ? input.getMove() : { x: 0, y: 0 };
    const block = app.inputEnabled ? input.getBlocking() : false;
    renderer.update(dt, { move, block }, now);
    const view = renderer.fighterView(app.localSlot, now);
    if (view) {
      camera.update(dt, view.displayX, view.displayY, move.x, move.y);
    } else {
      camera.update(dt, camera.x, camera.y, 0, 0);
    }
    renderer.render(camera, now);

    const local = app.lastState?.match?.fighters?.find((f) => f.slot === app.localSlot);
    app.attackRemaining = Math.max(0, app.attackRemaining - dt * 1000);
    app.dodgeRemaining = Math.max(0, app.dodgeRemaining - dt * 1000);
    const character = local ? getCharacter(app.config, local.character) : null;
    ui.setCooldowns(
      app.attackRemaining, character?.attackCooldownMs || app.attackTotal,
      app.dodgeRemaining, app.config.dodgeCooldownMs || app.dodgeTotal,
    );
  }

  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ boot

async function boot() {
  await loadConfig();
  ui.setTouchDevice(isTouchDevice());
  ui.setConfig(app.config);
  ui.setMuted(net.muted);
  sound.setMuted(net.muted);
  renderer.setConfig(app.config);
  camera.setArena(app.config.arenaWidth, app.config.arenaHeight);
  resizeCanvas();
  ui.setNickname(net.nickname || defaultNickname());
  ui.setConnection('connecting', 'Connecting');
  ui.hideBoot();

  const unlock = () => sound.unlock();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  if (net.hasSession) {
    ui.toast('Restoring your seat in the arena…', 'info', 2600);
  }
  net.connect();
  requestAnimationFrame((now) => {
    lastFrame = now;
    requestAnimationFrame(frame);
  });
}

boot();
