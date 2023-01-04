
function calcCatmullRomCurve(points, tension) {
  if (points.length < 2) {
    return points;
  }

  const smoothedPoints = [];
  const numPoints = points.length - 1;

  for (let i = 0; i < numPoints; i++) {
    const p0 = (i > 0) ? points[i - 1] : points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = (i !== numPoints - 1) ? points[i + 2] : p2;

    const cp1 = { x: p1.x + (tension * (p2.x - p0.x)) / 6, y: p1.y + (tension * (p2.y - p0.y)) / 6 };
    const cp2 = { x: p2.x - (tension * (p3.x - p1.x)) / 6, y: p2.y - (tension * (p3.y - p1.y)) / 6 };

    smoothedPoints.push(p1);
    smoothedPoints.push(cp1);
    smoothedPoints.push(cp2);
  }

  smoothedPoints.push(points[numPoints]);

  return smoothedPoints;
}


// Define a function to perform spline interpolation
function splineInterpolation(points, tension, numOfSegments) {
  // Calculate the coefficients for the spline curve
  const coefficients = calcNaturalCubicSpline(points, tension);

  // Initialize the interpolated points array
  const interpolatedPoints = [];

  // Generate the interpolated points
  for (let i = 0; i < points.length - 1; i++) {
    for (let t = 0; t < numOfSegments; t++) {
      const t1 = t / numOfSegments;
      const t2 = t1 * t1;
      const t3 = t2 * t1;

      // Calculate the x and y values for the interpolated point
      const x =
        (2 * t3 - 3 * t2 + 1) * points[i].x +
        (-2 * t3 + 3 * t2) * points[i + 1].x +
        (t3 - 2 * t2 + t1) * coefficients[i].a +
        (t3 - t2) * coefficients[i].b;
      const y =
        (2 * t3 - 3 * t2 + 1) * points[i].y +
        (-2 * t3 + 3 * t2) * points[i + 1].y +
        (t3 - 2 * t2 + t1) * coefficients[i].c +
        (t3 - t2) * coefficients[i].d;

      // Add the interpolated point to the array
      interpolatedPoints.push({ x, y });
    }
  }

  // Add the last point to the array
  interpolatedPoints.push(points[points.length - 1]);

  return interpolatedPoints;
}


// Define a function to draw a smooth curve through an array of points
function drawSmoothCurve(points, tension, ctx,  numOfSegments) {
  // Interpolate the points using spline interpolation
  const interpolatedPoints = splineInterpolation(points, tension, numOfSegments);

// Set the line width and stroke style
ctx.lineWidth = 3;
ctx.strokeStyle = 'red';
// Begin a new path
ctx.beginPath();

// Draw a curve through the interpolated points
for (let i = 0; i < interpolatedPoints.length; i++) {
const point = interpolatedPoints[i];
if (i === 0) {
ctx.moveTo(point.x, point.y);
} else {
ctx.lineTo(point.x, point.y);
}
}

// Stroke the path
ctx.stroke();
}
