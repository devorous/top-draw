/**
 * RegionTracker - Tracks drawing regions for canvas sync
 *
 * Handles region tracking with time-based finalization.
 * When a region becomes idle for 10 seconds, it's captured as PNG
 * and emitted for sync to the server.
 */

import { computeConvexHull, hullToBounds, generateRegionId } from './ConvexHull.js';

// Constants
const FINALIZATION_DELAY = 10000;  // 10 seconds of inactivity to finalize
const NEW_REGION_DISTANCE = 100;   // Start new region if click > 100px from last
const POINT_SAMPLE_DISTANCE = 5;   // Min distance between sampled points
const MERGE_DISTANCE = 30;         // Auto-merge regions within 30px

// Tools that create regions (brush-type tools)
const REGION_TOOLS = ['brush', 'flowPen', 'imageBrush'];

export class RegionTracker extends EventTarget {
  constructor() {
    super();

    // All tracked regions: regionId -> regionData
    this.regions = new Map();

    // Per-user drawing state
    this.userDrawingState = new Map();

    // Reference to the main canvas (set via init)
    this.mainCanvas = null;

    // Tick interval handle
    this.tickIntervalId = null;
  }

  /**
   * Initialize the region tracker
   * @param {HTMLCanvasElement} mainCanvas - The main drawing canvas
   */
  init(mainCanvas) {
    this.mainCanvas = mainCanvas;
    this.startTick();
  }

  /**
   * Start the finalization tick (runs every 1 second)
   */
  startTick() {
    if (this.tickIntervalId) return;
    this.tickIntervalId = setInterval(() => this.tick(), 1000);
  }

  /**
   * Stop the finalization tick
   */
  stopTick() {
    if (this.tickIntervalId) {
      clearInterval(this.tickIntervalId);
      this.tickIntervalId = null;
    }
  }

  /**
   * Get or create drawing state for a user
   * @param {string|number} userId
   * @returns {Object} User's drawing state
   */
  getUserDrawingState(userId) {
    const key = String(userId);
    if (!this.userDrawingState.has(key)) {
      this.userDrawingState.set(key, {
        activeRegionId: null,
        activePoints: [],
        lastPoint: null,
        lastRegionEnd: null,
        currentTool: null,
        currentSize: 10
      });
    }
    return this.userDrawingState.get(key);
  }

  /**
   * Check if a tool creates regions
   * @param {string} tool
   * @returns {boolean}
   */
  isRegionTool(tool) {
    return REGION_TOOLS.includes(tool);
  }

  /**
   * Called when user starts drawing (pointerdown)
   * @param {number} x
   * @param {number} y
   * @param {string} tool - Current tool type
   * @param {number} size - Current brush size
   * @param {string|number} userId - User ID
   * @param {string} username - Username for region labeling
   */
  startDrawing(x, y, tool, size, userId, username = '') {
    // Only track brush-type tools
    if (!this.isRegionTool(tool)) return;

    const state = this.getUserDrawingState(userId);
    state.currentTool = tool;
    state.currentSize = size;

    // Generate edge points based on brush size
    const edgePoints = this.generateEdgePoints(x, y, x, y, size);

    // Check if we should continue the last region or start a new one
    const shouldStartNew = this.shouldStartNewRegion({ x, y }, userId);


    if (shouldStartNew) {
      // Create a new region
      const regionId = `${username ? username + '_' : ''}${generateRegionId()}`;
      const hull = computeConvexHull(edgePoints, 5);

      const region = {
        id: regionId,
        userId: String(userId),
        username: username,
        points: [...edgePoints],
        hull: hull,
        bounds: hullToBounds(hull),
        lastActivity: Date.now(),
        finalized: false
      };

      this.regions.set(regionId, region);
      state.activeRegionId = regionId;
      state.activePoints = [...edgePoints];
    } else {
      // Continue the last region
      const lastRegionId = this.findLastUserRegionId(userId);
      if (lastRegionId) {
        const region = this.regions.get(lastRegionId);
        if (region && !region.finalized) {
          state.activeRegionId = lastRegionId;
          state.activePoints = [...region.points];
          state.activePoints.push(...edgePoints);
          region.points = [...state.activePoints];
          region.lastActivity = Date.now();
        }
      }
    }

    state.lastPoint = { x, y };
  }

