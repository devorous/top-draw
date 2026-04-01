<script>
  import { TimeMachine } from './TimeMachine.svelte.js';
  import { appState } from '../state.svelte.js';
  import { onMount, onDestroy } from 'svelte'; // Added import

  // Format timestamp relative to the current live time
  function formatRelativeTime(timestamp) {
    if (!timestamp) return '0:00';
    const referenceTime = TimeMachine.frozenMaxTime || TimeMachine.maxTime;
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

  function resolveMarkerPreview(source) {
    return TimeMachine.resolveAssetRef(source);
  }

  function handleUndoToState() {
    if (confirm('Are you sure you want to revert the board to this state for everyone?')) {
      TimeMachine.requestUndoTo(TimeMachine.currentTime);
    }
  }

  let isScrubbing = false;
  let scrubberElement; // Will be assigned to the .custom-scrubber div

  function calculateScrubTime(event, element) {
    const rect = element.getBoundingClientRect();
    const clientX = event.touches ? event.touches[0].clientX : event.clientX;
    const offsetX = clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, offsetX / rect.width));

    const firstTimestamp = TimeMachine.recordingBuffer[0]?.timestamp;
    if (!firstTimestamp) return 0;
    
    const maxTime = TimeMachine.frozenMaxTime || TimeMachine.maxTime;
    const range = maxTime - firstTimestamp;
    const scrubTime = firstTimestamp + (percentage * range);
    return scrubTime;
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
  });

  onDestroy(() => { // Added onDestroy
    document.removeEventListener('mousemove', handleGlobalMouseMove);
    document.removeEventListener('mouseup', handleGlobalMouseUp);
    document.removeEventListener('touchmove', handleGlobalTouchMove);
    document.removeEventListener('touchend', handleGlobalTouchEnd);
  });

  // Calculate percentage for slider background
  let progressPercent = $derived.by(() => {
    const firstTimestamp = TimeMachine.recordingBuffer[0]?.timestamp;
    const maxTime = TimeMachine.frozenMaxTime || TimeMachine.maxTime;
    if (!firstTimestamp || maxTime === firstTimestamp) return 0;
    
    const range = maxTime - firstTimestamp;
    const progress = TimeMachine.currentTime - firstTimestamp;
    return (progress / range) * 100;
  });

  // Calculate marker positions
  let markers = $derived.by(() => {
    const firstTimestamp = TimeMachine.recordingBuffer[0]?.timestamp;
    const maxTime = TimeMachine.frozenMaxTime || TimeMachine.maxTime;
    if (!firstTimestamp || maxTime === firstTimestamp) return [];
    
    const range = maxTime - firstTimestamp;
    return TimeMachine.recordingBuffer.map((snapshot, index) => {
      const position = ((snapshot.timestamp - firstTimestamp) / range) * 100;
      return {
        position,
        type: snapshot.kind === 'full' ? 'full-snapshot' : 'delta-snapshot',
        index,
        data: snapshot.canvasData,
        timestamp: snapshot.timestamp
      };
    });
  });

  // Calculate all tick marks and labels for the timeline
  let allTickMarks = $derived.by(() => {
    const firstTimestamp = TimeMachine.recordingBuffer[0]?.timestamp;
    const maxTime = TimeMachine.frozenMaxTime || TimeMachine.maxTime;
    if (!firstTimestamp || maxTime === firstTimestamp) return [];

    const duration = maxTime - firstTimestamp; // in milliseconds
    const tickMarks = [];

    // Determine interval for major ticks (e.g., every 15, 60, 300 seconds)
    let majorInterval = 1000 * 15; // 15 seconds
    if (duration > 1000 * 60 * 5) majorInterval = 1000 * 60; // 1 minute for longer recordings
    if (duration > 1000 * 60 * 30) majorInterval = 1000 * 60 * 5; // 5 minutes for very long recordings

    // Generate major ticks with labels
    for (let time = firstTimestamp; time <= maxTime; time += majorInterval) {
      const position = ((time - firstTimestamp) / duration) * 100;
      tickMarks.push({
        position: position,
        type: 'major',
        label: formatRelativeTime(time),
        timestamp: time
      });
    }

    // Add existing snapshot markers
    markers.forEach(marker => {
      // Avoid duplicate labels if a snapshot aligns exactly with a major tick's label
      const existingLabelTick = tickMarks.find(
        (tick) => tick.type === 'major' && Math.abs(tick.position - marker.position) < 0.5
      );
      if (existingLabelTick) {
        existingLabelTick.type = 'major-snapshot'; // Indicate it's both
      } else if (marker.position <= 100) { // Only add if it fits in frozen range
        tickMarks.push({
          position: marker.position,
          type: marker.type,
          index: marker.index,
          data: marker.data,
          timestamp: marker.timestamp
        });
      }
    });

    // Add activity markers (user actions)
    TimeMachine.recordingBuffer.forEach(snap => {
      (snap.actionChunks || []).forEach(chunk => {
        chunk.actions.forEach(action => {
          const position = ((action.timestamp - firstTimestamp) / duration) * 100;
          if (position >= 0 && position <= 100) {
            const exists = tickMarks.some(t => t.type === 'activity' && Math.abs(t.position - position) < 0.2);
            if (!exists) {
              tickMarks.push({
                position,
                type: 'activity',
                timestamp: action.timestamp
              });
            }
          }
        });
      });
    });

    // Sort by position and filter out anything beyond 100%
    return tickMarks
      .filter(t => t.position <= 100)
      .sort((a, b) => a.position - b.position);
  });

</script>

