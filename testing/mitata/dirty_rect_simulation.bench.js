import { bench, run, group, do_not_optimize } from 'mitata';
import { LayerManager as OriginalLayerManager } from '../../src/canvas/LayerManager.js';

/**
 * MOCK ENVIRONMENT FOR NODE.JS
 */
if (typeof document === 'undefined') {
  global.document = {
    getElementById: () => ({ getContext: () => ({}) }),
    createElement: (tag) => ({
      width: 0, height: 0,
      getContext: () => ({
        lineCap: '', lineJoin: '', imageSmoothingQuality: '',
        globalCompositeOperation: '', globalAlpha: 1.0,
        drawImage: () => {}, clearRect: () => {}, fillRect: () => {},
        beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
        stroke: () => {}, arc: () => {},
        fill: () => {}, save: () => {}, restore: () => {},
        translate: () => {}, shadowBlur: 0, shadowColor: '',
        getImageData: (x, y, w, h) => {
          // Return mock ImageData for _scanImageDataForContent
          const data = new Uint8ClampedArray(w * h * 4);
          // Simulate some content within the requested image data
          if (w > 0 && h > 0) {
            data[3] = 255; // Make the first pixel opaque
            // Simulate content in the middle for more realistic bounds finding
            if (w >= 10 && h >= 10) {
              data[((Math.floor(h/2) * w) + Math.floor(w/2)) * 4 + 3] = 255;
            }
          }
          return { data, width: w, height: h };
        }
      }),
    })
  };
  global.performance = { now: () => Date.now() };
}

const WIDTH = 1920;
const HEIGHT = 1080;
const USER_ID = 1;
const GROUP_IDX = 0;

/**
 * Mock LayerManager with Dirty Rect Optimization for Benchmarking.
 * This class extends the OriginalLayerManager and overrides/adds methods
 * to implement the dirty rect tracking and optimized content bounds finding.
 */
class MockLayerManager extends OriginalLayerManager {
  constructor(width, height) {
    super(width, height);
  }

  // Override beginUserStroke to initialize dirtyRect
  beginUserStroke(groupIdx, userId, blendMode = 'source-over') {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    const { canvas, ctx } = this._createCanvas();
    group.activeStrokeByUser.set(userId, {
        canvas, ctx, blendMode,
        dirtyRect: {minX: this.width, minY: this.height, maxX: -1, maxY: -1} // Initialize dirtyRect
    });
    this.needsComposite = true;
    this._notifyHistoryPanel();
  }

  // New method: Scans an ImageData object for content within its bounds.
  _scanImageDataForContent(imageData) {
    const data = imageData.data;
    const w = imageData.width;
    const h = imageData.height;

    let minX = w, minY = h, maxX = -1, maxY = -1;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > 0) { // Check alpha channel
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }

    if (maxX < 0) return null; // Empty content
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  // Override commitUserStroke to use dirtyRect tracking
  commitUserStroke(groupIdx, userId, extraProps = {}) {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    const active = group.activeStrokeByUser.get(userId);
    if (!active) return;

    group.activeStrokeByUser.delete(userId);

    let bounds;
    if (active.dirtyRect && active.dirtyRect.maxX !== -1) {
        // Optimized path: Use dirtyRect to get focused imageData and scan only that.
        const dr = active.dirtyRect;
        const ctx = active.canvas.getContext('2d');
        const imageData = ctx.getImageData(dr.minX, dr.minY, dr.maxX - dr.minX + 1, dr.maxY - dr.minY + 1);
        const contentInDirtyRect = this._scanImageDataForContent(imageData);

        if (!contentInDirtyRect) return; // Empty stroke within dirty rect

        // Adjust bounds to be relative to the original canvas
        bounds = {
            x: dr.minX + contentInDirtyRect.x,
            y: dr.minY + contentInDirtyRect.y,
            width: contentInDirtyRect.width,
            height: contentInDirtyRect.height
        };
    } else {
        // Fallback to legacy full scan if dirtyRect is not valid
        bounds = this._findContentBounds(active.canvas); // Call original _findContentBounds
        if (!bounds) return; // Empty stroke
    }

    const { x, y, width, height } = bounds;

    // Crop the full-size canvas to just the content area
    const croppedCanvas = document.createElement('canvas');
    croppedCanvas.width = width;
    croppedCanvas.height = height;
    const croppedCtx = croppedCanvas.getContext('2d');
    croppedCtx.drawImage(active.canvas, x, y, width, height, 0, 0, width, height);

    const record = { canvas: croppedCanvas, ctx: croppedCtx, x, y, width, height, blendMode: active.blendMode, userId, timestamp: Date.now(), ...extraProps };
    group.strokeStack.push(record);

    const prev = group.userStrokeCounts.get(userId) || 0;
    group.userStrokeCounts.set(userId, prev + 1);

    this._bakeOverflowStrokes(group);
    this._clearRedoStack(userId);
    this.needsComposite = true;
    this._notifyHistoryPanel();
  }
}

