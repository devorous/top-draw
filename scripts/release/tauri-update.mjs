import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const versionJsonPath = path.join(repoRoot, 'public', 'version.json');
const bundleRoot = path.join(repoRoot, 'src-tauri', 'target', 'release', 'bundle');
const publicUpdatesRoot = path.join(repoRoot, 'public', 'desktop-updates');
const distUpdatesRoot = path.join(repoRoot, 'dist', 'desktop-updates');
const windowsUpdatesDir = path.join(publicUpdatesRoot, 'windows-x86_64');
const publishOnly = process.argv.includes('--publish-only');
const stageOnly = process.argv.includes('--stage-only');

function loadEnvFile(relativePath, override = false) {
  const filePath = path.join(repoRoot, relativePath);
  if (fs.existsSync(filePath)) {
    dotenv.config({ path: filePath, override });
  }
}

loadEnvFile('.env');
// `.env.production` must override `.env` for release builds: otherwise the dev
// values from `.env` (e.g. VITE_API_BASE_URL=http://localhost:8030) stay in
// process.env and Vite bakes them into the packaged app, breaking every /api
// fetch (gallery, auth) against a localhost backend that does not exist on a
// user's machine.
loadEnvFile('.env.production', true);
loadEnvFile('.env.local', true);

// `.env.local` holds local dev/test overrides and is loaded with override=true so
// developer secrets (R2 keys, signing key) can live there. But it must NOT empty out
// frontend build vars: Vite gives any VITE_-prefixed value already in process.env
// priority over its own .env.production file, so an empty VITE_API_BASE_URL here would
// be baked into the release and break every /api fetch in the packaged app (the app then
// hits tauri://localhost and gets index.html -> "<!DOCTYPE ... is not valid JSON").
// Drop empty VITE_* overrides so Vite falls back to .env.production for the build.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('VITE_') && process.env[key] === '') {
    delete process.env[key];
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFileToTargets(sourcePath, relativeTargetPath) {
  const targets = [publicUpdatesRoot];
  if (fs.existsSync(path.join(repoRoot, 'dist'))) {
    targets.push(distUpdatesRoot);
  }

  for (const root of targets) {
    const targetPath = path.join(root, relativeTargetPath);
    ensureDir(path.dirname(targetPath));
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function writeTextToTargets(relativeTargetPath, text) {
  const targets = [publicUpdatesRoot];
  if (fs.existsSync(path.join(repoRoot, 'dist'))) {
    targets.push(distUpdatesRoot);
  }

  for (const root of targets) {
    const targetPath = path.join(root, relativeTargetPath);
    ensureDir(path.dirname(targetPath));
    fs.writeFileSync(targetPath, text);
  }
}

function findFilesRecursive(rootDir, matcher) {
  const results = [];

  function walk(currentDir) {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (matcher(fullPath, entry.name)) {
        results.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return results;
}

function resolvePublicKey() {
  const direct = process.env.TAURI_UPDATER_PUBLIC_KEY?.trim();
  if (direct) return direct;

  const envFilePath = process.env.TAURI_UPDATER_PUBLIC_KEY_FILE?.trim();
  if (envFilePath && fs.existsSync(envFilePath)) {
    return fs.readFileSync(envFilePath, 'utf8').trim();
  }

  const defaultPath = path.join(os.homedir(), '.tauri', 'top-draw.key.pub');
  if (fs.existsSync(defaultPath)) {
    return fs.readFileSync(defaultPath, 'utf8').trim();
  }

  throw new Error(
    'Missing TAURI_UPDATER_PUBLIC_KEY. Set TAURI_UPDATER_PUBLIC_KEY or TAURI_UPDATER_PUBLIC_KEY_FILE, or place the public key at ~/.tauri/top-draw.key.pub.'
  );
}

function resolveUpdateBaseUrl() {
  const raw = (
    process.env.TAURI_UPDATE_BASE_URL
    || process.env.TAURI_UPDATER_BASE_URL
    || process.env.DESKTOP_UPDATES_PUBLIC_URL
    || process.env.R2_PUBLIC_URL
    || process.env.NEXT_PUBLIC_R2_PUBLIC_URL
    || 'https://www.ddraw.ca'
  ).trim();

  return raw.replace(/\/+$/, '');
}

function resolveUpdatePrefix() {
  return (process.env.TAURI_UPDATE_PREFIX || 'desktop-updates')
    .trim()
    .replace(/^\/+|\/+$/g, '');
}

function getPackageVersion() {
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version;
}

function getReleaseMetadata() {
  try {
    return JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
  } catch {
    return {};
  }
}

function normalizeReleaseDate(rawDate) {
  if (typeof rawDate !== 'string' || !rawDate.trim()) {
    return new Date().toISOString();
  }

  const value = rawDate.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T00:00:00Z`;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }

  return parsed.toISOString();
}

function selectNewestFile(paths) {
  if (paths.length === 0) return null;
  return [...paths].sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function getPublicManifestUrl() {
  return `${resolveUpdateBaseUrl()}/${resolveUpdatePrefix()}/latest.json`;
}

function cleanOldDistUpdates() {
  // Clean up old installers from dist/desktop-updates to prevent bundling bloat
  const distWindowsDir = path.join(distUpdatesRoot, 'windows-x86_64');
  if (!fs.existsSync(distWindowsDir)) {
    return; // No old files to clean
  }

  try {
    const files = fs.readdirSync(distWindowsDir);
    const exeFiles = files.filter(f => f.endsWith('.exe') || f.endsWith('.exe.sig'));
    
    if (exeFiles.length > 0) {
      exeFiles.forEach(f => {
        const filePath = path.join(distWindowsDir, f);
        fs.unlinkSync(filePath);
      });
      console.log(`[Updater] Cleaned ${exeFiles.length} old installer file(s) from dist/desktop-updates`);
    }
  } catch (error) {
    console.warn(`[Updater] Warning: Could not clean old dist files: ${error.message}`);
    // Continue anyway, this is not critical
  }
}

function stageWindowsUpdaterArtifacts() {
  const nsisDir = path.join(bundleRoot, 'nsis');
  if (!fs.existsSync(nsisDir)) {
    throw new Error(`NSIS bundle directory not found: ${nsisDir}`);
  }

  const exePath = selectNewestFile(findFilesRecursive(nsisDir, (_fullPath, name) => (
    name.toLowerCase().endsWith('.exe') && !name.toLowerCase().endsWith('.exe.sig')
  )));
  if (!exePath) {
    throw new Error('Could not find a built NSIS installer .exe in src-tauri/target/release/bundle/nsis.');
  }

  const sigPath = `${exePath}.sig`;
  if (!fs.existsSync(sigPath)) {
    throw new Error(`Missing updater signature for installer: ${sigPath}`);
  }

  ensureDir(windowsUpdatesDir);
  const exeFileName = path.basename(exePath);

  // Clean old files from dist before copying new ones (prevents bundling bloat)
  cleanOldDistUpdates();

  copyFileToTargets(exePath, path.join('windows-x86_64', exeFileName));
  copyFileToTargets(sigPath, path.join('windows-x86_64', path.basename(sigPath)));

  const releaseMetadata = getReleaseMetadata();
  const version = getPackageVersion();
  const notes = typeof releaseMetadata.notes === 'string' ? releaseMetadata.notes : '';
  const releaseDate = normalizeReleaseDate(releaseMetadata.releaseDate);
  const updatePrefix = resolveUpdatePrefix();
  const baseUrl = resolveUpdateBaseUrl();
  const manifest = {
    version,
    notes,
    pub_date: releaseDate,
    platforms: {
      'windows-x86_64': {
        url: `${baseUrl}/${updatePrefix}/windows-x86_64/${encodeURIComponent(exeFileName)}`,
        signature: fs.readFileSync(sigPath, 'utf8').trim()
      }
    }
  };

  writeTextToTargets('latest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    version,
    manifest,
    exePath,
    sigPath,
    exeFileName,
    manifestUrl: getPublicManifestUrl()
  };
}

function runCommand(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ...extraEnv
    };
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', command, ...args], {
          cwd: repoRoot,
          stdio: 'inherit',
          shell: false,
          env
        })
      : spawn(command, args, {
          cwd: repoRoot,
          stdio: 'inherit',
          shell: false,
          env
        });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

function createR2Client() {
  const endpoint = process.env.R2_ENDPOINT?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey
    }
  });
}

async function uploadFile(client, bucket, key, filePath, contentType, cacheControl) {
  const body = fs.readFileSync(filePath);
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: cacheControl
  }));
}

async function uploadText(client, bucket, key, text, contentType, cacheControl) {
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: text,
    ContentType: contentType,
    CacheControl: cacheControl
  }));
}

async function uploadUpdaterArtifacts(result) {
  const client = createR2Client();
  const bucket = process.env.R2_BUCKET_NAME?.trim();
  if (!client || !bucket) {
    console.log('[Updater] R2 upload skipped. Missing R2 endpoint/credentials/bucket.');
    return { uploaded: false };
  }

  const updatePrefix = resolveUpdatePrefix();
  const manifestText = `${JSON.stringify(result.manifest, null, 2)}\n`;
  const exeKey = `${updatePrefix}/windows-x86_64/${result.exeFileName}`;
  const sigKey = `${updatePrefix}/windows-x86_64/${path.basename(result.sigPath)}`;
  const latestKey = `${updatePrefix}/latest.json`;

  await uploadFile(
    client,
    bucket,
    exeKey,
    result.exePath,
    'application/vnd.microsoft.portable-executable',
    'public, max-age=31536000, immutable'
  );
  await uploadFile(
    client,
    bucket,
    sigKey,
    result.sigPath,
    'text/plain; charset=utf-8',
    'public, max-age=31536000, immutable'
  );
  await uploadText(
    client,
    bucket,
    latestKey,
    manifestText,
    'application/json; charset=utf-8',
    'public, max-age=60, must-revalidate'
  );

  console.log(`[Updater] Uploaded: s3://${bucket}/${latestKey}`);
  return {
    uploaded: true,
    manifestUrl: result.manifestUrl
  };
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('This updater helper currently expects to run on Windows because it publishes the NSIS installer.');
  }

  const publicKey = resolvePublicKey();
  const endpoint = process.env.TAURI_UPDATER_ENDPOINT?.trim() || getPublicManifestUrl();

  if (!publishOnly) {
    if (!process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()) {
      throw new Error('Missing TAURI_SIGNING_PRIVATE_KEY. Add it to your environment or .env before running tauri:update.');
    }

    await runCommand('npm.cmd', ['run', 'tauri:build'], {
      TAURI_UPDATER_PUBLIC_KEY: publicKey,
      TAURI_UPDATER_ENDPOINT: endpoint,
      // The signing key has no password; without this the Tauri CLI stops to
      // prompt for one on every build. Must be defined (empty), not unset.
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? ''
    });
  }

  const result = stageWindowsUpdaterArtifacts();
  console.log(`[Updater] Staged desktop updater artifacts for v${result.version}`);
  console.log(`[Updater] Installer: ${resolveUpdatePrefix()}/windows-x86_64/${result.exeFileName}`);
  console.log(`[Updater] Manifest: ${result.manifestUrl}`);

  if (!stageOnly) {
    await uploadUpdaterArtifacts(result);
  }
}

main().catch((error) => {
  console.error('[Updater] Failed:', error.message || error);
  process.exit(1);
});
