/** @fileoverview Helpers for deriving the room-local identity used by uploader election and uploads. */

/**
 * Returns the room-local uploader identity for a client.
 * Prefers the registered account name, then the room display name.
 *
 * @param {Room} room
 * @param {WebSocket} ws
 * @returns {string|null}
 */
export function getUploaderIdentity(room, ws) {
  if (!room || !ws) return null;

  const user = room.sessionManager?.getUser(ws.sessionIndex);
  return user?.registeredName || user?.name || ws.username || null;
}
