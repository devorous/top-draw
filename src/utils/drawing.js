/**
 * Drawing utility functions for curve interpolation and smoothing
 */

export function quadraticCurve(points) {
  const quadraticPoints = [];

  for (let i = 0; i < points.length - 2; i++) {
    const point1 = points[i];
    const point2 = points[i + 1];
    const point3 = points[i + 2];

    const controlPointX = (point1.x + point2.x * 2 + point3.x) / 4;
    const controlPointY = (point1.y + point2.y * 2 + point3.y) / 4;
    const controlPoint = { x: controlPointX, y: controlPointY };

    quadraticPoints.push(point1, controlPoint, point2);
  }

  return quadraticPoints;
}

export function drawQuadraticCurve(points, ctx) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  for (let i = 1; i < points.length - 2; i += 2) {
    ctx.quadraticCurveTo(
      points[i].x, points[i].y,
      points[i + 1].x, points[i + 1].y
    );
  }

  ctx.stroke();
}

export function movingAverage(points, windowSize) {
  const smoothedPoints = [points[0]];

  for (let i = 1; i < points.length - 1; i++) {
    let sumX = 0;
    let sumY = 0;
    let count = 0;

    for (let j = i - windowSize; j <= i + windowSize; j++) {
      if (j >= 0 && j < points.length) {
        sumX += points[j].x;
        sumY += points[j].y;
        count++;
      }
    }

    const avgX = sumX / count;
    const avgY = sumY / count;
    smoothedPoints.push({ x: avgX, y: avgY });
  }

  smoothedPoints.push(points[points.length - 1]);
  return smoothedPoints;
}

export function calcCatmullRomCurve(points, tension) {
  if (points.length < 2) {
    return points;
  }

  const smoothedPoints = [];
  const numPoints = points.length - 1;

  for (let i = 0; i < numPoints; i++) {
    const p0 = i > 0 ? points[i - 1] : points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = i !== numPoints - 1 ? points[i + 2] : p2;

    const cp1 = {
      x: p1.x + (tension * (p2.x - p0.x)) / 6,
      y: p1.y + (tension * (p2.y - p0.y)) / 6
    };
    const cp2 = {
      x: p2.x - (tension * (p3.x - p1.x)) / 6,
      y: p2.y - (tension * (p3.y - p1.y)) / 6
    };

    smoothedPoints.push(p1, cp1, cp2);
  }

  smoothedPoints.push(points[numPoints]);
  return smoothedPoints;
}

export function manhattanDistance(p1, p2) {
  if (p1 && p2) {
    return Math.abs(p1.x - p2.x) + Math.abs(p1.y - p2.y);
  }
  return 0;
}

export function mirrorLine(points, width) {
  return points.map(point => ({
    x: width - point.x,
    y: point.y
  }));
}

/**
 * Calculate outer tangent points between two circles
 * @param {Object} c1 - First circle {x, y, radius}
 * @param {Object} c2 - Second circle {x, y, radius}
 * @returns {Object|null} - Tangent points {left: {t1, t2}, right: {t1, t2}} or null if circles overlap too much
 */
export function getOuterTangents(c1, c2) {
  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const d = Math.sqrt(dx * dx + dy * dy);

  // If circles are too close or one contains the other, can't compute tangents
  if (d < Math.abs(c1.radius - c2.radius) + 0.001) {
    return null;
  }

  // Base angle from c1 to c2
  const baseAngle = Math.atan2(dy, dx);

  // Angle offset for outer tangents
  // For outer tangents: sin(alpha) = (r1 - r2) / d
  const radiusDiff = c1.radius - c2.radius;
  const sinAlpha = Math.max(-1, Math.min(1, radiusDiff / d));
  const alpha = Math.asin(sinAlpha);

  // Tangent angles (perpendicular to the line from center to tangent point)
  const leftAngle = baseAngle + Math.PI / 2 - alpha;
  const rightAngle = baseAngle - Math.PI / 2 + alpha;

  return {
    left: {
      t1: {
        x: c1.x + c1.radius * Math.cos(leftAngle),
        y: c1.y + c1.radius * Math.sin(leftAngle),
        angle: leftAngle
      },
      t2: {
        x: c2.x + c2.radius * Math.cos(leftAngle),
        y: c2.y + c2.radius * Math.sin(leftAngle),
        angle: leftAngle
      }
    },
    right: {
      t1: {
        x: c1.x + c1.radius * Math.cos(rightAngle),
        y: c1.y + c1.radius * Math.sin(rightAngle),
        angle: rightAngle
      },
      t2: {
        x: c2.x + c2.radius * Math.cos(rightAngle),
        y: c2.y + c2.radius * Math.sin(rightAngle),
        angle: rightAngle
      }
    },
    baseAngle
  };
}

