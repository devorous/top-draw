#!/usr/bin/env node
/**
 * @fileoverview Guard: can a connected client that touches nothing ever go AFK?
 *
 * `isUserActivityMessage` treats every message NOT in `NON_USER_ACTIVITY_TYPES`
 * as deliberate user activity, so a single automated sender on a timer under
 * 5 minutes keeps a client permanently non-AFK. That denylist fails OPEN: every
 * new background message type silently disables the entire inactivity subsystem
 * — draw filtering for idle clients, the resync prompt, COMPRESS_USER_STROKES
 * and the all-AFK BOARD_SNAPSHOT_RESTORE — until somebody remembers to add it.
 * It has now failed open FIVE times (see docs/afk_parity_session_2026-08-08.md),
 * and each time the symptom was invisible: AFK simply never fired.
 *
 * Guessing the culprits from `grep` produced two wrong answers, so this measures
 * instead: join a room, touch nothing, count every outbound message type, and
 * classify each one exactly the way the server does.
 *
 * TWO checks, and the second is the one that matters:
 *   1. no idle-client transmission classifies as user activity (the detector)
 *   2. with --idle past AFK_TIMEOUT + AFK_CHECK_INTERVAL, the client is ACTUALLY
 *      marked AFK (the outcome). Check 1 can pass while 1 is incomplete; check 2
 *      cannot be fooled by a sender this probe failed to anticipate.
 *
 *   npm run test:afkactivity                        (2 min — detector only)
 *   npm run test:afkactivity -- --idle=6m            (asserts AFK actually fires)
 *   npm run test:afkactivity -- --idle=6m --room=lobby
 *        ↑ REQUIRED to see BOARD_SNAPSHOT_GET/`snapshot_probe`: only a
 *          snapshot-backed room (RoomManager.canPersistSnapshots) mints
 *          checkpoints, so only there does every client fire a parity probe
 *          every 15 s. That sender survived every earlier run for this reason.
 *   npm run test:afkactivity -- --peers=2            (with company)
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';

// server/SessionManager.js — mirrored, not imported, so a drift shows up here.
const SRV_AFK_TIMEOUT_MS = 5 * 60 * 1000;
const SRV_AFK_CHECK_MS   = 30 * 1000;
const AFK_EXPECTED_AFTER = SRV_AFK_TIMEOUT_MS + SRV_AFK_CHECK_MS;

let IDLE_MS = 120_000;
let PEERS = 1;                 // total clients in the room (>=2 exercises presence traffic)
let ROOM_ID = null;
let HEADLESS = process.env.HEADLESS !== 'false';
for (const a of process.argv.slice(2)) {
  if (a === '--headed') HEADLESS = false;
  else if (a.startsWith('--idle=')) {
    const s = a.slice(7);
    IDLE_MS = /^\d+$/.test(s) ? +s
      : [...s.matchAll(/(\d+)([sm])/g)].reduce((n, m) => n + (+m[1]) * (m[2] === 'm' ? 60000 : 1000), 0);
  } else if (a.startsWith('--peers=')) PEERS = Math.max(1, +a.slice(8));
  else if (a.startsWith('--room=')) ROOM_ID = a.slice(7);
  else { console.error(`Unknown flag: ${a}`); process.exit(2); }
}

const ROOM = ROOM_ID || `afkprobe_${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve wire numbers → names, and read the server's current denylist. */
function loadTypes() {
  const root = path.join(__dirname, '..', '..');
  const src = fs.readFileSync(path.join(root, 'shared', 'MessageTypes.js'), 'utf8');
  const block = src.match(/export const T = \{[\s\S]*?\};/)[0];
  const byNum = {};
  for (const p of block.matchAll(/(\w+)\s*:\s*(\d+)/g)) byNum[p[2]] = p[1];
  const srv = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const setSrc = srv.match(/const NON_USER_ACTIVITY_TYPES = new Set\(\[([\s\S]*?)\]\);/)[1];
  const excluded = new Set([...setSrc.matchAll(/T\.(\w+)/g)].map((x) => x[1]));
  return { byNum, excluded };
}

/**
 * The server's verdict for one captured send, reproduced.
 *
 * Three wire types are DUAL-USE — the same number carries both a real user
 * action and an automated one, told apart only by a payload flag — so they are
 * handled inside `isUserActivityMessage` and are deliberately absent from the
 * denylist. Classifying them by the set alone reports false positives on exactly
 * the senders that were fixed most recently.
 */
function classify(msg, name, excluded) {
  if (name === 'MM') return { activity: !!msg.mousedown, why: 'only while the button is held' };
  if (name === 'BOARD_SNAPSHOT_SAVE') return { activity: !msg.a, why: 'a:true = the server\'s own snapshot timer' };
  if (name === 'BOARD_SNAPSHOT_GET') return { activity: !msg.snapshotProbe, why: 'snapshot_probe = automatic parity fetch' };
  return { activity: !excluded.has(name), why: excluded.has(name) ? 'in NON_USER_ACTIVITY_TYPES' : 'NOT in NON_USER_ACTIVITY_TYPES' };
}

async function spawnClient(label) {
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 760 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => process.stderr.write(`  [${label} ERR] ${e.message}\n`));
  // Count EVERY outbound message, with the payload flags the server's dual-use
  // gates read, before the app has a chance to connect.
  await page.evaluateOnNewDocument(() => {
    window.__out = [];
    const hook = () => {
      const ws = window.app?.wsClient;
      if (!ws || ws.__outHooked) return !!ws?.__outHooked;
      ws.__outHooked = true;
      const orig = ws.send.bind(ws);
      ws.send = (msg) => {
        if (msg && msg.t != null) {
          window.__out.push({
            t: msg.t, at: Date.now(),
            a: !!msg.a, snapshotProbe: !!msg.snapshotProbe,
            mousedown: !!window.app?.self?.mousedown,
          });
        }
        return orig(msg);
      };
      return true;
    };
    const iv = setInterval(() => { if (hook()) clearInterval(iv); }, 50);
  });
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });
  await page.evaluate((n, r) => { window.app.self.username = n; window.app.handleRoomSelected(r); }, label, ROOM);
  await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
    { timeout: 60_000 });
  return { label, browser, page };
}