  /**
   * Called during drawing (pointermove while mousedown)
   * @param {number} x
   * @param {number} y
   * @param {number} size - Brush size
   * @param {string|number} userId - User ID
   */
  addDrawingPoint(x, y, size, userId) {
    const state = this.getUserDrawingState(userId);

    if (!state.activeRegionId) return;

    const region = this.regions.get(state.activeRegionId);
    if (!region || region.finalized) return;

    // Sample points - don't add every single one
    if (state.lastPoint) {
      const dist = Math.hypot(x - state.lastPoint.x, y - state.lastPoint.y);
      if (dist < POINT_SAMPLE_DISTANCE) return;

      // Generate edge points based on movement direction and brush size
      const edgePoints = this.generateEdgePoints(x, y, state.lastPoint.x, state.lastPoint.y, size);
      state.activePoints.push(...edgePoints);
    } else {
      state.activePoints.push({ x, y });
    }

    state.lastPoint = { x, y };

    // Update region
    this.updateActiveRegion(userId);
  }

  /**
   * Called when user stops drawing (pointerup)
   * @param {string|number} userId - User ID
   */
  endDrawing(userId) {
    const state = this.getUserDrawingState(userId);

    if (!state.activeRegionId) return;

    const region = this.regions.get(state.activeRegionId);
    if (region) {
      // Store the last point for distance checking on next stroke
      if (state.activePoints.length > 0) {
        state.lastRegionEnd = state.activePoints[state.activePoints.length - 1];
      }

      // Update region activity time
      region.lastActivity = Date.now();


    }

    // Reset active state but keep lastRegionEnd
    state.activeRegionId = null;
    state.activePoints = [];
    state.lastPoint = null;

    // Check for and merge overlapping regions
    this.mergeOverlappingRegions(userId);
  }

  /**
   * Determine if we should start a new region or continue the last one
   * @param {{x: number, y: number}} point
   * @param {string|number} userId
   * @returns {boolean}
   */
  shouldStartNewRegion(point, userId) {
    const state = this.getUserDrawingState(userId);

    // If no previous region, start new
    if (!state.lastRegionEnd) return true;

    // Check distance from last region's end point
    const dist = Math.hypot(
      point.x - state.lastRegionEnd.x,
      point.y - state.lastRegionEnd.y
    );

    return dist > NEW_REGION_DISTANCE;
  }

  /**
   * Generate edge points for a brush stroke segment
   * @param {number} x - Current x
   * @param {number} y - Current y
   * @param {number} prevX - Previous x
   * @param {number} prevY - Previous y
   * @param {number} size - Brush size (radius)
   * @returns {Array<{x: number, y: number}>} Edge points
   */
  generateEdgePoints(x, y, prevX, prevY, size) {
    const dx = x - prevX;
    const dy = y - prevY;
    const len = Math.hypot(dx, dy);
    const padding = size * 0.5;

    // If no movement, create a circle of points
    if (len < 0.1) {
      return [
        { x: x - padding, y: y },
        { x: x + padding, y: y },
        { x: x, y: y - padding },
        { x: x, y: y + padding }
      ];
    }

    // Perpendicular direction
    const perpX = -dy / len;
    const perpY = dx / len;

    return [
      { x: x + perpX * padding, y: y + perpY * padding },
      { x: x - perpX * padding, y: y - perpY * padding }
    ];
  }

  /**
   * Find the last non-finalized region created by a user
   * @param {string|number} userId
   * @returns {string|null} Region ID or null
   */
  findLastUserRegionId(userId) {
    const userIdStr = String(userId);
    let lastRegion = null;
    let lastTime = 0;

    for (const [id, region] of this.regions) {
      if (region.userId === userIdStr && !region.finalized && region.lastActivity > lastTime) {
        lastRegion = id;
        lastTime = region.lastActivity;
      }
    }

    return lastRegion;
  }

  /**
   * Update the hull for the active region
   * @param {string|number} userId
   */
  updateActiveRegion(userId) {
    const state = this.getUserDrawingState(userId);

    if (!state.activeRegionId || state.activePoints.length === 0) return;

    const region = this.regions.get(state.activeRegionId);
    if (!region || region.finalized) return;

    const hull = computeConvexHull(state.activePoints, 5);
    const bounds = hullToBounds(hull);

    region.hull = hull;
    region.bounds = bounds;
    region.points = [...state.activePoints];
    region.lastActivity = Date.now();
  }

  /**
   * Merge overlapping regions for a user
   * @param {string|number} userId
   */
  mergeOverlappingRegions(userId) {
    const userIdStr = String(userId);
    const userRegions = Array.from(this.regions.values())
      .filter(r => r.userId === userIdStr && !r.finalized);

    if (userRegions.length < 2) return;

    // Simple merge based on distance
    for (let i = 0; i < userRegions.length; i++) {
      for (let j = i + 1; j < userRegions.length; j++) {
        if (this.shouldMergeRegions(userRegions[i], userRegions[j])) {
          this.mergeRegions(userRegions[i], userRegions[j]);
          // Restart check after merge
          this.mergeOverlappingRegions(userId);
          return;
        }
      }
    }
  }

