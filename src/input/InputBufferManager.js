/**
 * InputBufferManager - Manages input buffering, tick loop, smoothing, and point reduction
 * Runs at 90 TPS to process input data and broadcast to server
 */

import { douglasPeucker, distanceBasedCulling } from '../utils/drawing.js';
import { applySmoothingEMA, resetSmoothingBuffer } from '../utils/smoothing.js';

export class InputBufferManager {
  constructor(app) {
    this.app = app;

    // Tick loop configuration
    this.tickRate = 90; // TPS (ticks per second)
    this.tickInterval = 1000 / this.tickRate; // ~11.11ms
    this.tickTimer = null;
    this.lastTickTime = null;

    // Input buffer for accumulating pointer events between ticks
    this.inputBuffer = {
      points: [],        // Flat array: [x1, y1, x2, y2, ...]
      pressure: 1,       // Current pressure (0-1)
      pointerType: 'mouse',
      position: null,    // Latest { x, y }
      lastPosition: null, // Previous { x, y }
      dirty: false       // True if new data since last tick
    };

    // Point reduction configuration (Level 1: bandwidth optimization)
    this.pointReduction = {
      enabled: true,
      algorithm: 'douglas-peucker', // 'douglas-peucker' or 'distance-based'
      // Douglas-Peucker parameters (epsilon range)
      minEpsilon: 0.1,
      maxEpsilon: 2.0,
      // Distance-based parameters
      minDistance: 1,
      maxDistance: 5
    };

    // Baseline smoothing configuration
    this.baselineSmoothing = {
      pointReduction: {
        minEpsilon: 0.5,
        maxEpsilon: 2.0
      }
    };

    // Broadcast smoothing buffer (matches tool smoothing for sync)
    this.broadcastSmoothBuffer = { x: 0, y: 0, isFirst: true };
  }

  startTickLoop() {
    if (this.tickTimer) return; // Already running

    this.lastTickTime = performance.now();
    this.tickTimer = setInterval(() => this.tick(), this.tickInterval);
  }

