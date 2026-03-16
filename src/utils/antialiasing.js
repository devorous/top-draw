/**
 * @fileoverview Anti-aliasing filters for hard-pixel rendering
 */

/**
 * Apply Fast Approximate Anti-Aliasing (FXAA) to an ImageData
 * This is a simplified FXAA implementation that detects edges and blends them
 * @param {ImageData} imageData - Source ImageData
 * @returns {ImageData} New anti-aliased ImageData
 */
export function applyFXAA(imageData) {
  const { width, height, data } = imageData;
  const output = new ImageData(width, height);
  const outData = output.data;

  // Copy input to output first
  outData.set(data);

  const EDGE_THRESHOLD = 0.125;
  const EDGE_THRESHOLD_MIN = 0.0312;
  const SUBPIX_QUALITY = 0.75;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;

      // Get luminance of center pixel and neighbors
      const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

      const lumaC = luma(data[idx], data[idx + 1], data[idx + 2]);
      const lumaU = luma(data[idx - width * 4], data[idx - width * 4 + 1], data[idx - width * 4 + 2]);
      const lumaD = luma(data[idx + width * 4], data[idx + width * 4 + 1], data[idx + width * 4 + 2]);
      const lumaL = luma(data[idx - 4], data[idx - 3], data[idx - 2]);
      const lumaR = luma(data[idx + 4], data[idx + 5], data[idx + 6]);

      // Find min/max luma
      const lumaMin = Math.min(lumaC, lumaU, lumaD, lumaL, lumaR);
      const lumaMax = Math.max(lumaC, lumaU, lumaD, lumaL, lumaR);
      const lumaRange = lumaMax - lumaMin;

      // Skip if not an edge
      if (lumaRange < Math.max(EDGE_THRESHOLD_MIN, lumaMax * EDGE_THRESHOLD)) {
        continue;
      }

      // Simple 3x3 blur for edge pixels
      let r = 0, g = 0, b = 0, a = 0, count = 0;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nidx = ((y + dy) * width + (x + dx)) * 4;
          r += data[nidx];
          g += data[nidx + 1];
          b += data[nidx + 2];
          a += data[nidx + 3];
          count++;
        }
      }

      outData[idx] = r / count;
      outData[idx + 1] = g / count;
      outData[idx + 2] = b / count;
      outData[idx + 3] = a / count;
    }
  }

  return output;
}

/**
 * Apply a simple box blur to ImageData
 * @param {ImageData} imageData - Source ImageData
 * @param {number} [radius=1] - Blur radius in pixels
 * @returns {ImageData} New blurred ImageData
 */
export function applyBoxBlur(imageData, radius = 1) {
  const { width, height, data } = imageData;
  const output = new ImageData(width, height);
  const outData = output.data;

  const diameter = radius * 2 + 1;
  const kernelSize = diameter * diameter;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      let count = 0;

      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;

          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const idx = (ny * width + nx) * 4;
            r += data[idx];
            g += data[idx + 1];
            b += data[idx + 2];
            a += data[idx + 3];
            count++;
          }
        }
      }

      const outIdx = (y * width + x) * 4;
      outData[outIdx] = r / count;
      outData[outIdx + 1] = g / count;
      outData[outIdx + 2] = b / count;
      outData[outIdx + 3] = a / count;
    }
  }

  return output;
}

/**
 * Apply Gaussian blur approximation using multiple box blurs
 * @param {ImageData} imageData - Source ImageData
 * @param {number} [radius=1] - Blur radius
 * @returns {ImageData} New blurred ImageData
 */
export function applyGaussianBlur(imageData, radius = 1) {
  // Three box blurs approximate a Gaussian blur
  let result = applyBoxBlur(imageData, radius);
  result = applyBoxBlur(result, radius);
  result = applyBoxBlur(result, radius);
  return result;
}

/**
 * Apply simple edge-detect blur (blur only high-contrast edges)
 * @param {ImageData} imageData - Source ImageData
 * @param {number} [threshold=30] - Edge detection threshold (0-255)
 * @param {number} [blurRadius=1] - Blur radius for detected edges
 * @returns {ImageData} New ImageData with edges smoothed
 */
export function applyEdgeBlur(imageData, threshold = 30, blurRadius = 1) {
  const { width, height, data } = imageData;
  const output = new ImageData(width, height);
  const outData = output.data;

  // Copy input to output first
  outData.set(data);

  // Detect edges using simple gradient
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;

      // Calculate gradient magnitude
      const rGradX = data[idx + 4] - data[idx - 4];
      const gGradX = data[idx + 5] - data[idx - 3];
      const bGradX = data[idx + 6] - data[idx - 2];

      const rGradY = data[idx + width * 4] - data[idx - width * 4];
      const gGradY = data[idx + width * 4 + 1] - data[idx - width * 4 + 1];
      const bGradY = data[idx + width * 4 + 2] - data[idx - width * 4 + 2];

      const gradMag = Math.sqrt(
        rGradX * rGradX + gGradX * gGradX + bGradX * bGradX +
        rGradY * rGradY + gGradY * gGradY + bGradY * bGradY
      );

      // If this is an edge, apply blur
      if (gradMag > threshold) {
        let r = 0, g = 0, b = 0, a = 0, count = 0;

        for (let dy = -blurRadius; dy <= blurRadius; dy++) {
          for (let dx = -blurRadius; dx <= blurRadius; dx++) {
            const nx = x + dx;
            const ny = y + dy;

            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              const nidx = (ny * width + nx) * 4;
              r += data[nidx];
              g += data[nidx + 1];
              b += data[nidx + 2];
              a += data[nidx + 3];
              count++;
            }
          }
        }

        outData[idx] = r / count;
        outData[idx + 1] = g / count;
        outData[idx + 2] = b / count;
        outData[idx + 3] = a / count;
      }
    }
  }

  return output;
}

/**
 * Apply anti-aliasing filter to a canvas context
 * @param {CanvasRenderingContext2D} sourceCtx - Source canvas context
 * @param {CanvasRenderingContext2D} targetCtx - Target canvas context (can be same as source)
 * @param {string} [method='fxaa'] - AA method: 'fxaa', 'box', 'gaussian', 'edge'
 * @param {Object} [options={}] - Options for the selected method
 */
export function applyAntiAliasing(sourceCtx, targetCtx, method = 'fxaa', options = {}) {
  const imageData = sourceCtx.getImageData(0, 0, sourceCtx.canvas.width, sourceCtx.canvas.height);
  let result;

  switch (method) {
    case 'fxaa':
      result = applyFXAA(imageData);
      break;
    case 'box':
      result = applyBoxBlur(imageData, options.radius || 1);
      break;
    case 'gaussian':
      result = applyGaussianBlur(imageData, options.radius || 1);
      break;
    case 'edge':
      result = applyEdgeBlur(imageData, options.threshold || 30, options.blurRadius || 1);
      break;
    default:
      result = imageData;
  }

  targetCtx.putImageData(result, 0, 0);
}
