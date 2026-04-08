export const TEXT_FONT_OPTIONS = [
  {
    label: 'Newsreader',
    family: 'Newsreader, serif',
    googleFamily: 'Newsreader:opsz@6..72',
    pickerFontSize: 12,
    appliedSizeMultiplier: 0,
    appliedOffset: -1
  },
  {
    label: 'Nunito',
    family: 'Nunito, sans-serif',
    googleFamily: 'Nunito:ital,wght@0,200..1000;1,200..1000',
    pickerFontSize: 12,
    appliedSizeMultiplier: 0.25,
    appliedOffset: 0
  },
  {
    label: 'Silkscreen',
    family: 'Silkscreen, cursive',
    googleFamily: 'Silkscreen:wght@400;700',
    pickerFontSize: 12,
    appliedSizeMultiplier: 0.25,
    appliedOffset: 0
  },
  {
    label: 'Tangerine',
    family: 'Tangerine, cursive',
    googleFamily: 'Tangerine:wght@400;700',
    pickerFontSize: 25,
    appliedSizeMultiplier: 0,
    appliedOffset: 0
  }
];

export const DEFAULT_TEXT_FONT = 'Nunito, sans-serif';

const TEXT_FONT_FAMILIES = new Set(TEXT_FONT_OPTIONS.map(font => font.family));
const TEXT_FONT_DEFAULTS = new Map(TEXT_FONT_OPTIONS.map(font => [
  font.family,
  {
    textPositionMultiplier: font.appliedSizeMultiplier ?? 0,
    textPositionOffset: font.appliedOffset ?? 0
  }
]));

export function normalizeTextFont(font) {
  return TEXT_FONT_FAMILIES.has(font) ? font : DEFAULT_TEXT_FONT;
}

export function getTextFontDefaults(font) {
  return TEXT_FONT_DEFAULTS.get(normalizeTextFont(font)) || {
    textPositionMultiplier: 0,
    textPositionOffset: 0
  };
}

export function ensureTextFontsLoaded(doc = document) {
  if (!doc?.head) return;

  const preconnectGoogle = 'https://fonts.googleapis.com';
  const preconnectStatic = 'https://fonts.gstatic.com';

  if (!doc.head.querySelector(`link[href="${preconnectGoogle}"]`)) {
    const link = doc.createElement('link');
    link.rel = 'preconnect';
    link.href = preconnectGoogle;
    doc.head.appendChild(link);
  }

  if (!doc.head.querySelector(`link[href="${preconnectStatic}"]`)) {
    const link = doc.createElement('link');
    link.rel = 'preconnect';
    link.href = preconnectStatic;
    link.crossOrigin = 'anonymous';
    doc.head.appendChild(link);
  }

  const googleFamilies = TEXT_FONT_OPTIONS
    .map(font => font.googleFamily)
    .filter(Boolean);

  if (googleFamilies.length === 0) return;

  const href = `https://fonts.googleapis.com/css2?${googleFamilies
    .map(family => `family=${encodeURIComponent(family)}`)
    .join('&')}&display=swap`;

  if (!doc.head.querySelector(`link[data-text-fonts="true"][href="${href}"]`)) {
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.textFonts = 'true';
    doc.head.appendChild(link);
  }
}
