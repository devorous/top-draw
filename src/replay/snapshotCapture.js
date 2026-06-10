/**
 * @fileoverview Capture an opening snapshot for the local Recorder.
 *
 * Emits a bundle in the shape ReplayEngine.loadSnapshot() already consumes
 * (see src/timebar/ReplayEngine.js — `loadSnapshot()` reads
 * `canvasData`, `topCanvasData`, `history`, `redoHistory`, `activeStrokes`,
 * `appState.userDrawingStates`).
 *
 * Phase 1 takes the **flat-composite** path: dump a single PNG of the
 * composited board as `canvasData`. That lets ReplayEngine seed the replay
 * board from one image and apply the delta tape on top. Phase 3 will swap
 * in `history`/`activeStrokes` for full stroke-record fidelity.
 */

/**
 * Snapshot the per-user transient/tool/selection state in the shape
 * ReplayEngine._restoreBotTransientState consumes.
 *
 * NOTE: this intentionally copies what the engine already hydrates from.
 * Audited against ReplayEngine.js lines 1371–1539 on 2026-05-21.
 *
 * @param {import('../User.js').User} user
 * @returns {Object}
 */
function captureUserTransientState(user) {
  const base = typeof user.toJSON === 'function' ? user.toJSON() : { ...user };

  // Live transient state — the engine reads these by name.
  const transient = {
    mousedown:    !!user.mousedown,
    panning:      !!user.panning,
    text:         user.text,
    startPos:     user.startPos ? { ...user.startPos } : null,
    currentLine:  Array.isArray(user.currentLine) ? user.currentLine.map((p) => ({ ...p })) : [],
    lineLength:   user.lineLength,
    remoteTarget: user.remoteTarget ? { ...user.remoteTarget } : null,
    lassoPoints:  Array.isArray(user.lassoPoints) ? user.lassoPoints.map((p) => ({ ...p })) : null,
    lastx:        user.lastx,
    lasty:        user.lasty,
    prevpressure: user.prevpressure,
    smoothBuffer: user.smoothBuffer
      ? { x: user.smoothBuffer.x, y: user.smoothBuffer.y, isFirst: !!user.smoothBuffer.isFirst }
      : null,
  };

  // Per-tool offscreen canvases. We serialise as PNG dataURLs so the bundle
  // is JSON-safe (the parity harness ships bundles between tabs via
  // evaluate_script). The replay engine accepts dataURLs in these fields.
  const pen = user._penOffscreen
    ? {
        penOffscreenData:  user._penOffscreen.toDataURL('image/png'),
        penStrokeActive:   !!user._penStrokeActive,
        penStrokeColor:    user._penStrokeColor ?? null,
        penAlpha:          user._penAlpha ?? null,
        penHardness:       user._penHardness ?? null,
        penLastStampPos:   user._penLastStampPos ? { ...user._penLastStampPos } : null,
        penPoints:         Array.isArray(user.penPoints) ? user.penPoints.map((p) => ({ ...p })) : [],
      }
    : {};

  const ink = user._inkOffscreen
    ? {
        inkOffscreenData: user._inkOffscreen.toDataURL('image/png'),
        inkStrokeActive:  !!user._inkStrokeActive,
        inkStrokeColor:   user._inkStrokeColor ?? null,
        inkAlpha:         user._inkAlpha ?? null,
        inkHardness:      user._inkHardness ?? null,
        inkSize:          user._inkSize ?? null,
        inkPoints:        Array.isArray(user._inkPoints) ? user._inkPoints.map((p) => Array.isArray(p) ? [...p] : p) : [],
      }
    : {};

  const previewCanvasData = user.board ? user.board.toDataURL('image/png') : null;

  const selection = {};
  if (user.selection) selection.selection = { ...user.selection };
  if (user.pendingSelection) selection.pendingSelection = { ...user.pendingSelection };
  if (Array.isArray(user.pendingLassoPath)) {
    selection.pendingLassoPath = user.pendingLassoPath.map((p) => ({ ...p }));
  }
  if (Array.isArray(user.lassoPath)) {
    selection.lassoPath = user.lassoPath.map((p) => ({ ...p }));
  }
  if (user.selectionCorners) {
    selection.selectionCorners = {
      tl: { ...user.selectionCorners.tl },
      tr: { ...user.selectionCorners.tr },
      br: { ...user.selectionCorners.br },
      bl: { ...user.selectionCorners.bl },
    };
  }
  if (user.originalCorners) {
    selection.originalCorners = {
      tl: { ...user.originalCorners.tl },
      tr: { ...user.originalCorners.tr },
      br: { ...user.originalCorners.br },
      bl: { ...user.originalCorners.bl },
    };
  }
  if (user.originalSelectionPos) {
    selection.originalSelectionPos = { ...user.originalSelectionPos };
  }
  if (user.floatingCanvas) {
    selection.floatingCanvasData = user.floatingCanvas.toDataURL('image/png');
    selection.floatingCanvasWidth = user.floatingCanvas.width;
    selection.floatingCanvasHeight = user.floatingCanvas.height;
  }
  if (user._cachedPreviewCanvas) {
    selection.cachedSelectionPreviewData = user._cachedPreviewCanvas.toDataURL('image/png');
    selection.cachedSelectionPreviewBounds = user._cachedPreviewBounds
      ? { ...user._cachedPreviewBounds }
      : null;
  }
  if (user._selectionRestoreData) {
    selection.selectionRestoreData = {
      eraseS: user._selectionRestoreData.eraseS ? { ...user._selectionRestoreData.eraseS } : null,
      eraseLassoPath: Array.isArray(user._selectionRestoreData.eraseLassoPath)
        ? user._selectionRestoreData.eraseLassoPath.map((p) => ({ ...p }))
        : null,
      eraseTimestamp: user._selectionRestoreData.eraseTimestamp,
      eraseUserId: user._selectionRestoreData.eraseUserId,
      snapshots: (user._selectionRestoreData.snapshots || []).map((snap) => ({
        groupIdx: snap.groupIdx,
        x: snap.x,
        y: snap.y,
        width: snap.canvas?.width ?? 0,
        height: snap.canvas?.height ?? 0,
        canvasData: snap.canvas?.toDataURL?.('image/png') ?? null,
      })),
    };
  }

  return {
    ...base,
    ...transient,
    ...pen,
    ...ink,
    ...selection,
    previewCanvasData,
  };
}

