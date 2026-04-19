/**
 * @fileoverview Circle Blur tool - samples and averages pixels in a circular area,
 * then stamps a solid circle with that averaged color. Much more efficient than true blur.
 */

/**
 * Base tool class.
 */
class Tool {
  /**
   * @param {string} name - The name of the tool.
   * @param {Object} board - The drawing board instance.
   */
  constructor(name, board) {
    this.name = name;
    this.board = board;
  }

  /**
   * Called when the tool is activated.
   */
  activate() {}

  /**
   * Called when the tool is deactivated.
   */
  deactivate() {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerDown(user, pos, e) {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerMove(user, pos, lastPos, e) {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerUp(user, pos, e) {}
}

/**
 * Circle Blur tool - samples pixels and stamps averaged color circles.
 * Uses sparse sampling for efficiency (no expensive blur operations).
 */
export class CircleBlurTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('circleBlur', board);
    this.lastStampPos = new Map(); // userId -> {x, y, radius}
    this.stampBuffer = []; // [x, y, radius, x, y, radius, ...] for broadcast
    this.strokePoints = []; // Track points for tile ownership
  }

  /**
   * Activates the tool.
   */
  activate() {}

  /**
   * Deactivates the tool and cleans up tracking.
   */
  deactivate() {
    if (this._activeUser && this.lastStampPos.has(this._activeUser.id)) {
      this.onPointerUp(this._activeUser);
    }
    this.lastStampPos.clear();
    this._activeUser = null;
  }

  /**
   * Handles pointer down event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerDown(user, pos) {
    this._activeUser = user;
    this.board.beginStroke(user);
    const radius = user.pressure * user.size;

    this.strokePoints = [{ x: pos.x, y: pos.y }];

    // Stamp averaged circle (now synchronous and fast)
    this.stampBlurredCircle(pos.x, pos.y, radius, user);

    // Store for broadcasting (fixes missing first point in remote/replay)
    this.stampBuffer.push(pos.x, pos.y, radius);

    this.board.forEachMirrorRegion({ point: pos }, (region) => {
      const mirrored = this.board.mirrorPointToRegion(pos, region);
      this.stampBlurredCircle(mirrored.x, mirrored.y, radius, user, region);
    });

    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y, radius });
  }

  /**
   * Handles pointer move event.
   * Uses batched getImageData for performance - fetches pixel data once for all stamps.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   */
  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    const radius = user.pressure * user.size;
    const lastStamp = this.lastStampPos.get(user.id);

    if (lastStamp) {
      const dx = pos.x - lastStamp.x;
      const dy = pos.y - lastStamp.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      const avgRadius = (lastStamp.radius + radius) / 2;
      const spacingPercent = 0.3 + user.spacing * 0.035;
      const minSpacing = Math.max(5, avgRadius * spacingPercent);

      if (distance >= minSpacing) {
        const steps = Math.floor(distance / minSpacing);

        // Pre-calculate all stamp positions
        const stamps = [];
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const sx = lastStamp.x + dx * t;
          const sy = lastStamp.y + dy * t;
          const sr = lastStamp.radius + (radius - lastStamp.radius) * t;
          stamps.push({ x: sx, y: sy, r: sr });
        }

        // Calculate bounding box for all stamps (with sample radius padding)
        const canvasWidth = this.board.getWidth();
        const canvasHeight = this.board.getHeight();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        for (const stamp of stamps) {
          const sampleRadius = Math.min(stamp.r * 1.2, stamp.r + 10);
          minX = Math.min(minX, stamp.x - sampleRadius);
          minY = Math.min(minY, stamp.y - sampleRadius);
          maxX = Math.max(maxX, stamp.x + sampleRadius);
          maxY = Math.max(maxY, stamp.y + sampleRadius);

          // Include mirrored stamps in bbox calculation
          this.board.forEachMirrorRegion({ point: stamp }, (region) => {
            const mirrored = this.board.mirrorPointToRegion(stamp, region);
            minX = Math.min(minX, mirrored.x - sampleRadius);
            minY = Math.min(minY, mirrored.y - sampleRadius);
            maxX = Math.max(maxX, mirrored.x + sampleRadius);
            maxY = Math.max(maxY, mirrored.y + sampleRadius);
          });
        }

        // Clamp to canvas bounds
        const left = Math.max(0, Math.floor(minX));
        const top = Math.max(0, Math.floor(minY));
        const right = Math.min(canvasWidth, Math.ceil(maxX));
        const bottom = Math.min(canvasHeight, Math.ceil(maxY));
        const width = right - left;
        const height = bottom - top;

        // Fetch imageData once for the entire batch
        let cachedImageData = null;
        if (width > 0 && height > 0) {
          cachedImageData = this.board.mainCtx.getImageData(left, top, width, height);
        }

        // Now stamp using cached data
        for (const stamp of stamps) {
          this.stampBlurredCircleFromCache(stamp.x, stamp.y, stamp.r, user, cachedImageData, left, top);
          this.stampBuffer.push(stamp.x, stamp.y, stamp.r);
          this.strokePoints.push({ x: stamp.x, y: stamp.y });

          this.board.forEachMirrorRegion({ point: stamp }, (region) => {
            const mirrored = this.board.mirrorPointToRegion(stamp, region);
            this.stampBlurredCircleFromCache(mirrored.x, mirrored.y, stamp.r, user, cachedImageData, left, top, region);
          });
        }

        this.lastStampPos.set(user.id, { x: pos.x, y: pos.y, radius });
      }
    }
  }

  /**
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   */
  onPointerUp(user) {
    // Track tile ownership
    if (this.strokePoints.length > 0) {
      const radius = user.size;
      this.board.markDirtyPath(user, this.strokePoints, radius);
      this.board.forEachMirrorRegion({ points: this.strokePoints }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(this.strokePoints, region), radius);
      });
    }
    this.strokePoints = [];

    this.board.endStroke(user);
    this.lastStampPos.delete(user.id);
  }

  /**
   * Drains accumulated stamp positions for network broadcast.
   * @returns {{ps: number[], rs: number[]}}
   */
  drainStampBuffer() {
    const buf = this.stampBuffer;
    this.stampBuffer = [];
    const ps = [];
    const rs = [];
    for (let i = 0; i < buf.length; i += 3) {
      ps.push(buf[i], buf[i + 1]);
      rs.push(buf[i + 2]);
    }
    return { ps, rs };
  }

  /**
   * Applies pre-computed stamp positions received from the network (remote users).
   * Uses batched getImageData for performance.
   * @param {Object} user - The remote user.
   * @param {number[]} ps - Flat [x, y, x, y, ...] stamp positions.
   * @param {number[]} rs - Radii, one per stamp.
   */
  applyStamps(user, ps, rs) {
    if (ps.length === 0) return;

    const canvasWidth = this.board.getWidth();
    const canvasHeight = this.board.getHeight();

    // Build stamp list and calculate bounding box
    const stamps = [];
    const points = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (let i = 0, j = 0; i < ps.length; i += 2, j++) {
      const sx = Number(ps[i]), sy = Number(ps[i + 1]), sr = Number(rs[j]);
      
      // Skip stamps with invalid or NaN coordinates/radius
      if (isNaN(sx) || isNaN(sy) || isNaN(sr) || sr <= 0) continue;

      stamps.push({ x: sx, y: sy, r: sr });
      points.push({ x: sx, y: sy });

      const sampleRadius = Math.min(sr * 1.2, sr + 10);
      minX = Math.min(minX, sx - sampleRadius);
      minY = Math.min(minY, sy - sampleRadius);
      maxX = Math.max(maxX, sx + sampleRadius);
      maxY = Math.max(maxY, sy + sampleRadius);

      this.board.forEachMirrorRegion({ point: { x: sx, y: sy } }, (region) => {
        const mirrored = this.board.mirrorPointToRegion({ x: sx, y: sy }, region);
        minX = Math.min(minX, mirrored.x - sampleRadius);
        minY = Math.min(minY, mirrored.y - sampleRadius);
        maxX = Math.max(maxX, mirrored.x + sampleRadius);
        maxY = Math.max(maxY, mirrored.y + sampleRadius);
      });
    }

    // Clamp to canvas bounds
    const left = Math.max(0, Math.floor(minX));
    const top = Math.max(0, Math.floor(minY));
    const right = Math.min(canvasWidth, Math.ceil(maxX));
    const bottom = Math.min(canvasHeight, Math.ceil(maxY));
    const width = right - left;
    const height = bottom - top;

    // Fetch imageData once
    let cachedImageData = null;
    if (width > 0 && height > 0) {
      cachedImageData = this.board.mainCtx.getImageData(left, top, width, height);
    }

    // Apply all stamps
    for (const stamp of stamps) {
      this.stampBlurredCircleFromCache(stamp.x, stamp.y, stamp.r, user, cachedImageData, left, top);
      this.board.forEachMirrorRegion({ point: stamp }, (region) => {
        const mirrored = this.board.mirrorPointToRegion(stamp, region);
        this.stampBlurredCircleFromCache(mirrored.x, mirrored.y, stamp.r, user, cachedImageData, left, top, region);
      });
    }

    // Track tile ownership for remote user
    if (points.length > 0) {
      const radius = user.size;
      this.board.markDirtyPath(user, points, radius);
      this.board.forEachMirrorRegion({ points }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(points, region), radius);
      });
    }
  }

  /**
   * Stamp a circle with the average color sampled from the canvas area.
   * Much more efficient than blur - samples pixels sparsely and averages them.
   * @param {number} x - Center x-coordinate.
   * @param {number} y - Center y-coordinate.
   * @param {number} radius - Stamp radius.
   * @param {Object} user - The user performing the action.
   */
  stampBlurredCircle(x, y, radius, user, clipRegion = null) {
    const canvasWidth = this.board.getWidth();
    const canvasHeight = this.board.getHeight();

    if (radius <= 0) return;

    const activeLayer = user.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
    const userId = user.id ?? this.board.app?.self?.id ?? 0;
    const strokeCtx = this.board.layerManager?.getUserStrokeContext(activeLayer, userId);
    if (!strokeCtx) return;

    // Sample area slightly larger than the circle for better averaging
    const sampleRadius = Math.min(radius * 1.2, radius + 10);
    const left = Math.max(0, Math.floor(x - sampleRadius));
    const top = Math.max(0, Math.floor(y - sampleRadius));
    const right = Math.min(canvasWidth, Math.ceil(x + sampleRadius));
    const bottom = Math.min(canvasHeight, Math.ceil(y + sampleRadius));
    const width = right - left;
    const height = bottom - top;

    if (width <= 0 || height <= 0) return;

    // Get pixel data from the main canvas
    const imageData = this.board.mainCtx.getImageData(left, top, width, height);

    // Use shared sampling logic
    const color = this._sampleAverageColor(imageData.data, width, height, x - left, y - top, sampleRadius, radius);
    if (!color) return;

    if (clipRegion) {
      this.board.withMirrorRegionClip(strokeCtx, clipRegion, () => {
        this._drawBlurCircle(strokeCtx, x, y, radius, color, user);
      });
    } else {
      this._drawBlurCircle(strokeCtx, x, y, radius, color, user);
    }

    // Mark dirty rect
    this.board.expandDirtyRect(user,
      Math.floor(x - radius - 2), Math.floor(y - radius - 2),
      Math.ceil(radius * 2 + 4), Math.ceil(radius * 2 + 4));

    this.board.requestUpdate();
  }

  /**
   * Stamp a circle using pre-fetched cached imageData.
   * Avoids repeated getImageData calls when processing multiple stamps.
   * @param {number} x - Center x-coordinate.
   * @param {number} y - Center y-coordinate.
   * @param {number} radius - Stamp radius.
   * @param {Object} user - The user performing the action.
   * @param {ImageData} cachedImageData - Pre-fetched pixel data.
   * @param {number} cacheLeft - Left offset of cached region.
   * @param {number} cacheTop - Top offset of cached region.
   */
  stampBlurredCircleFromCache(x, y, radius, user, cachedImageData, cacheLeft, cacheTop, clipRegion = null) {
    if (radius <= 0 || !cachedImageData) return;

    const activeLayer = user.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
    const userId = user.id ?? this.board.app?.self?.id ?? 0;
    const strokeCtx = this.board.layerManager?.getUserStrokeContext(activeLayer, userId);
    if (!strokeCtx) return;

    const sampleRadius = Math.min(radius * 1.2, radius + 10);

    // Calculate position within the cached data
    const localCx = x - cacheLeft;
    const localCy = y - cacheTop;

    // Use shared sampling logic
    const color = this._sampleAverageColor(
      cachedImageData.data,
      cachedImageData.width,
      cachedImageData.height,
      localCx,
      localCy,
      sampleRadius,
      radius
    );
    if (!color) return;

    if (clipRegion) {
      this.board.withMirrorRegionClip(strokeCtx, clipRegion, () => {
        this._drawBlurCircle(strokeCtx, x, y, radius, color, user);
      });
    } else {
      this._drawBlurCircle(strokeCtx, x, y, radius, color, user);
    }

    // Mark dirty rect
    this.board.expandDirtyRect(user,
      Math.floor(x - radius - 2), Math.floor(y - radius - 2),
      Math.ceil(radius * 2 + 4), Math.ceil(radius * 2 + 4));

    this.board.requestUpdate();
  }

  /**
   * Sample average color from pixel data within a circular region.
   * @param {Uint8ClampedArray} data - RGBA pixel data.
   * @param {number} width - Data width.
   * @param {number} height - Data height.
   * @param {number} cx - Center x in local coords.
   * @param {number} cy - Center y in local coords.
   * @param {number} sampleRadius - Radius to sample within.
   * @param {number} stampRadius - Stamp radius (for adaptive sampling).
   * @returns {{r: number, g: number, b: number, a: number}|null}
   * @private
   */
  _sampleAverageColor(data, width, height, cx, cy, sampleRadius, stampRadius) {
    const sampleStep = Math.max(2, Math.floor(stampRadius / 10));
    let r = 0, g = 0, b = 0, a = 0;
    let count = 0;
    const rSquared = sampleRadius * sampleRadius;

    // Calculate bounds to sample within
    const startX = Math.max(0, Math.floor(cx - sampleRadius));
    const startY = Math.max(0, Math.floor(cy - sampleRadius));
    const endX = Math.min(width, Math.ceil(cx + sampleRadius));
    const endY = Math.min(height, Math.ceil(cy + sampleRadius));

    for (let py = startY; py < endY; py += sampleStep) {
      for (let px = startX; px < endX; px += sampleStep) {
        const dx = px - cx;
        const dy = py - cy;
        if (dx * dx + dy * dy <= rSquared) {
          const idx = (py * width + px) * 4;
          const pixelAlpha = data[idx + 3] / 255;
          if (pixelAlpha > 0.01) {
            r += data[idx] * pixelAlpha;
            g += data[idx + 1] * pixelAlpha;
            b += data[idx + 2] * pixelAlpha;
            a += pixelAlpha;
            count++;
          }
        }
      }
    }

    if (count === 0) return null;

    return {
      r: Math.round(r / a),
      g: Math.round(g / a),
      b: Math.round(b / a),
      a: a / count
    };
  }

  /**
   * Draw the blur circle with the computed color.
   * @param {CanvasRenderingContext2D} ctx - Drawing context.
   * @param {number} x - Center x.
   * @param {number} y - Center y.
   * @param {number} radius - Circle radius.
   * @param {{r: number, g: number, b: number, a: number}} color - Averaged color.
   * @param {Object} user - User object for opacity/hardness.
   * @private
   */
  _drawBlurCircle(ctx, x, y, radius, color, user) {
    const { r, g, b } = color;
    const hardness = user.hardness !== undefined ? user.hardness / 100 : 1.0;

    ctx.save();
    ctx.globalAlpha = user.opacity !== undefined ? user.opacity : 1;

    if (hardness < 1.0) {
      const innerR = radius * hardness;
      const grad = ctx.createRadialGradient(x, y, innerR, x, y, radius);
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 1)`;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }
}
