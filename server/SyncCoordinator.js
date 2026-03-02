import { WebSocket } from 'ws';
import { T } from '../shared/MessageTypes.js';

/**
 * SyncCoordinator
 *
 * Handles canvas synchronization for new users joining the session.
 *
 * Flow:
 * 1. New user sends SYNC_REQUEST
 * 2. Server picks an existing user and sends them SYNC_PROVIDE
 * 3. Provider captures canvas and sends SYNC_CANVAS back to server
 * 4. Server forwards canvas to new user and sends SYNC_COMPLETE
 *
 * If no provider is available, server sends SYNC_COMPLETE immediately (empty canvas).
 */
export class SyncCoordinator {
  constructor(sessionManager, wss, sendToCallback) {
    this.sessionManager = sessionManager;
    this.wss = wss;
    this.sendTo = sendToCallback;
    this.pendingSyncRequests = new Map(); // requestingUserIndex -> true
  }

  /**
   * Handle SYNC_REQUEST from new user
   * Find a provider and ask them to send canvas
   * @param {WebSocket} ws - Requesting user's WebSocket
   * @param {Object} data - Message data (may contain tu field for targeted sync)
   */
  handleSyncRequest(ws, data) {
    console.log(`[Sync] User ${ws.sessionIndex} requested sync`);

    let providerSessionIndex = null;

    // Check if user requested a specific provider
    if (data.tu !== undefined && data.tu !== null) {
      const requestedProvider = data.tu;
      const providerData = this.sessionManager.users.get(requestedProvider);

      if (providerData && providerData.name) {
        // Requested provider exists and is valid
        providerSessionIndex = requestedProvider;
        console.log(`[Sync] Using requested provider ${providerSessionIndex} (${providerData.name})`);
      } else {
        console.log(`[Sync] Requested provider ${requestedProvider} not available, using auto-select`);
      }
    }

    // If no valid requested provider, use smart selection
    if (providerSessionIndex === null) {
      providerSessionIndex = this.selectBestProvider(ws.sessionIndex);
      if (providerSessionIndex !== null) {
        const providerData = this.sessionManager.users.get(providerSessionIndex);
        console.log(`[Sync] Auto-selected provider ${providerSessionIndex} (${providerData.name})`);
      }
    }

    // If we have a provider, ask them to send canvas
    if (providerSessionIndex !== null) {
      // Track this pending request
      this.pendingSyncRequests.set(ws.sessionIndex, true);

      // Find the provider's WebSocket and send SYNC_PROVIDE
      const providerClient = this._findClient(providerSessionIndex);
      if (providerClient) {
        console.log(`[Sync] Asking user ${providerSessionIndex} to provide canvas for user ${ws.sessionIndex}`);
        this.sendTo(providerClient, {
          t: T.SYNC_PROVIDE,
          tu: ws.sessionIndex  // Tell provider who needs the canvas
        });
        return;
      }
    }

    // No provider available - send empty sync
    console.log(`[Sync] No provider available, sending empty sync complete to user ${ws.sessionIndex}`);
    this.sendTo(ws, { t: T.SYNC_COMPLETE });
  }

  /**
   * Select best provider using smart selection algorithm
   * Prefers most recently active users
   * @param {number} excludeSessionIndex - Don't select this user
   * @returns {number|null} Selected provider session index, or null if none available
   */
  selectBestProvider(excludeSessionIndex) {
    const candidates = [];

    for (const [sessionIndex, userData] of this.sessionManager.users) {
      if (sessionIndex !== excludeSessionIndex && userData.name) {
        candidates.push({
          sessionIndex,
          lastActivity: userData.lastActivity || 0,
        });
      }
    }

    if (candidates.length === 0) return null;

    // Sort by last activity (most recent first)
    candidates.sort((a, b) => b.lastActivity - a.lastActivity);

    // Return most recently active user
    return candidates[0].sessionIndex;
  }

  /**
   * Handle SYNC_CANVAS from provider (legacy, kept for compatibility)
   */
  handleSyncCanvas(ws, data) {
    const targetUser = data.tu;
    console.log(`[Sync] User ${ws.sessionIndex} providing legacy canvas for user ${targetUser}`);
    for (const client of this.wss.clients) {
      if (client.sessionIndex === targetUser && client.readyState === WebSocket.OPEN) {
        this.sendTo(client, { t: T.SYNC_CANVAS, u: ws.sessionIndex, img: data.img });
        this.sendTo(client, { t: T.SYNC_COMPLETE });
        this.pendingSyncRequests.delete(targetUser);
        break;
      }
    }
  }

  /**
   * Relay SYNC_METADATA from provider to target joiner
   */
  handleSyncMetadata(ws, data) {
    const targetUser = data.tu;
    console.log(`[Sync] Relaying metadata to user ${targetUser}, count:`, data.syncTotal);
    const client = this._findClient(targetUser);
    if (client) {
      // protobufjs uses camelCase for JS properties (sync_total proto field → syncTotal JS property)
      this.sendTo(client, { t: T.SYNC_METADATA, syncTotal: data.syncTotal });
    }
  }

  /**
   * Relay SYNC_LAYER_BASE from provider to target joiner
   */
  handleSyncLayerBase(ws, data) {
    const targetUser = data.tu;
    const client = this._findClient(targetUser);
    if (client) {
      this.sendTo(client, { t: T.SYNC_LAYER_BASE, ly: data.ly, bm: data.bm, img: data.img });
    }
  }

  /**
   * Relay SYNC_STROKE from provider to target joiner
   */
  handleSyncStroke(ws, data) {
    const targetUser = data.tu;
    const client = this._findClient(targetUser);
    if (client) {
      this.sendTo(client, {
        t: T.SYNC_STROKE,
        u: data.u,
        ly: data.ly,
        sx: data.sx, sy: data.sy, sw: data.sw, sh: data.sh,
        bm: data.bm,
        // protobufjs decodes snake_case proto fields as camelCase JS properties:
        // stroke_ts → strokeTs, stroke_redo → strokeRedo, stroke_redo_batch → strokeRedoBatch
        strokeTs: data.strokeTs,
        a: data.a,
        strokeRedo: data.strokeRedo,
        strokeRedoBatch: data.strokeRedoBatch,
        img: data.img
      });
    }
  }

  /**
   * Handle SYNC_STROKES_DONE from provider.
   * Relays done signal to joiner and sends SYNC_COMPLETE.
   */
  handleSyncStrokesDone(ws, data) {
    const targetUser = data.tu;
    console.log(`[Sync] User ${ws.sessionIndex} finished sending strokes for user ${targetUser}`);
    const client = this._findClient(targetUser);
    if (client) {
      this.sendTo(client, { t: T.SYNC_STROKES_DONE });
      this.sendTo(client, { t: T.SYNC_COMPLETE });
      this.pendingSyncRequests.delete(targetUser);
      console.log(`[Sync] Stroke sync complete for user ${targetUser}`);
    }
  }

  /** Find an open WebSocket for the given session index */
  _findClient(sessionIndex) {
    for (const client of this.wss.clients) {
      if (client.sessionIndex === sessionIndex && client.readyState === WebSocket.OPEN) {
        return client;
      }
    }
    return null;
  }

  /**
   * Clear all pending sync requests
   * Called when all users disconnect
   */
  clearPendingRequests() {
    this.pendingSyncRequests.clear();
  }
}
