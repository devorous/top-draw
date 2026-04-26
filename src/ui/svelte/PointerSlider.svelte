<script>
  let {
    value = 0,
    min = 0,
    max = 100,
    step = 1,
    ariaLabel = 'Slider',
    onChange = null
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

  function updateValueFromPointer(event) {
    if (!containerElement) return;

    const rect = containerElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const percent = Math.max(0, Math.min(1, x / rect.width));

    let newValue = min + percent * (max - min);

    // Apply step rounding
    if (step) {
      newValue = Math.round(newValue / step) * step;
    }

    commitValue(newValue);
  }

  function handlePointerDown(event) {
    isDragging = true;
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
  }

  function handlePointerCancel(event) {
    isDragging = false;
    containerElement?.releasePointerCapture(event.pointerId);
  }

  function handleClick(event) {
    updateValueFromPointer(event);
  }

  function handleKeyDown(event) {
    const stepSize = step || 1;
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

  const percent = $derived(((displayValue - min) / (max - min)) * 100);
</script>

<div class="slider" bind:this={containerElement} role="slider" aria-label={ariaLabel} aria-valuemin={min} aria-valuemax={max} aria-valuenow={displayValue} tabindex="0" onpointerdown={handlePointerDown} onpointermove={handlePointerMove} onpointerup={handlePointerUp} onpointercancel={handlePointerCancel} onclick={handleClick} onkeydown={handleKeyDown}>
  <div class="slider-fill" style="width: {percent}%"></div>
  <div class="slider-thumb" style="--thumb-position: {percent}%"></div>
</div>

<style>
  .slider {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 6px;
    background: var(--bg-elevated, rgba(255, 255, 255, 0.1));
    border-radius: 3px;
    outline: none;
    cursor: pointer;
    touch-action: none;
    position: relative;
    display: flex;
    align-items: center;
    margin: 0;
    padding: 0;
  }

  .slider-fill {
    position: absolute;
    height: 100%;
    background: var(--accent-primary, #00d4aa);
    border-radius: 3px;
    pointer-events: none;
    left: 0;
    top: 0;
  }

  .slider-thumb {
    position: absolute;
    width: 16px;
    height: 16px;
    background: var(--accent-primary, #00d4aa);
    border-radius: 4px;
    top: 50%;
    left: calc(var(--thumb-position, 50%) - 8px);
    transform: translateY(-50%);
    pointer-events: none;
    transition: transform var(--transition-fast, 0.15s), box-shadow var(--transition-fast, 0.15s);
  }

  .slider:hover .slider-thumb {
    transform: translateY(-50%) scale(1.2);
    box-shadow: 0 0 0 4px var(--accent-glow, rgba(0, 212, 170, 0.25));
  }
</style>
