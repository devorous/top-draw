/**
 * @fileoverview Manages input buffering, tick loop synchronization, and point optimization.
 * Orchestrates local drawing feedback and network broadcast rates based on device performance.
 */

import { douglasPeucker, distanceBasedCulling } from '../utils/drawing.js';
import { applySmoothingEMA, resetSmoothingBuffer } from '../utils/smoothing.js';

const TPS_NORMAL = 60;
const TPS_LOW_POWER = 30;

const LOW_POWER_GPU_PATTERNS = [
  'mali', 'adreno', 'powervr', 'swiftshader', 'llvmpipe',
  'intel hd graphics', 'intel uhd graphics 6',
  'vivante', 'videocore', 'tegra',
];

/**
 * Detects if the current device is low-power to adjust the tick rate.
 * Uses hardware concurrency, device memory, and WebGL renderer hints.
 *
 * @returns {boolean} True if the device is considered low-power.
 */
function detectLowPowerDevice() {
  let score = 0;

  const cores = navigator.hardwareConcurrency || 0;
  if (cores > 0 && cores <= 4) score += 2;

  const memory = navigator.deviceMemory;
  if (memory !== undefined && memory <= 4) score += 2;

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
  const message = `[Performance] Device score: ${score} → ${isLowPower ? '30' : '60'} TPS`
    + ` | cores: ${cores || 'N/A'}, memory: ${memory ?? 'N/A'}GB`
    + ` | GPU: ${renderer}`
    + ` | maxTexture: ${maxTexture}, maxVertexUnits: ${maxVertexUnits}`;
  console.log(message);

  // Store for debug display
  window.__performanceDetection = {
    score,
    isLowPower,
    cores,
    memory,
    renderer,
    maxTexture,
    maxVertexUnits,
    message
  };

  return isLowPower;
}

/**
 * InputBufferManager handles the accumulation and processing of pointer events.
 * It ensures smooth local rendering by decoupling input from the animation frame
 * and optimizes network bandwidth through point reduction algorithms.
 */
export class InputBufferManager {
  /**
   * @param {App} app - The main application instance.
   */
  constructor(app) {
    this.app = app;

    /** @type {boolean} */
    this.lowPowerMode = detectLowPowerDevice();
    /** @type {number} */
    this.tickRate = this.lowPowerMode ? TPS_LOW_POWER : TPS_NORMAL;
    /** @type {number} */
    this.tickInterval = 1000 / this.tickRate;
    /** @type {number|null} */
    this.tickTimer = null;
    /** @type {number|null} */
    this.lastTickTime = null;

    /** @type {Object} */
    this.inputBuffer = {
      points: [],
      pressure: 1,
      pointerType: 'mouse',
      position: null,
      lastPosition: null,
      dirty: false
    };

    /** @type {Object} */
    this.pointReduction = {
      enabled: true,
      algorithm: 'douglas-peucker',
      minEpsilon: 0.1,
      maxEpsilon: 2.0,
      minDistance: 1,
      maxDistance: 5
    };

    /** @type {Object} */
    this.baselineSmoothing = {
      pointReduction: {
        minEpsilon: 0.5,
        maxEpsilon: 2.0
      }
    };

    /** @type {Object} */
    this.broadcastSmoothBuffer = { x: 0, y: 0, isFirst: true };
  }

  /**
   * Adjusts the tick rate at runtime.
   *
   * @param {number} tps - New ticks per second.
   * @returns {void}
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

  /**
   * Starts the internal tick loop.
   * @returns {void}
   */
  startTickLoop() {
    if (this.tickTimer) return;

    this.lastTickTime = performance.now();
    this.tickTimer = setInterval(() => this.tick(), this.tickInterval);
  }

