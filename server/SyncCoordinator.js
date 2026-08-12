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
      // Reopen live content broadcasts and never leave the joiner hanging on
      // the client-side idle timeout.
      ws.joinSyncPendingSince = null;
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

    // (Re-)arm live content suppression for the duration of the serve. Fresh
    // joiners already carry the flag from room join; RESYNCS (AFK return,
    // manual resync) don't, and without this every commit broadcast between
    // here and the barrier below would reach the client both live and via the
    // tail. The client resets its board + event buffer when it issues the
    // request, so content sent before the request arrived is already discarded.
    ws.joinSyncPendingSince = Date.now();

    const log = this.room?.strokeLog;
    const tape = this.room?.strokeTape;
    let snapshot = null;

    // This session's base-board decision (blank vs. the room's last persisted
    // snapshot) was pinned when the first client connected — Room.beginSessionBase,
    // driven by the `loadSnapshotOnFirstJoin` room setting. Await it so a joiner
    // racing the async R2/DB fetch is served the same base as everyone else,
    // rather than deciding for itself mid-flight.
    await this.room?.beginSessionBase?.();
    if (ws.readyState !== WebSocket.OPEN) return;

    // With the setting OFF a lone joiner does NOT auto-apply the persisted
    // checkpoint: they start from the live command tail only — empty for a cold
    // room, i.e. a blank canvas. With peers present the checkpoint base is
    // always required: it's the permanent content (<= watermark) the replayed
    // tail builds on, so the joiner matches what everyone else renders.
    const clientCount = this.room?.getClientCount?.() ?? 1;
    const startsBlank = clientCount <= 1
      && this.room?.settings?.loadSnapshotOnFirstJoin === false;

    // 1. Latest checkpoint image as the base (carries the applied-seq watermark
    //    S). Absent (fresh room / no persistence / blank-start lone joiner) →
    //    baseSeq 0, replay full tail.
    let baseSeq = 0;
    if (startsBlank && this.room?.canPersistSnapshots?.()) {
      // Log whether a checkpoint actually existed, so solo-join verification can
      // distinguish "correctly skipped an existing checkpoint" from "none
      // existed" (Issue 4). hasInMemoryJoinCheckpoint() is the live rolling-buffer
      // view; a DB/R2-only checkpoint won't show here.
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
        //
        // Read this off what the log has actually DROPPED, not off its first
        // retained entry. The log records only commit types, while the server
        // allocates a seq for every broadcast — MM outnumbers commits by roughly
        // 68:1 — so `entries[0].seq` sits an arbitrary distance above baseSeq
        // simply because no commit happened in between. The old check
        // (`firstRetainedSeq > baseSeq + 1`) therefore fired on essentially
        // EVERY checkpoint-served join: measured 3 of 3 in one soak, reporting
        // "unrecoverable" gaps of 29 and 86 seqs that contained no commits at
        // all. It could only have gone green if a commit happened to land on the
        // very next seq after the checkpoint, which is not a thing that has to
        // be true. `droppedThroughSeq` is the real invariant: a commit above the
        // served image's watermark is gone from the tail, which is genuine loss
        // (cap overflow, or a truncation against a higher base than the snapshot
        // actually served — Issue 6).
        const droppedThrough = log?.droppedThroughSeq || 0;
        if (droppedThrough > baseSeq) {
          console.warn(`[Sync] CHECKPOINT GAP for ${requesterSessionIndex}: served seq ${baseSeq} but the `
            + `command log has dropped commits through seq ${droppedThrough} — commits in `
            + `(${baseSeq}, ${droppedThrough}] are in neither the image nor the tail`);
        }
      }
    }

    // ── Live-broadcast barrier ──
    // From room-join until here the server suppresses room CONTENT broadcasts
    // to this ws (index.js shouldSkipJoinSyncPending) so nothing committed
    // before the tail's latestSeq read reaches the joiner twice. Everything
    // from this line through the tail + pending-bundle sends is synchronous
    // (no awaits), so no broadcast can interleave: commits ≤ latestSeq arrive
    // only via the tail, commits after it only via live broadcast, and
    // in-flight stroke preambles (pendingBundles) precede their live MM/MU
    // continuation. Clearing the flag any later (e.g. at SYNC_COMPLETE after
    // another await) would reopen the duplicate window.
    ws.joinSyncPendingSince = null;

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
    // Latest tool state per user, re-sent at the end of the serve (see 2c).
    const toolStateBundles = tape?.getToolStateBundles?.() || [];
    const toolStateMessageCount = toolStateBundles.reduce((total, b) => total + b.frames.length, 0);
    const [boardHeight, boardWidth] = getBoardDimensionsForSize(this.room?.settings?.boardSize);
    this.sendTo(ws, {
      t: T.SYNC_METADATA,
      syncTotal: checkpointMessageCount + tailMessageCount + pendingMessageCount + toolStateMessageCount,
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
      } else {
        // The other half of "blank board after resync": if the tail is empty the
        // requester's content had to come from the checkpoint image, and if that
        // is absent too there is nothing to serve and the fault is server-side.
        console.warn(`[Sync] EMPTY TAIL for ${requesterSessionIndex}: baseSeq=${baseSeq} latestSeq=${latestSeq} `
          + `checkpointServed=${!!(snapshot && snapshot.layers?.length)} logEntries=${log.getSummary?.().count ?? '?'}`);
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

    // 2c. Re-send every user's LATEST tool state. A tool-state frame broadcast
    //     during this joiner's suppression window for a stroke that has not
    //     yet begun is in neither the tail nor a pending bundle — without this
    //     the joiner draws that user's next stroke with stale color/size/tool.
    //     Sent last so it wins over older tail/pending config; frames carry
    //     their original seqs and the client applies tool-state events at
    //     every buffered position (they are exempt from replay dedup).
    if (toolStateBundles.length > 0) {
      for (const { frames } of toolStateBundles) {
        if (ws.readyState !== WebSocket.OPEN) return;
        for (const frame of frames) this.sendTo(ws, frame);
      }
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
