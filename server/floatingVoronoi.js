import Delaunator from 'delaunator';

const BASE_BOARD_WIDTH = 1920;
const BASE_BOARD_HEIGHT = 1080;
const CARD_WIDTH = 180;
const CARD_HEIGHT = 200;
const CARD_GAP = 12;
const BOARD_GAP = 10;
const RECT_MARGIN_LEFT = 70;
const RECT_MARGIN_RIGHT = 36;
const RECT_MARGIN_TOP = 90;
const RECT_MARGIN_BOTTOM = 70;
const VORONOI_POINT_SPACING = 125;
const VORONOI_FIELD_PADDING = 1400;
const MAX_VORONOI_SUPPORT_POINTS = 340;
const MAX_VORONOI_LINE_LENGTH = 420;

function createSeededRandom(seed) {
  let state = seed || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function getLayoutBoardMetrics() {
  return {
    left: 0,
    top: 0,
    width: BASE_BOARD_WIDTH,
    height: BASE_BOARD_HEIGHT,
    right: BASE_BOARD_WIDTH,
    bottom: BASE_BOARD_HEIGHT
  };
}

function getExpandedRect(board) {
  return {
    left: board.left - RECT_MARGIN_LEFT,
    top: board.top - RECT_MARGIN_TOP,
    right: board.right + RECT_MARGIN_RIGHT,
    bottom: board.bottom + RECT_MARGIN_BOTTOM
  };
}

function getVoronoiFieldRect(board) {
  return {
    left: board.left - VORONOI_FIELD_PADDING,
    top: board.top - VORONOI_FIELD_PADDING,
    right: board.right + VORONOI_FIELD_PADDING,
    bottom: board.bottom + VORONOI_FIELD_PADDING
  };
}

function pointInBoard(point, board) {
  return point.x >= board.left && point.x <= board.right && point.y >= board.top && point.y <= board.bottom;
}

function distanceToBoard(point, board) {
  const dx = Math.max(board.left - point.x, 0, point.x - board.right);
  const dy = Math.max(board.top - point.y, 0, point.y - board.bottom);
  return Math.sqrt(dx * dx + dy * dy);
}

function cardIntersectsBoard(card, board) {
  return !(
    card.x + CARD_WIDTH <= board.left - BOARD_GAP ||
    card.x >= board.right + BOARD_GAP ||
    card.y + CARD_HEIGHT <= board.top - BOARD_GAP ||
    card.y >= board.bottom + BOARD_GAP
  );
}

function cardsOverlap(a, b) {
  return !(
    a.x + CARD_WIDTH + CARD_GAP <= b.x ||
    b.x + CARD_WIDTH + CARD_GAP <= a.x ||
    a.y + CARD_HEIGHT + CARD_GAP <= b.y ||
    b.y + CARD_HEIGHT + CARD_GAP <= a.y
  );
}

function createVoronoiSupportSites(board, layoutSeed, { includeBoard = false } = {}) {
  const field = getVoronoiFieldRect(board);
  const random = createSeededRandom(layoutSeed ^ 0x9e3779b9);
  const sites = [];

  for (let y = field.top; y <= field.bottom; y += VORONOI_POINT_SPACING) {
    for (let x = field.left; x <= field.right; x += VORONOI_POINT_SPACING) {
      const jitterX = (random() - 0.5) * VORONOI_POINT_SPACING * 0.62;
      const jitterY = (random() - 0.5) * VORONOI_POINT_SPACING * 0.62;
      const site = { x: x + jitterX, y: y + jitterY };
      if (!includeBoard && pointInBoard(site, board)) continue;
      sites.push(site);
    }
  }

  return sites
    .sort((a, b) => distanceToBoard(a, board) - distanceToBoard(b, board))
    .slice(0, MAX_VORONOI_SUPPORT_POINTS);
}

function createVoronoiBaseSites(board, layoutSeed, { includeBoard = false } = {}) {
  const rect = getExpandedRect(board);
  return [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
    ...createVoronoiSupportSites(board, layoutSeed, { includeBoard })
  ];
}

function circumcenter(ax, ay, bx, by, cx, cy) {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-6) return null;

  const ax2ay2 = ax * ax + ay * ay;
  const bx2by2 = bx * bx + by * by;
  const cx2cy2 = cx * cx + cy * cy;

  return {
    x: (ax2ay2 * (by - cy) + bx2by2 * (cy - ay) + cx2cy2 * (ay - by)) / d,
    y: (ax2ay2 * (cx - bx) + bx2by2 * (ax - cx) + cx2cy2 * (bx - ax)) / d
  };
}

function clipLineToRect(origin, direction, rect) {
  const candidates = [];
  if (Math.abs(direction.x) > 1e-6) {
    candidates.push((rect.left - origin.x) / direction.x);
    candidates.push((rect.right - origin.x) / direction.x);
  }
  if (Math.abs(direction.y) > 1e-6) {
    candidates.push((rect.top - origin.y) / direction.y);
    candidates.push((rect.bottom - origin.y) / direction.y);
  }

  let best = null;
  for (const t of candidates) {
    if (t <= 0) continue;
    const point = { x: origin.x + direction.x * t, y: origin.y + direction.y * t };
    if (point.x < rect.left - 1e-6 || point.x > rect.right + 1e-6) continue;
    if (point.y < rect.top - 1e-6 || point.y > rect.bottom + 1e-6) continue;
    if (!best || t < best.t) best = { ...point, t };
  }

  return best || origin;
}

