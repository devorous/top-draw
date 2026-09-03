/**
 * Protocol-level peer drawer: gives the weak client a remote user to render
 * without putting a browser on the measuring machine.
 *
 * A headful Chrome peer is heavy enough to disturb the box it runs on, and
 * running it on the Chromebook would contend with the client under test. This
 * speaks the binary protocol directly (SpoofBot, the same protobufjs encoder
 * the browser uses), so it costs a node process and nothing else.
 *
 *   TOOL=brush SECONDS=90 node testing/devtools/peer_bot.mjs
 *
 * Env:
 *   TOOL     brush | ink | flowPen | pixel | line | rectangle | circle | pattern
 *   SECONDS  how long to draw, 0 = until killed          (default 60)
 *   ROOM     room id, must match the observer            (default perfroom)
 *   SIZE     brush size in px                            (default 24)
 *   RATE     ms between MM batches                       (default 16)
 *
 * Wire fidelity notes — these are what separate traffic that paints from
 * traffic that silently does nothing (see the k6 wire-fidelity memories):
 *  - `rs` is NOT decorative. RemoteUserHandler.handleMouseMove routes ANY tool
 *    with a non-empty `rs` into the stamp branch (pen/pixel/pattern), so a
 *    brush that sends radii is rendered as a pen. Brush and the shape tools
 *    must send `ps` alone; ink/pen/pixel/pattern send `rs`.
 *  - Points are batched per flush the way a real client's InputBufferManager
 *    flushes them, not one point per message.
 *  - `s` (size) and `sp` (spacing) are the value x100.
 */
import { SpoofBot } from '../lib/spoofBot.mjs';
import { T } from '../../shared/MessageTypes.js';
import { packColor } from '../../shared/ColorUtils.js';

const TOOL = process.env.TOOL || 'brush';
const SECONDS = Number(process.env.SECONDS ?? 60);
const ROOM = process.env.ROOM || 'perfroom';
const SIZE = Number(process.env.SIZE || 24);
const RATE = Number(process.env.RATE || 16);
const POINTS = Number(process.env.POINTS || 1);
const POINTS_PER_STROKE = Number(process.env.STROKE_POINTS || 30);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Tool enum on the wire (mirrors the proto Tool enum). */
const Tool = {
  brush: 0, text: 1, erase: 2, imageBrush: 3, select: 4,
  flowPen: 5, line: 6, rectangle: 7, circle: 8, ink: 9,
  inkdropper: 10, blur: 11, circleBlur: 12, glitchBlur: 13,
  pixel: 14, fill: 15, pattern: 16, confetti: 17,
};
if (!(TOOL in Tool)) { console.error('unknown TOOL', TOOL); process.exit(1); }
/** Tools whose remote handler expects per-point radii on MD/MM. */
const STAMPED = new Set(['ink', 'flowPen', 'pixel', 'pattern', 'blur', 'circleBlur', 'confetti', 'imageBrush']);
/** Tools that drag out one shape between mousedown and mouseup. */
const SHAPE = new Set(['line', 'rectangle', 'circle']);

const bot = new SpoofBot({ ip: '203.0.113.77', room: ROOM, name: 'peerbot', label: 'peerbot' });
const outcome = await bot.join();
if (!outcome.joined) {
  console.error('JOIN FAILED', JSON.stringify(outcome));
  process.exit(1);
}
console.log('PEER BOT READY', JSON.stringify({ room: ROOM, tool: TOOL, session: outcome.sessionIndex }));

// The server pings at the APPLICATION level (T.PING) every 30s and reaps a
// socket after two unanswered ones — so a bot that never answers dies at ~60s,
// mid-run, looking like the harness quit on its own. SpoofBot does not reply on
// its own; the moderation suites never run long enough to notice.
let pongs = 0;
bot.socket.on('message', (raw) => {
  try {
    const m = bot.Msg.decode(new Uint8Array(raw));
    if (m.t === T.PING) { bot.send({ t: T.PONG }); pongs++; }
  } catch (_) { /* not our concern */ }
  // SpoofBot keeps every decoded frame for its assertions; over a long draw run
  // that is an unbounded array. Nothing here reads history.
  if (bot.messages.length > 500) bot.messages.length = 0;
});

bot.send({ t: T.CT, l: Tool[TOOL] });
bot.send({ t: T.CC, c: packColor([230, 40, 90, 1]) });
bot.send({ t: T.CS, s: Math.round(SIZE * 100) });
bot.send({ t: T.CHD, hd: 100 });
bot.send({ t: T.CSP, sp: 100 });
if (SHAPE.has(TOOL)) bot.send({ t: T.CSDM, sdm: 'corner-to-corner' });
await sleep(300);

// Board size is the server's, not ours; stay well inside a conservative box.
const W = Number(process.env.BOARD_W || 1000);
const H = Number(process.env.BOARD_H || 900);
const radiiFor = n => new Array(n).fill(Math.round(0.7 * 255));

let strokes = 0, batches = 0;
const deadline = SECONDS > 0 ? Date.now() + SECONDS * 1000 : Infinity;
let s = 0;
const stopping = { flag: false };
process.on('SIGTERM', () => { stopping.flag = true; });
process.on('SIGINT', () => { stopping.flag = true; });

while (Date.now() < deadline && !stopping.flag && bot.connected) {
  const x0 = 60 + (s % 5) * (W - 120) / 5;
  const y0 = 60 + (Math.floor(s / 5) % 4) * (H - 120) / 4;
  bot.send(STAMPED.has(TOOL)
    ? { t: T.MD, ps: [x0, y0], rs: radiiFor(1) }
    : { t: T.MD, ps: [x0, y0] });

  // One MM per tick, POINTS points in it. The cost being measured is per
  // ARRIVING BATCH, so batches/second is the load knob that matters — a bot
  // that packs the same stroke into a third as many messages under-loads the
  // observer by a factor of three and reads as "no effect". Defaults match a
  // 60Hz pointer flushed by a 60 TPS tick: one point every 16ms.
  for (let i = 1; i <= POINTS_PER_STROKE && !stopping.flag; i += POINTS) {
    const pts = [];
    for (let k = 0; k < POINTS; k++) {
      const j = i + k;
      pts.push(x0 + j * 6, y0 + Math.sin(j / 3) * 26);
    }
    bot.send(STAMPED.has(TOOL)
      ? { t: T.MM, ps: pts, rs: radiiFor(pts.length / 2) }
      : { t: T.MM, ps: pts });
    batches++;
    await sleep(RATE);
  }
  bot.send({ t: T.MU });
  strokes++;
  s++;
  await sleep(120);
}

console.log('PEER BOT DONE', JSON.stringify({ strokes, batches, pongs, connected: bot.connected }));
bot.socket?.close();
process.exit(0);
