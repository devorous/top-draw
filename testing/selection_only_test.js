/**
 * @fileoverview Selection-only k6 mode for visual verification. After a short
 * warmup that puts paint on the canvas, bots do nothing but selection
 * sequences (rect/lasso lift → translate or perspective-warp → commit/stamp/
 * fill/delete/cancel). Use to confirm that bot selections actually lift
 * and transform real layer pixels.
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { buildMsg } from './_k6_proto.js';
import {
  T, Tool, COMMON_COLORS,
  pick, randInt, randColor,
  configureTool, sendMove, sendDown, sendUp,
  sendSelLift, sendSelMove, sendSelCommit, sendSelCancel,
  sendSelDelete, sendSelFill, sendSelStamp, sendSelFlip,
  parseInbound,
} from './_k6_actions.js';

const broadcastLatency = new Trend('broadcast_latency_sel_only');

export const options = {
  vus: 4,
  duration: '2m',
};

const TICKS_PER_SEC = 83;
const WARMUP_TICKS  = 10 * TICKS_PER_SEC;

const SEL_SHAPES   = ['rect', 'lasso'];
const SEL_MOTIONS  = ['move', 'transform', 'transformFlip'];
const SEL_OUTCOMES = ['commit', 'stamp', 'fill', 'commit', 'commit']; // bias toward commit/stamp/fill so the move is visible

const PHASE = {
  WARMUP_START:   0,
  WARMUP_DRAW:    1,
  WARMUP_BETWEEN: 2,
  PICK_SELECTION: 10,
  SEL_LIFT:       20,
  SEL_HOLD:       21,
  SEL_MOVING:     22,
  SEL_FLIP_PAUSE: 23,
  SEL_OUTCOME:    24,
  SEL_POSTPAUSE:  25,
};

export default function () {
  sleep(Math.random() * 1.5);

  const room = __ENV.ROOM || 'test';
  const baseUrl = __ENV.TARGET_URL || 'ws://127.0.0.1:8030';
  const url = `${baseUrl}/?room=${room}`;

  let sessionIndex = -1;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `SELONLY_VU_${__VU}` }));

      const BOARD_W = 1920, BOARD_H = 1080;
      const REGION = 400, margin = 140;

      const homeX = Math.random() * (BOARD_W - REGION - 2 * margin) + margin + REGION / 2;
      const homeY = Math.random() * (BOARD_H - REGION - 2 * margin) + margin + REGION / 2;

      let x = homeX, y = homeY;
      let dx = (Math.random() - 0.5) * 8;
      let dy = (Math.random() - 0.5) * 8;

      let phase = PHASE.WARMUP_START;
      let phaseTicks = 0;
      let totalTicks = 0;

      let strokeLength = 0;
      let strokeTicks = 0;
      let strokeBreak = 0;

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
        strokeLength = randInt(40, 90);
        strokeTicks = 0;
        sendDown(socket, sessionIndex, x, y);
      }

      function generateLassoPath(rect) {
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

        const w = randInt(160, Math.floor(REGION * 0.75));
        const h = randInt(160, Math.floor(REGION * 0.75));
        const rx = homeX - REGION / 2 + Math.random() * (REGION - w);
        const ry = homeY - REGION / 2 + Math.random() * (REGION - h);
        curRect = { x: rx, y: ry, width: w, height: h };

        lassoPath = selShape === 'lasso' ? generateLassoPath(curRect) : null;

        liftCorners = {
          tl: { x: rx,     y: ry     },
          tr: { x: rx + w, y: ry     },
          br: { x: rx + w, y: ry + h },
          bl: { x: rx,     y: ry + h },
        };

        const tx = (Math.random() - 0.5) * 260;
        const ty = (Math.random() - 0.5) * 180;

        if (selMotion === 'move') {
          targetCorners = {
            tl: { x: liftCorners.tl.x + tx, y: liftCorners.tl.y + ty },
            tr: { x: liftCorners.tr.x + tx, y: liftCorners.tr.y + ty },
            br: { x: liftCorners.br.x + tx, y: liftCorners.br.y + ty },
            bl: { x: liftCorners.bl.x + tx, y: liftCorners.bl.y + ty },
          };
        } else {
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

        // ===== Warmup: BRUSH scribbles for ~10s so selections have content =====
        if (phase === PHASE.WARMUP_START) {
          configureTool(socket, sessionIndex, Tool.BRUSH, {
            color: pick(COMMON_COLORS), size: randInt(900, 2600), hardness: 100,
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
              // Switch to SELECT and never leave it
              configureTool(socket, sessionIndex, Tool.SELECT, {
                color: pick(COMMON_COLORS), size: 500,
              });
              phase = PHASE.PICK_SELECTION;
              phaseTicks = 0;
              return;
            }
            phase = PHASE.WARMUP_DRAW;
            phaseTicks = 0;
            newStroke();
          }
          return;
        }

        // ===== Selection forever after warmup =====
        if (phase === PHASE.PICK_SELECTION) {
          pickSelection();
          phase = PHASE.SEL_LIFT;
          phaseTicks = 0;
          return;
        }

        if (phase === PHASE.SEL_LIFT) {
          if (phaseTicks === 1) {
            sendSelLift(socket, sessionIndex, curRect, { lassoPath });
          }
          if (phaseTicks >= 18) {
            phase = PHASE.SEL_HOLD;
            phaseTicks = 0;
          }
          return;
        }

        if (phase === PHASE.SEL_HOLD) {
          if (phaseTicks >= 10) {
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
          if (phaseTicks >= 10) {
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
          if (phaseTicks >= randInt(40, 80)) {
            phase = PHASE.PICK_SELECTION;
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
