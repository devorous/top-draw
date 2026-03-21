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
    this._prevGlitchSetting = false;
  }

  activate() {}

  deactivate() {
    this.lastStampPos.clear();
  }

  onPointerDown(user, pos) {
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

    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    this.paintMask(pos.x, pos.y, user.size, user, maskCtx);

    if (this.board.mirror) {
      this.paintMask(this.board.getWidth() - pos.x, pos.y, user.size, user, maskCtx);
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
        if (this.board.mirror) {
          this.paintMask(this.board.getWidth() - pos.x, pos.y, user.size, user, maskCtx);
        }
        this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
        this.board.requestUpdate();
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

    this.board.endStroke(user, {
      filterType: 'glitchBlur',
      blurRadius,
      cropBounds: { x, y, width: maxX - x, height: maxY - y }
    });

    this.lastStampPos.delete(user.id);
    delete user.blurBounds;
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
  }
}
