/** @fileoverview Handles pen and flowPen tool rendering for remote users using offscreen canvasing. */

/**
 * Handles pen/flowPen tool rendering for remote users.
 * Uses an offscreen canvas to prevent opacity stacking during a single stroke.
 */
export class RemotePenHandler {
  /**
   * @param {Board} board - The main board instance.
   */
  constructor(board) {
    this.board = board;
  }

  /**
   * Ensures the user has a valid offscreen canvas for pen rendering.
   * @param {User} user - The remote user object.
   */
  ensurePenOffscreen(user) {
    const width = this.board.getWidth();
    const height = this.board.getHeight();
    if (!user._penOffscreen || user._penOffscreen.width !== width || user._penOffscreen.height !== height) {
      user._penOffscreen = document.createElement('canvas');
      user._penOffscreen.width = width;
      user._penOffscreen.height = height;
      user._penOffscreenCtx = user._penOffscreen.getContext('2d');
    }
  }

  /**
   * Initializes a new pen stroke for a remote user.
   * @param {User} user - The remote user object.
   * @param {Object} pos - The starting coordinates {x, y}.
   */
  handlePenDown(user, pos) {
    this.ensurePenOffscreen(user);

    user._penOffscreenCtx.clearRect(0, 0, user._penOffscreen.width, user._penOffscreen.height);

    const pressure = Math.round(user.pressure * 255) / 255;
    const radius = pressure * user.size;

    const color = user.color.slice(0, 3);
    user._penStrokeColor = `rgb(${color.join(',')})`;
    user._penOffscreenCtx.fillStyle = user._penStrokeColor;

    const colorAlpha = user.color[3];
    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    user._penAlpha = colorAlpha * opacitySlider;
    user._penHardness = user.hardness !== undefined ? user.hardness / 100 : 1.0;

    const ctx = user._penOffscreenCtx;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, Math.max(0.5, radius), 0, Math.PI * 2);
    ctx.fill();

    user._penLastStampPos = { x: pos.x, y: pos.y, radius };
    user._penStrokeActive = true;
    user.penPoints = [{ x: pos.x, y: pos.y, radius }];

