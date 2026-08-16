#!/usr/bin/env node
/**
 * @fileoverview "Do all users see the k6 bot strokes identically?" check.
 *
 * Spins up FOUR independent live observer browsers in the same room (--observers=N
 * to change), then runs the real `testing/low_stress_test.js` k6 script flooding
 * that room with the full tool mix across all three layers, undo+redo, and every
 * selection verb. After the feed winds down it pixel-diffs the observers against
 * each other with the shared layerDiff oracle.
 *
 * Each observer is its OWN browser process (not background tabs in one browser)
 * so none gets background-throttled — every tab keeps ticking, which is required
 * for remote draws to render. Math.random is pinned to the same seed in all of
 * them so RNG-driven render jitter (soft edges, etc.) can't masquerade as a
 * sync fault.
 *
 * FOUR ORACLES, deliberately reported separately — folding any of them into the
 * others hides the case it exists to catch:
 *
 *   pixels   observers agree on the rendered board
 *   tape     observers received the same bytes (exact; names the message)
 *   replay   each observer's own tape replays back to its own live board
 *   coverage the traffic actually contained the tools/layers/verbs claimed
 *
 * Coverage is the one that is easy to dismiss and shouldn't be: agreement on a
 * board that only ever saw one tool on one layer is perfect agreement, so a feed
 * that quietly stops exercising something makes every other number look better.
 *
 * TAPE PARITY. Each observer also records its own .ddraw for the whole feed, and
 * the tapes are diffed at the wire level (testing/lib/tapeDiff.mjs) alongside the
 * pixel diff. Observers are the ideal subject for this: they only ever *receive*,
 * so their tapes have none of the outbound-vs-inbound asymmetry a drawer's tape
 * has — any difference at all is a genuine delivery difference. Reading the two
 * oracles together is what makes a failure actionable:
 *
 *   tapes agree + pixels agree  → converged
 *   tapes agree + pixels differ → renderer/ordering bug inside one client
 *   tapes differ                → transport bug; the pixel diff is the symptom
 *
 * Run the rate-limit-free server first (8 VUs trip the normal limits):
 *   npm run dev:stress
 *   node testing/devtools/k6_lowstress_observers.mjs
 *   node testing/devtools/k6_lowstress_observers.mjs --headed --vus=4 --duration=40s
 *   node testing/devtools/k6_lowstress_observers.mjs --vus=3 --duration=25s  (low, quick)
 *   node testing/devtools/k6_lowstress_observers.mjs --no-record             (pixels only)
 *   node testing/devtools/k6_lowstress_observers.mjs --no-pattern           (drop image-backed brushes)
 *   node testing/devtools/k6_lowstress_observers.mjs --no-bake              (diagnostic; see below)
 *
 * ── READ THIS BEFORE QUOTING A NUMBER FROM ONE RUN ──────────────────────────
 *
 * The result is BIMODAL and a fixed --seed does not pin it. Four runs of the
 * identical 30s command (seed 1001) produced 100.000/99.827/99.999,
 * 99.988/99.677/99.988, 99.845 x3 — and then 95.514/92.624/92.507 with all four
 * clients resyncing and their stroke counts diverging. Same feed, same machine,
 * no server bloat. Run it at least three times and report the distribution; a
 * single green run is not evidence of anything.
 *
 * The cliff is reliably reachable: a 60s feed spans TWO bot cohorts (each VU's
 * socket lasts ~65s, so `duration: 1m` yields u4-u11 then u12-u19, the first
 * eight disconnecting at ~66s). Every 60s run lands at 96-97% with only the
 * SECOND cohort's streams diverging. 30s stays inside one cohort.
 *
 * `--no-bake` is a DIAGNOSTIC, never a way to pass: it lifts
 * LayerManager.MAX_STROKES_PER_USER out of reach so the irreversible overflow
 * bake never fires. Keep those runs short — without baking the strokeStack grows
 * without bound and _compositeGroupSequential walks all of it, which pushed each
 * observer past 1.5 GB and pegged its CPU on a 60s feed. The cheap version is
 * always on instead: every run reports bake-order violations (a commit arriving
 * with seq <= the client's already-baked watermark), which is the exact
 * precondition for permanent, unrecoverable divergence.
 */

import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  PIXEL_TOLERANCE, PASS_PCT,
  captureLayerSnapshotsInPage,
  captureReplayLayerSnapshotsInPage,
  diffSnapshots,
  generateDiffPngInPage,
  makeStructureEvaluator,
  makeCompositeEvaluator,
} from '../lib/layerDiff.mjs';
import { loadTape, compareTapes, formatReport, joinVerdict } from '../lib/tapeDiff.mjs';
// Exact bake oracle. The pixel diff can only see the SHADOW of a bake
// disagreement, at a resolution coarser than the effect being measured; this
// records what each client actually flattened, by identity and in order, so the
// comparison is a pair of integers instead of a percentage.
import {
  installBakeLedgerInPage,
  captureBakeLedgerInPage,
  compareBakeLedgers,
  formatBakeLedgerReport,
} from '../lib/bakeLedger.mjs';
// Tool id -> name, shared with the feed so the coverage report can't drift from
// the enum the bots actually send.
import { TOOL_NAMES } from '../_k6_actions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const WS_URL     = process.env.WS_URL     || 'ws://127.0.0.1:8030';
const CODEC_URL = '/shared/ddrawCodec.js';
let   HEADLESS   = process.env.HEADLESS !== 'false';
let   VUS = null, DURATION = null;
let   RECORD = true;   // capture a .ddraw per observer and diff the tapes
let   KEEP_MM = false; // include cursor moves in the tape diff (very noisy here)
// Soak knobs. Multiple waves against the SAME room and the SAME observers is
// the point: a single 25s wave never crosses MAX_STROKES_PER_USER (20), so the
// overflow-bake path — the live counterpart of the replay eager-bake bug — is
// never exercised. Several waves push every bot past it while the observers
// keep ticking, and a joiner at the end has to rebuild all of it.
let   WAVES = 1;
let   LATE_JOIN = false;
let   NO_BLEND = false;   // keep every stroke source-over (isolates blend baking)
// Drop every image-backed brush: the PATTERN and IMAGE_BRUSH tools plus the
// pattern-fill checkbox on fill/select. Those are the only content whose render
// waits on an `Image.onload` in the receiver, so toggling this splits an
// observer divergence into "async brush decode" vs "everything else" — the same
// role --no-blend plays for bake behaviour.
let   NO_PATTERN = false;
// Diagnostic ONLY — never a way to make a run pass. Pushes
// LayerManager.MAX_STROKES_PER_USER out of reach on every observer so the
// overflow bake never fires. Baking is the single irreversible step in the
// pipeline, so this separates "clients disagree about stroke order" from
// "clients disagree about when to flatten it".
let   NO_BAKE = false;
// A/B control for the inbound-queue bake deferral. It ships DISABLED (it did not
// beat its control — see LayerManager.BAKE_DEFER_ENABLED), so this flag turns it
// ON. Unlike --no-bake it does not disable baking at all; it only holds the
// overflow bake while inbound commits are still queued, so both arms are
// directly comparable at the same concurrency.
//
// Read the two arms across SEVERAL interleaved runs, never blocked ON-then-OFF:
// blocked runs made the deferral look 1.5 points worse and interleaving reversed
// the sign. This suite's bimodality is larger than the effect.
let   BAKE_DEFER = false;
// ── Asymmetric lag injection ────────────────────────────────────────────────
// The bake-defer theory is that clients trail the stream by DIFFERENT amounts and
// therefore flatten different prefixes. An unthrottled run of four identical
// browsers on one machine is the worst possible place to observe that, so these
// make the observers unequal on purpose. Per-observer, index-aligned with
// OBSERVERS; a short list is padded with "no lag".
//
// TWO LEVERS, because they are not interchangeable — measured with
// testing/devtools/ws_latency_probe.mjs, which exists to stop this being assumed:
//
//   --cpu-lag=1,2,4,6   Emulation.setCPUThrottlingRate. The inbound drain runs
//                       on an 8ms-per-frame budget, so slowing the renderer
//                       makes messages arrive faster than they can be applied
//                       and _messageQueue GROWS. This is the only lever that
//                       moves getInboundQueueLength(), i.e. the only one the
//                       deferral can actually respond to.
//   --net-lag=0,0,200,600   Network.emulateNetworkConditions downloadThroughput,
//                       in KB/s (0 = uncapped). Verified to apply to established
//                       WebSocket frames. Makes a client trail in stream
//                       POSITION — but delivery stays rate-limited, so the queue
//                       does not build and the deferral is blind to it. That is
//                       a finding in its own right, not a broken knob.
//
// The `latency` field of emulateNetworkConditions is deliberately NOT exposed:
// it throttles the HTTP upgrade only and does nothing to frames on an
// established socket, so a flag for it would configure a lag and apply none.
let   CPU_LAG = null;
let   NET_LAG = null;
// Diagnostic: patch LayerManager.isLayerEmptyThroughSeq so it also counts
// bakedSequences. The shipped version consults only flatCanvas and strokeStack,
// so a layer whose strokes have all been compressed by _compressStrokesToGroup
// (which splices them OUT of strokeStack and does NOT create a flatCanvas) is
// declared empty — and getCheckpointSnapshotPixels then stores a zero-length
// payload for it. Verified against a real bundle: layers 1 and 2 were 0 bytes
// while holding 31 and 28 compressed runs. This flag validates the fix WITHOUT
// editing product source.
let   FIX_EMPTY_LAYER = false;
// Filled in per wave from each observer's in-page probe; also written to summary.json.
let   bakeViolations = {};
// Per-observer live-stack depth + heap at settle; see the collection site.
let   bakeCost = {};
// Cross-observer comparison of what each client irreversibly flattened. See
// testing/lib/bakeLedger.mjs — this is the oracle that can actually resolve a
// bake disagreement, as opposed to inferring one from a pixel percentage.
let   bakeLedger = null;
// Evidence that the configured lag actually happened — inbound queue depth and
// cross-client stream skew. See the collection site for why a run without this
// is worse than a run with no lag at all.
let   lagReport = null;
// Per-observer console-error tally, keyed by label. Populated by the console
// listener in makeObserver.
const consoleDrops = {};
// Message text fragments that mean "a message or asset was discarded and the
// client carried on". Deliberately narrow: a broad filter buries the signal.
const DROP_PATTERNS = [
  'Failed to decode batched message',
  'Failed to decode message',
  'Failed to load brush image',
  'Failed to load GIH image',
  'Failed to parse pattern payload',
  'Failed to parse brush payload',
  'Failed to get active layer context',
];
let   UNDO_WEIGHT = null;
let   SPECIAL_CHANCE = null;
// Restrict the feed's special pool to named actions — the only way to feed
// "plain strokes plus exactly one class", since every special shares one
// SPECIAL_CHANCE gate. Used by joiner_content_bisect.mjs.
let   SPECIAL_ONLY = null;
// Ad-hoc by default — but note RoomManager.canPersistSnapshots() is
// `isRegistered() || id === 'lobby'`, so an invented room name NEVER gets a join
// checkpoint: SyncCoordinator serves baseSeq 0 and `--join` measures a full-tail
// replay instead of the checkpoint+tail path a real room takes. Any joiner
// percentage from the default room is therefore not attributable. Use
// --room=lobby (against a snapshot-backed backend) for the real path.
let   ROOM_ID = null;
// Four observers, not three. Three is enough to tell "A disagrees with everyone"
// from "A and B agree, C is odd", but with a fourth the majority survives losing
// one — which matters because these runs routinely have one client mid-resync.
let   OBSERVER_COUNT = 4;
// Replay each observer's own tape and diff it against that observer's own live
// canvas. The tape oracle proves the four received the same bytes; the pixel
// oracle proves they rendered the same board. Neither says the RECORDING of
// that board replays back to it, and that is what ships in .ddraw exports.
let   REPLAY_PARITY = true;
let   SEED = null;
let   LAYERS = null, TOOLS = null, REDO_CHANCE = null;
// Coverage gate: fail the run if the feed never actually exercised the tools,
// layers and verbs it advertises. Without this "we test all tools" is a claim
// about the feed's source code, not about the traffic that ran.
let   REQUIRE_COVERAGE = true;
// Diagnostic, mirroring replay_parity_suite's flag. TimeMachine marks every user
// who never undoes in a tape as "eager bake", which flattens their strokes into
// flatCanvas immediately instead of at the MAX_STROKES_PER_USER threshold.
// flatCanvas composites UNDERNEATH the whole strokeStack, so hoisting a stroke
// into it changes z-order against any stroke that stayed in the stack. Running
// with and without this separates "the ReplayEngine applied the wrong messages"
// from "it baked them differently", which is the first thing to try on any
// live↔replay divergence.
let   NO_EAGER_BAKE = false;
for (const a of process.argv.slice(2)) {
  if (a === '--headed') HEADLESS = false;
  else if (a === '--no-record') RECORD = false;
  else if (a === '--keep-mm') KEEP_MM = true;
  else if (a === '--join') LATE_JOIN = true;
  else if (a === '--no-blend') NO_BLEND = true;
  else if (a === '--no-pattern') NO_PATTERN = true;
  else if (a === '--no-bake') NO_BAKE = true;
  else if (a === '--bake-defer') BAKE_DEFER = true;
  else if (a === '--lag') CPU_LAG = '1,2,4,6';
  else if (a.startsWith('--cpu-lag=')) CPU_LAG = a.slice(10);
  else if (a.startsWith('--net-lag=')) NET_LAG = a.slice(10);
  else if (a === '--fix-empty-layer') FIX_EMPTY_LAYER = true;
  else if (a === '--no-replay-parity') REPLAY_PARITY = false;
  else if (a === '--no-coverage-gate') REQUIRE_COVERAGE = false;
  else if (a === '--no-eager-bake') NO_EAGER_BAKE = true;
  else if (a.startsWith('--observers=')) OBSERVER_COUNT = Math.max(2, Math.min(6, Number(a.slice(12))));
  else if (a.startsWith('--waves='))    WAVES = Math.max(1, Number(a.slice(8)));
  else if (a.startsWith('--undo-weight=')) UNDO_WEIGHT = a.slice(14);
  else if (a.startsWith('--special-chance=')) SPECIAL_CHANCE = a.slice(17);
  else if (a.startsWith('--special-only=')) SPECIAL_ONLY = a.slice(15);
  else if (a.startsWith('--redo-chance=')) REDO_CHANCE = a.slice(14);
  else if (a.startsWith('--layers=')) LAYERS = a.slice(9);
  else if (a.startsWith('--tools=')) TOOLS = a.slice(8);
  else if (a.startsWith('--seed=')) SEED = a.slice(7);
  else if (a.startsWith('--room='))     ROOM_ID = a.slice(7);
  else if (a.startsWith('--vus='))      VUS = a.slice(6);
  else if (a.startsWith('--duration=')) DURATION = a.slice(11);
  else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
}

