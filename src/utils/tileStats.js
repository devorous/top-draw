/**
 * @fileoverview Read-only sampling of layer 0's tiled backing store, shared by
 * the debug panel's occupancy map and the board-aligned overlay.
 *
 * Every read here is a plain property access — `tiles[]`, `cols`, `rows`,
 * `canvas.width`. Nothing in this file may call `getImageData`: blank detection
 * is a GPU readback and these functions run on a per-frame path. The tile array
 * already records exactly what we want to show (allocated vs not), so there is
 * nothing to inspect pixels for.
 *
 * `TiledLayerCanvas` exposes `allocatedTileCount` and `allocatedBytes` as
 * separate getters, each of which walks the whole tile array. We want the count,
 * the bytes and the per-tile occupancy together, so this walks once instead.
 */

import { TiledLayerCanvas } from '../canvas/TiledLayerCanvas.js';

const MB = 1024 * 1024;

/**
 * Sample layer 0's backing store.
 *
 * Re-reads `app.board.layerManager` on every call rather than caching it:
 * `Board.resizeBoard()` throws the whole LayerManager away and builds a new one,
 * so a held reference silently goes stale after a board-size change and would
 * report the old grid forever.
 *
 * @param {Object} app - The App instance.
 * @returns {{
 *   tiled: boolean,
 *   reason: string,
 *   tileSize: number,
 *   nominalBytes: number,
 *   nominalMB: number,
 *   cols: number,
 *   rows: number,
 *   totalTiles: number,
 *   allocatedTiles: number,
 *   allocatedBytes: number,
 *   allocatedMB: number,
 *   savedPercent: number,
 *   readbackBlocked: boolean,
 *   viewCulling: boolean,
 *   visibleTiles: number,
 *   occupancy: Uint8Array|null
 * }}
 */
export function collectTileStats(app) {
  const lm = app?.board?.layerManager;
  const group = lm?.layerGroups?.[0];
  const nominalBytes = ((lm?.width | 0) * (lm?.height | 0)) * 4;

  const off = (reason) => ({
    tiled: false,
    reason,
    // The size tiling *would* use, so the panel can show it while off.
    // `lm.tiledTileSize` is null unless explicitly pinned, so it cannot be
    // read directly here without reporting 0.
    tileSize: lm
      ? (lm.tiledTileSize || TiledLayerCanvas.tileSizeForBoard(lm.width, lm.height))
      : 0,
    nominalBytes,
    nominalMB: nominalBytes / MB,
    cols: 0,
    rows: 0,
    totalTiles: 0,
    allocatedTiles: 0,
    allocatedBytes: 0,
    allocatedMB: 0,
    savedPercent: 0,
    readbackBlocked: false,
    viewCulling: false,
    visibleTiles: 0,
    occupancy: null
  });

  if (!lm) return off('no layer manager');
  // `group.tiled` is the authority, not `lm.tiledBackingStore`: setTiledBackingStore
  // bails before recording the flag when layer 0 has no flatCanvas yet, so the
  // two can legitimately disagree.
  if (!group) return off('no layer 0');
  if (!group.tiled) {
    return off(group.flatCanvas ? 'off for this room' : 'layer 0 not baked yet');
  }

  const tiled = group.flatCanvas;
  const tiles = tiled?.tiles;
  if (!Array.isArray(tiles)) return off('layer 0 is not a tile grid');

  const occupancy = new Uint8Array(tiles.length);
  let allocatedTiles = 0;
  let allocatedBytes = 0;
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    if (!tile) continue;
    occupancy[i] = 1;
    allocatedTiles++;
    allocatedBytes += tile.canvas.width * tile.canvas.height * 4;
  }

  return {
    tiled: true,
    reason: '',
    tileSize: tiled.tileSize,
    nominalBytes,
    nominalMB: nominalBytes / MB,
    cols: tiled.cols,
    rows: tiled.rows,
    totalTiles: tiles.length,
    allocatedTiles,
    allocatedBytes,
    allocatedMB: allocatedBytes / MB,
    savedPercent: nominalBytes > 0 ? (1 - allocatedBytes / nominalBytes) * 100 : 0,
    // A plain boolean, so it costs no readback to report — and without it a
    // latched grid is indistinguishable from a legitimately full one, since
    // both read "576/576 tiles, 0.0% saved". Once this latches, every tile the
    // bounds touch is allocated and kept forever: tiling then costs strictly
    // more than the single canvas it replaced, permanently, and silently.
    readbackBlocked: !!tiled._readbackBlocked,
    // Whether viewport culling is on AND currently engaged (a second view, or
    // a view that hides too little of the board, disengages it) — so the panel
    // never reports a "visible" figure that is really just "all of them".
    viewCulling: !!app?.board?.viewportCulling && !!app?.board?._lastCullView,
    visibleTiles: tiled.lastCompositeTileCount | 0,
    occupancy
  };
}

