/**
 * @fileoverview Interactive flow for creating and editing shared mirror regions.
 */

export class MirrorRegionController {
  /**
   * @param {Object} app
   */
  constructor(app) {
    this.app = app;
    this.board = app.board;
    this.ui = app.ui;
    this.wsClient = app.wsClient;

    this.active = false;
    this.stage = 'idle';
    this.startPos = null;
    this.selection = null;
    this.editingRegionId = null;
    this.marchingAntsOffset = 0;
    this.animationId = null;
    this.options = {
      axis: 'vertical',
      showLine: true
    };

    this.overlayCanvas = null;
    this.overlayCtx = null;
    this.panel = null;
    this.controlsLayer = null;
    this.panelTitle = null;
    this.panelDescription = null;
    this.applyButton = null;
  }

  init() {
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.id = 'mirrorRegionOverlay';
    this.overlayCanvas.style.position = 'absolute';
    this.overlayCanvas.style.top = '0';
    this.overlayCanvas.style.left = '0';
    this.overlayCanvas.style.pointerEvents = 'none';
    this.overlayCanvas.style.zIndex = '4';
    this.overlayCanvas.width = this.board.getWidth();
    this.overlayCanvas.height = this.board.getHeight();
    this.board.boardsWrapper.appendChild(this.overlayCanvas);
    this.overlayCtx = this.overlayCanvas.getContext('2d');

    this.controlsLayer = document.createElement('div');
    this.controlsLayer.id = 'mirrorRegionControls';
    this.controlsLayer.style.position = 'absolute';
    this.controlsLayer.style.top = '0';
    this.controlsLayer.style.left = '0';
    this.controlsLayer.style.width = '100%';
    this.controlsLayer.style.height = '100%';
    this.controlsLayer.style.pointerEvents = 'none';
    this.controlsLayer.style.zIndex = '5';
    this.controlsLayer.style.display = 'none';
    this.board.boardsWrapper.appendChild(this.controlsLayer);

    this.panel = document.createElement('div');
    this.panel.id = 'mirrorRegionPanel';
    this.panel.style.position = 'absolute';
    this.panel.style.zIndex = '60';
    this.panel.style.display = 'none';
    this.panel.style.minWidth = '220px';
    this.panel.style.padding = '12px';
    this.panel.style.borderRadius = '10px';
    this.panel.style.border = '1px solid rgba(255, 255, 255, 0.08)';
    this.panel.style.background = 'rgba(19, 23, 29, 0.96)';
    this.panel.style.boxShadow = '0 10px 28px rgba(0, 0, 0, 0.35)';
    this.panel.style.backdropFilter = 'blur(12px)';
    this.panel.innerHTML = `
      <div data-role="mirror-panel-title" style="font-size:12px;font-weight:600;color:#f3f6fb;margin-bottom:8px;">Mirror Region</div>
      <div data-role="mirror-panel-description" style="font-size:11px;color:rgba(255,255,255,0.6);margin-bottom:10px;">Choose how this area reflects strokes.</div>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:6px;">
        <input type="radio" name="mirrorRegionAxis" value="vertical" checked />
        Vertical
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:6px;">
        <input type="radio" name="mirrorRegionAxis" value="horizontal" />
        Horizontal
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:6px;">
        <input type="radio" name="mirrorRegionAxis" value="quad" />
        Quad
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:10px;">
        <input type="radio" name="mirrorRegionAxis" value="rotational" />
        Rotational
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:12px;">
        <input type="checkbox" name="mirrorRegionShowLine" checked />
        Show center line
      </label>
      <div style="display:flex;gap:8px;">
        <button type="button" data-action="cancel" class="btn" style="flex:1;">Close</button>
        <button type="button" data-action="apply" class="btn" style="flex:1;">Apply</button>
      </div>
    `;
    this.ui.elements.boardContainer.appendChild(this.panel);

    this.panelTitle = this.panel.querySelector('[data-role="mirror-panel-title"]');
    this.panelDescription = this.panel.querySelector('[data-role="mirror-panel-description"]');
    this.applyButton = this.panel.querySelector('[data-action="apply"]');

    this.panel.querySelectorAll('input[name="mirrorRegionAxis"]').forEach(input => {
      input.addEventListener('change', () => {
        this.options.axis = input.value;
        this._drawSelection();
        this._refreshRegionControls();
      });
    });
    this.panel.querySelector('input[name="mirrorRegionShowLine"]').addEventListener('change', (e) => {
      this.options.showLine = !!e.target.checked;
      this._drawSelection();
      this._refreshRegionControls();
    });
    this.panel.querySelector('[data-action="cancel"]').addEventListener('click', () => this._handlePanelCancel());
    this.panel.querySelector('[data-action="apply"]').addEventListener('click', () => this.apply());

    this.board.onMirrorRegionsChange = () => {
      this._refreshRegionControls();
      if (this.active && this.editingRegionId && !this._getRegionById(this.editingRegionId)) {
        this._resetSelectionState();
      }
    };
  }

