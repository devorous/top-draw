/**
 * @fileoverview K6 stress test for low-volume WebSocket traffic. Each VU picks
 * tools at random across the FULL tool set (including the new pattern +
 * confetti brushes) and exercises selection+homography transforms, text with
 * varied fonts, blend modes, flood fill, and undo.
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { buildMsg } from './_k6_proto.js';
import {
  T, Tool, ALL_TOOLS, TEXT_PHRASES, FONTS, BLEND_MODES,
  pick, randInt, randColor, isFillTargetTool,
  configureTool, sendMove, sendDown, sendUp,
  applyTextWithFont, applyFloodFill, setBlendMode,
  performSelectionTransform, sendUndo, parseInbound,
} from './_k6_actions.js';

const broadcastLatency = new Trend('broadcast_latency_low');

export const options = {
  vus: 8,
  duration: '1m',
};

// Random-action mix. Anything not in this list is a stroke with a random tool.
const SPECIAL_ACTIONS = ['blendSwap', 'selectionTransform', 'floodFill', 'undo'];
const SPECIAL_CHANCE = 0.15;

const STROKE_LENGTH = [30, 110];
const STROKE_COUNT  = [2, 6];

function isStrokeTool(tool) {
  return tool !== Tool.TEXT && tool !== Tool.SELECT &&
         tool !== Tool.FLOODFILL && tool !== Tool.INKDROPPER;
}

export default function () {
  sleep(Math.random() * 2);

  const room = __ENV.ROOM || 'test';
  const baseUrl = __ENV.TARGET_URL || 'ws://127.0.0.1:8030';
  const url = `${baseUrl}/?room=${room}`;

  let sessionIndex = -1;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `LOW_VU_${__VU}` }));

      const BOARD_WIDTH = 1920, BOARD_HEIGHT = 1080;
      const REGION_SIZE = 400, margin = 100;

      const homeX = Math.random() * (BOARD_WIDTH - REGION_SIZE - 2 * margin) + margin + REGION_SIZE / 2;
      const homeY = Math.random() * (BOARD_HEIGHT - REGION_SIZE - 2 * margin) + margin + REGION_SIZE / 2;

      let x = homeX, y = homeY, dx = 0, dy = 0;
      let state = 0; // 0=idle, 1=ready, 2=drawing
      let stateTicks = 0, cycleLength = 0;
      let currentTool = Tool.BRUSH;
      let strokesRemaining = 0;
      let idleTicks = 0;
      // Track positions the bot has actually drawn on so floodfill only fires
      // on non-transparent pixels (random points in home region are mostly empty).
      const drawnPoints = [];
      function recordDrawn(px, py) {
        drawnPoints.push({ x: px, y: py });
        if (drawnPoints.length > 64) drawnPoints.shift();
      }
      function pickDrawnPoint() {
        return drawnPoints.length ? drawnPoints[Math.floor(Math.random() * drawnPoints.length)] : null;
      }

      socket.setInterval(function () {
        if (sessionIndex === -1) return;

        if (state === 0) {
          idleTicks++;
          if (idleTicks < 15 + Math.floor(Math.random() * 30)) return;
          idleTicks = 0;

          // Occasionally fire a special non-stroke action and stay idle.
          if (Math.random() < SPECIAL_CHANCE) {
            const action = pick(SPECIAL_ACTIONS);
            try {
              if (action === 'blendSwap') {
                setBlendMode(socket, sessionIndex, pick(BLEND_MODES));
              } else if (action === 'selectionTransform') {
                performSelectionTransform(socket, sessionIndex, {
                  rect: {
                    x: homeX - REGION_SIZE / 4,
                    y: homeY - REGION_SIZE / 4,
                    width: REGION_SIZE / 2,
                    height: REGION_SIZE / 2,
                  },
                });
              } else if (action === 'floodFill') {
                const target = pickDrawnPoint();
                if (target) applyFloodFill(socket, sessionIndex, target.x, target.y, randColor());
              } else if (action === 'undo') {
                sendUndo(socket, sessionIndex);
              }
            } catch (_) { /* ignore */ }
            return;
          }

          strokesRemaining = randInt(STROKE_COUNT[0], STROKE_COUNT[1]);
          currentTool = pick(ALL_TOOLS);

          configureTool(socket, sessionIndex, currentTool, {
            color: randColor(),
            size: randInt(500, 2500),
          });

          const targetX = homeX + (Math.random() - 0.5) * REGION_SIZE;
          const targetY = homeY + (Math.random() - 0.5) * REGION_SIZE;
          x = Math.max(margin, Math.min(BOARD_WIDTH - margin, targetX));
          y = Math.max(margin, Math.min(BOARD_HEIGHT - margin, targetY));

          sendMove(socket, sessionIndex, x, y);
          state = 1;
        }
        else if (state === 1) {
          if (currentTool === Tool.TEXT) {
            applyTextWithFont(socket, sessionIndex, x, y, pick(TEXT_PHRASES), pick(FONTS));
            strokesRemaining--;
            state = 0;
          } else if (currentTool === Tool.SELECT) {
            performSelectionTransform(socket, sessionIndex, {
              rect: { x: x - 80, y: y - 80, width: 160, height: 160 },
            });
            strokesRemaining--;
            state = 0;
          } else if (currentTool === Tool.FLOODFILL) {
            const target = pickDrawnPoint();
            if (target) applyFloodFill(socket, sessionIndex, target.x, target.y, randColor());
            strokesRemaining--;
            state = 0;
          } else if (currentTool === Tool.INKDROPPER) {
            strokesRemaining--;
            state = 0;
          } else if (isStrokeTool(currentTool)) {
            sendDown(socket, sessionIndex, x, y);
            cycleLength = randInt(STROKE_LENGTH[0], STROKE_LENGTH[1]);
            state = 2;
            stateTicks = 0;
            dx = (Math.random() - 0.5) * 8;
            dy = (Math.random() - 0.5) * 8;
          } else {
            strokesRemaining--;
            state = 0;
          }
        }
        else if (state === 2) {
          stateTicks++;
          if (stateTicks < cycleLength) {
            dx += (Math.random() - 0.5) * 3;
            dy += (Math.random() - 0.5) * 3;
            dx = Math.max(-12, Math.min(12, dx));
            dy = Math.max(-12, Math.min(12, dy));
            x += dx; y += dy;

            const distFromHome = Math.sqrt((x - homeX) ** 2 + (y - homeY) ** 2);
            if (distFromHome > REGION_SIZE / 2) {
              dx *= -0.5; dy *= -0.5;
              x += (homeX - x) * 0.1;
              y += (homeY - y) * 0.1;
            }
            x = Math.max(margin, Math.min(BOARD_WIDTH - margin, x));
            y = Math.max(margin, Math.min(BOARD_HEIGHT - margin, y));

            sendMove(socket, sessionIndex, x, y, true);
            if (isFillTargetTool(currentTool)) recordDrawn(x, y);
          } else {
            sendUp(socket, sessionIndex);
            strokesRemaining--;
            state = 0;
          }
        }
      }, 12); // ~83 TPS tick rate
    });

    socket.on('binaryMessage', function (data) {
      const { t, u, ts } = parseInbound(data);
      if (t === 0 && u !== -1 && sessionIndex === -1) sessionIndex = u;
      if (ts !== -1 && u !== sessionIndex) broadcastLatency.add(Date.now() - ts);
    });

    socket.on('error', (e) => console.log('WebSocket Error: ', e.error()));
    socket.setTimeout(() => socket.close(), 55000);
  });

  check(res, { 'Connected': (r) => r && r.status === 101 });
}
