#!/usr/bin/env node
/**
 * @fileoverview One-off forensic repro for mid-flood join stroke duplication.
 * A joins first; k6 floods; C joins mid-flood. At the end, dump both tabs'
 * stroke stacks ({seq, userId, hasCanvas}) and diff them.
 */
import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const WS_URL     = process.env.WS_URL     || 'ws://127.0.0.1:8030';
const FEED = path.join(__dirname, '_k6_ddraw_feed.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function spawnTab(browser, label) {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error(`[${label} ERR]`, err.message));
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });
  return { label, page };
}

async function joinRoom(tab, room) {
  await tab.page.evaluate((n, r) => { window.app.self.username = n; window.app.handleRoomSelected(r); }, tab.label, room);
  await tab.page.waitForFunction(() => {
    const app = window.app;
    const done = app?.syncClient?.hasCompletedSync === true || (app?.wsClient?.connected && app?.users?.size <= 1);
    return app?.wsClient?.connected && done;
  }, { timeout: 60_000 });
}

function dumpStacks() {
  const lm = window.app?.board?.layerManager;
  const out = [];
  for (let gi = 0; gi < lm.layerGroups.length; gi++) {
    for (const s of lm.layerGroups[gi].strokeStack) {
      let px = 0, painted = 0;
      if (s.canvas) {
        const d = s.ctx.getImageData(0, 0, s.canvas.width, s.canvas.height).data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] > 0) { painted++; px = (px + d[i] + d[i + 1] * 7 + d[i + 2] * 13 + d[i + 3] * 31) >>> 0; }
        }
      }
      out.push({ g: gi, seq: s.seq ?? null, u: s.userId ?? null, ts: s.timestamp ?? null, blend: s.blendMode ?? null, x: s.x, y: s.y, w: s.canvas?.width, h: s.canvas?.height, painted, px });
    }
  }
  return out;
}

