/**
 * What does a long replay tail cost a weak client at JOIN time?
 *
 * An unregistered room never mints a checkpoint (`Room.canPersistSnapshots`
 * wants an ownerId), so `[Sync] Replayed tail (0, N]` replays the ENTIRE session
 * to every joiner, up to the fingerprint log's 10k commit cap. This measures the
 * shape of that cost as the tail grows: join repeatedly into one room while
 * peers keep drawing, and watch the same join get worse.
 *
 *   ROOM=joincost1 JOINS=6 GROW=90 node testing/devtools/join_replay_cost.mjs
 *
 * Env:
 *   ROOM   room to join, must match the peer bots      (default joincost)
 *   JOINS  how many joins to sample                    (default 6)
 *   GROW   seconds of drawing between joins            (default 90)
 *   WATCH  seconds of frame sampling after join        (default 15)
 *
 * Reports per join: seconds of accumulated drawing, time to sync completion,
 * dropped-frame % and p95 during the window, and how many full-board composites
 * the replay forced. Median frame time is deliberately absent — it pins to the
 * refresh ceiling and hides all of this.
 *
 * Requires: the tunnel + Chrome on `book` (CDP on 127.0.0.1:9222) and peers
 * drawing continuously in the same room (testing/devtools/peer_bot.mjs).
 *
 * STATUS 2026-09-03: written but NEVER completed a full run. Both attempts died
 * at the post-reload `app.connected` wait, and the cause turned out to be the
 * rig, not the script — Chrome exited on the box (the tunnel log filled with
 * "channel 2: open failed: connect failed" on the -L 9222 forward) and the
 * Chromebook then dropped off the tailnet entirely. Re-verify the rig with
 * `curl 127.0.0.1:9222/json/version` before blaming this harness.
 */
import puppeteer from 'puppeteer';

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const URL = 'http://localhost:3000/go/';
const ROOM = process.env.ROOM || 'joincost';
const JOINS = Number(process.env.JOINS || 6);
const GROW = Number(process.env.GROW || 90);
const WATCH = Number(process.env.WATCH || 15);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null, protocolTimeout: 600000 });
const pages = await browser.pages();
const page = pages.find(p => p.url().includes('localhost:3000')) || pages[0];

const t0 = Date.now();
const rows = [];

for (let i = 0; i < JOINS; i++) {
  // Full reload every time: instrumentation must not survive into the next
  // sample, and a join has to be a real cold join to mean anything.
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  await page.evaluate(() => {
    const box = document.querySelector('input[placeholder*="username" i], input[placeholder*="Pick" i]');
    if (box) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(box, 'weakobs');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const btn = [...document.querySelectorAll('button')].find(b => /join & draw/i.test(b.textContent));
    if (btn) btn.click();
  });
  await page.waitForFunction(() => window.app?.connected && window.app.board?.viewCanvas, { timeout: 90000 });
  await sleep(2000);

  // Instrument BEFORE the room join, so the replay itself is inside the window.
  await page.evaluate(async () => {
    try { await navigator.wakeLock.request('screen'); } catch (_) { /* headless-ish */ }
    const a = window.app, b = a.board;
    const P = window.__P = { full: 0, partial: 0, syncDoneAt: null };
    const origFull = b.markCompositeFull.bind(b);
    b.markCompositeFull = (...x) => { P.full++; return origFull(...x); };
    const g = b.compositeTileGrid;
    const oc = g.consumeDirtyRects.bind(g);
    g.consumeDirtyRects = (...x) => {
      const r = oc(...x);
      if (r && r.length) P.partial++;
      return r;
    };
    // A long replay blocks the main thread for whole seconds at a time, and rAF
    // stops firing with it — long enough to trip puppeteer's default 180s
    // protocolTimeout and kill the run that was measuring exactly that. Hence
    // the raised timeout on connect and the wall-clock backstop below.
    window.__watch = (secs) => new Promise(res => {
      const iv = []; let last = performance.now(); const start = last;
      const step = () => {
        const now = performance.now(); iv.push(now - last); last = now;
        if (P.syncDoneAt === null && a.syncClient && a.syncClient.syncing === false && now - start > 500) {
          P.syncDoneAt = now - start;
        }
        if (now - start < secs * 1000) { requestAnimationFrame(step); return; }
        iv.shift();
        const sorted = [...iv].sort((x, y) => x - y);
        const q = p => +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1);
        res({
          frames: iv.length,
          droppedPct: +(100 * iv.filter(v => v > 25).length / iv.length).toFixed(1),
          p95: q(0.95), p99: q(0.99), worst: +Math.max(...iv).toFixed(1),
          effFps: +(1000 * iv.length / iv.reduce((s, v) => s + v, 0)).toFixed(1),
          fullComposites: P.full, partialComposites: P.partial,
          syncMs: P.syncDoneAt === null ? null : Math.round(P.syncDoneAt)
        });
      };
      requestAnimationFrame(step);
    });
  });

  const joinStart = Date.now();
  await page.evaluate(r => window.app.handleRoomSelected(r), ROOM);
  const w = await page.evaluate(s => window.__watch(s), WATCH);
  const peers = await page.evaluate(() => ({
    users: window.app.users.size,
    room: window.app.currentRoomId,
    connected: window.app.connected
  }));

  const grownFor = Math.round((joinStart - t0) / 1000);
  rows.push({ join: i, grownForSec: grownFor, ...w, ...peers });
  console.log(`join ${i}  tail≈${grownFor}s of drawing  users=${peers.users}  room=${peers.room}`);
  console.log(`   syncMs ${w.syncMs}  dropped ${w.droppedPct}%  p95 ${w.p95}  p99 ${w.p99}  worst ${w.worst}ms  effFps ${w.effFps}`);
  console.log(`   composites: ${w.fullComposites} full / ${w.partialComposites} partial`);

  if (i < JOINS - 1) await sleep(GROW * 1000);
}

console.log('\nCURVE (tail seconds -> join cost)');
for (const r of rows) {
  console.log(`  ${String(r.grownForSec).padStart(4)}s  sync ${String(r.syncMs).padStart(5)}ms  `
    + `dropped ${String(r.droppedPct).padStart(5)}%  p99 ${String(r.p99).padStart(6)}ms  full ${r.fullComposites}`);
}
console.log('\nJSON');
console.log(JSON.stringify(rows, null, 2));
await browser.disconnect();
