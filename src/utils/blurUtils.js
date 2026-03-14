/**
 * @fileoverview Blur utility functions with lazy-loaded stackblur.
 * Provides functions for blurring image data with or without background compositing.
 */

let stackblurCache = null;
let loadingPromise = null;

/**
 * Loads stackblur dynamically (once).
 * @returns {Promise<Function>} The stackblur function.
 */
async function loadStackblur() {
  // Return cached function if already loaded
  if (stackblurCache) {
    return stackblurCache;
  }

  // Return existing promise if already loading
  if (loadingPromise) {
    return loadingPromise;
  }

  // Start loading
  loadingPromise = import('stackblur')
    .then(module => {
      stackblurCache = module.default;
      loadingPromise = null;
      return stackblurCache;
    })
    .catch(error => {
      loadingPromise = null;
      console.error('Failed to load stackblur:', error);
      throw error;
    });

  return loadingPromise;
}

/**
 * Apply stackblur with background compositing
 * Composites transparent areas against background before blurring
 * @param {ImageData} imageData - The image data to blur
 * @param {number} width - Width of the image data
 * @param {number} height - Height of the image data
 * @param {number} blurRadius - Blur radius (0 = no blur)
 * @param {Array} backgroundColor - Background color as [r, g, b, a] where RGB is 0-255 and alpha is 0-1
 * @returns {Promise<ImageData>} - Blurred image data
 */
export async function blurImageDataWithBackground(imageData, width, height, blurRadius, backgroundColor) {
  if (blurRadius <= 0) return imageData;

  // Lazy load stackblur
  const blur = await loadStackblur();

  // Create temporary canvas to hold the raw imageData
  const temp = document.createElement('canvas');
  temp.width = width;
  temp.height = height;
  const tempCtx = temp.getContext('2d');
  tempCtx.putImageData(imageData, 0, 0);

  // Create offscreen canvas for compositing
  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const ctx = offscreen.getContext('2d');

  const [r, g, b, a] = backgroundColor;
  ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
  ctx.fillRect(0, 0, width, height);

  // Composite original image on top using drawImage (respects alpha blending)
  ctx.drawImage(temp, 0, 0);

  // Get composited result
  const composited = ctx.getImageData(0, 0, width, height);

  // Apply blur to composited data
  blur(composited.data, width, height, blurRadius);

  return composited;
}

/**
 * Apply stackblur directly without background compositing
 * Preserves transparency by using pre-multiplied alpha to avoid dark fringes.
 * @param {ImageData} imageData - The image data to blur
 * @param {number} width - Width of the image data
 * @param {number} height - Height of the image data
 * @param {number} blurRadius - Blur radius (0 = no blur)
 * @returns {Promise<ImageData>} - Blurred image data
 */
export async function blurImageData(imageData, width, height, blurRadius) {
  if (blurRadius <= 0) return imageData;

  // Lazy load stackblur
  const blur = await loadStackblur();

  const data = new Uint8ClampedArray(imageData.data);

  // Pre-multiply alpha
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    data[i] *= alpha;
    data[i + 1] *= alpha;
    data[i + 2] *= alpha;
  }

  // Apply blur
  blur(data, width, height, blurRadius);

  // Un-pre-multiply alpha
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    if (alpha > 0) {
      data[i] /= alpha;
      data[i + 1] /= alpha;
      data[i + 2] /= alpha;
    }
  }

  return new ImageData(data, width, height);
}

/**
 * Returns the cached stackblur function if already loaded, or null.
 * @returns {Function|null}
 */
export function getStackblurSync() {
  return stackblurCache;
}
