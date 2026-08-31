/**
 * Display name shown instead of the uploader on a gallery item whose author
 * opted out of the username tag. It is a LABEL, never a username: nothing that
 * resolves a name to an account may be handed this string, or an account that
 * happens to be called "Anonymous" inherits every anonymised upload.
 */
export const ANONYMOUS_AUTHOR = 'Anonymous';

export const USERNAME_MIN_LENGTH = 2;
export const USERNAME_MAX_LENGTH = 20;

function toUsernameCodePoints(value) {
  return Array.from(String(value || '').normalize('NFC'));
}

export function truncateUsername(value, maxLength = USERNAME_MAX_LENGTH) {
  return toUsernameCodePoints(value).slice(0, maxLength).join('');
}

export function normalizeUsername(value) {
  return truncateUsername(String(value || '').trim(), USERNAME_MAX_LENGTH);
}

export function isValidUsername(value) {
  const username = normalizeUsername(value);
  if (!username) return false;

  const length = Array.from(username).length;
  if (length < USERNAME_MIN_LENGTH || length > USERNAME_MAX_LENGTH) {
    return false;
  }

  // Keep usernames single-line and JSON/log friendly while allowing
  // essentially any visible Unicode text, symbols, and emoji.
  return !/[\u0000-\u001F\u007F]/u.test(username);
}

export function getUsernameValidationMessage() {
  return `Username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters and cannot contain control characters`;
}

export function buildDirectMessageRoomId(userA, userB) {
  const [a, b] = [String(userA || ''), String(userB || '')].sort();

  // Preserve the legacy format for existing conversations unless a colon
  // would make the pair ambiguous.
  if (!a.includes(':') && !b.includes(':')) {
    return `${a}:${b}`;
  }

  return JSON.stringify([a, b]);
}

export function isValidDirectMessageRoomId(roomId, userA, userB) {
  if (!roomId || !userA || !userB) return false;
  return roomId === buildDirectMessageRoomId(userA, userB);
}

export function getDirectMessageRoomParticipants(roomId) {
  const value = String(roomId || '').trim();
  if (!value) return null;

  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.length === 2 && parsed.every(part => typeof part === 'string')) {
        return parsed;
      }
    } catch {
      return null;
    }
    return null;
  }

  const participants = value.split(':');
  return participants.length === 2 ? participants : null;
}
