/**
 * @fileoverview Server-side metrics tracking for user achievements
 * Tracks metrics in RAM and batches writes to MongoDB
 */

import { updateUserMetrics, updateConsecutiveDays } from './db.js';

const FLUSH_INTERVAL_MS = 5 * 60 * 1000; // Flush to DB every 5 minutes

/**
 * Server-side metrics tracker
 * Accumulates metrics in memory and periodically flushes to database
 */
export class MetricsTracker {
  constructor() {
    // Map<userId, { distance, strokes, timeMs, chatMessages, tools: Set, strokeDistance, lastPoint, sessionStart, lastActivity }>
    this.userMetrics = new Map();

    // Periodic flush interval
    this.flushInterval = null;
  }

  /**
   * Start the periodic flush timer
   */
  start() {
    if (this.flushInterval) return;

    this.flushInterval = setInterval(() => {
      this.flushAllUsers();
    }, FLUSH_INTERVAL_MS);

    console.log('[Metrics] Started with 5-minute flush interval');
  }

  /**
   * Stop the periodic flush timer
   */
  stop() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    // Final flush
    this.flushAllUsers();
  }

  /**
   * Initialize tracking for a user session
   * @param {string} userId - MongoDB user ID
   */
  initUser(userId) {
    if (!userId || this.userMetrics.has(userId)) return;

    this.userMetrics.set(userId, {
      distance: 0,
      strokes: 0,
      timeMs: 0,
      chatMessages: 0,
      tools: new Set(),
      strokeDistance: 0,
      lastPoint: null,
      sessionStart: Date.now(),
      lastActivity: Date.now()
    });
  }

  /**
   * Track a stroke starting (mouse down)
   * @param {string} userId
   * @param {string} tool - Tool name
   */
  onStrokeStart(userId, tool) {
    if (!userId) return;

    const metrics = this.userMetrics.get(userId);
    if (!metrics) return;

    metrics.strokeDistance = 0;
    metrics.lastPoint = null;
    metrics.lastActivity = Date.now();

    // Track tool usage (exclude non-drawing tools)
    if (tool && tool !== 'select' && tool !== 'text' && tool !== 'pan' && tool !== 'zoom' && tool !== 'rotate') {
      metrics.tools.add(tool);
    }
  }

  /**
   * Track pointer movement during a stroke
   * @param {string} userId
   * @param {number} x - Board X coordinate
   * @param {number} y - Board Y coordinate
   */
  onStrokeMove(userId, x, y) {
    if (!userId) return;

    const metrics = this.userMetrics.get(userId);
    if (!metrics) return;

    if (metrics.lastPoint) {
      const dx = x - metrics.lastPoint.x;
      const dy = y - metrics.lastPoint.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      metrics.strokeDistance += distance;
    }

    metrics.lastPoint = { x, y };
    metrics.lastActivity = Date.now();
  }

  /**
   * Track a stroke ending (mouse up)
   * @param {string} userId
   */
  onStrokeEnd(userId) {
    if (!userId) return;

    const metrics = this.userMetrics.get(userId);
    if (!metrics) return;

    // Add stroke distance to total
    metrics.distance += metrics.strokeDistance;
    metrics.strokes += 1;

    // Reset stroke tracking
    metrics.strokeDistance = 0;
    metrics.lastPoint = null;
    metrics.lastActivity = Date.now();
  }

  /**
   * Track a chat message sent
   * @param {string} userId
   */
  onChatMessage(userId) {
    if (!userId) return;

    const metrics = this.userMetrics.get(userId);
    if (!metrics) return;

    metrics.chatMessages += 1;
    metrics.lastActivity = Date.now();
  }

  /**
   * Update session time for a user (called periodically or on activity)
   * @param {string} userId
   */
  updateSessionTime(userId) {
    if (!userId) return;

    const metrics = this.userMetrics.get(userId);
    if (!metrics) return;

    const now = Date.now();
    const sessionDuration = now - metrics.sessionStart;

    // Only count time if user was active in the last 5 minutes
    const inactiveThreshold = 5 * 60 * 1000;
    if (now - metrics.lastActivity < inactiveThreshold) {
      metrics.timeMs = sessionDuration;
    }
  }

  /**
   * Flush metrics for a specific user to database
   * @param {string} userId
   */
  async flushUser(userId) {
    if (!userId) return;

    const metrics = this.userMetrics.get(userId);
    if (!metrics) return;

    // Update session time before flushing
    this.updateSessionTime(userId);

    // Check if there's anything to flush
    const hasMetrics =
      metrics.distance > 0 ||
      metrics.strokes > 0 ||
      metrics.timeMs > 0 ||
      metrics.chatMessages > 0 ||
      metrics.tools.size > 0;

    if (!hasMetrics) return;

    try {
      // Prepare metrics data
      const metricsData = {};

      if (metrics.distance > 0) {
        metricsData.distanceDrawn = Math.floor(metrics.distance);
      }
      if (metrics.strokes > 0) {
        metricsData.strokes = metrics.strokes;
      }
      if (metrics.timeMs > 0) {
        metricsData.timeSpentMs = Math.floor(metrics.timeMs);
      }
      if (metrics.chatMessages > 0) {
        metricsData.chatMessages = metrics.chatMessages;
      }
      if (metrics.tools.size > 0) {
        metricsData.toolsUsed = Array.from(metrics.tools);
      }

      // Write to database
      await updateUserMetrics(userId, metricsData);
      await updateConsecutiveDays(userId);

      // Reset metrics (keep session tracking)
      metrics.distance = 0;
      metrics.strokes = 0;
      metrics.timeMs = 0;
      metrics.chatMessages = 0;
      metrics.tools.clear();
      metrics.sessionStart = Date.now(); // Reset session timer

    } catch (err) {
      console.error(`[Metrics] Error flushing user ${userId}:`, err);
    }
  }

  /**
   * Flush all users' metrics to database
   */
  async flushAllUsers() {
    const userIds = Array.from(this.userMetrics.keys());

    if (userIds.length === 0) return;

    console.log(`[Metrics] Flushing ${userIds.length} users to DB`);

    await Promise.all(userIds.map(userId => this.flushUser(userId)));
  }

  /**
   * Clean up metrics for a disconnected user
   * @param {string} userId
   */
  async onUserDisconnect(userId) {
    if (!userId) return;

    // Flush final metrics
    await this.flushUser(userId);

    // Remove from tracking
    this.userMetrics.delete(userId);
  }
}

// Singleton instance
export const metricsTracker = new MetricsTracker();
