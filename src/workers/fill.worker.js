/**
 * @fileoverview Fill Web Worker
 *
 * Runs flood-fill, dilation, and erosion off the main thread.
 * Supports a generation counter so stale interactive-mode results are discarded.
 *
 * Messages IN:
 *   { id, type: 'computeFill', buffer: ArrayBuffer, width, height,
 *     sx, sy, tolerance, expansion, regionRects: [{x,y,width,height}]|null,
 *     generation }
 *
 * Messages OUT:
 *   { id, type, result: { mask: ArrayBuffer, minX, minY, maxX, maxY } | null,
 *     generation }
 */

let currentGeneration = 0;

// --- Scanline flood fill ---

function computeMask(data, width, height, sx, sy, tolerance, regionRects) {
  const startIdx = (sy * width + sx) * 4;
  const tR = data[startIdx];
  const tG = data[startIdx + 1];
  const tB = data[startIdx + 2];
  const tA = data[startIdx + 3];

  const fillTransparentOnly = tA < 10;
  const tolSq = tolerance * tolerance;

  const matchPixel = fillTransparentOnly
    ? (idx) => data[idx + 3] < 10
    : (idx) => {
        const dr = data[idx] - tR;
        const dg = data[idx + 1] - tG;
        const db = data[idx + 2] - tB;
        const da = data[idx + 3] - tA;
        return dr * dr + dg * dg + db * db + da * da <= tolSq;
      };

  // Build region check function
  let inRegion = null;
  if (regionRects && regionRects.length > 0) {
    inRegion = (px, py) => {
      for (let i = 0; i < regionRects.length; i++) {
        const r = regionRects[i];
        if (px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height) return true;
      }
      return false;
    };
  }

  const mask = new Uint8Array(width * height);

  const canFill = (px, py) => {
    if (px < 0 || px >= width || py < 0 || py >= height) return false;
    const vi = py * width + px;
    if (mask[vi]) return false;
    if (inRegion && !inRegion(px, py)) return false;
    return matchPixel(vi * 4);
  };

  if (!canFill(sx, sy)) return null;

  let minX = width, maxX = 0, minY = height, maxY = 0;

  const stack = new Int32Array(Math.min(width * height, 500000) * 2);
  let stackPtr = 0;
  stack[stackPtr++] = sx;
  stack[stackPtr++] = sy;

  while (stackPtr > 0) {
    const row = stack[--stackPtr];
    const col = stack[--stackPtr];
    if (mask[row * width + col]) continue;

    let left = col;
    while (left > 0 && canFill(left - 1, row)) left--;
    let right = col;
    while (right < width - 1 && canFill(right + 1, row)) right++;

    for (let i = left; i <= right; i++) mask[row * width + i] = 1;

    if (left < minX) minX = left;
    if (right > maxX) maxX = right;
    if (row < minY) minY = row;
    if (row > maxY) maxY = row;

    for (let dy = -1; dy <= 1; dy += 2) {
      const ny = row + dy;
      if (ny < 0 || ny >= height) continue;
      let i = left;
      while (i <= right) {
        while (i <= right && !canFill(i, ny)) i++;
        if (i > right) break;
        stack[stackPtr++] = i;
        stack[stackPtr++] = ny;
        while (i <= right && canFill(i, ny)) i++;
      }
    }
  }

  if (minX > maxX) return null;
  return { mask, minX, minY, maxX, maxY };
}

// --- Dilation ---

function dilateMask(result, radius, width, height) {
  if (!result || radius <= 0) return result;
  const { mask, minX, minY, maxX, maxY } = result;
  const r = Math.ceil(radius);

  const eMinX = Math.max(0, minX - r);
  const eMinY = Math.max(0, minY - r);
  const eMaxX = Math.min(width - 1, maxX + r);
  const eMaxY = Math.min(height - 1, maxY + r);
  const rw = eMaxX - eMinX + 1;
  const rh = eMaxY - eMinY + 1;

  const INF = 1e9;
  const dist = new Float32Array(rw * rh);
  dist.fill(INF);

  for (let py = minY; py <= maxY; py++) {
    const ry = py - eMinY;
    for (let px = minX; px <= maxX; px++) {
      if (mask[py * width + px]) {
        dist[ry * rw + (px - eMinX)] = 0;
      }
    }
  }

  for (let ry = 0; ry < rh; ry++) {
    const row = ry * rw;
    for (let rx = 1; rx < rw; rx++) {
      const prev = dist[row + rx - 1];
      if (prev < INF) { const d = Math.sqrt(prev) + 1; const dSq = d * d; if (dSq < dist[row + rx]) dist[row + rx] = dSq; }
    }
    for (let rx = rw - 2; rx >= 0; rx--) {
      const prev = dist[row + rx + 1];
      if (prev < INF) { const d = Math.sqrt(prev) + 1; const dSq = d * d; if (dSq < dist[row + rx]) dist[row + rx] = dSq; }
    }
  }

  for (let rx = 0; rx < rw; rx++) {
    for (let ry = 1; ry < rh; ry++) {
      const prev = dist[(ry - 1) * rw + rx];
      if (prev < INF) { const d = Math.sqrt(prev) + 1; const dSq = d * d; if (dSq < dist[ry * rw + rx]) dist[ry * rw + rx] = dSq; }
    }
    for (let ry = rh - 2; ry >= 0; ry--) {
      const prev = dist[(ry + 1) * rw + rx];
      if (prev < INF) { const d = Math.sqrt(prev) + 1; const dSq = d * d; if (dSq < dist[ry * rw + rx]) dist[ry * rw + rx] = dSq; }
    }
  }

  const rSq = r * r;
  const dilated = new Uint8Array(width * height);
  let dMinX = width, dMaxX = 0, dMinY = height, dMaxY = 0;

  for (let ry = 0; ry < rh; ry++) {
    const py = ry + eMinY;
    for (let rx = 0; rx < rw; rx++) {
      if (dist[ry * rw + rx] <= rSq) {
        const px = rx + eMinX;
        dilated[py * width + px] = 1;
        if (px < dMinX) dMinX = px;
        if (px > dMaxX) dMaxX = px;
        if (py < dMinY) dMinY = py;
        if (py > dMaxY) dMaxY = py;
      }
    }
  }

  if (dMinX > dMaxX) return result;
  return { mask: dilated, minX: dMinX, minY: dMinY, maxX: dMaxX, maxY: dMaxY };
}

