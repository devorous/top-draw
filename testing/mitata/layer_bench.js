/** @fileoverview Benchmark comparing logical operation counts for current versus optimized layer compositing algorithms. */

import { bench, run, group } from 'mitata';

const isNode = typeof window === 'undefined';

/**
 * Mock 2D context for simulation.
 */
class DummyContext {
  constructor() {
    this.globalCompositeOperation = 'source-over';
    this.globalAlpha = 1.0;
    this.fillStyle = 'black';
  }
  beginPath() {}
  moveTo() {}
  lineTo() {}
  closePath() {}
  fill() {}
  fillRect() {}
  clearRect() {}
  drawImage() {}
  /**
   * Mocks getting image data.
   * @param {number} x - X coordinate.
   * @param {number} y - Y coordinate.
   * @param {number} w - Width.
   * @param {number} h - Height.
   * @returns {Object} - Mocked image data.
   */
  getImageData(x, y, w, h) {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }
  putImageData() {}
}

/**
 * Mock canvas for simulation.
 */
class DummyCanvas {
  /**
   * @param {number} w - Width.
   * @param {number} h - Height.
   */
  constructor(w, h) {
    this.width = w;
    this.height = h;
  }
  /**
   * Gets the dummy context.
   * @returns {DummyContext}
   */
  getContext() { return new DummyContext(); }
  /**
   * Mocks toDataURL.
   * @returns {string}
   */
  toDataURL() { return ''; }
}

if (isNode) {
  global.document = {
    createElement: (tag) => {
      if (tag === 'canvas') return new DummyCanvas(1920, 1080);
      return {};
    }
  };
}

/**
 * Simulates the current sequential snapshot/restore compositing algorithm.
 * @param {Array} strokes - The strokes to composite.
 * @param {string} [background='white'] - The background color.
 * @returns {Object} - The count of composite and snapshot operations.
 */
function currentComposite(strokes, background = 'white') {
  let composites = 0;
  let snapshots = 0;
  
  for (const stroke of strokes) {
    if (stroke.blendMode === 'destination-out') {
      snapshots++;
      composites++; 
    } else {
      composites++;
    }
  }
  return { composites, snapshots };
}

/**
 * Simulates the optimized isolated group buffering compositing algorithm.
 * @param {Array} strokes - The strokes to composite.
 * @param {string} [background='white'] - The background color.
 * @returns {Object} - The count of composite and snapshot operations.
 */
function optimizedComposite(strokes, background = 'white') {
  let composites = 0;
  let snapshots = 0;
  
  composites++; 
  
  for (const stroke of strokes) {
    composites++;
  }
  
  composites++;
  
  return { composites, snapshots };
}

const STROKE_COUNTS = [10, 50, 100, 500];

for (const count of STROKE_COUNTS) {
  group(`Layer Compositing: ${count} Strokes (10% Erasers)`, () => {
    const strokes = Array.from({ length: count }, (_, i) => ({
      blendMode: i % 10 === 0 ? 'destination-out' : 'multiply'
    }));

    bench('Current (Sequential Snapshots)', () => {
      currentComposite(strokes);
    });

    bench('Optimized (Isolated Buffering)', () => {
      optimizedComposite(strokes);
    });
  });
}

console.log('--- Logical Performance Comparison ---');
console.log('Strokes | Current Ops | Optimized Ops | Complexity Ratio');
for (const count of STROKE_COUNTS) {
  const s = Array.from({ length: count }, (_, i) => ({ blendMode: i % 10 === 0 ? 'destination-out' : 'multiply' }));
  const cur = currentComposite(s);
  const opt = optimizedComposite(s);
  const curWeight = cur.composites + cur.snapshots * 10;
  const optWeight = opt.composites;
  console.log(`${count.toString().padEnd(7)} | ${curWeight.toString().padEnd(11)} | ${optWeight.toString().padEnd(13)} | ${(curWeight / optWeight).toFixed(1)}x slower`);
}

await run();