  stopTickLoop() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  tick() {
    const now = performance.now();
    this.lastTickTime = now;

    const { app } = this;

    // Skip local drawing while syncing
    if (app.syncClient?.isSyncing()) return;

    // Only process if we have new input data OR need to catch up smoothing
    const needsCatchup = this.needsSmoothingCatchup();
    if (!this.inputBuffer.dirty && !needsCatchup) return;

    const { points } = this.inputBuffer;

    // Process drawing if we have position data
    if (points.length >= 2) {
      // 1. Apply smoothing and reduction for broadcast
      let smoothedPoints;
      let broadcastPoints;
      if (app.self.mousedown && !app.self.panning) {
        smoothedPoints = this.applyBroadcastSmoothing(points);
        broadcastPoints = this.applyPointReduction(smoothedPoints);
      } else {
        smoothedPoints = points;
        broadcastPoints = points;
      }

      // 2. Determine local points based on tool type
      // - Brush/Pen/Ink/ImageBrush/Eraser: use smoothed points (ensures local preview matches broadcast)
      // - Blur tools: use reduced broadcast points (match remote exactly)
      // - Others: use raw points
      const smoothingTools = ['brush', 'flowPen', 'ink', 'imageBrush', 'erase'];
      const blurTools = ['blur', 'circleBlur'];
      let localPoints;
      if (app.self.mousedown && !app.self.panning) {
        if (smoothingTools.includes(app.self.tool)) {
          localPoints = smoothedPoints; // Pre-smoothed by InputBufferManager
        } else if (blurTools.includes(app.self.tool)) {
          localPoints = broadcastPoints; // Smoothed + reduced
        } else {
          localPoints = points; // Raw
        }
      } else {
        localPoints = points;
      }

      // 2. Update self state with the LATEST point in the batch
      // - targetX/Y: raw mouse target for catch-up convergence
      // - x/y: rendered (smoothed) position
      const lastRawX = points[points.length - 2];
      const lastRawY = points[points.length - 1];
      app.self.setTarget(lastRawX, lastRawY);

      const lastX = localPoints[localPoints.length - 2];
      const lastY = localPoints[localPoints.length - 1];
      app.self.setPosition(lastX, lastY);

      // 3. Process locally for immediate feedback (must run before broadcast for flowPen stamp buffer)
      if (app.self.mousedown && !app.self.panning) {
        const tool = app.toolManager.getCurrentTool();
        if (tool) {
          // We iterate through the batch locally so the user sees smooth lines
          // For blur tools, we use reduced points to match what remote users will see
          for (let i = 0; i < localPoints.length; i += 2) {
              const currentPos = { x: localPoints[i], y: localPoints[i+1] };
              const prevPos = i === 0 ? (this.inputBuffer.lastPosition || currentPos) : { x: localPoints[i-2], y: localPoints[i-1] };
              tool.onPointerMove(app.self, currentPos, prevPos);

              // Debug: Track each point processed locally
              app.debugOverlay.addStrokePoint(app.self.id, currentPos.x, currentPos.y, 'tick');
          }
        }
      }

      // 4. Broadcast to remote users
      if (app.self.tool === 'flowPen' && app.self.mousedown && !app.self.panning) {
        // FlowPen: send exact stamp positions (already generated by tool.onPointerMove above)
        const tool = app.toolManager.getCurrentTool();
        const { ps: stampPs, rs: stampRs } = tool.drainStampBuffer();
        if (stampPs.length > 0) {
          app.wsClient.broadcastStampMove(stampPs, stampRs);
        }
      } else if (app.self.tool === 'ink' && app.self.mousedown && !app.self.panning) {
        // Ink: send raw points + pressures via rs field
        const tool = app.toolManager.getCurrentTool();
        const { ps: fhPs, rs: fhRs } = tool.drainPointBuffer();
        if (fhPs.length > 0) {
          app.wsClient.broadcastStampMove(fhPs, fhRs);
        }
      } else {
        // Use pre-calculated broadcastPoints
        if (broadcastPoints.length > 0) {
          app.wsClient.broadcastMove(broadcastPoints);
        }
      }

      this.inputBuffer.lastPosition = { x: lastX, y: lastY };
    }

    // Smoothing catch-up: continue drawing towards target even when pointer is still
    if (needsCatchup) {
      this.processSmoothingCatchup();
    }

    // Clear points for next tick
    this.inputBuffer.points = [];
    this.inputBuffer.dirty = false;
  }

  /**
   * Check if smoothing needs to catch up to the target position
   * @returns {boolean} - True if catch-up is needed
   */
  needsSmoothingCatchup() {
    const { app } = this;

    // Only catch up when actively drawing (not panning, mouse is down)
    if (!app.self.mousedown || app.self.panning) return false;

    // Only catch up for tools that use position smoothing
    const smoothingTools = ['brush', 'flowPen', 'imageBrush', 'erase', 'ink'];
    if (!smoothingTools.includes(app.self.tool)) return false;

    // Check if smoothing is enabled (for tools that use user.smoothing)
    if (app.self.tool !== 'ink' && (!app.self.smoothing || app.self.smoothing === 0)) return false;

    // Check if broadcast smooth buffer has been initialized
    if (this.broadcastSmoothBuffer.isFirst) return false;

    // Use raw mouse target for catch-up calculation
    const dx = app.self.targetX - this.broadcastSmoothBuffer.x;
    const dy = app.self.targetY - this.broadcastSmoothBuffer.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Need catch-up if distance > 0.5 pixels
    return distance > 0.5;
  }