// --- Erosion ---

function erodeMask(result, radius, width, height) {
  if (!result || radius <= 0) return result;
  const { mask, minX, minY, maxX, maxY } = result;
  const r = Math.ceil(radius);

  const padMinX = Math.max(0, minX - 1);
  const padMinY = Math.max(0, minY - 1);
  const padMaxX = Math.min(width - 1, maxX + 1);
  const padMaxY = Math.min(height - 1, maxY + 1);
  const rw = padMaxX - padMinX + 1;
  const rh = padMaxY - padMinY + 1;

  const INF = 1e9;
  const dist = new Float32Array(rw * rh);

  for (let ry = 0; ry < rh; ry++) {
    const py = ry + padMinY;
    for (let rx = 0; rx < rw; rx++) {
      const px = rx + padMinX;
      dist[ry * rw + rx] = mask[py * width + px] ? INF : 0;
    }
  }

  for (let ry = 0; ry < rh; ry++) {
    const row = ry * rw;
    for (let rx = 1; rx < rw; rx++) {
      const prev = dist[row + rx - 1];
      if (prev < INF) { const d = Math.sqrt(prev) + 1; const dSq = d * d; if (dSq < dist[row + rx]) dist[row + rx] = dSq; }
    }
    for (let rx = rw - 2; rx >= 0; rx--) {
      const prev = dist[row + rx + 1];
      if (prev < INF) { const d = Math.sqrt(prev) + 1; const dSq = d * d; if (dSq < dist[row + rx]) dist[row + rx] = dSq; }
    }
  }

  for (let rx = 0; rx < rw; rx++) {
    for (let ry = 1; ry < rh; ry++) {
      const prev = dist[(ry - 1) * rw + rx];
      if (prev < INF) { const d = Math.sqrt(prev) + 1; const dSq = d * d; if (dSq < dist[ry * rw + rx]) dist[ry * rw + rx] = dSq; }
    }
    for (let ry = rh - 2; ry >= 0; ry--) {
      const prev = dist[(ry + 1) * rw + rx];
      if (prev < INF) { const d = Math.sqrt(prev) + 1; const dSq = d * d; if (dSq < dist[ry * rw + rx]) dist[ry * rw + rx] = dSq; }
    }
  }

  const rSq = r * r;
  const eroded = new Uint8Array(width * height);
  let eMinX = width, eMaxX = 0, eMinY = height, eMaxY = 0;

  for (let ry = 0; ry < rh; ry++) {
    const py = ry + padMinY;
    for (let rx = 0; rx < rw; rx++) {
      if (dist[ry * rw + rx] > rSq) {
        const px = rx + padMinX;
        eroded[py * width + px] = 1;
        if (px < eMinX) eMinX = px;
        if (px > eMaxX) eMaxX = px;
        if (py < eMinY) eMinY = py;
        if (py > eMaxY) eMaxY = py;
      }
    }
  }

  if (eMinX > eMaxX) return null;
  return { mask: eroded, minX: eMinX, minY: eMinY, maxX: eMaxX, maxY: eMaxY };
}

// --- Message handler ---

self.onmessage = function(e) {
  const { id, type } = e.data;

  try {
    switch (type) {
      case 'computeFill': {
        const { buffer, width, height, sx, sy, tolerance, expansion,
                regionRects, generation } = e.data;

        // If a newer generation is already pending, skip this stale request
        if (generation < currentGeneration) {
          self.postMessage({ id, type, result: null, generation, stale: true });
          return;
        }
        currentGeneration = generation;

        const data = new Uint8ClampedArray(buffer);

        let result = computeMask(data, width, height, sx, sy, tolerance, regionRects);

        if (result && expansion > 0) {
          result = dilateMask(result, expansion, width, height);
        } else if (result && expansion < 0) {
          result = erodeMask(result, -expansion, width, height);
        }

        if (!result) {
          self.postMessage({ id, type, result: null, generation, buffer }, [buffer]);
          return;
        }

        // Transfer mask as ArrayBuffer
        const maskBuffer = result.mask.buffer;
        self.postMessage({
          id, type, generation, buffer,
          result: {
            maskBuffer,
            minX: result.minX, minY: result.minY,
            maxX: result.maxX, maxY: result.maxY,
            width, height
          }
        }, [maskBuffer, buffer]);
        break;
      }

      case 'setGeneration': {
        currentGeneration = e.data.generation;
        break;
      }

      default:
        self.postMessage({ id, type, error: `Unknown message type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, type, error: err.message });
  }
};