const FEED = path.join(__dirname, '..', 'low_stress_test.js');
const ROOM = ROOM_ID || `lowstress_obs_${Date.now()}`;
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const RESULTS_DIR = path.join(__dirname, '..', 'sync_results', `lowstress_${RUN_ID}`);
const OBSERVERS = ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, OBSERVER_COUNT);
/** Parse a per-observer lag list, padded with `pad` for observers past its end. */
function lagList(spec, pad) {
  if (!spec) return OBSERVERS.map(() => pad);
  const nums = spec.split(',').map((s) => Number(s.trim()));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) {
    console.error(`Bad lag spec "${spec}" — expected comma-separated non-negative numbers`);
    process.exit(2);
  }
  return OBSERVERS.map((_, i) => (i < nums.length ? nums[i] : pad));
}
const CPU_RATES = lagList(CPU_LAG, 1);
const NET_CAPS  = lagList(NET_LAG, 0);
const LAG_ON    = CPU_RATES.some((r) => r > 1) || NET_CAPS.some((c) => c > 0);
// Lag must be UNEQUAL to test the theory. Four clients all throttled 4x trail the
// stream together and bake the same prefix, which would look like a pass for
// exactly the wrong reason.
const LAG_ASYMMETRIC = new Set(CPU_RATES).size > 1 || new Set(NET_CAPS).size > 1;
/** Every observer except the reference — the pairs that get diffed against A. */
const PEERS = OBSERVERS.slice(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function spawnObserver(label, { recordFromJoin = false } = {}) {
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 760 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (err) => process.stderr.write(`  [${label} ERR] ${err.message}\n`));
  // Console errors, not just uncaught throws. The client has several paths that
  // swallow a message and carry on with nothing but a console.error — the batch
  // drain's `catch { console.error('Failed to decode batched message'); continue; }`
  // discards that commit outright, and the brush loaders log and give up. Those
  // are exactly the silent-omission shapes `debug.parity_events` reports as
  // missingStrokes, and until now the suite could not see any of them.
  consoleDrops[label] = { total: 0, byPattern: {}, samples: [] };
  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    const text = msg.text();
    const hit = DROP_PATTERNS.find((p) => text.includes(p));
    if (!hit) return;
    const rec = consoleDrops[label];
    rec.total++;
    rec.byPattern[hit] = (rec.byPattern[hit] || 0) + 1;
    if (rec.samples.length < 4) rec.samples.push(text.slice(0, 160));
  });
  // Pin Math.random to the same seed across all observers — isolates message
  // delivery from RNG render jitter.
  await page.evaluateOnNewDocument(() => {
    let seed = 0x1f2e3d4c;
    Math.random = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  });
  // Sync-event probe. The tape only records draw traffic, so when an observer
  // is re-served mid-run (a resync, a reconnect, a parity mismatch) the tape
  // shows the *consequence* — a burst of tool-state + in-flight MD replayed to
  // that client alone — with no trace of the cause. This records the cause.
  await page.evaluateOnNewDocument(() => {
    window.__syncLog = [];
    const note = (kind, detail) => window.__syncLog.push({ t: Date.now(), kind, detail });
    const hook = () => {
      const ws = window.app?.wsClient;
      if (!ws || ws.__probed) return !!ws?.__probed;
      ws.__probed = true;
      const origSend = ws.send.bind(ws);
      ws.send = (msg) => {
        // 41 = SYNC_REQUEST, 44 = SYNC_COMPLETE, 137/139 = parity check/mismatch,
        // 143 = SYNC_PARITY_RESYNC_REQUEST — the one that says a client decided
        // its own board was wrong and asked to be re-served. (This list used to
        // read 60/61, which are UNDO/REDO: observers never send those, so the
        // section could not report a resync even when one happened.)
        if (msg && [41, 44, 137, 139, 143].includes(msg.t)) note('send', { t: msg.t, seq: msg.seq });
        return origSend(msg);
      };
      const origOn = ws.emit?.bind(ws);
      if (origOn) {
        ws.emit = (event, data) => {
          if (/sync|parity|checkpoint|connect|left|resync/i.test(event)) {
            note('recv', { event, session: data?.sessionIndex ?? data?.u });
          }
          return origOn(event, data);
        };
      }
      return true;
    };
    const iv = setInterval(() => { if (hook()) clearInterval(iv); }, 50);
  });

  // Count EVERY inbound message type, including the sync handshake. The replay
  // tape deliberately excludes sync traffic (see messageAllowlist.js), so a
  // joiner's bulk state transfer is INVISIBLE to the tape oracle — which is how
  // "tapes agree but pixels differ" is possible at all. This counts what the
  // tape cannot see.
  //
  // HOOK `_processMessage`, NOT `handleMessage`. The server coalesces messages
  // into batched frames, and `onmessage` routes those to `_decodeBatchedFrame`
  // → `_messageQueue` → `_processMessageQueue` → `_processMessage`, never
  // touching `handleMessage` at all. A `handleMessage` hook therefore sees only
  // the unbatched minority: measured on a 3-VU run it caught 3 of 160 CT and 24
  // of 214 CL, while reporting the low-frequency types (SEL_*, UNDO/REDO)
  // perfectly — which is exactly the pattern that makes the error invisible,
  // since the types you tend to eyeball are the ones that happen to be right.
  // `_processMessage` is the single drain point both paths converge on.
  await page.evaluateOnNewDocument(() => {
    window.__msgCounts = {};
    const hook2 = () => {
      const ws = window.app?.wsClient;
      if (!ws || ws.__counted) return !!ws?.__counted;
      const orig = ws._processMessage?.bind(ws);
      if (!orig) return false;
      ws.__counted = true;
      ws._processMessage = (data) => {
        const t = data?.t;
        if (t != null) window.__msgCounts[t] = (window.__msgCounts[t] || 0) + 1;
        // Highest authoritative seq this client has APPLIED. Sampled on a timer
        // below to give each observer a position-vs-time trace, which is how the
        // harness proves clients are actually trailing each other rather than
        // merely being configured to.
        const s = Number(data?.seq) || 0;
        if (s > (window.__maxAppliedSeq || 0)) window.__maxAppliedSeq = s;
        return orig(data);
      };
      return true;
    };
    const iv2 = setInterval(() => { if (hook2()) clearInterval(iv2); }, 50);
  });

  // Coverage probe. `__msgCounts` above answers "which message types arrived";
  // this answers "which FEATURES did they carry" — the tools actually selected,
  // the layers actually drawn on, the blend modes actually applied, the
  // selection verbs actually issued.
  //
  // This exists because the feed's claims and the feed's traffic had already
  // diverged once without anyone noticing: shape draw mode was advertised in the
  // tool mix, sent on every shape stroke, and silently discarded by the receiver
  // because it travelled in the wrong field. A suite that only counts message
  // types reports that run as full coverage. Reading the decoded VALUES is the
  // only way the harness can tell a feature was exercised rather than merely
  // mentioned.
  await page.evaluateOnNewDocument(() => {
    window.__coverage = {
      tools: {}, layers: {}, blendModes: {}, verbs: {},
      shapeModes: {}, textKinds: {}, eraseAll: 0, pressure: 0, stampRadii: 0,
      fillWithExpansion: 0, fillPlain: 0, undo: 0, redo: 0,
      // DECODED VALUES, not just presence. The static wire audit compares field
      // NAMES, so it cannot see an offset-encoding bug: `CSIM {sim: 1|0}` is a
      // perfectly valid field carrying a value that means "false or unset" under
      // the wire's `0=unset 1=false 2=true` encoding, so simulate-pressure was
      // never once true and nothing could tell. Recording the decoded booleans
      // is the only way a harness catches that class.
      simPressure: {}, thinning: {},
      // Pattern/image brushes, recorded as "is this payload actually loadable"
      // rather than "did a GPT/GMP arrive". Both brushes are applied on the
      // receiver by `new Image(); img.src = brushData.gimpUrl` (or a Blob built
      // from svgContent), reached only when `type` is gbr/image/svg — and for
      // the pattern brush, only when the payload has a `brush` key at all.
      // A payload missing any of that is accepted silently and then paints
      // NOTHING, which is how both tools sat in the tools[] coverage list for
      // this feed's whole history while contributing zero pixels. Counting the
      // message would reproduce exactly that blind spot, so count the shape.
      patternBrushLoadable: {}, imageBrushLoadable: {}, patternFillMode: {},
    };
    const bump = (bucket, key) => {
      const c = window.__coverage[bucket];
      if (c) c[key] = (c[key] || 0) + 1;
    };
    const hook3 = () => {
      const ws = window.app?.wsClient;
      if (!ws || ws.__covered) return !!ws?.__covered;
      // `_processMessage`, for the batched-frame reason explained on the counter
      // probe above. Chains onto whatever is current so the two compose.
      const prev = ws._processMessage?.bind(ws);
      if (!prev) return false;
      ws.__covered = true;
      ws._processMessage = (data) => {
        try {
          const t = data?.t;
          if (t === 15) bump('tools', String(data.l ?? 0));          // CT
          if (t === 15 && data.a) window.__coverage.eraseAll++;
          if (t === 58) bump('layers', String(data.ly ?? 0));        // CL
          if (t === 11) {                                             // MD
            if (data.ly !== undefined) bump('layers', String(data.ly));
            if (data.bm) bump('blendModes', String(data.bm));
            if (data.rs && data.rs.length) window.__coverage.stampRadii++;
          }
          if (t === 10 && data.rs && data.rs.length) window.__coverage.stampRadii++; // MM
          if (t === 59) bump('blendModes', String(data.bm || 'source-over'));        // CBM
          if (t === 91) bump('shapeModes', String(data.sdm || 'unset'));             // CSDM
          if (t === 13) window.__coverage.pressure++;                                 // CP
          // Decode exactly as the client does, so the bucket reflects what the
          // receiver believed, not what the sender meant.
          if (t === 72) bump('simPressure', String((data.sim ?? 0) === 2));            // CSIM
          if (t === 71) bump('thinning', String(data.th ? data.th - 1 : 50));          // CTHN
          if (t === 60) window.__coverage.undo++;                                     // UNDO
          if (t === 61) window.__coverage.redo++;                                     // REDO
          if (t === 84) bump('patternFillMode', String(!!data.pm));                   // CPM
          // Mirror the receiver's own acceptance test rather than re-stating it:
          // pattern needs payload.brush, image brush is the payload itself, and
          // either way a loadable source means a decodable gimpUrl or svgContent
          // under a recognised type.
          const loadable = (b) => !!b && (b.type === 'gbr' || b.type === 'image' || b.type === 'svg')
            && !!(b.gimpUrl || b.svgContent);
          if (t === 82 || t === 23) {                                                  // GPT / GMP
            let parsed = null;
            try { parsed = typeof data.g === 'string' ? JSON.parse(data.g) : data.g; } catch (_) { parsed = null; }
            const brush = t === 82 ? (parsed && parsed.brush) : parsed;
            bump(t === 82 ? 'patternBrushLoadable' : 'imageBrushLoadable', String(loadable(brush)));
          }
          if (t === 73) {                                                             // FILL
            if ((data.s || 0) !== 0 || (data.br || 0) !== 0) window.__coverage.fillWithExpansion++;
            else window.__coverage.fillPlain++;
          }
          if (t === 90) bump('textKinds', data.textPixel ? 'pixel' : 'overlay');      // TEXT_APPLY
          const VERBS = {
            30: 'SEL_LIFT', 31: 'SEL_MOVE', 32: 'SEL_COMMIT', 33: 'SEL_DELETE',
            34: 'SEL_FILL', 35: 'SEL_STAMP', 36: 'SEL_CANCEL', 67: 'SEL_FLIP',
            93: 'SEL_MASK', 136: 'SEL_MERGE',
          };
          if (VERBS[t]) {
            bump('verbs', VERBS[t]);
            // A lasso lift carries its polygon in `cr`; a rect lift does not.
            if (t === 30) bump('verbs', (data.cr && data.cr.length >= 6) ? 'SEL_LIFT_lasso' : 'SEL_LIFT_rect');
          }
        } catch { /* never let the probe break delivery */ }
        return prev(data);
      };
      return true;
    };
    const iv3 = setInterval(() => { if (hook3()) clearInterval(iv3); }, 50);
  });

  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });
  // Arm before joining so the tape captures the entire sync serve.
  if (recordFromJoin) await startRecording(page);
  // Raise the overflow-bake threshold out of reach, so strokes stay in the live
  // (seq-ordered) strokeStack for the whole run instead of being flattened into
  // flatCanvas.
  //
  // This is the control for the one place stroke ORDER can be lost permanently.
  // _sortStrokeStack keeps the live stack ordered by authoritative seq, so a
  // commit that arrives late still lands in the right place — but baking
  // resolves the bottom of that stack against whatever is beneath it AT BAKE
  // TIME, and flatCanvas then composites underneath the entire stack. A commit
  // that shows up after a bake covering higher seqs (exactly what a parity
  // resync re-delivers) can therefore never be put back underneath it.
  // LayerManager's own comment states the requirement — "every client must
  // flatten the SAME prefix in the SAME global order" — but the only guard,
  // _hasUnconfirmedLocalStroke, covers unconfirmed LOCAL strokes, and an
  // observer never draws, so nothing defers a bake for a remote commit still in
  // flight. If parity stops falling off its cliff with baking disabled, that is
  // the mechanism.
  if (NO_BAKE) {
    const applied = await page.evaluate(() => {
      const lm = window.app?.board?.layerManager;
      if (!lm?.constructor) return false;
      lm.constructor.MAX_STROKES_PER_USER = Number.MAX_SAFE_INTEGER;
      return lm.constructor.MAX_STROKES_PER_USER > 1e6;
    });
    if (!applied) throw new Error(`observer ${label}: --no-bake could not reach LayerManager (test would silently measure nothing)`);
    // Fair warning: without the overflow bake the strokeStack grows without
    // bound and _compositeGroupSequential walks every stroke, so a 60s feed
    // pushes each observer past ~1.5 GB and pegs its CPU. That starvation is
    // itself a divergence source, which makes long --no-bake runs useless as a
    // control. Keep them short.
  }

  // Peak live-stack sampler. The end-of-run reading is always ~0 (the feed has
  // stopped, the queue has drained and everything has baked), so it says nothing
  // about what the deferral actually cost while traffic was flowing. Sample
  // during the run and keep the max.
  await page.evaluate(() => {
    if (window.__stackPeakTimer) return;
    window.__stackPeak = 0;
    window.__heapPeakMB = 0;
    // Inbound-queue depth over time. This is the quantity _shouldDeferBakeForInbound
    // actually reads, so it is the only honest proof that a lag setting reached
    // the mechanism under test: a run whose queue never leaves 0 did not exercise
    // the deferral, no matter what was configured on the command line.
    window.__lagTrace = [];
    window.__maxAppliedSeq = window.__maxAppliedSeq || 0;
    window.__stackPeakTimer = setInterval(() => {
      const lm = window.app?.board?.layerManager;
      // Sample the queue FIRST and unconditionally — an early return here (the
      // layerGroups guard used to cover the whole body) would silently drop the
      // samples taken before the board exists, which is exactly the window where
      // a join flood builds the deepest queue.
      const q = window.app?.wsClient?.getInboundQueueLength?.();
      if (typeof q === 'number') {
        window.__lagTrace.push({ t: Date.now(), q, seq: window.__maxAppliedSeq || 0 });
      }
      if (performance?.memory) {
        const mb = Math.round(performance.memory.usedJSHeapSize / 1048576);
        if (mb > window.__heapPeakMB) window.__heapPeakMB = mb;
      }
      if (!lm?.layerGroups) return;
      for (const g of lm.layerGroups) {
        const n = g.strokeStack?.length || 0;
        if (n > window.__stackPeak) window.__stackPeak = n;
      }
    }, 100);
  });

  // Per-observer lag. Applied AFTER the page is up but BEFORE the room join, so
  // the join sync itself runs under the same conditions as the rest of the run.
  //
  // The late joiner ('J') is deliberately NOT in OBSERVERS, so indexOf gives -1
  // and it runs unthrottled. That is intended: the join test measures whether a
  // checkpoint rebuilds faithfully, and lagging the joiner would confound that
  // with the thing this harness is manipulating.
  const lagIdx = OBSERVERS.indexOf(label);
  const cpuRate = CPU_RATES[lagIdx] ?? 1;
  const netCap = NET_CAPS[lagIdx] ?? 0;
  if (cpuRate > 1 || netCap > 0) {
    const cdp = await page.createCDPSession();
    if (netCap > 0) {
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        // `latency` is left at 0 on purpose: it throttles the HTTP upgrade only
        // and provably does nothing to frames on an established socket
        // (testing/devtools/ws_latency_probe.mjs). Setting it would buy a
        // convincing-looking number and no actual lag.
        latency: 0,
        downloadThroughput: netCap * 1024,
        uploadThroughput: netCap * 1024,
      });
    }
    // Last, because throttling the CPU also slows every CDP round-trip above it.
    if (cpuRate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  }

  if (BAKE_DEFER) {
    const applied = await page.evaluate(() => {
      const lm = window.app?.board?.layerManager;
      if (!lm?.constructor) return false;
      lm.constructor.BAKE_DEFER_ENABLED = true;
      return lm.constructor.BAKE_DEFER_ENABLED === true;
    });
    if (!applied) throw new Error(`observer ${label}: --bake-defer could not reach LayerManager (test would silently measure nothing)`);
  }

  // Bake-order violation probe. Always on: it is a handful of comparisons and it
  // measures the exact precondition for permanent divergence, so it costs
  // nothing and turns "the boards differ" into "here is why".
  //
  // A commit arriving with an authoritative seq at or below this client's baked
  // watermark can never be placed correctly: _compositeGroupSequential renders
  // flatCanvas/bakedSequences BEFORE group.strokeStack, so anything landing in
  // the live stack draws on top of baked content no matter how low its seq is,
  // and baking is irreversible. Nothing in the product checks for this —
  // importStroke just pushes and re-sorts, and _bakeOverflowStrokes only defers
  // for unconfirmed LOCAL strokes (an observer never draws, so it never defers).
  if (FIX_EMPTY_LAYER) {
    const ok = await page.evaluate(() => {
      const lm = window.app?.board?.layerManager;
      const proto = lm && Object.getPrototypeOf(lm);
      if (!proto || typeof proto.isLayerEmptyThroughSeq !== 'function') return false;
      if (proto.__emptyLayerFixed) return true;
      proto.__emptyLayerFixed = true;
      const orig = proto.isLayerEmptyThroughSeq;
      proto.isLayerEmptyThroughSeq = function (groupIdx, maxSeq) {
        const g = this.layerGroups[groupIdx];
        // Mirror what compositeLayerRange actually renders: a compressed run in
        // bakedSequences is real content even with no flatCanvas and an empty stack.
        if (g && Array.isArray(g.bakedSequences) && g.bakedSequences.length > 0) return false;
        return orig.call(this, groupIdx, maxSeq);
      };
      return true;
    });
    if (!ok) throw new Error(`observer ${label}: --fix-empty-layer could not reach LayerManager.prototype`);
  }

  // Patch the PROTOTYPE, not the instance. `handleRoomSelected` →
  // `resetRoomState({clearBoard:true})` → `Board.rebuildRenderingState` calls
  // `_createLayerManager`, which does `new LayerManager(...)` — so an instance
  // hook installed before the join is thrown away before a single stroke
  // arrives, and the probe would report a confident 0 forever. Exactly the
  // silent-no-op shape as the brush payloads this suite already got wrong.
  const probed = await page.evaluate(() => {
    const lm = window.app?.board?.layerManager;
    const proto = lm && Object.getPrototypeOf(lm);
    if (!proto || typeof proto.commitUserStroke !== 'function') return false;
    window.__bakeViolations = { total: 0, commits: 0, samples: [] };
    if (proto.__bakeProbeInstalled) return true;
    proto.__bakeProbeInstalled = true;
    const orig = proto.commitUserStroke;
    proto.commitUserStroke = function (groupIdx, userId, extraProps = {}) {
      // ReplayEngine builds its own LayerManager off this same prototype, so
      // scope counting to the live board or the replay-parity phase pollutes it.
      if (this === window.app?.board?.layerManager && window.__bakeViolations) {
        const seq = Number(extraProps && extraProps.seq) || 0;
        const wm = (this.getBakedWatermarkSeq && this.getBakedWatermarkSeq()) || 0;
        window.__bakeViolations.commits++;
        if (seq > 0 && wm > 0 && seq <= wm) {
          window.__bakeViolations.total++;
          if (window.__bakeViolations.samples.length < 12) {
            window.__bakeViolations.samples.push({ seq, watermark: wm, userId, groupIdx });
          }
        }
      }
      return orig.call(this, groupIdx, userId, extraProps);
    };
    return true;
  });
  if (!probed) throw new Error(`observer ${label}: bake-order probe could not reach LayerManager.prototype`);

  // Bake ledger. The violation probe above answers "did a commit land below the
  // watermark"; this answers the prior question the whole bake-defer argument
  // turns on — did these clients flatten the SAME strokes in the SAME order.
  // Same prototype-not-instance reasoning, same fail-loud rule: a detached
  // ledger reports zero disagreements, which is indistinguishable from success.
  const ledgered = await page.evaluate(installBakeLedgerInPage);
  if (!ledgered) throw new Error(`observer ${label}: bake ledger could not reach LayerManager.prototype`);
  await page.evaluate((n, r) => { window.app.self.username = n; window.app.handleRoomSelected(r); }, `OBS_${label}`, ROOM);
  await page.waitForFunction(() => {
    const app = window.app;
    const done = app?.syncClient?.hasCompletedSync === true || (app?.wsClient?.connected && app?.users?.size <= 1);
    return app?.wsClient?.connected && done && app?.sessionIndex != null;
  }, { timeout: 60_000 });
  return { label, browser, page };
}