/**
 * Draw a stroke as a series of connected circles with tangent lines
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Array} points - Array of {x, y, radius} objects
 * @param {string} color - Fill color
 */
export function drawTangentStroke(ctx, points, color) {
  if (points.length === 0) return;

  ctx.fillStyle = color;

  // Single point - just draw a circle
  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, points[0].radius, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // Two points - draw circles and connecting quad
  if (points.length === 2) {
    const tangents = getOuterTangents(points[0], points[1]);
    if (!tangents) {
      // Fallback: just draw both circles
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, points[0].radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(points[1].x, points[1].y, points[1].radius, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    ctx.beginPath();
    // Start cap
    ctx.arc(points[0].x, points[0].y, points[0].radius,
      tangents.left.t1.angle, tangents.right.t1.angle, true);
    // Right edge to second circle
    ctx.lineTo(tangents.right.t2.x, tangents.right.t2.y);
    // End cap
    ctx.arc(points[1].x, points[1].y, points[1].radius,
      tangents.right.t2.angle, tangents.left.t2.angle, true);
    // Left edge back
    ctx.lineTo(tangents.left.t1.x, tangents.left.t1.y);
    ctx.closePath();
    ctx.fill();
    return;
  }

  // Multiple points - build the full stroke
  // Pre-compute all tangent data
  const tangentData = [];
  for (let i = 0; i < points.length - 1; i++) {
    const t = getOuterTangents(points[i], points[i + 1]);
    tangentData.push(t);
  }

  ctx.beginPath();

  // Start cap on first circle
  const firstTangent = tangentData[0];
  if (firstTangent) {
    ctx.arc(points[0].x, points[0].y, points[0].radius,
      firstTangent.left.t1.angle, firstTangent.right.t1.angle, true);
  } else {
    ctx.arc(points[0].x, points[0].y, points[0].radius, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // Right edge forward (from first to last)
  for (let i = 0; i < tangentData.length; i++) {
    const t = tangentData[i];
    if (!t) continue;

    // Line to tangent point on next circle
    ctx.lineTo(t.right.t2.x, t.right.t2.y);

    // If not the last segment, draw arc to next segment's tangent
    if (i < tangentData.length - 1) {
      const nextT = tangentData[i + 1];
      if (nextT) {
        // Arc on intermediate circle from current right tangent to next right tangent
        const circle = points[i + 1];
        ctx.arc(circle.x, circle.y, circle.radius,
          t.right.t2.angle, nextT.right.t1.angle, true);
      }
    }
  }

  // End cap on last circle
  const lastTangent = tangentData[tangentData.length - 1];
  if (lastTangent) {
    const lastCircle = points[points.length - 1];
    ctx.arc(lastCircle.x, lastCircle.y, lastCircle.radius,
      lastTangent.right.t2.angle, lastTangent.left.t2.angle, true);
  }

  // Left edge backward (from last to first)
  for (let i = tangentData.length - 1; i >= 0; i--) {
    const t = tangentData[i];
    if (!t) continue;

    // Line to tangent point on previous circle
    ctx.lineTo(t.left.t1.x, t.left.t1.y);

    // If not the first segment, draw arc to previous segment's tangent
    if (i > 0) {
      const prevT = tangentData[i - 1];
      if (prevT) {
        // Arc on intermediate circle from current left tangent to previous left tangent
        const circle = points[i];
        ctx.arc(circle.x, circle.y, circle.radius,
          t.left.t1.angle, prevT.left.t2.angle, true);
      }
    }
  }

  ctx.closePath();
  ctx.fill();
}

/**
 * Calculate perpendicular distance from point to line segment
 * @param {Object} point - Point {x, y}
 * @param {Object} lineStart - Line start {x, y}
 * @param {Object} lineEnd - Line end {x, y}
 * @returns {number} - Perpendicular distance
 */
function perpendicularDistance(point, lineStart, lineEnd) {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;

  // Handle degenerate case where line segment is a point
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    const pdx = point.x - lineStart.x;
    const pdy = point.y - lineStart.y;
    return Math.sqrt(pdx * pdx + pdy * pdy);
  }

  // Calculate perpendicular distance using cross product
  const numerator = Math.abs(dy * point.x - dx * point.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x);
  const denominator = Math.sqrt(lengthSquared);

  return numerator / denominator;
}

/**
 * Douglas-Peucker point reduction algorithm
 * Recursively simplifies a polyline while preserving its shape
 * @param {Array} points - Array of {x, y} points
 * @param {number} epsilon - Tolerance (larger = more reduction)
 * @returns {Array} - Simplified array of points
 */
export function douglasPeucker(points, epsilon) {
  if (points.length <= 2) {
    return points;
  }

  // Find the point with maximum distance from line between first and last
  let maxDistance = 0;
  let maxIndex = 0;
  const start = points[0];
  const end = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const distance = perpendicularDistance(points[i], start, end);
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = i;
    }
  }

  // If max distance is greater than epsilon, recursively simplify
  if (maxDistance > epsilon) {
    // Recursive call on both segments
    const left = douglasPeucker(points.slice(0, maxIndex + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIndex), epsilon);

    // Combine results (remove duplicate middle point)
    return left.slice(0, -1).concat(right);
  } else {
    // All points between start and end can be removed
    return [start, end];
  }
}

/**
 * Distance-based point culling (simpler and faster than Douglas-Peucker)
 * Removes points that are closer than threshold to previous kept point
 * @param {Array} points - Array of {x, y} points
 * @param {number} threshold - Minimum distance between points
 * @returns {Array} - Simplified array of points
 */
export function distanceBasedCulling(points, threshold) {
  if (points.length <= 2) {
    return points;
  }

  const result = [points[0]]; // Always keep first point
  let lastKept = points[0];

  for (let i = 1; i < points.length - 1; i++) {
    const dx = points[i].x - lastKept.x;
    const dy = points[i].y - lastKept.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance >= threshold) {
      result.push(points[i]);
      lastKept = points[i];
    }
  }

  // Always keep last point (important for shape tools)
  result.push(points[points.length - 1]);

  return result;
}

