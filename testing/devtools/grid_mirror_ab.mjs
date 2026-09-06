/**
 * Interleaved multi-arm A/B for MIRRORED rooms: what does mirror-expanding the
 * remote-preview dirty rect actually cost?
 *
 * `RemoteUserHandler._activeStrokeDirtyRect` used to bail to null the moment any
 * mirror was active, on the reasoning that the global mirror is a board-sized
 * region so the union collapses to the whole board anyway. That conflates the
 * size of the REGION with the size of the REFLECTED RECT — reflecting a 60x40
 * stroke rect across a board-length centerline gives another 60x40 rect, and the
 * union of the two is a wide, thin band, not a full board.
 *
 * Four arms, because a two-arm version cannot tell "scoping is bad here" apart
 * from "this particular rect SHAPE is bad":
 *
 *   old     resolver stubbed to null — pre-fix behaviour exactly (full composite)
 *   list    the stroke rect plus one rect per mirror image (what ships)
 *   union   those same rects collapsed to their bounding box — the first version
 *           of the fix, and mostly the empty gap between the copies
 *   base    the stroke rect alone, mirror expansion suppressed. Visually WRONG
 *           (the mirrored copy tears) but it isolates rect size/shape from the
 *           act of scoping: a fast `base` beside a slow `union` means the wide
 *           band is the cost, not the scoped path.
 *
 *   MIRROR=global node testing/devtools/grid_mirror_ab.mjs
 *   MIRROR=radial SLICES=8 ARMS=old,list node testing/devtools/grid_mirror_ab.mjs
 *
 * Env:
 *   MIRROR   global | vertical | quad | radial | fib          (default global)
 *   SLICES   radial slice count                               (default 8)
 *   ARMS     comma list from old,list,union,base              (default all four)
 *   SECONDS  measurement window per arm                       (default 12)
 *   REPEATS  rounds; arm order rotates each round             (default 4)
 *   BOARD    room | 1080p | 1440p | big | 4k   (locked on the observer)
 *   ROOM     must match the peer bot                          (default perfroom)
 *
 * Arms toggle at runtime inside ONE page session — this box drifts downward
 * across a session by more than the effect being measured — and the arm ORDER
 * rotates every round, so within-round drift cannot masquerade as an effect.
 *
 * Requires: the tunnel + Chrome on `book` (CDP on 127.0.0.1:9222) and a peer
 * drawing continuously in the same room (testing/devtools/peer_bot.mjs).
 */
import puppeteer from 'puppeteer';

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const URL = 'http://localhost:3000/go/';
const SECONDS = Number(process.env.SECONDS || 12);
const REPEATS = Number(process.env.REPEATS || 4);
const ROOM = process.env.ROOM || 'perfroom';
const MIRROR = process.env.MIRROR || 'global';
const SLICES = Number(process.env.SLICES || 8);
const BOARD = process.env.BOARD || 'room';
const ARMS = (process.env.ARMS || 'old,list,union,base').split(',').map(s => s.trim()).filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
const pages = await browser.pages();
const page = pages.find(p => p.url().includes('localhost:3000')) || pages[0];

// Reload so the edited module is loaded fresh and no prior instrumentation survives.
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
// `/go/` picks a room for you, so two clients silently land in DIFFERENT rooms
// while both look healthy. Join an explicit one on both sides.
await page.evaluate(r => window.app.handleRoomSelected(r), ROOM);
await page.waitForFunction(r => window.app?.connected && window.app.currentRoomId === r, { timeout: 60000 }, ROOM);
await sleep(4000);

// Board size is a ROOM setting and any room update — a peer joining mid-run
// included — reapplies it, so resizing without the lock silently reverts partway
// through and measures the wrong board.
if (BOARD !== 'room') {
  const dims = { '1080p': [1080, 1920], '1440p': [1440, 2560], big: [1800, 3200], '4k': [2160, 3840] }[BOARD];
  if (!dims) { console.error('unknown BOARD=' + BOARD); process.exit(1); }
  await page.evaluate(([h, w]) => {
    const board = window.app.board;
    board.resizeBoard([h, w]);
    window.app._bindLayerManagerDependencies?.();
    const orig = board.resizeBoard.bind(board);
    board.resizeBoard = (d) => { if (!d || d[0] !== h || d[1] !== w) return; return orig(d); };
  }, dims);
  await sleep(2500);
}

