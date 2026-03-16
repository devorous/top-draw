/**
 * @fileoverview FloodFill tool for filling regions with color
 */

/**
 * Flood fill tool using stack-based algorithm
 * Works best on hard-pixel data with precise boundaries
 */
export class FloodFillTool {
  /**
   * @param {Object} board - Board instance
   */
  constructor(board) {
    this.name = 'floodfill';
    this.board = board;
  }

  activate() {}

  deactivate() {}

  /**
   * Perform flood fill at the clicked position
   * @param {Object} user - User object
   * @param {Object} pos - Position {x, y}
   * @param {Event} e - Pointer event
   */
  onPointerDown(user, pos, e) {
    const x = Math.floor(pos.x);
    const y = Math.floor(pos.y);

    // Get the active layer context
    const activeLayer = user?.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
    const group = this.board.layerManager.getLayerGroup(activeLayer);
    if (!group) return;

    // Get the current state of the layer by compositing it to a temporary canvas
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.board.getWidth();
    tempCanvas.height = this.board.getHeight();
    const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });

    // Composite the layer to the temp canvas
    this.board.layerManager.compositeLayerRange(tempCtx, activeLayer, activeLayer + 1, null, []);

    // Get image data
    const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);

    // Get fill color from user
    const fillColor = user?.color ?? this.board.app?.self?.color ?? [0, 0, 0, 255];

    // Perform flood fill
    this.floodFill(imageData, x, y, fillColor);

    // Put the filled data back
    tempCtx.putImageData(imageData, 0, 0);

    // Begin a stroke and draw the filled result
    this.board.beginStroke(user);
    const ctx = this.board.layerManager.getUserStrokeContext(activeLayer, user?.id ?? this.board.app?.self?.id ?? 0);
    if (ctx) {
      ctx.drawImage(tempCanvas, 0, 0);
      this.board.expandDirtyRect(user, 0, 0, tempCanvas.width, tempCanvas.height);
    }
  }

  onPointerMove(user, pos, lastPos, e) {}

  onPointerUp(user, pos, e) {
    // Commit the stroke
    this.board.endStroke(user);
  }

  /**
   * Stack-based flood fill algorithm
   * @param {ImageData} imageData - Image data to modify
   * @param {number} startX - Starting X coordinate
   * @param {number} startY - Starting Y coordinate
   * @param {number[]} fillColor - Fill color [r, g, b, a]
   */
  floodFill(imageData, startX, startY, fillColor) {
    const { width, height, data } = imageData;

    // Bounds check
    if (startX < 0 || startX >= width || startY < 0 || startY >= height) {
      return;
    }

    const startIdx = (startY * width + startX) * 4;
    const targetColor = [
      data[startIdx],
      data[startIdx + 1],
      data[startIdx + 2],
      data[startIdx + 3]
    ];

    // Don't fill if target color is the same as fill color
    if (
      targetColor[0] === fillColor[0] &&
      targetColor[1] === fillColor[1] &&
      targetColor[2] === fillColor[2] &&
      targetColor[3] === fillColor[3]
    ) {
      return;
    }

    const stack = [[startX, startY]];
    const visited = new Set();

    const colorMatch = (idx) => {
      return (
        data[idx] === targetColor[0] &&
        data[idx + 1] === targetColor[1] &&
        data[idx + 2] === targetColor[2] &&
        data[idx + 3] === targetColor[3]
      );
    };

    const setPixel = (x, y) => {
      const idx = (y * width + x) * 4;
      data[idx] = fillColor[0];
      data[idx + 1] = fillColor[1];
      data[idx + 2] = fillColor[2];
      data[idx + 3] = fillColor[3];
    };

    while (stack.length > 0) {
      const [x, y] = stack.pop();
      const key = `${x},${y}`;

      if (visited.has(key)) continue;
      visited.add(key);

      if (x < 0 || x >= width || y < 0 || y >= height) continue;

      const idx = (y * width + x) * 4;

      if (!colorMatch(idx)) continue;

      setPixel(x, y);

      // Add neighbors to stack
      stack.push([x + 1, y]);
      stack.push([x - 1, y]);
      stack.push([x, y + 1]);
      stack.push([x, y - 1]);
    }
  }

  /**
   * Optimized scanline flood fill (faster for large areas)
   * @param {ImageData} imageData - Image data to modify
   * @param {number} startX - Starting X coordinate
   * @param {number} startY - Starting Y coordinate
   * @param {number[]} fillColor - Fill color [r, g, b, a]
   */
  scanlineFill(imageData, startX, startY, fillColor) {
    const { width, height, data } = imageData;

    if (startX < 0 || startX >= width || startY < 0 || startY >= height) {
      return;
    }

    const startIdx = (startY * width + startX) * 4;
    const targetColor = [
      data[startIdx],
      data[startIdx + 1],
      data[startIdx + 2],
      data[startIdx + 3]
    ];

    if (
      targetColor[0] === fillColor[0] &&
      targetColor[1] === fillColor[1] &&
      targetColor[2] === fillColor[2] &&
      targetColor[3] === fillColor[3]
    ) {
      return;
    }

    const colorMatch = (idx) => {
      return (
        data[idx] === targetColor[0] &&
        data[idx + 1] === targetColor[1] &&
        data[idx + 2] === targetColor[2] &&
        data[idx + 3] === targetColor[3]
      );
    };

    const setPixel = (x, y) => {
      const idx = (y * width + x) * 4;
      data[idx] = fillColor[0];
      data[idx + 1] = fillColor[1];
      data[idx + 2] = fillColor[2];
      data[idx + 3] = fillColor[3];
    };

    const stack = [[startX, startY]];

    while (stack.length > 0) {
      const [x, y] = stack.pop();

      if (y < 0 || y >= height) continue;

      let x1 = x;
      const idx = (y * width + x) * 4;
      if (!colorMatch(idx)) continue;

      // Find leftmost pixel in this row
      while (x1 >= 0 && colorMatch((y * width + x1) * 4)) {
        x1--;
      }
      x1++;

      // Find rightmost pixel in this row
      let x2 = x + 1;
      while (x2 < width && colorMatch((y * width + x2) * 4)) {
        x2++;
      }
      x2--;

      // Fill the scanline
      for (let i = x1; i <= x2; i++) {
        setPixel(i, y);
      }

      // Check rows above and below
      for (let i = x1; i <= x2; i++) {
        if (y > 0) {
          const idxAbove = ((y - 1) * width + i) * 4;
          if (colorMatch(idxAbove)) {
            stack.push([i, y - 1]);
          }
        }
        if (y < height - 1) {
          const idxBelow = ((y + 1) * width + i) * 4;
          if (colorMatch(idxBelow)) {
            stack.push([i, y + 1]);
          }
        }
      }
    }
  }
}
