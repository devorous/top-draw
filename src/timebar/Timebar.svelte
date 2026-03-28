<script>
  import { TimeMachine } from './TimeMachine.svelte.js';
  import { appState } from '../state.svelte.js';

  // Format timestamp relative to the current live time
  function formatRelativeTime(timestamp) {
    if (!timestamp) return '0:00';
    const secondsAgo = Math.floor((TimeMachine.maxTime - timestamp) / 1000);
    const mins = Math.floor(secondsAgo / 60);
    const secs = secondsAgo % 60;
    return `-${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function handleScrub(event) {
    const scrubTime = parseInt(event.target.value);
    TimeMachine.seek(scrubTime);
  }

  function togglePlay() {
    if (TimeMachine.isPlaying) {
      TimeMachine.pause();
    } else {
      TimeMachine.play();
    }
  }

  function handleUndoToState() {
    if (confirm('Are you sure you want to revert the board to this state for everyone?')) {
      TimeMachine.requestUndoTo(TimeMachine.currentTime);
    }
  }

  // Calculate percentage for slider background
  let progressPercent = $derived.by(() => {
    const firstTimestamp = TimeMachine.recordingBuffer[0]?.timestamp;
    if (!firstTimestamp || TimeMachine.maxTime === firstTimestamp) return 0;
    
    const range = TimeMachine.maxTime - firstTimestamp;
    const progress = TimeMachine.currentTime - firstTimestamp;
    return (progress / range) * 100;
  });

  // Calculate marker positions
  let markers = $derived.by(() => {
    const firstTimestamp = TimeMachine.recordingBuffer[0]?.timestamp;
    if (!firstTimestamp || TimeMachine.maxTime === firstTimestamp) return [];
    
    const range = TimeMachine.maxTime - firstTimestamp;
    return TimeMachine.recordingBuffer.map((snapshot, index) => {
      const position = ((snapshot.timestamp - firstTimestamp) / range) * 100;
      return { position, index, data: snapshot.canvasData };
    });
  });

</script>

{#if TimeMachine.isReviewing}
  <div class="history-badge">
    <span class="pulse"></span>
    VIEWING HISTORY
  </div>
{/if}

{#if TimeMachine.isStarted}
<div class="timebar" class:reviewing={TimeMachine.isReviewing}>
  <div class="controls">
    <button class="icon-btn play-pause" onclick={togglePlay} title={TimeMachine.isPlaying ? 'Pause' : 'Play'}>
      {#if TimeMachine.isPlaying}
        <svg viewBox="0 0 24 24" width="20" height="20"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/></svg>
      {:else}
        <svg viewBox="0 0 24 24" width="20" height="20"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
      {/if}
    </button>

    <div class="scrubber-container">
      <div class="markers">
        {#each markers as marker}
          <div 
            class="marker" 
            class:initial={marker.index === 0}
            style="left: {marker.position}%"
            title={marker.index === 0 ? 'Recording Start' : `Snapshot ${marker.index}`}
          >
            {#if marker.index === 0}
              <div class="flag">
                <img src={marker.data} alt="Start Preview" />
              </div>
            {/if}
          </div>
        {/each}
      </div>
      <input
        type="range"
        min={TimeMachine.recordingBuffer[0]?.timestamp || 0}
        max={TimeMachine.maxTime}
        value={TimeMachine.currentTime}
        oninput={handleScrub}
        class="scrubber"
        style="--progress: {progressPercent}%"
      />
      <div class="time-display">
        <span class="current">{formatRelativeTime(TimeMachine.currentTime)}</span>
        <span class="separator">/</span>
        <span class="max">Live</span>
      </div>
    </div>

    {#if TimeMachine.isReviewing}
      <button class="catch-up-btn" onclick={() => TimeMachine.catchUp()}>
        Catch Up
      </button>
      
      {#if appState.isModerator}
        <button class="mod-undo-btn" onclick={handleUndoToState}>
          Restore to here
        </button>
      {/if}
    {/if}
  </div>
</div>
{/if}

<style lang="scss">
  .history-badge {
    position: fixed;
    top: 80px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(59, 130, 246, 0.9);
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

    .pulse {
      width: 8px;
      height: 8px;
      background: white;
      border-radius: 50%;
      animation: pulse 1.5s infinite;
    }
  }

  @keyframes pulse {
    0% { transform: scale(0.95); opacity: 0.7; }
    50% { transform: scale(1.2); opacity: 1; }
    100% { transform: scale(0.95); opacity: 0.7; }
  }

  .timebar {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    width: 90%;
    max-width: 800px;
    background: rgba(15, 15, 20, 0.95);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 12px 24px;
    z-index: 1000;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);

    &.reviewing {
      border-color: #3b82f6;
      box-shadow: 0 0 20px rgba(59, 130, 246, 0.3);
      background: rgba(15, 20, 30, 0.98);
    }

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
      gap: 8px;
      padding-top: 10px;
    }

    .markers {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }

    .marker {
      position: absolute;
      top: 10px;
      width: 2px;
      height: 8px;
      background: rgba(255, 255, 255, 0.3);
      border-radius: 1px;
      transform: translateX(-50%);

      &.initial {
        height: 12px;
        background: #3b82f6;
        z-index: 2;

        .flag {
          position: absolute;
          bottom: 100%;
          left: 50%;
          transform: translateX(-50%) translateY(-5px);
          width: 48px;
          height: 32px;
          background: #1e293b;
          border: 2px solid #3b82f6;
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
            border-top: 5px solid #3b82f6;
          }
        }
      }
    }

    .scrubber {
      -webkit-appearance: none;
      width: 100%;
      height: 6px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
      outline: none;
      cursor: pointer;
      position: relative;
      z-index: 1;

      &::-webkit-slider-runnable-track {
        background: linear-gradient(to right, #3b82f6 var(--progress), transparent var(--progress));
        height: 6px;
        border-radius: 3px;
      }

      &::-webkit-slider-thumb {
        -webkit-appearance: none;
        height: 18px;
        width: 18px;
        border-radius: 50%;
        background: #fff;
        border: 3px solid #3b82f6;
        cursor: pointer;
        margin-top: -6px;
        box-shadow: 0 0 15px rgba(59, 130, 246, 0.6);
        transition: transform 0.1s;

        &:active {
          transform: scale(1.2);
        }
      }
    }

    .time-display {
      display: flex;
      gap: 6px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      font-weight: 500;
      color: #64748b;

      .current {
        color: #3b82f6;
      }
    }

    .catch-up-btn {
      background: #3b82f6;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;

      &:hover {
        background: #2563eb;
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(37, 99, 235, 0.4);
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
