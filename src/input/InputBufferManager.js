/**
 * @fileoverview Manages input buffering, tick loop synchronization, and point optimization.
 * Orchestrates local drawing feedback and network broadcast rates based on device performance.
 */

import { douglasPeucker } from '../utils/drawing.js';
import { applySmoothingEMA, resetSmoothingBuffer } from '../utils/smoothing.js';
import * as wasm from '../wasm/ddraw_wasm.js';

let douglasPeuckerWasm = null;
for (const [exportName, exportValue] of Object.entries(wasm)) {
  if (exportName === 'douglas_peucker_wasm' && typeof exportValue === 'function') {
    douglasPeuckerWasm = exportValue;
    break;
  }
}

const TPS_NORMAL = 60;
const TPS_LOW_POWER = 30;

const LOW_POWER_GPU_PATTERNS = [
  'mali', 'adreno', 'powervr', 'swiftshader', 'llvmpipe',
  'intel hd graphics', 'intel uhd graphics 6',
  'vivante', 'videocore', 'tegra',
];

const REDUCE_BEFORE_RENDER_TOOLS = new Set([
  'ink',
  'erase',
  'blur',
  'glitchBlur'
]);
const BATCH_RENDER_TOOLS = new Set([
  'flowPen',
  'ink',
  'erase',
  'blur',
  'circleBlur',
  'glitchBlur',
  'pixel',
  'imageBrush'
]);
const LATEST_POINT_ONLY_TOOLS = new Set(['select']);
// Tools that need all points for smooth remote rendering (no Douglas-Peucker reduction)
const SKIP_NETWORK_REDUCTION_TOOLS = new Set(['brush']);

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

    /** @type {{x:number,y:number,p:number}|null} */
    this._lastBufferedSample = null;
    /** @type {Object} */
    this.subPixelCulling = {
      enabled: true,
      distSq: 1,           // skip if moved < 1 board-px (squared)
      pressureDelta: 0.01  // unless pressure changed by >= this
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
    this.broadcastSmoothBuffer = { x: 0, y: 0, p: 1, isFirst: true, resultOut: { x: 0, y: 0, p: 1 } };
    /** @type {Array<number>} */
    this.pendingBroadcastPoints = [];
    this.pendingBroadcastPointsAreReduced = false;

    /** @type {Array<Function>} Ordered queue of broadcast callbacks */
    this.broadcastQueue = [];

    // Scratchpad objects for zero-allocation point processing
    this._currentPosScratch = { x: 0, y: 0 };
    this._prevPosScratch = { x: 0, y: 0 };
    this._smoothedPosScratch = { x: 0, y: 0 };

    this.pointTelemetry = {
      windowStartMs: performance.now(),
      bufferedInWindow: 0,
      outgoingInWindow: 0,
      bufferedPerSec: 0,
      outgoingPerSec: 0,
      reductionPercent: 0,
      lastUpdatedMs: performance.now()
    };
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
    this.processLocalFrame();         // render locally, populate pendingBroadcastPoints
    this._snapshotStrokesToQueue();   // commit strokes to queue (no-op if buffer already drained)
    this.drainBroadcastQueue();       // send all queued actions in order
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
    this._snapshotStrokesToQueue();
    this.drainBroadcastQueue();
  }

  /**
   * Moves current pending strokes into the ordered broadcast queue.
   * This ensures that any strokes drawn before a discrete action (like undo)
   * are sent before that action.
   * 
   * @private
   */
  _snapshotStrokesToQueue() {
    // Process any unrendered input buffer points first
    const points = this._consumeBufferedPoints();
    if (points.length >= 3) {
      this._processBufferedPoints(points); // populates pendingBroadcastPoints
    }

    const { app } = this;

    // Commit stamp tool buffers (ink, gimp, etc.)
    const tool = app.toolManager.getCurrentTool();
    if (tool && this._isStampTool(app.self.tool)) {
      const drain = app.self.tool === 'ink' ? tool.drainPointBuffer?.() : tool.drainStampBuffer?.();
      if (drain?.ps?.length > 0) {
        const reduced = this._shouldPreserveStampPayload(app.self.tool)
          ? { ps: drain.ps, rs: Array.isArray(drain.rs) ? drain.rs : [] }
          : this._reduceStampPayload(drain.ps, drain.rs);
        if (app.self.tool === 'ink' && this._hasUniformRadii(reduced.rs)) {
          this._recordOutgoingPoints(reduced.ps.length / 2);
          this.broadcastQueue.push(() => app.wsClient.broadcastMove(reduced.ps));
        } else {
          this._recordOutgoingPoints(reduced.ps.length / 2);
          this.broadcastQueue.push(() => app.wsClient.broadcastStampMove(reduced.ps, reduced.rs));
        }
      }
    }

    // Commit pending move points
    if (this.pendingBroadcastPoints.length > 0) {
      // Skip reduction for tools that need all points for smooth remote rendering
      const skipReduction = SKIP_NETWORK_REDUCTION_TOOLS.has(app.self.tool);
      const reducedPoints = (this.pendingBroadcastPointsAreReduced || skipReduction)
        ? this.pendingBroadcastPoints
        : this.applyPointReduction(this.pendingBroadcastPoints);
      this.pendingBroadcastPoints = [];
      this.pendingBroadcastPointsAreReduced = false;
      if (reducedPoints.length > 0) {
        const xyPoints = [];
        for (let i = 0; i < reducedPoints.length; i += 3) {
          xyPoints.push(reducedPoints[i], reducedPoints[i + 1]);
        }
        this._recordOutgoingPoints(xyPoints.length / 2);
        this.broadcastQueue.push(() => app.wsClient.broadcastMove(xyPoints));
      }
    }
  }

  /**
   * Enqueues a broadcast action, ensuring it is sent in order relative to strokes.
   * 
   * @param {Function} fn - The broadcast callback to enqueue.
   */
  queueBroadcast(fn, options = {}) {
    if (this.app.syncClient?.isSyncing()) return; // dropped during sync; sync replay handles ordering
    if (options.snapshot !== false) {
      this._snapshotStrokesToQueue();
    }
    this.broadcastQueue.push(fn);
  }

  discardPendingStrokeInput() {
    this.inputBuffer.points = [];
    this.inputBuffer.dirty = false;
    this.pendingBroadcastPoints = [];
    this.pendingBroadcastPointsAreReduced = false;
    this._lastBufferedSample = null;
  }

  /**
   * Decides whether an incoming pointer sample should be discarded as a
   * sub-pixel/no-op move. Updates the last-buffered tracker when accepting.
   *
   * @param {number} x - Board-space x.
   * @param {number} y - Board-space y.
   * @param {number} p - Pressure (0..1).
   * @returns {boolean} True if caller should skip pushing this sample.
   */
  shouldCullSample(x, y, p) {
    // Count every raw sample arrival so the dev panel's in/out telemetry
    // reflects sub-pixel culling (and downstream DP reduction).
    this._recordBufferedPoints(1);

    const cull = this.subPixelCulling;
    if (!cull.enabled) {
      this._lastBufferedSample = { x, y, p };
      return false;
    }
    const last = this._lastBufferedSample;
    if (last !== null) {
      const dx = x - last.x;
      const dy = y - last.y;
      const dp = p - last.p;
      const dpAbs = dp < 0 ? -dp : dp;
      if (dx * dx + dy * dy < cull.distSq && dpAbs < cull.pressureDelta) {
        return true;
      }
    }
    this._lastBufferedSample = { x, y, p };
    return false;
  }

  /**
   * Drains the ordered broadcast queue, executing each callback.
   */
  drainBroadcastQueue() {
    if (this.broadcastQueue.length === 0) return;
    const queue = this.broadcastQueue;
    this.broadcastQueue = [];
    for (const fn of queue) {
      try {
        fn();
      } catch (e) {
        console.error('[InputBufferManager] broadcast error', e);
      }
    }
  }

  _consumeBufferedPoints() {
    if (!this.inputBuffer.dirty || this.inputBuffer.points.length === 0) return [];
    const points = this.inputBuffer.points;
    // Note: buffered-in count is recorded at the cull/intake stage
    // (shouldCullSample) so culled samples are visible in dev telemetry.
    this.inputBuffer.points = [];
    this.inputBuffer.dirty = false;
    return points;
  }

  _processBufferedPoints(points) {
    const { app } = this;
    const smoothingTools = ['brush', 'flowPen', 'imageBrush', 'ink', 'erase'];
    const blurTools = ['blur', 'circleBlur', 'glitchBlur'];
    const useSmoothing = app.self.mousedown && !app.self.panning && smoothingTools.includes(app.self.tool);
    const useBlur = app.self.mousedown && !app.self.panning && blurTools.includes(app.self.tool);

    let smoothedPoints;
    let localPoints;
    let networkPoints;

    if (useSmoothing) {
      smoothedPoints = this.applyBroadcastSmoothing(points);
      if (REDUCE_BEFORE_RENDER_TOOLS.has(app.self.tool)) {
        localPoints = this.applyPointReduction(smoothedPoints);
        networkPoints = localPoints;
      } else {
        localPoints = smoothedPoints;
        networkPoints = smoothedPoints;
      }
    } else if (useBlur) {
      smoothedPoints = this.applyBroadcastSmoothing(points);
      localPoints = this.applyPointReduction(smoothedPoints);
      networkPoints = localPoints;
    } else {
      smoothedPoints = points;
      localPoints = points;
      networkPoints = points;
    }

    if (LATEST_POINT_ONLY_TOOLS.has(app.self.tool) && localPoints.length > 3) {
      localPoints = localPoints.slice(-3);
      networkPoints = networkPoints.slice(-3);
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
        const isBatchRenderable = BATCH_RENDER_TOOLS.has(app.self.tool) && tool.onPointerMoveNoRender;

        for (let i = 0; i < localPoints.length; i += 3) {
          const currentX = localPoints[i];
          const currentY = localPoints[i + 1];
          const currentPressure = localPoints[i + 2];

          // Use scratchpads
          this._currentPosScratch.x = currentX;
          this._currentPosScratch.y = currentY;

          if (i === 0) {
            if (this.inputBuffer.lastPosition) {
              this._prevPosScratch.x = this.inputBuffer.lastPosition.x;
              this._prevPosScratch.y = this.inputBuffer.lastPosition.y;
            } else {
              this._prevPosScratch.x = currentX;
              this._prevPosScratch.y = currentY;
            }
          } else {
            this._prevPosScratch.x = localPoints[i - 3];
            this._prevPosScratch.y = localPoints[i - 2];
          }

          app.self.setPressure(currentPressure);

          if (isBatchRenderable) {
            tool.onPointerMoveNoRender(app.self, this._currentPosScratch, this._prevPosScratch);
          } else {
            tool.onPointerMove(app.self, this._currentPosScratch, this._prevPosScratch);
          }

          app.self._mainCtxDrawCount++;
          app.debugOverlay.addStrokePoint(app.self.id, currentX, currentY, 'tick');
        }

        if (isBatchRenderable) {
          this._renderBatchTool(tool, app.self, app.self.tool);
        }

        app.boardViewer?.requestLiveRender?.();
      }
    }

    const usesStampBroadcast = this._isStampTool(app.self.tool) && app.self.mousedown && !app.self.panning;
    if (!usesStampBroadcast && networkPoints.length > 0) {
      this.pendingBroadcastPoints.push(...networkPoints);
      if (localPoints === networkPoints && (REDUCE_BEFORE_RENDER_TOOLS.has(app.self.tool) || useBlur)) {
        this.pendingBroadcastPointsAreReduced = true;
      } else {
        this.pendingBroadcastPointsAreReduced = false;
      }
    }

    this.inputBuffer.lastPosition = { x: lastX, y: lastY };
  }

  _hasUniformRadii(radii) {
    if (!Array.isArray(radii) || radii.length <= 1) return true;
    const first = radii[0];
    for (let i = 1; i < radii.length; i++) {
      if (radii[i] !== first) return false;
    }
    return true;
  }

  _isStampTool(toolName) {
    return ['flowPen', 'ink', 'pixel', 'circleBlur', 'imageBrush'].includes(toolName);
  }

  _shouldPreserveStampPayload(toolName) {
    // flowPen handles its own reduction in drainStampBuffer - don't double-reduce
    return ['ink', 'circleBlur', 'imageBrush', 'pixel', 'flowPen'].includes(toolName);
  }

  _reduceStampPayload(ps, rs) {
    if (!Array.isArray(ps) || ps.length < 6) {
      return { ps: ps || [], rs: Array.isArray(rs) ? rs : [] };
    }

    const pointCount = Math.floor(ps.length / 2);
    const indexedTriples = [];
    for (let i = 0; i < pointCount; i++) {
      const pointOffset = i * 2;
      indexedTriples.push(ps[pointOffset], ps[pointOffset + 1], i);
    }

    const reducedTriples = this.applyPointReduction(indexedTriples);
    if (!Array.isArray(reducedTriples) || reducedTriples.length < 6) {
      return { ps, rs: Array.isArray(rs) ? rs : [] };
    }

    const reducedPs = [];
    const reducedRs = [];
    const hasRadii = Array.isArray(rs) && rs.length >= pointCount;
    let lastIndex = -1;

    for (let i = 0; i < reducedTriples.length; i += 3) {
      const pointIndex = Math.max(0, Math.min(pointCount - 1, Math.round(reducedTriples[i + 2])));
      if (pointIndex === lastIndex) continue;
      lastIndex = pointIndex;

      const pointOffset = pointIndex * 2;
      reducedPs.push(ps[pointOffset], ps[pointOffset + 1]);
      if (hasRadii) {
        reducedRs.push(rs[pointIndex]);
      }
    }

    if (reducedPs.length < 2) {
      return { ps, rs: Array.isArray(rs) ? rs : [] };
    }

    return { ps: reducedPs, rs: hasRadii ? reducedRs : [] };
  }

  _rollPointTelemetry(now = performance.now()) {
    const elapsed = now - this.pointTelemetry.windowStartMs;
    if (elapsed < 1000) return;

    const bufferedRate = (this.pointTelemetry.bufferedInWindow * 1000) / elapsed;
    const outgoingRate = (this.pointTelemetry.outgoingInWindow * 1000) / elapsed;
    const reduction = this.pointTelemetry.bufferedInWindow > 0
      ? (1 - this.pointTelemetry.outgoingInWindow / this.pointTelemetry.bufferedInWindow) * 100
      : 0;

    this.pointTelemetry.bufferedPerSec = Math.max(0, bufferedRate);
    this.pointTelemetry.outgoingPerSec = Math.max(0, outgoingRate);
    this.pointTelemetry.reductionPercent = Math.min(100, Math.max(-100, reduction));
    this.pointTelemetry.windowStartMs = now;
    this.pointTelemetry.bufferedInWindow = 0;
    this.pointTelemetry.outgoingInWindow = 0;
    this.pointTelemetry.lastUpdatedMs = now;
  }

  _recordBufferedPoints(count) {
    if (!Number.isFinite(count) || count <= 0) return;
    const now = performance.now();
    this._rollPointTelemetry(now);
    this.pointTelemetry.bufferedInWindow += count;
    this.pointTelemetry.lastUpdatedMs = now;
  }

  _recordOutgoingPoints(count) {
    if (!Number.isFinite(count) || count <= 0) return;
    const now = performance.now();
    this._rollPointTelemetry(now);
    this.pointTelemetry.outgoingInWindow += count;
    this.pointTelemetry.lastUpdatedMs = now;
  }

  getPointTelemetry() {
    this._rollPointTelemetry(performance.now());
    return {
      bufferedPerSec: this.pointTelemetry.bufferedPerSec,
      outgoingPerSec: this.pointTelemetry.outgoingPerSec,
      reductionPercent: this.pointTelemetry.reductionPercent,
      bufferedInWindow: this.pointTelemetry.bufferedInWindow,
      outgoingInWindow: this.pointTelemetry.outgoingInWindow,
      lastUpdatedMs: this.pointTelemetry.lastUpdatedMs
    };
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
    const smoothingTools = ['brush', 'flowPen', 'imageBrush', 'ink', 'erase'];
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
    
    const isBatchRenderable = BATCH_RENDER_TOOLS.has(app.self.tool) && tool.onPointerMoveNoRender;
    if (isBatchRenderable) {
      tool.onPointerMoveNoRender(app.self, smoothedPos, prevPos);
      this._renderBatchTool(tool, app.self, app.self.tool);
    } else {
      tool.onPointerMove(app.self, smoothedPos, prevPos);
    }
    app.boardViewer?.requestLiveRender?.();
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
    const epsilon = baseline.minEpsilon + (baseline.maxEpsilon - baseline.minEpsilon) * (userSmoothing / 50);

    // Prefer WASM if available (already optimized for flat arrays)
    if (typeof douglasPeuckerWasm === 'function') {
      try {
        // Rust expects a Float32Array
        const floatPoints = points instanceof Float32Array ? points : new Float32Array(points);
        return douglasPeuckerWasm(floatPoints, epsilon);
      } catch (e) {
        console.error('WASM Douglas-Peucker failed, falling back to JS:', e);
      }
    }

    // Fallback to JS (now also optimized for flat arrays)
    return douglasPeucker(points, epsilon);
  }

  _renderBatchTool(tool, user, toolName) {
    const { app } = this;
    if (!tool || !user) return;

    if (tool.renderStroke) {
      tool.renderStroke(false, user);
    }

    const usesTopPreview = toolName === 'erase' || toolName === 'flowPen' || toolName === 'pixel' || toolName === 'glitchBlur' || toolName === 'ink';

    const previewRect = tool.getPreviewDirtyRect?.(user) ?? null;
    const hasNoPreviewWork = previewRect === false;

    if (app.board && usesTopPreview && !hasNoPreviewWork) {
      app.board.clearTop(previewRect);
    }

    if (usesTopPreview && !hasNoPreviewWork && tool.drawPreview) {
      tool.drawPreview(user, previewRect);
    }

    if (toolName === 'blur' || toolName === 'circleBlur' || toolName === 'glitchBlur' || toolName === 'imageBrush') {
      app.board?.requestUpdate();
    }
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
      const smoothed = applySmoothingEMA(
        this.broadcastSmoothBuffer, 
        points[i], 
        points[i+1], 
        points[i+2], 
        userSmoothing,
        0.12,
        this.broadcastSmoothBuffer.resultOut
      );
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
    this.pendingBroadcastPointsAreReduced = false;
    this._lastBufferedSample = null;
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
    this._rollPointTelemetry(performance.now());
    return {
      tickRate: this.tickRate,
      lowPowerMode: this.lowPowerMode,
      pointTelemetry: this.getPointTelemetry(),
      detection: window.__performanceDetection || {}
    };
  }
}
