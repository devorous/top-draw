<script>
  import { appState } from '../../state.svelte.js';

  let {
    panelId = 'boardColorPickerPanel',
    pickerId = 'boardColorPicker',
    ariaLabel = 'Board color picker',
    hideLabel = 'Hide color picker',
    moveLabel = 'Move color picker',
    resizeLabel = 'Resize color picker'
  } = $props();

  let panel = $state(null);
  let left = $state(null);
  let top = $state(null);
  let right = $state(1);
  let bottom = $state(1);
  let width = $state(116);
  let isCompactViewport = $state(false);

  let visible = $derived(
    appState.boardColorPickerVisible &&
    (appState.boardColorPickerForceVisible || isCompactViewport)
  );

  $effect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia('(max-width: 768px), (max-height: 650px)');
    const updateViewportState = () => {
      isCompactViewport = mediaQuery.matches;
    };

    updateViewportState();
    mediaQuery.addEventListener?.('change', updateViewportState);
    mediaQuery.addListener?.(updateViewportState);

    return () => {
      mediaQuery.removeEventListener?.('change', updateViewportState);
      mediaQuery.removeListener?.(updateViewportState);
    };
  });

  function getHost() {
    return panel?.closest('#boardContainer') || panel?.parentElement || null;
  }

  function clampPanel(nextLeft, nextTop, nextWidth = width) {
    const host = getHost();
    if (!host) {
      return { left: nextLeft, top: nextTop };
    }

    const hostRect = host.getBoundingClientRect();
    const panelHeight = panel?.offsetHeight || 220;
    const margin = 1;

    return {
      left: Math.max(margin, Math.min(nextLeft, hostRect.width - nextWidth - margin)),
      top: Math.max(margin, Math.min(nextTop, hostRect.height - panelHeight - margin))
    };
  }

  function startDrag(event) {
    if (!visible || !panel) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const startLeft = left ?? panel.offsetLeft;
    const startTop = top ?? panel.offsetTop;
    const startX = event.clientX;
    const startY = event.clientY;

    const handleMove = (moveEvent) => {
      const next = clampPanel(
        startLeft + moveEvent.clientX - startX,
        startTop + moveEvent.clientY - startY
      );

      left = next.left;
      top = next.top;
      right = null;
      bottom = null;
    };

    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  }

  function startResize(event) {
    if (!visible || !panel) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const host = getHost();
    const hostRect = host?.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const startWidth = width || panel.offsetWidth;
    const startRight = hostRect ? Math.max(1, hostRect.right - panelRect.right) : 1;
    const startBottom = hostRect ? Math.max(1, hostRect.bottom - panelRect.bottom) : 1;
    const startX = event.clientX;
    const startY = event.clientY;

    const handleMove = (moveEvent) => {
      if (!hostRect) return;

      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      const delta = (deltaX + deltaY) / 2;
      const maxWidth = Math.max(96, Math.min(236, hostRect.width - startRight - 1));
      const nextWidth = Math.max(96, Math.min(maxWidth, startWidth - delta));

      width = nextWidth;
      left = null;
      top = null;
      right = startRight;
      bottom = startBottom;
    };

    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  }

  function hidePanel() {
    appState.boardColorPickerVisible = false;
    appState.boardColorPickerForceVisible = false;
  }

  function panelStyle() {
    const parts = [`width: ${width}px`, `display: ${visible ? 'block' : 'none'}`];

    if (left != null && top != null) {
      parts.push(`left: ${left}px`, `top: ${top}px`, 'right: auto', 'bottom: auto');
    } else {
      parts.push(`right: ${right ?? 1}px`, `bottom: ${bottom ?? 1}px`, 'left: auto', 'top: auto');
    }

    return parts.join('; ');
  }
</script>

<div
  bind:this={panel}
  id={panelId}
  class="boardColorPickerPanel"
  aria-label={ariaLabel}
  aria-hidden={!visible}
  role="presentation"
  style={panelStyle()}
>
  <button
    type="button"
    class="boardColorPickerHideButton"
    title={hideLabel}
    aria-label={hideLabel}
    onclick={hidePanel}
    onpointerdown={(event) => event.stopPropagation()}
  >
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  <button
    type="button"
    class="boardColorPickerScaleHandle"
    title={resizeLabel}
    aria-label={resizeLabel}
    onclick={(event) => event.preventDefault()}
    onpointerdown={startResize}
  ></button>

  <button
    type="button"
    class="boardColorPickerDragHandle"
    title={moveLabel}
    aria-label={moveLabel}
    onpointerdown={startDrag}
  ></button>

  <div id={pickerId} class="boardColorPicker"></div>
</div>

<style>
  .boardColorPickerHideButton {
    position: absolute;
    top: 1px;
    right: 1px;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: color-mix(in srgb, var(--bg-secondary) 94%, black);
    color: color-mix(in srgb, var(--text-secondary) 78%, transparent);
    cursor: pointer;
    box-shadow: 0 1px 4px color-mix(in srgb, black 28%, transparent);
    z-index: 5;
    display: grid;
    place-items: center;
    transition: transform var(--transition-fast), color var(--transition-fast), background var(--transition-fast);
  }

  .boardColorPickerHideButton:hover {
    transform: translateY(-1px);
    color: var(--text-primary);
    background: color-mix(in srgb, var(--bg-secondary) 88%, black);
  }

  .boardColorPickerHideButton:active {
    transform: translateY(0);
  }
</style>