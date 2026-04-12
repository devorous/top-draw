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

  consumeDirtyRects(maxCoverage = 0.4, maxRects = 24) {
    if (this.forceFull) {
      this.clear();
      return null;
    }

    if (this.dirtyCount === 0) return [];

    const tileCount = this.cols * this.rows;
    if (tileCount > 0 && (this.dirtyCount / tileCount) > maxCoverage) {
      this.clear();
      return null;
    }

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
    if (rects.length > maxRects) return null;
    return rects;
  }
}
