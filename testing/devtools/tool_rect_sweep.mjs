/**
 * Per-tool check that the remote preview resolves a SCOPED dirty rect on the
 * weak client instead of falling back to a full-board composite.
 *
 * For each tool it spawns testing/devtools/peer_bot.mjs on this PC, then over
 * the CDP tunnel measures on the Chromebook: how many composites were full vs
 * partial, who called markFull, and what the resolver actually returned. The
 * tool the OBSERVER saw is reported alongside the one requested — they differ
 * when a tool refuses to activate (e.g. pattern with no image selected), and a
 * mismatch invalidates that row.
 *
 *   TOOLS=brush,flowPen,pixel,line node testing/devtools/tool_rect_sweep.mjs
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const ROOM = process.env.ROOM || 'perfroom';
const SECS = Number(process.env.SECONDS || 8);
const TOOLS = (process.env.TOOLS || 'brush,flowPen,ink,pixel,line,rectangle,circle,pattern').split(',');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
const pages = await browser.pages();
const page = pages.find(p => p.url().includes('localhost:3000')) || pages[0];
const room = await page.evaluate(() => window.app?.currentRoomId);
if (room !== ROOM) {
  await page.evaluate(r => window.app.handleRoomSelected(r), ROOM);
  await page.waitForFunction(r => window.app?.connected && window.app.currentRoomId === r, { timeout: 60000 }, ROOM);
  await sleep(3000);
}

const results = [];
for (const tool of TOOLS) {
  const child = spawn(process.execPath, ['testing/devtools/peer_bot.mjs'], {
    env: { ...process.env, TOOL: tool, ROOM, SECONDS: String(SECS + 8) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let peerLog = '';
  child.stdout.on('data', d => { peerLog += d; });
  child.stderr.on('data', d => { peerLog += d; });
  // The bot joins in well under a second; give the tool-change messages and the
  // first stroke time to land.
  await sleep(3000);

  const r = await page.evaluate(async (secs) => {
    const a = window.app, b = a.board, g = b.compositeTileGrid, h = a.remoteUserHandler;
    let full = 0, partial = 0, cov = 0, covN = 0, nullRects = 0, okRects = 0;
    const callers = {};
    const area = g.width * g.height;
    const oc = g.consumeDirtyRects.bind(g);
    g.consumeDirtyRects = (...x) => {
      const q = oc(...x);
      if (q === null) full++;
      else if (q.length) { partial++; let s = 0; for (const t of q) s += t.width * t.height; cov += s / area; covN++; }
      return q;
    };
    const omf = g.markFull.bind(g);
    g.markFull = function () {
      const st = new Error().stack.split('\n').slice(2, 5).map(s => s.trim().replace(/^at\s+/, '').split(' ')[0]).join(' < ');
      callers[st] = (callers[st] || 0) + 1;
      return omf();
    };
    const orig = h._activeStrokeDirtyRect.bind(h);
    h._activeStrokeDirtyRect = (u, l) => { const q = orig(u, l); q ? okRects++ : nullRects++; return q; };

    const iv = []; let last = performance.now(); const t0 = last;
    await new Promise(res => {
      const step = () => { const n = performance.now(); iv.push(n - last); last = n;
        if (n - t0 < secs * 1000) requestAnimationFrame(step); else res(); };
      requestAnimationFrame(step);
    });
    iv.shift();
    g.consumeDirtyRects = oc; g.markFull = omf; h._activeStrokeDirtyRect = orig;

    const seen = []; a.users.forEach(u => { if (u.id !== a.self?.id) seen.push(u.tool); });
    const sorted = [...iv].sort((x, y) => x - y);
    return {
      observedTools: seen, users: a.users.size, frames: iv.length,
      droppedPct: iv.length ? +(100 * iv.filter(v => v > 25).length / iv.length).toFixed(1) : null,
      p95: sorted.length ? +sorted[Math.floor(sorted.length * 0.95)].toFixed(2) : null,
      effFps: iv.length ? +(1000 * iv.length / iv.reduce((s, v) => s + v, 0)).toFixed(1) : null,
      full, partial, pctFull: (full + partial) ? +(100 * full / (full + partial)).toFixed(1) : null,
      avgCoveragePct: covN ? +(100 * cov / covN).toFixed(2) : null,
      resolver: { scoped: okRects, null: nullRects },
      markFullCallers: Object.entries(callers).sort((x, y) => y[1] - x[1]).slice(0, 4),
    };
  }, SECS);

  child.kill();
  results.push({ tool, peerReady: (peerLog.match(/PEER BOT READY .*/) || [''])[0], ...r });
  console.log(`${tool.padEnd(10)} observed=${JSON.stringify(r.observedTools)} pctFull=${r.pctFull} ` +
    `cov=${r.avgCoveragePct}% resolver(scoped/null)=${r.resolver.scoped}/${r.resolver.null} ` +
    `drop=${r.droppedPct}% p95=${r.p95} fps=${r.effFps}`);
  if (r.markFullCallers.length) console.log('   markFull:', JSON.stringify(r.markFullCallers));
  await sleep(3000);
}

console.log('\n' + JSON.stringify(results, null, 2));
await browser.disconnect();
