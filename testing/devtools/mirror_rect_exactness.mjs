/**
 * Correctness gate for the mirror-scoped remote preview rects.
 *
 * `RemoteUserHandler._previewDirtyRects` decides which parts of the board a
 * remote user's live stroke can have touched, and everything downstream trusts
 * it: `_copyPreviewSource` clears and redraws only those rects, and the tile
 * grid composites only those tiles. Under-cover it and the mirrored copy of the
 * stroke is left visibly torn — a defect that appears only on a real client
 * mid-stroke, which is why `node --check` and the parity suite cannot catch it.
 *
 * The assertion: mid-stroke, the composited board must already be byte-identical
 * to what a forced FULL composite of the same state produces. Both captures
 * happen inside one synchronous block, so no network batch can land between
 * them — any difference is the scoped path having missed pixels.
 *
 *   MIRROR=global node testing/devtools/mirror_rect_exactness.mjs
 *   MIRROR=radial SLICES=8 node testing/devtools/mirror_rect_exactness.mjs
 *
 * Env:
 *   MIRROR   global | vertical | horizontal | quad | rotational | radial | fib
 *   SLICES   radial slice count                          (default 8)
 *   SAMPLES  comparisons per arm                         (default 12)
 *   ROOM     must match the peer bot                     (default perfroom)
 *
 * Two arms, and the second is the point: `base` suppresses the mirror expansion
 * so the rects cover the stroke but not its reflections. It MUST fail. A run
 * where both arms come back clean has proved nothing — either no remote stroke
 * was live, or the mirror was not armed — so this exits non-zero on that too.
 *
 * Requires: the tunnel + Chrome on `book` (CDP on 127.0.0.1:9222) and a peer
 * drawing continuously in the same room (testing/devtools/peer_bot.mjs).
 */
import puppeteer from 'puppeteer';

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const URL = 'http://localhost:3000/go/';
const ROOM = process.env.ROOM || 'perfroom';
const MIRROR = process.env.MIRROR || 'global';
const SLICES = Number(process.env.SLICES || 8);
const SAMPLES = Number(process.env.SAMPLES || 12);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
const pages = await browser.pages();
const page = pages.find(p => p.url().includes('localhost:3000')) || pages[0];

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(3000);
await page.evaluate(() => {
  const box = document.querySelector('input[placeholder*="username" i], input[placeholder*="Pick" i]');
  if (box) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(box, 'weakobs');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const btn = [...document.querySelectorAll('button')].find(b => /join & draw/i.test(b.textContent));
  if (btn) btn.click();
});
await page.waitForFunction(() => window.app?.connected && window.app.board?.viewCanvas, { timeout: 90000 });
await sleep(4000);
await page.evaluate(r => window.app.handleRoomSelected(r), ROOM);
await page.waitForFunction(r => window.app?.connected && window.app.currentRoomId === r, { timeout: 60000 }, ROOM);
await sleep(4000);

