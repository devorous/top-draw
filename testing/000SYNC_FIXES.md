# Sync Fixes Follow-Up Audit

Second-pass review after the initial `seq` reconciliation fixes. The original
brush/erase sync bug is much improved, but the code still has a few remaining
paths that can affect sync correctness.

## Current Test State

Most of the sync suite is passing.

- `fill_variations`: **FIXED** — now passes. Root cause was a per-record `seq`
  off-by-one between the drawer and observers (see P1 fill section below).
- `flood_concurrent_blend_modes`: pixels matched at effectively 100%, but the
  live-vs-baked stroke split still differed by one stroke on one client.

The focused `flood_drawer_30_mixed` case passed after the pixel and erase-all
`seq` propagation fixes.

## Background-Tab Investigation (2026-05-26)

Reproduced live with two real Chrome tabs (chrome-devtools MCP). A background
emulator overrode `document.visibilityState='hidden'`, paused `requestAnimationFrame`
(queued + flushed on show), and clamped timers to >=1000ms — exactly what Chrome
does to a hidden tab. Compared per-record `seq` + a seq-ordered pixel signature
(NOT the suite's timestamp-ordered oracle).

Findings:

- **Hidden observer, foreground drawer** (brush/ink/line/circle/rect/flowPen/
  erase + blend modes): converges perfectly. Identical seqs, pixels within
  anti-aliasing tolerance. The inbound hidden-path (`_scheduleProcessing` drains
  via `queueMicrotask` when hidden, Board flushes the deferred composite on
  `visibilitychange`) is solid.
- **Hidden drawer, foreground observer** (throttled 1Hz tick, paused rAF):
  also converges. The drawer still reconciles its own MU self-echoes while
  hidden, and outbound broadcasts flush correctly (just slower).
- **Fill with a hidden observer**: surfaced the off-by-one below — but it is NOT
  background-specific (it reproduces foreground too). Background tabs are not the
  cause of the "MAJOR" symptoms for ordinary tools; the seq machinery holds up.

Caveat: the puppeteer suite **stops the tick loop and drives `tick()` manually**,
so it never exercises real background throttling. The live two-tab harness above
is the only thing that does. Worth promoting into an automated test (launch with
`ignoreDefaultArgs` for the throttle-disable flags + `page.bringToFront()`).

## P1: Non-MU Commit Events Still Do Not Reconcile Local Seq

The self-echo exception now allows `MU`, `FILL`, and `GLITCH_RESULT` (all
2026-05-26) through the local drop path. That fixes normal pointer-up strokes,
fills, and glitch, but `StrokeFingerprint.js` treats more than those as
commit-class messages:

- `FILL` — **fixed** via `pendingCommitEcho` (see P1 fill section).
- `GLITCH_RESULT` — **fixed** via `pendingCommitEcho` (see P1 glitch section).
- `SEL_COMMIT`, `SEL_DELETE`, `SEL_FILL`, `SEL_STAMP`, `SEL_MERGE`
- `IMG_PASTE`
- `TEXT_APPLY`, `TEXT_REMOVE` — text is an id-keyed fading overlay
  (`TextOverlay`), NOT a stroke-stack/z-order record, so the seq off-by-one does
  not apply; only delivery matters (suite `text_tool_set` covers it).
- `UNDO`, `REDO`, `CLR`, moderation/admin mutations

The client still drops the remaining commit-class self echoes in
`src/network/WebSocketClient.js`, and `src/network/WebSocketHandlers.js` only
allows self `mu`, `undo`, `fill`, and `glitch_result` through the wrapped
handlers. Any local optimistic stroke committed by one of the *other* commit
events can stay at `seq=0`, or be reconciled later by the wrong `MU`. The fill
fix is the template: tag the optimistic stroke `pendingCommitEcho: '<type>'`, let
the MU reconciler skip it, allow that type's self echo through, and reconcile it
to the echo's seq in the type's handler. Note these other types must ALSO carry
`seq` through decode first (see P2 below) — fill and glitch already did
(GLITCH_RESULT decode now emits `seq`).

## P1: Glitch Reconciled To The Wrong Seq — FIXED (2026-05-26)

Confirmed live (3-tab chrome-devtools harness): glitchBlur committed at `seq=0`
on observers while the drawer reconciled it via `MU` → glitch sorted to the TOP
on observers (seq=0 → MAX in the sort comparator) and diverged. Glitch is the
multi-layer case: it commits one stroke PER layer (`_getTargetLayers` → up to 3)
sharing one timestamp, and broadcasts **one `GLITCH_RESULT` per layer**, each
getting its own server seq. So the fix matches **per layer**:

- `GlitchBlurTool._endTargetLayerStrokes`: tags each local glitch stroke
  `pendingCommitEcho: 'glitch'` (only when local + connected).
- `WebSocketClient.js`: GLITCH_RESULT decode now emits `seq`; the self echo
  passes the commit-type drop.
- `WebSocketHandlers.js`: `'glitch_result'` added to `allowSelf`.
- `DrawingHandlers.js` `'glitch_result'`: self branch reconciles the local glitch
  stroke ON `data.layerIndex` via `reconcileLocalCommitStroke(..., 'glitch',
  layerIndex)`; remote path threads `seq` into `queueRemoteGlitchImage`.
- `RemoteUserHandler.js`: `queueRemoteGlitchImage`/`commitRemoteGlitchImage` carry
  `seq` into the async pending-glitch commit.
- `LayerManager.reconcileLocalCommitStroke` gained an optional `groupIdx` so
  glitch reconciles per-layer (fill still passes `null` = search all).

Verified: drawer and a backgrounded observer agree on per-layer glitch seqs
(e.g. `210/211/212`), a stroke drawn after glitch correctly sorts above it, and
the suite `blur_tools_test` passes.

This is the biggest remaining design hole in the `seq` fix. The likely direction
is to make every commit-class self echo either:

- route to a reconcile-only self branch, or
- be consumed by a central `seq` reconciler that knows which local optimistic
  record each commit type produced.

## P1: Fill Reconciled To The Wrong Seq — FIXED (2026-05-26)

Root cause (confirmed live): the fill tool commits a stroke locally, then
`App.handlePointerUp` always queues `broadcastMouseUp()`. Because the `FILL`
broadcast happens from an **un-awaited async** `onPointerUp`, the server assigns
the `MU` a *lower* seq than the `FILL`. The drawer's MU self-echo reconciler
(`reconcileOldestLocalStroke`) then grabbed the fill stroke and stamped it with
the **MU's** seq, while every observer commits that same fill with the **FILL's**
seq. Reproduced exactly: drawer fills `281/286/291`, observers `282/287/292`.
Pixels happened to match only because nothing interleaved between the two seqs;
with a third user's stroke landing on those seqs, the fill would order
differently on drawer vs observers → permanent divergence.

Fix (the doc's second suggested option — route `FILL` self echo as reconcile-only):

- `FloodFillTool.js`: both local fill commits tag the stroke
  `endStroke(user, { pendingCommitEcho: 'fill' })`.
- `LayerManager.js`: the MU reconcilers (`reconcileLocalStroke`,
  `reconcileOldestLocalStroke`) now **skip** strokes carrying `pendingCommitEcho`,
  so the MU's seq never lands on a fill. New `reconcileLocalCommitStroke(userId,
  seq, 'fill')` assigns the authoritative `FILL` seq FIFO and clears the tag.
- `WebSocketClient.js`: `FILL` self echo now passes the commit-type drop (like
  `MU`).
- `WebSocketHandlers.js`: `'fill'` added to `allowSelf`.
- `DrawingHandlers.js`: the `'fill'` handler has a self branch that reconciles
  (no recompute) and returns.

Verified: drawer and observers now agree on all fill seqs; `fill_variations`
passes; full regression set (brush/blend/eraser/text/select/image/gimp/confetti/
concurrent/flood) 15/15.

The same `pendingCommitEcho` mechanism generalizes to the other commit-class
tools below.

## P1/P2: Async Fill Handlers Are Not Serialized (still open)

`src/network/WebSocketHandlers.js` calls wrapped handlers without awaiting their
returned promises. `src/sync/SyncClient.js` replays buffered handlers the same
way. The `fill` handler is async and calls `FillWorkerClient.computeFill()`.

That means several inbound `FILL` messages can compute against the same stale
canvas state and commit later out of order. Since fill output depends on the
current composited canvas, this is order-sensitive.

This is now confirmed to be the remaining `fill_variations` failure. After the
seq off-by-one fix, `fill_variations` is **flaky**: re-running it back-to-back
gives PASS / FAIL / PASS, with the failure always showing the same shape —
`totals: 10 | 9 | 9` (an observer ends up with one fewer fill) and `maxΔ 255`
(one fill visibly missing). The per-record seqs that DO arrive are correct; the
problem is a whole fill occasionally failing to commit on an observer because
inbound `FILL` handlers compute against a stale/uncomposited canvas out of order.
This is independent of the seq work and independent of background state.

The least invasive fix is probably a per-client or per-event queue for fill
handlers. A broader fix would make the buffered canvas-mutating handler pipeline
promise-aware and ordered. This is the most impactful remaining sync bug — it's
the only one that drops a whole stroke rather than mis-ordering it.

## P2: Selection, Image Paste, Text, And Glitch Commits Do Not Carry Seq

Several non-stroke commit paths do not appear to pass `seq` from decode to the
remote commit:

- `SEL_COMMIT` decode omits `seq`, then `RemoteSelectionHandler` commits without
  seq.
- `SEL_DELETE`, `SEL_FILL`, `SEL_STAMP`, and `SEL_MERGE` have the same class of
  risk.
- `IMG_PASTE` decode omits `seq`.
- `GLITCH_RESULT` decode omits `seq`, and the remote glitch commit records no
  seq.

If these paths produce LayerManager stroke records, they need the same ordering
treatment as normal strokes. Otherwise late joins, baking, undo depth, and
order-sensitive blend/erase behavior can diverge.

## P2: Sync Snapshot Extraction Sorts By Timestamp, Not Seq

`src/sync/SyncClient.js` extracts compressed group strokes from
`bakedSequences`, merges them with `group.strokeStack`, and sorts the result by
`timestamp`.

The actual LayerManager stack order is `seq` first, timestamp second. Snapshot
extraction should use the same comparator or otherwise preserve the exact
rendering order. Timestamp sorting can reorder late-join sync payloads when
global server order and local timestamps disagree.

## P2: Baked Count Can Still Diverge

`flood_concurrent_blend_modes` still showed a `59 | 59 | 60` model total split
while pixels matched. That means the visual result is currently okay, but undo
depth/history shape may differ.

A complete fix likely needs a deterministic bake watermark, probably based on
confirmed global `seq`, instead of each client incrementally choosing when to
flatten based only on local state.

## P1: AFK Clients Served Stale Snapshots — FIXED (2026-05-26)

Root cause of "really bad snapshots": the server filters ALL canvas-mutating
messages away from AFK recipients (`INACTIVE_FILTERED_TYPES` — MD/MU/FILL/CLR/
UNDO/SEL_*/GLITCH_RESULT/TILE_*), so an AFK client's canvas is frozen at the
moment they went idle. The live sync provider election already excludes AFK
(`SyncCoordinator._getRankedCandidates` skips `userData.afk`), but the
**snapshot-uploader election did not** — `uploaderElection.runElection` scored
AFK users with only a soft `-90` penalty while a fast uploader earns up to
`+434` from bandwidth, so a high-bandwidth AFK client could win, upload its
frozen canvas to the DB, and every future joiner restoring that snapshot got
stale/incomplete state.

Fix:

- `server/providerScoring.js`: `scoreProvider` now returns `-Infinity` for an AFK
  user unless `allowAfk` is set (the SyncCoordinator AFK-fallback path, which
  re-validates `afk` again before actually asking). Disqualifying, not a penalty —
  an AFK canvas is *guaranteed* stale. This makes the uploader election consistent
  with the live sync election.
- `src/App.js` `_updatePreviewUploadEligibility`: also bail when `self.afk` (not
  just when hidden), closing the ≤30s window where an already-elected uploader
  goes AFK before the next election re-runs.
- `src/handlers/UserHandlers.js`: re-run `_updatePreviewUploadEligibility` on the
  self-AFK transition so uploads stop the instant we go AFK / resume on return.
- Tests in `testing/provider_scoring.test.js` lock in AFK disqualification + the
  `allowAfk` fallback + ranked-candidate exclusion.

Nuance: users immune to inactivity (`role >= 5`, or MOD with `modInactiveImmune`)
keep receiving draws while AFK, so their canvas is NOT stale — but the live
election already excludes all AFK users including immune ones, so disqualifying
them in the uploader election too is consistent (not a regression).

Still open (returning-from-AFK view, NOT a snapshot bug): coming back from AFK
does not auto-resync — `setInactive(false)` only hides the "please resync"
prompt. The intended recovery is the manual resync button in the inactive
overlay (which `requestSync`s and unblocks input); a user who returns via chat
instead of the button can keep a stale local view. Worth a follow-up: auto-
resync on the `afk → false` self transition.

## Test Coverage Gaps

The current suite is useful, but it still has blind spots:

- The layer diff helpers composite stroke stacks by timestamp even though the
  app renders by `seq` first.
- Pixel equality can pass while model structure differs, as seen in the
  bake-count split.
- The suite should assert per-record metadata for `seq`, especially after sync
  import and for non-`MU` commit types.
- Fill needs targeted tests for rapid successive fills, advanced fill
  pointer-up ordering, and buffered replay during sync.
- Selection/image paste/text/glitch commit paths need coverage that verifies
  they import and bake in global `seq` order.

## Suggested Next Work

1. Add a central commit self-echo reconciliation strategy for all commit-class
   message types, not just `MU`.
2. Fix fill ordering first, because it is the remaining visible failure.
3. Thread `seq` through selection, image paste, text, and glitch result decode
   and commit paths.
4. Update sync snapshot extraction and test diff helpers to use the same
   `seq`-first ordering as LayerManager.
5. Add metadata assertions so tests fail on wrong `seq` before pixels drift.
