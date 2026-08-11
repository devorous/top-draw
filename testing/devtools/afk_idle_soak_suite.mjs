#!/usr/bin/env node
/**
 * @fileoverview Long-idle (AFK) multi-user parity soak.
 *
 * The existing soak (`test:k6obs`) asks "do three simultaneously-present clients
 * see the same board?". This one asks the harder question the product actually
 * faces: **can a client that stopped paying attention for 5–10 minutes get back
 * to a correct board?**
 *
 * That path is real and load-bearing. `SessionManager` marks a user AFK after
 * `AFK_TIMEOUT` (5 min, checked every 30 s), and from that moment the server
 * *filters every canvas-mutating message away from them* — `INACTIVE_FILTERED_TYPES`
 * in `server/index.js` covers MD, MU, MM, FILL, CLR, UNDO, every SEL_ verb,
 * GLITCH_RESULT and the TILE_ pair.
 * An AFK client's canvas is therefore FROZEN at the instant it went idle, and it
 * only recovers because `SyncClient.setInactive(false)` force-requests a sync when
 * the user comes back. Nothing in the pixel/tape suites exercises that today:
 * every one of them finishes inside the 5-minute window.
 *
 * Two idle observers with different idle depths run against one continuously-fed
 * room, alongside two observers that stay active as the reference:
 *
 *   A, B   active throughout (kept non-AFK by a periodic chat ping)   ← control
 *   C      idles --idle   (default 7m → ~2 min of filtered drawing)
 *   D      idles --idle2  (default 12m → ~7 min of filtered drawing)
 *   J      --join, joins at the very end (the known departed-user bug)
 *
 * Chat is the keepalive because it is the only realistic user action that counts
 * as activity server-side (`isUserActivityMessage`) while being absent from
 * `INACTIVE_FILTERED_TYPES` — so it reaches idle observers too and lands
 * identically on every tape. It also keeps the observers pure receivers, which
 * is what makes their tapes directly comparable.
 *
 * THREE THINGS ARE CHECKED, not one:
 *
 *  1. The idle client really did go dark — measured as ZERO canvas-mutating
 *     messages delivered during the AFK window (that is precisely what
 *     INACTIVE_FILTERED_TYPES controls), while the active reference kept moving.
 *     If C keeps up with A while "AFK", the filtering never happened and the rest
 *     of the run proves nothing — a green result there would be a false pass, so
 *     it is reported as INVALID rather than as a success.
 *
 *     Note that canvas byte-identity is NOT a valid stand-in for this, and was
 *     the suite's own first mistake: the SVG text overlay fades and expires on a
 *     local rAF loop, so an AFK canvas keeps animating with zero messages. It
 *     reported "filtering did not apply" on a run where the idler sat at 951
 *     baked records against the reference's 1103.
 *  2. Return converges. After the ping, AFK clears, SyncClient force-resyncs, and
 *     the board must come back to the reference within tolerance.
 *  3. Nothing regressed for the clients that stayed. A↔B is the control: if it
 *     fails, the run says nothing about AFK.
 *
 * `--all-afk` adds a final phase for the other half of the mechanism: stop every
 * ping, let the room go entirely AFK, and wait out `ALL_AFK_RESTORE_DELAY` (2 min)
 * for the server's automatic `BOARD_SNAPSHOT_RESTORE` — then bring everyone back
 * and check they agree on the restored board.
 *
 * `--join-on-return[=C|D]` answers a different question: is the AFK residual even
 * an AFK bug? A fresh client spawned at the instant an idler returns rebuilds the
 * board through the SAME checkpoint+tail machinery the returner does, so the
 * returner↔joiner diff separates "one rebuild bug" from "something AFK-specific".
 * The two residuals (91.060% for a 12-minute idle, 93.967% for a fresh joiner)
 * had never been compared to each other.
 *
 * The run is GATED on the observers agreeing before the idle clock starts. A
 * divergence inherited at t=0 — from a room still holding an earlier run's
 * content, say — is indistinguishable at t=17m from one that AFK caused, and
 * measuring anyway is how a whole session's numbers came to be provisional.
 * `npm run dev:reset` gives a clean backend; `--allow-unequal-start` overrides.
 *
 * Run the rate-limit-free server first (the k6 feed trips the normal limits):
 *   npm run dev:stress
 *   npm run test:afksoak
 *   npm run test:afksoak -- --idle=6m --idle2=11m --join
 *   npm run test:afksoak -- --room=lobby --join --join-on-return=D   (the real path)
 *   npm run test:afksoak -- --idle=5m30s --idle2=5m30s --fast   (quick shakeout)
 *   npm run test:afksoak -- --all-afk
 */

import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  PIXEL_TOLERANCE, PASS_PCT,
  captureLayerSnapshotsInPage,
  diffSnapshots,
  generateDiffPngInPage,
} from '../lib/layerDiff.mjs';
import { loadTape, compareTapes, formatReport, joinVerdict } from '../lib/tapeDiff.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const WS_URL     = process.env.WS_URL     || 'ws://127.0.0.1:8030';
const CODEC_URL  = '/src/replay/ddrawCodec.js';

// Server-side constants this suite is built around (server/SessionManager.js).
// Mirrored, not imported, so a drift shows up as a suite failure rather than
// silently changing what the test means.
const SRV_AFK_TIMEOUT_MS       = 5 * 60 * 1000;
const SRV_AFK_CHECK_MS         = 30 * 1000;
const SRV_ALL_AFK_RESTORE_MS   = 2 * 60 * 1000;

// Message types (shared/MessageTypes.js). Numeric because they are read out of
// the in-page inbound counter, which keys by wire type.
const MT = {
  MSG: 22, AFK: 24, SYNC_REQUEST: 41, SYNC_COMPLETE: 44, SYNC_METADATA: 49,
  SYNC_STROKE_BATCH: 62, SYNC_TILE_OWNERSHIP: 75,
  BOARD_SNAPSHOT_RESTORE: 99, COMPRESS_USER_STROKES: 121,
  SYNC_PARITY_CHECK: 137, SYNC_PARITY_MISMATCH: 139, SYNC_PARITY_RESYNC_REQUEST: 143,
};

/** `7m` / `5m30s` / `90s` / `450000` → ms. */
function parseDur(s) {
  const str = String(s).trim();
  if (/^\d+$/.test(str)) return Number(str);
  let ms = 0, seen = false;
  for (const m of str.matchAll(/(\d+(?:\.\d+)?)(ms|[smh])/g)) {
    seen = true;
    const n = Number(m[1]);
    ms += m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3_600_000;
  }
  if (!seen) throw new Error(`Cannot parse duration: ${s}`);
  return ms;
}
const fmt = (ms) => {
  const t = Math.round(ms / 1000);
  return t >= 60 ? `${Math.floor(t / 60)}m${String(t % 60).padStart(2, '0')}s` : `${t}s`;
};

let HEADLESS = process.env.HEADLESS !== 'false';
let IDLE_1 = parseDur('7m');     // observer C total inactivity
let IDLE_2 = parseDur('12m');    // observer D total inactivity
let PING_EVERY = parseDur('90s');
let WAVE_DURATION = '60s';
let WAVE_GAP = parseDur('8s');
let VUS = '4';
let RECORD = true;
let LATE_JOIN = false;
let ALL_AFK = false;
let UNDO_WEIGHT = null, SPECIAL_CHANCE = null, NO_BLEND = false, SPECIAL_ONLY = null;
let FREEZE_OBSERVE_MS = parseDur('75s'); // how long to watch a frozen canvas
let DRAW_STROKES = 4;                    // strokes each idler lays down before idling
// Ad-hoc by default. Only a REGISTERED room (or 'lobby') gets join checkpoints —
// see RoomManager.canPersistSnapshots — so --room=lobby is required to exercise
// the real checkpoint+tail join path.
let ROOM_ID = null;
// `--join-on-return[=C|D]`: spawn a fresh joiner at the INSTANT an idler returns.
// Both rebuild the board through the same checkpoint+tail machinery, so if the
// two end up wrong in the same way there is one rebuild bug and AFK is not a
// cause at all. Nothing had ever compared them directly.
let JOIN_ON_RETURN = null;
const DISCRIM_LABEL = 'K';
// `--allow-unequal-start`: measure even if the observers disagree at t=0.
let BASELINE_GATE = true;
// `--mid-stroke[=C|D]`: the named idler goes dark with a stroke STILL IN FLIGHT.
// This is COMPRESS_USER_STROKES' entire reason to exist and has never been
// exercised — `commitAllUserStrokesGenerator` only commits strokes present in
// `activeStrokeByUser`, and every idler in every run so far had finished drawing,
// so the broadcast fired and did nothing.
let MID_STROKE = null;
// `--undo-on-return[=C|D]`: after the named idler is back and the feed has
// stopped, it presses Ctrl+Z once. Baked strokes are permanently un-undoable, and
// an idler's strokes can be baked out while it is dark, so a no-op is a fine
// answer — undoing SOMEONE ELSE's stroke is not, and nothing tests for it.
let UNDO_ON_RETURN = null;

