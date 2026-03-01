/**
 * Tick Loop Processing Benchmarks
 * Tests the tick() method at different tick rates
 *
 * Run: node --allow-natives-syntax testing/mitata/tickLoop.bench.js
 */

import { bench, run, summary } from 'mitata';
import { InputBufferManager } from '../../src/input/InputBufferManager.js';

// Mock App object for testing
function createMockApp(config = {}) {
  const self = {
    mousedown: config.mousedown ?? true,
    panning: config.panning ?? false,
    tool: config.tool ?? 'brush',
    smoothing: config.smoothing ?? 0.3,
    size: 10,
    x: 100,
    y: 100,
    setPosition: function(x, y) {
      self.x = x;
      self.y = y;
    }
  };

  return {
    self,
    syncClient: {
      isSyncing: () => false
    },
    wsClient: {
      broadcastMove: () => {},
      broadcastStampMove: () => {}
    },
    toolManager: {
      getCurrentTool: () => ({
        onPointerMove: () => {},
        smoothBuffer: { x: 100, y: 100 },
        drainStampBuffer: () => ({ ps: [], rs: [] }),
        drainPointBuffer: () => ({ ps: [], rs: [] })
      })
    },
    debugOverlay: {
      addStrokePoint: () => {},
      addDrawingPoint: () => {}
    },
    regionTracker: {
      addDrawingPoint: () => {}
    }
  };
}

// Generate realistic point data
function generatePoints(count) {
  const points = [];
  for (let i = 0; i < count; i++) {
    points.push(100 + i * 2, 100 + i * 2);
  }
  return points;
}

summary(() => {
  const tickRates = [30, 60, 90, 120, 150];
  const pointCounts = [2, 5, 10, 20];

  console.log('\n=== Tick Processing at Different Rates ===\n');

  tickRates.forEach((rate) => {
    const app = createMockApp();
    const manager = new InputBufferManager(app);
    manager.tickRate = rate;
    manager.tickInterval = 1000 / rate;

    // Simulate 5 points accumulated per tick (typical case)
    bench(`${rate} TPS - 5 points`, () => {
      manager.inputBuffer.points = generatePoints(5);
      manager.inputBuffer.dirty = true;
      manager.tick();
    });
  });

  console.log('\n=== Point Count Impact (90 TPS) ===\n');

  pointCounts.forEach((count) => {
    const app = createMockApp();
    const manager = new InputBufferManager(app);
    manager.tickRate = 90;
    manager.tickInterval = 1000 / 90;

    bench(`${count} points per tick`, () => {
      manager.inputBuffer.points = generatePoints(count);
      manager.inputBuffer.dirty = true;
      manager.tick();
    });
  });

  console.log('\n=== Tool Comparison (90 TPS, 5 points) ===\n');

  const tools = ['brush', 'ink', 'flowPen', 'blur'];

  tools.forEach((tool) => {
    const app = createMockApp({ tool });
    const manager = new InputBufferManager(app);
    manager.tickRate = 90;
    manager.tickInterval = 1000 / 90;

    bench(`Tool: ${tool}`, () => {
      manager.inputBuffer.points = generatePoints(5);
      manager.inputBuffer.dirty = true;
      manager.tick();
    });
  });

  console.log('\n=== Smoothing Level Impact (90 TPS, brush, 10 points) ===\n');

  const smoothingLevels = [0, 0.3, 0.6, 1.0];

  smoothingLevels.forEach((smoothing) => {
    const app = createMockApp({ smoothing });
    const manager = new InputBufferManager(app);
    manager.tickRate = 90;
    manager.tickInterval = 1000 / 90;

    bench(`Smoothing ${(smoothing * 100).toFixed(0)}%`, () => {
      manager.inputBuffer.points = generatePoints(10);
      manager.inputBuffer.dirty = true;
      manager.tick();
    });
  });

  console.log('\n=== Tick Overhead (Empty vs Dirty) ===\n');

  const app = createMockApp();
  const manager = new InputBufferManager(app);
  manager.tickRate = 90;

  bench('Tick with no data (clean)', () => {
    manager.inputBuffer.points = [];
    manager.inputBuffer.dirty = false;
    manager.tick();
  });

  bench('Tick with 5 points (dirty)', () => {
    manager.inputBuffer.points = generatePoints(5);
    manager.inputBuffer.dirty = true;
    manager.tick();
  });
});

await run();
