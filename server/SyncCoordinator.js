/** @fileoverview Orchestrates the synchronization of canvas state between existing users and new joiners. */

import { WebSocket } from 'ws';
import { T } from '../shared/MessageTypes.js';
import { getProviderActivityTier, isRecentlyActive, scoreProvider } from './providerScoring.js';

const SYNC_PROVIDER_TIMEOUT_MS = 2000;
const MAX_SYNC_CANDIDATES = 3;
const ROOM_OVERLAY_SESSION_INDEX = 0xffffffff;

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
    /** @type {Map<number, {providerIdx: number, candidates: number[], candidatePos: number, responded: boolean, timeoutHandle: NodeJS.Timeout|null}>} */
    this.pendingSyncRequests = new Map();
    this.room = room;
  }

  /**
   * Handles a sync request from a new user by selecting a provider and initiating the flow.
   * Tries up to MAX_SYNC_CANDIDATES non-AFK providers with a timeout each before falling back.
   * @param {WebSocket} ws - The WebSocket of the requesting user.
   * @param {Object} data - The sync request message data.
   */
  handleSyncRequest(ws, data) {
    const requesterSessionIndex = Number(ws.sessionIndex);
    console.log(`[Sync] User ${requesterSessionIndex} requested sync`);

    // Honor an explicit provider request (even AFK users), only reject self or unknown
    let candidates = null;
    if (data.tu !== undefined && data.tu !== null) {
      const requestedProvider = Number(data.tu);
      const providerData = this.sessionManager.users.get(requestedProvider);
      if (providerData && providerData.name && requestedProvider !== requesterSessionIndex) {
        candidates = [requestedProvider];
        console.log(`[Sync] Using requested provider ${requestedProvider} (${providerData.name})${providerData.afk ? ' [AFK]' : ''}`);
      } else {
        console.log(`[Sync] Requested provider ${requestedProvider} is invalid or self — using auto-select`);
      }
    }

    if (!candidates) {
      candidates = this._getRankedCandidates(ws);
    }

    if (candidates.length === 0) {
      // Prefer an AFK provider over snapshot fallback so joiners still receive
      // the latest live canvas state (e.g. history region restores).
      const afkCandidates = this._getRankedCandidates(ws, { includeAfk: true });
      if (afkCandidates.length > 0) {
        console.log(`[Sync] No active providers; using AFK fallback provider list for user ${requesterSessionIndex}`);
        candidates = afkCandidates;
      } else {
        console.log(`[Sync] No providers available for user ${requesterSessionIndex}`);
        this._fallbackToSnapshotOrComplete(ws, requesterSessionIndex);
        return;
      }
    }

    this._tryNextCandidate(ws, requesterSessionIndex, candidates, 0);
  }

  /**
   * Attempts to sync from the candidate at the given index.
   * If the candidate doesn't respond within SYNC_PROVIDER_TIMEOUT_MS, tries the next one.
   * @param {WebSocket} ws - The requester's WebSocket.
   * @param {number} requesterSessionIndex
   * @param {number[]} candidates - Ranked list of provider session indices.
   * @param {number} idx - Current candidate index to try.
   * @private
   */
  _tryNextCandidate(ws, requesterSessionIndex, candidates, idx) {
    if (ws.readyState !== WebSocket.OPEN) return;

    if (idx >= candidates.length) {
      console.log(`[Sync] All ${candidates.length} candidate(s) exhausted for user ${requesterSessionIndex}`);
      this.pendingSyncRequests.delete(requesterSessionIndex);
      this._fallbackToSnapshotOrComplete(ws, requesterSessionIndex);
      return;
    }

    const providerIdx = candidates[idx];
    const providerClient = this._findClient(providerIdx);

    if (!providerClient) {
      // Client disconnected between selection and now — skip immediately
      this._tryNextCandidate(ws, requesterSessionIndex, candidates, idx + 1);
      return;
    }

    const state = {
      providerIdx,
      candidates,
      candidatePos: idx,
      responded: false,
      timeoutHandle: null
    };
    this.pendingSyncRequests.set(requesterSessionIndex, state);

    state.timeoutHandle = setTimeout(() => {
      const currentState = this.pendingSyncRequests.get(requesterSessionIndex);
      if (!currentState || currentState.responded || currentState.providerIdx !== providerIdx) return;
      console.log(`[Sync] Provider ${providerIdx} timed out for user ${requesterSessionIndex}, trying next candidate`);
      this._tryNextCandidate(ws, requesterSessionIndex, candidates, idx + 1);
    }, SYNC_PROVIDER_TIMEOUT_MS);

    const providerData = this.sessionManager.users.get(providerIdx);

    // Re-validate that the provider is still a suitable candidate
    // (they may have gone AFK since initial ranking)
    if (!providerData || !providerData.name || providerData.afk || providerClient.lowPowerMode) {
      console.log(`[Sync] Provider ${providerIdx} no longer suitable (AFK: ${providerData?.afk}, lowPower: ${providerClient.lowPowerMode}), trying next candidate`);
      this._tryNextCandidate(ws, requesterSessionIndex, candidates, idx + 1);
      return;
    }

    console.log(`[Sync] Asking user ${providerIdx} (${providerData?.name}, candidate ${idx + 1}/${candidates.length}) to provide for ${requesterSessionIndex}`);
    this.sendTo(providerClient, { t: T.SYNC_PROVIDE, tu: requesterSessionIndex });
  }

  /**
   * Falls back to the last snapshot if no users are actively drawing, otherwise sends SYNC_COMPLETE.
   * @param {WebSocket} ws - The requester's WebSocket.
   * @param {number} requesterSessionIndex
   * @private
   */
  async _fallbackToSnapshotOrComplete(ws, requesterSessionIndex) {
    if (ws.readyState !== WebSocket.OPEN) return;

    // If someone is actively drawing right now, don't load a stale snapshot —
    // they'll sync naturally as strokes come in.
    const anyoneDrawing = this._isAnyoneActivelyDrawing(requesterSessionIndex);
    
    if (!anyoneDrawing && this.room?.canPersistSnapshots?.()) {
      const snapshot = await this.room.getLatestSnapshotData?.();
      if (snapshot) {
        if (ws.readyState !== WebSocket.OPEN) return;
        console.log(`[Sync] Restoring snapshot ${snapshot.id} for user ${requesterSessionIndex}`);
        this.sendTo(ws, {
          t: T.BOARD_SNAPSHOT_RESTORE,
          snapshotLayers: snapshot.layers,
          snapshotId: snapshot.id,
          snapshotTs: snapshot.ts,
          snapshotIssuer: snapshot.issuer
        });
        this._sendActiveImagesToJoiner(ws);
        this._sendActiveMasksToJoiner(ws);
        this._sendActiveObscureRegionsToJoiner(ws);
        this.sendTo(ws, { t: T.SYNC_COMPLETE });
        return;
      }
    }

    console.log(`[Sync] No snapshot fallback${anyoneDrawing ? ' (someone is drawing)' : ''}, sending empty sync complete to user ${requesterSessionIndex}`);
    this._sendActiveImagesToJoiner(ws);
    this._sendActiveMasksToJoiner(ws);
    this._sendActiveObscureRegionsToJoiner(ws);
    this.sendTo(ws, { t: T.SYNC_COMPLETE });
  }

  /**
   * Returns whether any non-AFK user (other than the given session) currently has a stroke in progress.
   * @param {number} excludeSessionIndex
   * @returns {boolean}
   * @private
   */
  _isAnyoneActivelyDrawing(excludeSessionIndex) {
    for (const [idx, userData] of this.sessionManager.users) {
      if (Number(idx) === excludeSessionIndex) continue;
      if (userData.mousedown && !userData.afk) return true;
    }
    return false;
  }

  /**
   * Returns whether the provider sending sync data is still the active provider
   * for the requester associated with the payload.
   * Cancels the timeout on first response from the provider.
   * @param {WebSocket} ws
   * @param {Object} data
   * @returns {number|null}
   * @private
   */
  _getActiveSyncTarget(ws, data) {
    const targetUser = Number(data.tu);
    const state = this.pendingSyncRequests.get(targetUser);
    if (!state) {
      console.log(`[Sync] Ignoring sync data from ${ws.sessionIndex}; no active request for ${targetUser}`);
      return null;
    }
    if (Number(ws.sessionIndex) !== state.providerIdx) {
      console.log(`[Sync] Ignoring stale sync data from ${ws.sessionIndex}; active provider for ${targetUser} is ${state.providerIdx}`);
      return null;
    }
    // First response from provider — cancel the timeout
    if (!state.responded) {
      state.responded = true;
      if (state.timeoutHandle) {
        clearTimeout(state.timeoutHandle);
        state.timeoutHandle = null;
        console.log(`[Sync] Provider ${ws.sessionIndex} responded for user ${targetUser}`);
      }
    }
    return targetUser;
  }

  /**
   * Returns up to MAX_SYNC_CANDIDATES ranked non-AFK providers for the requester.
   * @param {WebSocket} requesterWs
   * @returns {number[]} Session indices, best first.
   * @private
   */
  _getRankedCandidates(requesterWs, options = {}) {
    const includeAfk = options.includeAfk === true;
    const candidates = [];
    const excludeIdx = Number(requesterWs.sessionIndex);

    for (const [sessionIndex, userData] of this.sessionManager.users) {
      const idx = Number(sessionIndex);
      if (idx === excludeIdx || !userData.name) continue;
      if (!includeAfk && userData.afk) continue;
      const client = this._findClient(idx);
      if (client && client !== requesterWs) {
        candidates.push({
          sessionIndex: idx,
          score: scoreProvider(client, userData, { allowAfk: includeAfk }),
          activityTier: getProviderActivityTier(userData),
          active: isRecentlyActive(userData),
          hidden: !!client.tabHidden,
        });
      }
    }

    candidates.sort((a, b) => {
      if (b.activityTier !== a.activityTier) return b.activityTier - a.activityTier;
      if (b.score !== a.score) return b.score - a.score;
      if (a.hidden !== b.hidden) return Number(a.hidden) - Number(b.hidden);
      if (a.active !== b.active) return Number(b.active) - Number(a.active);
      return b.sessionIndex - a.sessionIndex;
    });

    return candidates.slice(0, MAX_SYNC_CANDIDATES).map(c => c.sessionIndex);
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
        this._sendActiveMasksToJoiner(client);
        this._sendActiveObscureRegionsToJoiner(client);
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
        u: ws.sessionIndex,
        syncTotal,
        boardWidth: data.boardWidth ?? data.board_width ?? 0,
        boardHeight: data.boardHeight ?? data.board_height ?? 0
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
        bbm: data.bbm,
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
      this._sendActiveMasksToJoiner(client);
      this._sendActiveObscureRegionsToJoiner(client);
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
        const moveMsg = { t: T.SEL_MOVE, u: sessionIndex, cr: userData.activeSelectionCorners };
        if (userData.activeSelectionSourceCrop) {
          moveMsg.cb = userData.activeSelectionSourceCrop;
        }
        this.sendTo(joinerWs, moveMsg);
      }
    }
  }

  _sendActiveMasksToJoiner(joinerWs) {
    for (const [sessionIndex, userData] of this.sessionManager.users) {
      if (!userData.activeMask) continue;
      const { sx, sy, sw, sh, ps } = userData.activeMask;
      const msg = { t: T.SEL_MASK, u: sessionIndex, mk: true, sx, sy, sw, sh };
      if (Array.isArray(ps) && ps.length >= 6) {
        msg.ps = ps;
      }
      this.sendTo(joinerWs, msg);
    }
  }

  _sendActiveObscureRegionsToJoiner(joinerWs) {
    for (const region of this.room?.obscureRegions?.values?.() || []) {
      this.sendTo(joinerWs, { t: T.OBSCURE_REGION, u: ROOM_OVERLAY_SESSION_INDEX, g: JSON.stringify(region) });
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
    for (const state of this.pendingSyncRequests.values()) {
      if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
    }
    this.pendingSyncRequests.clear();
  }
}
