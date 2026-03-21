/**
 * @fileoverview TileGrid - Fixed 32x32 tile-based dirty rect tracking
 *
 * Divides the canvas into a uniform grid of 32x32 pixel tiles.
 * When drawing operations touch pixels, the overlapping tiles are marked dirty.
 * At composite time, dirty tiles are merged into a small set of rectangles
 * that clip the redraw region, avoiding full-canvas compositing.
 */

export class TileGrid {
  static TILE_SIZE = 32;

  /**
   * @param {number} width  - Canvas width in pixels
   * @param {number} height - Canvas height in pixels
   */
  constructor(width, height) {
    this.tileSize = TileGrid.TILE_SIZE;
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / this.tileSize);
    this.rows = Math.ceil(height / this.tileSize);
    this.tiles = new Uint8Array(this.cols * this.rows);
  }

  /**
   * Mark all tiles overlapping a pixel-space rectangle as dirty.
   * @param {number} x - Left edge (pixels)
   * @param {number} y - Top edge (pixels)
   * @param {number} w - Width (pixels)
   * @param {number} h - Height (pixels)
   */
  markDirty(x, y, w, h) {
    if (w <= 0 || h <= 0) return;

    const ts = this.tileSize;
    let startCol = (x / ts) | 0;
    let startRow = (y / ts) | 0;
    let endCol = ((x + w - 1) / ts) | 0;
    let endRow = ((y + h - 1) / ts) | 0;

    if (startCol < 0) startCol = 0;
    if (startRow < 0) startRow = 0;
    if (endCol >= this.cols) endCol = this.cols - 1;
    if (endRow >= this.rows) endRow = this.rows - 1;

    for (let r = startRow; r <= endRow; r++) {
      const rowOffset = r * this.cols;
      for (let c = startCol; c <= endCol; c++) {
        this.tiles[rowOffset + c] = 1;
      }
    }
  }

  /**
   * Mark tiles along a line path with given radius.
   * More efficient than bounding box for diagonal lines.
   * @param {number} x0 - Start X
   * @param {number} y0 - Start Y
   * @param {number} x1 - End X
   * @param {number} y1 - End Y
   * @param {number} radius - Brush radius (half the stroke width)
   */
  markDirtyLine(x0, y0, x1, y1, radius) {
    const ts = this.tileSize;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);

    // Step size: half tile size for good coverage
    const step = ts * 0.5;
    const steps = Math.max(1, Math.ceil(len / step));

    for (let i = 0; i <= steps; i++) {
      const t = steps > 0 ? i / steps : 0;
      const px = x0 + dx * t;
      const py = y0 + dy * t;

      // Mark tiles touched by circle at this point
      const minX = px - radius;
      const minY = py - radius;
      const maxX = px + radius;
      const maxY = py + radius;

      let startCol = (minX / ts) | 0;
      let startRow = (minY / ts) | 0;
      let endCol = (maxX / ts) | 0;
      let endRow = (maxY / ts) | 0;

      if (startCol < 0) startCol = 0;
      if (startRow < 0) startRow = 0;
      if (endCol >= this.cols) endCol = this.cols - 1;
      if (endRow >= this.rows) endRow = this.rows - 1;

      for (let r = startRow; r <= endRow; r++) {
        const rowOffset = r * this.cols;
        for (let c = startCol; c <= endCol; c++) {
          this.tiles[rowOffset + c] = 1;
        }
      }
    }
  }

  /**
   * Mark tiles along a polyline path with given radius.
   * @param {Array<{x: number, y: number}>} points - Array of points
   * @param {number} radius - Brush radius
   */
  markDirtyPath(points, radius) {
    if (!points || points.length === 0) return;

    if (points.length === 1) {
      const p = points[0];
      this.markDirty(p.x - radius, p.y - radius, radius * 2, radius * 2);
      return;
    }

    for (let i = 0; i < points.length - 1; i++) {
      this.markDirtyLine(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y, radius);
    }
  }

  /**
   * Mark the entire grid as dirty (e.g. after undo/redo or full redraw).
   */
  markAllDirty() {
    this.tiles.fill(1);
  }

  /**
   * Reset all tiles to clean.
   */
  clear() {
    this.tiles.fill(0);
  }

  /**
   * @returns {boolean} True if any tile is dirty.
   */
  isDirty() {
    for (let i = 0; i < this.tiles.length; i++) {
      if (this.tiles[i]) return true;
    }
    return false;
  }

  /**
   * @returns {number} Count of dirty tiles.
   */
  getDirtyTileCount() {
    let count = 0;
    for (let i = 0; i < this.tiles.length; i++) {
      if (this.tiles[i]) count++;
    }
    return count;
  }

  /**
   * Get a snapshot of the current tile state (for debug visualization).
   * @returns {Uint8Array} Copy of tile flags
   */
  getTileSnapshot() {
    return new Uint8Array(this.tiles);
  }

  /**
   * Convert dirty tiles into a set of merged rectangles using a greedy
   * row-span algorithm. Scans left-to-right, top-to-bottom; for each
   * unvisited dirty tile, extends a run across the row, then extends
   * that run downward as far as all columns in the run remain dirty.
   *
   * @param {number} [maxRects=128] - Maximum rectangles to return.
   *   If the natural merge produces more, the smallest rects are
   *   merged with their nearest neighbor until the cap is met.
   * @returns {Array<{x: number, y: number, width: number, height: number}>}
   */
  getDirtyRects(maxRects = 128) {
    const { cols, rows, tileSize, tiles, width, height } = this;
    const visited = new Uint8Array(tiles.length);
    const rects = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (!tiles[idx] || visited[idx]) continue;

        // Find horizontal run
        let endCol = c;
        while (endCol + 1 < cols && tiles[r * cols + endCol + 1] && !visited[r * cols + endCol + 1]) {
          endCol++;
        }

        // Extend downward
        let endRow = r;
        outer:
        while (endRow + 1 < rows) {
          for (let cc = c; cc <= endCol; cc++) {
            const belowIdx = (endRow + 1) * cols + cc;
            if (!tiles[belowIdx] || visited[belowIdx]) break outer;
          }
          endRow++;
        }

        // Mark visited
        for (let rr = r; rr <= endRow; rr++) {
          for (let cc = c; cc <= endCol; cc++) {
            visited[rr * cols + cc] = 1;
          }
        }

        // Convert to pixel coords, clamped to canvas bounds
        const px = c * tileSize;
        const py = r * tileSize;
        const pw = Math.min((endCol + 1) * tileSize, width) - px;
        const ph = Math.min((endRow + 1) * tileSize, height) - py;

        rects.push({ x: px, y: py, width: pw, height: ph });
      }
    }

    // Merge down to maxRects if needed
    while (rects.length > maxRects) {
      this._mergeClosestPair(rects);
    }

    return rects;
  }

  /**
   * Resize the grid to match new canvas dimensions.
   * Clears all dirty state.
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / this.tileSize);
    this.rows = Math.ceil(height / this.tileSize);
    this.tiles = new Uint8Array(this.cols * this.rows);
  }

  /**
   * Get the ratio of dirty area to total canvas area.
   * Useful for deciding whether dirty-rect clipping is worthwhile.
   * @returns {number} 0..1
   */
  getDirtyRatio() {
    const dirtyCount = this.getDirtyTileCount();
    return dirtyCount / this.tiles.length;
  }

  /**
   * @private
   */
  _mergeClosestPair(rects) {
    if (rects.length < 2) return;
    let minCost = Infinity;
    let mergeI = 0, mergeJ = 1;

    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const cost = this._mergeCost(rects[i], rects[j]);
        if (cost < minCost) {
          minCost = cost;
          mergeI = i;
          mergeJ = j;
        }
      }
    }

    rects[mergeI] = this._unionRects(rects[mergeI], rects[mergeJ]);
    rects.splice(mergeJ, 1);
  }

  /**
   * Cost of merging two rects = area of union minus sum of individual areas.
   * Lower cost means less wasted overdraw.
   * @private
   */
  _mergeCost(a, b) {
    const u = this._unionRects(a, b);
    return (u.width * u.height) - (a.width * a.height) - (b.width * b.height);
  }

  /** @private */
  _unionRects(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.width, b.x + b.width);
    const bottom = Math.max(a.y + a.height, b.y + b.height);
    return { x, y, width: right - x, height: bottom - y };
  }
}