// Remote mirroring resolves against the OBSERVER's own board state
// (RemoteUserHandler routes every tool through board.forEachMirrorRegion), so
// arming it here alone exercises the full path — the peer needs to know nothing.
// Re-armed before EVERY window, not once at startup: the mirror flag is a room
// setting, and any SETTINGS message — a peer joining mid-run is enough — resets
// it. A run that loses it silently keeps reporting, with the mirror arms
// quietly measuring the unmirrored path. The resolver's rect-count and coverage
// columns are what caught it; `mirrorActive` in each result is the assertion.
await page.evaluate((mode, slices) => {
  window.__armMirror = () => {
    const b = window.app.board;
    b.setMirror(false);
    b.setMirrorRegions([]);
    if (mode === 'global') {
      b.setMirror(true);
    } else {
      // Sized to contain the peer bot's stroke box (it draws inside 1000x900).
      b.setMirrorRegions([{
        id: 'mr_perf_probe', x: 0, y: 0, width: 900, height: 900,
        mode, axis: mode, slices, fibDepth: 4, showLine: true, owner: window.app.self?.id ?? 0
      }]);
    }
    return { mirror: b.mirror, regions: b.mirrorRegions.length, expanded: b.getActiveMirrorRegions().length };
  };
}, MIRROR, SLICES);
const mirrorState = await page.evaluate(() => window.__armMirror());
console.log('MIRROR', MIRROR, JSON.stringify(mirrorState));
if (!mirrorState.expanded) {
  console.error('ABORT: no active mirror regions — nothing to measure');
  process.exit(2);
}

const env = await page.evaluate(async () => {
  let wake = 'unavailable';
  try { await navigator.wakeLock.request('screen'); wake = 'held'; } catch (e) { wake = 'failed:' + e.name; }
  const a = window.app, h = a.remoteUserHandler, b = a.board;
  const g = b.compositeTileGrid;
  const area = g.width * g.height;

  // Arm switch. 'base' suppresses only the mirror expansion, which
  // _previewDirtyRects gates on board.hasMirrors() — so stubbing that for the
  // duration of the call reproduces "scoped rect, no mirror copies" without
  // touching the resolver's own logic. 'union' collapses the rect list to its
  // bounding box, which is what the first version of the fix shipped.
  window.__arm = 'list';
  const R = window.__R = {
    scoped: 0, nullRect: 0, cov: [], count: [],
    reset() { this.scoped = 0; this.nullRect = 0; this.cov = []; this.count = []; }
  };
  const origHasMirrors = b.hasMirrors.bind(b);
  const orig = h._previewDirtyRects.bind(h);
  h._previewDirtyRects = (u, l) => {
    if (window.__arm === 'old') return null;
    let r;
    if (window.__arm === 'base') {
      b.hasMirrors = () => false;
      try { r = orig(u, l); } finally { b.hasMirrors = origHasMirrors; }
    } else {
      r = orig(u, l);
    }
    if (r?.length && window.__arm === 'union') {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of r) {
        x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y);
        x1 = Math.max(x1, q.x + q.width); y1 = Math.max(y1, q.y + q.height);
      }
      r = [{ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }];
    }
    if (r?.length) {
      R.scoped++;
      let s = 0;
      for (const q of r) s += q.width * q.height;
      R.cov.push(s / area);
      R.count.push(r.length);
    } else {
      R.nullRect++;
    }
    return r;
  };

  // Composite classification + frame intervals.
  const P = window.__P = {
    full: 0, partial: 0, empty: 0, coverage: [], rects: [],
    reset() { this.full = 0; this.partial = 0; this.empty = 0; this.coverage = []; this.rects = []; }
  };
  const oc = g.consumeDirtyRects.bind(g);
  g.consumeDirtyRects = (...x) => {
    const r = oc(...x);
    if (r === null) P.full++;
    else if (r.length === 0) P.empty++;
    else {
      P.partial++;
      let s = 0;
      for (const q of r) s += q.width * q.height;
      P.coverage.push(s / area);
      // Compositing cost is dominated by rect COUNT, not area (see
      // CompositeTileGrid.consumeDirtyRects), so count them rather than
      // assuming one marked rect means one composited rect.
      P.rects.push(r.length);
    }
    return r;
  };

  window.__measure = (secs) => new Promise(res => {
    P.reset(); R.reset();
    const iv = []; let last = performance.now(); const t0 = last;
    const step = () => {
      const now = performance.now(); iv.push(now - last); last = now;
      if (now - t0 < secs * 1000) { requestAnimationFrame(step); return; }
      iv.shift();
      const dropped = iv.filter(v => v > 25).length;
      const total = iv.reduce((s, v) => s + v, 0);
      const sorted = [...iv].sort((x, y) => x - y);
      const q = p => +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2);
      const mean = arr => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
      const cov = mean(P.coverage), rcov = mean(R.cov);
      res({
        frames: iv.length,
        droppedPct: +(100 * dropped / iv.length).toFixed(1),
        p95: q(0.95), p99: q(0.99),
        effFps: +(1000 * iv.length / total).toFixed(1),
        full: P.full, partial: P.partial, composites: P.full + P.partial,
        pctFullComposites: (P.full + P.partial) ? +(100 * P.full / (P.full + P.partial)).toFixed(1) : null,
        avgCoveragePct: cov != null ? +(100 * cov).toFixed(2) : null,
        avgRects: P.rects.length ? +mean(P.rects).toFixed(2) : null,
        maxRects: P.rects.length ? Math.max(...P.rects) : null,
        resolverScoped: R.scoped, resolverNull: R.nullRect,
        resolverBailPct: (R.scoped + R.nullRect) ? +(100 * R.nullRect / (R.scoped + R.nullRect)).toFixed(1) : null,
        resolverRectPct: rcov != null ? +(100 * rcov).toFixed(2) : null,
        resolverRectCount: R.count.length ? +mean(R.count).toFixed(2) : null
      });
    };
    requestAnimationFrame(step);
  });
  return {
    wake, cores: navigator.hardwareConcurrency, dims: b.dimensions.slice(),
    users: a.users.size, connected: a.connected, room: a.currentRoomId
  };
});
console.log('ENV', JSON.stringify(env));
if (env.users < 2) console.log('WARNING: only %d user(s) in room — start the peer bot', env.users);

