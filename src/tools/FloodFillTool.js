/**
 * @fileoverview FloodFill tool for filling regions with color
 */

/**
 * Flood fill tool using optimized scanline algorithm
 * Works best on hard-pixel data with precise boundaries
 */
export class FloodFillTool {
  /**
   * @param {Object} board - Board instance
   */
  constructor(board) {
    this.name = 'fill';
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

    const width = this.board.getWidth();
    const height = this.board.getHeight();

    if (x < 0 || x >= width || y < 0 || y >= height) return;

    // Get fill color from user
    const fillColor = user?.color ?? this.board.app?.self?.color ?? [0, 0, 0, 1];
    const colorAlpha = fillColor[3];
    const opacitySlider = user?.opacity !== undefined ? user.opacity : (this.board.app?.self?.opacity !== undefined ? this.board.app.self.opacity : 1);
    const userOpacity = colorAlpha * opacitySlider;
    const fillR = Math.round(fillColor[0]);
    const fillG = Math.round(fillColor[1]);
    const fillB = Math.round(fillColor[2]);

    // Get image data from the composite canvas
    const imageData = this.board.mainCtx.getImageData(0, 0, width, height);
    const data = imageData.data;

    // Read target color at click point
    const startIdx = (y * width + x) * 4;
    const tR = data[startIdx];
    const tG = data[startIdx + 1];
    const tB = data[startIdx + 2];
    const tA = data[startIdx + 3];

    const fillTransparentOnly = tA < 10;
    const tolerance = 10;
    const tolSq = tolerance * tolerance;

    // Don't fill if target color is too close to fill color (with alpha=255 for comparison)
    if (!fillTransparentOnly) {
      const dr = tR - fillR;
      const dg = tG - fillG;
      const db = tB - fillB;
      const da = tA - 255;
      if (dr * dr + dg * dg + db * db + da * da <= tolSq) return;
    }

    // Get user regions for constraint
    const userId = this.board.app?.self?.id ?? 0;
    const debugOverlay = this.board.app?.debugOverlay;
    const userRegions = debugOverlay?.userRegions.get(userId)?.regions || null;
    const hasRegions = userRegions && userRegions.length > 0;

    // Bitmap for visited pixels — one byte per pixel
    const visited = new Uint8Array(width * height);

    // Color matching
    const matchPixel = fillTransparentOnly
      ? (idx) => data[idx + 3] < 10
      : (idx) => {
          const dr = data[idx] - tR;
          const dg = data[idx + 1] - tG;
          const db = data[idx + 2] - tB;
          const da = data[idx + 3] - tA;
          return dr * dr + dg * dg + db * db + da * da <= tolSq;
        };

    const inRegion = hasRegions
      ? (px, py) => {
          for (let i = 0; i < userRegions.length; i++) {
            const r = userRegions[i];
            if (px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height) return true;
          }
          return false;
        }
      : null;

    const canFill = (px, py) => {
      if (px < 0 || px >= width || py < 0 || py >= height) return false;
      const vi = py * width + px;
      if (visited[vi]) return false;
      if (inRegion && !inRegion(px, py)) return false;
      return matchPixel(vi * 4);
    };

    // Check start pixel
    if (!canFill(x, y)) return;

    // Begin stroke
    this.board.beginStroke(user);
    const activeLayer = user?.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
    const strokeCtx = this.board.layerManager.getUserStrokeContext(activeLayer, user?.id ?? this.board.app?.self?.id ?? 0);
    if (!strokeCtx) return;

    strokeCtx.fillStyle = `rgba(${fillR}, ${fillG}, ${fillB}, ${userOpacity})`;

    // Track bounds
    let minX = width, maxX = 0, minY = height, maxY = 0;

    // Scanline flood fill — stack stores (x, y) as flat pairs
    const stack = new Int32Array(Math.min(width * height, 500000) * 2);
    let stackPtr = 0;

    stack[stackPtr++] = x;
    stack[stackPtr++] = y;

    while (stackPtr > 0) {
      const sy = stack[--stackPtr];
      const sx = stack[--stackPtr];

      if (visited[sy * width + sx]) continue;

      // Scan left
      let left = sx;
      while (left > 0 && canFill(left - 1, sy)) left--;

      // Scan right
      let right = sx;
      while (right < width - 1 && canFill(right + 1, sy)) right++;

      // Mark visited and draw this scanline
      for (let i = left; i <= right; i++) {
        visited[sy * width + i] = 1;
      }
      strokeCtx.fillRect(left, sy, right - left + 1, 1);

      // Update bounds
      if (left < minX) minX = left;
      if (right > maxX) maxX = right;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;

      // Push spans above and below
      for (let dy = -1; dy <= 1; dy += 2) {
        const ny = sy + dy;
        if (ny < 0 || ny >= height) continue;

        let i = left;
        while (i <= right) {
          // Skip non-fillable pixels
          while (i <= right && !canFill(i, ny)) i++;
          if (i > right) break;

          // Found start of a fillable span — push one seed per span
          stack[stackPtr++] = i;
          stack[stackPtr++] = ny;

          // Skip the rest of this fillable span
          while (i <= right && canFill(i, ny)) i++;
        }
      }
    }

    if (minX > maxX) return; // Nothing filled

    this.board.expandDirtyRect(user, minX, minY, maxX - minX + 1, maxY - minY + 1);
  }

  onPointerMove(user, pos, lastPos, e) {}

  onPointerUp(user, pos, e) {
    this.board.endStroke(user);
  }
}
