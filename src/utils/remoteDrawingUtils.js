/**
 * Remote Drawing Utilities - Shared drawing functions for remote user synchronization
 * Used by RemoteUserHandler and its extracted modules
 */

/**
 * Bridge gap between two points with interpolated filled circles (flow-pen style)
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Object} from - Start position {x, y}
 * @param {Object} to - End position {x, y}
 * @param {number} fromRadius - Start radius
 * @param {number} toRadius - End radius
 * @param {Object} user - User object with color, opacity, hardness
 * @param {string} blendMode - Blend mode to use (default 'source-over')
 */
export function bridgeGap(ctx, from, to, fromRadius, toRadius, user, blendMode = 'source-over') {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  const opacity = user.opacity !== undefined ? user.opacity : 1;
  const hardness = user.hardness !== undefined ? user.hardness : 1.0;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.globalCompositeOperation = blendMode;
  ctx.fillStyle = user.getColorString();

  if (hardness < 1.0) {
    // Hybrid blur: 20px base + 20% of size gives consistent softness across all brush sizes
    const blurAmount = (1 - hardness) * (20 + user.size * 0.2);
    const offset = 100000;
    ctx.shadowBlur = blurAmount;
    ctx.shadowColor = user.getColorString();
    ctx.shadowOffsetX = -offset;
    ctx.shadowOffsetY = 0;
    ctx.translate(offset, 0);
  }

  if (dist < 0.5) {
    const r = Math.max(fromRadius, toRadius);
    ctx.beginPath();
    ctx.arc(from.x, from.y, Math.max(0.5, r), 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Adaptive spacing (20% of average radius, like flow pen)
    const avgRadius = (fromRadius + toRadius) / 2;
    const step = Math.max(1, avgRadius * 0.2);
    const steps = Math.ceil(dist / step);

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = from.x + dx * t;
      const y = from.y + dy * t;
      const r = fromRadius + (toRadius - fromRadius) * t;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

/**
 * Draw a line array with smoothing and hardness support
 * @param {Array} points - Array of {x, y} points
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Object} user - User object with drawing properties
 * @param {string} blendMode - Blend mode to use (default 'source-over')
 */
export function drawLineArray(points, ctx, user, blendMode = 'source-over') {
  if (points.length === 0) return;

  // Explicitly set ALL context properties to ensure consistency
  const opacity = user.opacity !== undefined ? user.opacity : 1;
  const hardness = user.hardness !== undefined ? user.hardness : 1.0;

  ctx.globalAlpha = opacity;
  ctx.globalCompositeOperation = blendMode;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = user.pressure * user.size * 2;

  // Apply softness using shadow blur (hardness controls blur amount)
  // For soft brushes, draw off-screen and use shadow only
  if (hardness < 1.0) {
    // Hybrid blur: 20px base + 20% of size gives consistent softness across all brush sizes
    const blurAmount = (1 - hardness) * (20 + user.size * 0.2);
    const offset = 100000;

    ctx.strokeStyle = user.getColorString();
    ctx.shadowBlur = blurAmount;
    ctx.shadowColor = user.getColorString();
    ctx.shadowOffsetX = -offset;
    ctx.shadowOffsetY = 0;

    ctx.save();
    ctx.translate(offset, 0);
  } else {
    ctx.strokeStyle = user.getColorString();
    ctx.shadowBlur = 0;
  }

  const smoothing = user.smoothing || 0;

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  if (points.length === 1) {
    // Single point - draw a dot
    ctx.lineTo(points[0].x, points[0].y);
  } else if (points.length === 2 || smoothing === 0) {
    // Two points or no smoothing - straight lines
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
  } else {
    // 3+ points with smoothing: quadratic curves with control point
    // interpolated based on smoothing level
    // smoothing=0: straight line, smoothing=1: full curve through point

    let prevX = points[0].x;
    let prevY = points[0].y;

    for (let i = 1; i < points.length; i++) {
      const curr = points[i];

      if (i < points.length - 1) {
        // Not the last point - curve to midpoint
        const next = points[i + 1];
        const midX = (curr.x + next.x) / 2;
        const midY = (curr.y + next.y) / 2;

        // Interpolate control point: at smoothing=0, cp is on the line
        // at smoothing=1, cp is at the actual point
        const linearCpX = (prevX + midX) / 2;
        const linearCpY = (prevY + midY) / 2;
        const cpX = linearCpX + (curr.x - linearCpX) * smoothing;
        const cpY = linearCpY + (curr.y - linearCpY) * smoothing;

        ctx.quadraticCurveTo(cpX, cpY, midX, midY);
        prevX = midX;
        prevY = midY;
      } else {
        // Last point - curve to it
        const linearCpX = (prevX + curr.x) / 2;
        const linearCpY = (prevY + curr.y) / 2;
        const cpX = linearCpX + (curr.x - linearCpX) * smoothing;
        const cpY = linearCpY + (curr.y - linearCpY) * smoothing;

        ctx.quadraticCurveTo(cpX, cpY, curr.x, curr.y);
      }
    }
  }

  ctx.stroke();

  // Reset shadow and restore context if using soft brush
  if (hardness < 1.0) {
    ctx.restore();
  }
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.globalAlpha = 1.0;
}
