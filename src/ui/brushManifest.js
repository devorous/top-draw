/** @fileoverview Static brush manifest used by the brush galleries. */

const svgRaws = import.meta.glob('../svgs/*.svg', { query: '?raw', import: 'default', eager: true });
const brushUrls = import.meta.glob('../brushes/*.{gbr,gih}', { query: '?url', import: 'default', eager: true });

function svgUrl(name) {
  const raw = svgRaws[`../svgs/${name}`];
  if (raw) {
    const blob = new Blob([raw], { type: 'image/svg+xml' });
    return URL.createObjectURL(blob);
  }
  return `../svgs/${name}`;
}

function brushUrl(name) {
  return brushUrls[`../brushes/${name}`] ?? `../brushes/${name}`;
}

export const BRUSH_MANIFEST = [
  { file: 'pepper.gbr', path: brushUrl('pepper.gbr'), type: 'gbr' },
  { file: 'rainbowCircles.gih', path: brushUrl('rainbowCircles.gih'), type: 'gih' },
  { file: 'alien.svg', path: svgUrl('alien.svg'), type: 'svg' },
  { file: 'bee.svg', path: svgUrl('bee.svg'), type: 'svg' },
  { file: 'bug.svg', path: svgUrl('bug.svg'), type: 'svg' },
  { file: 'butterfly.svg', path: svgUrl('butterfly.svg'), type: 'svg' },
  { file: 'cherry.svg', path: svgUrl('cherry.svg'), type: 'svg' },
  { file: 'chip.svg', path: svgUrl('chip.svg'), type: 'svg' },
  { file: 'ghost.svg', path: svgUrl('ghost.svg'), type: 'svg' },
  { file: 'heart.svg', path: svgUrl('heart.svg'), type: 'svg' },
  { file: 'meeple.svg', path: svgUrl('meeple.svg'), type: 'svg' },
  { file: 'pizza.svg', path: svgUrl('pizza.svg'), type: 'svg' },
  { file: 'question-block.svg', path: svgUrl('question-block.svg'), type: 'svg' },
  { file: 'question.svg', path: svgUrl('question.svg'), type: 'svg' },
  { file: 'snowflake.svg', path: svgUrl('snowflake.svg'), type: 'svg' },
  { file: 'somber.svg', path: svgUrl('somber.svg'), type: 'svg' },
  { file: 'sparkles.svg', path: svgUrl('sparkles.svg'), type: 'svg' },
  { file: 'star.svg', path: svgUrl('star.svg'), type: 'svg' },
  { file: 'star2.svg', path: svgUrl('star2.svg'), type: 'svg' },
  { file: 'target.svg', path: svgUrl('target.svg'), type: 'svg' },
  { file: 'thumb-down.svg', path: svgUrl('thumb-down.svg'), type: 'svg' },
  { file: 'thumb-up.svg', path: svgUrl('thumb-up.svg'), type: 'svg' }
];
