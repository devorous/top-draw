# Selection ops do not survive sync / join

## The bug (real, reproducible, reported by the user — trust this over any test)

Two clients, **User A** and **User B**, both in the room.

1. A uses the **Select** tool to **fill an area** (lasso), then **moves and stamps
   it multiple times** across the board, including at least one **move + scale
   using the transform handles**. Only ONE lift; the homography can change
   between transforms.
2. **B sees all of it perfectly, live.** The live path is not the problem.
3. B presses **Sync** (on A) — or a fresh **User C joins**.
4. The selection operations come back **wrong**.

Observed failure modes, in the user's own words across several rounds:

- "none of the stamps appear"
- "one of three stamps appears, and it is cut off on one end"
- "the fill is filling in the bounding box only, not the lasso shape"
- "stamps are cut off by a bounding box that does not respect its current
  homography transform bounding box"
- "the most recent op (a select, move and scale up) shows as still scaled down
  and unmoved"
- **It is temperamental**: syncing repeatedly gives *different* results.
- Scrubbing back and forth in **Replay** also makes parts disappear.

Non-determinism across identical syncs is the single most important clue. The
server state is fixed; only client-side application order varies. **Every bug
found so far has been an ordering/race bug, not a data-loss bug.**

## Round 2 — root cause found, 4 more fixes applied (all UNCOMMITTED)

The two symptoms still live at the start of round 2 were **stamps clipped /
wrong size** and **lasso fill rebuilt as a filled bounding box**. Both come from
**one** violation of the ordering invariant, plus two server-side reasons the
tail was incomplete to begin with.

### The mechanism (read this first)

`_queueIfLoading(user, action)` defers an action while `user.pendingImageLoad`
(the SEL_LIFT / IMG_PASTE PNG decode) is in flight, by chaining onto that
promise.

- **Live**: messages arrive milliseconds apart, the decode finished long ago,
  **nothing ever defers**. This is why live is always correct.
- **Rebuild** (`SyncClient.replayBuffer()`): the whole tail replays in **one
  synchronous pass**, so the decode is *always* still pending and **everything
  that calls `_queueIfLoading` defers while everything that doesn't runs
  immediately**.

`SyncCoordinator._serveCheckpointJoin` sends the tail first and
`_sendActiveImagesToJoiner` (IMG_PASTE + one SEL_MOVE for a still-floating
selection) **last**. `handleImagePaste` did not defer. So on every rebuild:

```
SEL_LIFT      -> runs now, pendingImageLoad = P1 (lift PNG decoding)
m1 m2 STAMP1  -> queued on P1
m3 m4 STAMP2  -> queued on P1
IMG_PASTE     -> RAN IMMEDIATELY: replaced floatingCanvas / selection /
                 selectionCorners / originalCorners and installed P2,
                 orphaning the P1 chain
SEL_MOVE      -> queued on P2
```

Two independent image decodes then raced:

| winner | result |
|---|---|
| lift PNG (P1) | the queued stamps draw the paste's still-**empty** canvas → "none of the stamps appear" |
| paste PNG (P2) | the stamps draw the **final** (already source-cropped) float, and `_getWarpOutputBounds` warps from the **paste's** `originalCorners` against the tail's intermediate destination corners → "cut off by a bounding box that does not respect the transform" |

Same race explains the bounding-box fill. The Fill button is hidden once a
selection `hasMoved` (`SelectTool.showContextMenu`), so a lasso fill is always
the **layer** branch of `handleSelectionFill` — which is guarded by
`if (user.floatingCanvas)`. With IMG_PASTE having run early, `floatingCanvas`
was truthy, so the fill took the **floating** branch instead and painted the
*entire* float rect (a paste-created float has no `user.lassoPath`); the next
stamp then baked that rectangle onto the board.

### What changed in round 2

