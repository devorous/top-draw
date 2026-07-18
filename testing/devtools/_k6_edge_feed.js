/**
 * @fileoverview Scenario-driven k6 feeder for the multi-user replay edge-case
 * suite (replay_multiuser_edge_suite.mjs).
 *
 * Like _k6_ddraw_feed.js this sticks to RENDER-DETERMINISTIC tools so an
 * observer's live canvas and a replay of that same observer's recording can be
 * compared pixel-for-pixel: a HARD brush (hardness=100, no feathered edge) plus
 * the geometric shapes (line/rectangle/circle). It deliberately avoids soft
 * brushes, pen/stamp opacity buildup, confetti and pattern brushes — all of
 * which consume Math.random at render time and produce the known ~95–99%
 * observer-replay divergence (see memory: k6_ddraw_replay_parity).
 *
 * k6's OWN randomness (which strokes, where) is fine: parity compares a tape
 * against a replay of that same tape, so the feed content can vary run to run.
 *
 * SCENARIO env selects the traffic shape:
 *   baseline           N strokes/VU, all hold the socket open.
 *   clear              Two waves of strokes with a deliberate CLEAR_GAP_MS idle
 *                      gap between them, during which the orchestrator injects a
 *                      CLR into every observer tab while no stroke is in flight
 *                      (a stroke landing mid-injection would desync the tabs).
 *   join_leave         Staggered joins (some VUs sleep before connecting) +
 *                      early disconnects (some VUs close right after drawing),
 *                      while a "stayer" VU holds the socket open. Exercises the
 *                      recorder taping users that come and go.
 *   undo_redo          N brush strokes/VU, then UNDO the last few and REDO one,
 *                      so the final canvas reflects net history.
 *   selection_blend    Base strokes, then CBM blend-mode strokes (multiply /
 *                      screen), then a SEL_LIFT → SEL_MOVE (translate) →
 *                      SEL_COMMIT transform over the VU's own region.
 *   mixed_tools        Full tool-state churn per VU: brush/shapes, an eraser
 *                      pass, multiply/screen blend strokes, one flood fill
 *                      (VU 1), a pixel-text stamp, and a selection translate.
 *                      Built for mid-flood JOIN testing (join_timing_suite).
 *
 * Env:
 *   ROOM         room to join                 (default: edge_feed)
 *   TARGET_URL   ws base url                  (default: ws://127.0.0.1:8030)
 *   VUS          virtual users               (default: 3)
 *   STROKES      base strokes per VU         (default: 5)
 *   SCENARIO     see above                   (default: baseline)
 *   STEP_MS      ms between wire messages    (default: 40)
 *   LIFETIME_MS  how long stayers hold open  (default: 16000)
 *   WARMUP_MS    wait after learning index   (default: 800)
 *   LEAVE_HOLD_MS  leavers hold this long after drawing before closing (default 1500)
 *   LATE_JOIN_MS   late VUs sleep this long before connecting (default 3000)
 */

import ws from 'k6/ws';
import { sleep } from 'k6';
import { buildMsg } from '../_k6_proto.js';
import { T, Tool, pick, randInt, randColor } from '../_k6_actions.js';

const VUS          = parseInt(__ENV.VUS          || '3', 10);
const STROKES      = parseInt(__ENV.STROKES      || '5', 10);
const SCENARIO     = (__ENV.SCENARIO || 'baseline').trim();
const STEP_MS      = parseInt(__ENV.STEP_MS      || '40', 10);
const LIFETIME_MS  = parseInt(__ENV.LIFETIME_MS  || '16000', 10);
const WARMUP_MS    = parseInt(__ENV.WARMUP_MS    || '800', 10);
const LEAVE_HOLD_MS = parseInt(__ENV.LEAVE_HOLD_MS || '1500', 10);
const LATE_JOIN_MS = parseInt(__ENV.LATE_JOIN_MS || '3000', 10);
const CLEAR_GAP_MS = parseInt(__ENV.CLEAR_GAP_MS || '4000', 10);

export const options = {
  vus: VUS,
  iterations: VUS, // one pass per VU
};

