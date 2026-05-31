import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const ROOM = process.env.ROOM || `codex_live_probe_${Date.now()}`;
const WS_TARGET_URL = process.env.WS_TARGET_URL || 'ws://127.0.0.1:8030';
const HEADLESS = process.env.HEADLESS !== 'false';
const DEVTOOLS = process.env.DEVTOOLS === 'true';
const KEEP_OPEN = process.env.KEEP_OPEN === 'true';
const DOWNSAMPLE_WIDTH = Number(process.env.DOWNSAMPLE_WIDTH || 192);
const DOWNSAMPLE_HEIGHT = Number(process.env.DOWNSAMPLE_HEIGHT || 108);
const PIXEL_TOLERANCE = Number(process.env.PIXEL_TOLERANCE || 18);
const PASS_PCT = Number(process.env.PASS_PCT || 99.5);
const ROUNDS = Number(process.env.ROUNDS || 3);
const SETTLE_MS = Number(process.env.SETTLE_MS || 8000);
const HOLD_MS = Number(process.env.HOLD_MS || 300000);
const SAMPLE_INTERVAL_MS = Number(process.env.SAMPLE_INTERVAL_MS || 60000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runK6() {
  return new Promise((resolve, reject) => {
    const child = spawn('k6', ['run', 'testing/low_stress_test.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ROOM,
        TARGET_URL: WS_TARGET_URL,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`k6 exited ${code}\n${stderr || stdout}`));
    });
  });
}

async function joinPage(browser, i) {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    if (/Snapshot|Parity|Sync|checkpoint|mismatch/i.test(text)) {
      console.log(`[tab${i}] ${text}`);
    }
  });

  await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction(
    () => window.app && window.app.self && window.app.debugSync && window.app.parityClient && window.app.snapshotManager,
    { timeout: 60000 }
  );
  await page.evaluate((name, room) => {
    window.app.self.username = name;
    window.app.handleRoomSelected(room);
  }, `probe_tab_${i}`, ROOM);
  await page.waitForFunction(
    () => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
    { timeout: 60000 }
  );
  return page;
}

async function collect(page) {
  return page.evaluate(async () => {
    const app = window.app;
    const summary = app.wsClient?.strokeLog?.getSummary?.() || null;
    let check = null;
    try {
      const res = await app.debugSync.checkNow();
      check = res === 'ok'
        ? { ok: true }
        : {
            ok: false,
            percent: res.percent,
            serverCount: res.serverCount,
            clientCount: res.clientCount,
            missing: res.missing?.map((e) => e.seq) || [],
            extra: res.extra?.map((e) => e.seq) || [],
            mismatched: res.mismatched?.map((m) => m.seq) || [],
          };
    } catch (err) {
      check = { ok: false, error: String(err?.message || err) };
    }

    let canvas = null;
    const c = app.board?.mainCanvas;
    if (c) {
      const sample = document.createElement('canvas');
      sample.width = window.__probeDownsample?.width || 192;
      sample.height = window.__probeDownsample?.height || 108;
      const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
      sampleCtx.imageSmoothingEnabled = true;
      sampleCtx.imageSmoothingQuality = 'high';
      sampleCtx.drawImage(c, 0, 0, sample.width, sample.height);
      const sampleData = sampleCtx.getImageData(0, 0, sample.width, sample.height).data;
      let sampleNonZero = 0;
      for (let idx = 3; idx < sampleData.length; idx += 4) {
        if (sampleData[idx] !== 0) sampleNonZero++;
      }

      canvas = {
        width: c.width,
        height: c.height,
        downsample: {
          width: sample.width,
          height: sample.height,
          nonZero: sampleNonZero,
          data: Array.from(sampleData),
        },
      };
    }

    const sm = app.snapshotManager;
    const checkpoint = sm?._pixelParityCheckpoint;
    const snapshot = {
      listCount: sm?.snapshots?.length ?? null,
      autoInFlight: !!sm?._autoSnapshotInFlight,
      autoQueued: !!sm?._autoSnapshotQueued,
      encodePending: sm?._snapshotEncodePromises?.size ?? null,
      checkpoint: checkpoint
        ? {
            snapshotId: checkpoint.snapshotId || '',
            seq: checkpoint.seq,
            width: checkpoint.width,
            height: checkpoint.height,
            cols: checkpoint.cols,
            rows: checkpoint.rows,
          }
        : null,
      pixelProbe: sm?.buildPixelParityProbe?.() || null,
    };

    return {
      room: app.currentRoom,
      username: app.self?.username,
      sessionIndex: app.sessionIndex,
      lastProcessedSeq: app.wsClient?.lastProcessedSeq,
      connected: !!app.wsClient?.connected,
      summary,
      check,
      canvas,
      snapshot,
    };
  });
}

function compareDownsample(a, b) {
  const da = a?.canvas?.downsample;
  const db = b?.canvas?.downsample;
  if (!da || !db || da.width !== db.width || da.height !== db.height) {
    return { pass: false, reason: 'missing-or-size-mismatch' };
  }
  let matched = 0;
  let checked = 0;
  let maxDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < da.data.length; i += 4) {
    const d = Math.max(
      Math.abs(da.data[i] - db.data[i]),
      Math.abs(da.data[i + 1] - db.data[i + 1]),
      Math.abs(da.data[i + 2] - db.data[i + 2]),
      Math.abs(da.data[i + 3] - db.data[i + 3]),
    );
    if (d > maxDelta) maxDelta = d;
    totalDelta += d;
    checked++;
    if (d <= PIXEL_TOLERANCE) matched++;
  }
  const matchPct = checked ? (matched / checked) * 100 : 100;
  const meanMaxChannelDelta = checked ? totalDelta / checked : 0;
  return {
    pass: matchPct >= PASS_PCT,
    matchPct,
    matched,
    checked,
    maxDelta,
    meanMaxChannelDelta,
    tolerance: PIXEL_TOLERANCE,
    width: da.width,
    height: da.height,
  };
}

