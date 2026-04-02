/** @fileoverview Manages user sessions, state tracking, and AFK detection. */

import { T } from '../shared/MessageTypes.js';

/**
 * User role constants.
 * @enum {number}
 */
/**
 * Permission tiers — higher value = more authority.
 *
 * Room-scoped ranks (0–6): expected to exercise powers only in their assigned room.
 *   GUEST    (0) – Unauthenticated visitor
 *   USER     (1) – Registered account
 *   TRUSTED  (2) – Trusted community member
 *   HELPER   (3) – Can mute in room
 *   MOD      (4) – Full moderator in room (kick, ban, clear, wipe)
 *   ADMIN    (5) – Room administrator
 *   OWNER    (6) – Room owner (only one per room, ultimate room authority)
 *
 * Global ranks (7–9): authority extends across all rooms.
 *   NOBLE    (7) – Global mute
 *   HOLY     (8) – Global mute + ban
 *   DEITY    (9) – All powers everywhere + exclusive abilities
 */
export const Role = {
  GUEST:   0,
  USER:    1,
  TRUSTED: 2,
  HELPER:  3,
  MOD:     4,
  ADMIN:   5,
  OWNER:   6,
  NOBLE:   7,
  HOLY:    8,
  DEITY:   9,
};

const AFK_TIMEOUT = 5 * 60 * 1000;
const AFK_CHECK_INTERVAL = 30 * 1000;

/**
 * Manages user session indices, user data, and AFK tracking.
 */
export class SessionManager {
  /**
   * @param {function} broadcastCallback - Function to broadcast messages to all users.
   * @param {boolean} [isDiscovery=false] - Whether this manager is for a discovery/lobby room.
   */
  constructor(broadcastCallback, isDiscovery = false, options = {}) {
    this.sessions = new Map();
    this.users = new Map();
    this.nextSessionIndex = 0;
    this.freedIndices = [];
    this.broadcastToAll = broadcastCallback;
    this.isDiscovery = isDiscovery;
    this.isImmuneToInactivity = options.isImmuneToInactivity || (() => false);

    this.afkCheckInterval = setInterval(() => this.checkAfkUsers(), AFK_CHECK_INTERVAL);
  }

  /**
   * Returns a unique name by appending a suffix if the name is already taken.
   * @param {string} name - The desired name.
   * @param {number|null} [excludeSessionIndex=null] - The session index to exclude from the check.
   * @returns {string} - A unique name.
   */
  getUniqueName(name, excludeSessionIndex = null) {
    if (!name) return '';
    
    const joinedUsers = this.getJoinedUsers();
    let uniqueName = name;
    let suffix = 1;

    const isNameTaken = (n) => {
      return joinedUsers.some(u => 
        u.sessionIndex !== excludeSessionIndex && 
        u.name.toLowerCase() === n.toLowerCase()
      );
    };

    while (isNameTaken(uniqueName)) {
      uniqueName = `${name}-${suffix}`;
      suffix++;
    }

    return uniqueName;
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
   * @param {string} [ipHash=''] - Obfuscated IP hash.
   * @returns {Object} - The created user object.
   */
  createUser(sessionIndex, name = '', tool, color, ipHash = '') {
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
      thinning: 51, // 0.5 with offset (50 + 1)
      simulatePressure: 2, // true with offset
      name,
      registeredName: '',
      text: '',
      imageBrush: null,
      activeImage: null,           // { sx, sy, sw, sh, g } — active floating selection for sync replay
      activeSelectionCorners: null, // [tl.x, tl.y, tr.x, tr.y, bl.x, bl.y, br.x, br.y] — latest SEL_MOVE position
      role: Role.GUEST,
      ipHash
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
   * For discovery rooms, this always returns an empty list to prevent ghost users.
   * @returns {Array<Object>} - A list of joined user objects.
   */
  getJoinedUsers() {
    if (this.isDiscovery) return [];
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
   * Updates a user's activity timestamp.
   * Once marked inactive, a user remains inactive until an explicit resync.
   * @param {number} sessionIndex - The session index of the user.
   */
  updateUserActivity(sessionIndex) {
    const user = this.users.get(sessionIndex);
    if (user) {
      user.lastActivity = Date.now();
    }
  }

  /**
   * Marks a user active again, clearing their inactive state.
   * @param {number} sessionIndex - The session index of the user.
   */
  markUserActive(sessionIndex) {
    const user = this.users.get(sessionIndex);
    if (!user) return;

    const wasAfk = user.afk;
    user.lastActivity = Date.now();
    user.afk = false;

    if (wasAfk) {
      this.broadcastToAll({ t: T.AFK, u: sessionIndex, a: false });
    }
  }

  /**
   * Periodically checks all users for AFK timeouts and broadcasts updates.
   */
  checkAfkUsers() {
    const now = Date.now();
    const joinedUsers = this.getJoinedUsers();
    const shouldSuspendInactivity = joinedUsers.length <= 1;

    this.users.forEach((user, sessionIndex) => {
      if (!user.name) return;
      if (shouldSuspendInactivity || this.isImmuneToInactivity(sessionIndex, user)) {
        if (user.afk) {
          user.afk = false;
          this.broadcastToAll({ t: T.AFK, u: sessionIndex, a: false });
        }
        return;
      }
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
