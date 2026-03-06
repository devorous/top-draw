import { bench, run, group } from 'mitata';

/**
 * SHIM: Mock Canvas for Node.js environments
 * If running in a browser, the real HTMLCanvasElement will be used.
 */
const isNode = typeof window === 'undefined';
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
  getImageData(x, y, w, h) {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }
  putImageData() {}
}

class DummyCanvas {
  constructor(w, h) {
    this.width = w;
    this.height = h;
  }
  getContext() { return new DummyContext(); }
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

// -----------------------------------------------------------------------------
// Algorithm Mock-ups for Comparison
// -----------------------------------------------------------------------------

/**
 * CURRENT ALGORITHM (Sequential Snapshot/Restore)
 * O(N * E) complexity
 */
function currentComposite(strokes, background = 'white') {
  let composites = 0;
  let snapshots = 0;
  
  // Simulation of: for each stroke { if eraser then snapshot lower layers then restore }
  const erasers = strokes.filter(s => s.blendMode === 'destination-out');
  
  for (const stroke of strokes) {
    if (stroke.blendMode === 'destination-out') {
      // Snapshot lower layers (Expensive!)
      snapshots++;
      // Draw background into hole
      composites++; 
    } else {
      composites++;
    }
  }
  return { composites, snapshots };
}

/**
 * OPTIMIZED ALGORITHM (Isolated Group Buffering)
 * O(N) complexity
 */
function optimizedComposite(strokes, background = 'white') {
  let composites = 0;
  let snapshots = 0;
  
  // 1. Clear isolated buffer (1 call)
  composites++; 
  
  // 2. Draw all strokes into buffer (N calls)
  for (const stroke of strokes) {
    composites++;
  }
  
  // 3. Draw buffer onto target (1 call)
  composites++;
  
  return { composites, snapshots };
}

// -----------------------------------------------------------------------------
// Benchmarks
// -----------------------------------------------------------------------------

const STROKE_COUNTS = [10, 50, 100, 500];

for (const count of STROKE_COUNTS) {
  group(`Layer Compositing: ${count} Strokes (10% Erasers)`, () => {
    // Generate test data: 90% normal, 10% eraser
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

/**
 * Note: These benchmarks use logical "operation counts" to demonstrate the 
 * algorithmic difference. In a real environment with a GPU/Canvas, the 
 * "Snapshot" operation is significantly more expensive than a "Composite" 
 * operation (O(W*H) memory copy vs O(Region) draw call).
 */

console.log('--- Logical Performance Comparison ---');
console.log('Strokes | Current Ops | Optimized Ops | Complexity Ratio');
for (const count of STROKE_COUNTS) {
  const s = Array.from({ length: count }, (_, i) => ({ blendMode: i % 10 === 0 ? 'destination-out' : 'multiply' }));
  const cur = currentComposite(s);
  const opt = optimizedComposite(s);
  // Weight snapshots by 10x for rough approximation of memory copy cost
  const curWeight = cur.composites + cur.snapshots * 10;
  const optWeight = opt.composites;
  console.log(`${count.toString().padEnd(7)} | ${curWeight.toString().padEnd(11)} | ${optWeight.toString().padEnd(13)} | ${(curWeight / optWeight).toFixed(1)}x slower`);
}

await run();