async function snap(page) { return page.evaluate(captureLayerSnapshotsInPage); }
function painted(s) { return s.filter((g) => g.bbox).length; }

async function startRecording(page) {
  await page.evaluate(() => {
    if (!window.app.recorder) throw new Error('app.recorder missing');
    // Disable the max-length auto-stop. The suite's post-feed pixel settle can
    // run for minutes on a slow box, and an auto-stopped recorder returns null
    // from stop() — silently losing every tape (seen: all three "returned no
    // bundle" on a run that overran the default cap).
    window.app.recorder.configure?.({ maxLengthMs: 0 });
    window.app.recorder.start(window.app);
  });
}

/** Stop the recorder and encode the bundle to .ddraw bytes (base64) in-page. */
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
 * A browser that loads the app but never joins the room — it exists only to
 * play tapes back. Kept out of the room deliberately: a replayer that is also a
 * live client would have the room's real state underneath the replay, and a
 * replay that silently rendered nothing would still diff clean against it.
 */
async function spawnReplayer() {
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 760 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (err) => process.stderr.write(`  [REPLAY ERR] ${err.message}\n`));
  // Same pinned RNG as the observers, so soft-edge jitter can't show up as a
  // replay divergence.
  await page.evaluateOnNewDocument(() => {
    let seed = 0x1f2e3d4c;
    Math.random = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  });
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });
  await page.evaluate(() => window.app.landingPage?.hide?.());
  return { browser, page };
}

