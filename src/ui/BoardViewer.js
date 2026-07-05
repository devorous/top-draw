import { isTauriDesktop } from '../platform/desktop.js';
import { isMobile } from '../platform/mobile.js';
import { bindPressAction } from '../utils/buttonBinding.js';

const AUTO_SHOW_ZOOM = 1.5;
const MIN_VIEW_ZOOM = 0.05;
const MAX_VIEW_ZOOM = 8;
const TAURI_CHANNEL_NAME = 'ddraw-board-viewer-popout';
const TAURI_FRAME_INTERVAL_MS = 1000 / 12;
const FRAME_RATE_KEY = 'boardViewerFrameRate';
const DEFAULT_FRAME_RATE = 60;
const MIN_FRAME_RATE = 5;
const MAX_FRAME_RATE = 144;
const INTERACTION_RENDER_GRACE_MS = 120;
const VIEWPORT_BACKGROUND = '#121212';

export class BoardViewer {
  constructor(app) {
    this.app = app;
    this.board = app.board;
    this.visible = false;
    this.manualVisible = false;
    this.enabled = localStorage.getItem('boardViewerEnabled') !== 'false';
    this.viewZoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.followUserId = null;
    this.rafId = null;
    this.popout = null;
    this.tauriPopoutWindow = null;
    this.tauriChannel = null;
    this.tauriFrameCanvas = null;
    this.tauriFrameCtx = null;
    this._lastTauriFrameAt = 0;
    this._tauriFrameInFlight = false;
    this._dragState = null;
    this._moveState = null;
    this._resizeState = null;
    this._popoutDragState = null;
    this.frameRate = this._loadFrameRate();
    this._lastRenderAt = 0;
    this._lastMainZoomAutoVisible = false;
    this._interactiveRenderUntil = 0;
  }

  _loadFrameRate() {
    const raw = Number(localStorage.getItem(FRAME_RATE_KEY));
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_FRAME_RATE;
    if (raw === 30) return DEFAULT_FRAME_RATE;
    return Math.min(MAX_FRAME_RATE, Math.max(MIN_FRAME_RATE, raw));
  }

  setFrameRate(fps) {
    const value = Number(fps);
    const clamped = Number.isFinite(value)
      ? Math.min(MAX_FRAME_RATE, Math.max(MIN_FRAME_RATE, value))
      : DEFAULT_FRAME_RATE;
    this.frameRate = clamped;
    localStorage.setItem(FRAME_RATE_KEY, String(clamped));
  }

  getFrameRate() {
    return this.frameRate;
  }

  init() {
    // Board View is desktop-only: never build the panel, launch button or
    // zoom auto-show on mobile (setMainZoom early-returns when !enabled).
    if (isMobile()) {
      this.enabled = false;
      return;
    }
    this._build();
    this._fitToPanel();
    this._bind();
    this._updateLaunchButton();
  }

  destroy() {
    this._stopTick();
    this.popout?.close?.();
    this.tauriChannel?.close?.();
    this.tauriPopoutWindow?.close?.();
    this._releaseTauriFrameCanvas();
    this.el?.remove();
    this.launchButton?.remove();
  }

  _scheduleTick() {
    if (this.rafId != null) return;
    this.rafId = requestAnimationFrame((now) => this._tick(now));
  }

  _markInteractiveRender(now = performance.now()) {
    this._interactiveRenderUntil = Math.max(
      this._interactiveRenderUntil,
      now + INTERACTION_RENDER_GRACE_MS
    );
    this._scheduleTick();
  }

  requestLiveRender(now = performance.now()) {
    this._markInteractiveRender(now);
  }

