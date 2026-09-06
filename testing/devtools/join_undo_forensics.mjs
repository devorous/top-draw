#!/usr/bin/env node
/**
 * @fileoverview Forensic repro for the join_during_undo z-order divergence.
 * A joins first; k6 runs the undo_redo edge scenario; C joins mid-flood.
 * At the end, dump both tabs' stroke stacks IN STACK ORDER and diff:
 *   - presence (seqs only on one side)
 *   - ordering (first index where the shared-seq order differs)
 *   - per-record pixel content
 * plus wire-level undo/redo delivery tallies on C.
 */
import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const WS_URL     = process.env.WS_URL     || 'ws://127.0.0.1:8030';
const FEED = path.join(__dirname, '_k6_edge_feed.js');
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
    lm.layerGroups[gi].strokeStack.forEach((s, idx) => {
      let px = 0, painted = 0;
      if (s.canvas) {
        const d = s.ctx.getImageData(0, 0, s.canvas.width, s.canvas.height).data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] > 0) { painted++; px = (px + d[i] + d[i + 1] * 7 + d[i + 2] * 13 + d[i + 3] * 31) >>> 0; }
        }
      }
      out.push({ g: gi, idx, seq: s.seq ?? null, u: s.userId ?? null, ts: s.timestamp ?? null,
                 x: s.x, y: s.y, w: s.canvas?.width, h: s.canvas?.height, painted, px });
    });
  }
  return out;
}

function dumpBaked() {
  const lm = window.app?.board?.layerManager;
  const out = [];
  for (let gi = 0; gi < lm.layerGroups.length; gi++) {
    for (const seq of (lm.layerGroups[gi].bakedSequences || [])) {
      if (seq.type === 'group' && seq.strokes) {
        for (const s of seq.strokes) out.push({ g: gi, seq: s.seq ?? null, u: s.userId ?? null });
      } else {
        out.push({ g: gi, seq: seq.seq ?? null, u: seq.userId ?? null, kind: seq.type ?? 'single' });
      }
    }
  }
  return out;
}

function dumpRedoStacks() {
  const lm = window.app?.board?.layerManager;
  const out = {};
  for (const [uid, batches] of lm.redoStackByUser) {
    out[uid] = batches.map((b) => b.map((e) => ({ g: e.groupIdx, seq: e.record?.seq ?? null })));
  }
  return out;
}

