/**
 * @fileoverview Shared pattern-brush tile generation. Builds (and caches) the
 * repeating tile canvas for a user's pattern brush, handling aspect-ratio fit,
 * SVG smoothing, GIMP greyscale → alpha conversion, spacing padding, and
 * optional color tinting. Previously copy-pasted into PatternTool, FloodFillTool,
 * and SelectTool.
 */

/**
 * The on-canvas long edge (in board pixels) that a pattern tile occupies at
 * 100% scale, regardless of the source image's native resolution. Baselined on
 * pepper.gbr (49×61), so pepper renders at 100% exactly as it always has and
 * every other brush — a 1024px texture or a 200px SVG render — now matches its
 * apparent size instead of being ~17× bigger or smaller.
 */
export const PATTERN_BASE_SIZE = 61;

/**
 * Resolves the pattern-scale factor to feed a DOMMatrix for a repeating fill.
 * Combines the user's scale slider with the per-brush normalization that makes
 * 100% mean {@link PATTERN_BASE_SIZE} pixels for every brush.
 *
 * @param {Object} user - The drawing user (reads patternScale).
 * @param {HTMLCanvasElement|null} tile - Tile from {@link getPatternTile}.
 * @returns {number} Scale factor for the pattern transform.
 */
export function getPatternDrawScale(user, tile) {
  const userScale = (user.patternScale || 100) / 100;
  const baseDim = tile?.patternBaseDim;
  if (!baseDim) return userScale;
  return userScale * (PATTERN_BASE_SIZE / baseDim);
}

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

  // Long edge of the image itself (padding excluded) — getPatternDrawScale
  // divides by this so 100% is the same on-canvas size for every brush, while
  // spacing still widens the gap proportionally.
  tileCanvas.patternBaseDim = Math.max(tileWidth, tileHeight);

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

  // NOTE: 1-byte-per-pixel .gbr brushes arrive here already in the right shape —
  // `parseGbr` renders them as dark ink whose ALPHA is the ink density. An older
  // white → transparent pass used to run here on the assumption they were still
  // black-on-white; on parser output it read every transparent pixel as (0,0,0,0),
  // computed brightness 0, and turned it fully opaque black — inverting the tile
  // into a black slab. Don't reintroduce it.

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
