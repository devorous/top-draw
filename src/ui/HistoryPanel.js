/**
 * @fileoverview History panel for browsing board snapshots and restoring regions.
 * Shows a scrollable strip of snapshot thumbnails below a half-size preview canvas.
 * Users can draw rectangle or lasso selections on the preview to restore partial regions.
 */

import { T } from '../../shared/MessageTypes.js';
import * as wasm from '../wasm/ddraw_wasm.js';

/** @import { DrawingApp } from '../App.js' */

export class HistoryPanel {
  /**
   * @param {DrawingApp} app
   */
  constructor(app) {
    this.app = app;
    this.board = app.board;
    this.wsClient = app.wsClient;

    // State
    this.isOpen = false;
    this.snapshots = []; // [{ id, ts, issuer, auto, thumb, name }]
    this.selectedId = null;
    this.selectedLayers = null; // Uint8Array[] QOI blobs for currently selected snapshot
    this.isLoading = false;

    // Selection on preview
    this.mode = 'rectangle'; // 'rectangle' | 'lasso'
    this.activeTool = 'select'; // 'select' | 'pan'
    this.selection = null;     // { x, y, width, height } in preview coords
    this.lassoPoints = [];
    this.isSelecting = false;
    this.startPos = null;

    // Pan/zoom
    this.viewZoom = 0.5;
    this.viewPanX = 0;
    this.viewPanY = 0;
    this._isPanning = false;
    this._lastPanX = 0;
    this._lastPanY = 0;

    // Marching ants
    this.marchingAntsOffset = 0;
    this.animationId = null;

    // DOM
    this.overlay = null;
    this.previewCanvas = null;
    this.selectionCanvas = null;
    this.previewCtx = null;
    this.selectionCtx = null;
    this.thumbnailStrip = null;
    this.statusEl = null;
    this.restoreBtn = null;

    this._createElements();
    this._setupEventListeners();
    this._registerWsHandlers();
  }

  // ---------------------------------------------------------------------------
  // DOM creation
  // ---------------------------------------------------------------------------

