#!/usr/bin/env node

/** @fileoverview Generates a manifest of all brush files in public/brushes. Supports: .gbr, .gih, .png, .jpg, .jpeg, .webp, .svg. */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BRUSHES_DIR = path.join(__dirname, '..', 'public', 'brushes');
const SVGS_DIR = path.join(__dirname, '..', 'public', 'svgs');
const MANIFEST_PATH = path.join(BRUSHES_DIR, 'manifest.json');

/**
 * Scans the brushes and svgs directories for supported image and GIMP brush formats and generates a manifest.json file.
 * @returns {void}
 */
function generateManifest() {
  if (!fs.existsSync(BRUSHES_DIR)) {
    console.error(`Brushes directory not found: ${BRUSHES_DIR}`);
    process.exit(1);
  }

  // Define supported extensions in an array for better readability and easier maintenance
  const supportedExtensions = ['.gbr', '.gih', '.png', '.jpg', '.jpeg', '.webp', '.svg'];

  const files = fs.readdirSync(BRUSHES_DIR)
    .filter(file => {
      const ext = path.extname(file).toLowerCase();
      return supportedExtensions.includes(ext);
    })
    .sort();

  // Scan SVGs directory if it exists
  const svgFiles = fs.existsSync(SVGS_DIR)
    ? fs.readdirSync(SVGS_DIR)
      .filter(file => path.extname(file).toLowerCase() === '.svg')
      .sort()
    : [];

  const brushManifests = files.map(file => ({
    file: file,
    path: `/brushes/${file}`,
    type: path.extname(file).toLowerCase().slice(1)
  }));

  const svgManifests = svgFiles.map(file => ({
    file: file,
    path: `/svgs/${file}`,
    type: 'svg'
  }));

  const allBrushes = [...brushManifests, ...svgManifests];

  const manifest = {
    generated: new Date().toISOString(),
    count: allBrushes.length,
    brushes: allBrushes
  };

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  console.log(`Brush manifest generated: ${MANIFEST_PATH}`);
  console.log(`Found ${allBrushes.length} brush(es):`);
  allBrushes.forEach(b => console.log(`   - ${b.file}`));
}

generateManifest();