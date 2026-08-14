/** @fileoverview Handles selection-related events including lifting, moving, committing, and manipulating selections. */

/**
 * Sets up WebSocket event handlers for selection and image paste operations.
 * @param {Function} wrapHandler - Function to wrap event handlers for sync buffering.
 * @param {App} app - The main application instance.
 */
export function setupSelectionHandlers(wrapHandler, app) {
  const { users, remoteUserHandler } = app;

  app.wsClient?.on('obscure_region', (data) => {
    if (data && data.sessionIndex === app.sessionIndex) return;
    if (data.payload) {
      app.board?.addObscureRegion?.(data.payload);
    }
  });

  wrapHandler('sel_lift', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user) return;

    // Self echo: our lift already committed its destination-out erase of the
    // source area (tagged pendingCommitEcho='sel_lift'). Re-running the lift here
    // would erase twice. Reconcile that stroke to the authoritative seq — the one
    // every observer commits the same erase with — and stop. This is the lower
    // half of the lift/stamp pair; the stamp reconciles on its own echo to a
    // strictly higher seq, which is what keeps the erase underneath it.
    // Batch, not single: with the global mirror on, a lift erases the selection
    // AND its mirrored counterpart in one step.
    if (app.isSelfEcho(data.sessionIndex)) {
      app.board?.layerManager?.reconcileLocalCommitBatch(user.id, data.seq || 0, 'sel_lift');
      return;
    }

    remoteUserHandler.selectionHandler.handleSelectionLift(user, data.selection, data.lassoPath, data.imageData, data.allLayers, data.seq, data.extendedWarp);
  });

  wrapHandler('sel_move', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionMove(user, data.corners, data.sourceCrop, data.extendedWarp);
    }
  });

  wrapHandler('sel_commit', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user) return;

    // Self echo: reconcile-only. The stamp was committed optimistically at seq 0
    // (tagged pendingCommitEcho='sel_commit'); assign it the authoritative seq so
    // the drawer orders it exactly as every observer does. Safe to sequence now
    // ONLY because the lift-erase is sequenced too, on the SEL_LIFT echo, to a
    // lower seq — sequencing the stamp alone would sink it below a seq-0 erase
    // and wipe the placement.
    if (app.isSelfEcho(data.sessionIndex)) {
      app.board?.layerManager?.reconcileLocalCommitBatch(user.id, data.seq || 0, 'sel_commit');
      return;
    }

    remoteUserHandler.selectionHandler.handleSelectionCommit(user, data.layerIndex, data.seq, data.extendedWarp);
  });

  wrapHandler('sel_pending', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionPending(user, data.selection, data.lassoPath);
    }
  });

  wrapHandler('sel_delete', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user) return;

    // Self echo: we already committed this clear's destination-out erase stroke
    // optimistically (tagged pendingCommitEcho='sel_delete'). Recomputing it here
    // would double-erase. Reconcile that pending stroke with the authoritative
    // SEL_DELETE seq so our ordering matches every observer (who commit the same
    // erase carrying this seq). Reconcile only — no canvas work.
    // Batch, not single: with the global mirror on, one clear commits the
    // selection's erase AND its mirrored counterpart, and any left unreconciled
    // would sit at seq 0 on top of the stack and erase everyone's later strokes.
    if (app.isSelfEcho(data.sessionIndex)) {
      app.board?.layerManager?.reconcileLocalCommitBatch(user.id, data.seq || 0, 'sel_delete');
      return;
    }

    remoteUserHandler.selectionHandler.handleSelectionDelete(user, data.layerIndex, data.seq, data.allLayers, data.mirrored);
  });

  wrapHandler('sel_fill', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user) return;

    // Self echo: reconcile-only, same pairing rule as sel_commit.
    if (app.isSelfEcho(data.sessionIndex)) {
      app.board?.layerManager?.reconcileLocalCommitBatch(user.id, data.seq || 0, 'sel_fill');
      return;
    }

    remoteUserHandler.selectionHandler.handleSelectionFill(user, data.color, data.layerIndex, data.rect, data.seq, data.lassoPath);
  });

  wrapHandler('sel_stamp', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user) return;

    // Self echo: reconcile-only. Each SEL_STAMP broadcast pairs 1:1 with one
    // tagged stamp stroke, and reconcileLocalCommitBatch takes the oldest
    // outstanding batch, so repeated stamps reconcile in the order they were made.
    if (app.isSelfEcho(data.sessionIndex)) {
      app.board?.layerManager?.reconcileLocalCommitBatch(user.id, data.seq || 0, 'sel_stamp');
      return;
    }

    remoteUserHandler.selectionHandler.handleSelectionStamp(user, data.layerIndex, data.seq, data.extendedWarp);
  });

  wrapHandler('sel_merge', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user) return;

    // Self echo: the merge's strokes (one destination-out per erased layer plus
    // the source-over stamp) were committed optimistically at seq 0, where
    // _sortStrokeStack orders them by each client's own allocated timestamp.
    // Reconcile the whole batch to the authoritative seq so the drawer orders
    // the merge exactly as every observer does. Reconcile only — no canvas work.
    if (app.isSelfEcho(data.sessionIndex)) {
      app.board?.layerManager?.reconcileLocalCommitBatch(user.id, data.seq || 0, 'sel_merge');
      return;
    }

    remoteUserHandler.selectionHandler.handleSelectionMerge(user, data.mode, data.sourceLayer, data.seq);
  });

  wrapHandler('sel_flip', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionFlip(user);
    }
  });

  wrapHandler('sel_cancel', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionCancel(user);
    }
  });

  wrapHandler('sel_to_brush', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionToBrush(user, data.brushData);
    }
  });

  wrapHandler('sel_mask', (data) => {
    const { board } = app;
    const user = users.get(data.sessionIndex);
    const userId = user?.id ?? data.sessionIndex;
    if (user) user.isMaskMode = !!data.active;
    if (data.active) {
      const mask = { x: data.selection.x, y: data.selection.y, width: data.selection.width, height: data.selection.height, lassoPath: data.lassoPath };
      board.setSelectionMask(mask, userId, false);
      if (user) {
        user.pendingSelection = null;
        user.pendingLassoPath = null;
        user._pendingSelectionUpdatedAt = null;
        user.maskSelection = mask;
        user.maskLassoPath = mask.lassoPath;
        remoteUserHandler.selectionHandler.drawStaticMaskOutline(user, mask);
      }
    } else {
      board.clearSelectionMask(userId, false);
      if (user) {
        user.maskSelection = null;
        user.maskLassoPath = null;
        user._pendingSelectionUpdatedAt = null;
        user.context?.clearRect(0, 0, board.getWidth(), board.getHeight());
      }
    }
  });

  wrapHandler('img_paste', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleImagePaste(user, data);
    }
  });
}
