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
 * Circle Blur tool - averages pixels in a circular area and stamps a circle with that color.
 *
 * Each gesture is stored as one active stroke: stamps accumulate on the stroke canvas
 * and are committed as a single undoable record on pointerUp.
 * Reads from board.mainCtx so each stamp sees the already-blurred content.
 */
export class CircleBlurTool extends Tool {
  constructor(board) {
    super('circleBlur', board);
  }

  activate() {}
  deactivate() {}

  onPointerDown(user, pos) {
    this.board.beginStroke(user);
    const radius = user.pressure * user.size;
    this.stampBlurredCircle(pos.x, pos.y, radius, user);
  }

  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    const radius = user.pressure * user.size;
    this.stampBlurredCircle(pos.x, pos.y, radius, user);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      this.stampBlurredCircle(width - pos.x, pos.y, radius, user);
    }
  }

  onPointerUp(user) {
    this.board.endStroke(user);
  }

  /**
   * Sample pixels in a circular area from board.mainCtx, average them, and stamp
   * a circle with that color onto the user's active stroke canvas.
   */
  stampBlurredCircle(x, y, radius, user) {
    const canvasWidth = this.board.getWidth();
    const canvasHeight = this.board.getHeight();

    const left = Math.max(0, Math.floor(x - radius));
    const top = Math.max(0, Math.floor(y - radius));
    const right = Math.min(canvasWidth, Math.ceil(x + radius));
    const bottom = Math.min(canvasHeight, Math.ceil(y + radius));

    const width = right - left;
    const height = bottom - top;

    if (width <= 0 || height <= 0) return;

    try {
      // Read from the composited canvas (includes previous stamps in this gesture)
      const imageData = this.board.mainCtx.getImageData(left, top, width, height);
      const data = imageData.data;

      // Normalize background color
      let bgR = 255, bgG = 255, bgB = 255;
      if (this.board.backgroundColor) {
        const bg = this.board.backgroundColor;
        bgR = bg[0] ?? 255;
        bgG = bg[1] ?? 255;
        bgB = bg[2] ?? 255;
      }

      let totalR = 0, totalG = 0, totalB = 0, sampleCount = 0;

      for (let py = 0; py < height; py++) {
        for (let px = 0; px < width; px++) {
          const worldX = left + px;
          const worldY = top + py;
          const dx = worldX - x;
          const dy = worldY - y;
          if (dx * dx + dy * dy <= radius * radius) {
            const idx = (py * width + px) * 4;
            const alpha = data[idx + 3] / 255;
            totalR += data[idx]     * alpha + bgR * (1 - alpha);
            totalG += data[idx + 1] * alpha + bgG * (1 - alpha);
            totalB += data[idx + 2] * alpha + bgB * (1 - alpha);
            sampleCount++;
          }
        }
      }

      const avgR = sampleCount > 0 ? Math.round(totalR / sampleCount) : bgR;
      const avgG = sampleCount > 0 ? Math.round(totalG / sampleCount) : bgG;
      const avgB = sampleCount > 0 ? Math.round(totalB / sampleCount) : bgB;

      const hardness = user.hardness !== undefined ? user.hardness : 1.0;
      const blurAmount = hardness < 1.0 ? (1 - hardness) * radius * 1.2 : 0;

      // Write the averaged circle onto the active stroke canvas
      const activeLayer = user.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
      const userId = user.id ?? this.board.app?.self?.id ?? 0;
      const strokeCtx = this.board.layerManager?.getUserStrokeContext(activeLayer, userId);
      if (!strokeCtx) return;

      strokeCtx.save();
      strokeCtx.globalCompositeOperation = 'source-over';
      strokeCtx.globalAlpha = user.opacity !== undefined ? user.opacity : 1;

      if (hardness < 1.0) {
        const offset = 100000;
        strokeCtx.fillStyle = `rgb(${avgR}, ${avgG}, ${avgB})`;
        strokeCtx.shadowBlur = blurAmount;
        strokeCtx.shadowColor = `rgb(${avgR}, ${avgG}, ${avgB})`;
        strokeCtx.shadowOffsetX = -offset;
        strokeCtx.shadowOffsetY = 0;
        strokeCtx.translate(offset, 0);
        strokeCtx.beginPath();
        strokeCtx.arc(x, y, radius, 0, Math.PI * 2);
        strokeCtx.fill();
      } else {
        strokeCtx.fillStyle = `rgb(${avgR}, ${avgG}, ${avgB})`;
        strokeCtx.shadowBlur = 0;
        strokeCtx.beginPath();
        strokeCtx.arc(x, y, radius, 0, Math.PI * 2);
        strokeCtx.fill();
      }

      strokeCtx.shadowBlur = 0;
      strokeCtx.shadowOffsetX = 0;
      strokeCtx.shadowOffsetY = 0;
      strokeCtx.restore();

      this.board.compositeAllLayers();
    } catch (error) {
      console.error('Circle blur error:', error);
    }
  }
}
