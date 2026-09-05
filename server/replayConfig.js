/** @fileoverview Feature flags for server-side replay persistence. */

// See the note in tiledCanvasConfig.js: this const is evaluated at module-eval
// time, so loading dotenv here rather than depending on import order in
// server/index.js is what keeps the flag honest. Idempotent.
import 'dotenv/config';

export const ENABLE_SERVER_REPLAY_DB = process.env.ENABLE_SERVER_REPLAY_DB === 'true';
