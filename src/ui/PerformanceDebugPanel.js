/**
 * @fileoverview Simple performance debug panel showing device detection and TPS info.
 */

export class PerformanceDebugPanel {
  constructor(inputBufferManager, app) {
    this.inputBufferManager = inputBufferManager;
    this.app = app;
    this.panel = null;
    this.enabled = false;
    this.tpsDisplay = null;
  }

  /**
   * Initialize the debug panel (create DOM elements).
   */
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
      line-height: 1.4;
      pointer-events: auto;
      user-select: none;
    `;
    document.body.appendChild(this.panel);
  }

  /**
   * Toggle the debug panel visibility.
   */
  toggle() {
    this.enabled = !this.enabled;
    if (this.panel) {
      this.panel.style.display = this.enabled ? 'block' : 'none';
      if (this.enabled) {
        this.update();
      }
    }
    console.log('[PerformanceDebugPanel]', this.enabled ? 'Enabled' : 'Disabled');
  }

  /**
   * Update the panel content with current performance info.
   */
  update() {
    if (!this.panel || !this.enabled) return;

    const info = this.inputBufferManager.getPerformanceInfo();
    const detection = info.detection;
    const debugOverlay = this.app?.debugOverlay;

    let html = '<strong>PERFORMANCE DEBUG</strong><br>';
    html += `TPS: <span id="tpsValue" style="color: ${info.tickRate === 60 ? '#f00' : '#0f0'}; cursor: pointer; text-decoration: underline;">${info.tickRate}</span> <span style="font-size: 9px;">(click to toggle)</span><br>`;
    html += `Low Power Mode: ${info.lowPowerMode ? 'YES' : 'NO'}<br>`;
    html += '<br>';

    if (detection && detection.score !== undefined) {
      html += `Device Score: ${detection.score}<br>`;
      html += `Cores: ${detection.cores || 'N/A'}<br>`;
      html += `Memory: ${detection.memory ?? 'N/A'} GB<br>`;
      html += `GPU: ${detection.renderer || 'unknown'}<br>`;
      html += `Max Texture: ${detection.maxTexture || 'N/A'}<br>`;
      html += `Vertex Units: ${detection.maxVertexUnits || 'N/A'}<br>`;
    }

    html += '<br><strong>DEBUG OVERLAYS:</strong><br>';
    if (debugOverlay) {
      const dirtyRectsColor = debugOverlay.showDirtyRects ? '#0f0' : '#888';
      const regionsColor = debugOverlay.showRegions ? '#0f0' : '#888';
      const pointsColor = debugOverlay.showStrokePoints ? '#0f0' : '#888';

      html += `<span id="dirtyRectsToggle" style="color: ${dirtyRectsColor}; cursor: pointer; text-decoration: underline;">Dirty Rects</span><br>`;
      html += `<span id="regionsToggle" style="color: ${regionsColor}; cursor: pointer; text-decoration: underline;">Regions</span><br>`;
      html += `<span id="pointsToggle" style="color: ${pointsColor}; cursor: pointer; text-decoration: underline;">Stroke Points</span><br>`;
    }

    html += '<br>';
    html += '<small>(Press Shift+P to toggle panel)</small>';

    this.panel.innerHTML = html;

    // Attach click handlers
    const tpsValue = this.panel.querySelector('#tpsValue');
    if (tpsValue) {
      tpsValue.addEventListener('click', () => this.toggleTPS());
    }

    if (debugOverlay) {
      const dirtyRectsToggle = this.panel.querySelector('#dirtyRectsToggle');
      if (dirtyRectsToggle) {
        dirtyRectsToggle.addEventListener('click', () => {
          debugOverlay.toggleDirtyRects();
          this.update();
        });
      }

      const regionsToggle = this.panel.querySelector('#regionsToggle');
      if (regionsToggle) {
        regionsToggle.addEventListener('click', () => {
          debugOverlay.toggleRegions();
          this.update();
        });
      }

      const pointsToggle = this.panel.querySelector('#pointsToggle');
      if (pointsToggle) {
        pointsToggle.addEventListener('click', () => {
          debugOverlay.toggleStrokePoints();
          this.update();
        });
      }
    }
  }

  /**
   * Toggle TPS between 30 and 60.
   */
  toggleTPS() {
    const currentTPS = this.inputBufferManager.getCurrentTPS();
    const newTPS = currentTPS === 60 ? 30 : 60;
    this.inputBufferManager.setTickRate(newTPS);
    console.log(`[PerformanceDebugPanel] TPS changed: ${currentTPS} → ${newTPS}`);
    this.update();
  }

  /**
   * Destroy the panel.
   */
  destroy() {
    if (this.panel) {
      this.panel.remove();
      this.panel = null;
    }
  }
}
