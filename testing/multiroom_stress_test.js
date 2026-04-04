/**
 * @fileoverview Realistic k6 stress test simulating genuine user drawing behavior
 * across multiple rooms to avoid exponential fan-out from a single overcrowded room.
 *
 * Presets (set via env vars):
 *   Low:    NUM_VUS=5,  NUM_ROOMS=10
 *   Medium: NUM_VUS=10, NUM_ROOMS=10
 *   High:   NUM_VUS=20, NUM_ROOMS=10
 *
 * Usage:
 *   k6 run --env TARGET_URL=wss://top-draw.koyeb.app --env NUM_VUS=10 --env NUM_ROOMS=10 testing/multiroom_stress_test.js
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const broadcastLatency = new Trend('broadcast_latency');

const NUM_VUS   = parseInt(__ENV.NUM_VUS)   || 5;
const NUM_ROOMS = parseInt(__ENV.NUM_ROOMS) || 10;

export const options = {
  vus: NUM_VUS,
  duration: __ENV.DURATION || '2m',
};

// ---------------------------------------------------------------------------
// Protobuf helpers (field encoding matches messages.proto)
// ---------------------------------------------------------------------------

function encodeVarint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7F) | 0x80);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return bytes;
}

function buildMsg(fields) {
  const parts = [];

  if (fields.t !== undefined) parts.push(new Uint8Array([0x08, ...encodeVarint(fields.t)]));
  if (fields.u !== undefined) parts.push(new Uint8Array([0x10, ...encodeVarint(fields.u)]));

  if (fields.ps !== undefined) {
    const floatSize = 4;
    const psLength  = fields.ps.length * floatSize;
    parts.push(new Uint8Array([0x1A, ...encodeVarint(psLength)]));
    const psData = new ArrayBuffer(psLength);
    const view   = new DataView(psData);
    for (let i = 0; i < fields.ps.length; i++) {
      view.setFloat32(i * floatSize, fields.ps[i], true);
    }
    parts.push(new Uint8Array(psData));
  }

  if (fields.s !== undefined) parts.push(new Uint8Array([0x28, ...encodeVarint(fields.s)]));
  if (fields.l !== undefined) parts.push(new Uint8Array([0x30, ...encodeVarint(fields.l)]));

  if (fields.c !== undefined) {
    const b = new ArrayBuffer(4);
    new DataView(b).setUint32(0, fields.c, true);
    parts.push(new Uint8Array([0x3D, ...new Uint8Array(b)]));
  }

  if (fields.n !== undefined) {
    const nameBytes = new Uint8Array(Array.from(fields.n).map(c => c.charCodeAt(0)));
    parts.push(new Uint8Array([0x5A, ...encodeVarint(nameBytes.length)]));
    parts.push(nameBytes);
  }

  if (fields.stroke_ts !== undefined) {
    parts.push(new Uint8Array([0xF0, 0x02, ...encodeVarint(fields.stroke_ts)]));
  }

  const totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  const result      = new Uint8Array(totalLength);
  let   offset      = 0;
  for (const p of parts) { result.set(p, offset); offset += p.length; }
  return result.buffer;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const T = {
  CONNECT: 0, MM: 10, MD: 11, MU: 12,
  CS: 14, CT: 15, CC: 16, SHOW_CURSOR: 28,
};

// Only realistic drawing tools — skip text, select, inkdropper, etc.
const DRAWING_TOOLS = [0, 5, 9]; // BRUSH, PEN, INK

function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function randColor() {
  const r = randInt(0, 255), g = randInt(0, 255), b = randInt(0, 255);
  return (r << 24) | (g << 16) | (b << 8) | 0xFF;
}

// ---------------------------------------------------------------------------
// VU main function
// ---------------------------------------------------------------------------

export default function () {
  // Stagger connection start to avoid thundering herd
  sleep(Math.random() * 3);

  const baseUrl = __ENV.TARGET_URL || 'ws://127.0.0.1:8000';
  // Each VU picks a random room and sticks with it for the whole session
  const roomNum = randInt(1, NUM_ROOMS);
  const room    = `${__ENV.ROOM_PREFIX || 'stress'}_${roomNum}`;
  const url     = `${baseUrl}/?room=${room}`;

  let sessionIndex = -1;

  // VU drawing state — set once on connect, changed only occasionally
  let currentTool  = DRAWING_TOOLS[Math.floor(Math.random() * DRAWING_TOOLS.length)];
  let currentColor = randColor();
  let currentSize  = randInt(300, 2000); // multiplied by 100 per protocol

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `VU_${__VU}_R${roomNum}` }));

      const margin = 50;
      let x  = Math.random() * (1920 - 2 * margin) + margin;
      let y  = Math.random() * (1080 - 2 * margin) + margin;
      let dx = (Math.random() - 0.5) * 10;
      let dy = (Math.random() - 0.5) * 10;

      // Drawing state machine: 0=idle, 1=pen-down, 2=drawing
      let state       = 0;
      let stateTicks  = 0;
      let cycleLength = randInt(40, 80);  // ticks per stroke (~500–1000ms at 12ms/tick)
      let strokeCount = 0;               // how many strokes completed this session

      socket.setInterval(function () {
        if (sessionIndex === -1) return;

        // Drift position with bounce
        dx += (Math.random() - 0.5) * 3;
        dy += (Math.random() - 0.5) * 3;
        dx = Math.max(-12, Math.min(12, dx));
        dy = Math.max(-12, Math.min(12, dy));
        x += dx; y += dy;
        if (x < margin)            { x = margin;            dx = Math.abs(dx); }
        if (x > 1920 - margin)     { x = 1920 - margin;     dx = -Math.abs(dx); }
        if (y < margin)            { y = margin;            dy = Math.abs(dy); }
        if (y > 1080 - margin)     { y = 1080 - margin;     dy = -Math.abs(dy); }

        if (state === 0) {
          // Change settings roughly every 3–7 strokes, like a real user would
          if (strokeCount === 0 || strokeCount % randInt(3, 7) === 0) {
            currentTool  = DRAWING_TOOLS[Math.floor(Math.random() * DRAWING_TOOLS.length)];
            currentColor = randColor();
            currentSize  = randInt(300, 2000);
            socket.sendBinary(buildMsg({ t: T.CT, u: sessionIndex, l: currentTool }));
            socket.sendBinary(buildMsg({ t: T.CC, u: sessionIndex, c: currentColor }));
            socket.sendBinary(buildMsg({ t: T.CS, u: sessionIndex, s: currentSize }));
            socket.sendBinary(buildMsg({ t: T.SHOW_CURSOR, u: sessionIndex }));
          }

          // Move cursor to stroke start
          socket.sendBinary(buildMsg({ t: T.MM, u: sessionIndex, ps: [x, y] }));
          state = 1;

        } else if (state === 1) {
          // Pen down
          socket.sendBinary(buildMsg({ t: T.MD, u: sessionIndex, ps: [x, y] }));
          state = 2;

        } else if (stateTicks < cycleLength) {
          // Drawing: one MM per tick
          socket.sendBinary(buildMsg({ t: T.MM, u: sessionIndex, ps: [x, y], stroke_ts: Date.now() }));

        } else {
          // Pen up, then start next stroke
          socket.sendBinary(buildMsg({ t: T.MU, u: sessionIndex }));
          strokeCount++;
          state       = 0;
          stateTicks  = -1;
          cycleLength = randInt(40, 80);
        }

        stateTicks++;
      }, 12); // ~83 ticks/s, matching the app's 90 TPS tick loop
    });

    // ---------------------------------------------------------------------------
    // Receive: decode batched length-delimited frames from server
    // ---------------------------------------------------------------------------
    socket.on('binaryMessage', function (data) {
      const view   = new Uint8Array(data);
      let   offset = 0;

      // Server sends length-delimited batched frames: [varint len][msg bytes]...
      while (offset < view.length) {
        let msgLen = 0, shift = 0;
        while (offset < view.length) {
          const b = view[offset++];
          msgLen += (b & 0x7F) * Math.pow(2, shift);
          if (!(b & 0x80)) break;
          shift += 7;
        }
        if (msgLen === 0 || offset + msgLen > view.length) break;

        const msgEnd = offset + msgLen;
        let t = 0, u = -1, ts = -1;

        while (offset < msgEnd) {
          let tag = 0, tagShift = 0;
          while (offset < msgEnd) {
            const b = view[offset++];
            tag += (b & 0x7F) * Math.pow(2, tagShift);
            if (!(b & 0x80)) break;
            tagShift += 7;
          }
          const fieldNum = tag >> 3;
          const wireType = tag & 0x07;

          if (fieldNum === 1 && wireType === 0) {
            let val = 0, s = 0;
            while (offset < msgEnd) { const b = view[offset++]; val += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
            t = val;
          } else if (fieldNum === 2 && wireType === 0) {
            let val = 0, s = 0;
            while (offset < msgEnd) { const b = view[offset++]; val += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
            u = val;
          } else if (fieldNum === 46 && wireType === 0) {
            let val = 0, s = 0;
            while (offset < msgEnd) { const b = view[offset++]; val += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
            ts = val;
          } else {
            if      (wireType === 0) { while (offset < msgEnd && view[offset++] & 0x80); }
            else if (wireType === 1) { offset += 8; }
            else if (wireType === 2) {
              let len = 0, s = 0;
              while (offset < msgEnd) { const b = view[offset++]; len += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
              offset += len;
            }
            else if (wireType === 5) { offset += 4; }
            else break;
          }
        }

        if (t === 0 && u !== -1 && sessionIndex === -1) sessionIndex = u;
        if (ts !== -1 && u !== sessionIndex) broadcastLatency.add(Date.now() - ts);

        offset = msgEnd;
      }
    });

    socket.on('error', (e) => console.log(`[VU${__VU} room=${room}] WS Error:`, e.error()));
    socket.setTimeout(() => socket.close(), (110 + randInt(0, 20)) * 1000);
  });

  check(res, { 'Connected': (r) => r && r.status === 101 });
}