  /**
   * Process smoothing catch-up to continue drawing towards target
   */
  processSmoothingCatchup() {
    const { app } = this;
    const tool = app.toolManager.getCurrentTool();
    if (!tool) return;

    // Generate a synthetic pointer move towards the raw target
    const targetPos = { x: app.self.targetX, y: app.self.targetY };
    let prevPos = { x: this.broadcastSmoothBuffer.x, y: this.broadcastSmoothBuffer.y };

    // Process one catch-up step per tick towards target using centralized smoothing
    const points = [targetPos.x, targetPos.y];
    const smoothedPoints = this.applyBroadcastSmoothing(points);
    const smoothedPos = { x: smoothedPoints[0], y: smoothedPoints[1] };

    // Update rendered position with smoothed catch-up point
    app.self.setPosition(smoothedPos.x, smoothedPos.y);

    // Call tool with smoothed position
    tool.onPointerMove(app.self, smoothedPos, prevPos);

    // Broadcast the catch-up position
    if (app.self.tool === 'flowPen') {
      const { ps: stampPs, rs: stampRs } = tool.drainStampBuffer();
      if (stampPs.length > 0) {
        app.wsClient.broadcastStampMove(stampPs, stampRs);
      }
    } else if (app.self.tool === 'ink') {
      const { ps: fhPs, rs: fhRs } = tool.drainPointBuffer();
      if (fhPs.length > 0) {
        app.wsClient.broadcastStampMove(fhPs, fhRs);
      }
    } else {
      const reducedPoints = this.applyPointReduction(smoothedPoints);
      app.wsClient.broadcastMove(reducedPoints);
    }

    // Track for debug overlay
    app.debugOverlay.addStrokePoint(app.self.id, targetPos.x, targetPos.y, 'catchup');
    app.debugOverlay.addDrawingPoint(targetPos.x, targetPos.y, app.self.size, app.self.id);
  }

  /**
   * Apply Level 1 point reduction to reduce bandwidth before network broadcast
   * @param {Array} points - Flat array [x1, y1, x2, y2, ...]
   * @returns {Array} - Reduced flat array
   */
  applyPointReduction(points) {
    // Skip reduction if disabled or insufficient points
    if (!this.pointReduction.enabled || points.length < 4) {
      return points;
    }

    const userSmoothing = this.app.self.smoothing * 100; // Convert 0-1 to 0-100
    const baseline = this.baselineSmoothing.pointReduction;

    // Convert flat array [x1, y1, x2, y2, ...] to point objects
    const pointObjects = [];
    for (let i = 0; i < points.length; i += 2) {
      pointObjects.push({ x: points[i], y: points[i + 1] });
    }

    let reduced;

    if (this.pointReduction.algorithm === 'douglas-peucker') {
      // Always apply at least baseline reduction, scale up with user smoothing
      const epsilon = baseline.minEpsilon +
        (baseline.maxEpsilon - baseline.minEpsilon) * (userSmoothing / 100);

      reduced = douglasPeucker(pointObjects, epsilon);
    } else if (this.pointReduction.algorithm === 'distance-based') {
      // Calculate distance threshold based on smoothing level
      const { minDistance, maxDistance } = this.pointReduction;
      const threshold = minDistance + (maxDistance - minDistance) * (userSmoothing / 100);

      reduced = distanceBasedCulling(pointObjects, threshold);
    } else {
      // Invalid algorithm, return original
      console.warn(`Invalid point reduction algorithm: ${this.pointReduction.algorithm}`);
      return points;
    }

    // Convert back to flat array
    const result = [];
    for (const p of reduced) {
      result.push(p.x, p.y);
    }

    return result;
  }

  /**
   * Apply EMA smoothing to points before broadcast
   * Uses the centralized smoothing utility to ensure perfect parity between
   * local preview and remote rendering.
   * @param {Array} points - Flat array [x1, y1, x2, y2, ...]
   * @returns {Array} - Smoothed flat array
   */
  applyBroadcastSmoothing(points) {
    if (points.length < 2) {
      return points;
    }

    const userSmoothing = this.app.self.smoothing || 0;
    const result = [];

    for (let i = 0; i < points.length; i += 2) {
      const targetX = points[i];
      const targetY = points[i + 1];

      // Use centralized smoothing utility
      const smoothed = applySmoothingEMA(
        this.broadcastSmoothBuffer,
        targetX,
        targetY,
        userSmoothing
      );

      result.push(smoothed.x, smoothed.y);
    }

    return result;
  }

  resetBroadcastSmoothing() {
    resetSmoothingBuffer(this.broadcastSmoothBuffer);
  }
}