  _createElements() {
    this.overlay = document.createElement('div');
    this.overlay.id = 'historyPanel';
    this.overlay.className = 'historyPanel';
    this.overlay.style.display = 'none';

    // Header
    const header = document.createElement('div');
    header.className = 'historyPanelHeader';
    header.innerHTML = `
      <span class="historyPanelTitle">Board History</span>
      <div class="historyPanelHeaderRight">
        <span class="historyPanelStatus"></span>
        <button class="historyPanelCloseBtn" title="Close (Escape)">&times;</button>
      </div>
    `;

    // Preview area (canvas stack)
    const previewWrap = document.createElement('div');
    previewWrap.className = 'historyPanelPreviewWrap';

    this.previewCanvas = document.createElement('canvas');
    this.previewCanvas.className = 'historyPanelPreview';

    this.selectionCanvas = document.createElement('canvas');
    this.selectionCanvas.className = 'historyPanelSelection';

    // Tool controls for preview
    const toolControls = document.createElement('div');
    toolControls.className = 'historyPanelToolControls';
    toolControls.innerHTML = `
      <button class="historyToolBtn active" data-tool="select" data-mode="rectangle" title="Rectangle Selection">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="2" width="12" height="12" rx="1"/>
        </svg>
      </button>
      <button class="historyToolBtn" data-tool="select" data-mode="lasso" title="Lasso Selection">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M8 2C4.7 2 2 4.7 2 8C2 11.3 4.7 14 8 14C10 14 11.8 13.2 13 11.8"/>
          <circle cx="13" cy="11.8" r="1.8"/>
        </svg>
      </button>
      <button class="historyToolBtn" data-tool="pan" title="Pan View">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <path d="M8 2V14M2 8H14"/>
          <path d="M8 2L6.5 3.5M8 2L9.5 3.5"/>
          <path d="M8 14L6.5 12.5M8 14L9.5 12.5"/>
          <path d="M2 8L3.5 6.5M2 8L3.5 9.5"/>
          <path d="M14 8L12.5 6.5M14 8L12.5 9.5"/>
        </svg>
      </button>
      <button class="historyToolBtn historyZoomResetBtn" title="Reset zoom">100%</button>
    `;

    previewWrap.appendChild(this.previewCanvas);
    previewWrap.appendChild(this.selectionCanvas);
    previewWrap.appendChild(toolControls);

    // Empty state shown when no snapshot selected
    this.emptyPreview = document.createElement('div');
    this.emptyPreview.className = 'historyPanelEmptyPreview';
    this.emptyPreview.textContent = 'Select a snapshot to preview';
    previewWrap.appendChild(this.emptyPreview);

    // Thumbnail strip
    const stripWrap = document.createElement('div');
    stripWrap.className = 'historyPanelStripWrap';

    this.thumbnailStrip = document.createElement('div');
    this.thumbnailStrip.className = 'historyPanelStrip';
    stripWrap.appendChild(this.thumbnailStrip);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'historyPanelFooter';
    footer.innerHTML = `
      <span class="historyPanelSelectionHint">Draw a selection to restore a region, or restore the full board</span>
      <div class="historyPanelFooterBtns">
        <button class="btn secondary" id="historyPanelClearSelection">Clear Selection</button>
        <button class="btn primary" id="historyPanelRestoreBtn" disabled>Restore</button>
      </div>
    `;

    this.overlay.appendChild(header);
    this.overlay.appendChild(previewWrap);
    this.overlay.appendChild(stripWrap);
    this.overlay.appendChild(footer);

    const boardContainer = document.getElementById('boardContainer');
    if (boardContainer) {
      boardContainer.appendChild(this.overlay);
    } else {
      document.body.appendChild(this.overlay);
    }

    // Cache refs
    this.statusEl = header.querySelector('.historyPanelStatus');
    this.closeBtn = header.querySelector('.historyPanelCloseBtn');
    this.toolControls = toolControls;
    this.zoomResetBtn = toolControls.querySelector('.historyZoomResetBtn');
    this.restoreBtn = footer.querySelector('#historyPanelRestoreBtn');
    this.clearSelectionBtn = footer.querySelector('#historyPanelClearSelection');

    this.previewCtx = this.previewCanvas.getContext('2d');
    this.selectionCtx = this.selectionCanvas.getContext('2d');
  }

  // ---------------------------------------------------------------------------
  // Event listeners
  // ---------------------------------------------------------------------------

