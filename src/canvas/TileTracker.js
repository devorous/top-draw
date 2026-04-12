/**
 * TileTracker - disabled stub.
 *
 * The full occupancy tracker was removed because it was doing per-stroke
 * bookkeeping that nothing was reading for anything load-bearing. Keeping
 * the class + method shapes lets the many existing call sites (FloodFill,
 * SelectTool, RemoteSelectionHandler, SyncClient, etc.) continue to work as
 * no-ops without having to thread null checks through all of them.
 */
export class TileTracker {
  constructor(width, height) {
    this.tileSize = 32;
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / 32);
    this.rows = Math.ceil(height / 32);
    this.tiles = new Uint8Array(0);
  }

  getTileIndex() { return -1; }
  getTileIndicesForRect() { return []; }
  markTileDirty() { return false; }
  markPathDirty() {}
  collectTilesFromPath() {}
  clearTile() { return false; }
  isTileDirty() { return false; }
  clear() {}
  resize(width, height) {
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / 32);
    this.rows = Math.ceil(height / 32);
  }
  getDirtyTiles() { return []; }
  getDirtyCount() { return 0; }
}
