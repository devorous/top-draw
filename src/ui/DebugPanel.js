/**
 * @fileoverview The Debug mode panel — the single place for runtime diagnostics.
 *
 * Absorbs what used to be a separate Shift+P "performance" panel (canvas
 * census, overlay toggles) plus the grey HUD box the board overlay drew in its
 * top-left corner, and adds a live view of layer 0's tiled backing store. Three
 * overlapping debug UIs meant none told the whole story; this one is toggled
 * with Debug mode and nothing else, and it can be dragged out of the way.
 *
 * Present the tile numbers as a memory/allocation story, not a frame-rate one:
 * board-size lag was measured as memory bandwidth, and a tile-size sweep at
 * 1440p put the extra composite cost at roughly 0.6us per additional drawImage.
 * Tiling changes what the board costs to hold, not what it costs to draw.
 */

import { collectCanvasCensus, logCanvasCensus } from '../utils/canvasCensus.js';
import { collectTileStats, getTiledLayerCanvas, TileChurnTracker } from '../utils/tileStats.js';

const REFRESH_MS = 500;
/** Occupancy map sizing: cell edge in px, clamped so a wide grid still fits. */
const MAP_MAX_WIDTH = 276;
const MAP_MIN_CELL = 2;
const MAP_MAX_CELL = 14;

export class DebugPanel {
  /**
   * @param {Object} inputBufferManager
   * @param {Object} app - The App instance. Never cache anything reached
   *   *through* it (see the layerManager note in tileStats.js).
   */
  constructor(inputBufferManager, app) {
    this.inputBufferManager = inputBufferManager;
    this.app = app;
    this.panel = null;
    this.enabled = false;
    this.el = {};
    this.tileChurn = new TileChurnTracker();
    this._refreshInterval = null;
    this._compactNote = '';
  }

