import { normalizeTextFont } from '../config/textFonts.js';

export const DEFAULT_TEXT_X_OFFSET = 5;
export const DEFAULT_TEXT_BASELINE_MULTIPLIER = 0.66;
export const DEFAULT_TEXT_BASELINE_OFFSET = -3;
export const DEFAULT_APPLIED_TEXT_SIZE_MULTIPLIER = 0;
export const DEFAULT_APPLIED_TEXT_OFFSET = 0;
export const DEFAULT_TEXT_ASCENT_MULTIPLIER = 0.75;
export const DEFAULT_TEXT_DESCENT_MULTIPLIER = 0.25;
export const DEFAULT_TEXT_LINE_HEIGHT_MULTIPLIER = 1.35;
export const CURSOR_TEXT_ANCHOR = 100;

const textLineHeightCache = new Map();

export function getTextFontSize(size) {
  return size + 5;
}

export function getTextLineHeight(fontSize, font, doc = typeof document !== 'undefined' ? document : null) {
  const normalizedFont = normalizeTextFont(font);
  const cacheKey = `${normalizedFont}::${fontSize}`;
  const cached = textLineHeightCache.get(cacheKey);
  if (cached) return cached;

  let lineHeight = fontSize * DEFAULT_TEXT_LINE_HEIGHT_MULTIPLIER;

  if (doc?.body) {
    const probe = doc.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    probe.style.whiteSpace = 'pre';
    probe.style.display = 'inline-block';
    probe.style.margin = '0';
    probe.style.padding = '0';
    probe.style.border = '0';
    probe.style.fontSize = `${fontSize}px`;
    probe.style.fontFamily = normalizedFont;
    probe.style.lineHeight = 'normal';
    probe.textContent = 'M';

    doc.body.appendChild(probe);
    const singleLineHeight = probe.getBoundingClientRect().height;
    probe.textContent = 'M\nM';
    const doubleLineHeight = probe.getBoundingClientRect().height;
    probe.remove();

    const measuredLineHeight = doubleLineHeight - singleLineHeight;
    if (Number.isFinite(measuredLineHeight) && measuredLineHeight > 0) {
      lineHeight = measuredLineHeight;
    }
  }

  textLineHeightCache.set(cacheKey, lineHeight);
  return lineHeight;
}

export function getUserTextLineHeight(user, doc = typeof document !== 'undefined' ? document : null) {
  return getTextLineHeight(getTextFontSize(user.size), user.font, doc);
}

export function getPreviewTextContent(text = '') {
  const previewText = text ?? '';
  return previewText.endsWith('\n') ? `${previewText}\u200b` : previewText;
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
