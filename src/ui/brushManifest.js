/** @fileoverview Static brush manifest used by the brush galleries. */

const svgRaws = import.meta.glob('../svgs/*.svg', { query: '?raw', import: 'default', eager: true });
const brushUrls = import.meta.glob('../brushes/*.{gbr,gih}', { query: '?url', import: 'default', eager: true });

/**
 * Collapsible sections in the brush/pattern galleries, in display order.
 * A brush lands in a folder via its `group`; anything without one (and every
 * `pinned` entry) stays in the flat list above the folders. SVGs default to
 * `icons` in BrushGallery, so uploaded SVG assets keep filing themselves there.
 */
export const BRUSH_GROUPS = [
  { id: 'stains', label: 'Stains' },
  { id: 'misc', label: 'Misc' },
  { id: 'leaves', label: 'Leaves' },
  { id: 'icons', label: 'Icons' },
];

function svgEntry(name, extra = {}) {
  const raw = svgRaws[`../svgs/${name}`];
  return { file: name, svgContent: raw || null, path: raw ? null : `../svgs/${name}`, type: 'svg', ...extra };
}

function brushUrl(name) {
  return brushUrls[`../brushes/${name}`] ?? `../brushes/${name}`;
}

function brushEntries(files, group) {
  return files.map((file) => ({
    file,
    path: brushUrl(file),
    type: file.endsWith('.gih') ? 'gih' : 'gbr',
    group,
  }));
}

export const BRUSH_MANIFEST = [
  // pinned: shown in the main list (not a folder); the pattern gallery skips
  // these since it has its own built-in circle/square. `order` fixes the
  // position in the flat list — these brushes finish loading in whatever order
  // their decodes resolve, and the pattern gallery's circle/square register
  // before the manifest is read at all, so appending is not deterministic.
  { file: 'pepper.gbr', path: brushUrl('pepper.gbr'), type: 'gbr', order: 0 },
  svgEntry('dot.svg', { pinned: true, order: 1 }),
  svgEntry('square.svg', { pinned: true, order: 2 }),
  { file: 'rainbowCircles.gih', path: brushUrl('rainbowCircles.gih'), type: 'gih', order: 3 },
  // Stains: the coffee stain set (extracted from a Photoshop .abr and
  // converted to .gbr) plus the splatter brushes from the CC0 pack below.
  ...brushEntries([
    'coffee-stain-01.gbr', 'coffee-stain-02.gbr', 'coffee-stain-03.gbr',
    'coffee-stain-04.gbr', 'coffee-stain-05.gbr',
    'splat-sun.gbr', 'splatters.gih', 'splatters2.gih',
  ], 'stains'),
  // Misc: CC0 brush pack (opengameart.org/content/60-free-gimp-krita-brushes)
  ...brushEntries([
    'Fuzzy.gbr', 'Plasmaball.gbr', 'Weird.gih', 'bark.gih', 'blocky.gih', 'bubbles.gih',
    'bubbles2.gih', 'circles.gih', 'cracks.gih', 'cracks2.gih', 'crosses.gih', 'crystallix.gih',
    'crystals.gih', 'dirt.gih', 'dots.gih', 'explode-particles.gih', 'explode.gih',
    'exploding-sparks-small.gih', 'exploding-sparks.gih', 'fine-grain.gih', 'flocks.gih',
    'fractale1.gbr', 'fractale2.gbr', 'fractale3.gbr', 'glowing-fragments.gih',
    'hand-drawn-star.gbr', 'lava.gih', 'microbes.gih', 'multi-star.gbr', 'nature1.gih',
    'painted-style.gih', 'patches.gih', 'pixel-star.gbr', 'polarized.gbr', 'radioactive.gbr',
    'rippled-glass.gih', 'rocky1.gih', 'saw.gbr', 'scratches.gih', 'scratches2.gih',
    'spikeball.gbr', 'spiky.gih',
    'structure-glass.gih', 'structure.gih', 'structure2.gih', 'structure3.gih',
    'symmetric-flower.gbr', 'turbine.gbr', 'vegetal.gih', 'wall-struct.gih', 'waterfall.gih',
    'weird-mirror.gbr', 'weird-smoke.gih', 'weird2.gbr', 'weird3.gih', 'wood1.gih', 'wood1b.gih',
  ], 'misc'),
  // Leaves: converted from CC0 PNG textures (opengameart.org: "50 Dry Leaf
  // Textures", "Cool Leaves Textures")
  ...brushEntries([
    'tree-foliage-01.gbr',
    'leaf-01.gbr', 'leaf-04.gbr', 'leaf-18.gbr', 'leaf-26.gbr', 'leaf-39.gbr', 'leaf-45.gbr',
  ], 'leaves'),
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