  init() {
    this.panel = document.createElement('div');
    this.panel.id = 'debugPanel';
    this.panel.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      background: rgba(0, 0, 0, 0.85);
      color: #0f0;
      font-family: monospace;
      font-size: 11px;
      padding: 10px;
      border: 1px solid #0f0;
      border-radius: 4px;
      z-index: 10000;
      display: none;
      max-width: 300px;
      line-height: 1.6;
      pointer-events: auto;
      user-select: none;
    `;

    // Built once with stable nodes rather than rebuilt from innerHTML on every
    // tick: the occupancy map is a canvas, and re-creating it twice a second
    // would throw away its backing store and every listener with it.
    this.panel.innerHTML = `
      <div data-el="header" style="display:flex; align-items:center; justify-content:space-between; gap:10px; cursor:move; touch-action:none;">
        <strong>DEBUG MODE</strong>
        <span data-el="close" title="Turn off Debug mode" style="cursor:pointer; padding:0 3px; font-size:14px; line-height:1;">&times;</span>
      </div>
      <div data-el="input"></div>
      <div data-el="census" style="margin-top:6px;"></div>
      <div data-el="rects" style="margin-top:6px;"></div>
      <div style="margin-top:6px;">
        <strong>TILED LAYER 0</strong><br>
        <div data-el="tileBody"></div>
        <canvas data-el="tileMap" style="display:none; margin-top:4px; image-rendering:pixelated; border:1px solid #333;"></canvas>
        <div data-el="tileActions" style="display:none; margin-top:4px;">
          <span data-el="compact" style="cursor:pointer; text-decoration:underline;">compact()</span>
          <span data-el="compactNote" style="color:#888;"></span>
        </div>
      </div>
      <div style="margin-top:6px;">
        <strong>OVERLAYS:</strong><br>
        <span data-el="dirtyRectsToggle" style="cursor:pointer; text-decoration:underline;">Dirty Rects</span>
        &middot;
        <span data-el="tilesToggle" style="cursor:pointer; text-decoration:underline;">Tile Grid</span>
      </div>
      <div style="margin-top:6px; color:#555;">(drag the title bar to move &middot; Shift+P or the Debug button to toggle)</div>
    `;

    for (const node of this.panel.querySelectorAll('[data-el]')) {
      this.el[node.dataset.el] = node;
    }

    this.el.close?.addEventListener('click', () => this._close());
    this.el.compact?.addEventListener('click', () => this._compact());
    this.el.dirtyRectsToggle?.addEventListener('click', () => {
      this.app?.debugOverlay?.toggleDirtyRects();
      this.update();
    });
    this.el.tilesToggle?.addEventListener('click', () => {
      this.app?.debugOverlay?.toggleTiles();
      this.update();
    });

    this._initDrag();

    document.body.appendChild(this.panel);
  }

  /**
   * Turn off Debug mode from the panel's X.
   *
   * Toggles the whole mode rather than hiding this element: the panel and the
   * board overlay are one switch on purpose, and closing only the panel would
   * strand the overlay running with the Debug button still reading ON.
   * @private
   */
  _close() {
    if (typeof this.app?.handleToggleDebugMode === 'function'
      && this.app.debugOverlay?.isEnabled?.()) {
      this.app.handleToggleDebugMode();
      return;
    }
    // Panel shown without the overlay (a direct setEnabled, or no app wired).
    this.setEnabled(false);
  }

  /**
   * Drag the panel by its title bar.
   *
   * Listeners live on the header and the panel is removed wholesale in
   * `destroy()`, so there is nothing to unbind; pointer capture keeps the drag
   * alive when the cursor outruns the header or crosses the canvas.
   * @private
   */
  _initDrag() {
    const header = this.el.header;
    if (!header) return;

    let dragPointerId = null;
    let offsetX = 0;
    let offsetY = 0;

    header.addEventListener('pointerdown', (e) => {
      // The X sits inside the header; clicking it must not also start a drag.
      if (dragPointerId !== null || e.target === this.el.close) return;
      const rect = this.panel.getBoundingClientRect();
      dragPointerId = e.pointerId;
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      this._moveTo(rect.left, rect.top);
      header.setPointerCapture?.(dragPointerId);
      e.preventDefault();
    });

    header.addEventListener('pointermove', (e) => {
      if (e.pointerId !== dragPointerId) return;
      this._moveTo(e.clientX - offsetX, e.clientY - offsetY);
    });

    const endDrag = (e) => {
      if (e.pointerId !== dragPointerId) return;
      header.releasePointerCapture?.(dragPointerId);
      dragPointerId = null;
    };
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);
  }

  /**
   * Position the panel by its top-left, clamped to the viewport.
   *
   * The panel opens anchored top/right, so this also drops the `right` anchor —
   * setting `left` while `right` still applies would stretch the box instead of
   * moving it.
   * @private
   */
  _moveTo(left, top) {
    if (!this.panel) return;
    const rect = this.panel.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    this.panel.style.right = 'auto';
    this.panel.style.left = `${Math.min(Math.max(0, left), maxLeft)}px`;
    this.panel.style.top = `${Math.min(Math.max(0, top), maxTop)}px`;
  }

  /**
   * Re-clamp a dragged panel on re-show. Cheaper than a resize listener, which
   * would have to stay bound while Debug mode is off — the panel only needs to
   * be reachable at the moment it becomes visible again. An undragged panel is
   * still right-anchored and follows the viewport on its own.
   * @private
   */
  _clampIntoView() {
    const left = this.panel?.style.left;
    if (!left || left === 'auto') return;
    this._moveTo(parseFloat(left) || 0, parseFloat(this.panel.style.top) || 0);
  }

  /**
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    enabled = !!enabled;
    if (enabled === this.enabled) return this.enabled;
    this.enabled = enabled;
    if (this.panel) {
      this.panel.style.display = enabled ? 'block' : 'none';
    }
    if (enabled) {
      // Display is already 'block' above, so the rect this measures is real.
      this._clampIntoView();
      // Nothing was sampled while off, so a stale baseline would report the
      // whole grid as churn on the first tick.
      this.tileChurn.reset();
      this._compactNote = '';
      this.update();
      this._startRefresh();
    } else {
      this._stopRefresh();
      this.tileChurn.reset();
    }
    return this.enabled;
  }

  toggle() {
    return this.setEnabled(!this.enabled);
  }

  _startRefresh() {
    this._stopRefresh();
    this._refreshInterval = setInterval(() => this.update(), REFRESH_MS);
  }

  _stopRefresh() {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
    }
  }

  update() {
    if (!this.panel || !this.enabled) return;

    const info = this.inputBufferManager.getPerformanceInfo();

    if (this.el.input) {
      // A readout, not a control: the tick rate is set by low-power detection
      // and the app preference, and clicking a number here to override it lied
      // about being sticky — the next detection pass put it straight back.
      this.el.input.innerHTML =
        `Input: ${info.tickRate} TPS`
        + (info.lowPowerMode ? ' <span style="color:#fa0">(low power)</span>' : '');
    }

    this._updateCensus();
    this._updateRects(info.pointTelemetry);
    this._updateTiles();
    this._updateOverlayToggles();
  }

  /**
   * Dirty-rect counts and point throughput — what the overlay used to paint as
   * its own box in the board's top-left corner.
   *
   * It reads from the overlay rather than counting anything itself, so the
   * numbers here and the rectangles on the board are always the same sample.
   * @private
   */
  _updateRects(pointTelemetry) {
    const host = this.el.rects;
    if (!host) return;

    const overlay = this.app?.debugOverlay;
    const rectStats = overlay?.getRectStats?.();
    const lines = [];

    if (rectStats) {
      lines.push(
        `Dirty rects: ${rectStats.liveRects}`
        + ` <span style="color:#888">(${rectStats.fullRedraws} full redraw${rectStats.fullRedraws === 1 ? '' : 's'})</span>`
      );
    } else if (overlay) {
      // getRectStats() withholds counts when it is not tracking, so say why
      // instead of printing a zero that reads as "the board is idle".
      lines.push('<span style="color:#555">Dirty rects: not tracked</span>');
    }

    if (pointTelemetry) {
      lines.push(
        `Points: ${Math.round(pointTelemetry.bufferedPerSec)}/s in`
        + ` &rarr; ${Math.round(pointTelemetry.outgoingPerSec)}/s out`
        + ` <span style="color:#888">(${Math.round(pointTelemetry.reductionPercent)}% reduced)</span>`
      );
    }

    host.innerHTML = lines.join('<br>');
  }

  /**
   * Total canvas backing store. The leading suspect for board-size lag and the
   * one cost no profiler shows, so it belongs on the panel rather than behind a
   * console call. Recomputed on the refresh tick, which is cheap: the walk is
   * over a few hundred object references and touches no pixels.
   * @private
   */
  _updateCensus() {
    const host = this.el.census;
    if (!host) return;

    const census = this._safeCensus();
    if (!census) {
      host.innerHTML = '';
      return;
    }

    const budgetColor = census.totalMB > 400 ? '#f00' : census.totalMB > 200 ? '#fa0' : '#0f0';
    const top = census.buckets.slice(0, 4)
      .map((b) => `${b.label.replace(/^(layers|dom|tools)\./, '')} ${b.mb.toFixed(0)}`)
      .join(' · ');

    host.innerHTML =
      `Canvas RAM: <span style="color:${budgetColor}">${census.totalMB.toFixed(0)} MB</span>`
      + ` <span style="color:#888">(${census.canvasCount} canvases, ${census.fullBoardCount} full-board)</span><br>`
      + `Board: ${census.boardWidth}x${census.boardHeight} = ${census.fullBoardMB.toFixed(1)} MB each<br>`
      + `<span style="color:#888; font-size:9px;">${top}</span><br>`
      + `<span data-el="censusDump" style="color:#0f0; cursor:pointer; text-decoration:underline; font-size:9px;">full breakdown &rarr; console</span>`;

    // Re-bound each refresh because this block is the one that still rebuilds
    // its markup; the node it targets does not survive the rewrite.
    host.querySelector('[data-el="censusDump"]')?.addEventListener('click', () => {
      try {
        logCanvasCensus(this.app);
      } catch (err) {
        console.warn('[DebugPanel] canvas census failed', err);
      }
    });
  }

  /**
   * Tiled backing store: counts, memory saved, and the per-tile occupancy map.
   * All property reads — no `getImageData` anywhere on this path.
   * @private
   */
  _updateTiles() {
    const body = this.el.tileBody;
    if (!body) return;

    const stats = collectTileStats(this.app);
    this.tileChurn.update(stats.tiled ? stats.occupancy : null);

    if (!stats.tiled) {
      // Tiling is opt-in per room and usually off, so say so plainly. An empty
      // grid rendered here would read as a broken visualisation.
      body.innerHTML =
        `<span style="color:#888">Not tiled &mdash; ${stats.reason}.</span><br>`
        + `<span style="color:#555; font-size:9px;">Full-board backing store: ${stats.nominalMB.toFixed(1)} MB.`
        + ` Enable per room, or from the console:<br>`
        + `app.board.layerManager.setTiledBackingStore(true)</span>`;
      if (this.el.tileMap) this.el.tileMap.style.display = 'none';
      if (this.el.tileActions) this.el.tileActions.style.display = 'none';
      return;
    }

    const churn = this.tileChurn.counts();
    const savedColor = stats.savedPercent > 50 ? '#0f0' : stats.savedPercent > 20 ? '#fa0' : '#f00';
    body.innerHTML =
      `Tiles: ${stats.allocatedTiles}/${stats.totalTiles} allocated`
      + ` <span style="color:#888">(${stats.cols}&times;${stats.rows} @${stats.tileSize}px)</span><br>`
      + `Memory: ${stats.allocatedMB.toFixed(1)} MB of ${stats.nominalMB.toFixed(1)} MB nominal`
      + ` <span style="color:${savedColor}">(${stats.savedPercent.toFixed(1)}% saved)</span><br>`
      + `<span style="color:#888">Last 1s: <span style="color:#5f8">+${churn.allocated}</span>`
      + ` / <span style="color:#f93">-${churn.freed}</span></span>`;

    this._drawTileMap(stats);

    if (this.el.tileActions) this.el.tileActions.style.display = 'block';
    if (this.el.compactNote) this.el.compactNote.textContent = this._compactNote;
  }

  /**
   * Compact map of the tile grid: one cell per tile, filled when allocated,
   * flashed when it changed state in the last second.
   * @private
   */
  _drawTileMap(stats) {
    const canvas = this.el.tileMap;
    if (!canvas) return;

    const cell = Math.max(MAP_MIN_CELL, Math.min(MAP_MAX_CELL, Math.floor(MAP_MAX_WIDTH / stats.cols)));
    const width = stats.cols * cell;
    const height = stats.rows * cell;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    canvas.style.display = 'block';

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fillRect(0, 0, width, height);

    const now = performance.now();
    for (let row = 0; row < stats.rows; row++) {
      for (let col = 0; col < stats.cols; col++) {
        const index = row * stats.cols + col;
        const x = col * cell;
        const y = row * cell;
        if (stats.occupancy[index] === 1) {
          ctx.fillStyle = 'rgba(80, 200, 255, 0.75)';
          ctx.fillRect(x, y, cell - 1, cell - 1);
        }
        const event = this.tileChurn.get(index, now);
        if (event) {
          ctx.fillStyle = event.allocated
            ? `rgba(90, 255, 140, ${event.fade})`
            : `rgba(255, 150, 60, ${event.fade})`;
          ctx.fillRect(x, y, cell - 1, cell - 1);
        }
      }
    }
  }

  /** @private */
  _updateOverlayToggles() {
    const overlay = this.app?.debugOverlay;
    const paint = (node, active) => {
      if (node) node.style.color = active ? '#0f0' : '#555';
    };
    paint(this.el.dirtyRectsToggle, !!overlay?.showDirtyRects);
    paint(this.el.tilesToggle, !!overlay?.showTiles);
  }

  /**
   * `compact()` sweeps every allocated tile with a pixel readback, so it stays
   * behind an explicit click and never runs on the refresh tick.
   * @private
   */
  _compact() {
    const tiled = getTiledLayerCanvas(this.app);
    if (!tiled) {
      this._compactNote = ' not tiled';
      this.update();
      return;
    }
    try {
      const released = tiled.compact();
      this._compactNote = ` released ${released}`;
    } catch (err) {
      console.warn('[DebugPanel] compact failed', err);
      this._compactNote = ' failed (see console)';
    }
    this.update();
  }

  /**
   * The census reaches into LayerManager internals, which are mid-mutation
   * during a stroke commit. A debug panel must never be able to take the app
   * down, so a failure degrades to hiding the row.
   *
   * @returns {Object|null}
   * @private
   */
  _safeCensus() {
    try {
      return collectCanvasCensus(this.app);
    } catch (err) {
      console.warn('[DebugPanel] canvas census failed', err);
      return null;
    }
  }

  destroy() {
    this._stopRefresh();
    this.panel?.remove();
    this.panel = null;
    this.el = {};
  }
}
