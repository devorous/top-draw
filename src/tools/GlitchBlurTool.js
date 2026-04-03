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
    user.blurRadius = user.blurRadius || 10;

    const maskCtx = this.board.layerManager?.getUserStrokeContext(
      activeLayerIdx,
      user.id,
      'source-over',
      { filterType: 'glitchBlur', blurRadius: user.blurRadius }
    );
    if (!maskCtx) return;

    user.blurBounds = {
      minX: Infinity, minY: Infinity,
      maxX: -Infinity, maxY: -Infinity
    };

    // Initialize stamps array for preview
    user.glitchStamps = [];

    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    this.strokePoints.set(user.id, [{ x: pos.x, y: pos.y }]);
    this.paintMask(pos.x, pos.y, user.size, user, maskCtx);

    // Draw initial preview
    if (user === this.board.app?.self) {
      this.board.topCtx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
      this.drawPreview(user);
    }

    this.board.requestUpdate();
  }

  onPointerMove(user, pos, lastPos) {
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
        this.paintMask(pos.x, pos.y, user.size, user, maskCtx);
        this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
        const points = this.strokePoints.get(user.id);
        if (points) points.push({ x: pos.x, y: pos.y });
        this.board.requestUpdate();
      }
    } else {
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    }

    // Draw preview for local user
    if (user === this.board.app?.self) {
      this.drawPreview(user);
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
    delete user.glitchStamps;

    // Clear preview
    if (user === this.board.app?.self) {
      this.board.topCtx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    this.board.requestUpdate();
  }

  paintMask(x, y, size, user, maskCtx) {
    const radius = size;
    const blurRadius = user.blurRadius || 10;

    maskCtx.save();
    maskCtx.globalCompositeOperation = 'source-over';
    maskCtx.globalAlpha = user.pressure || 1.0;
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

    // Track stamps for preview
    if (!user.glitchStamps) user.glitchStamps = [];
    user.glitchStamps.push({ x, y, size: radius, pressure: user.pressure || 1.0 });
  }

  /**
   * Draws a preview of the glitch blur stamps on the given context
   * @param {Object} user - The user object
   * @param {CanvasRenderingContext2D} [ctx] - Context to draw on (defaults to topCtx for local user)
   */
  drawPreview(user, ctx) {
    if (!user.glitchStamps || user.glitchStamps.length === 0) return;

    const previewCtx = ctx || this.board.topCtx;
    const blurRadius = user.blurRadius || 10;

    previewCtx.save();

    // Draw each stamp with a glitch-like directional smear effect
    for (const stamp of user.glitchStamps) {
      const { x, y, size, pressure } = stamp;
      const alpha = pressure * 0.3;

      // Draw the stamp as a square with directional gradient to simulate glitch
      const gradient = previewCtx.createLinearGradient(x - size, y, x + size, y);
      gradient.addColorStop(0, `rgba(128, 128, 128, 0)`);
      gradient.addColorStop(0.3, `rgba(128, 128, 128, ${alpha})`);
      gradient.addColorStop(0.7, `rgba(128, 128, 128, ${alpha})`);
      gradient.addColorStop(1, `rgba(128, 128, 128, 0)`);

      previewCtx.fillStyle = gradient;
      previewCtx.fillRect(x - size, y - size, size * 2, size * 2);

      // Add a subtle outline to show the stamp boundary
      previewCtx.strokeStyle = `rgba(100, 100, 100, ${alpha * 0.5})`;
      previewCtx.lineWidth = 1;
      previewCtx.strokeRect(x - size, y - size, size * 2, size * 2);
    }

    previewCtx.restore();
  }
}
