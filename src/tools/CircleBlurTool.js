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
 * Circle Blur tool - averages pixels in circular area and stamps a circle with that color
 */
export class CircleBlurTool extends Tool {
  constructor(board) {
    super('circleBlur', board);
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
  }

  deactivate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
  }

  onPointerDown(user, pos) {
    this.stampBlurredCircle(pos.x, pos.y, user.size, user);
  }

  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    this.stampBlurredCircle(pos.x, pos.y, user.size, user);

    // Mirror mode support
    if (this.board.mirror) {
      const width = this.board.getWidth();
      this.stampBlurredCircle(width - pos.x, pos.y, user.size, user);
    }
  }

  /**
   * Sample pixels in a circular area, average them, and stamp a circle with that color
   * Transparent pixels are blended with the background color before averaging
   */
  stampBlurredCircle(x, y, radius, user) {
    const ctx = this.board.mainCtx;
    const canvas = this.board.mainCanvas;

    // Get the bounding box for sampling
    const left = Math.max(0, Math.floor(x - radius));
    const top = Math.max(0, Math.floor(y - radius));
    const right = Math.min(canvas.width, Math.ceil(x + radius));
    const bottom = Math.min(canvas.height, Math.ceil(y + radius));

    const width = right - left;
    const height = bottom - top;

    if (width <= 0 || height <= 0) return;

    try {
      // Get image data for the region
      const imageData = ctx.getImageData(left, top, width, height);
      const data = imageData.data;

      // Get background color (default white)
      // backgroundColor might be in different formats, so normalize it
      let bgR = 255, bgG = 255, bgB = 255;
      if (this.board.backgroundColor) {
        if (typeof this.board.backgroundColor === 'object') {
          bgR = this.board.backgroundColor.r || 255;
          bgG = this.board.backgroundColor.g || 255;
          bgB = this.board.backgroundColor.b || 255;
        }
      }

      // Sample pixels within the circular area and calculate average
      let totalR = 0, totalG = 0, totalB = 0;
      let sampleCount = 0;

      for (let py = 0; py < height; py++) {
        for (let px = 0; px < width; px++) {
          // Check if pixel is within radius
          const worldX = left + px;
          const worldY = top + py;
          const dx = worldX - x;
          const dy = worldY - y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance <= radius) {
            const idx = (py * width + px) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            const alpha = data[idx + 3] / 255;

            // Blend pixel with background color based on alpha
            // Fully transparent (alpha=0) gives background color
            // Fully opaque (alpha=1) gives pixel color
            const blendedR = r * alpha + bgR * (1 - alpha);
            const blendedG = g * alpha + bgG * (1 - alpha);
            const blendedB = b * alpha + bgB * (1 - alpha);

            totalR += blendedR;
            totalG += blendedG;
            totalB += blendedB;
            sampleCount++;
          }
        }
      }

      // Calculate average color
      let avgR, avgG, avgB;

      if (sampleCount > 0) {
        avgR = Math.round(totalR / sampleCount);
        avgG = Math.round(totalG / sampleCount);
        avgB = Math.round(totalB / sampleCount);
      } else {
        // No pixels sampled, use background color
        avgR = bgR;
        avgG = bgG;
        avgB = bgB;
      }

      // Debug: log first stamp to check values
      const hardness = user.hardness !== undefined ? user.hardness : 1.0;
      const blurAmount = hardness < 1.0 ? (1 - hardness) * radius * 1.2 : 0;

      if (!this._debugLogged) {
        console.log('CircleBlur Debug:', {
          userId: user.id || 'self',
          bgR, bgG, bgB,
          sampleCount,
          avgR, avgG, avgB,
          radius,
          hardness,
          blurAmount,
          backgroundColor: this.board.backgroundColor
        });
        this._debugLogged = true;
      }

      // Draw the averaged color circle with hardness support
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';

      // Apply hardness using shadow blur (like brush tool)
      if (hardness < 1.0) {
        // Use shadow blur technique for soft edges
        const offset = 100000;

        ctx.fillStyle = `rgb(${avgR}, ${avgG}, ${avgB})`;
        ctx.shadowBlur = blurAmount;
        ctx.shadowColor = `rgb(${avgR}, ${avgG}, ${avgB})`;
        ctx.shadowOffsetX = -offset;
        ctx.shadowOffsetY = 0;

        ctx.translate(offset, 0);
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Hard edges - no shadow
        ctx.fillStyle = `rgb(${avgR}, ${avgG}, ${avgB})`;
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      // Ensure shadow is completely reset
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.restore();

    } catch (error) {
      console.error('Circle blur error:', error);
    }
  }
}
