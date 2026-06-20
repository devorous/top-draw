/**
 * @fileoverview Shared pattern-brush tile generation. Builds (and caches) the
 * repeating tile canvas for a user's pattern brush, handling aspect-ratio fit,
 * SVG smoothing, GIMP greyscale → alpha conversion, spacing padding, and
 * optional color tinting. Previously copy-pasted into PatternTool, FloodFillTool,
 * and SelectTool.
 */

/**
 * Builds the pattern tile canvas for a user's active pattern brush.
 *
 * @param {Object} user - The drawing user (reads patternBrush, color,
 *   patternColorMode, patternSpacing).
 * @param {Map<string, HTMLCanvasElement>} [cache] - Optional cache keyed by
 *   brush/color/spacing/mode. Hits are returned directly; misses are stored.
 * @returns {HTMLCanvasElement|null} The tile canvas, or null if no brush /
 *   image not yet loaded.
 */
export function getPatternTile(user, cache) {
  const brush = user.patternBrush;
  if (!brush) return null;

  let img = brush.image;
  if (brush.type === 'gih' && brush.images) img = brush.images[0];
  if (!img) return null;

  const colorMode = user.patternColorMode || 'original';
  const colorKey = colorMode === 'tinted' ? user.color.join(',') : 'original';
  const spacing = user.patternSpacing || 0;
  const key = `${brush.brushName || brush.fileName}_${colorKey}_${spacing}_${colorMode}`;

  if (cache && cache.has(key)) return cache.get(key);

  const imgWidth = img.width || img.naturalWidth;
  const imgHeight = img.height || img.naturalHeight;

  // Image not loaded yet — bail rather than computing NaN tile dimensions.
  if (!imgWidth || !imgHeight) return null;

  // SVGs render at a fixed higher resolution (200px) to avoid pixelation when
  // scaled. Raster brushes cap at 1024px to preserve detail from high-res
  // textures, but must NOT be upscaled past their own size — otherwise a small
  // brush (e.g. pepper.gbr at 49×61) gets blown up ~17× into a giant, blurry
  // tile that reads as "stretched out" at default scale.
  const maxDim = (brush.type === 'svg')
    ? 200
    : Math.min(1024, Math.max(imgWidth, imgHeight));

  const aspectRatio = imgWidth / imgHeight;

  let tileWidth, tileHeight;
  if (aspectRatio > 1) {
    // Wider than tall
    tileWidth = maxDim;
    tileHeight = maxDim / aspectRatio;
  } else {
    // Taller than wide or square
    tileWidth = maxDim * aspectRatio;
    tileHeight = maxDim;
  }

  const padding = spacing;
  const tileCanvas = document.createElement('canvas');
  tileCanvas.width = tileWidth + padding;
  tileCanvas.height = tileHeight + padding;

  const tctx = tileCanvas.getContext('2d');

  // Enable image smoothing for SVGs to render them smoothly without pixelation
  if (brush.type === 'svg') {
    tctx.imageSmoothingEnabled = true;
  }

  // Intermediate canvas to handle greyscale transparency before tinting.
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = tileWidth;
  tempCanvas.height = tileHeight;
  const tempCtx = tempCanvas.getContext('2d');

  if (brush.type === 'svg') {
    tempCtx.imageSmoothingEnabled = true;
  }

  tempCtx.drawImage(img, 0, 0, tileWidth, tileHeight);

  // GIMP greyscale brushes are often black-on-white; map white → transparent
  // (black = opaque) so source-in tinting works.
  if (brush.type === 'gbr' && brush.colorDepth === 1) {
    const imageData = tempCtx.getImageData(0, 0, tileWidth, tileHeight);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
      data[i + 3] = 255 - brightness;
      data[i] = data[i + 1] = data[i + 2] = 0;
    }
    tempCtx.putImageData(imageData, 0, 0);
  }

  // Draw centered and optionally tinted.
  tctx.save();
  tctx.drawImage(tempCanvas, padding / 2, padding / 2, tileWidth, tileHeight);

  if (colorMode === 'tinted') {
    tctx.globalCompositeOperation = 'source-in';
    tctx.fillStyle = `rgba(${user.color[0]}, ${user.color[1]}, ${user.color[2]}, 1.0)`;
    tctx.fillRect(0, 0, tileCanvas.width, tileCanvas.height);
  }

  tctx.restore();

  if (cache) cache.set(key, tileCanvas);
  return tileCanvas;
}
