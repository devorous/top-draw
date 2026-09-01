import puppeteer from 'puppeteer';
const b = await puppeteer.connect({ browserURL: process.env.CDP_URL, defaultViewport: null });
const p = (await b.pages())[0];
await p.goto('http://localhost:3000/go/', { waitUntil: 'networkidle2' });
await p.waitForFunction(() => window.app && window.app.self != null, { timeout: 120000 });
const room = `pr_${Date.now()}`;
await p.evaluate((r) => { window.app.self.username = 'PR'; window.app.handleRoomSelected(r); }, room);
await p.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null, { timeout: 120000 });
await new Promise(r => setTimeout(r, 2500));
const snap = (t) => p.evaluate((tag) => {
  const lm = window.app.board.layerManager;
  return tag + '  dims=' + JSON.stringify(window.app.board.dimensions) + '\n' + lm.layerGroups.map((g, i) =>
    `  L${i} flat=${!!g.flatCanvas} baked=${g.bakedSequences.length} stack=${g.strokeStack.length} HAS=${lm.rangeHasRenderableContent(i, i + 1)}`
  ).join('\n');
}, t);
console.log(await snap('--- before resize ---'));
await p.evaluate(() => { window.app.board.resizeBoard([1440, 2560]); window.app._bindLayerManagerDependencies?.(); });
await new Promise(r => setTimeout(r, 1200));
console.log(await snap('--- after resizeBoard([1440,2560]) ---'));
await b.disconnect();
