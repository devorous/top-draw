import { buildDirectMessageRoomId } from '../../shared/identity.js';

/**
 * Generates a room_id from two user IDs (alphabetically sorted).
 */
export function getRoomId(uid1, uid2) {
  return buildDirectMessageRoomId(uid1, uid2);
}

/**
 * Encrypts a string using AES-GCM 256.
 * Note: In a real E2EE system, the key would be derived from a shared secret.
 * For this 'lite' version, we assume a pre-shared key or a derived one.
 */
export async function encryptMessage(text, key) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const ciphertext = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );
  return {
    encrypted_content: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
    iv: btoa(String.fromCharCode(...iv))
  };
}

export async function decryptMessage(encrypted_content, iv_base64, key) {
  const ciphertext = Uint8Array.from(atob(encrypted_content), c => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(iv_base64), c => c.charCodeAt(0));
  const decrypted = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(decrypted);
}

// Utility to import/generate keys (Simplified)
export async function getMessageKey(roomId) {
  // For demonstration, deriving a key from the roomId.
  // In production, use Web Crypto PBKDF2 with a shared secret.
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw",
    enc.encode(roomId + "SALT"), // Simple deterministic key for demo
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode("static-salt"),
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}
