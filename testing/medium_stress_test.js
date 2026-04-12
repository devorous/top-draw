/** @fileoverview K6 stress test for medium-volume WebSocket traffic with realistic user behavior. */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const broadcastLatency = new Trend('broadcast_latency_medium');

export const options = {
  vus: 20,
  duration: '2m',
};

/**
 * Encodes a numeric value as a Protobuf-style varint.
 * @param {number} value - The value to encode.
 * @returns {number[]} - The byte array representation of the varint.
 */
function encodeVarint(value) {
  let bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7F) | 0x80);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return bytes;
}

/**
 * Builds a binary message based on the provided fields, following the application's Protobuf schema.
 * @param {Object} fields - The message fields to include.
 * @returns {ArrayBuffer} - The serialized binary message.
 */
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
  if (fields.g !== undefined) {
    const gBytes = new Uint8Array(Array.from(fields.g).map(c => c.charCodeAt(0)));
    parts.push(new Uint8Array([0x62, ...encodeVarint(gBytes.length)]));
    parts.push(gBytes);
  }
  if (fields.hd !== undefined) parts.push(new Uint8Array([0xE0, 0x01, ...encodeVarint(fields.hd)]));
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
  SHOW_CURSOR: 28, CHD: 45, GMP: 23, TEXT_APPLY: 90, KP: 19
};

const Tool = {
  BRUSH: 0, TEXT: 1, ERASE: 2, IMAGE_BRUSH: 3, SELECT: 4,
  PEN: 5, LINE: 6, RECTANGLE: 7, CIRCLE: 8, INK: 9,
  INKDROPPER: 10, BLUR: 11, CIRCLE_BLUR: 12
};

// Realistic text phrases users might type
const TEXT_PHRASES = [
  'hello!', 'nice', 'cool drawing', 'lol', 'hey', 'sup',
  ':)', 'wow', 'brb', 'nice work', 'test', 'drawing',
  'awesome', 'haha', 'cool', 'ty', 'thanks', 'sweet'
];

// Common colors users tend to use
const COMMON_COLORS = [
  0x000000FF, // black
  0xFF0000FF, // red
  0x0000FFFF, // blue
  0x00FF00FF, // green
  0xFFFF00FF, // yellow
  0xFF00FFFF, // magenta
  0x00FFFFFF, // cyan
  0xFFFFFFFF, // white
  0x808080FF, // gray
  0xFFA500FF, // orange
  0x800080FF, // purple
  0x8B4513FF, // brown
];

// User behavior profiles
const BEHAVIOR_PROFILES = {
  ARTIST: { // Draws mostly with brush/pen, occasional text
    tools: [Tool.BRUSH, Tool.BRUSH, Tool.PEN, Tool.PEN, Tool.LINE, Tool.TEXT],
    strokeLength: [60, 120],
    strokeCount: [3, 8],
  },
  CASUAL: { // Mix of everything
    tools: [Tool.BRUSH, Tool.PEN, Tool.LINE, Tool.RECTANGLE, Tool.CIRCLE, Tool.TEXT, Tool.ERASE],
    strokeLength: [30, 80],
    strokeCount: [2, 6],
  },
  TEXTER: { // Mostly types text with occasional drawing
    tools: [Tool.TEXT, Tool.TEXT, Tool.TEXT, Tool.BRUSH, Tool.LINE],
    strokeLength: [20, 50],
    strokeCount: [1, 4],
  },
  EXPERIMENTER: { // Uses variety including image brushes
    tools: [Tool.BRUSH, Tool.IMAGE_BRUSH, Tool.PEN, Tool.BLUR, Tool.CIRCLE, Tool.ERASE],
    strokeLength: [40, 90],
    strokeCount: [3, 7],
  },
  SKETCHER: { // Fast, many short strokes
    tools: [Tool.PEN, Tool.PEN, Tool.LINE, Tool.LINE, Tool.BRUSH],
    strokeLength: [15, 40],
    strokeCount: [5, 12],
  },
};

const PROFILE_NAMES = Object.keys(BEHAVIOR_PROFILES);

/**
 * Main K6 virtual user function. Simulates a realistic user connecting and drawing on the canvas.
 * @returns {void}
 */
