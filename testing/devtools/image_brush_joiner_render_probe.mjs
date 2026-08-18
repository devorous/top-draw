#!/usr/bin/env node
/**
 * Which brush does a JOINER actually stamp with?
 *
 * A raw-socket bot draws two strokes with brush A and two with brush B, then a
 * real browser tab joins the room. Every ImageBrushTool stamp the tab makes is
 * recorded with the brush that was in force at the time, so the answer is not
 * inferred from pixels: strokes 1-2 must stamp BRUSH_A, strokes 3-4 BRUSH_B.
 *
 * A second raw-socket joiner records the wire in parallel, so a failure says
 * whether the server sent the brushes at all (a stale server process) or the
 * client dropped them.
 *
 * Needs the dev stack up (page :3000, ws :8030).
 *   node testing/devtools/image_brush_joiner_render_probe.mjs
 */

import puppeteer from 'puppeteer';
import WebSocket from 'ws';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import protobuf from 'protobufjs';
import { T } from '../../shared/MessageTypes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const PAGE_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
// By default the probe runs its own server on a spare port, so a stale dev
// server process cannot make a fixed build look broken (or a broken one look
// fixed). Point WS_URL at :8030 to test the dev server that is actually running.
const OWN_PORT = Number(process.env.PROBE_PORT || 8138);
const WS_URL = process.env.WS_URL || `ws://127.0.0.1:${OWN_PORT}`;
const SPAWN_SERVER = !process.env.WS_URL;
const ROOM = `brushrender_${Date.now()}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const NAME_BY_T = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));

const PIXEL_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PIXEL_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const brush = (name, pixel) => JSON.stringify({
  type: 'image', brushName: name, fileName: `${name}.png`,
  width: 1, height: 1, colorMode: 'original',
  gimpUrl: `data:image/png;base64,${pixel}`,
});

async function main() {
  const root = await protobuf.load(path.join(ROOT, 'public', 'messages.proto'));
  const Msg = root.lookupType('Msg');
  const encode = (obj) => Msg.encode(Msg.create(obj)).finish();

  let server = null;
  if (SPAWN_SERVER) {
    server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env: { ...process.env, PORT: String(OWN_PORT), HOST: '127.0.0.1', NODE_ENV: 'development' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (d) => {
      const line = String(d);
      if (/Sync|Brush/i.test(line)) process.stdout.write('  [server] ' + line);
    });
    server.stderr.on('data', (d) => process.stderr.write('  [server!] ' + String(d)));
    // Wait for the port to accept a socket rather than guessing at a delay.
    for (let i = 0; i < 60; i++) {
      try {
        const probe = new WebSocket(`${WS_URL}/?room=warmup`);
        await new Promise((res, rej) => { probe.once('open', res); probe.once('error', rej); });
        probe.close();
        break;
      } catch { await sleep(250); }
    }
    console.log(`Using a freshly started server on port ${OWN_PORT}`);
  } else {
    console.log(`Using the already-running server at ${WS_URL}`);
  }

  const browser = await puppeteer.launch({
    headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 900 },
  });

  try {
    // -- Drawer bot: brush A, two strokes; brush B, two strokes --------------
    const a = new WebSocket(`${WS_URL}/?room=${ROOM}`);
    await new Promise((res, rej) => { a.once('open', res); a.once('error', rej); });
    const sendA = (m) => a.send(encode(m));
    sendA({ t: T.CONNECT, n: 'DRAWER' });
    await sleep(400);
    sendA({ t: T.SYNC_REQUEST });
    await sleep(400);
    sendA({ t: T.CT, l: 3 });            // Tool.IMAGE_BRUSH
    sendA({ t: T.CS, s: 4000 });
    sendA({ t: T.CC, c: 0xff0000ff });
    sendA({ t: T.CSP, sp: 1000 });

    const stroke = (x) => {
      sendA({ t: T.MD, ps: [x * 10, 3000] });
      sendA({ t: T.MM, ps: [(x + 40) * 10, 3400] });
      sendA({ t: T.MU });
    };

    sendA({ t: T.GMP, g: brush('BRUSH_A', PIXEL_A) });
    await sleep(200);
    stroke(100); await sleep(150);
    stroke(200); await sleep(150);
    sendA({ t: T.GMP, g: brush('BRUSH_B', PIXEL_B) });
    await sleep(200);
    stroke(300); await sleep(150);
    stroke(400); await sleep(400);

    // -- Wire witness -------------------------------------------------------
    const wire = [];
    const c = new WebSocket(`${WS_URL}/?room=${ROOM}`);
    await new Promise((res, rej) => { c.once('open', res); c.once('error', rej); });
    c.on('message', (buf) => {
      const bytes = new Uint8Array(buf);
      let offset = 0;
      while (offset < bytes.length) {
        const reader = protobuf.Reader.create(bytes.subarray(offset));
        let msg;
        try { msg = Msg.decode(reader); } catch { break; }
        if (reader.pos === 0) break;
        offset += reader.pos;
        let label = NAME_BY_T[msg.t] || `T${msg.t}`;
        if (msg.t === T.GMP) {
          const m = /"brushName":"([^"]+)"/.exec(msg.g || '');
          label += `(${m ? m[1] : '?'})`;
        }
        if (/^(GMP|MD|MU|SYNC_METADATA|SYNC_COMPLETE)/.test(label)) wire.push(label);
      }
    });
    c.send(encode({ t: T.CONNECT, n: 'WIRE' }));
    await sleep(500);
    c.send(encode({ t: T.SYNC_REQUEST }));
    await sleep(2000);

    // -- Browser joiner -----------------------------------------------------
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('  [page error]', e.message));
    await page.goto(PAGE_URL, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });

    await page.evaluate(() => {
      window.__stamps = [];
      const tool = window.app.toolManager.getTool('imageBrush');
      const origDraw = tool.drawStamp.bind(tool);
      tool.drawStamp = function (user, pos, ...rest) {
        window.__stamps.push({ kind: 'down', brush: user?.imageBrush?.brushName ?? null, x: Math.round(pos?.x ?? -1) });
        return origDraw(user, pos, ...rest);
      };
      const origApply = tool.applyStamps.bind(tool);
      tool.applyStamps = function (user, pts, ...rest) {
        window.__stamps.push({ kind: 'stamps', brush: user?.imageBrush?.brushName ?? null, x: Math.round(pts?.[0] ?? -1) });
        return origApply(user, pts, ...rest);
      };
      window.__brushLoads = [];
      const rh = window.app.remoteUserHandler;
      const origLoad = rh.handleBrushLoad.bind(rh);
      rh.handleBrushLoad = function (user, data) {
        let name = null;
        try { name = (typeof data === 'string' ? JSON.parse(data) : data)?.brushName ?? null; } catch { /* ignore */ }
        window.__brushLoads.push({ user: user?.id, brush: name, buffering: !!window.app.syncClient?.buffering });
        return origLoad(user, data);
      };
    });

    await page.evaluate(({ r, wsUrl }) => {
      window.app.self.username = 'JOINER';
      // Point this tab at the same server the bots are on.
      window.app.wsClient.serverUrl = wsUrl;
      window.app.handleRoomSelected(r);
    }, { r: ROOM, wsUrl: WS_URL });
    await page.waitForFunction(() => window.app?.wsClient?.connected, { timeout: 60_000 });
    await sleep(6000);

    const report = await page.evaluate(() => ({
      stamps: window.__stamps,
      brushLoads: window.__brushLoads,
    }));

    console.log('\nWire seen by a raw joiner:');
    console.log('  ' + wire.join(' -> '));

    console.log('\nBrush loads applied by the browser joiner:');
    for (const l of report.brushLoads) console.log(`  user=${l.user} ${l.brush} (buffering=${l.buffering})`);

    console.log(`\nStamps drawn by the browser joiner (${report.stamps.length}):`);
    for (const s of report.stamps) console.log(`  ${s.kind} x=${s.x} brush=${s.brush}`);

    const byBrush = report.stamps.reduce((acc, s) => {
      acc[s.brush] = (acc[s.brush] || 0) + 1;
      return acc;
    }, {});
    console.log('\nStamp count by brush:', JSON.stringify(byBrush));

    // Board coords: strokes 1-2 live at x=100..240, strokes 3-4 at x=300..440.
    // (Stamp ORDER is not asserted — brush images decode independently, so a
    // later stroke can be painted first; each commit carries its own seq.)
    const wrong = report.stamps.filter(s =>
      (s.x < 250 && s.brush !== 'BRUSH_A') || (s.x >= 250 && s.brush !== 'BRUSH_B'));
    if (report.stamps.length === 0) {
      console.log('\nINCONCLUSIVE: the joiner drew no image-brush stamps at all.');
    } else if (wrong.length) {
      console.log(`\nFAIL: ${wrong.length}/${report.stamps.length} stamps used the wrong brush.`);
      for (const s of wrong.slice(0, 8)) console.log(`  x=${s.x} used ${s.brush}`);
    } else {
      console.log('\nPASS: every replayed stamp used the brush it was drawn with.');
    }

    a.close();
    c.close();
  } finally {
    await browser.close();
    server?.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
