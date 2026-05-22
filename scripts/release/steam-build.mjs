import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const releaseDir = path.join(repoRoot, 'src-tauri', 'target', 'release');
const steamRoot = path.join(repoRoot, 'dist', 'steam');
const steamWindowsDir = path.join(steamRoot, 'windows-x86_64');

const noBuild = process.argv.includes('--no-build');
const steamTauriConfig = JSON.stringify({
  build: {
    beforeBuildCommand: 'npm run build'
  }
});

function readPackageJson() {
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function cleanDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  ensureDir(dirPath);
}

function copyDir(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return false;
  fs.cpSync(sourceDir, targetDir, { recursive: true });
  return true;
}

function findReleaseExe() {
  const candidates = [
    path.join(releaseDir, 'app.exe'),
    path.join(releaseDir, 'Ddraw.exe'),
    path.join(releaseDir, 'DDraw.exe')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`Could not find a Tauri release executable in ${releaseDir}. Expected app.exe.`);
}

function runCommand(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ...extraEnv
    };

    // Steam owns updates for the Steam depot. Keep these out even if they are
    // present in the caller's shell from the standalone updater release flow.
    delete env.TAURI_UPDATER_ENDPOINT;
    delete env.TAURI_UPDATER_PUBLIC_KEY;
    delete env.TAURI_SIGNING_PRIVATE_KEY;
    delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;

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

function stageSteamBuild() {
  const packageJson = readPackageJson();
  const exePath = findReleaseExe();
  const targetExePath = path.join(steamWindowsDir, 'Ddraw.exe');
  const resourcesSource = path.join(releaseDir, 'resources');
  const resourcesTarget = path.join(steamWindowsDir, 'resources');
  const appId = process.env.STEAM_APP_ID?.trim();

  cleanDir(steamWindowsDir);
  fs.copyFileSync(exePath, targetExePath);

  const copiedResources = copyDir(resourcesSource, resourcesTarget);

  if (appId) {
    fs.writeFileSync(path.join(steamWindowsDir, 'steam_appid.txt'), `${appId}\n`);
  }

  const manifest = {
    product: 'Ddraw',
    version: packageJson.version,
    channel: 'steam',
    platform: 'windows-x86_64',
    executable: 'Ddraw.exe',
    updater: 'disabled',
    stagedAt: new Date().toISOString(),
    sourceExecutable: path.relative(repoRoot, exePath).replace(/\\/g, '/'),
    resources: copiedResources ? 'resources/' : null,
    steamAppIdFile: appId ? 'steam_appid.txt' : null
  };

  fs.writeFileSync(
    path.join(steamWindowsDir, 'steam-build-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  console.log(`[Steam] Staged DDraw v${packageJson.version} for Steam.`);
  console.log(`[Steam] Output: ${path.relative(repoRoot, steamWindowsDir)}`);
  console.log('[Steam] Steam depot launch executable: Ddraw.exe');
  console.log('[Steam] Updater env stripped for this build.');
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('This Steam build helper currently expects to run on Windows.');
  }

  if (!noBuild) {
    await runCommand('npm.cmd', [
      'run',
      'tauri',
      '--',
      'build',
      '--no-bundle',
      '--ci',
      '--ignore-version-mismatches',
      '--config',
      steamTauriConfig
    ]);
  }

  stageSteamBuild();
}

main().catch((error) => {
  console.error('[Steam] Failed:', error.message || error);
  process.exit(1);
});
