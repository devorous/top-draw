/**
 * @fileoverview Shared layer-snapshot diff helpers.
 *
 * Used by two test runners:
 *   - testing/puppeteer/comprehensive_sync_suite.js  (bot↔bot live sync)
 *   - testing/devtools/replay_parity_suite.mjs        (live↔replay parity)
 *
 * The diff fixture (pixel tolerance, neighbour slack, pass threshold) is
 * defined once here so a test that passes "live sync" but fails "replay
 * parity" is a real replay-only regression, not a tolerance mismatch.
 *
 * In-page evaluators are exported as plain functions. Both puppeteer
 * (`page.evaluate(fn)`) and the chrome-devtools MCP (`evaluate_script` with
 * `function` parameter) accept the .toString() form, so the same source
 * file works for both runners.
 */

// Canvas rendering is intentionally a bit non-deterministic (AA jitter, used
// as a fingerprinting signal in the wild), so we accept small per-channel
// deltas and report a % match instead of an exact hash.
export const PIXEL_TOLERANCE = 16;
// Morphological slack — a mismatched px passes if any neighbour within R
// matches the other side. Absorbs AA edge jitter.
export const NEIGHBOR_RADIUS = 2;
// % matching pixels in the union dirty bbox.
export const PASS_PCT = 99.5;

// ──────────────────────────────────────────────────────────────────────────
// In-page evaluators
// ──────────────────────────────────────────────────────────────────────────

/**
 * Capture per-layer model state from the LayerManager.
 *
 * Composites flatCanvas + strokeStack (in timestamp order) into a fresh
 * canvas, then crops to the dirty bbox and returns base64-encoded RGBA.
 *
 * Must run in the page (uses document, btoa, etc.).
 *
 * @returns {Array<{
 *   groupIdx: number,
 *   canvasW: number,
 *   canvasH: number,
 *   strokeStackLen: number,
 *   hasBaked: boolean,
 *   bbox: {x:number,y:number,w:number,h:number}|null,
 *   bboxPixelsB64: string|null,
 * }>}
 */
