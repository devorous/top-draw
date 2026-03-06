/**
 * Debug Overlay for visualizing dirty rectangles
 *
 * Provides a visual overlay showing dirty rect regions used for optimized compositing.
 * Used for development and debugging of the canvas rendering optimization.
 */

// Dirty rect visualization color
const RECT_COLOR = {
  fill: 'rgba(255, 107, 107, 0.15)',
  stroke: 'rgba(255, 107, 107, 0.8)'
};

export class DebugOverlay {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.enabled = false;
    this.board = null; // Reference to Board.js for accessing _dirtyRects
    this.dashOffset = 0; // For marching ants animation
    this.animationId = null;
    this.dirtyRectHistory = []; // Array of {rects: [...], timestamp: number}
    this.RECT_DISPLAY_DURATION = 2000; // Keep rects visible for 2 seconds

    // Stroke point tracking
    this.strokePoints = new Map(); // userId -> [{x, y, source}, ...]
    this.activeStrokes = new Map(); // userId -> strokeId

    // Per-user persistent regions (array of bounding rects, merges nearby regions)
    this.userRegions = new Map(); // userId -> {username, regions: [{x, y, width, height}, ...]}
    this.USER_REGION_MERGE_DISTANCE = 100; // Merge regions within 100px
  }

  /**
   * Initialize the debug overlay
   * @param {HTMLCanvasElement} canvas - The overlay canvas element
   * @param {number} width - Canvas width
   * @param {number} height - Canvas height
   */
  init(canvas, width, height) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.canvas.width = width;
    this.canvas.height = height;

    // Start animation loop for marching ants
    this.startAnimation();
  }

  /**
   * Set reference to Board for accessing dirty rects
   * @param {Board} board - Board instance
   */
  setBoard(board) {
    this.board = board;
  }

  /**
   * Capture dirty rects before they're reset (called by Board.compositeAllLayers)
   * @param {Array} dirtyRects - Array of {x, y, width, height} rectangles
   */
  captureDirtyRects(dirtyRects) {
    if (this.enabled && dirtyRects && dirtyRects.length > 0) {
      // Add to history with timestamp for fade-out effect
      this.dirtyRectHistory.push({
        rects: dirtyRects.slice(),
        timestamp: Date.now()
      });
    } else if (!this.enabled) {
      this.dirtyRectHistory = [];
    }

    // Clean up old rects
    const now = Date.now();
    this.dirtyRectHistory = this.dirtyRectHistory.filter(
      entry => (now - entry.timestamp) < this.RECT_DISPLAY_DURATION
    );
  }

  /**
   * Toggle the debug overlay on/off
   * @returns {boolean} New enabled state
   */
  toggle() {
    this.enabled = !this.enabled;
    console.log('[DebugOverlay] Toggle called, enabled:', this.enabled);
    if (!this.enabled) {
      this.clear();
      this.dirtyRectHistory = [];
      this.userRegions.clear();
      this.strokePoints.clear();
    }
    return this.enabled;
  }

  /**
   * Check if overlay is enabled
   * @returns {boolean}
   */
  isEnabled() {
    return this.enabled;
  }

  /**
   * Clear the overlay canvas
   */
  clear() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Start the animation loop for marching ants
   */
  startAnimation() {
    const animate = () => {
      this.dashOffset = (this.dashOffset + 1) % 16;
      if (this.enabled) {
        this.render();
      }
      this.animationId = requestAnimationFrame(animate);
    };
    animate();
  }

  /**
   * Stop the animation loop
   */
  stopAnimation() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  /**
   * Render the dirty rects overlay
   */
  render() {
    if (!this.enabled || !this.ctx) return;

    this.clear();

    const hasStrokePoints = this.strokePoints.size > 0;
    const hasUserRegions = this.userRegions.size > 0;
    const hasDirtyRects = this.dirtyRectHistory.length > 0;

    if (!hasDirtyRects && !hasStrokePoints && !hasUserRegions) {
      // Draw "waiting" message if enabled but no data
      if (this.enabled) {
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        this.ctx.font = '14px monospace';
        this.ctx.fillText('Dev Mode: Waiting for draw...', 10, 30);
      }
      return;
    }

    const now = Date.now();
    let totalArea = 0;
    const canvasArea = this.canvas.width * this.canvas.height;

    // Draw dirty rects with fade-out based on age
    if (hasDirtyRects) {
      this.dirtyRectHistory.forEach((entry, historyIdx) => {
        const age = now - entry.timestamp;
        const fadeProgress = age / this.RECT_DISPLAY_DURATION; // 0 to 1
        const opacity = 1 - fadeProgress; // Fade from 1 to 0

        entry.rects.forEach((rect, index) => {
          if (historyIdx === this.dirtyRectHistory.length - 1) {
            totalArea += rect.width * rect.height;
          }

          // Fill with semi-transparent color (fades out)
          const fillOpacity = 0.15 * opacity;
          this.ctx.fillStyle = `rgba(255, 107, 107, ${fillOpacity})`;
          this.ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

          // Stroke with marching ants (fades out)
          const strokeOpacity = 0.8 * opacity;
          this.ctx.strokeStyle = `rgba(255, 107, 107, ${strokeOpacity})`;
          this.ctx.lineWidth = 2;
          this.ctx.setLineDash([8, 8]);
          this.ctx.lineDashOffset = -this.dashOffset;
          this.ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);

          // Draw rect index label (only for newest batch)
          if (historyIdx === this.dirtyRectHistory.length - 1 && opacity > 0.5) {
            this.ctx.fillStyle = `rgba(255, 107, 107, ${strokeOpacity})`;
            this.ctx.font = 'bold 12px monospace';
            this.ctx.fillText(`#${index}`, rect.x + 4, rect.y + 16);
          }
        });
      });
    }

    // Draw per-user persistent regions (multiple bounding boxes per user)
    this.ctx.setLineDash([]);
    const userColors = [
      'rgba(78, 205, 196, 0.5)',   // Teal
      'rgba(255, 230, 109, 0.5)',  // Yellow
      'rgba(199, 125, 255, 0.5)',  // Purple
      'rgba(69, 183, 209, 0.5)'    // Blue
    ];
    let colorIdx = 0;
    for (const [userId, userData] of this.userRegions) {
      const color = userColors[colorIdx % userColors.length];
      colorIdx++;

      // Draw each region for this user
      userData.regions.forEach((region, idx) => {
        // Draw semi-transparent fill
        this.ctx.fillStyle = color.replace('0.5', '0.1');
        this.ctx.fillRect(region.x, region.y, region.width, region.height);

        // Draw solid border
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 3;
        this.ctx.setLineDash([]);
        this.ctx.strokeRect(region.x, region.y, region.width, region.height);

        // Draw username label on every region
        this.ctx.fillStyle = color;
        this.ctx.font = 'bold 14px monospace';
        this.ctx.fillText(userData.username || `User ${userId}`, region.x + 8, region.y + 22);

        // Draw region count if multiple regions
        if (userData.regions.length > 1) {
          this.ctx.fillStyle = color;
          this.ctx.font = '11px monospace';
          this.ctx.fillText(`${idx + 1}/${userData.regions.length}`, region.x + 8, region.y + region.height - 8);
        }
      });
    }

    // Draw stroke points
    this.ctx.setLineDash([]);
    for (const [userId, points] of this.strokePoints) {
      points.forEach((point, idx) => {
        // Color based on source
        if (point.source === 'tick') {
          this.ctx.fillStyle = 'rgba(0, 255, 0, 0.6)'; // Green for tick
        } else if (point.source === 'catchup') {
          this.ctx.fillStyle = 'rgba(255, 165, 0, 0.6)'; // Orange for catchup
        } else {
          this.ctx.fillStyle = 'rgba(100, 150, 255, 0.6)'; // Blue for other
        }

        // Draw small circle for each point
        this.ctx.beginPath();
        this.ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
        this.ctx.fill();

        // Draw line between consecutive points
        if (idx > 0) {
          const prevPoint = points[idx - 1];
          this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
          this.ctx.lineWidth = 1;
          this.ctx.beginPath();
          this.ctx.moveTo(prevPoint.x, prevPoint.y);
          this.ctx.lineTo(point.x, point.y);
          this.ctx.stroke();
        }
      });
    }

    // Draw stats in top-right corner
    const latestRects = this.dirtyRectHistory.length > 0
      ? this.dirtyRectHistory[this.dirtyRectHistory.length - 1].rects
      : [];

    // Calculate total regions across all users
    let totalRegionCount = 0;
    for (const [userId, userData] of this.userRegions) {
      totalRegionCount += userData.regions.length;
    }

    if (latestRects.length > 0 || this.userRegions.size > 0) {
      this.ctx.setLineDash([]);
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      this.ctx.fillRect(this.canvas.width - 220, 10, 210, 118);

      this.ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      this.ctx.font = 'bold 14px monospace';
      this.ctx.fillText('DEV OVERLAY', this.canvas.width - 210, 30);

      this.ctx.font = '12px monospace';
      this.ctx.fillText(`Dirty Rects: ${latestRects.length}`, this.canvas.width - 210, 50);

      const areaPct = ((totalArea / canvasArea) * 100).toFixed(1);
      this.ctx.fillText(`Area: ${areaPct}%`, this.canvas.width - 210, 68);

      this.ctx.fillText(`Users: ${this.userRegions.size}`, this.canvas.width - 210, 86);
      this.ctx.fillText(`Regions: ${totalRegionCount}`, this.canvas.width - 210, 104);

      const maxRects = this.board?.MAX_DIRTY_RECTS || 20;
      this.ctx.fillText(`Max: ${maxRects}`, this.canvas.width - 210, 122);
    }
  }

  /**
   * Cleanup resources
   */
  destroy() {
    this.stopAnimation();
    this.clear();
    this.board = null;
    this.canvas = null;
    this.ctx = null;
  }

  /**
   * Expand or create a user region when they draw
   * Uses merge logic similar to dirty rects - nearby regions merge, distant ones stay separate
   * @param {string|number} userId - User ID
   * @param {string} username - Username for display
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @param {number} width - Width of drawn area
   * @param {number} height - Height of drawn area
   */
  expandUserRegion(userId, username, x, y, width, height) {
    if (!this.enabled) return;

    const newRect = { x, y, width, height };

    if (!this.userRegions.has(userId)) {
      // Create new user entry with first region
      this.userRegions.set(userId, {
        username,
        regions: [newRect]
      });
      return;
    }

    const userData = this.userRegions.get(userId);
    userData.username = username; // Update username in case it changed

    // Find closest region
    let closestIdx = -1;
    let closestDist = Infinity;

    for (let i = 0; i < userData.regions.length; i++) {
      const dist = this._rectDistance(userData.regions[i], newRect);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = i;
      }
    }

    // Merge if close enough, otherwise create new region
    if (closestDist <= this.USER_REGION_MERGE_DISTANCE) {
      userData.regions[closestIdx] = this._unionRects(userData.regions[closestIdx], newRect);
    } else {
      userData.regions.push(newRect);
    }
  }

  /**
   * Calculate distance between two rectangles (same as Board.js logic)
   * @private
   */
  _rectDistance(r1, r2) {
    const overlapX = !(r1.x + r1.width < r2.x || r2.x + r2.width < r1.x);
    const overlapY = !(r1.y + r1.height < r2.y || r2.y + r2.height < r1.y);

    if (overlapX && overlapY) return 0; // Overlapping

    const gapX = overlapX ? 0 : Math.max(0,
      Math.max(r1.x, r2.x) - Math.min(r1.x + r1.width, r2.x + r2.width));
    const gapY = overlapY ? 0 : Math.max(0,
      Math.max(r1.y, r2.y) - Math.min(r1.y + r1.height, r2.y + r2.height));

    return Math.sqrt(gapX * gapX + gapY * gapY);
  }

  /**
   * Union two rectangles into their bounding box (same as Board.js logic)
   * @private
   */
  _unionRects(r1, r2) {
    const minX = Math.min(r1.x, r2.x);
    const minY = Math.min(r1.y, r2.y);
    const maxX = Math.max(r1.x + r1.width, r2.x + r2.width);
    const maxY = Math.max(r1.y + r1.height, r2.y + r2.height);
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /**
   * Clear a user's region (e.g., when they disconnect)
   * @param {string|number} userId - User ID
   */
  clearUserRegion(userId) {
    this.userRegions.delete(userId);
  }

  /**
   * Clear all debug overlay data (user regions, dirty rects, stroke points)
   * Called when the clear button is pressed
   */
  clearAll() {
    console.log('[DebugOverlay] Clearing all debug data');
    this.dirtyRectHistory = [];
    this.userRegions.clear();
    this.strokePoints.clear();
    this.activeStrokes.clear();
    this.clear(); // Clear the canvas
  }

  // Stroke point tracking methods (for visualizing individual stroke points)
  startStrokeTracking(userId, strokeId) {
    if (!this.enabled) return;
    this.activeStrokes.set(userId, strokeId);
    this.strokePoints.set(userId, []);
  }

  addStrokePoint(userId, x, y, source = 'unknown') {
    if (!this.enabled) return;
    if (!this.strokePoints.has(userId)) {
      this.strokePoints.set(userId, []);
    }
    this.strokePoints.get(userId).push({ x, y, source });
  }

  endStrokeTracking(userId) {
    if (!this.enabled) return;
    this.activeStrokes.delete(userId);
    // Keep points for a few seconds for visualization
    setTimeout(() => {
      this.strokePoints.delete(userId);
    }, 3000);
  }

  // Stub methods for backward compatibility
  startDrawing(x, y, userId, username) {}
  addDrawingPoint(x, y, size, userId) {}
  endDrawing(userId) {}
  cancelDrawing(userId) {}
  addRegion(region) {}
}