/**
 * The `TiledLayerCanvas` behind layer 0, or null when the room isn't tiled.
 * Only for the operations that genuinely need the object itself (`compact()`);
 * everything read-only should go through `collectTileStats`.
 *
 * @param {Object} app - The App instance.
 * @returns {Object|null}
 */
export function getTiledLayerCanvas(app) {
  const group = app?.board?.layerManager?.layerGroups?.[0];
  if (!group?.tiled) return null;
  return Array.isArray(group.flatCanvas?.tiles) ? group.flatCanvas : null;
}

/**
 * Remembers which tiles were allocated or freed recently, so the occupancy view
 * can flash the churn rather than only showing a static end state. Watching the
 * grid fill as strokes bake and empty as erases reclaim is the part that proves
 * lazy allocation is actually working.
 *
 * Sampling cadence is the caller's: the tracker times events off the clock, not
 * off update counts, so a 60fps overlay and a 500ms panel both age correctly.
 */
export class TileChurnTracker {
  /** @param {number} [windowMs=1000] - How long an event stays visible. */
  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
    /** @type {Uint8Array|null} */
    this._prev = null;
    /** @type {Map<number, {time: number, allocated: boolean}>} */
    this.events = new Map();
  }

  /**
   * Diff a fresh occupancy sample against the previous one.
   *
   * A grid whose size changed (board resize, or a live tile-size change) can't
   * be diffed index-for-index, so it re-baselines instead of reporting the whole
   * grid as churn.
   *
   * @param {Uint8Array|null} occupancy - null when tiling is off; resets state.
   * @param {number} [now]
   */
  update(occupancy, now = performance.now()) {
    if (!occupancy) {
      this.reset();
      return;
    }

    const prev = this._prev;
    if (prev && prev.length === occupancy.length) {
      for (let i = 0; i < occupancy.length; i++) {
        if (occupancy[i] !== prev[i]) {
          this.events.set(i, { time: now, allocated: occupancy[i] === 1 });
        }
      }
      prev.set(occupancy);
    } else {
      this._prev = new Uint8Array(occupancy);
      this.events.clear();
    }

    for (const [index, event] of this.events) {
      if (now - event.time > this.windowMs) this.events.delete(index);
    }
  }

  reset() {
    this._prev = null;
    this.events.clear();
  }

  /**
   * @param {number} index - Tile index (row * cols + col).
   * @param {number} [now]
   * @returns {{allocated: boolean, fade: number}|null} `fade` runs 1 → 0 over
   *   the tracker's window.
   */
  get(index, now = performance.now()) {
    const event = this.events.get(index);
    if (!event) return null;
    const fade = 1 - (now - event.time) / this.windowMs;
    if (fade <= 0) return null;
    return { allocated: event.allocated, fade };
  }

  /** @returns {{allocated: number, freed: number}} Events still in the window. */
  counts() {
    let allocated = 0;
    let freed = 0;
    for (const event of this.events.values()) {
      if (event.allocated) allocated++;
      else freed++;
    }
    return { allocated, freed };
  }
}
