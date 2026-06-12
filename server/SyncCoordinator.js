/** @fileoverview Orchestrates the synchronization of canvas state between existing users and new joiners. */

import { WebSocket } from 'ws';
import { T } from '../shared/MessageTypes.js';
import { getBoardDimensionsForSize } from '../shared/boardSizes.js';

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
   * NOTE: this replaced the legacy provider-election flow (the SYNC_PROVIDE /
   * SYNC_CANVAS / LAYER_BASE / STROKE relay path), which has since been removed.
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

    // A lone joiner has no peers to stay in sync with, so we do NOT auto-apply
    // the persisted checkpoint as their base. The opt-in BOARD_SNAPSHOT_JOIN_NOTIFY
    // toast (handleSnapshotJoinNotify, also gated on clientCount === 1) lets them
    // choose to load it. They start from the live command tail only — empty for a
    // cold room, i.e. a blank canvas. With peers present the checkpoint base IS
    // required: it's the permanent content (<= watermark) the replayed tail builds
    // on, so the joiner matches what everyone else renders.
    const clientCount = this.room?.getClientCount?.() ?? 1;
    const aloneJoiner = clientCount <= 1;

    // 1. Latest checkpoint image as the base (carries the applied-seq watermark
    //    S). Absent (fresh room / no persistence / lone joiner) → baseSeq 0,
    //    replay full tail.
    let baseSeq = 0;
    if (aloneJoiner && this.room?.canPersistSnapshots?.()) {
      // Lone joiner: deliberately do NOT auto-apply the persisted checkpoint
      // (no peers to match). Log whether one actually existed first, so solo-join
      // verification can distinguish "correctly skipped an existing checkpoint"
      // from "none existed" (Issue 4). hasInMemoryJoinCheckpoint() is the live
      // rolling-buffer view; a DB/R2-only checkpoint won't show here.
      const hadInMemoryCheckpoint = !!this.room.hasInMemoryJoinCheckpoint?.();
      this.room.invalidateJoinCheckpoint?.();
      console.log(`[Sync] Lone joiner ${requesterSessionIndex}: skipping persisted join checkpoint (in-memory checkpoint existed=${hadInMemoryCheckpoint}); starting from live command tail only`);
    } else if (this.room?.canPersistSnapshots?.()) {
      snapshot = await this.room.getLatestSnapshotData?.({ forJoin: true });
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

        // Invariant guard (Issue 6): the served image (<= baseSeq) plus the
        // surviving log tail (>= lowest retained seq) must jointly cover every
        // seq with no gap. If the log's earliest retained entry sits above
        // baseSeq+1, the strokes in between are in neither — surface it loudly
        // rather than losing pixels silently.
        const firstRetainedSeq = log?.entries?.length ? log.entries[0].seq : 0;
        if (firstRetainedSeq > baseSeq + 1) {
          console.warn(`[Sync] CHECKPOINT GAP for ${requesterSessionIndex}: served seq ${baseSeq} but log base is ${firstRetainedSeq} — strokes (${baseSeq}, ${firstRetainedSeq}) are unrecoverable for this joiner`);
        }
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
}
