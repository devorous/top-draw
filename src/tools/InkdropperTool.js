/**
 * Inkdropper (Eyedropper) tool for sampling colors from the canvas
 */
export class InkdropperTool {
  constructor(board) {
    this.name = 'inkdropper';
    this.board = board;
  }

  activate() {
    // Cursor display handled by UI.updateToolDisplay()
  }

  deactivate() {
    // No cleanup needed
  }

  onPointerDown(user, pos, e) {
    // Sample color from the main canvas at the clicked position
    this.sampleColor(pos);
  }

  onPointerMove(user, pos, lastPos, e) {
    // No action on move
  }

  onPointerUp(user, pos, e) {
    // No action on up
  }

  /**
   * Sample the color at the given canvas position
   * @param {Object} pos - {x, y} position on canvas
   */
  sampleColor(pos) {
    const ctx = this.board.mainCtx;

    // Round position to avoid subpixel sampling
    const x = Math.round(pos.x);
    const y = Math.round(pos.y);

    // Get pixel data at position (1x1 pixel)
    const imageData = ctx.getImageData(x, y, 1, 1);
    let [r, g, b, a] = imageData.data;

    // Composite against background for any transparency
    // This gives us the "visual" color that the user sees on screen
    if (a < 255) {
      const bgColor = this.board.backgroundColor;
      const alpha = a / 255;
      // Alpha compositing: result = fg * alpha + bg * (1 - alpha)
      r = Math.round(r * alpha + bgColor[0] * (1 - alpha));
      g = Math.round(g * alpha + bgColor[1] * (1 - alpha));
      b = Math.round(b * alpha + bgColor[2] * (1 - alpha));
      a = 255; // Sampled color is now fully opaque (visual color)
    }

    // Convert to RGBA array (0-255 for RGB, 0-1 for alpha)
    const rgba = [r, g, b, a / 255];

    // Update user's color
    const app = this.board.app;
    app.self.setColor(rgba);
    app.self.setOpacity(rgba[3]);

    // Update UI
    app.ui.updateSelfColor(rgba);
    app.ui.updateSelfTextStyle(app.self.size, rgba);
    app.ui.updateImageBrushOpacityValue(rgba[3]);

    // Update color picker
    if (app.colorPicker) {
      // For black/gray colors (no saturation), explicitly set hue to 0
      // to prevent the color picker from defaulting to arbitrary hues
      const isGrayscale = (r === g && g === b);
      if (isGrayscale) {
        // Set color in HSL mode with hue=0 for grayscale colors
        const lightness = r / 255 * 100; // 0-100
        app.colorPicker.setColor(`hsl(0, 0%, ${lightness}%)`, true);
        // Also update alpha separately since HSL string doesn't include it
        if (rgba[3] !== 1) {
          app.colorPicker.setColor([r, g, b, rgba[3]], true);
        }
      } else {
        app.colorPicker.setColor([r, g, b, rgba[3]], true);
      }
    }

    // Update color input menu
    if (app.colorInputMenu) {
      app.colorInputMenu.updateColor(rgba);
    }

    // Broadcast to other users if connected
    if (app.connected) {
      app.wsClient.broadcastColorChange(rgba);
    }

    // Add to recent colors
    if (app.colorPalette) {
      app.colorPalette.addRecent(rgba);
    }

    // If there's a previous tool (entered via TAB), restore it
    if (app.previousTool) {
      const toolToRestore = app.previousTool;
      app.previousTool = null; // Clear the stored tool
      app.selectTool(toolToRestore);
    }
  }
}
