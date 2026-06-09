/**
 * @fileoverview Confetti-only k6 feeder for verifying cross-client confetti
 * determinism. Each VU selects the confetti tool and draws plain MD/MM/MU
 * strokes with NO transmitted seeds — the exact path the stress bots (and the
 * reported divergence) exercise. With the deterministic position-seed fallback
 * in ConfettiTool.seedFromPos, every observer should now render identical
 * particles for these seedless stamps.
 *
 * Env: ROOM, TARGET_URL, VUS (default 3), STROKES (default 4), LIFETIME_MS.
 */
import ws from 'k6/ws';
import { buildMsg } from '../_k6_proto.js';
import { T, Tool, randInt } from '../_k6_actions.js';

const VUS         = parseInt(__ENV.VUS || '3', 10);
const STROKES     = parseInt(__ENV.STROKES || '4', 10);
const STEP_MS     = parseInt(__ENV.STEP_MS || '40', 10);
const LIFETIME_MS = parseInt(__ENV.LIFETIME_MS || '16000', 10);
const WARMUP_MS   = parseInt(__ENV.WARMUP_MS || '800', 10);

export const options = { vus: VUS, iterations: VUS };

const BOARD_W = 1920, BOARD_H = 1080, REGION = 360, MARGIN = 100;

export default function () {
  const room = __ENV.ROOM || 'confetti_feed';
  const baseUrl = __ENV.TARGET_URL || 'ws://127.0.0.1:8030';
  const url = `${baseUrl}/?room=${room}`;
  let sessionIndex = -1;

  const cols = Math.ceil(Math.sqrt(VUS));
  const col = (__VU - 1) % cols, row = Math.floor((__VU - 1) / cols);
  const homeX = MARGIN + REGION / 2 + col * (REGION + 30);
  const homeY = MARGIN + REGION / 2 + row * (REGION + 30);
  const clampX = (x) => Math.max(MARGIN, Math.min(BOARD_W - MARGIN, x));
  const clampY = (y) => Math.max(MARGIN, Math.min(BOARD_H - MARGIN, y));

  function buildSteps(u) {
    const steps = [];
    // Configure confetti once (deterministic settings).
    steps.push({ t: T.CT, u, l: Tool.CONFETTI });
    steps.push({ t: T.CC, u, c: 0xFF2828FF });
    steps.push({ t: T.CS, u, s: 1600 });
    steps.push({ t: T.IMAGE_TOOL, u, image_tool_type: 'confetti', image_tool_data: JSON.stringify({
      confettiParticles: 8, confettiParticleSize: 12, confettiSizeVariation: 60,
      confettiOpacityRandomness: 30, confettiSpacing: 18, confettiShape: 'circle',
      confettiColorMode: 'active', confettiRotationMode: 'random',
    }) });
    for (let s = 0; s < STROKES; s++) {
      const sx = clampX(homeX + randInt(-REGION / 3, REGION / 3));
      const sy = clampY(homeY + randInt(-REGION / 3, REGION / 3));
      steps.push({ t: T.MD, u, ps: [sx, sy] });
      let cx = sx, cy = sy;
      const segs = randInt(5, 9);
      for (let k = 0; k < segs; k++) {
        cx = clampX(cx + randInt(-60, 60));
        cy = clampY(cy + randInt(-60, 60));
        const m = { t: T.MM, u, ps: [cx, cy] };
        if (k === 0) m.stroke_ts = 1;
        steps.push(m);
      }
      steps.push({ t: T.MU, u });
    }
    return steps;
  }

  ws.connect(url, {}, function (socket) {
    let steps = null, i = 0, warmupAt = 0, cursorSent = false;
    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `CONF_${__VU}` }));
      socket.setInterval(function () {
        if (sessionIndex === -1) return;
        if (!warmupAt) { warmupAt = Date.now() + WARMUP_MS; return; }
        if (!cursorSent) { socket.sendBinary(buildMsg({ t: T.SHOW_CURSOR, u: sessionIndex })); cursorSent = true; }
        if (Date.now() < warmupAt) return;
        if (!steps) steps = buildSteps(sessionIndex);
        if (i >= steps.length) return;
        const step = steps[i++];
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
    socket.setTimeout(function () { socket.close(); }, LIFETIME_MS);
  });
}
