/** @fileoverview Orchestrates the synchronization of canvas state between existing users and new joiners. */

import { WebSocket } from 'ws';
import { T } from '../shared/MessageTypes.js';

/**
 * Handles the multi-step canvas synchronization flow for new users.
 */
export class SyncCoordinator {
  /**
   * @param {SessionManager} sessionManager - The session manager instance.
   * @param {Object} wss - The WebSocket server or room client set.
   * @param {function} sendToCallback - Function to send messages to a specific client.
   */
  constructor(sessionManager, wss, sendToCallback) {
    this.sessionManager = sessionManager;
    this.wss = wss;
    this.sendTo = sendToCallback;
    this.pendingSyncRequests = new Map();
  }

  /**
   * Handles a sync request from a new user by selecting a provider and initiating the flow.
   * @param {WebSocket} ws - The WebSocket of the requesting user.
   * @param {Object} data - The sync request message data.
   */
  handleSyncRequest(ws, data) {
    console.log(`[Sync] User ${ws.sessionIndex} requested sync`);

    let providerSessionIndex = null;

    if (data.tu !== undefined && data.tu !== null) {
      const requestedProvider = data.tu;
      const providerData = this.sessionManager.users.get(requestedProvider);

      if (providerData && providerData.name) {
        providerSessionIndex = requestedProvider;
        console.log(`[Sync] Using requested provider ${providerSessionIndex} (${providerData.name})`);
      } else {
        console.log(`[Sync] Requested provider ${requestedProvider} not available, using auto-select`);
      }
    }

    if (providerSessionIndex === null) {
      providerSessionIndex = this.selectBestProvider(ws.sessionIndex);
      if (providerSessionIndex !== null) {
        const providerData = this.sessionManager.users.get(providerSessionIndex);
        console.log(`[Sync] Auto-selected provider ${providerSessionIndex} (${providerData.name})`);
      }
    }

    if (providerSessionIndex !== null) {
      this.pendingSyncRequests.set(ws.sessionIndex, true);

      const providerClient = this._findClient(providerSessionIndex);
      if (providerClient) {
        console.log(`[Sync] Asking user ${providerSessionIndex} to provide canvas for user ${ws.sessionIndex}`);
        this.sendTo(providerClient, {
          t: T.SYNC_PROVIDE,
          tu: ws.sessionIndex
        });
        return;
      }
    }

    console.log(`[Sync] No provider available, sending empty sync complete to user ${ws.sessionIndex}`);
    this.sendTo(ws, { t: T.SYNC_COMPLETE });
  }

  /**
   * Selects the most suitable user to provide the canvas state.
   * @param {number} excludeSessionIndex - The session index of the requester.
   * @returns {number|null} - The session index of the selected provider, or null.
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

    candidates.sort((a, b) => b.lastActivity - a.lastActivity);

    return candidates[0].sessionIndex;
  }

  /**
   * Handles legacy full-canvas synchronization messages.
   * @param {WebSocket} ws - The WebSocket of the provider.
   * @param {Object} data - The sync canvas message data.
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
   * Relays sync metadata (e.g., total stroke count) to the requesting joiner.
   * @param {WebSocket} ws - The WebSocket of the provider.
   * @param {Object} data - The sync metadata message data.
   */
  handleSyncMetadata(ws, data) {
    const targetUser = data.tu;
    console.log(`[Sync] Relaying metadata to user ${targetUser}, count:`, data.syncTotal);
    const client = this._findClient(targetUser);
    if (client) {
      this.sendTo(client, { t: T.SYNC_METADATA, syncTotal: data.syncTotal });
    }
  }

  /**
   * Relays base layer image data to the requesting joiner.
   * @param {WebSocket} ws - The WebSocket of the provider.
   * @param {Object} data - The sync layer base message data.
   */
  handleSyncLayerBase(ws, data) {
    const targetUser = data.tu;
    const client = this._findClient(targetUser);
    if (client) {
      this.sendTo(client, { t: T.SYNC_LAYER_BASE, ly: data.ly, bm: data.bm, img: data.img });
    }
  }

  /**
   * Relays an individual stroke record to the requesting joiner.
   * @param {WebSocket} ws - The WebSocket of the provider.
   * @param {Object} data - The sync stroke message data.
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
        strokeTs: data.strokeTs,
        a: data.a,
        strokeRedo: data.strokeRedo,
        strokeRedoBatch: data.strokeRedoBatch,
        img: data.img
      });
    }
  }

  /**
   * Relays a batch of stroke records to the requesting joiner.
   * @param {WebSocket} ws - The WebSocket of the provider.
   * @param {Object} data - The sync stroke batch message data.
   */
  handleSyncStrokeBatch(ws, data) {
    const targetUser = data.tu;
    const client = this._findClient(targetUser);
    if (client) {
      this.sendTo(client, {
        t: T.SYNC_STROKE_BATCH,
        strokes: data.strokes,
        layerIdx: data.layerIdx,
        tu: data.tu
      });
    }
  }

  /**
   * Handles the signal that all strokes have been sent, completing the sync flow.
   * @param {WebSocket} ws - The WebSocket of the provider.
   * @param {Object} data - The sync strokes done message data.
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

  /**
   * Finds an open WebSocket client by their session index.
   * @param {number} sessionIndex - The session index to find.
   * @returns {WebSocket|null} - The client WebSocket or null.
   * @private
   */
  _findClient(sessionIndex) {
    for (const client of this.wss.clients) {
      if (client.sessionIndex === sessionIndex && client.readyState === WebSocket.OPEN) {
        return client;
      }
    }
    return null;
  }

  /**
   * Clears all tracking for pending sync requests.
   */
  clearPendingRequests() {
    this.pendingSyncRequests.clear();
  }
}
