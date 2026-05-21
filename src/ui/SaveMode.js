/**
 * @fileoverview Interactive save mode with visual selection on a board snapshot.
 * Allows users to select a region (or full board) before saving locally or to gallery.
 */

export class SaveMode {
  /**
   * @param {Object} app - The main application instance
   */
  constructor(app) {
    this.app = app;
    this.board = app.board;
    this.ui = app.ui;

    // DOM elements (created dynamically)
    this.overlay = null;
    this.snapshotCanvas = null;
    this.selectionCanvas = null;
    this.snapshotCtx = null;
    this.selectionCtx = null;
    this.optionsPanel = null;

    // Selection state
    this.isActive = false;
    this.isSelecting = false;
    this.activeTool = 'select'; // 'select' or 'pan'
    this.mode = 'rectangle'; // 'rectangle' or 'lasso'
    this.startPos = null;
    this.selection = null; // { x, y, width, height }
    this.lassoPoints = [];

    // Pan/zoom state
    this._isPanning = false;
    this._lastPanX = 0;
    this._lastPanY = 0;
    this.viewZoom = 1;
    this.viewPanX = 0;
    this.viewPanY = 0;
    this.defaultViewZoom = 1;
    this.defaultViewPanX = 0;
    this.defaultViewPanY = 0;

    // Marching ants animation
    this.marchingAntsOffset = 0;
    this.animationId = null;

    // Options state
    this.transparent = false;
    this.shareToDiscord = false;
    this.tagUsername = true;
    this.galleryTitle = '';
    this.preExistingCanvasFixedSelection = false;

    this._createElements();
    this._setupEventListeners();
  }

