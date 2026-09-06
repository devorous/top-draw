/**
 * Who forces FULL composites on the weak client while a remote user draws?
 *
 * Stack-attributed counting of Board.markCompositeFull / CompositeTileGrid.markFull,
 * plus a classification of every consumeDirtyRects() call into full / partial /
 * empty. Run with a peer drawing (testing/devtools/peer_draw.mjs) so the remote
 * path is actually exercised.
 *
 *   SECONDS=12 node testing/devtools/grid_caller_diag.mjs
 *
 * Attaches to the Chromebook over the CDP tunnel; does NOT reload the page by
 * default (RELOAD=1 to force a fresh join after an HMR edit).
 */
import puppeteer from 'puppeteer';

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const URL = 'http://localhost:3000/go/';
const SECONDS = Number(process.env.SECONDS || 12);
const ROOM = process.env.ROOM || 'perfroom';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
const pages = await browser.pages();
let page = pages.find(p => p.url().includes('localhost:3000')) || pages[0];

const joined = await page.evaluate(() => !!window.app?.connected).catch(() => false);
if (process.env.RELOAD === '1' || !joined) {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
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
  await sleep(4000);
}

// `/go/` picks a room for you; two clients land in different rooms while both
// look healthy (users>=2 from other traffic, but zero remote draw arrives).
const room = await page.evaluate(() => window.app?.currentRoomId);
if (room !== ROOM) {
  await page.evaluate(r => window.app.handleRoomSelected(r), ROOM);
  await page.waitForFunction(r => window.app?.connected && window.app.currentRoomId === r,
    { timeout: 60000 }, ROOM);
  await sleep(4000);
}

const out = await page.evaluate(async (secs) => {
  let wake = 'unavailable';
  try { await navigator.wakeLock.request('screen'); wake = 'held'; } catch (e) { wake = 'failed:' + e.name; }

  const a = window.app, b = a.board, g = b.compositeTileGrid;
  const callers = {};
  const origMarkFull = g.markFull.bind(g);
  g.markFull = function () {
    const st = new Error().stack.split('\n').slice(2, 7)
      .map(s => s.trim().replace(/^at\s+/, '').split(' ')[0])
      .filter(s => s && s !== 'Object.markFull').join(' < ');
    callers[st] = (callers[st] || 0) + 1;
    return origMarkFull();
  };

  const P = { full: 0, partial: 0, empty: 0, cov: 0, covN: 0 };
  const area = g.width * g.height;
  const oc = g.consumeDirtyRects.bind(g);
  g.consumeDirtyRects = (...x) => {
    const r = oc(...x);
    if (r === null) P.full++;
    else if (r.length === 0) P.empty++;
    else { P.partial++; let s = 0; for (const q of r) s += q.width * q.height; P.cov += s / area; P.covN++; }
    return r;
  };

  // Frame health over the same window.
  const iv = []; let last = performance.now(); const t0 = last;
  await new Promise(res => {
    const step = () => {
      const now = performance.now(); iv.push(now - last); last = now;
      if (now - t0 < secs * 1000) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });
  iv.shift();

  g.markFull = origMarkFull;
  g.consumeDirtyRects = oc;

  const sorted = [...iv].sort((x, y) => x - y);
  const q = p => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2) : null;
  const tools = [];
  a.users.forEach(u => { if (u.id !== a.self?.id) tools.push({ id: u.id, tool: u.tool, down: !!u.mousedown }); });

  return {
    wake, room: a.currentRoomId, users: a.users.size, connected: a.connected, dims: b.dimensions.slice(),
    remotes: tools,
    frames: iv.length,
    droppedPct: iv.length ? +(100 * iv.filter(v => v > 25).length / iv.length).toFixed(1) : null,
    p95: q(0.95), p99: q(0.99),
    effFps: iv.length ? +(1000 * iv.length / iv.reduce((s, v) => s + v, 0)).toFixed(1) : null,
    composites: { full: P.full, partial: P.partial, empty: P.empty,
      pctFull: (P.full + P.partial) ? +(100 * P.full / (P.full + P.partial)).toFixed(1) : null,
      avgCoveragePct: P.covN ? +(100 * P.cov / P.covN).toFixed(2) : null },
    markFullCallers: Object.entries(callers).sort((x, y) => y[1] - x[1]).slice(0, 12),
  };
}, SECONDS);

console.log(JSON.stringify(out, null, 2));
if (out.frames === 0) { console.error('ABORT: zero frames (display blanked)'); process.exit(2); }
if (out.users < 2) console.error('WARNING: only %d user(s) — peer not drawing!', out.users);
await browser.disconnect();
