<script>
  import { untrack } from 'svelte';
  import Delaunator from 'delaunator';
  import FloatingArt from './FloatingArt.svelte';

  /**
   * @type {{
   *   roomId: string,
   *   canvasBounds: { x: number, y: number, width: number, height: number },
   *   viewport: { x: number, y: number, width: number, height: number, scale: number },
   *   enabled: boolean,
   *   floatingGallerySeed?: number,
   *   floatingGalleryIncludeIds?: string[],
   *   floatingGalleryExcludeIds?: string[],
   *   apiBaseUrl?: string,
   *   onLike?: (id: string) => Promise<void>,
   *   onComment?: (id: string) => void
   * }}
   */
  let {
    roomId,
    canvasBounds,
    viewport,
    enabled = true,
    floatingGallerySeed = 0,
    floatingGalleryIncludeIds = [],
    floatingGalleryExcludeIds = [],
    apiBaseUrl = '',
    onLike = null,
    onComment = null
  } = $props();

  let items = $state([]);
  let loading = $state(false);
  let lastFetchedRoom = $state(null);
  let lastFetchedConfigKey = $state('');
  let requestedRoom = null;
  let requestedConfigKey = '';

  const FETCH_LIMIT = 200;
  const NUM_SLOTS = 100;

  const CARD_WIDTH = 180;
  const CARD_HEIGHT = 200;
  const CARD_GAP = 24;
  const BOARD_GAP = 24;
  const CULL_PADDING = 1400;
  const RECT_MARGIN_LEFT = 100;
  const RECT_MARGIN_RIGHT = 50;
  const RECT_MARGIN_TOP = 125;
  const RECT_MARGIN_BOTTOM = 100;
  const VORONOI_POINT_SPACING = 165;
  const VORONOI_FIELD_PADDING = 1400;
  const MAX_VORONOI_SUPPORT_POINTS = 200;
  const MAX_VORONOI_LINE_LENGTH = 500;

  let slotAssignments = $state(new Array(NUM_SLOTS).fill(null));

  function buildFetchConfigKey() {
    return JSON.stringify({
      roomId,
      includeIds: floatingGalleryIncludeIds || [],
      excludeIds: floatingGalleryExcludeIds || []
    });
  }

  async function fetchFloatingArt(forceRefresh = false) {
    if (!enabled || loading) return;

    const configKey = buildFetchConfigKey();

    if (!forceRefresh && lastFetchedRoom === roomId && lastFetchedConfigKey === configKey && items.length > 0) {
      return;
    }

    loading = true;
    try {
      const params = new URLSearchParams({
        room: roomId,
        minLikes: '1',
        limit: String(FETCH_LIMIT)
      });
      for (const id of floatingGalleryIncludeIds || []) {
        if (id) params.append('includeId', id);
      }
      for (const id of floatingGalleryExcludeIds || []) {
        if (id) params.append('excludeId', id);
      }
      const url = `${apiBaseUrl}/api/gallery/floating?${params.toString()}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to fetch floating art');

      const data = await response.json();
      items = data.items || [];
      lastFetchedRoom = roomId;
      lastFetchedConfigKey = configKey;
    } catch (err) {
      console.error('[FloatingArt] Fetch error:', err);
      items = [];
    } finally {
      loading = false;
    }
  }

  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  function createSeededRandom(seed) {
    let state = seed || 1;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

function getBoardMetrics() {
    const width = Math.max(canvasBounds?.width || 0, 1);
    const height = Math.max(canvasBounds?.height || 0, 1);

    return {
      left: canvasBounds?.x || 0,
      top: canvasBounds?.y || 0,
      width,
      height,
      right: (canvasBounds?.x || 0) + width,
      bottom: (canvasBounds?.y || 0) + height
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

  function getRectPerimeter(rect) {
    return (2 * (rect.right - rect.left)) + (2 * (rect.bottom - rect.top));
  }

  function pointInBoard(point, board) {
    return (
      point.x >= board.left &&
      point.x <= board.right &&
      point.y >= board.top &&
      point.y <= board.bottom
    );
  }

  function orientation(a, b, c) {
    const value = ((b.y - a.y) * (c.x - b.x)) - ((b.x - a.x) * (c.y - b.y));
    if (Math.abs(value) < 1e-6) return 0;
    return value > 0 ? 1 : 2;
  }

  function onSegment(a, b, c) {
    return (
      b.x <= Math.max(a.x, c.x) + 1e-6 &&
      b.x >= Math.min(a.x, c.x) - 1e-6 &&
      b.y <= Math.max(a.y, c.y) + 1e-6 &&
      b.y >= Math.min(a.y, c.y) - 1e-6
    );
  }

  function segmentsIntersect(a, b, c, d) {
    const o1 = orientation(a, b, c);
    const o2 = orientation(a, b, d);
    const o3 = orientation(c, d, a);
    const o4 = orientation(c, d, b);

    if (o1 !== o2 && o3 !== o4) return true;
    if (o1 === 0 && onSegment(a, c, b)) return true;
    if (o2 === 0 && onSegment(a, d, b)) return true;
    if (o3 === 0 && onSegment(c, a, d)) return true;
    if (o4 === 0 && onSegment(c, b, d)) return true;
    return false;
  }

  function lineTouchesBoard(a, b, board) {
    if (pointInBoard(a, board) || pointInBoard(b, board)) {
      return true;
    }

    const corners = [
      { x: board.left, y: board.top },
      { x: board.right, y: board.top },
      { x: board.right, y: board.bottom },
      { x: board.left, y: board.bottom }
    ];

    for (let i = 0; i < corners.length; i++) {
      const c = corners[i];
      const d = corners[(i + 1) % corners.length];
      if (segmentsIntersect(a, b, c, d)) {
        return true;
      }
    }

    return false;
  }

  function createVoronoiSupportSites(board, layoutSeed, { includeBoard = false } = {}) {
    const field = getVoronoiFieldRect(board);
    const width = field.right - field.left;
    const height = field.bottom - field.top;
    const columns = Math.max(1, Math.floor(width / VORONOI_POINT_SPACING));
    const rows = Math.max(1, Math.floor(height / VORONOI_POINT_SPACING));
    const colStep = width / columns;
    const rowStep = height / rows;
    const jitterRangeX = colStep * 0.22;
    const jitterRangeY = rowStep * 0.22;
    const random = createSeededRandom(layoutSeed ^ 0x9e3779b9);
    const sites = [];

    for (let row = 0; row <= rows; row++) {
      for (let col = 0; col <= columns; col++) {
        const baseX = field.left + (col * colStep);
        const baseY = field.top + (row * rowStep);
        const x = baseX + ((random() - 0.5) * 2 * jitterRangeX);
        const y = baseY + ((random() - 0.5) * 2 * jitterRangeY);
        if (!includeBoard && pointInBoard({ x, y }, board)) continue;
        sites.push({ x, y, kind: 'support' });
      }
    }

    if (sites.length <= MAX_VORONOI_SUPPORT_POINTS) {
      return sites;
    }

    const sampled = [];
    const stride = sites.length / MAX_VORONOI_SUPPORT_POINTS;
    for (let i = 0; i < MAX_VORONOI_SUPPORT_POINTS; i++) {
      sampled.push(sites[Math.floor(i * stride)]);
    }
    return sampled;
  }

  function dedupeSites(sites) {
    const seen = new Set();
    const deduped = [];

    for (const site of sites) {
      const key = `${Math.round(site.x)}:${Math.round(site.y)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(site);
    }

    return deduped;
  }

  function pointOnRectPerimeter(rect, distance) {
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    const perimeter = (2 * width) + (2 * height);
    let d = ((distance % perimeter) + perimeter) % perimeter;

    if (d <= width) {
      return { x: rect.left + d, y: rect.top };
    }

    d -= width;
    if (d <= height) {
      return { x: rect.right, y: rect.top + d };
    }

    d -= height;
    if (d <= width) {
      return { x: rect.right - d, y: rect.bottom };
    }

    d -= width;
    return { x: rect.left, y: rect.bottom - d };
  }

  function createRectGeneratorSites(rect, layoutSeed) {
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    const perimeter = (2 * width) + (2 * height);
    const siteCount = Math.max(12, Math.floor(perimeter / VORONOI_POINT_SPACING));
    const spacing = perimeter / siteCount;
    const random = createSeededRandom(layoutSeed ^ 0x85ebca6b);
    const sites = [];

    for (let i = 0; i < siteCount; i++) {
      const jitter = (random() - 0.5) * spacing * 0.75;
      const point = pointOnRectPerimeter(rect, (i * spacing) + jitter);
      sites.push({ ...point, kind: 'rect' });
    }

    return dedupeSites(sites);
  }

  function createSlotSeed(roomSeed) {
    const board = getBoardMetrics();
    return (roomSeed || 1) ^ hashString(`${Math.round(board.width)}:${Math.round(board.height)}:${roomId || 'room'}`);
  }

  function createVoronoiBaseSites(board, layoutSeed, { includeBoard = false } = {}) {
    const rect = getExpandedRect(board);
    return dedupeSites([
      ...createRectGeneratorSites(rect, layoutSeed),
      ...createVoronoiSupportSites(board, layoutSeed, { includeBoard })
    ]);
  }

  function distanceToBoard(point, board) {
    const dx = Math.max(board.left - point.x, 0, point.x - board.right);
    const dy = Math.max(board.top - point.y, 0, point.y - board.bottom);
    return Math.hypot(dx, dy);
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
      a.x >= b.x + CARD_WIDTH + CARD_GAP ||
      a.y + CARD_HEIGHT + CARD_GAP <= b.y ||
      a.y >= b.y + CARD_HEIGHT + CARD_GAP
    );
  }

  function circumcenter(ax, ay, bx, by, cx, cy) {
    const d = 2 * ((ax * (by - cy)) + (bx * (cy - ay)) + (cx * (ay - by)));
    if (Math.abs(d) < 1e-6) return null;

    const ax2ay2 = (ax * ax) + (ay * ay);
    const bx2by2 = (bx * bx) + (by * by);
    const cx2cy2 = (cx * cx) + (cy * cy);

    return {
      x: ((ax2ay2 * (by - cy)) + (bx2by2 * (cy - ay)) + (cx2cy2 * (ay - by))) / d,
      y: ((ax2ay2 * (cx - bx)) + (bx2by2 * (ax - cx)) + (cx2cy2 * (bx - ax))) / d
    };
  }

  function createVoronoiVertices(baseSites, board, { includeBoard = false } = {}) {
    if (baseSites.length < 3) return [];

    const delaunay = Delaunator.from(baseSites, point => point.x, point => point.y);
    const vertices = [];

    for (let t = 0; t < delaunay.triangles.length; t += 3) {
      const a = baseSites[delaunay.triangles[t]];
      const b = baseSites[delaunay.triangles[t + 1]];
      const c = baseSites[delaunay.triangles[t + 2]];
      const center = circumcenter(a.x, a.y, b.x, b.y, c.x, c.y);
      if (!center || (!includeBoard && pointInBoard(center, board))) continue;
      vertices.push({ x: center.x, y: center.y, kind: 'vertex' });
    }

    return dedupeSites(vertices);
  }

  function createSlotLayout(count, baseSites) {
    const board = getBoardMetrics();
    const sitePool = createVoronoiVertices(baseSites, board)
      .sort((a, b) => {
        const distanceDelta = distanceToBoard(a, board) - distanceToBoard(b, board);
        if (Math.abs(distanceDelta) > 1e-6) return distanceDelta;
        if (Math.abs(a.y - b.y) > 1e-6) return a.y - b.y;
        return a.x - b.x;
      });

    const placed = [];

    for (let i = 0; i < count; i++) {
      let chosenSite = null;
      let card = null;

      for (let s = 0; s < sitePool.length; s++) {
        const site = sitePool[s];
        const candidate = {
          x: site.x - (CARD_WIDTH / 2),
          y: site.y - (CARD_HEIGHT / 2)
        };

        if (cardIntersectsBoard(candidate, board)) continue;
        if (placed.some(existing => cardsOverlap(candidate, existing))) continue;

        chosenSite = site;
        card = candidate;
        sitePool.splice(s, 1);
        break;
      }

      if (!chosenSite) break;

      placed.push({
        x: card.x,
        y: card.y,
        centerX: chosenSite.x,
        centerY: chosenSite.y,
      });
    }

    return placed;
  }

  function clipLineToRect(origin, direction, rect) {
    const candidates = [];
    const { x: ox, y: oy } = origin;
    const { x: dx, y: dy } = direction;

    if (Math.abs(dx) > 1e-6) {
      const tLeft = (rect.left - ox) / dx;
      const yLeft = oy + (tLeft * dy);
      if (tLeft > 0 && yLeft >= rect.top - 1 && yLeft <= rect.bottom + 1) {
        candidates.push({ x: rect.left, y: yLeft, t: tLeft });
      }

      const tRight = (rect.right - ox) / dx;
      const yRight = oy + (tRight * dy);
      if (tRight > 0 && yRight >= rect.top - 1 && yRight <= rect.bottom + 1) {
        candidates.push({ x: rect.right, y: yRight, t: tRight });
      }
    }

    if (Math.abs(dy) > 1e-6) {
      const tTop = (rect.top - oy) / dy;
      const xTop = ox + (tTop * dx);
      if (tTop > 0 && xTop >= rect.left - 1 && xTop <= rect.right + 1) {
        candidates.push({ x: xTop, y: rect.top, t: tTop });
      }

      const tBottom = (rect.bottom - oy) / dy;
      const xBottom = ox + (tBottom * dx);
      if (tBottom > 0 && xBottom >= rect.left - 1 && xBottom <= rect.right + 1) {
        candidates.push({ x: xBottom, y: rect.bottom, t: tBottom });
      }
    }

    if (!candidates.length) {
      return { x: ox, y: oy };
    }

    candidates.sort((a, b) => a.t - b.t);
    return candidates[0];
  }

  function createPointKey(x, y) {
    return `${Math.round(x)}:${Math.round(y)}`;
  }

  function pruneIsolatedLines(lines) {
    if (lines.length <= 1) return [];

    const pointUsage = new Map();
    const adjacency = new Map();

    for (const line of lines) {
      const startKey = createPointKey(line.x1, line.y1);
      const endKey = createPointKey(line.x2, line.y2);
      pointUsage.set(startKey, (pointUsage.get(startKey) || 0) + 1);
      pointUsage.set(endKey, (pointUsage.get(endKey) || 0) + 1);

      if (!adjacency.has(startKey)) adjacency.set(startKey, new Set());
      if (!adjacency.has(endKey)) adjacency.set(endKey, new Set());
      adjacency.get(startKey).add(endKey);
      adjacency.get(endKey).add(startKey);
    }

    const smallComponentPoints = new Set();
    const visited = new Set();

    for (const pointKey of adjacency.keys()) {
      if (visited.has(pointKey)) continue;

      const stack = [pointKey];
      const component = [];

      while (stack.length) {
        const current = stack.pop();
        if (visited.has(current)) continue;
        visited.add(current);
        component.push(current);

        for (const neighbor of adjacency.get(current) || []) {
          if (!visited.has(neighbor)) {
            stack.push(neighbor);
          }
        }
      }

      if (component.length <= 2) {
        for (const key of component) {
          smallComponentPoints.add(key);
        }
      }
    }

    return lines.filter((line) => {
      const startKey = createPointKey(line.x1, line.y1);
      const endKey = createPointKey(line.x2, line.y2);
      if (smallComponentPoints.has(startKey) && smallComponentPoints.has(endKey)) {
        return false;
      }
      return (pointUsage.get(startKey) || 0) > 1 || (pointUsage.get(endKey) || 0) > 1;
    });
  }

  function buildVoronoiGeometry(artLayout, baseSites) {
    const board = getBoardMetrics();
    const field = getVoronoiFieldRect(board);
    const sites = dedupeSites(baseSites);
    const chosenVertices = artLayout.map(({ centerX, centerY }) => ({
      x: centerX,
      y: centerY,
      kind: 'chosen-vertex'
    }));

    if (sites.length < 3) {
      return { lines: [], siteMarkers: chosenVertices };
    }

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
        lines.push({
          x1: center.x,
          y1: center.y,
          x2: otherCenter.x,
          y2: otherCenter.y
        });
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
      lines.push({
        x1: center.x,
        y1: center.y,
        x2: clipped.x,
        y2: clipped.y
      });
    }

    return {
      lines: pruneIsolatedLines(lines),
      siteMarkers: [
        ...createVoronoiVertices(baseSites, board, { includeBoard: true }).map(site => ({ ...site, kind: 'vertex' })),
        ...chosenVertices
      ]
    };
  }

  function isVisible(x, y) {
    const { x: vx, y: vy, width: vw, height: vh } = viewport;
    return (
      x + CARD_WIDTH >= vx - CULL_PADDING &&
      x <= vx + vw + CULL_PADDING &&
      y + CARD_HEIGHT >= vy - CULL_PADDING &&
      y <= vy + vh + CULL_PADDING
    );
  }

  $effect(() => {
    const currentItems = items;
    const excludeIds = new Set((floatingGalleryExcludeIds || []).filter(Boolean));

    untrack(() => {
      // Remove excluded items from their slots
      for (let i = 0; i < NUM_SLOTS; i++) {
        if (slotAssignments[i] && excludeIds.has(slotAssignments[i].id)) {
          slotAssignments[i] = null;
        }
      }

      // Update already-slotted items with fresh data
      const slottedIds = new Set();
      for (let i = 0; i < NUM_SLOTS; i++) {
        if (!slotAssignments[i]) continue;
        const updated = currentItems.find(item => item.id === slotAssignments[i].id);
        if (updated) slotAssignments[i] = updated;
        slottedIds.add(slotAssignments[i].id);
      }

      // Assign new items to the first empty slot in order
      for (const item of currentItems) {
        if (excludeIds.has(item.id) || slottedIds.has(item.id)) continue;
        const emptySlot = slotAssignments.findIndex(s => s === null);
        if (emptySlot === -1) break;
        slotAssignments[emptySlot] = item;
        slottedIds.add(item.id);
      }
    });
  });

  let slotSeed = $derived.by(() => createSlotSeed(floatingGallerySeed));
  let baseSites = $derived.by(() => createVoronoiBaseSites(getBoardMetrics(), slotSeed));
  let visualBaseSites = $derived.by(() => (
    createVoronoiBaseSites(getBoardMetrics(), slotSeed ^ 0x6d2b79f5, { includeBoard: true })
  ));

  let precomputedSlots = $derived.by(() => {
    if (!enabled) return [];
    return createSlotLayout(NUM_SLOTS, baseSites);
  });

  let positionedItems = $derived.by(() => precomputedSlots.map((slot, i) => ({
    ...slot,
    item: slotAssignments[i] ?? null,
  })));

  let visibleItems = $derived.by(() => positionedItems.filter(({ x, y }) => isVisible(x, y)));

  let voronoiGeometry = $derived.by(() => buildVoronoiGeometry(precomputedSlots.map(s => ({ centerX: s.centerX, centerY: s.centerY })), visualBaseSites));
  let voronoiLines = $derived(voronoiGeometry.lines);
  let voronoiSiteMarkers = $derived(voronoiGeometry.siteMarkers);

  export function addItem(item) {
    if (items.some(existing => existing.id === item.id)) {
      return;
    }

    items = [...items, item].slice(-FETCH_LIMIT);
  }

  export function updateItem(item) {
    const index = items.findIndex(existing => existing.id === item.id);
    if (index >= 0) {
      items[index] = item;
      items = [...items];
    }
  }

  $effect(() => {
    if (!enabled || !roomId) return;
    const configKey = buildFetchConfigKey();
    if (requestedRoom === roomId && requestedConfigKey === configKey) return;
    requestedRoom = roomId;
    requestedConfigKey = configKey;
    fetchFloatingArt();
  });