for (const a of process.argv.slice(2)) {
  if (a === '--headed') HEADLESS = false;
  else if (a === '--no-record') RECORD = false;
  else if (a === '--join') LATE_JOIN = true;
  else if (a === '--join-on-return') JOIN_ON_RETURN = 'D';
  else if (a.startsWith('--join-on-return=')) JOIN_ON_RETURN = a.slice(17).toUpperCase();
  else if (a === '--allow-unequal-start') BASELINE_GATE = false;
  else if (a === '--mid-stroke') MID_STROKE = 'D';
  else if (a.startsWith('--mid-stroke=')) MID_STROKE = a.slice(13).toUpperCase();
  else if (a === '--undo-on-return') UNDO_ON_RETURN = 'D';
  else if (a.startsWith('--undo-on-return=')) UNDO_ON_RETURN = a.slice(17).toUpperCase();
  else if (a === '--all-afk') ALL_AFK = true;
  else if (a === '--no-blend') NO_BLEND = true;
  else if (a === '--no-draw') DRAW_STROKES = 0;
  else if (a.startsWith('--draw=')) DRAW_STROKES = Math.max(0, Number(a.slice(7)));
  else if (a === '--fast') { WAVE_DURATION = '30s'; VUS = '3'; FREEZE_OBSERVE_MS = parseDur('45s'); }
  else if (a.startsWith('--idle2=')) IDLE_2 = parseDur(a.slice(8));
  else if (a.startsWith('--idle='))  IDLE_1 = parseDur(a.slice(7));
  else if (a.startsWith('--ping='))  PING_EVERY = parseDur(a.slice(7));
  else if (a.startsWith('--wave-duration=')) WAVE_DURATION = a.slice(16);
  else if (a.startsWith('--wave-gap=')) WAVE_GAP = parseDur(a.slice(11));
  else if (a.startsWith('--room=')) ROOM_ID = a.slice(7);
  else if (a.startsWith('--vus=')) VUS = a.slice(6);
  else if (a.startsWith('--undo-weight=')) UNDO_WEIGHT = a.slice(14);
  else if (a.startsWith('--special-chance=')) SPECIAL_CHANCE = a.slice(17);
  else if (a.startsWith('--special-only=')) SPECIAL_ONLY = a.slice(15);
  else { console.error(`Unknown flag: ${a}`); process.exit(2); }
}
if (IDLE_2 < IDLE_1) [IDLE_1, IDLE_2] = [IDLE_2, IDLE_1];
if (JOIN_ON_RETURN && !['C', 'D'].includes(JOIN_ON_RETURN)) {
  console.error(`--join-on-return must name an idler: C (idles --idle) or D (idles --idle2)`);
  process.exit(2);
}
if (MID_STROKE && !['C', 'D'].includes(MID_STROKE)) {
  console.error(`--mid-stroke must name an idler: C (idles --idle) or D (idles --idle2)`);
  process.exit(2);
}
if (UNDO_ON_RETURN && !['C', 'D'].includes(UNDO_ON_RETURN)) {
  console.error(`--undo-on-return must name an idler: C (idles --idle) or D (idles --idle2)`);
  process.exit(2);
}
if (MID_STROKE && DRAW_STROKES === 0) {
  console.error(`--mid-stroke needs the pre-idle drawing phase; drop --no-draw / --draw=0`);
  process.exit(2);
}
// Compression fires COMPRESS_STROKES_DELAY (5 min) after the AFK mark, which is
// itself AFK_TIMEOUT + one check interval after the idle clock. An idler that
// returns before that never reaches the mechanism the flag exists to test.
const COMPRESS_DUE_AT = SRV_AFK_TIMEOUT_MS + SRV_AFK_CHECK_MS + 5 * 60_000;
if (MID_STROKE) {
  const idleOf = MID_STROKE === 'C' ? IDLE_1 : IDLE_2;
  if (idleOf < COMPRESS_DUE_AT) {
    console.error(`--mid-stroke=${MID_STROKE} idles ${fmt(idleOf)}, but stroke compression is not due `
      + `until +${fmt(COMPRESS_DUE_AT)}.\nRaise --idle${MID_STROKE === 'D' ? '2' : ''} to at least that, `
      + `or the in-flight stroke is never compressed and the run proves nothing.`);
    process.exit(2);
  }
}
if (PING_EVERY >= SRV_AFK_TIMEOUT_MS) {
  console.error(`--ping=${fmt(PING_EVERY)} is >= the server AFK timeout (${fmt(SRV_AFK_TIMEOUT_MS)}); `
    + `the "active" control observers would go AFK too and there would be no reference.`);
  process.exit(2);
}

const FEED = path.join(__dirname, '..', 'low_stress_test.js');
const ROOM = ROOM_ID || `afk_soak_${Date.now()}`;
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const RESULTS_DIR = path.join(__dirname, '..', 'sync_results', `afksoak_${RUN_ID}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T0 = Date.now();
const elapsed = () => fmt(Date.now() - T0);
const log = (msg) => console.log(`  [${elapsed().padStart(7)}] ${msg}`);

// ── observers ────────────────────────────────────────────────────────────────

async function spawnObserver(label, { recordFromJoin = false } = {}) {
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 760 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (err) => process.stderr.write(`  [${label} ERR] ${err.message}\n`));
  // Same RNG seed everywhere: render jitter (soft edges, confetti) must not be
  // able to masquerade as a delivery difference.
  await page.evaluateOnNewDocument(() => {
    let seed = 0x1f2e3d4c;
    Math.random = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  });

  // Sync/AFK event probe. The replay tape excludes sync handshake traffic, so a
  // resync is invisible to it — but a resync is the entire recovery mechanism
  // under test here, so it has to be observed directly.
  await page.evaluateOnNewDocument((types) => {
    window.__syncLog = [];
    const note = (kind, detail) => window.__syncLog.push({ t: Date.now(), kind, detail });
    const watched = new Set([types.SYNC_REQUEST, types.SYNC_COMPLETE,
      types.SYNC_PARITY_CHECK, types.SYNC_PARITY_MISMATCH, types.SYNC_PARITY_RESYNC_REQUEST]);
    const hook = () => {
      const ws = window.app?.wsClient;
      if (!ws || ws.__probed) return !!ws?.__probed;
      ws.__probed = true;
      const origSend = ws.send.bind(ws);
      ws.send = (msg) => {
        if (msg && watched.has(msg.t)) note('send', { t: msg.t });
        return origSend(msg);
      };
      const origEmit = ws.emit?.bind(ws);
      if (origEmit) {
        ws.emit = (event, data) => {
          if (/^(afk|compress_user_strokes)$/.test(event)) {
            note('recv', { event, session: data?.sessionIndex, afk: data?.afk });
          } else if (/sync|parity|checkpoint|resync|snapshot_restore/i.test(event)) {
            note('recv', { event, session: data?.sessionIndex ?? data?.u });
          }
          return origEmit(event, data);
        };
      }
      return true;
    };
    const iv = setInterval(() => { if (hook()) clearInterval(iv); }, 50);
  }, MT);

  // Count every inbound wire type, including the sync handshake the tape cannot
  // see. Deltas of this counter are how "what did you actually receive while you
  // were AFK?" gets answered.
  await page.evaluateOnNewDocument(() => {
    window.__msgCounts = {};
    const hook2 = () => {
      const ws = window.app?.wsClient;
      if (!ws || ws.__counted) return !!ws?.__counted;
      ws.__counted = true;
      const origHandle = ws.handleMessage?.bind(ws);
      if (!origHandle) return false;
      ws.handleMessage = (data, raw) => {
        const t = data?.t;
        if (t != null) window.__msgCounts[t] = (window.__msgCounts[t] || 0) + 1;
        return origHandle(data, raw);
      };
      return true;
    };
    const iv2 = setInterval(() => { if (hook2()) clearInterval(iv2); }, 50);
  });

  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });
  if (recordFromJoin) await startRecording(page);
  await page.evaluate((n, r) => { window.app.self.username = n; window.app.handleRoomSelected(r); }, `OBS_${label}`, ROOM);
  await page.waitForFunction(() => {
    const app = window.app;
    const done = app?.syncClient?.hasCompletedSync === true || (app?.wsClient?.connected && app?.users?.size <= 1);
    return app?.wsClient?.connected && done && app?.sessionIndex != null;
  }, { timeout: 60_000 });
  return { label, browser, page, pings: 0 };
}

// ── drawing (idle observers own real strokes before they go dark) ────────────
//
// An idle observer that never drew is only a *receiver* of the AFK path. An idle
// observer that DREW is also its subject: five minutes after it goes AFK the
// server broadcasts COMPRESS_USER_STROKES for it (SessionManager
// `_scheduleStrokeCompression`), and every client — including the ones still
// drawing — runs `commitAllUserStrokesForAFKUser`, baking that user's strokes out
// of the live stack. That is a server-driven bake boundary, it is irreversible,
// and nothing else in the test tree crosses it. So C and D each lay down ink
// first, in their own horizontal band so a diff image names the author.

function evLiteral() {
  return `((x, y, extra) => Object.assign({
    button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true, pointerId: 1,
    offsetX: x, offsetY: y, clientX: x, clientY: y, pressure: 0.5,
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    preventDefault() {}, stopPropagation() {}
  }, extra || {}))`;
}

/** Drive one gesture through the real App handlers, ticking the input buffer. */
async function gesture(page, points, { settle = 18 } = {}) {
  await page.evaluate(async (pts, settleMs, evSrc) => {
    const app = window.app;
    const ev = eval(evSrc);
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    app.handlePointerDown(ev(pts[0][0], pts[0][1]));
    app.inputBufferManager.tick();
    await nap(settleMs);
    for (let i = 1; i < pts.length; i++) {
      app.handlePointerMove(ev(pts[i][0], pts[i][1]));
      app.inputBufferManager.tick();
      await nap(settleMs);
    }
    const last = pts[pts.length - 1];
    app.handlePointerUp(ev(last[0], last[1]));
    app.inputBufferManager.tick();
    await nap(settleMs * 2);
  }, points, settle, evLiteral());
}

/**
 * Drive a gesture and NEVER release it — pointerDown + moves, no pointerUp.
 *
 * This is the only way to reach what `COMPRESS_USER_STROKES` is actually for.
 * `isUserActivityMessage(T.MM, user)` returns `!!user.mousedown`, so cursor moves
 * count as activity only while the button is held; a client that presses, moves,
 * then stops moving without releasing simply goes quiet. The server sees silence,
 * marks it AFK at 5 min (clearing `mousedown`), and 5 min after that broadcasts a
 * compression that — for the first time — has a real in-flight stroke to commit,
 * on every client at once.
 */
async function gestureHalf(page, points, { settle = 22 } = {}) {
  await page.evaluate(async (pts, settleMs, evSrc) => {
    const app = window.app;
    const ev = eval(evSrc);
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    app.handlePointerDown(ev(pts[0][0], pts[0][1]));
    app.inputBufferManager.tick();
    await nap(settleMs);
    for (let i = 1; i < pts.length; i++) {
      app.handlePointerMove(ev(pts[i][0], pts[i][1]));
      app.inputBufferManager.tick();
      await nap(settleMs);
    }
    // Deliberately no handlePointerUp. The stroke stays in activeStrokeByUser.
    await nap(settleMs * 2);
  }, points, settle, evLiteral());
}

async function setTool(page, tool, settings = {}) {
  await page.evaluate((t, s) => {
    const app = window.app;
    app.selectTool(t);
    if (s.size !== undefined) app.handleSizeChange({ target: { value: s.size } });
    if (s.color !== undefined) app.handleColorInputChange(s.color);
    if (s.blendMode !== undefined) app.handleBlendModeChange(s.blendMode);
  }, tool, settings);
}

// RGBA arrays — App.handleColorInputChange joins the channels, a hex string throws.
const IDLER_INK = { C: [224, 53, 90, 1], D: [47, 125, 224, 1] };
// Only tools that actually commit a stroke through a SYNTHESISED gesture
// (`handlePointerDown/Move/Up` + `inputBufferManager.tick()`). Measured with
// `_gesture_commit_probe.mjs`: brush, line, rectangle, circle and ink commit
// exactly one stroke each; **pen and eraser commit nothing** on this path, even
// with ink underneath for the eraser to bite. That is a statement about the
// driven-input path used by test harnesses, not about the tools in real use.
// Using 'pen' here is why each idler owned 3 of 4 requested strokes.
const IDLER_TOOLS = ['brush', 'line', 'rectangle', 'circle'];

/**
 * Four strokes in the observer's own band, deterministic from its label.
 * With `leaveInFlight`, a fifth is started and never released (see gestureHalf).
 */
async function drawIdlerStrokes(o, bandIdx, count, { leaveInFlight = false } = {}) {
  // handleRoomSelected() bypasses the landing page's click handler, so the
  // overlay stays flagged visible and swallows input paths. hide() is not
  // synchronous — firing the first gesture straight after it silently loses that
  // stroke (seen: every idler owned 3 of 4).
  await o.page.evaluate(() => window.app?.landingPage?.hide?.());
  await o.page.waitForFunction(() => !window.app?.landingPage?.isVisible, { timeout: 10_000 });
  await sleep(250);
  const yTop = 140 + bandIdx * 170;
  for (let i = 0; i < count; i++) {
    const tool = IDLER_TOOLS[i % IDLER_TOOLS.length];
    await setTool(o.page, tool, { size: 26, color: IDLER_INK[o.label] || [136, 136, 136, 1] });
    const y = yTop + (i % 3) * 34;
    const x0 = 180 + i * 90;
    const pts = [[x0, y], [x0 + 60, y + 26], [x0 + 130, y - 18], [x0 + 200, y + 12], [x0 + 260, y]];
    await gesture(o.page, pts);
  }
  if (leaveInFlight) {
    // Long and low in the band so a diff image can tell "the half-stroke" from
    // the four finished ones at a glance.
    const y = yTop + 120;
    await setTool(o.page, 'brush', { size: 30, color: IDLER_INK[o.label] || [136, 136, 136, 1] });
    await gestureHalf(o.page, [[190, y], [300, y + 30], [430, y - 22], [560, y + 16], [690, y]]);
  }
}

/** Deliberate user activity that is NOT canvas traffic — clears/postpones AFK. */
async function chatPing(o, text) {
  o.pings++;
  await o.page.evaluate((t) => {
    const ws = window.app?.wsClient;
    if (!ws?.broadcastChat) throw new Error('broadcastChat missing');
    ws.broadcastChat(t, `afksoak_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);
  }, text).catch((e) => log(`⚠ ${o.label} ping failed: ${e.message}`));
}