const setup = await page.evaluate((mode, slices) => {
  const a = window.app, b = a.board, h = a.remoteUserHandler;

  // The mirror flag is a room setting; any SETTINGS message resets it, so it is
  // re-armed before every sample rather than once here.
  window.__armMirror = () => {
    b.setMirror(false);
    b.setMirrorRegions([]);
    if (mode === 'global') {
      b.setMirror(true);
    } else {
      b.setMirrorRegions([{
        id: 'mr_exact_probe', x: 0, y: 0, width: 900, height: 900,
        mode, axis: mode, slices, fibDepth: 4, showLine: true, owner: a.self?.id ?? 0
      }]);
    }
    return b.getActiveMirrorRegions().length;
  };

  window.__arm = 'list';
  const origHasMirrors = b.hasMirrors.bind(b);
  const orig = h._previewDirtyRects.bind(h);
  h._previewDirtyRects = (u, l) => {
    if (window.__arm !== 'base') return orig(u, l);
    b.hasMirrors = () => false;
    try { return orig(u, l); } finally { b.hasMirrors = origHasMirrors; }
  };

  /**
   * One comparison. Everything between the two getImageData calls is
   * synchronous, so the board state cannot change underneath them.
   */
  window.__compare = () => {
    const drawing = [...a.users.values()].filter(u => u.mousedown && u.id !== a.self?.id).length;
    const canvas = b.viewCanvas, ctx = b.viewCtx;
    const w = canvas.width, h2 = canvas.height;
    // Flush whatever is already marked THROUGH THE SCOPED PATH first. Without
    // this the comparison catches the ordinary one-frame lag — content that
    // arrived since the last rAF and simply has not been composited yet — and
    // reports it as under-coverage. The assertion is "compositing the scoped
    // rects lands in the same place as compositing everything", so the scoped
    // pass has to have happened before the baseline is taken.
    b.compositeAllLayers();
    const before = ctx.getImageData(0, 0, w, h2).data;

    // The reference has to redo the PREVIEW COPY as well, not just the
    // composite. `_copyPreviewSource` writes into a layer-manager-owned canvas
    // that persists across calls, and `compositeAllLayers` reads that canvas —
    // so a full composite alone re-reads the very same stale pixels and agrees
    // with itself no matter how badly the rects under-covered. Passing an
    // explicit full-board rect drives the real production path with no scoping.
    const full = { x: 0, y: 0, width: w, height: h2 };
    for (const u of a.users.values()) {
      if (u.id !== a.self?.id && u._layeredPreviewActive) h._syncLayeredRemotePreview(u, full);
    }
    b.markCompositeFull();
    b.compositeAllLayers();
    const after = ctx.getImageData(0, 0, w, h2).data;

    let diff = 0;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let i = 0, px = 0; i < before.length; i += 4, px++) {
      if (before[i] !== after[i] || before[i + 1] !== after[i + 1]
        || before[i + 2] !== after[i + 2] || before[i + 3] !== after[i + 3]) {
        diff++;
        const x = px % w, y = (px / w) | 0;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    return {
      drawing,
      mirrors: b.getActiveMirrorRegions().length,
      diffPixels: diff,
      diffPct: +(100 * diff / (w * h2)).toFixed(4),
      bbox: maxX >= 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null
    };
  };

  return { dims: b.dimensions.slice(), users: a.users.size };
}, MIRROR, SLICES);
console.log('SETUP', JSON.stringify(setup), 'mirror=' + MIRROR);

const runArm = async (arm) => {
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    await page.evaluate(a => { window.__arm = a; window.__armMirror(); }, arm);
    await sleep(220);
    samples.push(await page.evaluate(() => window.__compare()));
  }
  const live = samples.filter(s => s.drawing > 0 && s.mirrors > 0);
  const bad = live.filter(s => s.diffPixels > 0);
  const worst = live.reduce((m, s) => (s.diffPixels > (m?.diffPixels ?? -1) ? s : m), null);
  return { arm, samples: samples.length, live: live.length, mismatched: bad.length, worst };
};

const list = await runArm('list');
const base = await runArm('base');

for (const r of [list, base]) {
  console.log(`${r.arm.padEnd(5)}  usable ${r.live}/${r.samples}  mismatched ${r.mismatched}`
    + `  worst ${r.worst ? r.worst.diffPixels + 'px (' + r.worst.diffPct + '%)' : 'n/a'}`
    + `  bbox ${r.worst?.bbox ? JSON.stringify(r.worst.bbox) : 'n/a'}`);
}

let exit = 0;
if (list.live < 3 || base.live < 3) {
  console.error('\nINCONCLUSIVE: too few samples with a live remote stroke AND an armed mirror.');
  console.error('Start testing/devtools/peer_bot.mjs in the same room and re-run.');
  exit = 2;
} else if (base.mismatched === 0) {
  // Without this the suite is a rubber stamp: it would also "pass" on a build
  // where the comparison itself is broken.
  console.error('\nINCONCLUSIVE: the `base` control did not tear, so this run cannot');
  console.error('detect under-coverage at all. Check that the mirror is actually painting.');
  exit = 2;
} else if (list.mismatched > 0) {
  console.error(`\nFAIL: the shipped rect list under-covers — ${list.mismatched} of ${list.live} samples`);
  console.error('differ from a full composite. That is a torn mirrored stroke on a real client.');
  exit = 1;
} else {
  console.log('\nPASS: scoped mirror rects match a full composite exactly'
    + ` (control tore in ${base.mismatched}/${base.live} samples).`);
}
await browser.disconnect();
process.exit(exit);
