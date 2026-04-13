/** @fileoverview Static brush manifest used by the brush galleries. */

const svgRaws = import.meta.glob('../svgs/*.svg', { query: '?raw', import: 'default', eager: true });
const brushUrls = import.meta.glob('../brushes/*.{gbr,gih}', { query: '?url', import: 'default', eager: true });

function svgEntry(name) {
  const raw = svgRaws[`../svgs/${name}`];
  return { file: name, svgContent: raw || null, path: raw ? null : `../svgs/${name}`, type: 'svg' };
}

function brushUrl(name) {
  return brushUrls[`../brushes/${name}`] ?? `../brushes/${name}`;
}

export const BRUSH_MANIFEST = [
  { file: 'pepper.gbr', path: brushUrl('pepper.gbr'), type: 'gbr' },
  { file: 'rainbowCircles.gih', path: brushUrl('rainbowCircles.gih'), type: 'gih' },
  svgEntry('alien.svg'),
  svgEntry('bee.svg'),
  svgEntry('bug.svg'),
  svgEntry('butterfly.svg'),
  svgEntry('cherry.svg'),
  svgEntry('chip.svg'),
  svgEntry('ghost.svg'),
  svgEntry('heart.svg'),
  svgEntry('meeple.svg'),
  svgEntry('pizza.svg'),
  svgEntry('question-block.svg'),
  svgEntry('question.svg'),
  svgEntry('snowflake.svg'),
  svgEntry('somber.svg'),
  svgEntry('sparkles.svg'),
  svgEntry('star.svg'),
  svgEntry('star2.svg'),
  svgEntry('target.svg'),
  svgEntry('thumb-down.svg'),
  svgEntry('thumb-up.svg'),
];
