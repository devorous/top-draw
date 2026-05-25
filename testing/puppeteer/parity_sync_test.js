#!/usr/bin/env node

/**
 * Integration test for the stroke-log parity protocol (Phases 1-3).
 *
 * Verifies:
 *   1. Two clients in the same room maintain identical strokeLog state.
 *   2. debugSync.checkNow() returns 'ok' when in sync.
 *   3. Synthetically corrupting one client's log triggers a mismatch
 *      with the correct missing seqs.
 *   4. debugSync.fixNow() triggers a resync and the next check returns 'ok'.
 *
 * Requires `npm run dev` running in another shell (vite :3000, server :8030).
 */

import 'dotenv/config';
import puppeteer from 'puppeteer';
import { MongoClient } from 'mongodb';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const HEADLESS = process.env.HEADLESS !== 'false';
const ROOM = `parity_${Date.now()}`;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || 'Draw';

let passes = 0;
let fails = 0;
function assert(label, cond, detail = '') {
  if (cond) {
    console.log(`  OK   ${label}`);
    passes++;
  } else {
    console.log(`  FAIL ${label}  ${detail}`);
    fails++;
  }
}

async function spawnBot(i) {
  const name = `parityBot${i}_${Date.now().toString(36).slice(-4)}`;
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 720 },
  });
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[ParityClient') || t.includes('[ParityCoordinator')) {
      console.log(`[${name}] ${t}`);
    }
  });
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(
    () => window.app && window.app.self && window.app.debugSync && window.app.parityClient,
    { timeout: 60000 }
  );
  await page.evaluate((n, r) => {
    window.app.self.username = n;
    window.app.handleRoomSelected(r);
  }, name, ROOM);
  await page.waitForFunction(
    () => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
    { timeout: 60000 }
  );
  return { name, browser, page };
}

async function drawStroke(bot, x1, y1, x2, y2, color = [255, 0, 102, 1]) {
  await bot.page.evaluate(async (sx, sy, ex, ey, col) => {
    const app = window.app;
    app.selectTool('brush');
    app.handleColorInputChange(col);
    app.handleSizeChange({ target: { value: 10 } });
    const ev = (x, y) => ({ button: 0, pointerType: 'mouse', offsetX: x, offsetY: y, clientX: x, clientY: y, preventDefault: () => {} });
    app.handlePointerDown(ev(sx, sy));
    app.inputBufferManager.tick();
    await new Promise(r => setTimeout(r, 20));
    app.handlePointerMove(ev(ex, ey));
    app.inputBufferManager.tick();
    await new Promise(r => setTimeout(r, 20));
    app.handlePointerUp(ev(ex, ey));
    app.inputBufferManager.tick();
  }, x1, y1, x2, y2, color);
  await new Promise(r => setTimeout(r, 250));
}

async function getSummary(bot) {
  return bot.page.evaluate(() => window.app.wsClient.strokeLog.getSummary());
}

async function checkNow(bot) {
  return bot.page.evaluate(async () => {
    const res = await window.app.debugSync.checkNow();
    if (res === 'ok') return { ok: true };
    return {
      ok: false,
      percent: res.percent,
      serverCount: res.serverCount,
      clientCount: res.clientCount,
      missing: res.missing.map(e => e.seq),
      extra: res.extra.map(e => e.seq),
      mismatched: res.mismatched.map(m => m.seq),
    };
  });
}