  /**
   * Creates the save mode overlay elements.
   */
  _createElements() {
    // Main overlay container
    this.overlay = document.createElement('div');
    this.overlay.id = 'saveModeInteractive';
    this.overlay.className = 'saveModeInteractive';
    this.overlay.style.display = 'none';

    // Snapshot canvas (shows the board snapshot with dark overlay)
    this.snapshotCanvas = document.createElement('canvas');
    this.snapshotCanvas.className = 'saveModeSnapshot';

    // Selection canvas (for drawing selection UI on top)
    this.selectionCanvas = document.createElement('canvas');
    this.selectionCanvas.className = 'saveModeSelection';

    // Top controls
    const controls = document.createElement('div');
    controls.className = 'saveModeControls';
    controls.innerHTML = `
      <div class="saveModeModeToggle">
        <button class="saveModeToggleBtn active" data-tool="select" data-mode="rectangle" title="Rectangle Selection">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="2" width="14" height="14" rx="1"/>
          </svg>
        </button>
        <button class="saveModeToggleBtn" data-tool="select" data-mode="lasso" title="Lasso Selection">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M9 2C5 2 2 5 2 9C2 13 5 16 9 16C11 16 13 15 14 13"/>
            <circle cx="14" cy="13" r="2"/>
          </svg>
        </button>
        <button class="saveModeToggleBtn" data-tool="pan" title="Pan View">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 2.5V15.5"/>
            <path d="M2.5 9H15.5"/>
            <path d="M9 2.5L7.2 4.3"/>
            <path d="M9 2.5L10.8 4.3"/>
            <path d="M9 15.5L7.2 13.7"/>
            <path d="M9 15.5L10.8 13.7"/>
            <path d="M2.5 9L4.3 7.2"/>
            <path d="M2.5 9L4.3 10.8"/>
            <path d="M15.5 9L13.7 7.2"/>
            <path d="M15.5 9L13.7 10.8"/>
          </svg>
        </button>
      </div>
      <div class="saveModeZoomControls">
        <button class="saveModeZoomBtn" id="saveModeZoomOut" title="Zoom Out">-</button>
        <button class="saveModeZoomResetBtn" id="saveModeZoomReset" title="Reset View">100%</button>
        <button class="saveModeZoomBtn" id="saveModeZoomIn" title="Zoom In">+</button>
      </div>
    `;

    // Options panel (shown after selection or for full board)
    this.optionsPanel = document.createElement('div');
    this.optionsPanel.className = 'saveModeOptionsPanel';
    this.optionsPanel.innerHTML = `
      <div class="saveModeOptionsPanelLead">
        <span class="saveModeOptionsHint">Draw a selection or save the entire canvas</span>
      </div>
      <div class="saveModeOptionsPanelBody">
        <label class="saveModeOptionsCheckbox">
          <input type="checkbox" id="saveModeTransparent">
          <span>Transparent Background</span>
        </label>
        <label class="saveModeOptionsCheckbox">
          <input type="checkbox" id="saveModeShareDiscord">
          <span>Share to Discord</span>
        </label>
        <label class="saveModeOptionsCheckbox">
          <input type="checkbox" id="saveModeTagUsername" checked>
          <span>Tag Username</span>
        </label>
      </div>
      <div class="saveModeOptionsPanelFooter">
        <button class="btn secondary" id="saveModeCancelInteractive">Cancel</button>
        <button class="btn secondary" id="saveModeCopyInteractive">Copy</button>
        <button class="btn secondary" id="saveModeGalleryInteractive">Save to Gallery</button>
        <button class="btn primary" id="saveModeLocalInteractive">Save Locally</button>
      </div>
    `;

    this.captionPanel = document.createElement('div');
    this.captionPanel.className = 'saveModeCaptionPanel';
    this.captionPanel.innerHTML = `
      <label class="saveModeOptionsField saveModeCaptionField" for="saveModeTitle">
        <span>Title</span>
        <input id="saveModeTitle" type="text" maxlength="60" placeholder="Short title (optional, max 60 chars)" />
      </label>
      <label class="saveModeOptionsField saveModeCaptionField saveModeDescriptionField" for="saveModeDescription">
        <span>Description</span>
        <textarea id="saveModeDescription" maxlength="300" rows="2" placeholder="Describe your image (optional, max 300 chars)"></textarea>
      </label>
    `;

    // Close button (top right)
    const closeBtn = document.createElement('button');
    closeBtn.className = 'saveModeCloseBtn';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = 'Cancel (Escape)';

    this.overlay.appendChild(this.snapshotCanvas);
    this.overlay.appendChild(this.selectionCanvas);
    this.overlay.appendChild(controls);
    this.overlay.appendChild(this.optionsPanel);
    this.overlay.appendChild(this.captionPanel);
    this.overlay.appendChild(closeBtn);

    // Insert into the top-level document layer so the save UI can stack above
    // other fixed overlays such as history/snapshot modals.
    if (document.body) {
      document.body.appendChild(this.overlay);
    } else {
      console.warn('[SaveMode] document.body not found, deferring DOM insertion');
    }

    // Get contexts
    this.snapshotCtx = this.snapshotCanvas.getContext('2d');
    this.snapshotCtx.imageSmoothingEnabled = true;
    this.snapshotCtx.imageSmoothingQuality = 'high';
    this.selectionCtx = this.selectionCanvas.getContext('2d');

    // Store references
    this.controls = controls;
    this.modeToggle = controls.querySelector('.saveModeModeToggle');
    this.zoomOutBtn = controls.querySelector('#saveModeZoomOut');
    this.zoomResetBtn = controls.querySelector('#saveModeZoomReset');
    this.zoomInBtn = controls.querySelector('#saveModeZoomIn');
    this.closeBtn = closeBtn;
  }

