/**
 * @fileoverview Idle reclaim for remote users' stroke scratch canvases.
 *
 * `RemoteInkHandler` and `RemotePenHandler` each give a drawing user an
 * offscreen canvas to accumulate a stroke into, windowed to the stroke's own
 * growing bounds rather than the full board (see
 * lag_measured_1440p_realistic_load) — so the reclaim below matters much less
 * than it used to, but is kept: a user who draws once and sits idle still
 * holds whatever the largest stroke they made needed. They are disposed
 * by `RemoteUserHandler._cleanupTransientUserState`, which runs on departure
 * and on going AFK — so the case they accumulate in is a user who is present,
 * has drawn at least once, and is now sitting idle without being idle long
 * enough to trip AFK. Each such user holds up to two full-board canvases:
 * 29 MB at 1440p, 46 MB at 4k.
 *
 * That cost was invisible until the canvas census learned to walk the user
 * model — these canvases are never in the DOM and are not reachable from
 * LayerManager. Measured at 1440p with 7 users: 98 MB across 7 canvases, second
 * only to the preview boards.
 *
 * WHY A TIMER AND NOT FREE-AT-STROKE-END. Freeing at the end of every stroke
 * trades retained memory for an allocate-and-zero-fill of a full-board canvas
 * at the start of the next one, and that allocation is the single most
 * expensive canvas operation there is — a fresh 8k canvas per frame drops
 * 180 fps to 92 while JS self-time stays at 0.14 ms, because the cost lands in
 * the GPU process where no JS timer can see it. The same mistake was measured
 * directly on the preview boards in this codebase: collapsing those after 2 s
 * of idle was worse than not collapsing at all on every axis (GPU 1225 vs
 * 968 MB, worst stall 396 vs 222 ms). Remote strokes arrive in bursts, so any
 * short interval thrashes. Hence one long interval, matching
 * userLayerPresence's.
 */

const IDLE_RECLAIM_MS = 60000;

/**
 * Drop a canvas's backing store and let it be collected.
 *
 * Sizing to 1x1 before releasing the reference is deliberate: it hands the
 * memory back at a known point rather than whenever GC gets to it, which is
 * what makes the reclaim show up in a measurement instead of eventually.
 *
 * @param {HTMLCanvasElement|null|undefined} canvas
 * @returns {void}
 */
function shrink(canvas) {
  if (!canvas || typeof canvas.width !== 'number') return;
  canvas.width = 1;
  canvas.height = 1;
}

/**
 * Restart a remote user's scratch-canvas idle timer.
 *
 * Call from the ensure* paths, i.e. every time the scratch canvas is actually
 * used. Cheap: one clearTimeout plus one setTimeout per stroke start.
 *
 * @param {Object} user - Remote user model.
 * @returns {void}
 */
export function touchRemoteScratch(user) {
  if (!user) return;
  if (user._scratchReclaimTimer) clearTimeout(user._scratchReclaimTimer);
  user._scratchReclaimTimer = setTimeout(() => {
    user._scratchReclaimTimer = null;
    // A stroke in progress owns these canvases; reclaiming underneath it would
    // discard the accumulated stroke and the user's line would vanish
    // mid-draw. Re-arm rather than dropping the reclaim entirely, or a user
    // who leaves a stroke open holds both canvases indefinitely.
    if (user._inkStrokeActive || user._penStrokeActive) {
      touchRemoteScratch(user);
      return;
    }
    releaseRemoteScratch(user);
  }, IDLE_RECLAIM_MS);
}

/**
 * Dispose a remote user's scratch canvases now.
 *
 * Both handlers recreate on demand (`ensureInkOffscreen` / `ensurePenOffscreen`
 * both test for a missing or wrongly-sized canvas), so this is always safe —
 * the next stroke reallocates. Replay checkpoint capture reads these and is
 * already null-guarded, so a reclaimed pair degrades to "no scratch captured"
 * rather than failing.
 *
 * @param {Object} user - Remote user model.
 * @returns {void}
 */
export function releaseRemoteScratch(user) {
  if (!user) return;
  if (user._scratchReclaimTimer) {
    clearTimeout(user._scratchReclaimTimer);
    user._scratchReclaimTimer = null;
  }
  shrink(user._inkOffscreen);
  user._inkOffscreen = null;
  user._inkCtx = null;
  shrink(user._inkHardnessCanvas);
  user._inkHardnessCanvas = null;
  user._inkHardnessCtx = null;
  user._inkOrigin = null;
  shrink(user._penOffscreen);
  user._penOffscreen = null;
  user._penOffscreenCtx = null;
  user._penOrigin = null;
}