async function main() {
  const room = `undoforensics_${Date.now()}`;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1920, height: 1080 } });
  try {
    const A = await spawnTab(browser, 'A');
    const C = await spawnTab(browser, 'C');
    // Wire-level tally on both tabs: undo/redo deliveries per user + arrival index.
    const instrument = () => {
      window.__histLog = [];
      for (const ev of ['undo', 'redo', 'mu', 'md', 'ct', 'cc', 'cs', 'chd']) {
        const prev = window.app.wsClient.messageHandlers.get(ev);
        window.app.wsClient.on(ev, (d) => {
          window.__histLog.push({ ev, u: d.sessionIndex ?? d.u, seq: d.seq ?? null,
            v: d.size ?? d.color ?? d.tool ?? d.hardness ?? null, t: Date.now() });
          prev?.(d);
        });
      }
    };
    await A.page.evaluate(instrument);
    await C.page.evaluate(instrument);
    // Deep instrumentation on C: log everything the sync client buffers
    // (pre-dedup) and everything actually applied (post-dedup) for the config +
    // stroke lifecycle events, so we can see which CC/CS a straddling stroke's
    // MD actually ran under.
    await C.page.evaluate(() => {
      window.__bufLog = [];
      window.__appLog = [];
      // Patch replayBuffer on the prototype: snapshot the whole pre-dedup
      // buffer and record which entries the (event,seq) keep-last dedup will
      // drop. Markers prove the patch actually took effect.
      const sc0 = window.app.syncClient;
      if (!sc0) { window.__bufLog.push({ ev: 'NO_SYNCCLIENT_AT_PATCH_TIME' }); }
      const proto = sc0 ? Object.getPrototypeOf(sc0) : null;
      if (proto) {
        window.__bufLog.push({ ev: 'PATCHED' });
        const origReplay = proto.replayBuffer;
        proto.replayBuffer = function () {
          const lastIndexByKey = new Map();
          for (let i = 0; i < this.eventBuffer.length; i++) {
            const { eventName, data } = this.eventBuffer[i];
            if (data?.seq) lastIndexByKey.set(`${eventName}:${data.seq}`, i);
          }
          window.__bufLog.push({ ev: 'REPLAY', n: this.eventBuffer.length });
          for (let i = 0; i < this.eventBuffer.length; i++) {
            const { eventName, data } = this.eventBuffer[i];
            const seq = data?.seq ?? null;
            const dropped = !!(seq && lastIndexByKey.get(`${eventName}:${seq}`) !== i);
            window.__bufLog.push({ ev: eventName, seq, u: data?.sessionIndex ?? null,
              v: data?.size ?? data?.color ?? data?.tool ?? null, dropped });
          }
          return origReplay.call(this);
        };
      }
    });
    await joinRoom(A, room);

    const k6 = spawn('k6', ['run', '-e', `ROOM=${room}`, '-e', `TARGET_URL=${WS_URL}`, '-e', 'VUS=12', '-e', 'STROKES=18',
      '-e', 'SCENARIO=undo_redo', '-e', 'LIFETIME_MS=60000', FEED], { shell: true });
    let k6out = ''; k6.stdout.on('data', (d) => k6out += d); k6.stderr.on('data', (d) => k6out += d);
    const k6done = new Promise((res) => k6.on('close', res));

    await sleep(5000);
    await joinRoom(C, room);
    console.log('C joined mid-flood');

    // settle: stroke counts stable on both and both non-zero
    let prev = '';
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      const a = await A.page.evaluate(() => window.app.board.layerManager.layerGroups.reduce((n, g) => n + g.strokeStack.length, 0));
      const c = await C.page.evaluate(() => window.app.board.layerManager.layerGroups.reduce((n, g) => n + g.strokeStack.length, 0));
      const cur = `${a}/${c}`;
      if (cur === prev && a > 0 && c > 0) break;
      prev = cur;
    }

    const [sa, sc, ba, bc, ra, rc] = await Promise.all([
      A.page.evaluate(dumpStacks), C.page.evaluate(dumpStacks),
      A.page.evaluate(dumpBaked),  C.page.evaluate(dumpBaked),
      A.page.evaluate(dumpRedoStacks), C.page.evaluate(dumpRedoStacks),
    ]);
    console.log(`A stack: ${sa.length} (baked ${ba.length}), C stack: ${sc.length} (baked ${bc.length})`);
    console.log('A redoStacks:', JSON.stringify(ra));
    console.log('C redoStacks:', JSON.stringify(rc));

    // presence diff
    const seqsA = sa.map((s) => s.seq), seqsC = sc.map((s) => s.seq);
    const setA = new Set(seqsA), setC = new Set(seqsC);
    console.log('stack seqs only in A:', seqsA.filter((s) => !setC.has(s)));
    console.log('stack seqs only in C:', seqsC.filter((s) => !setA.has(s)));
    const bakedSeqsA = ba.map((s) => s.seq), bakedSeqsC = bc.map((s) => s.seq);
    const bsetA = new Set(bakedSeqsA), bsetC = new Set(bakedSeqsC);
    console.log('baked seqs only in A:', bakedSeqsA.filter((s) => !bsetC.has(s)));
    console.log('baked seqs only in C:', bakedSeqsC.filter((s) => !bsetA.has(s)));

    // ordering diff over shared seqs (per group)
    for (const g of [...new Set(sa.map((s) => s.g))]) {
      const ga = sa.filter((s) => s.g === g && setC.has(s.seq)).map((s) => s.seq);
      const gc = sc.filter((s) => s.g === g && setA.has(s.seq)).map((s) => s.seq);
      let firstDiff = -1;
      for (let i = 0; i < Math.min(ga.length, gc.length); i++) {
        if (ga[i] !== gc[i]) { firstDiff = i; break; }
      }
      if (firstDiff === -1 && ga.length === gc.length) {
        console.log(`group ${g}: shared-seq stack ORDER identical (${ga.length} records)`);
      } else {
        console.log(`group ${g}: ORDER DIVERGES at idx ${firstDiff}`);
        console.log(`  A order: ...${ga.slice(Math.max(0, firstDiff - 3), firstDiff + 6).join(',')}...`);
        console.log(`  C order: ...${gc.slice(Math.max(0, firstDiff - 3), firstDiff + 6).join(',')}...`);
      }
    }

    // per-record content diff on shared seqs
    const byseqA = new Map(sa.map((s) => [s.seq, s]));
    let bboxMismatch = 0, pxMismatch = 0, compared = 0;
    const detail = [];
    for (const s of sc) {
      const a = byseqA.get(s.seq);
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
    console.log(`record comparison: ${compared} shared seqs, ${bboxMismatch} bbox mismatches, ${pxMismatch} pixel-content mismatches`);
    for (const line of detail) console.log(line);

    // Export stroke-canvas pairs + red/green overlay diff for mismatched seqs
    // so the mismatch type (wrong size vs different path vs missing segment)
    // is visually inspectable.
    const mismatchSeqs = [];
    for (const s of sc) {
      const a = byseqA.get(s.seq);
      if (!a) continue;
      if (!(a.x === s.x && a.y === s.y && a.w === s.w && a.h === s.h) || a.painted !== s.painted || a.px !== s.px) {
        mismatchSeqs.push(s.seq);
        if (mismatchSeqs.length >= 7) break;
      }
    }
    const grabStroke = ({ seqWanted, ox, oy }) => {
      const lm = window.app.board.layerManager;
      for (const g of lm.layerGroups) {
        for (const s of g.strokeStack) {
          if (s.seq === seqWanted && s.canvas) {
            // Shared origin so A and C align even when bboxes differ.
            const cv = document.createElement('canvas');
            cv.width = 700; cv.height = 500;
            const cx = cv.getContext('2d');
            cx.drawImage(s.canvas, s.x - ox, s.y - oy);
            return { url: cv.toDataURL() };
          }
        }
      }
      return null;
    };
    const outDir = path.join(__dirname, '..', 'sync_results');
    fs.mkdirSync(outDir, { recursive: true });
    const byseqC = new Map(sc.map((s) => [s.seq, s]));
    for (const seq of mismatchSeqs) {
      const ra2 = byseqA.get(seq), rc2 = byseqC.get(seq);
      const ox = Math.max(0, Math.min(ra2.x, rc2.x) - 20);
      const oy = Math.max(0, Math.min(ra2.y, rc2.y) - 20);
      const ga = await A.page.evaluate(grabStroke, { seqWanted: seq, ox, oy });
      const gc = await C.page.evaluate(grabStroke, { seqWanted: seq, ox, oy });
      if (!ga || !gc) continue;
      const overlay = await A.page.evaluate(async (u1, u2) => {
        const load = (u) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = u; });
        const [i1, i2] = await Promise.all([load(u1), load(u2)]);
        const cv = document.createElement('canvas'); cv.width = i1.width * 3; cv.height = i1.height;
        const cx = cv.getContext('2d');
        cx.drawImage(i1, 0, 0); cx.drawImage(i2, i1.width, 0);
        const grab = (img) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
        const d1 = grab(i1), d2 = grab(i2);
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
      }, ga.url, gc.url);
      fs.writeFileSync(path.join(outDir, `undostroke_seq${seq}.png`), Buffer.from(overlay.split(',')[1], 'base64'));
      console.log(`wrote undostroke_seq${seq}.png (A | C | diff: red=A-only green=C-only)`);
    }

    // For each mismatched stroke, show C's buffered vs applied event streams
    // for that user near the commit seq — reveals which CC/CS its MD ran under
    // and whether dedup dropped/reordered config frames.
    const bufLog = await C.page.evaluate(() => window.__bufLog);
    const markers = bufLog.filter((e) => !('u' in e));
    console.log(`C buffer-log markers: ${JSON.stringify(markers)}; entries: ${bufLog.length - markers.length}`);
    const droppedAll = bufLog.filter((e) => e.dropped);
    console.log(`dedup-dropped entries: ${droppedAll.length}`, droppedAll.slice(0, 30).map((e) => `${e.ev}(${e.seq})u${e.u}`).join(' '));
    // Arrival streams (wsClient level — includes tail, pending-bundle, and live
    // frames in delivery order) for each mismatched stroke's user, on A and C.
    const arrA = await A.page.evaluate(() => window.__histLog);
    const arrC = await C.page.evaluate(() => window.__histLog);
    for (const seq of mismatchSeqs) {
      const u = byseqC.get(seq)?.u;
      const fmt = (e) => `${e.dropped ? 'X' : ''}${e.ev}(${e.seq}${e.v !== null && !['md', 'mu', 'mm'].includes(e.ev) ? `=${JSON.stringify(e.v)}` : ''})`;
      console.log(`\n─ mismatch seq ${seq} u=${u} (X = dedup-dropped)`);
      const near = (e) => e.u === u && (e.seq === null || (e.seq > seq - 260 && e.seq < seq + 40));
      console.log(`  buffered : ${bufLog.filter(near).map(fmt).join(' ')}`);
      // arrival order: show the user's frames around the commit by ARRIVAL
      // index, not seq (tail/pending frames arrive out of seq order).
      const dumpArrivals = (arr, label) => {
        const idx = arr.findIndex((e) => e.ev === 'mu' && e.seq === seq);
        const win = arr.filter((e, i) => e.u === u && i <= (idx === -1 ? arr.length : idx));
        console.log(`  ${label} arrivals (last 14 up to mu ${seq}): ${win.slice(-14).map(fmt).join(' ')}`);
      };
      dumpArrivals(arrA, 'A');
      dumpArrivals(arrC, 'C');
    }

    // wire history around C's join
    const hc = await C.page.evaluate(() => window.__histLog.filter((e) => e.ev !== 'mu'));
    const ha = await A.page.evaluate(() => window.__histLog.filter((e) => e.ev !== 'mu'));
    console.log(`undo/redo deliveries: A=${ha.length} C=${hc.length}`);
    const tallyBy = (arr) => { const m = {}; for (const e of arr) { const k = `${e.ev}:u${e.u}`; m[k] = (m[k] || 0) + 1; } return m; };
    console.log('A undo/redo per user:', JSON.stringify(tallyBy(ha)));
    console.log('C undo/redo per user:', JSON.stringify(tallyBy(hc)));

    // whole-board pixel diff for the record
    const shot = (page) => page.evaluate(() => {
      const b = window.app.board;
      b.compositeLayers?.();
      return b.viewCanvas.toDataURL();
    });
    const [da, dc] = await Promise.all([shot(A.page), shot(C.page)]);
    const diffPct = await A.page.evaluate(async (u1, u2) => {
      const load = (u) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = u; });
      const [i1, i2] = await Promise.all([load(u1), load(u2)]);
      const cv = document.createElement('canvas'); cv.width = i1.width; cv.height = i1.height;
      const cx = cv.getContext('2d');
      cx.drawImage(i1, 0, 0); const d1 = cx.getImageData(0, 0, cv.width, cv.height).data;
      cx.clearRect(0, 0, cv.width, cv.height);
      cx.drawImage(i2, 0, 0); const d2 = cx.getImageData(0, 0, cv.width, cv.height).data;
      let bad = 0, total = d1.length / 4;
      for (let p = 0; p < d1.length; p += 4) {
        if (Math.abs(d1[p] - d2[p]) > 16 || Math.abs(d1[p + 1] - d2[p + 1]) > 16 ||
            Math.abs(d1[p + 2] - d2[p + 2]) > 16 || Math.abs(d1[p + 3] - d2[p + 3]) > 16) bad++;
      }
      return (100 * (1 - bad / total)).toFixed(3);
    }, da, dc);
    console.log(`whole-board pixel match A vs C: ${diffPct}%`);

    await k6done;
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
