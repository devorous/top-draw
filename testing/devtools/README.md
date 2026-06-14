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
