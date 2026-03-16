/**
 * @fileoverview Hard-pixel rendering utilities (Bresenham, Midpoint circle)
 */

/**
 * Draw a hard-pixel line using Bresenham's algorithm
 * @param {ImageData} imageData - Target ImageData
 * @param {number} x0 - Start X
 * @param {number} y0 - Start Y
 * @param {number} x1 - End X
 * @param {number} y1 - End Y
 * @param {number} r - Red component (0-255)
 * @param {number} g - Green component (0-255)
 * @param {number} b - Blue component (0-255)
 * @param {number} a - Alpha component (0-255)
 */
export function bresenhamLine(imageData, x0, y0, x1, y1, r, g, b, a) {
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);

  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  const { data, width, height } = imageData;

  while (true) {
    // Set pixel if in bounds
    if (x0 >= 0 && x0 < width && y0 >= 0 && y0 < height) {
      const idx = (y0 * width + x0) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = a;
    }

    if (x0 === x1 && y0 === y1) break;

    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/**
 * Draw a hard-pixel circle using Midpoint circle algorithm
 * @param {ImageData} imageData - Target ImageData
 * @param {number} cx - Center X
 * @param {number} cy - Center Y
 * @param {number} radius - Circle radius
 * @param {number} r - Red component (0-255)
 * @param {number} g - Green component (0-255)
 * @param {number} b - Blue component (0-255)
 * @param {number} a - Alpha component (0-255)
 * @param {boolean} [fill=false] - Whether to fill the circle
 */
export function midpointCircle(imageData, cx, cy, radius, r, g, b, a, fill = false) {
  cx = Math.round(cx);
  cy = Math.round(cy);
  radius = Math.round(radius);

  const { data, width, height } = imageData;

  const setPixel = (x, y) => {
    if (x >= 0 && x < width && y >= 0 && y < height) {
      const idx = (y * width + x) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = a;
    }
  };

  const drawHorizontalLine = (x0, x1, y) => {
    const startX = Math.max(0, Math.min(x0, x1));
    const endX = Math.min(width - 1, Math.max(x0, x1));
    if (y < 0 || y >= height) return;
    for (let x = startX; x <= endX; x++) {
      const idx = (y * width + x) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = a;
    }
  };

  let x = 0;
  let y = radius;
  let d = 1 - radius;

  while (x <= y) {
    if (fill) {
      // Draw horizontal lines to fill the circle
      drawHorizontalLine(cx - x, cx + x, cy + y);
      drawHorizontalLine(cx - x, cx + x, cy - y);
      drawHorizontalLine(cx - y, cx + y, cy + x);
      drawHorizontalLine(cx - y, cx + y, cy - x);
    } else {
      // Draw circle outline (8-way symmetry)
      setPixel(cx + x, cy + y);
      setPixel(cx - x, cy + y);
      setPixel(cx + x, cy - y);
      setPixel(cx - x, cy - y);
      setPixel(cx + y, cy + x);
      setPixel(cx - y, cy + x);
      setPixel(cx + y, cy - x);
      setPixel(cx - y, cy - x);
    }

    if (d < 0) {
      d += 2 * x + 3;
    } else {
      d += 2 * (x - y) + 5;
      y--;
    }
    x++;
  }
}

/**
 * Draw a thick hard-pixel line by drawing multiple offset Bresenham lines
 * @param {ImageData} imageData - Target ImageData
 * @param {number} x0 - Start X
 * @param {number} y0 - Start Y
 * @param {number} x1 - End X
 * @param {number} y1 - End Y
 * @param {number} thickness - Line thickness in pixels
 * @param {number} r - Red component (0-255)
 * @param {number} g - Green component (0-255)
 * @param {number} b - Blue component (0-255)
 * @param {number} a - Alpha component (0-255)
 */
export function thickBresenhamLine(imageData, x0, y0, x1, y1, thickness, r, g, b, a) {
  if (thickness <= 1) {
    bresenhamLine(imageData, x0, y0, x1, y1, r, g, b, a);
    return;
  }

  // Calculate perpendicular direction
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);

  if (len === 0) {
    // Single point - draw a circle
    midpointCircle(imageData, x0, y0, thickness / 2, r, g, b, a, true);
    return;
  }

  const perpX = -dy / len;
  const perpY = dx / len;

  // Draw multiple parallel lines
  const halfThickness = thickness / 2;
  for (let i = -halfThickness; i <= halfThickness; i += 0.5) {
    bresenhamLine(
      imageData,
      x0 + perpX * i,
      y0 + perpY * i,
      x1 + perpX * i,
      y1 + perpY * i,
      r, g, b, a
    );
  }
}

/**
 * Apply alpha threshold to convert anti-aliased pixels to hard pixels
 * @param {ImageData} imageData - Source ImageData (modified in place)
 * @param {number} [threshold=0] - Alpha threshold (0-255). Pixels with alpha > threshold become fully opaque.
 */
export function applyAlphaThreshold(imageData, threshold = 0) {
  const { data } = imageData;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > threshold) {
      data[i] = 255;
    } else {
      data[i] = 0;
    }
  }
}

/**
 * Convert a canvas context's content to hard pixels using alpha thresholding
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {number} [threshold=0] - Alpha threshold
 */
export function hardenCanvas(ctx, threshold = 0) {
  const imageData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  applyAlphaThreshold(imageData, threshold);
  ctx.putImageData(imageData, 0, 0);
}