(async () => {
  console.log(`Room: ${ROOM}`);
  console.log(`Spawning three bots (staggered)...`);
  // Stagger spawns to avoid the per-IP WS connection rate limiter when
  // 3 puppeteer browsers all hit 127.0.0.1 at once.
  const a = await spawnBot(1);
  await new Promise(r => setTimeout(r, 500));
  const b = await spawnBot(2);
  await new Promise(r => setTimeout(r, 500));
  const c = await spawnBot(3);

  try {
    // Wait for room to settle
    await new Promise(r => setTimeout(r, 1000));

    console.log('Phase 1: identical state across 3 clients');
    await drawStroke(a, 100, 100, 200, 200, [255, 0, 102, 1]);
    await drawStroke(b, 250, 250, 350, 350, [0, 204, 255, 1]);
    await drawStroke(c, 600, 100, 700, 200, [255, 200, 0, 1]);
    await drawStroke(a, 400, 100, 500, 200, [51, 204, 102, 1]);
    await drawStroke(b, 100, 400, 200, 500, [200, 100, 255, 1]);
    await new Promise(r => setTimeout(r, 1000));

    const sa = await getSummary(a);
    const sb = await getSummary(b);
    const sc = await getSummary(c);
    assert('all clients have ≥5 commits', sa.count >= 5 && sb.count >= 5 && sc.count >= 5, `a=${sa.count} b=${sb.count} c=${sc.count}`);
    assert('all clients agree on count', sa.count === sb.count && sb.count === sc.count, `a=${sa.count} b=${sb.count} c=${sc.count}`);
    assert('all clients agree on latestSeq', sa.latestSeq === sb.latestSeq && sb.latestSeq === sc.latestSeq, `a=${sa.latestSeq} b=${sb.latestSeq} c=${sc.latestSeq}`);
    assert('all clients agree on rollingHash', sa.rollingHash === sb.rollingHash && sb.rollingHash === sc.rollingHash, `a=${sa.rollingHash.toString(16)} b=${sb.rollingHash.toString(16)} c=${sc.rollingHash.toString(16)}`);

    console.log('Phase 2: checkNow returns ok for all 3');
    await new Promise(r => setTimeout(r, 500));
    const okA = await checkNow(a);
    const okB = await checkNow(b);
    const okC = await checkNow(c);
    assert('A checkNow ok', okA.ok, JSON.stringify(okA));
    assert('B checkNow ok', okB.ok, JSON.stringify(okB));
    assert('C checkNow ok', okC.ok, JSON.stringify(okC));

    console.log('Phase 3: corrupt only B by dropping its last stroke');
    const droppedSeq = await b.page.evaluate(() => {
      const e = window.app.wsClient.strokeLog.entries.pop();
      const log = window.app.wsClient.strokeLog;
      log.rollingHash = 0;
      for (const entry of log.entries) {
        let h = (log.rollingHash ^ entry.fingerprint) >>> 0;
        h = Math.imul(h, 0x85ebca6b) >>> 0;
        h ^= h >>> 13;
        h = Math.imul(h, 0xc2b2ae35) >>> 0;
        h ^= h >>> 16;
        log.rollingHash = h >>> 0;
      }
      return e ? e.seq : null;
    });
    assert('popped a real seq from B', droppedSeq != null, `seq=${droppedSeq}`);

    const mmA = await checkNow(a);
    const mmB = await checkNow(b);
    const mmC = await checkNow(c);
    assert('A unaffected (still ok)', mmA.ok, JSON.stringify(mmA));
    assert('C unaffected (still ok)', mmC.ok, JSON.stringify(mmC));
    assert('B detects mismatch', !mmB.ok, JSON.stringify(mmB));
    assert('B mismatch lists the dropped seq', mmB.missing && mmB.missing.includes(droppedSeq), `missing=${JSON.stringify(mmB.missing)} dropped=${droppedSeq}`);

    console.log('Phase 4: fixNow on B resolves only B');
    await b.page.evaluate(() => window.app.debugSync.fixNow());
    await new Promise(r => setTimeout(r, 600));
    const okBAgain = await checkNow(b);
    assert('B back to ok after fixNow', okBAgain.ok, JSON.stringify(okBAgain));

    const sa2 = await getSummary(a);
    const sb2 = await getSummary(b);
    const sc2 = await getSummary(c);
    assert('all 3 agree on count post-fix', sa2.count === sb2.count && sb2.count === sc2.count, `a=${sa2.count} b=${sb2.count} c=${sc2.count}`);
    assert('all 3 agree on hash post-fix', sa2.rollingHash === sb2.rollingHash && sb2.rollingHash === sc2.rollingHash, `a=${sa2.rollingHash.toString(16)} b=${sb2.rollingHash.toString(16)} c=${sc2.rollingHash.toString(16)}`);

    console.log('Phase 4b: post-fix, new strokes still keep all 3 in sync');
    await drawStroke(c, 700, 500, 800, 600, [100, 255, 100, 1]);
    await drawStroke(a, 50, 600, 150, 700, [255, 100, 200, 1]);
    await new Promise(r => setTimeout(r, 800));
    const sa3 = await getSummary(a);
    const sb3 = await getSummary(b);
    const sc3 = await getSummary(c);
    assert('all 3 agree on count after post-fix drawing', sa3.count === sb3.count && sb3.count === sc3.count, `a=${sa3.count} b=${sb3.count} c=${sc3.count}`);
    assert('all 3 agree on hash after post-fix drawing', sa3.rollingHash === sb3.rollingHash && sb3.rollingHash === sc3.rollingHash, `a=${sa3.rollingHash.toString(16)} b=${sb3.rollingHash.toString(16)} c=${sc3.rollingHash.toString(16)}`);
    const okAFinal = await checkNow(a);
    const okBFinal = await checkNow(b);
    const okCFinal = await checkNow(c);
    assert('all 3 checkNow ok after post-fix drawing', okAFinal.ok && okBFinal.ok && okCFinal.ok, `A=${JSON.stringify(okAFinal)} B=${JSON.stringify(okBFinal)} C=${JSON.stringify(okCFinal)}`);

    console.log('Phase 5: MongoDB persistence');
    if (!MONGODB_URI) {
      console.log('  SKIP MONGODB_URI not set — in-memory ring fallback only');
    } else {
      // Give the server's post-OK markResolved + the post-fix report time to land.
      await new Promise(r => setTimeout(r, 800));
      const mongo = new MongoClient(MONGODB_URI);
      try {
        await mongo.connect();
        const col = mongo.db(DB_NAME).collection('debug.parity_events');
        const events = await col.find({ roomId: ROOM }).sort({ ts: 1 }).toArray();
        assert('persisted at least one event', events.length > 0, `count=${events.length}`);

        const eventWithDetail = events.find(e => Array.isArray(e.missingStrokes) && e.missingStrokes.length > 0);
        assert('detail attached with missing seq', !!eventWithDetail, `events: ${events.map(e => ({ srv: e.serverCount, cli: e.clientCount, miss: e.missingStrokes?.length })).map(o => JSON.stringify(o)).join(', ')}`);
        if (eventWithDetail) {
          assert('persisted event has client < server', eventWithDetail.clientCount < eventWithDetail.serverCount,
            `srv=${eventWithDetail.serverCount} cli=${eventWithDetail.clientCount}`);
          assert('persisted event diff is exactly 1 stroke', eventWithDetail.serverCount - eventWithDetail.clientCount === 1,
            `srv=${eventWithDetail.serverCount} cli=${eventWithDetail.clientCount}`);
          assert('persisted missing seq matches dropped seq', eventWithDetail.missingStrokes.some(s => s.seq === droppedSeq),
            `missing=${JSON.stringify(eventWithDetail.missingStrokes.map(m => m.seq))} dropped=${droppedSeq}`);
          assert('event eventually resolved', eventWithDetail.resolved === true, `resolved=${eventWithDetail.resolved}`);
          assert('resolution kind stamped', !!eventWithDetail.resolutionKind, `kind=${eventWithDetail.resolutionKind}`);
        }

        // Clean up the test events
        await col.deleteMany({ roomId: ROOM });
      } finally {
        await mongo.close();
      }
    }

  } finally {
    await Promise.all([a, b, c].map(bot => bot.browser.close().catch(() => {})));
  }

  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails > 0 ? 1 : 0);
})().catch(err => {
  console.error('Test threw:', err);
  process.exit(2);
});
