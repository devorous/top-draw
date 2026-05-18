#!/usr/bin/env node

/**
 * @fileoverview Moderation Test Suite for Top Draw.
 *
 * Spawns two puppeteer bots — `mod_bot` (MOD role 4) and `target_bot` (USER role 1) —
 * joins them to the same room, and exercises the moderation flows:
 *
 *   • mute / unmute        — target's chat is rejected with "You are muted"
 *   • kick                 — target's WS closes with code 4002
 *   • ban / unban          — target's WS closes with 4001, rejoin blocked until unbanned
 *   • permission denial    — target attempts mod action, receives auth error
 *
 * MongoDB is required. The suite registers two fresh test users per run
 * (`tmod_<runId>_mod` / `tmod_<runId>_target`), promotes the mod bot via direct
 * DB update, and deletes both users + any moderation entries on exit.
 *
 * Usage:
 *   node testing/puppeteer/moderation_suite.js
 *
 * Env vars:
 *   TARGET_URL       Frontend URL                  (default: http://localhost:3000/go/)
 *   SERVER_URL       Backend HTTP origin           (default: http://localhost:3000)
 *   MONGODB_URI      Mongo connection string       (default: mongodb://127.0.0.1:27017)
 *   MONGODB_DB_NAME  Mongo database name           (default: Draw)
 *   HEADLESS         "false" to show browser       (default: true)
 *   PROPAGATION_MS   Wait after each action        (default: 1500)
 *   ONLY             Comma-sep test-name filter    (e.g. mute,ban_then_unban)
 *   KEEP             "true" to skip cleanup        (default: false; for debugging)
 */

import puppeteer from 'puppeteer';
import { MongoClient, ObjectId } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────

const TARGET_URL      = process.env.TARGET_URL    || 'http://localhost:3000/go/';
const SERVER_URL      = process.env.SERVER_URL    || 'http://localhost:3000';
const MONGODB_URI     = process.env.MONGODB_URI   || 'mongodb://127.0.0.1:27017';
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'Draw';
const HEADLESS        = process.env.HEADLESS !== 'false';
const PROPAGATION_MS  = parseInt(process.env.PROPAGATION_MS || '1500');
const NAME_FILTER     = process.env.ONLY ? process.env.ONLY.split(',').map(s => s.trim()) : null;
const KEEP_TEST_DATA  = process.env.KEEP === 'true';

const RUN_ID          = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const RESULTS_DIR     = path.join(__dirname, '..', 'moderation_results');
const REPORT_FILE     = path.join(RESULTS_DIR, `MOD_REPORT_${RUN_ID}.md`);
const SUMMARY_FILE    = path.join(RESULTS_DIR, `MOD_SUMMARY_${RUN_ID}.json`);

// USERNAME_MAX_LENGTH is 20 server-side; keep the suffixed name under that.
const MOD_USERNAME    = `tm_${RUN_ID}_m`;
const TARGET_USERNAME = `tm_${RUN_ID}_t`;
const TEST_PASSWORD   = 'Test_Pass_1234!';

// ── Action codes (must match the MOD_ACTION_MAP order in server/index.js) ──
const MOD_KICK         = 0;
const MOD_MUTE         = 1;
const MOD_BAN          = 2;
const MOD_UNMUTE       = 3;
const MOD_UNBAN        = 4;

// Roles (see shared/identity.js / server/permissions.js).
// NOTE: roles 0-5 are *room-scoped*; only globalRole >= HOLY(8) authorizes
// every moderation action across an arbitrary room. NOBLE(7) is enough for
// mute/kick but MOD_BAN/MOD_UNBAN are gated to HOLY+ globally, so we use HOLY
// here for the broadest coverage.
const ROLE_USER = 1;
const ROLE_HOLY = 8;

// ─── Mongo Helpers ────────────────────────────────────────────────────────

let mongoClient = null;
let db = null;

async function connectMongo() {
  mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  db = mongoClient.db(MONGODB_DB_NAME);
}

async function setUserRole(username, role) {
  const res = await db.collection('users').updateOne(
    { username: { $regex: new RegExp(`^${username}$`, 'i') } },
    { $set: { role } }
  );
  if (res.matchedCount === 0) throw new Error(`Cannot set role: user "${username}" not found`);
}