  /**
   * Sets up event listeners for the save mode.
   */
  _setupEventListeners() {
    // Mode toggle buttons
    this.modeToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('.saveModeToggleBtn');
      if (!btn) return;
      if (btn.dataset.tool === 'pan') {
        this.setActiveTool('pan');
        return;
      }

      this.setMode(btn.dataset.mode);
      this.setActiveTool('select');
    });

    this.zoomOutBtn.addEventListener('click', () => this._zoomByStep(-0.1));
    this.zoomInBtn.addEventListener('click', () => this._zoomByStep(0.1));
    this.zoomResetBtn.addEventListener('click', () => this.resetView());

    // Selection canvas pointer events
    this.selectionCanvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.selectionCanvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.selectionCanvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this.selectionCanvas.addEventListener('pointerleave', (e) => this._onPointerUp(e));

    // Wheel events for zooming
    this.selectionCanvas.addEventListener('wheel', (e) => this._onWheel(e));

    // Close button
    this.closeBtn.addEventListener('click', () => this.close());

    // Options panel buttons
    this.optionsPanel.querySelector('#saveModeCancelInteractive').addEventListener('click', () => this.close());
    this.optionsPanel.querySelector('#saveModeCopyInteractive').addEventListener('click', () => this._performCopy());
    this.optionsPanel.querySelector('#saveModeLocalInteractive').addEventListener('click', () => this._performSave(true));
    this.optionsPanel.querySelector('#saveModeGalleryInteractive').addEventListener('click', () => this._performSave(false));

    // Transparent checkbox
    this.optionsPanel.querySelector('#saveModeTransparent').addEventListener('change', (e) => {
      this.transparent = e.target.checked;
      this._drawSnapshot();
    });

    this.optionsPanel.querySelector('#saveModeShareDiscord').addEventListener('change', (e) => {
      this.shareToDiscord = e.target.checked;
    });

    this.optionsPanel.querySelector('#saveModeTagUsername').addEventListener('change', (e) => {
      this.tagUsername = e.target.checked;
    });

    this.titleInput = this.captionPanel.querySelector('#saveModeTitle');
    this.titleInput?.addEventListener('input', (e) => {
      this.galleryTitle = e.target.value;
    });

    this.descriptionInput = this.captionPanel.querySelector('#saveModeDescription');
    this.descriptionInput?.addEventListener('input', (e) => {
      this.galleryDescription = e.target.value;
    });

    // Escape key to close
    this._keyHandler = (e) => {
      if (e.key === 'Escape' && this.isActive) {
        this.close();
      }
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  /**
   * Opens the save mode, taking a snapshot of the current board.
   */
  open() {
    if (this.isActive) return;
    this.isActive = true;

    // Ensure overlay is in DOM (in case document.body wasn't available at construction)
    if (!this.overlay.parentNode) {
      if (document.body) {
        document.body.appendChild(this.overlay);
      }
    }

    // Reset state
    this.selection = null;
    this.lassoPoints = [];
    this.preExistingCanvas = null;
    this.preExistingCanvasFixedSelection = false;
    this.transparent = false;
    this.shareToDiscord = false;
    this.tagUsername = true;
    this.galleryTitle = '';
    this.galleryDescription = '';
    this.activeTool = 'select';
    this.optionsPanel.querySelector('#saveModeTransparent').checked = false;
    this.optionsPanel.querySelector('#saveModeShareDiscord').checked = false;
    this.optionsPanel.querySelector('#saveModeTagUsername').checked = true;
    if (this.titleInput) this.titleInput.value = '';
    if (this.descriptionInput) this.descriptionInput.value = '';

    // Size canvases to match board
    const [height, width] = this.board.dimensions;
    this.snapshotCanvas.width = width;
    this.snapshotCanvas.height = height;
    this.selectionCanvas.width = width;
    this.selectionCanvas.height = height;

    // Take snapshot and draw with overlay
    this._drawSnapshot();

    // Show overlay
    this.overlay.style.display = 'flex';

    // Start marching ants animation
    this._startMarchingAnts();

    this._setView(this.board.zoom || 1, this.board.panX || 0, this.board.panY || 0, true);
    this._syncControlState();
  }

  /**
   * Sets the selection mode.
   * @param {string} mode - 'rectangle' or 'lasso'
   */
  setMode(mode) {
    this.mode = mode;
    // Clear any existing selection when switching modes
    if (this.selection) {
      this.selection = null;
      this.lassoPoints = [];
      this._drawSnapshot();
      this._drawSelection();
    }
    this._syncControlState();
  }

  /**
   * Sets the active interaction tool.
   * @param {'select'|'pan'} tool
   */
  setActiveTool(tool) {
    this.activeTool = tool;
    this._updateCursor();
    this._syncControlState();
  }

  /**
   * Updates canvas transform to match board zoom/pan.
   */
  _updateCanvasTransform() {
    const transform = `translate(${this.viewPanX}px, ${this.viewPanY}px) scale(${this.viewZoom})`;
    this.snapshotCanvas.style.transform = transform;
    this.selectionCanvas.style.transform = transform;
  }

  _setView(zoom, panX, panY, updateDefault = false) {
    this.viewZoom = Math.max(0.2, Math.min(3, zoom));
    this.viewPanX = panX;
    this.viewPanY = panY;
    if (updateDefault) {
      this.defaultViewZoom = this.viewZoom;
      this.defaultViewPanX = this.viewPanX;
      this.defaultViewPanY = this.viewPanY;
    }
    this._updateCanvasTransform();
    this._syncControlState();
  }

  _zoomTo(nextZoom, pivot = null) {
    const clampedZoom = Math.max(0.2, Math.min(3, Math.round(nextZoom * 10) / 10));
    if (clampedZoom === this.viewZoom) return;

    let nextPanX = this.viewPanX;
    let nextPanY = this.viewPanY;

    if (pivot) {
      const canvasX = (pivot.x - this.viewPanX) / this.viewZoom;
      const canvasY = (pivot.y - this.viewPanY) / this.viewZoom;
      nextPanX = pivot.x - (canvasX * clampedZoom);
      nextPanY = pivot.y - (canvasY * clampedZoom);
    }

    this._setView(clampedZoom, nextPanX, nextPanY);
  }

  _zoomByStep(step) {
    const overlayRect = this.overlay.getBoundingClientRect();
    this._zoomTo(this.viewZoom + step, {
      x: overlayRect.width / 2,
      y: overlayRect.height / 2
    });
  }

  resetView() {
    this._setView(this.defaultViewZoom, this.defaultViewPanX, this.defaultViewPanY);
  }

  _syncControlState() {
    if (!this.controls) return;

    this.modeToggle.querySelectorAll('.saveModeToggleBtn').forEach((btn) => {
      const tool = btn.dataset.tool;
      const mode = btn.dataset.mode;
      const isActive = tool === 'pan'
        ? this.activeTool === 'pan'
        : this.activeTool === 'select' && mode === this.mode;
      btn.classList.toggle('active', isActive);
    });

    if (this.zoomResetBtn) {
      this.zoomResetBtn.textContent = `${Math.round(this.viewZoom * 100)}%`;
    }

    this._updateCursor();
  }

  _updateCursor() {
    if (!this.selectionCanvas) return;
    if (this._isPanning) {
      this.selectionCanvas.style.cursor = 'grabbing';
      return;
    }
    this.selectionCanvas.style.cursor = this.activeTool === 'pan' ? 'grab' : 'crosshair';
  }

  /**
   * Draws the board snapshot with dark overlay on non-selected areas.
   */
  _drawSnapshot() {
    // If we have a pre-existing canvas, use that instead
    if (this.preExistingCanvas) {
      this._drawPreExistingSnapshot();
      return;
    }

    const ctx = this.snapshotCtx;
    const [height, width] = this.board.dimensions;

    // Clear
    ctx.clearRect(0, 0, width, height);
    this._drawBoardPreview(ctx, 0, 0, width, height);

    // Only draw dark overlay if there's a selection (to highlight what's selected)
    const hasRectSelection = this.selection && this.selection.width > 0 && this.selection.height > 0;
    const hasLassoSelection = this.lassoPoints.length > 2;

    if (hasRectSelection || hasLassoSelection) {
      // Draw dark overlay
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(0, 0, width, height);

      // Cut through the overlay to show the selected area
      if (hasRectSelection) {
        this._drawSelectionCutout();
      } else if (hasLassoSelection) {
        this._drawLassoCutout();
      }
    }
  }

  /**
   * Draws a checkerboard pattern to indicate transparency.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   */
  _drawCheckerboard(ctx, x, y, w, h) {
    const size = 16;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#cccccc';

    for (let row = 0; row < Math.ceil(h / size); row++) {
      for (let col = 0; col < Math.ceil(w / size); col++) {
        if ((row + col) % 2 === 0) {
          ctx.fillRect(x + col * size, y + row * size, size, size);
        }
      }
    }
  }

  _drawRoomBackground(ctx, x, y, w, h) {
    const [r, g, b, a] = this.board.backgroundColor;
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
    ctx.fillRect(x, y, w, h);
  }

  _drawBoardPreview(ctx, x, y, w, h) {
    if (this.transparent) {
      this._drawCheckerboard(ctx, x, y, w, h);
      this.board.layerManager.compositeLayerRange(ctx, 0, this.board.layerManager.getLayerCount(), null);
      return;
    }

    // Mirror the export behavior for opaque saves by previewing the board over
    // the room background color rather than a transparency checkerboard.
    ctx.drawImage(this.board.mainCanvas, 0, 0);
  }

  _drawCanvasPreview(ctx, canvas, x, y, w, h) {
    if (this.transparent) {
      this._drawCheckerboard(ctx, x, y, w, h);
    } else {
      this._drawRoomBackground(ctx, x, y, w, h);
    }
    ctx.drawImage(canvas, 0, 0);
  }

  /**
   * Draws the selection cutout (shows the selected area without dark overlay).
   */
  _drawSelectionCutout() {
    const ctx = this.snapshotCtx;
    const s = this.selection;

    // Save the dark overlay state
    ctx.save();

    // Use destination-out to clear the overlay in the selection area
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 1)';
    ctx.fillRect(s.x, s.y, s.width, s.height);

    ctx.restore();

    // Redraw just the selection area content on top
    ctx.save();
    ctx.beginPath();
    ctx.rect(s.x, s.y, s.width, s.height);
    ctx.clip();

    // Clear and redraw this region
    ctx.clearRect(s.x, s.y, s.width, s.height);
    this._drawBoardPreview(ctx, s.x, s.y, s.width, s.height);

    ctx.restore();
  }

  /**
   * Draws the lasso cutout (shows the lasso-selected area without dark overlay).
   */
  _drawLassoCutout() {
    if (this.lassoPoints.length < 3) return;

    const ctx = this.snapshotCtx;
    const points = this.lassoPoints;

    // Get bounding box
    const bounds = this._getLassoBounds();

    ctx.save();

    // Use destination-out to clear the overlay in the lasso area
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 1)';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    // Redraw the lasso area content
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    ctx.clip();

    ctx.clearRect(bounds.x, bounds.y, bounds.width, bounds.height);
    this._drawBoardPreview(ctx, bounds.x, bounds.y, bounds.width, bounds.height);

    ctx.restore();
  }

  /**
   * Gets the bounding box of the lasso points.
   * @returns {{x: number, y: number, width: number, height: number}}
   */
  _getLassoBounds() {
    if (this.lassoPoints.length === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const p of this.lassoPoints) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    return {
      x: Math.floor(minX),
      y: Math.floor(minY),
      width: Math.ceil(maxX - minX),
      height: Math.ceil(maxY - minY)
    };
  }

  /**
   * Draws the selection outline (marching ants) on the selection canvas.
   */
  _drawSelection() {
    const ctx = this.selectionCtx;
    const width = this.selectionCanvas.width;
    const height = this.selectionCanvas.height;

    ctx.clearRect(0, 0, width, height);

    if (this.mode === 'rectangle' && this.selection && this.selection.width > 0 && this.selection.height > 0) {
      const s = this.selection;

      // Draw marching ants
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -this.marchingAntsOffset;
      ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.width, s.height);

      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = -this.marchingAntsOffset + 4;
      ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.width, s.height);

      ctx.setLineDash([]);
    } else if (this.mode === 'lasso' && this.lassoPoints.length > 1) {
      const points = this.lassoPoints;

      // Draw marching ants path
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -this.marchingAntsOffset;

      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      if (!this.isSelecting && points.length > 2) {
        ctx.closePath();
      }
      ctx.stroke();

      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = -this.marchingAntsOffset + 4;

      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      if (!this.isSelecting && points.length > 2) {
        ctx.closePath();
      }
      ctx.stroke();

      ctx.setLineDash([]);
    }
  }

  /**
   * Converts screen coordinates to canvas coordinates.
   * @param {PointerEvent} e
   * @returns {{x: number, y: number}}
   */
  _getCanvasPos(e) {
    const overlayRect = this.overlay.getBoundingClientRect();

    // Get pointer position relative to overlay
    const screenX = e.clientX - overlayRect.left;
    const screenY = e.clientY - overlayRect.top;

    // Reverse the transform: remove pan then unscale
    const canvasX = (screenX - this.viewPanX) / this.viewZoom;
    const canvasY = (screenY - this.viewPanY) / this.viewZoom;

    return { x: canvasX, y: canvasY };
  }

  /**
   * Handles wheel events for zooming.
   * @param {WheelEvent} e
   */
  _onWheel(e) {
    e.preventDefault();

    // Get cursor position for zoom center
    const overlayRect = this.overlay.getBoundingClientRect();
    const cursorX = e.clientX - overlayRect.left;
    const cursorY = e.clientY - overlayRect.top;

    this._zoomTo(this.viewZoom + (e.deltaY > 0 ? -0.1 : 0.1), { x: cursorX, y: cursorY });
  }

  /**
   * Handles pointer down events on the selection canvas.
   * @param {PointerEvent} e
   */
  _onPointerDown(e) {
    // Check if we're in pan mode (Space held or middle-click)
    const isPanning = this.activeTool === 'pan' || this.app.self.panning || e.button === 1;

    if (isPanning) {
      // Start pan mode
      this._isPanning = true;
      this._lastPanX = e.clientX;
      this._lastPanY = e.clientY;
      this._updateCursor();
      this.selectionCanvas.setPointerCapture(e.pointerId);
      return;
    }

    const pos = this._getCanvasPos(e);
    this.isSelecting = true;
    this.startPos = pos;

    if (this.mode === 'rectangle') {
      this.selection = { x: pos.x, y: pos.y, width: 0, height: 0 };
    } else {
      this.lassoPoints = [{ x: pos.x, y: pos.y }];
    }

    this.selectionCanvas.setPointerCapture(e.pointerId);
  }

  /**
   * Handles pointer move events on the selection canvas.
   * @param {PointerEvent} e
   */
  _onPointerMove(e) {
    // Handle panning
    if (this._isPanning) {
      const dx = e.clientX - this._lastPanX;
      const dy = e.clientY - this._lastPanY;
      this.viewPanX += dx;
      this.viewPanY += dy;
      this._lastPanX = e.clientX;
      this._lastPanY = e.clientY;
      this._updateCanvasTransform();
      return;
    }

    if (!this.isSelecting) return;

    const pos = this._getCanvasPos(e);

    if (this.mode === 'rectangle') {
      const x = Math.min(this.startPos.x, pos.x);
      const y = Math.min(this.startPos.y, pos.y);
      const width = Math.abs(pos.x - this.startPos.x);
      const height = Math.abs(pos.y - this.startPos.y);

      this.selection = { x, y, width, height };
    } else {
      // Add point to lasso (with distance threshold to avoid too many points)
      const lastPoint = this.lassoPoints[this.lassoPoints.length - 1];
      const dist = Math.hypot(pos.x - lastPoint.x, pos.y - lastPoint.y);
      if (dist > 3) {
        this.lassoPoints.push({ x: pos.x, y: pos.y });
      }
    }

    this._drawSnapshot();
    this._drawSelection();
  }

  /**
   * Handles pointer up events on the selection canvas.
   * @param {PointerEvent} e
   */
  _onPointerUp(e) {
    // End panning
    if (this._isPanning) {
      this._isPanning = false;
      this._updateCursor();
      if (e.pointerId !== undefined && this.selectionCanvas.hasPointerCapture?.(e.pointerId)) {
        this.selectionCanvas.releasePointerCapture(e.pointerId);
      }
      return;
    }

    if (!this.isSelecting) return;
    this.isSelecting = false;
    if (e.pointerId !== undefined && this.selectionCanvas.hasPointerCapture?.(e.pointerId)) {
      this.selectionCanvas.releasePointerCapture(e.pointerId);
    }

    // Finalize lasso by closing the path
    if (this.mode === 'lasso' && this.lassoPoints.length > 2) {
      // Compute bounding box for the selection
      this.selection = this._getLassoBounds();
    }

    this._drawSnapshot();
    this._drawSelection();
  }

  /**
   * Starts the marching ants animation.
   */
  _startMarchingAnts() {
    if (this.animationId) return;

    const animate = () => {
      this.marchingAntsOffset = (this.marchingAntsOffset + 0.5) % 16;
      this._drawSelection();
      this.animationId = requestAnimationFrame(animate);
    };
    this.animationId = requestAnimationFrame(animate);
  }

  /**
   * Stops the marching ants animation.
   */
  _stopMarchingAnts() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  /**
   * Performs the save action.
   * @param {boolean} locally - If true, downloads locally. If false, uploads to gallery.
   */
  async _performSave(locally) {
    const canvas = this._createExportCanvas();

    if (locally) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const prefix = (this.preExistingCanvas || this.selection || this.lassoPoints.length > 2) ? 'selection' : 'board';
      const saved = await this.app.saveCanvasLocally(canvas, `${prefix}-${ts}.png`, 'Image saved!');
      if (!saved) return;
    } else {
      await this.app.handleSaveToGallery(canvas, {
        title: this.galleryTitle.trim(),
        description: (this.galleryDescription || '').trim(),
        tags: this.shareToDiscord ? ['discord'] : [],
        tagUsername: this.tagUsername
      });
    }

    this.close();
  }

  async _performCopy() {
    const canvas = this._createExportCanvas();
    const copied = await this.app.copyCanvasToClipboard(canvas);
    if (copied) {
      this.close();
    }
  }

  _createExportCanvas() {
    if (this.preExistingCanvas && this.preExistingCanvasFixedSelection) {
      if (this.transparent) {
        return this.preExistingCanvas;
      }

      const canvas = document.createElement('canvas');
      canvas.width = this.preExistingCanvas.width;
      canvas.height = this.preExistingCanvas.height;
      const ctx = canvas.getContext('2d');
      const [r, g, b, a] = this.board.backgroundColor;
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(this.preExistingCanvas, 0, 0);
      return canvas;
    }

    if (this.mode === 'lasso' && this.lassoPoints.length > 2) {
      return this._createLassoExportCanvas();
    }

    if (this.selection && this.selection.width > 0 && this.selection.height > 0) {
      return this._createRectExportCanvas();
    }

    return this._createFullExportCanvas();
  }

  /**
   * Creates an export canvas for the full board.
   * @returns {HTMLCanvasElement}
   */
  _createFullExportCanvas() {
    const sourceCanvas = this.preExistingCanvas;
    const width = sourceCanvas ? sourceCanvas.width : this.board.dimensions[1];
    const height = sourceCanvas ? sourceCanvas.height : this.board.dimensions[0];
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    this._drawExportSource(ctx, 0, 0);
    return canvas;
  }

  /**
   * Creates an export canvas for a rectangle selection.
   * @returns {HTMLCanvasElement}
   */
  _createRectExportCanvas() {
    const s = this.selection;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(s.width));
    canvas.height = Math.max(1, Math.round(s.height));
    const ctx = canvas.getContext('2d');
    this._drawExportSource(ctx, -Math.round(s.x), -Math.round(s.y));

    return canvas;
  }

  /**
   * Creates an export canvas for a lasso selection.
   * @returns {HTMLCanvasElement}
   */
  _createLassoExportCanvas() {
    const bounds = this._getLassoBounds();
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, bounds.width);
    canvas.height = Math.max(1, bounds.height);
    const ctx = canvas.getContext('2d');

    const offsetPoints = this.lassoPoints.map(p => ({
      x: p.x - bounds.x,
      y: p.y - bounds.y
    }));

    this._drawExportSource(ctx, -bounds.x, -bounds.y);

    // Apply lasso mask using destination-in (keeps content only where mask is drawn)
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    ctx.moveTo(offsetPoints[0].x, offsetPoints[0].y);
    for (let i = 1; i < offsetPoints.length; i++) {
      ctx.lineTo(offsetPoints[i].x, offsetPoints[i].y);
    }
    ctx.closePath();
    ctx.fill();

    return canvas;
  }

  _drawExportSource(ctx, offsetX = 0, offsetY = 0) {
    ctx.save();
    ctx.translate(offsetX, offsetY);

    if (this.preExistingCanvas) {
      if (!this.transparent) {
        const [r, g, b, a] = this.board.backgroundColor;
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        ctx.fillRect(-offsetX, -offsetY, this.preExistingCanvas.width, this.preExistingCanvas.height);
      }
      ctx.drawImage(this.preExistingCanvas, 0, 0);
    } else {
      const bgColor = this.transparent ? null : this.board.backgroundColor;
      this.board.layerManager.compositeLayerRange(ctx, 0, this.board.layerManager.getLayerCount(), bgColor);
    }

    ctx.restore();
  }

  /**
   * Opens save mode with a pre-existing canvas (e.g., from SelectTool).
   * Shows the canvas centered with options to save locally or to gallery.
   * @param {HTMLCanvasElement} canvas - The canvas to save
   */
  openWithCanvas(canvas, options = {}) {
    if (this.isActive) return;
    this.isActive = true;
    const fixedSelection = options.fixedSelection ?? true;

    // Store the pre-existing canvas
    this.preExistingCanvas = canvas;
    this.preExistingCanvasFixedSelection = fixedSelection;

    // Ensure overlay is in DOM
    if (!this.overlay.parentNode) {
      if (document.body) {
        document.body.appendChild(this.overlay);
      }
    }

    // Reset state
    this.selection = null;
    this.lassoPoints = [];
    this.transparent = false;
    this.shareToDiscord = false;
    this.tagUsername = true;
    this.galleryTitle = '';
    this.galleryDescription = '';
    this.activeTool = fixedSelection ? 'pan' : 'select';
    this.optionsPanel.querySelector('#saveModeTransparent').checked = false;
    this.optionsPanel.querySelector('#saveModeShareDiscord').checked = false;
    this.optionsPanel.querySelector('#saveModeTagUsername').checked = true;
    if (this.titleInput) this.titleInput.value = '';
    if (this.descriptionInput) this.descriptionInput.value = '';

    // Size canvases to match the pre-existing canvas
    this.snapshotCanvas.width = canvas.width;
    this.snapshotCanvas.height = canvas.height;
    this.selectionCanvas.width = canvas.width;
    this.selectionCanvas.height = canvas.height;

    // Set selection to cover the full canvas only for fixed selections.
    if (fixedSelection) {
      this.selection = { x: 0, y: 0, width: canvas.width, height: canvas.height };
    }

    // Draw the canvas as the snapshot
    this._drawPreExistingSnapshot();

    // Show overlay
    this.overlay.style.display = 'flex';

    // Hide mode toggle only when the selection is fixed.
    this.modeToggle.style.display = fixedSelection ? 'none' : '';

    // Update options hint
    const hint = this.optionsPanel.querySelector('.saveModeOptionsHint');
    if (hint) {
      hint.textContent = fixedSelection
        ? 'Save selection to file or gallery'
        : 'Draw a selection or save the entire snapshot';
    }

    // Center the canvas in the viewport
    this._centerPreExistingCanvas();
    this._syncControlState();
  }

  /**
   * Draws the pre-existing canvas snapshot.
   */
  _drawPreExistingSnapshot() {
    if (!this.preExistingCanvas) return;

    const ctx = this.snapshotCtx;
    const w = this.snapshotCanvas.width;
    const h = this.snapshotCanvas.height;
    ctx.clearRect(0, 0, w, h);
    this._drawCanvasPreview(ctx, this.preExistingCanvas, 0, 0, w, h);
  }

  /**
   * Centers the pre-existing canvas in the viewport.
   */
  _centerPreExistingCanvas() {
    const overlayRect = this.overlay.getBoundingClientRect();
    const canvasWidth = this.snapshotCanvas.width;
    const canvasHeight = this.snapshotCanvas.height;

    // Calculate scale to fit in viewport with padding
    const maxWidth = overlayRect.width * 0.8;
    const maxHeight = overlayRect.height * 0.7;
    const scale = Math.min(1, maxWidth / canvasWidth, maxHeight / canvasHeight);

    // Calculate centered position
    const panX = (overlayRect.width - canvasWidth * scale) / 2;
    const panY = (overlayRect.height - canvasHeight * scale) / 2 - 30; // Offset for options panel

    this._setView(scale, panX, panY, true);
  }

  /**
   * Closes the save mode.
   */
  close() {
    if (!this.isActive) return;
    this.isActive = false;
    this.overlay.style.display = 'none';
    this._stopMarchingAnts();
    this.selection = null;
    this.lassoPoints = [];
    this.preExistingCanvas = null;
    this.preExistingCanvasFixedSelection = false;

    // Reset pan/zoom state
    this._isPanning = false;
    this.activeTool = 'select';
    this._setView(1, 0, 0, true);
    this._syncControlState();

    // Restore mode toggle visibility
    this.modeToggle.style.display = '';

    // Restore hint text
    const hint = this.optionsPanel.querySelector('.saveModeOptionsHint');
    if (hint) {
      hint.textContent = 'Draw a selection or save the entire canvas';
    }
  }

  /**
   * Cleans up event listeners.
   */
  destroy() {
    document.removeEventListener('keydown', this._keyHandler);
    this._stopMarchingAnts();
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
  }
}
