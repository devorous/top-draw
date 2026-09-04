/**
 * @fileoverview Connects N VUs to a room; by default all of them just hold
 * the socket open (no draws, no cursor movement). Set DRAWING_VUS=K to make
 * the first K (by __VU index) draw CONTINUOUSLY for the whole run while the
 * rest stay idle — a fixed, deterministic concurrent-drawer count, unlike the
 * other stress scripts' probabilistic idle/draw state machine where "6 VUs"
 * does not mean "6 people drawing at any given instant".
 *
 * Purpose: build a concurrency CURVE at fixed room size — "13 people in the
 * room, K of them actually drawing right now" — rather than just the two
 * extremes (nobody drawing / everybody drawing continuously). Real rooms sit
 * somewhere in between: people talk, look, pan, think between strokes. Pair
 * with board_perf_suite.mjs (drives one real, local, drawing user):
 *
 *   node testing/devtools/board_perf_suite.mjs --label=k3of13 --size=1440p \
 *     --vus=12 --k6script=testing/idle_users_test.js \
 *     --duration=45s   (set DRAWING_VUS via the script's own env, see below —
 *                        board_perf_suite only forwards ROOM/TARGET_URL/TOOLS,
 *                        so run k6 directly for anything else, or edit the
 *                        DRAWING_VUS default below for a one-off sweep)
 *
 * See lag_measured_1440p_realistic_load / remote_cursor_dom_is_not_the_cost /
 * idle_users_are_free_drawing_is_the_cost for the two extremes this fills in
 * between.
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { buildMsg } from './_k6_proto.js';
import { T, Tool, parseInbound, configureTool, sendDown, sendMoveBatch, sendUp } from './_k6_actions.js';

// _k6_actions.js's T map (shared by every other k6 script here) omits
// PING/PONG — no other script needs to reply to one, since they all close
// well inside the server's ~60s reap window. This one deliberately runs long,
// so it can't skip it. Values match shared/MessageTypes.js.
const PING = 69;
const PONG = 70;

export const options = {
  vus: 8,
  duration: '1m',
};

// First DRAWING_VUS VUs (by __VU index, 1-based) draw continuously; the rest
// stay idle. 0 (default) reproduces the pure-idle script unchanged.
const DRAWING_VUS = Number(__ENV.DRAWING_VUS || 0);
const SIZE = Number(__ENV.SIZE || 24);
const RATE = Number(__ENV.RATE || 16); // ms between MM batches, matches peer_bot's tick-shaped default

export default function () {
  const room = __ENV.ROOM || 'test';
  const baseUrl = __ENV.TARGET_URL || 'ws://127.0.0.1:8030';
  const url = `${baseUrl}/?room=${room}`;
  // Comfortably longer than any --duration this is likely run with (matches
  // low_stress_test's own 55s pattern, scaled up since idle runs are meant to
  // run longer than a 45-60s stress burst).
  const HOLD_MS = Number(__ENV.HOLD_MS || 600000);
  const isDrawer = __VU <= DRAWING_VUS;

  const res = ws.connect(url, {}, function (socket) {
    let u = -1;
    // Drawing state, only used when isDrawer.
    const BOARD_W = 1000, BOARD_H = 900;
    let strokeActive = false;
    let sx = 0, sy = 0, step = 0;

    function startStroke() {
      sx = 60 + Math.random() * (BOARD_W - 120);
      sy = 60 + Math.random() * (BOARD_H - 120);
      step = 0;
      configureTool(socket, u, Tool.BRUSH, { size: SIZE * 100 });
      sendDown(socket, u, sx, sy);
      strokeActive = true;
    }

    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `${isDrawer ? 'DRAW' : 'IDLE'}_VU_${__VU}` }));
    });

    socket.on('binaryMessage', function (data) {
      const { t, u: ackU } = parseInbound(data);
      // Reply to the server's application-level keepalive (T.PING, every 30s).
      // An unanswered bot is reaped after two misses (~60s) mid-run, which
      // looks like the harness quit rather than a protocol timeout — see
      // peer_bot.mjs's note on the same trap.
      if (t === PING) socket.sendBinary(buildMsg({ t: PONG }));
      if (t === 0 && ackU !== -1 && u === -1) {
        u = ackU;
        if (isDrawer) startStroke();
      }
    });

    if (isDrawer) {
      // Continuous stroke loop: a wandering line that never lifts for long —
      // this bot's whole purpose is "always drawing", the deterministic
      // opposite number to idle_users_test's "never drawing". Real per-VU
      // idle/draw cycling already exists in low_stress_test.js et al.; this
      // script is for pinning an EXACT concurrent-drawer count instead.
      socket.setInterval(function () {
        if (u === -1) return;
        if (!strokeActive) { startStroke(); return; }
        step++;
        const x = sx + Math.sin(step / 8) * 220;
        const y = sy + (step * 3) % (BOARD_H - 120);
        sendMoveBatch(socket, u, [x, y]);
        if (step % 60 === 0) { // ~1s of drawing per stroke at RATE=16ms, then a fresh one
          sendUp(socket, u);
          strokeActive = false;
        }
      }, RATE);
    }

    socket.on('error', (e) => console.log('WebSocket Error: ', e.error()));
    socket.setTimeout(() => socket.close(), HOLD_MS);
  });

  check(res, { 'Connected': (r) => r && r.status === 101 });
}
