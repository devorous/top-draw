/** Why does RemoteUserHandler._activeStrokeDirtyRect return null for a remote stroke? */
import puppeteer from 'puppeteer';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.connect({ browserURL: process.env.CDP_URL || 'http://127.0.0.1:9222', defaultViewport: null });
const pages = await browser.pages();
const page = pages.find(p => p.url().includes('localhost:3000')) || pages[0];

const out = await page.evaluate(async (secs) => {
  const a = window.app, b = a.board, h = a.remoteUserHandler, lm = b.layerManager;
  const samples = [];
  const orig = h._activeStrokeDirtyRect.bind(h);
  h._activeStrokeDirtyRect = (u, l) => {
    const r = orig(u, l);
    if (samples.length < 20) {
      const active = lm?.getActiveStroke?.(l, u?.id);
      samples.push({
        layer: l, tool: u?.tool, uid: u?.id, rect: r,
        mirror: !!b.mirror, mirrorRegions: b.mirrorRegions?.length || 0,
        ink: u?._inkDirtyBounds ? { ...u._inkDirtyBounds } : null,
        hasActive: !!active,
        activeKeys: active ? Object.keys(active).slice(0, 25) : null,
        dirtyRect: active?.dirtyRect ? { ...active.dirtyRect } : active?.dirtyRect,
      });
    }
    return r;
  };
  await new Promise(res => setTimeout(res, secs * 1000));
  h._activeStrokeDirtyRect = orig;
  return { room: a.currentRoomId, users: a.users.size, samples };
}, Number(process.env.SECONDS || 8));
console.log(JSON.stringify(out, null, 2));
await browser.disconnect();
