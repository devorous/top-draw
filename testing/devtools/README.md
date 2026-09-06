# Replay Parity Suite

Verifies that the local **Recorder + ReplayEngine** produces pixel-identical
output to the live drawing path.

Three tabs are driven via the Chrome DevTools Protocol (puppeteer wraps CDP):

| Tab | Role | In room? |
|---|---|---|
| A — drawer | Performs the test action; records its own session via `app.recorder` | yes |
| B — observer | Passive live mirror — sanity-check that broadcast still works | yes |
| C — replayer | Boots `/go/` but stays out of the room; receives the bundle from A and plays it through `TimeMachine.loadFromRecording` | no |

For every test case we run **two** diffs using the same tolerance fixture as
the comprehensive sync suite (`testing/lib/layerDiff.mjs`):

- **A ↔ B** — live broadcast/handler parity. If this fails, the live path
  itself is broken; the replay diff doesn't tell us anything new.
- **A ↔ C** — recorder + replay parity. **Catches replay-only regressions.**

A regression visible only in A↔C means the Recorder or ReplayEngine has
drifted from the live path — exactly the gap the doc 000REPLAY_SYSTEM.md
calls out as the correctness gate.

## Running

```bash
# Make sure the dev server is up (vite + ws server)
npm run dev   # in another terminal

# Full suite, headless
node testing/devtools/replay_parity_suite.mjs

# Just one case, visible browser windows
node testing/devtools/replay_parity_suite.mjs --headed --only=brush_step_1

# Via the npm script
npm run test:parity
```

Results land in `testing/sync_results/parity_<RUN_ID>/summary.json`.

## Interactive MCP usage

For ad-hoc spot checks, the same flow can be driven by the
`mcp__chrome-devtools__*` MCP tools rather than the scripted suite. The MCP
attaches to your installed Chrome — handy when you want to step through a
failing case manually:

1. `mcp__chrome-devtools__new_page` × 3 — drawer, observer, replayer.
2. `mcp__chrome-devtools__evaluate_script` on drawer & observer to
   `handleRoomSelected(room)`; on replayer skip the join.
3. `evaluate_script` → `window.app.recorder.start(window.app)` on drawer.
4. Drive the action via `evaluate_script` (same helpers as
   `replay_parity_suite.mjs`).
5. Capture snapshots from drawer & observer using
   `captureLayerSnapshotsInPage` (paste from `testing/lib/layerDiff.mjs`).
6. `evaluate_script` → `JSON.stringify(window.app.recorder.stop())` and feed
   the bundle into the replayer via
   `TimeMachine.loadFromRecording(...)`.
7. Capture from replayer using `captureReplayLayerSnapshotsInPage`.
8. Diff in Node with `diffSnapshots(snapsA, snapsC)`.

Because the diff oracle lives in one file, both runners ship the same
guarantee.

## Adding a test case

Append to `TEST_CASES` in `replay_parity_suite.mjs`. Each case is:

```js
{
  name: 'my_case',
  action: async (page) => {
    await selectTool(page, 'brush');
    await setToolSettings(page, { size: 30, color: [220, 60, 60, 1], hardness: 100 });
    await drawPath(page, [{ x: 300, y: 300 }, { x: 700, y: 400 }]);
  },
}
```

The action runs **only on the drawer**. The harness handles recording,
replay, snapshotting, and diffing.

## Known caveats

