/**
 * @fileoverview Debug panel showing device detection, TPS, loop timings, and
 * overlay toggles.
 */

import { perfProbe } from '../utils/PerfProbe.js';

/** Rows shown in the loop-timing table, in display order. */
const PROBE_ROWS = [
  { name: 'composite.all', label: 'Composite' },
  { name: 'dirtyRects.resolve', label: 'Dirty rects' }
];

function fmtMs(value) {
  if (!Number.isFinite(value)) return '—';
  return value >= 100 ? value.toFixed(0) : value.toFixed(2);
}

function fmtInt(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString() : '—';
}

/** Green under a third of the frame budget, amber under one frame, else red. */
function loadColor(percent) {
  if (percent >= 50) return '#f44';
  if (percent >= 20) return '#fa0';
  return '#0f0';
}

export class PerformanceDebugPanel {
  constructor(inputBufferManager, app) {
    this.inputBufferManager = inputBufferManager;
    this.app = app;
    this.panel = null;
    this.enabled = false;
    this._metricsInterval = null;
  }

  init() {
    this.panel = document.createElement('div');
    this.panel.id = 'performanceDebugPanel';
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
      max-width: 430px;
      line-height: 1.6;
      pointer-events: auto;
      user-select: none;
    `;
    document.body.appendChild(this.panel);
  }

  toggle() {
    this.enabled = !this.enabled;
    if (this.panel) {
      this.panel.style.display = this.enabled ? 'block' : 'none';
    }
    if (this.enabled) {
      // Probes stay disabled until the panel is open so the release build pays
      // only a boolean check per call site.
      perfProbe.enable();
      this.update();
      this._startMetricsInterval();
    } else {
      perfProbe.disable();
      this._stopMetricsInterval();
    }
  }

  _startMetricsInterval() {
    this._stopMetricsInterval();
    this._metricsInterval = setInterval(() => this.update(), 500);
  }

  _stopMetricsInterval() {
    if (this._metricsInterval) {
      clearInterval(this._metricsInterval);
      this._metricsInterval = null;
    }
  }

  update() {
    if (!this.panel || !this.enabled) return;

    const info = this.inputBufferManager.getPerformanceInfo();
    const detection = info.detection;
    const debugOverlay = this.app?.debugOverlay;
    let html = '<strong>PERFORMANCE DEBUG</strong><br>';

    // TPS
    html += `Input TPS: <span id="tpsValue" style="color: ${info.tickRate === 60 ? '#f00' : '#0f0'}; cursor: pointer; text-decoration: underline;">${info.tickRate}</span> <span style="color:#888; font-size:9px;">(click to toggle)</span><br>`;
    html += `Low Power Mode: ${info.lowPowerMode ? 'YES' : '<span style="color:#888">no</span>'}<br>`;

    // Device detection
    if (detection && detection.score !== undefined) {
      html += '<br>';
      html += `Device Score: ${detection.score}<br>`;
      html += `Cores: ${detection.cores || 'N/A'} | Memory: ${detection.memory ?? 'N/A'} GB<br>`;
      html += `GPU: ${detection.renderer || 'unknown'}<br>`;
      html += `Max Texture: ${detection.maxTexture || 'N/A'}<br>`;
    }

    html += this._renderLoopTimings();

    // Debug overlay toggles
    if (debugOverlay) {
      html += '<br><strong>OVERLAYS:</strong><br>';
      html += this._overlayToggle('dirtyRectsToggle', 'Dirty Rects', debugOverlay.showDirtyRects);
      html += ' · ';
      html += this._overlayToggle('regionsToggle', 'Regions', debugOverlay.showRegions);
      html += ' · ';
      html += this._overlayToggle('pointsToggle', 'Points', debugOverlay.showStrokePoints);
      html += '<br>';
    }

    html += '<br><span style="color:#555">(Shift+P to toggle)</span>';

    this.panel.innerHTML = html;

    // TPS toggle
    this.panel.querySelector('#tpsValue')?.addEventListener('click', () => this.toggleTPS());

    this.panel.querySelector('#perfProbeReset')?.addEventListener('click', () => {
      perfProbe.reset();
      this.update();
    });

    // Overlay toggles
    if (debugOverlay) {
      this.panel.querySelector('#dirtyRectsToggle')?.addEventListener('click', () => {
        debugOverlay.toggleDirtyRects(); this.update();
      });
      this.panel.querySelector('#regionsToggle')?.addEventListener('click', () => {
        debugOverlay.toggleRegions(); this.update();
      });
      this.panel.querySelector('#pointsToggle')?.addEventListener('click', () => {
        debugOverlay.toggleStrokePoints(); this.update();
      });
    }
  }

  /**
   * Renders the loop-timing table plus the branch/escape-hatch tallies that
   * explain it. Board dimensions and tile-grid size are shown alongside because
   * they are the variables the timings are expected to track.
   * @private
   * @returns {string}
   */
  _renderLoopTimings() {
    const snap = perfProbe.snapshot();
    const byName = new Map(snap.entries.map((e) => [e.name, e]));
    const seconds = snap.elapsedMs / 1000;

    let html = '<br><strong>LOOP TIMINGS</strong>';
    html += ` <span id="perfProbeReset" style="color:#888; cursor:pointer; text-decoration:underline; font-size:9px;">reset</span>`;
    html += ` <span style="color:#555; font-size:9px;">${seconds.toFixed(1)}s window</span><br>`;

    const board = this.app?.board;
    if (board) {
      const w = board.getWidth?.() ?? 0;
      const h = board.getHeight?.() ?? 0;
      const grid = board.compositeTileGrid;
      html += `<span style="color:#888">Board:</span> ${w}×${h}`;
      if (grid) {
        html += ` <span style="color:#888">Grid:</span> ${grid.cols}×${grid.rows} `
          + `(${fmtInt(grid.cols * grid.rows)} tiles @${grid.tileSize}px)`;
      }
      const layers = board.layerManager?.getLayerCount?.();
      if (Number.isFinite(layers)) html += ` <span style="color:#888">Layers:</span> ${layers}`;
      html += '<br>';
    }

    html += '<table style="width:100%; border-collapse:collapse; font-size:10px; margin-top:4px;">';
    html += '<tr style="color:#888"><td>loop</td><td align="right">/s</td>'
      + '<td align="right">self</td><td align="right">max</td><td align="right">load</td></tr>';

    for (const row of PROBE_ROWS) {
      const entry = byName.get(row.name);
      if (!entry || entry.count === 0) {
        html += `<tr><td>${row.label}</td><td colspan="4" align="right" style="color:#555">no samples</td></tr>`;
        continue;
      }
      html += `<tr>`
        + `<td>${row.label}</td>`
        + `<td align="right">${entry.perSec.toFixed(0)}</td>`
        + `<td align="right">${fmtMs(entry.selfAvgMs)}ms</td>`
        + `<td align="right">${fmtMs(entry.maxMs)}ms</td>`
        + `<td align="right" style="color:${loadColor(entry.loadPercent)}">${entry.loadPercent.toFixed(1)}%</td>`
        + `</tr>`;
    }
    html += '</table>';

    const composite = byName.get('composite.all');
    if (composite?.tallies) {
      const t = composite.tallies;
      const drawn = t.fullRedraw + t.partial;
      const fullPct = drawn > 0 ? (t.fullRedraw / drawn) * 100 : 0;
      const avgLayers = composite.count > 0 ? t.layersComposited / composite.count : 0;
      html += `<span style="color:#888">Full redraws:</span> `
        + `<span style="color:${loadColor(fullPct)}">${fullPct.toFixed(0)}%</span> `
        + `(${fmtInt(t.fullRedraw)}/${fmtInt(drawn)}) `
        + `<span style="color:#888">skipped:</span> ${fmtInt(t.skipped)}<br>`;
      html += `<span style="color:#888">Paths:</span> split ${fmtInt(t.pathSplit)} · `
        + `full ${fmtInt(t.pathFull)} · eraseAll ${fmtInt(t.pathEraseAll)} `
        + `<span style="color:#888">avg layers:</span> ${avgLayers.toFixed(1)}<br>`;
    }

    const dirty = byName.get('dirtyRects.resolve');
    if (dirty?.tallies) {
      const t = dirty.tallies;
      // Calls that ran the run-length scan; the other outcomes early-out first.
      const scanned = Math.max(0, dirty.count - t.forceFull - t.clean - t.coverageBail);
      const wastePerScan = scanned > 0 ? t.tilesScanned / scanned : 0;
      const dirtyPerScan = scanned > 0 ? t.dirtyTiles / scanned : 0;
      const usefulPct = wastePerScan > 0 ? (dirtyPerScan / wastePerScan) * 100 : 0;
      html += `<span style="color:#888">Bail:</span> coverage ${fmtInt(t.coverageBail)} · `
        + `collapse ${fmtInt(t.rectCollapse)} · clean ${fmtInt(t.clean)} · `
        + `forceFull ${fmtInt(t.forceFull)}<br>`;
      html += `<span style="color:#888">Scans:</span> ${fmtInt(scanned)} × `
        + `${fmtInt(wastePerScan)} tiles, ${fmtInt(dirtyPerScan)} dirty `
        + `(<span style="color:${loadColor(100 - usefulPct)}">${usefulPct.toFixed(1)}% useful</span>)<br>`;
      const avgRects = scanned > 0 ? t.rectsEmitted / scanned : 0;
      html += `<span style="color:#888">Rects/scan:</span> ${avgRects.toFixed(1)}<br>`;
    }

    const ltColor = snap.longTaskCount > 0 ? '#fa0' : '#555';
    html += `<span style="color:#888">Long tasks:</span> `
      + `<span style="color:${ltColor}">${fmtInt(snap.longTaskCount)}</span>`
      + ` total ${fmtMs(snap.longTaskTotalMs)}ms max ${fmtMs(snap.longTaskMaxMs)}ms`;
    if (snap.longTaskCount >= 64) html += ' <span style="color:#555">(capped)</span>';
    html += '<br>';

    if (snap.overflows || snap.underflows) {
      html += `<span style="color:#f44">probe imbalance: `
        + `${snap.overflows} overflow / ${snap.underflows} underflow</span><br>`;
    }

    return html;
  }

  _overlayToggle(id, label, active) {
    const color = active ? '#0f0' : '#555';
    return `<span id="${id}" style="color:${color}; cursor:pointer; text-decoration:underline;">${label}</span>`;
  }

  toggleTPS() {
    const currentTPS = this.inputBufferManager.getCurrentTPS();
    const newTPS = currentTPS === 60 ? 30 : 60;
    this.inputBufferManager.setTickRate(newTPS);
    this.update();
  }

  destroy() {
    this._stopMetricsInterval();
    perfProbe.disable();
    this.panel?.remove();
    this.panel = null;
  }
}
