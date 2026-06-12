/**
 * CLI script to set a user's role.
 *
 * Usage:
 *   node server/scripts/set-role.js <username> <role>
 *
 * Role values:
 *   0=GUEST  1=USER  2=TRUSTED  3=HELPER  4=MOD  5=ADMIN
 *   6=OWNER  7=NOBLE  8=HOLY  9=DEITY
 *
 * Example — promote Kyle to DEITY:
 *   node server/scripts/set-role.js Kyle 9
 */

import 'dotenv/config';
import { connectDB } from '../db.js';
import { RoleNames } from '../SessionManager.js';

const [,, username, roleArg] = process.argv;

if (!username || roleArg === undefined) {
  console.error('Usage: node server/scripts/set-role.js <username> <role 0-9>');
  process.exit(1);
}

const role = parseInt(roleArg, 10);
if (isNaN(role) || role < 0 || role > 9) {
  console.error(`Invalid role "${roleArg}". Must be 0–9.`);
  process.exit(1);
}

const db = await connectDB();
const result = await db.collection('users').updateOne(
  { username: { $regex: new RegExp(`^${username}$`, 'i') } },
  { $set: { role } }
);

if (result.matchedCount === 0) {
  console.error(`User "${username}" not found.`);
  process.exit(1);
}

console.log(`✓ Set ${username} → ${RoleNames[role]} (${role})`);
process.exit(0);