async function deleteTestData() {
  // Remove the two test accounts and any mod entries referencing them.
  const usernames = [MOD_USERNAME, TARGET_USERNAME];
  await db.collection('users').deleteMany({ username: { $in: usernames } });
  await db.collection('moderation').deleteMany({
    $or: [
      { targetUsername: { $in: usernames } },
      { issuedByUsername: { $in: usernames } },
    ],
  });
}

// ─── HTTP register helper ─────────────────────────────────────────────────

async function registerUser(username, password) {
  const res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Register ${username} failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  if (!data.success || !data.token) {
    throw new Error(`Register ${username} returned no token: ${JSON.stringify(data)}`);
  }
  return { token: data.token, userId: data.userId };
}

// ─── Puppeteer bot lifecycle ──────────────────────────────────────────────

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function spawnBot(browser, label, room, authToken) {
  const page = await browser.newPage();

  // Surface console errors for debugging only — silence the chatty default.
  page.on('console', msg => {
    const txt = msg.text();
    if (/\[ERROR\]|\[Auth\]|\[Mod\]/i.test(txt)) {
      process.stdout.write(`  [${label}] ${txt}\n`);
    }
  });
  page.on('pageerror', err => process.stderr.write(`  [${label} ERR] ${err.message}\n`));

  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app != null && window.app.self != null, { timeout: 60_000 });

  // Stop drawing tick loop — moderation tests don't draw.
  await page.evaluate(() => window.app.inputBufferManager?.stopTickLoop?.());

  // Install a capture buffer that records everything we need to observe.
  // Hooks into wsClient event emitters BEFORE the room WS reconnects.
  await page.evaluate(() => {
    window.__cap = {
      authResults: [],   // {success, error, role, username}
      modNotifies: [],   // {actionType, targetName, issuerName, reason}
      modResults:  [],   // {success, error}
      chatMsgs:    [],   // {sessionIndex, message}
      closeEvents: [],   // {code, reason, at}
    };
    const ws = window.app.wsClient;

    ws.on('auth_result', e => window.__cap.authResults.push({
      success: e.success, error: e.error, role: e.role, username: e.username,
    }));
    ws.on('mod_notify', e => window.__cap.modNotifies.push({
      actionType: e.actionType, targetName: e.targetName,
      issuerName: e.issuerName, reason: e.reason,
      targetSessionIndex: e.targetSessionIndex,
    }));
    ws.on('mod_result', e => window.__cap.modResults.push({
      success: e.success, error: e.error, at: Date.now(),
    }));
    ws.on('msg', e => window.__cap.chatMsgs.push({
      sessionIndex: e.sessionIndex, message: e.message, at: Date.now(),
    }));

    // Hook into WebSocket close — capture both natural and force closes.
    // The underlying socket is `ws.ws`, re-created on reconnect; we attach a
    // listener every time it's swapped.
    const attachCloseHook = (sock) => {
      if (!sock || sock.__capHooked) return;
      sock.__capHooked = true;
      sock.addEventListener('close', (ev) => {
        window.__cap.closeEvents.push({
          code: ev.code,
          reason: ev.reason,
          at: Date.now(),
        });
      });
    };
    attachCloseHook(ws.ws);
    // Re-attach whenever the underlying socket is replaced.
    let lastSock = ws.ws;
    setInterval(() => {
      if (ws.ws !== lastSock) {
        lastSock = ws.ws;
        attachCloseHook(lastSock);
      }
    }, 100);

    // Chain App-level onDisconnect — survives socket swaps that the raw
    // addEventListener path may miss when the WebSocketClient autoreconnects.
    const prevOnDisconnect = ws.onDisconnect;
    ws.onDisconnect = (code, reason) => {
      window.__cap.closeEvents.push({ code, reason, at: Date.now(), src: 'onDisconnect' });
      if (typeof prevOnDisconnect === 'function') prevOnDisconnect(code, reason);
    };
  });

  // Join the room. This connects (or reconnects) the WebSocket.
  await page.evaluate((r, n) => {
    window.app.self.username = n;
    window.app.handleRoomSelected(r);
  }, room, label);

  // Wait for WS connection to come up.
  await page.waitForFunction(
    () => window.app?.wsClient?.connected === true,
    { timeout: 30_000 }
  );

  // Authenticate via token.
  await page.evaluate((tok) => {
    window.app.wsClient.sendAuthTokenLogin(tok);
  }, authToken);

  // Wait for AUTH_RESULT with success=true.
  await page.waitForFunction(() => {
    const a = window.__cap.authResults;
    return a.some(r => r.success === true);
  }, { timeout: 15_000 });

  // Pull session index off the app for later. (App owns the canonical index; `self`
  // is a local User constructed with sessionIndex=0 and is not the source of truth.)
  const sessionIndex = await page.evaluate(() => window.app?.sessionIndex);

  return { label, page, sessionIndex };
}

