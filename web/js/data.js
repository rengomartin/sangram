export const FALLBACK_CONFIG = {
  tickRate: 60,
  snapshotRate: 30,
  baseSpeed: 230,
  arenaWidth: 1800,
  arenaHeight: 1100,
  playerRadius: 27,
  countdownMs: 3000,
  disconnectGraceMs: 12000,
  dodgeCooldownMs: 1150,
  dodgeDurationMs: 160,
  dodgeSpeed: 760,
  dodgeInvulnerableMs: 175,
  attackMoveMultiplier: 0.52,
  blockMoveMultiplier: 0.32,
  characters: [
    {
      key: 'knight', name: 'Knight', health: 100, speedPercent: 100, damage: 15,
      range: 88, rangeLabel: 'Medium', weapon: 'Sword & Shield',
      blurb: 'Steady steel. A balanced blade and a wall of oak.',
      attackCooldownMs: 500, attackDurationMs: 340,
    },
    {
      key: 'berserker', name: 'Berserker', health: 100, speedPercent: 85, damage: 25,
      range: 74, rangeLabel: 'Short', weapon: 'Heavy Axe',
      blurb: 'Slow feet, ruinous blows. One clean hit changes everything.',
      attackCooldownMs: 760, attackDurationMs: 440,
    },
    {
      key: 'duelist', name: 'Duelist', health: 100, speedPercent: 120, damage: 10,
      range: 78, rangeLabel: 'Short', weapon: 'Twin Swords',
      blurb: 'A blur of green and steel. Strike often, strike first.',
      attackCooldownMs: 300, attackDurationMs: 255,
    },
    {
      key: 'guardian', name: 'Guardian', health: 100, speedPercent: 90, damage: 15,
      range: 124, rangeLabel: 'Long', weapon: 'Longsword',
      blurb: 'A long reach and patient guard. Control the space.',
      attackCooldownMs: 650, attackDurationMs: 395,
    },
  ],
};

export const CHARACTER_STYLE = {
  knight: {
    accent: '#9db7c8', accent2: '#e4d3ad', cloth: '#3b5266', metal: '#b7c9d2',
    wood: '#6e4b2f', crest: '#d8b26a', scale: 1.2, title: 'THE STEADY',
  },
  berserker: {
    accent: '#c7684e', accent2: '#d7ab65', cloth: '#64372d', metal: '#8b8174',
    wood: '#5c3c24', crest: '#c25b43', scale: 1.3, title: 'THE RUINOUS',
  },
  duelist: {
    accent: '#75a887', accent2: '#d9cf9f', cloth: '#2d5142', metal: '#b6b8a8',
    wood: '#6f5235', crest: '#70a583', scale: 1.14, title: 'THE SWIFT',
  },
  guardian: {
    accent: '#d1ae64', accent2: '#efe2c0', cloth: '#57482f', metal: '#d7c493',
    wood: '#73532f', crest: '#d7b163', scale: 1.36, title: 'THE WALL',
  },
};

export function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') return structuredClone(FALLBACK_CONFIG);
  const cfg = { ...FALLBACK_CONFIG, ...raw };
  if (!Array.isArray(cfg.characters) || cfg.characters.length === 0) {
    cfg.characters = structuredClone(FALLBACK_CONFIG.characters);
  }
  cfg.characterMap = Object.fromEntries(cfg.characters.map((c) => [c.key, c]));
  return cfg;
}

export function charStyle(key) {
  return CHARACTER_STYLE[key] || CHARACTER_STYLE.knight;
}

export function getCharacter(config, key) {
  return config?.characterMap?.[key] || config?.characters?.find((c) => c.key === key) || null;
}

export function rangeLabel(char) {
  return char?.rangeLabel || 'Medium';
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function angleLerp(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function easeOutCubic(t) {
  return 1 - Math.pow(1 - clamp(t, 0, 1), 3);
}

export function easeInOutCubic(t) {
  t = clamp(t, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

export function storageRemove(key) {
  try { localStorage.removeItem(key); } catch { /* private mode */ }
}

export function isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}