/** Decode a .ddraw (base64) in-page and run it through TimeMachine. */
async function loadDdrawIntoReplayer(page, b64, noEager = false) {
  return page.evaluate(async (data, url, skipEager) => {
    const bin = atob(data);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const { decodeDdraw } = await import(url);
    const rec = await decodeDdraw(buf);
    if (!window.app?.TimeMachine?.loadFromRecording) throw new Error('TimeMachine.loadFromRecording missing');
    if (skipEager) {
      // Patch the prototype so the set stays empty however TimeMachine computes it.
      const mod = await import('/src/timebar/ReplayEngine.js');
      const Engine = mod.ReplayEngine ?? mod.default;
      if (Engine?.prototype) Engine.prototype.setEagerBakeUsers = function () {};
    }
    await window.app.TimeMachine.loadFromRecording(rec);
    return { deltas: rec.deltas?.length ?? 0 };
  }, b64, CODEC_URL, noEager);
}

/**
 * `loadFromRecording`'s fast path only paints a low-res preview and runs the
 * full-resolution seek(sessionEnd) in the BACKGROUND, so capturing on return
 * reads a half-built board. Settled = the seek reached the end and none is in
 * flight.
 */
async function waitReplaySettled(page, timeoutMs = 45_000) {
  await page.waitForFunction(() => {
    const tm = window.app?.TimeMachine;
    return !!tm && tm.isOpen && tm._lastAppliedTimestamp === tm.sessionEnd && !tm._isSeeking;
  }, { timeout: timeoutMs, polling: 200 });
}

/** Settle when a tab matches its own previous snapshot (no in-flight render). */
async function waitStable(page, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let prev = null;
  while (Date.now() < deadline) {
    await sleep(800);
    const s = await snap(page);
    if (prev && painted(s) > 0) {
      const d = diffSnapshots(prev, s);
      if (d.matchPct >= 99.99 && d.maxDelta === 0) return s;
    }
    prev = s;
  }
  return prev ?? [];
}