export default function () {
  sleep(Math.random() * 3);

  const room = __ENV.ROOM || 'test';
  const baseUrl = __ENV.TARGET_URL || 'ws://127.0.0.1:8000';
  const url = `${baseUrl}/?room=${room}`;

  let sessionIndex = -1;

  // Pick a behavior profile for this user
  const profile = BEHAVIOR_PROFILES[PROFILE_NAMES[Math.floor(Math.random() * PROFILE_NAMES.length)]];

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `MED_VU_${__VU}` }));

      // Define a localized "home area" for this user
      const BOARD_WIDTH = 1920;
      const BOARD_HEIGHT = 1080;
      const REGION_SIZE = 350; // Slightly tighter regions for medium test
      const margin = 100;

      // Pick a random region center
      const homeX = Math.random() * (BOARD_WIDTH - REGION_SIZE - 2 * margin) + margin + REGION_SIZE / 2;
      const homeY = Math.random() * (BOARD_HEIGHT - REGION_SIZE - 2 * margin) + margin + REGION_SIZE / 2;

      let x = homeX;
      let y = homeY;
      let dx = 0;
      let dy = 0;

      let state = 0; // 0=idle, 1=ready, 2=drawing
      let stateTicks = 0;
      let cycleLength = 0;
      let currentTool = Tool.BRUSH;
      let strokesRemaining = 0;
      let idleTicks = 0;

      // Track if we need to send image brush data
      let imageBrushSent = false;

      socket.setInterval(function() {
        if (sessionIndex === -1) return;

        if (state === 0) { // IDLE - pick what to do next
          idleTicks++;

          // Stay idle for a bit (simulate thinking/looking) - shorter idle for medium
          if (idleTicks < 10 + Math.floor(Math.random() * 20)) {
            return;
          }

          idleTicks = 0;
          strokesRemaining = profile.strokeCount[0] + Math.floor(Math.random() * (profile.strokeCount[1] - profile.strokeCount[0]));

          // Pick a tool from the profile
          currentTool = profile.tools[Math.floor(Math.random() * profile.tools.length)];

          // Pick a color (70% common colors, 30% random)
          let color;
          if (Math.random() < 0.7) {
            color = COMMON_COLORS[Math.floor(Math.random() * COMMON_COLORS.length)];
          } else {
            const r = Math.floor(Math.random() * 256);
            const g = Math.floor(Math.random() * 256);
            const b = Math.floor(Math.random() * 256);
            color = (r << 24) | (g << 16) | (b << 8) | 0xFF;
          }

          // Configure tool
          socket.sendBinary(buildMsg({ t: T.CT, u: sessionIndex, l: currentTool }));
          socket.sendBinary(buildMsg({ t: T.CC, u: sessionIndex, c: color }));

          const size = 500 + Math.floor(Math.random() * 2500); // 5-30px
          socket.sendBinary(buildMsg({ t: T.CS, u: sessionIndex, s: size }));
          socket.sendBinary(buildMsg({ t: T.SHOW_CURSOR, u: sessionIndex }));

          // If using image brush, send brush data
          if (currentTool === Tool.IMAGE_BRUSH && !imageBrushSent) {
            const brushData = JSON.stringify({ url: 'brushes/pepper.gbr' });
            socket.sendBinary(buildMsg({ t: T.GMP, u: sessionIndex, g: brushData }));
            imageBrushSent = true;
          }

          // Move to a point within the home region
          const targetX = homeX + (Math.random() - 0.5) * REGION_SIZE;
          const targetY = homeY + (Math.random() - 0.5) * REGION_SIZE;
          x = Math.max(margin, Math.min(BOARD_WIDTH - margin, targetX));
          y = Math.max(margin, Math.min(BOARD_HEIGHT - margin, targetY));

          socket.sendBinary(buildMsg({ t: T.MM, u: sessionIndex, ps: [x, y] }));
          state = 1;
        }
        else if (state === 1) { // READY - start action
          if (currentTool === Tool.TEXT) {
            // Type text
            const text = TEXT_PHRASES[Math.floor(Math.random() * TEXT_PHRASES.length)];
            socket.sendBinary(buildMsg({ t: T.TEXT_APPLY, u: sessionIndex, g: text, ps: [x, y] }));
            strokesRemaining--;
            state = strokesRemaining > 0 ? 0 : 0;
            stateTicks = 0;
          } else {
            // Start drawing stroke
            socket.sendBinary(buildMsg({ t: T.MD, u: sessionIndex, ps: [x, y] }));
            cycleLength = profile.strokeLength[0] + Math.floor(Math.random() * (profile.strokeLength[1] - profile.strokeLength[0]));
            state = 2;
            stateTicks = 0;

            // Initialize movement for this stroke
            dx = (Math.random() - 0.5) * 8;
            dy = (Math.random() - 0.5) * 8;
          }
        }
        else if (state === 2) { // DRAWING
          stateTicks++;

          if (stateTicks < cycleLength) {
            // Update movement with variation
            dx += (Math.random() - 0.5) * 3;
            dy += (Math.random() - 0.5) * 3;
            dx = Math.max(-12, Math.min(12, dx));
            dy = Math.max(-12, Math.min(12, dy));

            x += dx;
            y += dy;

            // Keep within home region (with soft boundaries)
            const distFromHome = Math.sqrt((x - homeX) ** 2 + (y - homeY) ** 2);
            if (distFromHome > REGION_SIZE / 2) {
              dx *= -0.5;
              dy *= -0.5;
              x += (homeX - x) * 0.1;
              y += (homeY - y) * 0.1;
            }

            // Keep within canvas bounds
            x = Math.max(margin, Math.min(BOARD_WIDTH - margin, x));
            y = Math.max(margin, Math.min(BOARD_HEIGHT - margin, y));

            socket.sendBinary(buildMsg({ t: T.MM, u: sessionIndex, ps: [x, y], stroke_ts: Date.now() }));
          } else {
            // End stroke
            socket.sendBinary(buildMsg({ t: T.MU, u: sessionIndex }));
            strokesRemaining--;
            state = strokesRemaining > 0 ? 0 : 0;
            stateTicks = 0;
          }
        }
      }, 12); // ~83 TPS tick rate
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
