import { bench, run, group, do_not_optimize } from 'mitata';
import { LayerManager } from '../../src/canvas/LayerManager.js';

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

// Helper to create a canvas with some "drawn" content within a specific area
function createPopulatedCanvasMock(width, height, contentBounds) {
    const canvas = document.createElement('canvas'); // Uses mock createElement
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // This mock needs to reflect content *only* within contentBounds for accurate testing
    // The getImageData mock above handles this generally, but here we ensure the bounds
    if (contentBounds) {
      // Simulate that active canvas has content ONLY within contentBounds
      ctx.getImageData = (x, y, w, h) => {
        const data = new Uint8ClampedArray(w * h * 4);
        // Only set opaque pixels if the requested ImageData overlaps contentBounds
        if (x < contentBounds.x + contentBounds.width &&
            y < contentBounds.y + contentBounds.height &&
            x + w > contentBounds.x &&
            y + h > contentBounds.y) {
            // Fill a small part of the returned imageData to simulate content
            data[3] = 255; // Make the first pixel opaque in the retrieved data
            // Simulate content in the middle of the retrieved data for more realistic bounds finding
            if (w >= 10 && h >= 10) {
              data[((Math.floor(h/2) * w) + Math.floor(w/2)) * 4 + 3] = 255;
            }
        }
        return { data, width: w, height: h };
      };
    }

    return canvas;
}

group('LayerManager - _findContentBounds Optimization Comparison', () => {
  const lm = new LayerManager(WIDTH, HEIGHT);
  
  // --- Benchmark 1: Original Full Canvas Scan ---
  // Simulate an active canvas with some content (e.g., a small stroke)
  // but with no dirtyRect tracking, forcing the legacy full scan.
  lm.beginUserStroke(GROUP_IDX, USER_ID, 'source-over');
  let activeOriginal = lm.layerGroups[GROUP_IDX].activeStrokeByUser.get(USER_ID);
  activeOriginal.canvas = createPopulatedCanvasMock(WIDTH, HEIGHT, {x: 500, y: 500, width: 10, height: 10});
  // Manually remove dirtyRect to force legacy path
  activeOriginal.dirtyRect = undefined;

  bench(`_findContentBoundsLegacy (Full Scan ${WIDTH}x${HEIGHT})`, () => {
    do_not_optimize(lm._findContentBoundsLegacy(activeOriginal.canvas));
  });

  // --- Benchmark 2: Optimized Dirty Rect Scan (Small Stroke) ---
  // Simulate an active canvas with a small stroke and a tightly tracked dirtyRect.
  // This will use the new optimized path in commitUserStroke.
  lm.beginUserStroke(GROUP_IDX, USER_ID, 'source-over');
  let activeOptimizedSmall = lm.layerGroups[GROUP_IDX].activeStrokeByUser.get(USER_ID);
  const smallStrokeBounds = { x: 500, y: 500, width: 100, height: 50 };
  activeOptimizedSmall.canvas = createPopulatedCanvasMock(WIDTH, HEIGHT, smallStrokeBounds);
  // Manually set dirtyRect to simulate effective tracking
  activeOptimizedSmall.dirtyRect = {
    minX: smallStrokeBounds.x,
    minY: smallStrokeBounds.y,
    maxX: smallStrokeBounds.x + smallStrokeBounds.width - 1,
    maxY: smallStrokeBounds.y + smallStrokeBounds.height - 1
  };

  bench(`_findContentBoundsOptimized (Dirty Rect ${smallStrokeBounds.width}x${smallStrokeBounds.height})`, () => {
    // This will trigger commitUserStroke, which now uses the dirtyRect for getImageData
    // and then calls _scanImageDataForContent on the smaller imageData.
    do_not_optimize(lm.commitUserStroke(GROUP_IDX, USER_ID));
    // Re-initialize for next iteration
    lm.beginUserStroke(GROUP_IDX, USER_ID, 'source-over');
    lm.layerGroups[GROUP_IDX].activeStrokeByUser.get(USER_ID).canvas = createPopulatedCanvasMock(WIDTH, HEIGHT, smallStrokeBounds);
    lm.layerGroups[GROUP_IDX].activeStrokeByUser.get(USER_ID).dirtyRect = {
      minX: smallStrokeBounds.x,
      minY: smallStrokeBounds.y,
      maxX: smallStrokeBounds.x + smallStrokeBounds.width - 1,
      maxY: smallStrokeBounds.y + smallStrokeBounds.height - 1
    };
  });

  // --- Benchmark 3: Optimized Dirty Rect Scan (Large Stroke / Worst Case) ---
  // Simulate a scenario where the dirtyRect covers the entire canvas (e.g., a very large stroke).
  // This will still use the optimized path, but getImageData will be called for the full canvas.
  lm.beginUserStroke(GROUP_IDX, USER_ID, 'source-over');
  let activeOptimizedLarge = lm.layerGroups[GROUP_IDX].activeStrokeByUser.get(USER_ID);
  const largeStrokeBounds = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
  activeOptimizedLarge.canvas = createPopulatedCanvasMock(WIDTH, HEIGHT, largeStrokeBounds);
  activeOptimizedLarge.dirtyRect = {
    minX: largeStrokeBounds.x,
    minY: largeStrokeBounds.y,
    maxX: largeStrokeBounds.x + largeStrokeBounds.width - 1,
    maxY: largeStrokeBounds.y + largeStrokeBounds.height - 1
  };

  bench(`_findContentBoundsOptimized (Large Dirty Rect ${WIDTH}x${HEIGHT})`, () => {
    do_not_optimize(lm.commitUserStroke(GROUP_IDX, USER_ID));
    // Re-initialize for next iteration
    lm.beginUserStroke(GROUP_IDX, USER_ID, 'source-over');
    lm.layerGroups[GROUP_IDX].activeStrokeByUser.get(USER_ID).canvas = createPopulatedCanvasMock(WIDTH, HEIGHT, largeStrokeBounds);
    lm.layerGroups[GROUP_IDX].activeStrokeByUser.get(USER_ID).dirtyRect = {
      minX: largeStrokeBounds.x,
      minY: largeStrokeBounds.y,
      maxX: largeStrokeBounds.x + largeStrokeBounds.width - 1,
      maxY: largeStrokeBounds.y + largeStrokeBounds.height - 1
    };
  });
});

await run();
