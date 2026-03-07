/**
 * Base tool class
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

/**
 * Hard Circle Blur tool - samples the average color at the stamp center via GPU blur,
 * then fills a solid circle of that color. No per-pixel getImageData needed.
 *
 * Uses a tiny offscreen canvas with CSS filter: blur() to average the region,
 * then reads a single pixel from the center.
 */
export class HardCircleBlurTool extends Tool {
  constructor(board) {
    super('circleBlurHard', board);
    this.lastStampPos = new Map(); // userId -> {x, y, radius}
  }

  activate() {}
  deactivate() {
    this.lastStampPos.clear();
  }

  onPointerDown(user, pos) {
    this.board.beginStroke(user);
    const radius = user.pressure * user.size;

    this.stampHardCircle(pos.x, pos.y, radius, user);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      this.stampHardCircle(width - pos.x, pos.y, radius, user);
    }

    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y, radius });
  }

  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    const radius = user.pressure * user.size;
    const lastStamp = this.lastStampPos.get(user.id);

    if (lastStamp) {
      const dx = pos.x - lastStamp.x;
      const dy = pos.y - lastStamp.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      const avgRadius = (lastStamp.radius + radius) / 2;
      const spacingPercent = 0.3 + user.spacing * 0.035; // 30% at spacing=0, 100% at spacing=20
      const minSpacing = Math.max(5, avgRadius * spacingPercent);

      if (distance >= minSpacing) {
        // Interpolate stamps along the path at even intervals
        const steps = Math.floor(distance / minSpacing);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const sx = lastStamp.x + dx * t;
          const sy = lastStamp.y + dy * t;
          const sr = lastStamp.radius + (radius - lastStamp.radius) * t;
          this.stampHardCircle(sx, sy, sr, user);

          if (this.board.mirror) {
            const w = this.board.getWidth();
            this.stampHardCircle(w - sx, sy, sr, user);
          }
        }

        this.lastStampPos.set(user.id, { x: pos.x, y: pos.y, radius });
      }
    }
  }

  onPointerUp(user) {
    this.board.endStroke(user);
    this.lastStampPos.delete(user.id);
  }

  /**
   * Sample the average color under the stamp via GPU blur into a 1x1 canvas,
   * then fill a solid circle of that color onto the active stroke canvas.
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

      // Source region with margin so blur has enough surrounding pixels
      const margin = Math.ceil(radius * 2);
      const left = Math.max(0, Math.floor(x - radius - margin));
      const top = Math.max(0, Math.floor(y - radius - margin));
      const right = Math.min(canvasWidth, Math.ceil(x + radius + margin));
      const bottom = Math.min(canvasHeight, Math.ceil(y + radius + margin));
      const width = right - left;
      const height = bottom - top;
      if (width <= 0 || height <= 0) return;

      // Blur the source region down to a 1x1 pixel — GPU-accelerated average
      if (!this._avgCanvas) {
        this._avgCanvas = document.createElement('canvas');
        this._avgCtx = this._avgCanvas.getContext('2d', { willReadFrequently: true });
      }
      this._avgCanvas.width = 1;
      this._avgCanvas.height = 1;
      this._avgCtx.filter = `blur(${radius * 0.4}px)`;
      // Draw the region centered so the blur samples evenly around the stamp center
      const cx = x - left; // center x within the source region
      const cy = y - top;  // center y within the source region
      this._avgCtx.drawImage(this.board.mainCanvas, left, top, width, height,
        -cx, -cy, width, height);
      this._avgCtx.filter = 'none';

      // Read the single averaged pixel
      const pixel = this._avgCtx.getImageData(0, 0, 1, 1).data;

      // Blend with background for transparent areas
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

      // Draw solid circle of the averaged color
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

      // Track dirty rect
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
