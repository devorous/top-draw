/**
 * @fileoverview Inkdropper (Eyedropper) tool for sampling colors from the canvas.
 */

/**
 * InkdropperTool handles color sampling and UI updates.
 */
export class InkdropperTool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    this.name = 'inkdropper';
    this.board = board;
  }

  /**
   * Activates the tool.
   */
  activate() {}

  /**
   * Deactivates the tool and clears the top canvas.
   */
  deactivate() {
    // Always clear the preview when deactivating
    this.board.clearTop();
    this._active = false;
  }

  /**
   * Convert a board-space pointer position into a valid pixel coordinate.
   * Using floor keeps sampling inside the pixel cell under the cursor instead
   * of rounding into a neighboring pixel near cell boundaries.
   * @private
   * @param {Object} pos - {x, y} position on canvas.
   * @returns {{x: number, y: number}}
   */
  _getSamplePixel(pos) {
    const [height, width] = this.board.dimensions;

    return {
      x: Math.max(0, Math.min(width - 1, Math.floor(pos.x))),
      y: Math.max(0, Math.min(height - 1, Math.floor(pos.y)))
    };
  }

  /**
   * Snap near-extreme color channels to exact endpoints.
   * This avoids 1-step drift like 254/254/255 or 1/1/0 when sampling
   * visually pure white/black from the composited board.
   * @private
   * @param {number} value
   * @returns {number}
   */
  _normalizeChannel(value) {
    if (value <= 1) return 0;
    if (value >= 254) return 255;
    return value;
  }

  /**
   * Normalize RGB channels for sampled colors.
   * @private
   * @param {number} r
   * @param {number} g
   * @param {number} b
   * @returns {[number, number, number]}
   */
  _normalizeSampledRgb(r, g, b) {
    return [
      this._normalizeChannel(r),
      this._normalizeChannel(g),
      this._normalizeChannel(b)
    ];
  }

  /**
   * Handles pointer down event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerDown(user, pos, e) {
    this._active = true;
  }

  /**
   * Handles pointer move event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerMove(user, pos, lastPos, e) {
    this._drawColorPreview(pos);
  }

  /**
   * The swatch sits on topCanvas between moves, so it has to be repainted when
   * the surface window moves out from under it.
   */
  redrawPreview() {
    if (this._lastPreviewPos) this._drawColorPreview(this._lastPreviewPos);
  }

  /**
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerUp(user, pos, e) {
    if (!this._active) return;
    this._active = false;
    this.sampleColor(pos);
  }

  /**
   * Samples the pixel under `pos` from the composited main canvas, flattening
   * any transparency over the board background and normalizing the result.
   * @private
   * @param {Object} pos - {x, y} position on canvas.
   * @returns {{r:number, g:number, b:number, a:number}} Opaque RGB (a is 255 once flattened).
   */
  _sampleCompositedColor(pos) {
    const { x, y } = this._getSamplePixel(pos);
    // Off the display surface (the pointer is over board the window does not
    // cover) reads as the room background, which is what is painted there.
    const bgColor = this.board.backgroundColor;
    const sample = this.board.sampleViewPixel(x, y);
    let [r, g, b, a] = sample ?? [bgColor[0], bgColor[1], bgColor[2], 255];

    if (a < 255) {
      const bg = this.board.backgroundColor;
      const alpha = a / 255;
      r = Math.round(r * alpha + bg[0] * (1 - alpha));
      g = Math.round(g * alpha + bg[1] * (1 - alpha));
      b = Math.round(b * alpha + bg[2] * (1 - alpha));
      a = 255;
    }

    [r, g, b] = this._normalizeSampledRgb(r, g, b);
    return { r, g, b, a };
  }

  /**
   * Draw a small color swatch showing the color under the cursor.
   * @private
   * @param {Object} pos - {x, y} position on canvas.
   */
  _drawColorPreview(pos) {
    this.board.clearTop();

    if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y)) return;
    // Kept so redrawPreview can put the swatch back after a window move.
    this._lastPreviewPos = pos;

    const { r, g, b } = this._sampleCompositedColor(pos);

    const ctx = this.board.topCtx;
    const size = 22;
    const offset = 14;
    const sx = pos.x + offset;
    const sy = pos.y + offset;

    ctx.fillStyle = 'white';
    ctx.fillRect(sx - 1, sy - 1, size + 2, size + 2);

    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx - 0.5, sy - 0.5, size + 1, size + 1);

    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(sx, sy, size, size);
  }

  /**
   * Sample the color at the given canvas position.
   * @param {Object} pos - {x, y} position on canvas.
   */
  sampleColor(pos) {
    if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y)) return;

    const { r, g, b, a } = this._sampleCompositedColor(pos);
    const app = this.board.app;

    const rgba = [r, g, b, a / 255];

    app.self.setColor(rgba);
    app.self.setOpacity(rgba[3]);

    app.ui.updateSelfColor(rgba);
    app.ui.updateSelfTextStyle(app.self.size, rgba, app.self.font);
    app.ui.updateOpacityValue(rgba[3]);

    if (app.colorPicker) {
      app.colorPicker.setColor([r, g, b, rgba[3]], true);
    }

    if (app.colorInputMenu) {
      app.colorInputMenu.updateColor(rgba);
    }

    if (app.connected) {
      app.inputBufferManager.queueBroadcast(() => app.wsClient.broadcastColorChange(rgba));
    }

    if (app.colorPalette) {
      app.colorPalette.addRecent(rgba);
    }

    // Clear the preview box
    this.board.clearTop();

    // Auto-switch back to previous tool if enabled
    const autoSwitch = app.ui.elements.inkdropperAutoSwitch?.checked ?? true;
    if (autoSwitch && app.previousTool) {
      const toolToRestore = app.previousTool;
      app.previousTool = null;
      app.selectTool(toolToRestore);
    }
  }
}
