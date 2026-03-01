/**
 * Batching Rate Comparison Test
 * Tests 30, 60, 90, and 120 TPS to compare bandwidth and latency
 * Based on existing stress test pattern
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// Metrics per tick rate
const messagesSent30 = new Counter('messages_30tps');
const messagesSent60 = new Counter('messages_60tps');
const messagesSent90 = new Counter('messages_90tps');
const messagesSent120 = new Counter('messages_120tps');

const latency30 = new Trend('latency_30tps');
const latency60 = new Trend('latency_60tps');
const latency90 = new Trend('latency_90tps');
const latency120 = new Trend('latency_120tps');

const pointsPerMsg30 = new Trend('points_per_msg_30tps');
const pointsPerMsg60 = new Trend('points_per_msg_60tps');
const pointsPerMsg90 = new Trend('points_per_msg_90tps');
const pointsPerMsg120 = new Trend('points_per_msg_120tps');

export const options = {
  scenarios: {
    tps_30: {
      executor: 'constant-vus',
      exec: 'test30TPS',
      vus: 5,
      duration: '30s',
      tags: { rate: '30tps' }
    },
    tps_60: {
      executor: 'constant-vus',
      exec: 'test60TPS',
      vus: 5,
      duration: '30s',
      startTime: '35s',
      tags: { rate: '60tps' }
    },
    tps_90: {
      executor: 'constant-vus',
      exec: 'test90TPS',
      vus: 5,
      duration: '30s',
      startTime: '70s',
      tags: { rate: '90tps' }
    },
    tps_120: {
      executor: 'constant-vus',
      exec: 'test120TPS',
      vus: 5,
      duration: '30s',
      startTime: '105s',
      tags: { rate: '120tps' }
    }
  }
};

function encodeVarint(value) {
  let bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7F) | 0x80);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return bytes;
}

function buildMsg(fields) {
  let parts = [];
  if (fields.t !== undefined) parts.push(new Uint8Array([0x08, ...encodeVarint(fields.t)]));
  if (fields.u !== undefined) parts.push(new Uint8Array([0x10, ...encodeVarint(fields.u)]));
  if (fields.ps !== undefined) {
    const floatSize = 4;
    const psLength = fields.ps.length * floatSize;
    parts.push(new Uint8Array([0x1A, ...encodeVarint(psLength)]));
    const psData = new ArrayBuffer(psLength);
    const view = new DataView(psData);
    for (let i = 0; i < fields.ps.length; i++) {
      view.setFloat32(i * floatSize, fields.ps[i], true);
    }
    parts.push(new Uint8Array(psData));
  }
  if (fields.n !== undefined) {
    const nameBytes = new Uint8Array(Array.from(fields.n).map(c => c.charCodeAt(0)));
    parts.push(new Uint8Array([0x5A, ...encodeVarint(nameBytes.length)]));
    parts.push(nameBytes);
  }
  if (fields.stroke_ts !== undefined) {
    parts.push(new Uint8Array([0xF0, 0x02, ...encodeVarint(fields.stroke_ts)]));
  }

  let totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  let result = new Uint8Array(totalLength);
  let offset = 0;
  for (let p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result.buffer;
}

const T = { CONNECT: 0, MM: 10, MD: 11, MU: 12 };

function runTest(tickRate, label, messagesMetric, latencyMetric, pointsMetric) {
  sleep(Math.random() * 2); // Stagger connections

  const url = 'ws://127.0.0.1:8000';
  let sessionIndex = -1;
  let messageCount = 0;
  let totalPoints = 0;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `${label}_VU_${__VU}` }));

      // Simulate continuous drawing
      let x = 500 + Math.random() * 400;
      let y = 500 + Math.random() * 200;
      let dx = (Math.random() - 0.5) * 8;
      let dy = (Math.random() - 0.5) * 8;

      // Simulate pointer events at ~180 Hz (5.5ms between events)
      // This way we accumulate different numbers of points per batch
      let pointBuffer = [];
      const pointerInterval = 5.5;
      const tickInterval = 1000 / tickRate;

      // Generate pointer events
      const pointerTimer = socket.setInterval(function() {
        if (sessionIndex === -1) return;

        // Update position
        dx += (Math.random() - 0.5) * 2;
        dy += (Math.random() - 0.5) * 2;
        dx = Math.max(-10, Math.min(10, dx));
        dy = Math.max(-10, Math.min(10, dy));
        x += dx;
        y += dy;

        // Bounce off edges
        if (x < 100) { x = 100; dx *= -1; }
        if (x > 1800) { x = 1800; dx *= -1; }
        if (y < 100) { y = 100; dy *= -1; }
        if (y > 980) { y = 980; dy *= -1; }

        pointBuffer.push(x, y);
      }, pointerInterval);

      // Send batches at tick rate
      const batchTimer = socket.setInterval(function() {
        if (sessionIndex === -1) return;
        if (pointBuffer.length === 0) return;

        // Send accumulated points
        const timestamp = Date.now();
        socket.sendBinary(buildMsg({
          t: T.MM,
          u: sessionIndex,
          ps: pointBuffer,
          stroke_ts: timestamp
        }));

        messageCount++;
        totalPoints += pointBuffer.length / 2;
        messagesMetric.add(1);
        pointsMetric.add(pointBuffer.length / 2);

        pointBuffer = []; // Clear buffer
      }, tickInterval);
    });

    socket.on('binaryMessage', function (data) {
      const view = new Uint8Array(data);
      let t = -1; let u = -1; let ts = -1;
      let offset = 0;

      while(offset < view.length) {
        let tag = 0; let shift = 0;
        while(true) {
          if (offset >= view.length) break;
          let b = view[offset++];
          tag += (b & 0x7F) * Math.pow(2, shift);
          if (!(b & 0x80)) break;
          shift += 7;
        }
        let fieldNum = tag >> 3;
        let wireType = tag & 0x07;

        if (fieldNum === 1) {
          let val = 0; let s = 0;
          while(true) { let b = view[offset++]; val += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
          t = val;
        } else if (fieldNum === 2) {
          let val = 0; let s = 0;
          while(true) { let b = view[offset++]; val += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
          u = val;
        } else if (fieldNum === 46) {
          let val = 0; let s = 0;
          while(true) { let b = view[offset++]; val += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
          ts = val;
        } else {
          if (wireType === 0) { while(view[offset++] & 0x80); }
          else if (wireType === 1) { offset += 8; }
          else if (wireType === 2) {
            let len = 0; let s = 0;
            while(true) { let b = view[offset++]; len += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
            offset += len;
          }
          else if (wireType === 5) { offset += 4; }
        }
      }

      if (t === 0 && u !== -1 && sessionIndex === -1) {
        sessionIndex = u;
        console.log(`${label}: Assigned session index ${sessionIndex}`);
      }
      if (ts !== -1 && u !== sessionIndex) {
        latencyMetric.add(Date.now() - ts);
      }
    });

    socket.on('error', (e) => console.log(`${label} WebSocket Error:`, e.error()));
    socket.setTimeout(() => {
      console.log(`${label}: Sent ${messageCount} messages with ${totalPoints} total points`);
      socket.close();
    }, 30000);
  });

  check(res, { [`${label} Connected`]: (r) => r && r.status === 101 });
}

export function test30TPS() {
  runTest(30, '30TPS', messagesSent30, latency30, pointsPerMsg30);
}

export function test60TPS() {
  runTest(60, '60TPS', messagesSent60, latency60, pointsPerMsg60);
}

export function test90TPS() {
  runTest(90, '90TPS', messagesSent90, latency90, pointsPerMsg90);
}

export function test120TPS() {
  runTest(120, '120TPS', messagesSent120, latency120, pointsPerMsg120);
}

export function handleSummary(data) {
  console.log('\n=== Batching Rate Comparison Results ===\n');

  const rates = [
    { name: '30 TPS', msgs: 'messages_30tps', lat: 'latency_30tps', pts: 'points_per_msg_30tps' },
    { name: '60 TPS', msgs: 'messages_60tps', lat: 'latency_60tps', pts: 'points_per_msg_60tps' },
    { name: '90 TPS', msgs: 'messages_90tps', lat: 'latency_90tps', pts: 'points_per_msg_90tps' },
    { name: '120 TPS', msgs: 'messages_120tps', lat: 'latency_120tps', pts: 'points_per_msg_120tps' }
  ];

  rates.forEach(rate => {
    const msgs = data.metrics[rate.msgs];
    const lat = data.metrics[rate.lat];
    const pts = data.metrics[rate.pts];

    if (msgs && lat && pts) {
      console.log(`${rate.name}:`);
      console.log(`  Messages sent: ${msgs.values.count}`);
      console.log(`  Avg points/msg: ${pts.values.avg.toFixed(2)}`);
      console.log(`  Latency - avg: ${lat.values.avg.toFixed(2)}ms, p95: ${lat.values['p(95)'].toFixed(2)}ms`);
      console.log('');
    }
  });

  return {
    'stdout': '',
    'testing/results/k6-batchingComparison.json': JSON.stringify(data, null, 2)
  };
}
