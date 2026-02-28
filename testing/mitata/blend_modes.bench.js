import { bench, run, group, do_not_optimize } from 'mitata';
import { LayerManager } from '../../src/canvas/LayerManager.js';

/**
 * MOCK ENVIRONMENT FOR NODE.JS
 */
if (typeof document === 'undefined') {
  global.document = {
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
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })
      }),
    })
  };
}

const WIDTH = 1920;
const HEIGHT = 1080;

group('Blend Mode Impact on Compositing', () => {
  const lm = new LayerManager(WIDTH, HEIGHT);
  const targetCtx = document.createElement('canvas').getContext('2d');
  
  const setupGroup = (blendMode) => {
    const group = lm.layerGroups[0];
    group.strokeStack = [{
      canvas: document.createElement('canvas'),
      x: 0, y: 0, width: 100, height: 100,
      blendMode: blendMode,
      userId: 1
    }];
  };

  const modes = [
    'source-over',
    'multiply',
    'screen',
    'overlay',
    'darken',
    'lighten',
    'difference',
    'destination-out'
  ];

  for (const mode of modes) {
    bench(`Mode: ${mode}`, () => {
      setupGroup(mode);
      do_not_optimize(lm.compositeLayers(targetCtx));
    });
  }
});

group('Full Stroke Cycle Performance', () => {
  const lm = new LayerManager(WIDTH, HEIGHT);
  const targetCtx = document.createElement('canvas').getContext('2d');
  const userId = 1;
  const groupIdx = 0;

  bench('Simulate Full Stroke (Begin -> 10 draws -> Commit -> Composite)', () => {
    // 1. Begin
    lm.beginUserStroke(groupIdx, userId, 'source-over');
    
    // 2. Draw (simulated by getting context 10 times)
    for (let i = 0; i < 10; i++) {
      const ctx = lm.getUserStrokeContext(groupIdx, userId);
      // Mock drawing
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(100, 100);
      ctx.stroke();
      
      // Live composite (happens during drawing)
      lm.compositeLayers(targetCtx);
    }
    
    // 3. Commit (includes pixel scan and baking)
    lm.commitUserStroke(groupIdx, userId);
    
    // 4. Final composite
    lm.compositeLayers(targetCtx);
  });
});

await run();
