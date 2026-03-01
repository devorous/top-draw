/**
 * k6 Load Test: Server Load Comparison
 * Tests server performance under different batching strategies
 *
 * Run: k6 run testing/k6/serverLoad.js
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

// Custom metrics
const errors = new Counter('errors');
const messageProcessingTime = new Trend('processing_time_ms');
const messagesPerSecond = new Rate('messages_per_second');
const totalDataTransferred = new Counter('total_bytes_transferred');
const serverErrors = new Counter('server_errors');

export const options = {
  scenarios: {
    // Low frequency batching (30 TPS) - more points per message
    lowFrequency: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5s', target: 20 },
        { duration: '30s', target: 20 },
        { duration: '5s', target: 0 }
      ],
      exec: 'lowFrequency',
      tags: { scenario: 'low_frequency' }
    },
    // Medium frequency (90 TPS) - current setting
    mediumFrequency: {
      executor: 'ramping-vus',
      startVUs: 0,
      startTime: '45s', // Start after low frequency
      stages: [
        { duration: '5s', target: 20 },
        { duration: '30s', target: 20 },
        { duration: '5s', target: 0 }
      ],
      exec: 'mediumFrequency',
      tags: { scenario: 'medium_frequency' }
    },
    // High frequency (120 TPS) - more messages, fewer points
    highFrequency: {
      executor: 'ramping-vus',
      startVUs: 0,
      startTime: '90s', // Start after medium
      stages: [
        { duration: '5s', target: 20 },
        { duration: '30s', target: 20 },
        { duration: '5s', target: 0 }
      ],
      exec: 'highFrequency',
      tags: { scenario: 'high_frequency' }
    }
  },
  thresholds: {
    'processing_time_ms': ['p(95)<100'],
    'errors': ['count<100'],
    'server_errors': ['count<10']
  }
};

export function lowFrequency() {
  runLoadTest(30, 'low');
}

export function mediumFrequency() {
  runLoadTest(90, 'medium');
}

export function highFrequency() {
  runLoadTest(120, 'high');
}

function runLoadTest(tickRate, label) {
  const url = __ENV.WS_URL || 'ws://localhost:3000';
  const tickInterval = 1000 / tickRate;

  const res = ws.connect(url, function (socket) {
    let messageCount = 0;
    let errorCount = 0;

    socket.on('open', () => {
      console.log(`[${label}] VU ${__VU}: Connected at ${tickRate} TPS`);
      socket.send(JSON.stringify({ t: 0, n: `k6_load_${label}_${__VU}` }));
    });

    socket.on('error', (e) => {
      errorCount++;
      errors.add(1);
      console.error(`[${label}] VU ${__VU}: Error:`, e);
    });

    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.error) {
          serverErrors.add(1);
        }
      } catch (e) {
        // Binary or non-JSON message
      }
    });

    // Simulate drawing load
    const testStart = Date.now();
    let lastTickTime = Date.now();
    let accumulatedPoints = [];

    while (Date.now() - testStart < 40000) { // 40 second test
      const now = Date.now();

      // Generate points (simulate pointer events at ~180Hz)
      if (Math.random() < 0.18) {
        accumulatedPoints.push(
          Math.random() * 1000,
          Math.random() * 1000
        );
      }

      // Send batch
      if (now - lastTickTime >= tickInterval) {
        if (accumulatedPoints.length > 0) {
          const sendTime = Date.now();
          const message = JSON.stringify({
            t: 3,
            ps: accumulatedPoints,
            ts: sendTime
          });

          try {
            socket.send(message);
            messageCount++;
            messagesPerSecond.add(1);
            totalDataTransferred.add(message.length);

            const processingTime = Date.now() - sendTime;
            messageProcessingTime.add(processingTime);
          } catch (e) {
            errors.add(1);
          }

          accumulatedPoints = [];
        }
        lastTickTime = now;
      }

      sleep(0.001);
    }

    console.log(`[${label}] VU ${__VU}: Sent ${messageCount} messages with ${errorCount} errors`);
    socket.close();
  });

  check(res, {
    'connected successfully': (r) => r && r.status === 101,
  });
}

export function handleSummary(data) {
  let summary = '\n=== Server Load Test Results ===\n\n';

  // Extract metrics per scenario
  const scenarios = ['low_frequency', 'medium_frequency', 'high_frequency'];
  const labels = { low_frequency: '30 TPS', medium_frequency: '90 TPS', high_frequency: '120 TPS' };

  scenarios.forEach(scenario => {
    summary += `\n${labels[scenario]}:\n`;
    summary += `${'='.repeat(40)}\n`;

    // Filter metrics for this scenario
    const scenarioData = Object.entries(data.metrics)
      .filter(([key]) => key.includes(scenario))
      .reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
      }, {});

    if (Object.keys(scenarioData).length > 0) {
      summary += `Metrics collected for ${scenario}\n`;
    }
  });

  if (data.metrics.processing_time_ms) {
    const proc = data.metrics.processing_time_ms.values;
    summary += `\nOverall Processing Time (ms):\n`;
    summary += `  avg: ${proc.avg.toFixed(2)}\n`;
    summary += `  p95: ${proc['p(95)'].toFixed(2)}\n`;
    summary += `  p99: ${proc['p(99)'].toFixed(2)}\n\n`;
  }

  if (data.metrics.errors) {
    summary += `Total Errors: ${data.metrics.errors.values.count}\n`;
  }

  if (data.metrics.server_errors) {
    summary += `Server Errors: ${data.metrics.server_errors.values.count}\n`;
  }

  if (data.metrics.total_bytes_transferred) {
    const mb = data.metrics.total_bytes_transferred.values.count / (1024 * 1024);
    summary += `Total Data Transferred: ${mb.toFixed(2)} MB\n`;
  }

  console.log(summary);

  return {
    'stdout': summary,
    'server-load-results.json': JSON.stringify(data, null, 2)
  };
}
