<script>
  import { onMount } from 'svelte';
  import { isTauriDesktop } from '../../platform/desktop.js';

  let {
    title = 'DDraw!',
    subtitle = '',
    branded = false,
    draggable = false,
    tauriDragRegion = false,
    showPopoutButton = false,
    onPopout = null,
    showModeToggle = false,
    mode = 'compact',
    onModeToggle = null,
    showWindowControls = false,
    showFullscreenButton = true,
    showCloseButton = true,
    onClose = null,
    onDragStart = null,
    className = ''
  } = $props();

  let desktopWindowApi = null;
  let desktopWindowState = $state({
    maximized: false,
    fullscreen: false
  });

  async function syncDesktopWindowState() {
    if (!desktopWindowApi) return;

    desktopWindowState = {
      maximized: await desktopWindowApi.isMaximized(),
      fullscreen: await desktopWindowApi.isFullscreen()
    };
  }

  async function minimizeWindow() {
    if (!desktopWindowApi) return;
    await desktopWindowApi.minimize();
  }

  async function toggleMaximizeWindow() {
    if (!desktopWindowApi) return;
    await desktopWindowApi.toggleMaximize();
    await syncDesktopWindowState();
  }

  async function toggleFullscreenWindow() {
    if (!desktopWindowApi) return;
    const nextFullscreen = !(await desktopWindowApi.isFullscreen());
    await desktopWindowApi.setFullscreen(nextFullscreen);
    await syncDesktopWindowState();
  }

  async function closeWindow() {
    if (typeof onClose === 'function') {
      onClose();
      return;
    }

    if (!desktopWindowApi) return;
    await desktopWindowApi.close();
  }

  function startManualWindowDrag(cursorScreenX, cursorScreenY, startPosition, scaleFactor, windowApi, minY) {
    const baseX = Math.round(startPosition.x);
    const baseY = Math.round(startPosition.y);

    let pendingX = baseX;
    let pendingY = baseY;
    let dirty = false;
    let inFlight = false;

    function flushPosition() {
      if (inFlight || !dirty) return;
      dirty = false;
      inFlight = true;
      windowApi.setPosition(new PhysicalPosition(pendingX, pendingY)).finally(() => {
        inFlight = false;
        if (dirty) requestAnimationFrame(flushPosition);
      });
    }

    const onMove = (moveEvent) => {
      const deltaX = (moveEvent.screenX - cursorScreenX) * scaleFactor;
      const deltaY = (moveEvent.screenY - cursorScreenY) * scaleFactor;
      pendingX = Math.round(baseX + deltaX);
      pendingY = Math.max(minY, Math.round(baseY + deltaY));
      if (!dirty) {
        dirty = true;
        requestAnimationFrame(flushPosition);
      }
    };

    const stop = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('blur', stop);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop, { once: true });
    window.addEventListener('blur', stop, { once: true });
  }

  async function beginWindowDrag(event) {
    if (!desktopWindowApi) return;

    const barRect = event.currentTarget?.getBoundingClientRect?.();
    const pointerRatio = barRect && barRect.width > 0
      ? Math.max(0, Math.min(1, (event.clientX - barRect.left) / barRect.width))
      : 0.5;
    const pointerOffsetY = barRect && barRect.height > 0
      ? Math.max(barRect.height * 0.5, Math.min(barRect.height, event.clientY - barRect.top))
      : 12;

    const isFullscreen = await desktopWindowApi.isFullscreen();
    const wasMaximized = isFullscreen ? false : await desktopWindowApi.isMaximized();

    if (isFullscreen || wasMaximized) {
      await desktopWindowApi.hide();

      if (isFullscreen) {
        await desktopWindowApi.setFullscreen(false);
      } else {
        await desktopWindowApi.toggleMaximize();
      }
      await syncDesktopWindowState();

      const [{ PhysicalPosition }, { cursorPosition, currentMonitor }] = await Promise.all([
        import('@tauri-apps/api/dpi'),
        import('@tauri-apps/api/window')
      ]);
      const [cursor, size, monitor, scaleFactor] = await Promise.all([
        cursorPosition(),
        desktopWindowApi.outerSize(),
        currentMonitor(),
        desktopWindowApi.scaleFactor()
      ]);

      if (cursor && size) {
        const monitorX = monitor?.position?.x ?? 0;
        const monitorY = monitor?.position?.y ?? 0;
        const monitorWidth = monitor?.size?.width ?? size.width;
        const monitorHeight = monitor?.size?.height ?? size.height;
        const maxX = monitorX + Math.max(0, monitorWidth - size.width);
        const maxY = monitorY + Math.max(0, monitorHeight - size.height);
        const nextX = Math.round(Math.max(monitorX, Math.min(maxX, cursor.x - (size.width * pointerRatio))));
        const nextY = Math.round(Math.max(monitorY, Math.min(maxY, cursor.y - pointerOffsetY)));
        const restoredPosition = new PhysicalPosition(nextX, nextY);
        await desktopWindowApi.setPosition(restoredPosition);
        await desktopWindowApi.show();
        startManualWindowDrag(cursor.x / scaleFactor, cursor.y / scaleFactor, restoredPosition, scaleFactor, desktopWindowApi, monitorY);
        return;
      }

      await desktopWindowApi.show();
      return;
    }

    await desktopWindowApi.startDragging();
  }

  function handleBarMouseDown(event) {
    if (event.target instanceof HTMLElement && event.target.closest('button')) return;
    if (tauriDragRegion && desktopWindowApi) {
      void beginWindowDrag(event);
      return;
    }
    if (draggable) onDragStart?.(event);
  }

  function handleBarDoubleClick(event) {
    if (event.target instanceof HTMLElement && event.target.closest('button')) return;
    if (showWindowControls) {
      void toggleMaximizeWindow();
    }
  }

  onMount(() => {
    if (!isTauriDesktop()) {
      return;
    }

    let unlistenResize = null;
    let active = true;

    void import('@tauri-apps/api/webviewWindow').then(async ({ getCurrentWebviewWindow }) => {
      if (!active) return;
      desktopWindowApi = getCurrentWebviewWindow();
      if (showWindowControls || tauriDragRegion) {
        await syncDesktopWindowState();
        unlistenResize = await desktopWindowApi.onResized(() => {
          void syncDesktopWindowState();
        });
      }
    });

    return () => {
      active = false;
      desktopWindowApi = null;
      unlistenResize?.();
    };
  });

  $effect(() => {
    if (!desktopWindowApi || (!showWindowControls && !tauriDragRegion)) return;
    void syncDesktopWindowState();
  });
