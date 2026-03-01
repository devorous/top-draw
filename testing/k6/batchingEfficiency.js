/**
 * k6 Load Test: Batching Efficiency
 * Compares bandwidth usage across different batching periods
 *
 * Run: k6 run testing/k6/batchingEfficiency.js
 * Or with options: k6 run --vus 50 --duration 30s testing/k6/batchingEfficiency.js
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// Custom metrics
const messagesSent = new Counter('messages_sent');
const bytesTransmitted = new Trend('bytes_transmitted');
const pointsPerMessage = new Trend('points_per_message');
const reductionRatio = new Trend('reduction_ratio');
const connectionDuration = new Trend('connection_duration_ms');

// Test configuration
const TICK_RATES = [30, 60, 90, 120];
const POINTER_RATE = 180; // Simulate 180 Hz pointer events (aggressive)
const TEST_DURATION_SECONDS = 30;

export const options = {
  stages: [
    { duration: '10s', target: 10 },   // Ramp up to 10 VUs
    { duration: '30s', target: 50 },   // Main test: 50 concurrent users
    { duration: '10s', target: 0 },    // Ramp down
  ],
  thresholds: {
    'ws_connecting': ['p(95)<1000'],        // Connection time < 1s for 95%
    'ws_session_duration': ['p(95)<60000'], // Session duration reasonable
    'bytes_transmitted': ['avg<500'],        // Average message size < 500 bytes
    'points_per_message': ['avg>1'],        // At least 1 point per message
    'reduction_ratio': ['avg>0.3']          // At least 30% reduction
  }
};

export default function () {
  // Each VU uses a different tick rate for comparison
  const tickRate = TICK_RATES[__VU % TICK_RATES.length];
  const tickInterval = 1000 / tickRate;

  const url = __ENV.WS_URL || 'ws://localhost:3000';
  const testDuration = parseInt(__ENV.TEST_DURATION || TEST_DURATION_SECONDS) * 1000;

  const startTime = Date.now();

  const res = ws.connect(url, function (socket) {
    const connectionStart = Date.now();
    let totalBytesSent = 0;
    let totalMessagesSent = 0;
    let totalPointsSent = 0;
    let totalPointsGenerated = 0;

    // Send initial connection message
    const connectMsg = JSON.stringify({ t: 0, n: `k6_user_${__VU}` });
    socket.send(connectMsg);

    socket.on('open', () => {
      console.log(`VU ${__VU}: Connected with ${tickRate} TPS`);
    });

    socket.on('message', (data) => {
      // Handle server messages if needed
    });

    socket.on('error', (e) => {
      console.error(`VU ${__VU}: WebSocket error:`, e);
    });

    socket.on('close', () => {
      const duration = Date.now() - connectionStart;
      connectionDuration.add(duration);

      console.log(`VU ${__VU} (${tickRate} TPS) Results:
        - Duration: ${duration}ms
        - Messages: ${totalMessagesSent}
        - Points sent: ${totalPointsSent}
        - Points generated: ${totalPointsGenerated}
        - Reduction: ${((1 - totalPointsSent / totalPointsGenerated) * 100).toFixed(1)}%
        - Avg bytes/msg: ${(totalBytesSent / totalMessagesSent).toFixed(0)}
        - Avg points/msg: ${(totalPointsSent / totalMessagesSent).toFixed(1)}
      `);
    });

    // Simulate drawing session
    let accumulatedPoints = [];
    let lastTickTime = Date.now();
    const sessionStart = Date.now();

    while (Date.now() - sessionStart < testDuration) {
      const now = Date.now();

      // Simulate pointer events at POINTER_RATE Hz
      if (Math.random() < POINTER_RATE / 1000) {
        const x = 500 + Math.random() * 200 - 100;
        const y = 500 + Math.random() * 200 - 100;
        accumulatedPoints.push(x, y);
        totalPointsGenerated++;
      }

      // Send batch when tick interval elapsed
      if (now - lastTickTime >= tickInterval && accumulatedPoints.length > 0) {
        const message = JSON.stringify({
          t: 3, // Mouse move message type
          ps: accumulatedPoints
        });

        const messageSize = message.length;
        socket.send(message);

        totalBytesSent += messageSize;
        totalMessagesSent++;
        totalPointsSent += accumulatedPoints.length / 2;

        bytesTransmitted.add(messageSize);
        pointsPerMessage.add(accumulatedPoints.length / 2);
        messagesSent.add(1);

        if (totalPointsGenerated > 0) {
          reductionRatio.add(1 - totalPointsSent / totalPointsGenerated);
        }

        accumulatedPoints = [];
        lastTickTime = now;
      }

      sleep(0.001); // 1ms sleep to prevent busy loop
    }

    socket.close();
  });

  check(res, {
    'status is 101': (r) => r && r.status === 101,
  });
}

export function handleSummary(data) {
  // Custom summary with per-tick-rate breakdown
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'summary.json': JSON.stringify(data),
  };
}

function textSummary(data, options) {
  let summary = '\n=== Batching Efficiency Test Results ===\n\n';

  if (data.metrics.messages_sent) {
    summary += `Total Messages Sent: ${data.metrics.messages_sent.values.count}\n`;
  }

  if (data.metrics.bytes_transmitted) {
    const bytes = data.metrics.bytes_transmitted.values;
    summary += `Bytes per Message: avg=${bytes.avg.toFixed(1)} p95=${bytes['p(95)'].toFixed(1)}\n`;
  }

  if (data.metrics.points_per_message) {
    const points = data.metrics.points_per_message.values;
    summary += `Points per Message: avg=${points.avg.toFixed(2)} p95=${points['p(95)'].toFixed(2)}\n`;
  }

  if (data.metrics.reduction_ratio) {
    const reduction = data.metrics.reduction_ratio.values;
    summary += `Point Reduction: avg=${(reduction.avg * 100).toFixed(1)}%\n`;
  }

  summary += '\n';
  return summary;
}
