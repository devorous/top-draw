import { bench, run, group, do_not_optimize } from 'mitata';
import protobuf from 'protobufjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { T } from '../shared/MessageTypes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = await protobuf.load(path.join(__dirname, '..', 'public', 'messages.proto'));
const Msg = root.lookupType('Msg');

// Helper to generate coordinate streams (2 numbers per point)
const genPoints = (count) => Array.from({ length: count * 2 }, () => parseFloat((Math.random() * 1000).toFixed(2)));

// Pre-generate our test datasets
const dataSets = {
  p10:   { t: T.MM, ps: genPoints(10), u: 1 },
  p25:   { t: T.MM, ps: genPoints(25), u: 1 },
  p50:   { t: T.MM, ps: genPoints(50), u: 1 },
  p100:  { t: T.MM, ps: genPoints(100), u: 1 },
  p1000: { t: T.MM, ps: genPoints(1000), u: 1 },
};

// Pooled object for the "Pooled" tests
const pooledMsg = Msg.create();

/**
 * Reusable benchmark logic for a specific data size
 */
function benchmarkSize(name, data) {
  group(`Size: ${name} (${data.ps.length / 2} points)`, () => {
    
    bench('Standard Protobuf (New Object)', () => {
      const message = Msg.create(data);
      do_not_optimize(Msg.encode(message).finish());
    });

    bench('Pooled Protobuf (Object.assign)', () => {
      // We use Object.assign to simulate the server logic
      Object.assign(pooledMsg, data);
      do_not_optimize(Msg.encode(pooledMsg).finish());
    });

    bench('JSON Stringify', () => {
      do_not_optimize(JSON.stringify(data));
    });
  });
}

// Run benchmarks for all requested sizes
benchmarkSize('Small', dataSets.p10);
benchmarkSize('Medium', dataSets.p25);
benchmarkSize('Large', dataSets.p50);
benchmarkSize('High Density', dataSets.p100);
benchmarkSize('Stress Test', dataSets.p1000);

await run();