    this.updatePenPreview(user);
  }

  /**
   * Processes incoming stamp points and radii for an active pen stroke.
   * @param {User} user - The remote user object.
   * @param {number[]} points - Flat array of [x, y, x, y, ...] coordinates.
   * @param {number[]} radii - Array of radius values (0-255).
   */
  handlePenStamps(user, points, radii) {
    if (points.length < 2) return;

    if (!user._penStrokeActive) {
      user.clearLine();
      this.handlePenDown(user, { x: points[0], y: points[1] });
    }

    const ctx = user._penOffscreenCtx;
    ctx.fillStyle = user._penStrokeColor;

    for (let i = 0, ri = 0; i < points.length; i += 2, ri++) {
      const x = points[i];
      const y = points[i + 1];
      const pressure = radii[ri] / 255;
      const r = pressure * user.size;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
      ctx.fill();
      if (user.penPoints) {
        user.penPoints.push({ x, y, radius: r });
      }
    }

    const lastPtIdx = points.length - 2;
    const lastPressure = radii[radii.length - 1] / 255;
    const lastR = lastPressure * user.size;
    user._penLastStampPos = { x: points[lastPtIdx], y: points[lastPtIdx + 1], radius: lastR };
    user.setPosition(points[lastPtIdx], points[lastPtIdx + 1]);
    this.updatePenPreview(user);
  }

  /**
   * Handles individual pen movement events and applies adaptive spacing.
   * @param {User} user - The remote user object.
   * @param {Object} pos - The new coordinates {x, y}.
   */
  handlePenMove(user, pos) {
    if (!user._penLastStampPos || !user._penOffscreenCtx) return;

    const pressure = Math.round(user.pressure * 255) / 255;
    const radius = pressure * user.size;
    const dx = pos.x - user._penLastStampPos.x;
    const dy = pos.y - user._penLastStampPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > 0.5) {
      const ctx = user._penOffscreenCtx;
      ctx.fillStyle = user._penStrokeColor;

      // Interpolate circles for smooth coverage
      this._interpolateStrokeRemote(
        ctx,
        user._penLastStampPos.x,
        user._penLastStampPos.y,
        user._penLastStampPos.radius,
        pos.x,
        pos.y,
        radius
      );

      user._penLastStampPos = { x: pos.x, y: pos.y, radius };
      if (user.penPoints) {
        user.penPoints.push({ x: pos.x, y: pos.y, radius });
      }

      this.updatePenPreview(user);
    }
  }

  /**
   * Interpolates and draws circles between two positions.
   */
  _interpolateStrokeRemote(ctx, x1, y1, r1, x2, y2, r2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const distance = Math.sqrt(dx * dx + dy * dy);

    const avgRadius = (r1 + r2) / 2;
    const spacing = Math.max(1, avgRadius * 0.2);

    if (distance < spacing) {
      ctx.beginPath();
      ctx.arc(x2, y2, Math.max(0.5, r2), 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    const steps = Math.ceil(distance / spacing);
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      const x = x1 + dx * t;
      const y = y1 + dy * t;
      const r = r1 + (r2 - r1) * t;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Finalizes and commits a pen stroke to the board layers.
   * @param {User} user - The remote user object.
   */
  handlePenUp(user) {
    if (!user._penLastStampPos || !user._penOffscreen) return;

    // Track dirty rect from pen stamp points to avoid expensive getImageData on commit
    if (user.penPoints && user.penPoints.length > 0) {
      const hardness = user._penHardness !== undefined ? user._penHardness : 1.0;
      const blurAmount = (1 - hardness) * (20 + user.size * 0.2);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of user.penPoints) {
        const r = pt.radius || user.size;
        if (pt.x - r < minX) minX = pt.x - r;
        if (pt.x + r > maxX) maxX = pt.x + r;
        if (pt.y - r < minY) minY = pt.y - r;
        if (pt.y + r > maxY) maxY = pt.y + r;
      }
      const margin = blurAmount + 2;
      const x = Math.floor(minX - margin);
      const y = Math.floor(minY - margin);
      const w = Math.ceil(maxX - minX + margin * 2);
      const h = Math.ceil(maxY - minY + margin * 2);
      this.board.expandDirtyRect(user, x, y, w, h);
      this.board.forEachMirrorRegion({ rect: { x, y, width: w, height: h } }, (region) => {
        const p1 = this.board.mirrorPointToRegion({ x: minX, y: minY }, region);
        const p2 = this.board.mirrorPointToRegion({ x: maxX, y: maxY }, region);
        const mx = Math.floor(Math.min(p1.x, p2.x) - margin);
        const my = Math.floor(Math.min(p1.y, p2.y) - margin);
        const mw = Math.ceil(Math.max(p1.x, p2.x) - Math.min(p1.x, p2.x) + margin * 2);
        const mh = Math.ceil(Math.max(p1.y, p2.y) - Math.min(p1.y, p2.y) + margin * 2);
        this.board.expandDirtyRect(user, mx, my, mw, mh);
      });

      // Track tile ownership for remote user
      const points = user.penPoints.map(pt => ({ x: pt.x, y: pt.y }));
      const maxRadius = Math.max(...user.penPoints.map(p => p.radius || user.size));
      this.board.markDirtyPath(user, points, maxRadius);
      this.board.forEachMirrorRegion({ points }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(points, region), maxRadius);
      });
    }

    const strokeLayer = user._strokeLayer ?? user.activeLayer;
    const layerCtx = this.board.layerManager.getUserStrokeContext(strokeLayer, user.id);
    if (layerCtx) {
      layerCtx.globalCompositeOperation = 'source-over';
      layerCtx.globalAlpha = user._penAlpha;

      this.compositeWithHardness(layerCtx, user._penOffscreen, user.size, user._penHardness, user._penStrokeColor, 0, 0);

      this.board.forEachMirrorRegion({ points: user.penPoints }, (region) => {
        layerCtx.save();
        layerCtx.globalCompositeOperation = 'source-over';
        this.board.drawMirroredCanvas(layerCtx, user._penOffscreen, region, 0, 0);
        layerCtx.restore();
      });

      layerCtx.globalAlpha = 1.0;
      this.board.requestUpdate();
    }

    user._penLastStampPos = null;
    user._penStrokeActive = false;
    user._penStrokeColor = null;
    user._penAlpha = null;
    user.penPoints = [];
  }

  /**
   * Updates the user's preview canvas with the current pen stroke state.
   * @param {User} user - The remote user object.
   */
  updatePenPreview(user) {
    if (!user._penOffscreen) return;

    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.context.globalAlpha = user._penAlpha;

    this.compositeWithHardness(user.context, user._penOffscreen, user.size, user._penHardness, user._penStrokeColor, 0, 0);

    this.board.forEachMirrorRegion({ points: user.penPoints }, (region) => {
      this.board.drawMirroredCanvas(user.context, user._penOffscreen, region, 0, 0);
    });

    user.context.globalAlpha = 1.0;
  }

  /**
   * Composites an offscreen canvas to a context with hardness/blur application.
   * @param {CanvasRenderingContext2D} ctx - The destination context.
   * @param {HTMLCanvasElement} sourceCanvas - The source canvas to composite.
   * @param {number} size - The stroke size.
   * @param {number} hardness - The hardness value (0.0 to 1.0).
   * @param {string} strokeColor - The RGB color string.
   * @param {number} x - Destination x-coordinate.
   * @param {number} y - Destination y-coordinate.
   */
  compositeWithHardness(ctx, sourceCanvas, size, hardness, strokeColor, x, y) {
    const blurAmount = (1 - hardness) * (20 + size * 0.2);

    if (blurAmount > 0) {
      const offset = 100000;
      ctx.save();
      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = strokeColor;
      ctx.shadowOffsetX = -offset;
      ctx.shadowOffsetY = 0;
      ctx.drawImage(sourceCanvas, x + offset, y);
      ctx.restore();
    } else {
      ctx.drawImage(sourceCanvas, x, y);
    }
  }
}