async function main() {
  const { byNum, excluded } = loadTypes();
  const willAssertAfk = IDLE_MS >= AFK_EXPECTED_AFTER;
  console.log(`\nAFK activity guard — what does an idle client transmit, and does AFK fire?`);
  console.log(`Room:   ${ROOM}   clients: ${PEERS}`);
  console.log(`Idle:   ${Math.round(IDLE_MS / 1000)}s of touching nothing`);
  console.log(willAssertAfk
    ? `AFK:    expected by +${Math.round(AFK_EXPECTED_AFTER / 1000)}s — this run ASSERTS it fires`
    : `AFK:    not asserted (need --idle >= ${Math.round(AFK_EXPECTED_AFTER / 1000)}s); detector only`);
  if (!ROOM_ID) {
    console.log(`Note:   ad-hoc room — BOARD_SNAPSHOT_GET/snapshot_probe cannot appear here.`);
    console.log(`        Use --room=lobby to cover that sender.`);
  }
  console.log('');

  const clients = [];
  try {
    for (let i = 0; i < PEERS; i++) clients.push(await spawnClient(`PROBE_${i}`));
    await sleep(3000);
    // Baseline AFTER join, so the connect/sync handshake is excluded and only
    // steady-state idle traffic is counted.
    const t0 = Date.now();
    await Promise.all(clients.map((c) => c.page.evaluate(() => { window.__mark = window.__out.length; })));
    console.log(`  joined; counting from here for ${Math.round(IDLE_MS / 1000)}s …`);

    // Poll for the AFK transition rather than only sampling at the end: WHEN it
    // fired is the useful number, and "never" is the failure being guarded.
    let afkAtMs = null;
    const subject = clients[0];
    const deadline = Date.now() + IDLE_MS;
    while (Date.now() < deadline) {
      await sleep(5000);
      if (afkAtMs == null) {
        // app.self, not the users map: the T.AFK handler calls app.self.setAfk()
        // for our own session and returns before touching app.users.
        const afk = await subject.page.evaluate(() => !!window.app?.self?.afk).catch(() => false);
        if (afk) {
          afkAtMs = Date.now() - t0;
          console.log(`  ${subject.label} marked AFK at +${Math.round(afkAtMs / 1000)}s`);
        }
      }
    }

    const out = await subject.page.evaluate(() => window.__out.slice(window.__mark));
    const elapsed = (Date.now() - t0) / 1000;

    // Group by (type, verdict): one wire type can legitimately produce both an
    // activity and a non-activity row, and collapsing them hides the split.
    const rows = new Map();
    for (const m of out) {
      const name = byNum[m.t] || `? (${m.t})`;
      const v = classify(m, name, excluded);
      const key = `${name}|${v.activity}`;
      const row = rows.get(key) || { name, t: +m.t, n: 0, ...v };
      row.n++;
      rows.set(key, row);
    }
    const sorted = [...rows.values()].sort((a, b) => b.n - a.n);

    console.log(`\n  ${subject.label} sent ${out.length} messages in ${elapsed.toFixed(0)}s while idle:\n`);
    console.log(`     type                         count   every    counts as activity?`);
    const guilty = [];
    for (const r of sorted) {
      const period = r.n > 1 ? `${(elapsed / r.n).toFixed(0)}s` : '—';
      if (r.activity) guilty.push({ ...r, period });
      console.log(`     ${r.name.padEnd(28)} ${String(r.n).padStart(5)}   ${period.padStart(5)}   `
        + (r.activity ? `YES — resets AFK timer  (${r.why})` : `no  (${r.why})`));
    }

    console.log('');
    if (guilty.length === 0) {
      console.log(`  ✅ nothing an idle client sends counts as user activity`);
    } else {
      console.log(`  ❌ ${guilty.length} type(s) reset the AFK timer with no user involved:`);
      for (const g of guilty) console.log(`       T.${g.name} (${g.t}) — ${g.n}x, about every ${g.period}`);
      console.log(`\n     Each must be excluded in server/index.js — added to`);
      console.log(`     NON_USER_ACTIVITY_TYPES, or payload-gated inside`);
      console.log(`     isUserActivityMessage if the wire type is dual-use.`);
    }

    let afkOk = true;
    if (willAssertAfk) {
      afkOk = afkAtMs != null;
      console.log(afkOk
        ? `  ✅ AFK fired at +${Math.round(afkAtMs / 1000)}s (expected ≈+${Math.round(AFK_EXPECTED_AFTER / 1000)}s)`
        : `  ❌ AFK NEVER fired in ${elapsed.toFixed(0)}s of doing nothing — the inactivity`
          + `\n     subsystem is dead. Draw filtering, the resync prompt,`
          + `\n     COMPRESS_USER_STROKES and the all-AFK restore are all disabled.`);
      if (!afkOk && guilty.length === 0) {
        console.log(`     Note: no guilty sender was identified, so the cause is NOT the`);
        console.log(`     denylist — look at the eligibility guard in SessionManager`);
        console.log(`     .checkAfkUsers (AFK_DEBUG=1 prints each user's idle age).`);
      }
    }

    process.exitCode = (guilty.length === 0 && afkOk) ? 0 : 1;
  } finally {
    for (const c of clients) await c.browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error('Uncaught:', e); process.exit(2); });
