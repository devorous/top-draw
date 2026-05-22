<script>
  import { TimeMachine } from './TimeMachine.svelte.js';
  import { appState } from '../state.svelte.js';
  import { onMount, onDestroy } from 'svelte'; // Added import

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
  let scrubberElement = $state(); // Will be assigned to the .custom-scrubber div
  let viewportElement = $state(); // The horizontally-scrollable wrapper

  // ── Horizontal-zoom configuration ────────────────────────────────────────
  // The viewport shows viewportSeconds of tape at once; the inner scrubber
  // is wider than the viewport when the recording is longer, so the user can
  // scroll horizontally to reach earlier moments. Mouse wheel over the
  // timebar zooms in/out. Auto-scroll keeps the playhead onscreen during
  // playback. pxPerSecond is derived from the viewport's current width so
  // things stay responsive when side panels open/close.
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
    if (scrubberElement) {
      TimeMachine.seek(calculateScrubTime(event, scrubberElement));
    }
    // Prevent default to avoid text selection or other native browser behaviors
    event.preventDefault(); 
  }

  function handleGlobalMouseMove(event) { // Added global handler
    if (isScrubbing && scrubberElement) {
      TimeMachine.seek(calculateScrubTime(event, scrubberElement));
    }
  }

  function handleGlobalMouseUp() { // Added global handler
    isScrubbing = false;
  }

  function handleScrubberTouchStart(event) {
    isScrubbing = true;
    if (scrubberElement) {
      TimeMachine.seek(calculateScrubTime(event, scrubberElement));
    }
    event.preventDefault(); // Prevent scrolling
  }

  function handleGlobalTouchMove(event) { // Added global handler
    if (isScrubbing && scrubberElement) {
      TimeMachine.seek(calculateScrubTime(event, scrubberElement));
    }
  }

  function handleGlobalTouchEnd() { // Added global handler
    isScrubbing = false;
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
    document.body.classList.remove('replay-playback-mode');
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

  $effect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle(
      'replay-playback-mode',
      TimeMachine.isPlaying && TimeMachine.isReviewing
    );
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

{#if TimeMachine.isReviewing}
  <div class="history-badge">
    <span class="pulse"></span>
    VIEWING HISTORY
  </div>

  <button class="floating-catch-up-btn" onclick={() => TimeMachine.catchUp()}>
    {TimeMachine.isLocalReplay ? 'Return To Live' : 'Jump To Present'}
  </button>
{/if}

{#if TimeMachine.isOpen || TimeMachine.isLoading}
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

  /* Hide overlays / chat / popovers during playback, but keep the top board
     toolbar (zoom in/out, rotate) and undo/redo HUD so the viewer can pan and
     zoom around the replay. The userList is hidden separately via JS so bot
     cursors stay visible without the sidebar entries. */
  :global(body.replay-playback-mode #boardMenu),
  :global(body.replay-playback-mode #chatMount),
  :global(body.replay-playback-mode #chatToastContainer),
  :global(body.replay-playback-mode #boardColorPickerPanelMount),
  :global(body.replay-playback-mode #floatingPaletteMount),
  :global(body.replay-playback-mode #selectionMenu),
  :global(body.replay-playback-mode #userContextMenu),
  :global(body.replay-playback-mode #selfContextMenu),
  :global(body.replay-playback-mode .toast),
  :global(body.replay-playback-mode .history-badge),
  :global(body.replay-playback-mode .floating-catch-up-btn) {
    opacity: 0 !important;
    pointer-events: none !important;
    transition: opacity 180ms ease;
  }

  :global(body.replay-playback-mode #boards) {
    box-shadow: none;
  }

  .floating-catch-up-btn {
    position: fixed;
    right: 20px;
    bottom: 96px;
    z-index: 10002;
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: rgba(15, 23, 42, 0.9);
    color: white;
    padding: 10px 14px;
    border-radius: 10px;
    font-weight: 700;
    font-size: 13px;
    letter-spacing: 0.02em;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
    backdrop-filter: blur(10px);
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
