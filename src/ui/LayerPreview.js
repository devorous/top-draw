/** @fileoverview Handles generating and displaying a miniature preview of a layer. */

/**
 * LayerPreview class
 */
export class LayerPreview {
  constructor() {
    this.container = null;
    this.canvas = null;
    this.ctx = null;
    this.image = null;
    this.maxDimension = 220; // Max size for the larger side
    this.checkerSize = 10;
    this.isVisible = false;
  }

  _getPreviewDimensions(layerManager) {
    const boardAspect = layerManager.width / layerManager.height;
    if (boardAspect > 1) {
      return {
        width: Math.round(this.maxDimension),
        height: Math.round(this.maxDimension / boardAspect)
      };
    }

    return {
      width: Math.round(this.maxDimension * boardAspect),
      height: Math.round(this.maxDimension)
    };
  }

  _createCompositeSourceCanvas(layerIdx, layerManager) {
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = layerManager.width;
    sourceCanvas.height = layerManager.height;
    const sourceCtx = sourceCanvas.getContext('2d');
    this._drawLayerGroupInto(sourceCtx, layerIdx, layerManager);
    this._drawLocalPreviewOverlay(sourceCtx, layerIdx, layerManager);
    sourceCtx.globalCompositeOperation = 'source-over';
    sourceCtx.globalAlpha = 1;
    return sourceCanvas;
  }

  _drawLayerGroupInto(targetCtx, layerIdx, layerManager) {
    const group = layerManager.getLayerGroup(layerIdx);
    if (!group) return;

    targetCtx.clearRect(0, 0, layerManager.width, layerManager.height);

    if (group.flatCanvas) {
      targetCtx.globalCompositeOperation = 'source-over';
      targetCtx.drawImage(group.flatCanvas, 0, 0);
    }

    for (const item of group.bakedSequences) {
      if (item?.type === 'group' && Array.isArray(item.strokes)) {
        for (const stroke of item.strokes) {
          layerManager._compositeStroke(targetCtx, stroke, false);
        }
        continue;
      }

      layerManager._compositeStroke(targetCtx, item, false);
    }

    for (const stroke of group.strokeStack) {
      layerManager._compositeStroke(targetCtx, stroke, false);
    }

    for (const [, activeStroke] of group.activeStrokeByUser) {
      layerManager._compositeStroke(targetCtx, activeStroke, true);
    }

    targetCtx.globalCompositeOperation = 'source-over';
    targetCtx.globalAlpha = 1;
  }

  _drawLocalPreviewOverlay(targetCtx, layerIdx, layerManager) {
    const board = layerManager?.board;
    const app = board?.app;
    const topCanvas = board?.topCanvas;
    if (!board || !app || !topCanvas) return;

    const activeLayer = app.self?.activeLayer ?? 0;
    const activeTool = app.activeTool ?? app.self?.tool;
    const isEraser = activeTool === 'erase';
    const shouldOverlay = isEraser
      ? (app.eraseAllLayers ?? false) || activeLayer === layerIdx
      : activeLayer === layerIdx;
    if (!shouldOverlay) return;

    if (isEraser) {
      targetCtx.globalCompositeOperation = 'destination-out';
      targetCtx.globalAlpha = app.self?.opacity ?? 1;
      targetCtx.drawImage(topCanvas, 0, 0);
      targetCtx.globalAlpha = 1;
      targetCtx.globalCompositeOperation = 'source-over';
      return;
    }

    const blendMode = board.getActiveLayerBlendMode?.() ?? app.self?.blendMode ?? 'source-over';
    targetCtx.globalCompositeOperation = blendMode;
    targetCtx.globalAlpha = 1;
    targetCtx.drawImage(topCanvas, 0, 0);
    targetCtx.globalCompositeOperation = 'source-over';
  }

