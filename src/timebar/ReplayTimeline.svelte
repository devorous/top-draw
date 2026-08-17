<script>
  // Multi-thumb replay timeline: a scrubbable playhead plus two trim brackets
  // that bound playback (TimeMachine.trimStart/trimEnd). Pointer handling
  // follows the PointerSlider pattern (single container with pointer capture,
  // thumbs are pointer-events:none and purely visual); a hit test on
  // pointerdown decides whether the drag moves the playhead or a trim edge.
  let {
    min = 0,
    max = 100,
    value = 0,
    trimStart = 0,        // effective (clamped) trim edges from TimeMachine
    trimEnd = 100,
    trimmed = false,
    onScrubStart = null,  // () => void
    onScrub = null,       // (timestamp) => void
    onScrubEnd = null,    // (timestamp) => void
    onTrimChange = null,  // (start, end) => void — parent normalizes/collapses
    onTrimCommit = null,  // () => void — a trim edge was released/settled
  } = $props();

  let containerElement = $state(null);
  /** 'playhead' | 'start' | 'end' | null */
  let dragging = $state(null);
  let dragTime = $state(0);

  const TRIM_GRAB_PX = 12;
  /** Pointer-downs in the top lane grab trim flags; the track below always scrubs. */
  const TRIM_LANE_PX = 11;

  const span = $derived(Math.max(1, max - min));
  const playheadPct = $derived(toPercent(value));
  const trimStartPct = $derived(toPercent(trimStart));
  const trimEndPct = $derived(toPercent(trimEnd));
  const minGap = $derived(Math.max(100, span * 0.005));

  function toPercent(t) {
    return Math.max(0, Math.min(100, ((t - min) / span) * 100));
  }

  function formatClock(ms) {
    const s = Math.floor(Math.max(0, ms) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function pointerToTime(event) {
    const rect = containerElement.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    return min + frac * span;
  }

  /** Which handle a pointerdown should grab. Trim flags live in the top lane
   *  so clicks on the track itself always scrub the playhead. */
  function hitTest(clientX, clientY) {
    const rect = containerElement.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (y <= TRIM_LANE_PX) {
      const px = (t) => ((t - min) / span) * rect.width;
      const dStart = Math.abs(x - px(trimStart));
      const dEnd = Math.abs(x - px(trimEnd));
      if (Math.min(dStart, dEnd) <= TRIM_GRAB_PX) {
        if (dStart === dEnd) return x < px(trimStart) ? 'start' : 'end';
        return dStart < dEnd ? 'start' : 'end';
      }
    }
    return 'playhead';
  }

  function applyDrag(t) {
    dragTime = t;
    if (dragging === 'playhead') {
      onScrub?.(t);
    } else if (dragging === 'start') {
      onTrimChange?.(Math.min(t, trimEnd - minGap), trimEnd);
    } else if (dragging === 'end') {
      onTrimChange?.(trimStart, Math.max(t, trimStart + minGap));
    }
  }

  function handlePointerDown(event) {
    if (!containerElement) return;
    event.preventDefault();
    dragging = hitTest(event.clientX, event.clientY);
    containerElement.setPointerCapture?.(event.pointerId);
    if (dragging === 'playhead') onScrubStart?.();
    applyDrag(pointerToTime(event));
  }

  function handlePointerMove(event) {
    if (!dragging) return;
    applyDrag(pointerToTime(event));
  }

  function handlePointerUp(event) {
    if (!dragging) return;
    const t = pointerToTime(event);
    if (dragging === 'playhead') {
      onScrubEnd?.(t);
    } else {
      applyDrag(t);
      onTrimCommit?.();
    }
    dragging = null;
    containerElement?.releasePointerCapture?.(event.pointerId);
  }

  function handleDblClick(event) {
    // Double-clicking a trim flag resets that edge to the tape boundary.
    const grabbed = hitTest(event.clientX, event.clientY);
    if (grabbed === 'start') onTrimChange?.(min, trimEnd);
    else if (grabbed === 'end') onTrimChange?.(trimStart, max);
    else return;
    onTrimCommit?.();
  }

  function handlePlayheadKey(event) {
    const step = span / 100;
    let t = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') t = value - step;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') t = value + step;
    else if (event.key === 'Home') t = min;
    else if (event.key === 'End') t = max;
    if (t == null) return;
    event.preventDefault();
    onScrubEnd?.(Math.max(min, Math.min(max, t)));
  }

  function handleTrimKey(event, edge) {
    const step = span / 100;
    const dir = (event.key === 'ArrowLeft' || event.key === 'ArrowDown') ? -1
      : (event.key === 'ArrowRight' || event.key === 'ArrowUp') ? 1 : 0;
    if (!dir) return;
    event.preventDefault();
    if (edge === 'start') {
      onTrimChange?.(Math.min(trimStart + dir * step, trimEnd - minGap), trimEnd);
    } else {
      onTrimChange?.(trimStart, Math.max(trimEnd + dir * step, trimStart + minGap));
    }
    onTrimCommit?.();
  }

  const bubblePct = $derived(toPercent(dragTime));
  const bubbleLabel = $derived(formatClock(dragTime - min));
</script>

<div
  class="timeline"
  class:dragging={!!dragging}
  class:trimmed
  bind:this={containerElement}
  role="group"
  aria-label="Replay timeline"
  onpointerdown={handlePointerDown}
  onpointermove={handlePointerMove}
  onpointerup={handlePointerUp}
  onpointercancel={handlePointerUp}
  ondblclick={handleDblClick}
>
  <div class="trim-lane"></div>
  <div class="track">
    <div class="fill" style="width: {playheadPct}%"></div>
    {#if trimmed}
      <div class="dim dim-left" style="width: {trimStartPct}%"></div>
      <div class="dim dim-right" style="width: {100 - trimEndPct}%"></div>
    {/if}
  </div>

  <div
    class="trim-bracket start"
    class:engaged={trimmed || dragging === 'start'}
    style="left: {trimStartPct}%"
    role="slider"
    aria-label="Trim start"
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={trimStart}
    aria-valuetext={formatClock(trimStart - min)}
    tabindex="0"
    onkeydown={(e) => handleTrimKey(e, 'start')}
  ></div>
  <div
    class="trim-bracket end"
    class:engaged={trimmed || dragging === 'end'}
    style="left: {trimEndPct}%"
    role="slider"
    aria-label="Trim end"
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={trimEnd}
    aria-valuetext={formatClock(trimEnd - min)}
    tabindex="0"
    onkeydown={(e) => handleTrimKey(e, 'end')}
  ></div>

  <div
    class="playhead"
    class:active={dragging === 'playhead'}
    style="left: {playheadPct}%"
    role="slider"
    aria-label="Replay scrubber"
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={value}
    aria-valuetext={formatClock(value - min)}
    tabindex="0"
    onkeydown={handlePlayheadKey}
  ></div>

  {#if dragging}
    <div class="bubble" style="left: {bubblePct}%">{bubbleLabel}</div>
  {/if}
</div>

<style>
  .timeline {
    position: relative;
    flex: 1;
    min-width: 0;
    height: 30px;
    display: flex;
    align-items: flex-end;
    cursor: pointer;
    touch-action: none;
    user-select: none;
  }

  /* Cursor affordance for the trim-flag lane; events bubble to the container. */
  .trim-lane {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 11px;
    cursor: ew-resize;
  }

  .track {
    position: relative;
    width: 100%;
    height: 6px;
    margin-bottom: 6px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.12);
    overflow: hidden;
  }

  .fill {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    background: linear-gradient(90deg,
      color-mix(in srgb, var(--accent-primary, #00d4aa) 65%, transparent),
      var(--accent-primary, #00d4aa));
    pointer-events: none;
  }

  /* Out-of-trim zones sit over the fill so played-but-trimmed areas read muted. */
  .dim {
    position: absolute;
    top: 0;
    height: 100%;
    background: rgba(8, 10, 14, 0.7);
    pointer-events: none;
  }
  .dim-left { left: 0; }
  .dim-right { right: 0; }

  /* Trim flags: a knob in the top lane with a stem dropping through the track. */
  .trim-bracket {
    position: absolute;
    top: 4px;
    width: 4px;
    height: 20px;
    transform: translateX(-50%);
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.35);
    pointer-events: none; /* container handles dragging via hit test */
    transition: background 0.15s, opacity 0.15s;
    opacity: 0;
  }
  .timeline:hover .trim-bracket,
  .trim-bracket:focus-visible,
  .timeline.dragging .trim-bracket {
    opacity: 1;
  }
  .trim-bracket.engaged {
    opacity: 1;
    background: var(--accent-primary, #00d4aa);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
  }
  .trim-bracket::after {
    content: '';
    position: absolute;
    top: -2px;
    left: 50%;
    transform: translateX(-50%);
    width: 10px;
    height: 8px;
    border-radius: 4px;
    background: inherit;
  }

  .playhead {
    position: absolute;
    top: 21px; /* centered on the bottom-aligned track */
    width: 14px;
    height: 14px;
    transform: translate(-50%, -50%);
    border-radius: 50%;
    background: #fff;
    border: 2px solid var(--accent-primary, #00d4aa);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
    pointer-events: none;
    transition: transform 0.12s, box-shadow 0.12s;
  }
  .timeline:hover .playhead,
  .playhead.active {
    transform: translate(-50%, -50%) scale(1.15);
    box-shadow: 0 0 0 4px var(--accent-glow, rgba(0, 212, 170, 0.25));
  }

  .bubble {
    position: absolute;
    bottom: calc(100% + 6px);
    transform: translateX(-50%);
    background: rgba(10, 12, 16, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: #fff;
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    padding: 2px 7px;
    border-radius: 5px;
    pointer-events: none;
    white-space: nowrap;
  }
</style>
