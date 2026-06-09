<script>
  import { TimeMachine } from './TimeMachine.svelte.js';
  import { appState } from '../state.svelte.js';
  import { onDestroy } from 'svelte';
  import TimeLapseDialog from './TimeLapseDialog.svelte';

  // NOTE: The original full-width tick-marked scrubber lives in
  // Timebar.fullscreen.backup.svelte (kept as a reference, not mounted).
  // This component renders the compact "mini-player" style timeline over the
  // full-board replay takeover instead.

  let timeLapseDialogOpen = $state(false);

  // Reactive mirrors of TimeMachine playback state for the compact controls.
  let tmPlaying = $derived(TimeMachine.isPlaying);
  let tmStart = $derived(TimeMachine.sessionStart);
  let tmEnd = $derived(TimeMachine.sessionEnd);
  let tmCurrent = $derived(TimeMachine.currentTime);
  let tmLoading = $derived(TimeMachine.isLoading);
  let tmExporting = $derived(TimeMachine.isExportingVideo);
  let tmExportProgress = $derived(TimeMachine.videoExportProgress);

  let elapsedLabel = $derived(formatClock(Math.max(0, tmCurrent - tmStart)));
  let totalLabel = $derived(formatClock(Math.max(0, tmEnd - tmStart)));

  function formatClock(ms) {
    const s = Math.floor((ms || 0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function togglePlay() {
    if (TimeMachine.isPlaying) TimeMachine.pause();
    else TimeMachine.play();
  }

  // ── Scrubbing via the range input ───────────────────────────────────────────
  let scrubbing = false;

  function onScrubInput(e) {
    const t = Number(e.currentTarget.value);
    if (!scrubbing) { scrubbing = true; TimeMachine.beginScrub(); }
    TimeMachine.scrubTo(t);
  }

  function onScrubChange(e) {
    const t = Number(e.currentTarget.value);
    TimeMachine.endScrub(t);
    scrubbing = false;
  }

  async function handleUndoToState() {
    if (TimeMachine.isLocalReplay) {
      if (await window.showAppConfirm('Replace your current board with this state?', {
        title: 'Undo to here',
        confirmLabel: 'Undo',
        danger: true
      })) {
        await TimeMachine.restoreLocalToCurrentState();
      }
      return;
    }
    if (await window.showAppConfirm('Are you sure you want to revert the board to this state for everyone?', {
      title: 'Revert board?',
      confirmLabel: 'Revert',
      danger: true
    })) {
      TimeMachine.requestUndoTo(TimeMachine.currentTime);
    }
  }

  function openRenderDialog() {
    if (TimeMachine.isExportingVideo) return;
    timeLapseDialogOpen = true;
  }

  function cancelVideo() {
    TimeMachine.cancelVideoExport();
  }

  let overlayElement = $state(); // .replay-preview-overlay node (positioned over #boards)

  onDestroy(() => {
    document.body.classList.remove('replay-reviewing-mode');
    document.body.classList.remove('replay-preview-mode');
  });

  // While showing a cached low-res frame, blur the replay canvas so the upscale
  // artefacts read as intentional, and surface a "Loading..." overlay so the
  // viewer knows the full-resolution render is on its way.
  $effect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('replay-preview-mode', !TimeMachine.isEmbedded && !!TimeMachine.isPreviewMode);
  });

  // Hide chrome (sidebar, board menu, undo/redo HUD, view-add button) while
  // any kind of replay review is active — not just during playback. Drawing
  // tools are meaningless on a frozen historical board.
  $effect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('replay-reviewing-mode', !TimeMachine.isEmbedded && !!TimeMachine.isReviewing);
  });

  // Keep the loading overlay centered over the live canvas region rather than
  // the whole viewport. The boards wrapper has a CSS transform applied to it,
  // so getBoundingClientRect() reads its current on-screen rect after pan/zoom.
  // We refresh on resize + every frame while the overlay is visible (cheap).
  $effect(() => {
    if (typeof window === 'undefined') return;
    if (!TimeMachine.isPreviewMode || !overlayElement) return;
    const boards = document.getElementById('boards');
    if (!boards) return;

    let rafId = 0;
    const sync = () => {
      const r = boards.getBoundingClientRect();
      if (overlayElement) {
        overlayElement.style.top = `${r.top}px`;
        overlayElement.style.left = `${r.left}px`;
        overlayElement.style.width = `${r.width}px`;
        overlayElement.style.height = `${r.height}px`;
      }
      rafId = requestAnimationFrame(sync);
    };
    sync();
    return () => cancelAnimationFrame(rafId);
  });