const SHAPE_TOOLS = [Tool.LINE, Tool.RECTANGLE, Tool.CIRCLE];
const MIXED_TOOLS = [Tool.BRUSH, Tool.LINE, Tool.RECTANGLE, Tool.CIRCLE];
const SHAPE_SET = new Set(SHAPE_TOOLS);

const BOARD_W = 1920, BOARD_H = 1080;
const REGION = 360, MARGIN = 80;

export default function () {
  const room    = __ENV.ROOM || 'edge_feed';
  const baseUrl = __ENV.TARGET_URL || 'ws://127.0.0.1:8030';
  const url = `${baseUrl}/?room=${room}`;

  // ── Per-VU role within the scenario ──────────────────────────────────────
  // join_leave: VU 1 stays for the whole session; even VUs leave early; every
  // third VU joins late (sleeps before connecting).
  const isStayer = __VU === 1;
  const isLeaver = SCENARIO === 'join_leave' && !isStayer && (__VU % 2 === 0);
  const isLate   = SCENARIO === 'join_leave' && !isStayer && (__VU % 3 === 0);

  if (isLate) sleep(LATE_JOIN_MS / 1000);

  let sessionIndex = -1;

  // Each VU owns a home region so strokes are spread out.
  const cols = Math.ceil(Math.sqrt(VUS));
  const col = (__VU - 1) % cols;
  const row = Math.floor((__VU - 1) / cols);
  const homeX = MARGIN + REGION / 2 + col * (REGION + 20);
  const homeY = MARGIN + REGION / 2 + row * (REGION + 20);

  const clampX = (x) => Math.max(MARGIN, Math.min(BOARD_W - MARGIN, x));
  const clampY = (y) => Math.max(MARGIN, Math.min(BOARD_H - MARGIN, y));

  // ── Build one render-deterministic stroke (config + geometry steps) ──────
  // `blendMode` (optional) emits a CBM before the stroke. `forceBrush` keeps the
  // tool a hard brush (needed so undo/selection have real pixels in a region).
  function strokeSteps(u, { blendMode, forceBrush } = {}) {
    const steps = [];
    const tool = forceBrush ? Tool.BRUSH : pick(MIXED_TOOLS);
    steps.push({ t: T.CT, u, l: tool });
    steps.push({ t: T.CC, u, c: randColor() });
    steps.push({ t: T.CS, u, s: randInt(1200, 3000) });   // 12–30 px
    steps.push({ t: T.CHD, u, hd: 100 });                  // HARD edge → deterministic
    steps.push({ t: T.CSM, u, sm: 0 });
    steps.push({ t: T.CSP, u, sp: 200 });
    if (blendMode !== undefined) steps.push({ t: T.CBM, u, bm: blendMode });

    const sx = clampX(homeX + randInt(-REGION / 3, REGION / 3));
    const sy = clampY(homeY + randInt(-REGION / 3, REGION / 3));
    // Blend mode must ride ON the MD, like real clients (broadcastMouseDown):
    // the server sanitizes MD.bm even when absent (proto3 default '' →
    // 'source-over'), and handleMouseDown applies MD.bm over any prior CBM —
    // a CBM alone is silently clobbered back to source-over at mousedown.
    const md = { t: T.MD, u, ps: [sx, sy] };
    if (blendMode !== undefined) md.bm = blendMode;
    steps.push(md);

    if (!forceBrush && SHAPE_SET.has(tool)) {
      const ex = clampX(sx + randInt(-REGION / 2, REGION / 2));
      const ey = clampY(sy + randInt(-REGION / 2, REGION / 2));
      steps.push({ t: T.MM, u, ps: [ex, ey], stroke_ts: 1 });
      steps.push({ t: T.MM, u, ps: [ex, ey] });
    } else {
      const segs = randInt(4, 7);
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
    return steps;
  }

  // ── Compose the full per-VU step queue for the chosen scenario ───────────
  function buildSteps(u) {
    const steps = [];

    if (SCENARIO === 'undo_redo') {
      // INTERLEAVED undo/redo: weave UNDO/REDO between strokes so the live
      // strokeStack grows and shrinks throughout the recorded tape (not
      // draw-all-then-undo). The replay must re-apply each undo/redo at its
      // point in the timeline and land on the same pixels.
      for (let s = 0; s < STROKES; s++) {
        steps.push(...strokeSteps(u, { forceBrush: true }));
        if (s % 2 === 1) steps.push({ t: T.UNDO, u });   // undo after every 2nd stroke
        if (s % 3 === 2) steps.push({ t: T.REDO, u });   // occasionally redo it back
      }
      // Trailing churn: undo two, redo one.
      steps.push({ t: T.UNDO, u });
      steps.push({ t: T.UNDO, u });
      steps.push({ t: T.REDO, u });
      return steps;
    }

    if (SCENARIO === 'selection_blend') {
      // Base strokes (source-over).
      for (let s = 0; s < 2; s++) steps.push(...strokeSteps(u, { forceBrush: true }));
      // Blended strokes.
      steps.push(...strokeSteps(u, { forceBrush: true, blendMode: 'multiply' }));
      steps.push(...strokeSteps(u, { forceBrush: true, blendMode: 'screen' }));
      // Back to normal, then a selection translate over the home region.
      steps.push({ t: T.CBM, u, bm: 'source-over' });
      steps.push({ t: T.CT, u, l: Tool.SELECT });
      const rx = Math.round(clampX(homeX - REGION / 3));
      const ry = Math.round(clampY(homeY - REGION / 3));
      const rw = Math.round(REGION / 2);
      const rh = Math.round(REGION / 2);
      steps.push({ t: T.SEL_LIFT, u, sx: rx, sy: ry, sw: rw, sh: rh });
      // Translate the lifted region by a fixed offset (no perspective warp →
      // render-deterministic).
      const dx = 90, dy = 60;
      steps.push({
        t: T.SEL_MOVE, u,
        cr: [rx + dx, ry + dy, rx + rw + dx, ry + dy, rx + rw + dx, ry + rh + dy, rx + dx, ry + rh + dy],
        cb: [rx, ry, rw, rh],
        cbt: [rx, ry, rw, rh],
      });
      steps.push({ t: T.SEL_COMMIT, u, ly: 0 });
      return steps;
    }

    if (SCENARIO === 'mixed_tools') {
      // Full tool-state churn: brush/shapes, eraser, blend modes, flood fill,
      // pixel text, selection translate. Exercises every per-user config type
      // (CT/CC/CS/CHD/CBM/CF) around a mid-flood join window.
      for (let s = 0; s < 3; s++) steps.push(...strokeSteps(u));
      // Eraser pass across own region (hard destination-out brush).
      steps.push({ t: T.CT, u, l: Tool.ERASE });
      steps.push({ t: T.CS, u, s: randInt(1500, 2500) });
      steps.push({ t: T.CHD, u, hd: 100 });
      const ex = clampX(homeX - REGION / 4), ey = clampY(homeY - REGION / 4);
      steps.push({ t: T.MD, u, ps: [ex, ey] });
      steps.push({ t: T.MM, u, ps: [clampX(ex + 120), clampY(ey + 80)], stroke_ts: 1 });
      steps.push({ t: T.MM, u, ps: [clampX(ex + 200), clampY(ey + 40)] });
      steps.push({ t: T.MU, u });
      // Blended strokes, then back to normal.
      steps.push(...strokeSteps(u, { forceBrush: true, blendMode: 'multiply' }));
      steps.push(...strokeSteps(u, { forceBrush: true, blendMode: 'screen' }));
      steps.push({ t: T.CBM, u, bm: 'source-over' });
      // One background flood fill (VU 1 only — a full-canvas fill per VU would
      // dominate the run). Committed client-side from composited state, so it
      // doubles as a consistency check of everything beneath it.
      if (__VU === 1) {
        steps.push({ t: T.CC, u, c: randColor() });
        // FILL carries its point in sx/sy (not ps — see WebSocketClient T.FILL).
        steps.push({ t: T.FILL, u, sx: Math.round(clampX(homeX)), sy: Math.round(clampY(homeY)) });
      }
      // Pixel text stamp (self-contained TEXT_APPLY carries its font).
      steps.push({ t: T.CF, u, fo: 'Arial', tm: 1.0, to: 0.0 });
      steps.push({
        t: T.TEXT_APPLY, u, g: `EDGE_${u}`, fo: 'Arial',
        ps: [Math.round(clampX(homeX - 60)), Math.round(clampY(homeY + REGION / 4))],
        text_id: `txt_${u}_k6`, text_pixel: 1, text_lifetime_ms: 0, text_fade_ms: 0,
      });
      // Selection translate over the home region.
      steps.push({ t: T.CT, u, l: Tool.SELECT });
      const rx = Math.round(clampX(homeX - REGION / 3));
      const ry = Math.round(clampY(homeY - REGION / 3));
      const rw = Math.round(REGION / 2), rh = Math.round(REGION / 2);
      steps.push({ t: T.SEL_LIFT, u, sx: rx, sy: ry, sw: rw, sh: rh });
      const dx = 70, dy = 50;
      steps.push({
        t: T.SEL_MOVE, u,
        cr: [rx + dx, ry + dy, rx + rw + dx, ry + dy, rx + rw + dx, ry + rh + dy, rx + dx, ry + rh + dy],
        cb: [rx, ry, rw, rh],
        cbt: [rx, ry, rw, rh],
      });
      steps.push({ t: T.SEL_COMMIT, u, ly: 0 });
      // Trailing strokes so a join after the special ops still sees churn.
      for (let s = 0; s < 2; s++) steps.push(...strokeSteps(u));
      return steps;
    }

    if (SCENARIO === 'clear') {
      // Two waves separated by an idle gap. The orchestrator clears every tab
      // during the gap, so wave-1 strokes get wiped and only wave-2 survives —
      // on both the live boards and the replayed tapes.
      const wave1 = Math.ceil(STROKES / 2);
      const wave2 = Math.max(1, STROKES - wave1);
      for (let s = 0; s < wave1; s++) steps.push(...strokeSteps(u));
      steps.push({ pause: CLEAR_GAP_MS });
      for (let s = 0; s < wave2; s++) steps.push(...strokeSteps(u));
      return steps;
    }

    // baseline / join_leave: N mixed deterministic strokes.
    for (let s = 0; s < STROKES; s++) steps.push(...strokeSteps(u));
    return steps;
  }

  ws.connect(url, {}, function (socket) {
    let steps = null;
    let i = 0;
    let warmupAt = 0;
    let cursorSent = false;
    let drewAt = 0;       // wall time the queue finished draining
    let pauseUntil = 0;   // honor {pause} steps (clear scenario idle gap)

    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `EDGE_${__VU}` }));

      socket.setInterval(function () {
        if (sessionIndex === -1) return;
        if (!warmupAt) { warmupAt = Date.now() + WARMUP_MS; return; }
        if (!cursorSent) {
          socket.sendBinary(buildMsg({ t: T.SHOW_CURSOR, u: sessionIndex }));
          cursorSent = true;
        }
        if (Date.now() < warmupAt) return;

        if (!steps) steps = buildSteps(sessionIndex);
        if (Date.now() < pauseUntil) return;

        if (i >= steps.length) {
          // Done drawing. Leavers close shortly after; others idle until LIFETIME.
          if (!drewAt) drewAt = Date.now();
          if (isLeaver && Date.now() - drewAt >= LEAVE_HOLD_MS) socket.close();
          return;
        }
        const step = steps[i++];
        if (step.pause) { pauseUntil = Date.now() + step.pause; return; }
        if (step.stroke_ts === 1) step.stroke_ts = Date.now();
        socket.sendBinary(buildMsg(step));
      }, STEP_MS);
    });

    socket.on('binaryMessage', function (data) {
      const view = new Uint8Array(data);
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

    // Stayers (and all baseline VUs) hold the socket open so the observer can
    // snapshot while they are still registered users.
    socket.setTimeout(function () { socket.close(); }, LIFETIME_MS);
  });
}