| file | fix |
|---|---|
| `src/remote/RemoteSelectionHandler.js` | **`handleImagePaste` now defers behind `pendingImageLoad`.** The root cause above. |
| `src/remote/RemoteSelectionHandler.js` | `handleSelectionLift` defers too — it replaces the whole selection state and installs a fresh `pendingImageLoad`, so running it ahead of a queued chain applies selection #1's stamps to selection #2's state. |
| `src/remote/RemoteSelectionHandler.js` | `_queueIfLoading` wraps the action in try/catch. One throw used to reject the shared per-user chain and silently drop every op queued behind it. |
| `server/index.js` | **`SEL_STAMP` / `SEL_FILL` no longer `clearActiveFloatingSelection`.** They keep the float alive, and that list is the only thing deciding whether a joiner hears about an in-flight float at all. Clearing on a stamp is why "move + scale after the last stamp" came back unmoved: the corners and cumulative source crop were discarded. Same membership mistake `StrokeTape._endsSelection` had. |
| `server/StrokeTape.js` | **Selection commits added to `nonStrokeCommitTypes`.** The Select tool still broadcasts MD/MM/MU (App.js doesn't gate mouse-down on tool) and a selection commit routinely fires *between* an MD and its MU — clicking outside a float queues MD, then `SelectTool.onPointerDown` → `commitSelection()` → SEL_COMMIT, MU only on release. The `pend && pend.length > 0` branch claimed that open brush preamble, took the early return, and so never built the selection preamble, shipped a phantom MD under the commit's seq, and skipped the `_pendingSelection` bookkeeping. |
| `messages.proto` (no change needed) + `WebSocketClient` / `validation.js` / `SelectTool` / `SelectionHandlers` / `ReplayEngine` | **SEL_FILL now carries its lasso path in `ps`.** Same argument as the `rect` it already carries: the receiver cannot infer the shape. It used to be read from `pendingLassoPath`, state the fill does not own — and `StrokeTape` empties a user's selection frames after every SEL_STAMP/SEL_FILL, so a second fill (or a fill after a stamp) ships no SEL_PENDING at all and the receiver fell through to `fillRect` over the bounds. |

**Fix ordering note:** the server fix (keep `activeImage` after a stamp) makes
IMG_PASTE reach joiners far more often. Applied *without* the client deferral
fix it would make things visibly worse. They belong together.

## Round 1 fixes (still applied)

| file | fix |
|---|---|
| `server/StrokeTape.js` | `SEL_STAMP`/`SEL_FILL` were classed as selection-ending, so the tape deleted the `SEL_LIFT`; every later stamp was recorded with no lift and rebuilt as nothing |
| `src/remote/RemoteSelectionHandler.js` | `handleSelectionMove` defers behind `pendingImageLoad` like the commit verbs |
| `src/remote/RemoteSelectionHandler.js` | `handleSelectionPending` defers too (it writes `pendingLassoPath` that the deferred fill reads) |
| `src/remote/RemoteSelectionHandler.js` | `handleSelectionCommit`'s `_queueIfLoading` closure dropped `seq` → joiners rebuilt the stamp at seq 0, which `_sortStrokeStack` floats to the TOP |
| `src/App.js` | tool-change `CT` was broadcast *before* the commit `deactivate()` triggers, so peers cancelled the float and dropped the stamp (verified: 88.5% → 99.8%) |

## The invariant

*Every writer of selection state must share the ordering discipline of its
readers.* Current status of each:

```
handleSelectionLift      deferred  (round 2)
handleImagePaste         deferred  (round 2)
handleSelectionPending   deferred  (round 1)
handleSelectionMove      deferred  (round 1)
handleSelectionStamp / Commit / Fill / Delete / Merge / Flip / Cancel   deferred
sel_mask handler (SelectionHandlers.js)   NOT deferred — nulls pendingSelection
                                          and pendingLassoPath synchronously,
                                          and _sendActiveMasksToJoiner runs at
                                          the very end of the serve. Only bites
                                          in mask mode; not yet needed.
```

Corollary still true: the move's *geometry* and the move's *crop* must be
applied together (they are; both live on the same chain). Note that with moves
deferred, the `if (user.pendingImageLoad) user._pendingSourceCrop = ...` branch
in `handleSelectionMove` is now unreachable — `_queueIfLoading` returning false
already proves `pendingImageLoad` is falsy. It is left as defensive code.

## Round 4 — selection state after the resync path started working

Once the resync actually rebuilds (round 3), four more asymmetries surface. Two
were measured in a live 2-tab repro, two are read off the code.

1. **`requestSync` never cleaned the LOCAL user's selection state.** The cleanup
   loop skips `userId === app.sessionIndex`, which was correct while self frames
   were discarded — but the rebuild now drives `app.self` through the remote
   pipeline, so it accumulates `floatingCanvas` / `lassoPath` /
   `_selectionRestoreData` / `pendingImageLoad` and an overlay canvas that
   nothing resets. A stale `pendingImageLoad` is the dangerous one: the next
   rebuild's whole lift/move/commit chain queues behind a promise that settled in
   a previous sync. Now cleaned via `_cleanupUserSelection(app.self)` — selection
   fields only; SelectTool keeps its state on the tool, not the user.

2. **The self overlay was retired too early.** `replayBuffer()` cleared
   `app.self.context` synchronously, but selection verbs defer behind the
   SEL_LIFT decode, so the chain painted the marching-ants outline onto that
   canvas *after* the clear — a stray lasso marquee stuck on the board with no
   selection behind it. Now chained onto `pendingImageLoad`.

3. **`WebSocketClient._processMessage`'s self-echo gate** (the fifth one) now
   suspends while rebuilding, via `wsClient._isRebuilding` wired up in
   `SyncClient.init`. It was dropping self-authored `IMG_PASTE`, `UNDO`, `REDO`,
   `CLR` and `TEXT_REMOVE` — so a resync lost every pasted image and replayed a
   history with the undos missing. IMG_PASTE also carries the still-floating
   selection from `_sendActiveImagesToJoiner`.

4. **`_eraseSelectionFromLayer` erased far more than the drawer did.** MEASURED:
   same lift, drawer committed a 48x17 erase, the rebuild committed 550x200.
   `SelectTool._eraseRegionStroke` pins the dirty rect to the selection and
   `commitUserStroke` crops to it, so the drawer erases selection ∩ lasso; the
   remote handler recomputed bounds from the raw lassoPath and committed the
   whole polygon. `cropNewSelectionToContent` shrinks the selection to its
   content while the transmitted lassoPath stays the full drawn loop, so the gap
   is large exactly when the lasso is sloppy. Now clamped to the lifted rect.
   Note this one is a LIVE drawer-vs-observer divergence too, not just a rebuild
   bug.

Not reproduced synthetically: "final transform applied at the un-transformed
position". Driven programmatically (lasso, move, corner-scale, apply) the commit
landed at the correct transformed rect on both drawer and rebuild, and A's board
matched B's pixel for pixel. Needs the real gesture sequence to pin down.

## Round 3 — a resync by the client that did the drawing returns a blank board

### THE actual root cause (measured in a live 2-tab repro, confirmed fixed)

`WebSocketClient.handleMessage` splits inbound traffic in two:

```js
if (this._batchableMessages.has(data.t)) { this._messageQueue.push(...); this._scheduleProcessing(); return; }
this._tapInbound(data, raw); this._processMessage(data);   // immediate
```

Every frame of the join tail — MD/MM/MU, tool state, and all the SEL_* verbs —
is in `_batchableMessages`, so it is queued and drained asynchronously on an 8ms
budget. **`SYNC_COMPLETE` was not**, so it was processed synchronously the moment
it arrived and overtook the entire tail. Measured on localhost:

```
t=0.0ms  requestSync
t=1.3ms  SYNC_METADATA
t=5.9ms  SYNC_COMPLETE      -> handleSyncComplete(), eventBuffer EMPTY
t=7.1ms  ...the whole tail arrives and drains onto the LIVE path
```

So `replayBuffer()` no-opped on an empty buffer, `buffering` went false, and the
tail was applied through the live path — which exists to *discard* self-echoes.
For a fresh joiner this was invisible (the tail is someone else's work, the live
path draws it fine, and `replayBuffer`'s dedup/ordering simply never ran). For a
resync it was fatal: the tail is the requester's own work.

Fix: add `T.SYNC_COMPLETE` to `_batchableMessages` so it drains in receive order,
which is the same rule the file already documents for UNDO/REDO/CLR/FILL and the
selection verbs. Verified live: before `buffered=0`, after
`buffered=130 (own=118) applied=130 (own=118) rebuilding=true`, board restored,
peer unaffected, live drawing after the resync still single-applies.

The self-echo work below is still required — it is what lets the now-correctly-
buffered self-authored frames actually draw.

Separate bug, found while chasing the above. A draws, B syncs and gets
everything; **A** then syncs and gets a blank board. B leaving and rejoining
"fixes" it.

The checkpoint join tail is **author-agnostic** — `log.getRange(baseSeq+1,
latest)` replays every commit regardless of who made it, including the
requester's own. But the client throws its own frames away:

- `wrapHandler` (`WebSocketHandlers.js`) drops `data.sessionIndex ===
  app.sessionIndex` **before buffering** unless the event is in `allowSelf`.
  `md` and `mm` are not in that list, so the geometry of every stroke we drew is
  discarded outright.
- Everything that *is* in `allowSelf` hits a reconcile-only self branch in its
  handler (`reconcileLocalCommitStroke` / `reconcileLocalCommitBatch`, then
  `return`) which deliberately draws nothing.

Both are correct for the LIVE path, where a self-echo is an echo of work already
on our canvas. `requestSync()` calls `layerManager.clearAll()` first, which makes
that premise false — so the one client whose work makes up the whole tail is the
one that cannot rebuild it. The leave/rejoin "fix" is a red herring: dropping to
one client makes the server ask the last user for a fresh snapshot
(`index.js`, `getClientCount() === 1`), and A's next sync is then served that
**image**, which is user-agnostic pixels.

Fix: `SyncClient.isRebuilding()` (true from `requestSync` to `_completeSync`)
plus `App.isSelfEcho(sessionIndex)`, which is the self check every handler now
uses — it returns false while rebuilding, so our own tail takes the full drawing
path. `wrapHandler` also stops dropping self frames while rebuilding. Safe
because `InputBufferManager.queueBroadcast` suppresses our outgoing messages
while syncing, so no genuine live self-echo can land in that window.

The remote draw path writes previews to `user.context` unguarded, and the local
user has never had a per-user canvas, so `App.ensureRemoteUser` now provisions
one lazily for our own index (`createUserBoard` is just a transparent canvas —
no cursor, no name tag), and `replayBuffer` calls it for every author including
self. `replayBuffer` retires that preview surface when it finishes.

**The gates are in FOUR layers, not one** — fixing only the outer ones changes
nothing, which is exactly what happened on the first attempt:

1. `wrapHandler`'s `allowSelf` list (drops before buffering)
2. the reconcile-only `sessionIndex === app.sessionIndex` branches in
   `DrawingHandlers` / `SelectionHandlers`
3. **`RemoteUserHandler.handleMouseMove` / `handleMouseDown` / `handleMouseUp`** —
   these bail on `user.id === this.app.sessionIndex` *inside* the handler, so
   `md`/`mm`/`mu` still went nowhere after 1 and 2 were fixed. This is where
   "all my strokes are live/active and never come back" actually died: a live
   (undoable) stroke is not in the baked checkpoint image by construction, so the
   tail is its only source.
4. cosmetic-only skips that are fine to leave: `getDebugStats`, the marching-ants
   rAF loop, `cthn`/`csim` slider echoes, `obscure_region`.

All of 1–3 now route through `App.isSelfEcho(sessionIndex)`.

**The trap that made two rounds of this fix inert:** `isRebuilding()` was first
written as `!!this.buffering`. But `handleSyncComplete()` does

```js
this.buffering = false;
this.replayBuffer();
```

— clearing it one line *before* the replay, deliberately, so the tail and any
live events that follow reach their handlers directly. So anything keyed on
`buffering` is false for every frame of the replay and silently reinstates the
exact filtering it is supposed to suspend. It now has its own `_rebuilding`
flag: set in `requestSync()` (which is where the board is wiped), cleared in a
`finally` around `replayBuffer()`, with backstops in `_resetSyncAttempt`,
`_completeSync` and `resetForRoomChange` so an aborted sync cannot leave it set
(which would double-apply live self-echoes).

There is also a FIFTH gate, in `WebSocketClient._processMessage` (~line 853),
which drops self-authored **commit types** not on its exemption list. `md`/`mm`
are not commits so stroke geometry passes, but our own `UNDO`, `REDO`,
`IMG_PASTE`, `CLR` and `TEXT_REMOVE` are still discarded on a rebuild. Left
alone for now — it cannot cause a blank board, but it will misrebuild a session
containing undos or pasted images.

`SyncClient.replayBuffer()` logs a one-line tally
(`buffered=… (own=…) applied=… (own=…) rebuilding=…` + per-event counts) and
`_serveCheckpointJoin` warns on an empty tail. `rebuilding=false` in that line is
the signature of exactly this bug.

## Known remaining rough edges (not causes of the reported bug)

- `SyncClient.requestSync` skips `_cleanupTransientUserState` for a remote user
  with `mousedown === true`, so if A is mid-drag when B syncs, A's stale
  `floatingCanvas` / `lassoPath` / `pendingImageLoad` survive into the replay.
- A joiner's float is reconstructed from IMG_PASTE, which carries no lasso, so
  `user.lassoPath` is lost on that float. SEL_FILL no longer depends on it;
  SEL_DELETE and SEL_MERGE still would.
- `StrokeTape.truncateBefore` can drop the bundle holding a still-live
  selection's SEL_LIFT if a checkpoint lands mid-selection.

## Failed attempts — do not repeat these

1. **Applying move geometry synchronously while leaving the crop deferred.**
   Made it visibly worse ("stamps render way bigger and cut off",
   non-deterministic). `img.onload` then saw final scaled corners while
   `originalCorners` was still the uncropped size. Reverted; there is a comment
   at the `_queueIfLoading` call in `handleSelectionMove` recording this.

2. **Fixing the still-floating (uncommitted) op inside `handleSelectionMove`.**
   Wrong place — the fix belonged in `handleImagePaste` (round 2).

## Test harness traps that cost round 1 hours

1. **Ad-hoc room names can never checkpoint.** `Room.canPersistSnapshots()` is
   `isRegistered() || id === 'lobby'`. A random room name → no checkpoint →
   `baseSeq = 0` → the joiner replays the **entire** command tail, which is the
   path that WORKS. Use the **lobby** (auto-snapshot timer 15s,
   `SYNC_CHECKPOINT_MINTED` = type 145).

2. **Pixel parity is blind to this whole bug class.** A commit rebuilt at seq 0
   renders *identically* to one at its real seq whenever it is the newest
   stroke. Compare **stroke seqs**, not pixels.

3. **Compare the joiner against a LIVE OBSERVER, not the drawer.** The drawer
   holds its own strokes outside `layerGroups[].strokeStack` until they bake, so
   `captureLayerSnapshotsInPage` cannot see the drawer's own ink. Diffing
   drawer-vs-anyone yields a fake 77–88% "desync" that is pure harness artifact.

4. `waitConverged` must include `totalStack` in its signature
   (`count|hash|stack`).

5. **`test:selparity` does not reproduce this.** Run as a negative control with
   fixes reverted, it still passed. `testing/devtools/selection_sync_probe.mjs`
   (untracked) reproduces some of it — `--checkpoint` runs in the lobby,
   `--only=<verbs>` filters, `--headed` to watch.

6. **The user does not want more test-building.** Fix it logically by reading
   code. Every real root cause in both rounds was found by reading. Use tests
   only to confirm, and always run a **negative control**.

## Architecture note worth knowing

`handleSyncRequest(ws, _data)` **ignores `data.tu`**. Pressing "Sync" on a
specific user does NOT sync from that user — it always calls
`_serveCheckpointJoin`, rebuilding from server-authoritative state (checkpoint
image + `strokeLog` tail + `strokeTape` preambles). The per-user targeting is
vestigial UI. **There is no legitimate reason for any difference to exist.**

The checkpoint image contains **only baked content** through the baked watermark
(`compositeBakedThroughSeq(ctx, i, watermark)`); everything still live/undoable
must come from the retained tail, and `snapshots.js` truncates `strokeLog` /
`strokeTape` at the checkpoint seq.

## Environment

- `.env` points `MONGODB_URI` at **Atlas** — persistence and checkpoints are ON.
- `npm run server` → ws on **:8030**; `npx vite --port 3000` → **:3000**.
- **Server changes require a manual restart** (round 2 touches `server/index.js`,
  `server/StrokeTape.js`, `server/validation.js`); client changes need a hard
  reload (HMR drops the room, so rejoin).
- **Never `git commit` or `git add`** — the user commits their own work.