function dedupeSites(sites) {
  const seen = new Set();
  return sites.filter((site) => {
    const key = `${Math.round(site.x * 10)}:${Math.round(site.y * 10)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function generateLines(baseSites, board) {
  const field = getVoronoiFieldRect(board);
  const sites = dedupeSites(baseSites);
  if (sites.length < 3) return [];

  const delaunay = Delaunator.from(sites, point => point.x, point => point.y);
  const triangleCenters = [];

  for (let t = 0; t < delaunay.triangles.length; t += 3) {
    const a = sites[delaunay.triangles[t]];
    const b = sites[delaunay.triangles[t + 1]];
    const c = sites[delaunay.triangles[t + 2]];
    triangleCenters.push(circumcenter(a.x, a.y, b.x, b.y, c.x, c.y));
  }

  const lines = [];
  const boundarySeen = new Set();

  for (let edge = 0; edge < delaunay.halfedges.length; edge++) {
    const opposite = delaunay.halfedges[edge];
    const triangleIndex = Math.floor(edge / 3);
    const center = triangleCenters[triangleIndex];
    if (!center) continue;

    const nextEdge = (edge % 3 === 2) ? edge - 2 : edge + 1;
    const pIndex = delaunay.triangles[edge];
    const qIndex = delaunay.triangles[nextEdge];
    const p = sites[pIndex];
    const q = sites[qIndex];

    if (opposite >= 0) {
      if (edge > opposite) continue;
      const otherCenter = triangleCenters[Math.floor(opposite / 3)];
      if (!otherCenter) continue;
      if (Math.hypot(otherCenter.x - center.x, otherCenter.y - center.y) > MAX_VORONOI_LINE_LENGTH) continue;
      lines.push({ x1: center.x, y1: center.y, x2: otherCenter.x, y2: otherCenter.y });
      continue;
    }

    const key = [Math.min(pIndex, qIndex), Math.max(pIndex, qIndex)].join(':');
    if (boundarySeen.has(key)) continue;
    boundarySeen.add(key);

    const midX = (p.x + q.x) / 2;
    const midY = (p.y + q.y) / 2;
    let normalX = q.y - p.y;
    let normalY = -(q.x - p.x);
    const toCenterX = center.x - midX;
    const toCenterY = center.y - midY;
    if ((normalX * toCenterX) + (normalY * toCenterY) < 0) {
      normalX *= -1;
      normalY *= -1;
    }

    const clipped = clipLineToRect(center, { x: normalX, y: normalY }, field);
    if (Math.hypot(clipped.x - center.x, clipped.y - center.y) > MAX_VORONOI_LINE_LENGTH) continue;
    lines.push({ x1: center.x, y1: center.y, x2: clipped.x, y2: clipped.y });
  }

  return lines;
}

function createSlotLayout(count, baseSites, board) {
  const random = createSeededRandom(baseSites.length ^ 0x85ebca6b);
  const sitePool = baseSites
    .map(site => ({ centerX: site.x, centerY: site.y, x: site.x - CARD_WIDTH / 2, y: site.y - CARD_HEIGHT / 2 }))
    .sort((a, b) => {
      const distanceDelta = distanceToBoard(a, board) - distanceToBoard(b, board);
      return distanceDelta || random() - 0.5;
    });

  const slots = [];
  for (const candidate of sitePool) {
    if (slots.length >= count) break;
    if (cardIntersectsBoard(candidate, board)) continue;
    if (slots.some(slot => cardsOverlap(candidate, slot))) continue;
    slots.push(candidate);
  }
  return slots;
}

function roundLine(line) {
  return {
    x1: Math.round(line.x1 * 10) / 10,
    y1: Math.round(line.y1 * 10) / 10,
    x2: Math.round(line.x2 * 10) / 10,
    y2: Math.round(line.y2 * 10) / 10
  };
}

export function generateFloatingGalleryVoronoi(seed) {
  const normalizedSeed = Number.isFinite(Number(seed)) && Number(seed) > 0
    ? Math.floor(Number(seed))
    : 1;
  const board = getLayoutBoardMetrics();
  const layoutSeed = normalizedSeed ^ `${BASE_BOARD_WIDTH}:${BASE_BOARD_HEIGHT}`.split('').reduce((hash, char) => {
    hash = ((hash << 5) - hash) + char.charCodeAt(0);
    return hash & hash;
  }, 0);
  const baseSites = createVoronoiBaseSites(board, layoutSeed);
  const visualBaseSites = createVoronoiBaseSites(board, layoutSeed ^ 0x6d2b79f5, { includeBoard: true });
  const slots = createSlotLayout(75, baseSites, board);

  return {
    version: 1,
    seed: normalizedSeed,
    boardWidth: BASE_BOARD_WIDTH,
    boardHeight: BASE_BOARD_HEIGHT,
    lines: generateLines(visualBaseSites, board).map(roundLine),
    siteMarkers: slots.map(slot => ({
      x: Math.round(slot.centerX * 10) / 10,
      y: Math.round(slot.centerY * 10) / 10,
      kind: 'chosen-vertex'
    }))
  };
}

export function getFloatingGalleryVoronoiJson(voronoi) {
  if (!voronoi || !Array.isArray(voronoi.lines)) return '';
  return JSON.stringify(voronoi);
}
