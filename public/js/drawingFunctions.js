function quadraticCurve(points) {
  // Initialize an empty array to store the quadratic curve points
  var quadraticPoints = [];
  
  // Loop through the points array and generate the quadratic curve points
  for (var i = 0; i < points.length - 2; i++) {
    // Get the current point and the next two points
    var point1 = points[i];
    var point2 = points[i + 1];
    var point3 = points[i + 2];
    
    // Calculate the control point for the quadratic curve
    var controlPointX = (point1.x + point2.x * 2 + point3.x) / 4;
    var controlPointY = (point1.y + point2.y * 2 + point3.y) / 4;
    var controlPoint = {x: controlPointX, y: controlPointY};
    
    // Add the quadratic curve point to the quadraticPoints array
    quadraticPoints.push({
      point1: point1,
      point2: controlPoint,
      point3: point2
    });
  }
  
  // Return the array of quadratic curve points
  return quadraticPoints;
}

function drawQuadraticCurve(canvas, quadraticCurve) {
  // Get the canvas context
  var ctx = canvas.getContext('2d');
  
  // Set the stroke style for the curve
  ctx.strokeStyle = 'black';
  
  // Begin a new path
  ctx.beginPath();
  
  // Set the starting point of the curve to be the first point of the quadratic curve
  ctx.moveTo(quadraticCurve.point1.x, quadraticCurve.point1.y);
  
  // Use the quadraticCurveTo() method to draw the curve
  ctx.quadraticCurveTo(
    quadraticCurve.point2.x,  // control point x
    quadraticCurve.point2.y,  // control point y
    quadraticCurve.point3.x,  // end point x
    quadraticCurve.point3.y   // end point y
  );
  
  // Stroke the curve
  ctx.stroke();
}

function movingAverage(points, windowSize) {
  // Create a new array to hold the smoothed points
  const smoothedPoints = [points[0]]; // Add the first point to the array
  
  // Loop through the points, starting at the second point
  for (let i = 1; i < points.length - 1; i++) {
    // Calculate the average of the current point and the previous "windowSize" points
    let sumX = 0;
    let sumY = 0;
    for (let j = i - windowSize; j <= i + windowSize; j++) {
      if (j >= 0 && j<points.length){
        console.log(j,points[j]);
        sumX += points[j].x;
        sumY += points[j].y;
      }
    }
    const avgX = sumX / (windowSize * 2 + 1);
    const avgY = sumY / (windowSize * 2 + 1);
    
    // Add the new smoothed point to the array
    smoothedPoints.push({ x: avgX, y: avgY });
  }
  
  // Add the last point to the array
  smoothedPoints.push(points[points.length - 1]);
  
  // Return the array of smoothed points
  return smoothedPoints;
}




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
