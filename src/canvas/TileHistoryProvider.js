/**
 * @fileoverview TileHistoryProvider - Manages QOI-compressed tile-based history for undo/redo.
 */

export class TileHistoryProvider {
  /**
   * @param {number} maxStrokes - Maximum number of strokes to keep in history per user.
   */
  constructor(maxStrokes = 100) {
    this.maxStrokes = maxStrokes;
    /** @type {Map<number, Array<Object>>} userId -> Array of stroke records */
    this.historyByUser = new Map();
    /** @type {Map<number, Array<Object>>} userId -> Array of redo batches */
    this.redoStackByUser = new Map();
  }

  /**
   * Push a new stroke record to history.
   * @param {number} userId - User who performed the stroke.
   * @param {Object} record - { timestamp, groupIdx, snapshots: Map<TileID, QOIBuffer>, extraProps }
   */
  pushStroke(userId, record) {
    if (!this.historyByUser.has(userId)) {
      this.historyByUser.set(userId, []);
    }
    const history = this.historyByUser.get(userId);
    history.push(record);

    // Rotate history if it exceeds limit
    if (history.length > this.maxStrokes) {
      history.shift();
    }

    // Clear redo stack on new action
    this.redoStackByUser.delete(userId);
  }

  /**
   * Get the most recent stroke for a user.
   * @param {number} userId
   * @returns {Object|null}
   */
  popStroke(userId) {
    const history = this.historyByUser.get(userId);
    if (!history || history.length === 0) return null;
    return history.pop();
  }

  /**
   * Peek at the latest stroke across all layers for a user to find the latest timestamp.
   * @param {number} userId
   * @returns {number} Latest timestamp
   */
  getLatestTimestamp(userId) {
    const history = this.historyByUser.get(userId);
    if (!history || history.length === 0) return -1;
    return history[history.length - 1].timestamp;
  }

  /**
   * Undo the most recent "batch" of strokes (matching timestamp).
   * @param {number} userId
   * @returns {Array<Object>|null} Array of stroke records in the batch
   */
  undoLastBatch(userId) {
    const history = this.historyByUser.get(userId);
    if (!history || history.length === 0) return null;

    const latestTimestamp = history[history.length - 1].timestamp;
    const batch = [];

    // Collect all strokes with the same timestamp (for multi-layer erases)
    while (history.length > 0 && history[history.length - 1].timestamp === latestTimestamp) {
      batch.push(history.pop());
    }

    if (batch.length > 0) {
      if (!this.redoStackByUser.has(userId)) {
        this.redoStackByUser.set(userId, []);
      }
      this.redoStackByUser.get(userId).push(batch);
    }

    return batch.length > 0 ? batch : null;
  }

  /**
   * Redo the most recently undone batch.
   * @param {number} userId
   * @returns {Array<Object>|null}
   */
  redoLastBatch(userId) {
    const redoStack = this.redoStackByUser.get(userId);
    if (!redoStack || redoStack.length === 0) return null;

    const batch = redoStack.pop();
    if (batch) {
      if (!this.historyByUser.has(userId)) {
        this.historyByUser.set(userId, []);
      }
      const history = this.historyByUser.get(userId);
      // Re-push in order
      for (let i = batch.length - 1; i >= 0; i--) {
        history.push(batch[i]);
      }
    }
    return batch;
  }

  /**
   * Clear all history for a user.
   * @param {number} userId
   */
  clearUser(userId) {
    this.historyByUser.delete(userId);
    this.redoStackByUser.delete(userId);
  }

  /**
   * Clear all history.
   */
  clearAll() {
    this.historyByUser.clear();
    this.redoStackByUser.clear();
  }
}
