/** @fileoverview Orchestrates the synchronization of canvas state between existing users and new joiners. */

import { WebSocket } from 'ws';
import { T } from '../shared/MessageTypes.js';
import { getProviderActivityTier, isRecentlyActive, scoreProvider } from './providerScoring.js';
import { getBoardDimensionsForSize } from '../shared/boardSizes.js';

const VISIBLE_SYNC_PROVIDER_TIMEOUT_MS = 3500;
const HIDDEN_SYNC_PROVIDER_TIMEOUT_MS = 15000;
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
   * Handles a sync request from a new user with the checkpoint-based join:
   * serve the latest server checkpoint image (seq S) as the base, then replay
   * the post-checkpoint tail — for each committed stroke in (S, latest], its
   * geometry preamble (MD/MM + tool-state, from `room.strokeTape`) followed by
   * the commit's original wire bytes (from `room.strokeLog`). The joiner's
   * normal receive pipeline both draws the canvas AND seeds its fingerprint log
   * from this single source, so there is no image-vs-log divergence and no
   * live-peer provider election. Finishes with SYNC_COMPLETE.
   *
   * NOTE: this replaced the legacy provider-election flow. The election/ranking
   * helpers and the SYNC_CANVAS/LAYER_BASE/STROKE/STROKE_BATCH/STROKES_DONE/
   * METADATA relay methods below are now unreachable on the join path and are
   * pending deletion once this path is live-verified (3-tab + k6 harness).
   *
   * @param {WebSocket} ws - The WebSocket of the requesting user.
   * @param {Object} _data - The sync request message data (provider hint ignored).
   */
  handleSyncRequest(ws, _data) {
    const requesterSessionIndex = Number(ws.sessionIndex);
    console.log(`[Sync] User ${requesterSessionIndex} requested checkpoint-based sync`);
    this._serveCheckpointJoin(ws, requesterSessionIndex).catch((err) => {
      console.error(`[Sync] Checkpoint join failed for ${requesterSessionIndex}:`, err);
      // Never leave the joiner hanging on the client-side idle timeout.
      if (ws.readyState === WebSocket.OPEN) this.sendTo(ws, { t: T.SYNC_COMPLETE });
    });
  }

  /**
   * Serves a checkpoint image + post-checkpoint command tail to a joiner, then
   * SYNC_COMPLETE. See handleSyncRequest for the rationale.
   * @param {WebSocket} ws
   * @param {number} requesterSessionIndex
   * @private
   */
  async _serveCheckpointJoin(ws, requesterSessionIndex) {
    if (ws.readyState !== WebSocket.OPEN) return;

    const log = this.room?.strokeLog;
    const tape = this.room?.strokeTape;
    let snapshot = null;

    // 1. Latest checkpoint image as the base (carries the applied-seq watermark
    //    S). Absent (fresh room / no persistence) → baseSeq 0, replay full tail.
    let baseSeq = 0;
    if (this.room?.canPersistSnapshots?.()) {
      snapshot = await this.room.getLatestSnapshotData?.();
      if (ws.readyState !== WebSocket.OPEN) return;
      if (snapshot && Array.isArray(snapshot.layers) && snapshot.layers.length > 0) {
        baseSeq = Number(snapshot.seq) || 0;
        this.sendTo(ws, {
          t: T.BOARD_SNAPSHOT_RESTORE,
          snapshotLayers: snapshot.layers,
          snapshotId: snapshot.id,
          snapshotTs: snapshot.ts,
          snapshotIssuer: snapshot.issuer,
          snapshotSeq: baseSeq,
        });
        console.log(`[Sync] Served checkpoint ${snapshot.id} @ seq ${baseSeq} to ${requesterSessionIndex}`);
      }
    }

    const latestSeqForMetadata = log?.getSummary?.().latestSeq || 0;
    const entriesForMetadata = latestSeqForMetadata > baseSeq && log
      ? log.getRange(baseSeq + 1, latestSeqForMetadata)
      : [];
    const checkpointMessageCount = snapshot && Array.isArray(snapshot.layers) && snapshot.layers.length > 0 ? 1 : 0;
    const tailMessageCount = entriesForMetadata.reduce((total, entry) => {
      const bundle = tape?.getBundle(entry.seq);
      return total + (bundle?.length || 0) + (log.getBytes(entry.seq) ? 1 : 0);
    }, 0);
    // In-flight (uncommitted) strokes have no commit seq yet, so they're absent
    // from both the checkpoint and the strokeLog tail. Replay their preambles so
    // the joiner re-begins each active stroke with the right tool state.
    const pendingBundles = tape?.getPendingBundles?.() || [];
    const pendingMessageCount = pendingBundles.reduce((total, b) => total + b.frames.length, 0);
    const [boardHeight, boardWidth] = getBoardDimensionsForSize(this.room?.settings?.boardSize);
    this.sendTo(ws, {
      t: T.SYNC_METADATA,
      syncTotal: checkpointMessageCount + tailMessageCount + pendingMessageCount,
      boardWidth,
      boardHeight
    });

    // 2. Replay the post-checkpoint command tail in seq order. Each commit may
    //    carry a geometry preamble (brush/pen strokes); self-contained commits
    //    (fill/selection/text) replay their bytes alone.
    if (log) {
      const latestSeq = log.getSummary().latestSeq;
      if (latestSeq > baseSeq) {
        const entries = log.getRange(baseSeq + 1, latestSeq);
        let served = 0, missing = 0;
        for (const entry of entries) {
          if (ws.readyState !== WebSocket.OPEN) return;
          const bundle = tape?.getBundle(entry.seq);
          if (bundle) {
            for (const frame of bundle) this.sendTo(ws, frame);
          }
          const bytes = log.getBytes(entry.seq);
          if (bytes) { this.sendTo(ws, bytes); served++; }
          else missing++;
        }
        console.log(`[Sync] Replayed tail (${baseSeq}, ${latestSeq}] to ${requesterSessionIndex}: ${served} commits${missing ? `, ${missing} evicted` : ''}`);
      }
    }

    // 2b. Replay in-flight (uncommitted) stroke preambles so a user who is
    //     mid-stroke at join time is visible to the joiner with the correct
    //     tool state (blend mode, size, color). No commit follows — the live
    //     MM/MU continuation lands on this open stroke. Sent after the tail so
    //     the active stroke sits above all committed strokes, matching peers.
    if (pendingBundles.length > 0) {
      let pendingStrokes = 0;
      for (const { frames } of pendingBundles) {
        if (ws.readyState !== WebSocket.OPEN) return;
        for (const frame of frames) this.sendTo(ws, frame);
        pendingStrokes++;
      }
      console.log(`[Sync] Replayed ${pendingStrokes} in-flight stroke(s) to ${requesterSessionIndex}`);
    }

    // 3. Live floating selections / masks / obscure regions, then complete.
    if (ws.readyState !== WebSocket.OPEN) return;
    this._sendActiveImagesToJoiner(ws);
    this._sendActiveMasksToJoiner(ws);
    this._sendActiveObscureRegionsToJoiner(ws);
    this.sendTo(ws, { t: T.SYNC_COMPLETE });
  }

  /**
   * Attempts to sync from the candidate at the given index.
   * If the candidate doesn't respond within its response timeout, tries the next one.
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

    const responseTimeoutMs = this._getProviderResponseTimeoutMs(providerClient);
    state.timeoutHandle = setTimeout(() => {
      const currentState = this.pendingSyncRequests.get(requesterSessionIndex);
      if (!currentState || currentState.responded || currentState.providerIdx !== providerIdx) return;
      console.log(`[Sync] Provider ${providerIdx} timed out after ${responseTimeoutMs}ms for user ${requesterSessionIndex}, trying next candidate`);
      this._tryNextCandidate(ws, requesterSessionIndex, candidates, idx + 1);
    }, responseTimeoutMs);

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
  _getRankedCandidates(requesterWs) {
    const candidates = [];
    const excludeIdx = Number(requesterWs.sessionIndex);

    for (const [sessionIndex, userData] of this.sessionManager.users) {
      const idx = Number(sessionIndex);
      if (idx === excludeIdx || !userData.name) continue;
      if (userData.afk) continue;
      const client = this._findClient(idx);
      if (client && client !== requesterWs) {
        candidates.push({
          sessionIndex: idx,
          score: scoreProvider(client, userData),
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
   * Hidden tabs can take multiple seconds to receive the request and export
   * canvases. Keep visible providers snappy, but do not fall through to stale
   * snapshots just because the only valid provider is backgrounded.
   * @param {WebSocket} providerClient
   * @returns {number}
   * @private
   */
  _getProviderResponseTimeoutMs(providerClient) {
    return providerClient?.tabHidden
      ? HIDDEN_SYNC_PROVIDER_TIMEOUT_MS
      : VISIBLE_SYNC_PROVIDER_TIMEOUT_MS;
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
        seq: data.seq ?? 0,
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
