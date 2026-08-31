/**
 * @fileoverview Single normalizer for `blendBakeMode`.
 *
 * `blendBakeMode` decides whether a blended stroke deposits pixels everywhere
 * ('background') or only where the layer already has content ('existing').
 * 'existing' is enforced in `LayerManager.commitUserStroke` by clipping the
 * committed stroke with `destination-in` against `_buildFlatContentCanvas` —
 * which replays the layer's stroke stack with eraser strokes as
 * `destination-out`. So the clip alpha carries a permanent hole wherever
 * anybody has ever erased, and a stroke that lands in 'existing' by accident
 * comes out shredded along every old eraser path, in fixed board coordinates,
 * identically on every subsequent stroke.
 *
 * That accident was reachable because the default polarity disagreed across
 * the codebase: `User`'s constructor read an unspecified value as
 * 'background', while `setBlendBakeMode`, `beginUserStroke`,
 * `getUserStrokeContext`, the CBM decode and SyncClient's stroke import all
 * read it as 'existing'. `bbm` is a proto3 string, so an unset field arrives
 * as '' — meaning a single `bbm`-less CBM silently flipped a user into the
 * clipping mode on every observer while their own client stayed on
 * 'background'.
 *
 * The safe polarity is the constructor's: only the explicit string 'existing'
 * selects the destructive mode. Everything else — undefined, null, '', a
 * typo — is 'background', which deposits the stroke as drawn.
 *
 * @param {*} mode - Candidate value from a user, a wire message, or a record.
 * @returns {'existing'|'background'}
 */
export function normalizeBlendBakeMode(mode) {
  return mode === 'existing' ? 'existing' : 'background';
}

/**
 * Wire-decode variant: distinguishes "the sender said 'background'/'existing'"
 * from "the field was absent", so a handler can leave existing state alone
 * instead of overwriting it with a default. Mirrors how the MD decode already
 * treats `bbm`.
 *
 * @param {*} bbm - Raw `bbm` field off a decoded protobuf message.
 * @returns {'existing'|'background'|undefined}
 */
export function decodeBlendBakeMode(bbm) {
  if (bbm === 'background') return 'background';
  if (bbm === 'existing') return 'existing';
  return undefined;
}
