// Quadtree class for storing points
class Quadtree {
  constructor(points, capacity) {
    this.capacity = capacity;
    this.points = points;
    this.bounds = this.getBounds(points);
    this.divided = false;

    this.subtrees = [];
    if (points.length > capacity) {
      this.divide();
    }
  }
// divide the quadtree into four subtrees
  divide() {
    const { x, y, w, h } = this.bounds;
    const points = this.points;

    const nePoints = [];
    const nwPoints = [];
    const sePoints = [];
    const swPoints = [];

    for (const point of points) {
      const { x: px, y: py } = point;
      if (px > x + w / 2) {
        if (py > y + h / 2) {
          sePoints.push(point);
        } else {
          nePoints.push(point);
        }
      } else {
        if (py > y + h / 2) {
          swPoints.push(point);
        } else {
          nwPoints.push(point);
        }
      }
    }

    this.subtrees[0] = new Quadtree(nwPoints, this.capacity);
    this.subtrees[1] = new Quadtree(nePoints, this.capacity);
    this.subtrees[2] = new Quadtree(sePoints, this.capacity);
    this.subtrees[3] = new Quadtree(swPoints, this.capacity);
    this.points = [];
    this.divided = true;
  }

  // query the quadtree for points within a given bounds
  query(bounds) {
    const result = [];
    if (!this.bounds.intersects(bounds)) {
      return result;
    }
    if (!this.divided) {
      return this.points.filter(point => bounds.contains(point));
    }
    for (const subtree of this.subtrees) {
      result.push(...subtree.query(bounds));
    }
    return result;
  }

  // count the number of points within a given bounds
  pointCount(bounds) {
    if (!this.bounds.intersects(bounds)) {
      return 0;
    }
    if (!this.divided) {
      return this.points.filter(point => bounds.contains(point)).length;
    }
    return this.subtrees.reduce((count, subtree) => count + subtree.pointCount(bounds), 0);
  }

  // get the bounds of a set of points
  getBounds(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      const { x, y } = point;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
}

class Bounds {
  constructor(points) {
    this.x = points.reduce((min, point) => Math.min(min, point.x), Infinity);
    this.y = points.reduce((min, point) => Math.min(min, point.y), Infinity);
    this.w = points.reduce((max, point) => Math.max(max, point.x), -Infinity) - this.x;
    this.h = points.reduce((max, point) => Math.max(max, point.y), -Infinity) - this.y;
  }

  // check if the bounds intersect with another bounds
  intersects(other) {
    return !(other.x > this.x + this.w || other.x + other.w < this.x ||
             other.y > this.y + this.h || other.y + other.h < this.y);
  }
}

// PriorityQueue class for storing elements with a priority
class PriorityQueue {
  constructor(comparator = (a, b) => a - b) {
    this.heap = [];
    this.comparator = comparator;
  }

  // add an element to the queue
  add(element) {
    this.heap.push(element);
    this.heapifyUp();
  }

  // remove and return the element with the highest priority
  poll() {
    const element = this.heap[0];
    this.heap[0] = this.heap[this.heap.length - 1];
    this.heap.pop();
    this.heapifyDown();
    return element;
  }

  // check if the queue is empty
  isEmpty() {
    return this.heap.length === 0;
  }
 // move an element up the heap
  heapifyUp(index = this.heap.length - 1) {
    let current = index;
    while (current > 0) {
      const parent = (current - 1) >>> 1;
      if (this.comparator(this.heap[current], this.heap[parent]) < 0) {
        [this.heap[current], this.heap[parent]] = [this.heap[parent], this.heap[current]];
        current = parent;
      } else {
        break;
      }
    }
  }

    // move an element down the heap
  heapifyDown(index = 0) {
    let current = index;
    while (true) {
      const left = (current << 1) + 1;
      const right = left + 1;
      let minIndex = current;
      if (left < this.heap.length && this.comparator(this.heap[left], this.heap[minIndex]) < 0) {
        minIndex = left;
      }
      if (right < this.heap.length && this.comparator(this.heap[right], this.heap[minIndex]) < 0) {
        minIndex = right;
      }
      if (minIndex !== current) {
        [this.heap[current], this.heap[minIndex]] = [this.heap[minIndex], this.heap[current]];
        current = minIndex;
      } else {
        break;
      }
    }
  }
}


function reduceLineWithQuadtree(points, maxPoints) {
  if (points.length <= maxPoints) {
    // no need to simplify if there are already fewer points than the maximum
    return points;
  }

  // create a quadtree to store the points
  const quadtree = new Quadtree(points, 4);

  // create a set to store the points that will be kept
  const keptPoints = new Set();

  // start by keeping the first and last points
  keptPoints.add(points[0]);
  keptPoints.add(points[points.length - 1]);

  // create a priority queue to store the points that will be processed
  const queue = new PriorityQueue((a, b) => b.priority - a.priority);

  // add the points in the middle of the line to the queue
  for (let i = 1; i < points.length - 1; i++) {
    queue.add({ point: points[i], priority: quadtree.pointCount(points[i]) });
  }

  // while the queue is not empty and the number of kept points is less than the maximum
  while (!queue.isEmpty() && keptPoints.size < maxPoints) {
    // remove the point with the highest priority (i.e., the point with the most neighbors)
    const { point } = queue.poll();

    // if the point has not already been kept
    if (!keptPoints.has(point)) {
      // keep the point and add its neighbors to the queue
      keptPoints.add(point);
      quadtree.query(point).forEach(neighbor => queue.add({ point: neighbor, priority: quadtree.pointCount(neighbor) }));
    }
  }

  // return the kept points as an array
  return Array.from(keptPoints);
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
