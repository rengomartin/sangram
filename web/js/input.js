const MOVE_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight',
]);

export class InputManager {
  constructor({ onAction, onBlockChange, onMoveChange } = {}) {
    this.onAction = onAction || (() => {});
    this.onBlockChange = onBlockChange || (() => {});
    this.onMoveChange = onMoveChange || (() => {});
    this.enabled = false;
    this.keys = new Set();
    this.blockKey = false;
    this.blockTouch = false;
    this.joystick = { active: false, pointerId: null, x: 0, y: 0 };
    this.zone = document.getElementById('joystick-zone');
    this.knob = document.getElementById('joystick-knob');
    this.attachKeyboard();
    this.attachJoystick();
    this.attachTouchButtons();
  }

  setEnabled(enabled) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.reset();
  }

  reset() {
    this.keys.clear();
    this.blockKey = false;
    this.blockTouch = false;
    this.joystick.active = false;
    this.joystick.x = 0;
    this.joystick.y = 0;
    this.zone?.classList.remove('is-active');
    if (this.knob) this.knob.style.transform = 'translate(0px, 0px)';
    document.querySelectorAll('.touch-btn.is-active').forEach((btn) => btn.classList.remove('is-active'));
  }

  getMove() {
    let x = 0;
    let y = 0;
    if (this.joystick.active && Math.hypot(this.joystick.x, this.joystick.y) > 0.08) {
      x = this.joystick.x;
      y = this.joystick.y;
    } else {
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y -= 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y += 1;
    }
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    return { x, y };
  }

  getBlocking() {
    return this.blockKey || this.blockTouch;
  }

  attachKeyboard() {
    window.addEventListener('keydown', (event) => {
      if (!this.enabled || this.isTyping(event.target)) return;
      const code = event.code;
      if (MOVE_CODES.has(code)) {
        this.keys.add(code);
        event.preventDefault();
        this.onMoveChange();
        return;
      }
      if (code === 'Space') {
        event.preventDefault();
        if (!event.repeat) this.onAction('attack');
        return;
      }
      if (code === 'KeyE') {
        event.preventDefault();
        if (!event.repeat) this.onAction('dodge');
        return;
      }
      if (code === 'ShiftLeft' || code === 'ShiftRight') {
        event.preventDefault();
        if (!this.blockKey) {
          this.blockKey = true;
          this.onBlockChange(true);
        }
      }
    }, { passive: false });

    window.addEventListener('keyup', (event) => {
      if (!this.enabled) return;
      const code = event.code;
      if (MOVE_CODES.has(code)) {
        this.keys.delete(code);
        event.preventDefault();
        this.onMoveChange();
        return;
      }
      if (code === 'ShiftLeft' || code === 'ShiftRight') {
        event.preventDefault();
        if (this.blockKey) {
          this.blockKey = false;
          this.onBlockChange(false);
        }
      }
    }, { passive: false });

    window.addEventListener('blur', () => {
      if (this.enabled) {
        const wasBlocking = this.getBlocking();
        this.reset();
        if (wasBlocking) this.onBlockChange(false);
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.enabled) {
        const wasBlocking = this.getBlocking();
        this.reset();
        if (wasBlocking) this.onBlockChange(false);
      }
    });
  }

  isTyping(target) {
    if (!(target instanceof HTMLElement)) return false;
    return target.matches('input, textarea, select') || target.isContentEditable;
  }

  attachJoystick() {
    if (!this.zone || !this.knob) return;
    const ring = this.zone.querySelector('.joystick-ring');
    const update = (event) => {
      if (!this.joystick.active || event.pointerId !== this.joystick.pointerId) return;
      const rect = ring.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      let dx = event.clientX - centerX;
      let dy = event.clientY - centerY;
      const max = rect.width * 0.29;
      const length = Math.hypot(dx, dy);
      if (length > max) {
        dx = (dx / length) * max;
        dy = (dy / length) * max;
      }
      this.joystick.x = dx / max;
      this.joystick.y = dy / max;
      this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.onMoveChange();
    };
    const release = (event) => {
      if (!this.joystick.active || event.pointerId !== this.joystick.pointerId) return;
      this.joystick.active = false;
      this.joystick.pointerId = null;
      this.joystick.x = 0;
      this.joystick.y = 0;
      this.zone.classList.remove('is-active');
      this.knob.style.transform = 'translate(0px, 0px)';
      this.onMoveChange();
    };

    this.zone.addEventListener('pointerdown', (event) => {
      if (!this.enabled) return;
      event.preventDefault();
      this.joystick.active = true;
      this.joystick.pointerId = event.pointerId;
      this.zone.classList.add('is-active');
      try { this.zone.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      update(event);
    }, { passive: false });
    this.zone.addEventListener('pointermove', (event) => {
      if (!this.enabled) return;
      event.preventDefault();
      update(event);
    }, { passive: false });
    this.zone.addEventListener('pointerup', release);
    this.zone.addEventListener('pointercancel', release);
    this.zone.addEventListener('lostpointercapture', release);
  }

  attachTouchButtons() {
    document.querySelectorAll('[data-touch-action]').forEach((button) => {
      const action = button.dataset.touchAction;
      let active = false;
      const press = (event) => {
        if (!this.enabled || active) return;
        event.preventDefault();
        active = true;
        button.classList.add('is-active');
        try { button.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        if (action === 'block') {
          this.blockTouch = true;
          this.onBlockChange(true);
        } else if (action === 'attack') {
          this.onAction('attack');
        } else if (action === 'dodge') {
          this.onAction('dodge');
        }
      };
      const release = (event) => {
        if (!active) return;
        active = false;
        button.classList.remove('is-active');
        if (event && button.hasPointerCapture?.(event.pointerId)) {
          try { button.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
        }
        if (action === 'block' && this.blockTouch) {
          this.blockTouch = false;
          this.onBlockChange(false);
        }
      };
      button.addEventListener('pointerdown', press, { passive: false });
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
      button.addEventListener('lostpointercapture', release);
      button.addEventListener('contextmenu', (event) => event.preventDefault());
    });
  }
}