/** Cheap per-observer state — safe to poll on a timer (no pixel work). */
const STATE_FN = `(() => {
  const app = window.app;
  const me = app?.users?.get?.(app?.sessionIndex);
  const g = app?.board?.layerManager?.layerGroups || [];
  return {
    session: app?.sessionIndex ?? null,
    // app.self first: the T.AFK handler calls app.self.setAfk() for our own
    // session and returns before touching the users map, so the map entry can
    // read a stale false for self.
    afk: !!(app?.self?.afk ?? me?.afk),
    inactive: !!app?.syncClient?.inactive,
    syncing: !!app?.syncClient?.syncing,
    completed: app?.syncClient?.hasCompletedSync === true,
    users: app?.users?.size ?? 0,
    strokes: g.reduce((n, x) => n + (x.strokeStack?.length || 0), 0),
    selfId: app?.self?.id ?? null,
    liveByUser: (() => {
      const per = {};
      for (const x of g) for (const s of (x.strokeStack || [])) per[s.userId] = (per[s.userId] || 0) + 1;
      return per;
    })(),
    // Strokes still IN FLIGHT per user — what COMPRESS_USER_STROKES commits, and
    // the only thing that makes that broadcast anything other than a no-op.
    activeByUser: (() => {
      const per = {};
      for (const x of g) {
        const m = x.activeStrokeByUser;
        if (m && typeof m.forEach === 'function') m.forEach((_v, uid) => { per[uid] = (per[uid] || 0) + 1; });
      }
      return per;
    })(),
    undoable: (() => {
      try { return !!app?.board?.layerManager?.hasUndoableStroke?.(app?.self?.id); } catch { return null; }
    })(),
    flatRecs: g.reduce((n, x) => n + (x.flatStrokeRecords?.length || 0), 0),
    bakedSeqs: g.reduce((n, x) => n + (x.bakedSequences?.length || 0), 0),
    counts: Object.assign({}, window.__msgCounts || {}),
  };
})()`;
const getState = (o) => o.page.evaluate(STATE_FN);
const snap = (o) => o.page.evaluate(captureLayerSnapshotsInPage);
const painted = (s) => s.filter((g) => g.bbox).length;
const pick = (d) => ({ pass: d.pass, matchPct: d.matchPct, maxDelta: d.maxDelta });
const pct = (d) => `${d.matchPct.toFixed(3)}%${d.pass ? '' : ' ❌'}`;

/** Baseline gate refusal — distinct from a crash, so main() can report it cleanly. */
class BaselineGateError extends Error {
  constructor(msg) { super(msg); this.name = 'BaselineGateError'; }
}

function countDelta(before, after) {
  const out = {};
  for (const k of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const d = (after?.[k] || 0) - (before?.[k] || 0);
    if (d) out[k] = d;
  }
  return out;
}
/** Canvas-mutating types the server filters from AFK clients — the ones that matter. */
const DRAW_TYPES = new Set([10, 11, 12, 20, 26, 60, 61, 73, 90, 30, 31, 32, 33, 34, 35, 36, 37, 67, 83]);
const drawTotal = (delta) => Object.entries(delta)
  .filter(([t]) => DRAW_TYPES.has(Number(t))).reduce((n, [, v]) => n + v, 0);

async function startRecording(page) {
  await page.evaluate(() => {
    if (!window.app.recorder) throw new Error('app.recorder missing');
    // A soak this long will blow the default length cap, and an auto-stopped
    // recorder returns null from stop() — silently losing the tape.
    window.app.recorder.configure?.({ maxLengthMs: 0 });
    window.app.recorder.start(window.app);
  });
}

async function stopAndEncode(page) {
  return page.evaluate(async (url) => {
    const rec = window.app.recorder?.stop?.();
    if (!rec) return null;
    const { encodeDdraw } = await import(url);
    const blob = await encodeDdraw(rec);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    return { b64: btoa(bin), size: buf.length, deltas: rec.deltas?.length ?? 0 };
  }, CODEC_URL);
}

/**
 * Compare two tabs until they agree, or give up and report the last reading.
 *
 * A plain "settle each tab, then diff" is not safe here: the k6 feed never stops
 * during the idle phases, so the two snapshots are taken seconds apart with bots
 * drawing in between, and a transient in-flight stroke reads as a divergence.
 * Both snapshots are taken in the SAME Promise.all so they share an instant, and
 * the comparison is retried — "did it catch up?" is a question about a limit, not
 * about one instant.
 */
async function waitAgree(ref, other, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let tries = 0;
  while (Date.now() < deadline) {
    tries++;
    const [a, b] = await Promise.all([snap(ref), snap(other)]);
    const d = diffSnapshots(a, b);
    last = { d, a, b, tries };
    if (d.pass) return last;
    await sleep(1500);
  }
  return last;
}

