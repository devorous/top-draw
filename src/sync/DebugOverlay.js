/**
 * Debug Overlay for visualizing sync regions
 *
 * Provides a visual overlay showing convex hull regions with different colors.
 * Used for development and debugging of the canvas sync feature.
 */

import { computeConvexHull, hullToBounds, generateRegionId, pointInHull } from './ConvexHull.js';

// Region colors - 5 distinct colors that cycle
const REGION_COLORS = [
  { fill: 'rgba(255, 107, 107, 0.25)', stroke: 'rgba(255, 107, 107, 0.8)' },  // Red
  { fill: 'rgba(78, 205, 196, 0.25)', stroke: 'rgba(78, 205, 196, 0.8)' },   // Teal
  { fill: 'rgba(255, 230, 109, 0.25)', stroke: 'rgba(255, 230, 109, 0.8)' }, // Yellow
  { fill: 'rgba(199, 125, 255, 0.25)', stroke: 'rgba(199, 125, 255, 0.8)' }, // Purple
  { fill: 'rgba(69, 183, 209, 0.25)', stroke: 'rgba(69, 183, 209, 0.8)' }    // Blue
];

// Distance threshold for starting a new region vs continuing existing
const NEW_REGION_DISTANCE = 100;

// Minimum points to sample (we don't need every single point)
const POINT_SAMPLE_DISTANCE = 5;

// Tools that create regions (brush-type tools)
const REGION_TOOLS = ['brush', 'pen', 'imageBrush'];

// Tools that will subtract from regions (future feature)
const ERASER_TOOLS = ['erase'];

// Distance threshold for merging nearby regions (pixels)
const MERGE_DISTANCE = 30;

// Minimum area for a region to survive (in square pixels)
const MIN_REGION_AREA = 500;

// Distance threshold for clustering points into separate regions
const CLUSTER_DISTANCE = 50;

// Eraser region color (reddish, semi-transparent)
const ERASER_COLOR = {
  fill: 'rgba(255, 80, 80, 0.3)',
  stroke: 'rgba(255, 80, 80, 0.9)'
};

export class DebugOverlay {
  constructor(options = {}) {
    this.canvas = null;
    this.ctx = null;
    this.enabled = false;
    this.regions = [];
    this.colorIndex = 0;

    // Animation properties
    this.animationFrame = null;
    this.dashOffset = 0;

    // Per-user active drawing tracking (keyed by oduserId)
    // Each entry: { activeRegionIndex, activePoints, lastPoint, lastRegionEnd, currentTool, currentSize }
    this.userDrawingState = new Map();

    // Per-user eraser tracking
    // Each entry: { eraserPoints, eraserPath, eraserLastPoint, isErasing, eraserRegionIndex }
    this.userEraserState = new Map();

    // Eraser history for troll detection (not visualized)
    this.eraserHistory = [];

    // Point visualization for debugging stroke differences
    this.strokePoints = new Map(); // userId -> { points: [], color: string, isLocal: boolean }
    this.showStrokePoints = true; // Toggle with app.debugOverlay.showStrokePoints = false
    this.logPoints = true; // Toggle with app.debugOverlay.logPoints = false
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
        activeRegionIndex: -1,
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
   * Get or create eraser state for a user
   * @param {string|number} userId
   * @returns {Object} User's eraser state
   */
  getUserEraserState(userId) {
    const key = String(userId);
    if (!this.userEraserState.has(key)) {
      this.userEraserState.set(key, {
        eraserPoints: [],
        eraserPath: [],
        eraserLastPoint: null,
        isErasing: false,
        eraserRegionIndex: -1
      });
    }
    return this.userEraserState.get(key);
  }

  /**
   * Initialize the debug overlay
   * @param {HTMLCanvasElement} canvas - The debug overlay canvas element
   * @param {number} width - Canvas width
   * @param {number} height - Canvas height
   */
  init(canvas, width, height) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    canvas.width = width;
    canvas.height = height;

    // Start hidden
    this.canvas.style.display = 'none';

    console.log('[DebugOverlay] Initialized', { canvas, width, height, ctx: this.ctx });
  }

  /**
   * Toggle dev mode on/off
   * @returns {boolean} New enabled state
   */
  toggle() {
    this.enabled = !this.enabled;
    this.canvas.style.display = this.enabled ? 'block' : 'none';

    console.log('[DebugOverlay] Toggle', {
      enabled: this.enabled,
      regionCount: this.regions.length,
      canvasDisplay: this.canvas.style.display,
      canvasSize: { w: this.canvas.width, h: this.canvas.height }
    });

    if (this.enabled) {
      this.startAnimation();
      this.render();
    } else {
      this.stopAnimation();
    }

    return this.enabled;
  }

  /**
   * Set dev mode state
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    if (this.enabled !== enabled) {
      this.toggle();
    }
  }

  /**
   * Start the dash animation loop
   */
  startAnimation() {
    const animate = () => {
      this.dashOffset -= 0.5;
      if (this.dashOffset < -16) this.dashOffset = 0;
      this.render();
      this.animationFrame = requestAnimationFrame(animate);
    };
    this.animationFrame = requestAnimationFrame(animate);
  }

