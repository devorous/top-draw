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
    this.mode = 'rectangle'; // 'rectangle' or 'lasso'
    this.startPos = null;
    this.selection = null; // { x, y, width, height }
    this.lassoPoints = [];

    // Marching ants animation
    this.marchingAntsOffset = 0;
    this.animationId = null;

    // Options state
    this.transparent = false;

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

    // Mode toggle buttons (rectangle/lasso)
    const modeToggle = document.createElement('div');
    modeToggle.className = 'saveModeModeToggle';
    modeToggle.innerHTML = `
      <button class="saveModeToggleBtn active" data-mode="rectangle" title="Rectangle Selection">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="2" width="14" height="14" rx="1"/>
        </svg>
      </button>
      <button class="saveModeToggleBtn" data-mode="lasso" title="Lasso Selection">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 2C5 2 2 5 2 9C2 13 5 16 9 16C11 16 13 15 14 13"/>
          <circle cx="14" cy="13" r="2"/>
        </svg>
      </button>
    `;

    // Options panel (shown after selection or for full board)
    this.optionsPanel = document.createElement('div');
    this.optionsPanel.className = 'saveModeOptionsPanel';
    this.optionsPanel.innerHTML = `
      <div class="saveModeOptionsPanelHeader">
        <span class="saveModeOptionsTitle">Save Image</span>
        <span class="saveModeOptionsHint">Draw a selection or save the entire canvas</span>
      </div>
      <div class="saveModeOptionsPanelBody">
        <label class="saveModeOptionsCheckbox">
          <input type="checkbox" id="saveModeTransparent">
          <span>Transparent Background</span>
        </label>
      </div>
      <div class="saveModeOptionsPanelFooter">
        <button class="btn secondary" id="saveModeCancelInteractive">Cancel</button>
        <button class="btn secondary" id="saveModeGalleryInteractive">Save to Gallery</button>
        <button class="btn primary" id="saveModeLocalInteractive">Save Locally</button>
      </div>
    `;

    // Close button (top right)
    const closeBtn = document.createElement('button');
    closeBtn.className = 'saveModeCloseBtn';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = 'Cancel (Escape)';

    this.overlay.appendChild(this.snapshotCanvas);
    this.overlay.appendChild(this.selectionCanvas);
    this.overlay.appendChild(modeToggle);
    this.overlay.appendChild(this.optionsPanel);
    this.overlay.appendChild(closeBtn);

    // Insert into DOM
    const boardContainer = document.getElementById('boardContainer');
    if (boardContainer) {
      boardContainer.appendChild(this.overlay);
    } else {
      console.warn('[SaveMode] boardContainer not found, deferring DOM insertion');
    }

    // Get contexts
    this.snapshotCtx = this.snapshotCanvas.getContext('2d');
    this.snapshotCtx.imageSmoothingEnabled = true;
    this.snapshotCtx.imageSmoothingQuality = 'high';
    this.selectionCtx = this.selectionCanvas.getContext('2d');

    // Store references
    this.modeToggle = modeToggle;
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
      const mode = btn.dataset.mode;
      this.setMode(mode);
      this.modeToggle.querySelectorAll('.saveModeToggleBtn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });

    // Selection canvas pointer events
    this.selectionCanvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.selectionCanvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.selectionCanvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this.selectionCanvas.addEventListener('pointerleave', (e) => this._onPointerUp(e));

    // Close button
    this.closeBtn.addEventListener('click', () => this.close());

    // Options panel buttons
    this.optionsPanel.querySelector('#saveModeCancelInteractive').addEventListener('click', () => this.close());
    this.optionsPanel.querySelector('#saveModeLocalInteractive').addEventListener('click', () => this._performSave(true));
    this.optionsPanel.querySelector('#saveModeGalleryInteractive').addEventListener('click', () => this._performSave(false));

    // Transparent checkbox
    this.optionsPanel.querySelector('#saveModeTransparent').addEventListener('change', (e) => {
      this.transparent = e.target.checked;
      this._drawSnapshot();
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

    // Ensure overlay is in DOM (in case boardContainer wasn't available at construction)
    if (!this.overlay.parentNode) {
      const boardContainer = document.getElementById('boardContainer');
      if (boardContainer) {
        boardContainer.appendChild(this.overlay);
      }
    }

    // Reset state
    this.selection = null;
    this.lassoPoints = [];
    this.transparent = false;
    this.optionsPanel.querySelector('#saveModeTransparent').checked = false;

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

    // Apply current board transform to the canvases
    this._updateCanvasTransform();
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
  }

  /**
   * Updates canvas transform to match board zoom/pan.
   */
  _updateCanvasTransform() {
    const zoom = this.board.zoom || 1;
    const panX = this.board.panX || 0;
    const panY = this.board.panY || 0;

    // Match board transform exactly
    const transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    this.snapshotCanvas.style.transform = transform;
    this.selectionCanvas.style.transform = transform;
  }

  /**
   * Draws the board snapshot with dark overlay on non-selected areas.
   */
  _drawSnapshot() {
    const ctx = this.snapshotCtx;
    const [height, width] = this.board.dimensions;

    // Clear
    ctx.clearRect(0, 0, width, height);

    if (this.transparent) {
      // For transparent preview, show checkerboard then composite layers without background
      this._drawCheckerboard(ctx, 0, 0, width, height);
      this.board.layerManager.compositeLayerRange(ctx, 0, this.board.layerManager.getLayerCount(), null);
    } else {
      // For normal preview, just copy the mainCanvas which already has the background
      ctx.drawImage(this.board.mainCanvas, 0, 0);
    }

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

    if (this.transparent) {
      this._drawCheckerboard(ctx, s.x, s.y, s.width, s.height);
      this.board.layerManager.compositeLayerRange(ctx, 0, this.board.layerManager.getLayerCount(), null);
    } else {
      ctx.drawImage(this.board.mainCanvas, 0, 0);
    }

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

    if (this.transparent) {
      this._drawCheckerboard(ctx, bounds.x, bounds.y, bounds.width, bounds.height);
      this.board.layerManager.compositeLayerRange(ctx, 0, this.board.layerManager.getLayerCount(), null);
    } else {
      ctx.drawImage(this.board.mainCanvas, 0, 0);
    }

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
    const [height, width] = this.board.dimensions;

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
    const zoom = this.board.zoom || 1;
    const panX = this.board.panX || 0;
    const panY = this.board.panY || 0;

    // Get pointer position relative to overlay
    const screenX = e.clientX - overlayRect.left;
    const screenY = e.clientY - overlayRect.top;

    // Reverse the transform: remove pan then unscale
    const canvasX = (screenX - panX) / zoom;
    const canvasY = (screenY - panY) / zoom;

    return { x: canvasX, y: canvasY };
  }

  /**
   * Handles pointer down events on the selection canvas.
   * @param {PointerEvent} e
   */
  _onPointerDown(e) {
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
    if (!this.isSelecting) return;
    this.isSelecting = false;

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
    let canvas;

    if (this.mode === 'lasso' && this.lassoPoints.length > 2) {
      // Lasso selection - create masked canvas
      canvas = this._createLassoExportCanvas();
    } else if (this.selection && this.selection.width > 0 && this.selection.height > 0) {
      // Rectangle selection - crop to selection
      canvas = this._createRectExportCanvas();
    } else {
      // Full board
      canvas = this._createFullExportCanvas();
    }

    if (locally) {
      const link = document.createElement('a');
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const prefix = (this.selection || this.lassoPoints.length > 2) ? 'selection' : 'board';
      link.download = `${prefix}-${ts}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      this.ui.showToast('Image saved!');
    } else {
      await this.app.handleSaveToGallery(canvas);
    }

    this.close();
  }

  /**
   * Creates an export canvas for the full board.
   * @returns {HTMLCanvasElement}
   */
  _createFullExportCanvas() {
    const [height, width] = this.board.dimensions;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    if (!this.transparent) {
      const [r, g, b, a] = this.board.backgroundColor;
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      ctx.fillRect(0, 0, width, height);
    }

    this.board.layerManager.compositeLayerRange(ctx, 0, this.board.layerManager.getLayerCount(), null);
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

    if (!this.transparent) {
      const [r, g, b, a] = this.board.backgroundColor;
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Draw the full board offset by the selection position
    ctx.save();
    ctx.translate(-Math.round(s.x), -Math.round(s.y));
    this.board.layerManager.compositeLayerRange(ctx, 0, this.board.layerManager.getLayerCount(), null);
    ctx.restore();

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

    // Draw content first (background + layers)
    if (!this.transparent) {
      const [r, g, b, a] = this.board.backgroundColor;
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    ctx.save();
    ctx.translate(-bounds.x, -bounds.y);
    this.board.layerManager.compositeLayerRange(ctx, 0, this.board.layerManager.getLayerCount(), null);
    ctx.restore();

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
