import { bench, run, group, do_not_optimize } from 'mitata';
import { LayerManager } from '../../src/canvas/LayerManager.js';

/**
 * MOCK ENVIRONMENT FOR NODE.JS
 * This provides just enough for LayerManager to function without 'canvas' dependency
 */
if (typeof document === 'undefined') {
  global.document = {
    createElement: (tag) => {
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: (type) => ({
            lineCap: '',
            lineJoin: '',
            imageSmoothingQuality: '',
            globalCompositeOperation: '',
            globalAlpha: 1.0,
            drawImage: () => {},
            clearRect: () => {},
            fillRect: () => {},
            beginPath: () => {},
            moveTo: () => {},
            lineTo: () => {},
            stroke: () => {},
            arc: () => {},
            rect: () => {},
            setTransform: () => {},
            closePath: () => {},
            fill: () => {},
            getImageData: (x, y, w, h) => {
              // Return mock ImageData for _findContentBounds
              const length = w * h * 4;
              const data = new Uint8ClampedArray(length);
              // Fill some "content" at the center to make it non-empty
              if (length > 0) {
                const centerIdx = Math.floor(length / 8) * 4 + 3;
                if (centerIdx < length) data[centerIdx] = 255;
              }
              return { data, width: w, height: h };
            }
          }),
        };
      }
    }
  };
}

const WIDTH = 1920;
const HEIGHT = 1080;

group('LayerManager - Content Bounds Scanning (O(W*H) JS Loop)', () => {
  const lm = new LayerManager(WIDTH, HEIGHT);
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;

  bench(`Scan ${WIDTH}x${HEIGHT} (2.07M pixels)`, () => {
    do_not_optimize(lm._findContentBounds(canvas));
  });

  const smallCanvas = document.createElement('canvas');
  smallCanvas.width = 400;
  smallCanvas.height = 400;
  bench('Scan 400x400 (160k pixels)', () => {
    do_not_optimize(lm._findContentBounds(smallCanvas));
  });
});

group('LayerManager - Baking Logic', () => {
  const lm = new LayerManager(WIDTH, HEIGHT);
  
  bench('Bake 10 Strokes (Associative)', () => {
    const group = lm.layerGroups[0];
    group.strokeStack = Array.from({ length: 10 }, (_, i) => ({
      canvas: document.createElement('canvas'),
      x: 0, y: 0, width: 100, height: 100,
      blendMode: 'source-over',
      userId: 1,
      timestamp: Date.now() + i
    }));
    group.userStrokeCounts.set(1, 10);
    
    // Trigger baking by adding one more stroke
    lm._bakeOverflowStrokes(group);
  });
});

group('LayerManager - Compositing Logic Overhead', () => {
  const lm = new LayerManager(WIDTH, HEIGHT);
  const targetCtx = document.createElement('canvas').getContext('2d');
  
  // Setup 3 layers with some content
  for (let i = 0; i < 3; i++) {
    const group = lm.layerGroups[i];
    group.strokeStack = Array.from({ length: 5 }, () => ({
      canvas: document.createElement('canvas'),
      x: 0, y: 0, width: 100, height: 100,
      blendMode: 'source-over',
      userId: 1
    }));
  }

  bench('Composite 3 Layers (Simple source-over)', () => {
    do_not_optimize(lm.compositeLayers(targetCtx));
  });

  bench('Composite 3 Layers (With complex blend modes)', () => {
    lm.layerGroups[0].strokeStack[0].blendMode = 'multiply';
    do_not_optimize(lm.compositeLayers(targetCtx));
  });

  bench('Composite 3 Layers (With Eraser - Sequential Path)', () => {
    lm.layerGroups[0].strokeStack[0].blendMode = 'destination-out';
    lm.layerGroups[0].strokeStack[1].blendMode = 'multiply'; // Forces sequential
    do_not_optimize(lm.compositeLayers(targetCtx));
  });

  bench('Composite 3 Layers (With Eraser - Isolated Path)', () => {
    lm.layerGroups[0].strokeStack[0].blendMode = 'destination-out';
    lm.layerGroups[0].strokeStack[1].blendMode = 'source-over'; // Allows isolated
    do_not_optimize(lm.compositeLayers(targetCtx));
  });
});

await run();