</script>

<div class="floating-art-container">
  <svg class="voronoi-web">
    {#each voronoiLines as line, index (`${index}:${line.x1}:${line.y1}:${line.x2}:${line.y2}`)}
      <line
        x1={line.x1}
        y1={line.y1}
        x2={line.x2}
        y2={line.y2}
        stroke="rgba(0, 212, 170, 0.42)"
        stroke-width="1.35"
      />
    {/each}

    {#each voronoiSiteMarkers as site, index (`site:${index}:${site.x}:${site.y}:${site.kind}`)}
      <circle
        cx={site.x}
        cy={site.y}
        r={site.kind === 'chosen-vertex' ? 3.5 : 1.75}
        fill={site.kind === 'chosen-vertex'
          ? 'rgba(0, 212, 170, 0.98)'
          : 'rgba(0, 212, 170, 0.55)'}
      />
    {/each}
  </svg>

  <div class="floating-art-cards">
    {#each visibleItems as { item, x, y }, i (i)}
      {#if item}
        <FloatingArt {item} {x} {y} {onLike} {onComment} />
      {:else}
        <div class="blank-card" style="left: {x}px; top: {y}px;"></div>
      {/if}
    {/each}
  </div>
</div>

<style>
  .floating-art-container {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    overflow: visible;
  }

  .voronoi-web {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: -1;
    opacity: 1;
    overflow: visible;
  }

  .floating-art-cards {
    position: relative;
    width: 100%;
    height: 100%;
    z-index: 4;
    pointer-events: none;
  }

  .blank-card {
    position: absolute;
    width: 180px;
    height: 200px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px dashed rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    box-sizing: border-box;
  }
</style>
