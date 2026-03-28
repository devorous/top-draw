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
    if (this._active) {
      this.sampleColor(this.board.lastMousePos || { x: 0, y: 0 });
    }
    this.board.clearTop();
    this._active = false;
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
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerUp(user, pos, e) {
    this._active = false;
    this.sampleColor(pos);
  }

  /**
   * Draw a small color swatch showing the color under the cursor.
   * @private
   * @param {Object} pos - {x, y} position on canvas.
   */
  _drawColorPreview(pos) {
    this.board.clearTop();

    const [height, width] = this.board.dimensions;
    const x = Math.round(pos.x);
    const y = Math.round(pos.y);
    if (x < 0 || y < 0 || x >= width || y >= height) return;

    const imageData = this.board.mainCtx.getImageData(x, y, 1, 1);
    let [r, g, b, a] = imageData.data;

    if (a < 255) {
      const bg = this.board.backgroundColor;
      const alpha = a / 255;
      r = Math.round(r * alpha + bg[0] * (1 - alpha));
      g = Math.round(g * alpha + bg[1] * (1 - alpha));
      b = Math.round(b * alpha + bg[2] * (1 - alpha));
    }

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
    const ctx = this.board.mainCtx;

    const x = Math.round(pos.x);
    const y = Math.round(pos.y);

    const imageData = ctx.getImageData(x, y, 1, 1);
    let [r, g, b, a] = imageData.data;

    if (a < 255) {
      const bgColor = this.board.backgroundColor;
      const alpha = a / 255;
      r = Math.round(r * alpha + bgColor[0] * (1 - alpha));
      g = Math.round(r * alpha + bgColor[1] * (1 - alpha));
      b = Math.round(r * alpha + bgColor[2] * (1 - alpha));
      a = 255;
    }

    const rgba = [r, g, b, a / 255];

    const app = this.board.app;
    app.self.setColor(rgba);
    app.self.setOpacity(rgba[3]);

    app.ui.updateSelfColor(rgba);
    app.ui.updateSelfTextStyle(app.self.size, rgba);
    app.ui.updateopacityValue(rgba[3]);

    if (app.colorPicker) {
      const isGrayscale = (r === g && g === b);
      if (isGrayscale) {
        const lightness = r / 255 * 100;
        app.colorPicker.setColor(`hsl(0, 0%, ${lightness}%)`, true);
        if (rgba[3] !== 1) {
          app.colorPicker.setColor([r, g, b, rgba[3]], true);
        }
      } else {
        app.colorPicker.setColor([r, g, b, rgba[3]], true);
      }
    }

    if (app.colorInputMenu) {
      app.colorInputMenu.updateColor(rgba);
    }

    if (app.connected) {
      app.wsClient.broadcastColorChange(rgba);
    }

    if (app.colorPalette) {
      app.colorPalette.addRecent(rgba);
    }

    if (app.previousTool) {
      const toolToRestore = app.previousTool;
      app.previousTool = null;
      app.selectTool(toolToRestore);
    }
  }
}
