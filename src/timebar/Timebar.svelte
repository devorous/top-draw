<script>
  import { TimeMachine } from './TimeMachine.svelte.js';
  import { appState } from '../state.svelte.js';
  import { onMount, onDestroy } from 'svelte'; // Added import
  import TimeLapseDialog from './TimeLapseDialog.svelte';

  let timeLapseDialogOpen = $state(false);

  // Format timestamp relative to the current live time
  function formatRelativeTime(timestamp) {
    if (!timestamp) return '0:00';
    const referenceTime = TimeMachine.sessionEnd;
    const secondsAgo = Math.floor((referenceTime - timestamp) / 1000);
    const mins = Math.floor(secondsAgo / 60);
    const secs = secondsAgo % 60;
    return `-${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function togglePlay() {
    if (TimeMachine.isPlaying) {
      TimeMachine.pause();
    } else {
      TimeMachine.play();
    }
  }

  async function handleUndoToState() {
    if (TimeMachine.isLocalReplay) {
      if (await window.showAppConfirm('Replace your current board with this state?', {
        title: 'Undo to here',
        confirmLabel: 'Undo',
        danger: true
      })) {
        TimeMachine.restoreLocalToCurrentState();
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

  let isScrubbing = false;
  let lastScrubTime = null;
  let scrubberElement = $state(); // Will be assigned to the .custom-scrubber div
  let viewportElement = $state(); // The horizontally-scrollable wrapper

  // ── Horizontal-zoom configuration ────────────────────────────────────────
  // The viewport shows viewportSeconds of tape at once; the inner scrubber
  // is wider than the viewport when the recording is longer, so the user can
  // scroll horizontally to reach earlier moments. Mouse wheel over the
  // timebar zooms in/out. Auto-scroll keeps the playhead onscreen during
  // playback. pxPerSecond is derived from the viewport's current width so
  // things stay responsive when side panels open/close.
  let overlayElement = $state(); // .replay-preview-overlay node (positioned over #boards)
  let viewportSeconds = $state(30);
  const VIEWPORT_SECONDS_MIN = 5;
  const VIEWPORT_SECONDS_MAX = 600;
  let viewportWidthPx = $state(700);

  let durationMs = $derived.by(() => {
    const { sessionStart, sessionEnd } = TimeMachine;
    return Math.max(0, (sessionEnd || 0) - (sessionStart || 0));
  });

  let pxPerSecond = $derived.by(() => {
    if (viewportWidthPx <= 0) return 12;
    return viewportWidthPx / viewportSeconds;
  });

  // Wheel zoom — preserve the tape position under the cursor so zoom feels
  // anchored. Native horizontal trackpad scroll still works because we only
  // hijack the event when deltaY is the dominant axis.
  function handleViewportWheel(event) {
    if (!viewportElement) return;
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    const rect = viewportElement.getBoundingClientRect();
    const cursorXInViewport = event.clientX - rect.left;
    const cursorXInScrubber = viewportElement.scrollLeft + cursorXInViewport;
    const cursorTapeSecond = cursorXInScrubber / pxPerSecond;
    const factor = event.deltaY > 0 ? 1.2 : 1 / 1.2;
    const next = Math.max(VIEWPORT_SECONDS_MIN, Math.min(VIEWPORT_SECONDS_MAX, viewportSeconds * factor));
    if (next === viewportSeconds) return;
    viewportSeconds = next;
    // After Svelte re-renders the new width, restore the cursor anchor.
    queueMicrotask(() => {
      if (!viewportElement) return;
      const newPxPerSec = viewportWidthPx / viewportSeconds;
      const newCursorXInScrubber = cursorTapeSecond * newPxPerSec;
      viewportElement.scrollLeft = Math.max(0, newCursorXInScrubber - cursorXInViewport);
    });
  }

  // Inner scrubber's width. min = viewport (so short tapes don't get squished).
  let scrubberWidthPx = $derived.by(() => {
    const tapeSeconds = durationMs / 1000;
    const px = tapeSeconds * pxPerSecond;
    return Math.max(viewportWidthPx, px);
  });

  // Track viewport width with a ResizeObserver so pxPerSecond stays meaningful
  // when the user opens/closes side panels.
  let viewportResizeObserver = null;

  function calculateScrubTime(event, element) {
    const rect = element.getBoundingClientRect();
    const clientX = event.touches ? event.touches[0].clientX : event.clientX;
    const offsetX = clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, offsetX / rect.width));

    const { sessionStart, sessionEnd } = TimeMachine;
    if (!sessionStart || sessionEnd <= sessionStart) return 0;

    return sessionStart + percentage * (sessionEnd - sessionStart);
  }

  function handleScrubberMouseDown(event) {
    isScrubbing = true;
    TimeMachine.beginScrub();
    if (scrubberElement) {
      lastScrubTime = calculateScrubTime(event, scrubberElement);
      TimeMachine.scrubTo(lastScrubTime);
    }
    // Prevent default to avoid text selection or other native browser behaviors
    event.preventDefault(); 
  }

  function handleGlobalMouseMove(event) { // Added global handler
    if (isScrubbing && scrubberElement) {
      lastScrubTime = calculateScrubTime(event, scrubberElement);
      TimeMachine.scrubTo(lastScrubTime);
    }
  }

  function handleGlobalMouseUp() { // Added global handler
    if (isScrubbing) TimeMachine.endScrub(lastScrubTime);
    isScrubbing = false;
    lastScrubTime = null;
  }

  function handleScrubberTouchStart(event) {
    isScrubbing = true;
    TimeMachine.beginScrub();
    if (scrubberElement) {
      lastScrubTime = calculateScrubTime(event, scrubberElement);
      TimeMachine.scrubTo(lastScrubTime);
    }
    event.preventDefault(); // Prevent scrolling
  }

  function handleGlobalTouchMove(event) { // Added global handler
    if (isScrubbing && scrubberElement) {
      lastScrubTime = calculateScrubTime(event, scrubberElement);
      TimeMachine.scrubTo(lastScrubTime);
    }
  }

  function handleGlobalTouchEnd() { // Added global handler
    if (isScrubbing) TimeMachine.endScrub(lastScrubTime);
    isScrubbing = false;
    lastScrubTime = null;
  }

  onMount(() => { // Added onMount
    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleGlobalMouseUp);
    document.addEventListener('touchmove', handleGlobalTouchMove);
    document.addEventListener('touchend', handleGlobalTouchEnd);

    if (viewportElement && typeof ResizeObserver !== 'undefined') {
      viewportResizeObserver = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect?.width;
        if (w && w > 0) viewportWidthPx = w;
      });
      viewportResizeObserver.observe(viewportElement);
      viewportWidthPx = viewportElement.clientWidth || viewportWidthPx;
    }
  });

  onDestroy(() => { // Added onDestroy
    document.removeEventListener('mousemove', handleGlobalMouseMove);
    document.removeEventListener('mouseup', handleGlobalMouseUp);
    document.removeEventListener('touchmove', handleGlobalTouchMove);
    document.removeEventListener('touchend', handleGlobalTouchEnd);
    document.body.classList.remove('replay-reviewing-mode');
    document.body.classList.remove('replay-preview-mode');
    viewportResizeObserver?.disconnect?.();
  });

  // Auto-scroll the viewport during playback so the playhead stays onscreen.
  // While the user is actively scrubbing we leave their scroll position alone.
  $effect(() => {
    if (!viewportElement || isScrubbing) return;
    const { sessionStart, sessionEnd, currentTime } = TimeMachine;
    if (!sessionStart || sessionEnd <= sessionStart) return;
    const headPx = ((currentTime - sessionStart) / 1000) * pxPerSecond;
    const left = viewportElement.scrollLeft;
    const right = left + viewportWidthPx;
    // Anchor playhead at 25% from the left edge once it crosses the right
    // half — gives the viewer some lead-in on the upcoming content.
    if (headPx < left + viewportWidthPx * 0.1 || headPx > right - viewportWidthPx * 0.2) {
      const target = Math.max(0, headPx - viewportWidthPx * 0.25);
      viewportElement.scrollTo({ left: target, behavior: TimeMachine.isPlaying ? 'auto' : 'smooth' });
    }
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

  // Calculate percentage for slider background
  let progressPercent = $derived.by(() => {
    const { sessionStart, sessionEnd, currentTime } = TimeMachine;
    if (!sessionStart || sessionEnd <= sessionStart) return 0;
    return ((currentTime - sessionStart) / (sessionEnd - sessionStart)) * 100;
  });

  // Checkpoint markers derived from server checkpoint list
  let markers = $derived.by(() => {
    const { sessionStart, sessionEnd, checkpoints } = TimeMachine;
    if (!sessionStart || sessionEnd <= sessionStart || checkpoints.length === 0) return [];
    const range = sessionEnd - sessionStart;
    return checkpoints.map((cp, index) => ({
      position: ((cp.ts - sessionStart) / range) * 100,
      type: 'snapshot',
      index,
      timestamp: cp.ts,
      id: cp.id
    }));
  });

  // Calculate all tick marks and labels for the timeline
  let allTickMarks = $derived.by(() => {
    const { sessionStart, sessionEnd } = TimeMachine;
    if (!sessionStart || sessionEnd <= sessionStart) return [];

    const duration = sessionEnd - sessionStart;
    const tickMarks = [];

    // Major tick interval depends on duration. Minor ticks are 1/5 of major
    // — gives the eye a steady cadence between labels without crowding.
    let majorInterval = 1000 * 5; // 5 s
    if (duration > 1000 * 60)       majorInterval = 1000 * 10;     // 10 s
    if (duration > 1000 * 60 * 5)   majorInterval = 1000 * 30;     // 30 s
    if (duration > 1000 * 60 * 30)  majorInterval = 1000 * 60 * 2; // 2 min
    const minorInterval = majorInterval / 5;

    for (let time = sessionStart; time <= sessionEnd; time += majorInterval) {
      tickMarks.push({
        position: ((time - sessionStart) / duration) * 100,
        type: 'major',
        label: formatRelativeTime(time),
        timestamp: time
      });
    }

    for (let time = sessionStart; time <= sessionEnd; time += minorInterval) {
      const position = ((time - sessionStart) / duration) * 100;
      // Skip positions that overlap a major tick
      if (tickMarks.some(t => Math.abs(t.position - position) < 0.05)) continue;
      tickMarks.push({ position, type: 'minor', timestamp: time });
    }

    // Merge checkpoint markers with major ticks
    markers.forEach(marker => {
      const existingLabelTick = tickMarks.find(
        (tick) => tick.type === 'major' && Math.abs(tick.position - marker.position) < 0.5
      );
      if (existingLabelTick) {
        existingLabelTick.type = 'major-snapshot';
      }
    });

    return tickMarks
      .filter(t => t.position <= 100)
      .sort((a, b) => a.position - b.position);
  });

</script>

{#if TimeMachine.isReviewing && !TimeMachine.isEmbedded}
  <div class="history-badge">
    <span class="pulse"></span>
    VIEWING HISTORY
  </div>
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
    <div class="controls">
      <button class="icon-btn play-pause" onclick={togglePlay} title={TimeMachine.isPlaying ? 'Pause' : 'Play'}>
        {#if TimeMachine.isPlaying}
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/></svg>
        {:else}
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
        {/if}
      </button>

      <div
        class="scrubber-viewport"
        bind:this={viewportElement}
        onwheel={handleViewportWheel}
      >
        <div
          class="custom-scrubber"
          bind:this={scrubberElement}
          onmousedown={handleScrubberMouseDown}
          ontouchstart={handleScrubberTouchStart}
          role="slider"
          aria-label="Timeline scrubber"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={progressPercent}
          tabindex="0"
          style="width: {scrubberWidthPx}px"
        >
          <div class="snapshot-marker-row">
            {#each markers as m}
              <div
                class="snapshot-marker"
                style="left: {m.position}%"
                title="Snapshot {m.index + 1} • {formatRelativeTime(m.timestamp)}"
              >◆</div>
            {/each}
          </div>
          <div class="scrubber-track">
            <div class="scrubber-progress" style="width: {progressPercent}%"></div>
            {#each markers as m}
              <div
                class="snapshot-line"
                style="left: {m.position}%"
                title="Snapshot {m.index + 1}"
              ></div>
            {/each}
            {#each allTickMarks as tick}
              {#if tick.type === 'major' || tick.type === 'major-snapshot'}
                <div
                  class="tick-mark major-tick"
                  style="left: {tick.position}%"
                  title={formatRelativeTime(tick.timestamp)}
                ></div>
              {:else if tick.type === 'minor'}
                <div class="tick-mark minor-tick" style="left: {tick.position}%"></div>
              {/if}
            {/each}
            <div class="scrubber-thumb" style="left: {progressPercent}%"></div>
          </div>
          <div class="time-labels-container">
            {#each allTickMarks as tick}
              {#if tick.label && (tick.type === 'major' || tick.type === 'major-snapshot')}
                <div class="time-label" style="left: {tick.position}%">
                  {tick.label}
                </div>
              {/if}
            {/each}
          </div>
        </div>
      </div>

      {#if TimeMachine.isReviewing}
        <div class="review-actions">
          {#if TimeMachine.isLocalReplay}
            <button class="save-replay-btn" onclick={() => TimeMachine.exportCurrentRecording()} title="Save this replay as a .ddraw file">
              Save .ddraw
            </button>
            <button class="save-replay-btn" onclick={() => (timeLapseDialogOpen = true)} title="Render as a time-lapse video">
              Export video
            </button>
          {/if}
          {#if TimeMachine.isLocalReplay || appState.isModerator}
            <button class="mod-undo-btn" onclick={handleUndoToState}>
              {TimeMachine.isLocalReplay ? 'Undo to here' : 'Restore to here'}
            </button>
          {/if}
          <button class="catch-up-btn" onclick={() => TimeMachine.catchUp()}>
            {TimeMachine.isLocalReplay ? 'Return Live' : 'Catch Up'}
          </button>
        </div>
      {/if}
    </div>
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

  /* Hide drawing chrome whenever a replay review is active. The top toolbar
     (zoom +/-, rotation reset) stays so the viewer can navigate around the
     canvas. The history badge stays visible to make it clear they're in
     replay mode. */
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

  @keyframes badge-pulse {
    0%, 100% { transform: translateX(-50%) scale(1); }
    50% { transform: translateX(-50%) scale(1.05); }
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
    max-width: 1100px;
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
      bottom: 100px;
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
    padding: 8px 20px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
    transition: all 0.3s ease;

    .controls {
      display: flex;
      align-items: center;
      gap: 20px;
    }

    .icon-btn {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: white;
      cursor: pointer;
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      transition: all 0.2s;

      &:hover {
        background: rgba(255, 255, 255, 0.15);
        transform: scale(1.1);
      }
    }

    .scrubber-viewport {
      flex: 1;
      position: relative;
      overflow-x: auto;
      overflow-y: hidden;
      padding-top: 2px;
      padding-bottom: 4px;
      /* Slim scrollbar so it doesn't dominate at the bottom of the bar. */
      &::-webkit-scrollbar { height: 6px; }
      &::-webkit-scrollbar-thumb {
        background: rgba(160, 174, 192, 0.5);
        border-radius: 3px;
      }
      &::-webkit-scrollbar-thumb:hover { background: rgba(160, 174, 192, 0.8); }
      &::-webkit-scrollbar-track { background: rgba(255, 255, 255, 0.04); }
    }

    .custom-scrubber {
      position: relative;
      /* width set inline based on duration × pxPerSecond */
      height: 60px;
      cursor: grab;
      display: flex;
      flex-direction: column;

      .snapshot-marker-row {
        position: relative;
        height: 14px;
        margin-bottom: 1px;
      }

      .snapshot-marker {
        position: absolute;
        top: 0;
        transform: translateX(-50%);
        color: #2dd4bf;
        font-size: 10px;
        line-height: 14px;
        text-shadow: 0 0 4px rgba(45, 212, 191, 0.6);
        pointer-events: none;
        user-select: none;
      }

      .scrubber-track {
        width: 100%;
        height: 27px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 0;
        position: relative;
        overflow: visible;
      }

      .scrubber-progress {
        height: 100%;
        background: rgba(160, 174, 192, 0.3);
        position: absolute;
        left: 0;
        top: 0;
      }

      .scrubber-thumb {
        position: absolute;
        top: -3px;
        width: 2px;
        height: 33px;
        background: #fff;
        border-radius: 1px;
        transform: translateX(-50%);
        box-shadow: 0 0 8px rgba(255, 255, 255, 0.6);
        z-index: 5;
        pointer-events: none;
      }

      .snapshot-line {
        position: absolute;
        top: -3px;
        bottom: -3px;
        width: 2px;
        background: #2dd4bf;
        box-shadow: 0 0 6px rgba(45, 212, 191, 0.5);
        transform: translateX(-50%);
        z-index: 3;
        pointer-events: none;
      }

      .tick-mark {
        position: absolute;
        bottom: 0;
        width: 1px;
        background: rgba(255, 255, 255, 0.2);
        transform: translateX(-50%);
        pointer-events: none;

        &.major-tick {
          top: 0;
          background: rgba(255, 255, 255, 0.45);
        }

        &.minor-tick {
          height: 9px;
          background: rgba(255, 255, 255, 0.35);
        }
      }
    }

    .time-labels-container {
      position: relative;
      width: 100%;
      height: 14px;
      margin-top: 4px;

      .time-label {
        position: absolute;
        top: 0;
        transform: translateX(-50%);
        font-size: 9px;
        color: #94a3b8;
        white-space: nowrap;
        pointer-events: none;
      }
    }

    .review-actions {
      display: flex;
      flex-direction: column;
      gap: 4px;
      align-items: stretch;
    }

    .catch-up-btn {
      background: #a0aec0;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;

      &:hover {
        background: #718096;
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(113, 128, 150, 0.4);
      }

    }

    @keyframes btn-pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.02); }
    }

    .save-replay-btn {
      background: #2dd4bf;
      color: #0f172a;
      border: none;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;

      &:hover {
        background: #14b8a6;
        color: white;
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(45, 212, 191, 0.4);
      }
    }

    .mod-undo-btn {
      background: #ef4444;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;

      &:hover {
        background: #dc2626;
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(220, 38, 38, 0.4);
      }
    }
  }
</style>
