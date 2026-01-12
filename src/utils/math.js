/**
 * Math utilities for drawing operations
 */

/**
 * Calculate Manhattan distance between two points
 * @param {Object} p1 - First point {x, y}
 * @param {Object} p2 - Second point {x, y}
 * @returns {number} Manhattan distance
 */
export function manhattanDistance(p1, p2) {
  if (!p1 || !p2 || (p1.x === p2.x && p1.y === p2.y)) {
    return 0;
  }
  return Math.abs(p1.x - p2.x) + Math.abs(p1.y - p2.y);
}

/**
 * Mirror a line of points horizontally across the board center
 * @param {Array} points - Array of point objects {x, y}
 * @param {number} boardWidth - Width of the board
 * @returns {Array} Mirrored points
 */
export function mirrorLine(points, boardWidth) {
  return points.map(point => ({
    x: boardWidth - point.x,
    y: point.y
  }));
}

/**
 * Calculate Catmull-Rom spline curve points
 * @param {Array} points - Input control points
 * @param {number} tension - Curve tension (0-1)
 * @returns {Array} Smoothed curve points
 */
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

/**
 * Apply moving average smoothing to points
 * @param {Array} points - Input points
 * @param {number} windowSize - Smoothing window size
 * @returns {Array} Smoothed points
 */
export function movingAverage(points, windowSize) {
  if (points.length < 3) return points;

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

    smoothedPoints.push({
      x: sumX / count,
      y: sumY / count
    });
  }

  smoothedPoints.push(points[points.length - 1]);
  return smoothedPoints;
}

/**
 * Clamp a value between min and max
 * @param {number} value - Value to clamp
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} Clamped value
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Linear interpolation between two values
 * @param {number} a - Start value
 * @param {number} b - End value
 * @param {number} t - Interpolation factor (0-1)
 * @returns {number} Interpolated value
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}
