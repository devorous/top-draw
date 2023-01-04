
function calcCatmullRomCurve(points, tension) {
  // Initialize the curve points array
  const curvePoints = [];

  // Add the first point to the curve points array
  curvePoints.push(points[0]);

  // Iterate over the points and generate the curve points
  for (let i = 1; i < points.length - 2; i++) {
    for (let t = 0; t < 1; t += 0.1) {
      const t1 = t;
      const t2 = t1 * t1;
      const t3 = t2 * t1;

      // Calculate the x and y values for the curve point
      const x =
        ((2 * points[i].x) +
          (-points[i - 1].x + points[i + 1].x) * t1 +
          (2 * points[i - 1].x - 5 * points[i].x + 4 * points[i + 1].x - points[i + 2].x) * t2 +
          (-points[i - 1].x + 3 * points[i].x - 3 * points[i + 1].x + points[i + 2].x) * t3) *
        tension;
      const y =
        ((2 * points[i].y) +
          (-points[i - 1].y + points[i + 1].y) * t1 +
          (2 * points[i - 1].y - 5 * points[i].y + 4 * points[i + 1].y - points[i + 2].y) * t2 +
          (-points[i - 1].y + 3 * points[i].y - 3 * points[i + 1].y + points[i + 2].y) * t3) *
        tension;

      // Add the curve point to the array
      curvePoints.push({ x, y });
    }
  }

  // Add the last point to the curve points array
  curvePoints.push(points[points.length - 1]);

  return curvePoints;
}

function calcNaturalCubicSpline(points, tension) {
  // Calculate the number of points
  const numPoints = points.length;

  // Initialize the coefficients array
  const coefficients = [];

  // Special case for the first point
  coefficients[0] = {
    a: 0,
    b: 2,
    c: 1,
    d: (points[1].y - points[0].y) / 2,
  };

  // Special case for the last point
  coefficients[numPoints - 1] = {
    a: (points[numPoints - 1].y - points[numPoints - 2].y) / 2,
    b: 2,
    c: 1,
    d: 0,
  };

  // Iterate over the remaining points
  for (let i = 1; i < numPoints - 1; i++) {
    const prevPoint = points[i - 1];
    const currPoint = points[i];
    const nextPoint = points[i + 1];

    coefficients[i] = {
      a: (nextPoint.y - currPoint.y) / 2 - (currPoint.y - prevPoint.y) / 2,
      b: 2 * currPoint.y - 2 * nextPoint.y + (nextPoint.y - prevPoint.y) / tension,
      c: (nextPoint.y - prevPoint.y) / tension - 2 * currPoint.y + 2 * prevPoint.y,
      d: currPoint.y,
    };
  }

  return coefficients;
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
