/**
 * @fileoverview Circle Blur tool - averages pixels in a circular area and stamps a circle with that color.
 */

/**
 * Base tool class.
 */
class Tool {
  /**
   * @param {string} name - The name of the tool.
   * @param {Object} board - The drawing board instance.
   */
  constructor(name, board) {
    this.name = name;
    this.board = board;
  }

  /**
   * Called when the tool is activated.
   */
  activate() {}

  /**
   * Called when the tool is deactivated.
   */
  deactivate() {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerDown(user, pos, e) {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerMove(user, pos, lastPos, e) {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerUp(user, pos, e) {}
}

/**
 * Circle Blur tool for soft blending using circular stamps.
 */
export class CircleBlurTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('circleBlur', board);
    this.lastStampPos = new Map(); // userId -> {x, y, radius}
  }

  /**
   * Activates the tool.
   */
  activate() {}

  /**
   * Deactivates the tool and cleans up tracking.
   */
  deactivate() {
    this.lastStampPos.clear();
  }

  /**
   * Handles pointer down event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerDown(user, pos) {
    this.board.beginStroke(user);
    const radius = user.pressure * user.size;

    this.stampBlurredCircle(pos.x, pos.y, radius, user);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      this.stampBlurredCircle(width - pos.x, pos.y, radius, user);
    }

    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y, radius });
  }

  /**
   * Handles pointer move event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   */
  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    const radius = user.pressure * user.size;
    const lastStamp = this.lastStampPos.get(user.id);

    if (lastStamp) {
      const dx = pos.x - lastStamp.x;
      const dy = pos.y - lastStamp.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      const avgRadius = (lastStamp.radius + radius) / 2;
      const spacingPercent = 0.3 + user.spacing * 0.035; 
      const minSpacing = Math.max(5, avgRadius * spacingPercent);

      if (distance >= minSpacing) {
        const steps = Math.floor(distance / minSpacing);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const sx = lastStamp.x + dx * t;
          const sy = lastStamp.y + dy * t;
          const sr = lastStamp.radius + (radius - lastStamp.radius) * t;
          this.stampBlurredCircle(sx, sy, sr, user);

          if (this.board.mirror) {
            const w = this.board.getWidth();
            this.stampBlurredCircle(w - sx, sy, sr, user);
          }
        }

        this.lastStampPos.set(user.id, { x: pos.x, y: pos.y, radius });
      }
    }
  }

  /**
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   */
  onPointerUp(user) {
    this.board.endStroke(user);
    this.lastStampPos.delete(user.id);
  }

  /**
   * Stamp a heavily-blurred circle from board.mainCanvas onto the active stroke canvas.
   * @param {number} x - Center x-coordinate.
   * @param {number} y - Center y-coordinate.
   * @param {number} radius - Stamp radius.
   * @param {Object} user - The user performing the action.
   */
  stampBlurredCircle(x, y, radius, user) {
    const canvasWidth = this.board.getWidth();
    const canvasHeight = this.board.getHeight();

    if (radius <= 0) return;

    try {
      const activeLayer = user.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
      const userId = user.id ?? this.board.app?.self?.id ?? 0;
      const strokeCtx = this.board.layerManager?.getUserStrokeContext(activeLayer, userId);
      if (!strokeCtx) return;

      const blurRadius = radius;
      const margin = Math.ceil(blurRadius * 2);
      const left = Math.max(0, Math.floor(x - radius - margin));
      const top = Math.max(0, Math.floor(y - radius - margin));
      const right = Math.min(canvasWidth, Math.ceil(x + radius + margin));
      const bottom = Math.min(canvasHeight, Math.ceil(y + radius + margin));
      const width = right - left;
      const height = bottom - top;

      if (width <= 0 || height <= 0) return;

      const hardness = user.hardness !== undefined ? user.hardness / 100 : 1.0;
      const innerR = radius * hardness;

      if (!this._stampCanvas) {
        this._stampCanvas = document.createElement('canvas');
        this._stampCtx = this._stampCanvas.getContext('2d');
      }
      this._stampCanvas.width = width;
      this._stampCanvas.height = height;
      this._stampCtx.clearRect(0, 0, width, height);

      const cx = x - left;
      const cy = y - top;
      this._stampCtx.save();
      this._stampCtx.beginPath();
      this._stampCtx.arc(cx, cy, radius, 0, Math.PI * 2);
      this._stampCtx.clip();
      this._stampCtx.filter = `blur(${blurRadius}px)`;
      this._stampCtx.drawImage(this.board.mainCanvas, left, top, width, height, 0, 0, width, height);
      this._stampCtx.filter = 'none';
      this._stampCtx.restore();

      if (hardness < 1.0) {
        const grad = this._stampCtx.createRadialGradient(cx, cy, innerR, cx, cy, radius);
        grad.addColorStop(0, 'rgba(255,255,255,1)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        this._stampCtx.globalCompositeOperation = 'destination-in';
        this._stampCtx.fillStyle = grad;
        this._stampCtx.fillRect(0, 0, width, height);
        this._stampCtx.globalCompositeOperation = 'source-over';
      }

      strokeCtx.save();
      strokeCtx.globalCompositeOperation = 'source-over';
      strokeCtx.globalAlpha = user.opacity !== undefined ? user.opacity : 1;
      strokeCtx.drawImage(this._stampCanvas, left, top);
      strokeCtx.restore();

      const drMargin = Math.ceil(blurRadius) + 2;
      this.board.expandDirtyRect(user,
        Math.floor(x - radius - drMargin), Math.floor(y - radius - drMargin),
        Math.ceil(radius * 2 + drMargin * 2), Math.ceil(radius * 2 + drMargin * 2));

      this.board.requestUpdate();
    } catch (error) {
      console.error('Circle blur error:', error);
    }
  }
}
