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

  // Store for debug display
  window.__performanceDetection = {
    score,
    isLowPower,
    cores,
    memory,
    renderer,
    maxTexture,
    maxVertexUnits
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
    /** @type {number|null} */
    this.localFrameId = null;

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
    this.broadcastSmoothBuffer = { x: 0, y: 0, p: 1, isFirst: true };
    /** @type {Array<number>} */
    this.pendingBroadcastPoints = [];
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
    if (this.localFrameId !== null) {
      cancelAnimationFrame(this.localFrameId);
      this.localFrameId = null;
    }
  }

  requestLocalFrame() {
    if (this.localFrameId !== null) return;
    this.localFrameId = requestAnimationFrame(() => {
      this.localFrameId = null;
      this.processLocalFrame();
    });
  }

  /**
   * Performs a single tick of input processing.
   * Prioritizes any pending local frame work, then flushes network state to peers.
   *
   * @returns {void}
   */
  tick() {
    const now = performance.now();
    this.lastTickTime = now;

    const { app } = this;

    if (app.syncClient?.isSyncing()) return;
    this.processLocalFrame();
    this.flushPendingNetwork();
  }

  processLocalFrame() {
    const { app } = this;
    if (app.syncClient?.isSyncing()) return;

    const points = this._consumeBufferedPoints();
    if (points.length >= 3) {
      this._processBufferedPoints(points);
    }

    if (this.needsSmoothingCatchup()) {
      this.processSmoothingCatchup();
    }

    if (this.inputBuffer.dirty || this.needsSmoothingCatchup()) {
      this.requestLocalFrame();
    }
  }

  flushPendingNetwork() {
    const { app } = this;
    if (app.syncClient?.isSyncing()) return;

    const tool = app.toolManager.getCurrentTool();
    if (tool && this._isStampTool(app.self.tool)) {
      const drain = app.self.tool === 'ink' ? tool.drainPointBuffer?.() : tool.drainStampBuffer?.();
      if (drain?.ps?.length > 0) {
        app.wsClient.broadcastStampMove(drain.ps, drain.rs);
      }
    }

    if (this.pendingBroadcastPoints.length > 0) {
      const reducedPoints = this.applyPointReduction(this.pendingBroadcastPoints);
      this.pendingBroadcastPoints = [];
      if (reducedPoints.length > 0) {
        const xyPoints = [];
        for (let i = 0; i < reducedPoints.length; i += 3) {
          xyPoints.push(reducedPoints[i], reducedPoints[i + 1]);
        }
        app.wsClient.broadcastMove(xyPoints);
      }
    }
  }

  _consumeBufferedPoints() {
    if (!this.inputBuffer.dirty || this.inputBuffer.points.length === 0) return [];
    const points = this.inputBuffer.points;
    this.inputBuffer.points = [];
    this.inputBuffer.dirty = false;
    return points;
  }

  _processBufferedPoints(points) {
    const { app } = this;
    const smoothingTools = ['brush', 'flowPen', 'imageBrush', 'ink'];
    const blurTools = ['blur', 'circleBlur', 'glitchBlur'];
    const useSmoothing = app.self.mousedown && !app.self.panning && smoothingTools.includes(app.self.tool);
    const useBlur = app.self.mousedown && !app.self.panning && blurTools.includes(app.self.tool);

    let smoothedPoints;
    let localPoints;
    let networkPoints;

    if (useSmoothing) {
      smoothedPoints = this.applyBroadcastSmoothing(points);
      localPoints = smoothedPoints;
      networkPoints = smoothedPoints;
    } else if (useBlur) {
      smoothedPoints = this.applyBroadcastSmoothing(points);
      localPoints = this.applyPointReduction(smoothedPoints);
      networkPoints = localPoints;
    } else {
      smoothedPoints = points;
      localPoints = points;
      networkPoints = points;
    }

    const lastRawX = points[points.length - 3];
    const lastRawY = points[points.length - 2];
    app.self.setTarget(lastRawX, lastRawY);

    const lastX = localPoints[localPoints.length - 3];
    const lastY = localPoints[localPoints.length - 2];
    const lastP = localPoints[localPoints.length - 1];
    app.self.setPosition(lastX, lastY);
    app.self.setPressure(lastP);

    if (app.self.mousedown && !app.self.panning) {
      const tool = app.toolManager.getCurrentTool();
      if (tool) {
        const isInk = app.self.tool === 'ink';

        for (let i = 0; i < localPoints.length; i += 3) {
          const currentPos = { x: localPoints[i], y: localPoints[i + 1] };
          const currentPressure = localPoints[i + 2];
          const prevPos = i === 0
            ? (this.inputBuffer.lastPosition || currentPos)
            : { x: localPoints[i - 3], y: localPoints[i - 2] };

          app.self.setPressure(currentPressure);

          if (isInk && tool.onPointerMoveNoRender) {
            tool.onPointerMoveNoRender(app.self, currentPos, prevPos);
          } else {
            tool.onPointerMove(app.self, currentPos, prevPos);
          }

          app.self._mainCtxDrawCount++;
          app.debugOverlay.addStrokePoint(app.self.id, currentPos.x, currentPos.y, 'tick');
        }

        if (isInk && tool.renderStroke) {
          tool.renderStroke(false, app.self);
          if (app.board) {
            app.board.clearTop();
            if (tool.drawPreview) tool.drawPreview();
          }
        }
      }
    }

    const usesStampBroadcast = this._isStampTool(app.self.tool) && app.self.mousedown && !app.self.panning;
    if (!usesStampBroadcast && networkPoints.length > 0) {
      this.pendingBroadcastPoints.push(...networkPoints);
    }

    this.inputBuffer.lastPosition = { x: lastX, y: lastY };
  }

  _isStampTool(toolName) {
    return ['flowPen', 'ink', 'pixel', 'circleBlur', 'imageBrush', 'pattern'].includes(toolName);
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
    const smoothingTools = ['brush', 'flowPen', 'imageBrush', 'ink'];
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
    const targetP = app.self.pressure;
    let prevPos = { x: this.broadcastSmoothBuffer.x, y: this.broadcastSmoothBuffer.y };

    const points = [targetPos.x, targetPos.y, targetP];
    const smoothedPoints = this.applyBroadcastSmoothing(points);
    const smoothedPos = { x: smoothedPoints[0], y: smoothedPoints[1] };
    const smoothedP = smoothedPoints[2];

    app.self.setPosition(smoothedPos.x, smoothedPos.y);
    app.self.setPressure(smoothedP);
    
    if (app.self.tool === 'ink' && tool.onPointerMoveNoRender) {
      tool.onPointerMoveNoRender(app.self, smoothedPos, prevPos);
      if (tool.renderStroke) {
        tool.renderStroke(false, app.self);
        if (app.board) {
          app.board.clearTop();
          if (tool.drawPreview) tool.drawPreview();
        }
      }
    } else {
      tool.onPointerMove(app.self, smoothedPos, prevPos);
    }
    app.self._mainCtxDrawCount++;
    if (!this._isStampTool(app.self.tool)) {
      this.pendingBroadcastPoints.push(...smoothedPoints);
    }

    app.debugOverlay.addStrokePoint(app.self.id, targetPos.x, targetPos.y, 'catchup');
  }

  /**
   * Reduces the number of points in a stroke using Douglas-Peucker.
   *
   * @param {Array<number>} points - Flattened point array (x, y, p triples).
   * @returns {Array<number>} Optimized point array.
   */
  applyPointReduction(points) {
    if (!this.pointReduction.enabled || points.length < 6) return points;
    const userSmoothing = this.app.self.smoothing !== undefined ? this.app.self.smoothing : 15;
    const baseline = this.baselineSmoothing.pointReduction;
    const pointObjects = [];
    for (let i = 0; i < points.length; i += 3) {
      pointObjects.push({ x: points[i], y: points[i + 1], p: points[i + 2] });
    }
    const epsilon = baseline.minEpsilon + (baseline.maxEpsilon - baseline.minEpsilon) * (userSmoothing / 50);
    const reduced = douglasPeucker(pointObjects, epsilon);
    const result = [];
    for (const p of reduced) result.push(p.x, p.y, p.p);
    return result;
  }

  /**
   * Applies Exponential Moving Average (EMA) smoothing to a batch of points.
   *
   * @param {Array<number>} points - Raw input coordinates (x, y, p triples).
   * @returns {Array<number>} Smoothed coordinates.
   */
  applyBroadcastSmoothing(points) {
    if (points.length < 3) return points;
    const userSmoothing = this.app.self.smoothing || 0;
    const result = [];
    for (let i = 0; i < points.length; i += 3) {
      const smoothed = applySmoothingEMA(this.broadcastSmoothBuffer, points[i], points[i+1], points[i+2], userSmoothing);
      result.push(smoothed.x, smoothed.y, smoothed.p);
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
    this.pendingBroadcastPoints = [];
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