  _stopTick() {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  _releaseTauriFrameCanvas() {
    if (this.tauriFrameCanvas) {
      this.tauriFrameCanvas.width = 0;
      this.tauriFrameCanvas.height = 0;
    }
    this.tauriFrameCanvas = null;
    this.tauriFrameCtx = null;
  }


  setMainZoom(zoom) {
    if (!this.enabled) return;

    if (this.isPopoutOpen()) {
      this._setPanelVisible(false);
      return;
    }

    const autoVisible = zoom > AUTO_SHOW_ZOOM;
    const shouldShow = autoVisible || this.manualVisible || this.followUserId;
    const visibilityChanged = shouldShow !== this.visible;
    const crossedAutoThreshold = autoVisible !== this._lastMainZoomAutoVisible;
    this._lastMainZoomAutoVisible = autoVisible;

    if (shouldShow) {
      if (visibilityChanged || crossedAutoThreshold) {
        this.show({ manual: this.manualVisible });
      } else {
        this._scheduleTick();
      }
    } else {
      this.hide({ clearManual: false });
    }
  }

  spectateUser(userId) {
    if (!this.enabled) return;
    this.followUserId = Number(userId);
    this.manualVisible = true;
    this.show({ manual: true });
    this._centerOnUser(this.followUserId, this.stage);
  }

  show({ manual = false } = {}) {
    if (!this.enabled) return;
    if (manual) this.manualVisible = true;
    if (this.isPopoutOpen()) {
      this._setPanelVisible(false);
      return;
    }
    const becameVisible = this._setPanelVisible(true);
    if (becameVisible) {
      this._fitToPanel(false, this.stage);
    }
  }

  hide({ clearManual = true } = {}) {
    if (clearManual) this.manualVisible = false;
    this.followUserId = null;
    this._setPanelVisible(false);
  }

  isPopoutOpen() {
    return !!(this.popout && !this.popout.closed) || !!this.tauriPopoutWindow;
  }

  _setPanelVisible(visible) {
    visible = !!visible;
    if (this.visible === visible) {
      if (visible) this._scheduleTick();
      return false;
    }
    this.visible = visible;
    this.el.hidden = !this.visible;
    this.el.classList.toggle('is-visible', this.visible);
    this._updateLaunchButton();
    if (this.visible) {
      this._scheduleTick();
    } else if (!this.isPopoutOpen() && !this.tauriPopoutWindow) {
      this._stopTick();
    }
    return true;
  }

  _updateLaunchButton() {
    const shouldShow = this.enabled && !this.visible && !this.isPopoutOpen();
    this.launchButton.hidden = !shouldShow;
  }

  setEnabled(enabled) {
    if (enabled && isMobile()) return; // unavailable on mobile — UI never built
    this.enabled = enabled;
    localStorage.setItem('boardViewerEnabled', enabled ? 'true' : 'false');
    if (!enabled) {
      this.hide();
      this.popout?.close?.();
      this.tauriPopoutWindow?.close?.();
      this._releaseTauriFrameCanvas();
      this._stopTick();
    }
    this._updateLaunchButton();
  }

  _build() {
    this.launchButton = document.createElement('button');
    this.launchButton.type = 'button';
    this.launchButton.className = 'boardViewerLaunch';
    this.launchButton.dataset.tut = 'add-view';
    this.launchButton.textContent = 'Add view';
    this.launchButton.title = 'Show board view';

    this.el = document.createElement('section');
    this.el.className = 'boardViewer';
    this.el.dataset.tut = 'board-view-controls';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="boardViewerHeader">
        <span class="boardViewerTitle">Board View</span>
        <div class="boardViewerActions">
          <button type="button" data-action="disable" class="boardViewerDisableBtn" title="Disable board view">Disable</button>
          <button type="button" data-action="popout" title="Open in separate window">&nearr;</button>
          <button type="button" data-action="close" title="Close">&times;</button>
        </div>
      </div>
      <div class="boardViewerStage" data-tut="board-view-controls">
        <canvas class="boardViewerCanvas"></canvas>
      </div>
      <div class="boardViewerControls" data-tut="board-view-controls">
        <button type="button" data-action="zoomOut" title="Zoom out">-</button>
        <button type="button" data-action="reset" title="Fit board">100%</button>
        <button type="button" data-action="zoomIn" title="Zoom in">+</button>
      </div>
      <div class="boardViewerResize" title="Resize"></div>
    `;

    this.stage = this.el.querySelector('.boardViewerStage');
    this.canvas = this.el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.zoomLabel = this.el.querySelector('[data-action="reset"]');
    document.body.append(this.launchButton, this.el);
  }

  _bind() {
    bindPressAction(this.launchButton, () => this.show({ manual: true }));

    const closeBtn = this.el.querySelector('[data-action="close"]');
    const popoutBtn = this.el.querySelector('[data-action="popout"]');
    const disableBtn = this.el.querySelector('[data-action="disable"]');

    bindPressAction(closeBtn, () => this.hide());
    bindPressAction(popoutBtn, () => this.openPopout());
    bindPressAction(disableBtn, () => this.setEnabled(false));

    this._bindControls(this.el.querySelector('.boardViewerControls'));
    this._bindPanZoomStage(this.stage, () => this.stage);
    this._bindPanelMove();

    const resizeHandle = this.el.querySelector('.boardViewerResize');
    resizeHandle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      resizeHandle.setPointerCapture(event.pointerId);
      const rect = this.el.getBoundingClientRect();
      this._resizeState = {
        x: event.clientX,
        y: event.clientY,
        width: rect.width,
        height: rect.height,
        left: rect.left,
        top: rect.top
      };
    });
    resizeHandle.addEventListener('pointermove', (event) => {
      if (!this._resizeState) return;
      const maxWidth = Math.max(240, window.innerWidth - this._resizeState.left);
      const maxHeight = Math.max(200, window.innerHeight - this._resizeState.top);
      const width = Math.min(maxWidth, Math.max(240, this._resizeState.width + event.clientX - this._resizeState.x));
      const height = Math.min(maxHeight, Math.max(200, this._resizeState.height + event.clientY - this._resizeState.y));
      this.el.style.width = `${width}px`;
      this.el.style.height = `${height}px`;
    });
    resizeHandle.addEventListener('pointerup', () => { this._resizeState = null; });
    resizeHandle.addEventListener('pointercancel', () => { this._resizeState = null; });
  }

  _bindPanelMove() {
    const header = this.el.querySelector('.boardViewerHeader');
    header.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      event.preventDefault();
      header.setPointerCapture(event.pointerId);
      const panelRect = this.el.getBoundingClientRect();
      this._moveState = {
        x: event.clientX,
        y: event.clientY,
        left: panelRect.left,
        top: panelRect.top
      };
      this.el.classList.add('is-moving');
    });
    header.addEventListener('pointermove', (event) => {
      if (!this._moveState) return;
      const panelRect = this.el.getBoundingClientRect();
      const nextLeft = this._moveState.left + event.clientX - this._moveState.x;
      const nextTop = this._moveState.top + event.clientY - this._moveState.y;
      this.el.style.left = `${Math.min(Math.max(0, nextLeft), Math.max(0, window.innerWidth - panelRect.width))}px`;
      this.el.style.top = `${Math.min(Math.max(0, nextTop), Math.max(0, window.innerHeight - panelRect.height))}px`;
    });
    const endMove = () => {
      this._moveState = null;
      this.el.classList.remove('is-moving');
    };
    header.addEventListener('pointerup', endMove);
    header.addEventListener('pointercancel', endMove);
  }

  _bindControls(controlsEl, getStage = () => this.stage) {
    controlsEl?.addEventListener('click', (event) => {
      const action = event.target.closest('button')?.dataset.action;
      if (!action) return;
      this._markInteractiveRender();
      if (action === 'zoomIn') this._zoomAt(this.viewZoom * 1.2, null, null, getStage());
      if (action === 'zoomOut') this._zoomAt(this.viewZoom / 1.2, null, null, getStage());
      if (action === 'reset') this._fitToPanel(true, getStage());
    });
  }

  _bindPanZoomStage(stageEl, getStage = () => stageEl, dragKey = '_dragState') {
    stageEl.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      stageEl.setPointerCapture(event.pointerId);
      this[dragKey] = { x: event.clientX, y: event.clientY, panX: this.panX, panY: this.panY };
    });
    stageEl.addEventListener('pointermove', (event) => {
      const dragState = this[dragKey];
      if (!dragState) return;
      this.panX = dragState.panX + event.clientX - dragState.x;
      this.panY = dragState.panY + event.clientY - dragState.y;
      this.followUserId = null;
      this._markInteractiveRender(event.timeStamp || performance.now());
    });
    stageEl.addEventListener('pointerup', () => { this[dragKey] = null; });
    stageEl.addEventListener('pointercancel', () => { this[dragKey] = null; });
    stageEl.addEventListener('wheel', (event) => {
      event.preventDefault();
      this._zoomAt(this.viewZoom * Math.pow(2, -event.deltaY / 360), event.offsetX, event.offsetY, getStage());
      this.followUserId = null;
      this._markInteractiveRender(event.timeStamp || performance.now());
    }, { passive: false });
  }

  _fitToPanel(clearFollow = false, stage = this.stage) {
    if (!stage) return;
    const [height, width] = this.board.dimensions;
    const rect = stage.getBoundingClientRect();
    this.viewZoom = Math.min(rect.width / width, rect.height / height);
    this.panX = (rect.width - width * this.viewZoom) / 2;
    this.panY = (rect.height - height * this.viewZoom) / 2;
    if (clearFollow) this.followUserId = null;
  }

  _zoomAt(nextZoom, pivotX = null, pivotY = null, stage = this.stage) {
    const rect = stage.getBoundingClientRect();
    const px = pivotX ?? rect.width / 2;
    const py = pivotY ?? rect.height / 2;
    const oldZoom = this.viewZoom;
    const clamped = Math.max(MIN_VIEW_ZOOM, Math.min(MAX_VIEW_ZOOM, nextZoom));
    const boardX = (px - this.panX) / oldZoom;
    const boardY = (py - this.panY) / oldZoom;
    this.viewZoom = clamped;
    this.panX = px - boardX * clamped;
    this.panY = py - boardY * clamped;
  }

  _centerOnUser(userId, stage = this.stage) {
    const user = this.app.users.get(Number(userId));
    if (!user || !stage) return;
    const rect = stage.getBoundingClientRect();
    this.panX = rect.width / 2 - user.x * this.viewZoom;
    this.panY = rect.height / 2 - user.y * this.viewZoom;
  }

  _tick(now = performance.now()) {
    this.rafId = null;
    const renderingPanel = this.visible;
    const sendingTauri = !!this.tauriPopoutWindow;

    if (!renderingPanel && !sendingTauri) return;

    const interactiveRender = now < this._interactiveRenderUntil;
    const minInterval = interactiveRender ? 0 : 1000 / this.frameRate;
    if (minInterval > 0 && now - this._lastRenderAt + 0.5 < minInterval) {
      this._scheduleTick();
      return;
    }
    this._lastRenderAt = now;

    if (renderingPanel) this._renderTo(this.canvas, this.ctx, this.stage, this.zoomLabel);
    if (sendingTauri) this._sendTauriFrame(now);

    this._scheduleTick();
  }

  _renderTo(canvas, ctx, stage, zoomLabel = null) {
    if (!canvas || !ctx || !stage) return;
    const rect = stage.getBoundingClientRect();
    const baseDpr = window.devicePixelRatio || 1;
    // When zoomed out, the source board is being downscaled anyway — drop DPR
    // so we fill fewer destination pixels per frame. Caps at 1x at viewZoom <= 1/baseDpr.
    const dpr = this.viewZoom >= 1
      ? baseDpr
      : Math.min(baseDpr, Math.max(1, baseDpr * this.viewZoom));
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.imageSmoothingEnabled = this.viewZoom < 4;
    ctx.fillStyle = VIEWPORT_BACKGROUND;
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.setTransform(dpr * this.viewZoom, 0, 0, dpr * this.viewZoom, dpr * this.panX, dpr * this.panY);
    ctx.drawImage(this.board.mainCanvas, 0, 0);
    if (this.board.upperLayersCanvas) ctx.drawImage(this.board.upperLayersCanvas, 0, 0);
    for (const userBoard of document.querySelectorAll('.userBoard')) {
      if (userBoard === this.board.topCanvas) continue;
      if (userBoard.style.display !== 'none') ctx.drawImage(userBoard, 0, 0);
    }
    ctx.drawImage(this.board.topCanvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (zoomLabel) zoomLabel.textContent = `${Math.round(this.viewZoom * 100)}%`;
  }

  openPopout() {
    if (!this.enabled) return;
    if (isTauriDesktop()) {
      this._openTauriPopout();
      return;
    }

    const popout = window.open('', 'top-draw-board-viewer', 'width=720,height=540');
    if (!popout) {
      this.app.ui.showToast('Popout was blocked by the browser', 3000, 'error');
      return;
    }

    popout.document.write(this._getPopoutHtml());
    popout.document.close();
    this.popout = popout;
    this.popoutStage = popout.document.querySelector('.boardViewerPopoutStage');
    this.popoutCanvas = popout.document.getElementById('boardViewerPopoutCanvas');
    this.popoutCtx = this.popoutCanvas.getContext('2d');
    this.popoutZoomLabel = popout.document.querySelector('[data-action="reset"]');
    popout.__topDrawBoardViewer = this._createPopoutRuntime(popout);
    popout.addEventListener('beforeunload', () => {
      popout.__topDrawBoardViewer?.destroy?.();
      this.popout = null;
      this.popoutStage = null;
      this.popoutCanvas = null;
      this.popoutCtx = null;
      this.popoutZoomLabel = null;
      this.setMainZoom(this.board.zoom);
      if (!this.visible && !this.tauriPopoutWindow) this._stopTick();
    });
    this._setPanelVisible(false);
    this._scheduleTick();
  }

  async _openTauriPopout() {
    if (this.tauriPopoutWindow) {
      await this.tauriPopoutWindow.setFocus?.();
      this._setPanelVisible(false);
      return;
    }

    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      this._ensureTauriChannel();
      const boardWindow = new WebviewWindow('board-viewer-popout', {
        url: '/board-viewer/',
        title: 'Board View',
        width: 720,
        height: 540,
        minWidth: 320,
        minHeight: 260,
        decorations: false,
        resizable: true,
        center: true,
        focus: true
      });

      boardWindow.once('tauri://created', () => {
        this.tauriPopoutWindow = boardWindow;
        this._setPanelVisible(false);
        this._scheduleTick();
      });

      boardWindow.once('tauri://error', (error) => {
        console.error('[BoardViewer] Failed to create Tauri popout:', error);
        this.app.ui.showToast('Could not open board view window', 3000, 'error');
        this.tauriPopoutWindow = null;
        this.setMainZoom(this.board.zoom);
      });

      boardWindow.once('tauri://destroyed', () => {
        this.tauriPopoutWindow = null;
        this._releaseTauriFrameCanvas();
        this.setMainZoom(this.board.zoom);
        if (!this.visible && !this.isPopoutOpen()) this._stopTick();
      });
    } catch (error) {
      console.error('[BoardViewer] Tauri popout unavailable:', error);
      this.app.ui.showToast('Could not open board view window', 3000, 'error');
    }
  }

  _ensureTauriChannel() {
    if (this.tauriChannel || typeof BroadcastChannel === 'undefined') return;
    this.tauriChannel = new BroadcastChannel(TAURI_CHANNEL_NAME);
    this.tauriChannel.onmessage = (event) => {
      if (event.data?.type === 'board-viewer-closed') {
        this.tauriPopoutWindow = null;
        this._releaseTauriFrameCanvas();
        this.setMainZoom(this.board.zoom);
        if (!this.visible && !this.isPopoutOpen()) this._stopTick();
      }
    };
  }

  _sendTauriFrame(now) {
    if (!this.tauriPopoutWindow || !this.tauriChannel || this._tauriFrameInFlight) return;
    if (now - this._lastTauriFrameAt < TAURI_FRAME_INTERVAL_MS) return;

    this._tauriFrameInFlight = true;
    this._lastTauriFrameAt = now;

    const width = this.board.getWidth();
    const height = this.board.getHeight();
    if (!this.tauriFrameCanvas) {
      this.tauriFrameCanvas = document.createElement('canvas');
      this.tauriFrameCtx = this.tauriFrameCanvas.getContext('2d');
    }
    if (this.tauriFrameCanvas.width !== width || this.tauriFrameCanvas.height !== height) {
      this.tauriFrameCanvas.width = width;
      this.tauriFrameCanvas.height = height;
    }

    const ctx = this.tauriFrameCtx;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.board.mainCanvas, 0, 0);
    if (this.board.upperLayersCanvas) ctx.drawImage(this.board.upperLayersCanvas, 0, 0);
    for (const userBoard of document.querySelectorAll('.userBoard')) {
      if (userBoard === this.board.topCanvas) continue;
      if (userBoard.style.display !== 'none') ctx.drawImage(userBoard, 0, 0);
    }
    ctx.drawImage(this.board.topCanvas, 0, 0);

    try {
      this.tauriChannel.postMessage({
        type: 'board-viewer-frame',
        width,
        height,
        viewportBackground: VIEWPORT_BACKGROUND,
        imageData: ctx.getImageData(0, 0, width, height)
      });
    } catch (error) {
      console.warn('[BoardViewer] Failed to send Tauri frame:', error);
    } finally {
      this._tauriFrameInFlight = false;
    }
  }

  _getPopoutHtml() {
    return `<!doctype html><html><head><title>Board View</title><style>
      html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${VIEWPORT_BACKGROUND};color:#f4f7fb;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
      *{box-sizing:border-box}
      .boardViewerPopout{position:relative;width:100vw;height:100vh}
      .boardViewerPopoutStage{width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;touch-action:none;cursor:grab;background:${VIEWPORT_BACKGROUND}}
      .boardViewerPopoutStage:active{cursor:grabbing}
      canvas{width:100%;height:100%;display:block;cursor:grab}
      .boardViewerPopoutControls{position:absolute;left:0;bottom:0;display:flex;gap:4px;align-items:center;padding:2px;background:rgba(32,38,49,.84);border:1px solid rgba(255,255,255,.14);border-left:0;border-bottom:0;border-radius:0 6px 0 0;box-shadow:0 8px 24px rgba(0,0,0,.32);backdrop-filter:blur(10px)}
      button{display:grid;place-items:center;width:22px;height:22px;padding:0;border:1px solid rgba(255,255,255,.14);border-radius:4px;background:transparent;color:inherit;font:600 13px system-ui;cursor:pointer}
      button:hover{background:rgba(255,255,255,.08)}
      [data-action="reset"]{width:42px;font-size:11px;font-variant-numeric:tabular-nums}
    </style></head><body>
      <section class="boardViewerPopout">
        <div class="boardViewerPopoutStage"><canvas id="boardViewerPopoutCanvas"></canvas></div>
        <div class="boardViewerPopoutControls">
          <button type="button" data-action="zoomOut" title="Zoom out">-</button>
          <button type="button" data-action="reset" title="Fit board">100%</button>
          <button type="button" data-action="zoomIn" title="Zoom in">+</button>
        </div>
      </section>
      <script>
        window.__TOP_DRAW_POPOUT_CONFIG__ = {
          minViewZoom: ${MIN_VIEW_ZOOM},
          maxViewZoom: ${MAX_VIEW_ZOOM},
          viewportBackground: '${VIEWPORT_BACKGROUND}'
        };
      </script>
    </body></html>`;
  }

  _renderPopout() {
    this._renderTo(this.popoutCanvas, this.popoutCtx, this.popoutStage, this.popoutZoomLabel);
  }

  _createPopoutRuntime(popout) {
    const config = popout.__TOP_DRAW_POPOUT_CONFIG__ || {};
    const stage = popout.document.querySelector('.boardViewerPopoutStage');
    const canvas = popout.document.getElementById('boardViewerPopoutCanvas');
    const ctx = canvas.getContext('2d');
    const zoomLabel = popout.document.querySelector('[data-action="reset"]');
    const controls = popout.document.querySelector('.boardViewerPopoutControls');
    const minZoom = config.minViewZoom ?? MIN_VIEW_ZOOM;
    const maxZoom = config.maxViewZoom ?? MAX_VIEW_ZOOM;
    const viewportBackground = config.viewportBackground || VIEWPORT_BACKGROUND;

    let viewZoom = this.viewZoom;
    let panX = this.panX;
    let panY = this.panY;
    let dragState = null;
    let rafId = null;

    const draw = () => {
      const rect = stage.getBoundingClientRect();
      const dpr = 1;
      const width = Math.max(1, Math.floor(rect.width * dpr));
      const height = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.imageSmoothingEnabled = viewZoom < 4;
      ctx.fillStyle = viewportBackground;
      ctx.fillRect(0, 0, rect.width, rect.height);
      ctx.setTransform(dpr * viewZoom, 0, 0, dpr * viewZoom, dpr * panX, dpr * panY);
      ctx.drawImage(this.board.mainCanvas, 0, 0);
      if (this.board.upperLayersCanvas) ctx.drawImage(this.board.upperLayersCanvas, 0, 0);
      for (const userBoard of document.querySelectorAll('.userBoard')) {
        if (userBoard === this.board.topCanvas) continue;
        if (userBoard.style.display !== 'none') ctx.drawImage(userBoard, 0, 0);
      }
      ctx.drawImage(this.board.topCanvas, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (zoomLabel) zoomLabel.textContent = `${Math.round(viewZoom * 100)}%`;
    };

    const tick = () => {
      rafId = popout.requestAnimationFrame(tick);
      draw();
    };

    const fit = () => {
      const rect = stage.getBoundingClientRect();
      const width = this.board.getWidth();
      const height = this.board.getHeight();
      viewZoom = Math.min(rect.width / width, rect.height / height);
      panX = (rect.width - width * viewZoom) / 2;
      panY = (rect.height - height * viewZoom) / 2;
      draw();
    };

    const zoomAt = (nextZoom, pivotX = null, pivotY = null) => {
      const rect = stage.getBoundingClientRect();
      const px = pivotX ?? rect.width / 2;
      const py = pivotY ?? rect.height / 2;
      const oldZoom = viewZoom;
      const clamped = Math.max(minZoom, Math.min(maxZoom, nextZoom));
      const boardX = (px - panX) / oldZoom;
      const boardY = (py - panY) / oldZoom;
      viewZoom = clamped;
      panX = px - boardX * clamped;
      panY = py - boardY * clamped;
      draw();
    };

    const onControlClick = (event) => {
      const action = event.target.closest('button')?.dataset.action;
      if (action === 'zoomIn') zoomAt(viewZoom * 1.2);
      if (action === 'zoomOut') zoomAt(viewZoom / 1.2);
      if (action === 'reset') fit();
    };
    const onPointerDown = (event) => {
      event.preventDefault();
      stage.setPointerCapture(event.pointerId);
      dragState = { x: event.clientX, y: event.clientY, panX, panY };
    };
    const onPointerMove = (event) => {
      if (!dragState) return;
      panX = dragState.panX + event.clientX - dragState.x;
      panY = dragState.panY + event.clientY - dragState.y;
      this.followUserId = null;
    };
    const endPointer = () => { dragState = null; };
    const onWheel = (event) => {
      event.preventDefault();
      zoomAt(viewZoom * Math.pow(2, -event.deltaY / 360), event.offsetX, event.offsetY);
      this.followUserId = null;
    };

    controls.addEventListener('click', onControlClick);
    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);
    stage.addEventListener('wheel', onWheel, { passive: false });
    popout.addEventListener('resize', fit);

    fit();
    rafId = popout.requestAnimationFrame(tick);

    return {
      destroy: () => {
        if (rafId != null) popout.cancelAnimationFrame(rafId);
        controls.removeEventListener('click', onControlClick);
        stage.removeEventListener('pointerdown', onPointerDown);
        stage.removeEventListener('pointermove', onPointerMove);
        stage.removeEventListener('pointerup', endPointer);
        stage.removeEventListener('pointercancel', endPointer);
        stage.removeEventListener('wheel', onWheel);
        popout.removeEventListener('resize', fit);
      }
    };
  }
}