async function readCapture(bot) {
  return bot.page.evaluate(() => JSON.parse(JSON.stringify(window.__cap)));
}

async function clearCapture(bot) {
  await bot.page.evaluate(() => {
    window.__cap.authResults.length = 0;
    window.__cap.modNotifies.length = 0;
    window.__cap.modResults.length = 0;
    window.__cap.chatMsgs.length = 0;
    window.__cap.closeEvents.length = 0;
  });
}

async function sessionIndexOf(bot) {
  return bot.page.evaluate(() => window.app?.sessionIndex);
}

async function sendChat(bot, message) {
  await bot.page.evaluate((m) => {
    window.app.wsClient.broadcastChat(m, `m_${Date.now()}_${Math.random().toString(36).slice(2,8)}`);
  }, message);
}

async function sendModAction(bot, actionType, targetSessionIndex, reason = '', duration = 0) {
  await bot.page.evaluate((a, t, r, d) => {
    window.app.wsClient.sendModAction(a, t, r, d);
  }, actionType, targetSessionIndex, reason, duration);
}

async function waitForChatFromTarget(observer, targetIdx, sourceMessage, timeoutMs = 1500) {
  // Returns whether the observer saw a chat with this exact message text
  // from the target session index within the timeout.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cap = await readCapture(observer);
    if (cap.chatMsgs.some(m => m.sessionIndex === targetIdx && m.message === sourceMessage)) {
      return true;
    }
    await sleep(100);
  }
  return false;
}

async function waitForModResult(bot, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = [];
  while (Date.now() < deadline) {
    const cap = await readCapture(bot);
    lastSeen = cap.modResults;
    const hit = lastSeen.find(predicate);
    if (hit) return hit;
    await sleep(100);
  }
  return null;
}

async function waitForCloseCode(bot, code, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cap = await readCapture(bot);
    if (cap.closeEvents.some(e => e.code === code)) return true;
    await sleep(100);
  }
  return false;
}

// ─── Test Cases ───────────────────────────────────────────────────────────

/**
 * Each test:
 *   - clears capture on both bots
 *   - performs the moderator action and observes the result
 *   - returns { name, pass, detail } where detail describes the observed
 *     evidence that supported pass/fail
 *
 * Tests are ordered — ban/unban must come last because it disconnects the
 * target. We rejoin between sections rather than relying on rejoin flow.
 */

async function testPermissionDenial(modBot, targetBot) {
  await clearCapture(modBot);
  await clearCapture(targetBot);

  // Target (USER role 1) attempts to mute the moderator.
  await sendModAction(targetBot, MOD_MUTE, modBot.sessionIndex, 'should be denied', 0);

  const result = await waitForModResult(targetBot, r => r.success === false, 3000);
  if (!result) {
    return { name: 'permission_denial', pass: false, detail: 'No MOD_RESULT received within 3s' };
  }
  if (!/Insufficient permissions/i.test(result.error || '')) {
    return { name: 'permission_denial', pass: false, detail: `Wrong error: "${result.error}"` };
  }

  // Also confirm the moderator was NOT actually muted — i.e. mod can still chat.
  await clearCapture(modBot);
  await clearCapture(targetBot);
  const probe = `probe_${Date.now()}`;
  await sendChat(modBot, probe);
  const targetSawIt = await waitForChatFromTarget(targetBot, modBot.sessionIndex, probe, 2000);

  return {
    name: 'permission_denial',
    pass: !!targetSawIt,
    detail: targetSawIt
      ? `Denial received ("${result.error}"), moderator's chat still flowed`
      : `Denial received but moderator's chat did NOT propagate — unexpected side effect`,
  };
}

