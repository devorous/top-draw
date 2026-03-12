/** @fileoverview Handles generating and displaying a miniature preview of a layer. */

/**
 * LayerPreview class
 */
export class LayerPreview {
  constructor() {
    this.container = null;
    this.canvas = null;
    this.ctx = null;
    this.previewSize = 150; // Max dimension
    this.checkerSize = 10;
    this.isVisible = false;
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
    this.container.style.border = '2px solid var(--accent-primary)';
    this.container.style.borderRadius = 'var(--radius-md)';
    this.container.style.overflow = 'hidden';
    this.container.style.boxShadow = 'var(--shadow-lg)';
    this.container.style.background = 'var(--bg-secondary)';

    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.container.appendChild(this.canvas);

    document.body.appendChild(this.container);
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

    const aspect = layerManager.width / layerManager.height;
    let w, h;
    if (aspect > 1) {
      w = this.previewSize;
      h = this.previewSize / aspect;
    } else {
      h = this.previewSize;
      w = this.previewSize * aspect;
    }

    this.canvas.width = w;
    this.canvas.height = h;

    this.drawCheckerboard(w, h);

    this.ctx.save();
    this.ctx.scale(w / layerManager.width, h / layerManager.height);
    
    // Composite ONLY this specific layer over the checkerboard (transparent background)
    layerManager.compositeLayerRange(this.ctx, layerIdx, layerIdx + 1, null);
    
    this.ctx.restore();

    this.container.style.left = `${x - w - 140}px`;
    this.container.style.top = `${y - h / 2}px`;
    this.container.style.display = 'block';
    this.isVisible = true;
  }

  /**
   * Hides the layer preview.
   */
  hide() {
    if (this.container) {
      this.container.style.display = 'none';
    }
    this.isVisible = false;
  }

  /**
   * Draws a checkerboard pattern for transparency visualization.
   * @param {number} w - Width
   * @param {number} h - Height
   */
  drawCheckerboard(w, h) {
    const cols = Math.ceil(w / this.checkerSize);
    const rows = Math.ceil(h / this.checkerSize);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        this.ctx.fillStyle = (r + c) % 2 === 0 ? '#2d323c' : '#363c4a';
        this.ctx.fillRect(c * this.checkerSize, r * this.checkerSize, this.checkerSize, this.checkerSize);
      }
    }
  }
}