  begin() {
    if (this.active) {
      this.cancel();
      return;
    }

    this.active = true;
    this.stage = 'selecting';
    this.ui.updateMirrorDisplay(true);
    this.startPos = null;
    this.selection = null;
    this.editingRegionId = null;
    this.options = { axis: 'vertical', showLine: true };
    this._showControlsLayer();
    this._refreshRegionControls();
    this._showMirrorCursor();
    this._hidePanel();
    this._clearOverlay();
    this._startMarchingAnts();
    this.ui.showToast('Drag to add a mirror region, or use the region controls to edit/remove one.', 2200);
  }

  cancel() {
    this.active = false;
    this.stage = 'idle';
    this._resetSelectionState();
    this._hidePanel();
    this._clearOverlay();
    this._hideControlsLayer();
    this._stopMarchingAnts();
    this.ui.updateMirrorDisplay(this.board.mirror);
    this.ui.updateToolDisplay(this.app.self?.tool, this.app.self);
  }

  isActive() {
    return this.active;
  }

  handlePointerDown(e) {
    if (!this.active) return false;
    if (this.stage !== 'selecting' || e.button !== 0) return true;
    const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
    this.ui.updateSelfCursor(pos.x, pos.y, this.app.self?.size || 1);
    this.startPos = pos;
    this.selection = { x: pos.x, y: pos.y, width: 0, height: 0 };
    this.editingRegionId = null;
    this._hidePanel();
    this._drawSelection();
    return true;
  }

  handlePointerMove(e) {
    if (!this.active) return false;
    const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
    this._showMirrorCursor();
    this.ui.updateSelfCursor(pos.x, pos.y, this.app.self?.size || 1);
    if (this.stage !== 'selecting' || !this.startPos) return true;
    const x = Math.min(this.startPos.x, pos.x);
    const y = Math.min(this.startPos.y, pos.y);
    const width = Math.abs(pos.x - this.startPos.x);
    const height = Math.abs(pos.y - this.startPos.y);
    this.selection = { x, y, width, height };
    this._drawSelection();
    return true;
  }

  handlePointerUp(e) {
    if (!this.active) return false;
    if (this.stage !== 'selecting' || e.button !== 0 || !this.selection) return true;
    if (this.selection.width < 4 || this.selection.height < 4) {
      this.ui.showToast('Mirror region is too small', 1800);
      this._resetSelectionState();
      this._clearOverlay();
      return true;
    }
    this.startPos = null;
    this.stage = 'configuring';
    this._configurePanelForCreate();
    this._showPanel();
    this._drawSelection();
    return true;
  }