export function captureLayerSnapshotsInPage() {
  const lm = window.app?.board?.layerManager;
  if (!lm || !lm.layerGroups) return [];
  const out = [];
  for (let gi = 0; gi < lm.layerGroups.length; gi++) {
    const group = lm.layerGroups[gi];
    const empty = group.strokeStack.length === 0 && !group.flatCanvas;
    if (empty) continue;

    const cvs = document.createElement('canvas');
    cvs.width = lm.width;
    cvs.height = lm.height;
    const ctx = cvs.getContext('2d');
    if (group.flatCanvas) ctx.drawImage(group.flatCanvas, 0, 0);
    const sorted = [...group.strokeStack].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    for (const s of sorted) {
      if (!s.canvas) continue;
      ctx.globalCompositeOperation = s.blendMode || 'source-over';
      ctx.drawImage(s.canvas, s.x || 0, s.y || 0);
    }
    ctx.globalCompositeOperation = 'source-over';

    const imageData = ctx.getImageData(0, 0, cvs.width, cvs.height);
    const data = imageData.data;
    const w = cvs.width, h = cvs.height;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        if (data[row + x * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    let bbox = null, bboxPixelsB64 = null;
    if (maxX >= 0) {
      bbox = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
      const cropped = ctx.getImageData(bbox.x, bbox.y, bbox.w, bbox.h);
      const u8 = new Uint8Array(cropped.data.buffer);
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < u8.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
      }
      bboxPixelsB64 = btoa(binary);
    }

    out.push({
      groupIdx: gi,
      canvasW: w,
      canvasH: h,
      strokeStackLen: group.strokeStack.length,
      hasBaked: !!group.flatCanvas,
      bbox,
      bboxPixelsB64,
    });
  }
  return out;
}

/**
 * Same as captureLayerSnapshotsInPage but reads the REPLAY engine's layer
 * manager instead of the live board's. Used by the parity harness to compare
 * what got replayed against what was drawn live.
 */
export function captureReplayLayerSnapshotsInPage() {
  const lm = window.app?.TimeMachine?.getReplayLayerManager?.();
  if (!lm || !lm.layerGroups) return [];
  // Body is intentionally identical to captureLayerSnapshotsInPage from the
  // `if (!lm...) return []` point forward — we only swap the lm source.
  const out = [];
  for (let gi = 0; gi < lm.layerGroups.length; gi++) {
    const group = lm.layerGroups[gi];
    const empty = group.strokeStack.length === 0 && !group.flatCanvas;
    if (empty) continue;

    const cvs = document.createElement('canvas');
    cvs.width = lm.width;
    cvs.height = lm.height;
    const ctx = cvs.getContext('2d');
    if (group.flatCanvas) ctx.drawImage(group.flatCanvas, 0, 0);
    const sorted = [...group.strokeStack].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    for (const s of sorted) {
      if (!s.canvas) continue;
      ctx.globalCompositeOperation = s.blendMode || 'source-over';
      ctx.drawImage(s.canvas, s.x || 0, s.y || 0);
    }
    ctx.globalCompositeOperation = 'source-over';

    const imageData = ctx.getImageData(0, 0, cvs.width, cvs.height);
    const data = imageData.data;
    const w = cvs.width, h = cvs.height;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        if (data[row + x * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    let bbox = null, bboxPixelsB64 = null;
    if (maxX >= 0) {
      bbox = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
      const cropped = ctx.getImageData(bbox.x, bbox.y, bbox.w, bbox.h);
      const u8 = new Uint8Array(cropped.data.buffer);
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < u8.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
      }
      bboxPixelsB64 = btoa(binary);
    }

    out.push({
      groupIdx: gi,
      canvasW: w,
      canvasH: h,
      strokeStackLen: group.strokeStack.length,
      hasBaked: !!group.flatCanvas,
      bbox,
      bboxPixelsB64,
    });
  }
  return out;
}

/**
 * Capture LayerManager stroke metadata (per-user counts, bake state, totals).
 * @returns {{ total: number, baked: number, groups: Object[], maxPerUser: number }}
 */
export function strokeMetadataInPage() {
  const lm = window.app.board.layerManager;
  const groups = [];
  let total = 0;
  let baked = 0;
  lm.layerGroups?.forEach((group, groupIdx) => {
    total += group.strokeStack.length;
    const userCounts = {};
    for (const [uid, n] of group.userStrokeCounts.entries()) userCounts[uid] = n;
    const hasBaked = !!group.flatCanvas;
    if (hasBaked) baked++;
    groups.push({ groupIdx, count: group.strokeStack.length, hasBaked, userCounts });
  });
  return { total, baked, groups, maxPerUser: lm.constructor.MAX_STROKES_PER_USER };
}

// ──────────────────────────────────────────────────────────────────────────
// Node-side diff
// ──────────────────────────────────────────────────────────────────────────

/**
 * Diff two snapshot arrays (one per bot/source). Returns per-group + overall
 * stats. Pass criterion: ≥ PASS_PCT matching pixels in the union dirty bbox,
 * applying neighbour-radius slack for AA jitter.
 *
 * @param {Array} refSnaps
 * @param {Array} otherSnaps
 * @param {number} [tolerance]
 * @returns {{ pass: boolean, matchPct: number, maxDelta: number, matched: number, checked: number, perGroup: Array }}
 */
export function diffSnapshots(refSnaps, otherSnaps, tolerance = PIXEL_TOLERANCE) {
  const groupIdxs = new Set([...refSnaps.map((s) => s.groupIdx), ...otherSnaps.map((s) => s.groupIdx)]);
  const refByIdx = new Map(refSnaps.map((s) => [s.groupIdx, s]));
  const otherByIdx = new Map(otherSnaps.map((s) => [s.groupIdx, s]));

  const perGroup = [];
  let allPass = true;
  let overallMatched = 0, overallChecked = 0, overallMaxDelta = 0;

  for (const gi of [...groupIdxs].sort((a, b) => a - b)) {
    const a = refByIdx.get(gi);
    const b = otherByIdx.get(gi);
    const bboxA = a?.bbox, bboxB = b?.bbox;

    if (!bboxA && !bboxB) {
      perGroup.push({ groupIdx: gi, pass: true, matchPct: 100, maxDelta: 0, matched: 0, checked: 0, empty: true });
      continue;
    }

    const u = {
      x: Math.min(bboxA?.x ?? Infinity, bboxB?.x ?? Infinity),
      y: Math.min(bboxA?.y ?? Infinity, bboxB?.y ?? Infinity),
    };
    const maxRight = Math.max((bboxA ? bboxA.x + bboxA.w : -Infinity), (bboxB ? bboxB.x + bboxB.w : -Infinity));
    const maxBottom = Math.max((bboxA ? bboxA.y + bboxA.h : -Infinity), (bboxB ? bboxB.y + bboxB.h : -Infinity));
    u.w = maxRight - u.x;
    u.h = maxBottom - u.y;

    const aBuf = bboxA ? Buffer.from(a.bboxPixelsB64, 'base64') : null;
    const bBuf = bboxB ? Buffer.from(b.bboxPixelsB64, 'base64') : null;

    const readPixel = (buf, bbox, x, y) => {
      if (!buf || x < bbox.x || x >= bbox.x + bbox.w || y < bbox.y || y >= bbox.y + bbox.h) {
        return [0, 0, 0, 0];
      }
      const lx = x - bbox.x;
      const ly = y - bbox.y;
      const i = (ly * bbox.w + lx) * 4;
      return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
    };

    const pixelDelta = (pa, pb) => Math.max(
      Math.abs(pa[0] - pb[0]),
      Math.abs(pa[1] - pb[1]),
      Math.abs(pa[2] - pb[2]),
      Math.abs(pa[3] - pb[3]),
    );

    let matched = 0, checked = 0, maxDelta = 0;
    for (let y = u.y; y < u.y + u.h; y++) {
      for (let x = u.x; x < u.x + u.w; x++) {
        const pa = readPixel(aBuf, bboxA, x, y);
        const pb = readPixel(bBuf, bboxB, x, y);
        const dCenter = pixelDelta(pa, pb);
        if (dCenter > maxDelta) maxDelta = dCenter;
        checked++;
        if (dCenter <= tolerance) { matched++; continue; }

        let ok = false;
        for (let dy = -NEIGHBOR_RADIUS; dy <= NEIGHBOR_RADIUS && !ok; dy++) {
          for (let dx = -NEIGHBOR_RADIUS; dx <= NEIGHBOR_RADIUS && !ok; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nb = readPixel(bBuf, bboxB, x + dx, y + dy);
            if (pixelDelta(pa, nb) <= tolerance) { ok = true; break; }
            const na = readPixel(aBuf, bboxA, x + dx, y + dy);
            if (pixelDelta(na, pb) <= tolerance) { ok = true; break; }
          }
        }
        if (ok) matched++;
      }
    }
    const pct = checked ? (matched / checked) * 100 : 100;
    const pass = pct >= PASS_PCT;
    if (!pass) allPass = false;
    overallMatched += matched;
    overallChecked += checked;
    if (maxDelta > overallMaxDelta) overallMaxDelta = maxDelta;
    perGroup.push({ groupIdx: gi, pass, matched, checked, matchPct: pct, maxDelta, bbox: u });
  }

  const overallPct = overallChecked ? (overallMatched / overallChecked) * 100 : 100;
  return {
    pass: allPass,
    matchPct: overallPct,
    maxDelta: overallMaxDelta,
    matched: overallMatched,
    checked: overallChecked,
    perGroup,
  };
}

/**
 * Render a side-by-side diff PNG showing where two snapshot sets disagree.
 *
 * Runs in-page (needs Canvas2D). The caller is responsible for invoking
 * this via `page.evaluate(generateDiffPngInPage, snapA, snapB, tolerance)`
 * (puppeteer) or `evaluate_script({ function, args: [...] })` (MCP).
 *
 * @returns {string} data URL (image/png)
 */
export function generateDiffPngInPage(sA, sB, tolerance) {
  const W = sA[0]?.canvasW || sB[0]?.canvasW || 1920;
  const H = sA[0]?.canvasH || sB[0]?.canvasH || 1080;

  const buildFull = (snaps) => {
    const full = new Uint8ClampedArray(W * H * 4);
    for (const s of snaps) {
      if (!s.bbox || !s.bboxPixelsB64) continue;
      const bin = atob(s.bboxPixelsB64);
      const len = bin.length;
      const tmp = new Uint8Array(len);
      for (let i = 0; i < len; i++) tmp[i] = bin.charCodeAt(i);
      const { x: bx, y: by, w: bw, h: bh } = s.bbox;
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const si = (y * bw + x) * 4;
          if (tmp[si + 3] === 0) continue;
          const di = ((by + y) * W + (bx + x)) * 4;
          full[di]     = tmp[si];
          full[di + 1] = tmp[si + 1];
          full[di + 2] = tmp[si + 2];
          full[di + 3] = tmp[si + 3];
        }
      }
    }
    return full;
  };

  const fullA = buildFull(sA);
  const fullB = buildFull(sB);
  const fullD = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    const dR = Math.abs(fullA[o]     - fullB[o]);
    const dG = Math.abs(fullA[o + 1] - fullB[o + 1]);
    const dB = Math.abs(fullA[o + 2] - fullB[o + 2]);
    const dA = Math.abs(fullA[o + 3] - fullB[o + 3]);
    if (Math.max(dR, dG, dB, dA) > tolerance) {
      fullD[o] = 255; fullD[o + 1] = 0; fullD[o + 2] = 0; fullD[o + 3] = 220;
    } else if (fullA[o + 3] || fullB[o + 3]) {
      fullD[o] = 80; fullD[o + 1] = 80; fullD[o + 2] = 80; fullD[o + 3] = 60;
    }
  }

  const panelW = Math.round(W / 2);
  const panelH = Math.round(H / 2);
  const tripW = panelW * 3 + 24;
  const tripH = panelH + 32;
  const cvs = document.createElement('canvas');
  cvs.width = tripW;
  cvs.height = tripH;
  const ctx = cvs.getContext('2d');
  ctx.fillStyle = '#181818';
  ctx.fillRect(0, 0, tripW, tripH);

  const drawPanel = (buf, x, label) => {
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const offCtx = off.getContext('2d');
    const id = offCtx.createImageData(W, H);
    id.data.set(buf);
    offCtx.putImageData(id, 0, 0);
    ctx.drawImage(off, x, 24, panelW, panelH);
    ctx.fillStyle = '#fff';
    ctx.font = '14px monospace';
    ctx.fillText(label, x + 4, 16);
  };

  drawPanel(fullA, 0, 'REF (drawer)');
  drawPanel(fullB, panelW + 12, 'OTHER');
  drawPanel(fullD, (panelW + 12) * 2, 'DIFF (red = mismatch)');

  return cvs.toDataURL('image/png');
}
