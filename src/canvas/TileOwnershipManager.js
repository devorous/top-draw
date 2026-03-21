/**
 * @fileoverview TileOwnershipManager - Tracks which users have drawn in which tiles
 *
 * Used for:
 * 1. Griefing detection - detecting when users erase others' work
 * 2. Coverage analysis - tracking % of canvas each user has contributed to
 *
 * Ownership Rules:
 * - When a user draws in a tile, add that user to the tile's ownership set
 * - Multiple users can own overlapping tiles
 * - When a tile becomes empty (all transparent), remove all ownership
 */

import { TileGrid } from './TileGrid.js';

export class TileOwnershipManager {
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

    /** @type {Map<number, Set<number>>} Map<tileIndex, Set<userId>> */
    this.tileOwnershipMap = new Map();

    /** @type {Map<number, Set<number>>} Map<userId, Set<tileIndex>> - reverse lookup */
    this.userTilesMap = new Map();

    // Griefing detection state
    /** @type {Map<number, Array<{timestamp: number, count: number}>>} */
    this.eraseWindowByUser = new Map();

    // Configurable thresholds by role (role index -> max tiles in window)
    this.griefingThresholds = {
      0: 10,  // GUEST
      1: 20,  // USER
      2: 20,  // TRUSTED
      3: 50,  // HELPER
      4: 50,  // MOD
      5: 100, // ADMIN
      6: 100, // NOBLE
      7: 100, // HOLY
      8: 100  // DEITY
    };