  apply() {
    if (!this.selection) return;

    const region = {
      id: this.editingRegionId || `mr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      x: Math.floor(this.selection.x),
      y: Math.floor(this.selection.y),
      width: Math.max(1, Math.floor(this.selection.width)),
      height: Math.max(1, Math.floor(this.selection.height)),
      mode: this.options.axis,
      axis: this.options.axis,
      showLine: this.options.showLine,
      owner: this.app.self?.id || null
    };

    if (this.editingRegionId) {
      const nextRegions = (this.board.mirrorRegions || []).map(existing =>
        existing.id === this.editingRegionId ? { ...existing, ...region } : existing
      );
      this.board.setMirrorRegions(nextRegions);
      if (this.wsClient?.connected) {
        this.wsClient.broadcastMirrorRegion({ action: 'update', region });
      }
      this.ui.showToast('Mirror region updated', 1800);
    } else {
      this.board.setMirrorRegions([...(this.board.mirrorRegions || []), region]);
      if (this.wsClient?.connected) {
        this.wsClient.broadcastMirrorRegion({ action: 'create', region });
      }
      this.ui.showToast('Mirror region applied', 1800);
    }

    this.cancel();
  }

  startEditingRegion(regionId) {
    const region = this._getRegionById(regionId);
    if (!region) return;

    this.active = true;
    this.stage = 'configuring';
    this.startPos = null;
    this.selection = {
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height
    };
    this.editingRegionId = region.id;
    this.options = {
      axis: region.mode || region.axis || 'vertical',
      showLine: region.showLine !== false
    };

    this._showControlsLayer();
    this._showMirrorCursor();
    this._configurePanelForEdit();
    this._showPanel();
    this._startMarchingAnts();
    this._drawSelection();
  }

  removeRegion(regionId) {
    const nextRegions = (this.board.mirrorRegions || []).filter(region => region.id !== regionId);
    this.board.setMirrorRegions(nextRegions);
    if (this.wsClient?.connected) {
      this.wsClient.broadcastMirrorRegion({ action: 'remove', id: regionId });
    }
    if (this.editingRegionId === regionId) {
      this._resetSelectionState();
      this._hidePanel();
      this._clearOverlay();
      this.stage = 'selecting';
    }
    this.ui.showToast('Mirror region removed', 1800);
  }

  _handlePanelCancel() {
    this._resetSelectionState();
    this._hidePanel();
    this._clearOverlay();
    this.stage = 'selecting';
  }

  _resetSelectionState() {
    this.stage = this.active ? 'selecting' : 'idle';
    this.startPos = null;
    this.selection = null;
    this.editingRegionId = null;
    this.options = { axis: 'vertical', showLine: true };
  }

  _showPanel() {
    this.panel.style.display = 'block';
    const axisInput = this.panel.querySelector(`input[name="mirrorRegionAxis"][value="${this.options.axis}"]`);
    if (axisInput) axisInput.checked = true;
    const lineInput = this.panel.querySelector('input[name="mirrorRegionShowLine"]');
    if (lineInput) lineInput.checked = this.options.showLine;
    this._positionPanelNearSelection();
  }

  _positionPanelNearSelection() {
    if (!this.selection) {
      this.panel.style.right = '12px';
      this.panel.style.top = '108px';
      this.panel.style.left = '';
      return;
    }

    // Convert the selection's right edge from board coords to container coords
    const board = this.board;
    const bx = this.selection.x + this.selection.width;
    const by = this.selection.y;

    // Board → container: zoom, rotate, then pan
    const sx = bx * board.zoom;
    const sy = by * board.zoom;
    const rad = board.rotation * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rx = sx * cos - sy * sin;
    const ry = sx * sin + sy * cos;
    let cx = rx + board.panX;
    let cy = ry + board.panY;

    const containerRect = board.container.getBoundingClientRect();
    const panelWidth = this.panel.offsetWidth || 220;
    const panelHeight = this.panel.offsetHeight || 260;
    const margin = 12;

    // Place to the right of the region edge; if it overflows, place to the left
    let left = cx + margin;
    if (left + panelWidth > containerRect.width) {
      // Try left side of the region
      const leftEdgeX = this.selection.x * board.zoom;
      const lrx = leftEdgeX * cos - sy * sin;
      const lcx = lrx + board.panX;
      left = lcx - panelWidth - margin;
    }
    // Clamp horizontal
    left = Math.max(margin, Math.min(left, containerRect.width - panelWidth - margin));

    // Clamp vertical
    let top = Math.max(margin, Math.min(cy, containerRect.height - panelHeight - margin));

    this.panel.style.left = `${left}px`;
    this.panel.style.top = `${top}px`;
    this.panel.style.right = '';
  }

  _hidePanel() {
    if (this.panel) this.panel.style.display = 'none';
  }

  _showControlsLayer() {
    if (this.controlsLayer) this.controlsLayer.style.display = 'block';
  }

  _hideControlsLayer() {
    if (this.controlsLayer) {
      this.controlsLayer.style.display = 'none';
      this.controlsLayer.innerHTML = '';
    }
  }

  _clearOverlay() {
    if (this.overlayCtx) {
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    }
  }

  _startMarchingAnts() {
    if (this.animationId) return;
    const step = () => {
      this.marchingAntsOffset = (this.marchingAntsOffset + 0.75) % 16;
      if (this.selection) this._drawSelection();
      this.animationId = requestAnimationFrame(step);
    };
    this.animationId = requestAnimationFrame(step);
  }

  _stopMarchingAnts() {
    if (!this.animationId) return;
    cancelAnimationFrame(this.animationId);
    this.animationId = null;
  }

  _drawSelection() {
    if (!this.overlayCtx || !this.selection) return;

    const ctx = this.overlayCtx;
    const s = this.selection;
    this._clearOverlay();

    ctx.save();
    ctx.fillStyle = 'rgba(8, 10, 14, 0.2)';
    ctx.fillRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    ctx.clearRect(s.x, s.y, s.width, s.height);

    ctx.setLineDash([6, 6]);
    ctx.lineDashOffset = -this.marchingAntsOffset;
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.width, s.height);

    ctx.lineDashOffset = -(this.marchingAntsOffset + 6);
    ctx.strokeStyle = '#0d0d0d';
    ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.width, s.height);

    if (this.options.showLine) {
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 0.75;
      ctx.strokeStyle = 'rgba(0, 212, 170, 0.95)';
      this._drawModeGuides(ctx, s, this.options.axis);
    }

    ctx.restore();
  }

  _drawModeGuides(ctx, selection, axis) {
    ctx.beginPath();
    if (axis === 'horizontal') {
      const cy = selection.y + selection.height / 2;
      ctx.moveTo(selection.x, cy);
      ctx.lineTo(selection.x + selection.width, cy);
    } else if (axis === 'vertical') {
      const cx = selection.x + selection.width / 2;
      ctx.moveTo(cx, selection.y);
      ctx.lineTo(cx, selection.y + selection.height);
    } else {
      const cx = selection.x + selection.width / 2;
      const cy = selection.y + selection.height / 2;
      ctx.moveTo(cx, selection.y);
      ctx.lineTo(cx, selection.y + selection.height);
      ctx.moveTo(selection.x, cy);
      ctx.lineTo(selection.x + selection.width, cy);
    }
    ctx.stroke();
  }

  _refreshRegionControls() {
    if (!this.controlsLayer || !this.active) return;

    this.controlsLayer.innerHTML = '';
    for (const region of this.board.mirrorRegions || []) {
      this.controlsLayer.appendChild(this._createRegionControl(region));
    }
  }

  _createRegionControl(region) {
    const wrapper = document.createElement('div');
    wrapper.style.position = 'absolute';
    wrapper.style.left = `${region.x + region.width - 58}px`;
    wrapper.style.top = `${Math.max(0, region.y + 6)}px`;
    wrapper.style.display = 'flex';
    wrapper.style.gap = '6px';
    wrapper.style.pointerEvents = 'none';

    wrapper.appendChild(this._createControlButton('Edit', () => this.startEditingRegion(region.id), 'rgba(17,24,39,0.92)'));
    wrapper.appendChild(this._createControlButton('X', () => this.removeRegion(region.id), 'rgba(127,29,29,0.95)'));

    return wrapper;
  }

  _createControlButton(label, onClick, background) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.pointerEvents = 'auto';
    button.style.minWidth = label === 'X' ? '24px' : '42px';
    button.style.height = '24px';
    button.style.padding = label === 'X' ? '0' : '0 8px';
    button.style.border = '1px solid rgba(255,255,255,0.18)';
    button.style.borderRadius = '999px';
    button.style.background = background;
    button.style.color = '#f8fafc';
    button.style.fontSize = '11px';
    button.style.cursor = 'pointer';
    button.style.boxShadow = '0 4px 12px rgba(0,0,0,0.25)';
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return button;
  }

  _configurePanelForCreate() {
    if (this.panelTitle) this.panelTitle.textContent = 'Mirror Region';
    if (this.panelDescription) this.panelDescription.textContent = 'Choose how this area reflects strokes.';
    if (this.applyButton) this.applyButton.textContent = 'Apply';
  }

  _configurePanelForEdit() {
    if (this.panelTitle) this.panelTitle.textContent = 'Edit Mirror Region';
    if (this.panelDescription) this.panelDescription.textContent = 'Adjust how this region reflects strokes.';
    if (this.applyButton) this.applyButton.textContent = 'Save';
  }

  _showMirrorCursor() {
    this.ui.showCursor();
    this.ui.showMirrorRegionCursor();
  }

  _getRegionById(regionId) {
    return (this.board.mirrorRegions || []).find(region => region.id === regionId) || null;
  }
}
