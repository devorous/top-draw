/**
 * @fileoverview Shared utilities for homography (perspective) transforms.
 * Used by SelectTool, image paste, and other features that need perspective warping.
 */

import { Homography } from './homography.js';

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
 * @returns {Object|null} - { imageData, bounds } or null if transform failed
 *   - imageData: The warped ImageData
 *   - bounds: { minX, minY, width, height } - position and size in dest coordinate space
 */
export function performHomographyTransform({
  sourceCanvas,
  sourceCorners,
  destCorners,
  scale = 1,
  homographyInstance = null
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

    // Perform the warp
    const imageData = homography.warp();

    if (!imageData) {
      return null;
    }

    // Return both the image data and bounds for positioning
    return {
      imageData,
      bounds: {
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
