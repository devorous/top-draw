/**
 * @fileoverview Single entry point for the perspective-warp maths.
 *
 * `homography.js` carries its own Delaunay triangulation dependency and is only
 * ever exercised when a selection is actually warped, so it is pulled out of the
 * App chunk (see platform/deferredModules.js). Import this barrel *only* through
 * `deferredHomography` — a static import would put it straight back on the
 * critical path.
 */

export { Homography, calculateTransformMatrix, applyProjectiveTransformToPoint } from './homography.js';
export {
  calculateCornerBounds,
  computeWarpOutputBounds,
  performHomographyTransform,
  imageDataToCanvas
} from './homographyUtils.js';
