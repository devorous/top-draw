/**
 * DebugOverlay - visualizes composite tile-grid dirty rects.
 *
 * Hooks Board.onCompositeDirtyRects to capture each set of rects (or full
 * redraw events) and renders them on a dedicated canvas above the board with
 * a short fade-out so quick updates remain visible. Also paints a faint tile
 * grid so the 32px partitioning is easy to see while debugging.
 */

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
    this.board = null;
    this.inputBufferManager = null;
    this.tileSize = 32;
    this.entries = [];
    this.fullEvents = [];
    this.entryColorIndex = 0;
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

  setBoard(board) {
    if (this.board === board) return;
    if (this.board?.onCompositeDirtyRects === this._dirtyRectsHandler) {
      this.board.onCompositeDirtyRects = null;
    }
    this.board = board;
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

  setInputBufferManager(inputBufferManager) {
    this.inputBufferManager = inputBufferManager || null;
  }

  // Compatibility shims for older callers — no-ops now.
  setPixelsWorker() {}
  setTileTracker() {}
  toggleOccupied() { return false; }
  toggleOwnership() { return false; }
  toggleDirtyTiles() { return this.enabled; }
  toggleGridLines() {}

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
    this.board = null;
  }

  _captureRects(rects, isFull) {
    if (!this.enabled) return;
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

    this._drawTileGrid(ctx, w, h);

    const now = performance.now();

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

    // HUD: counts.
    const liveRects = this.entries.reduce((sum, e) => sum + e.rects.length, 0);
    ctx.font = '14px monospace';
    ctx.textBaseline = 'top';
    const pointTelemetry = this.inputBufferManager?.getPointTelemetry?.();
    const pointLabel = pointTelemetry
      ? `   in: ${Math.round(pointTelemetry.bufferedPerSec)}/s out: ${Math.round(pointTelemetry.outgoingPerSec)}/s red: ${Math.round(pointTelemetry.reductionPercent)}%`
      : '';
    const label = `dirty rects: ${liveRects}   full redraws (recent): ${this.fullEvents.length}${pointLabel}`;
    const padX = 6;
    const padY = 4;
    const metrics = ctx.measureText(label);
    const boxW = metrics.width + padX * 2;
    const boxH = 18 + padY * 2 - 4;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(8, 8, boxW, boxH);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fillText(label, 8 + padX, 8 + padY);
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

  // Stroke/region tracking shims — no-ops now (the old region system is gone).
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
  toggleDirtyRects() { return this.enabled; }
  toggleRegions() {}
  toggleStrokePoints() {}
}
