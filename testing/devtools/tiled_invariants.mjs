#!/usr/bin/env node
/**
 * @fileoverview Invariant probes for the tiled canvas backing store — the
 * checks that are decided by an exact integer or an identical buffer rather
 * than by drawing with a tool.
 *
 * Each probe answers one of the ranked risks in the tiled-canvas test plan and
 * prints its own raw numbers, so a failure is localised without re-running
 * anything:
 *
 *   alpha       Can a 2D canvas hold non-zero RGB under zero alpha at all?
 *               If it cannot, `regionIsBlank`'s alpha-only test cannot destroy
 *               colour information, and risk #2 is closed by construction.
 *   ops         Per globalCompositeOperation: is per-tile compositing equal to
 *               whole-canvas compositing (raw), and does the production path
 *               (`writeToFlatCanvas` -> `_flatWindowWriteBack`, which screens
 *               ops through TILED_UNSAFE_COMPOSITE_OPS) diverge (guarded)?
 *   clear       `clearLayerFlatRect` / dropCovered against fully-covered,
 *               partially-covered and seam-straddling rects.
 *   dirty       Composite with dirty rects. `_drawCanvasRegion` composites
 *               WHOLE intersecting tiles and relies on an upstream clip to hide
 *               the overdraw; a missing clip shows as content outside the rect.
 *   roundtrip   toFullCanvas/fromFullCanvas with content sitting exactly on
 *               tile seams, board edges and single-pixel columns.
 *   tilesize    tileSizeForBoard over every preset and a set of non-16:9 boards.
 *   resize      Board resize while tiled: does the grid re-derive?
 *   overflow    The NATURAL overflow bake — commit >MAX_STROKES_PER_USER (20)
 *               strokes through the real begin/commitUserStroke pair and let
 *               _bakeOverflowStrokes flatten the oldest by itself, rather than
 *               calling _bakeStrokeToBin directly as every other harness does.
 *               Then undo repeatedly. Tiled and untiled must agree at every step.
 *   midstroke   Toggle the backing store off / re-granularize it WHILE a stroke
 *               is in progress. A ROOM_UPDATE can fire that toggle at any moment
 *               (report section 26), so a user drawing while someone edits a
 *               mirror region hits exactly this.
 *   memory      Do the reported bytes match the tiles, does the census agree,
 *               and does allocate/free churn return to baseline?
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9223 node testing/devtools/tiled_invariants.mjs
 *   ... --only=ops,dirty      to run a subset
 */

import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const SIZE = arg('size', '1440p');
const ONLY = arg('only', 'all');
const CHURN = Number(arg('churn', 20));
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9223';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 120_000);

