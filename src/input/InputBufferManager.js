/**
 * InputBufferManager - Manages input buffering, tick loop, smoothing, and point reduction
 * Runs at 60 TPS (or 30 TPS on low-power devices) to process input and broadcast to server
 */

import { douglasPeucker, distanceBasedCulling } from '../utils/drawing.js';
import { applySmoothingEMA, resetSmoothingBuffer } from '../utils/smoothing.js';

const TPS_NORMAL = 60;
const TPS_LOW_POWER = 30;

// GPU renderer substrings that indicate low-power hardware
const LOW_POWER_GPU_PATTERNS = [
  'mali', 'adreno', 'powervr', 'swiftshader', 'llvmpipe',
  'intel hd graphics', 'intel uhd graphics 6', // Chromebook-tier Intel
  'vivante', 'videocore', 'tegra',
];

/**
 * Detect low-power devices using navigator hints, WebGL GPU info, and GL limits.
 * Runs once at startup to determine the appropriate tick rate.
 */
function detectLowPowerDevice() {
  let score = 0; // positive = evidence of low-power

  // --- Navigator hints ---
  const cores = navigator.hardwareConcurrency || 0;
  if (cores > 0 && cores <= 4) score += 2;

  const memory = navigator.deviceMemory; // Chromium-only
  if (memory !== undefined && memory <= 4) score += 2;

  // --- WebGL GPU info ---
  let renderer = 'unknown';
  let maxTexture = 'N/A';
  let maxVertexUnits = 'N/A';
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
        if (LOW_POWER_GPU_PATTERNS.some(p => renderer.toLowerCase().includes(p))) score += 3;
      }

      maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (maxTexture <= 4096) score += 2;

      maxVertexUnits = gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS);
      if (maxVertexUnits <= 4) score += 1;

      const loseExt = gl.getExtension('WEBGL_lose_context');
      if (loseExt) loseExt.loseContext();
    }
  } catch (_) {
    score += 3;
  }

  const isLowPower = score >= 3;
  console.log(
    `[Performance] Device score: ${score} → ${isLowPower ? '30' : '60'} TPS`
    + ` | cores: ${cores || 'N/A'}, memory: ${memory ?? 'N/A'}GB`
    + ` | GPU: ${renderer}`
    + ` | maxTexture: ${maxTexture}, maxVertexUnits: ${maxVertexUnits}`
  );
  return isLowPower;
}

export class InputBufferManager {
  constructor(app) {
    this.app = app;

    // Tick loop configuration — auto-detect device capability
    this.lowPowerMode = detectLowPowerDevice();
    this.tickRate = this.lowPowerMode ? TPS_LOW_POWER : TPS_NORMAL;
    this.tickInterval = 1000 / this.tickRate;
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

  /**
   * Change tick rate at runtime. Restarts the loop if already running.
   * @param {number} tps - New ticks per second (e.g. 30 or 60)
   */
  setTickRate(tps) {
    this.tickRate = tps;
    this.tickInterval = 1000 / tps;
    this.lowPowerMode = tps <= TPS_LOW_POWER;
    if (this.tickTimer) {
      this.stopTickLoop();
      this.startTickLoop();
    }
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
      const smoothingTools = ['brush', 'flowPen', 'ink', 'imageBrush', 'erase'];
      const blurTools = ['blur', 'circleBlur', 'circleBlurHard'];
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
      const lastRawX = points[points.length - 2];
      const lastRawY = points[points.length - 1];
      app.self.setTarget(lastRawX, lastRawY);

      const lastX = localPoints[localPoints.length - 2];
      const lastY = localPoints[localPoints.length - 1];
      app.self.setPosition(lastX, lastY);

      // 3. Process locally for immediate feedback
      if (app.self.mousedown && !app.self.panning) {
        const tool = app.toolManager.getCurrentTool();
        if (tool) {
          for (let i = 0; i < localPoints.length; i += 2) {
              const currentPos = { x: localPoints[i], y: localPoints[i+1] };
              // Important: If lastPosition is null, use currentPos as prevPos to prevent jumping lines
              const prevPos = i === 0 ? (this.inputBuffer.lastPosition || currentPos) : { x: localPoints[i-2], y: localPoints[i-1] };
              
              tool.onPointerMove(app.self, currentPos, prevPos);
              
              // Increment draw counter so App.js knows we actually drew something
              app.self._mainCtxDrawCount++;

              // Debug: Track each point processed locally
              app.debugOverlay.addStrokePoint(app.self.id, currentPos.x, currentPos.y, 'tick');
          }
        }
      }

      // 4. Broadcast to remote users
      if (app.self.tool === 'flowPen' && app.self.mousedown && !app.self.panning) {
        const tool = app.toolManager.getCurrentTool();
        const { ps: stampPs, rs: stampRs } = tool.drainStampBuffer();
        if (stampPs.length > 0) {
          app.wsClient.broadcastStampMove(stampPs, stampRs);
        }
      } else if (app.self.tool === 'ink' && app.self.mousedown && !app.self.panning) {
        const tool = app.toolManager.getCurrentTool();
        const { ps: fhPs, rs: fhRs } = tool.drainPointBuffer();
        if (fhPs.length > 0) {
          app.wsClient.broadcastStampMove(fhPs, fhRs);
        }
      } else {
        if (broadcastPoints.length > 0) {
          app.wsClient.broadcastMove(broadcastPoints);
        }
      }

      this.inputBuffer.lastPosition = { x: lastX, y: lastY };
    }

    // Smoothing catch-up
    if (needsCatchup) {
      this.processSmoothingCatchup();
    }

    // Clear points for next tick
    this.inputBuffer.points = [];
    this.inputBuffer.dirty = false;
  }

