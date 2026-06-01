#!/usr/bin/env node
/**
 * Verifies departed-author tail replay with real rendered pixels.
 *
 * Scenario:
 *   A joins and draws blue.
 *   B joins, draws magenta, then disconnects.
 *   C joins fresh and must render B's magenta pixels.
 *
 * This targets docs/0000Sync_Issues.md Issue 7 directly. It also records C's
 * inbound tail frames so the live-vs-buffered timing window is visible.
 */

import puppeteer from 'puppeteer';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const HEADLESS = process.env.HEADLESS !== 'false';
const RUNS = Math.max(1, Number(process.env.RUNS || 3) | 0);
const SETTLE_MS = Math.max(500, Number(process.env.SETTLE_MS || 4500) | 0);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function spawnTab(browser, label, room, { trace = false } = {}) {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const txt = msg.text();
    if (/\[parity\]|\[SyncClient\]|\[SYNC\]|CHECKPOINT|ERROR/i.test(txt)) {
      process.stdout.write(`  [${label}] ${txt}\n`);
    }
  });
  page.on('pageerror', (err) => process.stderr.write(`  [${label} ERROR] ${err.message}\n`));

  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app !== undefined && window.app.self != null, { timeout: 60_000 });

  if (trace) {
    await page.evaluate(() => {
      const app = window.app;
      window.__tailTrace = [];
      const traced = new Set(['ct', 'cc', 'cs', 'md', 'mm', 'mu', 'fill', 'undo']);
      const originalEmit = app.wsClient.emit.bind(app.wsClient);
      app.wsClient.emit = (eventName, data) => {
        if (traced.has(eventName)) {
          const sid = data?.sessionIndex;
          const entry = {
            eventName,
            sid,
            seq: Number(data?.seq || 0),
            beforeSyncing: !!app.syncClient?.syncing,
            beforeBuffering: !!app.syncClient?.buffering,
            beforeHasUser: sid !== undefined && sid !== null ? !!app.users?.has(sid) : null,
            self: app.sessionIndex,
            ts: performance.now(),
          };
          originalEmit(eventName, data);
          entry.afterSyncing = !!app.syncClient?.syncing;
          entry.afterBuffering = !!app.syncClient?.buffering;
          entry.afterHasUser = sid !== undefined && sid !== null ? !!app.users?.has(sid) : null;
          window.__tailTrace.push(entry);
          return;
        }
        originalEmit(eventName, data);
      };
    });
  }

  await page.evaluate((name, roomId) => {
    window.app.self.username = name;
    window.app.handleRoomSelected(roomId);
  }, label, room);

  await page.waitForFunction(() => {
    const app = window.app;
    if (app?.brushGallery && !app.brushGallery.realGallery) app.brushGallery.loadRealGallery();
    const brushes = app?.brushGallery?.realGallery?.brushes;
    const syncDone = app?.syncClient?.hasCompletedSync === true || (app?.wsClient?.connected && app?.users?.size <= 1);
    return app?.wsClient?.connected && syncDone && brushes && brushes.length > 0;
  }, { timeout: 60_000 });

  await page.evaluate(() => window.app.inputBufferManager?.stopTickLoop?.());
  return page;
}

async function setTool(page, tool, settings = {}) {
  await page.evaluate((payload) => {
    const app = window.app;
    app.selectTool(payload.tool);
    if (payload.size !== undefined) app.handleSizeChange({ target: { value: payload.size } });
    if (payload.color !== undefined) app.handleColorInputChange(payload.color);
    if (payload.hardness !== undefined) app.handleHardnessChange({ target: { value: payload.hardness } });
    if (payload.smoothing !== undefined) app.handleSmoothingChange({ target: { value: payload.smoothing } });
  }, { tool, ...settings });
}

async function getClientCoords(page, boardX, boardY) {
  return page.evaluate((bx, by) => {
    const board = window.app.board;
    const containerRect = board.container.getBoundingClientRect();
    const rad = board.rotation * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    let rx = bx * board.zoom;
    let ry = by * board.zoom;
    if (board.canvasFlipped) rx = (board.getWidth() - bx) * board.zoom;
    const rxr = rx * cos + ry * sin;
    const ryr = -rx * sin + ry * cos;
    return {
      clientX: rxr + board.panX + containerRect.left,
      clientY: ryr + board.panY + containerRect.top,
    };
  }, boardX, boardY);
}

