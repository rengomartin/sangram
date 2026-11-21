export class SoundManager {
  constructor(muted = false) {
    this.muted = muted;
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.unlocked = false;
  }

  unlock() {
    if (this.unlocked) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      this.master.connect(this.ctx.destination);
      this.noiseBuffer = this.makeNoiseBuffer();
      this.unlocked = true;
      this.ctx.resume().catch(() => {});
    } catch {
      this.ctx = null;
    }
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.55, this.ctx.currentTime, 0.02);
    }
  }

  makeNoiseBuffer() {
    const length = this.ctx.sampleRate * 1.2;
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  ensure() {
    if (this.muted) return null;
    if (!this.ctx) this.unlock();
    if (!this.ctx) return null;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  tone({ freq = 440, type = 'sine', duration = 0.15, gain = 0.12, endFreq = null, delay = 0 }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(30, endFreq), t0 + duration);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(amp).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  noise({ duration = 0.15, gain = 0.1, freq = 800, q = 0.8, type = 'bandpass', slideTo = null, delay = 0 }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t0);
    if (slideTo) filter.frequency.exponentialRampToValueAtTime(Math.max(60, slideTo), t0 + duration);
    filter.Q.value = q;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter).connect(amp).connect(this.master);
    src.start(t0);
    src.stop(t0 + duration + 0.03);
  }

  ui() { this.tone({ freq: 620, type: 'sine', duration: 0.06, gain: 0.035 }); }
  toggle() { this.tone({ freq: 380, type: 'triangle', duration: 0.1, gain: 0.05, endFreq: 520 }); }
  join() {
    this.tone({ freq: 392, type: 'triangle', duration: 0.18, gain: 0.06 });
    this.tone({ freq: 587, type: 'triangle', duration: 0.22, gain: 0.05, delay: 0.08 });
  }
  ready() {
    this.tone({ freq: 330, type: 'triangle', duration: 0.16, gain: 0.05 });
    this.tone({ freq: 495, type: 'triangle', duration: 0.2, gain: 0.05, delay: 0.09 });
  }
  countdownTick(final = false) {
    if (final) {
      this.tone({ freq: 196, type: 'sawtooth', duration: 0.45, gain: 0.06, endFreq: 392 });
      this.noise({ duration: 0.32, gain: 0.06, freq: 500, slideTo: 1800, type: 'bandpass' });
      return;
    }
    this.tone({ freq: 440, type: 'sine', duration: 0.13, gain: 0.055, endFreq: 620 });
  }
  swing() {
    this.noise({ duration: 0.17, gain: 0.085, freq: 620, q: 0.7, slideTo: 1600 });
  }
  hit(local = false) {
    this.noise({ duration: 0.12, gain: local ? 0.15 : 0.11, freq: 260, q: 0.9, type: 'lowpass', slideTo: 120 });
    this.tone({ freq: local ? 92 : 110, type: 'sine', duration: 0.16, gain: local ? 0.16 : 0.11, endFreq: 52 });
    this.tone({ freq: 900, type: 'triangle', duration: 0.045, gain: 0.035, endFreq: 500 });
  }
  block() {
    this.tone({ freq: 1280, type: 'triangle', duration: 0.13, gain: 0.075, endFreq: 760 });
    this.tone({ freq: 2050, type: 'sine', duration: 0.08, gain: 0.05, endFreq: 1600 });
    this.noise({ duration: 0.08, gain: 0.055, freq: 3000, q: 2.2 });
  }
  dodge() {
    this.noise({ duration: 0.22, gain: 0.065, freq: 380, q: 0.5, slideTo: 1300 });
    this.tone({ freq: 180, type: 'sine', duration: 0.1, gain: 0.025, endFreq: 130 });
  }
  victory() {
    [392, 523.25, 659.25, 783.99].forEach((freq, i) => {
      this.tone({ freq, type: 'triangle', duration: 0.5, gain: 0.06, delay: i * 0.12 });
    });
  }
  defeat() {
    [293.66, 246.94, 196, 146.83].forEach((freq, i) => {
      this.tone({ freq, type: 'sine', duration: 0.55, gain: 0.055, delay: i * 0.15 });
    });
  }
  disconnect() {
    this.tone({ freq: 330, type: 'sine', duration: 0.25, gain: 0.04, endFreq: 220 });
  }
}
