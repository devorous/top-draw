/** @fileoverview Helpers for deriving the room-local identity used by uploader election and uploads. */

function cleanUploaderName(value) {
  const name = String(value || '').trim();
  if (!name || name === 'Unknown') return null;
  return name;
}

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
  return cleanUploaderName(user?.registeredName)
    || cleanUploaderName(user?.name)
    || cleanUploaderName(ws.username)
    || (ws.sessionIndex !== undefined ? `User ${ws.sessionIndex}` : null);
}
