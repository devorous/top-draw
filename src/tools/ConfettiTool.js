import {
  buildPreviewStrokePoints,
  drawPreviewStrokeGuide,
  getPreviewPointAngle,
  prepareStrokePreviewCanvas
} from '../ui/StrokePreviewRenderer.js';
import { Tool } from './BaseTool.js';

/**
 * @fileoverview Confetti brush - stamps randomized particles along a drawing path.
 */

function mulberry32(seed) {
  return function nextRandom() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function colorToString(color, alpha = 1) {
  const r = Math.round(color[0] ?? 0);
  const g = Math.round(color[1] ?? 0);
  const b = Math.round(color[2] ?? 0);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const CONFETTI_SEED_MAX = 0xFFFFFF;

export class ConfettiTool extends Tool {
  constructor(board) {
    super('confetti', board);
    this.lastStampPos = new Map();
    this.stampBuffer = [];
    this.seedBuffer = [];
    this._activeUser = null;
    this._strokeSeed = 0;
    this._emissionIndex = 0;
    this._imageCache = new Map();
    this._tintedImageCache = new Map();
  }

  deactivate() {
    if (this._activeUser && this.lastStampPos.has(this._activeUser.id)) {
      this.onPointerUp(this._activeUser, this.lastStampPos.get(this._activeUser.id));
    }
    this.lastStampPos.clear();
    this._activeUser = null;
  }

  onPointerDown(user, pos) {
    this._activeUser = user;
    this._strokeSeed = Number(user._confettiStrokeSeed ?? this.createSeed()) & CONFETTI_SEED_MAX;
    this._emissionIndex = 0;
    this.board.beginStroke(user);
    user._confettiDirtyBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    user._confettiStrokePoints = [{ x: pos.x, y: pos.y }];
    this.emit(user, pos, 0, this._strokeSeed);
    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    delete user._confettiStrokeSeed;
  }

  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning) return;

    const lastStamp = this.lastStampPos.get(user.id);
    if (!lastStamp) {
      this.emit(user, pos, 0);
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
      this.board.requestUpdate();
      return;
    }

    const dx = pos.x - lastStamp.x;
    const dy = pos.y - lastStamp.y;
    const distance = Math.hypot(dx, dy);
    const spacing = this.getSpacing(user);

    if (distance < spacing) return;

    const steps = Math.max(1, Math.floor(distance / spacing));
    const angle = Math.atan2(dy, dx);

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const interp = {
        x: lastStamp.x + dx * t,
        y: lastStamp.y + dy * t
      };
      const seed = this.createSeed();
      this.emit(user, interp, angle, seed);
      this.stampBuffer.push(interp.x, interp.y);
      this.seedBuffer.push(seed);
      this._getStrokePoints(user).push(interp);
    }

    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    this.board.requestUpdate();
  }

  onPointerUp(user) {
    if (user.panning) return;

    const dirtyBounds = user._confettiDirtyBounds;
    const strokePoints = this._getStrokePoints(user);
    if (dirtyBounds && dirtyBounds.maxX !== -Infinity) {
      const margin = 4;
      const x = Math.floor(dirtyBounds.minX - margin);
      const y = Math.floor(dirtyBounds.minY - margin);
      const width = Math.ceil(dirtyBounds.maxX - dirtyBounds.minX + margin * 2);
      const height = Math.ceil(dirtyBounds.maxY - dirtyBounds.minY + margin * 2);
      this.board.expandDirtyRect(user, x, y, width, height);

      this.board.forEachMirrorRegion({ rect: { x, y, width, height } }, (region) => {
        const p1 = this.board.mirrorPointToRegion({ x: dirtyBounds.minX, y: dirtyBounds.minY }, region);
        const p2 = this.board.mirrorPointToRegion({ x: dirtyBounds.maxX, y: dirtyBounds.maxY }, region);
        const mx = Math.floor(Math.min(p1.x, p2.x) - margin);
        const my = Math.floor(Math.min(p1.y, p2.y) - margin);
        const mw = Math.ceil(Math.max(p1.x, p2.x) - Math.min(p1.x, p2.x) + margin * 2);
        const mh = Math.ceil(Math.max(p1.y, p2.y) - Math.min(p1.y, p2.y) + margin * 2);
        this.board.expandDirtyRect(user, mx, my, mw, mh);
      });
    }

    if (strokePoints.length > 0) {
      const radius = user.size + this.getMaxParticleRadius(user);
      this.board.markDirtyPath(user, strokePoints, radius);
      this.board.forEachMirrorRegion({ points: strokePoints }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(strokePoints, region), radius);
      });
    }

    user._confettiStrokePoints = [];
    this.board.endStroke(user);
    if (this._isLocalUser(user)) this.board.clearTop();
    this.lastStampPos.delete(user.id);
    user._confettiDirtyBounds = null;
  }

  drainStampBuffer() {
    const ps = this.stampBuffer;
    const rs = this.seedBuffer;
    this.stampBuffer = [];
    this.seedBuffer = [];
    return { ps, rs };
  }

  applyStamps(user, ps, seeds = []) {
    if (!user || user.id == null) return;
    const strokeLayer = user._strokeLayer ?? user.activeLayer ?? 0;
    const hasActiveStroke = this.board.layerManager?.getActiveStroke(strokeLayer, user.id);
    if (!hasActiveStroke) this.board.beginStroke(user);

    const points = [];
    const strokePoints = this._getStrokePoints(user);
    for (let i = 0; i < ps.length; i += 2) {
      const pos = { x: ps[i], y: ps[i + 1] };
      const seed = Number(seeds[i / 2] ?? this.createSeed()) & CONFETTI_SEED_MAX;
      this.emit(user, pos, 0, seed);
      points.push(pos);
      strokePoints.push(pos);
    }

    if (points.length > 0) {
      const radius = user.size + this.getMaxParticleRadius(user);
      this.board.markDirtyPath(user, points, radius);
      this.board.forEachMirrorRegion({ points }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(points, region), radius);
      });
    }
    this.board.requestUpdate();
  }

  emit(user, pos, pathAngle = 0, seed = this.createSeed()) {
    const count = this.getParticlesPerStep(user);
    const seedBase = Number(seed) & CONFETTI_SEED_MAX;
    this._emissionIndex++;

    for (let i = 0; i < count; i++) {
      const random = mulberry32((seedBase + i * 374761393) >>> 0);
      const particle = this.createParticle(user, pos, pathAngle, random);
      this.drawParticle(user, particle);
    }
  }

  createParticle(user, pos, pathAngle, random) {
    const brushRadius = Math.max(1, Number(user.size ?? 10));
    const radius = Math.sqrt(random()) * brushRadius;
    const theta = random() * Math.PI * 2;
    const variation = Math.max(0, Math.min(1, Number(user.confettiSizeVariation ?? 40) / 100));
    const scaleMin = Math.max(0.1, 1 - variation);
    const scaleMax = Math.max(scaleMin, 1 + variation);
    const baseSize = Math.max(1, Number(user.confettiParticleSize ?? user.size ?? 10));
    const size = Math.max(1, baseSize * (scaleMin + random() * (scaleMax - scaleMin)));
    const rotationMode = this.getRotationMode(user);
    let rotation = random() * Math.PI * 2;
    if (rotationMode === 'follow') rotation = pathAngle;
    if (rotationMode === 'fixed') rotation = 0;

    const opacityRandomness = Math.max(0, Math.min(1, Number(user.confettiOpacityRandomness ?? 20) / 100));
    const opacityMin = Math.max(0, 1 - opacityRandomness);
    const opacityMax = Math.min(1, 1 + opacityRandomness);

    return {
      x: pos.x + Math.cos(theta) * radius,
      y: pos.y + Math.sin(theta) * radius,
      size,
      rotation,
      shape: this.getParticleShape(user),
      brush: this.getParticleShape(user) === 'image' ? (user.confettiBrush || null) : null,
      color: this.getParticleColor(user, random),
      colorMode: this.getColorMode(user),
      opacity: (user.opacity ?? 1) * (opacityMin + random() * (opacityMax - opacityMin))
    };
  }

  drawParticle(user, particle) {
    const strokeLayer = user._strokeLayer ?? user.activeLayer ?? 0;
    const ctx = this.board.layerManager.getUserStrokeContext(strokeLayer, user.id);
    if (!ctx) return;

    const draw = (targetCtx, item) => this.drawParticleToContext(targetCtx, item);

    draw(ctx, particle);

    const rect = {
      x: particle.x - particle.size,
      y: particle.y - particle.size,
      width: particle.size * 2,
      height: particle.size * 2
    };

    this.board.forEachMirrorRegion({ rect }, (region) => {
      this.board.withMirroredRegionTransform(ctx, region, () => draw(ctx, particle));
      // Mark the mirrored area dirty too so the reflected particle composites to
      // screen live during the stroke (not just on pointer-up). Mirrors the
      // two-corner approach used in onPointerUp's dirty-bounds expansion.
      const p1 = this.board.mirrorPointToRegion({ x: rect.x, y: rect.y }, region);
      const p2 = this.board.mirrorPointToRegion({ x: rect.x + rect.width, y: rect.y + rect.height }, region);
      const mx = Math.floor(Math.min(p1.x, p2.x));
      const my = Math.floor(Math.min(p1.y, p2.y));
      const mw = Math.ceil(Math.abs(p2.x - p1.x));
      const mh = Math.ceil(Math.abs(p2.y - p1.y));
      this.board.expandDirtyRect(user, mx, my, mw, mh);
    });

    this.expandDirtyBounds(user, rect);
    this.board.expandDirtyRect(user, Math.floor(rect.x), Math.floor(rect.y), Math.ceil(rect.width), Math.ceil(rect.height));
  }

  buildStarPath(ctx, outer, inner) {
    for (let i = 0; i < 10; i++) {
      const radius = i % 2 === 0 ? outer : inner;
      const angle = -Math.PI / 2 + (i * Math.PI) / 5;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  drawParticleToContext(ctx, particle) {
    ctx.save();
    ctx.translate(particle.x, particle.y);
    ctx.rotate(particle.rotation);
    ctx.globalAlpha = particle.opacity;
    const image = this.getParticleImage(particle.brush);
    if (image?.complete && image.naturalWidth > 0) {
      const imgWidth = image.naturalWidth || image.width || 1;
      const imgHeight = image.naturalHeight || image.height || 1;
      const aspectRatio = imgWidth / imgHeight;
      let drawWidth, drawHeight;
      if (aspectRatio > 1) {
        drawWidth = particle.size;
        drawHeight = particle.size / aspectRatio;
      } else {
        drawWidth = particle.size * aspectRatio;
        drawHeight = particle.size;
      }
      const source = particle.colorMode === 'image'
        ? image
        : this.getTintedParticleImage(image, particle.brush, particle.color);
      ctx.drawImage(source, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    } else if (particle.shape === 'square') {
      ctx.fillStyle = colorToString(particle.color);
      const half = particle.size / 2;
      ctx.fillRect(-half, -half, particle.size, particle.size);
    } else {
      ctx.fillStyle = colorToString(particle.color);
      ctx.beginPath();
      ctx.arc(0, 0, particle.size / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  updatePreview(user) {
    const canvas = document.getElementById('toolPreviewCanvas');
    if (!canvas) return;
    if (!user) user = this.board.self || this.board.app?.self;
    if (!user) return;

    const ctx = prepareStrokePreviewCanvas(canvas, this.board);
    if (!ctx) return;

    const previewUser = {
      ...user,
      confettiParticleSize: Math.max(2, Math.min(14, Number(user.confettiParticleSize ?? 10) * 0.65)),
      opacity: user.opacity ?? 1,
      size: 25
    };
    const oldSeed = this._strokeSeed;
    const oldIndex = this._emissionIndex;
    this._strokeSeed = 0xC0FFEE;
    this._emissionIndex = 0;

    const points = buildPreviewStrokePoints(canvas, 50);
    drawPreviewStrokeGuide(ctx, points, user.color || [0, 0, 0]);

    const spacing = this.getSpacing(previewUser);
    let lastPoint = points[0];

    // Emit for the first point
    this._emitForPreview(ctx, previewUser, lastPoint, getPreviewPointAngle(points, 0), 0);

    let distanceTraveled = 0;
    for (let i = 1; i < points.length; i++) {
      const pos = points[i];
      const dx = pos.x - lastPoint.x;
      const dy = pos.y - lastPoint.y;
      const dist = Math.hypot(dx, dy);
      distanceTraveled += dist;

      if (distanceTraveled >= spacing) {
        const pathAngle = getPreviewPointAngle(points, i);
        this._emitForPreview(ctx, previewUser, pos, pathAngle, i);
        lastPoint = pos;
        distanceTraveled = 0;
      }
    }

    this._strokeSeed = oldSeed;
    this._emissionIndex = oldIndex;
    ctx.globalAlpha = 1;
  }

  _emitForPreview(ctx, user, pos, pathAngle, index) {
    const seed = (0xC0FFEE + index * 2654435761) >>> 0;
    const count = this.getParticlesPerStep(user);
    for (let particleIndex = 0; particleIndex < count; particleIndex++) {
      const random = mulberry32((seed + particleIndex * 374761393) >>> 0);
      const pressureUser = {
        ...user,
        size: user.size * pos.pressure,
        confettiParticleSize: user.confettiParticleSize * pos.pressure
      };
      const particle = this.createParticle(pressureUser, pos, pathAngle, random);
      this.drawParticleToContext(ctx, particle);
    }
  }

  getParticleColor(user, random) {
    const mode = this.getColorMode(user);
    if (mode === 'image') return user.color || [0, 0, 0];
    if (mode === 'random') {
      return [
        Math.floor(random() * 256),
        Math.floor(random() * 256),
        Math.floor(random() * 256)
      ];
    }
    return user.color || [0, 0, 0];
  }

  getSpacing(user) {
    const spacing = Math.max(0, Math.min(50, Number(user.confettiSpacing ?? user.spacing ?? 30)));
    return Math.max(1, user.size * Math.max(0.05, spacing * 0.05));
  }

  getParticlesPerStep(user) {
    return Math.max(1, Math.min(12, Math.round(Number(user.confettiParticles ?? 4))));
  }

  getScatter(user) {
    return Math.max(0, Number(user.size ?? 10) - this.getMaxParticleRadius(user));
  }

  getMaxParticleRadius(user) {
    const baseSize = Math.max(1, Number(user.confettiParticleSize ?? user.size ?? 10));
    const variation = Math.max(0, Math.min(1, Number(user.confettiSizeVariation ?? 40) / 100));
    return (baseSize * (1 + variation)) / 2;
  }

  getParticleImage(brush) {
    const url = brush?.gBrushes?.[0]?.gimpUrl || brush?.previewUrl || brush?.gimpUrl || brush?.url || this.svgContentToDataUrl(brush?.svgContent);
    if (!url) return null;
    if (this._imageCache.has(url)) return this._imageCache.get(url);
    const image = new Image();
    image.onload = () => this.board?.requestUpdate?.();
    image.src = url;
    this._imageCache.set(url, image);
    return image;
  }

  getTintedParticleImage(image, brush, color) {
    const colorKey = color.slice(0, 3).map(value => Math.round(value ?? 0)).join(',');
    const brushKey = brush?.id || brush?.brushName || brush?.fileName || brush?.gimpUrl || brush?.previewUrl || 'brush';
    const sourceSizeKey = `${image.naturalWidth || image.width || 0}x${image.naturalHeight || image.height || 0}`;
    const cacheKey = `${brushKey}:${sourceSizeKey}:${colorKey}`;
    if (this._tintedImageCache.has(cacheKey)) return this._tintedImageCache.get(cacheKey);

    const width = image.naturalWidth || image.width || 1;
    const height = image.naturalHeight || image.height || 1;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const tintCtx = canvas.getContext('2d');
    tintCtx.drawImage(image, 0, 0, width, height);
    tintCtx.globalCompositeOperation = 'source-in';
    tintCtx.fillStyle = colorToString(color);
    tintCtx.fillRect(0, 0, width, height);

    this._tintedImageCache.set(cacheKey, canvas);
    return canvas;
  }

  svgContentToDataUrl(svgContent) {
    if (!svgContent) return null;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`;
  }

  createSeed() {
    return Math.floor(Math.random() * (CONFETTI_SEED_MAX + 1));
  }

  getNetworkSettings(user, extra = {}) {
    const { includeBrush = true, ...payloadExtra } = extra;
    const settings = {
      kind: 'confetti',
      confettiParticles: this.getParticlesPerStep(user),
      confettiParticleSize: Math.max(1, Number(user.confettiParticleSize ?? user.size ?? 10)),
      confettiSizeVariation: Math.max(0, Math.min(100, Number(user.confettiSizeVariation ?? 40))),
      confettiOpacityRandomness: Math.max(0, Math.min(100, Number(user.confettiOpacityRandomness ?? 20))),
      confettiSpacing: Math.max(0, Math.min(50, Number(user.confettiSpacing ?? user.spacing ?? 30))),
      confettiShape: this.getParticleShape(user),
      confettiColorMode: this.getColorMode(user),
      confettiRotationMode: this.getRotationMode(user),
      ...payloadExtra
    };
    if (includeBrush) settings.confettiBrush = this.getNetworkBrush(user.confettiBrush);
    return settings;
  }

  getNetworkBrush(brush) {
    if (!brush) return null;
    const data = {
      type: brush.type || 'image',
      fileName: brush.fileName || null,
      brushName: brush.brushName || null,
      gimpUrl: brush.gimpUrl || null,
      previewUrl: brush.previewUrl?.startsWith?.('data:') ? brush.previewUrl : null,
      svgContent: brush.svgContent || null
    };
    if (Array.isArray(brush.gBrushes)) {
      data.gBrushes = brush.gBrushes.map((entry) => ({
        gimpUrl: entry.gimpUrl,
        width: entry.width,
        height: entry.height
      }));
    }
    return data;
  }

  applyNetworkSettings(user, raw) {
    if (!raw) return null;
    let data = raw;
    if (typeof raw === 'string') {
      try {
        data = JSON.parse(raw);
      } catch {
        return null;
      }
    }
    if (!data || data.kind !== 'confetti') return null;

    for (const key of [
      'confettiParticles',
      'confettiParticleSize',
      'confettiSizeVariation',
      'confettiOpacityRandomness',
      'confettiSpacing',
      'confettiShape',
      'confettiColorMode',
      'confettiRotationMode',
      'confettiBrush'
    ]) {
      if (data[key] !== undefined) user[key] = data[key];
    }
    if (data.initialSeed !== undefined) {
      user._confettiStrokeSeed = Number(data.initialSeed) & CONFETTI_SEED_MAX;
    }
    return data;
  }

  getParticleShape(user) {
    const shape = user.confettiShape;
    if (['image', 'circle', 'square'].includes(shape)) return shape;
    return user.confettiBrush ? 'image' : 'circle';
  }

  getColorMode(user) {
    const mode = user.confettiColorMode || 'image';
    if (mode === 'image' && this.getParticleShape(user) !== 'image') return 'active';
    return ['image', 'active', 'random'].includes(mode) ? mode : 'image';
  }

  getRotationMode(user) {
    const mode = user.confettiRotationMode || 'random';
    return ['random', 'fixed'].includes(mode) ? mode : 'random';
  }

  expandDirtyBounds(user, rect) {
    const bounds = user?._confettiDirtyBounds;
    if (!bounds) return;
    bounds.minX = Math.min(bounds.minX, rect.x);
    bounds.minY = Math.min(bounds.minY, rect.y);
    bounds.maxX = Math.max(bounds.maxX, rect.x + rect.width);
    bounds.maxY = Math.max(bounds.maxY, rect.y + rect.height);
  }

  clearUserState(userId) {
    this.lastStampPos.delete(userId);
  }

  _getStrokePoints(user) {
    if (!user) return [];
    if (!Array.isArray(user._confettiStrokePoints)) user._confettiStrokePoints = [];
    return user._confettiStrokePoints;
  }

  _isLocalUser(user) {
    return user === this.board.app?.self || user?.id === this.board.app?.sessionIndex;
  }
}
