/** @fileoverview Feature flags for server-side replay persistence. */

export const ENABLE_SERVER_REPLAY_DB = process.env.ENABLE_SERVER_REPLAY_DB === 'true';
