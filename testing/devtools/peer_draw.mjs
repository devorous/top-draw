/**
 * Continuous peer drawer, run on THIS PC (the fast box) so the weak client has
 * a remote user to watch. Pair with grid_remote_ab.mjs / grid_caller_diag.mjs,
 * which measure on the Chromebook over the CDP tunnel.
 *
 *   TOOL=eraser SECONDS=90 node testing/devtools/peer_draw.mjs
 *
 * Env:
 *   TOOL      tool id passed to app.selectTool()   (default 'brush')
 *   SECONDS   how long to keep drawing, 0 = forever (default 60)
 *   NAME      username                             (default 'peerdrawer')
 *   HEADLESS  '1' to run headless                  (default headful)
 *
 * Draws with synthetic PointerEvents from inside the page rather than
 * page.mouse, so the stroke rate does not depend on CDP round-trips.
 */
import puppeteer from 'puppeteer';

const URL = process.env.APP_URL || 'http://localhost:3000/go/';
const TOOL = process.env.TOOL || 'brush';
const SECONDS = Number(process.env.SECONDS ?? 60);
const NAME = process.env.NAME || 'peerdrawer';
const ROOM = process.env.ROOM || 'perfroom';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: process.env.HEADLESS === '1',
  defaultViewport: null,
  args: ['--window-size=1100,850', '--window-position=40,40'],
});
const page = (await browser.pages())[0];
page.on('pageerror', e => console.error('PEER PAGEERROR', String(e).slice(0, 160)));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(2500);
await page.evaluate((name) => {
  const box = document.querySelector('input[placeholder*="username" i], input[placeholder*="Pick" i]');
  if (box) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(box, name);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const btn = [...document.querySelectorAll('button')].find(b => /join & draw/i.test(b.textContent));
  if (btn) btn.click();
}, NAME);
await page.waitForFunction(() => window.app?.connected && window.app.board?.mainCanvas, { timeout: 90000 });
await sleep(2500);

// `/go/` does NOT put two clients in the same room — it picks one for you, and
// two clients silently land in different rooms while both look healthy. Always
// join an explicit room on both sides.
await page.evaluate(r => window.app.handleRoomSelected(r), ROOM);
await page.waitForFunction(r => window.app?.connected && window.app.currentRoomId === r,
  { timeout: 60000 }, ROOM);
await sleep(2500);

const info = await page.evaluate((tool) => {
  window.app.selectTool(tool);
  return { room: window.app.currentRoomId, users: window.app.users.size, tool: window.app.self.tool };
}, TOOL);
console.log('PEER READY', JSON.stringify(info));

// Continuous serpentine strokes across the board until told to stop.
await page.evaluate((secs) => {
  const b = window.app.board, canvas = b.mainCanvas;
  const nap = ms => new Promise(res => setTimeout(res, ms));
  const ev = (t, x, y, tg) => tg.dispatchEvent(new PointerEvent(t, {
    pointerId: 1, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
    clientX: x, clientY: y, pressure: 0.5, buttons: t === 'pointerup' ? 0 : 1,
  }));
  window.__peerStop = false;
  window.__peerStrokes = 0;
  (async () => {
    const deadline = secs > 0 ? performance.now() + secs * 1000 : Infinity;
    let s = 0;
    while (!window.__peerStop && performance.now() < deadline) {
      const r = canvas.getBoundingClientRect();
      const x0 = r.left + 40 + (s % 5) * (r.width - 90) / 5;
      const y0 = r.top + 40 + (Math.floor(s / 5) % 4) * (r.height - 90) / 4;
      ev('pointerdown', x0, y0, canvas);
      for (let i = 1; i <= 30; i++) {
        ev('pointermove', x0 + i * 6, y0 + Math.sin(i / 3) * 26, window);
        await nap(16);
      }
      ev('pointerup', x0 + 180, y0, window);
      window.__peerStrokes++;
      s++;
      await nap(120);
    }
  })();
}, SECONDS);

if (SECONDS > 0) {
  await sleep(SECONDS * 1000 + 3000);
  const n = await page.evaluate(() => window.__peerStrokes);
  console.log('PEER DONE strokes=' + n);
  await browser.close();
} else {
  console.log('PEER drawing forever — kill this process to stop.');
  await new Promise(() => {});
}