  _renderPreviewImage(layerIdx, layerManager, width, height) {
    const sourceCanvas = this._createCompositeSourceCanvas(layerIdx, layerManager);
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = width;
    previewCanvas.height = height;
    const previewCtx = previewCanvas.getContext('2d');
    previewCtx.imageSmoothingEnabled = true;
    previewCtx.imageSmoothingQuality = 'high';
    previewCtx.clearRect(0, 0, width, height);
    previewCtx.drawImage(sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height, 0, 0, width, height);
    return previewCanvas.toDataURL('image/png');
  }

  /**
   * Initializes the preview container and canvas.
   */
  init() {
    this.container = document.createElement('div');
    this.container.className = 'layerPreviewContainer';
    this.container.style.display = 'none';
    this.container.style.position = 'fixed';
    this.container.style.zIndex = '1000';
    this.container.style.pointerEvents = 'none';
    this.container.style.border = '1px solid rgba(0, 0, 0, 0.35)';
    this.container.style.borderRadius = '12px';
    this.container.style.overflow = 'hidden';
    this.container.style.boxShadow = '0 10px 40px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05)';
    
    // CSS Checkerboard. Light tiles (same palette as .brushItem) so faint or
    // dark strokes read against the transparency instead of sinking into it.
    this.container.style.backgroundColor = '#f3f1ec';
    this.container.style.backgroundImage = `
      linear-gradient(45deg, #ddd9d0 25%, transparent 25%), 
      linear-gradient(-45deg, #ddd9d0 25%, transparent 25%), 
      linear-gradient(45deg, transparent 75%, #ddd9d0 75%), 
      linear-gradient(-45deg, transparent 75%, #ddd9d0 75%)
    `;
    this.container.style.backgroundSize = `${this.checkerSize * 2}px ${this.checkerSize * 2}px`;
    this.container.style.backgroundPosition = `0 0, 0 ${this.checkerSize}px, ${this.checkerSize}px -${this.checkerSize}px, -${this.checkerSize}px 0px`;

    this.container.style.opacity = '0';
    this.container.style.transition = 'opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1), transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)';
    this.container.style.transform = 'scale(0.9) translateX(15px)';

    this.image = document.createElement('img');
    this.image.alt = 'Layer preview';
    this.image.draggable = false;
    this.image.style.display = 'block';
    this.image.style.width = '100%';
    this.image.style.height = '100%';
    this.image.style.objectFit = 'contain';
    this.container.appendChild(this.image);

    document.body.appendChild(this.container);

    const cancelTouch = () => {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
      this.hide();
    };
    document.addEventListener('touchend', cancelTouch, { passive: true });
    document.addEventListener('touchcancel', cancelTouch, { passive: true });
  }

  /**
   * Show preview for a specific layer
   * @param {number} layerIdx - Layer index
   * @param {LayerManager} layerManager - Reference to LayerManager
   * @param {number} x - Screen X coordinate
   * @param {number} y - Screen Y coordinate
   */
  show(layerIdx, layerManager, x, y) {
    if (!layerManager) return;
    const { width: w, height: h } = this._getPreviewDimensions(layerManager);

    // Update container and canvas size
    this.container.style.width = `${w}px`;
    this.container.style.height = `${h}px`;
    if (this.image) {
      this.image.src = this._renderPreviewImage(layerIdx, layerManager, w, h);
    }

    // Position container relative to the hover point (offset left)
    this.container.style.left = `${x - w - 24}px`; 
    this.container.style.top = `${y - h / 2}px`;
    
    clearTimeout(this._hideTimer);
    this.container.style.display = 'block';
    
    // Force reflow for transition
    this.container.offsetHeight;
    
    this.container.style.opacity = '1';
    this.container.style.transform = 'scale(1) translateX(0)';
    this.isVisible = true;
  }

  /**
   * Hides the layer preview.
   */
  hide() {
    if (!this.container) return;
    this.container.style.opacity = '0';
    this.container.style.transform = 'scale(0.9) translateX(15px)';
    
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => {
      this.container.style.display = 'none';
    }, 200);
    this.isVisible = false;
  }
}
