#!/usr/bin/env node
/**
 * @fileoverview Two users erasing at once, over the same pixels.
 *
 * This is the historical failure mode. The per-user destination-out preview
 * exists BECAUSE simultaneous erasers used to flicker, fighting over a single
 * shared flatten pass (see the comment in EraserTool.drawPreview). The new
 * background-colour preview bypasses that machinery entirely, so it has to be
 * shown not to reintroduce the bug.
 *
 * The algebra says stacked previews stay exact — erasing D at alpha a then b
 * leaves D with coefficient (1-a)(1-b) on both paths — but that argument
 * assumes the two previews land on separate surfaces that composite in the
 * ordinary way. This checks the pixels instead.
 *
 * Runs against a locally launched browser: it is a correctness test and needs
 * no weak client. Two pages join one room, both erase overlapping paths on
 * layer 0 at the same time, and the visible stack on page A is compared
 * mid-stroke against the committed result.
 *
 * Pixel buffers stay INSIDE the page and only summaries cross CDP. Returning a
 * region's ImageData directly serialises ~200k numbers per call and times out
 * `Runtime.callFunctionOn` before any assertion runs.
 *
 * Usage:
 *   node testing/devtools/eraser_simultaneous_check.mjs
 *   node testing/devtools/eraser_simultaneous_check.mjs --headed
 */

