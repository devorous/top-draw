/**
 * @fileoverview Recording controller — owns the timeline (record) button state,
 * the local tape recorder start/stop/toggle flow, and the elapsed-time ticker.
 * Extracted from App.js.
 */

import { TimeMachine } from '../timebar/TimeMachine.svelte.js';

export class RecordingController {
  constructor(app) {
    this.app = app;
    this._tapeRecElapsedInterval = null;
  }

  get ui() { return this.app.ui; }
  get recorder() { return this.app.recorder; }

  updateRecordingButtonState() {
    const btn = this.ui?.elements?.recordBtn;
    if (!btn) return;

    const connectedToRoom = !!this.app.currentRoomId && !this.app.isOfflineMode;
    const waitingForSync = connectedToRoom && !!this.app.syncClient && !this.app.syncClient.hasCompletedSync;

    btn.classList.toggle('is-recording', TimeMachine.isStarted);
    btn.classList.toggle('disabled', waitingForSync);
    btn.setAttribute('aria-disabled', waitingForSync ? 'true' : 'false');

    if (TimeMachine.isStarted) {
      btn.title = 'Timeline active (click to close)';
      btn.setAttribute('aria-label', 'Close timeline');
    } else if (waitingForSync) {
      btn.title = 'Timeline becomes available after room sync completes';
      btn.setAttribute('aria-label', 'Timeline unavailable until sync completes');
    } else {
      btn.title = 'Open Timeline';
      btn.setAttribute('aria-label', 'Open timeline');
    }
  }

  /**
   * Begin a local tape recording. Returns true on success. The recorder mini
   * viewer (RecorderPanel.svelte) drives this.
   */
  startTapeRecording() {
    const rec = this.recorder;
    if (!rec || rec.isRecording()) return false;

    if (!this.app.currentRoomId) {
      this.ui?.showToast('Join a room before recording', 2000);
      return false;
    }

    try {
      rec.start(this.app);
      this._setTapeRecButtonRecording(true);
      this._startTapeRecElapsedTick();
      this.ui?.showToast('Recording…', 1500);
      return true;
    } catch (err) {
      console.error('[App] tape recorder start failed:', err);
      this.ui?.showToast('Could not start recording', 2500);
      return false;
    }
  }

  /**
   * Stop the local tape recording and return the captured bundle (or null).
   * Unlike the old toggle, this does NOT auto-open the full-board replay — the
   * recorder mini viewer presents the result and offers a fullscreen handoff.
   * @returns {import('../replay/Recorder.js').ReplayRecording | null}
   */
  stopTapeRecording() {
    const rec = this.recorder;
    if (!rec || !rec.isRecording()) return null;
    const bundle = rec.stop();
    this._stopTapeRecElapsedTick();
    this._setTapeRecButtonRecording(false);
    return bundle;
  }

  /**
   * Toggle the local tape recorder. Kept for backwards compatibility; the
   * stop path now opens the full-board replay directly.
   */
  async handleToggleTapeRecording() {
    const rec = this.recorder;
    if (!rec) return;

    if (rec.isRecording()) {
      const bundle = this.stopTapeRecording();
      if (bundle && bundle.deltas.length > 0) {
        this.ui?.showToast(`Loading replay... ${bundle.deltas.length} actions`, 60_000);
        try {
          await TimeMachine.loadFromRecording(bundle);
        } catch (err) {
          console.error('[App] failed to open local replay:', err);
          this.ui?.showToast('Could not load replay', 3000, 'error');
        }
      } else {
        this.ui?.showToast('Recording stopped (no actions captured)', 2000);
      }
      return;
    }

    this.startTapeRecording();
  }

  _setTapeRecButtonRecording(isOn) {
    const btn = this.ui?.elements?.tapeRecBtn;
    if (!btn) return;
    btn.classList.toggle('is-recording', !!isOn);
    btn.title = isOn ? 'Stop recording (opens scrubber)' : 'Record session — captures everything locally for scrubbing';
    const elapsed = this.ui?.elements?.tapeRecElapsed;
    if (elapsed) {
      elapsed.style.display = isOn ? '' : 'none';
      if (!isOn) elapsed.textContent = '0:00';
    }
  }

  _startTapeRecElapsedTick() {
    this._stopTapeRecElapsedTick();
    const elapsedEl = this.ui?.elements?.tapeRecElapsed;
    if (!elapsedEl) return;
    const tick = () => {
      if (!this.recorder?.isRecording()) return;
      const s = Math.floor(this.recorder.elapsedMs() / 1000);
      const mm = Math.floor(s / 60);
      const ss = String(s % 60).padStart(2, '0');
      elapsedEl.textContent = `${mm}:${ss}`;
    };
    tick();
    this._tapeRecElapsedInterval = setInterval(tick, 1000);
  }

  _stopTapeRecElapsedTick() {
    if (this._tapeRecElapsedInterval) {
      clearInterval(this._tapeRecElapsedInterval);
      this._tapeRecElapsedInterval = null;
    }
  }

  handleStartRecording() {
    if (TimeMachine.isStarted) {
      TimeMachine.stop();
      this.updateRecordingButtonState();
      this.ui.showToast('Timeline closed', 2000);
      return;
    }

    const connectedToRoom = !!this.app.currentRoomId && !this.app.isOfflineMode;
    if (connectedToRoom && this.app.syncClient && !this.app.syncClient.hasCompletedSync) {
      this.ui.showToast('Please wait for sync to finish before opening the timeline', 2500);
      this.updateRecordingButtonState();
      return;
    }

    TimeMachine.start();
    this.updateRecordingButtonState();
    // start() shows its own toast when offline has nothing to replay; only show
    // the loading toast when a source is actually being loaded.
    if (TimeMachine.isLoading || TimeMachine.isStarted) {
      this.ui.showToast('Loading timeline…', 2000);
    }
  }
}
