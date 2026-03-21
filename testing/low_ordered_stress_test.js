/** @fileoverview K6 stress test - low volume, ALL bots use same tool simultaneously, cycling every 5s. */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const broadcastLatency = new Trend('broadcast_latency_low_ordered');

export const options = {
  vus: 8,
  duration: '2m', // 16 tools x 5s = 80s, plus buffer
};

const TOOL_DURATION_MS = 5000; // 5 seconds per tool
const TEST_START_TIME = Date.now(); // All VUs sync to this

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
  // Spacing (field 16)
  if (fields.sp !== undefined) {
    parts.push(new Uint8Array([0x80, 0x01, ...encodeVarint(fields.sp)]));
  }
  // Smoothing (field 23)
  if (fields.sm !== undefined) {
    parts.push(new Uint8Array([0xB8, 0x01, ...encodeVarint(fields.sm)]));
  }
  // Hardness (field 28)
  if (fields.hd !== undefined) {
    parts.push(new Uint8Array([0xE0, 0x01, ...encodeVarint(fields.hd)]));
  }
  // Blur radius (field 43)
  if (fields.br !== undefined) {
    parts.push(new Uint8Array([0xD8, 0x02, ...encodeVarint(fields.br)]));
  }
  // Layer (field 44)
  if (fields.ly !== undefined) {
    parts.push(new Uint8Array([0xE0, 0x02, ...encodeVarint(fields.ly)]));
  }
  // Blend mode (field 45) - string
  if (fields.bm !== undefined) {
    const bmBytes = new Uint8Array(Array.from(fields.bm).map(c => c.charCodeAt(0)));
    parts.push(new Uint8Array([0xEA, 0x02, ...encodeVarint(bmBytes.length)]));
    parts.push(bmBytes);
  }
  // Thinning (field 59)
  if (fields.th !== undefined) {
    parts.push(new Uint8Array([0xD8, 0x03, ...encodeVarint(fields.th)]));
  }
  // Simulate pressure (field 60)
  if (fields.sim !== undefined) {
    parts.push(new Uint8Array([0xE0, 0x03, ...encodeVarint(fields.sim)]));
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

const T = {
  CONNECT: 0, MM: 10, MD: 11, MU: 12, CS: 14, CT: 15, CC: 16,
  CSP: 17, CSM: 29, CHD: 45, CBR: 57, CL: 58, CBM: 59,
  CTHN: 71, CSIM: 72, SHOW_CURSOR: 28
};

const Tool = {
  BRUSH: 0, TEXT: 1, ERASE: 2, IMAGE_BRUSH: 3, SELECT: 4,
  PEN: 5, LINE: 6, RECTANGLE: 7, CIRCLE: 8, INK: 9,
  INKDROPPER: 10, BLUR: 11, CIRCLE_BLUR: 12, GLITCH_BLUR: 13,
  PIXEL: 14, FLOODFILL: 15
};

const toolList = Object.values(Tool);
const TOOL_COUNT = toolList.length;
const toolNames = Object.keys(Tool);

function getCurrentToolIndex() {
  const elapsed = Date.now() - TEST_START_TIME;
  return Math.floor(elapsed / TOOL_DURATION_MS) % TOOL_COUNT;
}

export default function () {
  sleep(Math.random() * 0.5); // Small stagger to avoid connection burst

  const room = __ENV.ROOM || 'test';
  const baseUrl = __ENV.TARGET_URL || 'ws://127.0.0.1:8000';
  const url = `${baseUrl}/?room=${room}`;

  let sessionIndex = -1;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `ORD_LOW_${__VU}` }));

      const margin = 50;
      let x = Math.random() * (1920 - 2 * margin) + margin;
      let y = Math.random() * (1080 - 2 * margin) + margin;
      let dx = (Math.random() - 0.5) * 10;
      let dy = (Math.random() - 0.5) * 10;

      let state = 0;
      let stateTicks = 0;
      let cycleLength = 30 + Math.floor(Math.random() * 15); // Shorter strokes to fit more in 5s
      let lastToolIndex = -1;

      socket.setInterval(function() {
        if (sessionIndex === -1) return;

        dx += (Math.random() - 0.5) * 4;
        dy += (Math.random() - 0.5) * 4;
        dx = Math.max(-15, Math.min(15, dx));
        dy = Math.max(-15, Math.min(15, dy));
        x += dx; y += dy;

        if (x < margin) { x = margin; dx *= -1; }
        if (x > 1920 - margin) { x = 1920 - margin; dx *= -1; }
        if (y < margin) { y = margin; dy *= -1; }
        if (y > 1080 - margin) { y = 1080 - margin; dy *= -1; }

        // Get current tool based on elapsed time (all VUs sync)
        const toolIndex = getCurrentToolIndex();
        const currentTool = toolList[toolIndex];

        // Log tool change
        if (toolIndex !== lastToolIndex) {
          console.log(`[VU ${__VU}] Switching to tool: ${toolNames[toolIndex]} (${toolIndex})`);
          lastToolIndex = toolIndex;
          // Force end current stroke and start fresh with new tool
          if (state === 2) {
            socket.sendBinary(buildMsg({ t: T.MU, u: sessionIndex }));
          }
          state = 0;
          stateTicks = 0;
        }

        if (state === 0) {
          const r = Math.floor(Math.random() * 256);
          const g = Math.floor(Math.random() * 256);
          const b = Math.floor(Math.random() * 256);
          const color = (r << 24) | (g << 16) | (b << 8) | 0xFF;

          // Send tool change
          socket.sendBinary(buildMsg({ t: T.CT, u: sessionIndex, l: currentTool }));
          socket.sendBinary(buildMsg({ t: T.CC, u: sessionIndex, c: color }));
          socket.sendBinary(buildMsg({ t: T.CS, u: sessionIndex, s: Math.floor(Math.random() * 3000) + 500 }));

          // Send additional properties based on tool type
          socket.sendBinary(buildMsg({ t: T.CHD, u: sessionIndex, hd: Math.floor(Math.random() * 100) }));
          socket.sendBinary(buildMsg({ t: T.CSM, u: sessionIndex, sm: Math.floor(Math.random() * 10000) }));
          socket.sendBinary(buildMsg({ t: T.CSP, u: sessionIndex, sp: Math.floor(Math.random() * 500) + 100 }));

          // Blur tools get blur radius
          if (currentTool === Tool.BLUR || currentTool === Tool.CIRCLE_BLUR || currentTool === Tool.GLITCH_BLUR) {
            socket.sendBinary(buildMsg({ t: T.CBR, u: sessionIndex, br: Math.floor(Math.random() * 2000) + 100 }));
          }

          // Ink tool gets thinning and simulate pressure
          if (currentTool === Tool.INK) {
            socket.sendBinary(buildMsg({ t: T.CTHN, u: sessionIndex, th: Math.floor(Math.random() * 100) }));
            socket.sendBinary(buildMsg({ t: T.CSIM, u: sessionIndex, sim: Math.random() > 0.5 ? 1 : 0 }));
          }

          socket.sendBinary(buildMsg({ t: T.SHOW_CURSOR, u: sessionIndex }));
          socket.sendBinary(buildMsg({ t: T.MM, u: sessionIndex, ps: [x, y] }));
          state = 1;
        }
        else if (state === 1) {
          socket.sendBinary(buildMsg({ t: T.MD, u: sessionIndex }));
          state = 2;
        }
        else if (stateTicks < cycleLength) {
          socket.sendBinary(buildMsg({ t: T.MM, u: sessionIndex, ps: [x, y], stroke_ts: Date.now() }));
        }
        else if (stateTicks === cycleLength) {
          socket.sendBinary(buildMsg({ t: T.MU, u: sessionIndex }));
          state = 0;
          stateTicks = -1;
          cycleLength = 30 + Math.floor(Math.random() * 15);
        }

        stateTicks++;
      }, 12);
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
      if (t === 0 && u !== -1 && sessionIndex === -1) sessionIndex = u;
      if (ts !== -1 && u !== sessionIndex) broadcastLatency.add(Date.now() - ts);
    });

    socket.on('error', (e) => console.log('WebSocket Error: ', e.error()));
    socket.setTimeout(() => socket.close(), 115000);
  });

  check(res, { 'Connected': (r) => r && r.status === 101 });
}
