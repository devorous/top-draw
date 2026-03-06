import './node_shim.js';
import { bench, run, group } from 'mitata';
import { Worker } from 'worker_threads';
import { Homography } from '../../src/utils/homography.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WIDTH = 1000;
const HEIGHT = 1000;
const SOURCE_DATA = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(255);
const SRC_POINTS = [0, 0, WIDTH, 0, 0, HEIGHT, WIDTH, HEIGHT];
const DST_POINTS = [10, 10, WIDTH-10, 50, 50, HEIGHT-50, WIDTH-5, HEIGHT-10];

// -----------------------------------------------------------------------------
// RESPONSIIVENESS MONITOR
// -----------------------------------------------------------------------------
let maxDrift = 0;
let driftInterval;

function startMonitor() {
  maxDrift = 0;
  let lastTime = performance.now();
  driftInterval = setInterval(() => {
    const now = performance.now();
    const drift = now - lastTime - 16.66; // Expected 16.6ms for 60FPS
    if (drift > maxDrift) maxDrift = drift;
    lastTime = now;
  }, 16);
}

function stopMonitor() {
  clearInterval(driftInterval);
  return maxDrift;
}

// -----------------------------------------------------------------------------
// BENCHMARKS
// -----------------------------------------------------------------------------

console.log('--- Homography Worker vs Main Thread Benchmark ---');
console.log(`Resolution: ${WIDTH}x${HEIGHT} (1.0 MegaPixels)\n`);

group('Homography Performance & Jank', () => {
  
  bench('Main Thread: 10 Massive Warps', async () => {
    startMonitor();
    for (let i = 0; i < 10; i++) {
      const h = new Homography('projective', WIDTH, HEIGHT);
      h.setImage({ data: SOURCE_DATA, width: WIDTH, height: HEIGHT });
      h.setReferencePoints(SRC_POINTS, DST_POINTS);
      h.warp();
    }
    const drift = stopMonitor();
    console.log(`  [Main Thread] Max UI Drift: ${drift.toFixed(2)}ms (Frames Dropped: ${Math.floor(drift / 16.6)})`);
  });

  bench('Web Worker: 10 Massive Warps', async () => {
    const worker = new Worker(path.join(__dirname, 'homography_worker_bench_script.js'));
    startMonitor();
    
    const runWarp = () => new Promise((resolve) => {
      worker.once('message', resolve);
      worker.postMessage({ 
        sourceData: SOURCE_DATA, 
        width: WIDTH, 
        height: HEIGHT, 
        srcPoints: SRC_POINTS, 
        dstPoints: DST_POINTS 
      });
    });

    for (let i = 0; i < 10; i++) {
      await runWarp();
    }
    
    const drift = stopMonitor();
    await worker.terminate();
    console.log(`  [Web Worker]  Max UI Drift: ${drift.toFixed(2)}ms (Frames Dropped: ${Math.floor(drift / 16.6)})`);
  });

});

await run();