async function testMute(modBot, targetBot) {
  await clearCapture(modBot);
  await clearCapture(targetBot);

  // ── Baseline: target chat reaches moderator
  const baseline = `baseline_${Date.now()}`;
  await sendChat(targetBot, baseline);
  const baselineSeen = await waitForChatFromTarget(modBot, targetBot.sessionIndex, baseline, 2000);
  if (!baselineSeen) {
    return { name: 'mute', pass: false, detail: 'Baseline failed — target chat never reached moderator before muting' };
  }

  // ── Mute
  await clearCapture(modBot);
  await clearCapture(targetBot);
  await sendModAction(modBot, MOD_MUTE, targetBot.sessionIndex, 'test mute', 0);
  await sleep(PROPAGATION_MS);

  // Server doesn't send MOD_RESULT on success — only the room-wide MOD_NOTIFY.
  const modCap = await readCapture(modBot);
  const notifyOk = modCap.modNotifies.some(n => n.actionType === 1 && n.targetSessionIndex === targetBot.sessionIndex);
  if (!notifyOk) {
    return {
      name: 'mute', pass: false,
      detail: `Moderator never received MOD_NOTIFY for mute. modResults=${JSON.stringify(modCap.modResults)} modNotifies=${JSON.stringify(modCap.modNotifies)}`,
    };
  }

  // ── Target tries to chat — should be rejected with "You are muted"
  await clearCapture(modBot);
  await clearCapture(targetBot);
  const blockedMsg = `blocked_${Date.now()}`;
  await sendChat(targetBot, blockedMsg);

  const muteError = await waitForModResult(targetBot, r =>
    r.success === false && /muted/i.test(r.error || ''), 3000);
  if (!muteError) {
    return { name: 'mute', pass: false, detail: 'Target did not receive "You are muted" error' };
  }

  // Moderator should NOT have received the blocked chat
  const sawBlocked = await waitForChatFromTarget(modBot, targetBot.sessionIndex, blockedMsg, 1500);
  if (sawBlocked) {
    return { name: 'mute', pass: false, detail: 'Moderator received chat from muted target — mute not enforced' };
  }

  return { name: 'mute', pass: true, detail: 'Target chat blocked, mute error received, moderator did not see message' };
}

async function testUnmute(modBot, targetBot) {
  await clearCapture(modBot);
  await clearCapture(targetBot);

  await sendModAction(modBot, MOD_UNMUTE, targetBot.sessionIndex, '', 0);
  await sleep(PROPAGATION_MS);

  // Server-side success isn't acked individually — only the side effect
  // (target chat flowing again) is observable.

  // Target chat should now flow again.
  await clearCapture(modBot);
  await clearCapture(targetBot);
  const msg = `after_unmute_${Date.now()}`;
  await sendChat(targetBot, msg);
  const seen = await waitForChatFromTarget(modBot, targetBot.sessionIndex, msg, 2500);

  return {
    name: 'unmute',
    pass: seen,
    detail: seen ? 'Target chat reaches moderator after unmute' : 'Target chat still blocked after unmute',
  };
}

async function testKick(modBot, targetBot) {
  await clearCapture(modBot);
  await clearCapture(targetBot);

  // Refresh in case the session index drifted since spawn.
  targetBot.sessionIndex = await sessionIndexOf(targetBot);
  await sendModAction(modBot, MOD_KICK, targetBot.sessionIndex, 'test kick', 0);
  const closed = await waitForCloseCode(targetBot, 4002, 5000);

  if (!closed) {
    const modCap = await readCapture(modBot);
    return {
      name: 'kick', pass: false,
      detail: `Target WS did not close with 4002 within 5s. modResults=${JSON.stringify(modCap.modResults)} modNotifies=${JSON.stringify(modCap.modNotifies)} closeEvents=${JSON.stringify((await readCapture(targetBot)).closeEvents)}`,
    };
  }
  return { name: 'kick', pass: true, detail: 'Target WS closed with code 4002 (kick)' };
}

