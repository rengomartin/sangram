import {
  clamp, lerp, angleLerp, charStyle, getCharacter, easeOutCubic, easeInOutCubic,
} from './data.js';

const TAU = Math.PI * 2;
const INK = '#1a1610';
const AEN = 120; // arena texture margin for walls

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function ellipse(ctx, x, y, rx, ry, rotation = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rotation, 0, TAU);
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

export class Renderer {
  constructor(canvas, config, sound = null) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.config = config;
    this.sound = sound;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.time = 0;
    this.arenaTexture = null;
    this.arenaKey = '';

    this.localSlot = 0;
    this.characters = ['knight', 'berserker'];
    this.names = ['Warrior', 'Rival'];
    this.connected = [true, true];

    this.local = null;
    this.lastTick = 0;
    this.matchReady = false;
    this.display = new Map();
    this.buffers = { 0: [], 1: [] };
    this.authoritative = { 0: null, 1: null };

    this.particles = [];
    this.floaters = [];
    this.shake = 0;
    this.flash = 0;
    this.torches = [
      { x: 70, y: 70, seed: 1.2 },
      { x: -70, y: 70, seed: 2.8 },
      { x: 70, y: -70, seed: 4.4 },
      { x: -70, y: -70, seed: 6.1 },
    ];
    this.arena = { width: 1800, height: 1100 };
    this.setConfig(config);
  }

  setConfig(config) {
    this.config = config;
    this.arena = { width: config.arenaWidth, height: config.arenaHeight };
    const key = `${this.arena.width}x${this.arena.height}`;
    if (this.arenaKey !== key || !this.arenaTexture) {
      this.arenaKey = key;
      this.buildArenaTexture();
    }
  }

  setSound(sound) { this.sound = sound; }

  resize(width, height) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(this.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(this.height * this.dpr));
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }

  setLocalSlot(slot) { this.localSlot = slot === 1 ? 1 : 0; }

  setRoster(characters, names, connected) {
    if (Array.isArray(characters)) this.characters = characters;
    if (Array.isArray(names)) this.names = names;
    if (Array.isArray(connected)) this.connected = connected;
  }

  resetPrediction() {
    this.local = null;
    this.lastTick = 0;
    this.matchReady = false;
    this.display.clear();
    this.buffers = { 0: [], 1: [] };
    this.authoritative = { 0: null, 1: null };
    this.particles.length = 0;
    this.floaters.length = 0;
    this.shake = 0;
    this.flash = 0;
  }

  // ---------------------------------------------------------------- snapshots

  applyState(state, now = performance.now()) {
    if (!state || !state.match) return;
    const match = state.match;
    if (match.arena?.width) {
      this.arena = { width: match.arena.width, height: match.arena.height };
      if (this.arenaKey !== `${this.arena.width}x${this.arena.height}`) {
        this.arenaKey = `${this.arena.width}x${this.arena.height}`;
        this.buildArenaTexture();
      }
    }
    if (match.tick === 0 && this.lastTick !== 0) this.resetPrediction();
    this.lastTick = Math.max(this.lastTick, match.tick || 0);

    const players = state.players || [];
    const names = [null, null];
    const connected = [true, true];
    for (const p of players) {
      if (p.slot === 0 || p.slot === 1) {
        names[p.slot] = p.nickname;
        connected[p.slot] = p.connected !== false;
      }
    }
    if (names[0]) this.names[0] = names[0];
    if (names[1]) this.names[1] = names[1];
    this.connected = connected;

    const fighters = [...(match.fighters || [])].sort((a, b) => a.slot - b.slot);
    for (const f of fighters) {
      const slot = f.slot;
      if (slot !== 0 && slot !== 1) continue;
      this.characters[slot] = f.character || this.characters[slot];
      this.authoritative[slot] = f;
      const buffer = this.buffers[slot];
      const last = buffer[buffer.length - 1];
      if (last && Math.hypot(last.x - f.x, last.y - f.y) > 240) buffer.length = 0;
      buffer.push({
        t: now, x: f.x, y: f.y, facing: f.facing,
        dashing: f.dashing, dodgeAngle: f.dodgeAngle, dodgeProgress: f.dodgeProgress,
      });
      if (buffer.length > 30) buffer.shift();

      if (slot === this.localSlot) {
        if (!this.local) {
          this.local = {
            x: f.x, y: f.y, facing: f.facing,
            correctionX: 0, correctionY: 0,
          };
        } else {
          const errX = f.x - this.local.x;
          const errY = f.y - this.local.y;
          const err = Math.hypot(errX, errY);
          if (err > 240 || match.tick === 0) {
            this.local.x = f.x;
            this.local.y = f.y;
            this.local.correctionX = 0;
            this.local.correctionY = 0;
          } else if (f.dashing) {
            this.local.x = lerp(this.local.x, f.x, 0.7);
            this.local.y = lerp(this.local.y, f.y, 0.7);
            this.local.correctionX = 0;
            this.local.correctionY = 0;
          } else {
            this.local.correctionX = errX;
            this.local.correctionY = errY;
          }
          if (!f.attacking && !f.dashing && !f.blocking && !f.hurt) {
            const move = this.localMove || { x: 0, y: 0 };
            if (Math.hypot(move.x, move.y) > 0.05) this.local.facing = Math.atan2(move.y, move.x);
          }
        }
      }
    }
    this.matchReady = true;
  }

  // ---------------------------------------------------------------- update

  update(dt, input = { move: { x: 0, y: 0 }, block: false }, now = performance.now()) {
    this.time += dt;
    this.localMove = input.move || { x: 0, y: 0 };
    this.localBlock = Boolean(input.block);
    this.updateParticles(dt);
    this.shake *= Math.exp(-9 * Math.min(dt, 0.05));
    if (this.shake < 0.05) this.shake = 0;
    this.flash = Math.max(0, this.flash - dt * 4.5);

    const auth = this.authoritative[this.localSlot];
    if (this.local && auth) {
      const move = this.localMove;
      const len = Math.hypot(move.x, move.y);
      const character = getCharacter(this.config, auth.character || this.characters[this.localSlot]);
      const speedPct = character ? character.speedPercent / 100 : 1;
      let speed = (this.config.baseSpeed || 230) * speedPct;
      if (auth.blocking) speed *= this.config.blockMoveMultiplier ?? 0.32;
      else if (auth.attacking) speed *= this.config.attackMoveMultiplier ?? 0.52;
      if (!auth.dashing && !auth.hurt) {
        this.local.x += move.x * speed * dt;
        this.local.y += move.y * speed * dt;
        if (len > 0.05 && !auth.attacking && !auth.blocking) {
          this.local.facing = Math.atan2(move.y, move.x);
        }
      }
      const pull = Math.min(1, dt * 14);
      this.local.x += this.local.correctionX * pull;
      this.local.y += this.local.correctionY * pull;
      this.local.correctionX *= 1 - pull;
      this.local.correctionY *= 1 - pull;
      const r = this.config.playerRadius || 27;
      this.local.x = clamp(this.local.x, r, this.arena.width - r);
      this.local.y = clamp(this.local.y, r, this.arena.height - r);
    }
  }

  // ---------------------------------------------------------------- display

  displayPosition(slot, now) {
    const buffer = this.buffers[slot];
    if (!buffer || buffer.length === 0) {
      const auth = this.authoritative[slot];
      if (!auth) return null;
      return { x: auth.x, y: auth.y, facing: auth.facing };
    }
    if (slot === this.localSlot && this.local) {
      return {
        x: this.local.x,
        y: this.local.y,
        facing: this.local.facing,
      };
    }
    if (buffer.length === 1) return { ...buffer[0] };
    const renderTime = now - 105;
    let a = buffer[0];
    let b = buffer[0];
    for (let i = buffer.length - 1; i >= 0; i -= 1) {
      if (buffer[i].t <= renderTime) {
        a = buffer[i];
        b = buffer[Math.min(i + 1, buffer.length - 1)];
        break;
      }
    }
    if (renderTime < buffer[0].t) return { ...buffer[0] };
    const span = Math.max(1, b.t - a.t);
    const t = clamp((renderTime - a.t) / span, 0, 1);
    return {
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      facing: angleLerp(a.facing, b.facing, t),
    };
  }

  fighterView(slot, now) {
    const auth = this.authoritative[slot];
    if (!auth) return null;
    const pos = this.displayPosition(slot, now) || { x: auth.x, y: auth.y, facing: auth.facing };
    return {
      ...auth,
      displayX: pos.x,
      displayY: pos.y,
      displayFacing: pos.facing,
      isLocal: slot === this.localSlot,
      character: auth.character || this.characters[slot],
    };
  }

  // ---------------------------------------------------------------- events

  handleEvents(events) {
    if (!Array.isArray(events)) return;
    for (const event of events) {
      if (!event) continue;
      const angle = event.angle || 0;
      if (event.kind === 'hit') {
        this.spawnSparks(event.x, event.y, 'hit', angle);
        this.floaters.push({
          x: event.x, y: event.y - 18, text: `-${Math.round(event.amount || 0)}`,
          life: 0.95, max: 0.95, color: event.target === this.localSlot ? '#ff9a85' : '#ffe2a8',
          size: 22,
        });
        this.shake = Math.min(14, this.shake + (event.target === this.localSlot ? 9 : 6));
        if (event.target === this.localSlot) this.flash = 0.75;
        this.sound?.hit(event.target === this.localSlot);
      } else if (event.kind === 'block') {
        this.spawnSparks(event.x, event.y, 'block', angle);
        this.floaters.push({
          x: event.x, y: event.y - 18, text: 'BLOCKED',
          life: 0.8, max: 0.8, color: '#dfeaf0', size: 13,
        });
        this.shake = Math.min(10, this.shake + 4);
        this.sound?.block();
      } else if (event.kind === 'swing') {
        this.spawnSparks(event.x, event.y, 'swing', angle);
        this.sound?.swing();
      } else if (event.kind === 'dodge') {
        this.spawnSparks(event.x, event.y, 'dodge', angle);
        this.sound?.dodge();
      }
    }
  }

  spawnSparks(x, y, kind, angle) {
    const count = kind === 'hit' ? 15 : kind === 'block' ? 11 : kind === 'dodge' ? 7 : 4;
    for (let i = 0; i < count; i += 1) {
      const spread = kind === 'swing' || kind === 'dodge'
        ? angle + (Math.random() - 0.5) * 1.2
        : Math.random() * TAU;
      const speed = kind === 'hit' ? 90 + Math.random() * 190
        : kind === 'block' ? 70 + Math.random() * 170
          : kind === 'dodge' ? 30 + Math.random() * 70
            : 40 + Math.random() * 90;
      const life = 0.22 + Math.random() * 0.4;
      this.particles.push({
        x: x + (Math.random() - 0.5) * 16,
        y: y + (Math.random() - 0.5) * 16,
        vx: Math.cos(spread) * speed,
        vy: Math.sin(spread) * speed,
        life, max: life,
        size: kind === 'block' ? 1.6 + Math.random() * 2 : 1.2 + Math.random() * 2.4,
        color: kind === 'hit' ? (Math.random() > 0.35 ? '#ffd18d' : '#fff2d0')
          : kind === 'block' ? (Math.random() > 0.4 ? '#d9ecf2' : '#ffe8ac')
            : kind === 'dodge' ? '#a99a78' : '#d8c59d',
        drag: kind === 'dodge' ? 4 : 2.5,
        gravity: kind === 'dodge' ? -8 : 55,
        glow: kind === 'hit' || kind === 'block',
      });
    }
  }

  updateParticles(dt) {
    const step = Math.min(dt, 0.05);
    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const p = this.particles[i];
      p.life -= step;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * step;
      p.y += p.vy * step;
      p.vy += p.gravity * step;
      p.vx *= Math.exp(-p.drag * step);
      p.vy *= Math.exp(-p.drag * step);
    }
    for (let i = this.floaters.length - 1; i >= 0; i -= 1) {
      const f = this.floaters[i];
      f.life -= step;
      f.y -= 42 * step;
      if (f.life <= 0) this.floaters.splice(i, 1);
    }
  }

  // ---------------------------------------------------------------- arena art

  buildArenaTexture() {
    const W = this.arena.width;
    const H = this.arena.height;
    const TS = 1.6; // supersample so the art stays crisp when the camera zooms in
    const canvas = document.createElement('canvas');
    canvas.width = Math.round((W + AEN * 2) * TS);
    canvas.height = Math.round((H + AEN * 2) * TS);
    const ctx = canvas.getContext('2d');
    ctx.scale(TS, TS);
    const random = mulberry32(20260214);
    const ox = AEN;
    const oy = AEN;

    // Deep earth beyond the walls.
    const outside = ctx.createRadialGradient(
      ox + W / 2, oy + H / 2, Math.min(W, H) * 0.2,
      ox + W / 2, oy + H / 2, Math.max(W, H) * 0.78,
    );
    outside.addColorStop(0, '#1d231a');
    outside.addColorStop(0.7, '#11150f');
    outside.addColorStop(1, '#080a07');
    ctx.fillStyle = outside;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Floor.
    const floor = ctx.createLinearGradient(ox, oy, ox + W, oy + H);
    floor.addColorStop(0, '#585139');
    floor.addColorStop(0.45, '#4a452f');
    floor.addColorStop(1, '#3f3b28');
    ctx.fillStyle = floor;
    ctx.fillRect(ox, oy, W, H);

    // Large worn stone tiles.
    const tile = 100;
    for (let y = 0; y < H; y += tile) {
      for (let x = 0; x < W; x += tile) {
        const shade = (random() - 0.5) * 26;
        const r = Math.round(76 + shade);
        const g = Math.round(72 + shade * 0.9);
        const b = Math.round(54 + shade * 0.75);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(ox + x + 1.5, oy + y + 1.5, tile - 3, tile - 3);
        // Worn highlight along the top and left edge of each slab.
        ctx.strokeStyle = `rgba(228,214,178,${0.035 + random() * 0.035})`;
        ctx.lineWidth = 1;
        line(ctx, ox + x + 3, oy + y + 2.5, ox + x + tile - 4, oy + y + 2.5);
        line(ctx, ox + x + 2.5, oy + y + 3, ox + x + 2.5, oy + y + tile - 4);
        if (random() > 0.82) {
          ctx.fillStyle = `rgba(32,36,25,${0.06 + random() * 0.1})`;
          ctx.fillRect(ox + x + 5, oy + y + 5, tile - 10, tile - 10);
        }
        if (random() > 0.9) {
          // Chipped corner.
          ctx.fillStyle = 'rgba(30,32,23,0.16)';
          ctx.beginPath();
          ctx.moveTo(ox + x + tile - 18, oy + y + 2);
          ctx.lineTo(ox + x + tile - 2, oy + y + 2);
          ctx.lineTo(ox + x + tile - 2, oy + y + 18);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    // A few larger, darker flagstones break up the grid.
    for (let i = 0; i < 16; i += 1) {
      const x = ox + Math.floor(random() * 17) * tile;
      const y = oy + Math.floor(random() * 10) * tile;
      const w = tile * (random() > 0.6 ? 2 : 1);
      ctx.fillStyle = `rgba(38,40,29,${0.05 + random() * 0.07})`;
      ctx.fillRect(x + 2, y + 2, w - 4, tile - 4);
    }

    // Mortar lines, broken occasionally for a hand-laid feel.
    ctx.strokeStyle = 'rgba(26,26,18,0.55)';
    ctx.lineWidth = 2.6;
    for (let x = 0; x <= W; x += tile) {
      for (let y = 0; y < H; y += tile) {
        if (random() > 0.08) {
          const jx = (random() - 0.5) * 2.2;
          line(ctx, ox + x + jx, oy + y + 2, ox + x + jx, oy + Math.min(H, y + tile) - 2);
        }
      }
    }
    for (let y = 0; y <= H; y += tile) {
      for (let x = 0; x < W; x += tile) {
        if (random() > 0.08) {
          const jy = (random() - 0.5) * 2.2;
          line(ctx, ox + x + 2, oy + y + jy, ox + Math.min(W, x + tile) - 2, oy + y + jy);
        }
      }
    }

    // Sand drifts.
    for (let i = 0; i < 34; i += 1) {
      const x = ox + random() * W;
      const y = oy + random() * H;
      const r = 35 + random() * 120;
      const g = ctx.createRadialGradient(x, y, 4, x, y, r);
      g.addColorStop(0, `rgba(151,135,99,${0.035 + random() * 0.04})`);
      g.addColorStop(1, 'rgba(151,135,99,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // Moss creeping in from the walls.
    for (let i = 0; i < 26; i += 1) {
      let x;
      let y;
      if (random() > 0.5) {
        x = ox + (random() > 0.5 ? random() * 120 : W - random() * 120);
        y = oy + random() * H;
      } else {
        x = ox + random() * W;
        y = oy + (random() > 0.5 ? random() * 90 : H - random() * 90);
      }
      const r = 20 + random() * 65;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(62,78,46,${0.09 + random() * 0.08})`);
      g.addColorStop(1, 'rgba(62,78,46,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // Cracks and scattered stones.
    ctx.strokeStyle = 'rgba(30,29,21,0.5)';
    ctx.lineWidth = 1.7;
    for (let i = 0; i < 30; i += 1) {
      let x = ox + 40 + random() * (W - 80);
      let y = oy + 40 + random() * (H - 80);
      ctx.beginPath();
      ctx.moveTo(x, y);
      const segments = 2 + Math.floor(random() * 4);
      for (let j = 0; j < segments; j += 1) {
        x += (random() - 0.5) * 70;
        y += (random() - 0.5) * 70;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (let i = 0; i < 46; i += 1) {
      const x = ox + 30 + random() * (W - 60);
      const y = oy + 30 + random() * (H - 60);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(random() * TAU);
      ctx.fillStyle = `rgba(38,37,28,${0.12 + random() * 0.15})`;
      ellipse(ctx, 0, 0, 2 + random() * 5, 1.4 + random() * 3);
      ctx.fill();
      ctx.restore();
    }

    // Central sigil.
    const cx = ox + W / 2;
    const cy = oy + H / 2;
    ctx.save();
    ctx.translate(cx, cy);
    const sigil = ctx.createRadialGradient(0, 0, 10, 0, 0, 235);
    sigil.addColorStop(0, 'rgba(217,172,91,0.09)');
    sigil.addColorStop(0.7, 'rgba(217,172,91,0.035)');
    sigil.addColorStop(1, 'rgba(217,172,91,0)');
    ctx.fillStyle = sigil;
    ctx.beginPath();
    ctx.arc(0, 0, 235, 0, TAU);
    ctx.fill();

    ctx.strokeStyle = 'rgba(217,172,91,0.13)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, 190, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(217,172,91,0.07)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(0, 0, 172, 0, TAU);
    ctx.stroke();

    // Rune ticks.
    for (let i = 0; i < 24; i += 1) {
      const a = (i / 24) * TAU;
      const long = i % 6 === 0;
      ctx.strokeStyle = `rgba(217,172,91,${long ? 0.19 : 0.09})`;
      ctx.lineWidth = long ? 3 : 1.4;
      line(
        ctx,
        Math.cos(a) * (long ? 148 : 158), Math.sin(a) * (long ? 148 : 158),
        Math.cos(a) * 172, Math.sin(a) * 172,
      );
    }

    // Crossed swords etched into the floor.
    ctx.rotate(-0.62);
    ctx.lineCap = 'round';
    for (const dir of [1, -1]) {
      ctx.save();
      ctx.scale(dir, 1);
      ctx.strokeStyle = 'rgba(35,32,23,0.4)';
      ctx.lineWidth = 9;
      line(ctx, 0, -138, 0, 58);
      ctx.strokeStyle = 'rgba(217,172,91,0.15)';
      ctx.lineWidth = 2;
      line(ctx, 0, -130, 0, 54);
      ctx.strokeStyle = 'rgba(35,32,23,0.42)';
      ctx.lineWidth = 6;
      line(ctx, -26, -44, 26, -44);
      ctx.restore();
    }
    ctx.restore();

    // Spawn markings.
    for (const spawnX of [this.config.spawnInset || 300, W - (this.config.spawnInset || 300)]) {
      ctx.save();
      ctx.translate(ox + spawnX, cy);
      ctx.strokeStyle = 'rgba(217,172,91,0.16)';
      ctx.lineWidth = 2;
      ctx.setLineDash([16, 13]);
      ctx.beginPath();
      ctx.arc(0, 0, 62, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(35,32,23,0.35)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(0, 0, 52, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = 'rgba(217,172,91,0.1)';
      ctx.beginPath();
      ctx.moveTo(0, -13);
      ctx.lineTo(11, 8);
      ctx.lineTo(0, 3);
      ctx.lineTo(-11, 8);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Walls: heavy timber-and-stone palisade ringing the field.
    const wall = 66;
    const drawWallBand = (x, y, w, h, horizontal) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      const grad = ctx.createLinearGradient(x, y, horizontal ? x : x + w, horizontal ? y + h : y);
      grad.addColorStop(0, '#3f4436');
      grad.addColorStop(0.55, '#33382c');
      grad.addColorStop(1, '#262a20');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, h);

      const block = 58;
      ctx.strokeStyle = 'rgba(18,19,14,0.55)';
      ctx.lineWidth = 2;
      if (horizontal) {
        for (let bx = x; bx < x + w; bx += block) {
          line(ctx, bx, y, bx, y + h);
          if (random() > 0.5) line(ctx, bx, y + h / 2, bx + block, y + h / 2);
        }
        line(ctx, x, y + h / 2, x + w, y + h / 2);
      } else {
        for (let by = y; by < y + h; by += block) {
          line(ctx, x, by, x + w, by);
          if (random() > 0.5) line(ctx, x + w / 2, by, x + w / 2, by + block);
        }
        line(ctx, x + w / 2, y, x + w / 2, y + h);
      }
      ctx.restore();
    };

    drawWallBand(ox - wall, oy - wall, W + wall * 2, wall, true);
    drawWallBand(ox - wall, oy + H, W + wall * 2, wall, true);
    drawWallBand(ox - wall, oy, wall, H, false);
    drawWallBand(ox + W, oy, wall, H, false);

    // Wall inner edge shadow and highlight.
    ctx.fillStyle = 'rgba(0,0,0,0.33)';
    ctx.fillRect(ox, oy, W, 9);
    ctx.fillRect(ox, oy, 9, H);
    ctx.fillRect(ox + W - 9, oy, 9, H);
    ctx.fillRect(ox, oy + H - 9, W, 9);
    ctx.fillStyle = 'rgba(255,236,196,0.07)';
    ctx.fillRect(ox, oy - wall, W, 3);
    ctx.fillRect(ox, oy + H + wall - 3, W, 3);
    ctx.fillRect(ox - wall, oy, 3, H);
    ctx.fillRect(ox + W + wall - 3, oy, 3, H);

    // Crenellations.
    for (let x = ox - wall + 10; x < ox + W + wall - 10; x += 74) {
      for (const y of [oy - wall - 9, oy + H + wall - 24]) {
        ctx.fillStyle = '#454a3b';
        ctx.strokeStyle = 'rgba(18,19,14,0.55)';
        ctx.lineWidth = 1.6;
        roundRect(ctx, x, y, 34, 24, 3);
        ctx.fill();
        ctx.stroke();
      }
    }
    for (let y = oy + 14; y < oy + H - 10; y += 74) {
      for (const x of [ox - wall - 9, ox + W + wall - 24]) {
        ctx.fillStyle = '#454a3b';
        ctx.strokeStyle = 'rgba(18,19,14,0.55)';
        ctx.lineWidth = 1.6;
        roundRect(ctx, x, y, 24, 34, 3);
        ctx.fill();
        ctx.stroke();
      }
    }

    // Corner towers.
    for (const [tx, ty] of [
      [ox, oy], [ox + W, oy], [ox, oy + H], [ox + W, oy + H],
    ]) {
      ctx.save();
      ctx.translate(tx, ty);
      ctx.fillStyle = '#3b4032';
      ctx.strokeStyle = 'rgba(16,18,13,0.65)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 56, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(16,18,13,0.4)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, 40, 0, TAU);
      ctx.stroke();
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * TAU;
        ctx.fillStyle = '#474c3b';
        ctx.beginPath();
        ctx.arc(Math.cos(a) * 48, Math.sin(a) * 48, 8, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    // Hanging banners on the north and south walls.
    const banner = (x, y, w, h, flip) => {
      ctx.save();
      ctx.translate(x, y);
      if (flip) ctx.scale(1, -1);
      ctx.fillStyle = '#7c2f29';
      ctx.strokeStyle = 'rgba(20,14,10,0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-w / 2, 0);
      ctx.lineTo(w / 2, 0);
      ctx.lineTo(w / 2, h * 0.84);
      ctx.lineTo(0, h);
      ctx.lineTo(-w / 2, h * 0.84);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(217,172,91,0.45)';
      ctx.beginPath();
      ctx.moveTo(0, h * 0.22);
      ctx.lineTo(w * 0.16, h * 0.52);
      ctx.lineTo(0, h * 0.46);
      ctx.lineTo(-w * 0.16, h * 0.52);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(217,172,91,0.35)';
      line(ctx, -w * 0.38, h * 0.18, w * 0.38, h * 0.18);
      line(ctx, -w * 0.34, h * 0.72, w * 0.34, h * 0.72);
      ctx.restore();
    };
    banner(ox + W * 0.25, oy - wall + 4, 52, 118, false);
    banner(ox + W * 0.75, oy - wall + 4, 52, 118, false);
    banner(ox + W * 0.5, oy + H + wall - 4, 58, 124, true);

    // Soft edge vignette on the floor.
    const vignette = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.34, cx, cy, Math.max(W, H) * 0.72);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(6,8,5,0.34)');
    ctx.fillStyle = vignette;
    ctx.fillRect(ox, oy, W, H);

    this.arenaTexture = canvas;
  }

  // ---------------------------------------------------------------- render

  render(camera, now = performance.now()) {
    const ctx = this.ctx;
    if (!ctx) return;
    const shakeX = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
    const shakeY = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0a0d09';
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.save();
    ctx.translate(this.width / 2 + shakeX, this.height / 2 + shakeY);
    ctx.scale(camera.scale, camera.scale);
    ctx.translate(-camera.x, -camera.y);

    if (this.arenaTexture) {
      ctx.drawImage(this.arenaTexture, -AEN, -AEN, this.arena.width + AEN * 2, this.arena.height + AEN * 2);
    }

    this.drawTorches();
    this.drawBlockArcs(now);
    this.drawParticles(false);

    const views = [0, 1].map((slot) => this.fighterView(slot, now)).filter(Boolean);
    views.sort((a, b) => a.displayY - b.displayY);
    for (const view of views) this.drawFighter(ctx, view, now);

    this.drawAttackArcs(views);
    this.drawParticles(true);
    ctx.restore();

    this.drawOverheadBars(views, camera);
    this.drawOffscreenIndicator(views, camera);
    this.drawFloaters(camera);

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(150,32,24,${this.flash * 0.16})`;
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }

  drawTorches() {
    const W = this.arena.width;
    const H = this.arena.height;
    const spots = [
      [70, 70], [W - 70, 70], [70, H - 70], [W - 70, H - 70],
    ];
    for (let i = 0; i < spots.length; i += 1) {
      const [x, y] = spots[i];
      const flicker = 0.82 + Math.sin(this.time * 9 + i * 2.3) * 0.1 + Math.sin(this.time * 23 + i) * 0.05;
      const grad = this.ctx.createRadialGradient(x, y, 4, x, y, 96 * flicker);
      grad.addColorStop(0, 'rgba(255,177,79,0.15)');
      grad.addColorStop(0.45, 'rgba(255,143,58,0.05)');
      grad.addColorStop(1, 'rgba(255,143,58,0)');
      this.ctx.fillStyle = grad;
      this.ctx.fillRect(x - 120, y - 120, 240, 240);

      this.ctx.save();
      this.ctx.translate(x, y);
      this.ctx.strokeStyle = 'rgba(20,16,10,0.7)';
      this.ctx.lineWidth = 3;
      line(this.ctx, 0, 0, 0, 24);
      this.ctx.fillStyle = '#f0a448';
      this.ctx.beginPath();
      this.ctx.moveTo(0, -14 * flicker);
      this.ctx.quadraticCurveTo(9, -4, 0, 6);
      this.ctx.quadraticCurveTo(-9, -4, 0, -14 * flicker);
      this.ctx.fill();
      this.ctx.fillStyle = '#ffe3a2';
      this.ctx.beginPath();
      this.ctx.ellipse(0, -2, 2.6, 6 * flicker, 0, 0, TAU);
      this.ctx.fill();
      this.ctx.restore();
    }
  }

  drawBlockArcs(now) {
    for (const slot of [0, 1]) {
      const f = this.authoritative[slot];
      if (!f || !f.blocking) continue;
      const pos = this.displayPosition(slot, now);
      if (!pos) continue;
      const facing = pos.facing;
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(pos.x, pos.y);
      ctx.strokeStyle = f.invulnerable ? 'rgba(220,240,250,0.20)' : 'rgba(196,220,228,0.13)';
      ctx.lineWidth = 20;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0, 47, facing - 1.05, facing + 1.05);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(225,242,247,0.28)';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(0, 0, 57, facing - 0.92, facing + 0.92);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawAttackArcs(views) {
    const ctx = this.ctx;
    for (const f of views) {
      if (!f.attacking) continue;
      const p = f.attackProgress;
      if (p < 0.16 || p > 0.74) continue;
      const character = getCharacter(this.config, f.character);
      const range = (character?.range || 80) + (this.config.playerRadius || 27) * 0.55;
      const sweep = clamp((p - 0.16) / 0.46, 0, 1);
      const base = f.attackAngle;
      const head = base - 0.92 + 1.84 * easeOutCubic(sweep);
      const tail = base - 0.92;
      const alpha = 1 - clamp((p - 0.5) / 0.3, 0, 1) * 0.6;
      const warm = f.isLocal ? '255,238,198' : '238,168,148';
      ctx.save();
      ctx.translate(f.displayX, f.displayY);
      ctx.lineCap = 'round';
      for (const [width, a] of [[22, 0.05], [12, 0.09], [5, 0.16]]) {
        ctx.strokeStyle = `rgba(${warm},${a * alpha})`;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.arc(0, 0, range, tail, head);
        ctx.stroke();
      }
      ctx.strokeStyle = `rgba(${warm},${0.5 * alpha})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, range + 3, Math.max(tail, head - 0.35), head);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawParticles(glowPass) {
    const ctx = this.ctx;
    ctx.save();
    if (glowPass) ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      if (Boolean(p.glow) !== glowPass) continue;
      const a = clamp(p.life / p.max, 0, 1);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.4 + a * 0.8), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- fighters

  drawFighter(ctx, f, now) {
    const style = charStyle(f.character);
    const s = style.scale || 1;
    const auth = this.authoritative[f.slot] || f;
    const hostile = !f.isLocal;
    const attacking = auth.attacking;
    const progress = auth.attackProgress || 0;
    const blocking = auth.blocking;
    const dashing = auth.dashing;
    const hurt = auth.hurt;
    const invulnerable = auth.invulnerable;
    const move = f.isLocal ? (this.localMove || { x: 0, y: 0 }) : { x: Math.abs(auth.x - (auth.lastX ?? auth.x)), y: 0 };
    const moving = f.isLocal ? Math.hypot(move.x, move.y) > 0.08 : false;
    const walk = this.time * 12 + f.slot * 2.1;
    const bob = moving ? Math.sin(walk) * 1.1 : Math.sin(this.time * 2.2 + f.slot) * 0.5;
    const facing = attacking ? angleLerp(f.displayFacing, auth.attackAngle, 0.82) : f.displayFacing;

    if (dashing) {
      // Speed ghosts trailing behind the dash.
      for (let i = 3; i >= 1; i -= 1) {
        const tx = f.displayX - Math.cos(auth.dodgeAngle) * i * 17;
        const ty = f.displayY - Math.sin(auth.dodgeAngle) * i * 17;
        ctx.save();
        ctx.globalAlpha = 0.05 + (3 - i) * 0.035;
        ctx.translate(tx, ty);
        ctx.rotate(auth.dodgeAngle + Math.PI / 2);
        ellipse(ctx, 0, 4 * s, 17 * s, 21 * s, 0);
        ctx.fillStyle = style.accent;
        ctx.fill();
        ctx.restore();
      }
    }

    ctx.save();
    ctx.translate(f.displayX, f.displayY);

    // Ground shadow.
    ctx.fillStyle = 'rgba(4,6,4,0.34)';
    ellipse(ctx, 0, 10 * s, 25 * s, 10 * s, 0);
    ctx.fill();

    if (f.isLocal) {
      ctx.strokeStyle = 'rgba(233,197,124,0.30)';
      ctx.lineWidth = 1.3;
      ctx.setLineDash([5, 7]);
      ctx.beginPath();
      ctx.ellipse(0, 11 * s, 31 * s, 14 * s, 0, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (invulnerable) {
      const pulse = 0.5 + Math.sin(this.time * 22) * 0.2;
      ctx.strokeStyle = `rgba(226,243,250,${pulse * 0.55})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 32 * s, 0, TAU);
      ctx.stroke();
    }

    ctx.rotate(facing + Math.PI / 2);
    ctx.translate(0, bob);

    const lean = dashing ? -4 : hurt ? 3 : 0;
    ctx.translate(0, lean);

    // Feet, alternating while walking.
    const step = moving ? Math.sin(walk) * 5 : 0;
    ctx.fillStyle = style.wood;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.8;
    for (const [side, offset] of [[-1, step], [1, -step]]) {
      ellipse(ctx, side * 8.5 * s, 17 * s + offset * 0.4, 5.2 * s, 7.5 * s, side * 0.2);
      ctx.fill();
      ctx.stroke();
    }

    // Cloak / back.
    const cloak = ctx.createLinearGradient(0, -18 * s, 0, 22 * s);
    cloak.addColorStop(0, style.cloth);
    cloak.addColorStop(1, '#232318');
    ctx.fillStyle = cloak;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.3;
    ctx.beginPath();
    ctx.moveTo(-13 * s, -12 * s);
    ctx.quadraticCurveTo(-23 * s, 5 * s, -15 * s, 23 * s);
    ctx.quadraticCurveTo(0, 29 * s, 15 * s, 23 * s);
    ctx.quadraticCurveTo(23 * s, 5 * s, 13 * s, -12 * s);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 1.4;
    line(ctx, -5 * s, 6 * s, -9 * s, 21 * s);
    line(ctx, 5 * s, 6 * s, 9 * s, 21 * s);
    line(ctx, 0, 8 * s, 0, 24 * s);

    // Torso armor.
    const torso = ctx.createRadialGradient(-5 * s, -6 * s, 2, 0, 2 * s, 21 * s);
    torso.addColorStop(0, style.metal);
    torso.addColorStop(1, style.accent);
    ctx.fillStyle = torso;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.2;
    ellipse(ctx, 0, 3 * s, 14.5 * s, 17 * s, 0);
    ctx.fill();
    ctx.stroke();

    // Tabard stripe.
    ctx.fillStyle = style.cloth;
    ctx.beginPath();
    ctx.moveTo(-4 * s, -8 * s);
    ctx.lineTo(4 * s, -8 * s);
    ctx.lineTo(5.5 * s, 13 * s);
    ctx.lineTo(0, 17 * s);
    ctx.lineTo(-5.5 * s, 13 * s);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,16,10,0.4)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Badge on the chest.
    ctx.fillStyle = style.crest;
    ctx.beginPath();
    ctx.arc(0, 1 * s, 2.6 * s, 0, TAU);
    ctx.fill();

    // Belt.
    ctx.strokeStyle = 'rgba(36,26,15,0.8)';
    ctx.lineWidth = 4 * s;
    line(ctx, -12 * s, 12 * s, 12 * s, 12 * s);
    ctx.fillStyle = '#c9a45e';
    roundRect(ctx, -3 * s, 9.5 * s, 6 * s, 5 * s, 1.4 * s);
    ctx.fill();

    // Pauldrons.
    for (const side of [-1, 1]) {
      const pg = ctx.createLinearGradient(side * 10 * s, -12 * s, side * 18 * s, 2 * s);
      pg.addColorStop(0, style.metal);
      pg.addColorStop(1, style.accent);
      ctx.fillStyle = pg;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ellipse(ctx, side * 14 * s, -5 * s, 7.5 * s, 9.5 * s, side * 0.32);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(side * 14 * s, -5 * s, 5 * s, -2.4, 0.4);
      ctx.stroke();
    }

    // Head and helmet.
    this.drawHead(ctx, f.character, style, s, blocking, hurt);

    // Shield (Knight only) sits beside the body so it never hides the helm,
    // and swings up in front of the face while blocking.
    if (f.character === 'knight') {
      const shieldX = blocking ? 0 : -16 * s;
      const shieldY = blocking ? -22 * s : 2 * s;
      const shieldScale = blocking ? 1.3 : 0.92;
      this.drawShield(ctx, shieldX, shieldY, style, s * shieldScale, blocking);
    }
    if (f.character !== 'berserker' && f.character !== 'duelist') {
      ctx.strokeStyle = style.crest;
      ctx.lineWidth = 4 * s;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, -21 * s);
      ctx.quadraticCurveTo(2 * s, -8 * s, 0, 2 * s);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    if (f.character === 'duelist') {
      this.drawFeather(ctx, style, s);
    }

    // Shield (Knight only).
    if (f.character === 'knight') {
      const shieldX = blocking ? 0 : -13 * s;
      const shieldY = blocking ? -22 * s : -9 * s;
      const shieldScale = blocking ? 1.32 : 1;
      this.drawShield(ctx, shieldX, shieldY, style, s * shieldScale, blocking);
    }

    // Weapon.
    let swing = 0.34;
    if (attacking) {
      const p = clamp(progress, 0, 1);
      if (p < 0.2) swing = lerp(0.34, -1.18, easeInOutCubic(p / 0.2));
      else if (p < 0.64) swing = lerp(-1.18, 1.36, easeOutCubic((p - 0.2) / 0.44));
      else swing = lerp(1.36, 0.34, easeInOutCubic((p - 0.64) / 0.36));
    } else if (blocking) {
      swing = 0.12;
    } else if (hurt) {
      swing = 0.9;
    }
    this.drawWeapon(ctx, f.character, style, s, swing, blocking);

    if (hurt) {
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#e8574a';
      ellipse(ctx, 0, 0, 18 * s, 21 * s, 0);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  drawHead(ctx, character, style, s, blocking, hurt) {
    const hy = -22 * s;
    ctx.save();
    ctx.translate(0, hy);
    if (hurt) ctx.rotate(0.12);
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;

    if (character === 'knight') {
      const g = ctx.createLinearGradient(0, -9 * s, 0, 9 * s);
      g.addColorStop(0, '#d8e2e4');
      g.addColorStop(0.5, style.metal);
      g.addColorStop(1, '#6f7f86');
      ctx.fillStyle = g;
      roundRect(ctx, -8.5 * s, -8.5 * s, 17 * s, 17 * s, 5 * s);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(20,24,24,0.82)';
      roundRect(ctx, -6.5 * s, -5.6 * s, 13 * s, 2.6 * s, 1.3 * s);
      ctx.fill();
      ctx.fillStyle = style.crest;
      ctx.fillRect(-1.1 * s, -8.5 * s, 2.2 * s, 5 * s);
      ctx.fillRect(-1.1 * s, 2.4 * s, 2.2 * s, 4.2 * s);
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1;
      line(ctx, -5.5 * s, -7 * s, 5.5 * s, -7 * s);
    } else if (character === 'berserker') {
      // Horns.
      ctx.fillStyle = '#d7c7a4';
      ctx.strokeStyle = 'rgba(40,30,18,0.5)';
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * 6 * s, -5 * s);
        ctx.quadraticCurveTo(side * 17 * s, -13 * s, side * 14 * s, -18 * s);
        ctx.quadraticCurveTo(side * 15 * s, -9 * s, side * 10 * s, -2 * s);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      const g = ctx.createRadialGradient(-2 * s, -3 * s, 1, 0, 0, 10 * s);
      g.addColorStop(0, '#e0b98f');
      g.addColorStop(1, '#a97c55');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 8.8 * s, 0, TAU);
      ctx.fill();
      ctx.stroke();
      // Wild hair and beard.
      ctx.fillStyle = '#8a532f';
      for (let i = 0; i < 7; i += 1) {
        const a = -2.9 + (i / 6) * 2.3;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * 7 * s, Math.sin(a) * 7 * s + 1 * s, 3.4 * s, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = '#6f3f24';
      ctx.beginPath();
      ctx.ellipse(0, 6 * s, 5.4 * s, 3.6 * s, 0, 0, TAU);
      ctx.fill();
      // Angry eyes.
      ctx.strokeStyle = '#2a1a10';
      ctx.lineWidth = 1.6;
      line(ctx, -5 * s, -2.4 * s, -1.8 * s, -1.2 * s);
      line(ctx, 5 * s, -2.4 * s, 1.8 * s, -1.2 * s);
      ctx.fillStyle = '#241609';
      ctx.beginPath();
      ctx.arc(-3.3 * s, -0.8 * s, 1.1 * s, 0, TAU);
      ctx.arc(3.3 * s, -0.8 * s, 1.1 * s, 0, TAU);
      ctx.fill();
    } else if (character === 'duelist') {
      ctx.fillStyle = '#d9b48b';
      ctx.beginPath();
      ctx.arc(0, 0, 8.2 * s, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#2e5140';
      ctx.beginPath();
      ctx.ellipse(-1.8 * s, -3.4 * s, 9 * s, 7 * s, -0.18, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#243c30';
      ctx.beginPath();
      ctx.ellipse(4.6 * s, -2.8 * s, 5 * s, 2.2 * s, 0.3, 0, TAU);
      ctx.fill();
      // Mask.
      ctx.fillStyle = '#3c5f4c';
      ctx.beginPath();
      ctx.moveTo(-6.4 * s, 2 * s);
      ctx.quadraticCurveTo(0, 8.6 * s, 6.4 * s, 2 * s);
      ctx.quadraticCurveTo(0, 5.4 * s, -6.4 * s, 2 * s);
      ctx.fill();
      ctx.fillStyle = '#20160e';
      ctx.beginPath();
      ctx.arc(-3 * s, -0.5 * s, 1.1 * s, 0, TAU);
      ctx.arc(3 * s, -0.5 * s, 1.1 * s, 0, TAU);
      ctx.fill();
      // Gold earring.
      ctx.strokeStyle = '#e0b869';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(7 * s, 2 * s, 1.8 * s, 0, TAU);
      ctx.stroke();
    } else {
      // Guardian: winged helm.
      ctx.fillStyle = '#8d7a4b';
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * 6 * s, -4 * s);
        ctx.quadraticCurveTo(side * 18 * s, -10 * s, side * 14 * s, -15 * s);
        ctx.quadraticCurveTo(side * 13 * s, -6 * s, side * 8 * s, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      const g = ctx.createLinearGradient(0, -9 * s, 0, 9 * s);
      g.addColorStop(0, '#f0dfb1');
      g.addColorStop(0.5, style.metal);
      g.addColorStop(1, '#8f7742');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-8 * s, -7 * s);
      ctx.quadraticCurveTo(0, -12 * s, 8 * s, -7 * s);
      ctx.lineTo(6.5 * s, 5 * s);
      ctx.quadraticCurveTo(0, 9 * s, -6.5 * s, 5 * s);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(24,22,14,0.82)';
      roundRect(ctx, -6 * s, -4.6 * s, 12 * s, 2.6 * s, 1.3 * s);
      ctx.fill();
      ctx.fillStyle = '#e4c477';
      ctx.fillRect(-1.2 * s, -9 * s, 2.4 * s, 4 * s);
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1;
      line(ctx, -4 * s, -7 * s, 4 * s, -7 * s);
    }

    if (blocking) {
      ctx.strokeStyle = `rgba(226,242,247,${0.25 + Math.sin(this.time * 10) * 0.08})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(0, 0, 12 * s, -2.6, 2.6);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawFeather(ctx, style, s) {
    ctx.save();
    ctx.translate(4 * s, -28 * s);
    ctx.rotate(0.5 + Math.sin(this.time * 3) * 0.04);
    ctx.fillStyle = style.accent2;
    ctx.strokeStyle = 'rgba(30,24,14,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(7 * s, -9 * s, 15 * s, -14 * s);
    ctx.quadraticCurveTo(8 * s, -3 * s, 2 * s, 2 * s);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  drawShield(ctx, x, y, style, scale, blocking) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.rotate(blocking ? 0 : 0.22);
    const g = ctx.createLinearGradient(0, -15, 0, 15);
    g.addColorStop(0, '#b7c9d0');
    g.addColorStop(0.5, '#7f969f');
    g.addColorStop(1, '#4c5f66');
    ctx.fillStyle = g;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(0, -17);
    ctx.quadraticCurveTo(10, -13, 10.5, -3);
    ctx.quadraticCurveTo(10, 7, 0, 15);
    ctx.quadraticCurveTo(-10, 7, -10.5, -3);
    ctx.quadraticCurveTo(-10, -13, 0, -17);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = style.crest;
    ctx.lineWidth = 1.8;
    line(ctx, 0, -13, 0, 10);
    line(ctx, -6, -6, 6, -6);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 7, -2.4, 0.2);
    ctx.stroke();
    ctx.restore();
  }

  drawWeapon(ctx, character, style, s, swing, blocking) {
    if (character === 'duelist') {
      this.drawSword(ctx, { x: 13 * s, y: -8 * s, len: 38 * s, width: 2.6 * s, angle: swing, style, s });
      this.drawSword(ctx, { x: -13 * s, y: -8 * s, len: 36 * s, width: 2.4 * s, angle: -swing * 0.82 + 0.5, style, s, flip: true });
      return;
    }
    if (character === 'berserker') {
      ctx.save();
      ctx.translate(14 * s, -7 * s);
      ctx.rotate(swing);
      // Shaft.
      ctx.strokeStyle = '#5a3a22';
      ctx.lineWidth = 4.4 * s;
      ctx.lineCap = 'round';
      line(ctx, 0, 12 * s, 0, -31 * s);
      ctx.strokeStyle = 'rgba(255,225,180,0.16)';
      ctx.lineWidth = 1.2 * s;
      line(ctx, -1 * s, 10 * s, -1 * s, -30 * s);
      // Axe head.
      const g = ctx.createLinearGradient(-10 * s, -38 * s, 16 * s, -18 * s);
      g.addColorStop(0, '#e3e9e6');
      g.addColorStop(0.5, '#a9b5b4');
      g.addColorStop(1, '#6d7a7b');
      ctx.fillStyle = g;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(0, -34 * s);
      ctx.quadraticCurveTo(17 * s, -37 * s, 19 * s, -27 * s);
      ctx.quadraticCurveTo(17 * s, -17 * s, 0, -20 * s);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // Back spike.
      ctx.beginPath();
      ctx.moveTo(0, -33 * s);
      ctx.lineTo(-8 * s, -30 * s);
      ctx.lineTo(0, -24 * s);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.42)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(2 * s, -32 * s);
      ctx.quadraticCurveTo(14 * s, -32 * s, 16 * s, -28 * s);
      ctx.stroke();
      // Hands.
      ctx.fillStyle = '#c69a6c';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(0, -3 * s, 3.4 * s, 0, TAU);
      ctx.arc(0, 6 * s, 3.4 * s, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      return;
    }

    const long = character === 'guardian';
    const len = (long ? 58 : 46) * s;
    const width = (long ? 3.4 : 2.8) * s;
    this.drawSword(ctx, { x: 13 * s, y: -8 * s, len, width, angle: swing, style, s });
  }

  drawSword(ctx, { x, y, len, width, angle, style, s, flip = false }) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    if (flip) ctx.scale(1, 1);
    // Grip.
    ctx.fillStyle = '#5a3a22';
    ctx.strokeStyle = 'rgba(20,15,9,0.6)';
    ctx.lineWidth = 1;
    roundRect(ctx, -1.6 * s, -2 * s, 3.2 * s, 11 * s, 1.2 * s);
    ctx.fill();
    ctx.stroke();
    // Pommel.
    ctx.fillStyle = style.crest;
    ctx.beginPath();
    ctx.arc(0, 9.6 * s, 2.3 * s, 0, TAU);
    ctx.fill();
    // Crossguard.
    ctx.fillStyle = style.crest;
    ctx.strokeStyle = 'rgba(25,18,10,0.65)';
    ctx.lineWidth = 1;
    roundRect(ctx, -7.5 * s, -5 * s, 15 * s, 3.2 * s, 1.4 * s);
    ctx.fill();
    ctx.stroke();
    // Blade.
    const g = ctx.createLinearGradient(-width, 0, width, 0);
    g.addColorStop(0, '#8f9fa6');
    g.addColorStop(0.42, '#eef4f3');
    g.addColorStop(0.62, '#c6d2d3');
    g.addColorStop(1, '#7c8c93');
    ctx.fillStyle = g;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.35;
    ctx.beginPath();
    ctx.moveTo(-width, -5 * s);
    ctx.lineTo(-width * 0.72, -len + 7 * s);
    ctx.lineTo(0, -len);
    ctx.lineTo(width * 0.72, -len + 7 * s);
    ctx.lineTo(width, -5 * s);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 0.9;
    line(ctx, 0, -8 * s, 0, -len + 6 * s);
    ctx.restore();
  }

  // ---------------------------------------------------------------- screen HUD

  heroHeadPosition(f) {
    return { x: f.displayX, y: f.displayY - 44 };
  }

  drawOverheadBars(views, camera) {
    const ctx = this.ctx;
    for (const f of views) {
      const p = camera.worldToScreen(f.displayX, f.displayY - 50);
      if (p.x < -80 || p.x > this.width + 80 || p.y < 0 || p.y > this.height + 40) continue;
      const width = 76;
      const height = 5;
      const x = p.x - width / 2;
      const y = p.y;
      const pct = clamp((f.health ?? 0) / (f.maxHealth || 100), 0, 1);
      ctx.save();
      ctx.globalAlpha = f.connected === false ? 0.35 : 1;
      ctx.fillStyle = 'rgba(5,8,5,0.7)';
      roundRect(ctx, x - 2, y - 2, width + 4, height + 4, 3);
      ctx.fill();
      ctx.strokeStyle = f.isLocal ? 'rgba(217,172,91,0.7)' : 'rgba(190,92,76,0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
      const color = pct > 0.55 ? '#7fa36b' : pct > 0.25 ? '#d2a45f' : '#c15145';
      ctx.fillStyle = color;
      roundRect(ctx, x, y, width * pct, height, 2);
      ctx.fill();
      ctx.font = '600 10px Cinzel, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = f.isLocal ? 'rgba(247,231,199,0.92)' : 'rgba(238,206,197,0.9)';
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = 4;
      const name = f.isLocal ? `${this.names[f.slot] || 'You'} · YOU` : (this.names[f.slot] || 'Rival');
      ctx.fillText(name, p.x, y - 4);
      ctx.restore();
    }
  }

  drawOffscreenIndicator(views, camera) {
    const opponent = views.find((v) => !v.isLocal);
    if (!opponent || opponent.health <= 0) return;
    const point = camera.worldToScreen(opponent.displayX, opponent.displayY);
    const insets = camera.safeInsets();
    const minX = insets.left;
    const maxX = this.width - insets.right;
    const minY = insets.top;
    const maxY = this.height - insets.bottom;
    if (point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY) return;

    const cx = this.width / 2;
    const cy = this.height / 2;
    let dx = point.x - cx;
    let dy = point.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    let t = Infinity;
    if (dx > 0) t = Math.min(t, (maxX - cx) / dx);
    if (dx < 0) t = Math.min(t, (minX - cx) / dx);
    if (dy > 0) t = Math.min(t, (maxY - cy) / dy);
    if (dy < 0) t = Math.min(t, (minY - cy) / dy);
    if (!Number.isFinite(t) || t < 0) return;
    const x = cx + dx * t;
    const y = cy + dy * t;
    const angle = Math.atan2(dy, dx);
    const pulse = 0.5 + Math.sin(this.time * 4.5) * 0.5;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(10,13,9,0.82)';
    ctx.strokeStyle = `rgba(214,123,102,${0.55 + pulse * 0.3})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(0, 0, 20, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.rotate(angle);
    ctx.fillStyle = 'rgba(232,153,131,0.92)';
    ctx.beginPath();
    ctx.moveTo(15, 0);
    ctx.lineTo(3, -6);
    ctx.lineTo(3, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // Tiny sword sigil.
    ctx.strokeStyle = 'rgba(245,218,178,0.7)';
    ctx.lineWidth = 1.2;
    line(ctx, -2, -5, -2, 4);
    line(ctx, -5, -1, 1, -1);
    ctx.restore();

    ctx.save();
    ctx.font = '700 8px Nunito, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(232,206,188,0.6)';
    ctx.fillText((this.names[opponent.slot] || 'RIVAL').toUpperCase(), x, y + 36);
    ctx.restore();
  }

  drawFloaters(camera) {
    const ctx = this.ctx;
    for (const f of this.floaters) {
      const p = camera.worldToScreen(f.x, f.y);
      const alpha = clamp(f.life / f.max, 0, 1);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = `800 ${f.size}px Nunito, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(12,10,7,0.8)';
      ctx.strokeText(f.text, p.x, p.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, p.x, p.y);
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------- portraits

  paintPortrait(canvas, key) {
    const rect = canvas.getBoundingClientRect();
    const fallback = Number(canvas.getAttribute('width')) || 64;
    const size = Math.max(24, Math.round(rect.width || fallback));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.round(size * dpr);
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    this.drawBust(ctx, key, size);
  }

  drawBust(ctx, key, size) {
    const style = charStyle(key);
    const u = size / 100;
    ctx.save();
    ctx.scale(u, u);

    ctx.save();
    ctx.beginPath();
    ctx.arc(50, 50, 49, 0, TAU);
    ctx.clip();

    const bg = ctx.createRadialGradient(50, 36, 4, 50, 52, 64);
    bg.addColorStop(0, '#3b4635');
    bg.addColorStop(0.55, '#232b20');
    bg.addColorStop(1, '#0d110c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 100, 100);

    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = style.accent;
    ctx.lineWidth = 0.6;
    for (let i = 0; i < 18; i += 1) {
      const a = (i / 18) * TAU;
      line(ctx, 50 + Math.cos(a) * 40, 50 + Math.sin(a) * 40, 50 + Math.cos(a) * 74, 50 + Math.sin(a) * 74);
    }
    ctx.globalAlpha = 1;

    // Shoulders.
    const cloak = ctx.createLinearGradient(50, 60, 50, 100);
    cloak.addColorStop(0, style.cloth);
    cloak.addColorStop(1, '#181a12');
    ctx.fillStyle = cloak;
    ctx.strokeStyle = 'rgba(20,16,10,0.85)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(17, 102);
    ctx.quadraticCurveTo(20, 74, 37, 68);
    ctx.lineTo(63, 68);
    ctx.quadraticCurveTo(80, 74, 83, 102);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Pauldrons.
    for (const side of [-1, 1]) {
      const pg = ctx.createLinearGradient(50 + side * 12, 62, 50 + side * 28, 82);
      pg.addColorStop(0, style.metal);
      pg.addColorStop(1, style.accent);
      ctx.fillStyle = pg;
      ctx.strokeStyle = 'rgba(25,20,12,0.8)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(50 + side * 22, 77, 15, 11, side * 0.24, 0, TAU);
      ctx.fill();
      ctx.stroke();
    }

    // Neck.
    ctx.fillStyle = '#b7855f';
    ctx.strokeStyle = 'rgba(35,24,14,0.5)';
    ctx.lineWidth = 1;
    roundRect(ctx, 44, 56, 12, 14, 4);
    ctx.fill();
    ctx.stroke();

    const cx = 50;
    const cy = 44;
    if (key === 'knight') {
      ctx.fillStyle = '#d9b48c';
      ctx.beginPath();
      ctx.arc(cx, cy, 16, 0, TAU);
      ctx.fill();
      // Great helm.
      const g = ctx.createLinearGradient(cx - 16, cy - 18, cx + 14, cy + 16);
      g.addColorStop(0, '#dfe8ea');
      g.addColorStop(0.5, '#aebfc5');
      g.addColorStop(1, '#6f828b');
      ctx.fillStyle = g;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(cx - 17, cy - 3);
      ctx.quadraticCurveTo(cx - 18, cy - 20, cx, cy - 21);
      ctx.quadraticCurveTo(cx + 18, cy - 20, cx + 17, cy - 3);
      ctx.lineTo(cx + 14, cy + 15);
      ctx.quadraticCurveTo(cx, cy + 20, cx - 14, cy + 15);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // Visor slit and breath holes.
      ctx.fillStyle = 'rgba(18,22,22,0.9)';
      roundRect(ctx, cx - 13, cy - 4, 26, 4.5, 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(217,172,91,0.9)';
      ctx.fillRect(cx - 1.4, cy - 20, 2.8, 15);
      ctx.fillStyle = 'rgba(18,22,22,0.65)';
      for (let i = -2; i <= 2; i += 1) {
        ctx.beginPath();
        ctx.arc(cx + i * 4, cy + 9, 1, 0, TAU);
        ctx.fill();
      }
      // Raising a sword beside the helm.
      ctx.save();
      ctx.translate(79, 76);
      ctx.rotate(0.35);
      ctx.fillStyle = '#c6d2d4';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.2;
      roundRect(ctx, -2, -34, 4, 40, 1);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#d9ac5b';
      roundRect(ctx, -7, -1, 14, 3, 1);
      ctx.fill();
      ctx.restore();
    } else if (key === 'berserker') {
      // Horns behind.
      ctx.fillStyle = '#d8c8a3';
      ctx.strokeStyle = 'rgba(40,28,16,0.6)';
      ctx.lineWidth = 1.2;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + side * 12, cy - 11);
        ctx.quadraticCurveTo(cx + side * 32, cy - 28, cx + side * 27, cy - 40);
        ctx.quadraticCurveTo(cx + side * 30, cy - 18, cx + side * 19, cy - 4);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      // Hair.
      ctx.fillStyle = '#7e4828';
      for (let i = 0; i < 12; i += 1) {
        const a = -3.05 + (i / 11) * 3.2;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * 15, cy + Math.sin(a) * 13, 7, 0, TAU);
        ctx.fill();
      }
      const g = ctx.createRadialGradient(cx - 5, cy - 5, 2, cx, cy, 18);
      g.addColorStop(0, '#e7c098');
      g.addColorStop(1, '#b07f56');
      ctx.fillStyle = g;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(cx, cy, 16, 0, TAU);
      ctx.fill();
      ctx.stroke();
      // Beard.
      ctx.fillStyle = '#6d3e22';
      ctx.beginPath();
      ctx.moveTo(cx - 14, cy + 5);
      ctx.quadraticCurveTo(cx - 12, cy + 28, cx, cy + 31);
      ctx.quadraticCurveTo(cx + 12, cy + 28, cx + 14, cy + 5);
      ctx.quadraticCurveTo(cx, cy + 16, cx - 14, cy + 5);
      ctx.fill();
      ctx.strokeStyle = 'rgba(45,26,13,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // Angry brow and eyes.
      ctx.strokeStyle = '#3a2111';
      ctx.lineWidth = 2.2;
      line(ctx, cx - 11, cy - 5, cx - 3, cy - 2);
      line(ctx, cx + 11, cy - 5, cx + 3, cy - 2);
      ctx.fillStyle = '#241307';
      ctx.beginPath();
      ctx.arc(cx - 6, cy + 1, 2, 0, TAU);
      ctx.arc(cx + 6, cy + 1, 2, 0, TAU);
      ctx.fill();
      // Scar.
      ctx.strokeStyle = 'rgba(130,52,38,0.75)';
      ctx.lineWidth = 1.2;
      line(ctx, cx + 7, cy - 12, cx + 12, cy + 2);
      // Nose.
      ctx.strokeStyle = 'rgba(90,52,28,0.8)';
      ctx.lineWidth = 1.4;
      line(ctx, cx, cy + 1, cx - 2, cy + 7);
    } else if (key === 'duelist') {
      ctx.fillStyle = '#2f5442';
      for (let i = 0; i < 9; i += 1) {
        const a = -3.05 + (i / 8) * 3.1;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * 13, cy + Math.sin(a) * 12, 7, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = '#d9b48b';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(cx, cy, 16, 0, TAU);
      ctx.fill();
      ctx.stroke();
      // Masked lower face.
      ctx.fillStyle = '#2c4c3c';
      ctx.beginPath();
      ctx.moveTo(cx - 15, cy + 3);
      ctx.quadraticCurveTo(cx, cy + 24, cx + 15, cy + 3);
      ctx.quadraticCurveTo(cx, cy + 12, cx - 15, cy + 3);
      ctx.fill();
      ctx.strokeStyle = 'rgba(18,28,22,0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // Eyes.
      ctx.fillStyle = '#1c140c';
      ctx.beginPath();
      ctx.arc(cx - 6, cy - 3, 2.2, 0, TAU);
      ctx.arc(cx + 6, cy - 3, 2.2, 0, TAU);
      ctx.fill();
      // Cap.
      ctx.fillStyle = '#345a46';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(cx - 2, cy - 13, 18, 10, -0.16, 0, TAU);
      ctx.fill();
      ctx.stroke();
      // Feather.
      ctx.save();
      ctx.translate(cx + 10, cy - 21);
      ctx.rotate(0.6);
      ctx.fillStyle = '#e3d9a8';
      ctx.strokeStyle = 'rgba(30,30,18,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(10, -14, 24, -18);
      ctx.quadraticCurveTo(12, -4, 3, 4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      // Earring.
      ctx.strokeStyle = '#e6c16f';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(cx + 15, cy + 7, 3, 0, TAU);
      ctx.stroke();
    } else {
      // Guardian.
      ctx.fillStyle = '#a78c53';
      ctx.strokeStyle = 'rgba(30,24,13,0.7)';
      ctx.lineWidth = 1.2;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + side * 12, cy - 8);
        ctx.quadraticCurveTo(cx + side * 35, cy - 18, cx + side * 29, cy - 34);
        ctx.quadraticCurveTo(cx + side * 26, cy - 10, cx + side * 18, cy + 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      const g = ctx.createLinearGradient(cx - 16, cy - 18, cx + 16, cy + 18);
      g.addColorStop(0, '#f1e1b4');
      g.addColorStop(0.5, '#c8ab6f');
      g.addColorStop(1, '#8d7442');
      ctx.fillStyle = g;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(cx - 16, cy - 6);
      ctx.quadraticCurveTo(cx - 18, cy - 23, cx, cy - 24);
      ctx.quadraticCurveTo(cx + 18, cy - 23, cx + 16, cy - 6);
      ctx.lineTo(cx + 13, cy + 14);
      ctx.quadraticCurveTo(cx, cy + 20, cx - 13, cy + 14);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(20,20,13,0.86)';
      roundRect(ctx, cx - 13, cy - 6, 26, 5, 2.4);
      ctx.fill();
      ctx.fillStyle = '#e4c477';
      ctx.fillRect(cx - 1.6, cy - 24, 3.2, 16);
      // Face hint behind slit.
      ctx.fillStyle = 'rgba(217,180,139,0.4)';
      roundRect(ctx, cx - 9, cy - 3, 18, 1.6, 1);
      ctx.fill();
    }

    // Foreground rim.
    ctx.strokeStyle = 'rgba(217,172,91,0.28)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(50, 50, 48, 0, TAU);
    ctx.stroke();
    ctx.restore();

    // Outer frame.
    ctx.strokeStyle = 'rgba(217,172,91,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(50, 50, 48.6, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  paintCharacterArt(canvas, key) {
    const rect = canvas.getBoundingClientRect();
    const fallbackW = Number(canvas.getAttribute('width')) || 280;
    const fallbackH = Number(canvas.getAttribute('height')) || 132;
    const w = Math.max(80, Math.round(rect.width || fallbackW));
    const h = Math.max(60, Math.round(rect.height || fallbackH));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.round(w * dpr);
    const py = Math.round(h * dpr);
    if (canvas.width !== px || canvas.height !== py) {
      canvas.width = px;
      canvas.height = py;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const style = charStyle(key);
    const bg = ctx.createRadialGradient(w / 2, h * 0.62, 4, w / 2, h * 0.6, Math.max(w, h) * 0.75);
    bg.addColorStop(0, 'rgba(92,104,76,0.34)');
    bg.addColorStop(0.6, 'rgba(30,37,26,0.2)');
    bg.addColorStop(1, 'rgba(10,13,9,0.35)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Halo rays.
    ctx.save();
    ctx.translate(w / 2, h * 0.58);
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = style.accent;
    ctx.lineWidth = 1;
    for (let i = 0; i < 16; i += 1) {
      const a = (i / 16) * TAU;
      line(ctx, Math.cos(a) * 20, Math.sin(a) * 20, Math.cos(a) * 82, Math.sin(a) * 82);
    }
    ctx.restore();

    // Floor line.
    ctx.strokeStyle = 'rgba(217,172,91,0.14)';
    ctx.lineWidth = 1;
    line(ctx, 18, h * 0.9, w - 18, h * 0.9);

    const scale = Math.min(1.75, h / 88) * (style.scale || 1);
    ctx.save();
    ctx.translate(w / 2, h * 0.52);
    ctx.scale(scale, scale);
    this.drawFighter(ctx, {
      slot: 2,
      isLocal: false,
      character: key,
      displayX: 0,
      displayY: 0,
      displayFacing: -Math.PI / 2,
      health: 100,
      maxHealth: 100,
      attacking: false,
      attackProgress: 0,
      attackAngle: 0,
      blocking: false,
      dashing: false,
      dodgeAngle: 0,
      dodgeProgress: 0,
      hurt: false,
      invulnerable: false,
    }, performance.now());
    ctx.restore();

    ctx.globalAlpha = 0.9;
    ctx.fillStyle = 'rgba(217,172,91,0.5)';
    ctx.font = '600 8px Cinzel, serif';
    ctx.textAlign = 'center';
    ctx.fillText(style.title, w / 2, h - 10);
    ctx.globalAlpha = 1;
  }
}
