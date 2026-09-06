/**
 * board_capture.js — capture snippet for multi-window board-state comparison.
 *
 * Companion to board_state_compare.py. Paste the function below into the
 * DevTools MCP `evaluate_script` tool once per window, and ALWAYS pass the
 * tool's `filePath` argument so the multi-megabyte base64 payload is written
 * straight to disk instead of into the agent transcript:
 *
 *     evaluate_script({
 *       function: "<contents of captureBoard below>",
 *       filePath: "captures/A.json"     // file stem becomes the compare label
 *     })
 *
 * Then diff the captures:
 *
 *     python testing/devtools/board_state_compare.py captures/ --out captures/diffs
 *
 * Capture the *composited board canvas* (`board.viewCtx.canvas`), never a page
 * screenshot: screenshots pick up cursors, remote-user overlay canvases, the
 * marching-ants selection outline and the zoom level, none of which are board
 * state and all of which legitimately differ between clients.
 *
 * Quiesce first. Give every window ~1s after the last action so the tick loop
 * (60 TPS) has drained its input buffer and composited, otherwise you are
 * timing the render, not comparing state.
 */

// --- captureBoard: paste this as the evaluate_script `function` argument ---
() => {
  const app = window.app;
  if (!app || !app.board) return { error: 'app/board not ready' };

  const canvas = app.board.viewCtx.canvas;
  const layerGroups = app.board.layerManager?.layerGroups || [];

  return {
    // Identity — so a capture can be traced back to the window it came from.
    user: app.self?.name ?? null,
    sessionIndex: app.sessionIndex,
    connected: app.connected,
    capturedAt: new Date().toISOString(),

    // Board state metadata. Useful context when a diff fails: a stroke-count
    // mismatch says the desync is in history, not just in pixels.
    width: canvas.width,
    height: canvas.height,
    activeLayer: app.self?.activeLayer ?? 0,
    shapeDrawMode: app.shapeDrawMode,
    strokeStacks: layerGroups.map((g) => (g?.strokeStack || []).map((s) => ({
      userId: s.userId,
      seq: s.seq ?? 0,
      blendMode: s.blendMode,
      x: s.x, y: s.y, w: s.width, h: s.height
    }))),

    // The payload board_state_compare.py reads.
    dataUrl: canvas.toDataURL('image/png')
  };
}
