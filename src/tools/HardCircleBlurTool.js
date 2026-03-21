/**
 * @fileoverview Hard Circle Blur tool - samples the average color via GPU blur and fills a solid circle.
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
 * Hard Circle Blur tool for solid-color blending based on sampled averages.
 */
export class HardCircleBlurTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('circleBlurHard', board);
    this.lastStampPos = new Map(); // userId -> {x, y, radius}
    this.stampBuffer = []; // [x, y, radius, x, y, radius, ...] for broadcast
    this.strokePoints = []; // Track points for tile ownership
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

    this.strokePoints = [{ x: pos.x, y: pos.y }];

    this.stampHardCircle(pos.x, pos.y, radius, user);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      this.stampHardCircle(width - pos.x, pos.y, radius, user);
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
          this.stampHardCircle(sx, sy, sr, user);
          this.stampBuffer.push(sx, sy, sr);
          this.strokePoints.push({ x: sx, y: sy });

          if (this.board.mirror) {
            const w = this.board.getWidth();
            this.stampHardCircle(w - sx, sy, sr, user);
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
    // Track tile ownership
    if (this.strokePoints.length > 0) {
      const radius = user.size;
      this.board.markDirtyPath(user, this.strokePoints, radius);
      if (this.board.mirror) {
        const boardWidth = this.board.getWidth();
        const mirroredPoints = this.strokePoints.map(pt => ({ x: boardWidth - pt.x, y: pt.y }));
        this.board.markDirtyPath(user, mirroredPoints, radius);
      }
    }
    this.strokePoints = [];

    this.board.endStroke(user);
    this.lastStampPos.delete(user.id);
  }

  drainStampBuffer() {
    const buf = this.stampBuffer;
    this.stampBuffer = [];
    const ps = [];
    const rs = [];
    for (let i = 0; i < buf.length; i += 3) {
      ps.push(buf[i], buf[i + 1]);
      rs.push(buf[i + 2]);
    }
    return { ps, rs };
  }

  applyStamps(user, ps, rs) {
    for (let i = 0, j = 0; i < ps.length; i += 2, j++) {
      const sx = ps[i], sy = ps[i + 1], sr = rs[j];
      this.stampHardCircle(sx, sy, sr, user);
      if (this.board.mirror) {
        const w = this.board.getWidth();
        this.stampHardCircle(w - sx, sy, sr, user);
      }
    }
  }

  /**
   * Sample the average color under the stamp via GPU blur into a 1x1 canvas,
   * then fill a solid circle of that color onto the active stroke canvas.
   * @param {number} x - Center x-coordinate.
   * @param {number} y - Center y-coordinate.
   * @param {number} radius - Stamp radius.
   * @param {Object} user - The user performing the action.
   */
  stampHardCircle(x, y, radius, user) {
    const canvasWidth = this.board.getWidth();
    const canvasHeight = this.board.getHeight();
    if (radius <= 0) return;

    try {
      const activeLayer = user.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
      const userId = user.id ?? this.board.app?.self?.id ?? 0;
      const strokeCtx = this.board.layerManager?.getUserStrokeContext(activeLayer, userId);
      if (!strokeCtx) return;

      const margin = Math.ceil(radius * 2);
      const left = Math.max(0, Math.floor(x - radius - margin));
      const top = Math.max(0, Math.floor(y - radius - margin));
      const right = Math.min(canvasWidth, Math.ceil(x + radius + margin));
      const bottom = Math.min(canvasHeight, Math.ceil(y + radius + margin));
      const width = right - left;
      const height = bottom - top;
      if (width <= 0 || height <= 0) return;

      if (!this._avgCanvas) {
        this._avgCanvas = document.createElement('canvas');
        this._avgCtx = this._avgCanvas.getContext('2d', { willReadFrequently: true });
      }
      this._avgCanvas.width = 1;
      this._avgCanvas.height = 1;
      this._avgCtx.filter = `blur(${radius * 0.4}px)`;
      const cx = x - left; 
      const cy = y - top;  
      this._avgCtx.drawImage(this.board.mainCanvas, left, top, width, height,
        -cx, -cy, width, height);
      this._avgCtx.filter = 'none';

      const pixel = this._avgCtx.getImageData(0, 0, 1, 1).data;

      let r = pixel[0], g = pixel[1], b = pixel[2];
      const a = pixel[3] / 255;
      if (a < 1) {
        let bgR = 255, bgG = 255, bgB = 255;
        if (this.board.backgroundColor) {
          const bg = this.board.backgroundColor;
          bgR = bg[0] ?? 255;
          bgG = bg[1] ?? 255;
          bgB = bg[2] ?? 255;
        }
        r = Math.round(r * a + bgR * (1 - a));
        g = Math.round(g * a + bgG * (1 - a));
        b = Math.round(b * a + bgB * (1 - a));
      }

      strokeCtx.save();
      strokeCtx.globalCompositeOperation = 'source-over';
      strokeCtx.globalAlpha = user.opacity !== undefined ? user.opacity : 1;

      const hardness = user.hardness !== undefined ? user.hardness / 100 : 1.0;
      const blurAmount = hardness < 1.0 ? (1 - hardness) * (20 + user.size * 0.2) : 0;

      if (blurAmount > 0) {
        const offset = 100000;
        strokeCtx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        strokeCtx.shadowBlur = blurAmount;
        strokeCtx.shadowColor = `rgb(${r}, ${g}, ${b})`;
        strokeCtx.shadowOffsetX = -offset;
        strokeCtx.shadowOffsetY = 0;
        strokeCtx.translate(offset, 0);
        strokeCtx.beginPath();
        strokeCtx.arc(x, y, radius, 0, Math.PI * 2);
        strokeCtx.fill();
      } else {
        strokeCtx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        strokeCtx.beginPath();
        strokeCtx.arc(x, y, radius, 0, Math.PI * 2);
        strokeCtx.fill();
      }

      strokeCtx.shadowBlur = 0;
      strokeCtx.shadowOffsetX = 0;
      strokeCtx.shadowOffsetY = 0;
      strokeCtx.restore();

      const drMargin = Math.ceil(blurAmount) + 2;
      this.board.expandDirtyRect(user,
        Math.floor(x - radius - drMargin), Math.floor(y - radius - drMargin),
        Math.ceil(radius * 2 + drMargin * 2), Math.ceil(radius * 2 + drMargin * 2));

      this.board.requestUpdate();
    } catch (error) {
      console.error('Hard circle blur error:', error);
    }
  }
}
