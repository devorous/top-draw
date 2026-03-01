/**
 * k6 Load Test: Latency Comparison
 * Measures end-to-end latency at different batching rates
 *
 * Run: k6 run testing/k6/latencyComparison.js
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend, Gauge, Counter } from 'k6/metrics';

// Custom metrics
const roundTripLatency = new Trend('roundtrip_latency_ms');
const batchLatency = new Gauge('batch_latency_ms');
const messageLatency = new Trend('message_latency_ms');
const serverProcessingTime = new Trend('server_processing_time_ms');
const echoesReceived = new Counter('echoes_received');

export const options = {
  vus: 20,
  duration: '60s',
  thresholds: {
    'roundtrip_latency_ms': ['p(95)<500', 'p(99)<1000'],
    'message_latency_ms': ['p(95)<200'],
    'server_processing_time_ms': ['p(95)<50']
  }
};

const TICK_RATES = [30, 60, 90, 120];

export default function () {
  const tickRate = TICK_RATES[__VU % TICK_RATES.length];
  const tickInterval = 1000 / tickRate;

  const url = __ENV.WS_URL || 'ws://localhost:3000';

  const res = ws.connect(url, function (socket) {
    let messageId = 0;
    const pendingMessages = new Map();

    socket.on('open', () => {
      console.log(`VU ${__VU}: Connected (${tickRate} TPS)`);

      // Send connect message
      socket.send(JSON.stringify({ t: 0, n: `k6_latency_${__VU}` }));
    });

    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data);

        // If this is an echo with our timestamp
        if (msg.echo && msg.id !== undefined) {
          const sendTime = pendingMessages.get(msg.id);
          if (sendTime) {
            const latency = Date.now() - sendTime;
            roundTripLatency.add(latency);
            messageLatency.add(latency);
            echoesReceived.add(1);
            pendingMessages.delete(msg.id);
          }
        }

        // If server includes processing time
        if (msg.processingTime !== undefined) {
          serverProcessingTime.add(msg.processingTime);
        }
      } catch (e) {
        // Not JSON or not our echo message
      }
    });

    socket.on('error', (e) => {
      console.error(`VU ${__VU}: Error:`, e);
    });

    // Simulate drawing with latency measurement
    const testStart = Date.now();
    let lastTickTime = Date.now();
    let accumulatedPoints = [];

    while (Date.now() - testStart < 60000) { // 60 seconds
      const now = Date.now();

      // Accumulate points between ticks
      if (Math.random() < 0.5) { // ~50% chance per ms
        accumulatedPoints.push(
          500 + Math.random() * 100,
          500 + Math.random() * 100
        );
      }

      // Send batch when tick interval elapsed
      if (now - lastTickTime >= tickInterval && accumulatedPoints.length > 0) {
        const msg = {
          t: 3, // Mouse move
          ps: accumulatedPoints,
          // Include metadata for latency measurement
          id: messageId,
          ts: Date.now(),
          requestEcho: true // Ask server to echo back
        };

        pendingMessages.set(messageId, Date.now());
        socket.send(JSON.stringify(msg));

        batchLatency.value = tickInterval;
        messageId++;
        accumulatedPoints = [];
        lastTickTime = now;
      }

      sleep(0.001); // 1ms to prevent busy loop
    }

    // Clean up
    console.log(`VU ${__VU} (${tickRate} TPS): Sent ${messageId} messages, received ${echoesReceived.value || 0} echoes`);
    socket.close();
  });

  check(res, {
    'connection successful': (r) => r && r.status === 101,
  });
}

export function handleSummary(data) {
  let summary = '\n=== Latency Comparison Results ===\n\n';

  if (data.metrics.roundtrip_latency_ms) {
    const rtt = data.metrics.roundtrip_latency_ms.values;
    summary += `Round-Trip Latency (ms):\n`;
    summary += `  avg: ${rtt.avg.toFixed(2)}\n`;
    summary += `  min: ${rtt.min.toFixed(2)}\n`;
    summary += `  p50: ${rtt.med.toFixed(2)}\n`;
    summary += `  p95: ${rtt['p(95)'].toFixed(2)}\n`;
    summary += `  p99: ${rtt['p(99)'].toFixed(2)}\n`;
    summary += `  max: ${rtt.max.toFixed(2)}\n\n`;
  }

  if (data.metrics.message_latency_ms) {
    const msg = data.metrics.message_latency_ms.values;
    summary += `Message Latency (ms):\n`;
    summary += `  avg: ${msg.avg.toFixed(2)}\n`;
    summary += `  p95: ${msg['p(95)'].toFixed(2)}\n\n`;
  }

  if (data.metrics.server_processing_time_ms) {
    const proc = data.metrics.server_processing_time_ms.values;
    summary += `Server Processing (ms):\n`;
    summary += `  avg: ${proc.avg.toFixed(2)}\n`;
    summary += `  p95: ${proc['p(95)'].toFixed(2)}\n\n`;
  }

  console.log(summary);

  return {
    'stdout': summary,
    'latency-results.json': JSON.stringify(data, null, 2)
  };
}
