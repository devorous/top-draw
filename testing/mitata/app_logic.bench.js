import { bench, run, group, do_not_optimize } from 'mitata';
import { InputBufferManager } from '../../src/input/InputBufferManager.js';
import { BrushTool } from '../../src/tools/BrushTool.js';
import { LayerManager } from '../../src/canvas/LayerManager.js';
import * as DrawingUtils from '../../src/utils/drawing.js';

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
        bezierCurveTo: () => {}, stroke: () => {}, arc: () => {},
        fill: () => {}, save: () => {}, restore: () => {},
        translate: () => {}, shadowBlur: 0, shadowColor: '',
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })
      }),
    })
  };
  global.performance = { now: () => Date.now() };
}

// Mock App structure
const createMockApp = () => {
  const lm = new LayerManager(1920, 1080);
  const board = {
    mainCanvas: document.createElement('canvas'),
    mainCtx: document.createElement('canvas').getContext('2d'),
    topCtx: document.createElement('canvas').getContext('2d'),
    layerManager: lm,
    getWidth: () => 1920,
    getHeight: () => 1080,
    beginStroke: () => {},
    endStroke: () => {},
    compositeAllLayers: () => {},
    getActiveLayerContext: () => lm.layerGroups[0].activeStrokeByUser.get(1).ctx,
    clearTop: () => {}
  };
  
  const app = {
    board,
    self: {
      id: 1,
      x: 0, y: 0,
      mousedown: true,
      panning: false,
      smoothing: 0.5,
      size: 10,
      pressure: 1.0,
      color: [0, 0, 0, 1],
      currentLine: [],
      activeLayer: 0,
      setPosition: (x, y) => { app.self.x = x; app.self.y = y; },
      getColorString: () => 'rgba(0,0,0,1)',
      clearLine: () => { app.self.currentLine = []; }
    },
    toolManager: {
      getCurrentTool: () => app.brushTool
    },
    wsClient: {
      broadcastMove: () => {},
      broadcastPressureChange: () => {},
      broadcastMouseDown: () => {},
      broadcastMouseUp: () => {}
    },
    debugOverlay: { addStrokePoint: () => {}, startStrokeTracking: () => {}, endStrokeTracking: () => {}, addDrawingPoint: () => {} },
    regionTracker: { addDrawingPoint: () => {}, startDrawing: () => {}, endDrawing: () => {} }
  };
  
  app.brushTool = new BrushTool(board);
  return app;
};

group('Input Processing (Tick Loop)', () => {
  const app = createMockApp();
  const ibm = new InputBufferManager(app);
  
  const fillBuffer = (count) => {
    ibm.inputBuffer.points = Array.from({ length: count * 2 }, () => Math.random() * 1000);
    ibm.inputBuffer.dirty = true;
  };

  bench('Tick with 10 points (Standard)', () => {
    fillBuffer(10);
    ibm.tick();
  });

  bench('Tick with 100 points (Spike)', () => {
    fillBuffer(100);
    ibm.tick();
  });
});

group('Drawing Logic (BrushTool)', () => {
  const app = createMockApp();
  const tool = app.brushTool;
  const ctx = app.board.topCtx;
  
  const points = Array.from({ length: 50 }, (_, i) => ({ x: i * 10, y: i * 10 }));

  bench('drawLineArray - Linear (50 points)', () => {
    app.self.smoothing = 0;
    tool.drawLineArray(points, ctx, app.self);
  });

  bench('drawLineArray - Catmull-Rom (50 points)', () => {
    app.self.smoothing = 0.5;
    tool.drawLineArray(points, ctx, app.self);
  });

  bench('drawLineArray - Soft Brush (Hardness 0.5)', () => {
    app.self.smoothing = 0;
    app.self.hardness = 0.5;
    tool.drawLineArray(points, ctx, app.self);
  });
});

group('Layer Finalization (Commit & Composite)', () => {
  const app = createMockApp();
  const lm = app.board.layerManager;
  
  // Pre-fill some active stroke data
  lm.beginUserStroke(0, 1);
  const active = lm.layerGroups[0].activeStrokeByUser.get(1);
  // Simulate some drawing into active canvas
  active.ctx.fillRect(0, 0, 100, 100);

  bench('Full Commit Cycle (Scan -> Crop -> Bake -> Composite)', () => {
    // 1. Commit (includes findContentBounds and _bakeOverflowStrokes)
    lm.commitUserStroke(0, 1);
    
    // 2. Composite (Final pass)
    lm.compositeLayers(app.board.mainCtx);
    
    // Reset for next iteration
    lm.beginUserStroke(0, 1);
    lm.layerGroups[0].activeStrokeByUser.get(1).ctx.fillRect(0, 0, 100, 100);
  });
});

await run();
