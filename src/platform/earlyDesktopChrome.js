function isDesktopApp() {
  return typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI_METADATA__);
}

async function initEarlyDesktopChrome() {
  if (!isDesktopApp()) return;

  const mount = document.getElementById('desktopTitlebarMount');
  if (!mount || mount.dataset.chromeInitialized === 'true') return;

  mount.dataset.chromeInitialized = 'true';
  mount.dataset.earlyChrome = 'true';

  const { getCurrentWebviewWindow, WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const [{ PhysicalPosition, PhysicalSize }, { cursorPosition, currentMonitor }] = await Promise.all([
    import('@tauri-apps/api/dpi'),
    import('@tauri-apps/api/window')
  ]);

  const appWindow = getCurrentWebviewWindow();
  let dragOverlayWindow = null;

  async function syncState() {
    const maximized = await appWindow.isMaximized();
    const fullscreen = await appWindow.isFullscreen();
    mount.dataset.maximized = maximized ? 'true' : 'false';
    mount.dataset.fullscreen = fullscreen ? 'true' : 'false';
  }

  async function createDragOverlay(monitor) {
    if (dragOverlayWindow) {
      try {
        await dragOverlayWindow.show();
        return;
      } catch (e) {
        dragOverlayWindow = null;
      }
    }

    const monitorWidth = monitor?.size?.width ?? 1920;
    const monitorHeight = monitor?.size?.height ?? 1080;
    const monitorX = monitor?.position?.x ?? 0;
    const monitorY = monitor?.position?.y ?? 0;

    const overlayHTML = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body {
              margin: 0;
              padding: 0;
              width: 100vw;
              height: 100vh;
              background: rgba(255, 0, 0, 0.1);
              cursor: default;
            }
          </style>
        </head>
        <body></body>
      </html>
    `;

    try {
      dragOverlayWindow = new WebviewWindow('drag-overlay', {
        url: 'data:text/html,' + encodeURIComponent(overlayHTML),
        title: 'Drag Overlay',
        x: monitorX,
        y: monitorY,
        width: monitorWidth,
        height: monitorHeight,
        skipTaskbar: true,
        decorations: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        fullscreen: false,
        focus: false,
        visible: false
      });

      await dragOverlayWindow.once('tauri://created', async () => {
        await dragOverlayWindow.setIgnoreCursorEvents(true);
        await dragOverlayWindow.show();
      });
    } catch (error) {
      console.error('Failed to create drag overlay:', error);
    }
  }

  async function hideDragOverlay() {
    if (dragOverlayWindow) {
      try {
        await dragOverlayWindow.hide();
      } catch (e) {
        dragOverlayWindow = null;
      }
    }
  }

  function startManualWindowDrag(cursorScreenX, cursorScreenY, startPosition, scaleFactor, minY) {
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
      appWindow.setPosition(new PhysicalPosition(pendingX, pendingY)).finally(() => {
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
      void hideDragOverlay();
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop, { once: true });
    window.addEventListener('blur', stop, { once: true });
  }

  async function beginWindowDrag(event) {
    const bar = mount.querySelector('.desktop-titlebar-fallback');
    const barRect = bar?.getBoundingClientRect?.();
    const pointerRatio = barRect && barRect.width > 0
      ? Math.max(0, Math.min(1, (event.clientX - barRect.left) / barRect.width))
      : 0.5;
    const pointerOffsetY = barRect && barRect.height > 0
      ? Math.max(barRect.height * 0.5, Math.min(barRect.height, event.clientY - barRect.top))
      : 12;

    const isFullscreen = await appWindow.isFullscreen();
    const wasMaximized = isFullscreen ? false : await appWindow.isMaximized();

    if (isFullscreen || wasMaximized) {
      const monitor = await currentMonitor();
      await createDragOverlay(monitor);
      await appWindow.hide();

      if (isFullscreen) {
        await appWindow.setFullscreen(false);
      } else {
        await appWindow.toggleMaximize();
      }
      await syncState();

      const [cursor, size, scaleFactor] = await Promise.all([
        cursorPosition(),
        appWindow.outerSize(),
        appWindow.scaleFactor()
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
        await appWindow.setPosition(restoredPosition);
        await appWindow.show();
        startManualWindowDrag(cursor.x / scaleFactor, cursor.y / scaleFactor, restoredPosition, scaleFactor, monitorY);
        return;
      }

      await appWindow.show();
      await hideDragOverlay();
      return;
    }

    await appWindow.startDragging();
  }

  mount.addEventListener('click', (event) => {
    const button = event.target instanceof HTMLElement ? event.target.closest('[data-window-action]') : null;
    if (!button) return;

    const action = button.getAttribute('data-window-action');
    if (action === 'minimize') {
      void appWindow.minimize();
      return;
    }
    if (action === 'maximize') {
      void appWindow.toggleMaximize().then(syncState);
      return;
    }
    if (action === 'fullscreen') {
      void appWindow.isFullscreen().then((fullscreen) => appWindow.setFullscreen(!fullscreen).then(syncState));
      return;
    }
    if (action === 'close') {
      void appWindow.close();
    }
  });

  mount.addEventListener('mousedown', (event) => {
    if (event.target instanceof HTMLElement && event.target.closest('[data-window-action]')) return;
    event.preventDefault();
    void beginWindowDrag(event);
  });

  mount.addEventListener('dblclick', (event) => {
    if (event.target instanceof HTMLElement && event.target.closest('[data-window-action]')) return;
    void appWindow.toggleMaximize().then(syncState);
  });

  const unlistenResize = await appWindow.onResized(() => {
    void syncState();
  });

  window.addEventListener('beforeunload', () => {
    unlistenResize?.();
  }, { once: true });

  await syncState();
}

void initEarlyDesktopChrome();
