/**
 * @fileoverview K6 stress test focused on the selection pipeline. Bots
 * interleave drawing strokes with selection sequences so the SELECT tool
 * is not dominant — selections are exercised between bouts of normal
 * drawing the way a real user would use them.
 *
 * Selection sequences cover:
 *   - Rect (marquee) AND lasso (freehand polygon) lifts
 *   - Translation-only moves (corners stay rectangular)
 *   - Perspective transforms via the 4-corner `cr` field (homography)
 *   - SEL_FLIP mid-sequence
 *   - Outcomes: commit / stamp+commit / fill+commit / delete / cancel
 *
 * Floodfill (the bucket tool) only ever fires at positions the bot has
 * actually drawn on, never on transparent canvas.
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { buildMsg } from './_k6_proto.js';
import {
  T, Tool, COMMON_COLORS, BLEND_MODES,
  pick, randInt, randColor,
  configureTool, sendMove, sendDown, sendUp,
  sendSelLift, sendSelMove, sendSelCommit, sendSelCancel,
  sendSelDelete, sendSelFill, sendSelStamp, sendSelFlip,
  applyFloodFill,
  parseInbound,
} from './_k6_actions.js';

const broadcastLatency = new Trend('broadcast_latency_selection');

export const options = {
  vus: 4,
  duration: '2m',
};

// 12 ms scheduler -> ~83 TPS.
const TICKS_PER_SEC = 83;
const WARMUP_TICKS  = 12 * TICKS_PER_SEC;

// What does the bot do next when idle? Skewed toward drawing so SELECT
// is one tool among many, not the default mode.
const ACTIONS = [
  'draw',     'draw',     'draw',
  'select',
  'floodfill',
];

// Drawing tools used when the action is 'draw'. SELECT, FLOODFILL, TEXT,
// INKDROPPER are deliberately omitted — each has its own action path.
const DRAW_TOOLS = [
  Tool.BRUSH, Tool.PEN, Tool.LINE, Tool.RECTANGLE, Tool.CIRCLE,
  Tool.INK, Tool.PIXEL, Tool.CONFETTI,
];

const SEL_SHAPES   = ['rect', 'lasso'];
const SEL_MOTIONS  = ['move', 'transform', 'transformFlip'];
const SEL_OUTCOMES = ['commit', 'stamp', 'fill', 'delete', 'cancel'];

const PHASE = {
  WARMUP_START:   0,
  WARMUP_DRAW:    1,
  WARMUP_BETWEEN: 2,
  PICK_ACTION:    10,
  DRAW_START:     11,
  DRAW_STROKE:    12,
  DRAW_BETWEEN:   13,
  SEL_LIFT:       20,
  SEL_HOLD:       21,
  SEL_MOVING:     22,
  SEL_FLIP_PAUSE: 23,
  SEL_OUTCOME:    24,
  SEL_POSTPAUSE:  25,
  FILL_FIRE:      30,
  POSTACT:        40,
};

export default function () {
  sleep(Math.random() * 1.5);

  const room = __ENV.ROOM || 'test';
  const baseUrl = __ENV.TARGET_URL || 'ws://127.0.0.1:8030';
  const url = `${baseUrl}/?room=${room}`;

  let sessionIndex = -1;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `SEL_VU_${__VU}` }));

      const BOARD_W = 1920, BOARD_H = 1080;
      const REGION = 360, margin = 120;

      const homeX = Math.random() * (BOARD_W - REGION - 2 * margin) + margin + REGION / 2;
      const homeY = Math.random() * (BOARD_H - REGION - 2 * margin) + margin + REGION / 2;

      let x = homeX, y = homeY;
      let dx = (Math.random() - 0.5) * 8;
      let dy = (Math.random() - 0.5) * 8;

      let phase = PHASE.WARMUP_START;
      let phaseTicks = 0;
      let totalTicks = 0;

      // Drawing state
      let drawTool = Tool.BRUSH;
      let strokeLength = 0;
      let strokeTicks = 0;
      let strokesRemaining = 0;
      let strokeBreak = 0;
      // Track last drawn position so floodfill can target real pixels only.
      const drawnPoints = [];
      function recordDrawn(px, py) {
        drawnPoints.push({ x: px, y: py });
        if (drawnPoints.length > 64) drawnPoints.shift();
      }

      // Selection state
      let selShape = 'rect';
      let selMotion = 'transform';
      let selOutcome = 'commit';
      let curRect = null;
      let lassoPath = null;
      let liftCorners = null;
      let targetCorners = null;
      let flipped = false;
      let moveTicks = 0;
      let moveDuration = 0;

      function clampX(v) { return Math.max(margin, Math.min(BOARD_W - margin, v)); }
      function clampY(v) { return Math.max(margin, Math.min(BOARD_H - margin, v)); }

      function clampToHome(v, axis) {
        const home = axis === 'x' ? homeX : homeY;
        const dist = v - home;
        if (Math.abs(dist) > REGION / 2) v = home + Math.sign(dist) * REGION / 2;
        return axis === 'x' ? clampX(v) : clampY(v);
      }

      function newStroke() {
        strokeLength = randInt(28, 80);
        strokeTicks = 0;
        sendDown(socket, sessionIndex, x, y);
        recordDrawn(x, y);
      }

      function pickDrawTool() {
        drawTool = pick(DRAW_TOOLS);
        configureTool(socket, sessionIndex, drawTool, {
          color: pick(COMMON_COLORS),
          size: randInt(700, 2400),
          hardness: 100,
        });
      }

      function generateLassoPath(rect) {
        // Generate a closed irregular polygon roughly bounded by rect.
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        const rx = rect.width / 2;
        const ry = rect.height / 2;
        const sides = randInt(8, 14);
        const pts = [];
        for (let i = 0; i < sides; i++) {
          const ang = (i / sides) * Math.PI * 2 + (Math.random() - 0.5) * 0.25;
          const jitter = 0.75 + Math.random() * 0.35;
          pts.push(cx + Math.cos(ang) * rx * jitter);
          pts.push(cy + Math.sin(ang) * ry * jitter);
        }
        return pts;
      }

      function pickSelection() {
        selShape = pick(SEL_SHAPES);
        selMotion = pick(SEL_MOTIONS);
        selOutcome = pick(SEL_OUTCOMES);

        const w = randInt(140, Math.floor(REGION * 0.7));
        const h = randInt(140, Math.floor(REGION * 0.7));
        const rx = homeX - REGION / 2 + Math.random() * (REGION - w);
        const ry = homeY - REGION / 2 + Math.random() * (REGION - h);
        curRect = { x: rx, y: ry, width: w, height: h };

        lassoPath = selShape === 'lasso' ? generateLassoPath(curRect) : null;

        liftCorners = {
          tl: { x: rx,       y: ry        },
          tr: { x: rx + w,   y: ry        },
          br: { x: rx + w,   y: ry + h    },
          bl: { x: rx,       y: ry + h    },
        };

        const tx = (Math.random() - 0.5) * 220;
        const ty = (Math.random() - 0.5) * 140;

        if (selMotion === 'move') {
          // Pure translation — corners stay rectangular, no perspective distortion.
          targetCorners = {
            tl: { x: liftCorners.tl.x + tx, y: liftCorners.tl.y + ty },
            tr: { x: liftCorners.tr.x + tx, y: liftCorners.tr.y + ty },
            br: { x: liftCorners.br.x + tx, y: liftCorners.br.y + ty },
            bl: { x: liftCorners.bl.x + tx, y: liftCorners.bl.y + ty },
          };
        } else {
          // 'transform' / 'transformFlip' — distort the corners (perspective warp).
          const shrinkRight = 0.55 + Math.random() * 0.4;
          const skewTop     = (Math.random() - 0.5) * 60;
          const skewBottom  = (Math.random() - 0.5) * 60;
          targetCorners = {
            tl: { x: liftCorners.tl.x + tx,             y: liftCorners.tl.y + ty + skewTop    },
            tr: { x: liftCorners.tr.x + tx,             y: liftCorners.tr.y + ty + skewTop    + h * (1 - shrinkRight) * 0.5 },
            br: { x: liftCorners.br.x + tx,             y: liftCorners.br.y + ty + skewBottom - h * (1 - shrinkRight) * 0.5 },
            bl: { x: liftCorners.bl.x + tx,             y: liftCorners.bl.y + ty + skewBottom },
          };
        }

        moveDuration = randInt(28, 60);
        moveTicks = 0;
        flipped = false;
      }

      function lerpCorners(a, b, t) {
        return {
          tl: { x: a.tl.x + (b.tl.x - a.tl.x) * t, y: a.tl.y + (b.tl.y - a.tl.y) * t },
          tr: { x: a.tr.x + (b.tr.x - a.tr.x) * t, y: a.tr.y + (b.tr.y - a.tr.y) * t },
          br: { x: a.br.x + (b.br.x - a.br.x) * t, y: a.br.y + (b.br.y - a.br.y) * t },
          bl: { x: a.bl.x + (b.bl.x - a.bl.x) * t, y: a.bl.y + (b.bl.y - a.bl.y) * t },
        };
      }

      socket.setInterval(function () {
        if (sessionIndex === -1) return;
        totalTicks++;
        phaseTicks++;

        // ===== Warmup: brush scribbles for ~12s so selections have content =====
        if (phase === PHASE.WARMUP_START) {
          drawTool = Tool.BRUSH;
          configureTool(socket, sessionIndex, drawTool, {
            color: pick(COMMON_COLORS), size: randInt(800, 2500), hardness: 100,
          });
          sendMove(socket, sessionIndex, x, y);
          phase = PHASE.WARMUP_DRAW;
          phaseTicks = 0;
          newStroke();
          return;
        }

        if (phase === PHASE.WARMUP_DRAW || phase === PHASE.WARMUP_BETWEEN) {
          dx += (Math.random() - 0.5) * 3;
          dy += (Math.random() - 0.5) * 3;
          dx = Math.max(-12, Math.min(12, dx));
          dy = Math.max(-12, Math.min(12, dy));
          x = clampToHome(x + dx, 'x'); y = clampToHome(y + dy, 'y');

          if (phase === PHASE.WARMUP_DRAW) {
            strokeTicks++;
            sendMove(socket, sessionIndex, x, y, true);
            recordDrawn(x, y);
            if (strokeTicks >= strokeLength) {
              sendUp(socket, sessionIndex);
              phase = PHASE.WARMUP_BETWEEN;
              phaseTicks = 0;
              strokeBreak = randInt(5, 14);
              if (Math.random() < 0.5) {
                configureTool(socket, sessionIndex, Tool.BRUSH, {
                  color: pick(COMMON_COLORS), size: randInt(700, 2400), hardness: 100,
                });
              }
            }
          } else if (phaseTicks >= strokeBreak) {
            if (totalTicks >= WARMUP_TICKS) {
              phase = PHASE.PICK_ACTION;
              phaseTicks = 0;
              return;
            }
            phase = PHASE.WARMUP_DRAW;
            phaseTicks = 0;
            newStroke();
          }
          return;
        }

        // ===== Action dispatcher =====
        if (phase === PHASE.PICK_ACTION) {
          const action = pick(ACTIONS);
          if (action === 'draw') {
            pickDrawTool();
            strokesRemaining = randInt(2, 5);
            phase = PHASE.DRAW_START;
            phaseTicks = 0;
          } else if (action === 'select') {
            configureTool(socket, sessionIndex, Tool.SELECT, {
              color: pick(COMMON_COLORS), size: 500,
            });
            pickSelection();
            phase = PHASE.SEL_LIFT;
            phaseTicks = 0;
          } else if (action === 'floodfill') {
            if (drawnPoints.length === 0) {
              // No drawn pixels yet — skip and pick again.
              phase = PHASE.PICK_ACTION;
              phaseTicks = 0;
              return;
            }
            configureTool(socket, sessionIndex, Tool.FLOODFILL, {
              color: pick(COMMON_COLORS), size: 500,
            });
            phase = PHASE.FILL_FIRE;
            phaseTicks = 0;
          }
          return;
        }

        // ===== Draw: a few strokes with the chosen tool =====
        if (phase === PHASE.DRAW_START) {
          newStroke();
          phase = PHASE.DRAW_STROKE;
          phaseTicks = 0;
          return;
        }

        if (phase === PHASE.DRAW_STROKE || phase === PHASE.DRAW_BETWEEN) {
          dx += (Math.random() - 0.5) * 3;
          dy += (Math.random() - 0.5) * 3;
          dx = Math.max(-12, Math.min(12, dx));
          dy = Math.max(-12, Math.min(12, dy));
          x = clampToHome(x + dx, 'x'); y = clampToHome(y + dy, 'y');

          if (phase === PHASE.DRAW_STROKE) {
            strokeTicks++;
            sendMove(socket, sessionIndex, x, y, true);
            recordDrawn(x, y);
            if (strokeTicks >= strokeLength) {
              sendUp(socket, sessionIndex);
              strokesRemaining--;
              if (strokesRemaining <= 0) {
                phase = PHASE.POSTACT;
                phaseTicks = 0;
              } else {
                phase = PHASE.DRAW_BETWEEN;
                phaseTicks = 0;
                strokeBreak = randInt(4, 12);
              }
            }
          } else if (phaseTicks >= strokeBreak) {
            phase = PHASE.DRAW_START;
            phaseTicks = 0;
          }
          return;
        }

        // ===== Floodfill: hit only a previously drawn pixel =====
        if (phase === PHASE.FILL_FIRE) {
          const target = drawnPoints[Math.floor(Math.random() * drawnPoints.length)];
          applyFloodFill(socket, sessionIndex, target.x, target.y, randColor());
          phase = PHASE.POSTACT;
          phaseTicks = 0;
          return;
        }

        // ===== Selection sequence =====
        if (phase === PHASE.SEL_LIFT) {
          if (phaseTicks === 1) {
            sendSelLift(socket, sessionIndex, curRect, { lassoPath });
          }
          if (phaseTicks >= 20) {
            phase = PHASE.SEL_HOLD;
            phaseTicks = 0;
          }
          return;
        }

        if (phase === PHASE.SEL_HOLD) {
          if (phaseTicks >= 12) {
            phase = PHASE.SEL_MOVING;
            phaseTicks = 0;
            moveTicks = 0;
          }
          return;
        }

        if (phase === PHASE.SEL_MOVING) {
          moveTicks++;
          const t = Math.min(1, moveTicks / moveDuration);
          const eased = 1 - Math.pow(1 - t, 3);
          const cur = lerpCorners(liftCorners, targetCorners, eased);
          sendSelMove(socket, sessionIndex, cur, {
            sourceCrop: { x: curRect.x, y: curRect.y, width: curRect.width, height: curRect.height },
          });

          if (selMotion === 'transformFlip' && !flipped && moveTicks >= Math.floor(moveDuration / 2)) {
            sendSelFlip(socket, sessionIndex);
            flipped = true;
            phase = PHASE.SEL_FLIP_PAUSE;
            phaseTicks = 0;
            return;
          }
          if (moveTicks >= moveDuration) {
            phase = PHASE.SEL_OUTCOME;
            phaseTicks = 0;
          }
          return;
        }

        if (phase === PHASE.SEL_FLIP_PAUSE) {
          if (phaseTicks >= 12) {
            phase = PHASE.SEL_MOVING;
            phaseTicks = 0;
          }
          return;
        }

        if (phase === PHASE.SEL_OUTCOME) {
          if (selOutcome === 'commit') {
            sendSelCommit(socket, sessionIndex);
          } else if (selOutcome === 'stamp') {
            sendSelStamp(socket, sessionIndex);
            sendSelCommit(socket, sessionIndex);
          } else if (selOutcome === 'fill') {
            sendSelFill(socket, sessionIndex, randColor());
            sendSelCommit(socket, sessionIndex);
          } else if (selOutcome === 'delete') {
            sendSelDelete(socket, sessionIndex);
          } else if (selOutcome === 'cancel') {
            sendSelCancel(socket, sessionIndex);
          }
          phase = PHASE.SEL_POSTPAUSE;
          phaseTicks = 0;
          return;
        }

        if (phase === PHASE.SEL_POSTPAUSE) {
          if (phaseTicks >= randInt(30, 70)) {
            phase = PHASE.POSTACT;
            phaseTicks = 0;
          }
          return;
        }

        if (phase === PHASE.POSTACT) {
          if (phaseTicks >= randInt(10, 25)) {
            phase = PHASE.PICK_ACTION;
            phaseTicks = 0;
          }
          return;
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