  _setupEventListeners() {
    this.closeBtn.addEventListener('click', () => this.close());

    // Tool control buttons
    this.toolControls.addEventListener('click', (e) => {
      const btn = e.target.closest('.historyToolBtn');
      if (!btn) return;
      if (btn.dataset.tool === 'pan') {
        this._setActiveTool('pan');
      } else {
        this.mode = btn.dataset.mode;
        this._setActiveTool('select');
        this._clearSelection();
      }
    });

    this.zoomResetBtn.addEventListener('click', () => {
      this._resetView();
    });

    // Selection canvas pointer events
    this.selectionCanvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.selectionCanvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.selectionCanvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this.selectionCanvas.addEventListener('pointerleave', (e) => this._onPointerUp(e));
    this.selectionCanvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

    this.restoreBtn.addEventListener('click', () => this._doRestore());
    this.clearSelectionBtn.addEventListener('click', () => this._clearSelection());

    this._keyHandler = (e) => {
      if (!this.isOpen) return;
      if (e.key === 'Escape') this.close();
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  _registerWsHandlers() {
    // List response
    this.wsClient.on('board_snapshot_list', ({ snapshotList }) => {
      this.snapshots = snapshotList || [];
      this._renderStrip();
      this._setStatus('');
      if (this.snapshots.length === 0) {
        this._setStatus('No snapshots available');
      }
    });

    // Private get response
    this.wsClient.on('board_snapshot_get_response', ({ snapshotId, snapshotLayers }) => {
      if (snapshotId !== this.selectedId) return;
      this.selectedLayers = snapshotLayers;
      this._renderPreview(snapshotLayers);
      this._setStatus('');
      this.isLoading = false;
      this.restoreBtn.disabled = false;
    });
  }

  // ---------------------------------------------------------------------------
  // Open / Close
  // ---------------------------------------------------------------------------

  open() {
    if (this.isOpen) return;
    this.isOpen = true;

    this.selectedId = null;
    this.selectedLayers = null;
    this.selection = null;
    this.lassoPoints = [];

    const [h, w] = this.board.dimensions;
    this._setupCanvases(w, h);
    this._resetView();

    this.overlay.style.display = 'flex';
    this._setStatus('Loading…');
    this._loadSnapshotList();
    this._startMarchingAnts();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.overlay.style.display = 'none';
    this._stopMarchingAnts();
    this.selectedLayers = null;
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  _loadSnapshotList() {
    if (!this.wsClient.connected) {
      this._setStatus('Not connected');
      return;
    }
    this.wsClient.send({ t: T.BOARD_SNAPSHOT_LIST_REQUEST });
  }

  _selectSnapshot(id) {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.selectedLayers = null;
    this.selection = null;
    this.lassoPoints = [];
    this.restoreBtn.disabled = true;

    // Highlight selected thumbnail
    this.thumbnailStrip.querySelectorAll('.historyThumb').forEach((el) => {
      el.classList.toggle('selected', el.dataset.id === id);
    });

    // Clear preview while loading
    this._clearPreview();
    this._setStatus('Loading preview…');
    this.isLoading = true;

    this.wsClient.requestSnapshotGet(id);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  _setupCanvases(boardW, boardH) {
    // We render at half size
    this.previewCanvas.width = boardW;
    this.previewCanvas.height = boardH;
    this.selectionCanvas.width = boardW;
    this.selectionCanvas.height = boardH;
  }

  _resetView() {
    const [h, w] = this.board.dimensions;
    // Fit preview at 50% so it is "half size"
    this.viewZoom = 0.5;
    this.viewPanX = 0;
    this.viewPanY = 0;
    this._applyTransform();
  }

  _applyTransform() {
    const t = `translate(${this.viewPanX}px, ${this.viewPanY}px) scale(${this.viewZoom})`;
    this.previewCanvas.style.transform = t;
    this.selectionCanvas.style.transform = t;
    if (this.zoomResetBtn) {
      this.zoomResetBtn.textContent = `${Math.round(this.viewZoom * 100)}%`;
    }
  }

  _clearPreview() {
    this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
    this.selectionCtx.clearRect(0, 0, this.selectionCanvas.width, this.selectionCanvas.height);
    this.emptyPreview.style.display = '';
  }

  _renderPreview(layerDatas) {
    if (!layerDatas || layerDatas.length === 0) {
      this._clearPreview();
      return;
    }

    const [h, w] = this.board.dimensions;

    // Fill background color
    const bgColor = this.board.backgroundColor || '#ffffff';
    this.previewCtx.fillStyle = bgColor;
    this.previewCtx.fillRect(0, 0, w, h);

    for (let i = 0; i < layerDatas.length; i++) {
      const qoi = layerDatas[i];
      if (!qoi || qoi.length === 0) continue;
      try {
        const pixels = wasm.qoi_decode(qoi);
        if (!pixels || pixels.length === 0) continue;
        const imageData = new ImageData(new Uint8ClampedArray(pixels.buffer), w, h);
        this.previewCtx.putImageData(imageData, 0, 0);
      } catch (err) {
        console.warn('[HistoryPanel] QOI decode error:', err);
      }
    }

    this.emptyPreview.style.display = 'none';
    this._drawSelection();
  }

  _renderStrip() {
    this.thumbnailStrip.innerHTML = '';

    if (this.snapshots.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'historyStripEmpty';
      empty.textContent = 'No snapshots yet';
      this.thumbnailStrip.appendChild(empty);
      return;
    }

    for (const snap of this.snapshots) {
      const item = document.createElement('div');
      item.className = 'historyThumb';
      item.dataset.id = snap.id;

      if (snap.thumb && snap.thumb.length > 0) {
        // Render JPEG/PNG thumbnail blob
        const blob = new Blob([snap.thumb], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        const img = document.createElement('img');
        img.src = url;
        img.onload = () => URL.revokeObjectURL(url);
        item.appendChild(img);
      } else {
        // Placeholder
        const placeholder = document.createElement('div');
        placeholder.className = 'historyThumbPlaceholder';
        placeholder.textContent = snap.auto ? 'Auto' : 'Manual';
        item.appendChild(placeholder);
      }

      const label = document.createElement('span');
      label.className = 'historyThumbLabel';
      label.textContent = snap.name || new Date(snap.ts).toLocaleTimeString();
      item.appendChild(label);

      item.addEventListener('click', () => this._selectSnapshot(snap.id));
      this.thumbnailStrip.appendChild(item);
    }
  }

  // ---------------------------------------------------------------------------
  // Selection drawing
  // ---------------------------------------------------------------------------

  _clearSelection() {
    this.selection = null;
    this.lassoPoints = [];
    this._drawSelection();
  }

  _drawSelection() {
    const ctx = this.selectionCtx;
    const w = this.selectionCanvas.width;
    const h = this.selectionCanvas.height;
    ctx.clearRect(0, 0, w, h);

    if (this.mode === 'rectangle' && this.selection) {
      this._drawMarchingAntsRect(ctx, this.selection);
    } else if (this.mode === 'lasso' && this.lassoPoints.length > 2) {
      this._drawMarchingAntsLasso(ctx, this.lassoPoints);
    }
  }

  _drawMarchingAntsRect(ctx, rect) {
    const { x, y, width, height } = rect;
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.lineDashOffset = -this.marchingAntsOffset;
    ctx.strokeRect(x + 0.5, y + 0.5, width, height);
    ctx.strokeStyle = '#000';
    ctx.lineDashOffset = -(this.marchingAntsOffset + 5);
    ctx.strokeRect(x + 0.5, y + 0.5, width, height);
    ctx.restore();
  }

  _drawMarchingAntsLasso(ctx, points) {
    if (points.length < 2) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.lineDashOffset = -this.marchingAntsOffset;
    ctx.stroke();
    ctx.strokeStyle = '#000';
    ctx.lineDashOffset = -(this.marchingAntsOffset + 5);
    ctx.stroke();
    ctx.restore();
  }

  _startMarchingAnts() {
    const tick = () => {
      this.marchingAntsOffset = (this.marchingAntsOffset + 0.3) % 10;
      this._drawSelection();
      this.animationId = requestAnimationFrame(tick);
    };
    this.animationId = requestAnimationFrame(tick);
  }

  _stopMarchingAnts() {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Pointer events (selection + pan)
  // ---------------------------------------------------------------------------

  _canvasPos(e) {
    // getBoundingClientRect() returns the on-screen scaled size.
    // Divide by viewZoom to get logical canvas pixels.
    const rect = this.selectionCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / this.viewZoom,
      y: (e.clientY - rect.top) / this.viewZoom
    };
  }

  _onPointerDown(e) {
    if (e.button !== 0) return;
    this.selectionCanvas.setPointerCapture(e.pointerId);

    if (this.activeTool === 'pan') {
      this._isPanning = true;
      this._lastPanX = e.clientX;
      this._lastPanY = e.clientY;
      return;
    }

    this.isSelecting = true;
    const pos = this._canvasPos(e);
    this.startPos = pos;

    if (this.mode === 'rectangle') {
      this.selection = { x: pos.x, y: pos.y, width: 0, height: 0 };
    } else {
      this.lassoPoints = [pos];
    }
  }

  _onPointerMove(e) {
    if (this._isPanning) {
      const dx = e.clientX - this._lastPanX;
      const dy = e.clientY - this._lastPanY;
      this.viewPanX += dx;
      this.viewPanY += dy;
      this._lastPanX = e.clientX;
      this._lastPanY = e.clientY;
      this._applyTransform();
      return;
    }

    if (!this.isSelecting) return;
    const pos = this._canvasPos(e);

    if (this.mode === 'rectangle' && this.startPos) {
      const x = Math.min(pos.x, this.startPos.x);
      const y = Math.min(pos.y, this.startPos.y);
      const width = Math.abs(pos.x - this.startPos.x);
      const height = Math.abs(pos.y - this.startPos.y);
      this.selection = { x, y, width, height };
    } else if (this.mode === 'lasso') {
      this.lassoPoints.push(pos);
    }
  }

  _onPointerUp(e) {
    if (this._isPanning) {
      this._isPanning = false;
      return;
    }
    this.isSelecting = false;

    // Discard tiny rectangle selections
    if (this.mode === 'rectangle' && this.selection) {
      if (this.selection.width < 4 || this.selection.height < 4) {
        this.selection = null;
      }
    }
    if (this.mode === 'lasso' && this.lassoPoints.length < 4) {
      this.lassoPoints = [];
    }
  }

  _onWheel(e) {
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.1 : -0.1;
    const nextZoom = Math.max(0.2, Math.min(3, Math.round((this.viewZoom + step) * 10) / 10));
    if (nextZoom === this.viewZoom) return;

    const rect = this.overlay.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const canvasX = (px - this.viewPanX) / this.viewZoom;
    const canvasY = (py - this.viewPanY) / this.viewZoom;
    this.viewPanX = px - canvasX * nextZoom;
    this.viewPanY = py - canvasY * nextZoom;
    this.viewZoom = nextZoom;
    this._applyTransform();
  }

  // ---------------------------------------------------------------------------
  // Tool control
  // ---------------------------------------------------------------------------

  _setActiveTool(tool) {
    this.activeTool = tool;
    this.toolControls.querySelectorAll('.historyToolBtn').forEach((btn) => {
      const isActive = btn.dataset.tool === 'pan'
        ? tool === 'pan'
        : tool === 'select' && btn.dataset.mode === this.mode;
      btn.classList.toggle('active', isActive);
    });
    this.selectionCanvas.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
  }

  // ---------------------------------------------------------------------------
  // Restore
  // ---------------------------------------------------------------------------

  _doRestore() {
    if (!this.selectedId) return;

    const hasSelection = (this.mode === 'rectangle' && this.selection && this.selection.width > 0)
      || (this.mode === 'lasso' && this.lassoPoints.length > 2);

    if (hasSelection) {
      this._restoreRegion();
    } else {
      this._restoreFullBoard();
    }
  }

  _restoreFullBoard() {
    // Ask server to broadcast restore to all clients
    this.wsClient.send({ t: T.BOARD_SNAPSHOT_RESTORE, snapshotId: this.selectedId });
    this.close();
  }

  _restoreRegion() {
    if (!this.selectedLayers) return;

    const [h, w] = this.board.dimensions;

    // Decode selected snapshot layers to a temporary canvas
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext('2d');

    for (const qoi of this.selectedLayers) {
      if (!qoi || qoi.length === 0) continue;
      try {
        const pixels = wasm.qoi_decode(qoi);
        if (!pixels || pixels.length === 0) continue;
        const imageData = new ImageData(new Uint8ClampedArray(pixels.buffer), w, h);
        tempCtx.putImageData(imageData, 0, 0);
      } catch (err) {
        console.warn('[HistoryPanel] region restore QOI decode error:', err);
      }
    }

    if (this.mode === 'rectangle' && this.selection) {
      const { x, y, width, height } = this.selection;
      // Apply region from snapshot onto the board's main canvas
      const mainCtx = this.board.mainCtx;
      mainCtx.save();
      mainCtx.globalCompositeOperation = 'source-over';
      // First clear the region on the board (so we can paint snapshot content)
      mainCtx.clearRect(x, y, width, height);
      mainCtx.drawImage(tempCanvas, x, y, width, height, x, y, width, height);
      mainCtx.restore();
    } else if (this.mode === 'lasso' && this.lassoPoints.length > 2) {
      const mainCtx = this.board.mainCtx;
      mainCtx.save();
      mainCtx.beginPath();
      mainCtx.moveTo(this.lassoPoints[0].x, this.lassoPoints[0].y);
      for (let i = 1; i < this.lassoPoints.length; i++) {
        mainCtx.lineTo(this.lassoPoints[i].x, this.lassoPoints[i].y);
      }
      mainCtx.closePath();
      mainCtx.clip();
      mainCtx.clearRect(0, 0, w, h);
      mainCtx.drawImage(tempCanvas, 0, 0);
      mainCtx.restore();
    }

    if (this.board.tileGrid) this.board.tileGrid.markAllDirty();
    this.close();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _setStatus(msg) {
    if (this.statusEl) this.statusEl.textContent = msg;
  }
}
