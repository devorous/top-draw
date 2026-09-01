/**
 * @fileoverview Canvas backing-store census.
 *
 * Board-size lag is not visible to JS timers. Measurements on a real weak
 * machine (2 cores, Intel UHD) put `composite.all` at ~2% load and the tile-grid
 * scan at 0.08% — the JS render path is not what stalls. The leading remaining
 * suspect is total canvas backing store: every canvas the app holds is a GPU
 * texture, and crossing the renderer's GPU memory budget causes eviction and
 * demotion to software rasterization, which fails as a cliff rather than a curve
 * and scales with both board area and device memory.
 *
 * That number is not observable from any profiler, so this walks every canvas
 * the app owns and adds up `width * height * 4`. It is the ground truth that
 * decides whether the memory work in docs/board_size_lag_plan_2026-08-23.md is
 * worth doing.
 *
 * Deliberately explicit rather than a generic object graph walk: the holders are
 * known, and a blind deep walk over App would chase cycles and DOM nodes.
 * Anything missed shows up as a gap between this total and the browser's own
 * memory figure, which is a safer failure than a walker that hangs.
 */

const BYTES_PER_PIXEL = 4;
const MB = 1024 * 1024;

/**
 * Backing-store size of one canvas.
 *
 * Reads width/height rather than any CSS size: the backing store is what costs
 * memory, and a canvas scaled by a CSS transform has the same backing store at
 * every zoom level.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas|null|undefined} canvas
 * @returns {number} Bytes.
 */
function canvasBytes(canvas) {
  const w = canvas?.width | 0;
  const h = canvas?.height | 0;
  if (w <= 0 || h <= 0) return 0;
  return w * h * BYTES_PER_PIXEL;
}

/**
 * Walk every canvas the app holds and total its backing store.
 *
 * @param {Object} app - The App instance.
 * @returns {{
 *   totalBytes: number,
 *   totalMB: number,
 *   canvasCount: number,
 *   fullBoardCount: number,
 *   boardWidth: number,
 *   boardHeight: number,
 *   fullBoardMB: number,
 *   buckets: Array<{label: string, count: number, bytes: number, mb: number, fullBoard: number}>
 * }}
 */