  /**
   * Check if two regions should be merged
   * @param {Object} region1
   * @param {Object} region2
   * @returns {boolean}
   */
  shouldMergeRegions(region1, region2) {
    if (!region1.bounds || !region2.bounds) return false;

    // Expand bounds by merge distance
    const b1 = {
      x: region1.bounds.x - MERGE_DISTANCE,
      y: region1.bounds.y - MERGE_DISTANCE,
      width: region1.bounds.width + MERGE_DISTANCE * 2,
      height: region1.bounds.height + MERGE_DISTANCE * 2
    };

    const b2 = region2.bounds;

    // Check overlap
    return !(
      b1.x + b1.width < b2.x ||
      b2.x + b2.width < b1.x ||
      b1.y + b1.height < b2.y ||
      b2.y + b2.height < b1.y
    );
  }

  /**
   * Merge two regions
   * @param {Object} region1 - First region (kept)
   * @param {Object} region2 - Second region (removed)
   */
  mergeRegions(region1, region2) {

    // Combine points
    const combinedPoints = [
      ...(region1.points || []),
      ...(region2.points || [])
    ];

    // Recompute hull
    const hull = computeConvexHull(combinedPoints, 5);
    const bounds = hullToBounds(hull);

    // Update region1
    region1.hull = hull;
    region1.bounds = bounds;
    region1.points = combinedPoints;
    region1.lastActivity = Math.max(region1.lastActivity, region2.lastActivity);

    // Remove region2
    this.regions.delete(region2.id);
  }

  /**
   * Tick - Check for regions that need finalization
   * Called every 1 second
   */
  tick() {
    const now = Date.now();

    for (const [id, region] of this.regions) {
      if (region.finalized) continue;

      const idleTime = now - region.lastActivity;

      if (idleTime >= FINALIZATION_DELAY) {
        this.finalizeRegion(id);
      }
    }
  }

  /**
   * Finalize a region - capture PNG and emit event
   * @param {string} regionId
   */
  async finalizeRegion(regionId) {
    const region = this.regions.get(regionId);
    if (!region || region.finalized) return;

    region.finalized = true;



    try {
      // Capture the region as PNG
      const imageData = await this.captureRegionImage(region);

      // Flatten hull points for transmission
      const hullFlat = [];
      for (const point of region.hull) {
        hullFlat.push(point.x, point.y);
      }

      // Emit the regionFinalized event
      this.dispatchEvent(new CustomEvent('regionFinalized', {
        detail: {
          region: {
            id: region.id,
            userId: region.userId,
            username: region.username,
            hull: hullFlat,
            bounds: region.bounds,
            timestamp: Date.now()
          },
          imageData: imageData
        }
      }));

    } catch (error) {

    }
  }

  /**
   * Capture a region from the canvas as PNG
   * @param {Object} region
   * @returns {Promise<Uint8Array>} PNG data
   */
  async captureRegionImage(region) {
    if (!this.mainCanvas) {
      console.warn('[RegionTracker] No canvas reference for capture');
      return new Uint8Array(0);
    }

    const { bounds } = region;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      console.warn('[RegionTracker] Invalid bounds for capture', bounds);
      return new Uint8Array(0);
    }

    // Create a temporary canvas for the region
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = Math.ceil(bounds.width);
    tempCanvas.height = Math.ceil(bounds.height);

    const tempCtx = tempCanvas.getContext('2d');

    // Copy the region from the main canvas
    tempCtx.drawImage(
      this.mainCanvas,
      bounds.x, bounds.y, bounds.width, bounds.height,
      0, 0, bounds.width, bounds.height
    );

    // Convert to PNG blob
    return new Promise((resolve, reject) => {
      tempCanvas.toBlob(
        async (blob) => {
          if (!blob) {
            reject(new Error('Failed to create blob'));
            return;
          }

          // Convert blob to Uint8Array
          const arrayBuffer = await blob.arrayBuffer();
          resolve(new Uint8Array(arrayBuffer));
        },
        'image/png'
      );
    });
  }

  /**
   * Clear all regions (e.g., when canvas is cleared)
   */
  clearAllRegions() {
    this.regions.clear();
    this.userDrawingState.clear();
  }

  /**
   * Get all finalized regions
   * @returns {Array<Object>}
   */
  getFinalizedRegions() {
    return Array.from(this.regions.values()).filter(r => r.finalized);
  }

  /**
   * Get region count
   * @returns {number}
   */
  getRegionCount() {
    return this.regions.size;
  }

  /**
   * Destroy the tracker
   */
  destroy() {
    this.stopTick();
    this.regions.clear();
    this.userDrawingState.clear();
    this.mainCanvas = null;
  }
}
