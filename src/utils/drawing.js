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
