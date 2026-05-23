/**
 * @fileoverview K6 stress test — high volume, ALL bots use same tool
 * simultaneously, cycling every 5s through the FULL tool set (incl. pattern,
 * confetti, text, select, floodfill) with proper tool settings.
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { buildMsg } from './_k6_proto.js';
import {
  T, Tool, TOOL_NAMES, ALL_TOOLS, TEXT_PHRASES, FONTS, BLEND_MODES,
  pick, randInt, randColor,
  configureTool, sendMove, sendDown, sendUp,
  applyTextWithFont, applyFloodFill, performSelectionTransform,
  parseInbound,
} from './_k6_actions.js';

const broadcastLatency = new Trend('broadcast_latency_high_ordered');

export const options = {
  vus: 50,
  duration: '2m30s',
};

const TOOL_DURATION_MS = 5000;
const TEST_START_TIME = Date.now();

const TOOL_CYCLE = ALL_TOOLS;

function getCurrentToolIndex() {
  const elapsed = Date.now() - TEST_START_TIME;
  return Math.floor(elapsed / TOOL_DURATION_MS) % TOOL_CYCLE.length;
}

function isStrokeTool(tool) {
  return tool !== Tool.TEXT && tool !== Tool.SELECT &&
         tool !== Tool.FLOODFILL && tool !== Tool.INKDROPPER;
}

export default function () {
  sleep(Math.random() * 0.5);

  const room = __ENV.ROOM || 'test';
  const baseUrl = __ENV.TARGET_URL || 'ws://127.0.0.1:8030';
  const url = `${baseUrl}/?room=${room}`;

  let sessionIndex = -1;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `ORD_HIGH_${__VU}` }));

      const margin = 50;
      let x = Math.random() * (1920 - 2 * margin) + margin;
      let y = Math.random() * (1080 - 2 * margin) + margin;
      let dx = (Math.random() - 0.5) * 10;
      let dy = (Math.random() - 0.5) * 10;

      let state = 0;
      let stateTicks = 0;
      let cycleLength = randInt(30, 45);
      let lastToolIndex = -1;
      let nonStrokeCooldown = 0;

      socket.setInterval(function () {
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

        const toolIndex = getCurrentToolIndex();
        const currentTool = TOOL_CYCLE[toolIndex];

        if (toolIndex !== lastToolIndex) {
          console.log(`[VU ${__VU}] Switching to tool: ${TOOL_NAMES[currentTool]} (${currentTool})`);
          lastToolIndex = toolIndex;
          if (state === 2) sendUp(socket, sessionIndex);
          state = 0;
          stateTicks = 0;
          nonStrokeCooldown = 0;
        }

        if (!isStrokeTool(currentTool)) {
          if (state === 0) {
            configureTool(socket, sessionIndex, currentTool, {
              color: randColor(),
              size: randInt(500, 3000),
            });
            sendMove(socket, sessionIndex, x, y);
            state = 1;
            nonStrokeCooldown = 0;
            return;
          }
          if (nonStrokeCooldown > 0) { nonStrokeCooldown--; return; }
          if (currentTool === Tool.TEXT) {
            applyTextWithFont(socket, sessionIndex, x, y, pick(TEXT_PHRASES), pick(FONTS));
            nonStrokeCooldown = 60;
          } else if (currentTool === Tool.SELECT) {
            performSelectionTransform(socket, sessionIndex, {
              rect: { x: x - 80, y: y - 80, width: 160, height: 160 },
            });
            nonStrokeCooldown = 100;
          } else if (currentTool === Tool.FLOODFILL) {
            applyFloodFill(socket, sessionIndex, x, y, randColor());
            nonStrokeCooldown = 50;
          } else if (currentTool === Tool.INKDROPPER) {
            sendMove(socket, sessionIndex, x, y);
            nonStrokeCooldown = 20;
          }
          return;
        }

        if (state === 0) {
          configureTool(socket, sessionIndex, currentTool, {
            color: randColor(),
            size: randInt(500, 3500),
          });
          sendMove(socket, sessionIndex, x, y);
          state = 1;
        } else if (state === 1) {
          sendDown(socket, sessionIndex, x, y);
          state = 2;
          stateTicks = 0;
        } else if (stateTicks < cycleLength) {
          sendMove(socket, sessionIndex, x, y, true);
          stateTicks++;
        } else if (stateTicks === cycleLength) {
          sendUp(socket, sessionIndex);
          state = 0;
          stateTicks = -1;
          cycleLength = randInt(30, 45);
        }
      }, 12);
    });

    socket.on('binaryMessage', function (data) {
      const { t, u, ts } = parseInbound(data);
      if (t === 0 && u !== -1 && sessionIndex === -1) sessionIndex = u;
      if (ts !== -1 && u !== sessionIndex) broadcastLatency.add(Date.now() - ts);
    });

    socket.on('error', (e) => console.log('WebSocket Error: ', e.error()));
    socket.setTimeout(() => socket.close(), 145000);
  });

  check(res, { 'Connected': (r) => r && r.status === 101 });
}