import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 60_000);
const OPACITY = Number(arg('opacity', 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HELPERS = `(() => {
  const app = window.app;
  const snaps = window.__snaps = {};

  // Flatten what the browser actually paints, in paint order. #board carries no
  // z-index while every preview surface sits at z-index 2, so main goes first,
  // then the remote users' boards and topBoard in DOM order, then the
  // upper-layer canvas that was appended last. A surface held at opacity 0 is a
  // source for the composite, not something on screen — skip it.
  const grab = (x, y, w, h) => {
    const board = app.board;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d', { willReadFrequently: true });
    const bg = board.getCompositeBackgroundColor();
    octx.fillStyle = 'rgba(' + bg[0] + ',' + bg[1] + ',' + bg[2] + ',' + (bg[3] ?? 1) + ')';
    octx.fillRect(0, 0, w, h);

    const surfaces = [board.mainCanvas];
    const holder = document.getElementById('userBoards');
    if (holder) for (const c of holder.querySelectorAll('canvas')) surfaces.push(c);
    surfaces.push(board.topCanvas, board.upperLayersCanvas);

    for (const c of surfaces) {
      if (!c || !c.width) continue;
      if (c.style && c.style.opacity === '0') continue;
      octx.drawImage(c, x, y, w, h, 0, 0, w, h);
    }
    return octx.getImageData(0, 0, w, h);
  };

  window.__snap = (name, b) => { snaps[name] = grab(b.x, b.y, b.w, b.h); return true; };

  window.__diffSnaps = (an, bn) => {
    const a = snaps[an].data, b = snaps[bn].data;
    let worst = 0, differing = 0;
    for (let i = 0; i < a.length; i += 4) {
      let d = 0;
      for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i + k] - b[i + k]));
      if (d > 2) differing++;
      if (d > worst) worst = d;
    }
    return { worst, differing, total: a.length / 4 };
  };

  // Coarse per-cell average, for comparing ACROSS pages. Two clients are never
  // expected to be bit-identical (the parity suite allows 0.5%), and this keeps
  // the transfer to a few hundred numbers instead of a few hundred thousand.
  window.__signature = (name, cell) => {
    const img = snaps[name];
    const { width: w, height: h, data } = img;
    const out = [];
    for (let cy = 0; cy < h; cy += cell) {
      for (let cx = 0; cx < w; cx += cell) {
        let r = 0, g = 0, bl = 0, n = 0;
        for (let y = cy; y < Math.min(cy + cell, h); y++) {
          for (let x = cx; x < Math.min(cx + cell, w); x++) {
            const i = (y * w + x) * 4;
            r += data[i]; g += data[i + 1]; bl += data[i + 2]; n++;
          }
        }
        out.push(Math.round(r / n), Math.round(g / n), Math.round(bl / n));
      }
    }
    return out;
  };

  // Cross-page pixel comparison. A single base64 string transfers fine where an
  // array of ~200k numbers times out CDP, so the two clients can be compared at
  // full pixel resolution and quoted against the parity suite's 99.5% bar
  // rather than on a coarse cell average.
  window.__snapB64 = (name) => {
    const d = snaps[name].data;
    let s = '';
    for (let i = 0; i < d.length; i += 4) {
      s += String.fromCharCode(d[i], d[i + 1], d[i + 2]);
    }
    return btoa(s);
  };

  window.__compareB64 = (name, b64, tol) => {
    const d = snaps[name].data;
    const bin = atob(b64);
    let differing = 0, worst = 0;
    const n = d.length / 4;
    for (let p = 0; p < n; p++) {
      let m = 0;
      for (let k = 0; k < 3; k++) {
        m = Math.max(m, Math.abs(d[p * 4 + k] - bin.charCodeAt(p * 3 + k)));
      }
      if (m > tol) differing++;
      if (m > worst) worst = m;
    }
    return { differing, total: n, worst, matchPct: +(((n - differing) / n) * 100).toFixed(3) };
  };

  const evFactory = () => {
    const [bh, bw] = app.board.dimensions;
    const el = document.getElementById('boards');
    const rect = el.getBoundingClientRect();
    const sx = rect.width / bw, sy = rect.height / bh;
    const down = document.getElementById('board');
    return (type, x, y) => {
      const e = new PointerEvent(type, {
        pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true,
        cancelable: true, composed: true,
        clientX: rect.left + x * sx, clientY: rect.top + y * sy,
        buttons: type === 'pointerup' ? 0 : 1, button: 0,
        pressure: type === 'pointerup' ? 0 : 0.5
      });
      (type === 'pointerdown' ? down : window).dispatchEvent(e);
    };
  };
  // Only one of the two pages can be foreground, and a backgrounded tab stops
  // servicing requestAnimationFrame — an unguarded \`await raf()\` there never
  // resolves and the evaluate hangs until puppeteer's protocolTimeout fires,
  // which looks like a mysterious CDP error rather than a throttled tab. The
  // launcher passes --disable-renderer-backgrounding etc; this is the backstop
  // so a stall degrades into a slow test instead of an unexplained crash.
  const raf = () => new Promise(r => {
    let done = false;
    const fire = () => { if (!done) { done = true; r(); } };
    requestAnimationFrame(fire);
    setTimeout(fire, 250);
  });

  window.__brushStroke = async function (x0, y0, x1, y1) {
    const ev = evFactory();
    ev('pointermove', x0, y0); ev('pointerdown', x0, y0);
    for (let i = 1; i <= 14; i++) { ev('pointermove', x0 + (x1-x0)*(i/14), y0 + (y1-y0)*(i/14)); await raf(); }
    ev('pointerup', x1, y1);
    await raf(); await raf();
  };

  // Split into down / move / up so two pages can be interleaved from Node and
  // genuinely overlap, rather than running one stroke after the other.
  window.__eraseBegin = function (x, y) {
    window.__ev = evFactory();
    window.__ev('pointermove', x, y);
    window.__ev('pointerdown', x, y);
  };
  window.__eraseStep = async function (x, y) { window.__ev('pointermove', x, y); await raf(); };
  window.__eraseEnd = async function (x, y) {
    window.__ev('pointerup', x, y);
    await raf(); await raf(); await raf();
  };

  // Set size/opacity the way the UI does — through the model AND the wire.
  // Assigning app.self.size directly never broadcasts, so every peer keeps
  // rendering this user's strokes at whatever size it last heard about. That
  // produces a band of the wrong width on the other client and reads as a
  // cross-client divergence that has nothing to do with the code under test.
  window.__setBrushState = function (size, opacity) {
    app.self.setSize(size);
    app.wsClient.broadcastSizeChange(size);
    app.self.opacity = opacity;
    app.wsClient.broadcastOpacityChange?.(opacity);
    return { size: app.self.size, opacity: app.self.opacity };
  };

  window.__peerBrushState = function () {
    const out = [];
    for (const [id, u] of app.users || []) {
      if (id === app.self?.id) continue;
      out.push({ id, size: u.size, opacity: u.opacity, tool: u.tool });
    }
    return out;
  };

  window.__liveStrokes = () =>
    app.board.layerManager.layerGroups.reduce((n, g) => n + g.strokeStack.length, 0);
  window.__usingBgPreview = () =>
    app.toolManager.getTool('erase')._canUseBackgroundPreview(app.self);
  return true;
})()`;

const BOX = { x: 150, y: 260, w: 420, h: 120 };
const CELL = 16;

(async () => {
  const browser = await puppeteer.launch({
    headless: !flag('headed'),
    // Both pages have to keep animating even though only one can be foreground.
    // Without these the backgrounded tab stops servicing rAF and its stroke
    // never advances, so the two erases are not actually simultaneous.
    args: [
      '--window-size=1400,900', '--ignore-certificate-errors',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion'
    ],
    defaultViewport: null,
    protocolTimeout: 180_000
  });
  let failures = 0;
  const check = (name, ok, detail) => {
    console.log(`  ${ok ? '\x1b[32m✅ PASS\x1b[0m' : '\x1b[31m❌ FAIL\x1b[0m'}  ${name}${detail ? `  ${detail}` : ''}`);
    if (!ok) failures++;
  };

  try {
    const room = `simul_${Date.now()}`;
    const pages = [];
    for (const name of ['A', 'B']) {
      const p = pages.length ? await browser.newPage() : (await browser.pages())[0];
      await p.goto(TARGET_URL, { waitUntil: 'networkidle2' });
      await p.waitForFunction(() => window.app && window.app.self != null, { timeout: READY_TIMEOUT });
      await p.evaluate(HELPERS);
      await p.evaluate((r, n) => { window.app.self.username = n; window.app.handleRoomSelected(r); }, room, name);
      await p.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
        { timeout: READY_TIMEOUT });
      pages.push(p);
    }
    const [A, B] = pages;
    console.log(`\n=== simultaneous erasers   room ${room}, opacity ${OPACITY}\n`);

    // PRECONDITION, not an assertion. A socket being open is not the same as
    // being in the room with the other client: until each side has the other in
    // its user list there is no second eraser to be simultaneous with, and the
    // whole run would pass vacuously while measuring one user. Wait for the
    // real condition on BOTH pages and abort loudly if it never arrives.
    try {
      await Promise.all(pages.map((p) =>
        p.waitForFunction(() => (window.app.users?.size ?? 0) >= 1, { timeout: 30_000 })));
    } catch {
      const seen = await Promise.all(pages.map((p) => p.evaluate(() => window.app.users?.size ?? 0)));
      throw new Error(`clients never saw each other in room ${room} (peers seen: A=${seen[0]}, B=${seen[1]}) `
        + '— every check below would be measuring a single user');
    }
    const peers = await Promise.all(pages.map((p) => p.evaluate(() => window.app.users?.size ?? 0)));
    console.log(`  both clients joined — A sees ${peers[0]} peer(s), B sees ${peers[1]}\n`);

    // Content to erase, painted by A and awaited on B so both agree first.
    await A.evaluate(() => { window.app.selectTool('brush'); window.__setBrushState(70, 1); });
    await A.evaluate(() => window.__brushStroke(140, 320, 600, 320));
    await Promise.all(pages.map((p) =>
      p.waitForFunction(() => window.__liveStrokes() > 0, { timeout: 20_000 })));

    for (const p of pages) {
      await p.evaluate((o) => { window.app.selectTool('erase'); window.__setBrushState(30, o); }, OPACITY);
      // --forcedestout reproduces the behaviour from before the background
      // preview existed, so any failure here can be attributed to that change
      // or exonerated rather than guessed at.
      if (flag('forcedestout')) {
        await p.evaluate(() => {
          const EP = Object.getPrototypeOf(window.app.toolManager.getTool('erase'));
          EP._canUseBackgroundPreview = () => false;
        });
      }
    }
    await sleep(400);
    if (flag('forcedestout')) console.log('  (background preview FORCED OFF — old destination-out path)\n');

    check('A is on the background-preview path', await A.evaluate(() => window.__usingBgPreview()) === true);

    // Overlapping horizontal paths, started together and stepped in lockstep so
    // both strokes really are in flight at the same moment.
    // --solo: only A erases, so any A/B difference is generic remote-stroke
    // reconstruction rather than anything to do with two erases overlapping.
    const SOLO = flag('solo');
    if (SOLO) console.log('  (SOLO — only A erases)\n');
    await Promise.all([
      A.evaluate(() => window.__eraseBegin(180, 300)),
      ...(SOLO ? [] : [B.evaluate(() => window.__eraseBegin(180, 340))])
    ]);
    let LAST_X = 180;
    for (let i = 1; i <= 18; i++) {
      LAST_X = 180 + i * 20;
      await Promise.all([
        A.evaluate((v) => window.__eraseStep(v, 300), LAST_X),
        ...(SOLO ? [] : [B.evaluate((v) => window.__eraseStep(v, 340), LAST_X)])
      ]);
    }
    await sleep(300);

    const live = await A.evaluate(() => {
      const lm = window.app.board.layerManager;
      let previews = 0, actives = 0;
      for (const g of lm.layerGroups) {
        previews += g.activePreviewByUser?.size ?? 0;
        actives += g.activeStrokeByUser?.size ?? 0;
      }
      return { previews, actives };
    });
    check(SOLO ? 'A sees one erase in flight' : 'A sees two erases in flight', live.actives >= (SOLO ? 1 : 2),
      `${live.actives} active stroke(s), ${live.previews} published preview(s)`);

    await A.evaluate((b) => window.__snap('mid', b), BOX);

    // Sample repeatedly across frames: a flicker is a frame that disagrees with
    // its neighbours, which a single sample cannot see.
    let unstable = 0;
    let worstFlicker = 0;
    for (let i = 0; i < 5; i++) {
      await A.evaluate((n, b) => window.__snap(n, b), `f${i}`, BOX);
      if (i > 0) {
        const d = await A.evaluate((x, y) => window.__diffSnaps(x, y), `f${i - 1}`, `f${i}`);
        if (d.differing > 0) unstable++;
        worstFlicker = Math.max(worstFlicker, d.worst);
      }
      await sleep(120);
    }
    check('preview is stable across frames (no flicker)', unstable === 0,
      `${unstable}/4 frame pairs differ, worst channel Δ ${worstFlicker}`);

    const before = await A.evaluate(() => window.__liveStrokes());
    // Release at exactly the last stepped position. Lifting anywhere else adds
    // geometry the mid-stroke snapshot never saw, and the comparison below
    // would report that extra sliver as a preview/commit mismatch.
    await Promise.all([
      A.evaluate((x) => window.__eraseEnd(x, 300), LAST_X),
      ...(SOLO ? [] : [B.evaluate((x) => window.__eraseEnd(x, 340), LAST_X)])
    ]);
    // Wait for BOTH erases to land on both clients rather than sleeping: the
    // comparison below is against the committed result, so sampling before the
    // remote commit arrives compares the preview to a half-finished board.
    await Promise.all(pages.map((p) =>
      p.waitForFunction((n) => window.__liveStrokes() >= n, { timeout: 30_000 }, before + (SOLO ? 1 : 2))));
    await sleep(500);

    await A.evaluate((b) => window.__snap('committed', b), BOX);
    const d = await A.evaluate(() => window.__diffSnaps('mid', 'committed'));
    check('mid-stroke preview matches committed result', d.differing === 0,
      `worst channel Δ ${d.worst}, ${d.differing}/${d.total} px differ`);

    // And both clients must agree once it has all landed. Compared on a coarse
    // per-cell average, the way the parity suite tolerates renderer noise.
    // Re-sample a few times: if the two clients are merely still settling this
    // converges, and if they have genuinely diverged it does not. Distinguishing
    // those two is the whole point — a single sample cannot.
    let cellsDiffer = 0, worstCell = 0, sigLen = 0, trend = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      await Promise.all(pages.map((p) => p.evaluate((b) => window.__snap('committed', b), BOX)));
      const [sigA, sigB] = await Promise.all(pages.map((p) =>
        p.evaluate((c) => window.__signature('committed', c), CELL)));
      cellsDiffer = 0; worstCell = 0; sigLen = sigA.length;
      for (let i = 0; i < sigA.length; i++) {
        const delta = Math.abs(sigA[i] - sigB[i]);
        if (delta > 4) cellsDiffer++;
        worstCell = Math.max(worstCell, delta);
      }
      trend.push(cellsDiffer);
      if (cellsDiffer === 0) break;
      await sleep(1200);
    }
    // Quoted the way replay_parity_suite quotes it: a remote stroke is rebuilt
    // from broadcast points and lands a pixel or two off the sender's own
    // geometry, so exact cross-client equality is not the bar anywhere in this
    // project. 99.5% is.
    const b64 = await B.evaluate(() => window.__snapB64('committed'));
    const px = await A.evaluate((s) => window.__compareB64('committed', s, 16), b64);
    check('A and B agree on the result (parity bar: ≥99.5%)', px.matchPct >= 99.5,
      `${px.matchPct}% identical, ${px.differing}/${px.total} px differ, worst Δ ${px.worst}`);
    console.log(`         cell-average view: ${cellsDiffer}/${sigLen} channels differ,`
      + ` worst Δ ${worstCell}, stable over time [${trend.join(' → ')}]`);

    console.log(`\n${failures === 0 ? '\x1b[32mALL CHECKS PASSED\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`}\n`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    await browser.close();
  }
})();