/**
 * Bridge gap between two points with interpolated filled circles.
 * Used for tools that need continuous stamping (Pen, Blur, etc).
 */
export function bridgeGap(ctx, from, to, fromRadius, toRadius, user, blendMode = 'source-over') {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Spacing: 20% of average radius
  const avgRadius = (fromRadius + toRadius) / 2;
  const spacing = Math.max(1, avgRadius * 0.2);
  const steps = Math.ceil(distance / spacing);

  ctx.save();
  ctx.globalCompositeOperation = blendMode;
  ctx.fillStyle = user.getColorString();

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + dx * t;
    const y = from.y + dy * t;
    const r = fromRadius + (toRadius - fromRadius) * t;

    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Draw a line through an array of points.
 * Standard implementation used by BrushTool and RemoteUserHandler.
 */
export function drawLineArray(points, ctx, user, board = null, blendMode = 'source-over') {
  if (!points || points.length === 0) return;

  const opacity = user.opacity !== undefined ? user.opacity : 1;
  const hardness = user.hardness !== undefined ? user.hardness / 100.0 : 1.0;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.globalCompositeOperation = blendMode;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = user.pressure * user.size * 2;

  const colorString = user.getColorString();

  // Apply softness using shadow blur
  if (hardness < 1.0) {
    const blurAmount = (1 - hardness) * (20 + user.size * 0.2);
    const offset = 100000;

    ctx.strokeStyle = colorString;
    ctx.shadowBlur = blurAmount;
    ctx.shadowColor = colorString;
    ctx.shadowOffsetX = -offset;
    ctx.shadowOffsetY = 0;

    ctx.translate(offset, 0);
  } else {
    ctx.strokeStyle = colorString;
    ctx.shadowBlur = 0;
  }

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();

  ctx.restore();
}

// Blur functions moved to blurUtils.js for lazy loading
// Import from './blurUtils.js' instead

/**
 * Test if a point is inside a polygon using winding number algorithm.
 * Works with any polygon (convex or concave).
 * @param {Object} point - Point to test {x, y}
 * @param {Array<Object>} polygon - Array of polygon vertices [{x, y}, ...]
 * @returns {boolean} True if point is inside polygon
 */
export function pointInHull(point, polygon) {
  if (!polygon || polygon.length < 3) return false;

  let windingNumber = 0;
  const n = polygon.length;

  for (let i = 0; i < n; i++) {
    const v1 = polygon[i];
    const v2 = polygon[(i + 1) % n];

    if (v1.y <= point.y) {
      if (v2.y > point.y) {
        // Upward crossing
        if (isLeft(v1, v2, point) > 0) {
          windingNumber++;
        }
      }
    } else {
      if (v2.y <= point.y) {
        // Downward crossing
        if (isLeft(v1, v2, point) < 0) {
          windingNumber--;
        }
      }
    }
  }

  return windingNumber !== 0;
}

/**
 * Test if a point is left/on/right of an infinite line.
 * @param {Object} p0 - Line start point {x, y}
 * @param {Object} p1 - Line end point {x, y}
 * @param {Object} p2 - Point to test {x, y}
 * @returns {number} >0 for left, =0 for on, <0 for right
 * @private
 */
function isLeft(p0, p1, p2) {
  return ((p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y));
}
