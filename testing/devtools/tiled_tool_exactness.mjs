#!/usr/bin/env node
/**
 * @fileoverview Per-tool, per-hostile-geometry exactness oracle for the tiled
 * canvas backing store.
 *
 * `tiled_ab.mjs` phase 1 proves the *toggle* is byte-exact for one brush stroke
 * on one synthetic base. That leaves the interesting failure open: a tool whose
 * painted output lands outside the bounds it declares to
 * `TiledLayerCanvas.paintInto` / `paintImage`, so a freshly-allocated tile is
 * blank-checked over the wrong region and freed with the artwork inside it.
 * That failure is silent — no throw, no log, and the stroke simply is not there.
 *
 * So: for every (tool x geometry) pair, draw the SAME strokes onto the SAME
 * starting raster with tiling off and with tiling on, force the strokes through
 * the bake path (which is the only path that touches flatCanvas at all), and
 * demand byte-identical composited layer 0.
 *
 * Three digests per case, so a failure localises itself:
 *   A1, A2  untiled, twice   -> proves the tool is deterministic enough to judge.
 *                              A tool that fails this is reported NONDET, not BUG.
 *   B       tiled            -> A1 != B means tiling changed the pixels.
 *   C       tiled then toggled back to untiled
 *                            -> B == C but A1 != B localises to the composite;
 *                               B != C localises to toFullCanvas/fromFullCanvas.
 *
 * Geometry cases are chosen to sit exactly where the tile grid is: on a seam,
 * on a 4-tile corner, off the board edge, spanning the whole board, and with a
 * mirror fold that deposits pixels far from the source bounds.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9223 node testing/devtools/tiled_tool_exactness.mjs \
 *     --size=1440p --tools=brush,erase,line --cases=all
 */

import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const SIZE = arg('size', '1440p');
const TOOLS = arg('tools', 'brush,erase,line,rectangle,circle,pixel,ink,flowPen,confetti,pattern,imageBrush,blur,glitchBlur,text,fill,select').split(',').filter(Boolean);
const CASES = arg('cases', 'all');
const BRUSH_SIZE = Number(arg('brushsize', 0));   // 0 = leave the tool's own default
const BASE = arg('base', 'sparse');               // sparse | grid
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9223';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 120_000);

