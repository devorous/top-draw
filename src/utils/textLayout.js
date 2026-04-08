export const DEFAULT_TEXT_X_OFFSET = 5;
export const DEFAULT_TEXT_BASELINE_MULTIPLIER = 0.66;
export const DEFAULT_TEXT_BASELINE_OFFSET = -3;
export const DEFAULT_APPLIED_TEXT_SIZE_MULTIPLIER = 0;
export const DEFAULT_APPLIED_TEXT_OFFSET = 0;
export const DEFAULT_TEXT_ASCENT_MULTIPLIER = 0.75;
export const DEFAULT_TEXT_DESCENT_MULTIPLIER = 0.25;
export const CURSOR_TEXT_ANCHOR = 100;

export function getTextFontSize(size) {
  return size + 5;
}

export function getPreviewTextLayout(user, metrics = null) {
  const fontSize = getTextFontSize(user.size);
  const drawX = user.x + DEFAULT_TEXT_X_OFFSET;
  const baselineY = user.y + (fontSize * DEFAULT_TEXT_BASELINE_MULTIPLIER) + DEFAULT_TEXT_BASELINE_OFFSET;
  const ascent = metrics?.actualBoundingBoxAscent || (fontSize * DEFAULT_TEXT_ASCENT_MULTIPLIER);

  return {
    fontSize,
    drawX,
    baselineY,
    ascent,
    domLeft: CURSOR_TEXT_ANCHOR + DEFAULT_TEXT_X_OFFSET,
    domTop: CURSOR_TEXT_ANCHOR + (fontSize * DEFAULT_TEXT_BASELINE_MULTIPLIER) + DEFAULT_TEXT_BASELINE_OFFSET - ascent
  };
}

export function getAppliedTextLayout(user, metrics = null) {
  const fontSize = getTextFontSize(user.size);
  const multiplier = user.textPositionMultiplier ?? DEFAULT_APPLIED_TEXT_SIZE_MULTIPLIER;
  const offset = user.textPositionOffset ?? DEFAULT_APPLIED_TEXT_OFFSET;
  const drawX = user.x + DEFAULT_TEXT_X_OFFSET;
  const previewBaselineY = user.y + (fontSize * DEFAULT_TEXT_BASELINE_MULTIPLIER) + DEFAULT_TEXT_BASELINE_OFFSET;
  const baselineY = previewBaselineY + (fontSize * multiplier) + offset;
  const ascent = metrics?.actualBoundingBoxAscent || (fontSize * DEFAULT_TEXT_ASCENT_MULTIPLIER);
  const descent = metrics?.actualBoundingBoxDescent || (fontSize * DEFAULT_TEXT_DESCENT_MULTIPLIER);

  return {
    fontSize,
    drawX,
    baselineY,
    ascent,
    descent
  };
}
