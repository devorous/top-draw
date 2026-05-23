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

  return {
    ...base,
    ...transient,
    ...pen,
    ...ink,
    previewCanvasData,
  };
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
    recordedAt: Date.now(),
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
  };
}
