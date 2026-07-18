#!/usr/bin/env node
/** One-off: verify the mixed_tools feed actually lands fill/text/selection/eraser commits. */
import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FEED = path.join(__dirname, '_k6_edge_feed.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const room = `mixedsmoke_${Date.now()}`;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1920, height: 1080 } });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[ERR]', e.message));
    await page.goto('http://localhost:3000/go/', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });
    await page.evaluate(() => {
      window.__fill = [];
      const prevFill = window.app.wsClient.messageHandlers.get('fill');
      window.app.wsClient.on('fill', (d) => { window.__fill.push(d); prevFill?.(d); });
    });
    await page.evaluate((r) => { window.app.self.username = 'S'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected, { timeout: 60_000 });

    const k6 = spawn('k6', ['run', '-e', `ROOM=${room}`, '-e', 'TARGET_URL=ws://127.0.0.1:8030', '-e', 'VUS=3',
      '-e', 'SCENARIO=mixed_tools', '-e', 'LIFETIME_MS=40000', FEED], { shell: true });
    const k6done = new Promise((res) => k6.on('close', res));

    let prev = '';
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      const n = await page.evaluate(() => window.app.board.layerManager.layerGroups.reduce((s, g) => s + g.strokeStack.length, 0));
      if (String(n) === prev && n > 0) break;
      prev = String(n);
    }
    const summary = await page.evaluate(() => {
      const lm = window.app.board.layerManager;
      const out = { total: 0, fullCanvas: 0, destOut: 0, blends: {}, byUser: {}, big: [] };
      for (const g of lm.layerGroups) {
        for (const s of g.strokeStack) {
          out.total++;
          out.byUser[s.userId] = (out.byUser[s.userId] || 0) + 1;
          const bm = s.blendMode || 'source-over';
          out.blends[bm] = (out.blends[bm] || 0) + 1;
          if (s.canvas && s.canvas.width >= 1000) { out.fullCanvas++; out.big.push(`${s.canvas.width}x${s.canvas.height}@${s.x},${s.y} u=${s.userId} bm=${bm}`); }
          if (bm === 'destination-out') out.destOut++;
        }
      }
      out.fillEvents = window.__fill;
      return out;
    });
    console.log(JSON.stringify(summary, null, 1));
    await k6done;
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
