/**
 * @fileoverview Glitch Blur tool - identical to BlurTool but forces the
 * stackblur_rgba_glitch algorithm, producing a directional smear artifact.
 */

class Tool {
  constructor(name, board) {
    this.name = name;
    this.board = board;
  }
  activate() {}
  deactivate() {}
  onPointerDown(user, pos, e) {}
  onPointerMove(user, pos, lastPos, e) {}
  onPointerUp(user, pos, e) {}
}

export class GlitchBlurTool extends Tool {
  constructor(board) {
    super('glitchBlur', board);
    this.lastStampPos = new Map();
    this.strokePoints = new Map(); // userId -> [{x, y}, ...]
    this._prevGlitchSetting = false;
  }

  activate() {}

  deactivate() {
    if (this._activeUser) {
      const lastPos = this.lastStampPos.get(this._activeUser.id);
      if (lastPos) {
        this.onPointerUp(this._activeUser, lastPos);
      }
    }
    this.lastStampPos.clear();
    // Clear any lingering preview
    if (this.board.topCtx) {
      this.board.topCtx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }
    this._activeUser = null;
  }

  onPointerDown(user, pos) {
    this._activeUser = user;
    const activeLayerIdx = 0;
    const rawBlurRadius = Number(user.blurRadius);
    user.blurRadius = Math.max(1, Math.min(25, Number.isFinite(rawBlurRadius) ? rawBlurRadius : 10));

    const maskCtx = this.board.layerManager?.getUserStrokeContext(
      activeLayerIdx,
      user.id,
      user.blendMode || 'source-over',
      { filterType: 'glitchBlur', blurRadius: user.blurRadius }
    );
    if (!maskCtx) return;

    user.blurBounds = {
      minX: Infinity, minY: Infinity,
      maxX: -Infinity, maxY: -Infinity
    };

    // Get preview context and clear it once at the start
    let previewCtx = null;
    if (user === this.board.app?.self) {
      previewCtx = this.board.topCtx;
      previewCtx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    } else if (user.context) {
      previewCtx = user.context;
      previewCtx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    this.strokePoints.set(user.id, [{ x: pos.x, y: pos.y }]);
    this.paintMask(pos.x, pos.y, user.size, user, maskCtx, previewCtx);

    this.board.requestUpdate();
  }

  onPointerMove(user, pos, lastPos) {
    this._moveStroke(user, pos, true);
  }

  onPointerMoveNoRender(user, pos, lastPos) {
    this._moveStroke(user, pos, false);
  }

  _moveStroke(user, pos, shouldRender) {
    if (!user.mousedown || user.panning) return;

    const maskCtx = this.board.layerManager?.getUserStrokeContext(0, user.id);
    if (!maskCtx) return;

    const prevStamp = this.lastStampPos.get(user.id);
    if (prevStamp) {
      const dx = pos.x - prevStamp.x;
      const dy = pos.y - prevStamp.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const spacingPercent = user.spacing === 0 ? 0.1 : (user.spacing * 0.05);
      const minSpacing = Math.max(user.size * spacingPercent, 5);

      if (distance >= minSpacing) {
        // Get preview context once before stamping
        const previewCtx = shouldRender ? (user === this.board.app?.self ? this.board.topCtx : user.context) : null;
        this._stampAlongPath(user, prevStamp, pos, minSpacing, maskCtx, previewCtx);
        if (shouldRender) this.board.requestUpdate();
      }
    } else {
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    }
  }

  onPointerUp(user, pos) {
    const blurRadius = user.blurRadius || 10;
    const bounds = user.blurBounds || {
      minX: 0, minY: 0,
      maxX: this.board.getWidth(), maxY: this.board.getHeight()
    };

    const x = Math.max(0, Math.floor(bounds.minX));
    const y = Math.max(0, Math.floor(bounds.minY));
    const maxX = Math.min(this.board.getWidth(), Math.ceil(bounds.maxX));
    const maxY = Math.min(this.board.getHeight(), Math.ceil(bounds.maxY));

    // Track tile ownership
    const points = this.strokePoints.get(user.id);
    if (points && points.length > 0) {
      this.board.markDirtyPath(user, points, user.size);
      this.board.forEachMirrorRegion({ points }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(points, region), user.size);
      });
    }
    this.strokePoints.delete(user.id);

