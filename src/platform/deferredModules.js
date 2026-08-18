/**
 * @fileoverview Registry for heavy subsystems that are split out of the App chunk.
 *
 * Nothing here is needed to paint the first frame or to draw a stroke, so each
 * entry is imported dynamically and lands in its own chunk. They are *deferred*,
 * not on-demand: `preloadRoomModules()` warms every entry while the user is
 * still on the landing page, so by the time a room is joined the code is already
 * resident and `load()` resolves on the microtask queue.
 *
 * Call sites that can tolerate "not ready yet" read `.current` (synchronous,
 * null until loaded). Call sites that cannot await `.load()`.
 */

import { debug } from '../utils/debug.js';

/**
 * @typedef {object} DeferredModule
 * @property {string} name
 * @property {object|null} current   Loaded namespace, or null. Never throws.
 * @property {boolean} isLoaded
 * @property {() => Promise<object>} load
 */

/**
 * Wraps a dynamic import in a memoised handle.
 * @param {string} name Label used in diagnostics.
 * @param {() => Promise<object>} loader Thunk returning the dynamic import.
 * @returns {DeferredModule}
 */
function defineDeferred(name, loader) {
  let value = null;
  let inflight = null;

  return {
    name,
    get current() { return value; },
    get isLoaded() { return value !== null; },
    load() {
      if (value) return Promise.resolve(value);
      if (inflight) return inflight;

      const startedAt = performance.now();
      inflight = loader()
        .then((mod) => {
          value = mod;
          inflight = null;
          debug(`[deferred] ${name} ready in ${Math.round(performance.now() - startedAt)}ms`);
          return mod;
        })
        .catch((err) => {
          // Leave `inflight` null so a later call retries rather than reusing
          // a rejected promise — a transient chunk 404 after a deploy is the
          // common case, and the caller may well try again.
          inflight = null;
          console.error(`[deferred] ${name} failed to load:`, err);
          throw err;
        });

      return inflight;
    }
  };
}

/**
 * Replay stack: TimeMachine, ReplayEngine, the tape recorders, the timelapse
 * capturer/exporter and every Svelte surface that drives them.
 * Largest single entry (~225 kB) and needed only once a room is live.
 */
export const deferredReplay = defineDeferred('replay', () => import('../timebar/replayBundle.js'));

/**
 * Perspective-warp maths for the Select tool. Reached both locally (Select
 * tool warp handles) and remotely (an inbound SEL_LIFT carrying a warp), so it
 * must be warm before the first remote selection can arrive.
 */
export const deferredHomography = defineDeferred('homography', () => import('../utils/homographyBundle.js'));

/**
 * Admin panel. Deity-only, so it is excluded from the standard preload set and
 * warmed separately once the server confirms the role.
 */
export const deferredAdminPanel = defineDeferred('adminPanel', () => import('../ui/svelte/AdminPanel.svelte'));

/** Global role that unlocks the admin panel. Mirrors server/roomRoles.js DEITY. */
export const ADMIN_PANEL_MIN_ROLE = 9;

/**
 * Warms everything a live room needs. Fire-and-forget: failures are logged by
 * `load()` and each call site still awaits its own handle before use, so a
 * failed preload degrades to a lazy load rather than a broken room.
 * @returns {Promise<void>} Resolves once the set has settled.
 */
export async function preloadRoomModules() {
  await Promise.allSettled([
    deferredReplay.load(),
    deferredHomography.load()
  ]);
}

/**
 * Warms the admin panel. Separate from `preloadRoomModules` so the chunk is
 * only ever fetched by accounts that can actually open it. Takes the same
 * effective role the admin button gates on, so the two never disagree.
 * @param {number} role Effective role as resolved by App.selfRole.
 * @returns {Promise<void>}
 */
export async function preloadAdminModules(role) {
  if (!(role >= ADMIN_PANEL_MIN_ROLE)) return;
  await deferredAdminPanel.load().catch(() => {});
}