const measureArm = async (arm) => {
  await page.evaluate(a => { window.__arm = a; window.__armMirror(); }, arm);
  const r = await page.evaluate(s => window.__measure(s), SECONDS);
  r.mirrorActive = await page.evaluate(() => window.app.board.getActiveMirrorRegions().length);
  return r;
};

const rounds = [];
for (let i = 0; i < REPEATS; i++) {
  // Rotate the arm order every round so no arm is permanently last.
  const order = ARMS.map((_, k) => ARMS[(k + i) % ARMS.length]);
  const result = {};
  for (const arm of order) result[arm] = await measureArm(arm);
  const peers = await page.evaluate(() => {
    let n = 0;
    window.app.users.forEach(u => { if (u.mousedown) n++; });
    return { users: window.app.users.size, drawing: n };
  });
  if (Object.values(result).some(r => r.frames === 0)) {
    console.error('ABORT: zero frames (display blanked)');
    process.exit(2);
  }
  rounds.push({ round: i, label: i === 0 ? 'cold' : 'steady', order: order.join(','), peers, result });
  console.log(`round ${i} (${i === 0 ? 'cold' : 'steady'}, ${order.join('>')}) users=${peers.users} drawing=${peers.drawing}`);
  for (const arm of ARMS) {
    const r = result[arm];
    console.log(`   ${arm.padEnd(7)} drop ${String(r.droppedPct).padStart(4)}%  p95 ${String(r.p95).padStart(5)}  effFps ${r.effFps}  full ${r.pctFullComposites}%  cov ${r.avgCoveragePct}%  rects ${r.avgRects}/${r.maxRects}  resolver ${r.resolverScoped}/${r.resolverNull} rect ${r.resolverRectPct}% x${r.resolverRectCount}  mirrors ${r.mirrorActive}`);
  }
}

const steady = rounds.filter(r => r.label === 'steady');
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
if (steady.length) {
  console.log('\nSTEADY MEDIANS (mirror=' + MIRROR + ')');
  const out = {};
  for (const arm of ARMS) {
    out[arm] = {
      droppedPct: med(steady.map(r => r.result[arm].droppedPct)),
      p95: med(steady.map(r => r.result[arm].p95)),
      effFps: med(steady.map(r => r.result[arm].effFps)),
      pctFullComposites: med(steady.map(r => r.result[arm].pctFullComposites)),
      avgCoveragePct: med(steady.map(r => r.result[arm].avgCoveragePct)),
      resolverRectPct: med(steady.map(r => r.result[arm].resolverRectPct))
    };
  }
  console.log(JSON.stringify(out, null, 2));
}
console.log('\nALL ROUNDS');
console.log(JSON.stringify(rounds, null, 2));
await browser.disconnect();
