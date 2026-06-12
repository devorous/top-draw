/**
 * @fileoverview Server-side encryption-at-rest for direct messages.
 *
 * DM ciphertext is stored in Mongo encrypted with a key derived from a
 * server-held secret (SERVER_DM_SECRET) via HKDF, scoped per conversation by
 * roomId. A database dump alone cannot be decrypted without the secret, while
 * the server (and therefore moderation tooling) can still read messages.
 *
 * This is encryption-at-rest, NOT end-to-end encryption: the server holds the
 * key. Clients send and receive plaintext over the TLS (wss://) connection.
 */

import crypto from 'crypto';
import { getDmSecret } from './config.js';

const HKDF_SALT = 'top-draw-dm-rest-v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

// Legacy (client-side "lite") scheme parameters — used only to decrypt messages
// stored before encryption moved server-side. See src/utils/crypto.js history.
const LEGACY_PBKDF2_SALT = 'static-salt';
const LEGACY_PBKDF2_ITERS = 100000;

/** Derives a 32-byte AES key for a conversation from the server secret. */
function deriveRoomKey(roomId) {
  const secret = getDmSecret();
  const derived = crypto.hkdfSync('sha256', secret, HKDF_SALT, String(roomId), KEY_BYTES);
  return Buffer.from(derived);
}

/** Reproduces the old client PBKDF2 key so legacy rows remain readable. */
function deriveLegacyRoomKey(roomId) {
  return crypto.pbkdf2Sync(`${roomId}SALT`, LEGACY_PBKDF2_SALT, LEGACY_PBKDF2_ITERS, KEY_BYTES, 'sha256');
}

function gcmDecrypt(key, ivB64, contentB64) {
  const iv = Buffer.from(ivB64, 'base64');
  const blob = Buffer.from(contentB64, 'base64');
  // Web Crypto and our encrypt() both append the GCM tag to the ciphertext.
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ciphertext = blob.subarray(0, blob.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Encrypts plaintext for storage.
 * @returns {{ encrypted_content: string, iv: string }} base64 fields
 */
export function encryptMessageContent(text, roomId) {
  const key = deriveRoomKey(roomId);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const blob = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return {
    encrypted_content: blob.toString('base64'),
    iv: iv.toString('base64')
  };
}

/**
 * Decrypts a stored message. Falls back to the legacy client-derived key so
 * pre-migration history stays readable. Returns null if neither key works.
 */
export function decryptMessageContent(encryptedContent, iv, roomId) {
  try {
    return gcmDecrypt(deriveRoomKey(roomId), iv, encryptedContent);
  } catch {
    try {
      return gcmDecrypt(deriveLegacyRoomKey(roomId), iv, encryptedContent);
    } catch {
      return null;
    }
  }
}
