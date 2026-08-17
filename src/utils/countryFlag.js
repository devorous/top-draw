/** @fileoverview Converts an ISO 3166-1 alpha-2 country code into its flag emoji. */

const REGIONAL_INDICATOR_BASE = 0x1f1e6; // 🇦

export function countryCodeToFlagEmoji(countryCode) {
  const code = String(countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return String.fromCodePoint(
    ...[...code].map((char) => REGIONAL_INDICATOR_BASE + (char.charCodeAt(0) - 65))
  );
}
