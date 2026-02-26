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
   */
  handleSyncRequest(ws, data) {
    console.log(`[Sync] User ${ws.sessionIndex} requested sync`);

    // Find another connected user who has joined (has a name) to provide the canvas
    let providerFound = false;
    const users = this.sessionManager.users;

    for (const [sessionIndex, userData] of users) {
      if (sessionIndex !== ws.sessionIndex && userData.name) {
        // Found a joined user - ask them to provide canvas
        console.log(`[Sync] Asking user ${sessionIndex} (${userData.name}) to provide canvas for user ${ws.sessionIndex}`);

        // Track this pending request
        this.pendingSyncRequests.set(ws.sessionIndex, true);

        // Find the provider's WebSocket and send SYNC_PROVIDE
        for (const client of this.wss.clients) {
          if (client.sessionIndex === sessionIndex && client.readyState === WebSocket.OPEN) {
            this.sendTo(client, {
              t: T.SYNC_PROVIDE,
              tu: ws.sessionIndex  // Tell provider who needs the canvas
            });
            providerFound = true;
            break;
          }
        }
        break;
      }
    }

    if (!providerFound) {
      // No other users - just send sync complete (empty canvas)
      console.log(`[Sync] No other users, sending empty sync complete to user ${ws.sessionIndex}`);
      this.sendTo(ws, { t: T.SYNC_COMPLETE });
    }
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
   * Relay SYNC_LAYER_BASE from provider to target joiner
   */
  handleSyncLayerBase(ws, data) {
    const targetUser = data.tu;
    const client = this._findClient(targetUser);
    if (client) {
      this.sendTo(client, { t: T.SYNC_LAYER_BASE, ly: data.ly, img: data.img });
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
