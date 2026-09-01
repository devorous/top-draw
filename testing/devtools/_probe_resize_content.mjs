import puppeteer from 'puppeteer';
const b = await puppeteer.connect({ browserURL: process.env.CDP_URL, defaultViewport: null });
const p = (await b.pages())[0];
await p.goto('http://localhost:3000/go/', { waitUntil: 'networkidle2' });
await p.waitForFunction(() => window.app && window.app.self != null, { timeout: 120000 });
const room = `rc_${Date.now()}`;
await p.evaluate((r) => { window.app.self.username = 'RC'; window.app.handleRoomSelected(r); }, room);
await p.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null, { timeout: 120000 });
await new Promise(r => setTimeout(r, 2500));

await p.evaluate(() => {
  window.__stroke = async function (layer, span) {
    app.self.activeLayer = layer;
    const [bh, bw] = app.board.dimensions;
    const el = document.getElementById('boards');
    const rect = el.getBoundingClientRect();
    const sx = rect.width / bw, sy = rect.height / bh;
    const down = document.getElementById('board');
    const ev = (t, x, y) => (t === 'pointerdown' ? down : window).dispatchEvent(new PointerEvent(t, {
      pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true, composed: true,
      clientX: rect.left + x * sx, clientY: rect.top + y * sy,
      buttons: t === 'pointerup' ? 0 : 1, button: 0, pressure: t === 'pointerup' ? 0 : 0.5 }));
    const raf = () => new Promise(r => requestAnimationFrame(r));
    const ox = 200 + layer * 120, oy = 200;
    ev('pointermove', ox, oy); ev('pointerdown', ox, oy);
    for (let i = 1; i <= 20; i++) { ev('pointermove', ox + i * (span / 20), oy + i * (span / 20)); await raf(); }
    ev('pointerup', ox + span, oy + span);
    await raf(); await raf();
  };
  // Count non-transparent pixels in a single layer's composite.
  window.__layerPx = function (i) {
    const lm = app.board.layerManager;
    const [h, w] = app.board.dimensions;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    lm.compositeLayerRange(ctx, i, i + 1, null);
    const d = ctx.getImageData(0, 0, w, h).data;
    let n = 0; for (let k = 3; k < d.length; k += 4) if (d[k] !== 0) n++;
    return n;
  };
});

await p.evaluate(() => window.app.selectTool('brush'));
await p.evaluate(() => window.__stroke(0, 300));
await p.evaluate(() => window.__stroke(1, 300));
await new Promise(r => setTimeout(r, 600));
const before = await p.evaluate(() => [0,1,2].map(i => window.__layerPx(i)));
const stateB = await p.evaluate(() => { const lm = app.board.layerManager; return lm.layerGroups.map((g,i)=>`L${i} HAS=${lm.rangeHasRenderableContent(i,i+1)}`).join(' | '); });
console.log('before resize  px per layer:', before, '\n              ', stateB);

await p.evaluate(() => { window.app.board.resizeBoard([1440, 2560]); window.app._bindLayerManagerDependencies?.(); });
await new Promise(r => setTimeout(r, 1500));
const after = await p.evaluate(() => [0,1,2].map(i => window.__layerPx(i)));
const stateA = await p.evaluate(() => { const lm = app.board.layerManager; return lm.layerGroups.map((g,i)=>`L${i} HAS=${lm.rangeHasRenderableContent(i,i+1)}`).join(' | '); });
console.log('after  resize  px per layer:', after, '\n              ', stateA);

const ok = after[0] > 0 && after[1] > 0 && after[2] === 0;
console.log(ok ? '\nPASS — layers 0 and 1 kept their pixels, layer 2 stayed structurally empty'
              : '\nFAIL — content changed unexpectedly across the resize');
await b.disconnect();