    this.griefingWindowMs = 30000; // 30 seconds
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
    if (endCol >= this.cols) endCol = this.cols - 1;
    if (endRow >= this.rows) endRow = this.rows - 1;

    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        indices.push(r * this.cols + c);
      }
    }
    return indices;
  }

  /**
   * Add ownership of a tile to a user.
   * @param {number} tileIndex - The tile index
   * @param {number} userId - The user ID
   */
  addOwnership(tileIndex, userId) {
    if (tileIndex < 0 || tileIndex >= this.cols * this.rows) return;

    // Add to tile -> users map
    if (!this.tileOwnershipMap.has(tileIndex)) {
      this.tileOwnershipMap.set(tileIndex, new Set());
    }
    this.tileOwnershipMap.get(tileIndex).add(userId);

    // Add to user -> tiles map
    if (!this.userTilesMap.has(userId)) {
      this.userTilesMap.set(userId, new Set());
    }
    this.userTilesMap.get(userId).add(tileIndex);
  }

  /**
   * Add ownership for multiple tiles from dirty rect marking.
   * @param {number} userId - The user ID
   * @param {Array<{x: number, y: number}>} points - Array of points
   * @param {number} radius - Brush radius
   * @param {Set<number>} [collectInto] - Optional Set to collect affected tile indices
   */
  addOwnershipFromPath(userId, points, radius, collectInto = null) {
    if (!points || points.length === 0) return;

    const ts = this.tileSize;
    const step = ts * 0.5;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];

      // For single point or endpoints, mark tiles in radius
      const minX = p.x - radius;
      const minY = p.y - radius;
      const maxX = p.x + radius;
      const maxY = p.y + radius;

      let startCol = Math.floor(minX / ts);
      let startRow = Math.floor(minY / ts);
      let endCol = Math.floor(maxX / ts);
      let endRow = Math.floor(maxY / ts);

      if (startCol < 0) startCol = 0;
      if (startRow < 0) startRow = 0;
      if (endCol >= this.cols) endCol = this.cols - 1;
      if (endRow >= this.rows) endRow = this.rows - 1;

      for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
          const idx = r * this.cols + c;
          this.addOwnership(idx, userId);
          if (collectInto) collectInto.add(idx);
        }
      }

      // For line segments, sample along the line
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

          const sMinX = px - radius;
          const sMinY = py - radius;
          const sMaxX = px + radius;
          const sMaxY = py + radius;

          let sStartCol = Math.floor(sMinX / ts);
          let sStartRow = Math.floor(sMinY / ts);
          let sEndCol = Math.floor(sMaxX / ts);
          let sEndRow = Math.floor(sMaxY / ts);

          if (sStartCol < 0) sStartCol = 0;
          if (sStartRow < 0) sStartRow = 0;
          if (sEndCol >= this.cols) sEndCol = this.cols - 1;
          if (sEndRow >= this.rows) sEndRow = this.rows - 1;

          for (let r = sStartRow; r <= sEndRow; r++) {
            for (let c = sStartCol; c <= sEndCol; c++) {
              const idx = r * this.cols + c;
              this.addOwnership(idx, userId);
              if (collectInto) collectInto.add(idx);
            }
          }
        }
      }
    }
  }

  /**
   * Collect tile indices along a path (without modifying ownership).
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

      const minX = p.x - radius;
      const minY = p.y - radius;
      const maxX = p.x + radius;
      const maxY = p.y + radius;

      let startCol = Math.floor(minX / ts);
      let startRow = Math.floor(minY / ts);
      let endCol = Math.floor(maxX / ts);
      let endRow = Math.floor(maxY / ts);

      if (startCol < 0) startCol = 0;
      if (startRow < 0) startRow = 0;
      if (endCol >= this.cols) endCol = this.cols - 1;
      if (endRow >= this.rows) endRow = this.rows - 1;

      for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
          collectInto.add(r * this.cols + c);
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

          const sMinX = px - radius;
          const sMinY = py - radius;
          const sMaxX = px + radius;
          const sMaxY = py + radius;

          let sStartCol = Math.floor(sMinX / ts);
          let sStartRow = Math.floor(sMinY / ts);
          let sEndCol = Math.floor(sMaxX / ts);
          let sEndRow = Math.floor(sMaxY / ts);

          if (sStartCol < 0) sStartCol = 0;
          if (sStartRow < 0) sStartRow = 0;
          if (sEndCol >= this.cols) sEndCol = this.cols - 1;
          if (sEndRow >= this.rows) sEndRow = this.rows - 1;

          for (let r = sStartRow; r <= sEndRow; r++) {
            for (let c = sStartCol; c <= sEndCol; c++) {
              collectInto.add(r * this.cols + c);
            }
          }
        }
      }
    }
  }

  /**
   * Clear all ownership from a tile.
   * @param {number} tileIndex - The tile index
   */
  clearTile(tileIndex) {
    const owners = this.tileOwnershipMap.get(tileIndex);
    if (owners) {
      // Remove from each user's tile set
      for (const userId of owners) {
        const userTiles = this.userTilesMap.get(userId);
        if (userTiles) {
          userTiles.delete(tileIndex);
        }
      }
      this.tileOwnershipMap.delete(tileIndex);
    }
  }

  /**
   * Remove a specific user's ownership from a tile.
   * @param {number} tileIndex - The tile index
   * @param {number} userId - The user ID to remove
   */
  removeOwnership(tileIndex, userId) {
    const owners = this.tileOwnershipMap.get(tileIndex);
    if (owners) {
      owners.delete(userId);
      if (owners.size === 0) {
        this.tileOwnershipMap.delete(tileIndex);
      }
    }

    const userTiles = this.userTilesMap.get(userId);
    if (userTiles) {
      userTiles.delete(tileIndex);
    }
  }

  /**
   * Get all owners of a tile.
   * @param {number} tileIndex - The tile index
   * @returns {Set<number>} Set of user IDs
   */
  getTileOwners(tileIndex) {
    return this.tileOwnershipMap.get(tileIndex) || new Set();
  }

  /**
   * Get count of tiles owned by a user.
   * @param {number} userId - The user ID
   * @returns {number} Number of tiles owned
   */
  getUserTileCount(userId) {
    const userTiles = this.userTilesMap.get(userId);
    return userTiles ? userTiles.size : 0;
  }

  /**
   * Get all tile indices owned by a user.
   * @param {number} userId - The user ID
   * @returns {Set<number>} Set of tile indices
   */
  getUserTiles(userId) {
    return this.userTilesMap.get(userId) || new Set();
  }

  /**
   * Check for griefing when a user erases tiles.
   * Returns info about tiles erased that were owned by others.
   * @param {number} eraserId - The user who is erasing
   * @param {number[]} affectedTileIndices - Tiles being erased
   * @returns {{othersErased: number, affectedUsers: Set<number>}}
   */
  checkErasedTiles(eraserId, affectedTileIndices) {
    let othersErased = 0;
    const affectedUsers = new Set();

    for (const tileIdx of affectedTileIndices) {
      const owners = this.getTileOwners(tileIdx);
      if (owners.size > 0) {
        // Check if any owner is NOT the eraser
        for (const ownerId of owners) {
          if (ownerId !== eraserId) {
            othersErased++;
            affectedUsers.add(ownerId);
            break; // Only count each tile once
          }
        }
      }
    }

    return { othersErased, affectedUsers };
  }

  /**
   * Record an erase action and check if it triggers griefing detection.
   * @param {number} userId - The user who erased
   * @param {number} userRole - The user's role (0-8)
   * @param {number} othersErasedCount - Number of others' tiles erased
   * @returns {{isGriefing: boolean, totalInWindow: number, threshold: number}}
   */
  recordEraseAndCheckGriefing(userId, userRole, othersErasedCount) {
    const now = Date.now();

    // Get or create the user's erase window
    if (!this.eraseWindowByUser.has(userId)) {
      this.eraseWindowByUser.set(userId, []);
    }
    const window = this.eraseWindowByUser.get(userId);

    // Add this erase event
    if (othersErasedCount > 0) {
      window.push({ timestamp: now, count: othersErasedCount });
    }

    // Prune old entries outside the window
    const cutoff = now - this.griefingWindowMs;
    while (window.length > 0 && window[0].timestamp < cutoff) {
      window.shift();
    }

    // Sum up total in window
    let totalInWindow = 0;
    for (const entry of window) {
      totalInWindow += entry.count;
    }

    // Get threshold for this role
    const threshold = this.griefingThresholds[userRole] ?? this.griefingThresholds[1];

    return {
      isGriefing: totalInWindow > threshold,
      totalInWindow,
      threshold
    };
  }

  /**
   * Remove a user entirely (on disconnect).
   * Note: Does NOT remove their ownership - tiles persist for session.
   * @param {number} userId - The user ID
   */
  removeUser(userId) {
    this.eraseWindowByUser.delete(userId);
    // Ownership persists - call clearUserOwnership if needed
  }

  /**
   * Clear all ownership for a user (e.g., on session reset).
   * @param {number} userId - The user ID
   */
  clearUserOwnership(userId) {
    const userTiles = this.userTilesMap.get(userId);
    if (userTiles) {
      for (const tileIdx of userTiles) {
        const owners = this.tileOwnershipMap.get(tileIdx);
        if (owners) {
          owners.delete(userId);
          if (owners.size === 0) {
            this.tileOwnershipMap.delete(tileIdx);
          }
        }
      }
      this.userTilesMap.delete(userId);
    }
    this.eraseWindowByUser.delete(userId);
  }

  /**
   * Clear all ownership data.
   */
  clear() {
    this.tileOwnershipMap.clear();
    this.userTilesMap.clear();
    this.eraseWindowByUser.clear();
  }

  /**
   * Resize to match new canvas dimensions.
   * Clears all ownership data.
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / this.tileSize);
    this.rows = Math.ceil(height / this.tileSize);
    this.clear();
  }

  /**
   * Get statistics for debugging/monitoring.
   * @returns {{totalTilesOwned: number, uniqueOwners: number, ownershipMap: Map}}
   */
  getStats() {
    return {
      totalTilesOwned: this.tileOwnershipMap.size,
      uniqueOwners: this.userTilesMap.size,
      ownershipMap: new Map(this.tileOwnershipMap)
    };
  }
}
