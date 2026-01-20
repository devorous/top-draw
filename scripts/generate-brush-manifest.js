#!/usr/bin/env node

/**
 * Generates a manifest of all .gbr and .gih brush files in public/brushes
 * Run this script whenever you add or remove brushes from the folder.
 *
 * Usage: node scripts/generate-brush-manifest.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BRUSHES_DIR = path.join(__dirname, '..', 'public', 'brushes');
const MANIFEST_PATH = path.join(BRUSHES_DIR, 'manifest.json');

function generateManifest() {
  // Ensure brushes directory exists
  if (!fs.existsSync(BRUSHES_DIR)) {
    console.error(`Brushes directory not found: ${BRUSHES_DIR}`);
    process.exit(1);
  }

  // Get all .gbr and .gih files
  const files = fs.readdirSync(BRUSHES_DIR)
    .filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ext === '.gbr' || ext === '.gih';
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

  // Write manifest
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  console.log(`Brush manifest generated: ${MANIFEST_PATH}`);
  console.log(`Found ${files.length} brush(es):`);
  files.forEach(f => console.log(`  - ${f}`));
}

generateManifest();
