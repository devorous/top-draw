import { buildDirectMessageRoomId } from '../../shared/identity.js';

/**
 * Generates a room_id from two user IDs (alphabetically sorted).
 *
 * Direct messages are encrypted at rest server-side (see server/messageCrypto.js);
 * clients exchange plaintext over the TLS WebSocket connection, so no client-side
 * key derivation or message encryption happens here anymore.
 */
export function getRoomId(uid1, uid2) {
  return buildDirectMessageRoomId(uid1, uid2);
}
