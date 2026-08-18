/**
 * @fileoverview Synchronous accessor for the deferred perspective-warp chunk.
 *
 * `RemoteSelectionHandler` reaches the warp maths from inbound-message handlers
 * that cannot be made async without reordering selection traffic, so it reads
 * the module synchronously through here instead.
 *
 * In practice the chunk is always resident by then: App awaits
 * `whenRoomModulesReady()` before the socket joins a room, and the warp is only
 * reachable from room traffic. The null return exists for the pathological case
 * (preload rejected, e.g. a chunk 404 mid-deploy) — every caller already has a
 * fallback for a failed warp, so a miss degrades to an untransformed selection
 * rather than a broken handler.
 */

import { deferredHomography } from '../platform/deferredModules.js';

let warnedOnce = false;

/**
 * @returns {object|null} The homography namespace, or null if it is not loaded.
 */
export function getHomography() {
  const mod = deferredHomography.current;
  if (mod) return mod;

  if (!warnedOnce) {
    warnedOnce = true;
    console.error('[homography] warp requested before the chunk was resident — falling back to untransformed output');
  }
  // Kick a load so the next warp succeeds.
  void deferredHomography.load().catch(() => {});
  return null;
}