const BOARD_SIZES = {
  '720p': [720, 1280], '1080p': [1080, 1920], '1440p': [1440, 2560],
  big: [1800, 3200], '4k': [2160, 3840], '8k': [4320, 7680], '12k': [6480, 11520],
  // Non-16:9 boards, where tileSizeForBoard falls back to a fixed 256 and the
  // grid is RAGGED — the last column and row are short (_tileRectAt clamps
  // them). Every exactness run so far has used a preset, i.e. a perfectly
  // uniform 16x9 grid with no partial tiles anywhere, so the clamped-edge-tile
  // path has only ever been checked by the tile-size *rule* and never by a
  // stroke. These four are the least-tested geometry in the feature.
  sq2048: [2048, 2048],       // 8x8 = 64, exact
  '4x3': [1200, 1600],        // 7x5 = 35, ragged both axes
  odd: [1080, 1921],          // 8x5 = 40, ragged (odd width)
  '16x10': [1200, 1920]       // 8x5 = 40, ragged
};
const dims = BOARD_SIZES[SIZE];
if (!dims) throw new Error(`unknown --size=${SIZE}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP = `(() => {
  const app = window.app;

  window.__lockBoardSize = function (h, w) {
    const board = app.board;
    board.resizeBoard([h, w]);
    app._bindLayerManagerDependencies?.();
    const orig = board.resizeBoard.bind(board);
    board.resizeBoard = (d) => { if (!d || d[0] !== h || d[1] !== w) return; return orig(d); };
  };

  const evFor = () => {
    const [bh, bw] = app.board.dimensions;
    const el = document.getElementById('boards');
    const rect = el.getBoundingClientRect();
    const sx = rect.width / bw, sy = rect.height / bh;
    const down = document.getElementById('board');
    return (type, x, y) => {
      const e = new PointerEvent(type, {
        pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true,
        cancelable: true, composed: true,
        clientX: rect.left + x * sx, clientY: rect.top + y * sy,
        buttons: type === 'pointerup' ? 0 : 1, button: 0,
        pressure: type === 'pointerup' ? 0 : 0.5
      });
      (type === 'pointerdown' ? down : window).dispatchEvent(e);
    };
  };

  const raf = () => new Promise(r => requestAnimationFrame(r));

  // Every path is a fixed list of board-space points — no Math.random anywhere
  // in the harness, so any nondeterminism the A1/A2 check catches is the tool's.
  window.__casePaths = function (name) {
    const [bh, bw] = app.board.dimensions;
    const lm = app.board.layerManager;
    const g = lm.layerGroups[0];
    // The live grid's tile size when tiled; the size it WOULD use when not.
    const ts = g?.tiled ? g.flatCanvas.tileSize : (window.__tileSizeHint || 160);
    const ring = (cx, cy, r, n) => {
      const pts = [];
      // i < n, NOT i <= n. A closed ring's last point equals its first, which
      // gives the shape tools (line/rectangle/circle) a zero-extent drag: they
      // only read the drag's start and end, so they drew nothing at all and
      // rectangle/center, rectangle/corner and rectangle/mirror passed while
      // testing nothing. The closing segment was worthless to the stroke tools
      // too, so the point is simply dropped.
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      return pts;
    };
    switch (name) {
      // Entirely inside one tile: the control case.
      case 'center':  return [ring(ts * 2 + ts / 2, ts * 2 + ts / 2, ts * 0.25, 20)];
      // Straddles a vertical tile seam, then a horizontal one.
      case 'seam':    return [
        [[ts * 4 - 40, ts * 3 + 30], [ts * 4 + 40, ts * 3 + 30]],
        [[ts * 5 + 30, ts * 4 - 40], [ts * 5 + 30, ts * 4 + 40]]
      ];
      // Dead on the 4-tile corner.
      case 'corner':  return [ring(ts * 6, ts * 4, 18, 16)];
      // Runs off the top-left board edge (negative board coords) and off the
      // bottom-right one, so bounds clamping is exercised in both directions.
      case 'edge':    return [
        [[-60, 20], [60, 20]],
        [[20, -60], [20, 60]],
        [[bw - 60, bh - 20], [bw + 60, bh - 20]]
      ];
      // One long diagonal across the whole grid: touches ~cols+rows tiles.
      case 'diag':    return [[[30, 30], [bw - 30, bh - 30]]];
      // A tight zig-zag: many short segments, each with a join. Miter/round
      // joins on a wide line extend furthest past the segment bounds.
      case 'zigzag':  {
        const pts = [];
        for (let i = 0; i <= 40; i++) pts.push([ts * 3 + i * 12, ts * 6 + (i % 2 ? 40 : -40)]);
        return [pts];
      }
      // Same as center, but mirrored: the fold deposits a second copy on the
      // far side of the board, a long way outside the source stroke's bounds.
      case 'mirror':  return [ring(ts * 2 + ts / 2, ts * 5 + ts / 2, ts * 0.25, 20)];
      // Inside the mirror REGION defined in __runCase (ts*4..ts*6, ts*2..ts*4),
      // straddling its vertical fold axis at ts*5 so the reflected copy lands on
      // the other side of a tile seam.
      case 'mirrorregion': return [ring(ts * 5 - 30, ts * 3, 26, 16)];
      default: throw new Error('unknown case ' + name);
    }
  };

  window.__drawPaths = async function (paths) {
    const ev = evFor();
    for (const pts of paths) {
      ev('pointermove', pts[0][0], pts[0][1]);
      ev('pointerdown', pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        ev('pointermove', pts[i][0], pts[i][1]);
        await raf();
      }
      ev('pointerup', pts[pts.length - 1][0], pts[pts.length - 1][1]);
      await raf(); await raf();
    }
  };

  // The point each case is "about", clamped inside the board. Reuses the case's
  // own geometry so seam/corner/edge still mean the same thing for the tools
  // below, which place one mark rather than dragging a path.
  window.__caseFocus = function (caseName) {
    const [bh, bw] = app.board.dimensions;
    const m = 140;
    return window.__casePaths(caseName).map((p) => ({
      x: Math.min(bw - m, Math.max(m, p[0][0])),
      y: Math.min(bh - m, Math.max(m, p[0][1]))
    }));
  };

  // FloodFillTool rejects any fill covering more than 40% of the canvas
  // (_isFillTooLarge, FloodFillTool.js:422). On the sparse base the whole board
  // is ONE connected transparent region, so every click was rejected and the
  // tool committed nothing — the real cause of its VACUOUS(0 strokes) verdict.
  //
  // So give it something bounded to fill: an opaque square centred on the case's
  // focus point, painted as part of the base so all three arms share it. The
  // square is ~1.2 tiles, so it straddles the seam / corner / edge the case is
  // named for, and at 1440p it is 36,864 px against a 1,474,560 px limit.
  window.__driveFill = async function (caseName) {
    const lm = app.board.layerManager;
    const g = lm.layerGroups[0];
    const ts = g?.tiled ? g.flatCanvas.tileSize : (window.__tileSizeHint || 160);
    const side = Math.round(ts * 1.2);
    const foci = window.__caseFocus(caseName);

    window.__fillRegions = foci.map((f) => ({
      x: Math.round(f.x - side / 2), y: Math.round(f.y - side / 2),
      w: side, h: side, color: '#0b3d91'
    }));
    window.__paintBase();
    lm.needsComposite = true;
    // The fill reads board.viewCtx, i.e. the COMPOSITED canvas, not the layer —
    // without forcing a composite first it flood-fills whatever was on screen
    // before the base was painted.
    app.board.compositeAllLayers();

    // Far from the region colour, or the target-vs-fill similarity test at
    // FloodFillTool.js:520 returns before committing anything. Restored after,
    // for the same persistence reason as the size in __driveText.
    const prevColor = app.self.color;
    app.self.color = [255, 214, 0, 255];
    window.__restoreAfterFill = () => { app.self.color = prevColor; };

    const ev = evFor();
    for (const f of foci) {
      ev('pointermove', f.x, f.y);
      ev('pointerdown', f.x, f.y);
      // onPointerDown is async and awaits the fill worker; pointerup arriving
      // first makes onPointerUp end a stroke that was never begun.
      await new Promise(r => setTimeout(r, 500));
      ev('pointerup', f.x, f.y);
      await raf(); await raf();
      await new Promise(r => setTimeout(r, 200));
    }
  };

  // Text never reaches a stroke at all on the default (vector) path — it goes to
  // the ephemeral SVG overlay and is never baked into layer 0, so it cannot
  // touch the tiled backing store. Only textRenderMode 'pixel' takes the legacy
  // raster path (App._broadcastExplicitTextApply -> beginStroke / drawText /
  // endStroke), and that is the path worth testing here. Driving keystrokes
  // would only have filled user.text; the commit is a separate explicit call.
  window.__driveText = async function (caseName) {
    const foci = window.__caseFocus(caseName);
    const prevSize = app.self.size;
    const prevMode = app.self.textRenderMode;
    app.self.textRenderMode = 'pixel';
    app.self.size = 120;          // large enough that one glyph run spans a seam
    try {
      for (const f of foci) {
        app.self.text = 'TILED';
        app._broadcastExplicitTextApply({ x: f.x, y: f.y });
        await raf();
      }
      app.self.text = '';
      await raf(); await raf();
    } finally {
      // app.self.size is persisted through appPreferences, so leaving 120 behind
      // does not just leak into the next tool in this run — it survives the page
      // reload and changes the FIRST tool of the NEXT run. Measured: imageBrush
      // reported nz 37176 on a run where text had not yet run, and 90883 on the
      // next one, purely from the inherited stamp size.
      app.self.size = prevSize;
      app.self.textRenderMode = prevMode;
    }
  };

  // SelectTool's lift and commit both go through lm.beginUserStroke /
  // lm.commitUserStroke (SelectTool.js:2707/2746 for the lift's destination-out
  // erase, :2862/:2968 for the commit's source-over write-back), so they land on
  // the stroke stack like any other stroke and the capture-and-replay model
  // above applies unchanged — no separate harness needed.
  //
  // The gesture: rect-select a solid block, drag it by a deliberately
  // non-tile-multiple offset so the pixels are LIFTED from one set of tiles and
  // COMMITTED across a different set, then commit by switching tool (which is
  // how most users end a selection, via SelectTool.deactivate()).
  window.__driveSelect = async function (caseName) {
    const lm = app.board.layerManager;
    const g = lm.layerGroups[0];
    const ts = g?.tiled ? g.flatCanvas.tileSize : (window.__tileSizeHint || 160);
    const side = Math.round(ts * 1.2);
    const foci = window.__caseFocus(caseName);

    // A solid block is what makes the lift observable: lifting from the sparse
    // base would erase mostly-transparent pixels and change almost nothing.
    window.__fillRegions = foci.map((f) => ({
      x: Math.round(f.x - side / 2), y: Math.round(f.y - side / 2),
      w: side, h: side, color: '#c81e5a'
    }));
    window.__paintBase();
    lm.needsComposite = true;
    app.board.compositeAllLayers();

    const loader = app.toolManager.getTool('select');
    const rt = loader.realTool || await loader.loadRealTool();
    rt.cancelSelection?.();
    rt.setMode('rect');
    await new Promise(r => setTimeout(r, 120));

    const ev = evFor();
    const tick = () => app.inputBufferManager?.tick?.();
    const nap = (ms) => new Promise(r => setTimeout(r, ms));
    // Drive through the buffered path with a tick and a settle per sample. Going
    // faster merges or drops samples and makes the committed board
    // nondeterministic — the A1/A2 column is what proves this settled.
    const drag = async (pts) => {
      ev('pointermove', pts[0][0], pts[0][1]);
      ev('pointerdown', pts[0][0], pts[0][1]); tick(); await nap(24);
      for (let i = 1; i < pts.length; i++) {
        ev('pointermove', pts[i][0], pts[i][1]); tick(); await nap(24);
      }
      const l = pts[pts.length - 1];
      ev('pointerup', l[0], l[1]); tick(); await nap(60);
    };

    const f = foci[0];
    const half = side / 2;
    const inset = 6;
    // 1. rect-select just inside the block
    await drag([
      [f.x - half + inset, f.y - half + inset],
      [f.x, f.y],
      [f.x + half - inset, f.y + half - inset]
    ]);
    await nap(220);
    // 2. drag the interior to lift + move. 0.7 / -0.4 of a tile: not a whole
    //    number of tiles in either axis, so source and destination tiles differ.
    const dx = Math.round(ts * 0.7), dy = -Math.round(ts * 0.4);
    await drag([
      [f.x, f.y],
      [f.x + dx * 0.5, f.y + dy * 0.5],
      [f.x + dx, f.y + dy]
    ]);
    await nap(260);
    // 3. commit the floating selection the way a tool button would
    app.selectTool('brush');
    tick();
    await nap(320);
  };

  // Deterministic starting raster, always painted while UNTILED so both arms
  // begin from byte-identical pixels and the toggle is the only difference.
  // Deliberately sparse and NOT aligned to any tile grid, so most tiles start
  // unallocated (the regime where a wrong blank-check destroys artwork) and the
  // ones that exist are only partly covered.
  //
  // Two bases, because they exercise opposite halves of the risk:
  //   sparse - almost nothing where the strokes land, so the stroke ALLOCATES
  //            a fresh tile and the pruneNew blank-check decides whether the
  //            artwork survives. This is the data-loss case.
  //   grid   - content everywhere on a 61px pitch (deliberately coprime with
  //            every tile size in play, so nothing lines up with a seam), so
  //            erases have something to remove and pruneCovered/dropCovered
  //            get to fire on a tile that really was occupied.
  window.__baseMode = 'sparse';
  // Enclosing regions the fill tool needs (see __driveFill). Painted as part of
  // the base so every arm's __resetFlat reproduces them identically; empty for
  // every other tool.
  window.__fillRegions = [];
  window.__paintBase = function () {
    const lm = app.board.layerManager;
    const [h, w] = app.board.dimensions;
    const mode = window.__baseMode;
    lm.withFlatCanvasContext(0, (ctx) => {
      for (const r of window.__fillRegions) {
        ctx.fillStyle = r.color;
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
      if (mode === 'grid') {
        let i = 0;
        for (let y = 7; y < h; y += 61) {
          for (let x = 13; x < w; x += 61, i++) {
            ctx.fillStyle = 'hsl(' + ((i * 53) % 360) + ' 80% 55%)';
            ctx.fillRect(x, y, 43, 39);
          }
        }
        return;
      }
      for (let i = 0; i < 48; i++) {
        ctx.fillStyle = 'hsl(' + ((i * 53) % 360) + ' 80% 55%)';
        ctx.fillRect(137 + (i % 8) * 213, 91 + Math.floor(i / 8) * 197, 29, 23);
      }
    });
  };

  // Detach layer 0's committed strokes from the stack without baking or
  // disposing them, so the SAME stroke objects can be replayed into both arms.
  // Driving each arm by re-dispatching pointer events instead would compare two
  // different strokes: input is buffered per tick, so identical event sequences
  // produce slightly different geometry depending on where rAF lands relative
  // to the tick (measured — brush failed a same-arm A1/A2 determinism check
  // that way). Replaying one captured stroke removes that entirely, and it is
  // also the more faithful test: what tiling changes is the BAKE of a stroke
  // record, given its canvas and its declared x/y.
  window.__detachStrokes = function () {
    const g = app.board.layerManager.layerGroups[0];
    if (!g) return [];
    const stack = g.strokeStack.slice();
    g.strokeStack.length = 0;
    g.userStrokeCounts = new Map();
    return stack;
  };

  window.__bakeStrokes = function (stack) {
    const lm = app.board.layerManager;
    const g = lm.layerGroups[0];
    for (const s of stack) lm._bakeStrokeToBin(g, s);
    lm.needsComposite = true;
    return stack.length;
  };

  // Return layer 0's baked raster to the identical starting state, always via
  // the untiled path so the base itself can never be shaped by blank-tile
  // skipping.
  window.__resetFlat = function () {
    const lm = app.board.layerManager;
    const [h, w] = app.board.dimensions;
    lm.setTiledBackingStore(false);
    const g = lm.layerGroups[0];
    g.bakedSequences = [];
    g.flatStrokeRecords = [];
    lm.clearLayerFlatRect(0, 0, 0, w, h);
    window.__paintBase();
    lm.needsComposite = true;
  };

  window.__layerDigest = function (bandPx) {
    const lm = app.board.layerManager;
    const [h, w] = app.board.dimensions;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    lm.compositeLayerRange(ctx, 0, 1, null);
    const band = bandPx || Math.max(1, Math.floor(4 * 1024 * 1024 / (w * 4)));
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
    c.width = 0; c.height = 0;
    return { bands, nz };
  };

  window.__digestEq = function (a, b) {
    if (!a || !b || a.bands.length !== b.bands.length) return false;
    for (let i = 0; i < a.bands.length; i++) if (a.bands[i] !== b.bands[i]) return false;
    return true;
  };

  window.__tileInfo = function () {
    const g = app.board.layerManager.layerGroups[0];
    if (!g?.tiled) return { tiled: false, tiles: 0, total: 0, bytes: 0 };
    const fc = g.flatCanvas;
    return { tiled: true, tiles: fc.allocatedTileCount, total: fc.cols * fc.rows, bytes: fc.allocatedBytes, tileSize: fc.tileSize };
  };

  // imageBrush only ever gets a brush from a file picker or the brush gallery,
  // so app.selectTool('imageBrush') alone leaves app.self.imageBrush null and the
  // wait loop below just burns its 15s — which is exactly how imageBrush came
  // back VACUOUS(0 strokes). Synthesize the same shape loadBrush() builds for a
  // .png, through a real Image + data URL so the drawStamp path is the
  // production one.
  //
  // The stamp is deliberately asymmetric: a soft radial falloff (so the alpha
  // edge is gradual and a wrong blank-check has something to destroy) plus an
  // off-centre opaque notch (so a stamp placed at the wrong origin or rotation
  // shows up as a moved notch rather than a rounder blob).
  window.__loadSyntheticBrush = function () {
    const c = document.createElement('canvas');
    c.width = 48; c.height = 48;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(24, 24, 2, 24, 24, 23);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 48, 48);
    x.fillStyle = 'rgba(255,255,255,0.9)';
    x.fillRect(30, 4, 14, 8);
    const url = c.toDataURL('image/png');
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        app.self.imageBrush = {
          type: 'image', fileName: 'synthetic.png', imageFormat: 'png',
          brushName: 'synthetic', gimpUrl: url, previewUrl: url,
          width: img.width, height: img.height, image: img
        };
        res(true);
      };
      img.onerror = () => rej(new Error('synthetic brush failed to load'));
      img.src = url;
    });
  };

  window.__selectTool = async function (name) {
    app.selectTool(name);
    if (name === 'imageBrush' && !app.self.imageBrush) await window.__loadSyntheticBrush();
    // SelectToolLoader imports the real SelectTool lazily; without waiting the
    // driver would read a null realTool.
    if (name === 'select') {
      const loader = app.toolManager.getTool('select');
      if (!loader.realTool) await loader.loadRealTool();
    }
    const needsImage = name === 'pattern' || name === 'imageBrush';
    if (needsImage) {
      const t0 = performance.now();
      while (performance.now() - t0 < 15000) {
        const tool = app.toolManager.getTool(name);
        const ok = name === 'pattern'
          ? !!tool._getPatternTile?.(app.self)?.width
          : !!(app.self.imageBrush?.image?.width || app.self.imageBrush?.gBrushes?.length);
        if (ok) break;
        await new Promise(r => setTimeout(r, 100));
      }
    }
    return app.self?.tool;
  };

  window.__armDigest = function (stack, tiled) {
    const lm = app.board.layerManager;
    window.__resetFlat();
    if (tiled) lm.setTiledBackingStore(true);
    window.__bakeStrokes(stack);
    const info = window.__tileInfo();
    const digest = window.__layerDigest();
    let after = null;
    if (tiled) {
      lm.setTiledBackingStore(false);
      after = window.__layerDigest();
    }
    return { digest, after, info };
  };

  // Draw one case with one tool, then judge it by replaying the captured
  // strokes into three arms.
  window.__runCase = async function (opts) {
    const { tool, caseName, brushSize } = opts;
    const board = app.board;
    const lm = board.layerManager;

    lm.setTiledBackingStore(false);
    board.setMirror(caseName === 'mirror');
    // Mirror *regions* are a different code path from the global mirror flag:
    // bounded areas with their own clip (Board.withMirrorRegionClip), which the
    // 'mirror' case above does not touch at all. A region placed across a tile
    // seam folds a copy of the stroke to the far side of that seam, which is
    // exactly the "content lands outside the stroke's declared bounds" shape the
    // pruneNew blank-check has to survive.
    if (caseName === 'mirrorregion') {
      const g0 = lm.layerGroups[0];
      const ts = g0?.tiled ? g0.flatCanvas.tileSize : (window.__tileSizeHint || 160);
      board.setMirrorRegions([{
        id: 'mr_test_seam', x: ts * 4, y: ts * 2, width: ts * 2, height: ts * 2,
        mode: 'vertical', axis: 'vertical', slices: 6, fibDepth: 4,
        showLine: false, owner: app.self?.id ?? 0
      }]);
    } else {
      board.setMirrorRegions([]);
    }
    board.clear();
    window.__fillRegions = [];
    if (brushSize) app.self.size = brushSize;
    await window.__selectTool(tool);
    window.__paintBase();
    // Three tools do not commit anything from a dragged pointer path and need
    // their own driver; see __driveFill / __driveText for why.
    window.__restoreAfterFill = null;
    if (tool === 'fill') await window.__driveFill(caseName);
    else if (tool === 'text') await window.__driveText(caseName);
    else if (tool === 'select') await window.__driveSelect(caseName);
    else await window.__drawPaths(window.__casePaths(caseName));
    window.__restoreAfterFill?.();
    // Blur/glitchBlur resolve through a worker; give them a settle window.
    await new Promise(r => setTimeout(r, 400));
    const stack = window.__detachStrokes();

    // The base raster with NO strokes baked. Every arm below starts from this,
    // so if a tool's strokes are no-ops all three arms agree trivially and the
    // case passes without testing anything.
    //
    // The nz counters cannot catch that on their own: a fill recolours pixels
    // that were already opaque, so a working fill and a fill that painted
    // nothing report the identical non-transparent count. Compare the digest
    // instead — it is a hash of the actual bytes.
    window.__resetFlat();
    const baseDigest = window.__layerDigest();

    // Warm-up bake, discarded. _bakeBlurStroke resolves a blur the first time
    // and caches the result on the stroke (_cachedBlurResult), so the first
    // bake of a blur stroke is not the same operation as the second. Warming
    // before measuring makes every arm below take the identical branch.
    window.__bakeStrokes(stack);

    const a1 = window.__armDigest(stack, false);
    const a2 = window.__armDigest(stack, false);
    const b = window.__armDigest(stack, true);
    board.setMirror(false);
    window.__resetFlat();

    return {
      strokes: stack.length,
      changed: !window.__digestEq(baseDigest, a1.digest),
      det: window.__digestEq(a1.digest, a2.digest),
      match: window.__digestEq(a1.digest, b.digest),
      roundtrip: window.__digestEq(b.digest, b.after),
      nzFull: a1.digest.nz, nzTiled: b.digest.nz,
      nzBack: b.after ? b.after.nz : -1,
      tiles: b.info.tiles, total: b.info.total
    };
  };

  return true;
})()`;

const ALL_CASES = ['center', 'seam', 'corner', 'edge', 'diag', 'zigzag', 'mirror', 'mirrorregion'];
const caseList = CASES === 'all' ? ALL_CASES : CASES.split(',').filter(Boolean);

(async () => {
  const browser = await puppeteer.connect({
    browserURL: CDP_URL, defaultViewport: null, protocolTimeout: 300_000
  });
  const page = (await browser.pages())[0] || (await browser.newPage());
  try {
    for (const other of await browser.pages()) {
      if (other !== page) { try { await other.close(); } catch { /* already gone */ } }
    }
    await page.bringToFront();
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    const vis = await page.evaluate(() => document.visibilityState);
    if (vis !== 'visible') throw new Error(`page is ${vis} — rAF will not fire and the app will never boot`);
    await page.waitForFunction(() => window.app && window.app.self != null, { timeout: READY_TIMEOUT });
    await page.evaluate(SETUP);

    const room = `tex_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'TEX'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: READY_TIMEOUT });
    await page.evaluate((h, w) => window.__lockBoardSize(h, w), dims[0], dims[1]);
    await sleep(1500);
    const actual = await page.evaluate(() => window.app.board.dimensions);
    if (actual[0] !== dims[0] || actual[1] !== dims[1]) {
      throw new Error(`board size did not take: wanted ${dims}, got ${actual}`);
    }
    const ts = await page.evaluate(() => {
      const lm = window.app.board.layerManager;
      lm.setTiledBackingStore(true);
      const s = lm.layerGroups[0].flatCanvas.tileSize;
      lm.setTiledBackingStore(false);
      window.__tileSizeHint = s;
      return s;
    });
    await page.evaluate((b) => { window.__baseMode = b; }, BASE);

    console.log(`\n=== tiled tool exactness   ${SIZE} ${actual[1]}x${actual[0]}   tile ${ts}px   base=${BASE}   cases: ${caseList.join(',')}\n`);
    console.log('  tool          case      baked  tiles      nz(untiled)   nz(tiled)  changed  det  tiled==full  roundtrip   verdict');

    const failures = [];
    for (const tool of TOOLS) {
      const got = await page.evaluate((t) => window.__selectTool(t), tool);
      if (got !== tool) {
        console.log(`  ${tool.padEnd(12)}  -- SKIPPED, selectTool gave "${got}"`);
        continue;
      }
      for (const caseName of caseList) {
        let r;
        try {
          r = await page.evaluate((o) => window.__runCase(o),
            { tool, caseName, brushSize: BRUSH_SIZE || 0 });
        } catch (e) {
          console.log(`  ${tool.padEnd(12)}  ${caseName.padEnd(8)}  ERROR ${String(e.message).slice(0, 90)}`);
          failures.push(`${tool}/${caseName}: harness error ${e.message}`);
          continue;
        }

        let verdict;
        // A tool that committed nothing proves nothing about the bake path —
        // and "ok" on an untouched board is indistinguishable from a pass, so
        // say so explicitly.
        //
        // "no change" is the one that nearly got through: a fill recolours
        // pixels that were already opaque, so nz is identical whether it painted
        // or not, and all three arms would agree on the untouched base. Only the
        // digest can tell those apart.
        if (r.strokes === 0) verdict = 'VACUOUS(0 strokes)';
        else if (r.nzFull === 0 && r.nzTiled === 0) verdict = 'VACUOUS(no px)';
        else if (!r.changed) verdict = 'VACUOUS(no change vs base)';
        else if (!r.det) verdict = 'NONDET';
        else if (!r.match) verdict = 'FAIL tiled!=full';
        else if (!r.roundtrip) verdict = 'FAIL roundtrip';
        else verdict = 'ok';
        if (verdict.startsWith('FAIL')) failures.push(`${tool}/${caseName}: ${verdict} nz ${r.nzFull} vs ${r.nzTiled} (back ${r.nzBack})`);
        // A vacuous case is not a pass — it is the silent-green failure mode
        // this whole harness exists to avoid, so it fails the run too.
        if (verdict.startsWith('VACUOUS')) failures.push(`${tool}/${caseName}: ${verdict} — tested nothing`);

        console.log(`  ${tool.padEnd(12)}  ${caseName.padEnd(8)}`
          + `${String(r.strokes).padStart(6)}`
          + `${String(r.tiles + '/' + r.total).padStart(8)}`
          + `${String(r.nzFull).padStart(15)}${String(r.nzTiled).padStart(12)}`
          + `${(r.changed ? '    y' : '    N').padStart(7)}`
          + `${(r.det ? '   y' : '   N').padStart(6)}`
          + `${(r.match ? 'y' : 'N').padStart(13)}`
          + `${(r.roundtrip ? 'y' : 'N').padStart(11)}   ${verdict}`);
      }
    }

    console.log(`\n  ${failures.length} failure(s)`);
    for (const f of failures) console.log(`    - ${f}`);
    if (failures.length) process.exitCode = 1;
  } finally {
    await browser.disconnect();
  }
})();
