/**
 * @fileoverview k6 feeder for the .ddraw replay-parity flow.
 *
 * Unlike the general stress tests, this feeder deliberately sticks to
 * RENDER-DETERMINISTIC tools (brush, pen, line, rectangle, circle). It avoids
 * confetti / pattern / GIMP brushes that consume Math.random at *render* time,
 * because the parity check downstream compares a live observer's canvas against
 * a replay of that same observer's recording — any render-time RNG would make
 * the two diverge for reasons unrelated to the .ddraw round-trip.
 *
 * Each VU joins the room given by ROOM, performs STROKES coherent strokes of a
 * randomly-picked deterministic tool, then disconnects. The orchestrator
 * (k6_ddraw_parity.mjs) records the whole session from an in-room browser tab.
 *
 * Env:
 *   ROOM        room name to join          (default: ddraw_feed)
 *   TARGET_URL  ws base url                 (default: ws://127.0.0.1:8030)
 *   VUS         virtual users              (default: 3)
 *   STROKES     strokes per VU             (default: 6)
 *   STEP_MS     ms between wire messages   (default: 40)
 *   LIFETIME_MS hold the socket open this long so an observer can snapshot the
 *               canvas WHILE we are still a registered user — remote draws only
 *               render for users currently in app.users  (default: 9000)
 *   WARMUP_MS   wait after learning our session index before drawing, so the
 *               observer has processed the USERS broadcast that registers us
 *               (otherwise our first MD lands on an unknown user and is dropped)
 *               (default: 800)
 */

import ws from 'k6/ws';
import { buildMsg } from '../_k6_proto.js';
import {
  T, Tool, pick, randInt, randColor,
} from '../_k6_actions.js';

const VUS         = parseInt(__ENV.VUS         || '3', 10);
const STROKES     = parseInt(__ENV.STROKES     || '6', 10);
const STEP_MS     = parseInt(__ENV.STEP_MS     || '40', 10);
const LIFETIME_MS = parseInt(__ENV.LIFETIME_MS || '9000', 10);
const WARMUP_MS   = parseInt(__ENV.WARMUP_MS   || '800', 10);
// Optional knobs to isolate render-divergence sources:
//   TOOLS=line,rectangle,circle  → restrict to these tools
//   HARDNESS=100                 → fixed brush hardness instead of random
const TOOLS_ENV   = (__ENV.TOOLS || '').trim();
const HARDNESS_ENV = __ENV.HARDNESS ? parseInt(__ENV.HARDNESS, 10) : null;

export const options = {
  vus: VUS,
  iterations: VUS, // one pass per VU
};

// Render-deterministic tools only.
const TOOL_BY_NAME = {
  brush: Tool.BRUSH, pen: Tool.PEN, line: Tool.LINE,
  rectangle: Tool.RECTANGLE, circle: Tool.CIRCLE,
};
const DET_TOOLS = TOOLS_ENV
  ? TOOLS_ENV.split(',').map((n) => TOOL_BY_NAME[n.trim()]).filter((v) => v !== undefined)
  : [Tool.BRUSH, Tool.PEN, Tool.LINE, Tool.RECTANGLE, Tool.CIRCLE];
const SHAPE_TOOLS = new Set([Tool.LINE, Tool.RECTANGLE, Tool.CIRCLE]);

const BOARD_W = 1920, BOARD_H = 1080;
const REGION = 360, MARGIN = 80;

