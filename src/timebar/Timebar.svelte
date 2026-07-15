<script>
  import { TimeMachine } from './TimeMachine.svelte.js';
  import { onDestroy } from 'svelte';
  import ReplayControls from './ReplayControls.svelte';

  // NOTE: This component renders the compact "mini-player" style timeline over
  // the full-board replay takeover. The transport + action bar itself is the
  // shared ReplayControls component (same one as the mini players).

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

  // Keep the loading overlay centered over the replay canvas region rather than
  // the whole viewport. We anchor to #replayCanvas (not #boards): replays from a
  // larger-board room (e.g. 1440p) size the replay canvas above the live room's
  // board (e.g. 1080p), so anchoring to #boards would leave the overlay short of
  // the canvas. The canvas rect already folds in the #boards transform via
  // getBoundingClientRect(). Fall back to #boards if the canvas isn't up yet.
  // We refresh every frame while the overlay is visible (cheap).
  $effect(() => {
    if (typeof window === 'undefined') return;
    if (!TimeMachine.isPreviewMode || !overlayElement) return;

    let rafId = 0;
    const sync = () => {
      const anchor = document.getElementById('replayCanvas') || document.getElementById('boards');
      if (!anchor) { rafId = requestAnimationFrame(sync); return; }
      const r = anchor.getBoundingClientRect();
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
    <!-- Shared transport + action bar (same component as the mini players) -->
    <ReplayControls
      getCanvas={() => document.getElementById('replayCanvas')}
      onExit={() => TimeMachine.catchUp()}
    />
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
    transition: background 0.15s ease, border-color 0.15s ease;

    &:hover {
      background: rgba(45, 55, 72, 0.95);
      border-color: #fff;
    }
  }

  /* The desktop app keeps its custom titlebar (fixed, above everything) during
     replay review — push the floating Exit button below it so it isn't cut off. */
  :global(body.desktop-window-chrome) .replay-exit-btn {
    top: calc(var(--desktop-titlebar-height) + 16px);
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

  /* Live board overlays that sit ABOVE #replayCanvas (z 2) inside #boards:
     mirror-region rects/guides (z 3), the mirror-region editor (z 4/5/60),
     the selection marching ants (z 100) and its screen-space handles (z 6).
     They describe the LIVE board, not the historical one being reviewed, so
     they must not float over the replay (or over the render-region picker). */
  :global(body.replay-reviewing-mode #mirrorRegionsLayer),
  :global(body.replay-reviewing-mode #mirrorRegionOverlay),
  :global(body.replay-reviewing-mode #mirrorRegionControls),
  :global(body.replay-reviewing-mode #mirrorRegionPanel),
  :global(body.replay-reviewing-mode #selectionOverlay),
  :global(body.replay-reviewing-mode #handleOverlay) {
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
</style>
