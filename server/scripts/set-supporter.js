/**
 * CLI script to grant or revoke supporter status (for local testing).
 *
 * Usage:
 *   node server/scripts/set-supporter.js <username> <days>
 *
 * <days> sets supporterUntil to now + days. Use 0 to revoke immediately.
 *
 * Example — make Kyle a supporter for 30 days:
 *   node server/scripts/set-supporter.js Kyle 30
 */

import 'dotenv/config';
import { connectDB } from '../db.js';

const [,, username, daysArg] = process.argv;

if (!username || daysArg === undefined) {
  console.error('Usage: node server/scripts/set-supporter.js <username> <days>');
  process.exit(1);
}

const days = Number(daysArg);
if (!Number.isFinite(days) || days < 0) {
  console.error(`Invalid days "${daysArg}". Must be a number >= 0.`);
  process.exit(1);
}

const supporterUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

const db = await connectDB();
const result = await db.collection('users').updateOne(
  { username: { $regex: new RegExp(`^${username}$`, 'i') } },
  { $set: { supporterUntil } }
);

if (result.matchedCount === 0) {
  console.error(`User "${username}" not found.`);
  process.exit(1);
}

console.log(days === 0
  ? `✓ Revoked supporter status for ${username}`
  : `✓ ${username} is a supporter until ${supporterUntil.toISOString()}`);
process.exit(0);
