/** @fileoverview Static brush manifest used by the brush galleries. */

const svgRaws = import.meta.glob('../svgs/*.svg', { query: '?raw', import: 'default', eager: true });
const brushUrls = import.meta.glob('../brushes/*.{gbr,gih}', { query: '?url', import: 'default', eager: true });

function svgEntry(name, extra = {}) {
  const raw = svgRaws[`../svgs/${name}`];
  return { file: name, svgContent: raw || null, path: raw ? null : `../svgs/${name}`, type: 'svg', ...extra };
}

function brushUrl(name) {
  return brushUrls[`../brushes/${name}`] ?? `../brushes/${name}`;
}

export const BRUSH_MANIFEST = [
  // pinned: shown in the main list (not the Icons folder); the pattern
  // gallery skips these since it has its own built-in circle/square.
  svgEntry('dot.svg', { pinned: true }),
  svgEntry('square.svg', { pinned: true }),
  { file: 'pepper.gbr', path: brushUrl('pepper.gbr'), type: 'gbr' },
  { file: 'rainbowCircles.gih', path: brushUrl('rainbowCircles.gih'), type: 'gih' },
  // Coffee stain brush set, extracted from a Photoshop .abr and converted to .gbr
  ...Array.from({ length: 5 }, (_, i) => {
    const file = `coffee-stain-${String(i + 1).padStart(2, '0')}.gbr`;
    return { file, path: brushUrl(file), type: 'gbr' };
  }),
  // CC0 brush pack (opengameart.org/content/60-free-gimp-krita-brushes)
  ...[
    'Fuzzy.gbr', 'Plasmaball.gbr', 'Weird.gih', 'bark.gih', 'blocky.gih', 'bubbles.gih',
    'bubbles2.gih', 'circles.gih', 'cracks.gih', 'cracks2.gih', 'crosses.gih', 'crystallix.gih',
    'crystals.gih', 'dirt.gih', 'dots.gih', 'explode-particles.gih', 'explode.gih',
    'exploding-sparks-small.gih', 'exploding-sparks.gih', 'fine-grain.gih', 'flocks.gih',
    'fractale1.gbr', 'fractale2.gbr', 'fractale3.gbr', 'glowing-fragments.gih',
    'hand-drawn-star.gbr', 'lava.gih', 'microbes.gih', 'multi-star.gbr', 'nature1.gih',
    'painted-style.gih', 'patches.gih', 'pixel-star.gbr', 'polarized.gbr', 'radioactive.gbr',
    'rippled-glass.gih', 'rocky1.gih', 'saw.gbr', 'scratches.gih', 'scratches2.gih',
    'spikeball.gbr', 'spiky.gih', 'splat-sun.gbr', 'splatters.gih', 'splatters2.gih',
    'structure-glass.gih', 'structure.gih', 'structure2.gih', 'structure3.gih',
    'symmetric-flower.gbr', 'turbine.gbr', 'vegetal.gih', 'wall-struct.gih', 'waterfall.gih',
    'weird-mirror.gbr', 'weird-smoke.gih', 'weird2.gbr', 'weird3.gih', 'wood1.gih', 'wood1b.gih',
  ].map((file) => ({ file, path: brushUrl(file), type: file.endsWith('.gih') ? 'gih' : 'gbr' })),
  // Foliage brushes, converted from CC0 PNG textures (opengameart.org: "50 Dry Leaf
  // Textures", "Cool Leaves Textures")
  ...[
    'tree-foliage-01.gbr',
    'leaf-01.gbr', 'leaf-04.gbr', 'leaf-18.gbr', 'leaf-26.gbr', 'leaf-39.gbr', 'leaf-45.gbr',
  ].map((file) => ({ file, path: brushUrl(file), type: 'gbr' })),
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
