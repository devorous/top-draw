/**
 * Buffer Management Benchmarks
 * Tests memory patterns and array operations
 *
 * Run: node --allow-natives-syntax testing/mitata/bufferManagement.bench.js
 */

import { bench, run, summary } from 'mitata';

summary(() => {
  console.log('\n=== Buffer Clearing Strategies ===\n');

  bench('Clear via length = 0', () => {
    const buffer = [];
    for (let i = 0; i < 100; i++) {
      buffer.push(i);
    }
    buffer.length = 0;
  });

  bench('Clear via new array assignment', () => {
    let buffer = [];
    for (let i = 0; i < 100; i++) {
      buffer.push(i);
    }
    buffer = [];
  });

  bench('Clear via splice', () => {
    const buffer = [];
    for (let i = 0; i < 100; i++) {
      buffer.push(i);
    }
    buffer.splice(0, buffer.length);
  });

  console.log('\n=== Point Accumulation Patterns ===\n');

  bench('Sparse accumulation (1-3 points)', () => {
    const buffer = [];
    const count = Math.floor(Math.random() * 3) + 1;
    for (let i = 0; i < count; i++) {
      buffer.push(Math.random() * 1000, Math.random() * 1000);
    }
  });

  bench('Normal accumulation (3-7 points)', () => {
    const buffer = [];
    const count = Math.floor(Math.random() * 5) + 3;
    for (let i = 0; i < count; i++) {
      buffer.push(Math.random() * 1000, Math.random() * 1000);
    }
  });

  bench('Heavy accumulation (10-20 points)', () => {
    const buffer = [];
    const count = Math.floor(Math.random() * 11) + 10;
    for (let i = 0; i < count; i++) {
      buffer.push(Math.random() * 1000, Math.random() * 1000);
    }
  });

  console.log('\n=== Array Conversion (Flat to Objects) ===\n');

  const flatArray = [];
  for (let i = 0; i < 20; i++) {
    flatArray.push(i, i + 0.5);
  }

  bench('Convert flat to objects (20 points)', () => {
    const pointObjects = [];
    for (let i = 0; i < flatArray.length; i += 2) {
      pointObjects.push({ x: flatArray[i], y: flatArray[i + 1] });
    }
  });

  bench('Convert objects to flat (20 points)', () => {
    const pointObjects = [];
    for (let i = 0; i < flatArray.length; i += 2) {
      pointObjects.push({ x: flatArray[i], y: flatArray[i + 1] });
    }
    const result = [];
    for (const p of pointObjects) {
      result.push(p.x, p.y);
    }
  });

  console.log('\n=== Buffer Reuse vs Recreation ===\n');

  bench('Reuse same buffer (90 ticks)', () => {
    const buffer = [];
    for (let tick = 0; tick < 90; tick++) {
      // Accumulate points
      for (let i = 0; i < 5; i++) {
        buffer.push(Math.random() * 1000, Math.random() * 1000);
      }
      // Process (simulated)
      const processed = buffer.slice();
      // Clear for next tick
      buffer.length = 0;
    }
  });

  bench('Recreate buffer each tick (90 ticks)', () => {
    for (let tick = 0; tick < 90; tick++) {
      let buffer = [];
      // Accumulate points
      for (let i = 0; i < 5; i++) {
        buffer.push(Math.random() * 1000, Math.random() * 1000);
      }
      // Process (simulated)
      const processed = buffer.slice();
    }
  });

  console.log('\n=== Memory Pooling Simulation ===\n');

  // Simulate object pooling for point objects
  const objectPool = [];
  for (let i = 0; i < 100; i++) {
    objectPool.push({ x: 0, y: 0 });
  }

  bench('Use object pool', () => {
    const points = [];
    for (let i = 0; i < 10; i++) {
      const obj = objectPool[i];
      obj.x = Math.random() * 1000;
      obj.y = Math.random() * 1000;
      points.push(obj);
    }
  });

  bench('Create new objects', () => {
    const points = [];
    for (let i = 0; i < 10; i++) {
      points.push({
        x: Math.random() * 1000,
        y: Math.random() * 1000
      });
    }
  });

  console.log('\n=== Dirty Flag vs Array Length Check ===\n');

  bench('Check dirty flag', () => {
    const buffer = { points: [1, 2, 3, 4, 5], dirty: true };
    if (buffer.dirty) {
      // Process
      const result = buffer.points.slice();
      buffer.dirty = false;
    }
  });

  bench('Check array length', () => {
    const buffer = { points: [1, 2, 3, 4, 5] };
    if (buffer.points.length > 0) {
      // Process
      const result = buffer.points.slice();
      buffer.points.length = 0;
    }
  });
});

await run();
