#!/usr/bin/env node
/**
 * Verifies the persistent checkpoint-image join path (Issue 6) and the V6
 * pixel-parity diagnostic probe using Puppeteer/CDP.
 *
 * Default room is lobby because unregistered etest rooms do not persist/serve
 * checkpoint snapshots.
 */

import puppeteer from 'puppeteer';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const ROOM = process.env.ROOM || 'lobby';
const HEADLESS = process.env.HEADLESS !== 'false';
const AUTH_USER = process.env.AUTH_USER || 'parityadmin';
const AUTH_PASS = process.env.AUTH_PASS || 'parityTest123!';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function spawnTab(browser, label, room, { trace = false } = {}) {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const txt = msg.text();
    if (/\[parity\]|\[PixelParity\]|\[Sync\]|\[SyncClient\]|CHECKPOINT|ERROR|Snapshot/i.test(txt)) {
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
      window.__syncTrace = [];
      const traced = new Set(['board_snapshot_restore', 'sync_complete', 'sync_checkpoint_minted']);
      const originalEmit = app.wsClient.emit.bind(app.wsClient);
      app.wsClient.emit = (eventName, data) => {
        if (traced.has(eventName)) {
          window.__syncTrace.push({
            eventName,
            data: {
              snapshotId: data?.snapshotId,
              snapshotSeq: data?.snapshotSeq,
              isSyncCheckpoint: data?.isSyncCheckpoint,
            },
            lastProcessedSeq: app.wsClient?.lastProcessedSeq || 0,
            ts: performance.now(),
          });
        }
        return originalEmit(eventName, data);
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

async function login(page) {
  await page.evaluate((username, password) => {
    window.__authEvents = [];
    const app = window.app;
    const originalEmit = app.wsClient.emit.bind(app.wsClient);
    app.wsClient.emit = (eventName, data) => {
      if (eventName === 'auth_result') window.__authEvents.push(data);
      return originalEmit(eventName, data);
    };
    app.wsClient.sendAuthLogin(username, password);
  }, AUTH_USER, AUTH_PASS);
  await page.waitForFunction(() => (window.app?.selfRole || 0) >= 4, { timeout: 15_000 });
}

async function setTool(page, tool, settings = {}) {
  await page.evaluate((payload) => {
    const app = window.app;
    app.selectTool(payload.tool);
    if (payload.size !== undefined) app.handleSizeChange({ target: { value: payload.size } });
    if (payload.color !== undefined) app.handleColorInputChange(payload.color);
    if (payload.hardness !== undefined) app.handleHardnessChange({ target: { value: payload.hardness } });
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
    return {
      clientX: rx * cos + ry * sin + board.panX + containerRect.left,
      clientY: -rx * sin + ry * cos + board.panY + containerRect.top,
    };
  }, boardX, boardY);
}

async function drawPath(page, points) {
  const clientPoints = [];
  for (const p of points) clientPoints.push(await getClientCoords(page, p.x, p.y));
  await page.evaluate(async (pts) => {
    const app = window.app;
    const ev = (c) => ({ button: 0, pointerType: 'mouse', clientX: c.clientX, clientY: c.clientY, preventDefault: () => {} });
    app.handlePointerDown(ev(pts[0]));
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      for (let s = 1; s <= 6; s++) {
        const t = s / 6;
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
  await sleep(220);
}

async function clearBoard(page) {
  await page.evaluate(() => window.app.handleClear());
  await sleep(1000);
}

async function drawBakedPrefix(page) {
  await setTool(page, 'brush', { size: 36, color: [0, 80, 255, 1], hardness: 100 });
  for (let i = 0; i < 24; i++) {
    const y = 120 + (i % 12) * 34;
    const x0 = 180 + Math.floor(i / 12) * 760;
    await drawPath(page, [{ x: x0, y }, { x: x0 + 460, y: y + 18 }]);
  }
  await sleep(1500);
}

async function drawTail(page) {
  await setTool(page, 'brush', { size: 48, color: [255, 0, 255, 1], hardness: 100 });
  for (let i = 0; i < 3; i++) {
    const y = 640 + i * 58;
    await drawPath(page, [{ x: 260, y }, { x: 760, y: y - 55 }, { x: 1260, y: y + 25 }]);
  }
  await sleep(1000);
}

async function waitForCheckpoint(page) {
  await page.waitForFunction(() => {
    const cp = window.app?.snapshotManager?._pixelParityCheckpoint;
    return !!cp && cp.seq > 0;
  }, { timeout: 60_000 });
}

async function forceCheckpoint(page) {
  await page.evaluate(async () => {
    await window.app.snapshotManager.handleServerRequest();
  });
  await waitForCheckpoint(page);
  await sleep(2500);
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
      for (const item of group.bakedSequences || []) {
        if (item?.canvas) {
          ctx.globalCompositeOperation = item.blendMode || 'source-over';
          ctx.drawImage(item.canvas, item.x || 0, item.y || 0);
        } else if (item?.strokes) {
          for (const stroke of item.strokes) {
            if (!stroke.canvas) continue;
            ctx.globalCompositeOperation = stroke.blendMode || 'source-over';
            ctx.drawImage(stroke.canvas, stroke.x || 0, stroke.y || 0);
          }
        }
      }
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
      if (b > 120 && r < 140 && g < 170 && a > 20) blue++;
      if (r > 150 && b > 150 && g < 130 && a > 20) magenta++;
    }
    const log = app.wsClient.strokeLog.getSummary();
    const cp = app.snapshotManager._pixelParityCheckpoint;
    return {
      sessionIndex: app.sessionIndex,
      lastProcessedSeq: app.wsClient.lastProcessedSeq,
      log,
      firstLogSeq: app.wsClient.strokeLog.entries[0]?.seq || 0,
      bakedWatermark: lm.getBakedWatermarkSeq?.() || 0,
      checkpoint: cp ? { id: cp.snapshotId, seq: cp.seq, cols: cp.cols, rows: cp.rows } : null,
      blue,
      magenta,
      nonWhite,
      trace: window.__syncTrace || [],
      probe: app.snapshotManager.buildPixelParityProbe?.() || null,
    };
  });
}

async function induceBakedDivergence(page) {
  await page.evaluate(() => {
    const lm = window.app.board.layerManager;
    const group = lm.layerGroups[0];
    const ctx = group.flatCtx || group.flatCanvas?.getContext('2d');
    ctx.save();
    ctx.fillStyle = 'rgb(255,0,0)';
    ctx.fillRect(40, 40, 160, 160);
    ctx.restore();
  });
  await sleep(250);
}

function closeEnough(a, b, tolerance) {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= tolerance;
}

function summarizeProbe(probe) {
  if (!probe) return null;
  const tiles = Array.isArray(probe.parityPixelTiles) ? probe.parityPixelTiles : [];
  return {
    snapshotSeq: probe.parityPixelSnapshotSeq,
    snapshotId: probe.parityPixelSnapshotId,
    tileCount: tiles.length,
    firstTiles: tiles.slice(0, 20),
    tileSize: probe.parityPixelTileSize,
    tileCols: probe.parityPixelTileCols,
    maxMad: Math.round((probe.parityPixelMaxMadX100 || 0)) / 100,
    meanMad: Math.round((probe.parityPixelMeanMadX100 || 0)) / 100,
  };
}

function summarizeStats(stats) {
  if (!stats) return null;
  return {
    sessionIndex: stats.sessionIndex,
    lastProcessedSeq: stats.lastProcessedSeq,
    log: stats.log,
    firstLogSeq: stats.firstLogSeq,
    bakedWatermark: stats.bakedWatermark,
    checkpoint: stats.checkpoint,
    blue: stats.blue,
    magenta: stats.magenta,
    nonWhite: stats.nonWhite,
    trace: stats.trace,
    probe: summarizeProbe(stats.probe),
  };
}

async function main() {
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    defaultViewport: { width: 1440, height: 900 },
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });

  let a, b;
  try {
    a = await spawnTab(browser, 'A', ROOM, { trace: true });
    await login(a);
    await clearBoard(a);
    await drawBakedPrefix(a);
    const beforeCheckpoint = await renderedStats(a);
    if (beforeCheckpoint.bakedWatermark <= 0) {
      throw new Error(`Expected baked watermark > 0 before checkpoint, got ${beforeCheckpoint.bakedWatermark}`);
    }

    await forceCheckpoint(a);
    const afterCheckpoint = await renderedStats(a);
    await drawTail(a);
    const aFinal = await renderedStats(a);

    b = await spawnTab(browser, 'B', ROOM, { trace: true });
    await sleep(5000);
    await waitForCheckpoint(b);
    const bFinal = await renderedStats(b);

    const restore = bFinal.trace.find((e) => e.eventName === 'board_snapshot_restore' && e.data?.isSyncCheckpoint);
    const issue6Pass = !!restore &&
      bFinal.blue > 1000 &&
      bFinal.magenta > 1000 &&
      closeEnough(bFinal.blue, aFinal.blue, 1500) &&
      closeEnough(bFinal.magenta, aFinal.magenta, 1500) &&
      closeEnough(bFinal.nonWhite, aFinal.nonWhite, 2000) &&
      bFinal.lastProcessedSeq === aFinal.lastProcessedSeq &&
      bFinal.log.latestSeq === aFinal.log.latestSeq;

    const quietProbeA = afterCheckpoint.probe;
    const quietProbeB = bFinal.probe;
    const quietV6Pass = quietProbeA && quietProbeB &&
      quietProbeA.parityPixelTiles.length === 0 &&
      quietProbeB.parityPixelTiles.length === 0;

    await induceBakedDivergence(b);
    const bDiverged = await renderedStats(b);
    const divergentProbe = bDiverged.probe;
    const divergentV6Pass = !!divergentProbe && divergentProbe.parityPixelTiles.length > 0 &&
      divergentProbe.parityPixelTileSize > 0 &&
      divergentProbe.parityPixelTileCols > 0 &&
      divergentProbe.parityPixelMaxMadX100 > 0;

    await b.evaluate(() => window.app.debugSync?.checkNow?.());
    await sleep(1000);

    const result = {
      room: ROOM,
      issue6Pass,
      quietV6Pass,
      divergentV6Pass,
      beforeCheckpoint: summarizeStats(beforeCheckpoint),
      afterCheckpoint: summarizeStats(afterCheckpoint),
      aFinal: summarizeStats(aFinal),
      bFinal: summarizeStats(bFinal),
      restore,
      quietProbeA: summarizeProbe(quietProbeA),
      quietProbeB: summarizeProbe(quietProbeB),
      divergentProbe: summarizeProbe(divergentProbe),
    };
    console.log(JSON.stringify(result, null, 2));
    if (!issue6Pass || !quietV6Pass || !divergentV6Pass) process.exitCode = 1;
  } finally {
    await b?.close?.().catch(() => {});
    await a?.close?.().catch(() => {});
    await browser.close();
  }
}

await main();