async function drawPath(page, points) {
  const clientPoints = [];
  for (const p of points) clientPoints.push(await getClientCoords(page, p.x, p.y));
  await page.evaluate(async (pts) => {
    const app = window.app;
    const ev = (c) => ({
      button: 0,
      pointerType: 'mouse',
      clientX: c.clientX,
      clientY: c.clientY,
      preventDefault: () => {},
    });
    app.handlePointerDown(ev(pts[0]));
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      for (let s = 1; s <= 8; s++) {
        const t = s / 8;
        app.handlePointerMove(ev({
          clientX: a.clientX + (b.clientX - a.clientX) * t,
          clientY: a.clientY + (b.clientY - a.clientY) * t,
        }));
        app.inputBufferManager?.tick();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    app.handlePointerUp(ev(pts[pts.length - 1]));
    app.inputBufferManager?.tick();
  }, clientPoints);
  await sleep(300);
}

async function renderedStats(page) {
  return page.evaluate(() => {
    const app = window.app;
    const lm = app.board.layerManager;
    const canvas = document.createElement('canvas');
    canvas.width = lm.width;
    canvas.height = lm.height;
    const ctx = canvas.getContext('2d');
    for (const group of lm.layerGroups || []) {
      if (group.flatCanvas) ctx.drawImage(group.flatCanvas, 0, 0);
      const sorted = [...group.strokeStack].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      for (const stroke of sorted) {
        if (!stroke.canvas) continue;
        ctx.globalCompositeOperation = stroke.blendMode || 'source-over';
        ctx.drawImage(stroke.canvas, stroke.x || 0, stroke.y || 0);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonWhite = 0, blue = 0, magenta = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a > 0 && (r < 250 || g < 250 || b < 250)) nonWhite++;
      if (b > 120 && r < 120 && g < 160 && a > 20) blue++;
      if (r > 150 && b > 150 && g < 120 && a > 20) magenta++;
    }

    const groups = (lm.layerGroups || []).map((group, groupIdx) => ({
      groupIdx,
      stack: group.strokeStack.length,
      userCounts: Object.fromEntries(group.userStrokeCounts || []),
      hasBaked: !!group.flatCanvas,
    }));
    return {
      sessionIndex: app.sessionIndex,
      users: [...app.users.keys()],
      hasCompletedSync: !!app.syncClient?.hasCompletedSync,
      syncing: !!app.syncClient?.syncing,
      buffering: !!app.syncClient?.buffering,
      lastProcessedSeq: app.wsClient?.lastProcessedSeq || 0,
      strokeLog: app.wsClient?.strokeLog?.getSummary?.() || null,
      nonWhite,
      blue,
      magenta,
      groups,
      tailTrace: window.__tailTrace || [],
      parityLogs: (window.__parityLogs || []),
    };
  });
}

function summarizeFrames(frames) {
  const byEvent = {};
  for (const f of frames) byEvent[f.eventName] = (byEvent[f.eventName] || 0) + 1;
  return {
    count: frames.length,
    byEvent,
    first: frames[0] || null,
    last: frames[frames.length - 1] || null,
  };
}

async function resyncDepartedStroke(page, departedSessionIndex, seq) {
  if (!seq) return null;
  await page.evaluate((sid) => {
    const app = window.app;
    window.__tailTrace = [];
    app.forceCleanupResidualState?.(sid);
    app.users?.delete?.(sid);
  }, departedSessionIndex);
  await sleep(300);
  const before = await renderedStats(page);
  await page.evaluate((resyncSeq) => {
    window.app.parityClient?.requestResync?.([resyncSeq]);
  }, seq);
  await sleep(2500);
  const after = await renderedStats(page);
  const frames = after.tailTrace.filter((e) => e.sid === departedSessionIndex);
  return {
    seq,
    beforeMagenta: before.magenta,
    afterMagenta: after.magenta,
    frameSummary: summarizeFrames(frames),
    pass: before.magenta < 1000 && after.magenta > 1000 && frames.some((f) => f.eventName === 'md') && frames.some((f) => f.eventName === 'mu'),
  };
}

async function runOne(browser, runIdx) {
  const room = `departed_tail_${Date.now()}_${runIdx}`;
  const a = await spawnTab(browser, `A_${runIdx}`, room);
  await setTool(a, 'brush', { size: 44, color: [0, 80, 255, 1], hardness: 100 });
  await drawPath(a, [{ x: 260, y: 260 }, { x: 700, y: 350 }, { x: 1120, y: 250 }]);
  await sleep(700);

  const b = await spawnTab(browser, `B_${runIdx}`, room);
  await setTool(b, 'brush', { size: 52, color: [255, 0, 255, 1], hardness: 100 });
  await drawPath(b, [{ x: 300, y: 620 }, { x: 760, y: 520 }, { x: 1260, y: 660 }]);
  await sleep(1200);

  const aBefore = await renderedStats(a);
  const bBefore = await renderedStats(b);
  await b.close();
  await sleep(1200);

  const c = await spawnTab(browser, `C_${runIdx}`, room, { trace: true });
  await sleep(SETTLE_MS);
  const aAfter = await renderedStats(a);
  const cAfter = await renderedStats(c);

  const bTailFrames = cAfter.tailTrace.filter((e) => e.sid === bBefore.sessionIndex);
  const bCommitSeq = [...bTailFrames].reverse().find((e) => e.eventName === 'mu')?.seq || 0;
  const resync = await resyncDepartedStroke(c, bBefore.sessionIndex, bCommitSeq);
  const issue7Pass = cAfter.magenta > 1000;
  const parityResyncPass = !!resync?.pass;
  const pass = issue7Pass && parityResyncPass;
  const summary = {
    run: runIdx,
    room,
    pass,
    issue7Pass,
    parityResyncPass,
    a: {
      sessionIndex: aAfter.sessionIndex,
      blue: aAfter.blue,
      magenta: aAfter.magenta,
      nonWhite: aAfter.nonWhite,
      strokeLog: aAfter.strokeLog,
    },
    bDepartedSessionIndex: bBefore.sessionIndex,
    c: {
      sessionIndex: cAfter.sessionIndex,
      users: cAfter.users,
      blue: cAfter.blue,
      magenta: cAfter.magenta,
      nonWhite: cAfter.nonWhite,
      lastProcessedSeq: cAfter.lastProcessedSeq,
      strokeLog: cAfter.strokeLog,
      groups: cAfter.groups,
      bTailFrameSummary: summarizeFrames(bTailFrames),
    },
    resync,
  };

  await a.close().catch(() => {});
  await c.close().catch(() => {});
  return summary;
}

const browser = await puppeteer.launch({
  headless: HEADLESS,
  defaultViewport: { width: 1440, height: 900 },
  args: ['--disable-dev-shm-usage', '--no-sandbox'],
});

const results = [];
try {
  for (let i = 1; i <= RUNS; i++) {
    process.stdout.write(`\n[departed-tail] run ${i}/${RUNS}\n`);
    const result = await runOne(browser, i);
    results.push(result);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n[departed-tail] ${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
