/**
 * Supporter subscription helpers.
 *
 * A user is an active supporter while their `supporterUntil` timestamp is in
 * the future. The field is set by the Stripe webhook (subscription period end
 * plus a grace window) or manually via server/scripts/set-supporter.js.
 */

/**
 * Whether a user document has an active supporter subscription.
 * @param {Object|null} userDoc - Mongo user document (or null).
 * @returns {boolean}
 */
export function isSupporterActive(userDoc) {
  if (!userDoc || !userDoc.supporterUntil) return false;
  const until = new Date(userDoc.supporterUntil).getTime();
  return Number.isFinite(until) && until > Date.now();
}