  needsSmoothingCatchup() {
    const { app } = this;
    if (!app.self.mousedown || app.self.panning) return false;
    const smoothingTools = ['brush', 'flowPen', 'imageBrush', 'erase', 'ink'];
    if (!smoothingTools.includes(app.self.tool)) return false;
    if (app.self.tool !== 'ink' && (!app.self.smoothing || app.self.smoothing === 0)) return false;
    if (this.broadcastSmoothBuffer.isFirst) return false;
    const dx = app.self.targetX - this.broadcastSmoothBuffer.x;
    const dy = app.self.targetY - this.broadcastSmoothBuffer.y;
    return Math.sqrt(dx * dx + dy * dy) > 0.5;
  }

  processSmoothingCatchup() {
    const { app } = this;
    const tool = app.toolManager.getCurrentTool();
    if (!tool) return;

    const targetPos = { x: app.self.targetX, y: app.self.targetY };
    let prevPos = { x: this.broadcastSmoothBuffer.x, y: this.broadcastSmoothBuffer.y };

    const points = [targetPos.x, targetPos.y];
    const smoothedPoints = this.applyBroadcastSmoothing(points);
    const smoothedPos = { x: smoothedPoints[0], y: smoothedPoints[1] };

    app.self.setPosition(smoothedPos.x, smoothedPos.y);
    tool.onPointerMove(app.self, smoothedPos, prevPos);
    app.self._mainCtxDrawCount++;

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

    app.debugOverlay.addStrokePoint(app.self.id, targetPos.x, targetPos.y, 'catchup');
  }

  applyPointReduction(points) {
    if (!this.pointReduction.enabled || points.length < 4) return points;
    const userSmoothing = this.app.self.smoothing !== undefined ? this.app.self.smoothing : 15;
    const baseline = this.baselineSmoothing.pointReduction;
    const pointObjects = [];
    for (let i = 0; i < points.length; i += 2) {
      pointObjects.push({ x: points[i], y: points[i + 1] });
    }
    const epsilon = baseline.minEpsilon + (baseline.maxEpsilon - baseline.minEpsilon) * (userSmoothing / 50);
    const reduced = douglasPeucker(pointObjects, epsilon);
    const result = [];
    for (const p of reduced) result.push(p.x, p.y);
    return result;
  }

  applyBroadcastSmoothing(points) {
    if (points.length < 2) return points;
    const userSmoothing = this.app.self.smoothing || 0;
    const result = [];
    for (let i = 0; i < points.length; i += 2) {
      const smoothed = applySmoothingEMA(this.broadcastSmoothBuffer, points[i], points[i+1], userSmoothing);
      result.push(smoothed.x, smoothed.y);
    }
    return result;
  }

  resetBroadcastSmoothing() {
    resetSmoothingBuffer(this.broadcastSmoothBuffer);
    this.inputBuffer.lastPosition = null;
    this.inputBuffer.points = [];
    this.inputBuffer.dirty = false;
  }
}