/**
 * Snapshot active SVG text overlay records in replay-engine format. Text
 * overlay state is not part of the composited canvas, so it has to be carried
 * beside snapshots/checkpoints with a wall-clock tape birth timestamp.
 *
 * @param {import('../canvas/Board.js').Board} board
 * @param {number} capturedAt
 * @returns {Array<[string, Object]>}
 */
function captureVectorTextRecords(board, capturedAt) {
  const records = board?.textOverlay?.records;
  if (!records?.size) return [];

  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const out = [];
  for (const [id, stored] of records) {
    const record = stored?.record;
    if (!id || !record?.text) continue;

    const lifetimeMs = Number(record.lifetimeMs) || 30_000;
    const ageMs = Math.max(0, now - (Number(stored.bornAt) || now));
    if (ageMs >= lifetimeMs) continue;

    out.push([String(id), {
      record: {
        text: record.text,
        font: record.font,
        size: record.size,
        color: Array.isArray(record.color) ? [...record.color] : record.color,
        x: record.x,
        y: record.y,
        textPositionMultiplier: record.textPositionMultiplier,
        textPositionOffset: record.textPositionOffset,
        layerIdx: record.layerIdx
      },
      bornTs: capturedAt - ageMs,
      lifetimeMs,
      fadeMs: Number.isFinite(record.fadeMs) ? record.fadeMs : undefined,
      holdMs: Number.isFinite(record.holdMs) ? record.holdMs : undefined,
      minOpacity: Number.isFinite(record.minOpacity) ? record.minOpacity : 0,
      baseOpacity: Number.isFinite(record.opacity) ? record.opacity : 1
    }]);
  }
  return out;
}

/**
 * Build the opening snapshot for a recording.
 *
 * @param {Object} app - the live App instance (window.app)
 * @returns {{
 *   version: number,
 *   recordedAt: number,
 *   roomId: string | null,
 *   boardDimensions: [number, number],
 *   backgroundColor: number[],
 *   canvasData: string | null,
 *   topCanvasData: string | null,
 *   appState: { userDrawingStates: Record<number, Object> },
 *   mirrorRegions: Object[],
 *   mirror: boolean,
 * }}
 */
export function captureOpeningSnapshot(app) {
  const board = app?.board;
  if (!board) {
    throw new Error('[captureOpeningSnapshot] no board on app');
  }
  const lm = board.layerManager;
  if (!lm) {
    throw new Error('[captureOpeningSnapshot] no layerManager on board');
  }

  const recordedAt = Date.now();

  // Composite the whole board to a single PNG dataURL. ReplayEngine.loadSnapshot
  // uses `canvasData` as the base image when no `history` is present.
  const compositeCanvas = lm.getCompositedCanvas();
  const canvasData = compositeCanvas.toDataURL('image/png');

  // Top canvas (active previews drawn by other users at snapshot time)
  const topCanvasData = board.topCanvas?.toDataURL?.('image/png') ?? null;

  // Per-user state. Includes self so it gets bot-replayed too — the local
  // session is just another participant from the replay's POV.
  const userDrawingStates = {};
  if (app.users) {
    for (const [id, user] of app.users.entries()) {
      userDrawingStates[id] = captureUserTransientState(user);
    }
  }

  return {
    version: 2,
    recordedAt,
    roomId: app.currentRoomId ?? null,
    boardDimensions: [board.getHeight?.() ?? 0, board.getWidth?.() ?? 0],
    backgroundColor: Array.isArray(board.backgroundColor)
      ? [...board.backgroundColor]
      : [255, 255, 255, 1],
    canvasData,
    topCanvasData,
    appState: { userDrawingStates },
    mirrorRegions: Array.isArray(board.mirrorRegions)
      ? board.mirrorRegions.map((r) => ({ ...r }))
      : [],
    mirror: !!board.mirror,
    // App-global shape draw mode at record start; mid-tape changes ride along
    // as CSDM messages.
    shapeDrawMode: app.shapeDrawMode === 'center-scaling' ? 'center-scaling' : 'corner-to-corner',
    vectorText: captureVectorTextRecords(board, recordedAt),
  };
}
