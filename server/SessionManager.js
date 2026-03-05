import { T } from '../shared/MessageTypes.js';

// Role constants
export const Role = { GUEST: 0, USER: 1, MOD: 2, ADMIN: 3 };

// AFK timing
const AFK_TIMEOUT = 2 * 60 * 1000;       // 2 minutes
const AFK_CHECK_INTERVAL = 30 * 1000;    // 30 seconds

/**
 * SessionManager
 *
 * Manages user session indices, user data, and AFK tracking.
 *
 * Responsibilities:
 * - Allocate and free session indices (reuses freed indices for efficiency)
 * - Track user state (position, tool, color, etc.)
 * - AFK detection and broadcasting
 * - Activity updates
 */
export class SessionManager {
  constructor(broadcastCallback) {
    this.sessions = new Map();      // oldUserId -> sessionIndex (unused currently, for future multi-tab support)
    this.users = new Map();         // sessionIndex -> userData
    this.nextSessionIndex = 0;
    this.freedIndices = [];         // Reusable indices from disconnected users
    this.broadcastToAll = broadcastCallback;

    // Start AFK checker
    this.afkCheckInterval = setInterval(() => this.checkAfkUsers(), AFK_CHECK_INTERVAL);
  }

  /**
   * Allocate a session index for a new user
   * Reuses freed indices before incrementing
   */
  allocateSessionIndex() {
    if (this.freedIndices.length > 0) {
      return this.freedIndices.pop();
    }
    return this.nextSessionIndex++;
  }

  /**
   * Free a session index when user disconnects
   * Makes it available for reuse
   */
  freeSessionIndex(index) {
    this.freedIndices.push(index);
  }

  /**
   * Create and store a new user record
   * @param {number} sessionIndex - Assigned session index
   * @param {string} name - User's display name
   * @param {number} tool - Initial tool (from Tool enum)
   * @param {number} color - Packed RGBA color
   */
  createUser(sessionIndex, name = '', tool, color) {
    const newUser = {
      sessionIndex,
      afk: false,
      cursorHidden: true, // Hidden until user enters the board
      lastActivity: Date.now(),
      x: 0, y: 0, lastx: 0, lasty: 0,
      mousedown: false,
      tool,
      color,
      size: 1000,      // 10.00 * 100
      spacing: 10,     // 0.10 * 100
      smoothing: 15,   // 0-50 integer (default 15/50 = 30%)
      hardness: 100,   // 0-100 integer (default 100/100 = 100%)
      pressure: 100,   // 1.00 * 100
      blurRadius: 5,   // 0-100 integer (default 5px)
      name,
      text: ''
    };
    this.users.set(sessionIndex, newUser);
    return newUser;
  }

  /**
   * Get user data by session index
   */
  getUser(sessionIndex) {
    return this.users.get(sessionIndex);
  }

  /**
   * Remove user from session
   */
  removeUser(sessionIndex) {
    this.users.delete(sessionIndex);
  }

  /**
   * Get all users who have joined (have a name)
   */
  getJoinedUsers() {
    return Array.from(this.users.values()).filter(u => u.name);
  }

  /**
   * Get total user count
   */
  getUserCount() {
    return this.users.size;
  }

  /**
   * Update user activity timestamp and clear AFK status
   */
  updateUserActivity(sessionIndex) {
    const user = this.users.get(sessionIndex);
    if (user) {
      const wasAfk = user.afk;
      user.lastActivity = Date.now();
      user.afk = false;

      if (wasAfk) {
        this.broadcastToAll({ t: T.AFK, u: sessionIndex, a: false });
      }
    }
  }

  /**
   * Check all users for AFK timeout
   * Runs on interval via setInterval
   */
  checkAfkUsers() {
    const now = Date.now();
    this.users.forEach((user, sessionIndex) => {
      // Skip spectators (no name yet)
      if (!user.name) return;
      if (!user.afk && user.lastActivity && (now - user.lastActivity > AFK_TIMEOUT)) {
        user.afk = true;
        this.broadcastToAll({ t: T.AFK, u: sessionIndex, a: true });
        console.log(`User ${sessionIndex} marked as AFK`);
      }
    });
  }

  /**
   * Clear AFK check interval (for cleanup)
   */
  destroy() {
    if (this.afkCheckInterval) {
      clearInterval(this.afkCheckInterval);
    }
  }
}
