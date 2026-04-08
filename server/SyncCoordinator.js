/** @fileoverview Orchestrates the synchronization of canvas state between existing users and new joiners. */

import { WebSocket } from 'ws';
import { T } from '../shared/MessageTypes.js';
import { isRecentlyActive, scoreProvider } from './providerScoring.js';

/**
 * Handles the multi-step canvas synchronization flow for new users.
 */
export class SyncCoordinator {
  /**
   * @param {SessionManager} sessionManager - The session manager instance.
   * @param {Object} wss - The WebSocket server or room client set.
   * @param {function} sendToCallback - Function to send messages to a specific client.
   * @param {Object} [room=null] - The room object (for accessing tile ownership).
   */
  constructor(sessionManager, wss, sendToCallback, room = null) {
    this.sessionManager = sessionManager;
    this.wss = wss;
    this.sendTo = sendToCallback;
    this.pendingSyncRequests = new Map();
    this.room = room;
  }

  /**
   * Handles a sync request from a new user by selecting a provider and initiating the flow.
   * @param {WebSocket} ws - The WebSocket of the requesting user.
   * @param {Object} data - The sync request message data.
   */
  handleSyncRequest(ws, data) {
    const requesterSessionIndex = Number(ws.sessionIndex);
    this.sessionManager.markUserActive(requesterSessionIndex);
    console.log(`[Sync] User ${requesterSessionIndex} requested sync`);

    let providerSessionIndex = null;

    if (data.tu !== undefined && data.tu !== null) {
      const requestedProvider = Number(data.tu);
      const providerData = this.sessionManager.users.get(requestedProvider);

      if (providerData && providerData.name && requestedProvider !== requesterSessionIndex) {
        providerSessionIndex = requestedProvider;
        console.log(`[Sync] Using requested provider ${providerSessionIndex} (${providerData.name}) hidden=${!!this._findClient(providerSessionIndex)?.tabHidden} afk=${!!providerData.afk}`);
      } else {
        console.log(`[Sync] Requested provider ${requestedProvider} not available or invalid, using auto-select`);
      }
    }

    if (providerSessionIndex === null) {
      providerSessionIndex = this.selectBestProvider(ws);
      if (providerSessionIndex !== null) {
        const providerData = this.sessionManager.users.get(providerSessionIndex);
        const providerClient = this._findClient(providerSessionIndex);
        console.log(`[Sync] Auto-selected provider ${providerSessionIndex} (${providerData.name}) hidden=${!!providerClient?.tabHidden} afk=${!!providerData?.afk}`);
      }
    }

    if (providerSessionIndex !== null) {
      this.pendingSyncRequests.set(requesterSessionIndex, providerSessionIndex);

      const providerClient = this._findClient(providerSessionIndex);
      if (providerClient) {
        console.log(`[Sync] Asking user ${providerSessionIndex} to provide canvas for user ${requesterSessionIndex}`);
        this.sendTo(providerClient, {
          t: T.SYNC_PROVIDE,
          tu: requesterSessionIndex
        });
        return;
      }
    }

    this.pendingSyncRequests.delete(requesterSessionIndex);
    console.log(`[Sync] No provider available, sending empty sync complete to user ${requesterSessionIndex}`);
    this.sendTo(ws, { t: T.SYNC_COMPLETE });
  }

  /**
   * Returns whether the provider sending sync data is still the active provider
   * for the requester associated with the payload.
   * @param {WebSocket} ws
   * @param {Object} data
   * @returns {number|null}
   * @private
   */
  _getActiveSyncTarget(ws, data) {
    const targetUser = Number(data.tu);
    const activeProvider = this.pendingSyncRequests.get(targetUser);
    if (activeProvider === undefined) {
      console.log(`[Sync] Ignoring sync data from ${ws.sessionIndex}; no active request for ${targetUser}`);
      return null;
    }
    if (Number(ws.sessionIndex) !== Number(activeProvider)) {
      console.log(`[Sync] Ignoring stale sync data from ${ws.sessionIndex}; active provider for ${targetUser} is ${activeProvider}`);
      return null;
    }
    return targetUser;
  }

