/**
 * Drive the Chromebook's Chrome from this PC over the CDP tunnel.
 *
 * Connects to 127.0.0.1:9222 (an `ssh -L` forward of the Chromebook's DevTools
 * port) and loads the app from http://localhost:3000 -- which on that machine is
 * an `ssh -R` forward back to this PC's vite. localhost keeps it a secure
 * context, so the service worker and WebCodecs paths behave as in production.
 *
 * Usage: node testing/devtools/drive_book.mjs [screenshot.png]
 *
 * Note the app-ready wait is generous: on the N4500 the auth system can take
 * well over 60s to fall back to guest mode, and window.app only appears after.
 */
import puppeteer from 'puppeteer';

const CDP = 'http://127.0.0.1:9222';
const URL = process.env.APP_URL || 'http://localhost:3000/go/';
const ROOM = process.env.ROOM || `book_${Date.now()}`;
const SHOT = process.argv[2] || 'book-shot.png';
const READY_TIMEOUT = +(process.env.READY_TIMEOUT || 180000);

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });

// Reuse an already-loaded app tab when there is one -- reloading costs another
// full auth-fallback wait on this machine.
let page = (await browser.pages()).find((p) => p.url().startsWith(URL));
if (page) {
  console.log('reusing open tab');
} else {
  page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
}

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 200)));

const t0 = Date.now();
await page.waitForFunction(
  () => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
  { timeout: READY_TIMEOUT, polling: 1000 }
);
console.log(`app ready in ${Date.now() - t0} ms`);

await page.evaluate((r) => {
  window.app.self.username = 'BOOK';
  window.app.handleRoomSelected(r);
}, ROOM);
console.log('joined room', ROOM);

await page.waitForFunction(() => window.app?.board?.width > 0, { timeout: 60000, polling: 500 });

// Draw a few strokes through real input events so the whole pipeline runs:
// pointer -> InputBufferManager -> tick -> commit -> composite -> broadcast.
const box = await page.evaluate(() => {
  const c = window.app.board.canvas.getBoundingClientRect();
  return { x: c.x, y: c.y, w: c.width, h: c.height };
});
for (let s = 0; s < 3; s++) {
  const y = box.y + box.h * (0.35 + s * 0.12);
  await page.mouse.move(box.x + box.w * 0.2, y);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) {
    const t = i / 24;
    await page.mouse.move(
      box.x + box.w * (0.2 + 0.6 * t),
      y + Math.sin(t * Math.PI * 2) * box.h * 0.06
    );
  }
  await page.mouse.up();
}
console.log('drew 3 strokes');

await new Promise((r) => setTimeout(r, 2500));

const info = await page.evaluate(() => ({
  room: window.app?.roomName ?? null,
  session: window.app?.sessionIndex ?? null,
  board: [window.app?.board?.width, window.app?.board?.height],
  strokes: window.app?.board?.strokeStack?.length ?? null,
  heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
  cores: navigator.hardwareConcurrency,
  renderer: (() => {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      return gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
    } catch { return 'n/a'; }
  })(),
}));
console.log(JSON.stringify(info, null, 2));
console.log('console errors:', errors.length ? errors : 'none');

await page.screenshot({ path: SHOT });
console.log('screenshot ->', SHOT);
await browser.disconnect();
