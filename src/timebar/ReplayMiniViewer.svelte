<script>
  // Standalone mini replay viewer — the same embedded player used on the
  // History page (SnapshotMenu's rp-player), wrapped in its own modal so it can
  // be opened from the session recorder ("View" / "Stop recording"). Plays a
  // provided recording bundle into an in-panel canvas (TimeMachine embed mode).
  // The transport / speed / region / render / undo controls are the shared
  // ReplayControls component (same one as the full-board Timebar).
  import { onMount, onDestroy, tick } from 'svelte';
  import { TimeMachine } from './TimeMachine.svelte.js';
  import ReplayControls from './ReplayControls.svelte';

  /**
   * @type {{ bundle: import('../replay/Recorder.js').ReplayRecording|null, onClose?: () => void, title?: string }}
   */
  let { bundle = null, onClose = () => {}, title = 'Replay' } = $props();

  let embedCanvas = $state(null);
  let embedActive = $state(false);
  let embedStarting = false;
  let handoffToFull = false;

  let tmLoading = $derived(TimeMachine.isLoading);

  // ── Embedded player lifecycle ───────────────────────────────────────────────
  async function startEmbedded() {
    if (embedActive || embedStarting) return;
    if (!bundle || !bundle.deltas || bundle.deltas.length === 0) return;

    embedStarting = true;
    embedActive = true;
    resetRpView();
    try {
      await tick(); // ensure embedCanvas is bound in the DOM
      if (!embedCanvas) { embedActive = false; return; }
      TimeMachine.attachEmbedTarget(embedCanvas);
      await TimeMachine.loadFromRecording(bundle);
    } catch (err) {
      console.error('[ReplayMiniViewer] embedded replay failed:', err);
      embedActive = false;
      TimeMachine.detachEmbedTarget?.();
      window.app?.ui?.showToast?.('Could not load replay', 3000, 'error');
    } finally {
      embedStarting = false;
    }
  }

  function stopEmbedded() {
    resetRpView();
    if (handoffToFull) { embedActive = false; return; }
    if (!embedActive && !embedStarting) return;
    embedActive = false;
    try { TimeMachine.stop(); } catch {}
    TimeMachine.detachEmbedTarget?.();
  }

  function close() {
    stopEmbedded();
    onClose?.();
  }

  /** Hand the current tape off to the full-board replay UI (Timebar). */
  async function openFullscreenReplay() {
    // Capture the bundle locally: onClose() nulls the `bundle` prop (the parent
    // clears viewerBundle), so reading the prop after onClose would hand
    // loadFromRecording a null tape — which is why fullscreen only closed the UI.
    const rec = bundle;
    if (!rec || !rec.deltas?.length) return;
    handoffToFull = true;
    embedActive = false;
    try { TimeMachine.stop(); } catch {}     // end embedded session + detach embed
    onClose?.();                             // dismiss this viewer
    try {
      await TimeMachine.loadFromRecording(rec);  // full-board replay + Timebar
    } catch (err) {
      console.error('[ReplayMiniViewer] fullscreen handoff failed:', err);
      window.app?.ui?.showToast?.('Could not open replay', 3000, 'error');
    }
  }

  // ── Pan / zoom on the mini canvas ───────────────────────────────────────────
  let rpZoom = $state(1);
  let rpPanX = $state(0);
  let rpPanY = $state(0);
  let rpPanning = $state(false);
  let rpPanStart = null;

  let rpCanvasTransform = $derived(`translate(${rpPanX}px, ${rpPanY}px) scale(${rpZoom})`);

  function resetRpView() {
    rpZoom = 1;
    rpPanX = 0;
    rpPanY = 0;
  }

  function onRpWheel(e) {
    if (!embedCanvas) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const next = Math.max(1, Math.min(8, rpZoom * factor));
    if (next === rpZoom) return;
    const ratio = next / rpZoom;
    const rect = embedCanvas.getBoundingClientRect();
    if (rect.width && rect.height) {
      const fx = (e.clientX - rect.left) / rect.width - 0.5;
      const fy = (e.clientY - rect.top) / rect.height - 0.5;
      rpPanX += fx * rect.width * (1 - ratio);
      rpPanY += fy * rect.height * (1 - ratio);
    }
    rpZoom = next;
    if (rpZoom === 1) { rpPanX = 0; rpPanY = 0; }
  }

  function onRpPointerDown(e) {
    if (e.button !== 0) return;
    rpPanning = true;
    rpPanStart = { x: e.clientX - rpPanX, y: e.clientY - rpPanY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onRpPointerMove(e) {
    if (!rpPanning || !rpPanStart) return;
    rpPanX = e.clientX - rpPanStart.x;
    rpPanY = e.clientY - rpPanStart.y;
  }

  function onRpPointerUp(e) {
    if (!rpPanning) return;
    rpPanning = false;
    rpPanStart = null;
    e.currentTarget?.releasePointerCapture?.(e.pointerId);
  }

  onMount(() => {
    startEmbedded();
  });

  onDestroy(() => {
    stopEmbedded();
  });
</script>

<div class="rmv-overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && close()}>
  <div class="rmv-panel">
    <div class="rmv-header">
      <span class="rmv-title">{title}</span>
      <button class="rmv-close" onclick={close} title="Close" aria-label="Close">&times;</button>
    </div>

    {#if embedActive}
      <div class="rp-player">
        <div class="rp-stage">
          <canvas
            bind:this={embedCanvas}
            class="rp-canvas"
            class:panning={rpPanning}
            class:zoomed={rpZoom > 1}
            style="transform: {rpCanvasTransform}"
            onwheel={onRpWheel}
            onpointerdown={onRpPointerDown}
            onpointermove={onRpPointerMove}
            onpointerup={onRpPointerUp}
            onpointerleave={onRpPointerUp}
            ondblclick={resetRpView}
          ></canvas>
          {#if rpZoom > 1}
            <button class="rp-zoom-reset" onclick={resetRpView} title="Reset zoom">
              {Math.round(rpZoom * 100)}%
            </button>
          {/if}
          {#if tmLoading}
            <div class="rp-overlay"><div class="rp-spinner"></div></div>
          {/if}
          <button
            class="rp-fullscreen"
            onclick={openFullscreenReplay}
            title="Open full-screen replay"
            aria-label="Open full-screen replay"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
          </button>
        </div>
        <ReplayControls
          getCanvas={() => embedCanvas}
          onExit={close}
          onAfterUndo={close}
        />
      </div>
    {:else}
      <div class="rmv-empty">
        {#if bundle && bundle.deltas?.length}
          Loading replay…
        {:else}
          Nothing to replay yet — draw something first.
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .rmv-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }

  .rmv-panel {
    background: var(--bg-secondary, #1a1a1a);
    border: 1px solid var(--border-subtle, #333);
    border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
    width: min(880px, 92vw);
    height: min(640px, 88vh);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .rmv-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-subtle, #333);
  }
  .rmv-title { font-size: 15px; font-weight: 700; color: var(--text-primary, #fff); }
  .rmv-close {
    background: none; border: none; cursor: pointer; color: var(--text-secondary, #aaa);
    font-size: 24px; line-height: 1; width: 30px; height: 30px; border-radius: 6px;
  }
  .rmv-close:hover { background: var(--bg-elevated, #2a2a2a); color: var(--text-primary, #fff); }

  .rmv-empty {
    flex: 1; display: flex; align-items: center; justify-content: center;
    color: var(--text-secondary, #aaa); font-size: 14px; padding: 24px;
  }

  /* ── Mini player (identical to the History page rp-player) ───────────────── */
  .rp-player { flex: 1; min-height: 0; width: 100%; display: flex; flex-direction: column; gap: 12px; padding: 14px; }
  .rp-stage {
    flex: 1; min-height: 0; position: relative; display: flex; align-items: center;
    justify-content: center; background: #0a0a0a; border-radius: 8px; overflow: hidden;
  }
  .rp-canvas {
    max-width: 100%; max-height: 100%; object-fit: contain;
    transform-origin: center center;
    cursor: grab;
    background-image:
      linear-gradient(45deg, #1a1a1a 25%, transparent 25%),
      linear-gradient(-45deg, #1a1a1a 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #1a1a1a 75%),
      linear-gradient(-45deg, transparent 75%, #1a1a1a 75%);
    background-size: 20px 20px;
    background-position: 0 0, 0 10px, 10px -10px, -10px 0;
    background-color: #2a2a2a;
  }
  .rp-canvas.zoomed { cursor: grab; }
  .rp-canvas.panning { cursor: grabbing; }
  .rp-zoom-reset {
    position: absolute; bottom: 10px; right: 10px; z-index: 6;
    padding: 4px 8px; min-width: 44px; font-size: 11px; font-weight: 600;
    background: rgba(0, 0, 0, 0.55); border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px; color: #eee; cursor: pointer; font-variant-numeric: tabular-nums;
  }
  .rp-zoom-reset:hover { background: rgba(0, 0, 0, 0.8); color: #fff; }
  .rp-overlay {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.25); backdrop-filter: blur(2px);
  }
  .rp-spinner {
    width: 36px; height: 36px; border: 3px solid rgba(255, 255, 255, 0.25);
    border-top-color: #fff; border-radius: 50%; animation: rp-spin 0.9s linear infinite;
  }
  @keyframes rp-spin { to { transform: rotate(360deg); } }
  .rp-fullscreen {
    position: absolute; top: 10px; right: 10px; width: 32px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.55); border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px; color: #eee; cursor: pointer;
  }
  .rp-fullscreen:hover { background: rgba(0, 0, 0, 0.8); color: #fff; }
</style>
