/**
 * Convex Hull Utilities for Canvas Sync
 *
 * Provides convex hull computation using Graham Scan algorithm,
 * with support for padding expansion and point-in-hull testing.
 */

/**
 * Check if three points make a counter-clockwise turn
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @param {{x: number, y: number}} c
 * @returns {boolean}
 */
function isCounterClockwise(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0;
}

/**
 * Cross product of vectors OA and OB where O is origin
 * @param {{x: number, y: number}} o - Origin
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @returns {number} - Positive if counter-clockwise, negative if clockwise
 */
function crossProduct(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * Compute convex hull using Graham Scan algorithm
 * @param {Array<{x: number, y: number}>} points - Input points
 * @returns {Array<{x: number, y: number}>} - Hull vertices in counter-clockwise order
 */
function grahamScan(points) {
  if (points.length < 3) {
    return points.slice();
  }

  // Remove duplicate points
  const uniquePoints = [];
  const seen = new Set();
  for (const p of points) {
    const key = `${p.x},${p.y}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniquePoints.push({ x: p.x, y: p.y });
    }
  }

  if (uniquePoints.length < 3) {
    return uniquePoints;
  }

  // Find the lowest point (and leftmost if tie)
  let startIdx = 0;
  for (let i = 1; i < uniquePoints.length; i++) {
    if (uniquePoints[i].y < uniquePoints[startIdx].y ||
        (uniquePoints[i].y === uniquePoints[startIdx].y &&
         uniquePoints[i].x < uniquePoints[startIdx].x)) {
      startIdx = i;
    }
  }

  // Move start point to beginning
  const origin = uniquePoints[startIdx];
  uniquePoints[startIdx] = uniquePoints[0];
  uniquePoints[0] = origin;

  // Sort remaining points by polar angle from origin
  const rest = uniquePoints.slice(1);
  rest.sort((a, b) => {
    const angleA = Math.atan2(a.y - origin.y, a.x - origin.x);
    const angleB = Math.atan2(b.y - origin.y, b.x - origin.x);
    if (angleA !== angleB) {
      return angleA - angleB;
    }
    // If same angle, sort by distance (closer first)
    const distA = (a.x - origin.x) ** 2 + (a.y - origin.y) ** 2;
    const distB = (b.x - origin.x) ** 2 + (b.y - origin.y) ** 2;
    return distA - distB;
  });

  // Build the hull
  const hull = [origin];

  for (const point of rest) {
    // Remove points that would make a clockwise turn
    while (hull.length > 1 &&
           crossProduct(hull[hull.length - 2], hull[hull.length - 1], point) <= 0) {
      hull.pop();
    }
    hull.push(point);
  }

  return hull;
}

/**
 * Expand hull outward by padding amount
 * @param {Array<{x: number, y: number}>} hull - Hull vertices
 * @param {number} padding - Pixels to expand
 * @returns {Array<{x: number, y: number}>} - Expanded hull
 */
function expandHull(hull, padding) {
  if (hull.length === 0 || padding === 0) {
    return hull.slice();
  }

  // Calculate centroid
  const centroid = {
    x: hull.reduce((sum, p) => sum + p.x, 0) / hull.length,
    y: hull.reduce((sum, p) => sum + p.y, 0) / hull.length
  };

  // Move each point outward from centroid
  return hull.map(point => {
    const dx = point.x - centroid.x;
    const dy = point.y - centroid.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist === 0) {
      return { x: point.x, y: point.y };
    }

    const scale = (dist + padding) / dist;
    return {
      x: centroid.x + dx * scale,
      y: centroid.y + dy * scale
    };
  });
}

/**
 * Compute convex hull with optional padding
 * @param {Array<{x: number, y: number}>} points - Input points
 * @param {number} padding - Pixels to expand hull (default 15)
 * @returns {Array<{x: number, y: number}>} - Hull vertices in order
 */
export function computeConvexHull(points, padding = 15) {
  if (!points || points.length === 0) {
    return [];
  }

  // Handle single point - create a small box around it
  if (points.length === 1) {
    const p = points[0];
    return [
      { x: p.x - padding, y: p.y - padding },
      { x: p.x + padding, y: p.y - padding },
      { x: p.x + padding, y: p.y + padding },
      { x: p.x - padding, y: p.y + padding }
    ];
  }

  // Handle two points - create a rectangle around the line
  if (points.length === 2) {
    const p1 = points[0];
    const p2 = points[1];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len === 0) {
      return computeConvexHull([p1], padding);
    }

    // Perpendicular direction
    const perpX = -dy / len * padding;
    const perpY = dx / len * padding;
    // Extend along the line
    const extX = dx / len * padding;
    const extY = dy / len * padding;

    return [
      { x: p1.x - extX + perpX, y: p1.y - extY + perpY },
      { x: p1.x - extX - perpX, y: p1.y - extY - perpY },
      { x: p2.x + extX - perpX, y: p2.y + extY - perpY },
      { x: p2.x + extX + perpX, y: p2.y + extY + perpY }
    ];
  }

  const hull = grahamScan(points);

  if (padding > 0) {
    return expandHull(hull, padding);
  }

  return hull;
}

/**
 * Compute axis-aligned bounding box from hull
 * @param {Array<{x: number, y: number}>} hull - Hull vertices
 * @returns {{x: number, y: number, width: number, height: number}} - Bounding box
 */
export function hullToBounds(hull) {
  if (!hull || hull.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const point of hull) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }

  return {
    x: Math.floor(minX),
    y: Math.floor(minY),
    width: Math.ceil(maxX - minX),
    height: Math.ceil(maxY - minY)
  };
}

/**
 * Check if a point is inside a convex hull using ray casting
 * @param {{x: number, y: number}} point - Point to test
 * @param {Array<{x: number, y: number}>} hull - Hull vertices (must be in order)
 * @returns {boolean} - True if point is inside or on the hull
 */
export function pointInHull(point, hull) {
  if (!hull || hull.length < 3) {
    return false;
  }

  const n = hull.length;

  // Use winding number algorithm for robustness
  let windingNumber = 0;

  for (let i = 0; i < n; i++) {
    const current = hull[i];
    const next = hull[(i + 1) % n];

    if (current.y <= point.y) {
      if (next.y > point.y) {
        // Upward crossing
        if (crossProduct(current, next, point) > 0) {
          windingNumber++;
        }
      }
    } else {
      if (next.y <= point.y) {
        // Downward crossing
        if (crossProduct(current, next, point) < 0) {
          windingNumber--;
        }
      }
    }
  }

  return windingNumber !== 0;
}

/**
 * Generate a unique region ID
 * @returns {string}
 */
export function generateRegionId() {
  return `region_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
