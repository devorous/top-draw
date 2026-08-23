<script>
  let {
    value = 0,
    min = 0,
    max = 100,
    step = 1,
    ariaLabel = 'Slider',
    onChange = null,
    onDragStart = null,
    onDragEnd = null,
    scaling = 'linear',
    weightedStopValue = 10,
    weightedStopPercent = 1 / 3,
    snapStep = null
  } = $props();

  let isDragging = $state(false);
  let containerElement = $state(null);
  let displayValue = $state(0);

  function commitValue(newValue) {
    displayValue = Math.max(min, Math.min(max, newValue));

    if (onChange) {
      onChange(displayValue);
    }
  }

  function toValue(percent) {
    if (scaling !== 'weighted') {
      return min + percent * (max - min);
    }

    const threshold = Math.max(0.01, Math.min(0.99, weightedStopPercent));
    const stopValue = Math.max(min, Math.min(max, weightedStopValue));

    if (percent <= threshold) {
      const p = percent / threshold;
      return min + p * (stopValue - min);
    }

    const p = (percent - threshold) / (1 - threshold);
    return stopValue + p * (max - stopValue);
  }

  function toPercent(val) {
    if (scaling !== 'weighted') {
      return ((val - min) / (max - min)) * 100;
    }

    const threshold = Math.max(0.01, Math.min(0.99, weightedStopPercent));
    const stopValue = Math.max(min, Math.min(max, weightedStopValue));

    if (val <= stopValue) {
      const p = (val - min) / (stopValue - min);
      return p * threshold * 100;
    }

    const p = (val - stopValue) / (max - stopValue);
    return (threshold + p * (1 - threshold)) * 100;
  }

  function updateValueFromPointer(event) {
    if (!containerElement) return;

    const rect = containerElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const percent = Math.max(0, Math.min(1, x / rect.width));

    let newValue = toValue(percent);

    const activeStep = typeof snapStep === 'function' ? snapStep(newValue) : step;

    // Apply step rounding
    if (activeStep) {
      newValue = Math.round(newValue / activeStep) * activeStep;
    }

    commitValue(newValue);
  }

  function handlePointerDown(event) {
    isDragging = true;
    onDragStart?.();
    containerElement?.setPointerCapture(event.pointerId);
    updateValueFromPointer(event);
  }

  function handlePointerMove(event) {
    if (!isDragging) return;
    updateValueFromPointer(event);
  }

  function handlePointerUp(event) {
    isDragging = false;
    containerElement?.releasePointerCapture(event.pointerId);
    onDragEnd?.();
  }

  function handlePointerCancel(event) {
    isDragging = false;
    containerElement?.releasePointerCapture(event.pointerId);
    onDragEnd?.();
  }

  function handleClick(event) {
    updateValueFromPointer(event);
  }

  function handleKeyDown(event) {
    const stepSize = (typeof snapStep === 'function' ? snapStep(displayValue) : step) || 1;
    const keyDeltas = {
      ArrowLeft: -stepSize,
      ArrowDown: -stepSize,
      ArrowRight: stepSize,
      ArrowUp: stepSize,
      PageDown: -stepSize * 10,
      PageUp: stepSize * 10
    };

    if (event.key === 'Home') {
      event.preventDefault();
      commitValue(min);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      commitValue(max);
      return;
    }

    const delta = keyDeltas[event.key];
    if (delta === undefined) return;

    event.preventDefault();
    commitValue(displayValue + delta);
  }

  function handleGlobalPointerMove(event) {
    if (isDragging) {
      updateValueFromPointer(event);
    }
  }

  function handleGlobalPointerUp(event) {
    if (isDragging) {
      isDragging = false;
      containerElement?.releasePointerCapture(event.pointerId);
      onDragEnd?.();
    }
  }

  $effect(() => {
    if (isDragging) {
      document.addEventListener('pointermove', handleGlobalPointerMove);
      document.addEventListener('pointerup', handleGlobalPointerUp);
      return () => {
        document.removeEventListener('pointermove', handleGlobalPointerMove);
        document.removeEventListener('pointerup', handleGlobalPointerUp);
      };
    }
  });

  $effect(() => {
    displayValue = value;
  });

  // Signed ranges (pattern offsets, text offset, size multiplier, fill
  // expansion) fill outward from zero rather than from the left edge — a left
  // anchored fill would draw an offset of 0 as an empty row and an offset of
  // -100 as nothing at all.
  const isSigned = $derived(min < 0 && max > 0);
  const originPercent = $derived(isSigned ? toPercent(0) : 0);

  const percent = $derived(toPercent(displayValue));
  const fillStart = $derived(Math.min(originPercent, percent));
  const fillWidth = $derived(Math.abs(percent - originPercent));
</script>

<div class="slider" bind:this={containerElement} role="slider" aria-label={ariaLabel} aria-valuemin={min} aria-valuemax={max} aria-valuenow={displayValue} tabindex="0" onpointerdown={handlePointerDown} onpointermove={handlePointerMove} onpointerup={handlePointerUp} onpointercancel={handlePointerCancel} onclick={handleClick} onkeydown={handleKeyDown}>
  <div class="slider-fill" style="left: {fillStart}%; width: {fillWidth}%"></div>
  {#if isSigned}
    <div class="slider-zero" style="left: {originPercent}%"></div>
  {/if}
  <div class="slider-edge" style="left: calc(1px + {percent / 100} * (100% - 2px))"></div>
</div>

<style>
  /* In-track row: the bar is the whole control and the name and value are
     overlaid on it by .sliderLabel (see components/_sliders.scss). There is no
     thumb — the bright leading edge marks the value. */
  .slider {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: var(--intrack-height, 24px);
    background: var(--bg-tertiary, rgba(255, 255, 255, 0.06));
    border-radius: var(--radius-sm, 6px);
    outline: none;
    cursor: ew-resize;
    touch-action: none;
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: center;
    margin: 0;
    padding: 0;
    transition: background var(--transition-fast, 0.15s);
  }

  .slider:hover {
    background: var(--bg-elevated, rgba(255, 255, 255, 0.1));
  }

  .slider:focus-visible {
    box-shadow: 0 0 0 2px var(--accent-glow, rgba(0, 212, 170, 0.3));
  }

  .slider-fill {
    position: absolute;
    height: 100%;
    top: 0;
    /* Fallback derives from the accent too — a hard-coded teal here would
       silently reintroduce the default colour under a custom accent. */
    background: var(--slider-track-fill, color-mix(in srgb, var(--accent-primary, #00d4aa) 26%, transparent));
    pointer-events: none;
  }

  /* Origin hairline, drawn only when the range crosses zero. */
  .slider-zero {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--slider-track-zero, rgba(255, 255, 255, 0.18));
    pointer-events: none;
  }

  /* The value marker. Nudged inward at the extremes so it stays visible
     against the rounded ends instead of being clipped away. */
  .slider-edge {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -1px;
    min-width: 2px;
    background: var(--accent-primary, #00d4aa);
    border-radius: 1px;
    pointer-events: none;
    transition: box-shadow var(--transition-fast, 0.15s);
  }

  .slider:hover .slider-edge {
    box-shadow: 0 0 0 1px var(--accent-glow, rgba(0, 212, 170, 0.3));
  }

  /* Mobile: taller row for finger-sized targets. The whole bar is the target,
     so no oversized thumb is needed any more. */
  :global(html[data-mobile='true']) .slider {
    height: var(--intrack-height-mobile, 30px);
  }
</style>

