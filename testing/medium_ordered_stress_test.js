/** @fileoverview K6 stress test - medium volume, ALL bots use same tool simultaneously, cycling every 5s. */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { buildMsg } from './_k6_proto.js';

const broadcastLatency = new Trend('broadcast_latency_medium_ordered');

export const options = {
  vus: 20,
  duration: '2m',
};

const TOOL_DURATION_MS = 5000; // 5 seconds per tool
const TEST_START_TIME = Date.now(); // All VUs sync to this

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
  sleep(Math.random() * 0.5);

  const room = __ENV.ROOM || 'test';
  const baseUrl = __ENV.TARGET_URL || 'ws://127.0.0.1:8030';
  const url = `${baseUrl}/?room=${room}`;

  let sessionIndex = -1;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `ORD_MED_${__VU}` }));

      const margin = 50;
      let x = Math.random() * (1920 - 2 * margin) + margin;
      let y = Math.random() * (1080 - 2 * margin) + margin;
      let dx = (Math.random() - 0.5) * 10;
      let dy = (Math.random() - 0.5) * 10;

      let state = 0;
      let stateTicks = 0;
      let cycleLength = 30 + Math.floor(Math.random() * 15);
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

          socket.sendBinary(buildMsg({ t: T.CT, u: sessionIndex, l: currentTool }));
          socket.sendBinary(buildMsg({ t: T.CC, u: sessionIndex, c: color }));
          socket.sendBinary(buildMsg({ t: T.CS, u: sessionIndex, s: Math.floor(Math.random() * 3000) + 500 }));

          socket.sendBinary(buildMsg({ t: T.CHD, u: sessionIndex, hd: Math.floor(Math.random() * 100) }));
          socket.sendBinary(buildMsg({ t: T.CSM, u: sessionIndex, sm: Math.floor(Math.random() * 10000) }));
          socket.sendBinary(buildMsg({ t: T.CSP, u: sessionIndex, sp: Math.floor(Math.random() * 500) + 100 }));

          if (currentTool === Tool.BLUR || currentTool === Tool.CIRCLE_BLUR || currentTool === Tool.GLITCH_BLUR) {
            socket.sendBinary(buildMsg({ t: T.CBR, u: sessionIndex, br: Math.floor(Math.random() * 2000) + 100 }));
          }

          if (currentTool === Tool.INK) {
            socket.sendBinary(buildMsg({ t: T.CTHN, u: sessionIndex, th: Math.floor(Math.random() * 100) }));
            socket.sendBinary(buildMsg({ t: T.CSIM, u: sessionIndex, sim: Math.random() > 0.5 ? 1 : 0 }));
          }

          socket.sendBinary(buildMsg({ t: T.SHOW_CURSOR, u: sessionIndex }));
          socket.sendBinary(buildMsg({ t: T.MM, u: sessionIndex, ps: [x, y] }));
          state = 1;
        }
        else if (state === 1) {
          socket.sendBinary(buildMsg({ t: T.MD, u: sessionIndex, ps: [x, y] }));
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
      let t = 0; let u = -1; let ts = -1;
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
