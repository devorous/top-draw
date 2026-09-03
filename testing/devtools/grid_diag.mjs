/** Who is calling markFull on the weak client while a remote user draws? */
import puppeteer from 'puppeteer';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.connect({ browserURL: process.env.CDP_URL || 'http://127.0.0.1:9222', defaultViewport: null });
const pages = await browser.pages();
const page = pages.find(p => p.url().includes('localhost:3000')) || pages[0];

const out = await page.evaluate(async () => {
  const a = window.app, b = a.board, g = b.compositeTileGrid, h = a.remoteUserHandler;
  const callers = {};
  const rectSamples = [];
  const origMarkFull = g.markFull.bind(g);
  g.markFull = function () {
    const st = new Error().stack.split('\n').slice(2, 6)
      .map(s => s.trim().replace(/^at\s+/, '').split(' ')[0]).join(' < ');
    callers[st] = (callers[st] || 0) + 1;
    return origMarkFull();
  };
  // What does the rect resolver actually return during a remote stroke?
  const orig = h._activeStrokeDirtyRect.bind(h);
  h._activeStrokeDirtyRect = (u, l) => {
    const r = orig(u, l);
    if (rectSamples.length < 25) {
      const grp = b.layerManager.layerGroups[l];
      rectSamples.push({
        layer: l, tool: u?.tool, uid: u?.id,
        hasGroup: !!grp,
        hasActive: !!grp?.activeStrokeByUser?.get(u?.id),
        hasPreview: !!grp?.activePreviewByUser?.get(u?.id),
        activeLayer: u?.activeLayer, strokeLayer: u?._strokeLayer,
        rect: r
      });
    }
    return r;
  };
  await new Promise(res => setTimeout(res, 9000));
  return { callers, rectSamples, users: a.users.size };
});
console.log(JSON.stringify(out, null, 2));
await browser.disconnect();
