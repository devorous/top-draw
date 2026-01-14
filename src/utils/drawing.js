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
