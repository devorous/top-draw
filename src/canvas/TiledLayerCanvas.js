/**
 * @fileoverview TiledLayerCanvas - grid-of-canvases backing store for a
 * LayerManager layer group's baked raster, used in place of a single
 * full-board `flatCanvas` when a room opts into tiled backing storage.
 *
 * Tiles are lazily allocated on first paint; an empty board keeps almost
 * none allocated, which is the entire point (see canvas_backing_store_budget
 * in project memory for the full-board cost this avoids). This tile size is
 * deliberately much coarser than CompositeTileGrid's 32px dirty-rect grid —
 * that grid tracks *which regions changed*, this one tracks *which regions
 * of pixel storage exist at all*. Conflating the two would allocate one tiny
 * canvas per 32px cell, which is far more per-tile overhead than the memory
 * it would save.
 */
// ImageData is byte-ordered RGBA, so which byte of a uint32 word holds alpha
// depends on the platform's endianness. Every browser we ship to is
// little-endian, but the check is one-time and free.
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const ALPHA_MASK = LITTLE_ENDIAN ? 0xFF000000 : 0x000000FF;

/**
 * True when every pixel of `(x,y,width,height)` in `ctx` is fully transparent.
 * The rect is clamped to the context's canvas first, so a rect that falls
 * entirely outside reads as blank (which is what callers want — there is no
 * content out there to preserve).
 *
 * Reads back a uint32 at a time and tests only the alpha byte: a canvas pixel
 * can carry non-zero RGB with zero alpha, and that pixel is still nothing.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @returns {boolean}
 */
function regionIsBlank(ctx, x, y, width, height) {
  const canvas = ctx.canvas;
  const sx = Math.max(0, Math.floor(x));
  const sy = Math.max(0, Math.floor(y));
  const sw = Math.min(canvas.width, Math.ceil(x + width)) - sx;
  const sh = Math.min(canvas.height, Math.ceil(y + height)) - sy;
  if (sw <= 0 || sh <= 0) return true;

  const { data } = ctx.getImageData(sx, sy, sw, sh);
  const words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
  for (let i = 0; i < words.length; i++) {
    if (words[i] & ALPHA_MASK) return false;
  }
  return true;
}

export class TiledLayerCanvas {
  /**
   * Measured, not assumed. Swept 256/512/1024 at 1440p against memory and
   * composite-submission cost (testing/devtools/tile_size_sweep.mjs):
   *
   *   sparse board          256px  3.00MB  13us    512px  8.63MB  11us
   *   dense board (worst)   256px 14.06MB  40us    512px 14.06MB  13us
   *
   * 256 is ~3x better on memory where it matters (78.7% saved vs 38.6%) and
   * the cost it pays is microseconds — under 0.5ms of extra main-thread time
   * per second at 60fps. Cost tracks allocated tile count at roughly 0.6us per
   * extra drawImage, so the dense-board worst case is 40us: still small, but
   * it buys nothing there, since a full board saves no memory at any
   * granularity.
   */
  static DEFAULT_TILE_SIZE = 256;

  /**
   * @param {number} width - Full board width
   * @param {number} height - Full board height
   * @param {number} [tileSize]
   */
  constructor(width, height, tileSize = TiledLayerCanvas.DEFAULT_TILE_SIZE) {
    this.width = width;
    this.height = height;
    this.tileSize = tileSize;
    this.cols = Math.ceil(width / tileSize);
    this.rows = Math.ceil(height / tileSize);
    /** @type {Array<{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D}|null>} */
    this.tiles = new Array(this.cols * this.rows).fill(null);
    // Blank-detection needs getImageData, which throws SecurityError on a
    // canvas tainted by a cross-origin draw. The board is already required to
    // be readable elsewhere (QOI snapshot capture, blur bake, parity hashing),
    // so this should never trip — but if it does, latch it off and keep every
    // tile rather than throwing from a bake.
    this._readbackBlocked = false;
  }