{#if TimeMachine.isReviewing}
  <div class="history-badge" class:needs-resync={TimeMachine.needsResync}>
    <span class="pulse"></span>
    {#if TimeMachine.needsResync}
      RESYNC REQUIRED
    {:else}
      VIEWING HISTORY
    {/if}
  </div>

  <button class="floating-catch-up-btn" class:needs-resync={TimeMachine.needsResync} onclick={() => TimeMachine.catchUp()}>
    {#if TimeMachine.needsResync}
      Resync To Present
    {:else}
      Jump To Present
    {/if}
  </button>
{/if}

{#if TimeMachine.isStarted}
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

      <div class="scrubber-container">
        <div
          class="custom-scrubber"
          bind:this={scrubberElement}
          onmousedown={handleScrubberMouseDown}
          ontouchstart={handleScrubberTouchStart}
        >
          <div class="scrubber-track">
            <div class="scrubber-progress" style="width: {progressPercent}%"></div>
            <div class="scrubber-thumb" style="left: {progressPercent}%"></div>
            {#each allTickMarks as tick}
              {#if tick.type === 'major' || tick.type === 'major-snapshot'}
                <div 
                  class="tick-mark major-tick" 
                  style="left: {tick.position}%"
                  title="Recorded state at {formatRelativeTime(tick.timestamp)}"
                ></div>
              {:else if tick.type === 'full-snapshot' || tick.type === 'delta-snapshot'}
                <div 
                  class="tick-mark snapshot-tick" 
                  style="left: {tick.position}%"
                  title={(tick.type === 'full-snapshot' ? 'Full checkpoint ' : 'Delta checkpoint ') + tick.index}
                >
                  {#if tick.index === 0}
                    <div class="flag">
                      <img src={resolveMarkerPreview(tick.data)} alt="Start Preview" />
                    </div>
                  {/if}
                </div>
              {:else if tick.type === 'activity'}
                <div 
                  class="tick-mark activity-tick" 
                  style="left: {tick.position}%"
                ></div>
              {/if}
            {/each}
          </div>
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

      {#if TimeMachine.isReviewing}
        <button class="catch-up-btn" class:needs-resync={TimeMachine.needsResync} onclick={() => TimeMachine.catchUp()}>
          {#if TimeMachine.needsResync}
            Resync
          {:else}
            Catch Up
          {/if}
        </button>
        
        {#if appState.isModerator}
          <button class="mod-undo-btn" onclick={handleUndoToState}>
            Restore to here
          </button>
        {/if}
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

    &.needs-resync {
      background: rgba(239, 68, 68, 0.9);
      animation: badge-pulse 1s infinite;
    }

    .pulse {
      width: 8px;
      height: 8px;
      background: white;
      border-radius: 50%;
      animation: pulse 1.5s infinite;
    }
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

  .floating-catch-up-btn.needs-resync {
    background: rgba(185, 28, 28, 0.92);
    border-color: rgba(254, 202, 202, 0.35);
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
    width: 90%;
    max-width: 800px;
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

    .scrubber-container {
      flex: 1;
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 0;
      padding-top: 2px;
      padding-bottom: 10px;
    }

    .custom-scrubber {
      position: relative;
      width: 100%;
      height: 36px; /* Increased height by 1.5x from 24px */
      cursor: grab;
      display: flex;
      align-items: center;

      .scrubber-track {
        width: 100%;
        height: 27px; /* Increased height by 1.5x from 18px */
        background: rgba(255, 255, 255, 0.1);
        border-radius: 0;
        position: relative;
        overflow: hidden; /* Keep ticks inside if needed */
      }

      .scrubber-progress {
        height: 100%;
        background: rgba(160, 174, 192, 0.3); /* Subtle fill */
        position: absolute;
        left: 0;
        top: 0;
      }

      .scrubber-thumb {
        position: absolute;
        top: 0;
        width: 2px;
        height: 36px; /* Increased height by 1.5x from 24px */
        background: #fff;
        border-radius: 1px;
        transform: translateX(-50%);
        box-shadow: 0 0 8px rgba(255, 255, 255, 0.5);
        z-index: 5;
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
          height: 100%; /* Tick takes full height of track */
          background: rgba(255, 255, 255, 0.4);
          width: 1px;
        }

        &.snapshot-tick {
          height: 100%;
          background: #2dd4bf; /* Prominent Teal */
          width: 3px; /* Slightly wider */
          z-index: 2;

          .flag {
            position: absolute;
            bottom: 100%;
            left: 50%;
            transform: translateX(-50%) translateY(-5px);
            width: 48px;
            height: 32px;
            background: #1e293b;
            border: 2px solid #2dd4bf; /* Teal border */
            border-radius: 4px;
            overflow: hidden;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            
            img {
              width: 100%;
              height: 100%;
              object-fit: cover;
            }

            &::after {
              content: '';
              position: absolute;
              top: 100%;
              left: 50%;
              transform: translateX(-50%);
              border-left: 5px solid transparent;
              border-right: 5px solid transparent;
              border-top: 5px solid #2dd4bf; /* Teal arrow */
            }
          }
        }

        &.activity-tick {
          height: 100%; /* Same height as major ticks */
          width: 0.5px; /* Very thin */
          background: rgba(255, 255, 255, 0.15); /* Faint */
          bottom: 0;
          z-index: 0;
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
        color: #64748b;
        white-space: nowrap;
        pointer-events: none;
      }
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

      &.needs-resync {
        background: #ef4444;
        animation: btn-pulse 1s infinite;

        &:hover {
          background: #dc2626;
          box-shadow: 0 4px 12px rgba(220, 38, 38, 0.4);
        }
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