  /**
   * Stop the dash animation loop
   */
  stopAnimation() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  /**
   * Add a new region to visualize
   * @param {Object} region - Region with hull points
   * @param {Array<{x: number, y: number}>} region.hull - Convex hull vertices
   * @param {Object} region.bounds - Bounding box {x, y, width, height}
   * @param {string} [region.id] - Optional region ID
   * @returns {number} Index of the added region
   */
  addRegion(region) {
    const colorIdx = this.colorIndex % REGION_COLORS.length;
    this.colorIndex++;

    const newRegion = {
      ...region,
      colorIndex: colorIdx,
      color: REGION_COLORS[colorIdx]
    };

    this.regions.push(newRegion);

    console.log('[DebugOverlay] addRegion - total:', this.regions.length);

    if (this.enabled) {
      this.render();
    }

    return this.regions.length - 1;
  }

  /**
   * Update an existing region
   * @param {number} index - Region index
   * @param {Object} region - Updated region data
   */
  updateRegion(index, region) {
    if (index >= 0 && index < this.regions.length) {
      const existingColor = this.regions[index].color;
      const existingColorIndex = this.regions[index].colorIndex;
      this.regions[index] = {
        ...region,
        colorIndex: existingColorIndex,
        color: existingColor
      };

      if (this.enabled) {
        this.render();
      }
    }
  }

  /**
   * Remove a region by index
   * @param {number} index - Region index to remove
   */
  removeRegion(index) {
    if (index >= 0 && index < this.regions.length) {
      this.regions.splice(index, 1);

      if (this.enabled) {
        this.render();
      }
    }
  }

  /**
   * Remove a region by ID
   * @param {string} id - Region ID to remove
   */
  removeRegionById(id) {
    const index = this.regions.findIndex(r => r.id === id);
    if (index !== -1) {
      this.removeRegion(index);
    }
  }

  /**
   * Clear all regions
   */
  clearRegions() {
    this.regions = [];
    this.colorIndex = 0;

    if (this.enabled) {
      this.render();
    }
  }

  /**
   * Draw a single region
   * @param {Object} region - Region to draw
   */
  drawRegion(region) {
    const { hull, color, bounds } = region;

    if (!hull || hull.length < 3) {
      return;
    }

    const ctx = this.ctx;

    // Draw filled hull
    ctx.beginPath();
    ctx.moveTo(hull[0].x, hull[0].y);
    for (let i = 1; i < hull.length; i++) {
      ctx.lineTo(hull[i].x, hull[i].y);
    }
    ctx.closePath();

    ctx.fillStyle = color.fill;
    ctx.fill();

    // Draw animated dashed stroke
    ctx.strokeStyle = color.stroke;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.lineDashOffset = this.dashOffset;
    ctx.stroke();

    // Reset line dash
    ctx.setLineDash([]);

    // Draw hull vertices as small circles
    ctx.fillStyle = color.stroke;
    for (const point of hull) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw bounding box (lighter, dashed)
    if (bounds) {
      ctx.strokeStyle = color.stroke;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.globalAlpha = 0.5;
      ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    }

    // Draw region label if ID exists
    if (region.id) {
      const labelX = bounds ? bounds.x + 5 : hull[0].x;
      const labelY = bounds ? bounds.y - 5 : hull[0].y - 10;

      ctx.font = '11px Inter, sans-serif';
      ctx.fillStyle = color.stroke;
      ctx.fillText(region.id.substring(0, 12), labelX, labelY);
    }
  }

  /**
   * Get all current regions
   * @returns {Array} Array of regions
   */
  getRegions() {
    return this.regions;
  }

  /**
   * Check if overlay is currently enabled
   * @returns {boolean}
   */
  isEnabled() {
    return this.enabled;
  }

  /**
   * Add a test region for debugging purposes
   * Call this from console: app.debugOverlay.addTestRegion()
   */
  addTestRegion() {
    const testRegion = {
      hull: [
        { x: 100, y: 100 },
        { x: 300, y: 100 },
        { x: 350, y: 200 },
        { x: 200, y: 300 },
        { x: 50, y: 200 }
      ],
      bounds: { x: 50, y: 100, width: 300, height: 200 },
      id: `test_${Date.now()}`
    };

    console.log('[DebugOverlay] Adding test region', testRegion);
    return this.addRegion(testRegion);
  }

  // ========================================
  // Real-time drawing tracking
  // ========================================

  /**
   * Check if a tool creates regions
   * @param {string} tool
   * @returns {boolean}
   */
  isRegionTool(tool) {
    return REGION_TOOLS.includes(tool);
  }

  /**
   * Check if a tool erases (for future region subtraction)
   * @param {string} tool
   * @returns {boolean}
   */
  isEraserTool(tool) {
    return ERASER_TOOLS.includes(tool);
  }