async function collectAll(pages, label) {
  const results = [];
  for (const page of pages) results.push(await collect(page));

  const pixelPairs = [];
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      pixelPairs.push({
        pair: `${results[i].username}->${results[j].username}`,
        ...compareDownsample(results[i], results[j]),
      });
    }
  }

  const publicResults = results.map((r) => ({
    ...r,
    canvas: r.canvas
      ? {
          width: r.canvas.width,
          height: r.canvas.height,
          downsample: {
            width: r.canvas.downsample?.width,
            height: r.canvas.downsample?.height,
            nonZero: r.canvas.downsample?.nonZero,
          },
        }
      : null,
  }));

  const counts = new Set(results.map((r) => r.summary?.count));
  const seqs = new Set(results.map((r) => r.summary?.latestSeq));
  const strokeHashes = new Set(results.map((r) => r.summary?.rollingHash));
  const pixelParityOk = pixelPairs.every((p) => p.pass);
  const checksOk = results.every((r) => r.check?.ok === true);
  const connected = results.every((r) => r.connected);
  const nonBlank = results.every((r) => (r.canvas?.downsample?.nonZero || 0) > 0);
  const snapshotIdle = results.every((r) =>
    !r.snapshot?.autoInFlight &&
    !r.snapshot?.autoQueued &&
    (r.snapshot?.encodePending || 0) === 0
  );

  const pass =
    connected &&
    checksOk &&
    nonBlank &&
    counts.size === 1 &&
    seqs.size === 1 &&
    strokeHashes.size === 1 &&
    pixelParityOk &&
    snapshotIdle;

  console.log(`PROBE_SAMPLE ${label}`);
  console.log(JSON.stringify({ tabs: publicResults, pixelPairs }, null, 2));
  console.log(`PROBE_ASSERT ${label} connected=${connected}`);
  console.log(`PROBE_ASSERT ${label} parityChecksOk=${checksOk}`);
  console.log(`PROBE_ASSERT ${label} nonBlankCanvas=${nonBlank}`);
  console.log(`PROBE_ASSERT ${label} countsMatch=${counts.size === 1}`);
  console.log(`PROBE_ASSERT ${label} seqsMatch=${seqs.size === 1}`);
  console.log(`PROBE_ASSERT ${label} strokeHashesMatch=${strokeHashes.size === 1}`);
  console.log(`PROBE_ASSERT ${label} downsamplePixelParity=${pixelParityOk}`);
  for (const pair of pixelPairs) {
    console.log(`PROBE_PIXEL_PAIR ${label} ${pair.pair} matchPct=${pair.matchPct?.toFixed?.(4)} maxDelta=${pair.maxDelta} meanDelta=${pair.meanMaxChannelDelta?.toFixed?.(4)} tolerance=${pair.tolerance}`);
  }
  console.log(`PROBE_ASSERT ${label} snapshotIdle=${snapshotIdle}`);
  return { pass, results, pixelPairs };
}

const browser = await puppeteer.launch({
  headless: HEADLESS,
  devtools: DEVTOOLS,
  protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
  defaultViewport: { width: 1280, height: 720 },
});

try {
  console.log(`Room: ${ROOM}`);
  console.log(`Browser mode: headless=${HEADLESS} devtools=${DEVTOOLS}`);
  console.log(`Rounds=${ROUNDS} settleMs=${SETTLE_MS} holdMs=${HOLD_MS} sampleIntervalMs=${SAMPLE_INTERVAL_MS}`);
  const pages = [];
  for (let i = 1; i <= 3; i++) {
    pages.push(await joinPage(browser, i));
    await pages[pages.length - 1].evaluate(({ width, height }) => {
      window.__probeDownsample = { width, height };
    }, { width: DOWNSAMPLE_WIDTH, height: DOWNSAMPLE_HEIGHT });
    await sleep(500);
  }

  let allPass = true;
  await collectAll(pages, 'initial');
  for (let round = 1; round <= ROUNDS; round++) {
    console.log(`Running k6 round ${round}/${ROUNDS} with browser tabs still joined...`);
    await runK6();
    console.log(`Settling for ${SETTLE_MS}ms after round ${round}...`);
    await sleep(SETTLE_MS);
    const sample = await collectAll(pages, `round-${round}`);
    allPass = allPass && sample.pass;
  }

  const holdUntil = Date.now() + HOLD_MS;
  let holdSample = 1;
  while (Date.now() < holdUntil) {
    const waitMs = Math.min(SAMPLE_INTERVAL_MS, holdUntil - Date.now());
    console.log(`Holding browser session open for ${waitMs}ms before sample ${holdSample}...`);
    await sleep(waitMs);
    const sample = await collectAll(pages, `hold-${holdSample}`);
    allPass = allPass && sample.pass;
    holdSample++;
  }

  console.log(`PROBE_FINAL allPass=${allPass}`);
  process.exit(allPass ? 0 : 1);
} finally {
  if (KEEP_OPEN) {
    browser.disconnect();
  } else {
    await browser.close().catch(() => {});
  }
}
