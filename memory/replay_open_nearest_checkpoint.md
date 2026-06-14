---
name: replay_open_nearest_checkpoint
description: replay checkpoints carry full undoable layer state (QOI) so rebuilds from nearest checkpoint are faithful
metadata:
  type: project
---

Opening the History "Recent" / time-machine player on a heavy session used to lag
because `loadFromRecording`'s catch-up called `seek(sessionEnd, { forceFromOpening: true })`
— replaying the ENTIRE rolling window (≤2 min) from the opening anchor. `forceFromOpening`
existed because intra-checkpoints were flat composite PNGs (`captureOpeningSnapshot` →
`getCompositedCanvas`): they froze the still-undoable strokeStack into pixels, so a rebuild
had an empty strokeStack (any UNDO/REDO replayed afterward had nothing to pop — the core
bug) and unbaked complex-blend strokes baked wrong against a transparent backdrop.

Phase-3 fix (2026-06-14): checkpoints now carry **full undoable layer state**, not a flat PNG.
- `src/replay/layerStateCodec.js` — `exportLayerState(layerManager)` returns `{ layerBaked,
  history, activeStrokes, redoHistory }`, all canvases QOI-encoded (lossless, `wasm.qoi_encode`;
  empties dropped via `wasm.has_content`). Baked base per layer = `compositeBakedThroughSeq(ctx, gi, 0)`
  (temporarily empties strokeStack → pure permanent content, eraser/blur-aware). Live strokeStack +
  redo stacks + active (mid-drag, cropped to dirtyRect) strokes serialized as records. Returns null
  when nothing is live/undoable (fully-baked board → cheap flat path kept).
- `captureOpeningSnapshot` (snapshotCapture.js) spreads layerState and sets `canvasData = null`
  when present (loadSnapshot ignores it then; skips the full-board PNG encode).
- `ReplayEngine.loadSnapshot` seeds the baked base via `importSequence(gi,'source-over',qoiToCanvas(...))`
  then imports history/redo/active. `_buildImportedStrokeRecord` + `_restoreActiveStrokes` decode the
  `qoi`/`maskQoi` form and preserve `seq`/`blendBakeMode`/`selectionRestoreData`.
- `.ddraw` round-trips the QOI Uint8Arrays automatically via ddrawCodec `_replacer`/`_reviver` (`__u8` base64).

`forceFromOpening` now only fires for OLD flat-only recordings with complex blends
(`!_checkpointsCarryLayerState(rec) && _tapeHasComplexBlend(rec)` in TimeMachine.svelte.js).
Intra-checkpoint interval = `INTRA_CHECKPOINT_INTERVAL_MS` = 30000 (RollingTapeRecorder; raised from 12000 since each checkpoint is now heavier), idle-scheduled.
Also added a subtle `.rp-preview-spinner` (on `isPreviewMode`) to SnapshotMenu.svelte + ReplayMiniViewer.svelte.

WATCH: capture cost — every 12s checkpoint now does per-layer baked-base getImageData + per-stroke/active
QOI encodes (vs one PNG before). Idle-scheduled, but a very busy board could see occasional frame drops;
if so, offload encoding to a worker or cap serialized stroke count. Related: [[sync_checkpoint_join_bakes_undoable]],
[[replay_mini_viewer_ui]], [[rolling_tape_history]], [[glitch_result_blend_must_travel]].
