#!/usr/bin/env node
/**
 * @fileoverview Does a .ddraw replay reproduce content on layers 1 and 2?
 *
 * Standalone and fast: one browser, one tape, no k6, no observers. Written after
 * the k6 observer suite showed a live board with content on all three layer
 * groups replaying into a board with content on only ONE — and with zero stroke
 * records anywhere, meaning the replay was showing a checkpoint image rather
 * than anything it had replayed.
 *
 * Reports, per group, what the replay actually built (strokeStack /
 * bakedSequences / flatCanvas), alongside the tape's own MD-by-layer histogram
 * so "the recording didn't carry the layer" is ruled out in the same run. It
 * also polls TimeMachine's seek state, because `loadFromRecording` paints a
 * fast-path preview and finishes the full-resolution seek in the background —
 * so a capture can legitimately race a rebuild that never landed.
 *
 *   node testing/devtools/_replay_layer_probe.mjs <file.ddraw>
 *   node testing/devtools/_replay_layer_probe.mjs            (newest tape found)
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const CODEC_URL = '/src/replay/ddrawCodec.js';
const HEADLESS = process.env.HEADLESS !== 'false';

function newestTape() {
  const base = path.join(ROOT, 'testing', 'sync_results');
  const hits = [];
  for (const d of fs.readdirSync(base)) {
    const tdir = path.join(base, d, 'tapes');
    if (!fs.existsSync(tdir)) continue;
    for (const f of fs.readdirSync(tdir)) {
      if (f.endsWith('.ddraw')) {
        const p = path.join(tdir, f);
        hits.push({ p, m: fs.statSync(p).mtimeMs });
      }
    }
  }
  hits.sort((a, b) => b.m - a.m);
  return hits[0]?.p ?? null;
}

const file = process.argv[2] || newestTape();
if (!file || !fs.existsSync(file)) {
  console.error('No .ddraw found. Pass one explicitly.');
  process.exit(2);
}

const main = async () => {
  console.log(`\nReplay layer probe\nTape: ${path.relative(ROOT, file)}\n`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 760 },
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => process.stderr.write(`  [ERR] ${e.message}\n`));
    page.on('console', (m) => {
      const t = m.text();
      if (/replay|seek|checkpoint|layer/i.test(t)) process.stdout.write(`  [console] ${t.slice(0, 160)}\n`);
    });
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });
    await page.evaluate(() => window.app.landingPage?.hide?.());

    const b64 = fs.readFileSync(file).toString('base64');
    const info = await page.evaluate(async (data, url) => {
      const bin = atob(data);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const { decodeDdraw } = await import(url);
      const rec = await decodeDdraw(buf);
      // Tape-side truth: does the recording even carry per-layer MDs?
      const mdByLayer = {}, clByLayer = {};
      for (const d of rec.deltas || []) {
        const m = d.msg || {};
        if (m.t === 11) { const k = String(m.ly ?? 'absent'); mdByLayer[k] = (mdByLayer[k] || 0) + 1; }
        if (m.t === 58) { const k = String(m.ly ?? 'absent'); clByLayer[k] = (clByLayer[k] || 0) + 1; }
      }
      window.__rec = rec;
      await window.app.TimeMachine.loadFromRecording(rec);
      return {
        deltas: (rec.deltas || []).length,
        mdByLayer, clByLayer,
        hasOpening: !!rec.openingSnapshot,
        intra: (rec.intraCheckpoints || []).length,
        visual: (rec.visualCheckpoints || []).length,
      };
    }, b64, CODEC_URL);

    console.log(`  tape: ${info.deltas} deltas | opening=${info.hasOpening}`
      + ` intraCheckpoints=${info.intra} visualCheckpoints=${info.visual}`);
    console.log(`  tape MD by layer: ${JSON.stringify(info.mdByLayer)}`);
    console.log(`  tape CL by layer: ${JSON.stringify(info.clByLayer)}\n`);

    // Watch the seek settle rather than assuming it has.
    for (let i = 0; i < 40; i++) {
      const st = await page.evaluate(() => {
        const tm = window.app?.TimeMachine;
        const lm = tm?.getReplayLayerManager?.();
        return {
          isOpen: !!tm?.isOpen,
          lastApplied: tm?._lastAppliedTimestamp ?? null,
          sessionEnd: tm?.sessionEnd ?? null,
          seeking: !!tm?._isSeeking,
          groups: (lm?.layerGroups || []).map((g) => ({
            flat: !!g.flatCanvas,
            recs: (g.flatStrokeRecords || []).length,
            baked: (g.bakedSequences || []).length,
            stack: (g.strokeStack || []).length,
            visible: g.visible !== false,
          })),
        };
      });
      const atEnd = st.lastApplied === st.sessionEnd;
      if (i === 0 || i === 39 || (atEnd && !st.seeking)) {
        console.log(`  t+${i}: atEnd=${atEnd} seeking=${st.seeking}`
          + ` lastApplied=${st.lastApplied} sessionEnd=${st.sessionEnd}`);
        st.groups.forEach((g, gi) => console.log(
          `     g${gi}: flat=${g.flat} recs=${g.recs} baked=${g.baked} stack=${g.stack} visible=${g.visible}`));
        if (atEnd && !st.seeking && i > 0) break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    await browser.close().catch(() => {});
  }
};

main().catch((e) => { console.error('Uncaught:', e); process.exit(2); });
