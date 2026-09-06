/**
 * @fileoverview Tiled-canvas-backing-store configuration.
 *
 * Tiling is **ON for every room by default, in code**. It needs no environment
 * variable to run, because the deployed server gets no `.env`: `.dockerignore`
 * excludes it, the runtime image copies only dist/server/shared/public/wasm/data,
 * and the only baked ENV lines are NODE_ENV and PORT. Anything gated behind an
 * unset `=== 'true'` check was therefore silently OFF in production no matter
 * what the local `.env` said — which is exactly what happened to this feature.
 *
 * Both flags below are read as opt-OUT (`!== 'false'`), so the rollback levers
 * still exist and still work without a redeploy on any host that can inject env:
 *
 *   ENABLE_TILED_CANVAS_BACKING_STORE=false   turn the feature off everywhere
 *   TILED_CANVAS_FORCE_ALL=false              back to per-room opt-in
 *
 * Set neither and you get tiling on for everyone, which is the intent.
 */

// Load .env HERE rather than relying on an earlier import having done it. This
// const is evaluated at module-eval time, so without this line its value depends
// on `server/index.js` importing something that loads dotenv (db.js at :12,
// config.js at :13) *before* this module (:38). Reordering those imports would
// silently make the kill switch read `undefined !== 'true'` -> false: no error,
// tiling globally off, and `.env` still showing it set. That is the rollback
// lever, so it should not be load-bearing on a line number.
// `dotenv/config` is idempotent, so this is free where dotenv is already loaded.
import 'dotenv/config';

export const ENABLE_TILED_CANVAS_BACKING_STORE =
  process.env.ENABLE_TILED_CANVAS_BACKING_STORE !== 'false';

/**
 * Trial override: treat EVERY room as tiled, whatever its own setting says.
 *
 * `TILED_CANVAS_DEFAULT` cannot do this on its own — it only seeds
 * `RoomManager`'s in-memory default, so it reaches *newly minted* rooms. Any
 * room that has ever been saved has `settings.tiledCanvasBackingStore` written
 * explicitly by `Room.saveToDB`, and `loadFromDB` reads it back with `!!`, so
 * every persisted room comes up false and stays false no matter what the
 * default is. Those are exactly the rooms with real users in them.
 *
 * This flag overrides at READ time and never writes, so each room keeps its own
 * stored preference untouched underneath: set it to `false` and the whole
 * per-room opt-in behaves exactly as it did before, with no DB migration to
 * undo. The `ENABLE_TILED_CANVAS_BACKING_STORE` kill switch still wins over
 * both — it is the one lever that turns the feature off everywhere.
 *
 * Defaults ON (opt-out), for the reason in the file header.
 */
export const TILED_CANVAS_FORCE_ALL = process.env.TILED_CANVAS_FORCE_ALL !== 'false';

/**
 * Whether a room should run the tiled backing store right now.
 * @param {{settings?: {tiledCanvasBackingStore?: boolean}}} room
 * @returns {boolean}
 */
export function roomTiledCanvasEnabled(room) {
  if (!ENABLE_TILED_CANVAS_BACKING_STORE) return false;
  if (TILED_CANVAS_FORCE_ALL) return true;
  return !!room?.settings?.tiledCanvasBackingStore;
}

/**
 * Whether the per-room checkbox should be offered.
 *
 * Hidden while the trial override is on, for the same reason the kill switch
 * hides it: the setting would save happily and change nothing. Same rationale
 * as the `roomTiledCanvasAvailable` note in `server/index.js`.
 * @returns {boolean}
 */
export function roomTiledCanvasSettable() {
  return ENABLE_TILED_CANVAS_BACKING_STORE && !TILED_CANVAS_FORCE_ALL;
}
