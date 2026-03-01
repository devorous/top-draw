/**
 * Broadcast Smoothing Benchmarks
 * Tests EMA smoothing performance at different smoothing levels
 *
 * Run: node --allow-natives-syntax testing/mitata/broadcastSmoothing.bench.js
 */

import { bench, run, summary } from 'mitata';
import { InputBufferManager } from '../../src/input/InputBufferManager.js';

// Mock App
function createMockApp(smoothing = 0.3) {
  return {
    self: { smoothing }
  };
}

// Generate point arrays
function generatePoints(count) {
  const points = [];
  for (let i = 0; i < count; i++) {
    points.push(100 + i * 2 + Math.random() * 5, 100 + i * 2 + Math.random() * 5);
  }
  return points;
}

summary(() => {
  console.log('\n=== Broadcast Smoothing at Different Levels ===\n');

  const smoothingLevels = [0, 0.2, 0.4, 0.6, 0.8, 1.0];

  smoothingLevels.forEach((smoothing) => {
    const app = createMockApp(smoothing);
    const manager = new InputBufferManager(app);
    const points = generatePoints(10);

    bench(`Smoothing ${(smoothing * 100).toFixed(0)}% - 10 points`, () => {
      manager.broadcastSmoothBuffer.isFirst = true;
      manager.applyBroadcastSmoothing(points);
    });
  });

  console.log('\n=== Point Count Impact (smoothing 50%) ===\n');

  const pointCounts = [2, 5, 10, 20, 50];

  pointCounts.forEach((count) => {
    const app = createMockApp(0.5);
    const manager = new InputBufferManager(app);
    const points = generatePoints(count);

    bench(`${count} points`, () => {
      manager.broadcastSmoothBuffer.isFirst = true;
      manager.applyBroadcastSmoothing(points);
    });
  });

  console.log('\n=== Smoothing vs No Smoothing (10 points) ===\n');

  const app = createMockApp(0.5);
  const manager = new InputBufferManager(app);
  const points = generatePoints(10);

  bench('With smoothing (50%)', () => {
    manager.broadcastSmoothBuffer.isFirst = true;
    manager.applyBroadcastSmoothing(points);
  });

  bench('No smoothing (baseline)', () => {
    // Just return original array
    const result = points.slice();
  });

  console.log('\n=== Continuous Drawing Simulation (90 ticks) ===\n');

  // Simulate 1 second of drawing at 90 TPS
  bench('1 second at 90 TPS (5 pts/tick)', () => {
    const app = createMockApp(0.3);
    const manager = new InputBufferManager(app);

    for (let i = 0; i < 90; i++) {
      const points = generatePoints(5);
      manager.applyBroadcastSmoothing(points);
    }
  });

  // Simulate with different tick rates
  const tickRates = [30, 60, 90, 120];

  console.log('\n=== Smoothing Load at Different Tick Rates (1 second) ===\n');

  tickRates.forEach((rate) => {
    bench(`${rate} TPS`, () => {
      const app = createMockApp(0.3);
      const manager = new InputBufferManager(app);

      for (let i = 0; i < rate; i++) {
        const points = generatePoints(5);
        manager.applyBroadcastSmoothing(points);
      }
    });
  });
});

await run();