const BOARD_SIZES = {
  '720p': [720, 1280], '1080p': [1080, 1920], '1440p': [1440, 2560],
  big: [1800, 3200], '4k': [2160, 3840], '8k': [4320, 7680], '12k': [6480, 11520]
};
const dims = BOARD_SIZES[SIZE];
if (!dims) throw new Error(`unknown --size=${SIZE}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = (name) => ONLY === 'all' || ONLY.split(',').includes(name);

const SETUP = `(() => {
  const app = window.app;
  const lm = () => app.board.layerManager;
  const g0 = () => lm().layerGroups[0];

  // The room is authoritative for board size and pushes it on connect, so a
  // plain resizeBoard() before the room settles is silently undone — a run that
  // says --size=1440p then quietly measures 1080p. Lock it, the same way
  // tiled_ab.mjs does. The 'resize' probe needs to move the board, so it
  // unlocks first.
  window.__lockBoardSize = function (h, w) {
    const board = app.board;
    board.resizeBoard([h, w]);
    app._bindLayerManagerDependencies?.();
    if (!board.__origResize) board.__origResize = board.resizeBoard.bind(board);
    board.resizeBoard = (d) => { if (!d || d[0] !== h || d[1] !== w) return; return board.__origResize(d); };
  };
  window.__unlockBoardSize = function () {
    const board = app.board;
    if (board.__origResize) board.resizeBoard = board.__origResize;
  };

  window.__digest = function (canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const w = canvas.width, h = canvas.height;
    const band = Math.max(1, Math.floor(4 * 1024 * 1024 / (w * 4)));
    const bands = [];
    let nz = 0;
    for (let y = 0; y < h; y += band) {
      const bh = Math.min(band, h - y);
      const d = ctx.getImageData(0, y, w, bh).data;
      let hash = 0x811c9dc5;
      for (let i = 0; i < d.length; i++) { hash ^= d[i]; hash = (hash * 0x01000193) >>> 0; }
      for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) nz++;
      bands.push(hash);
    }
    return { bands, nz };
  };

  window.__eq = function (a, b) {
    if (!a || !b || a.bands.length !== b.bands.length) return false;
    for (let i = 0; i < a.bands.length; i++) if (a.bands[i] !== b.bands[i]) return false;
    return true;
  };

  // Composite layer 0 (only) into a fresh full-board canvas and digest it.
  window.__layer0 = function (dirtyRects) {
    const [h, w] = app.board.dimensions;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    lm().compositeLayerRange(c.getContext('2d', { willReadFrequently: true }), 0, 1, null, dirtyRects || null);
    const d = window.__digest(c);
    c.width = 0; c.height = 0;
    return d;
  };

  // A base raster that is NOT aligned to any tile grid, painted through
  // withFlatCanvasContext so it is identical in both arms.
  window.__baseKind = 'grid';
  window.__paintBase = function () {
    const [h, w] = app.board.dimensions;
    const kind = window.__baseKind;
    lm().withFlatCanvasContext(0, (ctx) => {
      if (kind === 'none') return;
      let i = 0;
      const pitch = kind === 'grid' ? 61 : 373;
      const box = kind === 'grid' ? 43 : 37;
      for (let y = 7; y < h; y += pitch) {
        for (let x = 13; x < w; x += pitch, i++) {
          ctx.fillStyle = 'hsl(' + ((i * 53) % 360) + ' 80% 55%)';
          ctx.fillRect(x, y, box, box - 4);
        }
      }
    });
  };

  window.__resetFlat = function () {
    const [h, w] = app.board.dimensions;
    lm().setTiledBackingStore(false);
    const g = g0();
    g.bakedSequences = [];
    g.flatStrokeRecords = [];
    g.strokeStack.length = 0;
    lm().clearLayerFlatRect(0, 0, 0, w, h);
    window.__paintBase();
    lm().needsComposite = true;
  };

  window.__tileInfo = function () {
    const g = g0();
    if (!g?.tiled) return { tiled: false, tiles: 0, total: 0, bytes: 0, tileSize: 0 };
    const fc = g.flatCanvas;
    return { tiled: true, tiles: fc.allocatedTileCount, total: fc.cols * fc.rows,
      bytes: fc.allocatedBytes, tileSize: fc.tileSize, cols: fc.cols, rows: fc.rows };
  };

  // A small opaque patch with a transparent hole, so destination-clearing
  // operators have something to visibly do.
  window.__patch = function (w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(255, 40, 40, 1)';
    ctx.fillRect(0, 0, w, h);
    ctx.clearRect(Math.floor(w / 4), Math.floor(h / 4), Math.floor(w / 2), Math.floor(h / 2));
    return c;
  };

  // ---- probe: the NATURAL overflow bake, and undo on top of it -------------
  //
  // Every exactness result so far forces the bake by calling _bakeStrokeToBin
  // directly, because a short scripted test never reaches flatCanvas on its own
  // (trap #1). That leaves the path a real user actually takes untested: commit
  // more than MAX_STROKES_PER_USER (20) strokes and _bakeOverflowStrokes
  // flattens the oldest ones into the backing store by itself.
  //
  // So: commit N strokes through the real beginUserStroke/commitUserStroke pair,
  // let the overflow fire naturally, and require the tiled and untiled results
  // to be byte-identical — then undo repeatedly and require them to stay
  // byte-identical at every step.
  window.__probeOverflowUndo = function (n) {
    const uid = app.self?.id ?? 0;

    const commitOne = (i) => {
      const w = 90, h = 70;
      const x = 60 + (i % 8) * 173;   // 173/151 are coprime with every tile size
      const y = 80 + (i % 5) * 151;   // in play, so strokes straddle seams
      lm().beginUserStroke(0, uid, 'source-over');
      const active = g0().activeStrokeByUser.get(uid);
      if (!active) return false;
      // The active stroke canvas may be WINDOWED rather than full-board, in
      // which case board coordinates have to be offset by its origin before
      // drawing (see docs on active-stroke windowing). Getting this wrong
      // misplaces every stroke and would read as a tiling failure.
      const ox = active.origin ? active.origin.x : 0;
      const oy = active.origin ? active.origin.y : 0;
      active.ctx.drawImage(window.__patch(w, h), x - ox, y - oy);
      // commitUserStroke crops to dirtyRect; without one the stroke is dropped.
      active.dirtyRect = { minX: x, minY: y, maxX: x + w - 1, maxY: y + h - 1 };
      lm().commitUserStroke(0, uid, { seq: i + 1 });
      return true;
    };

    const run = (tiled) => {
      window.__resetFlat();
      if (tiled) lm().setTiledBackingStore(true);
      let committed = 0;
      for (let i = 0; i < n; i++) if (commitOne(i)) committed++;
      const afterCommit = window.__layer0();
      const stackLen = g0().strokeStack.length;
      const info = window.__tileInfo();
      // Undo as far as the LIVE stack allows. Baked strokes are permanent, so
      // this necessarily stops early — that is the documented cap, not a bug.
      const undos = [];
      for (let k = 0; k < 6; k++) {
        try { app.handleUndo?.(); } catch (e) { undos.push({ err: String(e.message) }); break; }
        undos.push({ d: window.__layer0(), stack: g0().strokeStack.length });
      }
      if (tiled) lm().setTiledBackingStore(false);
      return { afterCommit, committed, stackLen, tiles: info.tiles, total: info.total, undos };
    };

    const a = run(false);
    const b = run(true);
    const undoSteps = Math.min(a.undos.length, b.undos.length);
    let undoMatch = a.undos.length === b.undos.length;
    const perStep = [];
    for (let i = 0; i < undoSteps; i++) {
      const ok = !!(a.undos[i].d && b.undos[i].d) && window.__eq(a.undos[i].d, b.undos[i].d);
      perStep.push({ ok, aStack: a.undos[i].stack, bStack: b.undos[i].stack });
      if (!ok) undoMatch = false;
    }
    return {
      committed: a.committed,
      commitMatch: window.__eq(a.afterCommit, b.afterCommit),
      nzUntiled: a.afterCommit.nz, nzTiled: b.afterCommit.nz,
      stackUntiled: a.stackLen, stackTiled: b.stackLen,
      tiles: b.tiles, total: b.total,
      undoMatch, perStep
    };
  };

  // ---- probe: toggling tiling in the MIDDLE of a live stroke ---------------
  //
  // setTiledBackingStore re-slices layer 0 while an in-progress stroke sits on
  // its own separate canvas. That *should* be untouched — but nothing has ever
  // driven it, and a ROOM_UPDATE can fire the toggle at any moment (section 26),
  // so a user drawing when someone edits a mirror region hits exactly this.
  window.__probeMidStroke = function (mode) {
    const uid = app.self?.id ?? 0;
    const w = 260, h = 180, x = 300, y = 240;   // deliberately spans seams

    const run = (toggleMidway) => {
      window.__resetFlat();
      lm().setTiledBackingStore(true);
      lm().beginUserStroke(0, uid, 'source-over');
      const active = g0().activeStrokeByUser.get(uid);
      if (!active) return null;
      const ox = active.origin ? active.origin.x : 0;
      const oy = active.origin ? active.origin.y : 0;
      // first half of the stroke
      active.ctx.drawImage(window.__patch(w, h / 2), x - ox, y - oy);
      if (toggleMidway === 'off')      lm().setTiledBackingStore(false);
      else if (toggleMidway === 'regrid') lm().setTiledBackingStore(true, 320);
      // second half, after the grid changed underneath
      active.ctx.drawImage(window.__patch(w, h / 2), x - ox, y + h / 2 - oy);
      active.dirtyRect = { minX: x, minY: y, maxX: x + w - 1, maxY: y + h - 1 };
      lm().commitUserStroke(0, uid, { seq: 1 });
      const d = window.__layer0();
      const info = window.__tileInfo();
      lm().setTiledBackingStore(false);
      return { d, tiles: info.tiles, tileSize: info.tileSize };
    };

    const control = run(null);          // no toggle
    const toggled = run(mode);          // toggled mid-stroke
    if (!control || !toggled) return { error: 'no active stroke' };
    return {
      match: window.__eq(control.d, toggled.d),
      nzControl: control.d.nz, nzToggled: toggled.d.nz,
      tilesControl: control.tiles, tilesToggled: toggled.tiles,
      tileSizeToggled: toggled.tileSize
    };
  };

  // ---- probe: fractional / subpixel coordinates across a seam -------------
  //
  // Every geometry tested so far lands on integer coordinates. A stroke at a
  // fractional x spreads antialiased coverage across BOTH sides of a tile seam,
  // and pruneNew blank-checks a freshly allocated tile over bounds padded by
  // only +/-2px. A half-pixel of coverage that lands just outside that pad on a
  // tile which is otherwise empty would be freed, silently.
  window.__probeFractional = function () {
    const g = g0();
    const ts = g?.tiled ? g.flatCanvas.tileSize : (window.__tileSizeHint || 160);
    const cases = [];
    // Offsets chosen so the shape's edge sits at, just before, and just after a
    // seam, at sub-pixel positions a tool would really produce.
    for (const off of [-0.5, -0.25, 0, 0.25, 0.5, 0.75]) {
      cases.push({ label: 'seam' + off, x: ts * 5 + off, y: ts * 4 + 30.5, w: 60.5, h: 40.25 });
    }
    // A hairline exactly on the seam: 1px wide, fractional origin.
    cases.push({ label: 'hairline', x: ts * 6 - 0.5, y: ts * 3 + 12.5, w: 1.5, h: 90.5 });

    const out = [];
    for (const c of cases) {
      const src = document.createElement('canvas');
      src.width = Math.ceil(c.w) + 2; src.height = Math.ceil(c.h) + 2;
      const sctx = src.getContext('2d');
      sctx.fillStyle = 'rgba(0,180,255,1)';
      // Draw at the fractional offset INSIDE the source so the antialiasing is
      // baked into the source raster, then place it on an integer boundary —
      // this is the shape a real windowed stroke canvas has.
      sctx.fillRect(c.x - Math.floor(c.x), c.y - Math.floor(c.y), c.w, c.h);

      window.__resetFlat();
      const bounds = { x: Math.floor(c.x), y: Math.floor(c.y), width: src.width, height: src.height };
      lm().writeToFlatCanvas(0, src, bounds.x, bounds.y);
      const untiled = window.__layer0();

      window.__resetFlat();
      lm().setTiledBackingStore(true);
      lm().writeToFlatCanvas(0, src, bounds.x, bounds.y);
      const tiled = window.__layer0();
      const info = window.__tileInfo();
      lm().setTiledBackingStore(false);

      out.push({ label: c.label, same: window.__eq(untiled, tiled),
        nzU: untiled.nz, nzT: tiled.nz, tiles: info.tiles });
    }
    return out;
  };

  // ---- probe: does content SURVIVE a board resize while tiled? -------------
  //
  // The resize probe below checks the grid re-derives to the right shape. It
  // does not check that the pixels are still there afterwards, which is the part
  // a user would notice. Compare a tiled resize against an untiled one.
  window.__probeResizeContent = function (h2, w2) {
    const run = (tiled) => {
      window.__unlockBoardSize();
      app.board.resizeBoard([1440, 2560]);
      app._bindLayerManagerDependencies?.();
      window.__resetFlat();
      if (tiled) lm().setTiledBackingStore(true);
      // Paint a marker grid through the tile-aware path so both arms match.
      lm().withFlatCanvasContext(0, (ctx) => {
        for (let i = 0; i < 24; i++) {
          ctx.fillStyle = 'hsl(' + ((i * 47) % 360) + ' 90% 50%)';
          ctx.fillRect(37 + i * 101, 53 + (i % 6) * 197, 71, 59);
        }
      });
      const before = window.__layer0();
      const infoBefore = window.__tileInfo();

      app.board.resizeBoard([h2, w2]);
      app._bindLayerManagerDependencies?.();
      const after = window.__layer0();
      const infoAfter = window.__tileInfo();
      lm().setTiledBackingStore(false);
      return { nzBefore: before.nz, nzAfter: after.nz, after,
        tilesBefore: infoBefore.tiles, tilesAfter: infoAfter.tiles,
        tiledAfter: infoAfter.tiled, tileSizeAfter: infoAfter.tileSize };
    };
    const u = run(false);
    const t = run(true);
    return { u, t, sameAfter: window.__eq(u.after, t.after) };
  };

  // ---- probe: RGB under zero alpha -----------------------------------------
  window.__probeAlpha = function () {
    const c = document.createElement('canvas');
    c.width = 4; c.height = 1;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const img = ctx.createImageData(4, 1);
    // px0: opaque red. px1: red with alpha 0. px2: white with alpha 0.
    // px3: red with alpha 1/255 (the smallest non-zero alpha).
    img.data.set([255, 0, 0, 255,  255, 0, 0, 0,  255, 255, 255, 0,  255, 0, 0, 1]);
    ctx.putImageData(img, 0, 0);
    const back = Array.from(ctx.getImageData(0, 0, 4, 1).data);
    // Same question via a normal draw: fillStyle with alpha 0.
    const c2 = document.createElement('canvas');
    c2.width = 1; c2.height = 1;
    const ctx2 = c2.getContext('2d', { willReadFrequently: true });
    ctx2.fillStyle = 'rgba(255,0,0,0)';
    ctx2.fillRect(0, 0, 1, 1);
    const drawn = Array.from(ctx2.getImageData(0, 0, 1, 1).data);
    return { putImageData: back, filled: drawn };
  };

  // ---- probe: composite operators ------------------------------------------
  window.__probeOp = function (op, x, y, w, h) {
    const src = window.__patch(w, h);

    window.__resetFlat();
    const g = g0();
    g.flatCtx.globalCompositeOperation = op;
    g.flatCtx.drawImage(src, x, y);
    g.flatCtx.globalCompositeOperation = 'source-over';
    const untiled = window.__layer0();

    // raw: straight at the tile grid, no operator screening.
    window.__resetFlat();
    lm().setTiledBackingStore(true);
    g0().flatCanvas.paintImage({ x, y, width: w, height: h }, src, op, { create: true });
    const raw = window.__layer0();

    // guarded: the production entry point, which screens the operator.
    //
    // Whether the operator is IN the guard set is *measured*, not mirrored: the
    // fallback in _flatWindowWriteBack announces itself with a console.error, so
    // trapping that error is a direct observation of the live
    // TILED_UNSAFE_COMPOSITE_OPS. An earlier version of this probe kept its own
    // hard-coded copy of the set, which meant it reported the same verdicts
    // whatever the source actually said — a fix to LayerManager.js could not
    // turn its failures green.
    let sawGuard = false;
    const realError = console.error;
    console.error = function (...args) {
      if (typeof args[0] === 'string' && args[0].includes('is not tile-safe')) sawGuard = true;
      return realError.apply(this, args);
    };
    try {
      window.__resetFlat();
      lm().setTiledBackingStore(true);
      lm().writeToFlatCanvas(0, src, x, y, op);
    } finally {
      console.error = realError;
    }
    const guarded = window.__layer0();

    lm().setTiledBackingStore(false);
    return {
      rawSame: window.__eq(untiled, raw),
      guardedSame: window.__eq(untiled, guarded),
      inGuard: sawGuard,
      nzUntiled: untiled.nz, nzRaw: raw.nz, nzGuarded: guarded.nz
    };
  };

  // ---- probe: clearLayerFlatRect / dropCovered -----------------------------
  window.__probeClear = function (rect) {
    window.__resetFlat();
    lm().clearLayerFlatRect(0, rect.x, rect.y, rect.width, rect.height);
    const untiled = window.__layer0();

    window.__resetFlat();
    lm().setTiledBackingStore(true);
    const before = window.__tileInfo();
    lm().clearLayerFlatRect(0, rect.x, rect.y, rect.width, rect.height);
    const after = window.__tileInfo();
    const tiled = window.__layer0();
    lm().setTiledBackingStore(false);
    const back = window.__layer0();

    return {
      same: window.__eq(untiled, tiled),
      roundtrip: window.__eq(tiled, back),
      nzUntiled: untiled.nz, nzTiled: tiled.nz,
      tilesBefore: before.tiles, tilesAfter: after.tiles
    };
  };

  // ---- probe: dirty-rect composite ----------------------------------------
  window.__probeDirty = function (rects) {
    window.__resetFlat();
    const untiled = window.__layer0(rects);
    window.__resetFlat();
    lm().setTiledBackingStore(true);
    const tiled = window.__layer0(rects);
    lm().setTiledBackingStore(false);
    return { same: window.__eq(untiled, tiled), nzUntiled: untiled.nz, nzTiled: tiled.nz };
  };

  // ---- probe: full-raster round trip ---------------------------------------
  // Content deliberately placed on seams, edges and as 1px slivers, then run
  // through toFullCanvas -> fromFullCanvas, which is the seam every full-raster
  // consumer (checkpoints, join-sync PNGs, QOI snapshots, resize, undo rebuild)
  // goes through.
  window.__probeRoundtrip = function () {
    const [h, w] = app.board.dimensions;
    window.__baseKind = 'none';
    window.__resetFlat();
    const ts = (() => { lm().setTiledBackingStore(true); const s = window.__tileInfo().tileSize; lm().setTiledBackingStore(false); return s; })();

    lm().withFlatCanvasContext(0, (ctx) => {
      ctx.fillStyle = '#0af';
      // 1px column exactly on a vertical seam, and the column just before it.
      ctx.fillRect(ts * 3, 0, 1, h);
      ctx.fillRect(ts * 5 - 1, 0, 1, h);
      // 1px row on a horizontal seam.
      ctx.fillStyle = '#fa0';
      ctx.fillRect(0, ts * 2, w, 1);
      // Corner pixels of the board.
      ctx.fillStyle = '#f0f';
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillRect(w - 1, 0, 1, 1);
      ctx.fillRect(0, h - 1, 1, 1);
      ctx.fillRect(w - 1, h - 1, 1, 1);
      // A patch straddling the very last (possibly partial) tile.
      ctx.fillStyle = '#0f8';
      ctx.fillRect(w - 40, h - 40, 40, 40);
    });
    const before = window.__layer0();

    lm().setTiledBackingStore(true);
    const onTiled = window.__layer0();
    const info = window.__tileInfo();
    // Explicit full-raster round trip inside the tiled arm.
    const full = g0().flatCanvas.toFullCanvas();
    const fullDigest = window.__digest(full);
    g0().flatCanvas.fromFullCanvas(full);
    const reimported = window.__layer0();
    const info2 = window.__tileInfo();
    lm().setTiledBackingStore(false);
    const back = window.__layer0();
    window.__baseKind = 'grid';

    return {
      toTiled: window.__eq(before, onTiled),
      fullCanvasSame: window.__eq(before, fullDigest),
      reimportSame: window.__eq(before, reimported),
      backSame: window.__eq(before, back),
      nz: before.nz, nzTiled: onTiled.nz, nzFull: fullDigest.nz,
      nzReimport: reimported.nz, nzBack: back.nz,
      tiles: info.tiles, tilesAfterReimport: info2.tiles, total: info.total
    };
  };

  // ---- probe: compact() ----------------------------------------------------
  // compact() is the one Debug-mode action that can delete pixels: it sweeps
  // every allocated tile with a readback and frees the ones that came out
  // blank. Two things have to hold — it must not change what the layer renders,
  // and it must free EXACTLY the tiles that are genuinely blank, no more and no
  // fewer. The second is checked against an independent oracle: stitch the
  // layer to one full canvas and blank-test each tile rect there, rather than
  // trusting the same code path compact() uses.
  window.__probeCompact = function (rects) {
    const [h, w] = app.board.dimensions;
    window.__baseKind = 'grid';
    window.__resetFlat();
    lm().setTiledBackingStore(true);
    const before = window.__tileInfo();

    // Erase regions that fully empty some tiles and only partly cover others.
    for (const r of rects) lm().clearLayerFlatRect(0, r.x, r.y, r.width, r.height);
    const afterErase = window.__tileInfo();
    const digestBefore = window.__layer0();

    // Independent oracle: which tiles actually hold a non-transparent pixel?
    const grid = g0().flatCanvas;
    const full = grid.toFullCanvas();
    const fullCtx = full.getContext('2d', { willReadFrequently: true });
    let trulyOccupied = 0;
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const x = col * grid.tileSize, y = row * grid.tileSize;
        const tw = Math.min(grid.tileSize, w - x), th = Math.min(grid.tileSize, h - y);
        if (tw <= 0 || th <= 0) continue;
        const d = fullCtx.getImageData(x, y, tw, th).data;
        for (let i = 3; i < d.length; i += 4) { if (d[i] !== 0) { trulyOccupied++; break; } }
      }
    }
    full.width = 0; full.height = 0;

    const released = grid.compact();
    const afterCompact = window.__tileInfo();
    const digestAfter = window.__layer0();
    lm().setTiledBackingStore(false);

    return {
      tilesBefore: before.tiles, afterErase: afterErase.tiles,
      released, afterCompact: afterCompact.tiles, trulyOccupied,
      pixelsUnchanged: window.__eq(digestBefore, digestAfter),
      nzBefore: digestBefore.nz, nzAfter: digestAfter.nz,
      bytesAfter: afterCompact.bytes, total: before.total
    };
  };

  // ---- probe: memory / churn ----------------------------------------------
  window.__probeMemory = function (cycles) {
    const [h, w] = app.board.dimensions;
    window.__baseKind = 'grid';
    window.__resetFlat();
    lm().setTiledBackingStore(true);
    const full = window.__tileInfo();

    // Clear everything: every tile is fully covered, so dropCovered should free
    // all of them with no readback.
    lm().clearLayerFlatRect(0, 0, 0, w, h);
    const emptied = window.__tileInfo();

    const seen = [];
    for (let i = 0; i < cycles; i++) {
      window.__paintBase();
      const a = window.__tileInfo().tiles;
      lm().clearLayerFlatRect(0, 0, 0, w, h);
      const b = window.__tileInfo();
      seen.push([a, b.tiles, b.bytes]);
    }
    const finalInfo = window.__tileInfo();

    // Does the census report the real tile bytes rather than the nominal board?
    let census = null;
    try {
      window.__paintBase();
      const c = app.canvasCensus?.({ log: false }) ?? app.canvasCensus?.();
      census = { totalMB: c?.totalMB ?? null, tiles: window.__tileInfo() };
    } catch (e) { census = { error: String(e && e.message) }; }

    lm().setTiledBackingStore(false);
    return {
      fullTiles: full.tiles, fullBytes: full.bytes, total: full.total,
      emptiedTiles: emptied.tiles, emptiedBytes: emptied.bytes,
      churn: seen, finalTiles: finalInfo.tiles, finalBytes: finalInfo.bytes,
      nominalBytes: w * h * 4, census
    };
  };

  return true;
})()`;

const PRESET_BOARDS = [
  ['720p', 1280, 720], ['1080p', 1920, 1080], ['1440p', 2560, 1440], ['4k', 3840, 2160],
  ['big(3200x1800)', 3200, 1800], ['8k', 7680, 4320], ['12k', 11520, 6480]
];
const NON_169 = [
  ['square 2048', 2048, 2048], ['4:3 1600x1200', 1600, 1200], ['odd 1921x1080', 1921, 1080],
  ['16:10 1920x1200', 1920, 1200], ['tiny 100x56', 100, 56]
];

const OPS = [
  'source-over', 'destination-out', 'destination-over', 'lighter', 'xor',
  'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference',
  'color-dodge', 'color-burn', 'hue', 'saturation', 'color', 'luminosity',
  'source-atop', 'destination-atop', 'source-in', 'destination-in', 'source-out', 'copy'
];

(async () => {
  const browser = await puppeteer.connect({
    browserURL: CDP_URL, defaultViewport: null, protocolTimeout: 300_000
  });
  const page = (await browser.pages())[0] || (await browser.newPage());
  const fails = [];
  try {
    for (const other of await browser.pages()) {
      if (other !== page) { try { await other.close(); } catch { /* already gone */ } }
    }
    await page.bringToFront();
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    // main.js starts the app from inside a requestAnimationFrame, which Chrome
    // does not run for a hidden window — window.app then never appears, with no
    // error, and the wait below burns the whole READY_TIMEOUT looking like a
    // hung dev stack. Every other harness here already guards this; this one
    // did not.
    const vis = await page.evaluate(() => document.visibilityState);
    if (vis !== 'visible') throw new Error(`page is ${vis} — rAF will not fire and the app will never boot`);
    await page.waitForFunction(() => window.app && window.app.self != null, { timeout: READY_TIMEOUT });
    await page.evaluate(SETUP);
    const room = `tinv_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'TINV'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: READY_TIMEOUT });
    await page.evaluate((h, w) => window.__lockBoardSize(h, w), dims[0], dims[1]);
    await sleep(1500);
    const actual = await page.evaluate(() => window.app.board.dimensions);
    if (actual[0] !== dims[0] || actual[1] !== dims[1]) {
      throw new Error(`board size did not take: wanted ${dims}, got ${actual}`);
    }
    console.log(`\n=== tiled invariants   board ${actual[1]}x${actual[0]}\n`);

    // --- tilesize -----------------------------------------------------------
    if (want('tilesize')) {
      console.log('  [tilesize] TiledLayerCanvas.tileSizeForBoard');
      const rows = await page.evaluate(async (presets, others) => {
        const { TiledLayerCanvas } = await import('/src/canvas/TiledLayerCanvas.js');
        const one = ([label, w, h]) => {
          const ts = TiledLayerCanvas.tileSizeForBoard(w, h);
          const cols = Math.ceil(w / ts), rows = Math.ceil(h / ts);
          return { label, w, h, ts, cols, rows, tiles: cols * rows,
            exact: (w % ts === 0) && (h % ts === 0) };
        };
        return { presets: presets.map(one), others: others.map(one) };
      }, PRESET_BOARDS, NON_169);
      for (const r of rows.presets) {
        const ok = r.tiles === 144 && r.exact && r.cols === 16 && r.rows === 9;
        if (!ok) fails.push(`tilesize preset ${r.label}: ${r.cols}x${r.rows}=${r.tiles} @${r.ts} exact=${r.exact}`);
        console.log(`    ${r.label.padEnd(16)} ${String(r.w + 'x' + r.h).padEnd(12)} tile ${String(r.ts).padStart(4)}  grid ${r.cols}x${r.rows} = ${String(r.tiles).padStart(4)}  exact ${r.exact ? 'y' : 'N'}  ${ok ? 'ok' : 'FAIL'}`);
      }
      for (const r of rows.others) {
        const ok = r.ts === 256;
        if (!ok) fails.push(`tilesize non-16:9 ${r.label}: got ${r.ts}, expected 256 fallback`);
        console.log(`    ${r.label.padEnd(16)} ${String(r.w + 'x' + r.h).padEnd(12)} tile ${String(r.ts).padStart(4)}  grid ${r.cols}x${r.rows} = ${String(r.tiles).padStart(4)}  exact ${r.exact ? 'y' : 'N'}  ${ok ? 'ok (fallback)' : 'FAIL'}`);
      }
      console.log('');
    }

    // --- alpha --------------------------------------------------------------
    if (want('alpha')) {
      const a = await page.evaluate(() => window.__probeAlpha());
      console.log('  [alpha] can a 2D canvas hold non-zero RGB under zero alpha?');
      console.log(`    putImageData([255,0,0,255, 255,0,0,0, 255,255,255,0, 255,0,0,1]) reads back`);
      console.log(`      ${JSON.stringify(a.putImageData)}`);
      console.log(`    fillRect rgba(255,0,0,0) reads back ${JSON.stringify(a.filled)}`);
      const px1 = a.putImageData.slice(4, 8);
      const px2 = a.putImageData.slice(8, 12);
      const holdsColour = (px1[0] || px1[1] || px1[2] || px2[0] || px2[1] || px2[2]) !== 0;
      console.log(`    verdict: canvas ${holdsColour ? 'DOES' : 'does NOT'} retain RGB under zero alpha`);
      if (holdsColour) fails.push('alpha: canvas retains RGB under zero alpha — regionIsBlank can destroy it');
      console.log('');
    }

    // --- ops ----------------------------------------------------------------
    if (want('ops')) {
      console.log('  [ops] per-tile vs whole-canvas compositing, and the production guard');
      console.log('    op                    raw-safe  guarded-same   nz untiled / raw / guarded   verdict');
      for (const op of OPS) {
        // A patch that covers part of some tiles and all of others, and does not
        // start on a tile boundary.
        const r = await page.evaluate((o) => window.__probeOp(o, 330, 250, 500, 380), op);
        // Observed from the live guard's own console.error, not mirrored here.
        const inGuard = r.inGuard;

        // An op that is genuinely not tile-safe AND is in the guard set is
        // *meant* to diverge: `_flatWindowWriteBack` downgrades it to
        // source-over and logs a console.error. That is fail-loud, by design,
        // not a defect — so it must not be counted as one.
        let verdict;
        if (!r.rawSame && inGuard) {
          verdict = 'guarded (falls back to source-over + console.error)';
        } else if (!r.rawSame && !inGuard) {
          verdict = 'BUG: unsafe and unguarded — diverges silently';
          fails.push(`ops: "${op}" is NOT tile-safe and is NOT in TILED_UNSAFE_COMPOSITE_OPS — tiled and untiled diverge with no error (untiled nz ${r.nzUntiled} vs tiled ${r.nzGuarded})`);
        } else if (r.rawSame && inGuard) {
          verdict = 'BUG: safe but guarded — needless downgrade';
          fails.push(`ops: "${op}" IS tile-safe but is in TILED_UNSAFE_COMPOSITE_OPS, so the guard downgrades it to source-over and the tiled path diverges from the untiled one (untiled nz ${r.nzUntiled} vs tiled ${r.nzGuarded})`);
        } else if (!r.guardedSame) {
          verdict = 'BUG: safe, unguarded, but the production path still diverges';
          fails.push(`ops: production path diverges for tile-safe "${op}" (untiled nz ${r.nzUntiled} vs tiled ${r.nzGuarded})`);
        } else {
          verdict = 'ok';
        }

        console.log(`    ${op.padEnd(20)}  ${(r.rawSame ? 'yes' : 'NO ').padStart(8)}`
          + `  ${(r.guardedSame ? 'yes' : 'NO ').padStart(12)}`
          + `   ${r.nzUntiled} / ${r.nzRaw} / ${r.nzGuarded}`
          + `${inGuard ? '  [guarded]' : ''}   ${verdict}`);
      }
      console.log('');
    }

    // --- clear --------------------------------------------------------------
    if (want('clear')) {
      console.log('  [clear] clearLayerFlatRect: dropCovered on full/partial/seam rects');
      const ts = await page.evaluate(() => {
        const lm = window.app.board.layerManager;
        lm.setTiledBackingStore(true);
        const s = lm.layerGroups[0].flatCanvas.tileSize;
        lm.setTiledBackingStore(false);
        return s;
      });
      const rects = [
        ['covers 4 whole tiles', { x: ts * 2, y: ts * 2, width: ts * 2, height: ts * 2 }],
        ['partial, inside one tile', { x: ts * 5 + 20, y: ts * 3 + 20, width: 60, height: 60 }],
        ['straddles a seam', { x: ts * 6 - 30, y: ts * 4 - 30, width: 60, height: 60 }],
        ['whole board', { x: 0, y: 0, width: actual[1], height: actual[0] }],
        ['off-board negative origin', { x: -200, y: -200, width: ts * 3, height: ts * 3 }],
        ['past the right/bottom edge', { x: actual[1] - 50, y: actual[0] - 50, width: 400, height: 400 }]
      ];
      console.log('    rect                          tiles before/after   nz untiled / tiled   same  roundtrip');
      for (const [label, rect] of rects) {
        const r = await page.evaluate((x) => window.__probeClear(x), rect);
        console.log(`    ${label.padEnd(28)}  ${String(r.tilesBefore + '/' + r.tilesAfter).padStart(9)}`
          + `        ${String(r.nzUntiled).padStart(7)} / ${String(r.nzTiled).padEnd(7)}`
          + `  ${(r.same ? 'y' : 'N').padStart(4)}  ${(r.roundtrip ? 'y' : 'N').padStart(9)}`);
        if (!r.same) fails.push(`clear: "${label}" diverges (untiled nz ${r.nzUntiled} vs tiled ${r.nzTiled})`);
        if (!r.roundtrip) fails.push(`clear: "${label}" round trip back to untiled diverges`);
      }
      console.log('');
    }

    // --- dirty --------------------------------------------------------------
    if (want('dirty')) {
      console.log('  [dirty] dirty-rect composite (tiles are drawn whole and clipped upstream)');
      const ts = await page.evaluate(() => {
        const lm = window.app.board.layerManager;
        lm.setTiledBackingStore(true);
        const s = lm.layerGroups[0].flatCanvas.tileSize;
        lm.setTiledBackingStore(false);
        return s;
      });
      const sets = [
        ['one small rect mid-tile', [{ x: ts * 3 + 37, y: ts * 3 + 41, width: 46, height: 39 }]],
        ['rect on a seam', [{ x: ts * 4 - 21, y: ts * 5 - 17, width: 43, height: 31 }]],
        ['several disjoint rects', [
          { x: 33, y: 47, width: 61, height: 29 },
          { x: ts * 7 + 5, y: ts * 2 + 9, width: 120, height: 77 },
          { x: ts * 11 + 3, y: ts * 6 + 3, width: 200, height: 150 }
        ]],
        ['rect clipped by the board edge', [{ x: actual[1] - 30, y: actual[0] - 30, width: 60, height: 60 }]]
      ];
      console.log('    case                              nz untiled / tiled   same');
      for (const [label, rects] of sets) {
        const r = await page.evaluate((x) => window.__probeDirty(x), rects);
        console.log(`    ${label.padEnd(32)}  ${String(r.nzUntiled).padStart(7)} / ${String(r.nzTiled).padEnd(7)}   ${r.same ? 'y' : 'N'}`);
        if (!r.same) fails.push(`dirty: "${label}" diverges (untiled nz ${r.nzUntiled} vs tiled ${r.nzTiled})`);
      }
      console.log('');
    }

    // --- roundtrip ----------------------------------------------------------
    if (want('roundtrip')) {
      const r = await page.evaluate(() => window.__probeRoundtrip());
      console.log('  [roundtrip] seam/edge/1px content through toFullCanvas + fromFullCanvas');
      console.log(`    nz: base ${r.nz}  tiled ${r.nzTiled}  toFullCanvas ${r.nzFull}  re-imported ${r.nzReimport}  back to untiled ${r.nzBack}`);
      console.log(`    tiles ${r.tiles}/${r.total}, after re-import ${r.tilesAfterReimport}/${r.total}`);
      console.log(`    full->tiled ${r.toTiled ? 'ok' : 'FAIL'}   toFullCanvas ${r.fullCanvasSame ? 'ok' : 'FAIL'}`
        + `   fromFullCanvas ${r.reimportSame ? 'ok' : 'FAIL'}   tiled->full ${r.backSame ? 'ok' : 'FAIL'}`);
      if (!r.toTiled) fails.push('roundtrip: full -> tiled lost or changed pixels');
      if (!r.fullCanvasSame) fails.push('roundtrip: toFullCanvas output differs from the layer');
      if (!r.reimportSame) fails.push('roundtrip: fromFullCanvas re-import differs');
      if (!r.backSame) fails.push('roundtrip: tiled -> full differs');
      if (r.tiles !== r.tilesAfterReimport) fails.push(`roundtrip: tile count changed across re-import (${r.tiles} -> ${r.tilesAfterReimport})`);
      console.log('');
    }

    // --- compact ------------------------------------------------------------
    if (want('compact')) {
      const ts = await page.evaluate(() => {
        const lm = window.app.board.layerManager;
        lm.setTiledBackingStore(true);
        const s = lm.layerGroups[0].flatCanvas.tileSize;
        lm.setTiledBackingStore(false);
        return s;
      });
      // The interesting case for compact() is a tile emptied by clears that
      // never FULLY cover it, since `dropCovered` already frees the fully
      // covered ones with no readback (measured: a whole-tile band left
      // compact() nothing to do). Tiles (6,3) and (7,3) are each emptied by two
      // half-width clears, so they stay allocated but blank until compact()
      // sweeps them. The last rect is a partial bite that must NOT free its
      // tile, so "released" has a single right answer.
      const rects = [
        { x: ts * 6, y: ts * 3, width: ts / 2, height: ts },
        { x: ts * 6 + ts / 2, y: ts * 3, width: ts / 2, height: ts },
        { x: ts * 7, y: ts * 3, width: ts, height: ts / 2 },
        { x: ts * 7, y: ts * 3 + ts / 2, width: ts, height: ts / 2 },
        { x: ts * 9 + 10, y: ts * 6 + 10, width: 40, height: 40 }
      ];
      const r = await page.evaluate((x) => window.__probeCompact(x), rects);
      const mb = (n) => (n / 1048576).toFixed(2) + 'MB';
      console.log('  [compact] frees only genuinely blank tiles, loses nothing');
      console.log(`    tiles: ${r.tilesBefore}/${r.total} -> after erase ${r.afterErase} -> compact released ${r.released} -> ${r.afterCompact} (${mb(r.bytesAfter)})`);
      console.log(`    independent oracle says ${r.trulyOccupied} tiles genuinely hold a pixel`);
      console.log(`    layer pixels: nz ${r.nzBefore} -> ${r.nzAfter}, byte-identical ${r.pixelsUnchanged ? 'yes' : 'NO'}`);
      if (!r.pixelsUnchanged) fails.push(`compact: the rendered layer changed (nz ${r.nzBefore} -> ${r.nzAfter}) — compact() destroyed content`);
      if (r.afterCompact !== r.trulyOccupied) fails.push(`compact: left ${r.afterCompact} tiles but ${r.trulyOccupied} are genuinely occupied`);
      if (r.released <= 0) fails.push(`compact: released ${r.released} tiles — the case did not empty any, so it proves nothing`);
      console.log('');
    }

    // --- memory -------------------------------------------------------------
    if (want('memory')) {
      const r = await page.evaluate((n) => window.__probeMemory(n), CHURN);
      const mb = (n) => (n / 1048576).toFixed(2) + 'MB';
      console.log('  [memory] real bytes, dropCovered reclaim, and churn baseline');
      console.log(`    grid base:  ${r.fullTiles}/${r.total} tiles, ${mb(r.fullBytes)} of ${mb(r.nominalBytes)} nominal`);
      console.log(`    after full clearLayerFlatRect: ${r.emptiedTiles} tiles, ${mb(r.emptiedBytes)}`);
      const tilesSeen = new Set(r.churn.map((c) => c[0]));
      const emptySeen = new Set(r.churn.map((c) => c[1]));
      console.log(`    ${r.churn.length} paint/clear cycles: allocated tile counts seen ${[...tilesSeen].join(',')};`
        + ` post-clear counts seen ${[...emptySeen].join(',')}`);
      console.log(`    final ${r.finalTiles} tiles, ${mb(r.finalBytes)}`);
      if (r.census?.error) console.log(`    canvasCensus: error ${r.census.error}`);
      else console.log(`    canvasCensus total ${r.census.totalMB?.toFixed?.(1)} MB with ${r.census.tiles.tiles} tiles = ${mb(r.census.tiles.bytes)} in layer 0`);
      if (r.emptiedTiles !== 0) fails.push(`memory: a full-board clear left ${r.emptiedTiles} tiles allocated`);
      if (emptySeen.size !== 1 || !emptySeen.has(0)) fails.push(`memory: churn does not return to zero tiles (${[...emptySeen].join(',')})`);
      if (tilesSeen.size !== 1) fails.push(`memory: repainting the same base allocates a varying tile count (${[...tilesSeen].join(',')})`);
      console.log('');
    }

    // --- fractional coordinates ---------------------------------------------
    if (want('fractional')) {
      console.log('  [fractional] sub-pixel geometry straddling a tile seam');
      const rows = await page.evaluate(() => window.__probeFractional());
      for (const r of rows) {
        console.log(`    ${r.label.padEnd(12)} nz ${String(r.nzU).padStart(8)} / ${String(r.nzT).padStart(8)}`
          + `  tiles ${String(r.tiles).padStart(3)}  ${r.same ? 'byte-identical' : 'DIFFER'}`);
        if (!r.same) fails.push(`fractional ${r.label}: tiled != untiled (nz ${r.nzU} vs ${r.nzT})`);
        if (r.nzU === 0) fails.push(`fractional ${r.label}: drew nothing — vacuous`);
      }
      console.log('');
    }

    // --- content survives a resize ------------------------------------------
    if (want('resizecontent')) {
      console.log('  [resizecontent] does painted content survive a board resize while tiled?');
      for (const [label, h2, w2] of [['1440p->4k', 2160, 3840], ['1440p->720p', 720, 1280]]) {
        const r = await page.evaluate((a, b) => window.__probeResizeContent(a, b), h2, w2);
        console.log(`    ${label.padEnd(12)} untiled nz ${r.u.nzBefore} -> ${r.u.nzAfter}`
          + `   tiled nz ${r.t.nzBefore} -> ${r.t.nzAfter}`
          + `   tiles ${r.t.tilesBefore} -> ${r.t.tilesAfter} @${r.t.tileSizeAfter}`
          + `   ${r.sameAfter ? 'arms agree' : 'ARMS DIFFER'}`);
        if (r.u.nzBefore === 0 || r.t.nzBefore === 0) fails.push(`resizecontent ${label}: nothing painted — vacuous`);
        if (!r.sameAfter) fails.push(`resizecontent ${label}: tiled and untiled disagree after resize (nz ${r.u.nzAfter} vs ${r.t.nzAfter})`);
      }
      console.log('');
    }

    // --- overflow + undo ----------------------------------------------------
    if (want('overflow')) {
      console.log('  [overflow] natural overflow bake (>MAX_STROKES_PER_USER) then undo, tiled vs untiled');
      const n = Number(arg('strokes', 25));
      const r = await page.evaluate((k) => window.__probeOverflowUndo(k), n);
      console.log(`    committed ${r.committed} strokes; live stack after: untiled ${r.stackUntiled}, tiled ${r.stackTiled}`);
      console.log(`    tiles allocated ${r.tiles}/${r.total}`);
      console.log(`    after commits: nz untiled ${r.nzUntiled} vs tiled ${r.nzTiled} -> ${r.commitMatch ? 'byte-identical' : 'DIFFER'}`);
      if (r.committed === 0) fails.push('overflow: committed 0 strokes — probe is vacuous');
      if (r.tiles === 0) fails.push('overflow: 0 tiles allocated — the tiled arm ran no tiled code (trap #1)');
      if (r.stackUntiled >= n) {
        fails.push(`overflow: live stack is ${r.stackUntiled} of ${n} committed — the overflow bake never fired, so this tested nothing`);
      }
      if (!r.commitMatch) fails.push(`overflow: natural overflow bake diverges (untiled nz ${r.nzUntiled} vs tiled ${r.nzTiled})`);
      r.perStep.forEach((s, i) => {
        console.log(`    undo #${i + 1}: ${s.ok ? 'match' : 'DIFFER'}  (stack untiled ${s.aStack}, tiled ${s.bStack})`);
      });
      if (!r.undoMatch) fails.push('overflow: undo diverges between tiled and untiled');
      console.log('');
    }

    // --- mid-stroke toggle --------------------------------------------------
    if (want('midstroke')) {
      console.log('  [midstroke] toggling the backing store while a stroke is in progress');
      for (const mode of ['off', 'regrid']) {
        const r = await page.evaluate((m) => window.__probeMidStroke(m), mode);
        if (r.error) { fails.push(`midstroke ${mode}: ${r.error}`); console.log(`    ${mode}: ERROR ${r.error}`); continue; }
        console.log(`    toggle ${mode.padEnd(7)} nz control ${r.nzControl} vs toggled ${r.nzToggled}`
          + `  tiles ${r.tilesControl}->${r.tilesToggled}  tile ${r.tileSizeToggled}  ${r.match ? 'byte-identical' : 'DIFFER'}`);
        if (r.nzControl === 0) fails.push(`midstroke ${mode}: control drew nothing — vacuous`);
        if (!r.match) fails.push(`midstroke ${mode}: toggling mid-stroke changed the committed pixels (control nz ${r.nzControl} vs ${r.nzToggled})`);
      }
      console.log('');
    }

    // --- resize -------------------------------------------------------------
    if (want('resize')) {
      // This probe exists to move the board, so the size lock has to come off.
      // Run it last: everything above assumes --size.
      await page.evaluate(() => window.__unlockBoardSize());
      console.log('  [resize] board resize while tiled must re-derive the grid');
      const steps = [['1080p', 1080, 1920], ['4k', 2160, 3840], ['720p', 720, 1280], ['1440p', 1440, 2560]];
      const seen = [];
      for (const [label, h, w] of steps) {
        const r = await page.evaluate(async (h2, w2) => {
          const app = window.app;
          app.board.resizeBoard([h2, w2]);
          app._bindLayerManagerDependencies?.();
          await new Promise((res) => setTimeout(res, 250));
          const lm = app.board.layerManager;
          const g = lm.layerGroups[0];
          return {
            dims: app.board.dimensions,
            tiled: !!g.tiled,
            flag: !!lm.tiledBackingStore,
            pinned: lm.tiledTileSize,
            tileSize: g.tiled ? g.flatCanvas.tileSize : null,
            cols: g.tiled ? g.flatCanvas.cols : null,
            rows: g.tiled ? g.flatCanvas.rows : null,
            total: g.tiled ? g.flatCanvas.cols * g.flatCanvas.rows : null
          };
        }, h, w);
        seen.push([label, r]);
      }
      // Turn tiling on, then repeat the same walk with it live.
      await page.evaluate(() => window.app.board.layerManager.setTiledBackingStore(true));
      const live = [];
      for (const [label, h, w] of steps) {
        const r = await page.evaluate(async (h2, w2) => {
          const app = window.app;
          app.board.resizeBoard([h2, w2]);
          app._bindLayerManagerDependencies?.();
          await new Promise((res) => setTimeout(res, 250));
          const lm = app.board.layerManager;
          const g = lm.layerGroups[0];
          return {
            dims: app.board.dimensions, tiled: !!g.tiled, flag: !!lm.tiledBackingStore,
            pinned: lm.tiledTileSize,
            tileSize: g.tiled ? g.flatCanvas.tileSize : null,
            cols: g.tiled ? g.flatCanvas.cols : null, rows: g.tiled ? g.flatCanvas.rows : null,
            total: g.tiled ? g.flatCanvas.cols * g.flatCanvas.rows : null
          };
        }, h, w);
        live.push([label, r]);
        const expect = { '1080p': 120, '4k': 240, '720p': 80, '1440p': 160 }[label];
        if (!r.tiled) fails.push(`resize: tiling was lost across a resize to ${label}`);
        else if (r.tileSize !== expect) fails.push(`resize: ${label} kept tile ${r.tileSize}, expected ${expect}`);
        else if (r.total !== 144) fails.push(`resize: ${label} gave ${r.total} tiles, expected 144`);
      }
      console.log('    tiling OFF before each resize (control):');
      for (const [label, r] of seen) console.log(`      -> ${label.padEnd(6)} ${r.dims[1]}x${r.dims[0]}  tiled=${r.tiled}  flag=${r.flag}  tile=${r.tileSize}  grid=${r.cols}x${r.rows}`);
      console.log('    tiling ON, resized live:');
      for (const [label, r] of live) console.log(`      -> ${label.padEnd(6)} ${r.dims[1]}x${r.dims[0]}  tiled=${r.tiled}  flag=${r.flag}  pinned=${r.pinned}  tile=${r.tileSize}  grid=${r.cols}x${r.rows} = ${r.total}`);

      // A pinned size (sweep-harness only) must survive a re-toggle.
      const pin = await page.evaluate(() => {
        const lm = window.app.board.layerManager;
        lm.setTiledBackingStore(false);
        lm.setTiledBackingStore(true, 320);
        const a = lm.layerGroups[0].flatCanvas.tileSize;
        lm.setTiledBackingStore(false);
        lm.setTiledBackingStore(true);
        const b = lm.layerGroups[0].flatCanvas.tileSize;
        const pinned = lm.tiledTileSize;
        lm.setTiledBackingStore(false);
        return { pinnedApplied: a, afterRetoggle: b, pinned };
      });
      console.log(`    pinned 320 -> applied ${pin.pinnedApplied}, after off/on ${pin.afterRetoggle} (lm.tiledTileSize=${pin.pinned})`);
      if (pin.pinnedApplied !== 320) fails.push(`resize: explicit tileSize 320 was not applied (got ${pin.pinnedApplied})`);
      if (pin.afterRetoggle !== 320) fails.push(`resize: pinned tileSize did not survive a re-toggle (got ${pin.afterRetoggle})`);
      console.log('');
    }

    console.log(`  ${fails.length} failure(s)`);
    for (const f of fails) console.log(`    - ${f}`);
    if (fails.length) process.exitCode = 1;
  } finally {
    await browser.disconnect();
  }
})();
