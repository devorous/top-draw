/**
 * @fileoverview TileTracker - Tracks which tiles in the canvas have content (are "dirty" or "occupied")
 *
 * This simplified version removes user "ownership" and griefing detection,
 * focusing solely on tracking the occupied state of the 32x32 pixel tiles.
 */

import { TileGrid } from './TileGrid.js';

export class TileTracker {
  /**
   * @param {number} width - Canvas width in pixels
   * @param {number} height - Canvas height in pixels
   */
  constructor(width, height) {
    this.tileSize = TileGrid.TILE_SIZE;
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / this.tileSize);
    this.rows = Math.ceil(height / this.tileSize);

    /** @type {Uint8Array} 1 if tile has content, 0 if empty */
    this.tiles = new Uint8Array(this.cols * this.rows);
  }

  /**
   * Convert pixel coordinates to tile index.
   * @param {number} x - X coordinate in pixels
   * @param {number} y - Y coordinate in pixels
   * @returns {number} Tile index
   */
  getTileIndex(x, y) {
    const col = Math.floor(x / this.tileSize);
    const row = Math.floor(y / this.tileSize);
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) {
      return -1;
    }
    return row * this.cols + col;
  }

  /**
   * Get tile indices for a rectangular region.
   * @param {number} x - Left edge (pixels)
   * @param {number} y - Top edge (pixels)
   * @param {number} w - Width (pixels)
   * @param {number} h - Height (pixels)
   * @returns {number[]} Array of tile indices
   */
  getTileIndicesForRect(x, y, w, h) {
    const indices = [];
    if (w <= 0 || h <= 0) return indices;

    const ts = this.tileSize;
    let startCol = Math.floor(x / ts);
    let startRow = Math.floor(y / ts);
    let endCol = Math.floor((x + w - 1) / ts);
    let endRow = Math.floor((y + h - 1) / ts);

    if (startCol < 0) startCol = 0;
    if (startRow < 0) startRow = 0;
    if (endCol >= this.cols) endCol = 0;
    if (endRow >= this.rows) endRow = 0;
    
    // Clamp to bounds
    startCol = Math.max(0, Math.min(this.cols - 1, startCol));
    startRow = Math.max(0, Math.min(this.rows - 1, startRow));
    endCol = Math.max(0, Math.min(this.cols - 1, endCol));
    endRow = Math.max(0, Math.min(this.rows - 1, endRow));

    for (let r = startRow; r <= endRow; r++) {
      const rowOffset = r * this.cols;
      for (let c = startCol; c <= endCol; c++) {
        indices.push(rowOffset + c);
      }
    }
    return indices;
  }

  /**
   * Mark a tile as having content.
   * @param {number} tileIndex - The tile index
   * @returns {boolean} True if the state changed from clean to dirty
   */
  markTileDirty(tileIndex) {
    if (tileIndex < 0 || tileIndex >= this.tiles.length) return false;
    if (this.tiles[tileIndex] === 1) return false;
    this.tiles[tileIndex] = 1;
    return true;
  }

  /**
   * Mark tiles along a path as dirty.
   * @param {Array<{x: number, y: number}>} points - Array of points
   * @param {number} radius - Brush radius
   * @param {Set<number>} [collectInto] - Optional Set to collect affected tile indices
   */
  markPathDirty(points, radius, collectInto = null) {
    if (!points || points.length === 0) return;

    const ts = this.tileSize;
    const step = ts * 0.5;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];

      const minX = p.x - radius;
      const minY = p.y - radius;
      const maxX = p.x + radius;
      const maxY = p.y + radius;

      let startCol = Math.floor(minX / ts);
      let startRow = Math.floor(minY / ts);
      let endCol = Math.floor(maxX / ts);
      let endRow = Math.floor(maxY / ts);

      startCol = Math.max(0, Math.min(this.cols - 1, startCol));
      startRow = Math.max(0, Math.min(this.rows - 1, startRow));
      endCol = Math.max(0, Math.min(this.cols - 1, endCol));
      endRow = Math.max(0, Math.min(this.rows - 1, endRow));

      for (let r = startRow; r <= endRow; r++) {
        const rowOffset = r * this.cols;
        for (let c = startCol; c <= endCol; c++) {
          const idx = rowOffset + c;
          this.markTileDirty(idx);
          if (collectInto) collectInto.add(idx);
        }
      }

      if (i < points.length - 1) {
        const next = points[i + 1];
        const dx = next.x - p.x;
        const dy = next.y - p.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        const steps = Math.max(1, Math.ceil(len / step));

        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          const px = p.x + dx * t;
          const py = p.y + dy * t;

          let sStartCol = Math.floor((px - radius) / ts);
          let sStartRow = Math.floor((py - radius) / ts);
          let sEndCol = Math.floor((px + radius) / ts);
          let sEndRow = Math.floor((py + radius) / ts);

          sStartCol = Math.max(0, Math.min(this.cols - 1, sStartCol));
          sStartRow = Math.max(0, Math.min(this.rows - 1, sStartRow));
          sEndCol = Math.max(0, Math.min(this.cols - 1, sEndCol));
          sEndRow = Math.max(0, Math.min(this.rows - 1, sEndRow));

          for (let r = sStartRow; r <= sEndRow; r++) {
            const rowOffset = r * this.cols;
            for (let c = sStartCol; c <= sEndCol; c++) {
              const idx = rowOffset + c;
              this.markTileDirty(idx);
              if (collectInto) collectInto.add(idx);
            }
          }
        }
      }
    }
  }

  /**
   * Collect tile indices along a path (without modifying state).
   * @param {Array<{x: number, y: number}>} points - Array of points
   * @param {number} radius - Brush radius
   * @param {Set<number>} collectInto - Set to collect affected tile indices
   */
  collectTilesFromPath(points, radius, collectInto) {
    if (!points || points.length === 0 || !collectInto) return;

    const ts = this.tileSize;
    const step = ts * 0.5;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];

      let startCol = Math.floor((p.x - radius) / ts);
      let startRow = Math.floor((p.y - radius) / ts);
      let endCol = Math.floor((p.x + radius) / ts);
      let endRow = Math.floor((p.y + radius) / ts);

      startCol = Math.max(0, Math.min(this.cols - 1, startCol));
      startRow = Math.max(0, Math.min(this.rows - 1, startRow));
      endCol = Math.max(0, Math.min(this.cols - 1, endCol));
      endRow = Math.max(0, Math.min(this.rows - 1, endRow));

      for (let r = startRow; r <= endRow; r++) {
        const rowOffset = r * this.cols;
        for (let c = startCol; c <= endCol; c++) {
          collectInto.add(rowOffset + c);
        }
      }

      if (i < points.length - 1) {
        const next = points[i + 1];
        const dx = next.x - p.x;
        const dy = next.y - p.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        const steps = Math.max(1, Math.ceil(len / step));

        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          const px = p.x + dx * t;
          const py = p.y + dy * t;

          let sStartCol = Math.floor((px - radius) / ts);
          let sStartRow = Math.floor((py - radius) / ts);
          let sEndCol = Math.floor((px + radius) / ts);
          let sEndRow = Math.floor((py + radius) / ts);

          sStartCol = Math.max(0, Math.min(this.cols - 1, sStartCol));
          sStartRow = Math.max(0, Math.min(this.rows - 1, sStartRow));
          sEndCol = Math.max(0, Math.min(this.cols - 1, sEndCol));
          sEndRow = Math.max(0, Math.min(this.rows - 1, sEndRow));

          for (let r = sStartRow; r <= sEndRow; r++) {
            const rowOffset = r * this.cols;
            for (let c = sStartCol; c <= sEndCol; c++) {
              collectInto.add(rowOffset + c);
            }
          }
        }
      }
    }
  }

  /**
   * Reset a tile to clean (no content).
   * @param {number} tileIndex - The tile index
   * @returns {boolean} True if the state changed from dirty to clean
   */
  clearTile(tileIndex) {
    if (tileIndex < 0 || tileIndex >= this.tiles.length) return false;
    if (this.tiles[tileIndex] === 0) return false;
    this.tiles[tileIndex] = 0;
    return true;
  }

  /**
   * Check if a tile is dirty.
   * @param {number} tileIndex - The tile index
   * @returns {boolean}
   */
  isTileDirty(tileIndex) {
    if (tileIndex < 0 || tileIndex >= this.tiles.length) return false;
    return this.tiles[tileIndex] === 1;
  }

  /**
   * Clear all tile data.
   */
  clear() {
    this.tiles.fill(0);
  }

  /**
   * Resize to match new canvas dimensions.
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
   * Get all dirty tile indices.
   * @returns {number[]}
   */
  getDirtyTiles() {
    const indices = [];
    for (let i = 0; i < this.tiles.length; i++) {
      if (this.tiles[i] === 1) indices.push(i);
    }
    return indices;
  }

  /**
   * Get count of dirty tiles.
   * @returns {number}
   */
  getDirtyCount() {
    let count = 0;
    for (let i = 0; i < this.tiles.length; i++) {
      if (this.tiles[i] === 1) count++;
    }
    return count;
  }
}