  /**
   * Stops the internal tick loop.
   * @returns {void}
   */
  stopTickLoop() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /**
   * Performs a single tick of input processing.
   * Processes buffered points, applies smoothing/reduction, and broadcasts to peers.
   *
   * @returns {void}
   */
  tick() {
    const now = performance.now();
    this.lastTickTime = now;

    const { app } = this;

    if (app.syncClient?.isSyncing()) return;

    const needsCatchup = this.needsSmoothingCatchup();
    if (!this.inputBuffer.dirty && !needsCatchup) return;

    const { points } = this.inputBuffer;

    if (points.length >= 2) {
      const smoothingTools = ['brush', 'flowPen', 'ink', 'imageBrush', 'erase'];
      const blurTools = ['blur', 'circleBlur', 'circleBlurHard'];
      const useSmoothing = app.self.mousedown && !app.self.panning && smoothingTools.includes(app.self.tool);
      const useBlur = app.self.mousedown && !app.self.panning && blurTools.includes(app.self.tool);

      let smoothedPoints;
      let broadcastPoints;
      let localPoints;

      if (useSmoothing) {
        // Tools that smooth: apply EMA, broadcast the smoothed (+ reduced) result
        smoothedPoints = this.applyBroadcastSmoothing(points);
        broadcastPoints = this.applyPointReduction(smoothedPoints);
        localPoints = smoothedPoints;
      } else if (useBlur) {
        // Blur tools: smooth + reduce for both local and broadcast
        smoothedPoints = this.applyBroadcastSmoothing(points);
        broadcastPoints = this.applyPointReduction(smoothedPoints);
        localPoints = broadcastPoints;
      } else {
        // All other tools (pixel, line, shapes, etc.): no smoothing
        // Broadcast exactly what is rendered locally so remote matches
        smoothedPoints = points;
        broadcastPoints = this.applyPointReduction(points);
        localPoints = points;
      }

      const lastRawX = points[points.length - 2];
      const lastRawY = points[points.length - 1];
      app.self.setTarget(lastRawX, lastRawY);

      const lastX = localPoints[localPoints.length - 2];
      const lastY = localPoints[localPoints.length - 1];
      app.self.setPosition(lastX, lastY);

      if (app.self.mousedown && !app.self.panning) {
        const tool = app.toolManager.getCurrentTool();
        if (tool) {
          for (let i = 0; i < localPoints.length; i += 2) {
              const currentPos = { x: localPoints[i], y: localPoints[i+1] };
              const prevPos = i === 0 ? (this.inputBuffer.lastPosition || currentPos) : { x: localPoints[i-2], y: localPoints[i-1] };
              
              tool.onPointerMove(app.self, currentPos, prevPos);
              app.self._mainCtxDrawCount++;
              app.debugOverlay.addStrokePoint(app.self.id, currentPos.x, currentPos.y, 'tick');
          }
        }
      }

      const stampTools = ['flowPen', 'ink', 'pixel', 'circleBlur', 'circleBlurHard', 'imageBrush'];
      if (stampTools.includes(app.self.tool) && app.self.mousedown && !app.self.panning) {
        const tool = app.toolManager.getCurrentTool();
        const drain = app.self.tool === 'ink' ? tool.drainPointBuffer() : tool.drainStampBuffer();
        if (drain.ps.length > 0) {
          app.wsClient.broadcastStampMove(drain.ps, drain.rs);
        }
      } else {
        if (broadcastPoints.length > 0) {
          app.wsClient.broadcastMove(broadcastPoints);
        }
      }

      this.inputBuffer.lastPosition = { x: lastX, y: lastY };
    }

    if (needsCatchup) {
      this.processSmoothingCatchup();
    }

    this.inputBuffer.points = [];
    this.inputBuffer.dirty = false;
  }

  /**
   * Determines if the smoothing buffer needs to catch up to the target position.
   * This is true if the user has stopped moving but the smoothed point hasn't
   * yet converged on the final input position.
   *
   * @returns {boolean} True if catch-up is needed.
   */
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

  /**
   * Performs a single convergence step for smoothing catch-up.
   * @returns {void}
   */
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

    const stampTools = ['flowPen', 'ink', 'pixel', 'circleBlur', 'circleBlurHard', 'imageBrush'];
    if (stampTools.includes(app.self.tool)) {
      const drain = app.self.tool === 'ink' ? tool.drainPointBuffer() : tool.drainStampBuffer();
      if (drain.ps.length > 0) {
        app.wsClient.broadcastStampMove(drain.ps, drain.rs);
      }
    } else {
      const reducedPoints = this.applyPointReduction(smoothedPoints);
      app.wsClient.broadcastMove(reducedPoints);
    }

    app.debugOverlay.addStrokePoint(app.self.id, targetPos.x, targetPos.y, 'catchup');
  }

  /**
   * Reduces the number of points in a stroke using Douglas-Peucker.
   *
   * @param {Array<number>} points - Flattened point array.
   * @returns {Array<number>} Optimized point array.
   */
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

  /**
   * Applies Exponential Moving Average (EMA) smoothing to a batch of points.
   *
   * @param {Array<number>} points - Raw input coordinates.
   * @returns {Array<number>} Smoothed coordinates.
   */
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

  /**
   * Resets the smoothing buffers and clears the input buffer.
   * @returns {void}
   */
  resetBroadcastSmoothing() {
    resetSmoothingBuffer(this.broadcastSmoothBuffer);
    this.inputBuffer.lastPosition = null;
    this.inputBuffer.points = [];
    this.inputBuffer.dirty = false;
  }

  /**
   * Get current TPS for debug/monitoring.
   * @returns {number}
   */
  getCurrentTPS() {
    return this.tickRate;
  }

  /**
   * Get performance detection info for debug display.
   * @returns {Object}
   */
  getPerformanceInfo() {
    return {
      tickRate: this.tickRate,
      lowPowerMode: this.lowPowerMode,
      detection: window.__performanceDetection || {}
    };
  }
}