/** Settle when a tab matches its own previous snapshot (nothing still rendering). */
async function waitStable(o, { timeoutMs = 45_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let prev = null;
  while (Date.now() < deadline) {
    await sleep(900);
    const s = await snap(o);
    if (prev && painted(s) > 0) {
      const d = diffSnapshots(prev, s);
      if (d.matchPct >= 99.99 && d.maxDelta === 0) return s;
    }
    prev = s;
  }
  return prev ?? [];
}

// ── k6 feed driver ───────────────────────────────────────────────────────────

let k6Stop = false;
const waveLog = [];

function startK6() {
  const args = ['run', '-e', `ROOM=${ROOM}`, '-e', `TARGET_URL=${WS_URL}`];
  if (UNDO_WEIGHT) args.push('-e', `UNDO_WEIGHT=${UNDO_WEIGHT}`);
  if (NO_BLEND) args.push('-e', 'NO_BLEND=1');
  if (SPECIAL_CHANCE) args.push('-e', `SPECIAL_CHANCE=${SPECIAL_CHANCE}`);
  if (SPECIAL_ONLY) args.push('-e', `SPECIAL_ONLY=${SPECIAL_ONLY}`);
  args.push('--vus', VUS, '--duration', WAVE_DURATION, FEED);
  const child = spawn('k6', args, { shell: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return new Promise((res, rej) => { child.on('error', rej); child.on('close', (code) => res({ code, out })); });
}

/**
 * Waves back-to-back for the whole idle window. The gaps matter as much as the
 * waves: bots depart between them, which is the departure/bake path, and it must
 * keep happening while C and D are dark.
 */
async function k6Driver() {
  let wave = 0;
  while (!k6Stop) {
    wave++;
    const started = Date.now();
    const r = await startK6().catch((e) => ({ code: -1, out: String(e) }));
    waveLog.push({ wave, code: r.code, at: started - T0, ms: Date.now() - started });
    fs.appendFileSync(path.join(RESULTS_DIR, 'k6_output.txt'),
      `\n===== wave ${wave} @+${fmt(started - T0)} (exit ${r.code}) =====\n${r.out}`);
    if (r.code !== 0) log(`⚠ k6 wave ${wave} exited ${r.code} (see k6_output.txt)`);
    if (k6Stop) break;
    await sleep(WAVE_GAP);
  }
  return wave;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const filteredWindow = (idle) => Math.max(0, idle - SRV_AFK_TIMEOUT_MS - SRV_AFK_CHECK_MS);

  console.log(`\nTop Draw — long-idle (AFK) multi-user parity soak`);
  console.log(`Room:        ${ROOM}`);
  console.log(`Browser:     ${TARGET_URL}   (4 independent observer browsers)`);
  console.log(`k6 feed:     ${path.relative(process.cwd(), FEED)} → ${WS_URL}  (${VUS} VUs × ${WAVE_DURATION}, back-to-back)`);
  console.log(`Server AFK:  ${fmt(SRV_AFK_TIMEOUT_MS)} timeout, checked every ${fmt(SRV_AFK_CHECK_MS)}`);
  console.log(`Idle plan:   C idles ${fmt(IDLE_1)} (≈${fmt(filteredWindow(IDLE_1))} of drawing filtered away)`);
  console.log(`             D idles ${fmt(IDLE_2)} (≈${fmt(filteredWindow(IDLE_2))} of drawing filtered away)`);
  console.log(`             A,B stay active (chat ping every ${fmt(PING_EVERY)})`);
  if (JOIN_ON_RETURN) {
    console.log(`Discrim:     ${DISCRIM_LABEL} joins fresh the instant ${JOIN_ON_RETURN} returns — `
      + `${JOIN_ON_RETURN}↔${DISCRIM_LABEL} says whether the AFK and joiner residuals are one bug`);
  }
  console.log(`Tolerance:   ±${PIXEL_TOLERANCE}px, ≥${PASS_PCT}% match`);
  console.log(`Est. wall:   ~${fmt(IDLE_2 + 180_000 + (LATE_JOIN ? 60_000 : 0) + (ALL_AFK ? SRV_AFK_TIMEOUT_MS + SRV_ALL_AFK_RESTORE_MS + 90_000 : 0))}\n`);

  const obs = [];
  const results = { checks: [], phases: {} };
  const record = (name, ok, detail) => {
    results.checks.push({ name, ok, detail });
    return ok;
  };

  try {
    // ── Phase 0: everyone joins and syncs ────────────────────────────────────
    for (const label of ['A', 'B', 'C', 'D']) obs.push(await spawnObserver(label));
    const byLabel = Object.fromEntries(obs.map((o) => [o.label, o]));
    const [A, B, C, D] = [byLabel.A, byLabel.B, byLabel.C, byLabel.D];
    const idlers = [{ o: C, idle: IDLE_1 }, { o: D, idle: IDLE_2 }];
    const actives = [A, B];
    log(`observers up: ${obs.map((o) => o.label).join(', ')}`);

    const seenDeadline = Date.now() + 30_000;
    while (Date.now() < seenDeadline) {
      const counts = await Promise.all(obs.map((o) => o.page.evaluate(() => window.app?.users?.size ?? 0)));
      if (counts.every((c) => c >= 4)) break;
      await sleep(250);
    }

    // Was the room already populated when we arrived? Every headline number in
    // docs/afk_parity_session_2026-08-08.md was measured against a `lobby` that
    // still held content from earlier runs of the same session, and nothing in
    // the output recorded that. Inherited content is not automatically
    // disqualifying — everyone syncs on join — but it makes the run a different
    // measurement, so it has to be visible in the log and in summary.json.
    const startState = await getState(A);
    const preExisting = startState.strokes + startState.flatRecs + startState.bakedSeqs;
    results.roomAtJoin = {
      live: startState.strokes, flat: startState.flatRecs, baked: startState.bakedSeqs,
      clean: preExisting === 0,
    };
    log(`room content at join: live=${startState.strokes} flat=${startState.flatRecs} `
      + `baked=${startState.bakedSeqs}`
      + (preExisting > 0 ? `   ⚠ room "${ROOM}" was NOT empty — measured against inherited content` : '   (clean room)'));

    if (RECORD) {
      const syncDeadline = Date.now() + 30_000;
      while (Date.now() < syncDeadline) {
        const done = await Promise.all(obs.map((o) => o.page.evaluate(() => window.app?.syncClient?.hasCompletedSync === true)));
        if (done.every(Boolean)) break;
        await sleep(250);
      }
      await sleep(2000);
      await Promise.all(obs.map((o) => startRecording(o.page)));
      log('recorders armed (post-sync)');
    }

    // The idlers lay down their own ink first, so their disappearance is a bake
    // boundary for everyone else and not merely a gap in their own view.
    const midStroke = { label: MID_STROKE, userId: null };
    if (DRAW_STROKES > 0) {
      for (const [i, { o }] of idlers.entries()) {
        const leaveInFlight = MID_STROKE === o.label;
        await drawIdlerStrokes(o, i, DRAW_STROKES, { leaveInFlight });
        log(`${o.label} drew ${DRAW_STROKES} strokes before going idle`
          + (leaveInFlight ? ' + one left IN FLIGHT (never released)' : ''));
      }
      await sleep(2500);
      // Per-author breakdown, not just a total: "8 strokes exist" and "each idler
      // owns 4" are different claims, and only the second one means the idlers
      // are really subjects of the AFK bake rather than bystanders.
      const owned = await Promise.all(obs.map(async (o) => {
        const s = await getState(o);
        return `${o.label}=${s.strokes}${JSON.stringify(s.liveByUser)}`;
      }));
      log(`live strokes after pre-idle drawing: ${owned.join(' ')}`);
      const idlerIds = await Promise.all(idlers.map(({ o }) => o.page.evaluate(() => window.app?.self?.id)));
      const refView = (await getState(A)).liveByUser;
      idlers.forEach(({ o }, i) => {
        const got = refView[idlerIds[i]] || 0;
        if (got < DRAW_STROKES) log(`⚠ ${o.label} owns only ${got}/${DRAW_STROKES} strokes in A's view`);
      });

      // The in-flight stroke must exist on the OWNER and on every observer
      // before the clock starts, or the compression later has nothing to commit
      // anywhere and the run silently degenerates into an ordinary idle soak —
      // which is precisely how this mechanism went unexercised for so long.
      if (MID_STROKE) {
        midStroke.userId = idlerIds[idlers.findIndex(({ o }) => o.label === MID_STROKE)] ?? null;
        const seen = {}, live = {};
        for (const o of obs) {
          const s = await getState(o);
          seen[o.label] = s.activeByUser?.[midStroke.userId] || 0;
          live[o.label] = s.liveByUser?.[midStroke.userId] || 0;
        }
        midStroke.activeAtStart = seen;
        midStroke.liveAtStart = live;
        const everywhere = obs.every((o) => seen[o.label] > 0);
        log(`mid-stroke: ${MID_STROKE}'s unreleased stroke is in flight on ${JSON.stringify(seen)}`
          + `   (compression due at +${fmt(COMPRESS_DUE_AT)})`);
        record(`mid-stroke: ${MID_STROKE}'s stroke is in flight everywhere before the idle clock`,
          everywhere, { active: seen });
        if (!everywhere) {
          log(`  ⚠ not in flight on every client — COMPRESS_USER_STROKES will be a no-op where it is missing`);
        }
      }
    }

    // ── Baseline gate: refuse to measure from an unequal start ───────────────
    //
    // The suite never checked that the observers AGREED before the idle clock
    // started. That is how a whole run's numbers came to be taken against a
    // dirty lobby without anyone noticing: a divergence inherited at t=0 is
    // indistinguishable at t=17m from one AFK caused. The k6 feed has not
    // started yet, so convergence here should take a comparison or two; if it
    // does not, nothing measured afterwards is attributable to anything.
    {
      const baseline = {};
      for (const o of [B, C, D]) {
        const ag = await waitAgree(A, o, { timeoutMs: 45_000 });
        baseline[o.label] = { ...pick(ag.d), tries: ag.tries };
      }
      const baselineOk = Object.values(baseline).every((b) => b.pass);
      log('baseline before idle clock: '
        + ['B', 'C', 'D'].map((l) => `A↔${l} ${baseline[l].matchPct.toFixed(3)}%${baseline[l].pass ? '' : ' ❌'}`).join('  '));
      record('baseline: observers agreed before the idle clock', baselineOk, baseline);
      results.phases.baseline = baseline;
      if (!baselineOk) {
        log('❌ the observers did not agree at t=0, so any divergence measured from');
        log('   here includes one this run did not cause. Reset the backend with');
        log('   `npm run dev:reset`, or pass --allow-unequal-start to measure anyway.');
        if (BASELINE_GATE) {
          throw new BaselineGateError(
            'Baseline gate: the observers disagreed before the idle clock started — '
            + Object.entries(baseline).map(([l, b]) => `A↔${l} ${b.matchPct.toFixed(3)}%`).join(', '));
        }
      }
    }

    // Everyone starts the clock from the same instant. Without this the idle
    // countdown would begin at each observer's join, which differ by seconds.
    for (const o of obs) await chatPing(o, `${o.label} online`);
    const idleClock = Date.now();
    log(`idle clock started (all four pinged)`);

    // ── Phase 1: feed + timeline ─────────────────────────────────────────────
    const driver = k6Driver();
    const timeline = [];
    const state = {};                      // label → latest cheap state
    const afkAt = {};                      // label → ms when AFK first observed
    const freeze = {};                     // label → frozen-canvas evidence
    const countsAtAfk = {};                // label → inbound counters at AFK onset
    let lastPing = Date.now();

    const returned = {};                   // label → return/resync result
    const returnedCheckpoint = {};         // label → was a checkpoint served on return?
    const discrim = {};                    // Tier 1.1 fresh-joiner-at-return state
    const extraActive = [];                // observers added mid-run that must not go AFK

    // One loop drives the whole timeline: pings, AFK detection, the frozen-canvas
    // proof, and the scheduled returns. Keeping it in one place means every
    // observer is measured against the same wall clock.
    while (true) {
      const now = Date.now();
      const sinceIdle = now - idleClock;

      for (const o of obs) state[o.label] = await getState(o);
      timeline.push({ at: now - T0, sinceIdle, state: Object.fromEntries(obs.map((o) => [o.label, {
        afk: state[o.label].afk, inactive: state[o.label].inactive, syncing: state[o.label].syncing,
        strokes: state[o.label].strokes, flatRecs: state[o.label].flatRecs, users: state[o.label].users,
      }])) });

      // Keep the control observers (and anyone already returned) out of AFK.
      if (now - lastPing >= PING_EVERY) {
        lastPing = now;
        const toPing = [...actives, ...extraActive,
          ...idlers.filter(({ o }) => returned[o.label]).map(({ o }) => o)];
        for (const o of toPing) await chatPing(o, `${o.label} still here`);
        log(`ping → ${toPing.map((o) => o.label).join(',')}   `
          + obs.map((o) => `${o.label}:${state[o.label].afk ? 'AFK' : 'act'}/${state[o.label].strokes}s/${state[o.label].flatRecs}f`).join(' '));
      }

      // A control observer going AFK invalidates the reference — bail loudly.
      for (const o of actives) {
        if (state[o.label].afk && !afkAt[o.label]) {
          afkAt[o.label] = sinceIdle;
          log(`❌ control observer ${o.label} went AFK at +${fmt(sinceIdle)} — ping interval too long?`);
        }
      }

      // AFK onset for the idlers → capture the frozen baseline.
      for (const { o } of idlers) {
        if (state[o.label].afk && !afkAt[o.label]) {
          afkAt[o.label] = sinceIdle;
          countsAtAfk[o.label] = state[o.label].counts;
          log(`${o.label} marked AFK at +${fmt(sinceIdle)} (server said so; client inactive=${state[o.label].inactive})`);
          const [idleSnap, refSnap] = await Promise.all([snap(o), snap(A)]);
          freeze[o.label] = {
            at: sinceIdle, idleSnap, refSnap,
            checkedAt: now + FREEZE_OBSERVE_MS,
            // The reference's counters at this instant: COMPRESS_USER_STROKES for
            // this idler is broadcast 5 min later and lands HERE, on the clients
            // that stayed, not on the idler.
            refCounts: state.A.counts, refStrokes: state.A.strokes,
          };
        }
      }

      // Frozen-canvas proof, FREEZE_OBSERVE_MS after onset.
      for (const { o } of idlers) {
        const f = freeze[o.label];
        if (!f || f.done || now < f.checkedAt) continue;
        f.done = true;
        // If the idler already came back, this window straddles its return and
        // the counters below are post-resync traffic, not traffic delivered
        // while AFK. Reporting "filtering did not apply" from that is the same
        // species of error as the byte-identity criterion it replaced: an oracle
        // that CANNOT go green in the configuration it is being read in. Happens
        // whenever the idle time is close to AFK_TIMEOUT + AFK_CHECK_INTERVAL,
        // e.g. any --fast shakeout.
        if (returned[o.label]) {
          f.notApplicable = true;
          const afkFor = (returned[o.label].idleMs ?? 0) - (afkAt[o.label] ?? 0);
          log(`${o.label} frozen-check: NOT APPLICABLE — ${o.label} was only AFK for ${fmt(afkFor)}, `
            + `shorter than the ${fmt(FREEZE_OBSERVE_MS)} observation window, so the counters below`);
          log(`  would be post-resync traffic. Raise --idle so the AFK window outlasts it.`);
          continue;
        }
        const [idleNow, refNow] = await Promise.all([snap(o), snap(A)]);
        const idleDrift = diffSnapshots(f.idleSnap, idleNow);
        const refDrift  = diffSnapshots(f.refSnap, refNow);
        const recvd = countDelta(countsAtAfk[o.label], (await getState(o)).counts);
        const draws = drawTotal(recvd);
        f.idleDrift = { matchPct: idleDrift.matchPct, maxDelta: idleDrift.maxDelta };
        f.refDrift  = { matchPct: refDrift.matchPct,  maxDelta: refDrift.maxDelta };
        f.drawMsgsWhileAfk = draws;
        // What actually proves the filtering engaged is that ZERO canvas-mutating
        // messages were delivered — that is the thing INACTIVE_FILTERED_TYPES
        // controls, and it is measured directly from the inbound counters.
        //
        // Byte-identity of the canvas is NOT a valid stand-in and was wrong here:
        // the SVG text overlay fades and expires on a local requestAnimationFrame
        // loop (TextOverlay._ensureRafLoop), so an AFK canvas keeps animating
        // with no messages at all. Observed: draw msgs 0, yet 3.7% of pixels
        // changed. Requiring byte-identity reported "filtering did not apply" on
        // a run where filtering demonstrably had (951 baked records vs the
        // reference's 1103).
        //
        // So: no draw traffic, and the reference must have moved substantially
        // MORE than the idler (otherwise nothing was being drawn and the window
        // proves nothing either way).
        const refMoved = refDrift.matchPct < 99.99 || refDrift.maxDelta > 0;
        const noDraws = draws === 0;
        const idleLagsReference = idleDrift.matchPct > refDrift.matchPct;
        f.idleFrozen = noDraws;
        f.valid = refMoved && noDraws && idleLagsReference;
        log(`${o.label} frozen-check over ${fmt(FREEZE_OBSERVE_MS)}: `
          + `idle drift ${idleDrift.matchPct.toFixed(3)}%/Δ${idleDrift.maxDelta}, `
          + `reference A drift ${refDrift.matchPct.toFixed(3)}%/Δ${refDrift.maxDelta}, `
          + `draw msgs to ${o.label}: ${draws}`);
        if (!refMoved) log(`  ⚠ reference A did not change — no drawing happened; this window proves nothing`);
        if (!noDraws) log(`  ⚠ ${o.label} still received ${draws} canvas-mutating message(s) while AFK — filtering did not apply`);
        else log(`  (${o.label} received 0 draw messages — filtering engaged; its residual drift is local text fade, not sync)`);
        record(`${o.label}: draw traffic filtered while AFK`, f.valid,
          { idleDrift: f.idleDrift, refDrift: f.refDrift, drawMsgsWhileAfk: draws, refMoved, noDraws, idleLagsReference });
      }

      // ── Mid-stroke AFK: watch the compression actually land ────────────────
      // COMPRESS_USER_STROKES reaches every client (it is NOT in
      // INACTIVE_FILTERED_TYPES, so even the AFK owner gets it) and each one
      // independently commits the in-flight stroke from its own reconstruction
      // of it. Whether those independent commits AGREE has never been measured.
      // Only meaningful if the stroke was in flight to begin with — otherwise
      // "no longer active anywhere" is true on the first tick and reports a
      // commit that never happened.
      if (MID_STROKE && midStroke.userId != null && !midStroke.committedAt
          && Object.values(midStroke.activeAtStart || {}).some((n) => n > 0)) {
        const active = Object.fromEntries(obs.map((o) => [o.label, state[o.label].activeByUser?.[midStroke.userId] || 0]));
        const live = Object.fromEntries(obs.map((o) => [o.label, state[o.label].liveByUser?.[midStroke.userId] || 0]));
        if (Object.values(active).every((n) => n === 0)) {
          midStroke.committedAt = sinceIdle;
          midStroke.liveAtCommit = live;
          midStroke.activeCleared = active;
          const counts = new Set(Object.values(live));
          const agree = counts.size === 1;
          // Committed, or discarded? Only a count that went UP means the stroke
          // survived; unchanged means it was dropped rather than compressed.
          const grew = obs.every((o) => live[o.label] > (midStroke.liveAtStart?.[o.label] ?? 0));
          log(`mid-stroke: ${MID_STROKE}'s in-flight stroke left activeStrokeByUser everywhere at +${fmt(sinceIdle)}`);
          log(`  strokes owned by ${MID_STROKE}: ${JSON.stringify(midStroke.liveAtStart)} → ${JSON.stringify(live)}`
            + `   ${agree ? '(all clients agree)' : '❌ CLIENTS DISAGREE'}`
            + `   ${grew ? '(committed)' : '⚠ count unchanged — the stroke was DISCARDED, not committed'}`);
          record(`mid-stroke: the in-flight stroke committed identically on every client`,
            agree && grew, { liveAtStart: midStroke.liveAtStart, liveAtCommit: live, agree, grew, at: fmt(sinceIdle) });
        }
      }

      // Scheduled returns.
      for (const { o, idle } of idlers) {
        if (returned[o.label] || sinceIdle < idle) continue;
        const wasAfk = state[o.label].afk;
        const countsBefore = state[o.label].counts;
        const before = await snap(o);
        log(`${o.label} returning after ${fmt(sinceIdle)} idle (afk=${wasAfk}) …`);

        // ── Tier 1.1 discriminator ───────────────────────────────────────────
        // A brand-new client joining at this instant rebuilds the board through
        // the SAME checkpoint+tail machinery the returner is about to use. The
        // AFK residual (91.060% @ 12m) and the fresh-joiner residual (93.967%)
        // are suspiciously close and have never been compared to each other; if
        // the returner and the joiner are wrong in the SAME way, there is one
        // rebuild bug and AFK is not a cause. Launched here rather than after
        // the resync — a browser start costs several seconds — so both rebuilds
        // straddle the same board state.
        let discrimPromise = null;
        if (JOIN_ON_RETURN === o.label && !discrim.spawnedAt) {
          discrim.spawnedAt = sinceIdle;
          discrim.against = o.label;
          discrimPromise = spawnObserver(DISCRIM_LABEL, { recordFromJoin: RECORD });
          log(`  spawning fresh joiner ${DISCRIM_LABEL} alongside ${o.label}'s return (Tier 1.1 discriminator)`);
        }

        const syncBefore = (await o.page.evaluate(() => window.__syncLog?.length ?? 0));
        await chatPing(o, `${o.label} back`);

        // AFK must clear, then SyncClient.setInactive(false) force-requests a sync.
        let cleared = false, resynced = false;
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          await sleep(500);
          const s = await getState(o);
          if (!s.afk) cleared = true;
          const sl = await o.page.evaluate(() => window.__syncLog ?? []);
          const after = sl.slice(syncBefore);
          const asked = after.some((e) => e.kind === 'send' && e.detail?.t === MT.SYNC_REQUEST);
          if (cleared && asked && !s.syncing && s.completed) { resynced = true; break; }
          if (cleared && !wasAfk) { resynced = true; break; } // never went AFK: nothing to recover
        }
        await sleep(1500);
        // The feed is still running, so compare against a moving reference until
        // it converges rather than at one arbitrary instant.
        const agree = await waitAgree(A, o, { timeoutMs: 75_000 });
        const d = agree.d;
        const after = agree.b;
        const recovered = diffSnapshots(before, after);   // how much came back
        const recvd = countDelta(countsBefore, (await getState(o)).counts);
        // Did the server's AFK stroke-compression fire for this user while it was
        // dark? It is broadcast to the clients that STAYED, so ask A, not the
        // idler. Only expected once the idler has been AFK for a further 5 min.
        const refDelta = countDelta(freeze[o.label]?.refCounts, (await getState(A)).counts);
        const compressSeen = (refDelta[MT.COMPRESS_USER_STROKES] || 0) > 0;
        const compressDue = (afkAt[o.label] != null) && (sinceIdle - afkAt[o.label] >= 5 * 60_000);
        returned[o.label] = {
          idleMs: sinceIdle, wentAfk: wasAfk, afkAt: afkAt[o.label] ?? null,
          cleared, resynced, pass: d.pass, matchPct: d.matchPct, maxDelta: d.maxDelta,
          repaintPct: recovered.matchPct, inboundOnReturn: recvd,
          compressSeen, compressDue,
        };
        if (compressDue || compressSeen) {
          log(`  AFK stroke-compression for ${o.label}: ${compressSeen ? 'fired' : 'NOT seen'}`
            + ` (due after 5m AFK; ${o.label} was AFK ${fmt(sinceIdle - (afkAt[o.label] ?? sinceIdle))})`);
          record(`${o.label}: server compressed its strokes after 5m AFK`, compressSeen, { compressDue });
        }
        log(`${o.label} back: afkCleared=${cleared} resynced=${resynced} → A↔${o.label} `
          + `${d.matchPct.toFixed(3)}%  maxΔ ${d.maxDelta}  ${d.pass ? '✅' : '❌'}`
          + `  (converged after ${agree.tries} comparison${agree.tries === 1 ? '' : 's'})`);
        // Did the recovery get a CHECKPOINT, or did it degenerate into replaying
        // the whole command tail from seq 0? In an ad-hoc room
        // canPersistSnapshots() is false, so there is no checkpoint and the
        // resync rebuilds the entire session from scratch — a different code
        // path from the one a real room takes, and one that lands on a different
        // bake boundary than peers who baked incrementally. A divergence here is
        // not attributable without knowing which of the two happened.
        const recoveryCheckpoint = (recvd[MT.BOARD_SNAPSHOT_RESTORE] || 0) > 0;
        const replayedMoves = recvd[10] || 0;
        log(`  (canvas repainted ${(100 - recovered.matchPct).toFixed(2)}% of pixels on return; `
          + `checkpoint served: ${recoveryCheckpoint ? 'yes' : 'NO'}; replayed ${replayedMoves} MM)`);
        if (!recoveryCheckpoint) {
          log(`  ⚠ no checkpoint — recovery replayed the tail from seq 0. Room "${ROOM}" is`);
          log(`    unregistered (RoomManager.canPersistSnapshots), so this is NOT the`);
          log(`    recovery path a real room takes; re-run with --room=lobby to attribute.`);
        }
        returnedCheckpoint[o.label] = recoveryCheckpoint;
        record(`${o.label}: AFK actually engaged`, wasAfk, { afkAt: afkAt[o.label] ?? null, idleMs: sinceIdle });
        record(`${o.label}: resync fired on return`, cleared && resynced, { cleared, resynced });
        record(`${o.label}: converged after ${fmt(sinceIdle)} idle`, d.pass,
          { matchPct: d.matchPct, maxDelta: d.maxDelta });
        if (!d.pass) {
          try {
            const url = await A.page.evaluate(generateDiffPngInPage, agree.a, after, PIXEL_TOLERANCE);
            fs.writeFileSync(path.join(RESULTS_DIR, `diff_return_A_${o.label}.png`), Buffer.from(url.split(',')[1], 'base64'));
          } catch {}
        }

        // Did the compressed half-stroke survive the returner's own rebuild?
        // Its resync throws the local board away (`requestSync` calls
        // layerManager.clearAll()) and rebuilds from checkpoint + tail, so the
        // stroke has to come back through the same machinery as everyone else's.
        if (MID_STROKE === o.label && midStroke.userId != null) {
          const s = await getState(o);
          const refOwn = (await getState(A)).liveByUser?.[midStroke.userId] || 0;
          const own = s.liveByUser?.[midStroke.userId] || 0;
          midStroke.onReturn = {
            ownLive: own, incumbentSeesOwn: refOwn, undoable: s.undoable,
            committedAt: midStroke.committedAt != null ? fmt(midStroke.committedAt) : null,
          };
          log(`  mid-stroke on return: ${o.label} owns ${own} live stroke(s), A sees ${refOwn} for it, `
            + `undoable=${s.undoable}`
            + (own === refOwn ? '' : '   ❌ the returner and the incumbent disagree about its own strokes'));
          record(`mid-stroke: ${o.label} and the incumbent agree on ${o.label}'s stroke count after return`,
            own === refOwn, midStroke.onReturn);
        }

        // The discriminator's first reading, taken while the feed still runs.
        // All three snapshots come from ONE Promise.all: taken separately, the
        // bots draw in between and any pair would differ for a reason that is
        // not the bug. The authoritative reading is the settled one in Phase 2;
        // this one shows whether the two rebuilds started out alike.
        if (discrimPromise) {
          const K = await discrimPromise;
          obs.push(K);
          extraActive.push(K);          // or it goes AFK before the run ends
          discrim.K = K;
          const kCounts = await K.page.evaluate(() => window.__msgCounts || {});
          discrim.checkpointServed = (kCounts[MT.BOARD_SNAPSHOT_RESTORE] || 0) > 0;
          const [sA, sR, sK] = await Promise.all([snap(A), snap(o), snap(K)]);
          const dAR = diffSnapshots(sA, sR), dAK = diffSnapshots(sA, sK), dRK = diffSnapshots(sR, sK);
          discrim.atReturn = { [`A_${o.label}`]: pick(dAR), A_K: pick(dAK), [`${o.label}_K`]: pick(dRK) };
          log(`  discriminator @return: A↔${o.label} ${pct(dAR)}   A↔${DISCRIM_LABEL} ${pct(dAK)}   `
            + `${o.label}↔${DISCRIM_LABEL} ${pct(dRK)}`
            + `   (${DISCRIM_LABEL} checkpoint: ${discrim.checkpointServed ? 'yes' : 'NO'})`);
        }
      }

      if (idlers.every(({ o }) => returned[o.label])) break;
      if (sinceIdle > IDLE_2 + 5 * 60_000) { log('⚠ timeline overran its budget — stopping'); break; }
      await sleep(10_000);
    }

    // ── Phase 2: stop the feed, settle, final parity ─────────────────────────
    k6Stop = true;
    const waves = await driver;
    log(`k6 feed stopped after ${waves} wave(s)`);
    await sleep(2500);

    const bundles = [];
    if (RECORD) {
      const tapeDir = path.join(RESULTS_DIR, 'tapes');
      fs.mkdirSync(tapeDir, { recursive: true });
      // Stop every recorder in the SAME tick. Encoding a 190k-delta tape takes
      // ~9s, so stopping them in a loop leaves the last tape's window ~30s
      // longer than the first, and the trailing messages only the later tapes
      // saw read as a delivery difference. Seen: A↔B pixels 100.000% with all
      // 26,348 commit seqs agreeing, yet three bot streams showed 10-13
      // "only in B" messages — purely stop skew.
      const encoded = await Promise.all(obs.map((o) =>
        stopAndEncode(o.page).catch((e) => { log(`⚠ ${o.label}: ${e.message}`); return null; })));
      for (const [i, o] of obs.entries()) {
        const enc = encoded[i];
        if (!enc) { log(`⚠ ${o.label}: recorder returned no bundle`); continue; }
        const file = path.join(tapeDir, `${o.label}.ddraw`);
        fs.writeFileSync(file, Buffer.from(enc.b64, 'base64'));
        bundles.push({ label: o.label, file, deltas: enc.deltas, size: enc.size });
        log(`${o.label} tape: ${enc.deltas} deltas, ${(enc.size / 1024).toFixed(1)} KiB`);
      }
    }

    // Settle every tab first, THEN take all four snapshots in one instant. Taken
    // sequentially, a 45 s settle per tab means the last snapshot is a minute
    // younger than the first — enough for anything still draining to read as a
    // divergence that isn't one.
    await Promise.all(obs.map((o) => waitStable(o)));
    const snapList = await Promise.all(obs.map((o) => snap(o)));
    const snaps = Object.fromEntries(obs.map((o, i) => [o.label, snapList[i]]));
    for (const o of obs) {
      await o.page.screenshot({ path: path.join(RESULTS_DIR, `obs_${o.label}.png`) }).catch(() => {});
    }
    const finalStates = {};
    for (const o of obs) finalStates[o.label] = await getState(o);
    log('final structure: ' + obs.map((o) => {
      const s = finalStates[o.label];
      return `${o.label}[live=${s.strokes} flat=${s.flatRecs} users=${s.users}]`;
    }).join(' '));

    console.log('');
    const finalDiffs = {};
    for (const label of obs.filter((o) => o.label !== 'A').map((o) => o.label)) {
      const d = diffSnapshots(snaps.A, snaps[label]);
      finalDiffs[label] = { pass: d.pass, matchPct: d.matchPct, maxDelta: d.maxDelta };
      const note = label === 'B' ? '   (control — both stayed active)'
        : label === DISCRIM_LABEL ? `   (fresh joiner, spawned at ${discrim.against}'s return)`
        : `   (idled ${fmt(label === 'C' ? IDLE_1 : IDLE_2)})`;
      console.log(`  ${d.pass ? '✅' : '❌'} final A↔${label}: ${d.matchPct.toFixed(3)}%  maxΔ ${d.maxDelta}${note}`);
      if (!d.pass) {
        try {
          const url = await A.page.evaluate(generateDiffPngInPage, snaps.A, snaps[label], PIXEL_TOLERANCE);
          fs.writeFileSync(path.join(RESULTS_DIR, `diff_final_A_${label}.png`), Buffer.from(url.split(',')[1], 'base64'));
        } catch {}
      }
    }
    record('control: A↔B (never idled)', finalDiffs.B.pass, finalDiffs.B);
    record('final: A↔C after return', finalDiffs.C.pass, finalDiffs.C);
    record('final: A↔D after return', finalDiffs.D.pass, finalDiffs.D);

    // ── Tier 1.1: is the AFK residual the same bug as the joiner residual? ───
    // Reported, deliberately NOT part of the pass/fail verdict — it answers
    // "which investigation is this?", it is not a regression gate.
    if (discrim.K) {
      const R = discrim.against;
      const dAR = diffSnapshots(snaps.A, snaps[R]);
      const dAK = diffSnapshots(snaps.A, snaps[DISCRIM_LABEL]);
      const dRK = diffSnapshots(snaps[R], snaps[DISCRIM_LABEL]);
      console.log('');
      console.log(`  Tier 1.1 discriminator — AFK residual vs fresh-joiner residual`);
      console.log(`    A↔${R}   incumbent vs returner        ${dAR.matchPct.toFixed(3)}%  maxΔ ${dAR.maxDelta}  ${dAR.pass ? '✅' : '❌'}`);
      console.log(`    A↔${DISCRIM_LABEL}   incumbent vs fresh joiner    ${dAK.matchPct.toFixed(3)}%  maxΔ ${dAK.maxDelta}  ${dAK.pass ? '✅' : '❌'}`);
      console.log(`    ${R}↔${DISCRIM_LABEL}   returner vs fresh joiner     ${dRK.matchPct.toFixed(3)}%  maxΔ ${dRK.maxDelta}  ${dRK.pass ? '✅' : '❌'}   ← discriminator`);
      // "Same bug or not" is not a yes/no — measure HOW MUCH is shared.
      //
      // Let S_R and S_K be the pixels where the returner and the fresh joiner
      // differ from the incumbent. Where both are wrong in the SAME way they
      // agree with each other, so R↔K differs on the symmetric difference:
      //   |S_R Δ S_K| = |S_R| + |S_K| - 2|S_R ∩ S_K|
      // giving |S_R ∩ S_K| = (|S_R| + |S_K| - |S_R Δ S_K|) / 2.
      // Where they are wrong in DIFFERENT ways on the same pixel they also
      // disagree with each other, which inflates the symmetric difference — so
      // the intersection this yields is a LOWER BOUND on shared error. That is
      // the useful direction: it cannot overstate how much is one bug.
      const errR = 100 - dAR.matchPct;
      const errK = 100 - dAK.matchPct;
      const errRK = 100 - dRK.matchPct;
      const shared = Math.max(0, (errR + errK - errRK) / 2);
      const sharedOfR = errR > 0 ? (shared / errR) * 100 : 0;
      let reading;
      if (dAR.pass && dAK.pass) {
        reading = 'no residual reproduced — both rebuilds match the incumbent, so this run has nothing to attribute';
      } else if (errR < 0.01) {
        reading = `the returner is clean and only the fresh joiner is wrong — this is a JOIN bug, not an AFK one`;
      } else {
        console.log(`    divergence from A: ${R} ${errR.toFixed(3)}% of pixels, ${DISCRIM_LABEL} ${errK.toFixed(3)}%; `
          + `they disagree on ${errRK.toFixed(3)}%`);
        console.log(`    ⇒ at least ${shared.toFixed(3)}% is the SAME divergence `
          + `(${sharedOfR.toFixed(0)}% of ${R}'s error is also in ${DISCRIM_LABEL}'s)`);
        if (sharedOfR >= 70) {
          reading = `MOSTLY ONE BUG: ${sharedOfR.toFixed(0)}% of the AFK returner's divergence is the same divergence a `
            + `fresh joiner has, so the bulk of it is the shared checkpoint+tail rebuild, not AFK. `
            + `${DISCRIM_LABEL} carries a further ${(errK - shared).toFixed(3)}% the returner does not.`;
        } else if (sharedOfR >= 25) {
          reading = `PARTLY SHARED: ${sharedOfR.toFixed(0)}% of the returner's divergence is also the joiner's; `
            + `the remainder is AFK-specific. Both causes are real.`;
        } else {
          reading = `LARGELY SEPARATE: only ${sharedOfR.toFixed(0)}% of the returner's divergence is shared with a fresh `
            + `joiner, so the AFK path fails in its own way on top of the rebuild issue.`;
        }
      }
      console.log(`  → ${reading}`);
      if (!discrim.checkpointServed) {
        console.log(`  ⚠ ${DISCRIM_LABEL} was served NO checkpoint, so its rebuild is not the real join`);
        console.log(`     path and this comparison is not attributable. Use --room=lobby.`);
      }
      try {
        const url = await A.page.evaluate(generateDiffPngInPage, snaps[R], snaps[DISCRIM_LABEL], PIXEL_TOLERANCE);
        fs.writeFileSync(path.join(RESULTS_DIR, `diff_discriminator_${R}_${DISCRIM_LABEL}.png`),
          Buffer.from(url.split(',')[1], 'base64'));
      } catch {}
      results.phases.discriminator = {
        against: R, spawnedAtMs: discrim.spawnedAt, checkpointServed: discrim.checkpointServed,
        atReturn: discrim.atReturn,
        final: { [`A_${R}`]: pick(dAR), A_K: pick(dAK), [`${R}_K`]: pick(dRK) },
        errorPct: { returner: errR, joiner: errK, betweenThem: errRK },
        sharedErrorPct: shared, sharedFractionOfReturnerError: sharedOfR,
        reading,
      };
    }

    // ── Phase 2.5: undo across the AFK boundary (Tier 1.4) ───────────────────
    //
    // Deliberately here, with the feed stopped. While k6 is drawing, another
    // user's live count also FALLS whenever MAX_STROKES_PER_USER overflow bakes
    // their oldest stroke, so a negative delta would not be attributable to the
    // undo. With nothing drawing, every delta is.
    //
    // A no-op is a legitimate outcome: baked strokes are permanently
    // un-undoable, and an idler's strokes can be baked out while it is dark by
    // overflow, by the AFK compression, or by the checkpoint its own resync
    // rebuilds from. Removing another user's stroke is not legitimate.
    if (UNDO_ON_RETURN) {
      const U = byLabel[UNDO_ON_RETURN];
      console.log('');
      const pre = {};
      for (const o of obs) pre[o.label] = await getState(o);
      const selfId = pre[U.label].selfId;
      const ownBefore = pre[U.label].liveByUser?.[selfId] || 0;
      log(`undo across the AFK boundary: ${U.label} (idled ${fmt(UNDO_ON_RETURN === 'C' ? IDLE_1 : IDLE_2)}) `
        + `owns ${ownBefore} live stroke(s), undoable=${pre[U.label].undoable}`);

      await U.page.evaluate(() => window.app?.handleUndo?.());
      await sleep(3500);
      await Promise.all(obs.map((o) => waitStable(o)));
      const post = {};
      for (const o of obs) post[o.label] = await getState(o);

      const deltaByUser = (b, a) => {
        const out = {};
        for (const k of new Set([...Object.keys(b || {}), ...Object.keys(a || {})])) {
          const d = (a?.[k] || 0) - (b?.[k] || 0);
          if (d) out[k] = d;
        }
        return out;
      };
      const dA = deltaByUser(pre.A.liveByUser, post.A.liveByUser);
      const dU = deltaByUser(pre[U.label].liveByUser, post[U.label].liveByUser);
      const othersHit = Object.entries(dA).filter(([uid, d]) => String(uid) !== String(selfId) && d < 0);
      const ownRemoved = -(dA[selfId] || 0);

      log(`  after Ctrl+Z — incumbent A sees ${JSON.stringify(dA)}; ${U.label} sees ${JSON.stringify(dU)}`);
      if (othersHit.length) {
        log(`  ❌ ${U.label}'s undo removed ${othersHit.map(([u, d]) => `${-d} stroke(s) owned by user ${u}`).join(', ')}`);
      } else if (ownRemoved > 0) {
        log(`  ${U.label}'s undo removed ${ownRemoved} of its own stroke(s) — correct`);
      } else {
        log(`  ${U.label}'s undo was a no-op — expected if its strokes were baked while it was dark`);
      }
      record(`undo after AFK: ${U.label}'s undo did not touch another user's strokes`,
        othersHit.length === 0, { incumbentDelta: dA, selfDelta: dU, selfId });

      const reSnap = await Promise.all(obs.map((o) => snap(o)));
      obs.forEach((o, i) => { snaps[o.label] = reSnap[i]; });
      const dPix = diffSnapshots(snaps.A, snaps[U.label]);
      console.log(`  ${dPix.pass ? '✅' : '❌'} post-undo A↔${U.label}: ${dPix.matchPct.toFixed(3)}%  maxΔ ${dPix.maxDelta}`);
      // Only assertable if they agreed BEFORE the undo — otherwise this just
      // re-reports the residual the run already recorded.
      if (finalDiffs[U.label]?.pass) {
        record(`undo after AFK: the room still agrees after ${U.label} undid`, dPix.pass, pick(dPix));
      } else {
        console.log(`     (not asserted — A↔${U.label} already differed before the undo)`);
      }
      results.phases.undoAcrossAfk = {
        label: U.label, ownBefore, undoable: pre[U.label].undoable,
        incumbentDelta: dA, selfDelta: dU, othersHit: othersHit.length,
        pixelBefore: finalDiffs[U.label], pixelAfter: pick(dPix),
      };
    }

    // ── Phase 3: all-AFK snapshot restore ────────────────────────────────────
    if (ALL_AFK) {
      console.log('');
      log(`all-AFK phase: nobody pings for ${fmt(SRV_AFK_TIMEOUT_MS + SRV_AFK_CHECK_MS)}, then the server should `
        + `auto-restore ${fmt(SRV_ALL_AFK_RESTORE_MS)} after the last user goes AFK`);
      const countsBefore = Object.fromEntries(obs.map((o) => [o.label, finalStates[o.label].counts]));
      const beforeSnaps = { ...snaps };
      const deadline = Date.now() + SRV_AFK_TIMEOUT_MS + SRV_AFK_CHECK_MS + SRV_ALL_AFK_RESTORE_MS + 60_000;
      let allAfkAt = null, restoreSeen = false;
      while (Date.now() < deadline) {
        await sleep(15_000);
        const st = {};
        for (const o of obs) st[o.label] = await getState(o);
        const allAfk = obs.every((o) => st[o.label].afk);
        if (allAfk && !allAfkAt) { allAfkAt = Date.now(); log('all four observers are AFK — restore timer running'); }
        restoreSeen = obs.some((o) => (countDelta(countsBefore[o.label], st[o.label].counts)[MT.BOARD_SNAPSHOT_RESTORE] || 0) > 0);
        if (restoreSeen) { log('BOARD_SNAPSHOT_RESTORE received'); break; }
        if (allAfkAt && Date.now() - allAfkAt > SRV_ALL_AFK_RESTORE_MS + 60_000) break;
      }
      record('all-AFK: every observer went AFK', !!allAfkAt, { allAfkAt: allAfkAt && fmt(allAfkAt - T0) });
      record('all-AFK: server auto-restored the board', restoreSeen, {});

      log('bringing everyone back …');
      for (const o of obs) await chatPing(o, `${o.label} back (all-afk)`);
      await sleep(4000);
      const afterSnaps = {};
      await Promise.all(obs.map((o) => waitStable(o)));
      const afterList = await Promise.all(obs.map((o) => snap(o)));
      obs.forEach((o, i) => { afterSnaps[o.label] = afterList[i]; });
      const restoreDiffs = {};
      for (const label of ['B', 'C', 'D']) {
        const d = diffSnapshots(afterSnaps.A, afterSnaps[label]);
        restoreDiffs[label] = { pass: d.pass, matchPct: d.matchPct, maxDelta: d.maxDelta };
        console.log(`  ${d.pass ? '✅' : '❌'} post-restore A↔${label}: ${d.matchPct.toFixed(3)}%  maxΔ ${d.maxDelta}`);
      }
      const changed = diffSnapshots(beforeSnaps.A, afterSnaps.A);
      log(`board changed by the restore: ${(100 - changed.matchPct).toFixed(2)}% of pixels`);
      record('all-AFK: observers agree after restore',
        Object.values(restoreDiffs).every((d) => d.pass), restoreDiffs);
      results.phases.allAfk = { allAfkAt, restoreSeen, restoreDiffs, boardChangedPct: 100 - changed.matchPct };
      Object.assign(snaps, afterSnaps);
    }

    // ── Phase 4: late joiner ─────────────────────────────────────────────────
    let joinPixel = null, joinTape = null, checkpointServed = false;
    if (LATE_JOIN) {
      console.log('');
      log('late joiner J: rebuilding the whole accumulated board from checkpoint + tail …');
      const J = await spawnObserver('J', { recordFromJoin: RECORD });
      obs.push(J);
      const [aAtSync, jAtSync] = await Promise.all([snap(A), snap(J)]);
      const atSync = diffSnapshots(aAtSync, jAtSync);
      log(`at sync-complete: A↔J ${atSync.matchPct.toFixed(3)}%  maxΔ ${atSync.maxDelta}`);

      // Was a join CHECKPOINT actually served? RoomManager.canPersistSnapshots()
      // is `isRegistered() || id === 'lobby'`, and an ad-hoc test room is
      // neither — so SyncCoordinator serves baseSeq 0 and the joiner depends
      // ENTIRELY on the retained command tail. That is not the join path real
      // rooms take, so a divergence here cannot be attributed without also
      // knowing whether the tail still covered the whole board. Detect it (the
      // checkpoint arrives as BOARD_SNAPSHOT_RESTORE) and say so, rather than
      // reporting a product bug that may be an artifact of the test room.
      const jCounts = await J.page.evaluate(() => window.__msgCounts || {});
      checkpointServed = (jCounts[MT.BOARD_SNAPSHOT_RESTORE] || 0) > 0;
      if (!checkpointServed) {
        log(`⚠ no join checkpoint was served — room "${ROOM}" is unregistered, so`);
        log(`  canPersistSnapshots() is false and J got only the retained log tail.`);
        log(`  The joiner comparison below is NOT measurable here; re-run with`);
        log(`  --room=lobby to exercise the real checkpoint+tail join path.`);
      }
      await sleep(2500);
      await Promise.all([waitStable(J), waitStable(A)]);
      const [aSnap, jSnap] = await Promise.all([snap(A), snap(J)]);
      joinPixel = diffSnapshots(aSnap, jSnap);
      for (const [label, o] of [['A', A], ['J', J]]) {
        const s = await getState(o);
        log(`  [struct ${label}] live=${s.strokes} flat=${s.flatRecs} bakedSeqs=${s.bakedSeqs} users=${s.users}`);
      }
      console.log(`  ${joinPixel.pass ? '✅' : '❌'} A↔J: ${joinPixel.matchPct.toFixed(3)}%  maxΔ ${joinPixel.maxDelta}`);
      if (!joinPixel.pass) {
        try {
          const url = await A.page.evaluate(generateDiffPngInPage, aSnap, jSnap, PIXEL_TOLERANCE);
          fs.writeFileSync(path.join(RESULTS_DIR, 'diff_A_J.png'), Buffer.from(url.split(',')[1], 'base64'));
        } catch {}
      }
      if (RECORD) {
        const encJ = await stopAndEncode(J.page).catch(() => null);
        const incumbent = bundles.find((b) => b.label === 'A');
        if (encJ && incumbent) {
          const fileJ = path.join(RESULTS_DIR, 'tapes', 'J.ddraw');
          fs.writeFileSync(fileJ, Buffer.from(encJ.b64, 'base64'));
          const tA = await loadTape(incumbent.file); tA.label = 'A';
          const tJ = await loadTape(fileJ); tJ.label = 'J';
          const jr = await compareTapes([tA, tJ], { ignoreTypes: new Set(['MM', 'MSG']), clipToWindow: false });
          const verdict = joinVerdict(jr);
          // The tape oracle is only MEANINGFUL for a joiner that rebuilt from
          // the command tail alone. When a checkpoint is served, everything at
          // or below its seq arrives as a flat IMAGE and those commands are
          // never sent — so a subsequence check reports the entire pre-checkpoint
          // history as "missing" and always fails. Observed: checkpoint at seq
          // 322,220 with a 74-commit tail, and the oracle duly reported 1,134
          // missing messages. That is the join working, not failing.
          //
          // With a checkpoint, the joiner's only valid oracle is the pixel diff.
          joinTape = {
            ok: verdict.ok, applicable: !checkpointServed,
            droppedByType: verdict.droppedByType, compacted: verdict.compacted.length,
          };
          if (checkpointServed) {
            console.log(`  ℹ tape A↔J: not applicable — a checkpoint was served, so`);
            console.log(`     pre-checkpoint history arrived as an image, not as commands.`);
            console.log(`     (${verdict.dropped.length} "missing" messages are the image's contents.)`);
          } else {
            console.log(`  ${verdict.ok ? '✅' : '❌'} tape A↔J: ${verdict.dropped.length} board-state message(s) missing`);
            if (!verdict.ok) console.log(`     missing: ${JSON.stringify(verdict.droppedByType)}`);
          }
        }
      }
      // Reported, but kept OUT of the pass/fail verdict: this is the already
      // known, already written-up departed-user bake divergence, and letting it
      // fail the run would mask any AFK regression this suite is actually for.
      results.phases.lateJoin = { pixel: joinPixel && { pass: joinPixel.pass, matchPct: joinPixel.matchPct, maxDelta: joinPixel.maxDelta }, tape: joinTape };
    }

    // ── Tape parity ──────────────────────────────────────────────────────────
    // A↔B strict: two clients that were present and active for the entire run
    // must have received byte-identical input. C and D legitimately have holes
    // (that is the filtering working), so their tapes are reported, not asserted.
    let tapeResult = null;
    if (RECORD && bundles.length >= 2) {
      const load = async (label) => {
        const b = bundles.find((x) => x.label === label);
        if (!b) return null;
        const t = await loadTape(b.file); t.label = label; return t;
      };
      const tA = await load('A'), tB = await load('B');
      if (tA && tB) {
        tapeResult = await compareTapes([tA, tB], { ignoreTypes: new Set(['MM', 'MSG']) });
        console.log('\n' + formatReport(tapeResult, { maxDiffs: 12, showCoverage: true }));
        record('control tape: A↔B identical input', tapeResult.ok, { failures: tapeResult.failures });
      }
      for (const label of ['C', 'D']) {
        const tI = await load(label);
        if (!tA || !tI) continue;
        const r = await compareTapes([tA, tI], { ignoreTypes: new Set(['MM', 'MSG']), clipToWindow: false });
        const v = joinVerdict(r);
        console.log(`  ℹ tape A↔${label}: ${v.dropped.length} board-state message(s) never reached ${label}`
          + `  — expected: filtered while AFK, recovered by the resync, not by the tape`);
        results.phases[`tape_${label}`] = { missing: v.dropped.length, byType: v.droppedByType };
      }
    }

    // ── Report ───────────────────────────────────────────────────────────────
    const syncLogs = {};
    for (const o of obs) syncLogs[o.label] = await o.page.evaluate(() => window.__syncLog ?? []).catch(() => []);
    fs.writeFileSync(path.join(RESULTS_DIR, 'sync_events.json'), JSON.stringify(syncLogs, null, 2));
    fs.writeFileSync(path.join(RESULTS_DIR, 'timeline.json'), JSON.stringify(timeline, null, 2));

    results.phases.idle = { returned, afkAt, freeze: Object.fromEntries(Object.entries(freeze).map(([k, v]) => [k, {
      at: v.at, idleDrift: v.idleDrift, refDrift: v.refDrift, drawMsgsWhileAfk: v.drawMsgsWhileAfk,
      valid: v.valid, notApplicable: !!v.notApplicable,
    }])) };
    results.phases.final = finalDiffs;
    if (MID_STROKE) {
      results.phases.midStroke = midStroke;
      if (!midStroke.committedAt) {
        console.log(`\n  ⚠ mid-stroke: ${MID_STROKE}'s in-flight stroke was NEVER compressed.`);
        console.log(`     COMPRESS_USER_STROKES was due at +${fmt(COMPRESS_DUE_AT)} — check the server log`);
        console.log(`     for "Broadcasting COMPRESS_USER_STROKES", and that the stroke was still in`);
        console.log(`     activeStrokeByUser when it fired.`);
        record('mid-stroke: the in-flight stroke was compressed at all', false,
          { dueAt: fmt(COMPRESS_DUE_AT), activeAtStart: midStroke.activeAtStart });
      }
    }
    fs.writeFileSync(path.join(RESULTS_DIR, 'summary.json'), JSON.stringify({
      runId: RUN_ID, room: ROOM, idle1: IDLE_1, idle2: IDLE_2, pingEvery: PING_EVERY,
      vus: VUS, waveDuration: WAVE_DURATION, waves: waveLog, pixelTolerance: PIXEL_TOLERANCE, passPct: PASS_PCT,
      ...results,
    }, null, 2));

    console.log('\n' + '─'.repeat(64));
    for (const c of results.checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}`);
    const allOk = results.checks.every((c) => c.ok);
    console.log('─'.repeat(64));
    if (LATE_JOIN && joinPixel && !joinPixel.pass) {
      console.log(`NOTE: the late joiner diverged (${joinPixel.matchPct.toFixed(2)}%) — that is the`);
      console.log(`      known departed-user bake bug, reported here but NOT failing this run.`);
    }
    console.log(allOk
      ? 'RESULT: clients that idled through 5–10 minutes of drawing recovered correctly ✅'
      : 'RESULT: long-idle recovery is BROKEN ❌ (see the failed checks above)');
    console.log(`Results: ${RESULTS_DIR}`);
    console.log('─'.repeat(64));
    process.exitCode = allOk ? 0 : 1;
  } finally {
    k6Stop = true;
    for (const o of obs) await o.browser.close().catch(() => {});
  }
}

main().catch((err) => {
  if (err?.name === 'BaselineGateError') {
    console.error(`\n─ ABORTED ${'─'.repeat(52)}\n${err.message}\n`
      + `Nothing was measured. This is the gate working: a run started from an\n`
      + `unequal board cannot attribute what it finds to AFK.\n${'─'.repeat(63)}`);
    process.exit(3);
  }
  console.error('Uncaught:', err);
  process.exit(2);
});