</script>

{#if TimeMachine.isReviewing && !TimeMachine.isEmbedded}
  <div class="history-badge">
    <span class="pulse"></span>
    VIEWING HISTORY
  </div>

  <!-- Floating exit, top-right. Functionally identical to the timebar's
       catch-up/return-live button — leaves review and returns to the live board.
       Replaces the (now hidden) top toolbar during review. -->
  <button class="replay-exit-btn" onclick={() => TimeMachine.catchUp()} title="Exit replay">
    <svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"/></svg>
    Exit
  </button>
{/if}

{#if TimeMachine.isPreviewMode && !TimeMachine.isEmbedded}
  <div class="replay-preview-overlay" bind:this={overlayElement}>
    <div class="replay-preview-spinner"></div>
    <div class="replay-preview-text">Loading…</div>
  </div>
{/if}

<TimeLapseDialog bind:open={timeLapseDialogOpen} onClose={() => (timeLapseDialogOpen = false)} />

{#if (TimeMachine.isOpen || TimeMachine.isLoading) && !TimeMachine.isEmbedded}
<button
  class="toggle-btn"
  class:bar-visible={TimeMachine.isVisible}
  class:bar-hidden={!TimeMachine.isVisible}
  onclick={() => TimeMachine.isVisible = !TimeMachine.isVisible}
  title={TimeMachine.isVisible ? 'Hide Timeline' : 'Show Timeline'}
>
  {#if TimeMachine.isVisible}
    <svg viewBox="0 0 24 24" width="24" height="24"><path d="M7 10l5 5 5-5z" fill="currentColor"/></svg>
  {:else}
    <svg viewBox="0 0 24 24" width="24" height="24"><path d="M7 14l5-5 5 5z" fill="currentColor"/></svg>
  {/if}
</button>

<div class="timebar-container" class:hidden={!TimeMachine.isVisible} class:reviewing={TimeMachine.isReviewing}>
  <div class="timebar">
    <!-- Compact "mini-player" style transport -->
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
        aria-label="Timeline scrubber"
      />
      <span class="rp-time rp-time-total">{totalLabel}</span>
    </div>

    {#if tmExporting}
      <div class="rp-export-progress">
        <div class="rp-export-bar" style="width: {Math.round(tmExportProgress * 100)}%"></div>
        <span class="rp-export-label">Rendering... {Math.round(tmExportProgress * 100)}%</span>
        <button class="rp-action" onclick={cancelVideo}>Cancel</button>
      </div>
    {:else if TimeMachine.isReviewing}
      <div class="rp-actions">
        {#if TimeMachine.isLocalReplay}
          <button class="rp-action" onclick={() => TimeMachine.exportCurrentRecording()} title="Save this replay as a .ddraw file">Save .ddraw</button>
          <button class="rp-action accent" onclick={openRenderDialog} title="Render time-lapse">Render</button>
        {/if}
        <span class="rp-actions-spacer"></span>
        {#if appState.canUndoReplayHistory}
          <button class="rp-action danger" onclick={handleUndoToState} title={TimeMachine.isLocalReplay ? 'Undo board to here' : 'Restore board to here'}>
            {TimeMachine.isLocalReplay ? 'Undo to here' : 'Restore to here'}
          </button>
        {/if}
        <button class="rp-action" onclick={() => TimeMachine.catchUp()} title="Exit replay">Exit</button>
      </div>
    {/if}
  </div>
</div>
{/if}

<style lang="scss">
  /* The replay canvas is a sibling of the live #mainCanvas inside #boards. While
     the preview flag is set, blur it heavily — the cached frame is 1/6 source
     size, so without this the upscaled pixels read as broken rather than as a
     loading shimmer. */
  :global(body.replay-preview-mode #replayCanvas) {
    filter: blur(8px);
    transition: filter 200ms ease;
  }

  .replay-preview-overlay {
    /* top/left/width/height are set imperatively from the boards bounding rect
       in the Timebar effect — keeps the overlay anchored to the canvas region
       rather than spilling over the toolbar/timebar/sidebar areas. */
    position: fixed;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 18px;
    pointer-events: none;
    z-index: 10000;
    color: white;
    text-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
    background: radial-gradient(
      ellipse at center,
      rgba(0, 0, 0, 0.0) 0%,
      rgba(0, 0, 0, 0.15) 60%,
      rgba(0, 0, 0, 0.35) 100%
    );
    animation: replay-preview-fade-in 220ms ease;
  }

  .replay-preview-spinner {
    width: 44px;
    height: 44px;
    border: 3px solid rgba(255, 255, 255, 0.25);
    border-top-color: white;
    border-radius: 50%;
    animation: replay-preview-spin 0.9s linear infinite;
  }

  .replay-preview-text {
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0.04em;
    opacity: 0.95;
  }

  @keyframes replay-preview-spin {
    to { transform: rotate(360deg); }
  }

  @keyframes replay-preview-fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .replay-exit-btn {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 10002;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    background: rgba(15, 20, 30, 0.92);
    border: 1px solid #a0aec0;
    border-radius: 10px;
    color: #fff;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.02em;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(8px);
    transition: all 0.2s ease;

    &:hover {
      background: rgba(160, 174, 192, 0.25);
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(160, 174, 192, 0.4);
    }
  }

  .history-badge {
    position: fixed;
    top: 80px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(160, 174, 192, 0.9);
    color: white;
    padding: 6px 16px;
    border-radius: 20px;
    font-weight: 800;
    font-size: 14px;
    letter-spacing: 0.05em;
    display: flex;
    align-items: center;
    gap: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    z-index: 100;
    transition: background 0.3s ease;

    .pulse {
      width: 8px;
      height: 8px;
      background: white;
      border-radius: 50%;
      animation: pulse 1.5s infinite;
    }
  }

  /* Hide drawing chrome whenever a replay review is active, including the top
     toolbar (.boardBtns) — the floating Exit button replaces it and the viewer
     can still pan/zoom by dragging the replay canvas. The history badge stays
     visible to make it clear they're in replay mode. */
  :global(body.replay-reviewing-mode .boardBtns),
  :global(body.replay-reviewing-mode #boardMenu),
  :global(body.replay-reviewing-mode #chatMount),
  :global(body.replay-reviewing-mode #chatToastContainer),
  :global(body.replay-reviewing-mode #boardColorPickerPanelMount),
  :global(body.replay-reviewing-mode #floatingPaletteMount),
  :global(body.replay-reviewing-mode #selectionMenu),
  :global(body.replay-reviewing-mode #userContextMenu),
  :global(body.replay-reviewing-mode #selfContextMenu),
  :global(body.replay-reviewing-mode #viewHud),
  :global(body.replay-reviewing-mode #bottomBar),
  :global(body.replay-reviewing-mode .boardViewerLaunch),
  :global(body.replay-reviewing-mode .toast) {
    opacity: 0 !important;
    pointer-events: none !important;
    transition: opacity 180ms ease;
  }

  /* Sidebar has to leave layout entirely so the canvas can grow into the
     freed space — opacity alone keeps the flex column reserved. */
  :global(body.replay-reviewing-mode #sideMenu) {
    display: none !important;
  }

  /* Floating palettes and the floating-art carousel use position:fixed/absolute
     with their own stacking context, so opacity:0 on the mount alone leaves
     visible (but inert) panels and art cards floating over the canvas during
     review. Force display:none on every mount + their detached panels. */
  :global(body.replay-reviewing-mode #floatingPaletteMount),
  :global(body.replay-reviewing-mode #floatingPalette),
  :global(body.replay-reviewing-mode .floating-palette),
  :global(body.replay-reviewing-mode #floatingArtMount),
  :global(body.replay-reviewing-mode .floating-art-container),
  :global(body.replay-reviewing-mode .floating-art-cards),
  :global(body.replay-reviewing-mode .floating-art) {
    display: none !important;
  }

  :global(body.replay-reviewing-mode #boards) {
    box-shadow: none;
  }

  /* Replay canvas captures pan/zoom drags directly. App.js routes those into
     the existing board pan/zoom handlers when TimeMachine.isReviewing is true. */
  :global(body.replay-reviewing-mode #replayCanvas) {
    pointer-events: auto !important;
    cursor: grab;
  }
  :global(body.replay-reviewing-mode #replayCanvas:active) {
    cursor: grabbing;
  }

  /* Hide the local user's drawing cursor (brush circle, crosshair, pressure
     ring, text caret, mirror line, etc.) while reviewing. Live pointer-move
     handlers may keep restyling these SVG/DOM nodes, so CSS — not JS — has
     to be the source of truth. Remote / bot cursors are deliberately not
     scoped here so playback still shows who was drawing where. */
  :global(body.replay-reviewing-mode .cursors .self),
  :global(body.replay-reviewing-mode .cursors .mirrorLine) {
    display: none !important;
  }

  @keyframes pulse {
    0% { transform: scale(0.95); opacity: 0.7; }
    50% { transform: scale(1.2); opacity: 1; }
    100% { transform: scale(0.95); opacity: 0.7; }
  }

  .timebar-container {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    width: 92%;
    max-width: 760px;
    z-index: 10001;
    transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);

    &.hidden {
      transform: translateX(-50%) translateY(calc(100% + 20px));
      pointer-events: none;
    }

    &.reviewing .timebar {
      border-color: #a0aec0;
      box-shadow: 0 0 20px rgba(160, 174, 192, 0.3);
      background: rgba(15, 20, 30, 0.98);
    }
  }

  .toggle-btn {
    position: fixed;
    bottom: 6px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(30, 41, 59, 0.8);
    backdrop-filter: blur(8px);
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: white;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 6px 20px;
    opacity: 0.7;
    transition: all 0.3s ease;
    z-index: 10002;

    &:hover {
      opacity: 1;
      background: rgba(30, 41, 59, 1);
      transform: translateX(-50%) translateY(-2px);
    }

    &.bar-visible {
      bottom: 92px;
      opacity: 0.5;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    &.bar-hidden {
      border: 2px solid #a0aec0;
      box-shadow: 0 0 15px rgba(160, 174, 192, 0.4);
      opacity: 0.9;
    }
  }

  .timebar {
    background: rgba(15, 15, 20, 0.95);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 12px 18px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
    transition: all 0.3s ease;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* ── Compact mini-player transport (ported from the History rp-player) ───── */
  .rp-controls { display: flex; align-items: center; gap: 12px; }
  .rp-play {
    flex-shrink: 0; width: 38px; height: 38px; display: flex; align-items: center;
    justify-content: center; border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.08); color: #fff; cursor: pointer;
    transition: background 0.2s, transform 0.2s;
  }
  .rp-play:hover { background: var(--accent-primary, #00d4aa); transform: scale(1.05); }
  .rp-time {
    font-size: 12px; color: #aaa; font-variant-numeric: tabular-nums; min-width: 40px;
  }
  .rp-time-total { text-align: right; }
  .rp-scrubber { flex: 1; min-width: 0; accent-color: var(--accent-primary, #00d4aa); cursor: pointer; }

  .rp-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .rp-actions-spacer { flex: 1; }
  .rp-action {
    background: transparent; border: 1px solid rgba(255, 255, 255, 0.15); color: #bbb;
    border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600;
    cursor: pointer; white-space: nowrap; transition: all 0.15s;
  }
  .rp-action:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
  .rp-action.accent { background: var(--accent-primary, #00d4aa); border-color: var(--accent-primary, #00d4aa); color: #fff; }
  .rp-action.accent:hover { filter: brightness(1.1); }
  .rp-action.danger { border-color: rgba(220, 53, 69, 0.4); color: #ff6b6b; }
  .rp-action.danger:hover { background: rgba(220, 53, 69, 0.25); color: #fff; }

  .rp-export-progress {
    position: relative; display: flex; align-items: center; gap: 10px; height: 32px;
  }
  .rp-export-bar {
    position: absolute; left: 0; top: 0; bottom: 0; border-radius: 6px;
    background: linear-gradient(90deg, var(--accent-primary, #00d4aa), var(--accent-hover, #00e6b8));
    opacity: 0.35; transition: width 120ms ease-out; pointer-events: none;
  }
  .rp-export-label { font-size: 12px; color: #eee; z-index: 1; flex: 1; }
</style>