async function testBanThenUnban(modBot, targetBot, browser, room, targetAuthToken) {
  await clearCapture(modBot);
  await clearCapture(targetBot);

  targetBot.sessionIndex = await sessionIndexOf(targetBot);
  await sendModAction(modBot, MOD_BAN, targetBot.sessionIndex, 'test ban', 0);
  const closed = await waitForCloseCode(targetBot, 4001, 5000);
  if (!closed) {
    const modCap = await readCapture(modBot);
    const tgtCap = await readCapture(targetBot);
    return {
      name: 'ban_then_unban', pass: false,
      detail: `Target was not closed with 4001 after ban. target.sessionIndex=${targetBot.sessionIndex} modResults=${JSON.stringify(modCap.modResults)} modNotifies=${JSON.stringify(modCap.modNotifies)} targetCloseEvents=${JSON.stringify(tgtCap.closeEvents)}`,
    };
  }

  // Confirm DB recorded the ban
  const banDoc = await db.collection('moderation').findOne({
    type: 'ban',
    targetUsername: TARGET_USERNAME,
    active: true,
  });
  if (!banDoc) {
    return { name: 'ban_then_unban', pass: false, detail: 'No active ban row in moderation collection' };
  }

  // Reconnect attempt should be rejected with "You are banned"
  // We spawn a fresh page (auth token still valid) and observe AUTH_RESULT.
  let banAttempt = null;
  try {
    banAttempt = await spawnBot(browser, 'target_rejoin', room, targetAuthToken);
    // If spawnBot succeeded, the ban was NOT enforced — fail.
    await banAttempt.page.close().catch(() => {});
    return { name: 'ban_then_unban', pass: false, detail: 'Banned target reconnected successfully — ban not enforced' };
  } catch (err) {
    // Expected: spawnBot times out waiting for successful auth.
    // Tear down whatever page may have been opened.
    if (banAttempt) await banAttempt.page.close().catch(() => {});
  }

  // ── Unban
  // The server caches recently-departed sessions on the room so an unban
  // targeting the just-closed sessionIndex can still resolve the user.
  await clearCapture(modBot);
  await sendModAction(modBot, MOD_UNBAN, targetBot.sessionIndex, '', 0);
  await sleep(PROPAGATION_MS);

  const stillActive = await db.collection('moderation').findOne({
    type: 'ban', targetUsername: TARGET_USERNAME, active: true,
  });
  if (stillActive) {
    return { name: 'ban_then_unban', pass: false, detail: 'Ban still active in DB after unban request' };
  }

  // Target should now be able to rejoin successfully.
  let rejoined = null;
  try {
    rejoined = await spawnBot(browser, 'target_after_unban', room, targetAuthToken);
  } catch (err) {
    return { name: 'ban_then_unban', pass: false, detail: `Target could not rejoin after unban: ${err.message}` };
  }
  await rejoined.page.close().catch(() => {});

  return { name: 'ban_then_unban', pass: true, detail: 'Ban enforced (close 4001 + rejoin blocked), unban cleared DB row and allowed rejoin' };
}

// ─── Reporting ────────────────────────────────────────────────────────────

function writeReport(results, meta) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const passed = results.filter(r => r.pass).length;
  const total = results.length;

  let md = `# Moderation Test Report\n\n`;
  md += `Generated: ${new Date().toISOString()}\n`;
  md += `Run ID: \`${RUN_ID}\`\n`;
  md += `Room: \`${meta.roomName}\`\n`;
  md += `Mod user: \`${MOD_USERNAME}\` (role ${ROLE_HOLY})\n`;
  md += `Target user: \`${TARGET_USERNAME}\` (role ${ROLE_USER})\n\n`;
  md += `**Result: ${passed}/${total} passed**\n\n`;
  md += `| Test | Status | Detail |\n`;
  md += `| :--- | :--- | :--- |\n`;
  for (const r of results) {
    const icon = r.pass ? '✅' : '❌';
    const detail = (r.detail || '').replace(/\|/g, '\\|');
    md += `| ${r.name} | ${icon} | ${detail} |\n`;
  }
  fs.writeFileSync(REPORT_FILE, md);

  fs.writeFileSync(SUMMARY_FILE, JSON.stringify({
    runId: RUN_ID,
    passed,
    total,
    results,
  }, null, 2));
}

// ─── Main ─────────────────────────────────────────────────────────────────

function nameAllowed(name) {
  if (!NAME_FILTER) return true;
  return NAME_FILTER.some(f => name.includes(f));
}