  /**
   * @returns {number} Tiles currently holding a backing store.
   */
  get allocatedTileCount() {
    let n = 0;
    for (const tile of this.tiles) if (tile) n++;
    return n;
  }

  /**
   * @returns {number} Real backing-store bytes, not the nominal full-board size.
   */
  get allocatedBytes() {
    let bytes = 0;
    for (const tile of this.tiles) {
      if (!tile) continue;
      bytes += tile.canvas.width * tile.canvas.height * 4;
    }
    return bytes;
  }

  /**
   * Blank-check a tile-local rect, treating a blocked readback as "has
   * content" so we never drop pixels we could not inspect.
   * @private
   */
  _regionIsBlank(tile, x, y, width, height) {
    if (this._readbackBlocked) return false;
    try {
      return regionIsBlank(tile.ctx, x, y, width, height);
    } catch (e) {
      this._readbackBlocked = true;
      console.warn('[TiledLayerCanvas] blank detection disabled — canvas readback failed:', e);
      return false;
    }
  }

  /**
   * Free the tile at (col,row), if one is allocated. The grid cell goes back
   * to meaning "transparent", which is exactly what a blank tile meant.
   * @returns {boolean} Whether a tile was actually released.
   */
  releaseTile(col, row) {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return false;
    const idx = row * this.cols + col;
    const tile = this.tiles[idx];
    if (!tile) return false;
    tile.canvas.width = 0;
    tile.canvas.height = 0;
    this.tiles[idx] = null;
    return true;
  }

