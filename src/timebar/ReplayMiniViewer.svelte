<script>
  // Standalone mini replay viewer — the same embedded player used on the
  // History page (SnapshotMenu's rp-player), wrapped in its own modal so it can
  // be opened from the session recorder ("View" / "Stop recording"). Plays a
  // provided recording bundle into an in-panel canvas (TimeMachine embed mode)
  // with play/scrub/region/render controls and a "fullscreen" handoff button.
  import { onMount, onDestroy, tick } from 'svelte';
  import { TimeMachine } from './TimeMachine.svelte.js';
  import { appState } from '../state.svelte.js';
  import TimeLapseDialog from './TimeLapseDialog.svelte';

  /**
   * @type {{ bundle: import('../replay/Recorder.js').ReplayRecording|null, onClose?: () => void, title?: string }}
   */
  let { bundle = null, onClose = () => {}, title = 'Replay' } = $props();

  let embedCanvas = $state(null);
  let embedActive = $state(false);
  let embedStarting = false;
  let handoffToFull = false;

  // Reactive mirrors of TimeMachine playback state.
  let tmPlaying = $derived(TimeMachine.isPlaying);
  let tmStart = $derived(TimeMachine.sessionStart);
  let tmEnd = $derived(TimeMachine.sessionEnd);
  let tmCurrent = $derived(TimeMachine.currentTime);
  let tmLoading = $derived(TimeMachine.isLoading);
  let tmExporting = $derived(TimeMachine.isExportingVideo);
  let tmExportProgress = $derived(TimeMachine.videoExportProgress);
  let scrubbingLocal = false;

  let elapsedLabel = $derived(formatClock(Math.max(0, tmCurrent - tmStart)));
  let totalLabel = $derived(formatClock(Math.max(0, tmEnd - tmStart)));

  function formatClock(ms) {
    const s = Math.floor((ms || 0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

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
    clearRegion();
    regionSelecting = false;
    resetRpView();
    if (handoffToFull) { embedActive = false; return; }
    if (!embedActive && !embedStarting) return;
    embedActive = false;
    try { TimeMachine.stop(); } catch {}
    TimeMachine.detachEmbedTarget?.();
  }

  function togglePlay() {
    if (TimeMachine.isPlaying) TimeMachine.pause();
    else TimeMachine.play();
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

  // ── Mini-player actions ─────────────────────────────────────────────────────
  let timeLapseDialogOpen = $state(false);

  async function saveReplay() {
    await TimeMachine.exportCurrentRecording();
  }

  async function undoToHere() {
    const hasRegion = !!regionRect;
    const msg = hasRegion
      ? 'Revert just the selected region of your board to this point in the replay?'
      : 'Replace your current board with this state?';
    const ok = await window.showAppConfirm(msg, {
      title: hasRegion ? 'Undo region to here' : 'Undo to here',
      confirmLabel: 'Undo',
      danger: true,
    });
    if (!ok) return;
    if (hasRegion) await TimeMachine.restoreLocalRegionToCurrentState(regionRect);
    else await TimeMachine.restoreLocalToCurrentState();
    // restoreLocal* calls catchUp() which stops the (embedded) replay; close.
    close();
  }

  function openRenderDialog() {
    if (TimeMachine.isExportingVideo) return;
    timeLapseDialogOpen = true;
  }

  function cancelVideo() {
    TimeMachine.cancelVideoExport();
  }

  // ── Region selection on the mini canvas ─────────────────────────────────────
  let regionSelecting = $state(false);
  let regionRect = $state(null);
  let regionDrag = null;
  let regionDragRect = $state(null);
  let regionOutline = $state(null);

  function toggleRegionSelect() {
    if (regionSelecting) { regionSelecting = false; return; }
    regionSelecting = true;
    regionRect = null;
    regionOutline = null;
  }

  function clearRegion() {
    regionRect = null;
    regionOutline = null;
    regionDragRect = null;
  }

  function clientToBoard(clientX, clientY) {
    if (!embedCanvas) return null;
    const r = embedCanvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: ((clientX - r.left) / r.width) * embedCanvas.width,
      y: ((clientY - r.top) / r.height) * embedCanvas.height,
    };
  }

  function onRegionPointerDown(e) {
    if (!regionSelecting) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    regionDrag = { startX: e.clientX, startY: e.clientY };
    regionDragRect = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
  }

  function onRegionPointerMove(e) {
    if (!regionDrag) return;
    regionDragRect = {
      x: Math.min(regionDrag.startX, e.clientX),
      y: Math.min(regionDrag.startY, e.clientY),
      w: Math.abs(e.clientX - regionDrag.startX),
      h: Math.abs(e.clientY - regionDrag.startY),
    };
  }

  function onRegionPointerUp(e) {
    if (!regionDrag) return;
    const start = clientToBoard(regionDrag.startX, regionDrag.startY);
    const end = clientToBoard(e.clientX, e.clientY);
    regionDrag = null;
    regionDragRect = null;
    if (!start || !end) { regionSelecting = false; return; }
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);
    if (width < 8 || height < 8) { regionSelecting = false; return; }
    regionRect = { x, y, width, height };
    regionSelecting = false;
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
    if (regionSelecting || e.button !== 0) return;
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

  // Keep the committed-region outline anchored to the canvas.
  $effect(() => {
    if (!embedActive || !regionRect || !embedCanvas) { regionOutline = null; return; }
    let rafId = 0;
    const sync = () => {
      if (embedCanvas && regionRect) {
        const r = embedCanvas.getBoundingClientRect();
        const sx = r.width / embedCanvas.width;
        const sy = r.height / embedCanvas.height;
        regionOutline = {
          left: r.left + regionRect.x * sx,
          top: r.top + regionRect.y * sy,
          width: regionRect.width * sx,
          height: regionRect.height * sy,
        };
      }
      rafId = requestAnimationFrame(sync);
    };
    sync();
    return () => cancelAnimationFrame(rafId);
  });

  function onScrubInput(e) {
    const t = Number(e.currentTarget.value);
    if (!scrubbingLocal) { scrubbingLocal = true; TimeMachine.beginScrub(); }
    TimeMachine.scrubTo(t);
  }

  function onScrubChange(e) {
    const t = Number(e.currentTarget.value);
    TimeMachine.endScrub(t);
    scrubbingLocal = false;
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
          {#if regionSelecting}
            <div
              class="rp-region-picker"
              role="presentation"
              onpointerdown={onRegionPointerDown}
              onpointermove={onRegionPointerMove}
              onpointerup={onRegionPointerUp}
              onpointerleave={onRegionPointerUp}
            >
              <span class="rp-region-hint">Drag a rectangle to pick a region</span>
            </div>
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
        <div class="rp-controls">
          <button class="rp-play" onclick={togglePlay} title={tmPlaying ? 'Pause' : 'Play'} aria-label={tmPlaying ? 'Pause' : 'Play'}>
            {#if tmPlaying}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            {:else}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            {/if}
          </button>
          <span class="rp-time">{elapsedLabel}</span>
          <input
            class="rp-scrubber"
            type="range"
            min={tmStart}
            max={tmEnd}
            value={tmCurrent}
            step="1"
            oninput={onScrubInput}
            onchange={onScrubChange}
            aria-label="Replay scrubber"
          />
          <span class="rp-time rp-time-total">{totalLabel}</span>
        </div>

        {#if tmExporting}
          <div class="rp-export-progress">
            <div class="rp-export-bar" style="width: {Math.round(tmExportProgress * 100)}%"></div>
            <span class="rp-export-label">Rendering... {Math.round(tmExportProgress * 100)}%</span>
            <button class="rp-action" onclick={cancelVideo}>Cancel</button>
          </div>
        {:else}
          <div class="rp-actions">
            <button
              class="rp-action"
              class:active={regionSelecting || !!regionRect}
              onclick={toggleRegionSelect}
              title="Select a region of the canvas"
            >
              {#if regionRect}
                Region: {Math.round(regionRect.width)}×{Math.round(regionRect.height)}
              {:else if regionSelecting}
                Picking…
              {:else}
                Select region
              {/if}
            </button>
            {#if regionRect}
              <button class="rp-action" onclick={clearRegion} title="Clear region">Clear</button>
            {/if}
            <span class="rp-actions-spacer"></span>
            {#if appState.canUndoReplayHistory}
              <button class="rp-action danger" onclick={undoToHere} title={regionRect ? 'Undo just this region to here' : 'Undo board to here'}>
                {regionRect ? 'Undo region' : 'Undo to here'}
              </button>
            {/if}
            <button class="rp-action" onclick={saveReplay} title="Save this replay as a .ddraw file">Save .ddraw</button>
            <button class="rp-action accent" onclick={openRenderDialog} title={regionRect ? 'Render this region as a time-lapse' : 'Render time-lapse'}>Render</button>
          </div>
        {/if}

        {#if regionDragRect}
          <div class="rp-region-rect" style="left:{regionDragRect.x}px;top:{regionDragRect.y}px;width:{regionDragRect.w}px;height:{regionDragRect.h}px"></div>
        {/if}
        {#if regionOutline && !regionSelecting}
          <div class="rp-region-outline" style="left:{regionOutline.left}px;top:{regionOutline.top}px;width:{regionOutline.width}px;height:{regionOutline.height}px">
            <span class="rp-region-tag">Region</span>
          </div>
        {/if}
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

<TimeLapseDialog
  bind:open={timeLapseDialogOpen}
  onClose={() => (timeLapseDialogOpen = false)}
  initialRegion={regionRect}
  allowRegionPick={false}
/>

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

  .rp-controls { display: flex; align-items: center; gap: 12px; padding: 0 4px; }
  .rp-play {
    flex-shrink: 0; width: 38px; height: 38px; display: flex; align-items: center;
    justify-content: center; border-radius: 50%; border: 1px solid var(--border-subtle, #333);
    background: var(--bg-elevated, #2a2a2a); color: #fff; cursor: pointer;
  }
  .rp-play:hover { background: var(--accent-primary, #00d4aa); }
  .rp-time { font-size: 12px; color: var(--text-secondary, #aaa); font-variant-numeric: tabular-nums; min-width: 34px; }
  .rp-time-total { text-align: right; }
  .rp-scrubber { flex: 1; accent-color: var(--accent-primary, #00d4aa); cursor: pointer; }

  .rp-actions { display: flex; align-items: center; gap: 8px; padding: 0 4px; flex-wrap: wrap; }
  .rp-actions-spacer { flex: 1; }
  .rp-action {
    background: transparent; border: 1px solid var(--border-subtle, #333); color: var(--text-secondary, #bbb);
    border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap;
  }
  .rp-action:hover { background: var(--bg-elevated, #2a2a2a); color: #fff; }
  .rp-action.active { border-color: var(--accent-primary, #00d4aa); color: var(--accent-primary, #00d4aa); }
  .rp-action.accent { background: var(--accent-primary, #00d4aa); border-color: var(--accent-primary, #00d4aa); color: #fff; }
  .rp-action.accent:hover { filter: brightness(1.1); }
  .rp-action.danger { border-color: rgba(220, 53, 69, 0.4); color: #ff6b6b; }
  .rp-action.danger:hover { background: rgba(220, 53, 69, 0.25); color: #fff; }

  .rp-region-picker {
    position: absolute; inset: 0; z-index: 5; cursor: crosshair; touch-action: none;
    background: rgba(0, 0, 0, 0.2);
  }
  .rp-region-hint {
    position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.8); color: #fff; font-size: 12px; font-weight: 600;
    padding: 6px 12px; border-radius: 6px; pointer-events: none;
  }
  .rp-region-rect {
    position: fixed; z-index: 2100; pointer-events: none;
    border: 2px dashed #fff; background: rgba(0, 212, 170, 0.18);
  }
  .rp-region-outline {
    position: fixed; z-index: 2100; pointer-events: none;
    border: 2px dashed var(--accent-primary, #00d4aa);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55), inset 0 0 0 1px rgba(0, 0, 0, 0.55);
  }
  .rp-region-tag {
    position: absolute; top: -20px; left: -2px; background: var(--accent-primary, #00d4aa);
    color: #fff; font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 4px 4px 0 0; white-space: nowrap;
  }

  .rp-export-progress {
    position: relative; display: flex; align-items: center; gap: 10px; padding: 0 4px;
    height: 32px;
  }
  .rp-export-bar {
    position: absolute; left: 4px; top: 0; bottom: 0; border-radius: 6px;
    background: linear-gradient(90deg, var(--accent-primary, #00d4aa), var(--accent-hover, #00e6b8));
    opacity: 0.35; transition: width 120ms ease-out; pointer-events: none;
  }
  .rp-export-label { font-size: 12px; color: var(--text-primary, #eee); z-index: 1; flex: 1; }
</style>
