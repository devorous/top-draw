/**
 * DebugOverlay - board-aligned visualisation for Debug mode.
 *
 * Two independent layers, each toggleable from the debug panel:
 *
 *  - Dirty rects: hooks Board.onCompositeDirtyRects to capture each set of rects
 *    (or full redraw events) and paints them with a short fade-out so quick
 *    updates stay visible, over a faint grid at CompositeTileGrid's granularity.
 *  - Tile occupancy: outlines layer 0's tiled backing store, filling the tiles
 *    that actually hold a canvas and flashing the ones allocated or freed in the
 *    last second. This is the direct, per-tile view of whether lazy allocation
 *    is working — an aggregate byte count can look right while the grid is wrong.
 *
 * The overlay owns its own canvas above the board and never touches layer 0 or
 * the composite path, so nothing here can affect what gets rendered.
 */

import { collectTileStats, TileChurnTracker } from '../utils/tileStats.js';

const RECT_LIFETIME_MS = 600;
const FULL_LIFETIME_MS = 350;
const RECT_PALETTE = [
  'rgba(255, 80, 80, 0.95)',
  'rgba(80, 200, 255, 0.95)',
  'rgba(140, 255, 120, 0.95)',
  'rgba(255, 200, 80, 0.95)',
  'rgba(220, 120, 255, 0.95)',
];

export class DebugOverlay {
  constructor() {
    this.enabled = false;
    this.canvas = null;
    this.ctx = null;
    this.app = null;
    this.board = null;
    this.tileSize = 32;
    this.entries = [];
    this.fullEvents = [];
    this.entryColorIndex = 0;
    this.showDirtyRects = true;
    this.showTiles = true;
    this.tileChurn = new TileChurnTracker();
    this._rafId = 0;
    this._renderLoop = this._renderLoop.bind(this);
    this._dirtyRectsHandler = (rects, isFull) => this._captureRects(rects, isFull);
  }

  init(canvas, width, height) {
    if (!canvas) return;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.canvas.width = width;
    this.canvas.height = height;

    // Reparent into #boards so the overlay shares the board's transform/zoom.
    const boardsWrapper = document.getElementById('boards');
    if (boardsWrapper && this.canvas.parentElement !== boardsWrapper) {
      boardsWrapper.appendChild(this.canvas);
    }

    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.pointerEvents = 'none';
    this.canvas.style.zIndex = '5';
    this.canvas.style.display = 'none';
  }

  setApp(app) {
    this.app = app || null;
  }

  setBoard(board) {
    if (this.board === board) return;
    if (this.board?.onCompositeDirtyRects === this._dirtyRectsHandler) {
      this.board.onCompositeDirtyRects = null;
    }
    this.board = board;
    // A new board means a new LayerManager and possibly a new grid shape, so any
    // churn history is about tiles that no longer exist.
    this.tileChurn.reset();
    if (board) {
      this.tileSize = board.compositeTileGrid?.tileSize ?? 32;
      if (this.canvas) {
        const w = board.getWidth?.() ?? this.canvas.width;
        const h = board.getHeight?.() ?? this.canvas.height;
        if (w !== this.canvas.width || h !== this.canvas.height) {
          this.canvas.width = w;
          this.canvas.height = h;
        }
      }
      if (this.enabled) {
        board.onCompositeDirtyRects = this._dirtyRectsHandler;
      }
    }
  }

  toggleDirtyRects() {
    this.showDirtyRects = !this.showDirtyRects;
    if (!this.showDirtyRects) this.clear();
    return this.showDirtyRects;
  }

  toggleTiles() {
    this.showTiles = !this.showTiles;
    if (!this.showTiles) this.tileChurn.reset();
    return this.showTiles;
  }

  toggle() {
    if (this.enabled) {
      this.disable();
    } else {
      this.enable();
    }
    return this.enabled;
  }

