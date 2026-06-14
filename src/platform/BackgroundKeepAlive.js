/**
 * @fileoverview Keeps a backgrounded tab's timers running at full rate.
 *
 * Chrome (and other Chromium browsers) clamp `setInterval`/`setTimeout` in
 * hidden tabs to >= 1 Hz and pause `requestAnimationFrame` entirely. Our 60 Hz
 * tick loop (`InputBufferManager`, driven by `setInterval`) therefore starves
 * when a tab is backgrounded: remote strokes still ARRIVE and get applied to the
 * model promptly (the WS queue drains via microtasks), but they're rasterized in
 * coarse batches on the ~1 Hz tick instead of incrementally per 16 ms tick.
 * Soft/stamped strokes (soft brush, pen stamps, confetti, flood fill) build up
 * opacity/spacing differently under batch vs incremental rasterization, so two
 * users whose tabs spent different time backgrounded end up with visibly
 * different pixels even though their stroke logs are identical.
 *
 * A tab that is "playing audio" is exempt from this throttling. Holding a
 * running AudioContext with an effectively-silent (inaudible, tiny non-zero
 * gain) oscillator routed to the destination keeps the tab in that exempt state,
 * so the tick loop keeps firing at full rate in the background and the render
 * cadence — and therefore the pixels — stays consistent across users.
 *
 * Tradeoff: a hidden tab keeps doing real work (battery/CPU) and the browser may
 * show a faint "audio playing" tab indicator. That's the deliberate cost.
 */
export class BackgroundKeepAlive {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.osc = null;
    this.gain = null;
    this.started = false;
    this._onVisibility = null;
    this._gestureResume = null;
  }

  /**
   * Begin keeping the tab alive. Safe to call repeatedly. The AudioContext may
   * start `suspended` under the autoplay policy; it resumes on the next user
   * gesture or on the next time the tab becomes visible.
   */
  start() {
    if (this.started) return;
    const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return;

    try {
      this.ctx = new AC();
      this.osc = this.ctx.createOscillator();
      this.gain = this.ctx.createGain();
      // Tiny but non-zero so the browser counts the tab as producing audio
      // (gain of exactly 0 can be treated as silent and skip the exemption),
      // yet far below the threshold of human hearing — and 25 Hz is sub-bass.
      this.gain.gain.value = 0.0001;
      this.osc.frequency.value = 25;
      this.osc.type = 'sine';
      this.osc.connect(this.gain);
      this.gain.connect(this.ctx.destination);
      this.osc.start();
      this.started = true;
    } catch (err) {
      console.warn('[KeepAlive] Failed to start AudioContext keepalive:', err);
      this.ctx = null;
      return;
    }

    this._resume();

    // The context parks itself in `suspended` until a user gesture; resume it
    // on the first gesture and whenever the tab is brought back to the front.
    this._onVisibility = () => { if (!document.hidden) this._resume(); };
    document.addEventListener('visibilitychange', this._onVisibility);

    this._gestureResume = () => this._resume();
    window.addEventListener('pointerdown', this._gestureResume, { passive: true });
    window.addEventListener('keydown', this._gestureResume, { passive: true });
  }

  _resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  /** Returns the AudioContext state ('running' | 'suspended' | 'closed' | null). */
  get state() {
    return this.ctx ? this.ctx.state : null;
  }

  /** Tear everything down (e.g. on going fully offline). */
  stop() {
    if (this._onVisibility) document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._gestureResume) {
      window.removeEventListener('pointerdown', this._gestureResume);
      window.removeEventListener('keydown', this._gestureResume);
    }
    this._onVisibility = null;
    this._gestureResume = null;
    try { this.osc?.stop(); } catch { /* already stopped */ }
    try { this.ctx?.close(); } catch { /* already closed */ }
    this.osc = null;
    this.gain = null;
    this.ctx = null;
    this.started = false;
  }
}
