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
