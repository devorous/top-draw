/**
 * @fileoverview K6 stress test for medium-volume WebSocket traffic. Each VU
 * picks tools at random across the FULL tool set (incl. pattern + confetti)
 * and exercises selection+homography, text with fonts, blend modes, flood
 * fill, and undo.
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

const broadcastLatency = new Trend('broadcast_latency_medium');

export const options = {
  vus: 20,
  duration: '2m',
};

const SPECIAL_ACTIONS = ['blendSwap', 'selectionTransform', 'floodFill', 'undo'];
const SPECIAL_CHANCE = 0.18;

const STROKE_LENGTH = [25, 100];
const STROKE_COUNT  = [2, 7];

function isStrokeTool(tool) {
  return tool !== Tool.TEXT && tool !== Tool.SELECT &&
         tool !== Tool.FLOODFILL && tool !== Tool.INKDROPPER;
}

/**
 * Optional tool restriction, e.g. `-e TOOLS=ink,pen`.
 *
 * The bots normally pick uniformly from all 18 tools, so any single tool is
 * ~5.5 % of the traffic — far too little signal to judge a change to one tool's
 * render path against this suite's run-to-run variance. Narrowing the pool
 * amplifies the path under test instead of trying to average the noise away.
 * Unknown names are reported rather than silently dropped: a typo would
 * otherwise fall back to the full set and look like "the change did nothing".
 */
const TOOL_POOL = (() => {
  const raw = (__ENV.TOOLS || '').trim();
  if (!raw) return ALL_TOOLS;
  const wanted = raw.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  const picked = [];
  for (const name of wanted) {
    if (Tool[name] === undefined) throw new Error(`TOOLS: unknown tool "${name}"`);
    picked.push(Tool[name]);
  }
  return picked;
})();

export default function () {
  sleep(Math.random() * 3);

  const room = __ENV.ROOM || 'test';
  const baseUrl = __ENV.TARGET_URL || 'ws://127.0.0.1:8030';
  const url = `${baseUrl}/?room=${room}`;

  let sessionIndex = -1;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `MED_VU_${__VU}` }));

      // BOARD_W/BOARD_H default to the historical hardcoded 1080p. They matter
      // on a larger board: left at 1920x1080 the bots only ever touch the
      // top-left corner of a 1440p board, which silently changes how much of
      // the board gets painted and is exactly the kind of thing that makes a
      // backing-store measurement lie.
      const BOARD_WIDTH = Number(__ENV.BOARD_W || 1920);
      const BOARD_HEIGHT = Number(__ENV.BOARD_H || 1080);
      const REGION_SIZE = Number(__ENV.REGION_SIZE || 350), margin = 100;

      // CLUSTERS=n snaps every bot's home region to one of n fixed, evenly
      // spaced points instead of a free random position, so painted content
      // stays confined to a few areas of the board. Needed to exercise the
      // tiled backing store's sparse case under real multi-user load: bots
      // scattered freely eventually touch every tile, which measures the dense
      // case no matter how few users there are. CLUSTERS=0 (default) keeps the
      // original free-roam behaviour.
      const CLUSTERS = Number(__ENV.CLUSTERS || 0);
      let homeX, homeY;
      if (CLUSTERS > 0) {
        // Deterministic per-VU assignment so a rerun paints the same areas.
        const idx = (__VU - 1) % CLUSTERS;
        const cols = Math.ceil(Math.sqrt(CLUSTERS));
        const rows = Math.ceil(CLUSTERS / cols);
        const cx = (idx % cols) + 0.5, cy = Math.floor(idx / cols) + 0.5;
        homeX = (cx / cols) * BOARD_WIDTH;
        homeY = (cy / rows) * BOARD_HEIGHT;
        homeX = Math.max(margin + REGION_SIZE / 2, Math.min(BOARD_WIDTH - margin - REGION_SIZE / 2, homeX));
        homeY = Math.max(margin + REGION_SIZE / 2, Math.min(BOARD_HEIGHT - margin - REGION_SIZE / 2, homeY));
      } else {
        homeX = Math.random() * (BOARD_WIDTH - REGION_SIZE - 2 * margin) + margin + REGION_SIZE / 2;
        homeY = Math.random() * (BOARD_HEIGHT - REGION_SIZE - 2 * margin) + margin + REGION_SIZE / 2;
      }

      let x = homeX, y = homeY, dx = 0, dy = 0;
      let state = 0;
      let stateTicks = 0, cycleLength = 0;
      let currentTool = Tool.BRUSH;
      let strokesRemaining = 0;
      let idleTicks = 0;
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
          if (idleTicks < 10 + Math.floor(Math.random() * 20)) return;
          idleTicks = 0;

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
            } catch (_) {}
            return;
          }

          strokesRemaining = randInt(STROKE_COUNT[0], STROKE_COUNT[1]);
          currentTool = pick(TOOL_POOL);

          configureTool(socket, sessionIndex, currentTool, {
            color: randColor(),
            size: randInt(500, 3000),
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
      }, 12);
    });

    socket.on('binaryMessage', function (data) {
      const { t, u, ts } = parseInbound(data);
      if (t === 0 && u !== -1 && sessionIndex === -1) sessionIndex = u;
      if (ts !== -1 && u !== sessionIndex) broadcastLatency.add(Date.now() - ts);
    });

    socket.on('error', (e) => console.log('WebSocket Error: ', e.error()));
    socket.setTimeout(() => socket.close(), 115000);
  });

  check(res, { 'Connected': (r) => r && r.status === 101 });
}
