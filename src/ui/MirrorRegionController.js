/**
 * @fileoverview Interactive flow for creating shared mirror regions.
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
    this.marchingAntsOffset = 0;
    this.animationId = null;
    this.options = {
      axis: 'vertical',
      showLine: true
    };

    this.overlayCanvas = null;
    this.overlayCtx = null;
    this.panel = null;
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

    this.panel = document.createElement('div');
    this.panel.id = 'mirrorRegionPanel';
    this.panel.style.position = 'absolute';
    this.panel.style.right = '12px';
    this.panel.style.top = '108px';
    this.panel.style.zIndex = '60';
    this.panel.style.display = 'none';
    this.panel.style.minWidth = '200px';
    this.panel.style.padding = '12px';
    this.panel.style.borderRadius = '10px';
    this.panel.style.border = '1px solid rgba(255, 255, 255, 0.08)';
    this.panel.style.background = 'rgba(19, 23, 29, 0.96)';
    this.panel.style.boxShadow = '0 10px 28px rgba(0, 0, 0, 0.35)';
    this.panel.style.backdropFilter = 'blur(12px)';
    this.panel.innerHTML = `
      <div style="font-size:12px;font-weight:600;color:#f3f6fb;margin-bottom:8px;">Mirror Region</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.6);margin-bottom:10px;">Choose how this area reflects strokes.</div>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:6px;">
        <input type="radio" name="mirrorRegionAxis" value="vertical" checked />
        Vertical
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:10px;">
        <input type="radio" name="mirrorRegionAxis" value="horizontal" />
        Horizontal
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:12px;">
        <input type="checkbox" name="mirrorRegionShowLine" checked />
        Show center line
      </label>
      <div style="display:flex;gap:8px;">
        <button type="button" data-action="cancel" class="btn" style="flex:1;">Cancel</button>
        <button type="button" data-action="apply" class="btn" style="flex:1;">Apply</button>
      </div>
    `;
    this.ui.elements.boardContainer.appendChild(this.panel);

    this.panel.querySelectorAll('input[name="mirrorRegionAxis"]').forEach(input => {
      input.addEventListener('change', () => {
        this.options.axis = input.value;
        this._drawSelection();
      });
    });
    this.panel.querySelector('input[name="mirrorRegionShowLine"]').addEventListener('change', (e) => {
      this.options.showLine = !!e.target.checked;
      this._drawSelection();
    });
    this.panel.querySelector('[data-action="cancel"]').addEventListener('click', () => this.cancel());
    this.panel.querySelector('[data-action="apply"]').addEventListener('click', () => this.apply());
  }

  begin() {
    this.cancel();
    this.active = true;
    this.stage = 'selecting';
    this.ui.showToast('Drag out a mirror region');
    this._startMarchingAnts();
  }

  cancel() {
    this.active = false;
    this.stage = 'idle';
    this.startPos = null;
    this.selection = null;
    this.options = { axis: 'vertical', showLine: true };
    this._hidePanel();
    this._clearOverlay();
    this._stopMarchingAnts();
  }

  isActive() {
    return this.active;
  }

  handlePointerDown(e) {
    if (!this.active) return false;
    if (this.stage !== 'selecting' || e.button !== 0) return true;
    const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
    this.startPos = pos;
    this.selection = { x: pos.x, y: pos.y, width: 0, height: 0 };
    this._drawSelection();
    return true;
  }

  handlePointerMove(e) {
    if (!this.active) return false;
    if (this.stage !== 'selecting' || !this.startPos) return true;
    const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
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
      this.startPos = null;
      this.selection = null;
      this._clearOverlay();
      return true;
    }
    this.startPos = null;
    this.stage = 'configuring';
    this._showPanel();
    this._drawSelection();
    return true;
  }

  apply() {
    if (!this.selection) return;

    const region = {
      id: `mr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      x: Math.floor(this.selection.x),
      y: Math.floor(this.selection.y),
      width: Math.max(1, Math.floor(this.selection.width)),
      height: Math.max(1, Math.floor(this.selection.height)),
      axis: this.options.axis,
      showLine: this.options.showLine,
      owner: this.app.self?.id || null
    };

    this.board.setMirrorRegions([...(this.board.mirrorRegions || []), region]);
    if (this.wsClient?.connected) {
      this.wsClient.broadcastMirrorRegion({ action: 'create', region });
    }
    this.ui.showToast('Mirror region applied', 1800);
    this.cancel();
  }

  _showPanel() {
    this.panel.style.display = 'block';
    const axisInput = this.panel.querySelector(`input[name="mirrorRegionAxis"][value="${this.options.axis}"]`);
    if (axisInput) axisInput.checked = true;
    const lineInput = this.panel.querySelector('input[name="mirrorRegionShowLine"]');
    if (lineInput) lineInput.checked = this.options.showLine;
  }

  _hidePanel() {
    if (this.panel) this.panel.style.display = 'none';
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
      ctx.beginPath();
      if (this.options.axis === 'horizontal') {
        const cy = s.y + s.height / 2;
        ctx.moveTo(s.x, cy);
        ctx.lineTo(s.x + s.width, cy);
      } else {
        const cx = s.x + s.width / 2;
        ctx.moveTo(cx, s.y);
        ctx.lineTo(cx, s.y + s.height);
      }
      ctx.stroke();
    }

    ctx.restore();
  }
}
