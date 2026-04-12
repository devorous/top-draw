/**
 * @fileoverview Debug panel showing device detection, TPS, and overlay toggles.
 */

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
      max-width: 300px;
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
      this.update();
      this._startMetricsInterval();
    } else {
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
    this.panel?.remove();
    this.panel = null;
  }
}