function startK6(waveNo = 0) {
  const args = ['run', '-e', `ROOM=${ROOM}`, '-e', `TARGET_URL=${WS_URL}`];
  if (UNDO_WEIGHT) args.push('-e', `UNDO_WEIGHT=${UNDO_WEIGHT}`);
  if (NO_BLEND) args.push('-e', 'NO_BLEND=1');
  if (SPECIAL_CHANCE) args.push('-e', `SPECIAL_CHANCE=${SPECIAL_CHANCE}`);
  if (SPECIAL_ONLY) args.push('-e', `SPECIAL_ONLY=${SPECIAL_ONLY}`);
  if (REDO_CHANCE) args.push('-e', `REDO_CHANCE=${REDO_CHANCE}`);
  if (LAYERS) args.push('-e', `LAYERS=${LAYERS}`);
  if (TOOLS) args.push('-e', `TOOLS=${TOOLS}`);
  if (NO_PATTERN) args.push('-e', 'NO_PATTERN=1');
  // Seed per wave, not per run: identical seeds across back-to-back waves would
  // make every wave draw the same picture in the same place, so the board would
  // stop accumulating distinct content and the overflow-bake path the waves
  // exist to reach would be fed duplicate geometry.
  if (SEED) args.push('-e', `SEED=${Number(SEED) + waveNo * 104729}`);
  if (VUS) args.push('--vus', VUS);
  if (DURATION) args.push('--duration', DURATION);
  args.push(FEED);
  const child = spawn('k6', args, { shell: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return { done: new Promise((res, rej) => { child.on('error', rej); child.on('close', (code) => res({ code, out })); }) };
}

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  console.log(`\nTop Draw — k6 low_stress bot-stroke observer parity`);
  console.log(`Room:       ${ROOM}`);
  console.log(`Browser:    ${TARGET_URL}   (${OBSERVERS.length} independent observer browsers: ${OBSERVERS.join(' ')})`);
  console.log(`k6 feed:    ${path.relative(process.cwd(), FEED)} → ${WS_URL}`);
  console.log(`Tolerance:  ±${PIXEL_TOLERANCE}px, ≥${PASS_PCT}% match\n`);

  // `obs` is declared outside the try so the finally can always close the
  // browsers. Without that, ANY throw after spawn leaks three full Chrome
  // processes, and the next run of the suite contends with them — one failure
  // cascades into the following runs failing for unrelated reasons.
  const obs = [];
  try {
  for (const label of OBSERVERS) { obs.push(await spawnObserver(label)); }

  // Wait for the trio (+ they'll also see bots as they connect) to see each other.
  const seenDeadline = Date.now() + 30_000;
  while (Date.now() < seenDeadline) {
    const counts = await Promise.all(obs.map((o) => o.page.evaluate(() => window.app?.users?.size ?? 0)));
    if (counts.every((c) => c >= 3)) break;
    await sleep(250);
  }

  // Arm every recorder BEFORE the feed starts so all three tapes cover the same
  // window. Observers never send, so their tapes are pure inbound streams.
  //
  // But arm only once the LAST observer's join sync has fully drained. Its serve
  // ends with a tool-state resend for every user already in the room, which the
  // earlier observers never receive; taped, that reads as "C got 36 messages A
  // and B didn't" — a real difference, but a join artifact, not a desync.
  // `hasCompletedSync` flips before the buffered tail finishes being applied
  // (the Recorder taps at application time), so wait past it as well.
  if (RECORD) {
    const syncDeadline = Date.now() + 30_000;
    while (Date.now() < syncDeadline) {
      const done = await Promise.all(obs.map((o) =>
        o.page.evaluate(() => window.app?.syncClient?.hasCompletedSync === true)));
      if (done.every(Boolean)) break;
      await sleep(250);
    }
    await sleep(2000);
    await Promise.all(obs.map((o) => startRecording(o.page)));
    console.log('  recorders armed (post-sync)');
  }

  // Wave loop. Every wave is a fresh set of k6 bots against the SAME room with
  // the SAME observers still recording, so the board accumulates across waves.
  // That is the whole point: one wave never pushes a bot past
  // MAX_STROKES_PER_USER (20), so the overflow-bake path stays untested, and
  // bots joining/leaving between waves exercises the join serve repeatedly.
  const waveResults = [];
  for (let wave = 1; wave <= WAVES; wave++) {
    console.log(`  wave ${wave}/${WAVES}: launching k6 feed…`);
    const k6 = startK6(wave);
    const k6res = await k6.done;
    fs.appendFileSync(path.join(RESULTS_DIR, 'k6_output.txt'),
      `
===== wave ${wave} (exit ${k6res.code}) =====
${k6res.out}`);
    console.log(`  wave ${wave} k6 finished (exit ${k6res.code})`);

    // Settle, then check the observers still agree. Checking per wave localises
    // a divergence to the wave that caused it instead of only seeing the end.
    await sleep(1500);
    const waveSnaps = {};
    for (const o of obs) waveSnaps[o.label] = await waitStable(o.page);
    const stats = await Promise.all(obs.map((o) => o.page.evaluate(() => {
      const lm = window.app?.board?.layerManager;
      const groups = lm?.layerGroups || [];
      return {
        strokes: groups.reduce((n, g) => n + (g.strokeStack?.length || 0), 0),
        baked: groups.some((g) => !!g.flatCanvas),
        bakedSeqs: groups.reduce((n, g) => n + (g.bakedSequences?.length || 0), 0),
        flatRecs: groups.reduce((n, g) => n + (g.flatStrokeRecords?.length || 0), 0),
        users: window.app?.users?.size ?? 0,
      };
    })));
    const wr = { wave, exit: k6res.code, pairs: {}, stats };
    for (const label of PEERS) {
      const d = diffSnapshots(waveSnaps.A, waveSnaps[label]);
      wr.pairs[`A_${label}`] = { pass: d.pass, matchPct: d.matchPct, maxDelta: d.maxDelta };
      console.log(`    ${d.pass ? '✅' : '❌'} wave ${wave} A↔${label}: ${d.matchPct.toFixed(3)}%  maxΔ ${d.maxDelta}`);
      if (!d.pass) {
        try {
          const dataUrl = await obs[0].page.evaluate(generateDiffPngInPage, waveSnaps.A, waveSnaps[label], PIXEL_TOLERANCE);
          fs.writeFileSync(path.join(RESULTS_DIR, `diff_wave${wave}_A_${label}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
        } catch {}
      }
    }
    console.log(`    live strokes: ${stats.map((x, i) => `${obs[i].label}=${x.strokes}`).join(' ')}`
      + `  baked=${stats.map((x) => (x.baked ? 'y' : 'n')).join('')}`
      + `  flatRecs=${stats.map((x) => x.flatRecs).join('/')}`);

    // Stroke-count invariant. These two numbers were already printed and never
    // checked, which let a real divergence read as incidental detail: one run
    // showed flatRecs 147/147/146/147 with liveStrokes 0/0/4/0, i.e. one client
    // accounting for 150 strokes where its peers had 147. Whether that is a
    // duplicate, a straggler or a lost commit, the clients do not agree on what
    // the board is made of, and a pixel percentage alone will not say so.
    const totals = stats.map((x) => (x.strokes || 0) + (x.flatRecs || 0));
    if (new Set(totals).size > 1) {
      console.log(`    ⚠ observers disagree on total stroke count: `
        + `${stats.map((x, i) => `${obs[i].label}=${totals[i]}`).join(' ')}`
        + `  (live+flat; they should be identical once every client has settled)`);
    }
    waveResults.push(wr);
  }

  // Let buffered tails drain, then stop the recorders BEFORE the pixel settle.
  // The feed is over, so nothing more will arrive that belongs on the tape, and
  // waitStable below can take a minute per observer — time the recorder would
  // otherwise spend accumulating nothing and risking its length cap.
  await sleep(1500);
  const bundles = [];
  if (RECORD) {
    const tapeDir = path.join(RESULTS_DIR, 'tapes');
    fs.mkdirSync(tapeDir, { recursive: true });
    console.log('  stopping recorders…');
    for (const o of obs) {
      const enc = await stopAndEncode(o.page).catch((e) => { console.log(`  ⚠ ${o.label}: ${e.message}`); return null; });
      if (!enc) { console.log(`  ⚠ ${o.label}: recorder returned no bundle`); continue; }
      const file = path.join(tapeDir, `${o.label}.ddraw`);
      fs.writeFileSync(file, Buffer.from(enc.b64, 'base64'));
      bundles.push({ label: o.label, file, deltas: enc.deltas, size: enc.size });
      console.log(`  ${o.label}: ${enc.deltas} deltas, ${(enc.size / 1024).toFixed(1)} KiB`);
    }
  }

  const snaps = {};
  for (const o of obs) {
    snaps[o.label] = await waitStable(o.page);
    await o.page.screenshot({ path: path.join(RESULTS_DIR, `obs_${o.label}.png`) }).catch(() => {});
  }

  const userCounts = await Promise.all(obs.map((o) => o.page.evaluate(() => ({
    users: window.app?.users?.size ?? 0,
    strokes: (window.app?.board?.layerManager?.layerGroups || []).reduce((n, g) => n + (g.strokeStack?.length || 0), 0),
    baked: (window.app?.board?.layerManager?.layerGroups || []).some((g) => !!g.flatCanvas),
  }))));
  obs.forEach((o, i) => console.log(`  ${o.label}: paintedGroups=${painted(snaps[o.label])} liveStrokes=${userCounts[i].strokes} baked=${userCounts[i].baked}`));

  // Name the missing stroke. A pixel percentage says the boards differ; a
  // set-difference over stroke identities says WHICH stroke, by author, layer
  // and seq — which is the difference between "C is 2.9% off" and "C dropped
  // u7's seq 14822 on layer 1". Identities are gathered from all three places a
  // committed stroke can live: the live stack, flatStrokeRecords, and the
  // grouped runs inside bakedSequences.
  const strokeIds = await Promise.all(obs.map((o) => o.page.evaluate(() => {
    const groups = window.app?.board?.layerManager?.layerGroups || [];
    const out = [];
    let unsequenced = 0;
    const unseqDetail = [];
    let anonymous = 0;
    groups.forEach((g, gi) => {
      const add = (s) => {
        if (!s) return;
        // Identity is (layer, author, server seq) ONLY. `timestamp` must stay out
        // of it: it is assigned locally, so the same stroke reads t…688 on one
        // client and t…689 on another and every identity becomes unique — which
        // made the first version of this report claim all four observers were
        // each missing ~364 of their own 148 strokes.
        // Entries without a userId are not comparable strokes at all — some
        // baked bookkeeping records carry neither userId nor dimensions, and
        // counting them as "unsequenced" inflated that number (it read 3 per
        // client in a run where the real figure was 0) and nearly produced a
        // wrong conclusion about z-ordering.
        if (s.userId === undefined || s.userId === null) { anonymous++; return; }
        const seq = s.seq || 0;
        if (seq > 0) out.push(`L${gi}:u${s.userId}:s${seq}`);
        else {
          // Not comparable across clients — but WHICH strokes these are is the
          // whole question, because a seq=0 stroke is ordered by the receiving
          // client's own clock. Record enough to name the producing path.
          unsequenced++;
          if (unseqDetail.length < 12) {
            unseqDetail.push(`L${gi}:u${s.userId}:${s.filterType || s.blendMode || 'source-over'}`
              + `${s.isRemoteGlitchImage ? ':glitch' : ''}:${s.width}x${s.height}`);
          }
        }
      };
      (g.strokeStack || []).forEach(add);
      (g.flatStrokeRecords || []).forEach(add);
      (g.bakedSequences || []).forEach((item) => { if (item && item.type === 'group') (item.strokes || []).forEach(add); });
    });
    return { ids: out, unsequenced, unseqDetail, anonymous };
  })));
  const idSets = strokeIds.map((r) => new Set(r.ids));
  const union = new Set(strokeIds.flatMap((r) => r.ids));
  const missingBy = {};
  for (const id of union) {
    const absent = obs.map((o, i) => (idSets[i].has(id) ? null : o.label)).filter(Boolean);
    // Only interesting when SOME clients have it — an id nobody has cannot exist,
    // and one every client has is fine.
    if (absent.length > 0 && absent.length < obs.length) {
      for (const label of absent) (missingBy[label] ||= []).push(id);
    }
  }
  const anon = strokeIds.map((r, i) => `${obs[i].label}=${r.anonymous || 0}`).join(' ');
  if (strokeIds.some((r) => (r.anonymous || 0) > 0)) {
    console.log(`  ℹ non-stroke bookkeeping records skipped (no userId): ${anon}`);
  }
  const unseq = strokeIds.map((r, i) => `${obs[i].label}=${r.unsequenced}`).join(' ');
  if (strokeIds.some((r) => r.unsequenced > 0)) {
    console.log(`  ℹ unsequenced strokes excluded from the identity diff (seq=0, not comparable): ${unseq}`);
    const det = strokeIds.find((r) => r.unseqDetail && r.unseqDetail.length);
    if (det) console.log(`     the seq=0 strokes: ${det.unseqDetail.slice(0, 6).join('  ')}`);
  }
  if (Object.keys(missingBy).length) {
    console.log(`  ⚠ stroke identities not present on every observer:`);
    for (const [label, ids] of Object.entries(missingBy)) {
      console.log(`      ${label} is missing ${ids.length}: ${ids.slice(0, 8).join(' ')}${ids.length > 8 ? ' …' : ''}`);
    }
  } else {
    console.log(`  ✅ every observer holds the same ${union.size} sequenced stroke identities`);
  }

  // Bake-order violations: commits that landed at or below this client's baked
  // watermark. Any non-zero count means that client permanently rendered at
  // least one stroke above content it belongs beneath — the boards cannot
  // reconverge, and no amount of resyncing will fix it.
  bakeViolations = {};
  for (const o of obs) {
    bakeViolations[o.label] = await o.page.evaluate(() => window.__bakeViolations || null).catch(() => null);
  }

  // Cost side of the bake deferral: how deep the live stacks actually got, and
  // what that cost in heap. Deferring the bake trades memory for a common bake
  // prefix, and the cap (LayerManager.BAKE_DEFER_STACK_CAP) is the only thing
  // bounding that trade — so a run that reports better parity is only meaningful
  // alongside these. maxStack at/above the cap means the safety valve fired.
  bakeCost = {};
  for (const o of obs) {
    bakeCost[o.label] = await o.page.evaluate(() => {
      const lm = window.app?.board?.layerManager;
      const stacks = (lm?.layerGroups || []).map((g) => g.strokeStack?.length || 0);
      return {
        stacks,
        maxStack: stacks.length ? Math.max(...stacks) : 0,
        peakStack: window.__stackPeak ?? null,
        peakHeapMB: window.__heapPeakMB || null,
        cap: lm?.constructor?.BAKE_DEFER_STACK_CAP ?? null,
        deferEnabled: lm?.constructor?.BAKE_DEFER_ENABLED ?? null,
        heapMB: performance?.memory
          ? Math.round(performance.memory.usedJSHeapSize / 1048576)
          : null,
      };
    }).catch(() => null);
  }
  const costLine = Object.entries(bakeCost)
    .map(([k, v]) => `${k}: peak ${v?.peakStack ?? '?'}${v?.peakHeapMB != null ? `/${v.peakHeapMB}MB` : ''}`)
    .join('   ');
  console.log(`  bake cost (defer=${bakeCost[obs[0]?.label]?.deferEnabled}, cap=${bakeCost[obs[0]?.label]?.cap}):  ${costLine}`);
  const violTotal = Object.values(bakeViolations).reduce((n, v) => n + (v?.total || 0), 0);
  if (violTotal > 0) {
    console.log(`  ⚠ bake-order violations (commit seq <= already-baked watermark):`);
    for (const [label, v] of Object.entries(bakeViolations)) {
      if (!v) continue;
      console.log(`      ${label}: ${v.total} of ${v.commits} commits`
        + (v.samples.length ? `  e.g. seq ${v.samples[0].seq} <= watermark ${v.samples[0].watermark} (u${v.samples[0].userId} L${v.samples[0].groupIdx})` : ''));
    }
  } else {
    // "0 violations" is only meaningful if the probe actually saw commits go by.
    // A hook that silently detached reports a confident zero, which is worse
    // than no probe at all.
    const seen = Object.values(bakeViolations).reduce((n, v) => n + (v?.commits || 0), 0);
    if (seen === 0) {
      console.log(`  ⚠ bake-order probe observed 0 commits — the hook is not attached; treat its 0 as UNKNOWN`);
    } else {
      console.log(`  ✅ no bake-order violations (${seen} commits, all above the baked watermark)`);
    }
  }

  // ── Proof of lag ──────────────────────────────────────────────────────────
  // A lag harness that silently applies nothing is worse than no harness: it
  // produces a full set of plausible numbers for a condition that never existed.
  // So report the two quantities that would have to move, and say plainly when
  // they did not.
  //
  //   queue depth   what _shouldDeferBakeForInbound actually reads. If this stays
  //                 at 0 the deferral never engaged and the run says nothing
  //                 about it, whatever was configured.
  //   stream skew   wall-clock spread between clients reaching the same seq. This
  //                 is "clients trail by different amounts" measured directly —
  //                 the premise of the whole theory.
  lagReport = {
    requested: LAG_ON, asymmetric: LAG_ASYMMETRIC,
    cpuRates: CPU_RATES, netCapsKBs: NET_CAPS,
    observers: {}, skew: null, queueMoved: false, skewMoved: false, verified: false,
  };
  const lagTraces = {};
  for (const o of obs) {
    const idx = OBSERVERS.indexOf(o.label);
    const got = await o.page.evaluate(() => ({
      trace: window.__lagTrace || [], maxSeq: window.__maxAppliedSeq || 0,
    })).catch(() => ({ trace: [], maxSeq: 0 }));
    lagTraces[o.label] = got.trace;
    const qs = got.trace.map((s) => s.q);
    const sorted = [...qs].sort((a, b) => a - b);
    const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
    lagReport.observers[o.label] = {
      cpuRate: CPU_RATES[idx] ?? 1,
      netCapKBs: NET_CAPS[idx] ?? 0,
      samples: qs.length,
      qMax: qs.length ? Math.max(...qs) : 0,
      qP95: pct(0.95),
      qMedian: pct(0.5),
      qMean: qs.length ? Number((qs.reduce((a, b) => a + b, 0) / qs.length).toFixed(1)) : 0,
      qNonZeroPct: qs.length ? Number((100 * qs.filter((q) => q > 0).length / qs.length).toFixed(1)) : 0,
      maxAppliedSeq: got.maxSeq,
    };
  }

  // Skew is measured at seq MILESTONES rather than at the end, because the ends
  // converge: once the feed stops every client drains and the final seqs match,
  // which would report zero lag for a run that was badly skewed throughout.
  const finalSeqs = Object.values(lagReport.observers).map((o) => o.maxAppliedSeq).filter((s) => s > 0);
  if (finalSeqs.length >= 2) {
    const target = Math.min(...finalSeqs);
    const skews = [];
    for (let f = 0.2; f <= 0.96; f += 0.15) {
      const m = Math.floor(target * f);
      const times = [];
      for (const label of Object.keys(lagTraces)) {
        const hit = lagTraces[label].find((s) => s.seq >= m);
        if (hit) times.push(hit.t);
      }
      if (times.length === Object.keys(lagTraces).length) skews.push(Math.max(...times) - Math.min(...times));
    }
    if (skews.length) {
      const s = [...skews].sort((a, b) => a - b);
      lagReport.skew = { medianMs: s[s.length >> 1], maxMs: s[s.length - 1], milestones: s.length };
    }
  }
  lagReport.queueMoved = Object.values(lagReport.observers).some((o) => o.qMax >= 10 || o.qP95 > 0);
  lagReport.skewMoved = (lagReport.skew?.maxMs ?? 0) >= 200;
  lagReport.verified = lagReport.queueMoved || lagReport.skewMoved;

  const lagCfg = OBSERVERS.map((l, i) => `${l}=${CPU_RATES[i]}x${NET_CAPS[i] ? `/${NET_CAPS[i]}KBs` : ''}`).join(' ');
  console.log(`  lag config: ${LAG_ON ? lagCfg : 'none (unthrottled)'}`);
  for (const [label, v] of Object.entries(lagReport.observers)) {
    console.log(`      ${label}: inbound queue max ${v.qMax} p95 ${v.qP95} mean ${v.qMean}`
      + ` (${v.qNonZeroPct}% of ${v.samples} samples non-empty)  appliedSeq ${v.maxAppliedSeq}`);
  }
  if (lagReport.skew) {
    console.log(`      stream skew at matched seq: median ${lagReport.skew.medianMs}ms  max ${lagReport.skew.maxMs}ms`
      + `  (${lagReport.skew.milestones} milestones)`);
  }
  if (LAG_ON && !LAG_ASYMMETRIC) {
    console.log('  ⚠ lag is UNIFORM across observers — clients trail together and bake the same');
    console.log('     prefix, so this run cannot show the divergence it is meant to provoke.');
  }
  if (LAG_ON && !lagReport.verified) {
    console.log('  ❌ lag was configured but NEITHER the inbound queue nor the stream skew moved.');
    console.log('     Nothing here tests the bake deferral; do not read the numbers below as an');
    console.log('     answer about it. Check that the CDP session applied (a `latency`-only');
    console.log('     setting is a known no-op on established WS frames).');
  } else if (!LAG_ON && lagReport.queueMoved) {
    console.log('  ℹ the inbound queue built up without any configured lag — the machine itself');
    console.log('     is the bottleneck, which makes this an uncontrolled but genuine lag run.');
  }

  // Bake ledger — the exact half of the bake question. Reported BEFORE the pixel
  // numbers deliberately: when the two disagree it is the ledger that is exact,
  // and reading the percentage first is how a 0.6-point difference got mistaken
  // for a result once already.
  //
  // How to read it:
  //   inversions > 0    permanent divergence; two clients flattened a common pair
  //                     of strokes in opposite orders and nothing can undo that
  //   prefixDelta > 0   clients flattened different amounts. Not a bug by itself
  //                     (the shorter prefix still holds those strokes live, in seq
  //                     order) but it is precisely the quantity the inbound-queue
  //                     deferral exists to drive to zero, so it is the direct
  //                     measure of whether the deferral is doing anything at all.
  const ledgerCaptures = {};
  for (const o of obs) {
    ledgerCaptures[o.label] = await o.page.evaluate(captureBakeLedgerInPage)
      .catch(() => ({ installed: false, entries: [], live: {} }));
  }
  bakeLedger = compareBakeLedgers(ledgerCaptures);
  for (const line of formatBakeLedgerReport(bakeLedger)) console.log(line);

  // Pixel parity A↔B, A↔C.
  let allPass = true;
  const diffs = {};
  for (const label of PEERS) {
    const d = diffSnapshots(snaps.A, snaps[label]);
    diffs[label] = d;
    if (!d.pass) {
      allPass = false;
      try {
        const dataUrl = await obs[0].page.evaluate(generateDiffPngInPage, snaps.A, snaps[label], PIXEL_TOLERANCE);
        fs.writeFileSync(path.join(RESULTS_DIR, `diff_A_${label}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
      } catch {}
    }
    console.log(`  ${d.pass ? '✅' : '❌'} A↔${label}: match ${d.matchPct.toFixed(3)}%  maxΔ ${d.maxDelta}`);
  }

  // Peer-vs-peer, not just A-vs-everyone. Diffing only against A cannot tell
  // "A is the outlier and B/C/D agree" from "all four disagree with each other",
  // and those point at completely different bugs — the first at something that
  // happened to one client (a lost commit, a resync, a bake-order violation),
  // the second at something systemic. The bake-order probe fired on exactly one
  // client in a run where B/C/D still disagreed among themselves, which is only
  // visible from here.
  // Silent client-side drops. A message the client discarded during decode never
  // reaches strokeLog, so the server reports it as a missingStroke and the
  // client resyncs — with no other visible symptom. Surfacing the count turns
  // that from an inference into an observation.
  const dropTotal = Object.values(consoleDrops).reduce((n, v) => n + (v?.total || 0), 0);
  if (dropTotal > 0) {
    console.log(`  ⚠ client-side discards logged to console:`);
    for (const [label, v] of Object.entries(consoleDrops)) {
      if (!v || !v.total) continue;
      console.log(`      ${label}: ${v.total}  ${JSON.stringify(v.byPattern)}`);
      if (v.samples.length) console.log(`         e.g. ${v.samples[0]}`);
    }
  } else {
    console.log(`  ✅ no client-side message/asset discards logged`);
  }

  // An empty board matches an empty board at 100.000% maxΔ 0. That is the
  // failure mode this suite's own header warns about, and --no-coverage-gate
  // disables the check that would otherwise catch it — so a restricted-tool
  // diagnostic run can look like a flawless pass while painting nothing at all
  // (a SELECT+TEXT-only arm did exactly this: six pairs at maxΔ 0, every
  // observer reporting paintedGroups=0). Refuse to call that a result.
  const paintedAny = obs.some((o) => painted(snaps[o.label]) > 0);
  if (!paintedAny) {
    allPass = false;
    console.log(`  ❌ VOID: every observer reports paintedGroups=0 — the boards are EMPTY.`);
    console.log(`     The pixel percentages above compare nothing to nothing and mean nothing.`);
  }

  const peerDiffs = {};
  for (let i = 0; i < PEERS.length; i++) {
    for (let j = i + 1; j < PEERS.length; j++) {
      const [x, y] = [PEERS[i], PEERS[j]];
      const d = diffSnapshots(snaps[x], snaps[y]);
      peerDiffs[`${x}${y}`] = { pass: d.pass, matchPct: d.matchPct, maxDelta: d.maxDelta };
      console.log(`  ${d.pass ? '✅' : '❌'} ${x}↔${y}: match ${d.matchPct.toFixed(3)}%  maxΔ ${d.maxDelta}   (peer-vs-peer)`);
      // Deliberately does NOT affect allPass: A↔peer is the suite's contract and
      // widening it mid-investigation would silently change what "green" means.
    }
  }

  // ── Coverage gate ──────────────────────────────────────────────────────────
  // Everything above measures AGREEMENT. Agreement on an empty board is perfect,
  // and so is agreement on a board that only ever saw one tool on one layer — so
  // without this, a feed that silently stopped exercising something would make
  // the suite look better, not worse. Read from A's decoded inbound stream: what
  // the observers actually received, not what the feed intended to send.
  const coverage = await obs[0].page.evaluate(() => window.__coverage || null);
  let coverageOk = true;
  if (coverage) {
    const toolsSeen = Object.keys(coverage.tools).map(Number);
    const layersSeen = Object.keys(coverage.layers).map(Number);
    const verbsSeen = new Set(Object.keys(coverage.verbs));
    const blendsSeen = new Set(Object.keys(coverage.blendModes));
    const complexBlends = [...blendsSeen].filter((b) => b && b !== 'source-over');

    const named = toolsSeen.map((t) => TOOL_NAMES[t] || `?${t}`).sort();
    console.log('');
    console.log(`  coverage (from A's inbound stream):`);
    console.log(`    tools   ${named.length}: ${named.join(' ')}`);
    console.log(`    layers  ${layersSeen.sort().join(',') || 'none'}`);
    console.log(`    blends  ${complexBlends.length} complex: ${complexBlends.slice(0, 8).join(' ')}${complexBlends.length > 8 ? ' …' : ''}`);
    console.log(`    verbs   ${[...verbsSeen].sort().join(' ') || 'none'}`);
    console.log(`    shape   ${Object.keys(coverage.shapeModes).join(' ') || 'none'}`
      + `   text ${Object.keys(coverage.textKinds).join('/') || 'none'}`);
    console.log(`    undo ${coverage.undo}  redo ${coverage.redo}  pressure ${coverage.pressure}`
      + `  stampRadii ${coverage.stampRadii}  eraseAll ${coverage.eraseAll}`
      + `  fill ${coverage.fillPlain}+${coverage.fillWithExpansion}exp`);
    console.log(`    values  simPressure ${JSON.stringify(coverage.simPressure)}`
      + `  thinning ${Object.keys(coverage.thinning).length} distinct`);
    console.log(`    brushes patternLoadable ${JSON.stringify(coverage.patternBrushLoadable)}`
      + `  imageLoadable ${JSON.stringify(coverage.imageBrushLoadable)}`
      + `  patternFill ${JSON.stringify(coverage.patternFillMode)}`);

    // Each requirement names a capability that was silently untested before this
    // rewrite. A miss is not necessarily a product bug — a short run can just be
    // unlucky — but it does mean the run's green result covers less than it
    // appears to, which is the thing that must never pass quietly.
    const want = [
      ['≥6 distinct tools', toolsSeen.length >= 6],
      ['all 3 layers', [0, 1, 2].every((l) => layersSeen.includes(l))],
      ['≥2 complex blend modes', complexBlends.length >= 2],
      ['undo AND redo', coverage.undo > 0 && coverage.redo > 0],
      ['rect AND lasso lifts', verbsSeen.has('SEL_LIFT_rect') && verbsSeen.has('SEL_LIFT_lasso')],
      ['≥4 selection verbs', [...verbsSeen].filter((v) => !v.startsWith('SEL_LIFT_')).length >= 4],
      ['stamp radii present', coverage.stampRadii > 0],
      ['shape draw mode applied', Object.keys(coverage.shapeModes).some((m) => m && m !== 'unset')],
      // Both states, not just "CSIM arrived". The bug this replaces was a feed
      // that sent CSIM constantly and never once encoded `true`.
      ['simulate-pressure both states', coverage.simPressure.true > 0 && coverage.simPressure.false > 0],
      ['thinning non-default', Object.keys(coverage.thinning).some((v) => v !== '50')],
      // The strong form: not "a brush payload arrived" but "every brush payload
      // that arrived was one the receiver can actually load". The bug these
      // replace shipped a payload the receiver parsed, accepted, and then used
      // to paint nothing — so any `false` here means the tool is back to
      // decorating the coverage list without touching a pixel.
      ['pattern brush payloads loadable',
        NO_PATTERN || (coverage.patternBrushLoadable.true > 0 && !coverage.patternBrushLoadable.false)],
      ['image brush payloads loadable',
        NO_PATTERN || (coverage.imageBrushLoadable.true > 0 && !coverage.imageBrushLoadable.false)],
      // Pattern FILL is a separate consumer from the pattern BRUSH — fill and
      // select tile the brush across a region instead of stamping it.
      ['pattern fill mode enabled', NO_PATTERN || coverage.patternFillMode.true > 0],
    ];
    const missed = want.filter(([, ok]) => !ok).map(([n]) => n);
    if (missed.length) {
      coverageOk = false;
      console.log(`    ${REQUIRE_COVERAGE ? '❌' : '⚠'} not exercised: ${missed.join('; ')}`);
      console.log(`      (a green parity result below covers less than it looks like it does)`);
    } else {
      console.log(`    ✅ every advertised capability appeared in the traffic`);
    }
  } else {
    console.log('  ⚠ coverage probe reported nothing — cannot confirm what was exercised');
    coverageOk = false;
  }
  if (REQUIRE_COVERAGE && !coverageOk) allPass = false;

  // ── Per-user replay parity ─────────────────────────────────────────────────
  // Each observer's OWN tape, replayed, must reproduce that observer's OWN live
  // canvas. This is a different question from the two oracles above and can fail
  // while both of them pass: the four can receive identical bytes (tape ✓) and
  // paint identical boards (pixels ✓) while the Recorder→ReplayEngine round trip
  // loses something for all four equally. Running it for every observer rather
  // than one also separates "replay is broken" from "replay is broken for the
  // client that happened to be mid-resync".
  const replayParity = {};
  if (REPLAY_PARITY && RECORD && bundles.length) {
    console.log('');
    console.log('  per-user replay parity (own tape → own live canvas):');
    // A client re-served mid-recording is NOT measurable on this oracle, for the
    // same structural reason a joiner served a checkpoint is not measurable on
    // the tape oracle: the sync payload is deliberately excluded from the tape
    // (messageAllowlist.js), so state that arrived as a bulk transfer is in the
    // client's live board and will never be in its own recording. Its replay
    // then legitimately cannot reproduce its live canvas, and scoring that as a
    // replay failure blames the ReplayEngine for a hole the Recorder never had
    // the chance to fill.
    const resyncedMidRun = new Set();
    for (const o of obs) {
      const log = await o.page.evaluate(() => window.__syncLog ?? []).catch(() => []);
      if ((log || []).some((e) => e.kind === 'send' && e.detail?.t === 143)) resyncedMidRun.add(o.label);
    }
    if (resyncedMidRun.size) {
      console.log(`    ℹ ${[...resyncedMidRun].join(',')} resynced mid-recording — their replay result is`);
      console.log(`      reported but NOT asserted (bulk sync state never reaches the tape).`);
    }
    let replayer = null;
    try {
      replayer = await spawnReplayer();
      for (const b of bundles) {
        const b64 = fs.readFileSync(b.file).toString('base64');
        try {
          const loaded = await loadDdrawIntoReplayer(replayer.page, b64, NO_EAGER_BAKE);
          await waitReplaySettled(replayer.page);
          // How did the replay arrive at its board? `loadFromRecording` takes a
          // fast path when the .ddraw carries baked visual checkpoints: it paints
          // a checkpoint image and runs the full-resolution seek in the
          // background. A replay that settled on the checkpoint image rather than
          // on replayed commands has no strokes to show for it — which reads as a
          // huge pixel gap with no structural explanation, so record the evidence
          // instead of inferring it later.
          const tmState = await replayer.page.evaluate(() => {
            const tm = window.app?.TimeMachine;
            return {
              isOpen: !!tm?.isOpen,
              lastApplied: tm?._lastAppliedTimestamp ?? null,
              sessionEnd: tm?.sessionEnd ?? null,
              seeking: !!tm?._isSeeking,
              atEnd: tm?._lastAppliedTimestamp === tm?.sessionEnd,
            };
          }).catch(() => null);
          // Compare WHOLE-BOARD composites, not per-layer groups. A replay is
          // not obliged to distribute content across layer groups the way the
          // live board did — when the tape's checkpoints are flat composite PNGs
          // the replay restores everything into group 0 and replays 0 actions,
          // which a per-group diff scores at ~70% for a visually identical
          // board. What "does the recording replay faithfully?" actually means
          // is "does it LOOK the same", so composite both sides and diff that.
          const rSnaps = await replayer.page.evaluate(makeCompositeEvaluator(true));
          const liveComposite = await obs.find((o) => o.label === b.label)
            .page.evaluate(makeCompositeEvaluator(false));
          const d = diffSnapshots(liveComposite, rSnaps);
          // A blank replay against a blank live board diffs at 100.000%. That is
          // the one way this oracle can report success while proving nothing, so
          // require the replay to have actually painted before believing it.
          const rPainted = painted(rSnaps);
          const lPainted = painted(liveComposite);
          const blank = rPainted === 0 && lPainted > 0;
          const applicable = !resyncedMidRun.has(b.label);
          const pass = d.pass && !blank;
          replayParity[b.label] = {
            pass, applicable, matchPct: d.matchPct, maxDelta: d.maxDelta,
            replayPaintedGroups: rPainted, livePaintedGroups: lPainted,
          };
          const mark = !applicable ? 'ℹ' : (pass ? '✅' : '❌');
          console.log(`    ${mark} ${b.label} live↔replay: ${d.matchPct.toFixed(3)}%  maxΔ ${d.maxDelta}`
            + `  (painted live ${lPainted} / replay ${rPainted})`
            + (applicable ? '' : '  [not asserted — resynced mid-run]'));
          if (blank) console.log(`       ⚠ replay painted NOTHING — the match is two empty canvases, not parity`);
          if (!pass && applicable) {
            allPass = false;
            try {
              const dataUrl = await replayer.page.evaluate(generateDiffPngInPage, liveComposite, rSnaps, PIXEL_TOLERANCE);
              fs.writeFileSync(path.join(RESULTS_DIR, `diff_replay_${b.label}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
            } catch {}
            // Structural dump. A match% cannot express "the same strokes in a
            // different z-order", which is the most likely live↔replay gap
            // because the two managers sort by different keys (live by seq,
            // replay by timestamp — ReplayEngine commits everything at seq 0).
            // Writing the ordered composite inputs for both turns the next
            // investigation into a diff instead of a re-derivation.
            try {
              const liveStruct = await obs.find((o) => o.label === b.label)
                .page.evaluate(makeStructureEvaluator(false));
              const replayStruct = await replayer.page.evaluate(makeStructureEvaluator(true));
              fs.writeFileSync(path.join(RESULTS_DIR, `struct_replay_${b.label}.json`),
                JSON.stringify({ live: liveStruct, replay: replayStruct }, null, 1));
              for (let gi = 0; gi < Math.max(liveStruct.length, replayStruct.length); gi++) {
                const L = liveStruct[gi] || {}, R = replayStruct[gi] || {};
                const lLive = (L.live || []).length, rLive = (R.live || []).length;
                const lFlat = (L.flatRecs || []).length, rFlat = (R.flatRecs || []).length;
                if (lLive === rLive && lFlat === rFlat && !!L.hasFlat === !!R.hasFlat) continue;
                console.log(`       L${gi}: live flat=${lFlat} stack=${lLive} baked=${!!L.hasFlat}`
                  + `  |  replay flat=${rFlat} stack=${rLive} baked=${!!R.hasFlat}`);
              }
              // Blend-mode census is the fastest tell for a misplaced erase.
              const census = (st) => {
                const c = {};
                for (const g of st) for (const s of [...(g.flatRecs || []), ...(g.live || [])]) c[s.bm] = (c[s.bm] || 0) + 1;
                return c;
              };
              const cl = census(liveStruct), cr = census(replayStruct);
              if (JSON.stringify(cl) !== JSON.stringify(cr)) {
                console.log(`       blend census live ${JSON.stringify(cl)} vs replay ${JSON.stringify(cr)}`);
              }
            } catch (e) { console.log(`       (structural dump failed: ${e.message})`); }
            if (tmState) {
              console.log(`       replay state: deltas=${loaded?.deltas ?? '?'} atEnd=${tmState.atEnd}`
                + ` lastApplied=${tmState.lastApplied} sessionEnd=${tmState.sessionEnd} seeking=${tmState.seeking}`);
            }
          }
        } catch (e) {
          replayParity[b.label] = { pass: false, error: e.message };
          allPass = false;
          console.log(`    ❌ ${b.label}: replay failed — ${e.message}`);
        }
        await replayer.page.evaluate(() => window.app?.TimeMachine?.stop?.()).catch(() => {});
      }
    } finally {
      if (replayer) await replayer.browser.close().catch(() => {});
    }
  }

  // ── Late joiner ────────────────────────────────────────────────────────────
  // Joins AFTER every wave, so it must rebuild the whole accumulated board —
  // including whatever the incumbents have already baked past
  // MAX_STROKES_PER_USER. Checked on both oracles: pixels against an incumbent,
  // and its rebuilt tail against that incumbent's tape (subsequence, unclipped).
  let joinPixel = null;
  let joinTape = null;
  if (LATE_JOIN) {
    console.log('');
    console.log('  late joiner: joining after all waves…');
    const joiner = await spawnObserver('J', { recordFromJoin: RECORD });
    obs.push(joiner);              // so the finally-block closes its browser

    // Snapshot the joiner the instant sync completes, BEFORE any tail settles.
    // If it already disagrees here, the divergence is in the bulk sync payload
    // (which the tape cannot see) rather than in replaying the command tail.
    const jAtSync = await snap(joiner.page);
    const aAtSync = await snap(obs[0].page);
    const atSync = diffSnapshots(aAtSync, jAtSync);
    console.log(`  [at sync-complete] A↔J ${atSync.matchPct.toFixed(3)}%  maxΔ ${atSync.maxDelta}`);
    const syncCounts = await joiner.page.evaluate(() => window.__msgCounts || {});
    const named = Object.entries(syncCounts)
      .map(([t, n]) => `${t}:${n}`).join(' ');
    console.log(`  [joiner inbound types] ${named}`);
    const structs = [];
    for (const [label, pg] of [['A', obs[0].page], ['J', joiner.page]]) {
      structs.push([label, await pg.evaluate(`(() => {
        const g = (window.app.board.layerManager.layerGroups) || [];
        return {
          stacks: g.map((x) => (x.strokeStack || []).length),
          flat: g.map((x) => !!x.flatCanvas),
          bakedSeqs: g.map((x) => (x.bakedSequences || []).length),
          flatRecs: g.map((x) => (x.flatStrokeRecords || []).length),
        };
      })()`)]);
    }
    for (const [label, st] of structs) console.log(`  [struct ${label}] ${JSON.stringify(st)}`);

    await sleep(2500);
    const jSnap = await waitStable(joiner.page);
    const aSnap = await waitStable(obs[0].page);
    joinPixel = diffSnapshots(aSnap, jSnap);

    // Post-settle structure. The joiner rebuilds from the command tail, so if it
    // ends with a different bake shape than an incumbent, the two applied the
    // same input through different bake boundaries — which is how identical
    // tapes can still produce different pixels.
    for (const [label, pg] of [['A', obs[0].page], ['J', joiner.page]]) {
      const st = await pg.evaluate(`(() => {
        const g = (window.app.board.layerManager.layerGroups) || [];
        const perUser = {};
        for (const x of g) for (const s of (x.strokeStack || [])) perUser[s.userId] = (perUser[s.userId] || 0) + 1;
        return {
          stacks: g.map((x) => (x.strokeStack || []).length),
          bakedSeqs: g.map((x) => (x.bakedSequences || []).length),
          flatRecs: g.map((x) => (x.flatStrokeRecords || []).length),
          userCounts: g.map((x) => Object.fromEntries(x.userStrokeCounts || [])),
          liveByUser: perUser,
          users: window.app?.users?.size ?? 0,
        };
      })()`);
      console.log(`  [post-settle ${label}] ${JSON.stringify(st)}`);
    }
    console.log(`  ${joinPixel.pass ? '✅' : '❌'} pixels A↔J: ${joinPixel.matchPct.toFixed(3)}%  maxΔ ${joinPixel.maxDelta}`);
    if (!joinPixel.pass) {
      allPass = false;
      try {
        const dataUrl = await obs[0].page.evaluate(generateDiffPngInPage, aSnap, jSnap, PIXEL_TOLERANCE);
        fs.writeFileSync(path.join(RESULTS_DIR, 'diff_A_J.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
      } catch {}
    }
    if (RECORD) {
      const encJ = await stopAndEncode(joiner.page).catch(() => null);
      const incumbent = bundles.find((b) => b.label === 'A');
      if (encJ && incumbent) {
        const fileJ = path.join(RESULTS_DIR, 'tapes', 'J.ddraw');
        fs.writeFileSync(fileJ, Buffer.from(encJ.b64, 'base64'));
        const tA = await loadTape(incumbent.file); tA.label = 'A';
        const tJ = await loadTape(fileJ); tJ.label = 'J';
        const jr = await compareTapes([tA, tJ], {
          ignoreTypes: KEEP_MM ? new Set() : new Set(['MM']),
          clipToWindow: false,
        });
        const verdict = joinVerdict(jr);
        // 99 = BOARD_SNAPSHOT_RESTORE: the join checkpoint image. If one was
        // served, everything at or below its seq reached the joiner as PIXELS,
        // never as commands — so a subsequence check reports the whole
        // pre-checkpoint history as "missing" and can only fail. (Measured
        // elsewhere: checkpoint at seq 322,220 with a 74-commit tail produced
        // 1,134 bogus "missing" messages.) In that configuration the joiner's
        // only valid oracle is the pixel diff, so this must not fail the run.
        const checkpointServed = (syncCounts[99] || 0) > 0;
        joinTape = {
          ok: verdict.ok, applicable: !checkpointServed,
          droppedByType: verdict.droppedByType, compacted: verdict.compacted.length,
        };
        if (checkpointServed) {
          console.log(`  ℹ tape A↔J: not applicable — a checkpoint was served, so pre-checkpoint`);
          console.log(`     history arrived as an image. (${verdict.dropped.length} "missing" = the image's contents.)`);
        } else {
          console.log(`  ${verdict.ok ? '✅' : '❌'} tape A↔J: ${verdict.dropped.length} board-state message(s) missing`
            + `  (${verdict.compacted.length} compacted, expected)`);
          if (!verdict.ok) {
            allPass = false;
            console.log(`     missing: ${JSON.stringify(verdict.droppedByType)}`);
            for (const d of verdict.dropped.slice(0, 8)) {
              console.log(`     - u${d.user} ${d.event.typeName} ${JSON.stringify(d.event.canon).slice(0, 110)}`);
            }
          }
        }
      }
    }
  }

  // Sync-event probe dump. A client that was re-served mid-run shows up here as
  // an extra SYNC_REQUEST / sync event long after join — the cause of the
  // "one observer received messages the others didn't" signature in the tape.
  const syncLogs = {};
  for (const o of obs) {
    syncLogs[o.label] = await o.page.evaluate(() => window.__syncLog ?? []).catch(() => []);
  }
  const t0 = Math.min(...Object.values(syncLogs).flat().map((e) => e.t).filter(Number.isFinite), Date.now());
  console.log('\n  sync events (cause of any mid-run re-serve):');
  for (const [label, log] of Object.entries(syncLogs)) {
    const line = log.map((e) => `${e.kind}:${e.detail?.event ?? 't' + e.detail?.t}@+${((e.t - t0) / 1000).toFixed(1)}s`).join(' ');
    console.log(`    ${label}: ${line || '(none)'}`);
  }
  fs.writeFileSync(path.join(RESULTS_DIR, 'sync_events.json'), JSON.stringify(syncLogs, null, 2));

  // ── Tape parity ────────────────────────────────────────────────────────────
  // Snapshots are already taken, so stopping the recorders now cannot affect the
  // pixel result — the two oracles observe the same settled state.
  let tapeResult = null;
  let tapeResyncExplained = false;
  if (RECORD) {
    if (bundles.length >= 2) {
      const tapes = [];
      for (const b of bundles) {
        const tape = await loadTape(b.file);
        tape.label = b.label;
        tapes.push(tape);
      }
      tapeResult = await compareTapes(tapes, { ignoreTypes: KEEP_MM ? new Set() : new Set(['MM']) });
      console.log('\n' + formatReport(tapeResult, { maxDiffs: 12, showCoverage: true }));

      // A client that asked to be re-served mid-run (SYNC_PARITY_RESYNC_REQUEST,
      // type 143) is sent a tool-state resend for every user in the room, which
      // nobody else receives. On its tape that reads as "D got 14 messages A did
      // not" — a real difference, and NOT a delivery bug. Without this
      // correlation the suite reports "observers received DIFFERENT input —
      // transport bug", which sends you hunting the sanitizer for something the
      // product did on purpose.
      //
      // The resync is still worth surfacing loudly: a client only asks for one
      // after deciding its own board was wrong, so it is evidence of a parity
      // mismatch even when the resulting tape difference is benign. Reported,
      // not swallowed.
      const resynced = new Set();
      for (const [label, log] of Object.entries(syncLogs)) {
        if ((log || []).some((e) => e.kind === 'send' && e.detail?.t === 143)) resynced.add(label);
      }
      // Explained per STREAM and per SIDE. Both matter, and the first version of
      // this check got both wrong:
      //
      // - When several observers resync at different moments, each holds serve
      //   traffic the others lack, so the SAME pair shows extras in BOTH
      //   directions. Requiring "extras on one side only" therefore fails to
      //   explain the very case that produces the most resync noise.
      // - Filtering by message TYPE does not work, and trying it was the second
      //   wrong answer here. A re-serve replays whole StrokeTape bundles — the
      //   tool-state preamble AND the MD/MM/MU geometry AND commit verbs like
      //   FILL — so "tool-state types only" rejects every real serve artifact.
      //   Widening the type list to cover it would accept almost everything and
      //   the oracle would stop being an oracle.
      //
      // The discriminator is DIRECTION, not type. `tapeDiff` labels each op from
      // the baseline's point of view: `extra` = present in B only, `missing` =
      // present in A only. A re-serve can only ever ADD messages to the client
      // being served, so for pair A↔B:
      //
      //   extra   ops are explained iff B resynced
      //   missing ops are explained iff A resynced
      //
      // A message genuinely dropped for a client that did NOT resync still fails,
      // which is the case this oracle exists to catch.
      const failingPairs = (tapeResult.streams || []).filter((s) => !s.ok);
      const unexplained = failingPairs.filter((s) => {
        // tapeDiff emits `pair` as an ARRAY [baselineLabel, otherLabel]
        // (tapeDiff.mjs:358/392). Coercing it with String() yields "A,B", so
        // splitting on ↔ produced left="A,B" and right=undefined — and since
        // `resynced.has(undefined)` is always false, BOTH branches below were
        // always true and every single tape difference was reported as
        // "NOT explained by a resync". The direction logic underneath is right;
        // it just never got a label to test.
        const [left, right] = Array.isArray(s.pair)
          ? s.pair
          : String(s.pair || '').split(/\s*↔\s*/).map((x) => x.trim());
        // `ops` is null when diffStreams gave up (entry.truncated), and then the
        // only evidence is a raw count mismatch. Treating that as "no ops, so
        // explained" would silently excuse the largest divergences — exactly the
        // ones big enough to blow the diff budget.
        if (s.truncated || s.ops == null) return true;
        for (const o of s.ops) {
          if (o.op === 'extra' && !resynced.has(right)) return true;
          if (o.op === 'missing' && !resynced.has(left)) return true;
        }
        return false;
      });
      const explained = failingPairs.length > 0 && unexplained.length === 0;
      tapeResyncExplained = explained;
      if (resynced.size) {
        console.log(`  ℹ mid-run resync requested by: ${[...resynced].join(', ')}`
          + ` — that client was re-served a tool-state preamble the others never saw.`);
      }
      if (!tapeResult.ok && explained) {
        console.log(`  ℹ every tape difference is EXTRA messages on the side of a client that`);
        console.log(`     resynced — a serve artifact, not a delivery failure. Nothing was dropped.`);
        console.log(`     The resync itself is still the signal worth chasing.`);
      } else if (!tapeResult.ok) {
        if (resynced.size) {
          console.log(`  ⚠ ${unexplained.length} of ${failingPairs.length} failing stream(s) are NOT explained by a resync`);
          for (const s2 of unexplained.slice(0, 4)) {
            // Report the DIRECTION too — "missing on a client that never
            // resynced" is the actionable half, and it reads identically to a
            // benign extra without it.
            const miss = (s2.ops ?? []).filter((o) => o.op === 'missing').length;
            const extra = (s2.ops ?? []).filter((o) => o.op === 'extra').length;
            const kinds = [...new Set((s2.ops ?? []).map((o) => o.event?.typeName))].join(',');
            console.log(`     ${s2.pair} u${s2.user}: ${miss} missing / ${extra} extra — ${kinds}`);
          }
        }
        allPass = false;
      }
    } else {
      console.log('  ⚠ fewer than 2 tapes captured — skipping tape diff');
    }
  }

  fs.writeFileSync(path.join(RESULTS_DIR, 'summary.json'), JSON.stringify({
    runId: RUN_ID, room: ROOM, pixelTolerance: PIXEL_TOLERANCE, passPct: PASS_PCT,
    observers: OBSERVERS,
    waves: WAVES, vus: VUS, duration: DURATION, undoWeight: UNDO_WEIGHT, specialChance: SPECIAL_CHANCE, specialOnly: SPECIAL_ONLY,
    seed: SEED, layers: LAYERS, tools: TOOLS, redoChance: REDO_CHANCE,
    noBlend: NO_BLEND, noPattern: NO_PATTERN, noBake: NO_BAKE, bakeDefer: BAKE_DEFER,
    cpuLag: CPU_LAG, netLag: NET_LAG,
    fixEmptyLayer: FIX_EMPTY_LAYER, bakeViolations, bakeCost, bakeLedger, lagReport, peerDiffs, missingBy, consoleDrops,
    coverage, coverageOk,
    replayParity,
    waveResults,
    lateJoin: LATE_JOIN ? { pixel: joinPixel && { pass: joinPixel.pass, matchPct: joinPixel.matchPct, maxDelta: joinPixel.maxDelta }, tape: joinTape } : null,
    diffs: Object.fromEntries(Object.entries(diffs).map(([k, d]) => [k, { pass: d.pass, matchPct: d.matchPct, maxDelta: d.maxDelta }])),
    tape: tapeResult && {
      ok: tapeResult.ok,
      resyncExplained: tapeResyncExplained,
      failures: tapeResult.failures,
      streams: tapeResult.streams.map((s) => ({
        pair: s.pair, user: s.user, countA: s.countA, countB: s.countB, ok: s.ok,
        ops: (s.ops ?? []).slice(0, 60).map((o) => ({ op: o.op, type: o.event.typeName, canon: o.event.canon })),
      })),
      seq: tapeResult.seq.map((s) => ({
        pair: s.pair, shared: s.shared, ok: s.ok,
        mismatches: s.mismatches.slice(0, 60).map((m) => ({ seq: m.seq, a: m.a.canon, b: m.b.canon })),
      })),
    },
  }, null, 2));

  console.log('\n' + '─'.repeat(56));
  const pixelOk = Object.values(diffs).every((d) => d.pass);
  // The late joiner is a separate verdict and must not be swallowed by the
  // observer-trio result — the trio can agree perfectly while a joiner rebuilds
  // a different board, which is exactly what happened the first time this ran.
  // The tape half of the join verdict only counts when it was applicable — i.e.
  // no checkpoint was served, so the joiner really did rebuild from commands.
  const joinTapeOk = joinTape ? (joinTape.applicable === false ? true : joinTape.ok) : true;
  const joinOk = !LATE_JOIN || ((joinPixel?.pass ?? true) && joinTapeOk);
  if (LATE_JOIN) {
    console.log(joinOk
      ? 'RESULT (join): the joiner rebuilt the accumulated board faithfully ✅'
      : 'RESULT (join): the joiner DIVERGED from the incumbents ❌');
  }
  const replayVals = Object.values(replayParity);
  if (replayVals.length) {
    const asserted = Object.entries(replayParity).filter(([, r]) => r.applicable !== false);
    const bad = asserted.filter(([, r]) => !r.pass).map(([l]) => l);
    const skipped = replayVals.length - asserted.length;
    // Say how many were actually asserted. A run where every client resynced
    // asserts nothing here, and reporting that as "all N replay back ✅" claims
    // a guarantee the run did not establish.
    if (asserted.length === 0) {
      console.log(`RESULT (replay): not asserted — all ${replayVals.length} clients resynced mid-recording ℹ`);
    } else if (bad.length) {
      console.log(`RESULT (replay): ${bad.join(',')} did not replay back to their own live board ❌`
        + (skipped ? `  (${skipped} not asserted — resynced)` : ''));
    } else {
      console.log(`RESULT (replay): ${asserted.length} of ${replayVals.length} tapes replay back to their own live board ✅`
        + (skipped ? `  (${skipped} not asserted — resynced)` : ''));
    }
  }
  if (!coverageOk) {
    console.log(`RESULT (coverage): the feed did NOT exercise everything it advertises ${REQUIRE_COVERAGE ? '❌' : '⚠'}`);
  }
  if (tapeResult) {
    // The two oracles read together — this is the line that says where to look.
    const tapeEffectivelyOk = tapeResult.ok || tapeResyncExplained;
    if (tapeEffectivelyOk && pixelOk) {
      console.log(`RESULT (live ${OBSERVERS.length}-way): converged — same bot input, same output ✅`
        + (tapeResyncExplained ? ' (one client resynced mid-run; its extra serve traffic is accounted for)' : ''));
    } else if (tapeEffectivelyOk) {
      console.log('RESULT: identical input, different pixels ❌ — bug is INSIDE a client (ordering/undo/blend), not transport');
    } else {
      console.log('RESULT: observers received DIFFERENT input ❌ — bug is in transport (sanitizer/relay/handler)');
    }
  } else {
    console.log(allPass ? 'RESULT: all observers see bot strokes identically ✅' : 'RESULT: observer divergence detected ❌ (see diff_*.png)');
  }
  // The bake verdict gets its own RESULT line. It is the only oracle here that
  // is exact, so it must not be inferred from the pixel line above it.
  if (bakeLedger) {
    const t = bakeLedger.totals;
    if (bakeLedger.verdict === 'UNKNOWN') {
      console.log('RESULT (bake): nothing was flattened — this run does not exercise the bake path ℹ');
    } else if (bakeLedger.verdict === 'DIVERGED') {
      console.log(`RESULT (bake): clients flattened strokes in DIFFERENT orders ❌ `
        + `(${t.inversions} inversions, ${t.zInversions} z-order) — permanent, unrecoverable`);
    } else if (t.prefixDelta > 0) {
      console.log(`RESULT (bake): same order, different prefixes ℹ (delta ${t.prefixDelta}, `
        + `worst pair ${t.worstPrefixDelta}) — the quantity the deferral targets`);
    } else {
      console.log('RESULT (bake): every client flattened the same strokes in the same order ✅');
    }
  }
  if (LAG_ON && !lagReport?.verified) {
    console.log('RESULT (lag): configured lag did NOT materialise — bake numbers are not attributable ❌');
  } else if (LAG_ON) {
    console.log(`RESULT (lag): lag confirmed ✅ (queue ${lagReport.queueMoved ? 'built up' : 'stayed empty'}, `
      + `skew max ${lagReport.skew?.maxMs ?? 0}ms)`);
  }
  console.log(`Results: ${RESULTS_DIR}`);
  console.log('─'.repeat(56));
  if (!joinOk) allPass = false;

  process.exitCode = allPass ? 0 : 1;
  } finally {
    for (const o of obs) await o.browser.close().catch(() => {});
  }
}

main().catch((err) => { console.error('Uncaught:', err); process.exit(2); });
