/**
 * @fileoverview Brush tool for freehand drawing on the canvas.
 * Handles stroke lifecycle, preview rendering, and dirty rectangle tracking.
 */

import { manhattanDistance, drawLineArray, bridgeGap } from '../utils/drawing.js';

/**
 * Base class for all interactive tools.
 * Defines the lifecycle methods for pointer interactions.
 */
class Tool {
  /**
   * @param {string} name - The unique name of the tool.
   * @param {Board} board - The board instance the tool operates on.
   */
  constructor(name, board) {
    this.name = name;
    this.board = board;
  }

  /**
   * Called when the tool is selected.
   * @returns {void}
   */
  activate() {}

  /**
   * Called when the tool is deselected.
   * @returns {void}
   */
  deactivate() {
    if (this._activeUser && this._activeUser.currentLine && this._activeUser.currentLine.length > 0) {
      this.onPointerUp(this._activeUser);
    }
    this._activeUser = null;
  }

  /**
   * Handles pointer down events.
   * @param {User} user - The user performing the action.
   * @param {Object} pos - The {x, y} coordinate of the event.
   * @param {PointerEvent} e - The original pointer event.
   * @returns {void}
   */
  onPointerDown(user, pos, e) {}

  /**
   * Handles pointer move events.
   * @param {User} user - The user performing the action.
   * @param {Object} pos - The current {x, y} coordinate.
   * @param {Object} lastPos - The previous {x, y} coordinate.
   * @param {PointerEvent} e - The original pointer event.
   * @returns {void}
   */
  onPointerMove(user, pos, lastPos, e) {}

  /**
   * Handles pointer up events.
   * @param {User} user - The user performing the action.
   * @param {Object} pos - The {x, y} coordinate of the event.
   * @param {PointerEvent} e - The original pointer event.
   * @returns {void}
   */
  onPointerUp(user, pos, e) {}
}

/**
 * Brush tool for drawing smooth, pressure-sensitive lines.
 * Position smoothing is handled by InputBufferManager before points reach this tool.
 *
 * @extends Tool
 */
export class BrushTool extends Tool {
  /**
   * @param {Board} board - The board instance.
   */
  constructor(board) {
    super('brush', board);
  }

  /**
   * Activates the brush tool.
   * @override
   */
  activate() {
    // Sub-layers always draw source-over; blend mode is applied at composite time.
  }

  /**
   * Starts a new stroke.
   *
   * @param {User} user - The user drawing the stroke.
   * @param {Object} pos - Starting {x, y} position.
   * @override
   */
  onPointerDown(user, pos) {
    this._activeUser = user;
    this.board.beginStroke(user);
    user.clearLine();

    // Push twice so a click without movement draws a dot on commit
    user.currentLine.push(pos);
    user.currentLine.push(pos);
  }

  /**
   * Updates the active stroke with new points.
   *
   * @param {User} user - The user drawing the stroke.
   * @param {Object} pos - Current {x, y} position.
   * @param {Object} lastPos - Previous {x, y} position.
   * @override
   */
  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    user.currentLine.push(pos);
    this.board.clearTop();
    this.board.topCtx.beginPath();
    drawLineArray(user.currentLine, this.board.topCtx, user);

    this.board.forEachMirrorRegion({ points: user.currentLine }, (region) => {
      const mirrored = this.board.mirrorPointsToRegion(user.currentLine, region);
      this.board.withMirrorRegionClip(this.board.topCtx, region, () => {
        drawLineArray(mirrored, this.board.topCtx, user);
      });
    });

    user.lineLength += manhattanDistance(pos, lastPos);
  }

  /**
   * Finalizes the stroke and commits it to the active layer.
   *
   * @param {User} user - The user finishing the stroke.
   * @override
   */
  onPointerUp(user) {
    if (user.panning) return;

    this.board.clearTop();

    const layerCtx = this.board.getActiveLayerContext();
    drawLineArray(user.currentLine, layerCtx, user);

    this.board.forEachMirrorRegion({ points: user.currentLine }, (region) => {
      const mirrored = this.board.mirrorPointsToRegion(user.currentLine, region);
      this.board.withMirrorRegionClip(layerCtx, region, () => {
        drawLineArray(mirrored, layerCtx, user);
      });
    });

    this.trackDirtyRect(user, user.currentLine);
    user.clearLine();

    this.board.endStroke(user);
  }

  /**
   * Renders the current line as a preview on the top canvas.
   *
   * @param {User} user - The user to render the preview for.
   * @returns {void}
   */
  drawPreview(user) {
    drawLineArray(user.currentLine, this.board.topCtx, user);
  }

  /**
   * Marks dirty tiles along the stroke path for efficient compositing.
   *
   * @param {User} user - The user whose drawing is being tracked.
   * @param {Array<Object>} points - Array of {x, y} points in the stroke.
   * @returns {void}
   */
  trackDirtyRect(user, points) {
    if (!points || points.length === 0) return;

    const hardness = user.hardness !== undefined ? user.hardness : 100;
    const hardnessFloat = hardness / 100.0;

    const radius = user.pressure * user.size;
    const blurAmount = hardness < 100 ? (1 - hardnessFloat) * (20 + user.size * 0.2) : 0;
    const safetyMargin = radius * 0.25;
    const totalRadius = radius + blurAmount + safetyMargin + 2;

    // Use line-based tile marking for efficiency
    this.board.markDirtyPath(user, points, totalRadius);

    this.board.forEachMirrorRegion({ points }, (region) => {
      const mirroredPoints = this.board.mirrorPointsToRegion(points, region);
      this.board.markDirtyPath(user, mirroredPoints, totalRadius);
    });
  }

  /**
   * Commits the current line segment to the layer and prepares for the next.
   * Used when brush parameters change mid-stroke.
   *
   * @param {User} user - The user drawing.
   * @param {number} [newPressure] - New pressure value.
   * @param {number} [newSize] - New brush size.
   * @returns {void}
   */
  commitCurrentLine(user, newPressure, newSize) {
    this.board.clearTop();
    this.board.topCtx.beginPath();

    const oldRadius = user.pressure * user.size;
    const newRadius = (newPressure ?? user.pressure) * (newSize ?? user.size);

    const layerCtx = this.board.getActiveLayerContext();
    drawLineArray(user.currentLine, layerCtx, user);

    this.board.forEachMirrorRegion({ points: user.currentLine }, (region) => {
      const mirrored = this.board.mirrorPointsToRegion(user.currentLine, region);
      this.board.withMirrorRegionClip(layerCtx, region, () => {
        drawLineArray(mirrored, layerCtx, user);
      });
    });

    this.trackDirtyRect(user, user.currentLine);

    const lastSmoothedPos = user.currentLine.length > 0
      ? user.currentLine[user.currentLine.length - 1]
      : { x: user.x, y: user.y };

    if (user.currentLine.length > 0) {
      const from = lastSmoothedPos;
      bridgeGap(layerCtx, from, lastSmoothedPos, oldRadius, newRadius, user);
      this.board.forEachMirrorRegion({ points: [from, lastSmoothedPos] }, (region) => {
        this.board.withMirrorRegionClip(layerCtx, region, () => {
          bridgeGap(
            layerCtx,
            this.board.mirrorPointToRegion(from, region),
            this.board.mirrorPointToRegion(lastSmoothedPos, region),
            oldRadius,
            newRadius,
            user
          );
        });
      });
    }

    user.clearLine();
    user.currentLine.push(lastSmoothedPos);

    this.board.compositeAllLayers();
  }
}
