<script>
  import { appState } from '../../state.svelte.js';

  let { onColorSelect = null } = $props();

  let panel = $state(null);
  let left = $state(null);
  let top = $state(null);
  let userPositioned = $state(false);
  let dragging = $state(false);

  const SPACING = 40;
  const PANEL_WIDTH = 168;
  const PANEL_HEIGHT = 180;
  const PANEL_MARGIN = 6;

  const POSITIONS = [
    { x: 0, y: 0 },
    { x: 0, y: -SPACING },
    { x: SPACING * 0.866, y: -SPACING * 0.5 },
    { x: SPACING * 0.866, y: SPACING * 0.5 },
    { x: 0, y: SPACING },
    { x: -SPACING * 0.866, y: SPACING * 0.5 },
    { x: -SPACING * 0.866, y: -SPACING * 0.5 }
  ];

  let visible = $derived(appState.recentPaletteVisible);

  let circles = $derived.by(() => {
    const centerX = PANEL_WIDTH / 2;
    const centerY = 100;

    return POSITIONS.map((pos, i) => ({
      x: centerX + pos.x,
      y: centerY + pos.y,
      color: i < appState.recentColors.length ? appState.recentColors[i] : null
    }));
  });

  function hidePanel() {
    appState.recentPaletteVisible = false;
  }

  function selectColor(color) {
    appState.currentColor = [...color];
    onColorSelect?.(color);
  }

  function clampValue(value, minValue, maxValue) {
    return Math.max(minValue, Math.min(value, maxValue));
  }

  function getBoardLayout() {
    const boards = panel?.parentElement || (
      typeof document !== 'undefined' ? document.getElementById('boards') : null
    );
    const width = boards?.clientWidth || boards?.getBoundingClientRect?.().width || PANEL_WIDTH + (PANEL_MARGIN * 2);
    const height = boards?.clientHeight || boards?.getBoundingClientRect?.().height || PANEL_HEIGHT + (PANEL_MARGIN * 2);
    const maxLeft = Math.max(PANEL_MARGIN, width - PANEL_WIDTH - PANEL_MARGIN);
    const maxTop = Math.max(PANEL_MARGIN, height - PANEL_HEIGHT - PANEL_MARGIN);

    return {
      safeLeft: PANEL_MARGIN,
      safeTop: PANEL_MARGIN,
      maxLeft,
      maxTop,
      dockLeft: maxLeft,
      dockTop: maxTop
    };
  }

  function syncPanelPosition(forceDock = false) {
    const bounds = getBoardLayout();

    if (forceDock || !userPositioned || left == null || top == null) {
      left = bounds.dockLeft;
      top = bounds.dockTop;
      return;
    }

    left = clampValue(left, bounds.safeLeft, bounds.maxLeft);
    top = clampValue(top, bounds.safeTop, bounds.maxTop);
  }

  function clampPanelPosition(nextLeft, nextTop) {
    const bounds = getBoardLayout();

    return {
      left: clampValue(nextLeft, bounds.safeLeft, bounds.maxLeft),
      top: clampValue(nextTop, bounds.safeTop, bounds.maxTop)
    };
  }

  function getBoardPointerScale() {
    const boards = panel?.parentElement;
    const rect = boards?.getBoundingClientRect?.();
    const localWidth = boards?.clientWidth || rect?.width || 1;
    const localHeight = boards?.clientHeight || rect?.height || 1;

    return {
      x: rect?.width ? localWidth / rect.width : 1,
      y: rect?.height ? localHeight / rect.height : 1
    };
  }

  function startDrag(event) {
    if (!visible || !panel) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const panelRect = panel.getBoundingClientRect();
    const startLeft = left ?? panel.offsetLeft ?? panelRect.left;
    const startTop = top ?? panel.offsetTop ?? panelRect.top;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerScale = getBoardPointerScale();
    dragging = true;
    document?.body?.classList?.add?.('floating-palette-dragging');

    const handleMove = (moveEvent) => {
      const next = clampPanelPosition(
        startLeft + ((moveEvent.clientX - startX) * pointerScale.x),
        startTop + ((moveEvent.clientY - startY) * pointerScale.y)
      );

      left = next.left;
      top = next.top;
      userPositioned = true;
    };

    const handleUp = () => {
      dragging = false;
      document?.body?.classList?.remove?.('floating-palette-dragging');
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  }

  $effect(() => {
    if (typeof window === 'undefined' || !panel || !visible) {
      return;
    }

    const sync = () => syncPanelPosition(!userPositioned);
    sync();

    window.addEventListener('resize', sync);
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    resizeObserver?.observe?.(panel.parentElement);

    return () => {
      window.removeEventListener('resize', sync);
      resizeObserver?.disconnect?.();
    };
  });

  function panelStyle() {
    const bounds = getBoardLayout();
    const resolvedLeft = left != null ? clampValue(left, bounds.safeLeft, bounds.maxLeft) : bounds.dockLeft;
    const resolvedTop = top != null ? clampValue(top, bounds.safeTop, bounds.maxTop) : bounds.dockTop;

    return [
      `width: ${PANEL_WIDTH}px`,
      `height: ${PANEL_HEIGHT}px`,
      `left: ${resolvedLeft}px`,
      `top: ${resolvedTop}px`,
      `display: ${visible ? 'block' : 'none'}`
    ].join('; ');
  }
</script>

<div
  bind:this={panel}
  id="floatingPalette"
  class="floating-palette"
  class:dragging
  style={panelStyle()}
  role="region"
  aria-label="Recent colors palette"
  aria-hidden={!visible}
>
  <div class="palette-grid">
    <button
      class="palette-handle"
      onpointerdown={startDrag}
      ondblclick={hidePanel}
      title="Drag to move - Double-click to hide"
    >
      <span class="grab-dots">::</span>
    </button>

    {#each circles as circle, i}
      {#if circle.color}
        <button
          class="color-dot"
          style="left: {circle.x}px; top: {circle.y}px; --dot-color: rgb({circle.color[0]}, {circle.color[1]}, {circle.color[2]})"
          title="Color {i + 1}"
          onpointerup={() => selectColor(circle.color)}
        ></button>
      {:else}
        <div
          class="color-dot empty"
          style="left: {circle.x}px; top: {circle.y}px"
        ></div>
      {/if}
    {/each}
  </div>
</div>

<style>
  :global(#floatingPaletteMount) {
    position: absolute;
    inset: 0;
    z-index: 1480;
    pointer-events: none;
  }

  :global(body.floating-palette-dragging),
  :global(body.floating-palette-dragging *) {
    cursor: none !important;
  }

  .floating-palette {
    position: absolute;
    z-index: 1480;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 0;
    background: transparent;
    border: none;
    overflow: visible;
    pointer-events: none;
    touch-action: none;
  }

  .palette-handle {
    position: absolute;
    width: 32px;
    height: 28px;
    border: 1px solid var(--bg-secondary);
    border-radius: 6px;
    background: var(--bg-secondary);
    color: rgba(255, 255, 255, 0.6);
    cursor: grab;
    pointer-events: auto;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    user-select: none;
    left: 50%;
    top: 10px;
    transform: translateX(-50%);
    z-index: 10;
  }

  .palette-handle:hover {
    background: var(--bg-secondary);
    border-color: var(--bg-secondary);
    color: rgba(255, 255, 255, 0.8);
  }

  .palette-handle:active {
    cursor: grabbing;
    background: var(--bg-secondary);
  }

  .grab-dots {
    font-weight: bold;
    font-size: 1.05rem;
    letter-spacing: -1px;
    transform: rotate(90deg);
  }

  .palette-grid {
    position: relative;
    width: 100%;
    height: 100%;
  }

  .color-dot {
    position: absolute;
    width: 36px;
    height: 36px;
    box-sizing: border-box;
    border-radius: 50%;
    border: none;
    padding: 0;
    margin: 0;
    background:
      radial-gradient(circle at 35% 30%, rgba(255, 255, 255, 0.18), transparent 34%),
      var(--dot-color);
    cursor: pointer;
    pointer-events: auto;
    transition: all 0.15s ease;
    transform: translate(-50%, -50%);
    box-shadow:
      0 0 0 5px var(--bg-secondary),
      0 2px 6px rgba(0, 0, 0, 0.3);
    background-clip: padding-box;
  }

  .color-dot:hover {
    z-index: 2;
    transform: translate(-50%, -50%) scale(1.12);
    box-shadow:
      0 0 0 5px var(--bg-secondary),
      0 3px 10px rgba(0, 0, 0, 0.4);
  }

  .color-dot:active {
    z-index: 3;
    transform: translate(-50%, -50%) scale(0.95);
  }

  .color-dot.empty {
    background: rgba(255, 255, 255, 0.08);
    box-shadow:
      0 0 0 5px var(--bg-secondary),
      0 2px 6px rgba(0, 0, 0, 0.22);
    cursor: default;
    pointer-events: none;
  }
</style>
