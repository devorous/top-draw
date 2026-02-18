/**
 * LayerManager - Manages multiple off-screen canvas layers for drawing
 *
 * Each layer is an off-screen canvas that can be drawn to independently.
 * Layers are composited together onto the main visible canvas.
 */
export class LayerManager {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.layers = [];
    this.needsComposite = true;

    this.initLayers(3); // Start with 3 layers
  }

  /**
   * Initialize layer canvases
   * @param {number} count - Number of layers to create
   */
  initLayers(count) {
    for (let i = 0; i < count; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = this.width;
      canvas.height = this.height;
      const ctx = canvas.getContext('2d');
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.imageSmoothingQuality = 'high';

      this.layers.push({
        id: i,
        name: `Layer ${i + 1}`,
        visible: true,
        canvas,
        context: ctx
      });
    }
  }

  /**
   * Get a layer by index
   * @param {number} index - Layer index
   * @returns {Object|undefined} Layer object
   */
  getLayer(index) {
    return this.layers[index];
  }

  /**
   * Get the drawing context for a layer
   * @param {number} index - Layer index
   * @returns {CanvasRenderingContext2D|undefined} Layer context
   */
  getLayerContext(index) {
    return this.layers[index]?.context;
  }

  /**
   * Get the number of layers
   * @returns {number} Number of layers
   */
  getLayerCount() {
    return this.layers.length;
  }

  /**
   * Check if a layer is visible
   * @param {number} index - Layer index
   * @returns {boolean} True if visible
   */
  isLayerVisible(index) {
    return this.layers[index]?.visible ?? false;
  }

  /**
   * Toggle layer visibility
   * @param {number} index - Layer index
   * @returns {boolean} New visibility state
   */
  toggleLayerVisibility(index) {
    if (this.layers[index]) {
      this.layers[index].visible = !this.layers[index].visible;
      this.needsComposite = true;
      return this.layers[index].visible;
    }
    return false;
  }

  /**
   * Set layer visibility
   * @param {number} index - Layer index
   * @param {boolean} visible - Visibility state
   */
  setLayerVisibility(index, visible) {
    if (this.layers[index]) {
      this.layers[index].visible = visible;
      this.needsComposite = true;
    }
  }

  /**
   * Composite all visible layers onto a target context
   * Layers are composited from bottom (index 0) to top
   * @param {CanvasRenderingContext2D} targetCtx - Target context to composite onto
   */
  compositeLayers(targetCtx) {
    // Clear composite canvas
    targetCtx.clearRect(0, 0, this.width, this.height);

    // Composite all visible layers (bottom to top)
    for (const layer of this.layers) {
      if (layer.visible) {
        targetCtx.globalCompositeOperation = 'source-over';
        targetCtx.drawImage(layer.canvas, 0, 0);
      }
    }

    this.needsComposite = false;
  }

  /**
   * Clear a specific layer
   * @param {number} index - Layer index to clear
   */
  clear(index) {
    const layer = this.layers[index];
    if (layer) {
      layer.context.clearRect(0, 0, this.width, this.height);
      this.needsComposite = true;
    }
  }

  /**
   * Clear all layers
   */
  clearAll() {
    for (const layer of this.layers) {
      layer.context.clearRect(0, 0, this.width, this.height);
    }
    this.needsComposite = true;
  }

  /**
   * Resize all layer canvases
   * @param {number} width - New width
   * @param {number} height - New height
   */
  resize(width, height) {
    this.width = width;
    this.height = height;

    for (const layer of this.layers) {
      // Create a temporary canvas to preserve content
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = layer.canvas.width;
      tempCanvas.height = layer.canvas.height;
      tempCanvas.getContext('2d').drawImage(layer.canvas, 0, 0);

      // Resize the layer canvas
      layer.canvas.width = width;
      layer.canvas.height = height;

      // Restore context settings
      layer.context.lineCap = 'round';
      layer.context.lineJoin = 'round';
      layer.context.imageSmoothingQuality = 'high';

      // Draw back the preserved content
      layer.context.drawImage(tempCanvas, 0, 0);
    }

    this.needsComposite = true;
  }

  /**
   * Get image data from all visible layers composited
   * @returns {ImageData} Composited image data
   */
  getCompositedImageData() {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.width;
    tempCanvas.height = this.height;
    const tempCtx = tempCanvas.getContext('2d');

    this.compositeLayers(tempCtx);

    return tempCtx.getImageData(0, 0, this.width, this.height);
  }

  /**
   * Get all layer data for serialization
   * @returns {Array} Array of layer metadata
   */
  getLayerData() {
    return this.layers.map(layer => ({
      id: layer.id,
      name: layer.name,
      visible: layer.visible
    }));
  }
}