- This suite diffs the drawer's live board against the replay **per layer
  group** (`diffSnapshots(snapsA, snapsC)`). That is only safe because its cases
  are short single-drawer sessions that stay on layer 0, so the replay rebuilds
  strokes into matching groups. It is **not** generally safe: once a recording
  is long enough to carry flat composite checkpoints, the replay restores the
  whole board into group 0 and a per-group diff collapses (the k6 observer suite
  hit exactly this — see "live↔live is a per-LAYER diff; live↔replay is a
  WHOLE-BOARD diff"). If you add a multi-layer case here and it fails at ~70%
  with no visible difference, switch this comparison to
  `makeCompositeEvaluator` rather than hunting the ReplayEngine.

- Determinism relies on the pinned `Math.random` + frozen `Date.now`
  (set in `evaluateOnNewDocument`). Tools that consume RNG outside the
  pinned `Math.random` (e.g. ones reading `performance.now()`) would drift.
- Confetti and other randomised tools are pixel-identical only under the
  pinned seed. The long-term fix (per-`T.MD` seed in the protocol) is
  Phase 3 in the doc.
- The replay viewer keeps the live canvases hidden (`_showReplayCanvas(true)`).
  The diff reads from the replay engine's `LayerManager` directly via
  `TimeMachine.getReplayLayerManager()`, not from the visible canvas — so
  the visibility state doesn't affect correctness.

---

# k6 → .ddraw → replay parity (`k6_ddraw_parity.mjs`)

Whereas `replay_parity_suite.mjs` drives the *drawer* tab with synthesised
local pointer input, this harness validates the recording pipeline against
**real server-relayed traffic** and writes/loads **actual `.ddraw` files**
through the production `ddrawCodec`:

1. A browser "recorder" tab joins a room and starts `app.recorder`.
2. `_k6_ddraw_feed.js` floods the room with render-deterministic strokes from
   N k6 virtual users. The recorder taps every inbound message.
3. The recorder's **live** canvas is snapshotted once it is *pixel-stable*,
   then the tape is stopped and `encodeDdraw`'d to
   `testing/ddraw/k6_feed_<RUN_ID>.ddraw`.
4. That file is read back from disk and replayed in several configs
   (`out_of_room`, `in_room`); each replay's `LayerManager` is diffed against
   the live snapshot with the shared `layerDiff` oracle.
5. Any other `.ddraw` already in `testing/ddraw/` is loaded + replayed as a
   portability smoke check (decode + non-blank paint; no live oracle).

```bash
npm run dev                                   # vite + ws server (port 8030)
npm run test:k6parity                         # default: 3 VUs × 6 strokes, mixed tools
node testing/devtools/k6_ddraw_parity.mjs --vus=5 --strokes=8
node testing/devtools/k6_ddraw_parity.mjs --tools=line,rectangle,circle  # geometry only
node testing/devtools/k6_ddraw_parity.mjs --tools=brush --hardness=100   # opaque brush
```

Results (summary.json, screenshots, `diff_<config>.png` on failure, k6 log)
land in `testing/sync_results/k6ddraw_<RUN_ID>/`.

## Harness gotchas (learned the hard way)

- **Do not freeze `Date.now()`** here. The Recorder stamps each delta with
  `Date.now()` and the replay seek slices the tape by those timestamps. A
  frozen clock pushes the seek-to-end target *before* any real-timestamp tape
  (e.g. a pre-existing `.ddraw`), so it replays **0 actions**. We pin
  `Math.random` only; the feeder is render-deterministic so wall-clock drift
  is irrelevant to pixels.
- **Snapshot the live canvas only while bots are still connected.** Remote
  draws only render for users currently in `app.users`; the feeder holds its
  sockets open (`LIFETIME_MS`) and warms up (`WARMUP_MS`) before drawing so the
  observer has registered it first.
- **Settle on pixel-stability, not stroke count.** A stroke is committed
  (`strokeStack` count++) *before* the observer finishes incrementally
  rendering its buffered points, so a count-stable canvas can still be
  half-painted. Wait for two consecutive identical live snapshots.
- **`.ddraw` files carry a baked visual-checkpoint grid**, so
  `loadFromRecording` takes the fast preview path and runs the full-resolution
  `seek(sessionEnd)` in the **background**. Wait for `_lastAppliedTimestamp ===
  sessionEnd && !_isSeeking` before capturing the replay.
- Tapes with no undo/redo trigger `setEagerBakeUsers`, which bakes every stroke
  straight into `flatCanvas` (so `strokeStack.length` stays 0 on replay — that
  is expected; the pixels are in `flatCanvas`, which the diff captures).

---

# 3-user SYNC state suite (`sync_state_join_suite.mjs`)

Targets the part of the sync model the other harnesses skip: **board state that
has crossed the bake threshold** (`MAX_STROKES_PER_USER = 20`), combined with
**undo** and a **pending (un-redone) redo stack**, and then a **fresh user
joining** into that state — the `sync_checkpoint_join_bakes_undoable` danger zone
(baked strokes leave the live `strokeStack`, so a naive join hands the joiner a
baked image with no undo history).

Three live tabs (A, B, C) each draw 24 strokes round-robin (so seqs interleave
and every user keeps some live, undoable strokes after baking), then per state:

| State | Op after build |
|---|---|
| `baked` | none (just verifies baking happened) |
| `undo` | A undo×3, B undo×3 |
| `pending_redo` | A undo×3 — left redoable, **not** redone |

Per state it asserts:

1. **Baking actually occurred** — `flatCanvas` / watermark > 0 (we're really on the baked path).
2. **Live parity (A,B,C)** — equal `strokeLog` (count/latestSeq/rollingHash), pixel diff A↔B / A↔C within the shared `layerDiff` tolerance, equal live `strokeStack` totals, and equal per-user redo-stack sizes.
3. **Undo wasn't a no-op** — each operated user's redo stack grew by exactly the undo count, *replicated on every peer*.
4. **Late-join parity** — a 4th tab (D) joins AFTER the state exists and converges to A's pixels.
5. **Post-join remote undo/redo** — A then undoes/redoes and D must mirror it (the exact op the baked-join bug breaks on the joiner).

```bash
npm run dev            # vite :3000 + ws server :8030
npm run test:syncstate                                   # all 3 states, fresh rooms
node testing/devtools/sync_state_join_suite.mjs --only=undo --headed
node testing/devtools/sync_state_join_suite.mjs --strokes=30
node testing/devtools/sync_state_join_suite.mjs --lobby  # persistent room (see below)
```

Results land in `testing/sync_results/statejoin_<RUN_ID>/` (per-state live/late/post
screenshots + `*diff*.png` on failure + `summary.json`).

## Harness gotchas (learned the hard way)

- **Assert AGREEMENT, not an absolute stroke count.** Driving pointer events
  through the tick/input-buffer pipeline with wall-clock sleeps splits/merges
  strokes, so the committed count is nondeterministic run-to-run (seen swinging
  67↔78 for a nominal 72). The real invariant is that all peers converge on
  *whatever* was committed — `waitTrioConverged` polls until logCount + rolling
  hash + live stack agree and hold across two reads.
- **Wait for the trio to re-converge AFTER undo/redo before snapshotting.** An
  early snapshot caught `A=B=45, C=41` — a false desync that was just the undo
  still propagating to C. Re-converging first makes it reliable; a *persistent*
  disagreement after the generous timeout is the genuine-bug signal.
- **`--lobby` is the only way to hit the baked-snapshot-base join.** A fresh
  room is never persistent (`canPersistSnapshots()` = lobby or registered only),
  so a joiner always replays the full command tail and can't reproduce the
  truncated-log / baked-base condition. `--lobby` runs in the real `lobby`,
  waits past the 15s server snapshot timer before the late join so a checkpoint
  mints + the log truncates, and then checks the joiner. (Writes strokes into
  the live lobby — opt-in.) Validated 2026-06-14: all three states pass the
  baked-base join + post-join remote undo/redo there.

## Finding: soft-stroke observer-replay divergence

With **shapes** (line/rect/circle) or a **hard opaque brush**
(`--hardness=100`), an observer's recording replays **pixel-identical**
(100.0%, maxΔ 0). With **soft brushes (hardness < 100)** and stamp/opacity
buildup (pen), observer-recorded replays land at ~95–99% — the live observer's
incremental remote-render of feathered/stamped strokes differs from the replay
engine's batch render. Geometry and final hard pixels are exact; the gap is
purely soft-edge/opacity accumulation. (The original drawer's *own* outbound
strokes replay exactly — this only affects an **observer's** recording of
**remote** soft strokes.)

## board_state_compare.py — multi-window board diffing

Compares the composited board canvas across several live clients (three or more
Chrome windows driven over the DevTools MCP) and reports how closely they agree.
Rendering is never bit-exact between clients — antialiasing, soft-brush falloff
and blend rounding drift a channel or two — so **hashing is useless here**; this
scores agreement per pixel with a tolerance instead.

    # capture one file per window (see board_capture.js for the snippet)
    evaluate_script({ function: "<captureBoard>", filePath: "captures/A.json" })

    # diff them
    python testing/devtools/board_state_compare.py captures/ --baseline A \
        --out captures/diffs

Two thresholds per pixel: `--tolerance` (default 8) is the max per-channel delta
still counted as identical, absorbing antialiasing noise; `--structural`
(default 48) is the delta above which a pixel counts as **real** missing/extra
ink. A pair passes at `--threshold` match% (default 99.0) with at most
`--max-structural` structural px — an absolute count or a percentage of the
canvas, default `0.05%` (~1,800 px at 2560x1440). Exit code gates a suite.

The structural budget is deliberately non-zero. Where geometry shifts by a
sub-pixel amount, individual antialiased edge pixels differ by a lot (deltas
near 100) while amounting to almost nothing overall — an observer ends a shape
on the last MM sample whereas the drawer ends it on the true pointer-up point
(`broadcastMouseUp` sends no position), so every shape has a faint edge
disagreement between drawer and observers while the observers agree with each
other exactly. 0.05% sits well above that and well below a whole missing stroke.

Failures print the bounding box of the structural differences and write a diff
image (structural = red, sub-threshold = blue), which usually names the
offending stroke on sight.

**Always pass the MCP tool's `filePath`** when capturing — a 2560x1440 PNG data
URI is multiple megabytes and must not land in the agent transcript.

**Capture `board.viewCtx.canvas`, never a page screenshot.** Screenshots include
cursors, remote-user overlay canvases, the marching-ants selection outline and
the zoom level — none of which are board state, all of which legitimately differ
between clients. Quiesce ~1s after the last action so the 60 TPS tick loop has
drained and composited, or you are timing the render rather than comparing state.

Validated 2026-08-06 against a real desync: a remote circle rendered with the
*observer's* shape-draw-mode came out 2.8x oversized, and the tool isolated it
as `98.5024% match / 54,180 structural px / region x=1229 y=0 w=742 h=671` while
the other three clients held at exactly 100%. After the per-user shape-mode fix
the same three-window scenario reads `99.91–99.97% / 89–259 structural px` — a
50x margin under the default budget, so the check separates the two states
cleanly rather than by a hair.

## selection_parity_suite.mjs — every Select verb, 3 clients + a late joiner

    npm run test:selparity
    node testing/devtools/selection_parity_suite.mjs --list
    node testing/devtools/selection_parity_suite.mjs --only=fill,merge_all --headed
    node testing/devtools/selection_parity_suite.mjs --no-join

20 scenarios covering delete (rect/lasso/Delete-key/all-layers/mirrored), move +
commit, cancel-restore, cut/paste, clone, fill (rect + lasso), flip, stamp,
select-all, merge up/down/all, and undo-after-delete / undo-after-move. Each is
checked for LIVE parity (A↔B, A↔C) and LATE-JOIN parity (A↔D) — those fail
independently on purpose: live-only points at the remote handler, join-only at
the strokeLog / StrokeTape / commit ordering.

Deterministic by design: fixed client coordinates driven through the real
pointer/tick pipeline and the real context-menu handlers, so a failure reproduces
byte-for-byte and can be bisected. (k6 finds *a* failure; this finds the same one
every time.) Failures print each tab's per-layer stroke stack side by side —
`L0:4*[S59 S69 S78 E129m]` is layer 0 with 4 strokes, `*` baked, `S`/`E` =
source-over / destination-out, the number is the seq, `m` = merge — which is
usually enough to name the bug without opening a diff image.

**Every scenario asserts the operation actually changed the actor's board** (or,
for the cancel/undo scenarios, provably restored it). Three clients agreeing on
an unchanged board proves nothing, and several of these verbs fail by silently
doing nothing.

Two gotchas that will bite any similar suite:
- Joining via `app.handleRoomSelected()` leaves the landing overlay flagged
  visible, and `KeyboardHandler.handleKeyDown` returns early on
  `app.landingPage?.isVisible` — so every keyboard scenario silently no-ops.
  spawnTab calls `landingPage.hide()` for this reason.
- The Select tool's default mode is **lasso**, not rect. A straight-line drag
  produces a zero-area path and the verb looks broken. Use `setMode('rect')` or
  drive a real closed polygon.

Baseline 2026-08-07: **18/20**. Known failing: `move_all_layers` (SEL_LIFT /
SEL_COMMIT still lack the all-layers flag SEL_DELETE now carries) and
`move_commit_then_undo` (live is fine; only a late joiner diverges).

---

# Wire-level tape parity (`tape_compare.mjs` + `testing/lib/tapeDiff.mjs`)

Every other oracle here scores **pixels**. This one compares the **input**: the
`.ddraw` tape each client's Recorder captured.

That distinction is the whole point. Two clients never render bit-identically —
antialiasing, soft-brush falloff and blend rounding drift a channel or two — so
`layerDiff` / `board_state_compare.py` must carry a tolerance and can only ever
conclude "close enough". A tape holds the decoded message stream, which admits
an *exact* answer, and when it fails it names the offending message instead of a
bounding box.

Read the two together — this is what makes a failure actionable:

| tapes | pixels | where the bug is |
|---|---|---|
| agree | agree | converged |
| agree | differ | **inside a client** — stroke ordering, undo bookkeeping, blend/bake |
| differ | differ | **transport** — validation sanitizer, server relay, a message handler. Fix this first; the pixel diff is downstream of it. |

## Manual use (the record-button workflow)

In every window: **Record → Start**, draw, then **Stop → Save**. Every client
must be recording over the same wall-clock window; the tool clips to the overlap
and tells you if there isn't one.

    npm run test:tapediff  ~/Downloads/A.ddraw ~/Downloads/B.ddraw ~/Downloads/C.ddraw
    node testing/devtools/tape_compare.mjs captures/ --baseline=A --ignore-types=MM -v

## What it checks

1. **Per-sender streams** — a single WebSocket preserves order, so for any user
   U every client must observe U's messages in identical order with identical
   payloads. Diffed by LCS, so one dropped message reports as one op instead of
   misaligning everything after it. This is the check that catches a field
   stripped by the sanitizer, a message never relayed, a join-window duplicate.
2. **Seq agreement** — the server numbers commit-class messages, so two tapes
   must agree on what seq N *was*. Disagreement is the "erase floated to the top
   of the stack" class of bug.
3. **Per-type coverage** — a whole missing verb is visible before you read a diff.

## Normalisation — and why each step is required

These are not fudge factors; without them every message "differs" and the real
signal is buried.

- **proto3 defaults dropped** (`0` / `false` / `''` / `[]`). A client's own
  messages are taped **outbound** as the sparse object it constructed; the same
  message reaches every other client **inbound** as a fully-populated protobuf
  decode carrying ~25 empty repeated fields. Cost: an explicit `0` and an absent
  field are indistinguishable — which is exactly how the client reads them
  (`data.ly ?? 0`), so no real coverage is lost.
- **Floats rounded to 1 dp** (`WIRE_PRECISION`) — *the wire's own precision*. A
  sender tapes the raw pointer float (`ps:[310.08, 36.28]`); receivers tape what
  was actually transmitted (`ps:[310.1, 36.3]`). Rounding tighter than the wire
  makes every MD/MM differ.
- **`fixed32` fields normalised with `>>> 0`.** `packColor([220,50,50,1])` is
  **-600689921** because `220 << 24` overflows into the sign bit, while the
  decode is **3694277375**. Identical 32 bits, opposite JS signs.
- **`seq` excluded from the payload fingerprint**, checked separately: the
  Recorder drops the inbound self-echo of a client's own commits, so the sender's
  tape holds that message *without* the server's seq while every observer holds
  it *with* one. By design, not a desync.

## Gotcha: arm the recorders AFTER the join settles

The last client to join is served a checkpoint + command tail ending in a
tool-state resend for every user already in the room; the incumbents never see
it. Recorded, that reads as "C received 36 messages A and B did not" — a real
difference, but a join artifact. Both suites below wait for convergence before
arming. For late-joiner comparisons pass `clipToWindow: false`: the joiner tapes
the tail at *application* time, not origin time, so a wall-clock clip would throw
the entire tail away.

---

# Concurrent draw + undo suite (`npm run test:concurrent`)

Every other harness drives ONE actor and checks the observers followed. That
misses the class of bug that only appears when several users mutate the board at
the same instant: seq ordering between interleaved commits, undo racing another
user's stroke, a stroke landing above or below someone else's depending on who
you ask.

N clients draw **simultaneously** — each round fires through `Promise.all` so the
MD/MM/MU streams genuinely interleave on the wire and the server assigns seqs
across authors rather than in tidy per-author blocks — with a different tool
**and a different layer** per client per round, and periodic undo/redo. Checked
with **both** oracles above.

    npm run test:concurrent
    node testing/devtools/concurrent_draw_undo_suite.mjs --clients=4 --rounds=12 --undo-every=2
    node testing/devtools/concurrent_draw_undo_suite.mjs --headed --no-undo
    node testing/devtools/concurrent_draw_undo_suite.mjs --tools=brush,line,eraser
    node testing/devtools/concurrent_draw_undo_suite.mjs --layers=0   (old single-layer behaviour)

**The layer rotation is newer than the rest and matters more than it looks.**
Each layer group keeps its own `strokeStack`, its own bake threshold and its own
`flatCanvas` (only layer 0 gets one at construction), and undo resolves through
whichever group the stroke landed in — so "undo racing another user's stroke"
is a materially different operation when the two users are on different layers.
Until this rotation existed the suite drew everything on layer 0, so the only
oracle in the tree that reproduces byte-for-byte never touched any of it.

Each round every client draws two strokes: one in its own horizontal lane (so a
diff image is legible per author) and one crossing a shared contention band.
The overlap is deliberate — z-order between interleaved commits is only
observable where strokes cover the same pixels.

Undo passes fire on **all** clients at once; redo fires on **half**, so the redo
stacks legitimately diverge per user while every client must still agree on the
resulting board.

Baseline 2026-08-07: 4 clients × 12 rounds × 7 tools with 6 undo+redo passes —
tapes byte-identical (859 seq checks), pixels 99.73–99.98%.

Baseline 2026-08-09, **with the layer rotation added**: 4 clients × 10 rounds ×
7 tools rotating layers 0/1/2, undo every 2 rounds — pixels A↔B 99.95%, A↔C
99.93%, A↔D 99.93%; tapes agree (770 seq checks); late joiner 99.96% with 0
board-state messages missing from its rebuilt tail. So spreading the same
concurrent-undo workload across three layer groups did **not** destabilise it —
worth stating explicitly, because it makes the multi-wave k6 divergence below a
finding about that workload rather than about layers in general.

---

# Harness fidelity audit (`npm run test:k6audit`)

`k6_wire_audit.mjs`. Static, no server, no browser, ~50 ms. Run it before
trusting any result from this tree.

Two questions, one runner, because the same failure mode produced both: **a
harness that quietly disagrees with the product reports GREEN**, since it
disagrees identically on every client at once.

1. Do the bots send what a real client sends?
2. Does the pixel oracle still delegate to the product's compositor
   (`compositeLayerRange`) rather than re-implementing it, and does it account
   for `bakedSequences`?

Check 2 was added after the oracle drifted twice — see the compositor section
below. Verified by reintroducing a hand-rolled composite and confirming the
audit fails.

Every pixel and tape number in this tree rests on one unstated premise: that the
bots send what a real browser sends. Nothing checked that premise, and **it was
false in five places at once**. The failure mode is silent and self-reinforcing —
a feed can send a field the client ignores, and every suite still reports green,
because the bots and the observers agree with each other about a message that
does nothing.

| what the feed sent | what the client reads | effect |
|---|---|---|
| `CSDM {g: mode}` | `data.sdm` | shape draw mode **never applied** — every shape drew corner-to-corner regardless |
| `CSIM {sim: 1\|0}` | `0=unset, 1=false, 2=true` | simulate-pressure **never true** |
| `CTHN {th: n}` | `(th ? th-1 : 50)/100` | thinning off by one; `th:0` silently meant "use 50" |
| `FILL {c: colour}` | FILL has no `c` | fill colour was **inert**; fills used whatever `CC` last set, so the harness believed a colour it had not set |
| `CBM {bm}` | `bm` + `ly` + `bbm` | no layer (skips the re-composite) and `bbm` defaulted to `existing`, the branch real clients never take |

Three checks:

1. **T enum agreement** — `testing/_k6_actions.js` vs `shared/MessageTypes.js`.
2. **Field agreement, per type** — for every `buildMsg({t: T.X, …})` in any k6
   file, each field must be one that `WebSocketClient`'s `case T.X` actually
   reads. Helper keys are resolved through `buildMsg`'s field NUMBER and the
   proto's camelCase name first, or every snake_case field reports as a false
   mismatch and buries the real ones.
3. **Encoder coverage** — a field `buildMsg` doesn't know is dropped before the
   wire.

Two legitimate exemptions, both narrow on purpose: fields only `ReplayEngine`
reads (`SEL_MOVE.cbt`) and fields only the **server** reads (`CONNECT.n`). The
ReplayEngine exemption is matched **per message type** — a global "does
ReplayEngine mention this field anywhere" set excuses everything, because short
names like `c` and `s` appear under some type or other, and that leniency hid
the FILL finding on this tool's own first pass.

---

# k6 bot feed + tape parity (`npm run test:k6obs`)

`k6_lowstress_observers.mjs` runs **four** observers (`--observers=N`) and checks
**four oracles**, reported separately because folding any into the others hides
the case it exists to catch:

| oracle | question | fails alone when |
|---|---|---|
| pixels | do the observers agree on the board? | a renderer/ordering bug |
| tape | did they receive the same bytes? | transport: sanitizer, relay, handler |
| **replay** | does each observer's own tape replay back to its own live board? | Recorder→ReplayEngine round trip, for all four equally |
| **coverage** | did the traffic contain the tools/layers/verbs claimed? | the feed silently stopped exercising something |

Coverage is the one that looks like bookkeeping and isn't. Agreement on a board
that only ever saw one tool on one layer is *perfect* agreement — so a feed that
quietly loses a feature makes every other number look **better**. It gates the
run (`--no-coverage-gate` to demote to a warning).

    node testing/devtools/k6_lowstress_observers.mjs --vus=3 --duration=25s
    node testing/devtools/k6_lowstress_observers.mjs --observers=4 --waves=3 --seed=4242
    node testing/devtools/k6_lowstress_observers.mjs --no-replay-parity   (skip the replay oracle)

Baseline 2026-08-09, 4 observers × 3 VUs × 25 s, seed 1337:

    pixels    A↔B 100.000%  A↔C 99.924%  A↔D 99.995%
    tape      4971 seq checks, every per-sender stream identical
    replay    A B C D all 100.000%, maxΔ 0
    coverage  16 tools · layers 0,1,2 · 5 complex blends · 11 selection verbs
              (incl. rect AND lasso lifts, mask, merge, flip) · both shape draw
              modes · both text kinds · undo 8 / redo 4 · pressure 49 ·
              stamp radii 1648 · eraseAll 5 · fill 7 plain + 6 with expansion

**Definitive baseline 2026-08-09**, after the full oracle rewrite below —
4 observers × 3 VUs × 25 s, seed 1337, all four oracles green:

    pixels    A↔B 100.000%  A↔C 99.809%  A↔D 100.000%
    tape      AGREE — 5064 seq checks, every per-sender stream identical
    replay    4 of 4 tapes replay back to their own live board, 100.000% maxΔ 0
    coverage  ✅ every advertised capability appeared in the traffic

Baseline 2026-08-09 at load, 4 observers × 4 VUs × 30 s × **3 waves**, seed 4242,
all three layers, **after** the layerDiff seq-ordering fix below:

    pixels    every wave and every pair 100.000% (maxΔ 0–143)
    coverage  16 tools · layers 0,1,2 · 4 complex blends · 12 selection verbs ·
              both shape modes · both text kinds · undo 17 / redo 4 ·
              pressure 94 · stamp radii 6397 · eraseAll 9 ·
              fill 28 plain + 30 with expansion ·
              simPressure {true:21, false:19} · 30 distinct thinning values

The last two are **decoded values, not message counts**, and they exist because
the static wire audit cannot see an offset-encoding bug: `CSIM {sim:1|0}` is a
valid field carrying a value that decodes to "false or unset" under the wire's
`0=unset 1=false 2=true`, so simulate-pressure was never once true and nothing
could tell. Asserting that BOTH states appeared is the only way a harness catches
that class.

## The probe bug this found in the harness itself

Both in-page probes originally hooked `wsClient.handleMessage`. **The server
coalesces messages into batched frames**, and `onmessage` routes those through
`_decodeBatchedFrame` → `_messageQueue` → `_processMessageQueue` →
`_processMessage`, never touching `handleMessage`. A `handleMessage` hook
therefore sees only the unbatched minority — measured at **3 of 160 `CT` and 24
of 214 `CL`**, while reporting low-frequency types (`SEL_*`, `UNDO`/`REDO`)
perfectly.

That pattern is what made it invisible for so long: the types you eyeball in a
report are the rare ones, and those were exactly the ones that happened to be
right. Both probes now hook `_processMessage`, the single point both paths
converge on. **`__msgCounts` was wrong the same way**, which matters beyond
coverage — the joiner's "was a checkpoint served?" test reads
`syncCounts[99] > 0` from it.

## A mid-run resync is not a transport bug

A client that sends `SYNC_PARITY_RESYNC_REQUEST` (143) is re-served a tool-state
preamble for every user in the room, which nobody else receives. On its tape
that reads as "D got 14 messages A did not" — a real difference, and **not** a
delivery failure. The suite now correlates the two and says so, instead of
concluding "observers received DIFFERENT input — transport bug" and sending you
into the sanitizer after something the product did on purpose.

The correlation is deliberately narrow: it only excuses a difference that is
**purely extra messages** on the side of a client that actually resynced. A
*missing* message is never a resync artifact. And the resync itself is still
printed loudly — a client only asks for one after deciding its own board was
wrong, so it is evidence of a parity mismatch even when the tape difference it
causes is benign.

Low VU counts keep the tapes small and stay under the normal rate limits; 8 VUs
needs `npm run dev:stress`. The value over the scripted suite is the random tool
mix — text, selection transforms, flood fill, pattern/confetti brushes — which
fixed scenarios don't reach.

## What the feed covers now, and what it did not before

`testing/low_stress_test.js` was the sole source of "realistic" traffic for the
observer, joiner and AFK suites, so its blind spots were inherited by every
number those suites ever produced.

| | was | now |
|---|---|---|
| layers | every bot on layer 0, forever | rotates all 3 via `CL` (`LAYERS=`) |
| history | `UNDO` only | `UNDO` + `REDO`, redo deferred so peers' commits land in between |
| selection | lift/move/commit | + delete/fill/stamp/cancel/flip/merge/mask, rect **and** lasso |
| input | one point per `MM`, no radii | batched multi-point `MM` (tick-shaped) + per-point `rs`, `CP` mid-stroke |
| fill | colour was inert | `CC`-then-`FILL`, plus expansion and edge-blur |
| determinism | unseeded | per-VU seed; `SEED=` reproduces a run |

The layer axis is the biggest of these. Only layer 0 has
`allowComplexBlendModes` and only layer 0 gets a `flatCanvas` at construction
(`LayerManager.initLayerGroups`), so bake behaviour, blend clamping and undo all
interact differently per layer — and a single-layer feed could not reach any of
it. A complex blend aimed at layer 1 or 2 is correctly clamped to `source-over`
by the receiver; that is behaviour to assert, not a desync to chase.

**Two tools are deliberately excluded from the bot pool**, and the exclusion is
better than fake coverage. `glitchBlur` commits only via `GLITCH_RESULT`
carrying a rendered bitmap, which a headless VU cannot produce —
`handleMouseDown` skips it entirely, so a bot "drawing" with it emits MD/MM/MU
that every receiver discards while looking like a tested tool. `inkdropper`
samples a colour and commits no pixels. Both are covered by the browser-driven
suites instead.

## live↔live is a per-LAYER diff; live↔replay is a WHOLE-BOARD diff

These need different oracles and using one for both produces a confident wrong
answer.

**live ↔ live** (observers): every client builds the same layer structure from
the same messages, so a per-group diff is right and localises a divergence to a
layer.

**live ↔ replay**: the replay is under no obligation to distribute content across
groups the way the live board did. A `.ddraw`'s checkpoints carry
`openingSnapshot.canvasData` — **one flattened PNG of the whole board**, with no
per-layer payload — so `TimeMachine` restores the composite into group 0 and, for
a 5100-delta tape, logs:

    [TimeMachine] Seek 76.7ms (0 actions replayed)

That is the design working: it rebuilt from the nearest checkpoint. But a
per-group diff then compares live's *layer 0* against the replay's *all layers
flattened*, counts live's layers 1–2 as entirely missing, and reports ~70% for a
board that may be visually identical. The replay oracle now composites both
sides (`makeCompositeEvaluator`) and diffs that, which is what "does the
recording replay faithfully?" actually means.

Diagnosing this needs `testing/devtools/_replay_layer_probe.mjs` — one browser,
one tape, no k6. It prints the tape's own MD-by-layer histogram (ruling out "the
recording didn't carry the layer"), the checkpoint inventory, and the replay's
per-group contents as the seek settles.

**Know the blind spot you are accepting.** A composite diff cannot see a stroke
replayed onto the *wrong layer* when the flattened result looks the same — it
would catch it only once something else (a later erase, a blend) made the
misplacement visible. That is the deliberate trade: the alternative reports a
structural difference the format guarantees on every flat-checkpoint tape, i.e.
fails always and tells you nothing. The per-group structure is still dumped
alongside every failure (`struct_replay_<label>.json`), so the layer information
is there when a failure needs explaining — it is just no longer the pass/fail
criterion.

## The pixel oracle now calls the product's compositor (do not re-hand-roll it)

`captureLayerSnapshotsInPage` used to rebuild each layer by hand — draw
`flatCanvas`, then replay `strokeStack` in sorted order. That was a **second
implementation of the compositor living in the test tree**, and it drifted from
the real one twice, silently, both times only on paths nothing exercised:

1. it sorted the live stack by `timestamp` while the product sorts by `seq`
   (see the finding below);
2. it never read **`bakedSequences`** at all. `_compressStrokesToGroup` moves
   runs of strokes out of `strokeStack` into that collection, and on layers 1–2
   — which have no `flatCanvas` — that is where nearly everything ends up. A
   group whose content had all been compressed therefore looked **empty** and was
   skipped, so two boards could "agree at 100%" on a layer neither was comparing.
   Observed live: `group 1 hasFlat=false flatRecs=0 bakedSeqs=17 liveStack=0` —
   17 compressed runs of real ink, invisible to the oracle.

Both capture functions now call `lm.compositeLayerRange(ctx, gi, gi+1, null, null)`
— the same call `Board.compositeAllLayers` makes. That matters because a group
has **four** composite paths (`_compositeGroupWithFlatCanvas` / `Isolated` /
`Sequential` / `Into`), chosen by whether it has a flat canvas, a
`destination-out` stroke, and complex blends. Reproducing that in a harness is
not realistic; calling it is exact by construction.

Two details worth keeping if you touch this: `backgroundColor` is passed as
`null` so the capture stays transparent and `lm.backgroundColor` is not mutated,
and `needsComposite` is saved/restored because the call clears it — suppressing a
pending composite on a live board would make measuring it change it. None of the
four paths reference `this.board`/`this.app`, which is why the same call is safe
on the replay engine's LayerManager.

**Any harness that reconstructs a layer should call the compositor, not imitate
it.** Both oracle bugs in this file came from imitating it.

## FINDING (2026-08-09): the pixel oracle was wrong for any layer holding live strokes

Pointing the feed at layers 1–2 for the first time produced an apparently
catastrophic sync failure — 63–83% pixel match, degrading every wave. **It was
the oracle.** After the fix the identical run scores **100.000%, maxΔ 0**, on
every wave and every pair.

`captureLayerSnapshotsInPage` rebuilds a layer by compositing `flatCanvas` and
then the live `strokeStack`. It sorted that stack by **`timestamp` alone**. The
product sorts by **`seq` first** (`LayerManager._sortStrokeStack`), falling back
to timestamp only for optimistic seq=0 strokes.

`timestamp` is a per-client monotonic counter (`_getNextCommittedStrokeTimestamp`)
— arrival order. Wherever the server's seq order differs from arrival order,
which is the entire reason `seq` exists, the oracle reconstructed a different
z-order than the product renders, *differently on each client*, and reported a
divergence the real boards did not have.

**Why it survived this long: it is unreachable on layer 0.** Layer 0 is the only
group with a `flatCanvas` at construction, so its strokes bake out of the live
stack almost immediately and the reconstruction reads entirely from the baked
canvas — layer-0 runs settle at `live strokes = 0` and score exactly 100.000%.
Every k6 feed drew only on layer 0 until this rewrite. Layers 1–2 hold 15–120
live strokes, so the sort finally had work to do and got it wrong.

Both capture functions now mirror the product comparator. **Any harness that
reconstructs a layer from `strokeStack` must do the same**, or iterate the stack
as-is — the product already keeps it sorted.

### The bisect that got there, and one artifact of its own

| variant | layers | special pool | pixels (broken oracle) |
|---|---|---|---:|
| `oldish` | 0 only | old | 100.000% ✅ |
| `verbs` | 0 only | + selectionVerb | 99.891% ✅ |
| `layers` | 0,1,2 | old | 95.9–96.7% ❌ |
| `full` | 0,1,2 | everything | 92.9–94.8% ❌ |

The layer-0 rows are still valid — the bug cannot bite there — so the useful
surviving result is that **every new selection verb costs ~0.1%**. The
multi-layer rows were measuring the oracle and should not be quoted.

Chasing it also turned up a **second, independent harness bug worth knowing
about**, because it is a general trap: the feed tracked `blendMode` and
`activeLayer` as independent variables and stamped the blend onto every `MD`.
Only layer 0 has `allowComplexBlendModes`, and `App.handleLayerSelect` resets
blend to `source-over` when you select a restricted layer — so a real client
*cannot* have `multiply` active on layer 1. The bots could. The feed now mirrors
the UI transition (`switchLayer()`).

That one exposed a real product asymmetry on the way:

| path | on a restricted layer |
|---|---|
| `App.handleLayerSelect` (local) | **resets** blend to `source-over` |
| `DrawingHandlers 'cbm'` (remote) | **clamps** complex → `source-over` |
| `RemoteUserHandler.handleMouseDown` (remote) | applies `data.blendMode` **unclamped** |

`cbm` defends the layer restriction and `md` does not, so a complex blend
delivered via `MD.bm` commits on a restricted layer and bakes through the lossy
`_bakeFlatComplexBlendStroke` path. Not reachable from the UI, so it is
hardening rather than a live bug — but it is real.

**The lesson, since this cost two full bisects:** a feed can be wire-accurate and
still be unrealistic, and an oracle can be stable for years while being wrong on
a path nothing exercised. `test:k6audit` proves every field is one the client
reads; nothing proves the bot's *state machine* matches the UI's, or that the
oracle's reconstruction matches the renderer's. When a k6-only failure looks too
violent for the mechanism you suspect, **suspect the harness first** — both times,
that was the answer.

### Resolved: the live↔replay gap was the third oracle bug

It looked like the ReplayEngine losing layers. It was the per-layer diff being
the wrong comparison for a replay (see the live↔live vs live↔replay section
above). Ruled out with evidence rather than argument, which is the part worth
copying:

- **not eager bake** — `--no-eager-bake` moved it 77.8% → 78.4%, i.e. nothing;
- **not the recorder** — the tape's own histogram is `MD by layer
  {0:51, 1:35, 2:48}`, so the layer information was recorded;
- **not a dropped field** — `ReplayEngine`'s `case T.MD` passes
  `layerIndex: msg.ly`.

What it was: the tape's checkpoints are flat composite PNGs, so the replay
restores the whole board into group 0 and replays **0 of 5100 deltas**. Diffing
composites instead gives **100.000%, maxΔ 0** — which also proves the
zero-action seek did not drop the post-checkpoint tail.

One real asymmetry surfaced and is worth remembering even though it was not the
cause: `ReplayEngine`'s `case T.MU` calls `handleMouseUp(user)` with **no seq**,
so every replayed stroke commits at seq 0 and the replay orders by timestamp
throughout. That is deliberate and self-consistent — its `case T.SEL_DELETE`
comment explains that passing a real seq there would sort an erase below every
seq-0 stroke and make the erase vanish — but it does mean live and replay order
their live stacks by different keys, so never compare their `strokeStack`s
directly.

## Which earlier numbers this supersedes

Any result that depended on the *content* of bot traffic was measured against
traffic that could not exercise shape draw mode, simulate-pressure, non-zero
fill expansion, layers 1–2, redo, stamp radii, pressure, or most selection
verbs. That does not make those runs wrong about what they measured — a
convergence result is still a convergence result — but it does mean **absence of
a failure there was never evidence of coverage**, and any bug living in the
untested paths could not have been found by them. Re-baseline rather than
compare against them.

## Joiner tape rebuild — "did sync replay the stream faithfully?"

Both `test:selparity` and `test:concurrent` now record the **late joiner** too,
arming its recorder *before* it joins so the tape captures the entire sync serve
(checkpoint + replayed command tail). A joiner's tail is supposed to reproduce
the live stream the incumbents already saw, which turns "was the tape rebuilt
correctly by sync?" into an exact question rather than a pixel percentage.

Two things make this comparison different from the live one, and getting either
wrong produces pure noise:

- **Unclipped** (`clipToWindow: false`). The joiner tapes the tail at
  *application* time, not origin time, so a wall-clock overlap clip discards the
  entire tail.
- **Subsequence, not equality.** The incumbents' recorders arm just before the
  operation; the joiner replays the room's whole history. The joiner holding far
  MORE messages is correct. The failure condition is a `missing` op — something
  an incumbent sent that the rebuilt tail does not contain.

Reading a failure: anything folded into a **checkpoint** is baked into an image
rather than replayed, so a missing *prefix* can be a checkpoint rather than a
bug. Fresh rooms are never persistent (`canPersistSnapshots()` = lobby or
registered only), so these suites always get the full tail; on a persistent room
check for a minted checkpoint before chasing it.

The live verdict (`tape`) and the joiner verdict (`jtape`) are **separate
columns** on purpose — the live recorders stop before the joiner exists, so a
`tape ✓` says nothing whatsoever about the joiner.

The verdict itself is `tapeDiff.joinVerdict(result)`, shared by both suites so
they cannot drift, with `JOIN_REQUIRED_TYPES` naming the message types whose
absence is always a fault (the commit verbs, UNDO/REDO, FILL, CLR, …).

**It earned its keep on its first run**: `SEL_FLIP` was missing from every
joiner's tail. It has no `COMMIT_KIND` entry — never sequenced, never logged —
and was absent from `buildSelectionStateSet`, so `StrokeTape.observe()` dropped
it and a joiner replayed the commit with an *unflipped* image. `_endsSelection`
also listed it, which is wrong: a flip transforms the floating selection in place
and the selection stays live. Pixels had been passing at 99.7% the whole time
because the scenario's content is nearly symmetric — a purely content-dependent
miss, which is precisely what a wire oracle catches and a pixel oracle cannot.

---

# Replay parity: the eager-bake trap (`--no-eager-bake`)

`test:parity` sat at 2/7 for a long time, attributed to "soft-brush render
drift". It was not. It was **two** independent bugs, and every case now replays
at exactly 100.00%.

**Product.** `TimeMachine` marks every user who never undoes in a tape as
*eager bake*, which makes `LayerManager._bakeOverflowStrokes` flatten each stroke
into `flatCanvas` immediately rather than at the `MAX_STROKES_PER_USER`
threshold. `_bakeStrokeToBin` is only lossless for `source-over` and
`destination-out`; anything else goes through `_bakeFlatComplexBlendStroke`,
which reconstructs a backdrop and extracts the stroke's footprint — an
approximation of the render-time composite, not an identity. (`_canBakeStroke`
also returns `true` unconditionally once `flatCanvas` exists, so the `safeModes`
guard never ran.) Minimal repro: **one `screen` stroke on an empty layer**,
59.97% eager-baked vs 100.00% in the stack. Eager bake is now limited to the two
lossless modes. Live drawing is unaffected — `eagerBakeUsers` is only ever set by
TimeMachine.

**Harness.** `clearCanvas` resets the board, but blend mode is *user* state.
`brush_blend_modes` ended on `screen` and every later case inherited it, so
ink / flowPen / shape_set / eraser were all secretly drawing in `screen`. They
passed in isolation and failed in a full run — the worst possible signature.
`runCase` now calls `resetToolState` too. **If you add a case that changes tool
state, reset it there.**

`--no-eager-bake` is kept as a diagnostic. It separates *"the ReplayEngine
applied the wrong messages"* from *"the ReplayEngine baked them differently"* —
running the suite once with it localised this to the bake path immediately, and
that is the first thing to try on any future replay-only divergence.

## Soak mode: multiple k6 waves in one session (`--waves`)

A single 25s wave never pushes a bot past `MAX_STROKES_PER_USER` (20), so the
**overflow-bake path** — the live counterpart of the replay eager-bake bug —
is never exercised, and the join serve is only ever tested against a small board.
`--waves=N` runs N k6 feeds back-to-back against the **same room with the same
observers still recording**, so state accumulates across waves.

    node testing/devtools/k6_lowstress_observers.mjs --waves=3 --vus=3 --duration=20s \
         --undo-weight=6 --join

    --observers=<n>        live observer browsers (default 4, max 6)
    --waves=<n>            k6 feeds run back-to-back in one session
    --join                 add a late joiner after the last wave
    --undo-weight=<n>      n makes 'undo' n times as likely as each other
                           special action (passed to the feed as $UNDO_WEIGHT)
    --special-chance=<p>   probability an idle tick fires a non-stroke action
    --special-only=a,b     restrict the feed's special pool to these actions
                           (blendSwap, floodFill, selectionTransform,
                            selectionVerb, undo, layerSwap)
    --redo-chance=<p>      chance an undo is followed by a deferred redo
    --layers=0,1,2         layers the bots may draw on
    --tools=brush,line     restrict the tool pool by name
    --seed=<n>             reproduce a run (seeded per VU, varied per wave)
    --no-replay-parity     skip the per-user replay oracle
    --no-coverage-gate     report coverage misses as a warning, don't fail

Per wave it re-settles and diffs the observers against each other, so a
divergence is localised to the wave that caused it, and prints live/baked stroke
counts (`flatRecs` climbing past ~20/user confirms the overflow-bake path is
actually being hit). The late joiner is checked on both oracles — pixels against
an incumbent, and its rebuilt tail via `joinVerdict`.

**The join verdict is reported separately from the observer-trio verdict** and
must not be folded into it: the trio can agree perfectly while the joiner
rebuilds a different board, which is exactly what happened the first time this
ran.

Note the feed applies text with `textFadeMs: 30000` — text expires, so a
`TEXT_APPLY` older than the fade window is legitimately absent from a joiner's
tail. Don't read that one as a drop.

---

# Bake ledger — an EXACT oracle for what each client flattened

`testing/lib/bakeLedger.mjs`, wired into `k6_lowstress_observers` and always on.

The overflow bake is the one irreversible step in the pipeline, and every
argument about it (`_bakeOverflowStrokes`, `BAKE_DEFER_ENABLED`,
[[lag_drives_bake_divergence]]) turns on one question: **did these clients
flatten the same strokes in the same order?** Until now that was answered
indirectly, with a pixel percentage — an oracle whose run-to-run range (92.5 to
100.0 on an identical command) is far wider than the effects being argued about
(~0.6 of a point). Asking it to settle this was asking it for a digit it does
not have.

The ledger hooks `_bakeStrokeToBin` and `_compressStrokesToGroup` and records
every flattened stroke by identity (`L{layer}:u{user}:s{seq}`, the same scheme as
the stroke-identity diff — `timestamp` is local, so including it makes every
identity unique and every comparison vacuous) in bake order. Clients are then
compared with integers instead of percentages:

    prefixDelta   strokes one client baked and another did not. NOT a bug by
                  itself — the other client still holds them live, in seq order.
                  It is the quantity the inbound-queue deferral targets.
    inversions    strokes BOTH baked, in opposite relative orders. Unambiguous:
                  baking is irreversible and non-commutative blends do not
                  survive a reorder, so any non-zero count is permanent
                  divergence that no resync can repair.
    zInversions   the same over the effective render order (baked run, then live
                  stack), which is what `_compositeGroupSequential` actually
                  draws.

**Entries are tagged with the bake CAUSE, and this turned out to matter more than
the oracle itself.** Two unrelated triggers reach the same code: `overflow`
(`MAX_STROKES_PER_USER` exceeded — the only one `_shouldDeferBakeForInbound`
gates) and `cleanup` (`deepCleanupUserState`, a user disconnected). In a lagged
8-bot run, **cleanup bakes are the MAJORITY** — measured 387 of 729 flattened
strokes on one observer, 429 of 689 on another, because k6 cohorts turn over
mid-feed. Any verdict on the deferral computed over all bakes is therefore mostly
measuring a path the deferral does not touch, in either direction. The report
splits them, and the A/B decides on the overflow arm alone.

A ledger that recorded nothing reports `UNKNOWN`, not success — the suite has
already shipped two silent-no-op probes and this one refuses to join them.

---

# Asymmetric lag injection (`--lag`, `--cpu-lag=`, `--net-lag=`)

Four identical unthrottled browsers on one machine is the worst possible place to
observe "clients trail the stream by different amounts". These make them unequal
on purpose, index-aligned with the observer list:

    --lag                  preset: 1,2,4,6 (shorthand for --cpu-lag)
    --cpu-lag=1,2,3,4      Emulation.setCPUThrottlingRate per observer
    --net-lag=0,0,200,600  downloadThroughput cap in KB/s (0 = uncapped)

**The two levers are not interchangeable, and the difference is not a detail.**
The inbound drain runs on an 8ms-per-frame budget, so CPU throttling makes
messages arrive faster than they can be applied and `_messageQueue` GROWS — it is
the only lever that moves `getInboundQueueLength()`, i.e. the only one the
deferral can respond to at all. A bandwidth cap makes a client trail in stream
*position* while delivery stays rate-limited, so its queue never builds and the
deferral is blind to it. Both are real lag; only one is lag the product can see.

**`Network.emulateNetworkConditions.latency` is deliberately NOT exposed**, and
this is the finding worth carrying forward. Measured with
`testing/devtools/ws_latency_probe.mjs` (a self-contained echo-server probe that
exists precisely so this is never assumed again):

    latency 200ms       handshake +208.5ms    frame RTT +0.0ms
    64KB @ 100KB/s cap  handshake  +8.9ms     frame RTT +1672.5ms

The `latency` setting throttles the HTTP upgrade **only**; frames on an
established socket bypass it entirely. A harness built on it would report a
configured lag and apply none — the same failure shape as the empty-tab bug in
[[replay_multiuser_edge_suite]]. The throughput cap *does* reach frames.

Every run prints the evidence, and says so plainly when the lag did not
materialise:

      A: inbound queue max 229 p95 11 mean 3.7 (23.8% non-empty)  appliedSeq 21611
      C: inbound queue max 5153 p95 4504 mean 902.1 (74.3% non-empty)  appliedSeq 21611
      stream skew at matched seq: median 1408ms  max 7048ms

Skew is measured at seq **milestones**, not at the end: the ends converge once
the feed stops, so an end-state reading would report zero lag for a badly skewed
run. Note from those numbers that 4x throttling drives the queue to p95 ~4500,
which would pin the deferral against `BAKE_DEFER_STACK_CAP` (200) for the whole
run — use 1-4x, not 1-10x, or the treatment arm spends its time on the safety
valve instead of the mechanism.

---

# Bake-deferral A/B (`bake_defer_ab.mjs`)

Interleaves `--bake-defer` ON/OFF rounds and reports the distribution. **There is
no flag to run the arms in blocks**, because that is exactly what produced the
original wrong answer: blocked runs made the deferral look 1.5 points worse and
interleaving the same command reversed the sign. The runner also alternates which
arm leads each round, differences within a round (to remove between-round drift),
and refuses to average in a run whose ON arm did not actually have
`BAKE_DEFER_ENABLED` set or whose configured lag never materialised.

    node testing/devtools/bake_defer_ab.mjs --runs=3
    node testing/devtools/bake_defer_ab.mjs --runs=2 --no-lag    (control)

The verdict bar is **a consistent sign across every round**, not a favourable
median — a median over rounds that disagree is the failure mode this whole
exercise exists to avoid.

## Result (2026-08-10, 3 rounds, 8 bots, 4 observers, lag 1-4x)

                          ON (deferral)      OFF
    overflow inversions   0 / 0 / 0          106 / 126 / 304    <- the arm it gates
    bake violations       238 (median)       397
    TOTAL inversions      58k / 61k / 67k    32k / 38k / 41k
    worst pixel           70-80%             76-87%
    peak live stack       199 / 199 / 215    131 / 132 / 173

**It works on the path it gates and is net-negative anyway**, and only the exact
oracle can see both halves — the pixel column alone would have said "worse, drop
it" and thrown away the fact that permanent bake-order damage went to zero.

The reason is mechanical, and was confirmed by the ledger's cause tags rather
than inferred: deferring cannot prevent a stroke being flattened, only delay it.
`deepCleanupUserState` then flattens it on user departure, in departure order,
through a path with **no seq gate at all**. With the deferral on, ~800 fewer
strokes per run bake through the gated overflow path and ~500 more through the
ungated departure path (cleanup share 43% → 56%). The damage is relocated, not
removed. `BAKE_DEFER_ENABLED` therefore stays `false`; gating the departure bake
is the prerequisite for revisiting it.

One caveat on the experiment itself: realized lag varies substantially between
runs of the same round (queue max 35k-74k), and lag drives divergence, so the
pairing controls this less than intended. It does not threaten the overflow
result — 0 versus 106-304 is not a lag artifact — but treat the pixel and
total-inversion columns as directional rather than precise.

---

# Joiner residual — bisect by content type (`npm run test:joinerbisect`)

`joiner_content_bisect.mjs`. A late joiner on the real checkpoint+tail path lands
at **93.967%** and nothing had localised that to a *kind* of content. This feeds
plain strokes plus exactly one class at a time and reads the pixel diff — which
is the joiner's only valid oracle once a checkpoint is served, since everything
at or below the checkpoint seq arrives as a flat image and never reaches the
tape at all.

    plain → blend → fill → selection → undo → all (the default mix)

Each step is **strokes + one class**, not a cumulative ladder, so a drop names
its class directly instead of implicating everything added before it.

**This needed a new feed knob.** `SPECIAL_CHANCE` and `NO_BLEND` cannot express
"one class": every special action, `blendSwap` included, fires through the single
`SPECIAL_CHANCE` gate, so turning it off removes all of them at once and
`NO_BLEND` on top is a no-op. `SPECIAL_ONLY=floodFill,undo` restricts the pool,
and `UNDO_WEIGHT` is applied *after* the allowlist so it cannot smuggle undos
back into a fill-only run.

**Every step wipes the backend AND restarts the server.** The restart is the part
that is easy to skip and fatal to skip: rooms live in server memory — strokeLog,
checkpoints, session indices — so a process that outlives `docker compose down -v`
still holds the previous step's `lobby`, and every later number silently carries
the earlier config's content. The script also refuses to proceed if the server
boots without snapshot storage, because then no checkpoint persists and the whole
comparison measures a full-tail replay instead.

    npm run test:joinerbisect
    npm run test:joinerbisect -- --waves=3
    npm run test:joinerbisect -- --only=plain,selection
    npm run test:joinerbisect -- --no-reset      (reuse the running backend)

Reading it: if `plain` already fails, the residual is a general rebuild failure
and the richer classes are not the cause. If `plain` is clean, the step with the
largest drop names the culprit.

---

# Long-idle (AFK) parity soak (`npm run test:afksoak`)

`afk_idle_soak_suite.mjs`. Every other suite in this tree finishes inside five
minutes, which happens to be exactly the window in which the product's most
destructive sync behaviour has not yet switched on. This one runs past it.

## What the product does at five minutes

`server/SessionManager.js` marks a user AFK after `AFK_TIMEOUT` (5 min, checked
every 30 s). From that instant the server **filters every canvas-mutating
message away from them** — `INACTIVE_FILTERED_TYPES` in `server/index.js` covers
MD, MU, MM, FILL, CLR, UNDO, every `SEL_` verb, `GLITCH_RESULT` and the `TILE_`
pair. An AFK client's canvas is frozen where it stood. Recovery depends entirely
on `SyncClient.setInactive(false)` force-requesting a sync when the user returns.

Two more server-driven things follow, and both are bake boundaries — irreversible
flattening that no other suite crosses:

| When | What | Where |
|---|---|---|
| AFK + 5 min | `COMPRESS_USER_STROKES` broadcast → every client runs `commitAllUserStrokesForAFKUser` on that user | `SessionManager._scheduleStrokeCompression` |
| all users AFK + 2 min | automatic `BOARD_SNAPSHOT_RESTORE` | `SessionManager.checkAfkUsers` → `onAllUsersAfk` |

## Cast

    A, B   active throughout, kept non-AFK by a chat ping    ← the control
    C      idles --idle   (default 7m)
    D      idles --idle2  (default 12m)
    J      --join, joins at the very end

Chat is the keepalive because it is the only realistic user action that counts
as activity server-side (`isUserActivityMessage`) while being absent from
`INACTIVE_FILTERED_TYPES` — so it also reaches the idle observers and lands
identically on every tape, and the observers stay pure receivers.

**The idlers draw before they go dark** (`--draw=<n>`, default 4). An idle
observer that never drew is only a *receiver* of the AFK path; one that drew is
also its *subject*, because `COMPRESS_USER_STROKES` fires for it and every other
client bakes its strokes out of the live stack.

## Four checks, not one

0. **The observers agreed before the clock started.** A divergence inherited at
   t=0 — from a room still holding an earlier run's content, say — is
   indistinguishable at t=17m from one AFK caused. The run is **gated** on it and
   aborts (exit 3) rather than measure from an unequal board; `npm run dev:reset`
   gives a clean backend, `--allow-unequal-start` overrides. The room's content
   at join is printed and recorded in `summary.json` either way. Every headline
   number from 2026-08-08 predates this gate and was taken against a dirty lobby.
1. **The idle client really did go dark**, measured as **zero canvas-mutating
   messages delivered** during the window — that is exactly what
   `INACTIVE_FILTERED_TYPES` controls — while the reference kept moving. Canvas
   byte-identity is **not** a valid stand-in and was this suite's own first
   mistake: the SVG text overlay fades on a local rAF loop, so an AFK canvas
   keeps animating with no messages at all. A green "converged" on a client that
   was never actually AFK is the failure mode this exists to prevent.
2. **Return converges** — AFK clears, the force-resync fires, the board comes
   back within tolerance.
3. **Nothing regressed for those who stayed** — A↔B. If the control fails, the
   run says nothing about AFK.

## Flags

    --idle=7m --idle2=12m    total inactivity per idler (accepts 5m30s, 90s, ms)
    --ping=90s               keepalive interval for the active observers
    --draw=<n> / --no-draw   strokes each idler lays down first (default 4)
    --join                   late joiner at the end
    --join-on-return[=C|D]   fresh joiner spawned AT the idler's return (below)
    --mid-stroke[=C|D]       idler goes dark with a stroke still in flight (below)
    --undo-on-return[=C|D]   idler presses Ctrl+Z after returning (below)
    --all-afk                extra phase: let the room go fully AFK and wait out
                             the 2-minute automatic BOARD_SNAPSHOT_RESTORE
    --allow-unequal-start    measure even if the observers disagree at t=0
    --vus= --wave-duration= --wave-gap=      k6 feed shape
    --fast                   lighter feed, shorter freeze observation

### `--join-on-return` — is the AFK residual even an AFK bug?

The two open failures are suspiciously close in magnitude: an AFK returner at
**91.060%** (12 min idle) and a fresh late joiner at **93.967%**. Both rebuild
through the same checkpoint+tail machinery, and nothing had ever compared them
**to each other**.

This spawns a brand-new client at the instant an idler returns and prints all
three pairs at the settled end of the run:

| reading | meaning |
|---|---|
| returner↔joiner **agree**, both differ from the incumbent | **one** rebuild bug; AFK is a red herring and the two investigations collapse into one |
| returner↔joiner **differ** | something genuinely AFK-specific on top of the rebuild issue |
| both match the incumbent | no residual reproduced — nothing to attribute |

The joiner is labelled `K`, is kept out of AFK by the ping loop for the rest of
the run, and writes `diff_discriminator_<idler>_K.png`. It needs `--room=lobby`
to mean anything: without a checkpoint its rebuild is not the real join path, and
the suite says so.

### `--mid-stroke` — what `COMPRESS_USER_STROKES` is actually for

The mechanism exists to finalise a stroke left in flight by someone who walked
away, and **it had never once been exercised**.
`LayerManager.commitAllUserStrokesGenerator` only commits strokes present in
`activeStrokeByUser`, and every idler in every previous run had finished drawing
before going idle — so the broadcast fired and did nothing, on every run that
ever reported it "✅ fired".

The path is reachable because `isUserActivityMessage(T.MM, user)` returns
`!!user.mousedown`: cursor moves count as activity only while the button is held,
so a client that presses, moves, then stops **without releasing** simply goes
quiet. `gestureHalf()` drives exactly that — pointerDown plus moves, no
pointerUp. AFK marks it at 5 min (clearing `mousedown`), and compression 5 min
later finally has something to commit, on every client at once.

The flag needs an idle of at least **10m30s** for that idler (AFK_TIMEOUT + one
check interval + the 5-minute compression delay) and refuses to run otherwise,
rather than silently degenerating into an ordinary idle soak. It then asserts the
stroke was in flight *everywhere* before the clock started, that it left
`activeStrokeByUser` on every client, that each client's stroke count for that
user went **up** (committed, not discarded) and that they all agree on the
number, and finally that the returner and the incumbent agree once it is back.

### `--undo-on-return` — undo across the AFK boundary

Runs **after the feed stops**, deliberately: while k6 is drawing, another user's
live count also falls whenever `MAX_STROKES_PER_USER` overflow bakes their oldest
stroke, so a negative delta would not be attributable to the undo.

Baked strokes are permanently un-undoable, and an idler's strokes can be baked
out while it is dark — by overflow, by the AFK compression, or by the checkpoint
its own resync rebuilds from. So a **no-op is a legitimate outcome**. What is not
legitimate is Ctrl+Z removing *someone else's* stroke, and that is the assertion:
per-user live counts before and after, read from the incumbent.

Remember the server needs `AFK_TIMEOUT + AFK_CHECK_INTERVAL` before AFK even
begins, so `--idle=7m` buys roughly **90 s** of genuinely filtered drawing, and
`--idle2=12m` roughly **6m30s** (and crosses the stroke-compression boundary at
~10m30s). The header prints both numbers — read the filtered window, not the
idle time.

## Harness gotchas (learned the hard way)

- **Never diff two tabs at one instant while the feed is running.** The k6 feed
  does not stop during the idle phases, so a "settle each tab, then diff" reads
  an in-flight stroke as a divergence. `waitAgree()` snapshots both tabs inside
  the same `Promise.all` and retries — "did it catch up?" is a question about a
  limit, not an instant. The first run of this suite reported 98.66% purely
  from sequential snapshots, and 100.000% once they were paired.
- **A mid-run resync makes that client's tape legitimately longer.** The join
  serve ends with a tool-state resend and the retained selection state set, both
  delivered only to the client being served. On the first run observer A had 9
  messages from one bot that B, C and D lacked — six `CT/CC/CS/CHD/CSM/CSP`
  and a `SEL_LIFT/MOVE/COMMIT` triple, i.e. exactly one serve artifact — after
  a `SYNC_PARITY_RESYNC_REQUEST`. Read `sync_events.json` before calling a tape
  difference a delivery bug.
- **`app.handleColorInputChange` takes an RGBA array**, not a hex string; a hex
  string throws `color.join is not a function` inside the page.
- The old `k6_lowstress_observers.mjs` sync probe watches types `[60, 61, ...]`,
  which are `UNDO`/`REDO` — **not** `SYNC_REQUEST`/`SYNC_COMPLETE` (41/44).
  This suite uses the right constants and also logs `SYNC_PARITY_RESYNC_REQUEST`
  (143), which is how the resync above was caught.
- Only `A↔B` is asserted at the wire level. C and D legitimately have holes in
  their tapes — that is the filtering working — so theirs are reported, not
  asserted, and their recovery is judged on pixels.

## The joiner is NOT measurable in an ad-hoc room

`RoomManager.canPersistSnapshots()` is `isRegistered() || id === 'lobby'`. Every
soak in this tree invents a room name (`afk_soak_<ts>`, `lowstress_obs_<ts>`),
so **no join checkpoint is ever served**: `SyncCoordinator` serves `baseSeq 0`
and the joiner depends entirely on the retained command tail. The server log
shows `Replayed tail (0, N] to <idx>: M commits` with no `Served checkpoint`
line above it.

That is not the join path a real room takes, so a joiner divergence measured
this way cannot be attributed. The suite now detects it directly — the
checkpoint arrives as `BOARD_SNAPSHOT_RESTORE`, so its absence from the joiner's
inbound counters is conclusive — and says the result is not measurable rather
than filing a bug. Pass `--room=lobby` to exercise the real checkpoint+tail path.

**This applies to `test:k6obs --join` too**, and is worth re-checking against any
previously recorded joiner percentage from these suites.

## AFK: what has to be true for it to fire at all

`isUserActivityMessage` treats **every** message not in
`NON_USER_ACTIVITY_TYPES` as deliberate user activity. That is a denylist, so it
fails open: any automated client→server message keeps a client permanently
non-AFK. Three timers send without a user (all now excluded):

| Type | Sender | Trigger |
|---|---|---|
| `SYNC_PARITY_CHECK` (137) | `ParityClient` | `setInterval`, 30 s |
| `ROOM_PREVIEW` (85) | `App.startPreviewInterval` | `setInterval`, 30 s |
| `CHECKPOINT_UPLOAD` (110) | preview/checkpoint uploader | server snapshot timer |
| `BOARD_SNAPSHOT_SAVE` (96) `a:true` | `SnapshotManager` | server snapshot timer |
| `BOARD_SNAPSHOT_GET` (102) `snapshot_probe` | `SnapshotManager.handleCheckpointMinted` | every client, per minted checkpoint (15 s) |

The last two are **dual-use wire types**: the same type carries a genuine user
action (clicking save, opening history) and an automated one, distinguished only
by a payload flag — so they are handled inside `isUserActivityMessage` the way
`MM` already is, not by adding them to the set.

`BOARD_SNAPSHOT_GET` only appears in a **snapshot-backed room**, because ad-hoc
rooms never mint checkpoints. If you test AFK only in ad-hoc rooms you will never
see it.

If a future run reports "AFK actually engaged ❌", re-run this audit before
assuming the suite is at fault — list every `T.` the client sends and diff it
against the denylist:

    node -e "const fs=require('fs');
      const t=fs.readFileSync('shared/MessageTypes.js','utf8').match(/export const T = \{[\s\S]*?\};/)[0];
      const byName={}; for(const p of t.matchAll(/(\w+)\s*:\s*(\d+)/g)) byName[p[1]]=+p[2];
      const set=fs.readFileSync('server/index.js','utf8').match(/const NON_USER_ACTIVITY_TYPES = new Set\(\[([\s\S]*?)\]\);/)[1];
      const ex=new Set([...set.matchAll(/T\.(\w+)/g)].map(x=>x[1]));
      const sent=new Set([...fs.readFileSync('src/network/WebSocketClient.js','utf8')
        .matchAll(/send\(\s*\{\s*t:\s*T\.(\w+)/g)].map(x=>x[1]));
      for(const n of [...sent].sort()) if(!ex.has(n)) console.log(byName[n], n);"

Confirm AFK server-side, not from the client: `SessionManager` logs
`User <idx> (<name>) marked as AFK`, tagged `[discovery]` for the room-browse
connection (session indices are per-room and both start at 0).