export function collectCanvasCensus(app) {
  const board = app?.board;
  const [boardH = 0, boardW = 0] = board?.dimensions || [];
  const fullBoardBytes = (boardW | 0) * (boardH | 0) * BYTES_PER_PIXEL;

  // A canvas can be reachable from more than one holder (a userBoard is both in
  // the DOM and on the user model), so identity-dedupe or the total inflates.
  const seen = new Set();
  const buckets = new Map();

  const add = (label, canvas) => {
    if (!canvas || typeof canvas.width !== 'number') return;
    if (seen.has(canvas)) return;
    seen.add(canvas);

    const bytes = canvasBytes(canvas);
    let bucket = buckets.get(label);
    if (!bucket) {
      bucket = { label, count: 0, bytes: 0, fullBoard: 0 };
      buckets.set(label, bucket);
    }
    bucket.count++;
    bucket.bytes += bytes;
    // A canvas at or above full board area is the unit that matters — those are
    // what the plan's reduction work targets. Small UI canvases are noise.
    if (fullBoardBytes > 0 && bytes >= fullBoardBytes) bucket.fullBoard++;
  };

  // LayerManager first: these are detached canvases with meaningful labels, and
  // counting them before the DOM sweep keeps the generic `dom.*` buckets from
  // absorbing anything we can name.
  const lm = board?.layerManager;
  if (lm) {
    for (const group of lm.layerGroups || []) {
      add('layers.flat', group.flatCanvas);

      for (const record of group.strokeStack || []) add('layers.strokeStack', record?.canvas);
      for (const record of group.flatStrokeRecords || []) add('layers.flatRecords', record?.canvas);

      // bakedSequences holds either a bare seq number or a rasterized group
      // carrying its own full-board canvas — only the latter costs memory.
      for (const seq of group.bakedSequences || []) {
        if (seq && typeof seq === 'object') {
          add('layers.bakedSeq', seq.canvas);
          for (const record of seq.strokes || []) add('layers.bakedSeq', record?.canvas);
        }
      }

      for (const active of group.activeStrokeByUser?.values?.() || []) {
        add('layers.activeStroke', active?.canvas);
      }
      for (const preview of group.activePreviewByUser?.values?.() || []) {
        add('layers.activePreview', preview?.canvas);
      }
    }

    for (const pooled of lm._canvasPool || []) add('layers.pool', pooled?.canvas);
    add('layers.groupBuffer', lm._groupBuffer?.canvas);
  }

  // Board-owned offscreen canvases that never enter the DOM.
  if (board) {
    add('board.offscreen', board._eraserPreviewCanvas);
  }

  // Tool offscreen canvases. Named individually because InkTool's pair is
  // board-sized and was the subject of an earlier fix.
  const tools = app?.toolManager?.tools;
  if (tools) {
    for (const tool of Object.values(tools)) {
      if (!tool || typeof tool !== 'object') continue;
      add('tools.offscreen', tool.offscreenCanvas);
      add('tools.offscreen', tool.hardnessCanvas);
      add('tools.offscreen', tool.floatingCanvas);
      // PatternTool keeps board-sized stroke masks per remote user, plus a
      // composite surface per in-flight stroke and a short free-list of those.
      // All are full-board and none are reachable from anything above.
      for (const off of tool.remoteOffscreens?.values?.() || []) {
        add('tools.patternMask', off?.canvas);
      }
      for (const surface of tool._compositeSurfaces?.values?.() || []) {
        add('tools.patternComposite', surface?.canvas);
      }
      for (const surface of tool._compositePool || []) {
        add('tools.patternCompositePool', surface?.canvas);
      }
      // The blur family freezes a board-sized snapshot per in-flight stroke and
      // keeps a small free-list of them (SnapshotCanvasPool). Both are
      // full-board and neither is reachable from anything above.
      for (const canvas of tool.snapshotCanvases?.values?.() || []) {
        add('tools.blurSnapshot', canvas);
      }
      for (const canvas of tool._snapshotCanvases?.values?.() || []) {
        add('tools.blurSnapshot', canvas);
      }
      for (const canvas of tool._snapshotPool?._free || []) {
        add('tools.blurSnapshotPool', canvas);
      }
      add('tools.blurScratch', tool._blurScratch?.canvas);
      add('tools.glitchCropScratch', tool._cropScratch?.canvas);
    }
  }

  // Per-user offscreen canvases. These hang off the user model, never enter the
  // DOM, and are not reachable from LayerManager — so nothing above finds them
  // and every earlier census undercounted by up to two full-board canvases per
  // remote user who has drawn. At 1440p with six active users that is ~90 MB
  // invisible, which is most of the gap between this total and the GPU
  // process's own figure. `_inkOffscreen` and `_penOffscreen` are disposed on
  // departure and on AFK, so the case they accumulate in is a user who drew
  // once and then sat idle.
  const users = app?.users;
  if (users?.values) {
    for (const user of users.values()) {
      add('user.inkOffscreen', user?._inkOffscreen);
      add('user.penOffscreen', user?._penOffscreen);
      add('user.selectionCache', user?._cachedPreviewCanvas);
      add('user.floating', user?.floatingCanvas);
    }
  }
  if (app?.self) {
    add('user.inkOffscreen', app.self._inkOffscreen);
    add('user.penOffscreen', app.self._penOffscreen);
  }

  // Everything attached to the document, which covers the board layers, the
  // overlays, per-user preview boards and any UI canvases (brush previews,
  // colour picker, minimap). Runs last so named buckets win.
  if (typeof document !== 'undefined') {
    for (const canvas of document.querySelectorAll('canvas')) {
      const id = canvas.id;
      let label = 'dom.other';
      if (id === 'board' || id === 'topBoard') label = 'dom.boardPair';
      else if (id === 'upperLayersBoard') label = 'dom.upperLayers';
      else if (id === 'mirrorRegionsLayer' || id === 'mirrorGuidesLayer') label = 'dom.mirror';
      else if (id === 'selectionOverlay' || id === 'interactionBlockOverlay' || id === 'handleOverlay') label = 'dom.overlays';
      else if (canvas.classList.contains('userBoard')) label = 'dom.userBoards';
      add(label, canvas);
    }
  }

  let totalBytes = 0;
  let fullBoardCount = 0;
  for (const bucket of buckets.values()) {
    totalBytes += bucket.bytes;
    fullBoardCount += bucket.fullBoard;
  }

  const rows = [...buckets.values()]
    .map((b) => ({ ...b, mb: b.bytes / MB }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    totalBytes,
    totalMB: totalBytes / MB,
    canvasCount: seen.size,
    fullBoardCount,
    boardWidth: boardW | 0,
    boardHeight: boardH | 0,
    fullBoardMB: fullBoardBytes / MB,
    buckets: rows
  };
}

/**
 * Console-friendly dump. Exposed via `window.app.canvasCensus()`.
 *
 * @param {Object} app - The App instance.
 * @returns {Object} The census, so it can be inspected or diffed.
 */
export function logCanvasCensus(app) {
  const census = collectCanvasCensus(app);
  const { boardWidth, boardHeight, fullBoardMB } = census;

  console.log(
    `[canvasCensus] ${census.totalMB.toFixed(1)} MB across ${census.canvasCount} canvases ` +
    `(${census.fullBoardCount} at full board size). ` +
    `Board ${boardWidth}x${boardHeight} = ${fullBoardMB.toFixed(1)} MB each. ` +
    `deviceMemory=${navigator.deviceMemory ?? 'N/A'} GB, cores=${navigator.hardwareConcurrency ?? 'N/A'}`
  );
  console.table(census.buckets.map((b) => ({
    bucket: b.label,
    canvases: b.count,
    'full-board': b.fullBoard,
    MB: Number(b.mb.toFixed(2))
  })));

  return census;
}