  /**
   * Called when user starts drawing (pointerdown)
   * @param {number} x
   * @param {number} y
   * @param {string} tool - Current tool type
   * @param {number} size - Current brush size
   * @param {string|number} [userId] - User ID (defaults to 'self')
   * @param {string} [username] - Username for region labeling
   */
  startDrawing(x, y, tool, size, userId = 'self', username = '') {
    if (!this.enabled) return;

    const state = this.getUserDrawingState(userId);
    state.currentTool = tool;
    state.currentSize = size;

    // Handle eraser separately
    if (this.isEraserTool(tool)) {
      this.startErasing(x, y, size, userId, username);
      return;
    }

    // Only track brush-type tools for regions
    if (!this.isRegionTool(tool)) {
      console.log('[DebugOverlay] Ignoring non-region tool:', tool);
      return;
    }

    // Generate edge points based on brush size
    const edgePoints = this.generateEdgePoints(x, y, x, y, size);

    // Check if we should continue the last region or start a new one
    const shouldStartNew = this.shouldStartNewRegion({ x, y }, userId);

    console.log('[DebugOverlay] startDrawing', { x, y, tool, size, userId, username, shouldStartNew });

    // Generate region ID with username prefix
    const regionIdPrefix = username ? `${username}_` : '';

    if (shouldStartNew) {
      // Start a brand new region with edge points
      state.activePoints = [...edgePoints];
      state.activeRegionIndex = this.addRegion({
        hull: computeConvexHull(state.activePoints, 5), // Less padding since size is accounted for
        bounds: hullToBounds(computeConvexHull(state.activePoints, 5)),
        id: regionIdPrefix + generateRegionId(),
        points: [...state.activePoints],
        userId: String(userId),
        username: username
      });
    } else {
      // Continue adding to the last region for this user
      state.activeRegionIndex = this.findLastUserRegionIndex(userId);
      if (state.activeRegionIndex >= 0) {
        const region = this.regions[state.activeRegionIndex];
        state.activePoints = region.points ? [...region.points] : [];
        state.activePoints.push(...edgePoints);
      } else {
        // Fallback: start a new region
        state.activePoints = [...edgePoints];
        state.activeRegionIndex = this.addRegion({
          hull: computeConvexHull(state.activePoints, 5),
          bounds: hullToBounds(computeConvexHull(state.activePoints, 5)),
          id: regionIdPrefix + generateRegionId(),
          points: [...state.activePoints],
          userId: String(userId),
          username: username
        });
      }
    }

    state.lastPoint = { x, y };
  }

