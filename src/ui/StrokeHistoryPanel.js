/**
 * StrokeHistoryPanel - Debug panel for visualizing stroke history
 *
 * Shows thumbnails of:
 * - Baked sequences (chronological compressed history)
 * - Each stroke in the strokeStack (recent history)
 * - Active strokes (in-progress)
 *
 * Only visible when dev mode is enabled.
 */
export class StrokeHistoryPanel {
  constructor() {
    this.panel = null;
    this.baseContainer = null;
    this.stackContainer = null;
    this.activeContainer = null;
    this.enabled = false;
    this.layerManager = null;
    this.activeLayerIndex = 0;
    this.thumbnailWidth = 80;
    this.thumbnailHeight = 60;
    this.updateQueued = false;
  }

  /**
   * Initialize the panel with DOM elements
   */
  init() {
    this.panel = document.getElementById('strokeHistoryPanel');
    this.baseContainer = document.getElementById('baseCanvasThumbnails');
    this.stackContainer = document.getElementById('strokeStackThumbnails');
    this.activeContainer = document.getElementById('activeStrokeThumbnails');
  }

  /**
   * Set the layer manager reference
   * @param {LayerManager} layerManager
   */
  setLayerManager(layerManager) {
    this.layerManager = layerManager;
  }

  /**
   * Set which layer to display
   * @param {number} index
   */
  setActiveLayer(index) {
    this.activeLayerIndex = index;
    if (this.enabled) {
      this.update();
    }
  }

  /**
   * Toggle panel visibility
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    if (this.panel) {
      this.panel.style.display = enabled ? 'block' : 'none';
    }
    if (enabled) {
      this.update();
    }
  }

  /**
   * Queue an update (debounced to avoid excessive re-renders)
   */
  queueUpdate() {
    if (!this.enabled || this.updateQueued) return;
    this.updateQueued = true;
    requestAnimationFrame(() => {
      this.updateQueued = false;
      this.update();
    });
  }

  /**
   * Update all thumbnails
   */
  update() {
    if (!this.enabled || !this.layerManager || !this.panel) return;

    const group = this.layerManager.getLayerGroup(this.activeLayerIndex);
    if (!group) return;

    // Base shows compressed history (bakedSequences)
    // Stack shows undo buffer (strokeStack)
    this.updateBaseThumbnails(group);
    this.updateStackThumbnails(group);
    this.updateActiveThumbnails(group);
  }

