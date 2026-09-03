/**
 * Does GPU memory actually bind on the weak client?
 *
 * Stage 3b.2 (windowing per-user stroke canvases to stroke bounds) only pays if
 * total canvas backing store is near this device's capacity cliff. On the dev
 * box it plainly is not — 2.8 GB of canvas still sustained 145 fps. This box has
 * ~4 GB shared with the iGPU, so the budget is far smaller.
 *
 * Method: allocate K full-board canvases and DRAW INTO each (an untouched canvas
 * may never get a GPU texture at all, which would fake a clean result), then
 * measure achieved frame interval. Sweep K. If drops climb sharply past some K,
 * memory binds here and 3b.2 pays; if flat, it does not and the pool redesign
 * is not the right next spend.
 *
 * Ramps up and back DOWN to separate a genuine capacity effect from monotonic
 * session drift, which this box is known to have.
 */
import puppeteer from 'puppeteer';

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const SECS = Number(process.env.SECS || 5);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
const pages = await browser.pages();
const page = pages.find(p => p.url().includes('localhost:3000')) || pages[0];

const census = await page.evaluate(() => {
  const a = window.app, b = a.board, lm = b.layerManager;
  const seen = new Set(); const buckets = {};
  const add = (label, c) => {
    if (!c || !c.width || !c.height || seen.has(c)) return;
    seen.add(c);
    buckets[label] = buckets[label] || { n: 0, mb: 0 };
    buckets[label].n++; buckets[label].mb += (c.width * c.height * 4) / 1048576;
  };
  add('main', b.mainCanvas); add('top', b.topCanvas);
  add('upperLayers', b.upperLayersCanvas);
  add('mirrorRegions', b.mirrorRegionsLayer); add('mirrorGuides', b.mirrorGuidesLayer);
  add('selectionOverlay', b.selectionOverlay); add('interactionBlock', b.interactionBlockOverlay);
  for (const g of lm.layerGroups || []) {
    add('layers.flat', g.flatCanvas);
    for (const s of g.strokeStack || []) add('layers.strokeStack', s.canvas);
    for (const s of g.activeStrokeByUser?.values?.() || []) add('layers.activeStroke', s?.canvas);
    for (const p of g.activePreviewByUser?.values?.() || []) add('layers.activePreview', p?.canvas);
    for (const bs of g.bakedSequences || []) add('layers.baked', bs?.canvas);
  }
  for (const c of lm._canvasPool || []) add('canvasPool', c?.canvas || c);
  a.users?.forEach(u => { add('user.inkOffscreen', u._inkOffscreen); add('user.penOffscreen', u._penOffscreen); add('user.board', u.board); });
  document.querySelectorAll('canvas').forEach(c => add('dom.other', c));
  let totalMb = 0, totalN = 0;
  for (const k of Object.keys(buckets)) { totalMb += buckets[k].mb; totalN += buckets[k].n; buckets[k].mb = +buckets[k].mb.toFixed(1); }
  return { buckets, totalMb: +totalMb.toFixed(1), totalN, dims: b.dimensions.slice(), users: a.users.size };
});
console.log('CENSUS', JSON.stringify(census, null, 2));

await page.evaluate(() => {
  window.__hog = [];
  window.__setHog = (k) => {
    const b = window.app.board;
    const [h, w] = b.dimensions;
    while (window.__hog.length > k) { const c = window.__hog.pop(); c.width = 1; c.height = 1; }
    while (window.__hog.length < k) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      // Draw so the canvas actually becomes a GPU-resident texture. An
      // allocated-but-untouched canvas may never be uploaded at all.
      ctx.fillStyle = 'rgba(0,128,255,0.5)'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255,0,0,0.5)'; ctx.fillRect(10, 10, w - 20, 40);
      window.__hog.push(c);
    }
    return window.__hog.length;
  };
  window.__frames = (secs) => new Promise(res => {
    const b = window.app.board, lm = b.layerManager, g = b.compositeTileGrid;
    const iv = []; let last = performance.now(); const t0 = last;
    const step = () => {
      const now = performance.now(); iv.push(now - last); last = now;
      // Keep the real composite path busy, scoped like normal drawing.
      g.clear(); g.markRect(100, 100, 300, 300); lm.needsComposite = true; b.compositeAllLayers();
      // Touch the hogged canvases so they stay resident rather than being evicted as cold.
      for (const c of window.__hog) { const cx = c.getContext('2d'); cx.fillRect(0, 0, 2, 2); }
      if (now - t0 < secs * 1000) requestAnimationFrame(step);
      else {
        iv.shift();
        const dropped = iv.filter(v => v > 25).length;
        const total = iv.reduce((s, v) => s + v, 0);
        const sorted = [...iv].sort((x, y) => x - y);
        res({ frames: iv.length, droppedPct: +(100 * dropped / iv.length).toFixed(1),
              p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
              effFps: +(1000 * iv.length / total).toFixed(1) });
      }
    };
    requestAnimationFrame(step);
  });
});

const perCanvasMb = (census.dims[0] * census.dims[1] * 4) / 1048576;
const ladder = [0, 32, 64, 96, 128, 160, 64, 0];
const out = [];
for (const k of ladder) {
  await page.evaluate(n => window.__setHog(n), k);
  await sleep(1200);
  const r = await page.evaluate(s => window.__frames(s), SECS);
  const addedMb = +(k * perCanvasMb).toFixed(0);
  out.push({ k, addedMb, totalMb: +(census.totalMb + addedMb).toFixed(0), ...r });
  console.log(`k=${String(k).padStart(2)}  +${String(addedMb).padStart(4)}MB  total~${String(census.totalMb + addedMb).padStart(4)}MB   drop ${r.droppedPct}%  p95 ${r.p95}  effFps ${r.effFps}`);
  if (r.frames === 0) { console.error('ABORT: zero frames'); process.exit(2); }
}
await page.evaluate(() => window.__setHog(0));
console.log('\nJSON', JSON.stringify({ perCanvasMb: +perCanvasMb.toFixed(1), census: census.totalMb, ladder: out }));
await browser.disconnect();
