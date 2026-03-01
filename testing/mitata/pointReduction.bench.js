/**
 * Point Reduction Algorithm Benchmarks
 * Tests Douglas-Peucker and Distance-Based culling with various point counts
 *
 * Run: node --allow-natives-syntax testing/mitata/pointReduction.bench.js
 */

import { bench, run, summary } from 'mitata';
import { douglasPeucker, distanceBasedCulling } from '../../src/utils/drawing.js';

// Simulate realistic pointer movement patterns
function generatePointerSequence(numPoints, pattern = 'smooth') {
  const points = [];
  let x = 100, y = 100;

  for (let i = 0; i < numPoints; i++) {
    if (pattern === 'smooth') {
      // Smooth movement with occasional jumps
      x += (Math.random() - 0.5) * 5 + (Math.random() > 0.7 ? 10 : 0);
      y += (Math.random() - 0.5) * 5 + (Math.random() > 0.7 ? 10 : 0);
    } else if (pattern === 'jittery') {
      // Very jittery movement (fast hand shaking)
      x += (Math.random() - 0.5) * 15;
      y += (Math.random() - 0.5) * 15;
    } else if (pattern === 'linear') {
      // Straight line movement
      x += 2;
      y += 2;
    }
    points.push({ x, y });
  }

  return points;
}

summary(() => {
  // Test scenarios representing different drawing speeds
  const scenarios = [
    { name: '2 points (slow drawing)', count: 2, pattern: 'smooth' },
    { name: '5 points (normal speed)', count: 5, pattern: 'smooth' },
    { name: '10 points (fast drawing)', count: 10, pattern: 'smooth' },
    { name: '20 points (very fast)', count: 20, pattern: 'smooth' },
    { name: '50 points (extreme)', count: 50, pattern: 'smooth' },
  ];

  console.log('\n=== Douglas-Peucker Algorithm ===\n');

  scenarios.forEach(({ name, count, pattern }) => {
    const points = generatePointerSequence(count, pattern);

    // Test different epsilon values
    bench(`DP ε=0.5 - ${name}`, () => {
      douglasPeucker(points, 0.5);
    });

    bench(`DP ε=1.0 - ${name}`, () => {
      douglasPeucker(points, 1.0);
    });

    bench(`DP ε=2.0 - ${name}`, () => {
      douglasPeucker(points, 2.0);
    });
  });

  console.log('\n=== Distance-Based Culling ===\n');

  scenarios.forEach(({ name, count, pattern }) => {
    const points = generatePointerSequence(count, pattern);

    // Test different threshold values
    bench(`DB thresh=1 - ${name}`, () => {
      distanceBasedCulling(points, 1);
    });

    bench(`DB thresh=3 - ${name}`, () => {
      distanceBasedCulling(points, 3);
    });

    bench(`DB thresh=5 - ${name}`, () => {
      distanceBasedCulling(points, 5);
    });
  });

  console.log('\n=== Algorithm Comparison (10 points) ===\n');

  const testPoints = generatePointerSequence(10, 'smooth');

  bench('Douglas-Peucker (ε=1.0)', () => {
    douglasPeucker(testPoints, 1.0);
  });

  bench('Distance-Based (thresh=3)', () => {
    distanceBasedCulling(testPoints, 3);
  });

  bench('No reduction (baseline)', () => {
    // Just return original array to measure overhead
    const result = testPoints.slice();
  });

  console.log('\n=== Pattern Comparison (Douglas-Peucker, 20 points) ===\n');

  const smoothPoints = generatePointerSequence(20, 'smooth');
  const jitteryPoints = generatePointerSequence(20, 'jittery');
  const linearPoints = generatePointerSequence(20, 'linear');

  bench('Smooth movement', () => {
    douglasPeucker(smoothPoints, 1.0);
  });

  bench('Jittery movement', () => {
    douglasPeucker(jitteryPoints, 1.0);
  });

  bench('Linear movement', () => {
    douglasPeucker(linearPoints, 1.0);
  });
});

await run();