export default function () {
  const room    = __ENV.ROOM || 'ddraw_feed';
  const baseUrl = __ENV.TARGET_URL || 'ws://127.0.0.1:8030';
  const url = `${baseUrl}/?room=${room}`;

  let sessionIndex = -1;

  // Each VU owns a home region so strokes are spread out (overlap would still
  // be valid for parity, just visually muddier in saved screenshots).
  const cols = Math.ceil(Math.sqrt(VUS));
  const col = (__VU - 1) % cols;
  const row = Math.floor((__VU - 1) / cols);
  const homeX = MARGIN + REGION / 2 + col * (REGION + 20);
  const homeY = MARGIN + REGION / 2 + row * (REGION + 20);

  function clampX(x) { return Math.max(MARGIN, Math.min(BOARD_W - MARGIN, x)); }
  function clampY(y) { return Math.max(MARGIN, Math.min(BOARD_H - MARGIN, y)); }

  // Build a flat queue of "wire steps". Each entry is a buildMsg() fields obj.
  function buildSteps(u) {
    const steps = [];
    for (let s = 0; s < STROKES; s++) {
      const tool = pick(DET_TOOLS);
      const color = randColor();
      const size = randInt(800, 3000);          // ×100 wire units → 8–30 px
      // Tool/colour/size config.
      steps.push({ t: T.CT, u, l: tool });
      steps.push({ t: T.CC, u, c: color });
      steps.push({ t: T.CS, u, s: size });
      steps.push({ t: T.CHD, u, hd: HARDNESS_ENV ?? randInt(40, 100) });
      steps.push({ t: T.CSP, u, sp: randInt(150, 400) });

      // Stroke geometry inside the VU home region.
      const sx = clampX(homeX + randInt(-REGION / 3, REGION / 3));
      const sy = clampY(homeY + randInt(-REGION / 3, REGION / 3));
      steps.push({ t: T.MD, u, ps: [sx, sy] });

      if (SHAPE_TOOLS.has(tool)) {
        // Shapes need a single drag to the opposite corner/end.
        const ex = clampX(sx + randInt(-REGION / 2, REGION / 2));
        const ey = clampY(sy + randInt(-REGION / 2, REGION / 2));
        steps.push({ t: T.MM, u, ps: [ex, ey], stroke_ts: 1 });
        steps.push({ t: T.MM, u, ps: [ex, ey] });
      } else {
        // Freehand: a short polyline of moves.
        const segs = randInt(4, 8);
        let cx = sx, cy = sy;
        for (let k = 0; k < segs; k++) {
          cx = clampX(cx + randInt(-70, 70));
          cy = clampY(cy + randInt(-70, 70));
          const m = { t: T.MM, u, ps: [cx, cy] };
          if (k === 0) m.stroke_ts = 1;
          steps.push(m);
        }
      }
      steps.push({ t: T.MU, u });
    }
    return steps;
  }

  const res = ws.connect(url, {}, function (socket) {
    let steps = null;
    let i = 0;
    let warmupAt = 0;        // wall time after which we may start drawing
    let cursorSent = false;

    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `FEED_${__VU}` }));

      socket.setInterval(function () {
        if (sessionIndex === -1) return;
        // Once we know our index, set the warm-up deadline and announce a cursor
        // so the observer treats us as a fully-present user before we draw.
        if (!warmupAt) {
          warmupAt = Date.now() + WARMUP_MS;
          return;
        }
        if (!cursorSent) {
          socket.sendBinary(buildMsg({ t: T.SHOW_CURSOR, u: sessionIndex }));
          cursorSent = true;
        }
        if (Date.now() < warmupAt) return;

        if (!steps) steps = buildSteps(sessionIndex);
        // Drawing finished: hold the connection open (LIFETIME timeout closes
        // it) so the orchestrator can snapshot while we are still registered.
        if (i >= steps.length) return;
        const step = steps[i++];
        // stroke_ts marker → real timestamp so commit fingerprints are unique.
        if (step.stroke_ts === 1) step.stroke_ts = Date.now();
        socket.sendBinary(buildMsg(step));
      }, STEP_MS);
    });

    socket.on('binaryMessage', function (data) {
      const view = new Uint8Array(data);
      // Minimal parse: find t (field 1) and u (field 2) to learn our index.
      let off = 0, t = 0, u = -1;
      while (off < view.length) {
        let tag = 0, sh = 0;
        while (true) { const b = view[off++]; tag += (b & 0x7f) * Math.pow(2, sh); if (!(b & 0x80)) break; sh += 7; }
        const fn = tag >> 3, wt = tag & 7;
        if (fn === 1) { let v = 0, s = 0; while (true) { const b = view[off++]; v += (b & 0x7f) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; } t = v; }
        else if (fn === 2) { let v = 0, s = 0; while (true) { const b = view[off++]; v += (b & 0x7f) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; } u = v; }
        else if (wt === 0) { while (view[off++] & 0x80); }
        else if (wt === 1) { off += 8; }
        else if (wt === 2) { let l = 0, s = 0; while (true) { const b = view[off++]; l += (b & 0x7f) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; } off += l; }
        else if (wt === 5) { off += 4; }
      }
      if (t === T.CONNECT && u !== -1 && sessionIndex === -1) sessionIndex = u;
    });

    socket.on('error', (e) => { if (e && e.error && e.error() !== 'websocket: close sent') console.log('WS err', e.error()); });

    // Hold the connection open for LIFETIME_MS so an observer can snapshot the
    // canvas while we are still a registered user, then disconnect cleanly.
    socket.setTimeout(function () { socket.close(); }, LIFETIME_MS);
  });
}
