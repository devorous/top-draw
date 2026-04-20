#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

// Find repo root by looking for package.json
function findRepoRoot() {
  let current = process.cwd();
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    current = path.dirname(current);
  }
  throw new Error('Could not find repo root (package.json)');
}

const repoRoot = findRepoRoot();

function cleanUpdateDir(dirPath, label) {
  const windowsDir = path.join(dirPath, 'windows-x86_64');
  
  console.log(`[Build] Checking ${label}: ${windowsDir}`);
  
  if (!fs.existsSync(windowsDir)) {
    console.log(`[Build] ${label} does not exist yet, skipping cleanup.`);
    return;
  }

  try {
    const files = fs.readdirSync(windowsDir);
    const exeFiles = files.filter(f => f.endsWith('.exe') || f.endsWith('.exe.sig'));
    
    if (exeFiles.length > 0) {
      console.log(`[Build] Found ${exeFiles.length} old installer file(s) in ${label}, deleting...`);
      exeFiles.forEach(f => {
        const filePath = path.join(windowsDir, f);
        try {
          fs.unlinkSync(filePath);
          console.log(`[Build] Deleted: ${f}`);
        } catch (err) {
          console.warn(`[Build] Failed to delete ${f}: ${err.message}`);
        }
      });
      console.log(`[Build] ✓ Cleaned ${exeFiles.length} installer file(s) from ${label}`);
    } else {
      console.log(`[Build] No old installers found in ${label}.`);
    }
  } catch (error) {
    console.warn(`[Build] Error reading ${label}: ${error.message}`);
  }
}

// Clean both public and dist to prevent Vite from copying old installers
cleanUpdateDir(path.join(repoRoot, 'public', 'desktop-updates'), 'public/desktop-updates');
cleanUpdateDir(path.join(repoRoot, 'dist', 'desktop-updates'), 'dist/desktop-updates');