group('LayerManager - _findContentBounds Original vs. Dirty Rect Simulation', () => {
  // --- Original LayerManager ---
  const originalLm = new OriginalLayerManager(WIDTH, HEIGHT);
  
  // Prepare an active stroke for the original LayerManager
  originalLm.beginUserStroke(GROUP_IDX, USER_ID, 'source-over');
  let originalActive = originalLm.layerGroups[GROUP_IDX].activeStrokeByUser.get(USER_ID);
  // Simulate some drawing (fillRect will make getImageData return content)
  originalActive.ctx.fillRect(500, 500, 10, 10); // Small stroke
  
  bench(`Original _findContentBounds (Full Scan ${WIDTH}x${HEIGHT})`, () => {
    // We can't call _findContentBounds directly as it's private.
    // So we simulate a commit, which will call the original _findContentBounds internally.
    originalLm.commitUserStroke(GROUP_IDX, USER_ID);
    // Re-initialize for next iteration
    originalLm.beginUserStroke(GROUP_IDX, USER_ID, 'source-over');
    originalLm.layerGroups[GROUP_IDX].activeStrokeByUser.get(USER_ID).ctx.fillRect(500, 500, 10, 10);
  });

  // --- Mock LayerManager with Dirty Rect ---
  const mockLm = new MockLayerManager(WIDTH, HEIGHT);

  // --- Benchmark 2: Mock LayerManager - Optimized Dirty Rect Scan (Small Stroke) ---
  // Simulate an active canvas with a small stroke and a tightly tracked dirtyRect.
  // This will use the new optimized path in commitUserStroke.
  mockLm.beginUserStroke(GROUP_IDX, USER_ID, 'source-over');
  let mockActiveSmall = mockLm.layerGroups[GROUP_IDX].activeStrokeByUser.get(USER_ID);
  const smallStrokeBounds = { x: 500, y: 500, width: 100, height: 50 };
  mockActiveSmall.canvas.getContext('2d').fillRect(smallStrokeBounds.x, smallStrokeBounds.y, smallStrokeBounds.width, smallStrokeBounds.height);
  // Manually set dirtyRect to simulate effective tracking by drawing tools
  mockActiveSmall.dirtyRect = {
    minX: smallStrokeBounds.x,
    minY: smallStrokeBounds.y,
    maxX: smallStrokeBounds.x + smallStrokeBounds.width - 1,
    maxY: smallStrokeBounds.y + smallStrokeBounds.height - 1
  };

  bench(`Mock _findContentBounds_Optimized (Dirty Rect ${smallStrokeBounds.width}x${smallStrokeBounds.height})`, () => {
    do_not_optimize(mockLm.commitUserStroke(GROUP_IDX, USER_ID));
    // Re-initialize for next iteration
    mockLm.beginUserStroke(GROUP_IDX, USER_ID, 'source-over');
    let active = mockLm.layerGroups[GROUP_IDX].activeStrokeByUser.get(USER_ID);
    active.canvas.getContext('2d').fillRect(smallStrokeBounds.x, smallStrokeBounds.y, smallStrokeBounds.width, smallStrokeBounds.height);
    active.dirtyRect = {
      minX: smallStrokeBounds.x, minY: smallStrokeBounds.y,
      maxX: smallStrokeBounds.x + smallStrokeBounds.width - 1, maxY: smallStrokeBounds.y + smallStrokeBounds.height - 1
    };
  });

  // --- Benchmark 3: Mock LayerManager - Optimized Dirty Rect Scan (Large Stroke / Worst Case) ---
  // Simulate a scenario where the dirtyRect covers the entire canvas (e.g., a very large stroke).
  // This will still use the optimized path, but getImageData will be called for the full canvas
  // if the dirtyRect encompasses it.
  mockLm.beginUserStroke(GROUP_IDX, USER_ID, 'source-over');
  let mockActiveLarge = mockLm.layerGroups[GROUP_IDX].activeStrokeByUser.get(USER_ID);
  const largeStrokeBounds = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
  mockActiveLarge.canvas.getContext('2d').fillRect(largeStrokeBounds.x, largeStrokeBounds.y, largeStrokeBounds.width, largeStrokeBounds.height);
  mockActiveLarge.dirtyRect = {
    minX: largeStrokeBounds.x,
    minY: largeStrokeBounds.y,
    maxX: largeStrokeBounds.x + largeStrokeBounds.width - 1,
    maxY: largeStrokeBounds.y + largeStrokeBounds.height - 1
  };

  bench(`Mock _findContentBounds_Optimized (Large Dirty Rect ${WIDTH}x${HEIGHT})`, () => {
    do_not_optimize(mockLm.commitUserStroke(GROUP_IDX, USER_ID));
    // Re-initialize for next iteration
    mockLm.beginUserStroke(GROUP_IDX, USER_ID, 'source-over');
    let active = mockLm.layerGroups[GROUP_IDX].activeStrokeByUser.get(USER_ID);
    active.canvas.getContext('2d').fillRect(largeStrokeBounds.x, largeStrokeBounds.y, largeStrokeBounds.width, largeStrokeBounds.height);
    active.dirtyRect = {
      minX: largeStrokeBounds.x, minY: largeStrokeBounds.y,
      maxX: largeStrokeBounds.x + largeStrokeBounds.width - 1, maxY: largeStrokeBounds.y + largeStrokeBounds.height - 1
    };
  });
});

await run();