async function main() {
  const room = `dupforensics_${Date.now()}`;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1920, height: 1080 } });
  try {
    const A = await spawnTab(browser, 'A');
    const C = await spawnTab(browser, 'C');
    // Wire-level tally on C: how many times does each mu/md event ARRIVE
    // (dispatch level, before sync buffering), keyed by seq / user.
    await C.page.evaluate(() => {
      window.__muTally = new Map();
      window.__mdTally = new Map();
      // wsClient.on REPLACES the handler (Map.set) — chain the original or the
      // draw pipeline goes dead.
      const prevMu = window.app.wsClient.messageHandlers.get('mu');
      const prevMd = window.app.wsClient.messageHandlers.get('md');
      window.app.wsClient.on('mu', (d) => {
        const k = String(d.seq ?? 'noseq');
        window.__muTally.set(k, (window.__muTally.get(k) || 0) + 1);
        prevMu?.(d);
      });
      window.app.wsClient.on('md', (d) => {
        const k = `u${d.sessionIndex}`;
        window.__mdTally.set(k, (window.__mdTally.get(k) || 0) + 1);
        prevMd?.(d);
      });
    });
    await joinRoom(A, room);

    const k6 = spawn('k6', ['run', '-e', `ROOM=${room}`, '-e', `TARGET_URL=${WS_URL}`, '-e', 'VUS=12', '-e', 'STROKES=18', '-e', 'HARDNESS=100', '-e', 'LIFETIME_MS=60000', FEED], { shell: true });
    let k6out = ''; k6.stdout.on('data', (d) => k6out += d); k6.stderr.on('data', (d) => k6out += d);
    const k6done = new Promise((res) => k6.on('close', res));

    await sleep(4500);
    await joinRoom(C, room);
    console.log('C joined mid-flood');

    // settle: stroke counts stable on both, and C must actually have content
    // (its sync buffer replays a while after joining — a 0-count C just means
    // the sync hasn't finished, not that it's stable).
    let prev = '';
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      const a = await A.page.evaluate(() => window.app.board.layerManager.layerGroups.reduce((n, g) => n + g.strokeStack.length, 0));
      const c = await C.page.evaluate(() => window.app.board.layerManager.layerGroups.reduce((n, g) => n + g.strokeStack.length, 0));
      const cur = `${a}/${c}`;
      if (cur === prev && a > 0 && c > 0) break;
      prev = cur;
    }
    const syncState = await C.page.evaluate(() => ({
      syncing: window.app.syncClient?.syncing,
      buffering: window.app.syncClient?.buffering,
      completed: window.app.syncClient?.hasCompletedSync,
      buffered: window.app.syncClient?.eventBuffer?.length,
    }));
    console.log('C sync state at dump:', JSON.stringify(syncState));

    const sa = await A.page.evaluate(dumpStacks);
    const sc = await C.page.evaluate(dumpStacks);
    console.log(`A stack: ${sa.length}, C stack: ${sc.length}`);

    const key = (s) => `${s.seq}`;
    const countBy = (arr) => { const m = new Map(); for (const s of arr) m.set(key(s), (m.get(key(s)) || 0) + 1); return m; };
    const ma = countBy(sa), mc = countBy(sc);

    const dupInC = [...mc.entries()].filter(([, n]) => n > 1);
    const dupInA = [...ma.entries()].filter(([, n]) => n > 1);
    console.log('duplicate seqs in A:', dupInA);
    console.log('duplicate seqs in C:', dupInC);

    const onlyC = [...mc.keys()].filter((k) => !ma.has(k));
    const onlyA = [...ma.keys()].filter((k) => !mc.has(k));
    console.log('seqs only in C:', onlyC);
    console.log('seqs only in A:', onlyA);

    // Wire-level arrival counts for C's duplicated seqs.
    const muTally = await C.page.evaluate(() => Object.fromEntries(window.__muTally));
    const mdTally = await C.page.evaluate(() => Object.fromEntries(window.__mdTally));
    for (const [k] of dupInC.slice(0, 12)) {
      console.log(`  wire mu deliveries for seq ${k}: ${muTally[k] ?? 0}`);
    }
    const multiMu = Object.entries(muTally).filter(([, n]) => n > 1);
    console.log('all seqs with >1 wire mu delivery:', multiMu.slice(0, 20));
    console.log('md deliveries per user:', mdTally);

    // detail for C's duplicated seqs
    for (const [k] of dupInC.slice(0, 12)) {
      const rows = sc.filter((s) => key(s) === k);
      console.log(`  seq ${k}:`, rows.map((r) => `u=${r.u} g=${r.g} ${r.w}x${r.h}@${r.x},${r.y} ts=${r.ts}`).join('  |  '));
    }

    // Per-seq record comparison: same stroke committed on both — does it have
    // the same geometry (bbox) and pixel content?
    const byseqA = new Map(sa.map((s) => [key(s), s]));
    let bboxMismatch = 0, pxMismatch = 0, compared = 0;
    const detail = [];
    for (const s of sc) {
      const a = byseqA.get(key(s));
      if (!a) continue;
      compared++;
      const bboxOk = a.x === s.x && a.y === s.y && a.w === s.w && a.h === s.h;
      const pxOk = a.painted === s.painted && a.px === s.px;
      if (!bboxOk) bboxMismatch++;
      if (bboxOk && !pxOk) pxMismatch++;
      if ((!bboxOk || !pxOk) && detail.length < 15) {
        detail.push(`  seq ${s.seq} u=${s.u}: A ${a.w}x${a.h}@${a.x},${a.y} painted=${a.painted} px=${a.px}  vs  C ${s.w}x${s.h}@${s.x},${s.y} painted=${s.painted} px=${s.px}`);
      }
    }
    console.log(`record comparison: ${compared} shared seqs, ${bboxMismatch} bbox mismatches, ${pxMismatch} pixel-content mismatches (same bbox)`);
    for (const line of detail) console.log(line);

    // Export stroke-canvas pairs + red/green overlay diff for the first few
    // mismatched seqs so the mismatch type (edge fringe vs missing stamp) is
    // visually inspectable.
    const mismatchSeqs = [];
    for (const s of sc) {
      const a = byseqA.get(key(s));
      if (!a) continue;
      if (!(a.x === s.x && a.y === s.y && a.w === s.w && a.h === s.h) || a.painted !== s.painted || a.px !== s.px) {
        mismatchSeqs.push(s.seq);
        if (mismatchSeqs.length >= 3) break;
      }
    }
    const grabStroke = (seqWanted) => {
      const lm = window.app.board.layerManager;
      for (const g of lm.layerGroups) {
        for (const s of g.strokeStack) {
          if (s.seq === seqWanted && s.canvas) return s.canvas.toDataURL();
        }
      }
      return null;
    };
    const outDir = path.join(__dirname, '..', 'sync_results');
    for (const seq of mismatchSeqs) {
      const da = await A.page.evaluate(grabStroke, seq);
      const dc = await C.page.evaluate(grabStroke, seq);
      if (da && dc) {
        const overlay = await A.page.evaluate(async (u1, u2) => {
          const load = (u) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = u; });
          const [i1, i2] = await Promise.all([load(u1), load(u2)]);
          const cv = document.createElement('canvas'); cv.width = i1.width * 3; cv.height = i1.height;
          const cx = cv.getContext('2d');
          cx.drawImage(i1, 0, 0); cx.drawImage(i2, i1.width, 0);
          // diff panel: red = A only, green = C only
          const d1 = (() => { const c = document.createElement('canvas'); c.width = i1.width; c.height = i1.height; const x = c.getContext('2d'); x.drawImage(i1, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; })();
          const d2 = (() => { const c = document.createElement('canvas'); c.width = i2.width; c.height = i2.height; const x = c.getContext('2d'); x.drawImage(i2, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; })();
          const od = cx.createImageData(i1.width, i1.height);
          for (let p = 0; p < d1.length; p += 4) {
            const a1 = d1[p + 3], a2 = d2[p + 3];
            if (Math.abs(a1 - a2) > 16 || Math.abs(d1[p] - d2[p]) > 16 || Math.abs(d1[p + 1] - d2[p + 1]) > 16 || Math.abs(d1[p + 2] - d2[p + 2]) > 16) {
              if (a1 > a2) { od.data[p] = 255; od.data[p + 3] = 255; }
              else { od.data[p + 1] = 255; od.data[p + 3] = 255; }
            } else if (a1 > 0) { od.data[p] = od.data[p + 1] = od.data[p + 2] = 70; od.data[p + 3] = 255; }
          }
          cx.putImageData(od, i1.width * 2, 0);
          return cv.toDataURL();
        }, da, dc);
        fs.writeFileSync(path.join(outDir, `strokediff_seq${seq}.png`), Buffer.from(overlay.split(',')[1], 'base64'));
        console.log(`wrote strokediff_seq${seq}.png (A | C | diff: red=A-only green=C-only)`);
      }
    }

    await k6done;
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
