#!/usr/bin/env node

/** @fileoverview Generates a manifest of all brush files in public/brushes. Supports: .gbr, .gih, .png, .jpg, .jpeg, .webp. */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BRUSHES_DIR = path.join(__dirname, '..', 'public', 'brushes');
const MANIFEST_PATH = path.join(BRUSHES_DIR, 'manifest.json');

/**
 * Scans the brushes directory for supported image and GIMP brush formats and generates a manifest.json file.
 * @returns {void}
 */
function generateManifest() {
  if (!fs.existsSync(BRUSHES_DIR)) {
    console.error(`Brushes directory not found: ${BRUSHES_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(BRUSHES_DIR)
    .filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ext === '.gbr' || ext === '.gih' || ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp';
    })
    .sort();

  const manifest = {
    generated: new Date().toISOString(),
    count: files.length,
    brushes: files.map(file => ({
      file: file,
      type: path.extname(file).toLowerCase().slice(1)
    }))
  };

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  console.log(`Brush manifest generated: ${MANIFEST_PATH}`);
  console.log(`Found ${files.length} brush(es):`);
  files.forEach(f => console.log(`  - ${f}`));
}

generateManifest();