async function main() {
  console.log(`\nTop Draw — Moderation Suite`);
  console.log(`Run:       ${RUN_ID}`);
  console.log(`URL:       ${TARGET_URL}`);
  console.log(`Server:    ${SERVER_URL}`);
  console.log(`Mongo:     ${MONGODB_URI} (db: ${MONGODB_DB_NAME})`);
  console.log(`Headless:  ${HEADLESS}`);
  if (NAME_FILTER) console.log(`Filter:    ${NAME_FILTER.join(', ')}`);
  console.log('');

  // ── Pre-flight: DB connection + register test users ──
  await connectMongo();
  console.log('✓ Connected to MongoDB');

  // In case a prior run left these around (different runId though).
  await deleteTestData();

  const modAuth    = await registerUser(MOD_USERNAME, TEST_PASSWORD);
  const targetAuth = await registerUser(TARGET_USERNAME, TEST_PASSWORD);
  console.log(`✓ Registered ${MOD_USERNAME} and ${TARGET_USERNAME}`);

  await setUserRole(MOD_USERNAME, ROLE_HOLY);
  console.log(`✓ Promoted ${MOD_USERNAME} → HOLY(${ROLE_HOLY})`);

  const roomName = `tmod_${RUN_ID}`;
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 800 },
  });

  const results = [];
  const bots = [];

  try {
    console.log(`\nSpawning bots into room "${roomName}"...`);
    const modBot    = await spawnBot(browser, 'mod_bot', roomName, modAuth.token);
    bots.push(modBot);
    const targetBot = await spawnBot(browser, 'target_bot', roomName, targetAuth.token);
    bots.push(targetBot);

    // Refresh session indexes after auth (server may reassign on login)
    modBot.sessionIndex    = await sessionIndexOf(modBot);
    targetBot.sessionIndex = await sessionIndexOf(targetBot);
    console.log(`  mod_bot session: ${modBot.sessionIndex}`);
    console.log(`  target_bot session: ${targetBot.sessionIndex}`);

    // Wait until each sees the other in its user roster.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const sizes = await Promise.all(bots.map(b =>
        b.page.evaluate(() => window.app?.users?.size ?? 0)
      ));
      if (sizes.every(s => s >= 2)) break;
      await sleep(250);
    }

    console.log('\n── Running tests ──────────────────────────────────────');
    // Order matters: both kick and ban close the target's WS with no
    // auto-reconnect (codes 4001/4002 aren't transient). Run kick LAST,
    // and re-spawn the target before ban so it has a live session.
    const tests = [
      { name: 'permission_denial', fn: () => testPermissionDenial(modBot, targetBot) },
      { name: 'mute',              fn: () => testMute(modBot, targetBot) },
      { name: 'unmute',            fn: () => testUnmute(modBot, targetBot) },
      { name: 'ban_then_unban',    fn: () => testBanThenUnban(modBot, targetBot, browser, roomName, targetAuth.token) },
      { name: 'kick',              fn: () => testKick(modBot, targetBot) },
    ];

    const respawnTargetIfClosed = async () => {
      // The WebSocketClient does not auto-reconnect on 4001/4002, so once
      // disconnected, the target page is useless for further mod actions.
      const connected = await targetBot.page.evaluate(
        () => !!window.app?.wsClient?.connected,
      ).catch(() => false);
      if (connected) return;
      try { await targetBot.page.close(); } catch {}
      const fresh = await spawnBot(browser, 'target_bot', roomName, targetAuth.token);
      Object.assign(targetBot, fresh);
      await sleep(500);
    };

    for (const t of tests) {
      if (!nameAllowed(t.name)) continue;
      if (t.name === 'ban_then_unban' || t.name === 'kick') {
        await respawnTargetIfClosed();
      }

      process.stdout.write(`  ${t.name.padEnd(22)} ... `);
      let r;
      try {
        r = await t.fn();
      } catch (err) {
        r = { name: t.name, pass: false, detail: `Threw: ${err.message}` };
      }
      console.log(`${r.pass ? '✅ PASS' : '❌ FAIL'}  ${r.detail || ''}`);
      results.push(r);

      // After a kick, the target ws is dead — flag so the next iteration re-spawns.
      if (t.name === 'kick') targetBot._alive = false;
    }

    console.log('\n' + '─'.repeat(60));
    const passed = results.filter(r => r.pass).length;
    console.log(`RESULTS: ${passed}/${results.length} passed`);
    console.log('─'.repeat(60));

    writeReport(results, { roomName });
    console.log(`Report:  ${REPORT_FILE}`);
    console.log(`Summary: ${SUMMARY_FILE}\n`);

    process.exitCode = passed === results.length ? 0 : 1;
  } catch (err) {
    console.error('\nFatal error:', err);
    process.exitCode = 1;
  } finally {
    for (const b of bots) await b.page.close().catch(() => {});
    await browser.close().catch(() => {});

    if (!KEEP_TEST_DATA) {
      try {
        await deleteTestData();
        console.log('✓ Cleaned up test users and moderation entries');
      } catch (err) {
        console.error('Cleanup failed:', err.message);
      }
    } else {
      console.log(`(KEEP=true — left ${MOD_USERNAME}, ${TARGET_USERNAME} in DB)`);
    }
    await mongoClient?.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
