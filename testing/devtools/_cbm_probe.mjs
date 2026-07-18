#!/usr/bin/env node
/** One-off: does a k6-style CBM('multiply') actually reach a browser client
 *  and ride into the committed stroke record? */
import puppeteer from 'puppeteer';
import WebSocket from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildMsg } from '../_k6_proto.js';
import { T } from '../../shared/MessageTypes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const room = `cbmprobe_${Date.now()}`;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1920, height: 1080 } });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[ERR]', e.message));
    await page.goto('http://localhost:3000/go/', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });
    // Log what the observer's wsClient emits for cbm.
    await page.evaluate(() => {
      window.__cbm = [];
      const prev = window.app.wsClient.messageHandlers.get('cbm');
      window.app.wsClient.on('cbm', (d) => { window.__cbm.push(d); prev?.(d); });
      window.__fill = [];
      const prevFill = window.app.wsClient.messageHandlers.get('fill');
      window.app.wsClient.on('fill', (d) => { window.__fill.push(d); prevFill?.(d); });
      // Trace every setBlendMode call with its caller.
      window.__bmCalls = [];
      const proto = Object.getPrototypeOf(window.app.self);
      const orig = proto.setBlendMode;
      proto.setBlendMode = function (bm) {
        window.__bmCalls.push({ id: this.id, bm, stack: new Error().stack.split('\n').slice(2, 5).join(' | ') });
        return orig.call(this, bm);
      };
    });
    await page.evaluate((r) => { window.app.self.username = 'P'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected, { timeout: 60_000 });
    await sleep(500);

    const sock = new WebSocket(`ws://127.0.0.1:8030/?room=${room}`);
    await new Promise((res) => sock.on('open', res));
    const send = (m) => sock.send(buildMsg(m));
    send({ t: T.CONNECT, n: 'BOT' });
    await sleep(400);
    const u = 0; // server rewrites sender index anyway
    send({ t: T.CT, u, l: 0 });
    send({ t: T.CC, u, c: 0xff0000ff });
    send({ t: T.CS, u, s: 2000 });
    send({ t: T.CHD, u, hd: 100 });
    send({ t: T.CBM, u, bm: 'multiply' });
    await sleep(200);
    send({ t: T.MD, u, ps: [300, 300] });
    await sleep(100);
    send({ t: T.MM, u, ps: [360, 340], stroke_ts: Date.now() });
    await sleep(100);
    send({ t: T.MM, u, ps: [420, 380] });
    await sleep(100);
    send({ t: T.MU, u });
    await sleep(800);
    send({ t: T.CC, u, c: 0x00ff00ff });
    send({ t: T.FILL, u, sx: 330, sy: 330 });
    await sleep(1500);

    const report = await page.evaluate(() => {
      const lm = window.app.board.layerManager;
      const recs = [];
      for (const g of lm.layerGroups) for (const s of g.strokeStack) recs.push({ seq: s.seq, u: s.userId, bm: s.blendMode ?? null, w: s.canvas?.width });
      const users = [];
      for (const [id, usr] of window.app.users) users.push({ id, tool: usr.tool, bm: usr.blendMode ?? null });
      return { cbmEvents: window.__cbm, fillEvents: window.__fill, recs, users, bmCalls: window.__bmCalls };
    });
    console.log(JSON.stringify(report, null, 1));
    sock.close();
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
