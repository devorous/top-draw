/**
 * Full-vs-partial composite A/B on the weak client (Celeron N4500).
 *
 * Question: does CompositeTileGrid's partial compositing actually buy anything?
 * On the fast dev box every arm pinned to the 178Hz vsync ceiling, so the
 * instrument could not resolve a difference. This box has no such headroom.
 *
 * Traps honored (see chromebook_weak_client_rig memory):
 *  - screen wake lock from inside the page; ABORT on zero frames
 *  - interleaved paired A/B in ONE page session (this box drifts downward)
 *  - first run is JIT/GPU-cold: reported as `cold`, never silently discarded
 *  - board size comes from the SERVER; assert what we actually got
 *  - reload first so prior instrumentation cannot persist
 */
import puppeteer from 'puppeteer';

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const URL = 'http://localhost:3000/go/';
const FRAMES = Number(process.env.FRAMES || 180);
const REPEATS = Number(process.env.REPEATS || 4);

const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
const pages = await browser.pages();
let page = pages.find(p => p.url().includes('localhost:3000')) || pages[0];

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(3000);

// --- join as guest ---
await page.evaluate(async () => {
  const box = document.querySelector('input[placeholder*="username" i], input[placeholder*="Pick" i]');
  if (box) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(box, 'weakprobe');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const btn = [...document.querySelectorAll('button')].find(b => /join & draw/i.test(b.textContent));
  if (btn) btn.click();
});

await page.waitForFunction(() => window.app && window.app.connected && window.app.board?.mainCanvas, { timeout: 90000 });
await sleep(4000);

const env = await page.evaluate(async () => {
  let wake = 'unavailable';
  try { await navigator.wakeLock.request('screen'); wake = 'held'; } catch (e) { wake = 'failed: ' + e.name; }
  let renderer = 'unknown';
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  } catch (_) {}
  const b = window.app.board;
  return {
    wake, renderer,
    cores: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    dims: b.dimensions.slice(),
    grid: !!b.compositeTileGrid,
    liveStrokes: b.layerManager.layerGroups.reduce((s, g) => s + (g.strokeStack?.length || 0), 0),
    lowPowerDetected: window.__performanceDetection || null,
  };
});
console.log('ENV', JSON.stringify(env, null, 2));
if (!env.grid) { console.error('no compositeTileGrid'); await browser.disconnect(); process.exit(1); }

// --- the A/B ---
await page.evaluate(() => {
  window.__ab = (mode, frames) => new Promise(resolve => {
    const b = window.app.board, g = b.compositeTileGrid, lm = b.layerManager;
    const iv = []; let last = performance.now(), n = 0;
    const step = () => {
      const now = performance.now(); iv.push(now - last); last = now;
      if (mode === 'full') g.markFull();
      else { g.clear(); g.markRect(100, 100, 200, 200); }
      lm.needsComposite = true;
      b.compositeAllLayers();
      if (++n < frames) requestAnimationFrame(step);
      else {
        iv.shift();
        // A frame is "dropped" when the interval spans more than 1.5 vsync
        // periods. Median is useless here — it pins to the refresh ceiling on
        // any machine that is keeping up at all. The tail is the signal.
        const dropped = iv.filter(v => v > 25).length;
        const total = iv.reduce((s, v) => s + v, 0);
        iv.sort((a, z) => a - z);
        const q = p => +iv[Math.min(iv.length - 1, Math.floor(iv.length * p))].toFixed(2);
        resolve({ frames: iv.length, median: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1),
                  droppedPct: +(100 * dropped / iv.length).toFixed(1),
                  effectiveFps: +(1000 * iv.length / total).toFixed(1) });
      }
    };
    requestAnimationFrame(step);
  });
});

// Put real content on the board: composite cost is linear in the LIVE stroke
// stack, and an empty board understates it. Strokes are drawn locally so this
// needs no second client.
if (process.env.STROKES !== '0') {
  await page.evaluate(async (target) => {
    const b = window.app.board, canvas = b.mainCanvas;
    const r = canvas.getBoundingClientRect();
    const nap = ms => new Promise(res => setTimeout(res, ms));
    const ev = (t, x, y, tg) => tg.dispatchEvent(new PointerEvent(t, {
      pointerId: 1, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
      clientX: x, clientY: y, pressure: 0.5, buttons: t === 'pointerup' ? 0 : 1 }));
    for (let s = 0; s < target; s++) {
      const x0 = r.left + 30 + (s % 6) * (r.width / 7);
      const y0 = r.top + 30 + Math.floor(s / 6) * (r.height / 5);
      ev('pointerdown', x0, y0, canvas);
      for (let i = 1; i <= 8; i++) {
        ev('pointermove', x0 + i * 5, y0 + Math.sin(i / 2) * 10, window);
        if (i % 4 === 0) await nap(16);
      }
      ev('pointerup', x0 + 40, y0, window);
      await nap(40);
    }
    await nap(800);
  }, Number(process.env.STROKES || 18));
}

const runs = [];
for (let i = 0; i < REPEATS; i++) {
  const partial = await page.evaluate(f => window.__ab('partial', f), FRAMES);
  const full    = await page.evaluate(f => window.__ab('full', f), FRAMES);
  const dims    = await page.evaluate(() => window.app.board.dimensions.slice());
  const live    = await page.evaluate(() => window.app.board.layerManager.layerGroups.reduce((s,g)=>s+(g.strokeStack?.length||0),0));
  if (partial.frames === 0 || full.frames === 0) {
    console.error('ABORT: zero frames — display likely blanked (PowerDevil).');
    await browser.disconnect(); process.exit(2);
  }
  runs.push({ run: i, label: i === 0 ? 'cold' : 'steady', dims, liveStrokes: live, partial, full });
  console.log(`run ${i} (${i === 0 ? 'cold' : 'steady'}) dims=${dims} live=${live}\n` +
    `   partial  drop ${partial.droppedPct}%  p95 ${partial.p95}  p99 ${partial.p99}  effFps ${partial.effectiveFps}\n` +
    `   full     drop ${full.droppedPct}%  p95 ${full.p95}  p99 ${full.p99}  effFps ${full.effectiveFps}`);
}

const steady = runs.filter(r => r.label === 'steady');
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
console.log('\nSUMMARY');
console.log(JSON.stringify({
  env,
  runs,
  steadyMedian: steady.length ? {
    liveStrokes: med(steady.map(r => r.liveStrokes)),
    partial: { droppedPct: med(steady.map(r => r.partial.droppedPct)), p95: med(steady.map(r => r.partial.p95)),
               p99: med(steady.map(r => r.partial.p99)), effFps: med(steady.map(r => r.partial.effectiveFps)) },
    full:    { droppedPct: med(steady.map(r => r.full.droppedPct)), p95: med(steady.map(r => r.full.p95)),
               p99: med(steady.map(r => r.full.p99)), effFps: med(steady.map(r => r.full.effectiveFps)) },
  } : null
}, null, 2));

await browser.disconnect();