  /**
   * Selects the most suitable user to provide the canvas state.
   * @param {WebSocket} requesterWs - The WebSocket of the requester to exclude.
   * @returns {number|null} - The session index of the selected provider, or null.
   */
  selectBestProvider(requesterWs) {
    const candidates = [];
    const excludeIdx = Number(requesterWs.sessionIndex);

    for (const [sessionIndex, userData] of this.sessionManager.users) {
      const idx = Number(sessionIndex);
      if (idx !== excludeIdx && userData.name) {
        // Also exclude by WS reference to be ultra-safe against uninitialized sessionIndex
        const client = this._findClient(idx);
        if (client && client !== requesterWs) {
          candidates.push({
            sessionIndex: idx,
            score: scoreProvider(client, userData),
            active: isRecentlyActive(userData),
            hidden: !!client.tabHidden,
          });
        }
      }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.hidden !== b.hidden) return Number(a.hidden) - Number(b.hidden);
      if (a.active !== b.active) return Number(b.active) - Number(a.active);
      return b.sessionIndex - a.sessionIndex;
    });

    return candidates[0].sessionIndex;
  }

  /**
   * Handles legacy full-canvas synchronization messages.
   * @param {WebSocket} ws - The WebSocket of the provider.
   * @param {Object} data - The sync canvas message data.
   */
  handleSyncCanvas(ws, data) {
    const targetUser = this._getActiveSyncTarget(ws, data);
    if (targetUser === null) return;
    console.log(`[Sync] User ${ws.sessionIndex} providing legacy canvas for user ${targetUser}`);
    for (const client of this.wss.clients) {
      if (client.sessionIndex === targetUser && client.readyState === WebSocket.OPEN) {
        this.sendTo(client, { t: T.SYNC_CANVAS, u: ws.sessionIndex, img: data.img });
        this._sendActiveImagesToJoiner(client);
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
    const targetUser = this._getActiveSyncTarget(ws, data);
    if (targetUser === null) return;
    const syncTotal = Number(data.syncTotal ?? data.sync_total ?? 0);
    console.log(`[Sync] Relaying metadata to user ${targetUser}, count:`, syncTotal);
    const client = this._findClient(targetUser);
    if (client) {
      this.sendTo(client, {
        t: T.SYNC_METADATA,
        syncTotal
      });
    }
  }

  /**
   * Relays base layer image data to the requesting joiner.
   * @param {WebSocket} ws - The WebSocket of the provider.
   * @param {Object} data - The sync layer base message data.
   */
  handleSyncLayerBase(ws, data) {
    const targetUser = this._getActiveSyncTarget(ws, data);
    if (targetUser === null) return;
    const client = this._findClient(targetUser);
    if (client) {
      this.sendTo(client, { 
        t: T.SYNC_LAYER_BASE, 
        ly: data.ly, 
        bm: data.bm, 
        img: data.img 
      });
    }
  }

  /**
   * Relays an individual stroke record to the requesting joiner.
   * @param {WebSocket} ws - The WebSocket of the provider.
   * @param {Object} data - The sync stroke message data.
   */
  handleSyncStroke(ws, data) {
    const targetUser = this._getActiveSyncTarget(ws, data);
    if (targetUser === null) return;
    const client = this._findClient(targetUser);
    if (client) {
      // Use the field names defined in public/messages.proto for SYNC_STROKE
      this.sendTo(client, {
        t: T.SYNC_STROKE,
        u: data.u,
        ly: data.ly,
        sx: data.sx,
        sy: data.sy,
        sw: data.sw, 
        sh: data.sh,
        bm: data.bm,
        strokeTs: data.strokeTs ?? data.stroke_ts ?? 0,
        a: data.a,
        strokeRedo: data.strokeRedo ?? data.stroke_redo ?? false,
        strokeRedoBatch: data.strokeRedoBatch ?? data.stroke_redo_batch ?? 0,
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
    const targetUser = this._getActiveSyncTarget(ws, data);
    if (targetUser === null) return;
    const client = this._findClient(targetUser);
    if (client) {
      this.sendTo(client, {
        t: T.SYNC_STROKE_BATCH,
        strokes: data.strokes,
        layerIdx: data.layerIdx
      });
    }
  }

  /**
   * Handles the signal that all strokes have been sent, completing the sync flow.
   * @param {WebSocket} ws - The WebSocket of the provider.
   * @param {Object} data - The sync strokes done message data.
   */
  handleSyncStrokesDone(ws, data) {
    const targetUser = this._getActiveSyncTarget(ws, data);
    if (targetUser === null) return;
    console.log(`[Sync] User ${ws.sessionIndex} finished sending strokes for user ${targetUser}`);
    const client = this._findClient(targetUser);
    if (client) {
      this.sendTo(client, { t: T.SYNC_STROKES_DONE });

      // Send server's authoritative dirty tile data
      const dirtyTiles = this.room?.getDirtyTilesForSync();
      if (dirtyTiles && dirtyTiles.length > 0) {
        this.sendTo(client, { t: T.SYNC_TILE_OWNERSHIP, tiles: dirtyTiles });
        console.log(`[Sync] Sent ${dirtyTiles.length} dirty tile entries to user ${targetUser}`);
      }

      this._sendActiveImagesToJoiner(client);
      this.sendTo(client, { t: T.SYNC_COMPLETE });
      this.pendingSyncRequests.delete(targetUser);
      console.log(`[Sync] Stroke sync complete for user ${targetUser}`);
    }
  }

  /**
   * Relays dirty tile data to the requesting joiner.
   * @param {WebSocket} ws - The WebSocket of the provider.
   * @param {Object} data - The tile sync message data.
   */
  handleSyncDirtyTiles(ws, data) {
    const targetUser = this._getActiveSyncTarget(ws, data);
    if (targetUser === null) return;
    const client = this._findClient(targetUser);
    if (client) {
      this.sendTo(client, {
        t: T.SYNC_TILE_OWNERSHIP,
        tiles: data.tiles || data.dirtyTiles || []
      });
    }
  }

  /**
   * Sends active floating selection images to a newly joined user.
   * Called just before SYNC_COMPLETE so the new user's canvas is already built.
   * @param {WebSocket} joinerWs - The WebSocket of the new user.
   * @private
   */
  _sendActiveImagesToJoiner(joinerWs) {
    for (const [sessionIndex, userData] of this.sessionManager.users) {
      if (!userData.activeImage) continue;
      const { sx, sy, sw, sh, g } = userData.activeImage;
      this.sendTo(joinerWs, { t: T.IMG_PASTE, u: sessionIndex, sx, sy, sw, sh, g });
      // If the selection has been moved from its initial position, send current corners
      if (userData.activeSelectionCorners) {
        this.sendTo(joinerWs, { t: T.SEL_MOVE, u: sessionIndex, cr: userData.activeSelectionCorners });
      }
    }
  }

  /**
   * Finds an open WebSocket client by their session index.
   * @param {number} sessionIndex - The session index to find.
   * @returns {WebSocket|null} - The client WebSocket or null.
   * @private
   */
  _findClient(sessionIndex) {
    const idx = Number(sessionIndex);
    for (const client of this.wss.clients) {
      if (Number(client.sessionIndex) === idx && client.readyState === WebSocket.OPEN) {
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
