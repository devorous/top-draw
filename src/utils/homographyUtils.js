/**
 * @fileoverview Shared utilities for homography (perspective) transforms.
 * Used by SelectTool, image paste, and other features that need perspective warping.
 */

import { Homography, calculateTransformMatrix, applyProjectiveTransformToPoint } from './homography.js';

/**
 * Calculates a bounding box from four corner points.
 * @param {Object} corners - Corner positions { tl, tr, bl, br } where each has {x, y}.
 * @returns {Object} - { minX, minY, maxX, maxY, width, height }
 */
export function calculateCornerBounds(corners) {
  const minX = Math.min(corners.tl.x, corners.tr.x, corners.bl.x, corners.br.x);
  const minY = Math.min(corners.tl.y, corners.tr.y, corners.bl.y, corners.br.y);
  const maxX = Math.max(corners.tl.x, corners.tr.x, corners.bl.x, corners.br.x);
  const maxY = Math.max(corners.tl.y, corners.tr.y, corners.bl.y, corners.br.y);

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function isConvexQuad(corners) {
  // Walk the quad as a polygon (tl -> tr -> br -> bl) and require a consistent
  // turn direction. Concave and self-intersecting (crossed) quads fail this.
  const pts = [corners.tl, corners.tr, corners.br, corners.bl];
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const c = pts[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * Compute the output window needed to rasterize the full warped image.
 *
 * When the destination quad is convex, the warped image is exactly the quad,
 * so the corner bounding box (the default window) already fits it and null is
 * returned. When the quad is concave or crossed, the fitted homography folds:
 * source pixels near the vanishing line map far outside the corner bbox
 * (toward infinity), so the spill is sampled along the source rect boundary
 * and clamped to clampBounds (typically the board rect).
 *
 * @param {Object} sourceCorners - Source corners { tl, tr, bl, br } in image coords.
 * @param {Object} destCorners - Destination corners { tl, tr, bl, br }.
 * @param {Object} clampBounds - { minX, minY, maxX, maxY } limit for the spill.
 * @returns {Object|null} - Integer { minX, minY, width, height } window that
 *   contains the corner bbox, or null if no expansion is needed.
 */
export function computeWarpOutputBounds(sourceCorners, destCorners, clampBounds) {
  if (!sourceCorners || !destCorners || !clampBounds) return null;
  if (isConvexQuad(destCorners)) return null;

  let matrix;
  try {
    const src = [
      sourceCorners.tl.x, sourceCorners.tl.y,
      sourceCorners.tr.x, sourceCorners.tr.y,
      sourceCorners.bl.x, sourceCorners.bl.y,
      sourceCorners.br.x, sourceCorners.br.y
    ];
    const dst = [
      destCorners.tl.x, destCorners.tl.y,
      destCorners.tr.x, destCorners.tr.y,
      destCorners.bl.x, destCorners.bl.y,
      destCorners.br.x, destCorners.br.y
    ];
    matrix = calculateTransformMatrix('projective', src, dst);
  } catch (e) {
    return null;
  }
  if (!matrix || matrix.length !== 8) return null;

  const cornerBounds = calculateCornerBounds(destCorners);
  let minX = cornerBounds.minX;
  let minY = cornerBounds.minY;
  let maxX = cornerBounds.maxX;
  let maxY = cornerBounds.maxY;

  // Forward-map the source rect boundary; extremes of the warped image lie on
  // the boundary image. Near-zero denominators map toward infinity and end up
  // clamped to clampBounds.
  const SAMPLES_PER_EDGE = 48;
  const EPS = 1e-9;
  const edges = [
    [sourceCorners.tl, sourceCorners.tr],
    [sourceCorners.tr, sourceCorners.br],
    [sourceCorners.br, sourceCorners.bl],
    [sourceCorners.bl, sourceCorners.tl]
  ];
  for (const [from, to] of edges) {
    for (let i = 0; i <= SAMPLES_PER_EDGE; i++) {
      const t = i / SAMPLES_PER_EDGE;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      const w = matrix[6] * x + matrix[7] * y + 1;
      if (Math.abs(w) < EPS) continue;
      const [px, py] = applyProjectiveTransformToPoint(matrix, x, y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      minX = Math.min(minX, Math.max(px, clampBounds.minX));
      minY = Math.min(minY, Math.max(py, clampBounds.minY));
      maxX = Math.max(maxX, Math.min(px, clampBounds.maxX));
      maxY = Math.max(maxY, Math.min(py, clampBounds.maxY));
    }
  }

  minX = Math.floor(minX);
  minY = Math.floor(minY);
  maxX = Math.ceil(maxX);
  maxY = Math.ceil(maxY);

  // No meaningful spill beyond the default corner-bbox window
  if (
    minX >= Math.floor(cornerBounds.minX) &&
    minY >= Math.floor(cornerBounds.minY) &&
    maxX <= Math.ceil(cornerBounds.maxX) &&
    maxY <= Math.ceil(cornerBounds.maxY)
  ) {
    return null;
  }

  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Perform a homography transform on a canvas with given corner mapping
 * Consolidates duplicate transform logic used throughout the codebase
 *
 * @param {Object} options - Transform options
 * @param {HTMLCanvasElement} options.sourceCanvas - The source canvas to transform
 * @param {Object} options.sourceCorners - Source corner positions { tl, tr, bl, br }
 * @param {Object} options.destCorners - Destination corner positions { tl, tr, bl, br }
 * @param {number} [options.scale=1] - Scale factor for downsampling (1 = full resolution)
 * @param {Homography} [options.homographyInstance] - Optional existing instance to reuse
 * @param {Object} [options.outputBounds] - Integer { minX, minY, width, height } window
 *   (in dest coordinate space) to rasterize instead of the dest corner bbox. Use
 *   computeWarpOutputBounds() so folded warps aren't cut off at the corner bbox.
 * @returns {Object|null} - { imageData, bounds } or null if transform failed
 *   - imageData: The warped ImageData
 *   - bounds: { minX, minY, width, height } - position and size in dest coordinate space
 */
export function performHomographyTransform({
  sourceCanvas,
  sourceCorners,
  destCorners,
  scale = 1,
  homographyInstance = null,
  outputBounds = null
}) {
  if (!sourceCanvas || !sourceCorners || !destCorners) {
    console.warn('Missing required parameters for homography transform');
    return null;
  }

  try {
    // Create or reuse homography instance
    const homography = homographyInstance || new Homography('projective');

    // Calculate scaled dimensions for source
    const srcWidth = scale === 1 ? undefined : Math.max(1, Math.round(sourceCanvas.width * scale));
    const srcHeight = scale === 1 ? undefined : Math.max(1, Math.round(sourceCanvas.height * scale));
    const effectiveScaleX = srcWidth === undefined ? 1 : srcWidth / sourceCanvas.width;
    const effectiveScaleY = srcHeight === undefined ? 1 : srcHeight / sourceCanvas.height;

    // Build source points array using the effective scale that matches the
    // actual resized raster dimensions. Using the requested scale directly can
    // drift from the integer preview size after rounding and skew the warp.
    const srcPoints = [
      [sourceCorners.tl.x * effectiveScaleX, sourceCorners.tl.y * effectiveScaleY],
      [sourceCorners.tr.x * effectiveScaleX, sourceCorners.tr.y * effectiveScaleY],
      [sourceCorners.bl.x * effectiveScaleX, sourceCorners.bl.y * effectiveScaleY],
      [sourceCorners.br.x * effectiveScaleX, sourceCorners.br.y * effectiveScaleY]
    ];

    // Calculate destination bounds
    const bounds = calculateCornerBounds(destCorners);

    // Build destination points array in the same effective coordinate space as
    // the resized preview raster.
    const dstPoints = [
      [(destCorners.tl.x - bounds.minX) * effectiveScaleX, (destCorners.tl.y - bounds.minY) * effectiveScaleY],
      [(destCorners.tr.x - bounds.minX) * effectiveScaleX, (destCorners.tr.y - bounds.minY) * effectiveScaleY],
      [(destCorners.bl.x - bounds.minX) * effectiveScaleX, (destCorners.bl.y - bounds.minY) * effectiveScaleY],
      [(destCorners.br.x - bounds.minX) * effectiveScaleX, (destCorners.br.y - bounds.minY) * effectiveScaleY]
    ];

    // Configure homography with source and destination points
    if (srcWidth !== undefined && srcHeight !== undefined) {
      homography.setSourcePoints(srcPoints, sourceCanvas, srcWidth, srcHeight);
    } else {
      homography.setSourcePoints(srcPoints, sourceCanvas);
    }
    homography.setDestinyPoints(dstPoints);

    // Widen the rasterized window when the warp spills beyond the corner bbox
    // (folded/concave quads). The library's inverse warp iterates exactly over
    // this window, so overriding it renders the spill instead of clipping it.
    if (outputBounds) {
      homography._xOutputOffset = Math.round((outputBounds.minX - bounds.minX) * effectiveScaleX);
      homography._yOutputOffset = Math.round((outputBounds.minY - bounds.minY) * effectiveScaleY);
      homography._objectiveWidth = Math.max(1, Math.round(outputBounds.width * effectiveScaleX));
      homography._objectiveHeight = Math.max(1, Math.round(outputBounds.height * effectiveScaleY));
    }

    // Perform the warp
    const imageData = homography.warp();

    if (!imageData) {
      return null;
    }

    // Return both the image data and bounds for positioning
    return {
      imageData,
      bounds: outputBounds
        ? {
            minX: outputBounds.minX,
            minY: outputBounds.minY,
            width: outputBounds.width,
            height: outputBounds.height
          }
        : {
            minX: bounds.minX,
            minY: bounds.minY,
            width: imageData.width,
            height: imageData.height
          }
    };
  } catch (e) {
    console.warn('Homography transform failed:', e);
    return null;
  }
}

/**
 * Convert ImageData to a canvas element
 * Utility helper for drawing transformed images
 *
 * @param {ImageData} imageData - The image data to convert
 * @returns {HTMLCanvasElement} - Canvas containing the image data
 */
export function imageDataToCanvas(imageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}