  /**
   * Create a scaled thumbnail canvas from a source canvas
   * @param {HTMLCanvasElement} sourceCanvas
   * @param {number} [srcX] - Optional crop X
   * @param {number} [srcY] - Optional crop Y
   * @param {number} [srcW] - Optional crop width
   * @param {number} [srcH] - Optional crop height
   * @returns {HTMLCanvasElement}
   */
  createThumbnail(sourceCanvas, srcX = 0, srcY = 0, srcW, srcH) {
    const thumb = document.createElement('canvas');
    thumb.width = this.thumbnailWidth;
    thumb.height = this.thumbnailHeight;
    const ctx = thumb.getContext('2d');

    // Fill with checkerboard pattern to show transparency
    this.drawCheckerboard(ctx, this.thumbnailWidth, this.thumbnailHeight);

    // Calculate scaling to fit
    const sw = srcW ?? sourceCanvas.width;
    const sh = srcH ?? sourceCanvas.height;
    const scale = Math.min(this.thumbnailWidth / sw, this.thumbnailHeight / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    const dx = (this.thumbnailWidth - dw) / 2;
    const dy = (this.thumbnailHeight - dh) / 2;

    ctx.drawImage(sourceCanvas, srcX, srcY, sw, sh, dx, dy, dw, dh);

    return thumb;
  }

  /**
   * Draw a checkerboard pattern (for transparency)
   */
  drawCheckerboard(ctx, w, h) {
    const size = 8;
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#4a4a4a';
    for (let y = 0; y < h; y += size) {
      for (let x = 0; x < w; x += size) {
        if ((x / size + y / size) % 2 === 0) {
          ctx.fillRect(x, y, size, size);
        }
      }
    }
  }

  /**
   * Update the base history: baked sequences + compressed stroke groups
   * @param {Object} group - Layer group
   */
  updateBaseThumbnails(group) {
    this.baseContainer.innerHTML = '';

    const bakedSequences = group.bakedSequences || [];

    if (bakedSequences.length === 0) {
      const emptyLabel = document.createElement('span');
      emptyLabel.className = 'strokeSectionLabel';
      emptyLabel.style.fontStyle = 'italic';
      emptyLabel.style.color = 'var(--text-muted)';
      emptyLabel.textContent = '(no history)';
      this.baseContainer.appendChild(emptyLabel);
      return;
    }

    // Render each history item in chronological order
    for (let i = 0; i < bakedSequences.length; i++) {
      const item = bakedSequences[i];
      const container = document.createElement('div');

      if (item.type === 'group') {
        // Compressed non-bakeable stroke group
        container.className = 'strokeThumbnail compressed-group';

        // Create composite thumbnail from all strokes in group
        const compositeThumb = this.createCompositeThumbnail(item.strokes);
        container.appendChild(compositeThumb);

        // Add group label
        const indexLabel = document.createElement('span');
        indexLabel.className = 'indexLabel';
        indexLabel.textContent = `G${i}`;
        indexLabel.title = `Group ${i} - ${item.strokes.length} strokes`;
        container.appendChild(indexLabel);

        // Add blend mode label with count
        const blendLabel = document.createElement('span');
        blendLabel.className = 'blendLabel';
        blendLabel.textContent = `${this.formatBlendMode(item.blendMode)} ×${item.strokes.length}`;
        blendLabel.style.backgroundColor = 'rgba(255, 152, 0, 0.9)'; // Orange for non-bakeable
        container.appendChild(blendLabel);

      } else {
        // Baked sequence
        container.className = 'strokeThumbnail baked-sequence';

        const thumb = this.createThumbnail(item.canvas);
        container.appendChild(thumb);

        const indexLabel = document.createElement('span');
        indexLabel.className = 'indexLabel';
        indexLabel.textContent = `S${i}`;
        indexLabel.title = `Sequence ${i}`;
        container.appendChild(indexLabel);

        const blendLabel = document.createElement('span');
        blendLabel.className = 'blendLabel';
        blendLabel.textContent = this.formatBlendMode(item.blendMode);
        container.appendChild(blendLabel);

        if (!this.canvasHasContent(item.canvas)) {
          container.classList.add('empty');
        }
      }

      this.baseContainer.appendChild(container);
    }
  }

  /**
   * Create a composite thumbnail showing multiple strokes layered together
   */
  createCompositeThumbnail(strokes) {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.layerManager.width;
    tempCanvas.height = this.layerManager.height;
    const tempCtx = tempCanvas.getContext('2d');

    // Draw all strokes onto temp canvas
    for (const stroke of strokes) {
      tempCtx.globalCompositeOperation = stroke.blendMode;
      tempCtx.drawImage(stroke.canvas, stroke.x, stroke.y);
    }

    // Create thumbnail from composite
    return this.createThumbnail(tempCanvas);
  }

  /**
   * Update stroke stack thumbnails - shows undo buffer
   * @param {Object} group - Layer group
   */
  updateStackThumbnails(group) {
    this.stackContainer.innerHTML = '';

    const strokeStack = group.strokeStack || [];

    if (strokeStack.length === 0) {
      const emptyLabel = document.createElement('span');
      emptyLabel.className = 'strokeSectionLabel';
      emptyLabel.style.fontStyle = 'italic';
      emptyLabel.style.color = 'var(--text-muted)';
      emptyLabel.textContent = '(empty undo buffer)';
      this.stackContainer.appendChild(emptyLabel);
      return;
    }

    const safeModes = ['source-over', 'destination-out', 'multiply', 'darken', 'lighten', 'screen'];

    for (let i = 0; i < strokeStack.length; i++) {
      const stroke = strokeStack[i];
      const isNonBakeable = !safeModes.includes(stroke.blendMode);

      const container = document.createElement('div');
      container.className = 'strokeThumbnail undo-buffer';

      if (isNonBakeable) {
        container.classList.add('non-bakeable');
      }

      // Create thumbnail from the stroke canvas
      const thumb = this.createThumbnail(stroke.canvas, 0, 0, stroke.width, stroke.height);
      container.appendChild(thumb);

      // Add index label (position in undo buffer)
      const indexLabel = document.createElement('span');
      indexLabel.className = 'indexLabel';
      indexLabel.textContent = i.toString();
      indexLabel.title = `Undo position ${i}`;
      container.appendChild(indexLabel);

      // Add blend mode label
      const blendLabel = document.createElement('span');
      blendLabel.className = 'blendLabel';
      blendLabel.textContent = this.formatBlendMode(stroke.blendMode);
      container.appendChild(blendLabel);

      // Add user ID label if not the local user
      if (stroke.userId !== undefined) {
        const userLabel = document.createElement('span');
        userLabel.className = 'userLabel';
        userLabel.textContent = `user ${stroke.userId}`;
        container.appendChild(userLabel);
      }

      this.stackContainer.appendChild(container);
    }
  }

  /**
   * Update active stroke thumbnails
   */
  updateActiveThumbnails(group) {
    this.activeContainer.innerHTML = '';

    if (group.activeStrokeByUser.size === 0) {
      const emptyLabel = document.createElement('span');
      emptyLabel.className = 'strokeSectionLabel';
      emptyLabel.style.fontStyle = 'italic';
      emptyLabel.style.color = 'var(--text-muted)';
      emptyLabel.textContent = '(none)';
      this.activeContainer.appendChild(emptyLabel);
      return;
    }

    for (const [userId, active] of group.activeStrokeByUser) {
      const container = document.createElement('div');
      container.className = 'strokeThumbnail active';

      const thumb = this.createThumbnail(active.canvas);
      container.appendChild(thumb);

      // Add blend mode label
      const blendLabel = document.createElement('span');
      blendLabel.className = 'blendLabel';
      blendLabel.textContent = this.formatBlendMode(active.blendMode);
      container.appendChild(blendLabel);

      // Add user label
      const userLabel = document.createElement('span');
      userLabel.className = 'userLabel';
      userLabel.textContent = `user ${userId}`;
      container.appendChild(userLabel);

      this.activeContainer.appendChild(container);
    }
  }

  /**
   * Format blend mode for display
   */
  formatBlendMode(blendMode) {
    const shortNames = {
      'source-over': 'normal',
      'destination-out': 'erase',
      'multiply': 'mult',
      'screen': 'screen',
      'overlay': 'overlay',
      'darken': 'darken',
      'lighten': 'lighten',
      'difference': 'diff',
      'color-dodge': 'dodge',
      'color-burn': 'burn',
      'lighter': 'add'
    };
    return shortNames[blendMode] || blendMode;
  }

  /**
   * Check if a canvas has any non-transparent content
   */
  canvasHasContent(canvas) {
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) return true;
    }
    return false;
  }
}
