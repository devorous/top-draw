/**
 * DebugOverlay - disabled stub.
 *
 * The full dev overlay was removed because (a) only moderators had access
 * to toggle it, (b) it ran an unconditional rAF loop, and (c) it fed off the
 * dirty-rect tracking which is also gone. Keeping the class + method shapes
 * lets existing call sites continue to work as no-ops.
 */
export class DebugOverlay {
  constructor() {
    this.enabled = false;
  }

  init() {}
  setBoard() {}
  setPixelsWorker() {}
  setTileTracker() {}
  toggleOccupied() { return false; }
  toggleOwnership() { return false; }
  toggleDirtyTiles() { return false; }
  toggleGridLines() {}
  toggle() { return false; }
  isEnabled() { return false; }
  clear() {}
  clearAll() {}
  render() {}
  destroy() {}

  captureDirtyTiles() {}
  captureDirtyRects() {}
  expandUserRegion() {}
  clearUserRegion() {}
  startStrokeTracking() {}
  addStrokePoint() {}
  endStrokeTracking() {}
  startDrawing() {}
  addDrawingPoint() {}
  endDrawing() {}
  cancelDrawing() {}
  addRegion() {}
  toggleDirtyRects() { return false; }
  toggleRegions() {}
  toggleStrokePoints() {}
}
