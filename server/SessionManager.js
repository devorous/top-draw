/** @fileoverview Manages user sessions, state tracking, and AFK detection. */

import { T } from '../shared/MessageTypes.js';

/**
 * User role constants.
 * @enum {number}
 */
export const Role = { GUEST: 0, USER: 1, MOD: 2, ADMIN: 3 };

const AFK_TIMEOUT = 2 * 60 * 1000;
const AFK_CHECK_INTERVAL = 30 * 1000;

/**
 * Manages user session indices, user data, and AFK tracking.
 */
export class SessionManager {
  /**
   * @param {function} broadcastCallback - Function to broadcast messages to all users.
   */
  constructor(broadcastCallback) {
    this.sessions = new Map();
    this.users = new Map();
    this.nextSessionIndex = 0;
    this.freedIndices = [];
    this.broadcastToAll = broadcastCallback;

    this.afkCheckInterval = setInterval(() => this.checkAfkUsers(), AFK_CHECK_INTERVAL);
  }

  /**
   * Allocates a session index for a new user, reusing freed indices if available.
   * @returns {number} - The allocated session index.
   */
  allocateSessionIndex() {
    if (this.freedIndices.length > 0) {
      return this.freedIndices.pop();
    }
    return this.nextSessionIndex++;
  }

  /**
   * Frees a session index for future reuse.
   * @param {number} index - The session index to free.
   */
  freeSessionIndex(index) {
    this.freedIndices.push(index);
  }

  /**
   * Creates and stores a new user record.
   * @param {number} sessionIndex - Assigned session index.
   * @param {string} [name=''] - User's display name.
   * @param {number} tool - Initial tool ID.
   * @param {number} color - Initial packed RGBA color.
   * @returns {Object} - The created user object.
   */
  createUser(sessionIndex, name = '', tool, color) {
    const newUser = {
      sessionIndex,
      afk: false,
      cursorHidden: true,
      lastActivity: Date.now(),
      x: 0, y: 0, lastx: 0, lasty: 0,
      mousedown: false,
      tool,
      color,
      size: 1000,
      spacing: 10,
      smoothing: 15,
      hardness: 100,
      pressure: 100,
      blurRadius: 5,
      name,
      text: '',
      imageBrush: null,
      role: Role.ADMIN
    };
    this.users.set(sessionIndex, newUser);
    return newUser;
  }

  /**
   * Retrieves user data by session index.
   * @param {number} sessionIndex - The session index.
   * @returns {Object|undefined} - The user object or undefined if not found.
   */
  getUser(sessionIndex) {
    return this.users.get(sessionIndex);
  }

  /**
   * Removes a user record from the manager.
   * @param {number} sessionIndex - The session index of the user to remove.
   */
  removeUser(sessionIndex) {
    this.users.delete(sessionIndex);
  }

  /**
   * Returns all users who have joined the room (i.e., have a name).
   * @returns {Array<Object>} - A list of joined user objects.
   */
  getJoinedUsers() {
    return Array.from(this.users.values()).filter(u => u.name);
  }

  /**
   * Returns the total number of users currently tracked.
   * @returns {number} - The user count.
   */
  getUserCount() {
    return this.users.size;
  }

  /**
   * Updates a user's activity timestamp and clears their AFK status.
   * @param {number} sessionIndex - The session index of the user.
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
   * Periodically checks all users for AFK timeouts and broadcasts updates.
   */
  checkAfkUsers() {
    const now = Date.now();
    this.users.forEach((user, sessionIndex) => {
      if (!user.name) return;
      if (!user.afk && user.lastActivity && (now - user.lastActivity > AFK_TIMEOUT)) {
        user.afk = true;
        this.broadcastToAll({ t: T.AFK, u: sessionIndex, a: true });
        console.log(`User ${sessionIndex} marked as AFK`);
      }
    });
  }

  /**
   * Cleans up resources, such as clearing the AFK check interval.
   */
  destroy() {
    if (this.afkCheckInterval) {
      clearInterval(this.afkCheckInterval);
    }
  }
}
