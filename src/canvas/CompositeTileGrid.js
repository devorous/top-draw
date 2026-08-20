import { perfProbe } from '../utils/PerfProbe.js';

const PROBE = 'dirtyRects.resolve';

// Tallies here are the point of the probe: the two escape hatches below
// (coverage bail, rect collapse) each swap a cheap path for a much more
// expensive one, and we have no production data on how often either fires.
perfProbe.register(PROBE, [
  'forceFull',    // markFull() had been called — full redraw, no scan
  'clean',        // nothing dirty, early-out before the grid scan
  'coverageBail', // dirty fraction > maxCoverage — degraded to full redraw
  'rectCollapse', // more than maxRects runs — degraded to bounding box
  'rectsEmitted', // total rects returned, for a per-call average
  'tilesScanned', // cols*rows per scanning call — the board-area cost driver
  'dirtyTiles'    // dirty tiles per scanning call, to compare against the above
]);

export class CompositeTileGrid {
  constructor(width, height, tileSize = 32) {
    this.tileSize = tileSize;
    this.resize(width, height);
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / this.tileSize);
    this.rows = Math.ceil(height / this.tileSize);
    this.dirtyTiles = new Uint8Array(this.cols * this.rows);
    this.dirtyCount = 0;
    this.forceFull = true;
  }

  clear() {
    this.dirtyTiles.fill(0);
    this.dirtyCount = 0;
    this.forceFull = false;
  }

  markFull() {
    this.forceFull = true;
    this.dirtyTiles.fill(0);
    this.dirtyCount = 0;
  }

  markRect(x, y, width, height) {
    if (this.forceFull) return;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;

    const minX = Math.max(0, Math.floor(x));
    const minY = Math.max(0, Math.floor(y));
    const maxX = Math.min(this.width - 1, Math.ceil(x + width) - 1);
    const maxY = Math.min(this.height - 1, Math.ceil(y + height) - 1);
    if (maxX < minX || maxY < minY) return;

    const startCol = Math.floor(minX / this.tileSize);
    const endCol = Math.floor(maxX / this.tileSize);
    const startRow = Math.floor(minY / this.tileSize);
    const endRow = Math.floor(maxY / this.tileSize);

    for (let row = startRow; row <= endRow; row++) {
      const rowOffset = row * this.cols;
      for (let col = startCol; col <= endCol; col++) {
        const idx = rowOffset + col;
        if (this.dirtyTiles[idx] === 0) {
          this.dirtyTiles[idx] = 1;
          this.dirtyCount++;
        }
      }
    }
  }

  /**
   * @param {number} [maxCoverage=0.4] - Above this fraction of dirty tiles, give
   *   up on rects entirely and signal a full redraw (null).
   * @param {number} [maxRects=8] - Above this many disjoint rects, collapse to
   *   their bounding box.
   *
   *   Compositing cost is dominated by rect *count*, not area: _applyDirtyClip
   *   builds an N-rect clip path and _drawCanvasRegion issues a drawImage per
   *   rect, per live stroke, per layer. Measured on a Big board with 60 live
   *   strokes, 24 rects covering 1.65% of the board cost 30.3ms while the
   *   collapsed bounding box — 65.8% of the board — cost 5.8ms. The old limit of
   *   24 sat at the top of that expensive band; 8 keeps the cheap cases and
   *   collapses out of the band before it gets costly.
   *
   *   See docs/board_size_performance_session_2026-08-18.md, "Open lead 1".
   * @returns {Array<{x:number,y:number,width:number,height:number}>|null}
   */
  consumeDirtyRects(maxCoverage = 0.4, maxRects = 8) {
    perfProbe.begin(PROBE);
    try {
      return this._consumeDirtyRects(maxCoverage, maxRects);
    } finally {
      perfProbe.end(PROBE);
    }
  }

  /** @private */
  _consumeDirtyRects(maxCoverage, maxRects) {
    if (this.forceFull) {
      perfProbe.tally(PROBE, 'forceFull');
      this.clear();
      return null;
    }

    if (this.dirtyCount === 0) {
      perfProbe.tally(PROBE, 'clean');
      return [];
    }

    const tileCount = this.cols * this.rows;
    if (tileCount > 0 && (this.dirtyCount / tileCount) > maxCoverage) {
      perfProbe.tally(PROBE, 'coverageBail');
      this.clear();
      return null;
    }

    // Counted only on calls that actually run the scan below, so the ratio of
    // tilesScanned to dirtyTiles reads as wasted work per scanning call.
    perfProbe.tally(PROBE, 'tilesScanned', tileCount);
    perfProbe.tally(PROBE, 'dirtyTiles', this.dirtyCount);

    const rectRuns = [];
    let activeRuns = new Map();

    for (let row = 0; row < this.rows; row++) {
      const nextRuns = new Map();
      let col = 0;
      while (col < this.cols) {
        if (!this.dirtyTiles[row * this.cols + col]) {
          col++;
          continue;
        }

        const startCol = col;
        while (col + 1 < this.cols && this.dirtyTiles[row * this.cols + col + 1]) {
          col++;
        }
        const endCol = col;
        const key = `${startCol}:${endCol}`;
        const existing = activeRuns.get(key);
        if (existing) {
          existing.endRow = row;
          nextRuns.set(key, existing);
          activeRuns.delete(key);
        } else {
          nextRuns.set(key, { startCol, endCol, startRow: row, endRow: row });
        }
        col++;
      }

      for (const stale of activeRuns.values()) {
        rectRuns.push(stale);
      }
      activeRuns = nextRuns;
    }

    for (const run of activeRuns.values()) {
      rectRuns.push(run);
    }

    const rects = rectRuns.map((run) => {
      const x = run.startCol * this.tileSize;
      const y = run.startRow * this.tileSize;
      const maxX = Math.min(this.width, (run.endCol + 1) * this.tileSize);
      const maxY = Math.min(this.height, (run.endRow + 1) * this.tileSize);
      return { x, y, width: maxX - x, height: maxY - y };
    });

    this.clear();
    if (rects.length > maxRects) {
      perfProbe.tally(PROBE, 'rectCollapse');
      perfProbe.tally(PROBE, 'rectsEmitted');
      let minX = Infinity, minY = Infinity, maxRX = -Infinity, maxRY = -Infinity;
      for (const r of rects) {
        if (r.x < minX) minX = r.x;
        if (r.y < minY) minY = r.y;
        if (r.x + r.width > maxRX) maxRX = r.x + r.width;
        if (r.y + r.height > maxRY) maxRY = r.y + r.height;
      }
      return [{ x: minX, y: minY, width: maxRX - minX, height: maxRY - minY }];
    }
    perfProbe.tally(PROBE, 'rectsEmitted', rects.length);
    return rects;
  }
}
