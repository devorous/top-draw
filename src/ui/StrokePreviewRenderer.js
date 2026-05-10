export function prepareStrokePreviewCanvas(canvas, board) {
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  resetPreviewContext(ctx);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const bgColor = board?.backgroundColor || [255, 255, 255, 1];
  ctx.fillStyle = `rgba(${bgColor[0]}, ${bgColor[1]}, ${bgColor[2]}, ${bgColor[3] ?? 1})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return ctx;
}

export function resetPreviewContext(ctx) {
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'rgba(0, 0, 0, 0)';
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineDashOffset = 0;
  ctx.setLineDash?.([]);
  ctx.imageSmoothingEnabled = true;
}

export function buildPreviewStrokePoints(canvas, count = 50) {
  const points = [];
  if (!canvas || count <= 0) return points;

  const padding = Math.max(18, Math.min(28, canvas.width * 0.12));
  const startX = padding;
  const endX = canvas.width - padding;
  const midY = canvas.height / 2;
  const amplitude = Math.max(10, canvas.height * 0.22);

  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const pressure = Math.sin(Math.PI * t);
    const x = startX + (endX - startX) * t;
    const y = midY + Math.sin((t * Math.PI * 2) - Math.PI / 6) * amplitude;
    points.push({
      x,
      y,
      t,
      pressure: Math.max(0.05, pressure)
    });
  }

  return points;
}

export function drawPreviewStrokeGuide(ctx, points, color = [0, 0, 0]) {
  if (!ctx || !points?.length) return;
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = `rgba(${color[0] ?? 0}, ${color[1] ?? 0}, ${color[2] ?? 0}, 0.45)`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();
  ctx.restore();
}

export function getPreviewPointAngle(points, index) {
  const point = points[index];
  const next = points[Math.min(points.length - 1, index + 1)];
  const prev = points[Math.max(0, index - 1)];
  const dx = (next?.x ?? point.x) - (prev?.x ?? point.x);
  const dy = (next?.y ?? point.y) - (prev?.y ?? point.y);
  return Math.atan2(dy, dx || 1);
}

export function drawTaperedStroke(ctx, points, user, options = {}) {
  if (!ctx || !points?.length) return;
  const color = user?.color || [0, 0, 0];
  const opacity = options.opacity ?? user?.opacity ?? color[3] ?? 1;
  const previewSize = options.previewSize ?? 25;
  const sizeScale = options.sizeScale ?? 0.34;
  const baseRadius = Math.max(0.5, previewSize * sizeScale);
  const hardness = Math.max(0, Math.min(100, Number(user?.hardness ?? 100))) / 100;
  const blurAmount = hardness < 1 ? (1 - hardness) * (8 + baseRadius * 1.2) : 0;
  const targetCanvas = ctx.canvas;

  // Draw the raw stroke to an offscreen canvas without blur first
  const strokeCanvas = document.createElement('canvas');
  strokeCanvas.width = targetCanvas.width;
  strokeCanvas.height = targetCanvas.height;
  const strokeCtx = strokeCanvas.getContext('2d');
  if (!strokeCtx) return;

  strokeCtx.save();
  strokeCtx.lineCap = 'round';
  strokeCtx.lineJoin = 'round';
  strokeCtx.strokeStyle = `rgb(${color[0] ?? 0}, ${color[1] ?? 0}, ${color[2] ?? 0})`;

  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1];
    const point = points[i];
    const pressure = Math.max(0.05, (previous.pressure + point.pressure) / 2);
    strokeCtx.lineWidth = Math.max(1, baseRadius * pressure * 2);
    strokeCtx.beginPath();
    strokeCtx.moveTo(previous.x, previous.y);
    strokeCtx.lineTo(point.x, point.y);
    strokeCtx.stroke();
  }
  strokeCtx.restore();

  // Composite the offscreen stroke onto the target canvas
  ctx.save();
  ctx.globalAlpha = opacity;

  if (blurAmount > 0) {
    // Offset trick: draw the source off-screen and let only the shadow fall on the target
    const offset = 10000;
    ctx.shadowBlur = blurAmount;
    ctx.shadowColor = `rgb(${color[0] ?? 0}, ${color[1] ?? 0}, ${color[2] ?? 0})`;
    ctx.shadowOffsetX = offset;
    ctx.shadowOffsetY = 0;
    ctx.drawImage(strokeCanvas, -offset, 0);
  } else {
    ctx.drawImage(strokeCanvas, 0, 0);
  }

  ctx.restore();
}
