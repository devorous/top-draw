/**
 * LayerManager - Manages multiple off-screen canvas layers for drawing
 *
 * Each user-visible "layer" is a LayerGroup containing one sub-canvas per
 * blend mode used. Strokes are drawn source-over into the appropriate
 * sub-canvas. At composite time, each sub-canvas is drawn onto the target
 * using its blend mode, so blend modes compound correctly across layers.
 */
export class LayerManager {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.layerGroups = [];
    this.needsComposite = true;

    this.initLayerGroups(3); // Start with 3 layers
  }

  /**
   * Create a new sub-layer canvas for a given blend mode
   */
  _createSubLayer(blendMode) {
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.imageSmoothingQuality = 'high';
    return { blendMode, canvas, context: ctx };
  }

  /**
   * Initialize layer groups
   * @param {number} count - Number of layer groups to create
   */
  initLayerGroups(count) {
    for (let i = 0; i < count; i++) {
      this.layerGroups.push({
        id: i,
        name: `Layer ${i + 1}`,
        visible: true,
        activeBlendMode: 'source-over',  // Currently selected blend mode for this layer
        subLayers: [this._createSubLayer('source-over')]
      });
    }
  }

  /**
   * Get or create the sub-layer context for a given group.
   * Uses the group's activeBlendMode to determine which sub-layer to return.
   * The base sub-layer (source-over) is always at index 0.
   * Additional blend modes are appended on first use.
   * @param {number} groupIndex - Layer group index
   * @returns {CanvasRenderingContext2D|undefined}
   */
  getLayerContext(groupIndex) {
    const group = this.layerGroups[groupIndex];
    if (!group) return undefined;

    const blendMode = group.activeBlendMode || 'source-over';

    // Find existing sub-layer for this blend mode
    let sub = group.subLayers.find(s => s.blendMode === blendMode);
    if (!sub) {
      // Create new sub-layer for this blend mode
      sub = this._createSubLayer(blendMode);
      group.subLayers.push(sub);
    }
    return sub.context;
  }

  /**
   * Get the active blend mode for a layer group
   * @param {number} groupIndex - Layer group index
   * @returns {string} The active blend mode (e.g., 'source-over', 'multiply')
   */
  getActiveBlendMode(groupIndex) {
    const group = this.layerGroups[groupIndex];
    return group?.activeBlendMode || 'source-over';
  }

  /**
   * Set the active blend mode for a layer group.
   * Creates the sub-layer if it doesn't exist yet.
   * @param {number} groupIndex - Layer group index
   * @param {string} blendMode - CSS composite operation
   */
  setActiveBlendMode(groupIndex, blendMode) {
    const group = this.layerGroups[groupIndex];
    if (!group) return;

    group.activeBlendMode = blendMode || 'source-over';

    // Ensure sub-layer exists for this blend mode
    let sub = group.subLayers.find(s => s.blendMode === group.activeBlendMode);
    if (!sub) {
      sub = this._createSubLayer(group.activeBlendMode);
      group.subLayers.push(sub);
    }

    this.needsComposite = true;
  }

  /**
   * Get the full layer group (needed for eraser to clear all sub-layers)
   * @param {number} groupIndex - Layer group index
   * @returns {Object|undefined}
   */
  getLayerGroup(groupIndex) {
    return this.layerGroups[groupIndex];
  }

  /**
   * Get the number of layer groups
   * @returns {number}
   */
  getLayerCount() {
    return this.layerGroups.length;
  }

  /**
   * Check if a layer group is visible
   * @param {number} index - Layer group index
   * @returns {boolean}
   */
  isLayerVisible(index) {
    return this.layerGroups[index]?.visible ?? false;
  }

  /**
   * Toggle layer group visibility
   * @param {number} index - Layer group index
   * @returns {boolean} New visibility state
   */
  toggleLayerVisibility(index) {
    if (this.layerGroups[index]) {
      this.layerGroups[index].visible = !this.layerGroups[index].visible;
      this.needsComposite = true;
      return this.layerGroups[index].visible;
    }
    return false;
  }

  /**
   * Set layer group visibility
   * @param {number} index - Layer group index
   * @param {boolean} visible - Visibility state
   */
  setLayerVisibility(index, visible) {
    if (this.layerGroups[index]) {
      this.layerGroups[index].visible = visible;
      this.needsComposite = true;
    }
  }

  /**
   * Composite all visible layer groups onto a target context.
   * Groups are composited bottom to top; within each group, sub-layers are
   * drawn in order (first-use order) using their blend mode.
   * @param {CanvasRenderingContext2D} targetCtx - Target context
   */
  compositeLayers(targetCtx) {
    targetCtx.clearRect(0, 0, this.width, this.height);

    for (const group of this.layerGroups) {
      if (!group.visible) continue;
      for (const sub of group.subLayers) {
        targetCtx.globalCompositeOperation = sub.blendMode;
        targetCtx.drawImage(sub.canvas, 0, 0);
      }
    }

    // Reset to default
    targetCtx.globalCompositeOperation = 'source-over';
    this.needsComposite = false;
  }

  /**
   * Clear a specific layer group (all its sub-layers)
   * @param {number} index - Layer group index
   */
  clear(index) {
    const group = this.layerGroups[index];
    if (group) {
      for (const sub of group.subLayers) {
        sub.context.clearRect(0, 0, this.width, this.height);
      }
      this.needsComposite = true;
    }
  }

  /**
   * Clear all layer groups and their sub-layers
   */
  clearAll() {
    for (const group of this.layerGroups) {
      for (const sub of group.subLayers) {
        sub.context.clearRect(0, 0, this.width, this.height);
      }
    }
    this.needsComposite = true;
  }

  /**
   * Resize all layer group canvases (preserving content)
   * @param {number} width - New width
   * @param {number} height - New height
   */
  resize(width, height) {
    this.width = width;
    this.height = height;

    for (const group of this.layerGroups) {
      for (const sub of group.subLayers) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = sub.canvas.width;
        tempCanvas.height = sub.canvas.height;
        tempCanvas.getContext('2d').drawImage(sub.canvas, 0, 0);

        sub.canvas.width = width;
        sub.canvas.height = height;

        sub.context.lineCap = 'round';
        sub.context.lineJoin = 'round';
        sub.context.imageSmoothingQuality = 'high';

        sub.context.drawImage(tempCanvas, 0, 0);
      }
    }

    this.needsComposite = true;
  }

  /**
   * Get image data from all visible layers composited
   * @returns {ImageData}
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
   * Get all layer data for serialization (one entry per user-visible layer)
   * @returns {Array}
   */
  getLayerData() {
    return this.layerGroups.map(group => ({
      id: group.id,
      name: group.name,
      visible: group.visible,
      activeBlendMode: group.activeBlendMode || 'source-over'
    }));
  }
}
