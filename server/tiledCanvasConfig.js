/** @fileoverview Global kill switch for the tiled-canvas-backing-store experiment. */

// Load .env HERE rather than relying on an earlier import having done it. This
// const is evaluated at module-eval time, so without this line its value depends
// on `server/index.js` importing something that loads dotenv (db.js at :12,
// config.js at :13) *before* this module (:38). Reordering those imports would
// silently make the kill switch read `undefined !== 'true'` -> false: no error,
// tiling globally off, and `.env` still showing it set. That is the rollback
// lever, so it should not be load-bearing on a line number.
// `dotenv/config` is idempotent, so this is free where dotenv is already loaded.
import 'dotenv/config';

export const ENABLE_TILED_CANVAS_BACKING_STORE = process.env.ENABLE_TILED_CANVAS_BACKING_STORE === 'true';