    this.board.endStroke(user, {
      filterType: 'glitchBlur',
      blurRadius,
      cropBounds: { x, y, width: maxX - x, height: maxY - y }
    });

    this.lastStampPos.delete(user.id);
    delete user.blurBounds;

    // Clear preview
    if (user === this.board.app?.self) {
      this.board.topCtx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    this.board.requestUpdate();
  }

  paintMask(x, y, size, user, maskCtx, previewCtx) {
    const radius = size;
    const blurRadius = user.blurRadius || 10;

    maskCtx.save();
    maskCtx.globalCompositeOperation = 'source-over';
    maskCtx.globalAlpha = 1.0;
    maskCtx.fillStyle = '#ffffff';
    maskCtx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    maskCtx.restore();

    const margin = Math.ceil(blurRadius * 2);
    const left = Math.floor(x - radius - margin);
    const top = Math.floor(y - radius - margin);
    const width = Math.ceil((radius + margin) * 2);
    const height = Math.ceil((radius + margin) * 2);
    this.board.expandDirtyRect(user, left, top, width, height);

    if (user.blurBounds) {
      user.blurBounds.minX = Math.min(user.blurBounds.minX, left);
      user.blurBounds.minY = Math.min(user.blurBounds.minY, top);
      user.blurBounds.maxX = Math.max(user.blurBounds.maxX, left + width);
      user.blurBounds.maxY = Math.max(user.blurBounds.maxY, top + height);
    }

    // Draw preview stamp immediately (incremental rendering)
    if (previewCtx) {
      this._drawStampPreview(previewCtx, x, y, radius, user.pressure || 1.0);
    }
  }

  _stampAlongPath(user, from, to, spacing, maskCtx, previewCtx) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (!Number.isFinite(distance) || distance <= 0) return;

    const steps = Math.floor(distance / spacing);
    const points = this.strokePoints.get(user.id);
    let lastStamp = from;

    for (let i = 1; i <= steps; i++) {
      const t = (i * spacing) / distance;
      const x = from.x + dx * t;
      const y = from.y + dy * t;
      this.paintMask(x, y, user.size, user, maskCtx, previewCtx);
      points?.push({ x, y });
      lastStamp = { x, y };
    }

    this.lastStampPos.set(user.id, lastStamp);
  }

  /**
   * Draws a single preview stamp with glitch-like directional smear effect
   * @param {CanvasRenderingContext2D} ctx - Context to draw on
   * @param {number} x - Center x-coordinate
   * @param {number} y - Center y-coordinate
   * @param {number} size - Radius/half-width of the stamp
   * @param {number} pressure - Pressure value (0-1)
   */
  _drawStampPreview(ctx, x, y, size, pressure) {
    const alpha = pressure * 0.3;

    ctx.save();

    // Draw the stamp as a square with directional gradient to simulate glitch
    const gradient = ctx.createLinearGradient(x - size, y, x + size, y);
    gradient.addColorStop(0, `rgba(128, 128, 128, 0)`);
    gradient.addColorStop(0.3, `rgba(128, 128, 128, ${alpha})`);
    gradient.addColorStop(0.7, `rgba(128, 128, 128, ${alpha})`);
    gradient.addColorStop(1, `rgba(128, 128, 128, 0)`);

    ctx.fillStyle = gradient;
    ctx.fillRect(x - size, y - size, size * 2, size * 2);

    // Add a subtle outline to show the stamp boundary
    ctx.strokeStyle = `rgba(100, 100, 100, ${alpha * 0.5})`;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - size, y - size, size * 2, size * 2);

    ctx.restore();
  }
}
