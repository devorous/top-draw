/**
 * Debug Overlay for visualizing tile-based dirty rect tracking
 *
 * Shows the 32x32 tile grid and highlights which tiles are dirty.
 */

export class DebugOverlay {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.enabled = false;
    this.board = null;
    this.dashOffset = 0;
    this.animationId = null;

    // Tile visualization
    this.tileSnapshot = null;
    this.tileHistory = [];
    this.TILE_DISPLAY_DURATION = 1500;

    this.showGridLines = true;
    this.wasmStatus = { mode: 'checking...', wasmReady: false };

    // Ownership visualization
    this.tileOwnershipManager = null;
    this.showOwnership = true;
    this.showDirtyTiles = false; // Dirty tiles now off by default
    this.userColors = new Map(); // userId -> color
    this.colorPalette = [
      'rgba(255, 100, 100, 0.35)', // red
      'rgba(100, 255, 100, 0.35)', // green
      'rgba(100, 100, 255, 0.35)', // blue
      'rgba(255, 255, 100, 0.35)', // yellow
      'rgba(255, 100, 255, 0.35)', // magenta
      'rgba(100, 255, 255, 0.35)', // cyan
      'rgba(255, 180, 100, 0.35)', // orange
      'rgba(180, 100, 255, 0.35)', // purple
    ];
  }

  init(canvas, width, height) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.canvas.width = width;
    this.canvas.height = height;
    this.startAnimation();
  }

  setBoard(board) {
    this.board = board;
  }

  setPixelsWorker(pixelsWorker) {
    this.pixelsWorker = pixelsWorker;
    this._queryWasmStatus();
  }

  setTileOwnershipManager(manager) {
    this.tileOwnershipManager = manager;
  }

  _getUserColor(userId) {
    if (!this.userColors.has(userId)) {
      const idx = this.userColors.size % this.colorPalette.length;
      this.userColors.set(userId, this.colorPalette[idx]);
    }
    return this.userColors.get(userId);
  }

  toggleOwnership() {
    this.showOwnership = !this.showOwnership;
    return this.showOwnership;
  }

  toggleDirtyTiles() {
    this.showDirtyTiles = !this.showDirtyTiles;
    return this.showDirtyTiles;
  }

  async _queryWasmStatus() {
    if (!this.pixelsWorker) {
      this.wasmStatus = { mode: 'N/A', wasmReady: false };
      return;
    }
    try {
      this.wasmStatus = await this.pixelsWorker.getStatus();
    } catch {
      this.wasmStatus = { mode: 'Error', wasmReady: false };
    }
  }

  /**
   * Capture tile state before it's cleared
   */
  captureDirtyTiles(tileSnapshot, tileGrid) {
    if (!this.enabled || !tileSnapshot || !tileGrid) return;

    // Count dirty tiles in this snapshot
    let count = 0;
    for (let i = 0; i < tileSnapshot.length; i++) {
      if (tileSnapshot[i]) count++;
    }

    if (count === 0) return;

    this.tileHistory.push({
      tiles: tileSnapshot,
      cols: tileGrid.cols,
      rows: tileGrid.rows,
      tileSize: tileGrid.tileSize,
      timestamp: Date.now(),
      count
    });

    // Cleanup old
    const now = Date.now();
    this.tileHistory = this.tileHistory.filter(
      e => (now - e.timestamp) < this.TILE_DISPLAY_DURATION
    );
  }

  captureDirtyRects() {}

  toggle() {
    this.enabled = !this.enabled;
    if (this.enabled) {
      this._queryWasmStatus();
    } else {
      this.clear();
      this.tileHistory = [];
    }
    return this.enabled;
  }

  toggleGridLines() {
    this.showGridLines = !this.showGridLines;
  }

  isEnabled() {
    return this.enabled;
  }

  clear() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  startAnimation() {
    const animate = () => {
      this.dashOffset = (this.dashOffset + 0.5) % 8;
      if (this.enabled) {
        this.render();
      }
      this.animationId = requestAnimationFrame(animate);
    };
    animate();
  }

  stopAnimation() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  render() {
    if (!this.enabled || !this.ctx) return;
    this.clear();

    const tileGrid = this.board?.tileGrid;
    if (!tileGrid) {
      this._drawStats(0, 0);
      return;
    }

    const { cols, rows, tileSize } = tileGrid;
    const now = Date.now();

    // Draw grid lines
    if (this.showGridLines) {
      this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      this.ctx.lineWidth = 1;
      this.ctx.setLineDash([]);

      for (let c = 0; c <= cols; c++) {
        const x = c * tileSize;
        this.ctx.beginPath();
        this.ctx.moveTo(x, 0);
        this.ctx.lineTo(x, rows * tileSize);
        this.ctx.stroke();
      }

      for (let r = 0; r <= rows; r++) {
        const y = r * tileSize;
        this.ctx.beginPath();
        this.ctx.moveTo(0, y);
        this.ctx.lineTo(cols * tileSize, y);
        this.ctx.stroke();
      }
    }

    // Draw owned tiles (permanent)
    let ownedCount = 0;
    if (this.showOwnership && this.tileOwnershipManager) {
      const ownershipMap = this.tileOwnershipManager.tileOwnershipMap;
      for (const [tileIdx, owners] of ownershipMap) {
        if (owners.size === 0) continue;
        ownedCount++;

        const col = tileIdx % cols;
        const row = Math.floor(tileIdx / cols);
        const x = col * tileSize;
        const y = row * tileSize;

        // Use color from first owner (tiles can have multiple owners)
        const firstOwner = owners.values().next().value;
        this.ctx.fillStyle = this._getUserColor(firstOwner);
        this.ctx.fillRect(x, y, tileSize, tileSize);

        // If multiple owners, show a small indicator
        if (owners.size > 1) {
          this.ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
          this.ctx.fillRect(x + tileSize - 6, y + 1, 5, 5);
        }
      }
    }

    // Draw dirty tiles (temporary, fading)
    let latestCount = 0;
    if (this.showDirtyTiles) {
      for (const entry of this.tileHistory) {
        const age = now - entry.timestamp;
        const opacity = 1 - (age / this.TILE_DISPLAY_DURATION);
        if (opacity <= 0) continue;

        const isNewest = entry === this.tileHistory[this.tileHistory.length - 1];
        if (isNewest) latestCount = entry.count;

        const tiles = entry.tiles;
        const ts = entry.tileSize;

        for (let i = 0; i < tiles.length; i++) {
          if (!tiles[i]) continue;

          const col = i % entry.cols;
          const row = Math.floor(i / entry.cols);
          const x = col * ts;
          const y = row * ts;

          // Fill
          const alpha = (isNewest ? 0.35 : 0.15) * opacity;
          this.ctx.fillStyle = `rgba(255, 80, 80, ${alpha})`;
          this.ctx.fillRect(x, y, ts, ts);

          // Border for newest
          if (isNewest) {
            this.ctx.strokeStyle = `rgba(255, 80, 80, ${0.9 * opacity})`;
            this.ctx.lineWidth = 2;
            this.ctx.setLineDash([4, 4]);
            this.ctx.lineDashOffset = -this.dashOffset;
            this.ctx.strokeRect(x + 1, y + 1, ts - 2, ts - 2);
          }
        }
      }
    }

    this._drawStats(latestCount, cols * rows, ownedCount);
  }

  _drawStats(dirtyCount, totalTiles, ownedCount = 0) {
    const tileGrid = this.board?.tileGrid;
    const tileSize = tileGrid?.tileSize ?? 32;
    const cols = tileGrid?.cols ?? 0;
    const rows = tileGrid?.rows ?? 0;

    // Count tiles per user
    const userTileCounts = new Map();
    if (this.showOwnership && this.tileOwnershipManager) {
      for (const [, owners] of this.tileOwnershipManager.tileOwnershipMap) {
        for (const userId of owners) {
          userTileCounts.set(userId, (userTileCounts.get(userId) || 0) + 1);
        }
      }
    }

    // Calculate panel height based on user count
    const userCount = userTileCounts.size;
    const baseHeight = 100;
    const userLegendHeight = userCount > 0 ? (userCount * 14) + 10 : 0;
    const panelHeight = baseHeight + userLegendHeight;

    this.ctx.setLineDash([]);
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    this.ctx.fillRect(this.canvas.width - 180, 10, 170, panelHeight);

    this.ctx.fillStyle = '#fff';
    this.ctx.font = 'bold 13px monospace';
    this.ctx.fillText('DEV OVERLAY', this.canvas.width - 170, 26);

    // WASM status
    this.ctx.fillStyle = this.wasmStatus.wasmReady ? '#4ade80' : '#f87171';
    this.ctx.font = '12px monospace';
    this.ctx.fillText(`● ${this.wasmStatus.mode}`, this.canvas.width - 170, 44);

    this.ctx.fillStyle = '#fff';
    this.ctx.fillText(`Tiles: ${tileSize}×${tileSize}px`, this.canvas.width - 170, 62);
    this.ctx.fillText(`Grid: ${cols}×${rows}`, this.canvas.width - 170, 78);

    // Owned tiles
    const ownedPct = totalTiles > 0 ? ((ownedCount / totalTiles) * 100).toFixed(1) : '0.0';
    this.ctx.fillStyle = ownedCount > 0 ? '#4ade80' : '#fff';
    this.ctx.fillText(`Owned: ${ownedCount} (${ownedPct}%)`, this.canvas.width - 170, 96);

    // User legend with colors
    if (userCount > 0) {
      let y = 114;
      const users = this.board?.app?.users;
      for (const [userId, count] of userTileCounts) {
        const color = this._getUserColor(userId);
        const username = users?.get(userId)?.username || `User ${userId}`;
        // Draw color swatch
        this.ctx.fillStyle = color;
        this.ctx.fillRect(this.canvas.width - 170, y - 8, 10, 10);
        // Draw user info
        this.ctx.fillStyle = '#fff';
        this.ctx.font = '10px monospace';
        this.ctx.fillText(`${username}: ${count}`, this.canvas.width - 155, y);
        y += 14;
      }
    }
  }

  clearAll() {
    this.tileHistory = [];
    this.clear();
  }

  destroy() {
    this.stopAnimation();
    this.clear();
    this.board = null;
    this.canvas = null;
    this.ctx = null;
  }

  // Stubs for backward compat
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
  toggleDirtyRects() { return this.toggleDirtyTiles(); }
  toggleRegions() {}
  toggleStrokePoints() {}
}
