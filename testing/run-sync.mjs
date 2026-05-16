#!/usr/bin/env node
/**
 * Stable-shape wrapper around comprehensive_sync_suite.js.
 *
 * Usage:
 *   node testing/run-sync.mjs                        # full suite
 *   node testing/run-sync.mjs flowPen_step_1         # ONLY=flowPen_step_1
 *   node testing/run-sync.mjs brush ink              # ONLY=brush,ink
 *   node testing/run-sync.mjs --no-flood --no-concurrent --no-special   # skip sections
 *   node testing/run-sync.mjs --tools=flowPen,line   # TOOLS filter
 *   node testing/run-sync.mjs --headed               # show browser windows
 *   node testing/run-sync.mjs --users=4              # NUM_USERS=4
 *
 * Flags can be combined with name filters:
 *   node testing/run-sync.mjs flowPen_step_1 --no-flood
 */

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const names = [];

for (const a of args) {
  if (a === '--no-flood')         process.env.SKIP_FLOOD = 'true';
  else if (a === '--no-concurrent') process.env.SKIP_CONCURRENT = 'true';
  else if (a === '--no-special')    process.env.SKIP_SPECIAL = 'true';
  else if (a === '--headed')        process.env.HEADLESS = 'false';
  else if (a.startsWith('--tools=')) process.env.TOOLS = a.slice('--tools='.length);
  else if (a.startsWith('--users=')) process.env.NUM_USERS = a.slice('--users='.length);
  else if (a.startsWith('--propagation=')) process.env.PROPAGATION_MS = a.slice('--propagation='.length);
  else if (a.startsWith('--drawer=')) process.env.DRAWER = a.slice('--drawer='.length);
  else if (a.startsWith('--')) {
    console.error(`Unknown flag: ${a}`);
    process.exit(2);
  }
  else names.push(a);
}

if (names.length) process.env.ONLY = names.join(',');

const suitePath = path.join(__dirname, 'puppeteer', 'comprehensive_sync_suite.js');
await import(pathToFileURL(suitePath).href);