  /**
   * Find the last region created by a specific user
   * @param {string|number} userId
   * @returns {number} Region index or -1 if not found
   */
  findLastUserRegionIndex(userId) {
    const userIdStr = String(userId);
    for (let i = this.regions.length - 1; i >= 0; i--) {
      if (this.regions[i].userId === userIdStr && !this.regions[i].isEraser) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Generate edge points for a brush stroke segment
   * Creates points on both sides of the stroke perpendicular to movement direction
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

    // Use 0.5x brush size as padding for edge points
    const padding = size * 0.5;

    // If no movement, create a circle of points around the center
    if (len < 0.1) {
      return [
        { x: x - padding, y: y },
        { x: x + padding, y: y },
        { x: x, y: y - padding },
        { x: x, y: y + padding }
      ];
    }

    // Normalize and get perpendicular direction
    const perpX = -dy / len;
    const perpY = dx / len;

    // Create points on both edges of the brush with 0.5x size padding
    return [
      { x: x + perpX * padding, y: y + perpY * padding },
      { x: x - perpX * padding, y: y - perpY * padding }
    ];
  }

  /**
   * Called during drawing (pointermove while mousedown)
   * @param {number} x
   * @param {number} y
   * @param {number} [size] - Optional brush size (uses stored size if not provided)
   * @param {string|number} [userId] - User ID (defaults to 'self')
   */
  addDrawingPoint(x, y, size, userId = 'self') {
    if (!this.enabled) return;

    const state = this.getUserDrawingState(userId);
    const eraserState = this.getUserEraserState(userId);
    const brushSize = size ?? state.currentSize;

    // Handle eraser separately
    if (eraserState.isErasing) {
      this.addEraserPoint(x, y, brushSize, userId);
      return;
    }

    if (state.activeRegionIndex < 0) return;

    // Sample points - don't add every single one
    if (state.lastPoint) {
      const dist = Math.hypot(x - state.lastPoint.x, y - state.lastPoint.y);
      if (dist < POINT_SAMPLE_DISTANCE) return;

      // Generate edge points based on movement direction and brush size
      const edgePoints = this.generateEdgePoints(x, y, state.lastPoint.x, state.lastPoint.y, brushSize);
      state.activePoints.push(...edgePoints);
    } else {
      // First point - add center
      state.activePoints.push({ x, y });
    }

    state.lastPoint = { x, y };

    // Recompute hull and update region
    this.updateActiveRegion(userId);
  }

  /**
   * Called when user stops drawing (pointerup)
   * @param {string|number} [userId] - User ID (defaults to 'self')
   */
  endDrawing(userId = 'self') {
    if (!this.enabled) return;

    const state = this.getUserDrawingState(userId);
    const eraserState = this.getUserEraserState(userId);

    // Handle eraser separately
    if (eraserState.isErasing) {
      this.endErasing(userId);
      return;
    }

    if (state.activeRegionIndex < 0) return;

    console.log('[DebugOverlay] endDrawing', {
      userId,
      regionIndex: state.activeRegionIndex,
      pointCount: state.activePoints.length
    });

    // Store the last point for distance checking on next stroke
    if (state.activePoints.length > 0) {
      state.lastRegionEnd = state.activePoints[state.activePoints.length - 1];
    }

    // Finalize the region
    this.updateActiveRegion(userId);

    // Reset active state
    state.activeRegionIndex = -1;
    state.activePoints = [];
    state.lastPoint = null;

    // Check for and merge overlapping regions (only for this user)
    this.mergeOverlappingRegions(userId);

    // Update lastRegionEnd to point to the (possibly merged) last region for this user
    const lastUserRegionIndex = this.findLastUserRegionIndex(userId);
    if (lastUserRegionIndex >= 0) {
      const lastRegion = this.regions[lastUserRegionIndex];
      if (lastRegion.points && lastRegion.points.length > 0) {
        state.lastRegionEnd = lastRegion.points[lastRegion.points.length - 1];
      }
    }
  }

  /**
   * Determine if we should start a new region or continue the last one
   * @param {{x: number, y: number}} point
   * @param {string|number} [userId] - User ID (defaults to 'self')
   * @returns {boolean}
   */
  shouldStartNewRegion(point, userId = 'self') {
    const state = this.getUserDrawingState(userId);

    // If no previous region for this user, start new
    if (!state.lastRegionEnd) {
      return true;
    }

    // Check distance from last region's end point
    const dist = Math.hypot(
      point.x - state.lastRegionEnd.x,
      point.y - state.lastRegionEnd.y
    );

    console.log('[DebugOverlay] Distance from last region (user:', userId, '):', dist, 'threshold:', NEW_REGION_DISTANCE);

    return dist > NEW_REGION_DISTANCE;
  }

  /**
   * Recompute the hull for the active region and update it
   * @param {string|number} [userId] - User ID (defaults to 'self')
   */
  updateActiveRegion(userId = 'self') {
    const state = this.getUserDrawingState(userId);

    if (state.activeRegionIndex < 0 || state.activePoints.length === 0) return;

    // Use minimal padding since brush size is already accounted for in edge points
    const hull = computeConvexHull(state.activePoints, 5);
    const bounds = hullToBounds(hull);

    const region = this.regions[state.activeRegionIndex];
    if (region) {
      region.hull = hull;
      region.bounds = bounds;
      region.points = [...state.activePoints];
    }

    // Render is handled by animation loop
  }

  /**
   * Cancel the current drawing (e.g., on right-click)
   * @param {string|number} [userId] - User ID (defaults to 'self')
   */
  cancelDrawing(userId = 'self') {
    const state = this.getUserDrawingState(userId);
    const eraserState = this.getUserEraserState(userId);

    // Cancel eraser stroke
    if (eraserState.isErasing) {
      console.log('[DebugOverlay] cancelDrawing (eraser) for user:', userId);
      // Remove the temporary eraser region
      if (eraserState.eraserRegionIndex >= 0 && eraserState.eraserRegionIndex < this.regions.length) {
        this.regions.splice(eraserState.eraserRegionIndex, 1);
      }
      eraserState.isErasing = false;
      eraserState.eraserPoints = [];
      eraserState.eraserPath = [];
      eraserState.eraserLastPoint = null;
      eraserState.eraserRegionIndex = -1;
      return;
    }

    // Cancel region drawing
    if (state.activeRegionIndex >= 0) {
      console.log('[DebugOverlay] cancelDrawing (region) for user:', userId);
      // Remove the active region if it was just started
      if (state.activePoints.length < 10) {
        this.removeRegion(state.activeRegionIndex);
      }
      state.activeRegionIndex = -1;
      state.activePoints = [];
      state.lastPoint = null;
    }
  }

  // ========================================
  // Region Merging
  // ========================================

  /**
   * Check if two bounding boxes overlap or are within merge distance
   * @param {Object} bounds1 - First bounding box {x, y, width, height}
   * @param {Object} bounds2 - Second bounding box {x, y, width, height}
   * @returns {boolean}
   */
  boundsOverlapOrClose(bounds1, bounds2) {
    if (!bounds1 || !bounds2) return false;

    // Expand bounds by merge distance for proximity check
    const expanded1 = {
      x: bounds1.x - MERGE_DISTANCE,
      y: bounds1.y - MERGE_DISTANCE,
      width: bounds1.width + MERGE_DISTANCE * 2,
      height: bounds1.height + MERGE_DISTANCE * 2
    };

    // Check if expanded bounds1 overlaps with bounds2
    return !(
      expanded1.x + expanded1.width < bounds2.x ||
      bounds2.x + bounds2.width < expanded1.x ||
      expanded1.y + expanded1.height < bounds2.y ||
      bounds2.y + bounds2.height < expanded1.y
    );
  }

  /**
   * Check if two hulls overlap (any point of one inside the other)
   * @param {Array<{x, y}>} hull1
   * @param {Array<{x, y}>} hull2
   * @returns {boolean}
   */
  hullsOverlap(hull1, hull2) {
    if (!hull1 || !hull2 || hull1.length < 3 || hull2.length < 3) {
      return false;
    }

    // Check if any point of hull1 is inside hull2
    for (const point of hull1) {
      if (pointInHull(point, hull2)) {
        return true;
      }
    }

    // Check if any point of hull2 is inside hull1
    for (const point of hull2) {
      if (pointInHull(point, hull1)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Calculate minimum distance between two hulls
   * @param {Array<{x, y}>} hull1
   * @param {Array<{x, y}>} hull2
   * @returns {number} Minimum distance between any two points
   */
  hullDistance(hull1, hull2) {
    if (!hull1 || !hull2 || hull1.length === 0 || hull2.length === 0) {
      return Infinity;
    }

    let minDist = Infinity;

    for (const p1 of hull1) {
      for (const p2 of hull2) {
        const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        if (dist < minDist) {
          minDist = dist;
        }
      }
    }

    return minDist;
  }

  /**
   * Check if two regions should be merged
   * @param {Object} region1
   * @param {Object} region2
   * @returns {boolean}
   */
  shouldMergeRegions(region1, region2) {
    // Quick rejection: check bounding boxes first
    if (!this.boundsOverlapOrClose(region1.bounds, region2.bounds)) {
      return false;
    }

    // Check if hulls actually overlap
    if (this.hullsOverlap(region1.hull, region2.hull)) {
      return true;
    }

    // Check if hulls are within merge distance
    const dist = this.hullDistance(region1.hull, region2.hull);
    return dist <= MERGE_DISTANCE;
  }

  /**
   * Merge two regions into one
   * @param {number} index1 - Index of first region (will be kept)
   * @param {number} index2 - Index of second region (will be removed)
   * @returns {number} Index of merged region
   */
  mergeRegions(index1, index2) {
    // Ensure index1 < index2 for consistent removal
    if (index1 > index2) {
      [index1, index2] = [index2, index1];
    }

    const region1 = this.regions[index1];
    const region2 = this.regions[index2];

    console.log('[DebugOverlay] Merging regions', {
      region1: region1.id,
      region2: region2.id,
      userId: region1.userId
    });

    // Combine all points from both regions
    const combinedPoints = [
      ...(region1.points || []),
      ...(region2.points || [])
    ];

    // Recompute hull from combined points
    const newHull = computeConvexHull(combinedPoints, 5);
    const newBounds = hullToBounds(newHull);

    // Update region1 with merged data (preserve userId and username)
    region1.hull = newHull;
    region1.bounds = newBounds;
    region1.points = combinedPoints;
    region1.id = region1.id + '+' + region2.id.split('_').pop();
    // userId and username are preserved from region1

    // Remove region2 (higher index, so region1's index stays valid)
    this.regions.splice(index2, 1);

    console.log('[DebugOverlay] Merged - total regions now:', this.regions.length);

    return index1;
  }

  /**
   * Check all regions and merge any that overlap (only regions from same user)
   * Called after a stroke is completed
   * @param {string|number} [userId] - User ID to filter by (defaults to merging all)
   */
  mergeOverlappingRegions(userId) {
    if (this.regions.length < 2) return;

    const userIdStr = userId !== undefined ? String(userId) : null;

    let merged = true;

    // Keep merging until no more merges happen
    while (merged) {
      merged = false;

      outer:
      for (let i = 0; i < this.regions.length; i++) {
        // Skip if filtering by user and this region doesn't belong to them
        if (userIdStr !== null && this.regions[i].userId !== userIdStr) continue;
        // Skip eraser regions
        if (this.regions[i].isEraser) continue;

        for (let j = i + 1; j < this.regions.length; j++) {
          // Only merge regions from the same user
          if (this.regions[i].userId !== this.regions[j].userId) continue;
          // Skip eraser regions
          if (this.regions[j].isEraser) continue;

          if (this.shouldMergeRegions(this.regions[i], this.regions[j])) {
            this.mergeRegions(i, j);
            merged = true;
            break outer; // Restart from beginning after merge
          }
        }
      }
    }
  }

  // ========================================
  // Eraser Subtraction (Boolean Operation)
  // ========================================

  /**
   * Start tracking an eraser stroke - creates visible temporary region
   * @param {number} x
   * @param {number} y
   * @param {number} size - Eraser size
   * @param {string|number} [userId] - User ID (defaults to 'self')
   * @param {string} [username] - Username for region labeling
   */
  startErasing(x, y, size, userId = 'self', username = '') {
    console.log('[DebugOverlay] startErasing', { x, y, size, userId, username });

    const eraserState = this.getUserEraserState(userId);

    eraserState.isErasing = true;
    eraserState.eraserPoints = [];
    eraserState.eraserPath = [];  // Center points with size for circle subtraction
    eraserState.eraserLastPoint = { x, y };

    // Add initial center point for circle-based subtraction
    eraserState.eraserPath.push({ x, y, size });

    // Add initial edge points for visualization
    const edgePoints = this.generateEdgePoints(x, y, x, y, size);
    eraserState.eraserPoints.push(...edgePoints);

    // Create visible eraser region (convex hull is fine for temp visualization)
    const hull = computeConvexHull(eraserState.eraserPoints, 5);
    const bounds = hullToBounds(hull);

    const regionIdPrefix = username ? `${username}_` : '';

    eraserState.eraserRegionIndex = this.regions.length;
    this.regions.push({
      hull,
      bounds,
      points: [...eraserState.eraserPoints],
      id: regionIdPrefix + 'eraser_temp',
      color: ERASER_COLOR,
      colorIndex: -1,  // Special index for eraser
      isEraser: true,  // Mark as eraser region
      userId: String(userId),
      username: username
    });
  }

  /**
   * Add a point to the eraser stroke
   * @param {number} x
   * @param {number} y
   * @param {number} size - Eraser size
   * @param {string|number} [userId] - User ID (defaults to 'self')
   */
  addEraserPoint(x, y, size, userId = 'self') {
    const eraserState = this.getUserEraserState(userId);

    if (!eraserState.isErasing || eraserState.eraserRegionIndex < 0) return;

    // Sample points
    if (eraserState.eraserLastPoint) {
      const dist = Math.hypot(x - eraserState.eraserLastPoint.x, y - eraserState.eraserLastPoint.y);
      if (dist < POINT_SAMPLE_DISTANCE) return;

      // Add center point for circle-based subtraction
      eraserState.eraserPath.push({ x, y, size });

      // Generate edge points for visualization
      const edgePoints = this.generateEdgePoints(x, y, eraserState.eraserLastPoint.x, eraserState.eraserLastPoint.y, size);
      eraserState.eraserPoints.push(...edgePoints);
    }

    eraserState.eraserLastPoint = { x, y };

    // Update visible eraser region
    this.updateEraserRegion(userId);
  }

  /**
   * Update the visible eraser region hull
   * @param {string|number} [userId] - User ID (defaults to 'self')
   */
  updateEraserRegion(userId = 'self') {
    const eraserState = this.getUserEraserState(userId);

    if (eraserState.eraserRegionIndex < 0 || eraserState.eraserPoints.length < 3) return;

    const hull = computeConvexHull(eraserState.eraserPoints, 5);
    const bounds = hullToBounds(hull);

    const region = this.regions[eraserState.eraserRegionIndex];
    if (region) {
      region.hull = hull;
      region.bounds = bounds;
      region.points = [...eraserState.eraserPoints];
    }
  }

  /**
   * End eraser stroke and perform boolean subtraction
   * @param {string|number} [userId] - User ID (defaults to 'self')
   */
  endErasing(userId = 'self') {
    const eraserState = this.getUserEraserState(userId);

    if (!eraserState.isErasing) return;

    console.log('[DebugOverlay] endErasing', { userId, pathLength: eraserState.eraserPath.length });

    eraserState.isErasing = false;

    // Remove the temporary eraser region
    if (eraserState.eraserRegionIndex >= 0) {
      this.regions.splice(eraserState.eraserRegionIndex, 1);
    }

    // Perform subtraction using circle-based path if we have enough points
    if (eraserState.eraserPath.length >= 2) {
      // Save to history for troll detection (before subtraction)
      this.eraserHistory.push({
        userId: String(userId),
        path: [...eraserState.eraserPath],
        timestamp: Date.now()
      });

      this.subtractFromRegions(eraserState.eraserPath);
    }

    // Clean up
    eraserState.eraserPoints = [];
    eraserState.eraserPath = [];
    eraserState.eraserLastPoint = null;
    eraserState.eraserRegionIndex = -1;
  }

  /**
   * Calculate the area of a convex hull using shoelace formula
   * @param {Array<{x, y}>} hull
   * @returns {number} Area in square pixels
   */
  calculateHullArea(hull) {
    if (!hull || hull.length < 3) return 0;

    let area = 0;
    const n = hull.length;

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += hull[i].x * hull[j].y;
      area -= hull[j].x * hull[i].y;
    }

    return Math.abs(area) / 2;
  }

  /**
   * Cluster points into separate groups based on proximity
   * @param {Array<{x, y}>} points
   * @returns {Array<Array<{x, y}>>} Array of point clusters
   */
  clusterPoints(points) {
    if (points.length === 0) return [];

    const visited = new Set();
    const clusters = [];

    for (let i = 0; i < points.length; i++) {
      if (visited.has(i)) continue;

      // Start a new cluster
      const cluster = [];
      const queue = [i];

      while (queue.length > 0) {
        const idx = queue.shift();
        if (visited.has(idx)) continue;

        visited.add(idx);
        cluster.push(points[idx]);

        // Find all nearby unvisited points
        for (let j = 0; j < points.length; j++) {
          if (visited.has(j)) continue;

          const dist = Math.hypot(
            points[idx].x - points[j].x,
            points[idx].y - points[j].y
          );

          if (dist <= CLUSTER_DISTANCE) {
            queue.push(j);
          }
        }
      }

      if (cluster.length > 0) {
        clusters.push(cluster);
      }
    }

    return clusters;
  }

  /**
   * Check if a point is inside any circle along the eraser path
   * @param {{x: number, y: number}} point - Point to test
   * @param {Array<{x: number, y: number, size: number}>} eraserPath - Eraser circles
   * @returns {boolean}
   */
  pointInEraserPath(point, eraserPath) {
    for (const circle of eraserPath) {
      const dist = Math.hypot(point.x - circle.x, point.y - circle.y);
      // Use the eraser size as radius (with 0.5x padding like brush)
      if (dist <= circle.size * 0.5) {
        return true;
      }
    }
    return false;
  }

  /**
   * Calculate bounding box for eraser path (all circles)
   * @param {Array<{x: number, y: number, size: number}>} eraserPath
   * @returns {{x: number, y: number, width: number, height: number}}
   */
  getEraserPathBounds(eraserPath) {
    if (eraserPath.length === 0) return { x: 0, y: 0, width: 0, height: 0 };

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const circle of eraserPath) {
      const radius = circle.size * 0.5;
      minX = Math.min(minX, circle.x - radius);
      minY = Math.min(minY, circle.y - radius);
      maxX = Math.max(maxX, circle.x + radius);
      maxY = Math.max(maxY, circle.y + radius);
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  /**
   * Subtract eraser path from all regions (boolean difference using circles)
   * Can split regions into multiple parts
   * @param {Array<{x: number, y: number, size: number}>} eraserPath - Eraser circles
   */
  subtractFromRegions(eraserPath) {
    const eraserBounds = this.getEraserPathBounds(eraserPath);
    const regionsToRemove = [];
    const regionsToAdd = [];

    for (let i = 0; i < this.regions.length; i++) {
      const region = this.regions[i];

      // Skip eraser regions
      if (region.isEraser) continue;

      // Quick rejection: check bounding boxes
      if (!this.boundsOverlap(region.bounds, eraserBounds)) {
        continue;
      }

      console.log('[DebugOverlay] Subtracting from region:', region.id);

      // Remove points that are inside any eraser circle
      const remainingPoints = (region.points || []).filter(point => {
        return !this.pointInEraserPath(point, eraserPath);
      });

      // Check if all points were removed
      if (remainingPoints.length < 4) {
        console.log('[DebugOverlay] Region fully erased:', region.id);
        regionsToRemove.push(i);
        continue;
      }

      // Cluster remaining points to detect splits
      const clusters = this.clusterPoints(remainingPoints);

      console.log('[DebugOverlay] Found', clusters.length, 'cluster(s) after subtraction');

      if (clusters.length === 0) {
        regionsToRemove.push(i);
        continue;
      }

      // Process each cluster
      const validClusters = [];
      for (const cluster of clusters) {
        if (cluster.length < 4) continue;

        const clusterHull = computeConvexHull(cluster, 5);
        if (clusterHull.length < 3) continue;

        const clusterArea = this.calculateHullArea(clusterHull);

        // Filter by minimum area
        if (clusterArea < MIN_REGION_AREA) {
          console.log('[DebugOverlay] Cluster too small, area:', clusterArea);
          continue;
        }

        validClusters.push({
          points: cluster,
          hull: clusterHull,
          bounds: hullToBounds(clusterHull),
          area: clusterArea
        });
      }

      if (validClusters.length === 0) {
        // No valid clusters remain
        regionsToRemove.push(i);
      } else if (validClusters.length === 1) {
        // Single cluster - update existing region
        region.points = validClusters[0].points;
        region.hull = validClusters[0].hull;
        region.bounds = validClusters[0].bounds;
        console.log('[DebugOverlay] Region updated, area:', validClusters[0].area);
      } else {
        // Multiple clusters - split into new regions
        console.log('[DebugOverlay] Splitting region into', validClusters.length, 'parts');

        // Mark original for removal
        regionsToRemove.push(i);

        // Create new regions for each cluster (preserve userId and username)
        for (let j = 0; j < validClusters.length; j++) {
          const cluster = validClusters[j];
          regionsToAdd.push({
            hull: cluster.hull,
            bounds: cluster.bounds,
            points: cluster.points,
            id: `${region.id}_split${j}`,
            color: region.color,
            colorIndex: region.colorIndex,
            userId: region.userId,
            username: region.username
          });
        }
      }
    }

    // Remove regions (in reverse order to preserve indices)
    for (let i = regionsToRemove.length - 1; i >= 0; i--) {
      const idx = regionsToRemove[i];
      console.log('[DebugOverlay] Removing region:', this.regions[idx].id);
      this.regions.splice(idx, 1);
    }

    // Add new split regions
    for (const newRegion of regionsToAdd) {
      this.regions.push(newRegion);
      console.log('[DebugOverlay] Added split region:', newRegion.id);
    }

    console.log('[DebugOverlay] Total regions now:', this.regions.length);
  }

  /**
   * Check if two bounding boxes overlap (without merge distance padding)
   * @param {Object} bounds1
   * @param {Object} bounds2
   * @returns {boolean}
   */
  boundsOverlap(bounds1, bounds2) {
    if (!bounds1 || !bounds2) return false;

    return !(
      bounds1.x + bounds1.width < bounds2.x ||
      bounds2.x + bounds2.width < bounds1.x ||
      bounds1.y + bounds1.height < bounds2.y ||
      bounds2.y + bounds2.height < bounds1.y
    );
  }

  // ========================================
  // Stroke Point Debugging
  // ========================================

  /**
   * Start tracking stroke points for a user
   * @param {string|number} userId
   * @param {boolean} isLocal - true for local user, false for remote
   */
  startStrokeTracking(userId, isLocal = false) {
    if (!this.enabled) return;

    const key = String(userId);
    const color = isLocal ? '#00ff00' : '#ff6600'; // Green for local, orange for remote

    this.strokePoints.set(key, {
      points: [],
      color,
      isLocal,
      startTime: Date.now()
    });

    if (this.logPoints) {
      console.log(`[StrokeDebug] START ${isLocal ? 'LOCAL' : 'REMOTE'} user=${userId}`);
    }
  }

  /**
   * Add a point to stroke tracking
   * @param {string|number} userId
   * @param {number} x
   * @param {number} y
   * @param {string} source - Where the point came from (e.g., 'tick', 'handleMouseMove')
   */
  addStrokePoint(userId, x, y, source = '') {
    if (!this.enabled) return;

    const key = String(userId);
    const data = this.strokePoints.get(key);
    if (!data) return;

    data.points.push({ x, y, source, time: Date.now() - data.startTime });

    if (this.logPoints) {
      const label = data.isLocal ? 'LOCAL' : 'REMOTE';
      console.log(`[StrokeDebug] ${label} user=${userId} point #${data.points.length}: (${x.toFixed(2)}, ${y.toFixed(2)}) src=${source}`);
    }
  }

  /**
   * End stroke tracking and show summary
   * @param {string|number} userId
   */
  endStrokeTracking(userId) {
    if (!this.enabled) return;

    const key = String(userId);
    const data = this.strokePoints.get(key);
    if (!data) return;

    if (this.logPoints) {
      const label = data.isLocal ? 'LOCAL' : 'REMOTE';
      console.log(`[StrokeDebug] END ${label} user=${userId} total points: ${data.points.length}`);

      // Log point summary
      if (data.points.length > 0) {
        const xs = data.points.map(p => p.x);
        const ys = data.points.map(p => p.y);
        console.log(`[StrokeDebug] ${label} X range: ${Math.min(...xs).toFixed(2)} - ${Math.max(...xs).toFixed(2)}`);
        console.log(`[StrokeDebug] ${label} Y range: ${Math.min(...ys).toFixed(2)} - ${Math.max(...ys).toFixed(2)}`);
      }
    }

    // Keep points visible for a few seconds then clear
    setTimeout(() => {
      this.strokePoints.delete(key);
    }, 5000);
  }

  /**
   * Clear all stroke tracking data
   */
  clearStrokeTracking() {
    this.strokePoints.clear();
  }

  /**
   * Render stroke points on the debug overlay
   */
  renderStrokePoints() {
    if (!this.ctx || !this.enabled || !this.showStrokePoints) return;

    for (const [userId, data] of this.strokePoints) {
      const { points, color, isLocal } = data;

      // Draw points as small circles
      this.ctx.fillStyle = color;
      this.ctx.strokeStyle = isLocal ? '#004400' : '#442200';
      this.ctx.lineWidth = 1;

      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const radius = isLocal ? 3 : 4; // Slightly larger for remote so we can see overlap

        this.ctx.beginPath();
        this.ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.stroke();

        // Draw index number for first few and last few points
        if (i < 3 || i >= points.length - 3) {
          this.ctx.fillStyle = '#ffffff';
          this.ctx.font = '10px monospace';
          this.ctx.fillText(String(i), p.x + 5, p.y - 5);
          this.ctx.fillStyle = color;
        }
      }

      // Draw lines connecting points
      if (points.length > 1) {
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 1;
        this.ctx.globalAlpha = 0.5;
        this.ctx.beginPath();
        this.ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
          this.ctx.lineTo(points[i].x, points[i].y);
        }
        this.ctx.stroke();
        this.ctx.globalAlpha = 1;
      }

      // Draw label
      if (points.length > 0) {
        const lastPoint = points[points.length - 1];
        this.ctx.fillStyle = color;
        this.ctx.font = 'bold 12px monospace';
        this.ctx.fillText(`${isLocal ? 'LOCAL' : 'REMOTE'} (${points.length} pts)`, lastPoint.x + 10, lastPoint.y);
      }
    }
  }

  /**
   * Render all regions to the overlay canvas
   */
  render() {
    if (!this.ctx || !this.enabled) {
      return;
    }

    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);

    for (const region of this.regions) {
      this.drawRegion(region);
    }

    // Render stroke points on top
    this.renderStrokePoints();
  }
}
