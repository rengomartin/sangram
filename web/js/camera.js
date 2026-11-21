import { clamp } from './data.js';

export class Camera {
  constructor() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.arena = { width: 1800, height: 1100 };
    this.x = 900;
    this.y = 550;
    this.scale = 1;
    this.targetScale = 1;
    this.initialized = false;
  }

  resize(width, height) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.recalculateScale();
    this.clampToArena();
  }

  setArena(width, height) {
    if (!width || !height) return;
    this.arena.width = width;
    this.arena.height = height;
    this.clampToArena();
  }

  recalculateScale() {
    // The arena deliberately remains larger than the viewport so flanking and
    // off-screen awareness matter. Portrait screens get a tighter, readable view.
    const targetW = 840;
    const targetH = 600;
    this.targetScale = clamp(Math.max(this.width / targetW, this.height / targetH), 0.62, 2.2);
    if (!this.initialized) this.scale = this.targetScale;
  }

  snapTo(x, y) {
    this.x = x;
    this.y = y;
    this.initialized = true;
    this.clampToArena();
  }

  update(dt, playerX, playerY, moveX = 0, moveY = 0) {
    if (!this.initialized) {
      this.snapTo(playerX, playerY - 16);
      return;
    }
    // A gentle look-ahead and a slightly high camera centre keep the fighter
    // clear of the top HUD without making the view swim.
    const lookX = moveX * 24;
    const lookY = moveY * 16;
    const targetX = playerX + lookX;
    const targetY = playerY + lookY - 18;
    const smoothing = 1 - Math.exp(-7.5 * Math.min(dt, 0.1));
    this.x += (targetX - this.x) * smoothing;
    this.y += (targetY - this.y) * smoothing;
    this.scale += (this.targetScale - this.scale) * (1 - Math.exp(-8 * Math.min(dt, 0.1)));
    this.clampToArena();
  }

  clampToArena() {
    const halfW = this.width / (2 * this.scale);
    const halfH = this.height / (2 * this.scale);
    if (this.arena.width <= halfW * 2) {
      this.x = this.arena.width / 2;
    } else {
      this.x = clamp(this.x, halfW, this.arena.width - halfW);
    }
    if (this.arena.height <= halfH * 2) {
      this.y = this.arena.height / 2;
    } else {
      this.y = clamp(this.y, halfH, this.arena.height - halfH);
    }
  }

  worldToScreen(x, y) {
    return {
      x: (x - this.x) * this.scale + this.width / 2,
      y: (y - this.y) * this.scale + this.height / 2,
    };
  }

  safeInsets() {
    const touch = document.body.classList.contains('touch-device');
    return {
      left: 18,
      right: 18,
      top: touch ? 66 : 94,
      bottom: touch ? 150 : 60,
    };
  }
}