</script>

<header
  class={`window-titlebar ${branded ? 'branded' : 'plain'} ${className}`.trim()}
  onmousedown={handleBarMouseDown}
  ondblclick={handleBarDoubleClick}
  role="presentation"
  aria-label="Window header"
>
  <div class="titlebar-copy">
    {#if branded}
      <p class="titlebar-brand">{title}</p>
      {#if subtitle}
        <span class="titlebar-subtitle">{subtitle}</span>
      {/if}
    {:else}
      <p class="titlebar-title">{title}</p>
      {#if subtitle}
        <span class="titlebar-subtitle">{subtitle}</span>
      {/if}
    {/if}
  </div>

  <div class="titlebar-actions">
    {#if showPopoutButton}
      <button class="titlebar-btn" onclick={onPopout} title="Open chat in a separate window" type="button">Pop Out</button>
    {/if}

    {#if showModeToggle}
      <button
        class="titlebar-btn"
        onclick={onModeToggle}
        title={mode === 'full' ? 'Use compact mode' : 'Use full mode'}
        type="button"
      >
        {mode === 'full' ? 'Small' : 'Full'}
      </button>
    {/if}

    {#if showWindowControls}
      <button class="titlebar-btn chrome-btn" onclick={minimizeWindow} title="Minimize window" type="button" aria-label="Minimize">
        <span class="window-icon minimize-icon" aria-hidden="true"></span>
      </button>

      <button
        class="titlebar-btn chrome-btn"
        onclick={toggleMaximizeWindow}
        title={desktopWindowState.maximized ? 'Restore window' : 'Maximize window'}
        type="button"
        aria-label={desktopWindowState.maximized ? 'Restore window' : 'Maximize window'}
      >
        <span class={`window-icon maximize-icon ${desktopWindowState.maximized ? 'restored' : ''}`.trim()} aria-hidden="true"></span>
      </button>

      {#if showFullscreenButton}
        <button
          class="titlebar-btn chrome-btn"
          onclick={toggleFullscreenWindow}
          title={desktopWindowState.fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          type="button"
          aria-label={desktopWindowState.fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          <span class={`window-icon fullscreen-icon ${desktopWindowState.fullscreen ? 'active' : ''}`.trim()} aria-hidden="true"></span>
        </button>
      {/if}

      <button class="titlebar-btn chrome-btn close-btn" onclick={closeWindow} title="Close window" type="button" aria-label="Close window">
        <span class="close-glyph" aria-hidden="true">&times;</span>
      </button>
    {:else if showCloseButton}
      <button class="titlebar-btn close-btn" onclick={onClose} title="Close chat" type="button">&times;</button>
    {/if}
  </div>
</header>

<style>
  .window-titlebar {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.45rem;
    min-height: 28px;
    padding: 2px 0 2px 0.3rem;
    border-bottom: 1px solid var(--border-subtle);
    background: color-mix(in srgb, var(--bg-elevated) 56%, #1a1f29);
    color: var(--text-primary);
    user-select: none;
  }

  .app-window-titlebar {
    min-height: var(--desktop-titlebar-height);
    height: var(--desktop-titlebar-height);
  }

  .window-titlebar.branded {
    background:
      linear-gradient(180deg, rgba(48, 54, 68, 0.98) 0%, rgba(40, 45, 57, 0.96) 100%);
  }

  .titlebar-copy {
    min-width: 0;
    flex: 1 1 auto;
  }

  .titlebar-brand {
    margin: 0;
    font-family: 'Fredoka', sans-serif;
    font-size: 1.2rem;
    font-weight: 700;
    color: #00d4aa;
    letter-spacing: 0.01em;
    transform: translateY(2px) rotate(-2deg);
    transform-origin: left center;
    line-height: 0.92;
  }

  .titlebar-title {
    margin: 0;
    color: color-mix(in srgb, var(--accent-primary) 58%, var(--text-primary));
    font-size: 0.56rem;
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    line-height: 1;
  }

  .titlebar-subtitle {
    display: inline-block;
    margin-top: 0.08rem;
    color: var(--text-secondary);
    font-size: 0.62rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.1;
  }

  .window-titlebar.branded .titlebar-subtitle {
    display: block;
    margin-top: 0.12rem;
    font-size: 0.58rem;
  }

  .titlebar-actions {
    display: flex;
    gap: 0;
    align-self: stretch;
    align-items: stretch;
    flex-shrink: 0;
  }

  .titlebar-btn {
    align-self: stretch;
    min-height: 100%;
    height: 100%;
    margin: 0;
    padding: 0 0.72rem;
    border: 0;
    border-radius: 0;
    background: color-mix(in srgb, var(--bg-elevated) 82%, transparent);
    color: var(--text-primary);
    font-size: 0.68rem;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease;
  }

  .titlebar-btn:hover {
    background: color-mix(in srgb, var(--accent-primary) 18%, var(--bg-elevated));
    color: var(--text-primary);
    transform: translateY(-1px);
  }

  .chrome-btn {
    display: grid;
    place-items: center;
    width: 28px;
    min-width: 28px;
    min-height: 100%;
    padding: 0;
  }

  .close-btn {
    width: 28px;
    min-width: 28px;
    min-height: 100%;
    padding: 0;
  }

  .close-btn:hover {
    background: color-mix(in srgb, #ff6b6b 24%, var(--bg-elevated));
    color: white;
  }

  .window-icon {
    position: relative;
    display: block;
    width: 14px;
    height: 14px;
    color: currentColor;
  }

  .window-icon::before,
  .window-icon::after {
    content: '';
    position: absolute;
    box-sizing: border-box;
  }

  .minimize-icon::before {
    left: 1px;
    right: 1px;
    bottom: 4px;
    border-top: 2px solid currentColor;
  }

  .maximize-icon::before {
    inset: 2px 1px 2px 1px;
    border: 1.8px solid currentColor;
    border-top-width: 2.6px;
    border-radius: 1px;
  }

  .maximize-icon.restored::before {
    inset: 4px 1px 1px 4px;
    border: 1.8px solid currentColor;
    border-top-width: 2.4px;
    border-radius: 1px;
  }

  .maximize-icon.restored::after {
    inset: 1px 4px 4px 1px;
    border: 1.8px solid currentColor;
    border-top-width: 2.4px;
    border-radius: 1px;
    background: color-mix(in srgb, var(--bg-elevated) 82%, transparent);
  }

  .fullscreen-icon::before {
    top: 1px;
    right: 1px;
    width: 6px;
    height: 6px;
    border-top: 2px solid currentColor;
    border-right: 2px solid currentColor;
  }

  .fullscreen-icon::after {
    left: 1px;
    bottom: 1px;
    width: 6px;
    height: 6px;
    border-left: 2px solid currentColor;
    border-bottom: 2px solid currentColor;
  }

  .fullscreen-icon {
    box-shadow:
      8px -8px 0 -6px currentColor,
      -8px 8px 0 -6px currentColor;
  }

  .fullscreen-icon.active {
    transform: scale(0.92);
  }

  .close-glyph {
    font-size: 1.45rem;
    font-weight: 500;
    line-height: 1;
  }

  @media (max-width: 700px) {
    .window-titlebar {
      padding-left: 0.22rem;
      padding-right: 0.22rem;
    }

    .titlebar-btn {
      min-width: 32px;
      padding: 0 0.62rem;
    }
  }
</style>
