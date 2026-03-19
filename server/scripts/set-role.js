/**
 * CLI script to set a user's role.
 *
 * Usage:
 *   node server/scripts/set-role.js <username> <role>
 *
 * Role values:
 *   0=GUEST  1=USER  2=TRUSTED  3=HELPER  4=MOD  5=ADMIN
 *   6=NOBLE  7=HOLY  8=DEITY
 *
 * Example — promote Kyle to DEITY:
 *   node server/scripts/set-role.js Kyle 8
 */

import 'dotenv/config';
import { connectDB } from '../db.js';

const ROLE_NAMES = ['GUEST', 'USER', 'TRUSTED', 'HELPER', 'MOD', 'ADMIN', 'NOBLE', 'HOLY', 'DEITY'];

const [,, username, roleArg] = process.argv;

if (!username || roleArg === undefined) {
  console.error('Usage: node server/scripts/set-role.js <username> <role 0-8>');
  process.exit(1);
}

const role = parseInt(roleArg, 10);
if (isNaN(role) || role < 0 || role > 8) {
  console.error(`Invalid role "${roleArg}". Must be 0–8.`);
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

console.log(`✓ Set ${username} → ${ROLE_NAMES[role]} (${role})`);
process.exit(0);
