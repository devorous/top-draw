/** @fileoverview Handles generating and displaying a miniature preview of a layer. */

/**
 * LayerPreview class
 */
export class LayerPreview {
  constructor() {
    this.container = null;
    this.canvas = null;
    this.ctx = null;
    this.maxDimension = 220; // Max size for the larger side
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
    this.container.style.border = '1px solid rgba(255, 255, 255, 0.2)';
    this.container.style.borderRadius = '12px';
    this.container.style.overflow = 'hidden';
    this.container.style.boxShadow = '0 10px 40px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05)';
    
    // CSS Checkerboard
    this.container.style.backgroundColor = '#1e222a';
    this.container.style.backgroundImage = `
      linear-gradient(45deg, #2a2f3a 25%, transparent 25%), 
      linear-gradient(-45deg, #2a2f3a 25%, transparent 25%), 
      linear-gradient(45deg, transparent 75%, #2a2f3a 75%), 
      linear-gradient(-45deg, transparent 75%, #2a2f3a 75%)
    `;
    this.container.style.backgroundSize = `${this.checkerSize * 2}px ${this.checkerSize * 2}px`;
    this.container.style.backgroundPosition = `0 0, 0 ${this.checkerSize}px, ${this.checkerSize}px -${this.checkerSize}px, -${this.checkerSize}px 0px`;

    this.container.style.opacity = '0';
    this.container.style.transition = 'opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1), transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)';
    this.container.style.transform = 'scale(0.9) translateX(15px)';

    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.ctx = this.canvas.getContext('2d');
    this.container.appendChild(this.canvas);

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

    // Calculate dimensions based on aspect ratio
    const boardAspect = layerManager.width / layerManager.height;
    let w, h;
    if (boardAspect > 1) { // Wide board
      w = this.maxDimension;
      h = this.maxDimension / boardAspect;
    } else { // Tall board
      h = this.maxDimension;
      w = this.maxDimension * boardAspect;
    }

    // Update container and canvas size
    this.container.style.width = `${w}px`;
    this.container.style.height = `${h}px`;
    this.canvas.width = w;
    this.canvas.height = h;

    this.ctx.save();
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.scale(w / layerManager.width, h / layerManager.height);
    
    // Composite ONLY this specific layer
    layerManager.compositeLayerRange(this.ctx, layerIdx, layerIdx + 1, null);
    
    this.ctx.restore();

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