  isEnabled() {
    return this.enabled;
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    if (this.canvas) this.canvas.style.display = 'block';
    if (this.board) this.board.onCompositeDirtyRects = this._dirtyRectsHandler;
    // Nothing was sampled while off, so the first frame would otherwise report
    // the entire allocated grid as freshly churned.
    this.tileChurn.reset();
    if (!this._rafId) {
      this._rafId = requestAnimationFrame(this._renderLoop);
    }
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    if (this.canvas) this.canvas.style.display = 'none';
    if (this.board?.onCompositeDirtyRects === this._dirtyRectsHandler) {
      this.board.onCompositeDirtyRects = null;
    }
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
    this.entries.length = 0;
    this.fullEvents.length = 0;
    this.tileChurn.reset();
    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  clear() {
    this.entries.length = 0;
    this.fullEvents.length = 0;
  }

  clearAll() {
    this.clear();
    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  destroy() {
    this.disable();
    this.canvas = null;
    this.ctx = null;
    this.app = null;
    this.board = null;
  }

  _captureRects(rects, isFull) {
    if (!this.enabled || !this.showDirtyRects) return;
    const now = performance.now();
    if (isFull) {
      this.fullEvents.push({ time: now });
      if (this.fullEvents.length > 8) this.fullEvents.shift();
      return;
    }
    if (!rects || rects.length === 0) return;
    const color = RECT_PALETTE[this.entryColorIndex % RECT_PALETTE.length];
    this.entryColorIndex++;
    this.entries.push({ rects, time: now, color });
    if (this.entries.length > 64) {
      this.entries.splice(0, this.entries.length - 64);
    }
  }

  _renderLoop() {
    this._rafId = 0;
    if (!this.enabled) return;
    this.render();
    this._rafId = requestAnimationFrame(this._renderLoop);
  }

  render() {
    if (!this.ctx || !this.canvas) return;
    if (this.board) {
      const bw = this.board.getWidth?.();
      const bh = this.board.getHeight?.();
      if (bw && bh && (bw !== this.canvas.width || bh !== this.canvas.height)) {
        this.canvas.width = bw;
        this.canvas.height = bh;
      }
      this.tileSize = this.board.compositeTileGrid?.tileSize ?? this.tileSize;
    }
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const now = performance.now();

    // Sampled every frame because it is only property reads over a few dozen
    // array slots — no pixel readback, so the per-frame budget is negligible.
    const tileStats = this.showTiles ? collectTileStats(this.app) : null;
    this.tileChurn.update(tileStats?.occupancy ?? null, now);

    if (this.showDirtyRects) {
      this._drawTileGrid(ctx, w, h);
      this._drawDirtyRects(ctx, w, h, now);
    }
    if (tileStats?.tiled) {
      this._drawTileOccupancy(ctx, tileStats, now);
    }
  }

  /**
   * Live dirty-rect counts, for the debug panel to render.
   *
   * The overlay used to paint these itself as a box in the board's top-left
   * corner. That put a second debug readout on screen in a place the user could
   * not move, repainting at a different cadence than the panel and duplicating
   * the panel's tile line — so the numbers live in one place now and the
   * overlay draws only what has to be board-aligned.
   *
   * Null rather than zeroes when nothing is being tracked: a zero here would
   * read as "the board is not redrawing", which is a very different claim.
   *
   * @returns {{liveRects: number, fullRedraws: number}|null}
   */
  getRectStats() {
    if (!this.enabled || !this.showDirtyRects) return null;
    let liveRects = 0;
    for (const entry of this.entries) liveRects += entry.rects.length;
    return { liveRects, fullRedraws: this.fullEvents.length };
  }

  _drawDirtyRects(ctx, w, h, now) {
    // Drop expired entries.
    while (this.entries.length && now - this.entries[0].time > RECT_LIFETIME_MS) {
      this.entries.shift();
    }
    while (this.fullEvents.length && now - this.fullEvents[0].time > FULL_LIFETIME_MS) {
      this.fullEvents.shift();
    }

    // Full-redraw flash.
    for (const ev of this.fullEvents) {
      const age = now - ev.time;
      const alpha = Math.max(0, 1 - age / FULL_LIFETIME_MS) * 0.18;
      ctx.fillStyle = `rgba(255, 60, 60, ${alpha})`;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = `rgba(255, 60, 60, ${alpha * 4})`;
      ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, w - 4, h - 4);
    }

    // Per-rect overlays.
    ctx.lineWidth = 1.5;
    for (const entry of this.entries) {
      const age = now - entry.time;
      const t = Math.max(0, 1 - age / RECT_LIFETIME_MS);
      const fillAlpha = 0.12 * t;
      const strokeAlpha = 0.85 * t;
      const baseColor = entry.color;
      ctx.fillStyle = baseColor.replace(/rgba\(([^)]+),\s*[\d.]+\)/, `rgba($1, ${fillAlpha})`);
      ctx.strokeStyle = baseColor.replace(/rgba\(([^)]+),\s*[\d.]+\)/, `rgba($1, ${strokeAlpha})`);
      for (const r of entry.rects) {
        ctx.fillRect(r.x, r.y, r.width, r.height);
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width - 1, r.height - 1);
      }
    }
  }

  /**
   * Paint layer 0's tile grid: every cell outlined, allocated cells filled, and
   * cells that changed state in the last second flashed green (allocated) or
   * orange (freed).
   * @private
   */
  _drawTileOccupancy(ctx, stats, now) {
    const { cols, rows, tileSize, occupancy } = stats;
    const boardW = this.canvas.width;
    const boardH = this.canvas.height;

    ctx.save();
    ctx.lineWidth = 1;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const index = row * cols + col;
        const x = col * tileSize;
        const y = row * tileSize;
        // Edge tiles are cropped to the board, matching TiledLayerCanvas.
        const width = Math.min(tileSize, boardW - x);
        const height = Math.min(tileSize, boardH - y);
        if (width <= 0 || height <= 0) continue;

        const allocated = occupancy[index] === 1;
        const churn = this.tileChurn.get(index, now);

        if (allocated) {
          ctx.fillStyle = 'rgba(80, 200, 255, 0.10)';
          ctx.fillRect(x, y, width, height);
        }
        if (churn) {
          const color = churn.allocated ? '90, 255, 140' : '255, 150, 60';
          ctx.fillStyle = `rgba(${color}, ${0.35 * churn.fade})`;
          ctx.fillRect(x, y, width, height);
          ctx.strokeStyle = `rgba(${color}, ${0.95 * churn.fade})`;
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, width - 2, height - 2);
          ctx.lineWidth = 1;
        }
        ctx.strokeStyle = allocated ? 'rgba(80, 200, 255, 0.55)' : 'rgba(255, 255, 255, 0.14)';
        ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
      }
    }

    ctx.restore();
  }

  _drawTileGrid(ctx, w, h) {
    const size = this.tileSize;
    if (!size || size <= 0) return;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x += size) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    }
    for (let y = 0; y <= h; y += size) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
    }
    ctx.stroke();
  }
}