  /**
   * Sweep every allocated tile and free the ones that are fully transparent.
   * O(allocated tiles) readbacks, so this is a maintenance operation — call it
   * after something that removes a lot of content, not per stroke.
   * @returns {number} Tiles released.
   */
  compact() {
    let released = 0;
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const tile = this.getTile(col, row, false);
        if (!tile) continue;
        if (this._regionIsBlank(tile, 0, 0, tile.canvas.width, tile.canvas.height)) {
          if (this.releaseTile(col, row)) released++;
        }
      }
    }
    return released;
  }

  _tileRectAt(col, row) {
    const x = col * this.tileSize;
    const y = row * this.tileSize;
    return {
      x,
      y,
      width: Math.min(this.tileSize, this.width - x),
      height: Math.min(this.tileSize, this.height - y)
    };
  }

  _colRange(x, width) {
    const startCol = Math.max(0, Math.floor(x / this.tileSize));
    const endCol = Math.min(this.cols - 1, Math.floor((x + width - 1) / this.tileSize));
    return [startCol, endCol];
  }

  _rowRange(y, height) {
    const startRow = Math.max(0, Math.floor(y / this.tileSize));
    const endRow = Math.min(this.rows - 1, Math.floor((y + height - 1) / this.tileSize));
    return [startRow, endRow];
  }

  /**
   * Get the tile at (col,row), allocating it (and applying the standard
   * stroke-canvas context defaults) on first access. Returns null for an
   * out-of-grid col/row rather than throwing, since bounds math elsewhere
   * clamps to width/height, not to tile-grid dimensions.
   * @param {number} col
   * @param {number} row
   * @param {boolean} [create=true] - Pass false to peek without allocating.
   */
  getTile(col, row, create = true) {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return null;
    const idx = row * this.cols + col;
    let tile = this.tiles[idx];
    if (!tile && create) {
      const rect = this._tileRectAt(col, row);
      const canvas = document.createElement('canvas');
      canvas.width = rect.width;
      canvas.height = rect.height;
      const ctx = canvas.getContext('2d');
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.imageSmoothingQuality = 'high';
      tile = { canvas, ctx, x: rect.x, y: rect.y };
      this.tiles[idx] = tile;
    }
    return tile;
  }

  /**
   * Iterate every tile intersecting `bounds` (board-space {x,y,width,height})
   * and call `drawFn(tileCtx, offsetX, offsetY, tile)`, where offsetX/offsetY
   * translate board-space coordinates into that tile's local space (i.e. draw
   * at `boardX + offsetX`). Tiles fully outside [0,width)x[0,height) are
   * skipped.
   *
   * `drawFn` MUST NOT paint outside `bounds` — the blank-detection options
   * below only inspect the region `bounds` covers, and would otherwise free a
   * tile whose content lives outside it.
   *
   * @param {{x:number,y:number,width:number,height:number}} bounds
   * @param {(ctx: CanvasRenderingContext2D, offsetX: number, offsetY: number, tile: object) => void} drawFn
   * @param {object} [options]
   * @param {boolean} [options.create=true] - Allocate tiles that don't exist
   *   yet. Pass false for operations that can only *remove* alpha
   *   (destination-out, clearRect): an absent tile is already transparent, so
   *   there is nothing to erase and allocating one would be pure waste.
   * @param {boolean} [options.pruneNew=create] - After drawing, free any tile
   *   this call allocated if it came out fully transparent. This is what keeps
   *   a mostly-empty board cheap: the tile was blank before the call, so
   *   checking the (padded) `bounds` region is enough to prove the whole tile
   *   is still blank.
   * @param {boolean} [options.pruneCovered=false] - Also free *pre-existing*
   *   tiles that `bounds` fully covers, if they came out blank. Costs a
   *   full-tile readback per covered tile, so only worth passing for
   *   alpha-removing operations that could plausibly have emptied one.
   * @param {boolean} [options.dropCovered=false] - Free pre-existing tiles
   *   that `bounds` fully covers outright, without calling `drawFn` or reading
   *   anything back. Only valid when `drawFn`'s effect on a fully-covered tile
   *   is unconditionally "make it blank" (i.e. a pure clearRect over `bounds`).
   */
  paintInto(bounds, drawFn, options = {}) {
    const {
      create = true,
      pruneNew = create,
      pruneCovered = false,
      dropCovered = false,
      _skipTile = null
    } = options;

    const x = Math.max(0, bounds.x);
    const y = Math.max(0, bounds.y);
    const width = Math.min(this.width, bounds.x + bounds.width) - x;
    const height = Math.min(this.height, bounds.y + bounds.height) - y;
    if (width <= 0 || height <= 0) return;

    const [startCol, endCol] = this._colRange(x, width);
    const [startRow, endRow] = this._rowRange(y, height);
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const existing = this.getTile(col, row, false);

        // Nothing here and the caller can't add anything: skip without
        // allocating. This is the whole reason erases stay free on a sparse
        // board.
        if (!existing && !create) continue;

        // A caller that can prove this tile would gain nothing (paintImage
        // inspecting the source) skips it before we ever allocate.
        if (!existing && _skipTile && _skipTile(col, row)) continue;

        const covered = (dropCovered || pruneCovered) && this._boundsCoverTile(col, row, x, y, width, height);
        if (existing && covered && dropCovered) {
          this.releaseTile(col, row);
          continue;
        }

        const tile = existing || this.getTile(col, row, true);
        if (!tile) continue;

        drawFn(tile.ctx, -tile.x, -tile.y, tile);

        if (!existing) {
          // Freshly allocated: it was blank before drawFn, and drawFn only
          // paints inside `bounds`, so `bounds` (padded for antialiased edge
          // bleed) is the only region that can hold content.
          if (pruneNew && this._regionIsBlank(tile, x - tile.x - 2, y - tile.y - 2, width + 4, height + 4)) {
            this.releaseTile(col, row);
          }
        } else if (covered && this._regionIsBlank(tile, 0, 0, tile.canvas.width, tile.canvas.height)) {
          this.releaseTile(col, row);
        }
      }
    }
  }

  /**
   * Draw `source` onto the grid at board position `(bounds.x, bounds.y)` with
   * `compositeOp`, without allocating tiles the source cannot actually reach.
   *
   * This is `paintInto` specialised for the overwhelmingly common case — a
   * canvas being composited at a board offset — and it matters because the
   * generic version has to allocate a tile before it can find out the result
   * was blank. Here we can inspect the *source* region that maps onto each
   * unallocated tile and skip it outright, so restoring a mostly-empty
   * full-board snapshot never spikes to full-board memory.
   *
   * Skipping a blank source region is sound for every operator we allow
   * through: source-over and the separable blend modes all leave the
   * destination untouched where source alpha is zero, and so does
   * destination-out. (The destination-clearing operators — copy, source-in,
   * destination-in, destination-atop — are NOT per-tile safe in the first
   * place and must never reach a tiled layer.)
   *
   * @param {{x:number,y:number,width:number,height:number}} bounds
   * @param {HTMLCanvasElement|ImageBitmap} source
   * @param {string} [compositeOp='source-over']
   * @param {object} [options] - As `paintInto`, minus `pruneNew` (redundant:
   *   a tile only gets allocated here once the source is known non-blank).
   */
  paintImage(bounds, source, compositeOp = 'source-over', options = {}) {
    let srcCtx = null;
    if (!this._readbackBlocked) {
      try {
        srcCtx = source?.getContext?.('2d') ?? null;
      } catch { /* ImageBitmap or other non-2D source */ }
    }

    const draw = (ctx, offX, offY) => {
      ctx.globalCompositeOperation = compositeOp;
      ctx.drawImage(source, bounds.x + offX, bounds.y + offY);
      ctx.globalCompositeOperation = 'source-over';
    };

    // No way to inspect the source — fall back to draw-then-check.
    if (!srcCtx) {
      this.paintInto(bounds, draw, options);
      return;
    }

    this.paintInto(bounds, draw, {
      ...options,
      pruneNew: false,
      // Consulted by paintInto before it allocates: true means "the source
      // contributes nothing here, leave the tile unallocated".
      _skipTile: (col, row) => {
        const rect = this._tileRectAt(col, row);
        return this._sourceRegionIsBlank(srcCtx, rect.x - bounds.x, rect.y - bounds.y, rect.width, rect.height);
      }
    });
  }

  /**
   * Blank-check a rect in source-local coordinates, latching detection off if
   * the source turns out to be unreadable.
   * @private
   */
  _sourceRegionIsBlank(srcCtx, x, y, width, height) {
    try {
      return regionIsBlank(srcCtx, x, y, width, height);
    } catch (e) {
      this._readbackBlocked = true;
      console.warn('[TiledLayerCanvas] blank detection disabled — canvas readback failed:', e);
      return false;
    }
  }

  /**
   * Whether a board-space rect fully contains the tile at (col,row).
   * @private
   */
  _boundsCoverTile(col, row, x, y, width, height) {
    const rect = this._tileRectAt(col, row);
    return x <= rect.x && y <= rect.y &&
      x + width >= rect.x + rect.width &&
      y + height >= rect.y + rect.height;
  }

  /**
   * Composite every allocated tile intersecting `dirtyRects` (or every
   * allocated tile if `dirtyRects` is null/undefined) onto `targetCtx` at
   * its board position, offset by `(destX, destY)`. Never allocates tiles —
   * an unallocated tile is untouched board content, nothing to draw.
   * @param {CanvasRenderingContext2D} targetCtx
   * @param {Array<{x:number,y:number,width:number,height:number}>|null} [dirtyRects]
   * @param {number} [destX=0]
   * @param {number} [destY=0]
   */
  compositeInto(targetCtx, dirtyRects = null, destX = 0, destY = 0) {
    if (!dirtyRects) {
      for (let row = 0; row < this.rows; row++) {
        for (let col = 0; col < this.cols; col++) {
          const tile = this.getTile(col, row, false);
          if (!tile) continue;
          targetCtx.drawImage(tile.canvas, tile.x + destX, tile.y + destY);
        }
      }
      return;
    }

    const seen = new Set();
    for (const rect of dirtyRects) {
      const x = Math.max(0, rect.x);
      const y = Math.max(0, rect.y);
      const width = Math.min(this.width, rect.x + rect.width) - x;
      const height = Math.min(this.height, rect.y + rect.height) - y;
      if (width <= 0 || height <= 0) continue;

      const [startCol, endCol] = this._colRange(x, width);
      const [startRow, endRow] = this._rowRange(y, height);
      for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
          const key = row * this.cols + col;
          if (seen.has(key)) continue;
          seen.add(key);
          const tile = this.getTile(col, row, false);
          if (!tile) continue;
          targetCtx.drawImage(tile.canvas, tile.x + destX, tile.y + destY);
        }
      }
    }
  }

  /**
   * Stitch every allocated tile into one full-board (or bounds-cropped, if
   * `bounds` is given) canvas. This is the single point every full-raster
   * consumer (checkpoint capture, join-sync PNG bins, resize) goes through —
   * see LayerManager integration in the tiled-canvas-backing-store plan.
   * @param {{x:number,y:number,width:number,height:number}} [bounds]
   * @returns {HTMLCanvasElement}
   */
  toFullCanvas(bounds = null) {
    const rect = bounds || { x: 0, y: 0, width: this.width, height: this.height };
    const canvas = document.createElement('canvas');
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext('2d');
    this.compositeInto(ctx, [rect], -rect.x, -rect.y);
    return canvas;
  }

  /**
   * Replace this tile grid's contents by slicing `sourceCanvas` (assumed
   * full-board-sized, top-left aligned) into tiles. Used both for initial
   * import of a full raster into a tiled room and for a live single->tiled
   * toggle. Existing tiles are discarded first.
   *
   * Tiles whose source region is fully transparent are left unallocated. That
   * check is the entire point of the backing store: without it, every import
   * (toggle-on, resize, undo rebuild, glitchBlur bake) would re-materialize
   * the full grid and the tiled mode would cost strictly more memory than the
   * single canvas it replaced.
   *
   * A source region that falls outside `sourceCanvas` (growing the board via
   * resize) reads as blank and is skipped, which is also what we want.
   *
   * @param {HTMLCanvasElement} sourceCanvas
   * @returns {number} Tiles allocated, out of `cols * rows`.
   */
  fromFullCanvas(sourceCanvas) {
    this.dispose();
    this.tiles = new Array(this.cols * this.rows).fill(null);

    // An ImageBitmap (or anything else without a 2D context) can't be
    // inspected; fall back to materializing every tile rather than guessing.
    let srcCtx = null;
    try {
      srcCtx = sourceCanvas?.getContext?.('2d') ?? null;
    } catch { /* not a 2D-capable source */ }

    let allocated = 0;
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const rect = this._tileRectAt(col, row);
        if (srcCtx && !this._readbackBlocked) {
          let blank;
          try {
            blank = regionIsBlank(srcCtx, rect.x, rect.y, rect.width, rect.height);
          } catch (e) {
            this._readbackBlocked = true;
            console.warn('[TiledLayerCanvas] blank detection disabled — canvas readback failed:', e);
            blank = false;
          }
          if (blank) continue;
        }
        const tile = this.getTile(col, row, true);
        tile.ctx.drawImage(
          sourceCanvas,
          rect.x, rect.y, rect.width, rect.height,
          0, 0, rect.width, rect.height
        );
        allocated++;
      }
    }
    return allocated;
  }

  /** Discard all tile canvases. */
  dispose() {
    for (const tile of this.tiles) {
      if (!tile) continue;
      tile.canvas.width = 0;
      tile.canvas.height = 0;
    }
    this.tiles.fill(null);
  }
}
